// background.ts — Service worker: keep-alive, offscreen setup, and message routing.
// Heavy lifting is delegated to modules in background/ and utils/.

import { syncRecipeToCloud, deleteRecipeFromCloud, syncAllFromCloud, getCloudLatestTimestamp } from "./utils/sync";
import { saveRecipeLocally, getRecipe, getAllRecipes } from "./utils/db";
import { refreshSupabaseToken } from "./utils/authUtils";
import { getLocal, setLocal } from "./utils/storage";
import {
    normalizeUrl,
    getActiveExtractions,
    setActiveExtractions,
    markCancelled,
} from "./utils/extractionSession";
import { setupOffscreenDocument } from "./background/offscreen";
import { executeExtractionInBackground } from "./background/extractionJob";
import { executeSubstitutionInBackground } from "./background/substitutionJob";
import { MSG } from "./utils/messages";

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details: any) => {
    if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
        chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") });
    }
});

// Re-apply badges if a tab updates or navigates while extraction is still running
chrome.tabs.onUpdated.addListener(async (tabId: number, changeInfo: any, tab: any) => {
    if (changeInfo.status === "complete" && tab.url) {
        const normUrl = normalizeUrl(tab.url);
        const map = await getActiveExtractions();
        const active = map[normUrl];
        if (active) {
            active.tabId = tabId;
            await setActiveExtractions(map);
            chrome.action.setBadgeText({ text: "...", tabId }).catch(() => {});
            chrome.action.setBadgeBackgroundColor({ color: "#F59E0B", tabId }).catch(() => {});
        }
    }
});

// ─── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: any, sender: any, sendResponse: any) => {
    // Auth: content script on mypantry.dev/api/auth/callback forwards the session
    if (message.type === MSG.authSessionCaptured) {
        (async () => {
            const { accessToken, refreshToken } = message;
            await setLocal({
                supabaseToken: accessToken,
                supabaseRefreshToken: refreshToken ?? null,
            });
            if (sender.tab?.id != null) chrome.tabs.remove(sender.tab.id);
            try {
                await chrome.runtime.sendMessage({ type: MSG.authComplete });
            } catch {
                // Setup page already closed — not an error
            }
            sendResponse({ success: true });
        })();
        return true;
    }

    if (message.type === MSG.generateEmbedding) {
        (async () => {
            try {
                await setupOffscreenDocument();
                const embeddingResult = await chrome.runtime.sendMessage({
                    ...message,
                    target: "offscreen",
                });
                sendResponse(embeddingResult);
            } catch (error: any) {
                console.error("Error generating embedding in background:", error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    }

    if (message.type === MSG.startExtraction) {
        const { tabId, url, apiKey, llmModel, llmProvider, authMode } = message;
        const normUrl = normalizeUrl(url);
        (async () => {
            const map = await getActiveExtractions();
            if (!map[normUrl]) {
                executeExtractionInBackground(normUrl, tabId, apiKey, llmModel, llmProvider, authMode);
            }
            sendResponse({ success: true, status: map[normUrl]?.status || "Starting extraction..." });
        })();
        return true;
    }

    if (message.type === MSG.getExtractionStatus) {
        const normUrl = normalizeUrl(message.url);
        (async () => {
            const map = await getActiveExtractions();
            const active = map[normUrl];
            sendResponse({ isActive: !!active, status: active ? active.status : null });
        })();
        return true;
    }

    if (message.type === MSG.getAllExtractions) {
        (async () => {
            const map = await getActiveExtractions();
            sendResponse({ extractions: map });
        })();
        return true;
    }

    if (message.type === MSG.cancelExtraction) {
        const normUrl = normalizeUrl(message.url);
        (async () => {
            await markCancelled(normUrl);
            const map = await getActiveExtractions();
            delete map[normUrl];
            await setActiveExtractions(map);
            sendResponse({ success: true });
        })();
        return true;
    }

    if (message.type === MSG.askSubstitution) {
        const { tabId, recipeData, userPrompt, apiKey, llmModel, llmProvider, authMode } = message;
        executeSubstitutionInBackground(tabId, recipeData, userPrompt, apiKey, llmModel, llmProvider, authMode);
        sendResponse({ success: true });
        return true;
    }

    if (message.type === MSG.pushAllLocalToCloud) {
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

    if (message.type === MSG.getCloudLatest) {
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

    if (message.type === MSG.syncFromCloud) {
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
                const syncedAt = new Date().toISOString();
                await setLocal({ lastSyncAt: syncedAt });
                sendResponse({ success: true, merged: mergedCount, total: cloudRecipes.length, syncedAt });
            } catch (err: any) {
                console.warn("[Sync] Manual sync failed:", err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    if (message.type === MSG.shareRecipe) {
        (async () => {
            try {
                const stored = await getLocal(["supabaseToken", "llmProvider", "apiUrl"]);
                if (stored.llmProvider !== "google" || !stored.supabaseToken) {
                    sendResponse({ success: false, error: "not_authenticated" });
                    return;
                }
                const freshToken = await refreshSupabaseToken();
                const token = freshToken ?? stored.supabaseToken;
                const apiBase = stored.apiUrl ?? "http://127.0.0.1:8000";
                const res = await fetch(`${apiBase}/share`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify({ recipes: message.recipes }),
                });
                if (res.ok) {
                    const data = await res.json();
                    sendResponse({ success: true, url: data.url });
                } else {
                    const text = await res.text().catch(() => res.status.toString());
                    console.warn(`[Share] API error (${res.status}):`, text);
                    sendResponse({ success: false, error: "api_error", status: res.status });
                }
            } catch (err: any) {
                console.warn("[Share] Network error:", err?.message ?? err);
                sendResponse({ success: false, error: "network_error" });
            }
        })();
        return true;
    }

    if (message.type === MSG.importSharedRecipe) {
        (async () => {
            try {
                const recipes: any[] = message.recipes ?? (message.recipe ? [message.recipe] : []);
                const now = Date.now();
                await setupOffscreenDocument();

                for (const recipe of recipes) {
                    recipe.createdAt = now;
                    const textToEmbed = [
                        recipe.title,
                        recipe.semantic_summary,
                        ...(recipe.ingredients?.map((i: any) => i.item) || []),
                    ]
                        .filter(Boolean)
                        .join(". ");

                    const embeddingResult: { success: boolean; embedding?: number[]; error?: string } =
                        await chrome.runtime.sendMessage({
                            type: MSG.generateEmbedding,
                            target: "offscreen",
                            text: textToEmbed,
                        });

                    if (embeddingResult?.success && embeddingResult.embedding) {
                        recipe.embedding = embeddingResult.embedding;
                    } else {
                        console.warn("[Import] Embedding failed, saving without vector:", embeddingResult?.error);
                    }

                    await saveRecipeLocally(recipe);
                    await syncRecipeToCloud(recipe);
                }

                chrome.runtime.sendMessage({ type: MSG.recipeSavedFromShare }).catch(() => {});
                sendResponse({ success: true });
            } catch (err: any) {
                console.warn("[Import] Failed to import shared recipe:", err?.message ?? err);
                sendResponse({ success: false });
            }
        })();
        return true;
    }

});
