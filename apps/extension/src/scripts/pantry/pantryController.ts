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

// ─── Page state ───────────────────────────────────────────────────────────────

let currentFilter = localStorage.getItem("pantryFilter") || "all";
const UNIT_PREFERENCE_KEY = "preferredUnitSystem";
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
    wireImportExport();

    // Enable animations after first paint to prevent layout-shift flashes
    // (e.g. fadeUp on recipe cards firing before the grid is stable on mobile).
    requestAnimationFrame(() =>
        requestAnimationFrame(() => document.body.classList.add("page-ready"))
    );
});

// ─── Extraction live-update listener ────────────────────────────────────────

function wireExtractionListener() {
    if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return;

    chrome.runtime.onMessage.addListener((message: any) => {
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

    const MAX_VISIBLE_TAGS = 2;
    const MAX_TAG_LENGTH = 12;

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
        r.tags = r.tags.map(t => t.toUpperCase());
        if (r.url) {
            try {
                const domain = new URL(r.url).hostname.replace(/^www\./, '').toUpperCase();
                if (!r.tags.includes(domain)) {
                    r.tags.push(domain);
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

        const isNew = recipe.createdAt && Date.now() - recipe.createdAt < 6000;
        if (isNew) card.classList.add("highlight-new");

        (card.style as any).viewTransitionName = `card-${recipe.id}`;

        card.innerHTML = buildRecipeCardHtml(recipe);
        wireCardEvents(card, recipe);
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
}

function wireCardEvents(card: HTMLElement, recipe: Recipe) {
    // Clicking the card navigates to the detail view
    card.addEventListener("click", () => {
        window.location.href = `recipe.html?id=${recipe.id}`;
    });

    // Source link should not bubble to the card click handler
    card.querySelector(".view-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
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

        const featherIcon = recipe.isFavorite
            ? (feather.icons["star"] as any)?.toSvg({
                width: 18,
                height: 18,
                fill: "currentColor",
            })
            : (feather.icons["star"] as any)?.toSvg({ width: 18, height: 18 });
        if (featherIcon) btn.innerHTML = featherIcon;

        await saveRecipeLocally(recipe);
        // Re-sort everything so the card moves to its correct position
        await loadRecipes();
    });

    // Delete — removes from DB and cleans up empty-state
    card.querySelector(".delete-btn")?.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = (e.currentTarget as HTMLButtonElement).dataset.id!;
        await deleteRecipe(id);
        card.remove();

        const remaining = grid!.querySelectorAll(".recipe-card").length;
        if (recipeCountEl)
            recipeCountEl.textContent = `${remaining} recipe${remaining !== 1 ? "s" : ""}`;
        if (remaining === 0) {
            grid!.classList.add("hidden");
            emptyState!.classList.remove("hidden");
        }
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
    searchBtn.textContent = "Searching...";

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
        searchBtn.textContent = "Search";
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
                        const embeddingText = `${r.title} ${r.description || ""} ${r.tags?.join(" ") || ""}`;
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
