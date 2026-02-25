// background.ts
// Service worker for the extension

import { checkJsonLd, extractDomTarget, extractWithReadability, extractRecipeWithClaude, askSubstitutionWithClaude } from "./utils/parser";
import { saveRecipeLocally } from "./utils/db";

let creating: Promise<void> | null;

// Track active extractions by normalized URL
interface ExtractionState {
    status: string;
    tabId: number;
}
const activeExtractions: Record<string, ExtractionState> = {};

// Keep-alive mechanism to prevent service worker from sleeping during long LLM requests
let keepAliveInterval: any = null;
let activeJobsCount = 0;

function startKeepAlive() {
    activeJobsCount++;
    if (activeJobsCount === 1 && !keepAliveInterval) {
        // Ping a chrome API every 20 seconds to reset the 30s idle timeout
        keepAliveInterval = setInterval(() => {
            if (chrome.runtime?.getPlatformInfo) {
                chrome.runtime.getPlatformInfo();
            }
        }, 20000);
    }
}

function stopKeepAlive() {
    activeJobsCount--;
    if (activeJobsCount <= 0) {
        activeJobsCount = 0;
        if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
        }
    }
}

function normalizeUrl(url: string): string {
    return url.replace(/\/$/, "");
}

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

async function updateExtractionStatus(url: string, tabId: number, status: string, isError: boolean = false, isComplete: boolean = false) {
    const normUrl = normalizeUrl(url);
    if (isComplete || isError) {
        delete activeExtractions[normUrl];
        chrome.action.setBadgeText({ text: isError ? "ERR" : "✓", tabId }).catch(() => { });
        chrome.action.setBadgeBackgroundColor({ color: isError ? "#EF4444" : "#10B981", tabId }).catch(() => { });
    } else {
        activeExtractions[normUrl] = { status, tabId };
        chrome.action.setBadgeText({ text: "...", tabId }).catch(() => { });
        chrome.action.setBadgeBackgroundColor({ color: "#F59E0B", tabId }).catch(() => { });
    }

    try {
        // Attempt to send to popup if it's open
        await chrome.runtime.sendMessage({
            type: "EXTRACTION_STATUS_UPDATE",
            url: normUrl,
            status,
            isError,
            isComplete
        });
    } catch (e) {
        // Popup is closed, ignore error
    }

    // Artificial delay so the user can actually read the status messages as they stream in
    if (!isComplete && !isError) {
        await new Promise(r => setTimeout(r, 1500));
    }
}

async function executeExtractionInBackground(url: string, tabId: number, apiKey: string, llmModel: string, llmProvider: string) {
    try {
        startKeepAlive();
        await updateExtractionStatus(url, tabId, "Extracting page content...");
        console.log(`[Recipe AI] Starting background extraction for ${url} (tab ${tabId}) with ${llmProvider} model: ${llmModel}`);

        console.log("[Recipe AI] Tier 1: Checking for JSON-LD schema...");
        let results = await chrome.scripting.executeScript({
            target: { tabId },
            func: checkJsonLd,
        });

        let extractedData = results?.[0]?.result;

        if (!extractedData) {
            console.log("[Recipe AI] JSON-LD failed. Tier 2: Extracting targeted DOM recipe card...");
            await updateExtractionStatus(url, tabId, "Hunting for recipe card on page...");

            results = await chrome.scripting.executeScript({
                target: { tabId },
                func: extractDomTarget,
            });

            extractedData = results?.[0]?.result;
        }

        if (!extractedData) {
            console.log("[Recipe AI] Targeted DOM extraction failed. Tier 3: Injecting Readability fallback...");
            await updateExtractionStatus(url, tabId, "Loading entire page context (slower)...");

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
            const hasText = !!extractedData.recipeText;
            console.log(`[Recipe AI] JSON-LD schema found (Contains dom text? ${hasText})`);
            await updateExtractionStatus(url, tabId, "Analyzing structured recipe data...");
        } else if (extractedData.source === "dom-target") {
            console.log(`[Recipe AI] Extracted recipe card only`, `Text length: ${extractedData.recipeText?.length ?? 0} chars.`);
            const charCount = extractedData.recipeText?.length ?? 0;
            const formattedCount = new Intl.NumberFormat().format(charCount);
            await updateExtractionStatus(url, tabId, `Processing localized recipe card (${formattedCount} chars)...`);
        } else {
            console.log("[Recipe AI] Used comprehensive Readability fallback.", `Text length: ${extractedData.textContent?.length ?? 0} chars.`);
            const charCount = extractedData.textContent?.length ?? 0;
            const formattedCount = new Intl.NumberFormat().format(charCount);
            if (charCount > 10000) {
                await updateExtractionStatus(url, tabId, `Processing large text (${formattedCount} chars)...`);
            } else {
                await updateExtractionStatus(url, tabId, `Reading page text (${formattedCount} chars)...`);
            }
        }

        // Approximate the payload size before we send it (content + ~1500 chars for system prompt constraints)
        const baseCount = extractedData.source === "json-ld"
            ? JSON.stringify(extractedData.jsonLd).length
            : (extractedData.source === "dom-target" ? (extractedData.recipeText?.length ?? 0) : (extractedData.textContent?.length ?? 0));
        const approxPayloadCharCount = baseCount + 1500;

        // Lightweight token estimation: ~4 chars per token on average for English text
        const approxTokens = Math.ceil(approxPayloadCharCount / 4);
        const formattedPayloadCount = new Intl.NumberFormat().format(approxTokens);

        console.log("[Recipe AI] Sending request to LLM API...");
        await updateExtractionStatus(url, tabId, `Asking ${llmProvider} to process ~${formattedPayloadCount} tokens...`);

        const { recipeData } = await extractRecipeWithClaude(
            extractedData,
            apiKey,
            llmModel,
            llmProvider
        );

        console.log("Successfully parsed recipe:", recipeData);
        await updateExtractionStatus(url, tabId, "Successfully extracted recipe data!");

        await updateExtractionStatus(url, tabId, "Generating embedding vector...");
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

        await updateExtractionStatus(url, tabId, "Saving to local database...");
        console.log("[Recipe AI] Saving recipe to IndexedDB...");
        await saveRecipeLocally(recipeData);
        console.log("[Recipe AI] Saved to IndexedDB successfully.");

        await updateExtractionStatus(url, tabId, "Recipe saved! Open Pantry to view.", false, true);
    } catch (error: any) {
        console.error("Extraction error in background:", error);
        await updateExtractionStatus(url, tabId, `Error: ${error.message || "Unknown error occurred"}`, true, true);
    } finally {
        stopKeepAlive();
    }
}

async function executeSubstitutionInBackground(tabId: number, recipeData: any, userPrompt: string, apiKey: string, llmModel: string, llmProvider: string) {
    try {
        startKeepAlive();

        // Calculate approximate tokens for the ingredients payload and prompt
        const mappedIngredients = recipeData.ingredients.map((ing: any, index: number) => {
            return `[ID: ${index}] - ${ing.item} (${ing.rawText})`;
        }).join("\n");
        const payloadStr = `Title: ${recipeData.title}\nYield: ${recipeData.yield ?? recipeData.servings}\nIngredients:\n${mappedIngredients}\nUser Request: ${userPrompt}`;
        const approximateTokens = Math.ceil(payloadStr.length / 4);

        // Initial progress
        chrome.tabs.sendMessage(tabId, {
            type: "SUBSTITUTION_STATUS_UPDATE",
            status: `Analyzing request (~${approximateTokens} tokens)...`,
            isComplete: false,
            isError: false
        }).catch(() => { });

        // Progressive status updates to keep user engaged
        const statuses = [
            "Reviewing ingredient chemistry...",
            "Calculating mathematical adjustments...",
            "Finalizing substitution mapping..."
        ];

        let statusIndex = 0;
        const statusInterval = setInterval(() => {
            if (statusIndex < statuses.length) {
                chrome.tabs.sendMessage(tabId, {
                    type: "SUBSTITUTION_STATUS_UPDATE",
                    status: statuses[statusIndex],
                    isComplete: false,
                    isError: false
                }).catch(() => { });
                statusIndex++;
            }
        }, 3000); // Update every 3 seconds

        let result;
        try {
            result = await askSubstitutionWithClaude(recipeData, userPrompt, apiKey, llmModel, llmProvider);
        } finally {
            clearInterval(statusInterval);
        }

        chrome.tabs.sendMessage(tabId, {
            type: "SUBSTITUTION_STATUS_UPDATE",
            status: "Substitutions generated successfully!",
            result: result,
            isComplete: true,
            isError: false
        }).catch(() => { });

    } catch (error: any) {
        console.error("Substitution error in background:", error);
        chrome.tabs.sendMessage(tabId, {
            type: "SUBSTITUTION_STATUS_UPDATE",
            status: `Error: ${error.message || "Unknown error occurred"}`,
            isComplete: true,
            isError: true
        }).catch(() => { });
    } finally {
        stopKeepAlive();
    }
}


chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
        chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") });
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'INIT_MODEL_DOWNLOAD') {
        (async () => {
            await setupOffscreenDocument();
            const res = await chrome.runtime.sendMessage({ type: "INIT_MODEL_DOWNLOAD", target: "offscreen" });
            sendResponse(res);
        })();
        return true;
    }

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
        const { tabId, url, apiKey, llmModel, llmProvider } = message;
        const normUrl = normalizeUrl(url);
        if (!activeExtractions[normUrl]) {
            executeExtractionInBackground(normUrl, tabId, apiKey, llmModel, llmProvider);
        }
        sendResponse({ success: true, status: activeExtractions[normUrl]?.status || "Starting extraction..." });
        return true;
    }

    if (message.type === 'GET_EXTRACTION_STATUS') {
        const { url } = message;
        const normUrl = normalizeUrl(url);
        const active = activeExtractions[normUrl];
        sendResponse({
            isActive: !!active,
            status: active ? active.status : null
        });
        return true;
    }

    if (message.type === 'ASK_SUBSTITUTION') {
        const { tabId, recipeData, userPrompt, apiKey, llmModel, llmProvider } = message;
        // Don't await this, let it run in the background
        executeSubstitutionInBackground(tabId, recipeData, userPrompt, apiKey, llmModel, llmProvider);
        sendResponse({ success: true });
        return true;
    }
});

// Re-apply badges if a tab updates or navigates while extraction is still running
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // We only need to re-apply if it finished loading a new page/refresh
    if (changeInfo.status === 'complete' && tab.url) {
        const normUrl = normalizeUrl(tab.url);
        const active = activeExtractions[normUrl];
        if (active) {
            // Update the tab ID we're tracking for this URL since they might have opened it in a new tab
            active.tabId = tabId;
            chrome.action.setBadgeText({ text: "...", tabId }).catch(() => { });
            chrome.action.setBadgeBackgroundColor({ color: "#F59E0B", tabId }).catch(() => { });
        }
    }
});
