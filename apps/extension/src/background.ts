// background.ts
// Service worker for the extension

import type { ExtractionResult } from "./utils/parser";
import { extractRecipeWithClaude, askSubstitutionWithClaude } from "./utils/parser";
import { syncRecipeToCloud, deleteRecipeFromCloud, syncAllFromCloud, getCloudLatestTimestamp } from './utils/sync';
import { saveRecipeLocally, getRecipe, getAllRecipes } from "./utils/db";

let creating: Promise<void> | null;

// Track active extractions by normalized URL
interface ExtractionState {
    status: string;
    tabId: number;
    title?: string;
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

/**
 * Parses a JWT payload and checks if it is expired or within `bufferMinutes` of expiring.
 */
function isTokenExpired(token: string, bufferMinutes: number = 5): boolean {
    try {
        // JWT is header.payload.signature
        const payloadBase64Url = token.split(".")[1];
        if (!payloadBase64Url) return true;

        // Convert Base64Url to Base64
        const payloadBase64 = payloadBase64Url.replace(/-/g, "+").replace(/_/g, "/");
        const jsonPayload = decodeURIComponent(
            atob(payloadBase64)
                .split("")
                .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
                .join("")
        );

        const decoded = JSON.parse(jsonPayload);
        if (!decoded.exp) return true;

        // exp is in seconds, convert to ms
        const expiresAt = decoded.exp * 1000;
        const now = Date.now();
        const bufferMs = bufferMinutes * 60 * 1000;

        return now >= (expiresAt - bufferMs);
    } catch (e) {
        console.warn("[Auth] Failed to decode JWT to check expiry", e);
        return true; // Assume expired if we can't parse it
    }
}

/**
 * Attempts to silently refresh the Supabase access token using the stored refresh token.
 * Persists the new access token to chrome.storage.local on success.
 * Returns the fresh access token, or null if refresh fails.
 */
async function refreshSupabaseToken(): Promise<string | null> {
    const stored = await chrome.storage.local.get([
        "supabaseRefreshToken",
        "supabaseToken",
        "supabaseUrl",
        "supabaseAnonKey"
    ]);

    const supabaseUrl = stored.supabaseUrl as string;
    const supabaseAnonKey = stored.supabaseAnonKey as string;
    const refreshToken = stored.supabaseRefreshToken as string | undefined;
    const currentToken = stored.supabaseToken as string | undefined;

    if (!refreshToken) {
        console.warn("[Auth] No refresh token stored — user must re-authenticate.");
        return null;
    }

    if (!supabaseUrl || supabaseUrl.includes("your-project-ref")) {
        // BYOK mode — no Supabase configured, skip refresh
        return currentToken ?? null;
    }

    // If we have a valid token that isn't expiring soon, just use it
    if (currentToken && !isTokenExpired(currentToken)) {
        return currentToken;
    }

    console.log("[Auth] Token is missing or expiring soon. Attempting refresh...");

    const resolvedAnonKey = supabaseAnonKey;

    if (!resolvedAnonKey) {
        // Anon key is missing from storage — user must re-authenticate.
        throw new Error("Session expired. Please sign out and sign in again to refresh your credentials.");
    }

    try {
        const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "apikey": resolvedAnonKey },
            body: JSON.stringify({ refresh_token: refreshToken }),
        });

        if (!res.ok) {
            console.warn("[Auth] Token refresh failed:", res.status, await res.text());
            return null;
        }

        const data = await res.json();
        const newAccessToken: string = data.access_token;
        const newRefreshToken: string = data.refresh_token;

        if (newAccessToken) {
            await chrome.storage.local.set({
                supabaseToken: newAccessToken,
                supabaseRefreshToken: newRefreshToken ?? refreshToken,
            });
            console.log("[Auth] Token refreshed successfully.");
            return newAccessToken;
        }
    } catch (err) {
        console.warn("[Auth] Token refresh threw:", err);
    }

    return null;
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

async function updateExtractionStatus(url: string, tabId: number, status: string, isError: boolean = false, isComplete: boolean = false, recipeTitle?: string) {
    const normUrl = normalizeUrl(url);
    const existingTitle = activeExtractions[normUrl]?.title;
    const finalTitle = recipeTitle || existingTitle;

    if (isComplete || isError) {
        delete activeExtractions[normUrl];
        chrome.action.setBadgeText({ text: isError ? "ERR" : "✓", tabId }).catch(() => { });
        chrome.action.setBadgeBackgroundColor({ color: isError ? "#EF4444" : "#10B981", tabId }).catch(() => { });
    } else {
        activeExtractions[normUrl] = { status, tabId, title: finalTitle };
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
            isComplete,
            recipeTitle: finalTitle
        });
    } catch (e) {
        // Popup is closed, ignore error
    }

    // Artificial delay so the user can actually read the status messages as they stream in
    if (!isComplete && !isError) {
        await new Promise(r => setTimeout(r, 1500));
    }
}

async function executeExtractionInBackground(url: string, tabId: number, apiKey: string, llmModel: string, llmProvider: string, authMode: string) {
    try {
        startKeepAlive();

        // Proactively refresh the Supabase token before the LLM call to avoid mid-request 401s.
        // Only relevant for the cloud mode that authenticates via Supabase JWTs.
        if (authMode === "cloud") {
            const freshToken = await refreshSupabaseToken();
            if (freshToken) {
                apiKey = freshToken;
            } else {
                console.warn("[Auth] Could not refresh token; proceeding with existing key.");
            }
        }

        await updateExtractionStatus(url, tabId, "Extracting page content...");
        console.log(`[MyPantry] Starting background extraction for ${url} (tab ${tabId}) with ${llmProvider} model: ${llmModel} (mode: ${authMode})`);

        // Delegate all three extraction tiers to the dynamically injected content script.
        // The content script runs in the page's DOM context and handles the
        // JSON-LD → DOM-target → Readability cascade internally.
        const sendExtractMessage = (): Promise<{ result: ExtractionResult | null; error?: string; noListener?: boolean }> => {
            return new Promise((resolve) => {
                chrome.tabs.sendMessage(
                    tabId,
                    { type: "EXTRACT_PAGE" },
                    (response) => {
                        if (chrome.runtime.lastError) {
                            resolve({ result: null, noListener: true });
                            return;
                        }
                        resolve(response || { result: null });
                    }
                );
            });
        };

        let response = await sendExtractMessage();

        if (response.noListener) {
            console.log("[MyPantry] Content script not present, injecting...");
            try {
                await chrome.scripting.executeScript({
                    target: { tabId },
                    files: ["content.js"]
                });
                // Wait briefly for the script to initialize
                await new Promise(r => setTimeout(r, 100));

                response = await sendExtractMessage();

                if (response.noListener) {
                    throw new Error("Content script injection failed to initialize.");
                }
            } catch (err: any) {
                console.error("[MyPantry] Failed to inject content script:", err);
                throw new Error("Could not access page content. Please try reloading the tab. Error: " + err.message);
            }
        }

        if (response.error) {
            throw new Error(response.error);
        }

        const extractedData = response.result;
        if (!extractedData) {
            throw new Error("Extraction failed: No results returned from page.");
        }

        const recipeTitle = (extractedData as any)?.jsonLd?.name || undefined;

        if (extractedData.source === "json-ld") {
            const hasText = !!extractedData.recipeText;
            console.log(`[MyPantry] JSON-LD schema found (Contains dom text? ${hasText})`);
            await updateExtractionStatus(url, tabId, "Analyzing structured recipe data...", false, false, recipeTitle);
        } else if (extractedData.source === "dom-target") {
            console.log(`[MyPantry] Extracted recipe card only`, `Text length: ${extractedData.recipeText?.length ?? 0} chars.`);
            const charCount = extractedData.recipeText?.length ?? 0;
            const formattedCount = new Intl.NumberFormat().format(charCount);
            await updateExtractionStatus(url, tabId, `Processing localized recipe card (${formattedCount} chars)...`, false, false, recipeTitle);
        } else {
            console.log("[MyPantry] Used comprehensive Readability fallback.", `Text length: ${extractedData.textContent?.length ?? 0} chars.`);
            const charCount = extractedData.textContent?.length ?? 0;
            const formattedCount = new Intl.NumberFormat().format(charCount);
            if (charCount > 10000) {
                await updateExtractionStatus(url, tabId, `Processing large text (${formattedCount} chars)...`, false, false, recipeTitle);
            } else {
                await updateExtractionStatus(url, tabId, `Reading page text (${formattedCount} chars)...`, false, false, recipeTitle);
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

        console.log("[MyPantry] Sending request to LLM API...");
        await updateExtractionStatus(url, tabId, `Asking ${llmProvider} to process ~${formattedPayloadCount} tokens...`);

        const { recipeData } = await extractRecipeWithClaude(
            extractedData,
            apiKey,
            llmModel,
            llmProvider,
            authMode
        );

        console.log("Successfully parsed recipe:", recipeData);
        await updateExtractionStatus(url, tabId, "Successfully extracted recipe data!");

        await updateExtractionStatus(url, tabId, "Generating embedding vector...");
        console.log("[MyPantry] Requesting embedding...");

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
            console.log(`[MyPantry] Embedding generated (${embeddingResult.embedding.length} dims).`);
            recipeData.embedding = embeddingResult.embedding;
        } else {
            console.warn("[MyPantry] Embedding failed, saving without vector:", embeddingResult?.error);
        }

        await updateExtractionStatus(url, tabId, "Saving to local database...");
        console.log("[MyPantry] Saving recipe to IndexedDB...");
        await saveRecipeLocally(recipeData);
        console.log("[MyPantry] Saved to IndexedDB successfully.");

        await updateExtractionStatus(url, tabId, "Recipe saved! Open Pantry to view.", false, true);
    } catch (error: any) {
        console.error("Extraction error in background:", error);
        await updateExtractionStatus(url, tabId, `Error: ${error.message || "Unknown error occurred"}`, true, true);
    } finally {
        stopKeepAlive();
    }
}

async function executeSubstitutionInBackground(tabId: number, recipeData: any, userPrompt: string, apiKey: string, llmModel: string, llmProvider: string, authMode: string) {
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
            result = await askSubstitutionWithClaude(recipeData, userPrompt, apiKey, llmModel, llmProvider, authMode);
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
    // ── Tab-Capture Auth: the content script on mypantry.dev/auth/callback ──
    // forwards the Supabase session it read from localStorage. We persist the
    // tokens, close the login tab, and notify the setup page to advance.
    if (message.type === 'AUTH_SESSION_CAPTURED') {
        (async () => {
            const { accessToken, refreshToken } = message;
            await chrome.storage.local.set({
                supabaseToken: accessToken,
                supabaseRefreshToken: refreshToken ?? null,
            });

            // Close the auth tab so the user lands back on whatever they had open
            if (sender.tab?.id != null) {
                chrome.tabs.remove(sender.tab.id);
            }

            // Notify the setup page (if it's still open) to advance its UI state
            try {
                await chrome.runtime.sendMessage({ type: 'AUTH_COMPLETE' });
            } catch {
                // Setup page might already be closed — not an error
            }

            sendResponse({ success: true });
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
        const { tabId, url, apiKey, llmModel, llmProvider, authMode } = message;
        const normUrl = normalizeUrl(url);
        if (!activeExtractions[normUrl]) {
            executeExtractionInBackground(normUrl, tabId, apiKey, llmModel, llmProvider, authMode);
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
        const { tabId, recipeData, userPrompt, apiKey, llmModel, llmProvider, authMode } = message;
        // Don't await this, let it run in the background
        executeSubstitutionInBackground(tabId, recipeData, userPrompt, apiKey, llmModel, llmProvider, authMode);
        sendResponse({ success: true });
        return true;
    }

    if (message.type === 'PUSH_ALL_LOCAL_TO_CLOUD') {
        // Used during cold boot sync to push local recipes that were never
        // synced to the cloud (e.g. saved before cloud sync was working).
        (async () => {
            try {
                const localRecipes = await getAllRecipes();
                let pushedCount = 0;
                for (const recipe of localRecipes) {
                    try {
                        await syncRecipeToCloud(recipe);
                        pushedCount++;
                    } catch (err) {
                        console.warn(`[Sync] Failed to push recipe '${recipe.id}':`, err);
                    }
                }
                sendResponse({ success: true, pushed: pushedCount, total: localRecipes.length });
            } catch (err: any) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    if (message.type === 'GET_CLOUD_LATEST') {
        // Cheap single-row query used by the pantry dashboard on open
        // to decide whether a delta sync is needed.
        (async () => {
            try {
                const latest = await getCloudLatestTimestamp();
                sendResponse({ success: true, latest_updated_at: latest });
            } catch (err: any) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    if (message.type === 'SYNC_FROM_CLOUD') {
        // Triggered by the pantry dashboard after detecting a cloud-ahead state.
        // `message.since` is passed from the pantry's lastSyncAt so only new
        // recipes are fetched — making repeated calls very cheap.
        (async () => {
            try {
                const since = message.since as string | undefined;
                const cloudRecipes = await syncAllFromCloud(since);
                let mergedCount = 0;

                for (const cloudRecipe of cloudRecipes) {
                    const local = await getRecipe(cloudRecipe.id);
                    const cloudTs = cloudRecipe.createdAt ?? 0;
                    const localTs = local?.createdAt ?? 0;
                    if (!local || cloudTs > localTs) {
                        await saveRecipeLocally(cloudRecipe);
                        mergedCount++;
                    }
                }

                // Record this sync time for the next differential fetch
                const syncedAt = new Date().toISOString();
                await chrome.storage.local.set({ lastSyncAt: syncedAt });

                sendResponse({ success: true, merged: mergedCount, total: cloudRecipes.length, syncedAt });
            } catch (err: any) {
                console.warn('[Sync] Manual sync failed:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
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
