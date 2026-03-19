/**
 * Background substitution job.
 *
 * Sends the substitution request to the LLM and forwards
 * progressive status updates to the recipe page content script.
 */

import { askSubstitution } from "../utils/substitutionParser";
import { refreshSupabaseToken } from "../utils/authUtils";
import { startKeepAlive, stopKeepAlive } from "./keepAlive";
import { MSG } from "../utils/messages";

declare const chrome: any;

export async function executeSubstitutionInBackground(
    tabId: number,
    recipeData: any,
    userPrompt: string,
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

        const mappedIngredients = recipeData.ingredients
            .map((ing: any, index: number) => `[ID: ${index}] - ${ing.item} (${ing.rawText})`)
            .join("\n");
        const payloadStr = `Title: ${recipeData.title}\nYield: ${recipeData.yield ?? recipeData.servings}\nIngredients:\n${mappedIngredients}\nUser Request: ${userPrompt}`;
        const approximateTokens = Math.ceil(payloadStr.length / 4);

        chrome.tabs
            .sendMessage(tabId, {
                type: MSG.substitutionStatusUpdate,
                status: `Analyzing request (~${approximateTokens} tokens)...`,
                isComplete: false,
                isError: false,
            })
            .catch(() => {});

        const statuses = [
            "Reviewing ingredient chemistry...",
            "Calculating mathematical adjustments...",
            "Finalizing substitution mapping...",
        ];

        let statusIndex = 0;
        const statusInterval = setInterval(() => {
            if (statusIndex < statuses.length) {
                chrome.tabs
                    .sendMessage(tabId, {
                        type: MSG.substitutionStatusUpdate,
                        status: statuses[statusIndex],
                        isComplete: false,
                        isError: false,
                    })
                    .catch(() => {});
                statusIndex++;
            }
        }, 3000);

        let result;
        try {
            result = await askSubstitution(recipeData, userPrompt, apiKey, llmModel, llmProvider, authMode);
        } finally {
            clearInterval(statusInterval);
        }

        chrome.tabs
            .sendMessage(tabId, {
                type: MSG.substitutionStatusUpdate,
                status: "Substitutions generated successfully!",
                result,
                isComplete: true,
                isError: false,
            })
            .catch(() => {});
    } catch (error: any) {
        console.error("Substitution error in background:", error);
        chrome.tabs
            .sendMessage(tabId, {
                type: MSG.substitutionStatusUpdate,
                status: `Error: ${error.message || "Unknown error occurred"}`,
                isComplete: true,
                isError: true,
            })
            .catch(() => {});
    } finally {
        stopKeepAlive();
    }
}
