/**
 * Background extraction job.
 *
 * Orchestrates the full recipe extraction pipeline:
 *   content script → LLM → embedding → IndexedDB save
 */

import type { ExtractionResult } from "../utils/llmClient";
import { extractRecipe } from "../utils/parser";
import { saveRecipeLocally } from "../utils/db";
import { refreshSupabaseToken } from "../utils/authUtils";
import { isCancelled, updateExtractionStatus } from "../utils/extractionSession";
import { startKeepAlive, stopKeepAlive } from "./keepAlive";
import { setupOffscreenDocument } from "./offscreen";
import { MSG } from "../utils/messages";

declare const chrome: any;

export async function executeExtractionInBackground(
    url: string,
    tabId: number,
    apiKey: string,
    llmModel: string,
    llmProvider: string,
    authMode: string
): Promise<void> {
    try {
        startKeepAlive();

        // Proactively refresh the Supabase token to avoid mid-request 401s
        if (authMode === "cloud") {
            const freshToken = await refreshSupabaseToken();
            if (freshToken) {
                apiKey = freshToken;
            } else {
                console.warn("[Auth] Could not refresh token; proceeding with existing key.");
            }
        }

        await updateExtractionStatus(url, tabId, "Extracting page content...");
        console.log(
            `[MyPantry] Starting background extraction for ${url} (tab ${tabId}) with ${llmProvider} model: ${llmModel} (mode: ${authMode})`
        );

        // Delegate extraction to the content script (JSON-LD → DOM-target → Readability cascade)
        const sendExtractMessage = (): Promise<{
            result: ExtractionResult | null;
            error?: string;
            noListener?: boolean;
        }> =>
            new Promise((resolve) => {
                chrome.tabs.sendMessage(tabId, { type: MSG.extractPage }, (response: any) => {
                    if (chrome.runtime.lastError) {
                        resolve({ result: null, noListener: true });
                        return;
                    }
                    resolve(response || { result: null });
                });
            });

        let response = await sendExtractMessage();

        if (response.noListener) {
            console.log("[MyPantry] Content script not present, injecting...");
            try {
                await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
                await new Promise((r) => setTimeout(r, 100));
                response = await sendExtractMessage();
                if (response.noListener) {
                    throw new Error("Content script injection failed to initialize.");
                }
            } catch (err: any) {
                console.error("[MyPantry] Failed to inject content script:", err);
                throw new Error("Could not access page content. Please try reloading the tab. Error: " + err.message);
            }
        }

        if (response.error) throw new Error(response.error);

        const extractedData = response.result;
        if (!extractedData) throw new Error("Extraction failed: No results returned from page.");

        const recipeTitle = (extractedData as any)?.jsonLd?.name || undefined;

        if (extractedData.source === "json-ld") {
            const hasText = !!extractedData.recipeText;
            console.log(`[MyPantry] JSON-LD schema found (Contains dom text? ${hasText})`);
            await updateExtractionStatus(url, tabId, "Analyzing structured recipe data...", false, false, recipeTitle);
        } else if (extractedData.source === "dom-target") {
            const charCount = extractedData.recipeText?.length ?? 0;
            const formattedCount = new Intl.NumberFormat().format(charCount);
            console.log(`[MyPantry] Extracted recipe card only`, `Text length: ${charCount} chars.`);
            await updateExtractionStatus(url, tabId, `Processing localized recipe card (${formattedCount} chars)...`, false, false, recipeTitle);
        } else {
            const charCount = extractedData.textContent?.length ?? 0;
            const formattedCount = new Intl.NumberFormat().format(charCount);
            console.log("[MyPantry] Used comprehensive Readability fallback.", `Text length: ${charCount} chars.`);
            const msg = charCount > 10000
                ? `Processing large text (${formattedCount} chars)...`
                : `Reading page text (${formattedCount} chars)...`;
            await updateExtractionStatus(url, tabId, msg, false, false, recipeTitle);
        }

        const baseCount =
            extractedData.source === "json-ld"
                ? JSON.stringify(extractedData.jsonLd).length
                : extractedData.source === "dom-target"
                ? (extractedData.recipeText?.length ?? 0)
                : (extractedData.textContent?.length ?? 0);
        const approxTokens = Math.ceil((baseCount + 1500) / 4);
        const formattedPayloadCount = new Intl.NumberFormat().format(approxTokens);

        console.log("[MyPantry] Sending request to LLM API...");
        await updateExtractionStatus(url, tabId, `Asking ${llmProvider} to process ~${formattedPayloadCount} tokens...`);

        const { recipeData } = await extractRecipe(extractedData, apiKey, llmModel, llmProvider, authMode);

        console.log("Successfully parsed recipe:", recipeData);
        await updateExtractionStatus(url, tabId, "Successfully extracted recipe data!");
        await updateExtractionStatus(url, tabId, "Generating embedding vector...");
        console.log("[MyPantry] Requesting embedding...");

        const textToEmbed = [
            recipeData.title,
            recipeData.semantic_summary,
            ...(recipeData.ingredients?.map((i: any) => i.item) || []),
        ]
            .filter(Boolean)
            .join(". ");

        await setupOffscreenDocument();

        const embeddingResult: { success: boolean; embedding?: number[]; error?: string } =
            await chrome.runtime.sendMessage({
                type: MSG.generateEmbedding,
                target: "offscreen",
                text: textToEmbed,
            });

        let embeddingFailed = false;
        if (embeddingResult?.success && embeddingResult.embedding) {
            console.log(`[MyPantry] Embedding generated (${embeddingResult.embedding.length} dims).`);
            recipeData.embedding = embeddingResult.embedding;
        } else {
            console.warn("[MyPantry] Embedding failed, saving without vector:", embeddingResult?.error);
            embeddingFailed = true;
        }

        if (await isCancelled(url)) {
            console.log(`[MyPantry] Extraction for ${url} was cancelled, not saving.`);
            return;
        }

        await updateExtractionStatus(url, tabId, "Saving to local database...");
        console.log("[MyPantry] Saving recipe to IndexedDB...");
        await saveRecipeLocally(recipeData);
        console.log("[MyPantry] Saved to IndexedDB successfully.");

        const savedMsg = embeddingFailed
            ? "Recipe saved (no semantic search — embedding failed). Open Pantry to view."
            : "Recipe saved! Open Pantry to view.";
        await updateExtractionStatus(url, tabId, savedMsg, false, true);
    } catch (error: any) {
        console.error("Extraction error in background:", error);
        await updateExtractionStatus(url, tabId, `Error: ${error.message || "Unknown error occurred"}`, true, true);
    } finally {
        stopKeepAlive();
    }
}
