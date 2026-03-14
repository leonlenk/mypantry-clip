/**
 * Pantry page controller.
 *
 * This module owns all runtime DOM logic for pantry.html:
 *  - Startup sync check (cloud ahead-of-local delta)
 *  - Filter and tag-dropdown wiring
 *  - Recipe loading / rendering / sorting
 *  - Semantic search (tag pre-filter → vector embedding)
 *  - Active extraction placeholder lifecycle
 *  - Import / Export backup handlers
 *
 * It is imported as a side-effect module by pantry.astro's <script> block.
 * Zero exports — all state is local to this module.
 */

import {
    getAllRecipes,
    deleteRecipe,
    searchRecipes,
    saveRecipeLocally,
    importRecipesLocally,
} from "../../utils/db";
import type { Recipe } from "../../types/recipe";
import feather from "feather-icons";
import {
    buildRecipeCardHtml,
    buildMediumCardHtml,
    buildSmallCardHtml,
    buildPlaceholderHtml,
    buildMetaHtml,
} from "./cardRenderer";

declare const chrome: any;

// ─── DOM handles ─────────────────────────────────────────────────────────────

const grid = document.getElementById("recipe-grid");
const emptyState = document.getElementById("empty-state");
const searchInput = document.getElementById("semantic-search") as HTMLInputElement;
const searchBtn = document.getElementById("search-btn") as HTMLButtonElement;
const recipeCountEl = document.getElementById("recipe-count");
const filterLinks = document.querySelectorAll(".filter-btn");
const clearBtn = document.getElementById("clear-search");
const searchBadgesContainer = document.getElementById("search-badges");
const searchSuggestions = document.getElementById("search-suggestions");
const unitPreferenceDropdown = document.getElementById("pantry-unit-pref");
const bulkActionBar = document.getElementById("bulk-action-bar");
const bulkSelectedCount = document.getElementById("bulk-selected-count");
const bulkTagBtn = document.getElementById("bulk-tag-btn") as HTMLButtonElement | null;
const bulkShareBtn = document.getElementById("bulk-share-btn") as HTMLButtonElement | null;
const bulkDeleteBtn = document.getElementById("bulk-delete-btn") as HTMLButtonElement | null;
const bulkTagEditor = document.getElementById("bulk-tag-editor");
const bulkTagInput = document.getElementById("bulk-tag-input") as HTMLInputElement | null;
const bulkTagChips = document.getElementById("bulk-tag-chips");
const bulkTagSuggestionsEl = document.getElementById("bulk-tag-suggestions");
const bulkTagApplyBtn = document.getElementById("bulk-tag-apply") as HTMLButtonElement | null;
const bulkTagCancelBtn = document.getElementById("bulk-tag-cancel") as HTMLButtonElement | null;
const shareConfirmOverlay = document.getElementById("share-confirm-overlay");
const shareConfirmList = document.getElementById("share-confirm-list");
const shareConfirmCancelBtn = document.getElementById("share-confirm-cancel");
const shareConfirmContinueBtn = document.getElementById("share-confirm-continue") as HTMLButtonElement | null;
const shareLinksOverlay = document.getElementById("share-links-overlay");
const shareLinksList = document.getElementById("share-links-list");
const shareLinksCloseBtn = document.getElementById("share-links-close");
const pantryToastEl = document.getElementById("pantry-toast");

// ─── Page state ───────────────────────────────────────────────────────────────

let currentFilter = localStorage.getItem("pantryFilter") || "all";
const UNIT_PREFERENCE_KEY = "preferredUnitSystem";
const VIEW_MODE_KEY = "pantryViewMode";
let currentViewMode = localStorage.getItem(VIEW_MODE_KEY) || "large";
let currentTagFilters: string[] = [];
let currentSuggestions: string[] = [];
let selectedSuggestionIndex = -1;
try {
    const stored = localStorage.getItem("pantryTagFilters");
    if (stored) {
        currentTagFilters = JSON.parse(stored);
    } else {
        const oldSingle = localStorage.getItem("pantryTagFilter");
        if (oldSingle) currentTagFilters = [oldSingle.toUpperCase()];
    }
} catch {
    currentTagFilters = [];
}
const allKnownTags = new Set<string>();
let activeExtractions: Record<string, { status: string; title: string }> = {};
let isSelectionMode = false;
const selectedRecipeIds = new Set<string>();
let visibleRecipeOrder: string[] = [];
let lastSelectedRecipeId: string | null = null;
let isBulkTagEditorOpen = false;
let bulkPendingTags: string[] = [];
let bulkTagSuggestions: string[] = [];
let bulkTagSuggestionIndex = -1;

// Shared IntersectionObserver: adds .in-view to each card when it is ~150px
// from entering the viewport. Re-created on every render so stale entries
// from a previous render don't linger.
let cardObserver: IntersectionObserver | null = null;

function getCardObserver(): IntersectionObserver {
    if (cardObserver) {
        cardObserver.disconnect();
    }
    cardObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    (entry.target as HTMLElement).classList.add("in-view");
                    cardObserver!.unobserve(entry.target);
                }
            });
        },
        {
            // Pre-trigger 150px before the card enters view so the
            // animation finishes right as the card scrolls into sight.
            rootMargin: "150px 0px",
            threshold: 0,
        }
    );
    return cardObserver;
}

// ─── Startup ─────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
    // Redirect to setup if not configured
    if (
        typeof chrome !== "undefined" &&
        chrome.storage &&
        chrome.storage.local
    ) {
        const { setupComplete, llmProvider } = await chrome.storage.local.get([
            "setupComplete",
            "llmProvider",
        ]);

        if (!setupComplete) {
            window.location.href = "setup.html";
            return;
        }

        // Dashboard-open background sync: silently fetch only recipes newer
        // than lastSyncAt so the pantry is always fresh without blocking render.
        if (llmProvider === "google") {
            (async () => {
                try {
                    const stored = await chrome.storage.local.get("lastSyncAt");
                    const lastSyncAt = stored.lastSyncAt as string | undefined;

                    const latestRes: {
                        success: boolean;
                        latest_updated_at: string | null;
                    } = await chrome.runtime.sendMessage({
                        type: "GET_CLOUD_LATEST",
                    });

                    if (!latestRes.success || !latestRes.latest_updated_at) return;

                    const cloudIsAhead =
                        !lastSyncAt || latestRes.latest_updated_at > lastSyncAt;
                    if (!cloudIsAhead) return;

                    console.log("[Pantry] Cloud is ahead of local — fetching delta...");

                    const syncRes: { success: boolean; merged: number } =
                        await chrome.runtime.sendMessage({
                            type: "SYNC_FROM_CLOUD",
                            since: lastSyncAt,
                        });

                    if (syncRes.success && syncRes.merged > 0) {
                        console.log(
                            `[Pantry] Silently merged ${syncRes.merged} new recipe(s) from cloud.`
                        );
                        await loadRecipes();
                    }
                } catch (err) {
                    console.warn(
                        "[Pantry] Dashboard-open sync check failed (non-fatal):",
                        err
                    );
                }
            })();
        }
    }

    // Initialise active filter link highlight
    if (filterLinks.length > 0) {
        filterLinks.forEach((l) => l.classList.remove("active"));
        const activeLink =
            Array.from(filterLinks).find(
                (l) => (l as HTMLElement).dataset.filter === currentFilter
            ) || filterLinks[0];
        activeLink.classList.add("active");
    }

    filterLinks.forEach((link) => {
        link.addEventListener("click", async (e) => {
            e.preventDefault();
            filterLinks.forEach((l) => l.classList.remove("active"));
            (e.currentTarget as HTMLElement).classList.add("active");
            currentFilter =
                (e.currentTarget as HTMLElement).dataset.filter || "all";
            localStorage.setItem("pantryFilter", currentFilter);
            await loadRecipes();
        });
    });

    // View mode toggle
    applyViewMode();
    document.querySelectorAll<HTMLElement>(".view-mode-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            currentViewMode = btn.dataset.view || "large";
            localStorage.setItem(VIEW_MODE_KEY, currentViewMode);
            applyViewMode();
            loadRecipes();
        });
    });

    // Close overflow tag popover when clicking outside
    document.addEventListener("click", () => closeTagPopover());

    if (unitPreferenceDropdown) {
        const storedUnitPreference = localStorage.getItem(UNIT_PREFERENCE_KEY);
        const selected = storedUnitPreference === "metric" ? "metric" : "us";

        const unitLabel = document.getElementById("pantry-unit-pref-label");
        if (unitLabel) {
            unitLabel.textContent = selected === "metric" ? "MET" : "US";
        }

        const menu = document.getElementById("pantry-unit-pref-menu");
        if (menu) {
            menu.querySelectorAll(".dropdown-item").forEach((item) => {
                item.classList.toggle(
                    "active",
                    item.getAttribute("data-value") === selected
                );
            });
        }

        unitPreferenceDropdown.addEventListener("change", (e: any) => {
            const selectedValue = e?.detail?.value === "metric" ? "metric" : "us";
            localStorage.setItem(UNIT_PREFERENCE_KEY, selectedValue);
        });
    }

    // Fetch active extractions from the background script so placeholder cards
    // survive a page refresh while extraction is still in-flight.
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        try {
            const activeRes = await chrome.runtime.sendMessage({
                type: "GET_ALL_EXTRACTIONS",
            });
            if (activeRes && activeRes.extractions) {
                for (const [url, data] of Object.entries(
                    activeRes.extractions as Record<string, any>
                )) {
                    let displayTitle = data.title;
                    if (!displayTitle) {
                        try {
                            displayTitle = new URL(url).hostname.replace("www.", "");
                        } catch (e) {
                            displayTitle = "Website";
                        }
                    }
                    activeExtractions[url] = {
                        status: data.status,
                        title: displayTitle,
                    };
                }
            }
        } catch (e) {
            console.warn("[Pantry] Failed to fetch active extractions:", e);
        }
    }

    await loadRecipes();
    wireExtractionListener();
    wireSearchHandlers();
    wireSelectionControls();
    wireImportExport();

    // Enable animations after first paint to prevent layout-shift flashes
    // (e.g. fadeUp on recipe cards firing before the grid is stable on mobile).
    requestAnimationFrame(() =>
        requestAnimationFrame(() => document.body.classList.add("page-ready"))
    );
});

function applyViewMode() {
    if (!grid) return;
    grid.classList.remove("view-large", "view-medium", "view-small");
    grid.classList.add(`view-${currentViewMode}`);
    document.querySelectorAll<HTMLElement>(".view-mode-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.view === currentViewMode);
    });
}

// ── Tag overflow popover ──────────────────────────────────────────────────────

let activePopoverAnchor: HTMLElement | null = null;

function showTagPopover(anchor: HTMLElement, tags: string[]) {
    closeTagPopover();
    activePopoverAnchor = anchor;

    const popover = document.createElement("div");
    popover.className = "tag-overflow-popover";
    popover.innerHTML = tags.map((t) => `<span class="tag">${t}</span>`).join("");
    document.body.appendChild(popover);

    // Position after paint so getBoundingClientRect is accurate
    requestAnimationFrame(() => {
        const anchorRect = anchor.getBoundingClientRect();
        const popRect = popover.getBoundingClientRect();
        let top = anchorRect.top - popRect.height - 8;
        let left = anchorRect.left + anchorRect.width / 2 - popRect.width / 2;

        // Flip below if not enough room above
        if (top < 8) top = anchorRect.bottom + 8;
        // Keep within horizontal viewport
        left = Math.max(8, Math.min(left, window.innerWidth - popRect.width - 8));

        popover.style.top = `${top}px`;
        popover.style.left = `${left}px`;
    });
}

function closeTagPopover() {
    document.querySelectorAll(".tag-overflow-popover").forEach((p) => p.remove());
    activePopoverAnchor = null;
}

function syncSelectionModeClass() {
    isSelectionMode = selectedRecipeIds.size > 0;
    document.body.classList.toggle("selection-mode", isSelectionMode);
}

function updateSelectionUI() {
    const selectedCount = selectedRecipeIds.size;

    if (bulkSelectedCount) {
        bulkSelectedCount.textContent = `${selectedCount} recipe${selectedCount !== 1 ? "s" : ""} selected`;
    }

    bulkActionBar?.classList.toggle("visible", selectedCount > 0);

    if (bulkTagBtn) bulkTagBtn.disabled = selectedCount === 0;
    if (bulkShareBtn) bulkShareBtn.disabled = selectedCount === 0;
    if (bulkDeleteBtn) bulkDeleteBtn.disabled = selectedCount === 0;
    if (selectedCount === 0 && isBulkTagEditorOpen) {
        closeBulkTagEditor();
    }
}

function resetSelection({ keepMode = false }: { keepMode?: boolean } = {}) {
    selectedRecipeIds.clear();
    lastSelectedRecipeId = null;
    closeBulkTagEditor();
    if (!keepMode) isSelectionMode = false;

    grid?.querySelectorAll<HTMLElement>(".recipe-card").forEach((card) => {
        card.classList.remove("selected");
    });

    syncSelectionModeClass();
    updateSelectionUI();
}

function setCardSelectedState(card: HTMLElement, isSelected: boolean) {
    card.classList.toggle("selected", isSelected);
    card.setAttribute("aria-pressed", String(isSelected));
}

function toggleRecipeSelection(card: HTMLElement, recipeId: string) {
    if (selectedRecipeIds.has(recipeId)) {
        selectedRecipeIds.delete(recipeId);
        setCardSelectedState(card, false);
    } else {
        selectedRecipeIds.add(recipeId);
        setCardSelectedState(card, true);
        syncSelectionModeClass();
    }

    lastSelectedRecipeId = recipeId;

    syncSelectionModeClass();

    updateSelectionUI();
}

function selectRecipeRange(toRecipeId: string) {
    if (!lastSelectedRecipeId || visibleRecipeOrder.length === 0) {
        // No anchor yet — just add (never deselect) and set anchor
        selectedRecipeIds.add(toRecipeId);
        const card = grid?.querySelector<HTMLElement>(`.recipe-card[data-recipe-id="${toRecipeId}"]`);
        if (card) setCardSelectedState(card, true);
        lastSelectedRecipeId = toRecipeId;
        syncSelectionModeClass();
        updateSelectionUI();
        return;
    }

    const fromIndex = visibleRecipeOrder.indexOf(lastSelectedRecipeId);
    const toIndex = visibleRecipeOrder.indexOf(toRecipeId);

    if (fromIndex < 0 || toIndex < 0) {
        // Anchor not in visible list — add and set anchor
        selectedRecipeIds.add(toRecipeId);
        const card = grid?.querySelector<HTMLElement>(`.recipe-card[data-recipe-id="${toRecipeId}"]`);
        if (card) setCardSelectedState(card, true);
        lastSelectedRecipeId = toRecipeId;
        syncSelectionModeClass();
        updateSelectionUI();
        return;
    }

    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);

    for (let index = start; index <= end; index += 1) {
        const recipeId = visibleRecipeOrder[index];
        selectedRecipeIds.add(recipeId);
        const card = grid?.querySelector<HTMLElement>(`.recipe-card[data-recipe-id="${recipeId}"]`);
        if (card) {
            setCardSelectedState(card, true);
        }
    }

    syncSelectionModeClass();

    lastSelectedRecipeId = toRecipeId;
    updateSelectionUI();
}

function normalizeTagInput(value: string): string {
    return value.trim().toUpperCase();
}

function renderBulkTagChips() {
    if (!bulkTagChips) return;

    bulkTagChips.innerHTML = "";
    const MAX_VISIBLE_TAGS = 0;
    const MAX_TAG_LENGTH = window.innerWidth <= 600 ? 5 : 12;
    const visibleTags = bulkPendingTags.slice(0, MAX_VISIBLE_TAGS);
    const hiddenTags = bulkPendingTags.slice(MAX_VISIBLE_TAGS);

    visibleTags.forEach((tag, index) => {
        const chip = document.createElement("div");
        chip.className = "bulk-tag-chip search-badge";
        const displayTag =
            tag.length > MAX_TAG_LENGTH
                ? `${tag.substring(0, MAX_TAG_LENGTH)}...`
                : tag;
        chip.innerHTML = `
            <span title="${tag}">${displayTag}</span>
            <button data-index="${index}" title="Remove tag">
                ${feather.icons["x"]?.toSvg({ width: 12, height: 12 }) || "x"}
            </button>
        `;
        chip.querySelector("button")?.addEventListener("click", () => {
            bulkPendingTags.splice(index, 1);
            renderBulkTagChips();
            refreshBulkTagSuggestions();
            if (bulkTagApplyBtn) {
                bulkTagApplyBtn.disabled = bulkPendingTags.length === 0;
            }
        });
        bulkTagChips.appendChild(chip);
    });

    if (hiddenTags.length > 0) {
        const moreBadge = document.createElement("div");
        moreBadge.className = "more-badge";
        moreBadge.innerHTML = `+${hiddenTags.length}`;
        moreBadge.title = "Click to see more tags";

        const popover = document.createElement("div");
        popover.className = "more-tags-popover hidden";

        hiddenTags.forEach((tag, hiddenIdx) => {
            const realIdx = MAX_VISIBLE_TAGS + hiddenIdx;
            const item = document.createElement("div");
            item.className = "more-tag-item";
            item.innerHTML = `
                <span title="${tag}">${tag}</span>
                <button title="Remove tag">
                    ${feather.icons["x"]?.toSvg({ width: 12, height: 12 }) || "x"}
                </button>
            `;
            item.querySelector("button")?.addEventListener("click", (event) => {
                event.stopPropagation();
                bulkPendingTags.splice(realIdx, 1);
                renderBulkTagChips();
                refreshBulkTagSuggestions();
                if (bulkTagApplyBtn) {
                    bulkTagApplyBtn.disabled = bulkPendingTags.length === 0;
                }
            });
            popover.appendChild(item);
        });

        moreBadge.addEventListener("click", (event) => {
            event.stopPropagation();
            popover.classList.toggle("hidden");
        });

        moreBadge.appendChild(popover);
        bulkTagChips.appendChild(moreBadge);
    }
}

function renderBulkTagSuggestions() {
    if (!bulkTagSuggestionsEl) return;

    if (bulkTagSuggestions.length === 0) {
        bulkTagSuggestionsEl.classList.add("hidden");
        return;
    }

    bulkTagSuggestionsEl.innerHTML = "";
    const closeRow = document.createElement("div");
    closeRow.className = "suggestion-close-row";
    const closeBtn = document.createElement("button");
    closeBtn.className = "suggestion-close-btn";
    closeBtn.setAttribute("aria-label", "Close suggestions");
    closeBtn.innerHTML = feather.icons["x"]?.toSvg({ width: 14, height: 14 }) || "x";
    closeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        hideBulkTagSuggestions();
        bulkTagInput?.blur();
    });
    closeRow.appendChild(closeBtn);
    bulkTagSuggestionsEl.appendChild(closeRow);

    const typed = normalizeTagInput(bulkTagInput?.value || "");
    bulkTagSuggestions.forEach((tag, index) => {
        const option = document.createElement("div");
        option.className =
            "bulk-tag-suggestion suggestion-item" +
            (index === bulkTagSuggestionIndex ? " selected" : "");
        if (typed && tag.startsWith(typed)) {
            const prefix = tag.slice(0, typed.length);
            const suffix = tag.slice(typed.length);
            option.innerHTML = `<span class="suggest-tag-match">${prefix}</span>${suffix}`;
        } else {
            option.textContent = tag;
        }
        option.addEventListener("click", () => {
            addBulkPendingTag(tag);
        });
        bulkTagSuggestionsEl.appendChild(option);
    });

    bulkTagSuggestionsEl.classList.remove("hidden");
}

function hideBulkTagSuggestions() {
    bulkTagSuggestions = [];
    bulkTagSuggestionIndex = -1;
    bulkTagSuggestionsEl?.classList.add("hidden");
}

function refreshBulkTagSuggestions() {
    const typed = normalizeTagInput(bulkTagInput?.value || "");
    bulkTagSuggestions = Array.from(allKnownTags)
        .filter((tag) => !bulkPendingTags.includes(tag) && tag.startsWith(typed))
        .sort((a, b) => a.localeCompare(b));
    bulkTagSuggestionIndex = bulkTagSuggestions.length > 0 ? 0 : -1;
    renderBulkTagSuggestions();
}

function addBulkPendingTag(tagValue: string) {
    const tag = normalizeTagInput(tagValue);
    if (!tag || bulkPendingTags.includes(tag)) {
        if (bulkTagInput) bulkTagInput.value = "";
        refreshBulkTagSuggestions();
        return;
    }

    bulkPendingTags.push(tag);
    bulkPendingTags.sort((a, b) => a.localeCompare(b));

    if (bulkTagInput) bulkTagInput.value = "";
    renderBulkTagChips();
    refreshBulkTagSuggestions();
    if (bulkTagApplyBtn) {
        bulkTagApplyBtn.disabled = bulkPendingTags.length === 0;
    }
}

function openBulkTagEditor() {
    isBulkTagEditorOpen = true;
    bulkTagEditor?.classList.remove("hidden");
    bulkActionBar?.classList.add("tag-editor-open");
    bulkPendingTags = [];
    renderBulkTagChips();
    refreshBulkTagSuggestions();
    if (bulkTagApplyBtn) {
        bulkTagApplyBtn.disabled = true;
    }
    bulkTagInput?.focus();
}

function closeBulkTagEditor() {
    isBulkTagEditorOpen = false;
    bulkTagEditor?.classList.add("hidden");
    bulkActionBar?.classList.remove("tag-editor-open");
    bulkPendingTags = [];
    if (bulkTagInput) {
        bulkTagInput.value = "";
    }
    renderBulkTagChips();
    hideBulkTagSuggestions();
    if (bulkTagApplyBtn) {
        bulkTagApplyBtn.disabled = true;
    }
}

async function applyBulkTags(tagsToApply: string[]) {
    if (tagsToApply.length === 0 || selectedRecipeIds.size === 0) return;

    const allRecipes = await getAllRecipes();
    const recipeMap = new Map(allRecipes.map((recipe) => [recipe.id, recipe]));

    const selectedRecipes = Array.from(selectedRecipeIds)
        .map((id) => recipeMap.get(id))
        .filter((recipe): recipe is Recipe => !!recipe);

    await Promise.all(
        selectedRecipes.map(async (recipe) => {
            const tags = new Set((recipe.tags || []).map((tag) => tag.toUpperCase()));
            tagsToApply.forEach((tag) => tags.add(tag));
            recipe.tags = Array.from(tags).sort((a, b) => a.localeCompare(b));
            await saveRecipeLocally(recipe);
        })
    );

    closeBulkTagEditor();
    resetSelection();
    await loadRecipes();
}

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string, type: "success" | "error" | "info" = "info", duration = 3500) {
    const el = pantryToastEl;
    if (!el) return;

    if (toastTimer) clearTimeout(toastTimer);

    el.textContent = message;
    el.className = `pantry-toast toast-${type}`;

    toastTimer = setTimeout(() => {
        el.classList.add("hidden");
        toastTimer = null;
    }, duration);
}

// ─── Share Links Modal ────────────────────────────────────────────────────────

function showShareLinksModal(urls: string[]) {
    if (!shareLinksOverlay || !shareLinksList || !shareLinksCloseBtn) return;

    shareLinksList.innerHTML = "";
    for (const url of urls) {
        const row = document.createElement("div");
        row.className = "share-link-row";

        const input = document.createElement("input");
        input.type = "text";
        input.readOnly = true;
        input.value = url;
        input.addEventListener("click", () => input.select());

        const copyBtn = document.createElement("button");
        copyBtn.className = "share-link-copy";
        copyBtn.textContent = "Copy";
        copyBtn.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(url);
                copyBtn.textContent = "Copied!";
                copyBtn.classList.add("copied");
                setTimeout(() => {
                    copyBtn.textContent = "Copy";
                    copyBtn.classList.remove("copied");
                }, 2000);
            } catch {
                input.select();
            }
        });

        row.appendChild(input);
        row.appendChild(copyBtn);
        shareLinksList.appendChild(row);
    }

    shareLinksOverlay.classList.remove("hidden");

    const close = () => {
        shareLinksOverlay.classList.add("hidden");
        shareLinksCloseBtn.removeEventListener("click", close);
        shareLinksOverlay.removeEventListener("click", onOverlay);
        document.removeEventListener("keydown", onKey);
    };
    const onOverlay = (e: MouseEvent) => { if (e.target === shareLinksOverlay) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };

    shareLinksCloseBtn.addEventListener("click", close);
    shareLinksOverlay.addEventListener("click", onOverlay);
    document.addEventListener("keydown", onKey);
}

function confirmShareModal(initialIds: string[], initialTitles: string[]): Promise<string[]> {
    return new Promise((resolve) => {
        const overlay = shareConfirmOverlay;
        const list = shareConfirmList;
        const cancelBtn = shareConfirmCancelBtn;
        const continueBtn = shareConfirmContinueBtn;
        if (!overlay || !list || !cancelBtn || !continueBtn) {
            resolve(initialIds);
            return;
        }

        const xIcon = feather.icons["x"]?.toSvg({ width: 14, height: 14 }) ?? "×";
        const pending = new Map<string, string>(initialIds.map((id, i) => [id, initialTitles[i]]));

        const renderList = () => {
            list.innerHTML = "";
            pending.forEach((title, id) => {
                const li = document.createElement("li");
                li.dataset.id = id;
                li.innerHTML = `<span>${title}</span><button class="delete-list-remove" title="Remove from list">${xIcon}</button>`;
                li.querySelector("button")!.addEventListener("click", () => {
                    pending.delete(id);
                    if (pending.size === 0) { onCancel(); return; }
                    renderList();
                    continueBtn.textContent = `Share ${pending.size}`;
                });
                list.appendChild(li);
            });
        };

        renderList();
        continueBtn.textContent = `Share ${pending.size}`;
        overlay.classList.remove("hidden");

        const cleanup = () => {
            overlay.classList.add("hidden");
            cancelBtn.removeEventListener("click", onCancel);
            continueBtn!.removeEventListener("click", onConfirm);
            overlay.removeEventListener("click", onOverlayClick);
            document.removeEventListener("keydown", onKeyDown);
        };
        const onCancel = () => { cleanup(); resolve([]); };
        const onConfirm = () => { cleanup(); resolve(Array.from(pending.keys())); };
        const onOverlayClick = (e: MouseEvent) => { if (e.target === overlay) onCancel(); };
        const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };

        cancelBtn.addEventListener("click", onCancel);
        continueBtn.addEventListener("click", onConfirm);
        overlay.addEventListener("click", onOverlayClick);
        document.addEventListener("keydown", onKeyDown);
    });
}

function confirmDeleteModal(initialIds: string[], initialTitles: string[]): Promise<string[]> {
    return new Promise((resolve) => {
        const overlay = document.getElementById("delete-confirm-overlay");
        const list = document.getElementById("delete-confirm-list");
        const cancelBtn = document.getElementById("delete-confirm-cancel");
        const continueBtn = document.getElementById("delete-confirm-continue") as HTMLButtonElement | null;
        if (!overlay || !list || !cancelBtn || !continueBtn) {
            resolve(initialIds);
            return;
        }

        const xIcon = feather.icons["x"]?.toSvg({ width: 14, height: 14 }) ?? "×";
        // Working copy so removals don't affect the caller's set until confirmed
        const pending = new Map<string, string>(initialIds.map((id, i) => [id, initialTitles[i]]));

        const renderList = () => {
            list.innerHTML = "";
            pending.forEach((title, id) => {
                const li = document.createElement("li");
                li.dataset.id = id;
                li.innerHTML = `<span>${title}</span><button class="delete-list-remove" title="Remove from list">${xIcon}</button>`;
                li.querySelector("button")!.addEventListener("click", () => {
                    pending.delete(id);
                    if (pending.size === 0) { onCancel(); return; }
                    renderList();
                    if (continueBtn) continueBtn.textContent = `Delete ${pending.size}`;
                });
                list.appendChild(li);
            });
        };

        renderList();
        continueBtn.textContent = `Delete ${pending.size}`;
        overlay.classList.remove("hidden");

        const cleanup = () => {
            overlay.classList.add("hidden");
            cancelBtn.removeEventListener("click", onCancel);
            continueBtn!.removeEventListener("click", onConfirm);
            overlay.removeEventListener("click", onOverlayClick);
            document.removeEventListener("keydown", onKeyDown);
        };
        const onCancel = () => { cleanup(); resolve([]); };
        const onConfirm = () => { cleanup(); resolve(Array.from(pending.keys())); };
        const onOverlayClick = (e: MouseEvent) => { if (e.target === overlay) onCancel(); };
        const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };

        cancelBtn.addEventListener("click", onCancel);
        continueBtn.addEventListener("click", onConfirm);
        overlay.addEventListener("click", onOverlayClick);
        document.addEventListener("keydown", onKeyDown);
    });
}

async function handleBulkDelete() {
    if (selectedRecipeIds.size === 0) return;

    const allRecipes = await getAllRecipes();
    const recipeMap = new Map(allRecipes.map((r) => [r.id, r]));
    const ids = Array.from(selectedRecipeIds);
    const titles = ids.map((id) => recipeMap.get(id)?.title ?? id);

    const toDelete = await confirmDeleteModal(ids, titles);
    if (toDelete.length === 0) return;

    await Promise.all(toDelete.map((id) => deleteRecipe(id)));
    resetSelection();
    await loadRecipes();
}

async function handleBulkTag() {
    if (selectedRecipeIds.size === 0) return;
    if (isBulkTagEditorOpen) {
        closeBulkTagEditor();
        return;
    }
    openBulkTagEditor();
}

async function handleBulkShare() {
    if (selectedRecipeIds.size === 0) return;

    const allRecipes = await getAllRecipes();
    const recipeMap = new Map(allRecipes.map((r) => [r.id, r]));
    const ids = Array.from(selectedRecipeIds);
    const titles = ids.map((id) => recipeMap.get(id)?.title ?? id);

    const toShare = await confirmShareModal(ids, titles);
    if (toShare.length === 0) return;

    const selected = toShare
        .map((id) => recipeMap.get(id))
        .filter((r): r is Recipe => !!r);

    // Strip personal data (tags, embedding) before sending to the share API
    const cleanRecipes = selected.map(({ embedding: _e, tags: _t, ...r }) => r);

    const res: { success: boolean; url?: string; error?: string } = await chrome.runtime.sendMessage({
        type: "SHARE_RECIPE",
        recipes: cleanRecipes,
    });

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

    // Copy the share URL to clipboard silently, then show the links modal
    try {
        await navigator.clipboard.writeText(res.url);
    } catch {
        // Clipboard blocked — user can still manually copy from the modal
    }

    showShareLinksModal([res.url]);
}

function wireSelectionControls() {
    bulkDeleteBtn?.addEventListener("click", async () => {
        await handleBulkDelete();
    });

    bulkTagBtn?.addEventListener("click", async () => {
        await handleBulkTag();
    });

    bulkShareBtn?.addEventListener("click", async () => {
        await handleBulkShare();
    });

    bulkTagCancelBtn?.addEventListener("click", () => {
        closeBulkTagEditor();
    });

    bulkTagApplyBtn?.addEventListener("click", async () => {
        await applyBulkTags([...bulkPendingTags]);
    });

    bulkTagInput?.addEventListener("input", () => {
        const text = bulkTagInput.value;
        const delimiterMatch = text.match(/[, ]$/);
        const term = normalizeTagInput(text);
        if (delimiterMatch && term) {
            addBulkPendingTag(term);
            return;
        }
        refreshBulkTagSuggestions();
    });

    bulkTagInput?.addEventListener("focus", () => {
        refreshBulkTagSuggestions();
    });

    bulkTagInput?.addEventListener("click", () => {
        refreshBulkTagSuggestions();
    });

    bulkTagInput?.addEventListener("keydown", async (event: KeyboardEvent) => {
        if (event.key === "Tab") {
            if (bulkTagSuggestions.length > 0) {
                event.preventDefault();
                const index = bulkTagSuggestionIndex >= 0 ? bulkTagSuggestionIndex : 0;
                addBulkPendingTag(bulkTagSuggestions[index]);
            }
            return;
        }

        if (event.key === "ArrowDown" && bulkTagSuggestions.length > 0) {
            event.preventDefault();
            bulkTagSuggestionIndex = (bulkTagSuggestionIndex + 1) % bulkTagSuggestions.length;
            renderBulkTagSuggestions();
            return;
        }

        if (event.key === "ArrowUp" && bulkTagSuggestions.length > 0) {
            event.preventDefault();
            bulkTagSuggestionIndex =
                bulkTagSuggestionIndex <= 0
                    ? bulkTagSuggestions.length - 1
                    : bulkTagSuggestionIndex - 1;
            renderBulkTagSuggestions();
            return;
        }

        if (event.key === "Enter") {
            event.preventDefault();
            if (bulkTagSuggestions.length > 0 && bulkTagSuggestionIndex >= 0) {
                addBulkPendingTag(bulkTagSuggestions[bulkTagSuggestionIndex]);
                return;
            }

            const raw = bulkTagInput?.value || "";
            if (raw.trim().length > 0) {
                addBulkPendingTag(raw);
                return;
            }

            if (bulkPendingTags.length > 0) {
                await applyBulkTags([...bulkPendingTags]);
            }
            return;
        }

        if (event.key === "Backspace" && (bulkTagInput?.value || "") === "" && bulkPendingTags.length > 0) {
            bulkPendingTags.pop();
            renderBulkTagChips();
            refreshBulkTagSuggestions();
            if (bulkTagApplyBtn) {
                bulkTagApplyBtn.disabled = bulkPendingTags.length === 0;
            }
            return;
        }

        if (event.key === "Escape") {
            event.preventDefault();
            if (!bulkTagSuggestionsEl?.classList.contains("hidden")) {
                hideBulkTagSuggestions();
            } else {
                closeBulkTagEditor();
            }
        }
    });

    document.addEventListener("click", (event) => {
        if (!isBulkTagEditorOpen) return;
        const target = event.target as Node;
        if (
            bulkTagEditor?.contains(target) ||
            bulkTagBtn?.contains(target)
        ) {
            return;
        }
        bulkTagEditor
            ?.querySelectorAll<HTMLElement>(".more-tags-popover")
            .forEach((popover) => popover.classList.add("hidden"));
        hideBulkTagSuggestions();
    });

    document.addEventListener("keydown", async (event: KeyboardEvent) => {
        if (event.key === "Escape" && isBulkTagEditorOpen) {
            event.preventDefault();
            closeBulkTagEditor();
            return;
        }

        if (event.key === "Escape" && isSelectionMode) {
            event.preventDefault();
            // Let confirmation/result modals handle their own Escape first
            const deleteOverlay = document.getElementById("delete-confirm-overlay");
            if (deleteOverlay && !deleteOverlay.classList.contains("hidden")) return;
            if (shareConfirmOverlay && !shareConfirmOverlay.classList.contains("hidden")) return;
            if (shareLinksOverlay && !shareLinksOverlay.classList.contains("hidden")) return;
            resetSelection();
            return;
        }

        if ((event.key === "Delete" || event.key === "Backspace") && isSelectionMode) {
            const activeTag = document.activeElement?.tagName;
            if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;
            event.preventDefault();
            await handleBulkDelete();
            return;
        }

    });

    updateSelectionUI();
}

// ─── Extraction live-update listener ────────────────────────────────────────

function wireExtractionListener() {
    if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return;

    chrome.runtime.onMessage.addListener((message: any) => {
        // A recipe was imported from a share page — reload the grid so it appears immediately
        if (message.type === "RECIPE_SAVED_FROM_SHARE") {
            loadRecipes();
            return;
        }

        if (message.type !== "EXTRACTION_STATUS_UPDATE") return;

        if (message.isComplete) {
            if (message.isError) {
                // Show error on the placeholder card, then fade it out
                const safeId =
                    "placeholder-" + message.url.replace(/[^a-zA-Z0-9_-]/g, "");
                const placeholderEl = document.getElementById(safeId);

                if (placeholderEl) {
                    placeholderEl.classList.add("skeleton-error");
                    const statusBadge = placeholderEl.querySelector(".status-badge");
                    if (statusBadge) statusBadge.textContent = message.status;
                    const titleEl = placeholderEl.querySelector(".skeleton-title");
                    if (titleEl) (titleEl as HTMLElement).style.opacity = "1";

                    setTimeout(() => {
                        placeholderEl.classList.add("skeleton-fade-out");
                        placeholderEl.addEventListener(
                            "animationend",
                            () => {
                                placeholderEl.remove();
                                const remaining =
                                    grid?.querySelectorAll(".recipe-card").length ?? 0;
                                if (remaining === 0) {
                                    grid?.classList.add("hidden");
                                    emptyState?.classList.remove("hidden");
                                }
                            },
                            { once: true }
                        );
                    }, 3000);
                }

                delete activeExtractions[message.url];
            } else {
                loadRecipes();
                delete activeExtractions[message.url];
            }
        } else {
            let displayTitle = message.recipeTitle;
            if (!displayTitle) {
                try {
                    displayTitle = new URL(message.url).hostname.replace("www.", "");
                } catch (e) {
                    displayTitle = "Website";
                }
            }

            const isNew = !activeExtractions[message.url];
            activeExtractions[message.url] = {
                status: message.status,
                title: displayTitle,
            };

            if (isNew) {
                // Trigger a full re-render only when creating the placeholder card initially
                loadRecipes();
            } else {
                // Update only the specific placeholder card to avoid layout thrashing
                const safeId =
                    "placeholder-" + message.url.replace(/[^a-zA-Z0-9_-]/g, "");
                const placeholderEl = document.getElementById(safeId);
                if (placeholderEl) {
                    const statusBadge = placeholderEl.querySelector(".status-badge");
                    if (statusBadge) statusBadge.textContent = message.status;
                    const titleEl = placeholderEl.querySelector(".skeleton-title");
                    if (titleEl) titleEl.textContent = displayTitle;
                }
            }
        }
    });
}

// ─── Tag dropdown ─────────────────────────────────────────────────────────────

function extractTags(allRecipes: Recipe[]) {
    allKnownTags.clear();
    allRecipes.forEach((r) => {
        if (r.tags) r.tags.forEach((t) => allKnownTags.add(t));
    });

    // Remove any filters that are no longer valid tags
    const origLength = currentTagFilters.length;
    currentTagFilters = currentTagFilters.filter(t => allKnownTags.has(t));
    if (currentTagFilters.length !== origLength) {
        localStorage.setItem("pantryTagFilters", JSON.stringify(currentTagFilters));
    }
    renderSearchBadges();
}

function renderSearchBadges() {
    if (!searchBadgesContainer) return;
    searchBadgesContainer.innerHTML = "";

    const MAX_VISIBLE_TAGS = window.innerWidth <= 600 ? 1 : 2;
    const MAX_TAG_LENGTH = window.innerWidth <= 600 ? 5 : 12;

    const visibleTags = currentTagFilters.slice(0, MAX_VISIBLE_TAGS);
    const hiddenTags = currentTagFilters.slice(MAX_VISIBLE_TAGS);

    visibleTags.forEach((tag, idx) => {
        const badge = document.createElement("div");
        badge.className = "search-badge";
        const displayTag = tag.length > MAX_TAG_LENGTH ? tag.substring(0, MAX_TAG_LENGTH) + "..." : tag;
        badge.innerHTML = `
            <span title="${tag}">${displayTag}</span>
            <button data-index="${idx}" title="Remove tag">
                ${feather.icons["x"]?.toSvg({ width: 12, height: 12 }) || "x"}
            </button>
        `;
        const btn = badge.querySelector("button");
        btn?.addEventListener("click", () => {
            currentTagFilters.splice(idx, 1);
            localStorage.setItem("pantryTagFilters", JSON.stringify(currentTagFilters));
            renderSearchBadges();
            handleSearch();
        });
        searchBadgesContainer.appendChild(badge);
    });

    if (hiddenTags.length > 0) {
        const moreBadge = document.createElement("div");
        moreBadge.className = "search-badge more-badge";
        moreBadge.innerHTML = `+${hiddenTags.length}`;
        moreBadge.title = "Click to see more tags";

        // Overflow container
        const popover = document.createElement("div");
        popover.className = "more-tags-popover hidden";

        hiddenTags.forEach((tag, hiddenIdx) => {
            const realIdx = MAX_VISIBLE_TAGS + hiddenIdx;
            const item = document.createElement("div");
            item.className = "more-tag-item";
            item.innerHTML = `
                <span title="${tag}">${tag}</span>
                <button title="Remove tag">
                    ${feather.icons["x"]?.toSvg({ width: 12, height: 12 }) || "x"}
                </button>
            `;
            item.querySelector("button")?.addEventListener("click", (e) => {
                e.stopPropagation();
                currentTagFilters.splice(realIdx, 1);
                localStorage.setItem("pantryTagFilters", JSON.stringify(currentTagFilters));
                renderSearchBadges();
                handleSearch();
            });
            popover.appendChild(item);
        });

        moreBadge.addEventListener("click", (e) => {
            e.stopPropagation();
            popover.classList.toggle("hidden");
        });

        // Hide popover when clicking outside
        document.addEventListener("click", (e) => {
            if (!moreBadge.contains(e.target as Node)) {
                popover.classList.add("hidden");
            }
        });

        moreBadge.appendChild(popover);
        searchBadgesContainer.appendChild(moreBadge);
    }

    // Evaluate if the clear X button needs to be shown based on tag presence
    if ((searchInput && searchInput.value.trim().length > 0) || currentTagFilters.length > 0) {
        clearBtn?.classList.add("show");
    } else {
        clearBtn?.classList.remove("show");
    }
}

function renderSuggestions() {
    if (!searchSuggestions) return;
    if (currentSuggestions.length === 0) {
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

    currentSuggestions.forEach((tag, idx) => {
        const item = document.createElement("div");
        item.className = "suggestion-item" + (idx === selectedSuggestionIndex ? " selected" : "");

        const lowerTag = tag.toLowerCase();
        if (lowerInput && lowerTag.startsWith(lowerInput)) {
            const prefix = tag.substring(0, lowerInput.length);
            const suffix = tag.substring(lowerInput.length);
            item.innerHTML = `<span class="suggest-tag-match">${prefix}</span>${suffix}`;
        } else {
            item.textContent = tag;
        }

        item.addEventListener("click", () => {
            selectSuggestion(tag);
        });

        searchSuggestions.appendChild(item);
    });
    searchSuggestions.classList.remove("hidden");
}

function hideSuggestions() {
    currentSuggestions = [];
    selectedSuggestionIndex = -1;
    searchSuggestions?.classList.add("hidden");
}

function selectSuggestion(tag: string) {
    if (!currentTagFilters.includes(tag)) {
        currentTagFilters.unshift(tag);
        localStorage.setItem("pantryTagFilters", JSON.stringify(currentTagFilters));
        renderSearchBadges();
    }
    searchInput.value = "";
    hideSuggestions();
    handleSearch();
}

// ─── Recipe loading / rendering ───────────────────────────────────────────────

async function loadRecipes() {
    let recipes = await getAllRecipes();
    recipes.forEach(r => {
        if (!r.tags) {
            r.tags = [];
        }
        r.tags = r.tags
            .map(t => t.toUpperCase())
            .sort((a, b) => a.localeCompare(b));
        if (r.url) {
            try {
                const domain = new URL(r.url).hostname.replace(/^www\./, '').toUpperCase();
                if (!r.tags.includes(domain)) {
                    r.tags.push(domain);
                    r.tags.sort((a, b) => a.localeCompare(b));
                }
            } catch (e) { }
        }
    });
    extractTags(recipes);

    recipes.sort((a, b) => {
        if (currentFilter === "all" || currentFilter === "favorites") {
            if (a.isFavorite && !b.isFavorite) return -1;
            if (!a.isFavorite && b.isFavorite) return 1;
            return a.title.localeCompare(b.title);
        }
        // Pure chronological for "Recent" (newest to oldest)
        const aTime = a.createdAt || 0;
        const bTime = b.createdAt || 0;
        return bTime - aTime;
    });

    if (currentFilter === "favorites") {
        recipes = recipes.filter((r) => r.isFavorite);
    }

    if (currentTagFilters.length > 0) {
        recipes = recipes.filter(
            (r) => r.tags && currentTagFilters.every(tag => r.tags!.includes(tag))
        );
    }

    if (recipeCountEl)
        recipeCountEl.textContent = `${recipes.length} recipe${recipes.length !== 1 ? "s" : ""}`;

    // Wrap DOM update in a view transition for smooth animations when supported
    if ((document as any).startViewTransition) {
        (document as any).startViewTransition(() => renderRecipes(recipes));
    } else {
        renderRecipes(recipes);
    }
}

function renderRecipes(recipes: Recipe[]) {
    if (!grid || !emptyState) return;

    visibleRecipeOrder = recipes.map((recipe) => recipe.id);

    const visibleIds = new Set(recipes.map((recipe) => recipe.id));
    Array.from(selectedRecipeIds).forEach((id) => {
        if (!visibleIds.has(id)) {
            selectedRecipeIds.delete(id);
        }
    });
    if (selectedRecipeIds.size === 0 && isSelectionMode) {
        isSelectionMode = false;
        syncSelectionModeClass();
    }

    grid.innerHTML = "";

    // Render active extraction placeholders first.
    // Skeleton cards must get .in-view immediately — they start at opacity:0
    // like every other .recipe-card but are excluded from the IntersectionObserver
    // rAF loop below (which only processes non-skeleton cards). Without .in-view
    // the shimmer card would be invisible forever.
    Object.entries(activeExtractions).forEach(([url, data], index) => {
        const placeholder = document.createElement("div");
        const safeId = "placeholder-" + url.replace(/[^a-zA-Z0-9_-]/g, "");
        placeholder.id = safeId;
        placeholder.className = "card recipe-card skeleton in-view";
        (placeholder.style as any).viewTransitionName = `placeholder-view-${index}`;
        placeholder.innerHTML = buildPlaceholderHtml(data.title, data.status);
        grid.appendChild(placeholder);
    });

    if (
        recipes.length === 0 &&
        Object.keys(activeExtractions).length === 0
    ) {
        grid.classList.add("hidden");
        emptyState.classList.remove("hidden");
        return;
    }

    grid.classList.remove("hidden");
    emptyState.classList.add("hidden");

    recipes.forEach((recipe: Recipe, index: number) => {
        const card = document.createElement("div");
        card.className = "card recipe-card";
        card.dataset.recipeId = recipe.id;
        card.setAttribute("role", "button");

        const isNew = recipe.createdAt && Date.now() - recipe.createdAt < 6000;
        if (isNew) card.classList.add("highlight-new");

        (card.style as any).viewTransitionName = `card-${recipe.id}`;

        if (currentViewMode === "small") {
            card.innerHTML = buildSmallCardHtml(recipe);
        } else if (currentViewMode === "medium") {
            card.innerHTML = buildMediumCardHtml(recipe);
        } else {
            card.innerHTML = buildRecipeCardHtml(recipe);
        }
        wireCardEvents(card, recipe);
        setCardSelectedState(card, selectedRecipeIds.has(recipe.id));
        grid.appendChild(card);
    });

    // Set up the viewport observer so each card fades in right before it
    // enters the viewport rather than after a pre-computed stagger delay.
    const observer = getCardObserver();
    // rAF gives the browser one layout pass so getBoundingClientRect is accurate.
    requestAnimationFrame(() => {
        grid!.querySelectorAll<HTMLElement>(".recipe-card:not(.skeleton)").forEach((card) => {
            const rect = card.getBoundingClientRect();
            // Cards already within 150px of the viewport get .in-view immediately
            // so they don't briefly flash as transparent before the observer fires.
            if (rect.top < window.innerHeight + 150) {
                card.classList.add("in-view");
            } else {
                observer.observe(card);
            }
        });
    });

    updateSelectionUI();
}

function wireCardEvents(card: HTMLElement, recipe: Recipe) {
    // Chrome suppresses `click` when Ctrl is held in an extension popup.
    // Use mousedown to catch it before Chrome intercepts, then skip the
    // click handler via a flag to avoid double-firing.
    let pendingCtrlClick = false;

    card.addEventListener("mousedown", (event: MouseEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.button === 0) {
            pendingCtrlClick = true;
            selectRecipeRange(recipe.id);
        }
    });

    // Clicking the card navigates to the detail view.
    // Plain click in selection mode toggles individual selection.
    card.addEventListener("click", (event: MouseEvent) => {
        if (pendingCtrlClick) {
            pendingCtrlClick = false;
            return; // handled in mousedown
        }

        if (isSelectionMode) {
            toggleRecipeSelection(card, recipe.id);
            return;
        }
        window.location.href = `recipe.html?id=${recipe.id}`;
    });

    card.querySelector(".select-indicator")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (pendingCtrlClick) { pendingCtrlClick = false; return; }
        toggleRecipeSelection(card, recipe.id);
    });

    // Source links should not bubble to the card click handler
    card.querySelector(".view-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
    });
    card.querySelector(".small-card-source")?.addEventListener("click", (e) => {
        e.stopPropagation();
    });

    // Tag overflow chips — show popover with hidden tags
    card.querySelectorAll<HTMLElement>(".tag-overflow").forEach((chip) => {
        chip.addEventListener("click", (e) => {
            e.stopPropagation();
            const tags = chip.dataset.overflowTags?.split("|").filter(Boolean) ?? [];
            if (!tags.length) return;
            if (activePopoverAnchor === chip) {
                closeTagPopover();
            } else {
                showTagPopover(chip, tags);
            }
        });
    });

    // Mobile image preview: the .preview-toggle-btn is shown only on touch devices
    // (hidden via CSS on desktop where :hover drives the flip instead).
    // Tapping it toggles .is-flipped on the flip container and .active on the button.
    const previewBtn = card.querySelector<HTMLButtonElement>(".preview-toggle-btn");
    const flipContainer = card.querySelector<HTMLElement>(".content-flip-container");
    if (previewBtn && flipContainer) {
        previewBtn.addEventListener("click", (e) => {
            e.stopPropagation(); // prevent card navigation
            const isFlipped = flipContainer.classList.toggle("is-flipped");
            previewBtn.classList.toggle("active", isFlipped);
        });
    }

    // Favorite toggle — optimistic UI update
    card.querySelector(".favorite-btn")?.addEventListener("click", async (e) => {
        e.stopPropagation();
        recipe.isFavorite = !recipe.isFavorite;

        const btn = e.currentTarget as HTMLButtonElement;
        btn.classList.toggle("is-favorite", recipe.isFavorite);

        const starSize = parseInt(btn.dataset.starSize || "18", 10);
        const featherIcon = recipe.isFavorite
            ? (feather.icons["star"] as any)?.toSvg({
                width: starSize,
                height: starSize,
                fill: "currentColor",
            })
            : (feather.icons["star"] as any)?.toSvg({ width: starSize, height: starSize });
        if (featherIcon) btn.innerHTML = featherIcon;

        await saveRecipeLocally(recipe);
        // Re-sort everything so the card moves to its correct position
        await loadRecipes();
    });

}

// ─── Search ───────────────────────────────────────────────────────────────────

async function handleSearch() {
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

        // Ensure hard tag filters are applied before semantic search
        if (currentTagFilters.length > 0) {
            all = all.filter(r => r.tags && currentTagFilters.every(t => r.tags!.includes(t)));
        }

        // Step 1: synchronous tag/title pre-filter (no model needed)
        const tagHitIds = new Set<string>();
        const tagHits = all.filter((r) => {
            const titleMatch = r.title?.toLowerCase().includes(lower);
            const tagMatch = r.tags?.some((t) =>
                queryTokens.some((token) => t.toLowerCase().includes(token))
            );
            if (titleMatch || tagMatch) {
                tagHitIds.add(r.id);
                return true;
            }
            return false;
        });

        // Step 2: vector similarity search
        const embeddingResult: {
            success: boolean;
            embedding?: number[];
            error?: string;
        } = await chrome.runtime.sendMessage({
            type: "GENERATE_EMBEDDING",
            text: query,
        });

        let merged: typeof all;

        if (embeddingResult.success && embeddingResult.embedding) {
            const vectorMatches = await searchRecipes(
                embeddingResult.embedding,
                query,
                20
            );
            // Tag hits pinned first, then additional vector results
            const extraVectorMatches = vectorMatches.filter(
                (r) => !tagHitIds.has(r.id)
            );
            merged = [...tagHits, ...extraVectorMatches];
        } else {
            console.error("Search embedding failed:", embeddingResult.error);
            merged = tagHits;
        }

        renderRecipes(merged);

        const tagLabel =
            tagHits.length > 0
                ? ` (${tagHits.length} tag match${tagHits.length !== 1 ? "es" : ""})`
                : "";
        if (recipeCountEl)
            recipeCountEl.textContent = `${merged.length} result${merged.length !== 1 ? "s" : ""} for "${query}"${tagLabel}`;
    } catch (err) {
        console.error("Search error:", err);
    } finally {
        searchBtn.disabled = false;
    }
}

function wireSearchHandlers() {
    searchBtn?.addEventListener("click", handleSearch);

    // Global Enter to focus search bar
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
            if (visibleRecipeOrder.length === 0) return;
            e.preventDefault();
            visibleRecipeOrder.forEach((id) => {
                selectedRecipeIds.add(id);
                const card = grid?.querySelector<HTMLElement>(`.recipe-card[data-recipe-id="${id}"]`);
                if (card) setCardSelectedState(card, true);
            });
            lastSelectedRecipeId = visibleRecipeOrder[visibleRecipeOrder.length - 1];
            syncSelectionModeClass();
            updateSelectionUI();
        }
    });

    // Handle chips selection when text is highlighted
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

    // Hide suggestions when clicking outside
    document.addEventListener("click", (e) => {
        if (!searchInput?.contains(e.target as Node) && !searchSuggestions?.contains(e.target as Node)) {
            hideSuggestions();
        }
    });

    searchInput?.addEventListener("keydown", (e: KeyboardEvent) => {
        // Handle selecting chips
        if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
            if (currentTagFilters.length > 0) {
                searchBadgesContainer?.classList.add("chips-selected");
            }
            // Let default browser text selection happen
        }

        if (searchBadgesContainer?.classList.contains("chips-selected")) {
            const isPrintableKey = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
            const isCutOrPaste = (e.key === "x" || e.key === "v") && (e.ctrlKey || e.metaKey);

            if (e.key === "Backspace" || e.key === "Delete" || isPrintableKey || isCutOrPaste) {
                if (currentTagFilters.length > 0) {
                    currentTagFilters = [];
                    localStorage.setItem("pantryTagFilters", JSON.stringify(currentTagFilters));
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
            if (currentSuggestions.length > 0) {
                e.preventDefault();
                const idx = selectedSuggestionIndex >= 0 ? selectedSuggestionIndex : 0;
                selectSuggestion(currentSuggestions[idx]);
            }
            return;
        }

        if (e.key === "ArrowDown") {
            if (currentSuggestions.length > 0) {
                e.preventDefault();
                selectedSuggestionIndex = (selectedSuggestionIndex + 1) % currentSuggestions.length;
                renderSuggestions();
                // Ensure selected item is visible (basic scroll)
                const selectedEl = searchSuggestions?.querySelector('.selected') as HTMLElement;
                if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest' });
            }
            return;
        }

        if (e.key === "ArrowUp") {
            if (currentSuggestions.length > 0) {
                e.preventDefault();
                selectedSuggestionIndex = selectedSuggestionIndex <= 0 ? currentSuggestions.length - 1 : selectedSuggestionIndex - 1;
                renderSuggestions();
                const selectedEl = searchSuggestions?.querySelector('.selected') as HTMLElement;
                if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest' });
            }
            return;
        }

        if (e.key === "Enter") {
            e.preventDefault();
            if (selectedSuggestionIndex >= 0 && selectedSuggestionIndex < currentSuggestions.length) {
                selectSuggestion(currentSuggestions[selectedSuggestionIndex]);
                return;
            }

            const text = searchInput.value.trim().toUpperCase();
            if (allKnownTags.has(text) && !currentTagFilters.includes(text)) {
                currentTagFilters.unshift(text);
                localStorage.setItem("pantryTagFilters", JSON.stringify(currentTagFilters));
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
        if (e.key === "Backspace" && searchInput.value === "" && currentTagFilters.length > 0) {
            currentTagFilters.shift();
            localStorage.setItem("pantryTagFilters", JSON.stringify(currentTagFilters));
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
            currentTagFilters = [];
            localStorage.setItem("pantryTagFilters", JSON.stringify(currentTagFilters));
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
            if (allKnownTags.has(term) && !currentTagFilters.includes(term)) {
                currentTagFilters.unshift(term);
                localStorage.setItem("pantryTagFilters", JSON.stringify(currentTagFilters));
                searchInput.value = "";
                renderSearchBadges();
                hideSuggestions();
                await handleSearch();
                return;
            }
        }

        if (text.trim().length > 0 || currentTagFilters.length > 0) {
            clearBtn?.classList.add("show");
        } else {
            clearBtn?.classList.remove("show");
        }

        triggerShowSuggestions();

        if (text.trim().length === 0) {
            await handleSearch(); // trigger search which will fall back to loadRecipes
        }
    });

    const triggerShowSuggestions = () => {
        const textBeforeCursor = searchInput?.value.substring(0, searchInput?.selectionStart || 0) || "";
        let lowerQuery = "";

        if (textBeforeCursor.trim() !== "") {
            lowerQuery = searchInput?.value.trim().toLowerCase() || "";
        }

        currentSuggestions = Array.from(allKnownTags).filter(tag =>
            !currentTagFilters.includes(tag) && tag.toLowerCase().startsWith(lowerQuery)
        ).sort();

        if (lowerQuery === "") {
            selectedSuggestionIndex = -1;
        } else {
            selectedSuggestionIndex = currentSuggestions.length > 0 ? 0 : -1;
        }
        renderSuggestions();
    };

    searchInput?.addEventListener("focus", triggerShowSuggestions);
    searchInput?.addEventListener("click", triggerShowSuggestions);
    searchInput?.addEventListener("keyup", (e) => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
            triggerShowSuggestions();
        }
    });

    // Also allow clicking inside the container background to focus input natively
    searchInput?.closest(".search-input-container")?.addEventListener("click", (e) => {
        if (e.target === searchInput?.closest(".search-input-container")) {
            searchInput?.focus();
        }
    });
}

// ─── Import / Export ──────────────────────────────────────────────────────────

function wireImportExport() {
    // Export backup
    const exportBtn = document.getElementById("export-btn");
    exportBtn?.addEventListener("click", async () => {
        try {
            const recipes = await getAllRecipes();
            // Strip embeddings from the export — they are re-computed on import
            const exportRecipes = recipes.map((r) => {
                const { embedding, ...rest } = r;
                return rest;
            });
            const blob = new Blob([JSON.stringify(exportRecipes, null, 2)], {
                type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `mypantry_backup_${new Date().toISOString().split("T")[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error("Export failed:", err);
            alert("Failed to export database.");
        }
    });

    // Import backup
    const importBtn = document.getElementById("import-btn") as HTMLButtonElement | null;
    const importFile = document.getElementById("import-file") as HTMLInputElement | null;

    importBtn?.addEventListener("click", () => {
        if (importFile) importFile.click();
    });

    importFile?.addEventListener("change", async (e: Event) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file || !importBtn) return;

        const originalHtml = importBtn.innerHTML;
        importBtn.disabled = true;
        importBtn.innerHTML =
            feather.icons["loader"]?.toSvg({
                width: 16,
                height: 16,
                class: "spin-svg",
            }) || "";

        try {
            const text = await file.text();
            const recipes = JSON.parse(text);

            if (Array.isArray(recipes)) {
                // Re-generate embeddings for any recipes that don't have them
                // (embeddings are excluded from exports to reduce file size)
                for (const r of recipes) {
                    if (!r.embedding) {
                        const embeddingText = [r.title, r.semantic_summary || "", ...(r.ingredients?.map((i: any) => i.item) || [])].filter(Boolean).join(". ");
                        const embeddingResult = await chrome.runtime.sendMessage({
                            type: "GENERATE_EMBEDDING",
                            text: embeddingText,
                        });
                        if (embeddingResult.success && embeddingResult.embedding) {
                            r.embedding = embeddingResult.embedding;
                        }
                    }
                }

                await importRecipesLocally(recipes as Recipe[]);
                await loadRecipes();
                importFile.value = ""; // Allow same file to be re-selected
            } else {
                alert("Invalid backup file format. Expected an array of recipes.");
            }
        } catch (err) {
            console.error("Import failed:", err);
            alert("Failed to read backup file. Make sure it is a valid JSON file.");
        } finally {
            importBtn.innerHTML = originalHtml;
            importBtn.disabled = false;
        }
    });
}
