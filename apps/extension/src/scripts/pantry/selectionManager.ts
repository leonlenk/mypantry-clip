/**
 * Recipe selection mode and bulk actions (delete, tag, share).
 *
 * Manages the set of selected recipe IDs, renders the bulk-action bar,
 * and handles bulk delete / tag / share operations.
 */

import feather from "feather-icons";
import { getAllRecipes, deleteRecipe, saveRecipeLocally } from "../../utils/db";
import { getLocal, setLocal } from "../../utils/storage";
import { MSG } from "../../utils/messages";
import type { Recipe } from "../../types/recipe";
import { pantryState } from "./pantryState";
import {
    openBulkTagEditor,
    closeBulkTagEditor,
    wireBulkTagInputHandlers,
    hideBulkTagSuggestions,
    bulkTagSuggestionsEl,
} from "./bulkTagEditor";
import { confirmDeleteModal, confirmShareModal, showShareLinksModal, showToast } from "./modals";
import { loadRecipes, renderRecipes } from "./recipeRenderer";

declare const chrome: any;

// ─── DOM handles ─────────────────────────────────────────────────────────────

const grid = document.getElementById("recipe-grid");
const bulkActionBar = document.getElementById("bulk-action-bar");
const bulkSelectedCount = document.getElementById("bulk-selected-count");
const bulkTagBtn = document.getElementById("bulk-tag-btn") as HTMLButtonElement | null;
const bulkShareBtn = document.getElementById("bulk-share-btn") as HTMLButtonElement | null;
const bulkDeleteBtn = document.getElementById("bulk-delete-btn") as HTMLButtonElement | null;
const bulkTagCancelBtn = document.getElementById("bulk-tag-cancel") as HTMLButtonElement | null;
const bulkTagApplyBtn = document.getElementById("bulk-tag-apply") as HTMLButtonElement | null;
const shareConfirmOverlay = document.getElementById("share-confirm-overlay");

// ─── Selection state helpers ──────────────────────────────────────────────────

export function syncSelectionModeClass() {
    pantryState.isSelectionMode = pantryState.selectedRecipeIds.size > 0;
    document.body.classList.toggle("selection-mode", pantryState.isSelectionMode);
}

export function updateSelectionUI() {
    const selectedCount = pantryState.selectedRecipeIds.size;
    if (bulkSelectedCount) {
        bulkSelectedCount.textContent = `${selectedCount} recipe${selectedCount !== 1 ? "s" : ""} selected`;
    }
    bulkActionBar?.classList.toggle("visible", selectedCount > 0);
    if (bulkTagBtn) bulkTagBtn.disabled = selectedCount === 0;
    if (bulkShareBtn) bulkShareBtn.disabled = selectedCount === 0;
    if (bulkDeleteBtn) bulkDeleteBtn.disabled = selectedCount === 0;
    if (selectedCount === 0 && pantryState.isBulkTagEditorOpen) closeBulkTagEditor();
}

export function resetSelection({ keepMode = false }: { keepMode?: boolean } = {}) {
    pantryState.selectedRecipeIds.clear();
    pantryState.lastSelectedRecipeId = null;
    closeBulkTagEditor();
    if (!keepMode) pantryState.isSelectionMode = false;
    grid?.querySelectorAll<HTMLElement>(".recipe-card").forEach((card) => {
        card.classList.remove("selected");
    });
    syncSelectionModeClass();
    updateSelectionUI();
}

export function setCardSelectedState(card: HTMLElement, isSelected: boolean) {
    card.classList.toggle("selected", isSelected);
    card.setAttribute("aria-pressed", String(isSelected));
}

export function toggleRecipeSelection(card: HTMLElement, recipeId: string) {
    if (pantryState.selectedRecipeIds.has(recipeId)) {
        pantryState.selectedRecipeIds.delete(recipeId);
        setCardSelectedState(card, false);
    } else {
        pantryState.selectedRecipeIds.add(recipeId);
        setCardSelectedState(card, true);
    }
    pantryState.lastSelectedRecipeId = recipeId;
    syncSelectionModeClass();
    updateSelectionUI();
}

export function selectRecipeRange(toRecipeId: string) {
    if (!pantryState.lastSelectedRecipeId || pantryState.visibleRecipeOrder.length === 0) {
        pantryState.selectedRecipeIds.add(toRecipeId);
        const card = grid?.querySelector<HTMLElement>(`.recipe-card[data-recipe-id="${toRecipeId}"]`);
        if (card) setCardSelectedState(card, true);
        pantryState.lastSelectedRecipeId = toRecipeId;
        syncSelectionModeClass();
        updateSelectionUI();
        return;
    }

    const fromIndex = pantryState.visibleRecipeOrder.indexOf(pantryState.lastSelectedRecipeId);
    const toIndex = pantryState.visibleRecipeOrder.indexOf(toRecipeId);

    if (fromIndex < 0 || toIndex < 0) {
        pantryState.selectedRecipeIds.add(toRecipeId);
        const card = grid?.querySelector<HTMLElement>(`.recipe-card[data-recipe-id="${toRecipeId}"]`);
        if (card) setCardSelectedState(card, true);
        pantryState.lastSelectedRecipeId = toRecipeId;
        syncSelectionModeClass();
        updateSelectionUI();
        return;
    }

    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);
    for (let i = start; i <= end; i++) {
        const id = pantryState.visibleRecipeOrder[i];
        pantryState.selectedRecipeIds.add(id);
        const card = grid?.querySelector<HTMLElement>(`.recipe-card[data-recipe-id="${id}"]`);
        if (card) setCardSelectedState(card, true);
    }
    pantryState.lastSelectedRecipeId = toRecipeId;
    syncSelectionModeClass();
    updateSelectionUI();
}

// ─── Bulk actions ─────────────────────────────────────────────────────────────

async function applyBulkTags(tagsToApply: string[]) {
    if (tagsToApply.length === 0 || pantryState.selectedRecipeIds.size === 0) return;

    const allRecipes = await getAllRecipes();
    const recipeMap = new Map(allRecipes.map((r) => [r.id, r]));
    const selectedRecipes = Array.from(pantryState.selectedRecipeIds)
        .map((id) => recipeMap.get(id))
        .filter((r): r is Recipe => !!r);

    await Promise.all(
        selectedRecipes.map(async (recipe) => {
            const tags = new Set((recipe.tags || []).map((t) => t.toUpperCase()));
            tagsToApply.forEach((tag) => tags.add(tag));
            recipe.tags = Array.from(tags).sort((a, b) => a.localeCompare(b));
            await saveRecipeLocally(recipe);
        })
    );

    closeBulkTagEditor();
    resetSelection();
    await loadRecipes();
}

async function handleBulkDelete() {
    if (pantryState.selectedRecipeIds.size === 0) return;

    const allRecipes = await getAllRecipes();
    const recipeMap = new Map(allRecipes.map((r) => [r.id, r]));
    const ids = Array.from(pantryState.selectedRecipeIds);
    const titles = ids.map((id) => recipeMap.get(id)?.title ?? id);

    const toDelete = await confirmDeleteModal(ids, titles);
    if (toDelete.length === 0) return;

    // Collect URLs before deletion to fix savedUrls race condition:
    // parallel deleteRecipe calls each do a concurrent read-modify-write on savedUrls,
    // so the last writer wins and some URLs survive. One authoritative cleanup after.
    const urlsToRemove = toDelete
        .map((id) => recipeMap.get(id)?.url)
        .filter((url): url is string => Boolean(url));

    await Promise.all(toDelete.map((id) => deleteRecipe(id)));

    if (urlsToRemove.length > 0 && typeof chrome !== "undefined" && chrome.storage?.local) {
        const data = await getLocal(["savedUrls"]);
        const urls = (data.savedUrls ?? []).filter((u) => !urlsToRemove.includes(u));
        await setLocal({ savedUrls: urls });
    }

    resetSelection();
    await loadRecipes();
}

async function handleBulkTag() {
    if (pantryState.selectedRecipeIds.size === 0) return;
    if (pantryState.isBulkTagEditorOpen) {
        closeBulkTagEditor();
        return;
    }
    openBulkTagEditor();
}

async function handleBulkShare() {
    if (pantryState.selectedRecipeIds.size === 0) return;

    const allRecipes = await getAllRecipes();
    const recipeMap = new Map(allRecipes.map((r) => [r.id, r]));
    const ids = Array.from(pantryState.selectedRecipeIds);
    const titles = ids.map((id) => recipeMap.get(id)?.title ?? id);

    const toShare = await confirmShareModal(ids, titles);
    if (toShare.length === 0) return;

    const selected = toShare.map((id) => recipeMap.get(id)).filter((r): r is Recipe => !!r);
    const cleanRecipes = selected.map(({ embedding: _e, tags: _t, ...r }) => r);

    const res: { success: boolean; url?: string; error?: string } =
        await chrome.runtime.sendMessage({ type: MSG.shareRecipe, recipes: cleanRecipes });

    if (!res.success) {
        if (res.error === "not_authenticated") {
            showToast("Sharing requires a cloud account — sign in with Google in Settings.", "error");
        } else {
            showToast("Failed to create share link. Please try again.", "error");
        }
        return;
    }

    if (!res.url) {
        showToast("No link was returned. Please try again.", "error");
        return;
    }

    try { await navigator.clipboard.writeText(res.url); } catch { /* user can copy from modal */ }
    showShareLinksModal([res.url]);
}

// ─── Wire controls ────────────────────────────────────────────────────────────

export function wireSelectionControls() {
    bulkDeleteBtn?.addEventListener("click", () => handleBulkDelete());
    bulkTagBtn?.addEventListener("click", () => handleBulkTag());
    bulkShareBtn?.addEventListener("click", () => handleBulkShare());
    bulkTagCancelBtn?.addEventListener("click", () => closeBulkTagEditor());
    bulkTagApplyBtn?.addEventListener("click", () => applyBulkTags([...pantryState.bulkPendingTags]));

    wireBulkTagInputHandlers(() => applyBulkTags([...pantryState.bulkPendingTags]));

    // Close bulk tag editor when clicking outside
    document.addEventListener("click", (event) => {
        if (!pantryState.isBulkTagEditorOpen) return;
        const target = event.target as Node;
        const bulkTagEditorEl = document.getElementById("bulk-tag-editor");
        const bulkTagBtnEl = document.getElementById("bulk-tag-btn");
        if (bulkTagEditorEl?.contains(target) || bulkTagBtnEl?.contains(target)) return;
        bulkTagEditorEl?.querySelectorAll<HTMLElement>(".more-tags-popover")
            .forEach((p) => p.classList.add("hidden"));
        hideBulkTagSuggestions();
    });

    document.addEventListener("keydown", async (event: KeyboardEvent) => {
        if (event.key === "Escape" && pantryState.isBulkTagEditorOpen) {
            event.preventDefault();
            closeBulkTagEditor();
            return;
        }

        if (event.key === "Escape" && pantryState.isSelectionMode) {
            event.preventDefault();
            const deleteOverlay = document.getElementById("delete-confirm-overlay");
            if (deleteOverlay && !deleteOverlay.classList.contains("hidden")) return;
            if (shareConfirmOverlay && !shareConfirmOverlay.classList.contains("hidden")) return;
            const shareLinksOverlay = document.getElementById("share-links-overlay");
            if (shareLinksOverlay && !shareLinksOverlay.classList.contains("hidden")) return;
            resetSelection();
            return;
        }

        if ((event.key === "Delete" || event.key === "Backspace") && pantryState.isSelectionMode) {
            const activeTag = document.activeElement?.tagName;
            if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;
            event.preventDefault();
            await handleBulkDelete();
        }
    });

    updateSelectionUI();
}
