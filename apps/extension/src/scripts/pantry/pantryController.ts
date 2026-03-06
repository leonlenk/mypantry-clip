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
const dropdownMenu = document.getElementById("tag-dropdown-menu");
const selectedTagEl = document.getElementById("selected-tag");

// ─── Page state ───────────────────────────────────────────────────────────────

let currentFilter = localStorage.getItem("pantryFilter") || "all";
let currentTagFilter = localStorage.getItem("pantryTagFilter") || "";
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

function populateTags(allRecipes: Recipe[]) {
    if (!dropdownMenu || !selectedTagEl) return;

    const allTags = new Set<string>();
    allRecipes.forEach((r) => {
        if (r.tags) r.tags.forEach((t) => allTags.add(t));
    });

    const sortedTags = Array.from(allTags).sort();
    dropdownMenu.innerHTML = "";

    // "All Tags" option
    const allOption = document.createElement("div");
    allOption.className = `dropdown-item ${!currentTagFilter ? "active" : ""}`;
    allOption.textContent = "All Tags";
    allOption.addEventListener("click", async () => {
        currentTagFilter = "";
        localStorage.removeItem("pantryTagFilter");
        selectedTagEl.textContent = "All Tags";
        await loadRecipes();
    });
    dropdownMenu.appendChild(allOption);

    sortedTags.forEach((tag) => {
        const option = document.createElement("div");
        option.className = `dropdown-item ${currentTagFilter === tag ? "active" : ""}`;
        option.textContent = tag;
        option.addEventListener("click", async () => {
            currentTagFilter = tag;
            localStorage.setItem("pantryTagFilter", tag);
            selectedTagEl.textContent = tag;
            await loadRecipes();
        });
        dropdownMenu.appendChild(option);
    });

    // If the saved tag filter is no longer valid, reset it
    if (currentTagFilter && !allTags.has(currentTagFilter)) {
        currentTagFilter = "";
        localStorage.removeItem("pantryTagFilter");
        selectedTagEl.textContent = "All Tags";
    } else if (currentTagFilter && allTags.has(currentTagFilter)) {
        selectedTagEl.textContent = currentTagFilter;
    }
}

// ─── Recipe loading / rendering ───────────────────────────────────────────────

async function loadRecipes() {
    let recipes = await getAllRecipes();
    populateTags(recipes);

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

    if (currentTagFilter) {
        recipes = recipes.filter(
            (r) => r.tags && r.tags.includes(currentTagFilter)
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

    // Render active extraction placeholders first
    Object.entries(activeExtractions).forEach(([url, data], index) => {
        const placeholder = document.createElement("div");
        const safeId = "placeholder-" + url.replace(/[^a-zA-Z0-9_-]/g, "");
        placeholder.id = safeId;
        placeholder.className = "card recipe-card skeleton";
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
        const all = await getAllRecipes();

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

    searchInput?.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") handleSearch();
    });

    clearBtn?.addEventListener("click", async () => {
        if (searchInput) {
            searchInput.value = "";
            clearBtn.classList.remove("show");
            await loadRecipes();
        }
    });

    searchInput?.addEventListener("input", async () => {
        if (searchInput.value.trim().length > 0) {
            clearBtn?.classList.add("show");
        } else {
            clearBtn?.classList.remove("show");
            await loadRecipes();
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
