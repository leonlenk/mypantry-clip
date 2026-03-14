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
function buildOverflowChip(overflowTags: string[]): string {
    if (!overflowTags.length) return "";
    return `<span class="tag tag-overflow" data-overflow-tags="${overflowTags.join("|")}">+${overflowTags.length}</span>`;
}

function buildContentHtml(recipe: Recipe): string {
    const MAX_TAGS = 5;
    let domain = "";
    let domainTagHtml = "";
    if (recipe.url) {
        try {
            domain = new URL(recipe.url).hostname.replace(/^www\./, '').toUpperCase();
            domainTagHtml = `<span class="tag domain-tag">${safeIcon("link", { width: 10, height: 10, style: "margin-right: 4px; vertical-align: -1px;" })}${domain}</span>`;
        } catch (e) { }
    }

    const sortedTags = recipe.tags
        ? [...recipe.tags].sort((a, b) => a.localeCompare(b)).filter(tag => tag !== domain)
        : [];
    const visibleTagsHtml = sortedTags.slice(0, MAX_TAGS).map((t) => `<span class="tag">${t}</span>`).join("");
    const overflowChip = buildOverflowChip(sortedTags.slice(MAX_TAGS));

    const displayText = recipe.semantic_summary || "";
    const description = displayText.slice(0, 160);
    const truncated = displayText.length > 160 ? "..." : "";

    const innerHtml = `
        <p class="desc">${description}${truncated}</p>
        <div class="tags">${domainTagHtml}${visibleTagsHtml}${overflowChip}</div>
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
    const checkIcon = safeIcon("check", { width: 14, height: 14 });

    const starIcon = recipe.isFavorite
        ? safeIcon("star", { width: 18, height: 18, fill: "currentColor" })
        : safeIcon("star", { width: 18, height: 18 });

    return `
        <div class="card-header">
            <h3 title="${recipe.title}">${recipe.title}</h3>
            <div class="card-actions">
                <button class="favorite-btn ${recipe.isFavorite ? "is-favorite" : ""}" data-id="${recipe.id}" data-star-size="18" title="Toggle favorite">
                    ${starIcon}
                </button>
                <button class="select-indicator" data-id="${recipe.id}" aria-label="Select recipe">
                    ${checkIcon}
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
 * Builds the compact card HTML for medium grid view.
 * Shows image at top, title + meta + limited tags — no description, no flip.
 */
export function buildMediumCardHtml(recipe: Recipe): string {
    const metaHtml = buildMetaHtml(recipe);
    const checkIcon = safeIcon("check", { width: 12, height: 12 });
    const starIcon = recipe.isFavorite
        ? safeIcon("star", { width: 16, height: 16, fill: "currentColor" })
        : safeIcon("star", { width: 16, height: 16 });

    let domain = "";
    let domainTagHtml = "";
    if (recipe.url) {
        try {
            domain = new URL(recipe.url).hostname.replace(/^www\./, "").toUpperCase();
            domainTagHtml = `<span class="tag domain-tag">${safeIcon("link", { width: 10, height: 10, style: "margin-right: 3px; vertical-align: -1px;" })}${domain}</span>`;
        } catch (e) {}
    }

    const sortedTags = recipe.tags
        ? [...recipe.tags].sort((a, b) => a.localeCompare(b)).filter((t) => t !== domain)
        : [];
    const MAX_TAGS = 3;
    const visibleTagsHtml = sortedTags.slice(0, MAX_TAGS).map((t) => `<span class="tag">${t}</span>`).join("");
    const overflowChip = buildOverflowChip(sortedTags.slice(MAX_TAGS));

    const imageHtml = recipe.image
        ? `<div class="medium-card-image"><img src="${recipe.image}" alt="${recipe.title} cover" loading="lazy" /></div>`
        : "";

    return `
        ${imageHtml}
        <div class="medium-card-body">
            <div class="card-header">
                <h3 title="${recipe.title}">${recipe.title}</h3>
                <div class="card-actions">
                    <button class="favorite-btn ${recipe.isFavorite ? "is-favorite" : ""}" data-id="${recipe.id}" data-star-size="16" title="Toggle favorite">${starIcon}</button>
                    <button class="select-indicator" data-id="${recipe.id}" aria-label="Select recipe">${checkIcon}</button>
                </div>
            </div>
            ${metaHtml ? `<div class="meta">${metaHtml}</div>` : ""}
            <div class="tags">${domainTagHtml}${visibleTagsHtml}${overflowChip}</div>
            ${recipe.url ? `<a href="${recipe.url}" target="_blank" class="view-btn">View Source →</a>` : ""}
        </div>
    `;
}

/**
 * Builds the compact list-row HTML for small/list view.
 * Single horizontal row: star | title | tags+overflow | source link.
 */
export function buildSmallCardHtml(recipe: Recipe): string {
    const starIcon = recipe.isFavorite
        ? safeIcon("star", { width: 14, height: 14, fill: "currentColor" })
        : safeIcon("star", { width: 14, height: 14 });
    const checkIcon = safeIcon("check", { width: 12, height: 12 });

    let domain = "";
    if (recipe.url) {
        try {
            domain = new URL(recipe.url).hostname.replace(/^www\./, "").toUpperCase();
        } catch (e) {}
    }

    const allTags = recipe.tags
        ? [...recipe.tags].sort((a, b) => a.localeCompare(b))
        : [];
    // In small view show only 2 non-domain tags; domain counts in overflow
    const nonDomainTags = allTags.filter((t) => t !== domain);
    const MAX_TAGS = 2;
    const visibleTagsHtml = nonDomainTags.slice(0, MAX_TAGS).map((t) => `<span class="tag">${t}</span>`).join("");
    // Overflow includes hidden non-domain tags + the domain tag
    const overflowTags = [
        ...nonDomainTags.slice(MAX_TAGS),
        ...(domain ? [domain] : []),
    ];
    const overflowChip = buildOverflowChip(overflowTags);

    const sourceLink = recipe.url
        ? `<a href="${recipe.url}" target="_blank" class="small-card-source" title="View source">${safeIcon("external-link", { width: 13, height: 13 })}</a>`
        : "";

    return `
        <button class="favorite-btn ${recipe.isFavorite ? "is-favorite" : ""}" data-id="${recipe.id}" data-star-size="14" title="Toggle favorite">${starIcon}</button>
        <button class="select-indicator" data-id="${recipe.id}" aria-label="Select recipe">${checkIcon}</button>
        <span class="small-card-title" title="${recipe.title}">${recipe.title}</span>
        <div class="small-card-tags">${visibleTagsHtml}${overflowChip}</div>
        ${sourceLink}
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
