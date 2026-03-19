/**
 * Tag extraction and search-badge rendering.
 *
 * extractTags() rebuilds allKnownTags from the current recipe list and
 * prunes any stale filters, then calls renderSearchBadges() to sync the UI.
 * renderSearchBadges() is also called directly by searchManager whenever
 * the active tag filters change without a full recipe reload.
 */

import feather from "feather-icons";
import type { Recipe } from "../../types/recipe";
import { pantryState } from "./pantryState";
import { LS } from "../../utils/storage";

const searchBadgesContainer = document.getElementById("search-badges");
const searchInput = document.getElementById("semantic-search") as HTMLInputElement;
const clearBtn = document.getElementById("clear-search");

export function extractTags(allRecipes: Recipe[]) {
    pantryState.allKnownTags.clear();
    allRecipes.forEach((r) => {
        if (r.tags) r.tags.forEach((t) => pantryState.allKnownTags.add(t));
    });

    // Remove any filters that are no longer valid tags
    const origLength = pantryState.currentTagFilters.length;
    pantryState.currentTagFilters = pantryState.currentTagFilters.filter(
        (t) => pantryState.allKnownTags.has(t)
    );
    if (pantryState.currentTagFilters.length !== origLength) {
        localStorage.setItem(LS.pantryTagFilters, JSON.stringify(pantryState.currentTagFilters));
    }
    renderSearchBadges();
}

export function renderSearchBadges() {
    if (!searchBadgesContainer) return;
    searchBadgesContainer.innerHTML = "";

    const MAX_VISIBLE_TAGS = window.innerWidth <= 600 ? 1 : 2;
    const MAX_TAG_LENGTH = window.innerWidth <= 600 ? 5 : 12;

    const visibleTags = pantryState.currentTagFilters.slice(0, MAX_VISIBLE_TAGS);
    const hiddenTags = pantryState.currentTagFilters.slice(MAX_VISIBLE_TAGS);

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
        badge.querySelector("button")?.addEventListener("click", () => {
            pantryState.currentTagFilters.splice(idx, 1);
            localStorage.setItem(LS.pantryTagFilters, JSON.stringify(pantryState.currentTagFilters));
            renderSearchBadges();
            // Trigger search refresh — imported lazily to avoid circular dep
            import("./searchManager").then(({ handleSearch }) => handleSearch());
        });
        searchBadgesContainer.appendChild(badge);
    });

    if (hiddenTags.length > 0) {
        const moreBadge = document.createElement("div");
        moreBadge.className = "search-badge more-badge";
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
            item.querySelector("button")?.addEventListener("click", (e) => {
                e.stopPropagation();
                pantryState.currentTagFilters.splice(realIdx, 1);
                localStorage.setItem(LS.pantryTagFilters, JSON.stringify(pantryState.currentTagFilters));
                renderSearchBadges();
                import("./searchManager").then(({ handleSearch }) => handleSearch());
            });
            popover.appendChild(item);
        });

        moreBadge.addEventListener("click", (e) => {
            e.stopPropagation();
            popover.classList.toggle("hidden");
        });

        document.addEventListener("click", (e) => {
            if (!moreBadge.contains(e.target as Node)) {
                popover.classList.add("hidden");
            }
        });

        moreBadge.appendChild(popover);
        searchBadgesContainer.appendChild(moreBadge);
    }

    // Show/hide the clear X button
    if ((searchInput && searchInput.value.trim().length > 0) || pantryState.currentTagFilters.length > 0) {
        clearBtn?.classList.add("show");
    } else {
        clearBtn?.classList.remove("show");
    }
}
