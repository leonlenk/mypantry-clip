/**
 * Pantry card renderer — pure HTML-string builders.
 *
 * Keeping all innerHTML templating here means pantryController.ts can stay
 * focused on DOM state management, and these functions are easy to unit-test
 * in isolation if tests are added later.
 */

import feather from "feather-icons";
import { formatTime } from "../../utils/conversions";
import type { Recipe } from "../../types/recipe";

/** Guard: feather-icons will throw if the icon name doesn't exist. */
function safeIcon(
    name: string,
    opts: Record<string, unknown> = {}
): string {
    return (feather.icons[name] as any)?.toSvg(opts) ?? "";
}

/**
 * Builds the meta row HTML (time · servings · yield).
 * Returns an empty string when no meta data is available.
 */
export function buildMetaHtml(recipe: Recipe): string {
    // Prefer totalTimeMinutes; fall back to prep+cook sum (Cloud API only sets those)
    const displayTime =
        recipe.totalTimeMinutes ||
        (recipe.prepTimeMinutes || 0) + (recipe.cookTimeMinutes || 0) ||
        null;

    const items = [
        displayTime
            ? `<span class="meta-item">${safeIcon("clock", { width: 14, height: 14 })} ${formatTime(displayTime)}</span>`
            : null,
        recipe.servings
            ? `<span class="meta-item">${safeIcon("users", { width: 14, height: 14 })} ${recipe.servings} servings</span>`
            : null,
        recipe.yield
            ? `<span class="meta-item">${safeIcon("package", { width: 14, height: 14 })} ${recipe.yield}</span>`
            : null,
    ].filter(Boolean);

    return items.join('<span class="dot">·</span>');
}

/**
 * Builds the content area (description + tags), optionally wrapped in a
 * flip-container when the recipe has a cover image.
 */
function buildContentHtml(recipe: Recipe): string {
    const tagsHtml = recipe.tags
        ? recipe.tags.map((tag) => `<span class="tag">${tag}</span>`).join("")
        : "";

    const description = (recipe.description || "").slice(0, 140);
    const truncated = (recipe.description || "").length > 140 ? "..." : "";

    const innerHtml = `
        <p class="desc">${description}${truncated}</p>
        <div class="tags">${tagsHtml}</div>
    `;

    if (recipe.image) {
        return `
            <div class="content-flip-container">
                <div class="content-flip-inner">
                    <div class="content-front">${innerHtml}</div>
                    <div class="content-back">
                        <img src="${recipe.image}" alt="${recipe.title} cover image" loading="lazy" />
                    </div>
                </div>
            </div>
        `;
    }

    return innerHtml;
}

/**
 * Returns the full inner HTML string for a recipe card `<div>`.
 */
export function buildRecipeCardHtml(recipe: Recipe): string {
    const metaHtml = buildMetaHtml(recipe);
    const contentHtml = buildContentHtml(recipe);

    const starIcon = recipe.isFavorite
        ? safeIcon("star", { width: 18, height: 18, fill: "currentColor" })
        : safeIcon("star", { width: 18, height: 18 });

    const deleteIcon = safeIcon("x", { width: 18, height: 18 });

    return `
        <div class="card-header">
            <h3>${recipe.title}</h3>
            <div class="card-actions">
                <button class="favorite-btn ${recipe.isFavorite ? "is-favorite" : ""}" data-id="${recipe.id}" title="Toggle favorite">
                    ${starIcon}
                </button>
                <button class="delete-btn" data-id="${recipe.id}" title="Delete recipe">
                    ${deleteIcon}
                </button>
            </div>
        </div>
        ${metaHtml ? `<div class="meta">${metaHtml}</div>` : ""}
        ${contentHtml}
        <div class="card-footer">
            ${recipe.url
            ? `<a href="${recipe.url}" target="_blank" class="view-btn">View Source →</a>`
            : "<span></span>"
        }
            ${recipe.image
            ? `<button class="preview-toggle-btn" title="Preview image">${safeIcon("image", { width: 16, height: 16 })}</button>`
            : ""
        }
        </div>
    `;
}

/**
 * Returns the inner HTML for an in-progress extraction placeholder card.
 */
export function buildPlaceholderHtml(title: string, status: string): string {
    return `
        <div class="card-header">
            <h3 class="skeleton-title" style="overflow-wrap: anywhere; opacity: 0.8; margin-bottom: 0; background: none; animation: none;">${title}</h3>
        </div>
        <div class="skeleton-meta"></div>
        <div class="skeleton-text"></div>
        <div class="skeleton-text"></div>
        <div class="status-badge">${status}</div>
    `;
}
