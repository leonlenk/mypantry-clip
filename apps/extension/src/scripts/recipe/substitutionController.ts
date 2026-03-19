/**
 * Substitution modal controller.
 *
 * Handles all AI-substitution UX:
 *  - Open / close / discard the modal
 *  - Send the substitution request to the background script
 *  - Listen for SUBSTITUTION_STATUS_UPDATE messages and update the UI
 *  - Apply or discard suggested substitutions
 *
 * Reads `recipeState.currentRecipe` (shared mutable singleton) so it always
 * reflects the latest value set by recipeController.ts.
 */

import { saveRecipeLocally } from "../../utils/db";
import { renderIngredients } from "./ingredientsRenderer";
import { recipeState } from "./recipeState";
import { getLocal } from "../../utils/storage";
import { MSG } from "../../utils/messages";

declare const chrome: any;

// ─── DOM handles ─────────────────────────────────────────────────────────────

const subModal = document.getElementById("sub-modal");
const openSubBtn = document.getElementById("open-sub-modal-btn");
const closeSubBtn = document.getElementById("close-sub-modal-btn");
const subInput = document.getElementById("sub-input") as HTMLInputElement;
const subSendBtn = document.getElementById("sub-send-btn");
const subStatusArea = document.getElementById("sub-status-area");
const subStatusText = document.getElementById("sub-status-text");
const subResultArea = document.getElementById("sub-result-area");
const subReasoningText = document.getElementById("sub-reasoning-text");
const subSuggestionsContainer = document.getElementById("sub-suggestions-container");
const applySubBtn = document.getElementById("apply-sub-btn");
const discardSubBtn = document.getElementById("discard-sub-btn");

let currentSubResult: any = null;

// ─── Open / close ─────────────────────────────────────────────────────────────

function openModal() {
    subModal?.classList.remove("hidden");
    subInput?.focus();
    document.body.style.overflow = "hidden";
}

function closeModal() {
    subModal?.classList.add("hidden");
    subStatusArea?.classList.add("hidden");
    subResultArea?.classList.add("hidden");
    document.body.style.overflow = "";
}

openSubBtn?.addEventListener("click", openModal);
closeSubBtn?.addEventListener("click", closeModal);

discardSubBtn?.addEventListener("click", () => {
    closeModal();
    subInput.value = "";
    currentSubResult = null;
});

// ─── Send request ─────────────────────────────────────────────────────────────

subSendBtn?.addEventListener("click", async () => {
    const recipe = recipeState.currentRecipe;
    const prompt = subInput.value.trim();
    if (!prompt || !recipe) return;

    subStatusArea?.classList.remove("hidden");
    subResultArea?.classList.add("hidden");
    if (subStatusText) subStatusText.textContent = "Starting AI substitution analysis...";

    const { plaintextApiKey, supabaseToken, llmModel, llmProvider, apiMode } =
        await getLocal(["plaintextApiKey", "supabaseToken", "llmModel", "llmProvider", "apiMode"]);
    const provider = llmProvider || "anthropic";

    const resolvedApiMode = apiMode ?? (supabaseToken ? "cloud" : "byok");
    const apiKey = resolvedApiMode === "cloud" ? supabaseToken : plaintextApiKey;
    const authMode = resolvedApiMode === "cloud" ? "cloud" : "byok";

    if (!apiKey) {
        if (subStatusText)
            subStatusText.textContent = `Error: No API key configured. Please add one in API Settings.`;
        return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs: any[]) => {
        const tabId = tabs[0]?.id;
        chrome.runtime.sendMessage({
            type: MSG.askSubstitution,
            tabId,
            recipeData: recipe,
            userPrompt: prompt,
            apiKey,
            llmModel: llmModel || "claude-3-5-sonnet-20241022",
            llmProvider: provider,
            authMode,
        });
    });
});

subInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") subSendBtn?.click();
});

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: any) => {
    if (message.type !== MSG.substitutionStatusUpdate) return;

    subStatusArea?.classList.remove("hidden");
    if (subStatusText) subStatusText.textContent = message.status;

    if (message.isComplete) {
        subStatusArea?.classList.add("hidden");

        if (!message.isError && message.result) {
            subResultArea?.classList.remove("hidden");
            currentSubResult = message.result;

            if (subReasoningText)
                subReasoningText.textContent = currentSubResult.thoughtProcess;

            if (subSuggestionsContainer) {
                subSuggestionsContainer.innerHTML = "<h3>Suggested Substitutions</h3>";
                if (currentSubResult.substitutions && Array.isArray(currentSubResult.substitutions)) {
                    currentSubResult.substitutions.forEach((sub: any, i: number) => {
                        const label = document.createElement("label");
                        label.className = "suggestion-label";
                        label.innerHTML = `<input type="checkbox" class="sub-checkbox" data-index="${i}" checked />
                                           <span class="suggestion-text">${sub.rawText}</span>`;
                        subSuggestionsContainer.appendChild(label);
                    });
                }
            }
        } else if (message.isError) {
            subStatusArea?.classList.remove("hidden");
            if (subStatusText) subStatusText.textContent = message.status;
        }
    }
});

// ─── Apply button ─────────────────────────────────────────────────────────────

applySubBtn?.addEventListener("click", async () => {
    const recipe = recipeState.currentRecipe;
    if (!recipe || !currentSubResult?.substitutions) return;

    const checkboxes = document.querySelectorAll(".sub-checkbox") as NodeListOf<HTMLInputElement>;
    const checkedIndices = Array.from(checkboxes)
        .filter((cb) => cb.checked)
        .map((cb) => parseInt(cb.getAttribute("data-index") || "-1", 10));

    let appliedCount = 0;

    currentSubResult.substitutions.forEach((subResult: any, i: number) => {
        if (!checkedIndices.includes(i)) return;

        const targetIndex = subResult.ingredientId;
        if (
            typeof targetIndex === "number" &&
            targetIndex >= 0 &&
            targetIndex < recipe.ingredients.length
        ) {
            recipe.ingredients[targetIndex].substituted = {
                quantity: subResult.quantity,
                unit: subResult.unit,
                item: subResult.item,
                preparation: subResult.preparation,
                rawText: subResult.rawText,
            };
            appliedCount++;
        }
    });

    if (appliedCount > 0) {
        await saveRecipeLocally(recipe);

        const batchInput = document.getElementById("batch-input") as HTMLInputElement;
        const mult = batchInput
            ? parseFloat(batchInput.value) / recipeState.originalBatchSize
            : 1;
        renderIngredients(recipe, isNaN(mult) ? 1 : mult);

        closeModal();
        subInput.value = "";
        currentSubResult = null;
    } else {
        alert(
            "Could not automatically map the substitution to the original ingredients using their IDs. Please try again."
        );
    }
});
