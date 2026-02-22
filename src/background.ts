// background.ts
// Service worker for the extension

import { checkJsonLd, extractWithReadability, extractRecipeWithClaude } from "./utils/parser";
import { saveRecipeLocally } from "./utils/db";

let creating: Promise<void> | null;

// Track active extractions by tabId
const activeExtractions: Record<number, string> = {};

async function setupOffscreenDocument() {
    const offscreenUrl = chrome.runtime.getURL('offscreen.html');
    // Check if it already exists
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
        documentUrls: [offscreenUrl]
    });

    if (existingContexts.length > 0) {
        return;
    }

    // Create document
    if (creating) {
        await creating;
    } else {
        creating = chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: [chrome.offscreen.Reason.DOM_PARSER],
            justification: 'Run Transformers.js without service worker timeout limits'
        });
        await creating;
        creating = null;
    }
}

async function updateExtractionStatus(tabId: number, status: string, isError: boolean = false, isComplete: boolean = false) {
    if (isComplete || isError) {
        delete activeExtractions[tabId];
        chrome.action.setBadgeText({ text: isError ? "ERR" : "✓", tabId });
        chrome.action.setBadgeBackgroundColor({ color: isError ? "#EF4444" : "#10B981", tabId });
    } else {
        activeExtractions[tabId] = status;
        chrome.action.setBadgeText({ text: "...", tabId });
        chrome.action.setBadgeBackgroundColor({ color: "#F59E0B", tabId });
    }

    try {
        // Attempt to send to popup if it's open
        await chrome.runtime.sendMessage({
            type: "EXTRACTION_STATUS_UPDATE",
            tabId,
            status,
            isError,
            isComplete
        });
    } catch (e) {
        // Popup is closed, ignore error
    }
}

async function executeExtractionInBackground(tabId: number, apiKey: string, llmModel: string, llmProvider: string) {
    try {
        await updateExtractionStatus(tabId, "Extracting page content...");
        console.log(`[Recipe AI] Starting background extraction for tab ${tabId} with ${llmProvider} model: ${llmModel}`);

        console.log("[Recipe AI] Checking for JSON-LD schema...");
        let results = await chrome.scripting.executeScript({
            target: { tabId },
            func: checkJsonLd,
        });

        let extractedData = results?.[0]?.result;

        if (!extractedData) {
            console.log("[Recipe AI] No JSON-LD found. Injecting Readability fallback...");
            await updateExtractionStatus(tabId, "Loading Readability fallback...");

            await chrome.scripting.executeScript({
                target: { tabId },
                files: ["Readability.js"],
            });

            console.log("[Recipe AI] Executing Readability extraction...");
            results = await chrome.scripting.executeScript({
                target: { tabId },
                func: extractWithReadability,
            });

            extractedData = results?.[0]?.result;
        }

        if (!extractedData) {
            throw new Error("Extraction failed: No results returned from page.");
        }

        if (extractedData.source === "json-ld") {
            console.log("[Recipe AI] JSON-LD schema found, skipping Readability.");
            await updateExtractionStatus(tabId, "Analyzing structured recipe data...");
        } else {
            console.log("[Recipe AI] No JSON-LD found, using Readability fallback.", `Text length: ${extractedData.textContent?.length ?? 0} chars.`);
            const charCount = extractedData.textContent?.length ?? 0;
            // Format character count with commas for readability
            const formattedCount = new Intl.NumberFormat().format(charCount);
            if (charCount > 10000) {
                await updateExtractionStatus(tabId, `Processing large text (${formattedCount} chars)...`);
            } else {
                await updateExtractionStatus(tabId, `Reading page text (${formattedCount} chars)...`);
            }
        }

        console.log("[Recipe AI] Sending request to LLM API...");
        await updateExtractionStatus(tabId, `Asking ${llmProvider} to extract recipe...`);
        const recipeData = await extractRecipeWithClaude(
            extractedData,
            apiKey,
            llmModel,
            llmProvider
        );

        console.log("Successfully parsed recipe:", recipeData);
        await updateExtractionStatus(tabId, "Successfully extracted recipe data!");

        await updateExtractionStatus(tabId, "Generating embedding vector...");
        console.log("[Recipe AI] Requesting embedding...");

        const textToEmbed = [
            recipeData.title,
            recipeData.description,
            ...(recipeData.tags || []),
            ...(recipeData.ingredients?.map((i: any) => i.item) || []),
        ].join(", ");

        await setupOffscreenDocument();

        const embeddingResult: { success: boolean, embedding?: number[], error?: string } = await chrome.runtime.sendMessage({
            type: 'GENERATE_EMBEDDING',
            target: 'offscreen',
            text: textToEmbed
        });

        if (embeddingResult && embeddingResult.success && embeddingResult.embedding) {
            console.log(`[Recipe AI] Embedding generated (${embeddingResult.embedding.length} dims).`);
            recipeData.embedding = embeddingResult.embedding;
        } else {
            console.warn("[Recipe AI] Embedding failed, saving without vector:", embeddingResult?.error);
        }

        await updateExtractionStatus(tabId, "Saving to local database...");
        console.log("[Recipe AI] Saving recipe to IndexedDB...");
        await saveRecipeLocally(recipeData);
        console.log("[Recipe AI] Saved to IndexedDB successfully.");

        await updateExtractionStatus(tabId, "Recipe saved! Open Pantry to view.", false, true);
    } catch (error: any) {
        console.error("Extraction error in background:", error);
        await updateExtractionStatus(tabId, `Error: ${error.message || "Unknown error occurred"}`, true, true);
    }
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GENERATE_EMBEDDING') {
        (async () => {
            // this handles requests from other parts of the extension that aren't the background extraction
            try {
                await setupOffscreenDocument();

                // Forward message to offscreen document
                const embeddingResult = await chrome.runtime.sendMessage({
                    ...message,
                    target: 'offscreen'
                });

                sendResponse(embeddingResult);
            } catch (error: any) {
                console.error("Error generating embedding in background:", error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true; // Indicates asynchronous response
    }

    if (message.type === 'START_EXTRACTION') {
        const { tabId, apiKey, llmModel, llmProvider } = message;
        if (!activeExtractions[tabId]) {
            executeExtractionInBackground(tabId, apiKey, llmModel, llmProvider);
        }
        sendResponse({ success: true, status: activeExtractions[tabId] || "Starting extraction..." });
        return true;
    }

    if (message.type === 'GET_EXTRACTION_STATUS') {
        const { tabId } = message;
        sendResponse({
            isActive: !!activeExtractions[tabId],
            status: activeExtractions[tabId] || null
        });
        return true;
    }
});
