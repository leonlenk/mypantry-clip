/**
 * Recipe grid loading and rendering for the pantry page.
 *
 * loadRecipes() is the main entry point: fetches all recipes, applies active
 * filters/sort, then delegates to renderRecipes() for DOM output.
 * wireCardEvents() attaches all per-card interaction handlers.
 */

import feather from "feather-icons";
import { getAllRecipes, saveRecipeLocally } from "../../utils/db";
import type { Recipe } from "../../types/recipe";
import { pantryState } from "./pantryState";
import { extractTags } from "./tagFilter";
import {
    buildRecipeCardHtml,
    buildMediumCardHtml,
    buildSmallCardHtml,
    buildPlaceholderHtml,
} from "./cardRenderer";
import { closeTagPopover, showTagPopover } from "./tagPopover";
import { setCardSelectedState, syncSelectionModeClass, toggleRecipeSelection, selectRecipeRange, updateSelectionUI } from "./selectionManager";

// ─── DOM handles ─────────────────────────────────────────────────────────────

const grid = document.getElementById("recipe-grid");
const emptyState = document.getElementById("empty-state");
const recipeCountEl = document.getElementById("recipe-count");

// ─── Viewport intersection observer ──────────────────────────────────────────

let cardObserver: IntersectionObserver | null = null;

function getCardObserver(): IntersectionObserver {
    if (cardObserver) cardObserver.disconnect();
    cardObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    (entry.target as HTMLElement).classList.add("in-view");
                    cardObserver!.unobserve(entry.target);
                }
            });
        },
        { rootMargin: "150px 0px", threshold: 0 }
    );
    return cardObserver;
}

// ─── Recipe loading ───────────────────────────────────────────────────────────

export async function loadRecipes() {
    let recipes = await getAllRecipes();

    // Normalise and augment tags with the source domain
    recipes.forEach((r) => {
        if (!r.tags) r.tags = [];
        r.tags = r.tags.map((t) => t.toUpperCase()).sort((a, b) => a.localeCompare(b));
        if (r.url) {
            try {
                const domain = new URL(r.url).hostname.replace(/^www\./, "").toUpperCase();
                if (!r.tags.includes(domain)) {
                    r.tags.push(domain);
                    r.tags.sort((a, b) => a.localeCompare(b));
                }
            } catch { /* invalid URL */ }
        }
    });

    extractTags(recipes);

    recipes.sort((a, b) => {
        if (pantryState.currentFilter === "all" || pantryState.currentFilter === "favorites") {
            if (a.isFavorite && !b.isFavorite) return -1;
            if (!a.isFavorite && b.isFavorite) return 1;
            return a.title.localeCompare(b.title);
        }
        // Pure chronological for "Recent" (newest first)
        return (b.createdAt || 0) - (a.createdAt || 0);
    });

    if (pantryState.currentFilter === "favorites") {
        recipes = recipes.filter((r) => r.isFavorite);
    }

    if (pantryState.currentTagFilters.length > 0) {
        recipes = recipes.filter(
            (r) => r.tags && pantryState.currentTagFilters.every((tag) => r.tags!.includes(tag))
        );
    }

    if (recipeCountEl) {
        recipeCountEl.textContent = `${recipes.length} recipe${recipes.length !== 1 ? "s" : ""}`;
    }

    if ((document as any).startViewTransition && !pantryState.skipNextViewTransition) {
        (document as any).startViewTransition(() => renderRecipes(recipes));
    } else {
        pantryState.skipNextViewTransition = false;
        renderRecipes(recipes);
    }
}

// ─── Recipe rendering ─────────────────────────────────────────────────────────

export function renderRecipes(recipes: Recipe[]) {
    if (!grid || !emptyState) return;

    pantryState.visibleRecipeOrder = recipes.map((r) => r.id);

    // Prune deselected cards that are no longer visible
    const visibleIds = new Set(recipes.map((r) => r.id));
    Array.from(pantryState.selectedRecipeIds).forEach((id) => {
        if (!visibleIds.has(id)) pantryState.selectedRecipeIds.delete(id);
    });
    if (pantryState.selectedRecipeIds.size === 0 && pantryState.isSelectionMode) {
        pantryState.isSelectionMode = false;
        syncSelectionModeClass();
    }

    grid.innerHTML = "";

    // Render active extraction placeholders first (they get .in-view immediately)
    Object.entries(pantryState.activeExtractions).forEach(([url, data], index) => {
        const placeholder = document.createElement("div");
        const safeId = "placeholder-" + url.replace(/[^a-zA-Z0-9_-]/g, "");
        placeholder.id = safeId;
        placeholder.className = "card recipe-card skeleton in-view";
        (placeholder.style as any).viewTransitionName = `placeholder-view-${index}`;
        placeholder.innerHTML = buildPlaceholderHtml(data.title, data.status, pantryState.currentViewMode, url);
        grid.appendChild(placeholder);
    });

    if (recipes.length === 0 && Object.keys(pantryState.activeExtractions).length === 0) {
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

        if (pantryState.currentViewMode === "small") {
            card.innerHTML = buildSmallCardHtml(recipe);
        } else if (pantryState.currentViewMode === "medium") {
            card.innerHTML = buildMediumCardHtml(recipe);
        } else {
            if (recipe.image) card.classList.add("has-image");
            card.innerHTML = buildRecipeCardHtml(recipe);
        }

        wireCardEvents(card, recipe);
        setCardSelectedState(card, pantryState.selectedRecipeIds.has(recipe.id));
        grid.appendChild(card);
    });

    // Fade in cards as they enter the viewport
    const observer = getCardObserver();
    requestAnimationFrame(() => {
        grid!.querySelectorAll<HTMLElement>(".recipe-card:not(.skeleton)").forEach((card) => {
            const rect = card.getBoundingClientRect();
            if (rect.top < window.innerHeight + 150) {
                card.classList.add("in-view");
            } else {
                observer.observe(card);
            }
        });
    });

    updateSelectionUI();
}

// ─── Card event wiring ────────────────────────────────────────────────────────

export function wireCardEvents(card: HTMLElement, recipe: Recipe) {
    // Progressive image upgrade: thumbnail loads first (via loading="lazy"), then
    // the full-size hires version is prefetched and swapped in seamlessly.
    card.querySelectorAll<HTMLImageElement>("img[data-hires]").forEach((img) => {
        const swap = () => {
            const hi = new Image();
            hi.onload = () => { img.src = hi.src; };
            hi.src = img.dataset.hires!;
        };
        if (img.complete && img.naturalWidth > 0) swap();
        else img.addEventListener("load", swap, { once: true });
    });

    // Chrome suppresses `click` when Ctrl is held in an extension popup;
    // catch it in mousedown and skip the click handler via a flag.
    let pendingCtrlClick = false;

    card.addEventListener("mousedown", (event: MouseEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.button === 0) {
            pendingCtrlClick = true;
            selectRecipeRange(recipe.id);
        }
    });

    card.addEventListener("click", (event: MouseEvent) => {
        if (pendingCtrlClick) { pendingCtrlClick = false; return; }
        if (pantryState.isSelectionMode) {
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

    card.querySelector(".view-btn")?.addEventListener("click", (e) => e.stopPropagation());
    card.querySelector(".small-card-source")?.addEventListener("click", (e) => e.stopPropagation());

    // Tag overflow chips — show popover with hidden tags
    card.querySelectorAll<HTMLElement>(".tag-overflow").forEach((chip) => {
        chip.addEventListener("click", (e) => {
            e.stopPropagation();
            const tags = chip.dataset.overflowTags?.split("|").filter(Boolean) ?? [];
            if (!tags.length) return;
            if (chip === (document.querySelector(".tag-overflow-popover") as any)?._anchor) {
                closeTagPopover();
            } else {
                showTagPopover(chip, tags);
            }
        });
    });

    // Mobile image preview toggle
    const previewBtn = card.querySelector<HTMLButtonElement>(".preview-toggle-btn");
    const flipContainer = card.querySelector<HTMLElement>(".content-flip-container");
    if (previewBtn && flipContainer) {
        previewBtn.addEventListener("click", (e) => {
            e.stopPropagation();
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
            ? (feather.icons["star"] as any)?.toSvg({ width: starSize, height: starSize, fill: "currentColor" })
            : (feather.icons["star"] as any)?.toSvg({ width: starSize, height: starSize });
        if (featherIcon) btn.innerHTML = featherIcon;

        await saveRecipeLocally(recipe);
        await loadRecipes();
    });
}
