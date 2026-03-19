/**
 * Semantic search: suggestion dropdown, handleSearch, and all search-input wiring.
 */

import feather from "feather-icons";
import { getAllRecipes, searchRecipes } from "../../utils/db";
import { pantryState } from "./pantryState";
import { LS } from "../../utils/storage";
import { MSG } from "../../utils/messages";
import { renderSearchBadges } from "./tagFilter";
import { loadRecipes, renderRecipes } from "./recipeRenderer";
import { setCardSelectedState, syncSelectionModeClass, updateSelectionUI } from "./selectionManager";

declare const chrome: any;

// ─── DOM handles ─────────────────────────────────────────────────────────────

const searchInput = document.getElementById("semantic-search") as HTMLInputElement;
const searchBtn = document.getElementById("search-btn") as HTMLButtonElement;
const recipeCountEl = document.getElementById("recipe-count");
const clearBtn = document.getElementById("clear-search");
const searchBadgesContainer = document.getElementById("search-badges");
const searchSuggestions = document.getElementById("search-suggestions");

// ─── Suggestion rendering ─────────────────────────────────────────────────────

function renderSuggestions() {
    if (!searchSuggestions) return;
    if (pantryState.currentSuggestions.length === 0) {
        searchSuggestions.classList.add("hidden");
        return;
    }

    searchSuggestions.innerHTML = "";
    const closeRow = document.createElement("div");
    closeRow.className = "suggestion-close-row";
    const closeBtn = document.createElement("button");
    closeBtn.className = "suggestion-close-btn";
    closeBtn.setAttribute("aria-label", "Close suggestions");
    closeBtn.innerHTML = feather.icons["x"]?.toSvg({ width: 14, height: 14 }) || "x";
    closeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        hideSuggestions();
        searchInput?.blur();
    });
    closeRow.appendChild(closeBtn);
    searchSuggestions.appendChild(closeRow);

    const lowerInput = searchInput.value.trim().toLowerCase();
    pantryState.currentSuggestions.forEach((tag, idx) => {
        const item = document.createElement("div");
        item.className = "suggestion-item" + (idx === pantryState.selectedSuggestionIndex ? " selected" : "");

        const lowerTag = tag.toLowerCase();
        if (lowerInput && lowerTag.startsWith(lowerInput)) {
            const prefix = tag.substring(0, lowerInput.length);
            const suffix = tag.substring(lowerInput.length);
            item.innerHTML = `<span class="suggest-tag-match">${prefix}</span>${suffix}`;
        } else {
            item.textContent = tag;
        }

        item.addEventListener("click", () => selectSuggestion(tag));
        searchSuggestions.appendChild(item);
    });
    searchSuggestions.classList.remove("hidden");
}

function hideSuggestions() {
    pantryState.currentSuggestions = [];
    pantryState.selectedSuggestionIndex = -1;
    searchSuggestions?.classList.add("hidden");
}

function selectSuggestion(tag: string) {
    if (!pantryState.currentTagFilters.includes(tag)) {
        pantryState.currentTagFilters.unshift(tag);
        localStorage.setItem(LS.pantryTagFilters, JSON.stringify(pantryState.currentTagFilters));
        renderSearchBadges();
    }
    searchInput.value = "";
    hideSuggestions();
    handleSearch();
}

function triggerShowSuggestions() {
    const textBeforeCursor = searchInput?.value.substring(0, searchInput?.selectionStart || 0) || "";
    let lowerQuery = "";
    if (textBeforeCursor.trim() !== "") {
        lowerQuery = searchInput?.value.trim().toLowerCase() || "";
    }

    pantryState.currentSuggestions = Array.from(pantryState.allKnownTags)
        .filter((tag) => !pantryState.currentTagFilters.includes(tag) && tag.toLowerCase().startsWith(lowerQuery))
        .sort();

    pantryState.selectedSuggestionIndex = lowerQuery === "" ? -1 : (pantryState.currentSuggestions.length > 0 ? 0 : -1);
    renderSuggestions();
}

// ─── Search execution ─────────────────────────────────────────────────────────

export async function handleSearch() {
    const query = searchInput.value.trim();
    if (!query) {
        await loadRecipes();
        return;
    }

    searchBtn.disabled = true;
    try {
        const lower = query.toLowerCase();
        const queryTokens = lower.split(/\s+/);
        let all = await getAllRecipes();

        if (pantryState.currentTagFilters.length > 0) {
            all = all.filter(
                (r) => r.tags && pantryState.currentTagFilters.every((t) => r.tags!.includes(t))
            );
        }

        // Step 1: synchronous tag/title pre-filter
        const tagHitIds = new Set<string>();
        const tagHits = all.filter((r) => {
            const titleMatch = r.title?.toLowerCase().includes(lower);
            const tagMatch = r.tags?.some((t) =>
                queryTokens.some((token) => t.toLowerCase().includes(token))
            );
            if (titleMatch || tagMatch) { tagHitIds.add(r.id); return true; }
            return false;
        });

        // Step 2: vector similarity search
        const embeddingResult: { success: boolean; embedding?: number[]; error?: string } =
            await chrome.runtime.sendMessage({ type: MSG.generateEmbedding, text: query });

        let merged: typeof all;
        if (embeddingResult.success && embeddingResult.embedding) {
            const vectorMatches = await searchRecipes(embeddingResult.embedding, query, 20);
            const extraVectorMatches = vectorMatches.filter((r) => !tagHitIds.has(r.id));
            merged = [...tagHits, ...extraVectorMatches];
        } else {
            console.error("Search embedding failed:", embeddingResult.error);
            merged = tagHits;
        }

        renderRecipes(merged);

        const tagLabel = tagHits.length > 0
            ? ` (${tagHits.length} tag match${tagHits.length !== 1 ? "es" : ""})`
            : "";
        if (recipeCountEl) {
            recipeCountEl.textContent = `${merged.length} result${merged.length !== 1 ? "s" : ""} for "${query}"${tagLabel}`;
        }
    } catch (err) {
        console.error("Search error:", err);
    } finally {
        searchBtn.disabled = false;
    }
}

// ─── Search input wiring ──────────────────────────────────────────────────────

export function wireSearchHandlers() {
    searchBtn?.addEventListener("click", handleSearch);

    // Global Enter focuses search bar when no input is focused
    document.addEventListener("keydown", (e: KeyboardEvent) => {
        const activeTag = document.activeElement?.tagName;
        if (e.key === "Enter" && activeTag !== "INPUT" && activeTag !== "TEXTAREA" && activeTag !== "BUTTON") {
            e.preventDefault();
            searchInput?.focus();
        }
    });

    // Ctrl+A — select all visible recipes
    document.addEventListener("keydown", (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "a") {
            const activeTag = document.activeElement?.tagName;
            if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;
            if (pantryState.visibleRecipeOrder.length === 0) return;
            e.preventDefault();

            const grid = document.getElementById("recipe-grid");
            pantryState.visibleRecipeOrder.forEach((id) => {
                pantryState.selectedRecipeIds.add(id);
                const card = grid?.querySelector<HTMLElement>(`.recipe-card[data-recipe-id="${id}"]`);
                if (card) setCardSelectedState(card, true);
            });
            pantryState.lastSelectedRecipeId = pantryState.visibleRecipeOrder[pantryState.visibleRecipeOrder.length - 1];
            syncSelectionModeClass();
            updateSelectionUI();
        }
    });

    // Highlight chips when search text is fully selected
    document.addEventListener("selectionchange", () => {
        if (document.activeElement === searchInput) {
            const isAtLeastStartSelected = searchInput.selectionStart === 0 && (searchInput.selectionEnd || 0) > 0;
            if (isAtLeastStartSelected && searchInput.value.length > 0) {
                searchBadgesContainer?.classList.add("chips-selected");
            } else {
                searchBadgesContainer?.classList.remove("chips-selected");
            }
        } else {
            searchBadgesContainer?.classList.remove("chips-selected");
        }
    });

    document.addEventListener("click", (e) => {
        if (!searchInput?.contains(e.target as Node) && !searchSuggestions?.contains(e.target as Node)) {
            hideSuggestions();
        }
    });

    searchInput?.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
            if (pantryState.currentTagFilters.length > 0) {
                searchBadgesContainer?.classList.add("chips-selected");
            }
        }

        if (searchBadgesContainer?.classList.contains("chips-selected")) {
            const isPrintableKey = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
            const isCutOrPaste = (e.key === "x" || e.key === "v") && (e.ctrlKey || e.metaKey);

            if (e.key === "Backspace" || e.key === "Delete" || isPrintableKey || isCutOrPaste) {
                if (pantryState.currentTagFilters.length > 0) {
                    pantryState.currentTagFilters = [];
                    localStorage.setItem(LS.pantryTagFilters, JSON.stringify(pantryState.currentTagFilters));
                    renderSearchBadges();
                }
                searchBadgesContainer.classList.remove("chips-selected");

                if (e.key === "Backspace" || e.key === "Delete") {
                    searchInput.value = "";
                    e.preventDefault();
                    triggerShowSuggestions();
                    handleSearch();
                    return;
                }
            } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
                searchBadgesContainer.classList.remove("chips-selected");
            }
        }

        if (e.key === "Tab") {
            if (pantryState.currentSuggestions.length > 0) {
                e.preventDefault();
                const idx = pantryState.selectedSuggestionIndex >= 0 ? pantryState.selectedSuggestionIndex : 0;
                selectSuggestion(pantryState.currentSuggestions[idx]);
            }
            return;
        }

        if (e.key === "ArrowDown" && pantryState.currentSuggestions.length > 0) {
            e.preventDefault();
            pantryState.selectedSuggestionIndex = (pantryState.selectedSuggestionIndex + 1) % pantryState.currentSuggestions.length;
            renderSuggestions();
            searchSuggestions?.querySelector<HTMLElement>(".selected")?.scrollIntoView({ block: "nearest" });
            return;
        }

        if (e.key === "ArrowUp" && pantryState.currentSuggestions.length > 0) {
            e.preventDefault();
            pantryState.selectedSuggestionIndex =
                pantryState.selectedSuggestionIndex <= 0
                    ? pantryState.currentSuggestions.length - 1
                    : pantryState.selectedSuggestionIndex - 1;
            renderSuggestions();
            searchSuggestions?.querySelector<HTMLElement>(".selected")?.scrollIntoView({ block: "nearest" });
            return;
        }

        if (e.key === "Enter") {
            e.preventDefault();
            if (pantryState.selectedSuggestionIndex >= 0 && pantryState.selectedSuggestionIndex < pantryState.currentSuggestions.length) {
                selectSuggestion(pantryState.currentSuggestions[pantryState.selectedSuggestionIndex]);
                return;
            }
            const text = searchInput.value.trim().toUpperCase();
            if (pantryState.allKnownTags.has(text) && !pantryState.currentTagFilters.includes(text)) {
                pantryState.currentTagFilters.unshift(text);
                localStorage.setItem(LS.pantryTagFilters, JSON.stringify(pantryState.currentTagFilters));
                searchInput.value = "";
                renderSearchBadges();
                hideSuggestions();
                handleSearch();
                return;
            }
            hideSuggestions();
            handleSearch();
            return;
        }

        if (e.key === "Backspace" && searchInput.value === "" && pantryState.currentTagFilters.length > 0) {
            pantryState.currentTagFilters.shift();
            localStorage.setItem(LS.pantryTagFilters, JSON.stringify(pantryState.currentTagFilters));
            renderSearchBadges();
            hideSuggestions();
            handleSearch();
        }

        if (e.key === "Escape") {
            hideSuggestions();
            searchInput.blur();
        }
    });

    clearBtn?.addEventListener("click", async () => {
        if (searchInput) {
            searchInput.value = "";
            pantryState.currentTagFilters = [];
            localStorage.setItem(LS.pantryTagFilters, JSON.stringify(pantryState.currentTagFilters));
            renderSearchBadges();
            clearBtn.classList.remove("show");
            hideSuggestions();
            await loadRecipes();
        }
    });

    searchInput?.addEventListener("input", async () => {
        const text = searchInput.value;
        const delimiterMatch = text.match(/[, ]$/);
        const term = text.trim().toUpperCase();

        if (delimiterMatch && term) {
            if (pantryState.allKnownTags.has(term) && !pantryState.currentTagFilters.includes(term)) {
                pantryState.currentTagFilters.unshift(term);
                localStorage.setItem(LS.pantryTagFilters, JSON.stringify(pantryState.currentTagFilters));
                searchInput.value = "";
                renderSearchBadges();
                hideSuggestions();
                await handleSearch();
                return;
            }
        }

        if (text.trim().length > 0 || pantryState.currentTagFilters.length > 0) {
            clearBtn?.classList.add("show");
        } else {
            clearBtn?.classList.remove("show");
        }

        triggerShowSuggestions();

        if (text.trim().length === 0) {
            await handleSearch();
        }
    });

    searchInput?.addEventListener("focus", triggerShowSuggestions);
    searchInput?.addEventListener("click", triggerShowSuggestions);
    searchInput?.addEventListener("keyup", (e) => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) triggerShowSuggestions();
    });

    searchInput?.closest(".search-input-container")?.addEventListener("click", (e) => {
        if (e.target === searchInput?.closest(".search-input-container")) searchInput?.focus();
    });
}
