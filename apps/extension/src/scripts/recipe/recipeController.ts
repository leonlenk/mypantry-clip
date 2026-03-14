/**
 * Recipe page controller — rendering and UI interactions.
 *
 * Responsibilities:
 *  - Parse ?id= URL param, load recipe from DB
 *  - Render: title, description, source link, tags, ingredients, instructions, notes
 *  - Unit system switching (US ↔ Metric) and batch-size scaling of ingredients
 *  - Inline title editing (pencil button)
 *  - Delegated click handlers for tag removal and substitution revert
 *  - Delegated keydown handler for tag addition
 *
 * Substitution modal logic is in substitutionController.ts and reads the same
 * `recipeState` singleton for currentRecipe.
 */

import feather from "feather-icons";
import { getRecipe, saveRecipeLocally } from "../../utils/db";
import {
    convertVolumeToWeight,
    formatUSVolume,
    formatTime,
    escapeHtml,
} from "../../utils/conversions";
import { recipeState } from "./recipeState";

// ─── Page state ───────────────────────────────────────────────────────────────

let currentUnitSystem = "us"; // "us" | "metric"
let isFirstRender = true;
const UNIT_PREFERENCE_KEY = "preferredUnitSystem";

// ─── Startup ─────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const recipeId = urlParams.get("id");

    document.getElementById("back-btn")?.addEventListener("click", () => {
        window.location.href = "pantry.html";
    });

    const editRecipeBtn = document.getElementById("edit-recipe-btn") as HTMLButtonElement;
    if (editRecipeBtn && recipeId) {
        editRecipeBtn.classList.remove("hidden");
        editRecipeBtn.addEventListener("click", () => {
            window.location.href = `recipe-edit.html?id=${recipeId}`;
        });
    }

    if (!recipeId) {
        showError();
        return;
    }

    try {
        const recipe = await getRecipe(recipeId);
        if (!recipe) {
            showError();
            return;
        }
        if (recipe.tags) {
            recipe.tags = recipe.tags
                .map((t: string) => t.toUpperCase())
                .sort((a: string, b: string) => a.localeCompare(b));
        }
        recipeState.currentRecipe = recipe;
        renderRecipe(recipe);
    } catch (e) {
        console.error(e);
        showError();
    }

    wireTitleEdit();
    wireDelegatedHandlers();
    wireMobileIngredientPanel();

    // Enable CSS transitions only after the first paint so the ingredients panel
    // doesn't animate from off-screen during initial layout (FOUC prevention).
    requestAnimationFrame(() =>
        requestAnimationFrame(() => document.body.classList.add("page-ready"))
    );
});

// ─── Error / loading state ────────────────────────────────────────────────────

function showError() {
    document.getElementById("loading")?.classList.add("hidden");
    document.getElementById("error-state")?.classList.remove("hidden");
}

// ─── Title inline edit ────────────────────────────────────────────────────────

function wireTitleEdit() {
    const titleHeading = document.getElementById("recipe-title");
    const titleInput = document.getElementById("recipe-title-input") as HTMLInputElement;
    const editTitleBtn = document.getElementById("edit-title-btn");

    function enableTitleEdit() {
        const recipe = recipeState.currentRecipe;
        if (!recipe || !titleHeading || !titleInput || !editTitleBtn) return;
        titleInput.value = recipe.title || "";
        titleHeading.classList.add("hidden");
        editTitleBtn.classList.add("hidden");
        titleInput.classList.remove("hidden");
        titleInput.focus();
        titleInput.setSelectionRange(titleInput.value.length, titleInput.value.length);
    }

    async function saveTitleEdit() {
        const recipe = recipeState.currentRecipe;
        if (!recipe || !titleHeading || !titleInput || !editTitleBtn) return;
        const newTitle = titleInput.value.trim();
        if (newTitle && newTitle !== recipe.title) {
            recipe.title = newTitle;
            titleHeading.textContent = newTitle;
            await saveRecipeLocally(recipe);
        }
        titleInput.classList.add("hidden");
        titleHeading.classList.remove("hidden");
        editTitleBtn.classList.remove("hidden");
    }

    editTitleBtn?.addEventListener("click", enableTitleEdit);
    titleInput?.addEventListener("blur", saveTitleEdit);
    titleInput?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") titleInput.blur();
        else if (e.key === "Escape") {
            titleInput.value = recipeState.currentRecipe?.title || "";
            titleInput.blur();
        }
    });
}

// ─── Delegated event handlers ────────────────────────────────────────────────

function wireDelegatedHandlers() {
    // Revert a substitution
    document.addEventListener("click", async (e) => {
        const revertBtn = (e.target as Element).closest(".revert-sub");
        const recipe = recipeState.currentRecipe;
        if (revertBtn && recipe) {
            const indexStr = revertBtn.getAttribute("data-index");
            if (indexStr) {
                const idx = parseInt(indexStr, 10);
                if (!isNaN(idx) && idx >= 0 && idx < recipe.ingredients.length) {
                    delete recipe.ingredients[idx].substituted;
                    await saveRecipeLocally(recipe);
                    renderIngredients(recipe, getCurrentMultiplier());
                }
            }
        }
    });

    // Remove a tag
    document.addEventListener("click", async (e) => {
        const removeBtn = (e.target as Element).closest(".remove-tag");
        const recipe = recipeState.currentRecipe;
        if (removeBtn && recipe) {
            const tagToRemove = removeBtn.getAttribute("data-tag");
            if (tagToRemove) {
                recipe.tags = (recipe.tags || []).filter((t: string) => t.toUpperCase() !== tagToRemove.toUpperCase());
                await saveRecipeLocally(recipe);
                renderTags();
            }
        }
    });

    // Add a tag on Enter
    document.addEventListener("keydown", async (e) => {
        const target = e.target as Element;
        const recipe = recipeState.currentRecipe;
        if (target?.classList.contains("tag-input") && e.key === "Enter") {
            e.preventDefault();
            const input = target as HTMLInputElement;
            const newTag = input.value.trim().toUpperCase();
            if (newTag && recipe) {
                recipe.tags = recipe.tags || [];
                if (!recipe.tags.includes(newTag)) {
                    recipe.tags.push(newTag);
                    recipe.tags.sort((a: string, b: string) => a.localeCompare(b));
                    await saveRecipeLocally(recipe);
                    renderTags();
                    setTimeout(() => {
                        const newInput = document.querySelector(".tag-input") as HTMLInputElement;
                        if (newInput) newInput.focus();
                    }, 50);
                } else {
                    input.value = "";
                }
            }
        }
    });
}

// ─── Mobile ingredient slide-over panel ──────────────────────────────────────

function wireMobileIngredientPanel() {
    // Only wire on touch/narrow screens — the media query hides the FAB on
    // desktop so this function is a no-op when the elements don't exist.
    const fab = document.getElementById("ingredients-fab");
    const panel = document.querySelector<HTMLElement>(".ingredients-section");
    const backdrop = document.getElementById("ingredients-backdrop");
    if (!fab || !panel || !backdrop) return;

    function openPanel() {
        panel!.classList.add("panel-open");
        backdrop!.classList.add("open");
        document.body.classList.add("ingredients-open"); // drives FAB slide via CSS
        document.body.style.overflow = "hidden";
    }

    function closePanel() {
        panel!.classList.remove("panel-open");
        backdrop!.classList.remove("open");
        document.body.classList.remove("ingredients-open");
        document.body.style.overflow = "";
    }

    // FAB toggles: open when closed, close when open
    fab.addEventListener("click", () => {
        if (document.body.classList.contains("ingredients-open")) {
            closePanel();
        } else {
            openPanel();
        }
    });

    // Backdrop tap also closes
    backdrop.addEventListener("click", closePanel);
}

function getCurrentMultiplier(): number {
    const batchInput = document.getElementById("batch-input") as HTMLInputElement;
    if (!batchInput) return 1;
    const mult = parseFloat(batchInput.value) / recipeState.originalBatchSize;
    return isNaN(mult) ? 1 : mult;
}

// ─── Recipe render ─────────────────────────────────────────────────────────────

function renderRecipe(recipe: any) {
    document.getElementById("loading")?.classList.add("hidden");
    const article = document.getElementById("recipe-article");
    if (!article) return;

    article.classList.remove("hidden");

    const titleEl = document.getElementById("recipe-title");
    if (titleEl) titleEl.textContent = recipe.title;

    const descEl = document.getElementById("recipe-desc");
    if (descEl && recipe.semantic_summary) descEl.textContent = recipe.semantic_summary;

    const sourceLink = document.getElementById("source-link") as HTMLAnchorElement;
    if (sourceLink && recipe.url) {
        sourceLink.href = recipe.url;
        sourceLink.classList.remove("hidden");
    }

    renderTags();

    if (isFirstRender) {
        initUnitSystem(recipe);
        isFirstRender = false;
    }

    // Parse and set the initial batch size
    const batchInput = document.getElementById("batch-input") as HTMLInputElement;
    if (batchInput) {
        recipeState.originalBatchSize = parseBatchSize(recipe.yield);
        batchInput.value = recipeState.originalBatchSize.toString();

        if (!batchInput.dataset.listenerAttached) {
            batchInput.addEventListener("input", (e) => {
                const newBatch = parseInt((e.target as HTMLInputElement).value, 10);
                if (!isNaN(newBatch) && newBatch > 0) {
                    renderIngredients(recipeState.currentRecipe, newBatch / recipeState.originalBatchSize);
                }
            });
            batchInput.dataset.listenerAttached = "true";
        }
    }

    const unitDropdown = document.getElementById("unit-system-select");
    if (unitDropdown && !unitDropdown.dataset.listenerAttached) {
        unitDropdown.addEventListener("change", (e: any) => {
            currentUnitSystem = e.detail.value === "metric" ? "metric" : "us";
            localStorage.setItem(UNIT_PREFERENCE_KEY, currentUnitSystem);
            renderIngredients(recipeState.currentRecipe, getCurrentMultiplier());
        });
        unitDropdown.dataset.listenerAttached = "true";
    }

    renderIngredients(recipe, 1);
    renderInstructions(recipe);
    renderNotes(recipe);
}

/** Detect whether the recipe is predominantly metric or US and set the dropdown accordingly. */
function initUnitSystem(recipe: any) {
    const unitLabel = document.getElementById("unit-system-select-label");

    const updateActiveDropdownItem = (val: string) => {
        const menu = document.getElementById("unit-system-select-menu");
        if (menu) {
            menu.querySelectorAll(".dropdown-item").forEach((i) => {
                i.classList.toggle("active", i.getAttribute("data-value") === val);
            });
        }
    };

    const applyUnitSystem = (unit: "us" | "metric") => {
        currentUnitSystem = unit;
        if (unitLabel) unitLabel.textContent = unit === "metric" ? "Metric (Grams)" : "US (Volume)";
        updateActiveDropdownItem(unit);
    };

    const preferredUnit = localStorage.getItem(UNIT_PREFERENCE_KEY);
    if (preferredUnit === "us" || preferredUnit === "metric") {
        applyUnitSystem(preferredUnit);
        return;
    }

    let metricCount = 0;
    let usCount = 0;

    if (recipe.ingredients) {
        recipe.ingredients.forEach((ing: any) => {
            const u = (ing.unit || "").toLowerCase();
            if (["g", "gram", "grams", "ml", "milliliter", "milliliters"].includes(u)) metricCount++;
            else if (["cup", "cups", "tbsp", "tsp", "ounce", "oz", "fl oz"].includes(u)) usCount++;
        });
    }

    if (metricCount > usCount) {
        applyUnitSystem("metric");
    } else {
        applyUnitSystem("us");
    }
}

// ─── Tags ─────────────────────────────────────────────────────────────────────

function renderTags() {
    const metaEl = document.getElementById("recipe-meta");
    const recipe = recipeState.currentRecipe;
    if (!metaEl || !recipe) return;

    const safeIcon = (name: string, opts: Record<string, any> = { width: 14, height: 14 }) =>
        (feather.icons[name] as any)?.toSvg(opts) || "";

    const displayTime =
        recipe.totalTimeMinutes ||
        (recipe.prepTimeMinutes || 0) + (recipe.cookTimeMinutes || 0) ||
        null;

    const metaItems = [
        displayTime
            ? `<span class="meta-item">${safeIcon("clock")} ${formatTime(displayTime)}</span>`
            : null,
        recipe.servings
            ? `<span class="meta-item">${safeIcon("users")} ${recipe.servings} servings</span>`
            : null,
        recipe.yield
            ? `<span class="meta-item">${safeIcon("package")} ${recipe.yield}</span>`
            : null,
    ].filter(Boolean);

    let domain = "";
    if (recipe.url) {
        try {
            domain = new URL(recipe.url).hostname.replace(/^www\./, '').toUpperCase();
        } catch (e) { }
    }

    const tagsHtml: string[] = [];
    if (domain) {
        tagsHtml.push(`<span class="tag domain-tag" title="Domain source">${safeIcon("link", { width: 10, height: 10, style: "margin-right: 4px; vertical-align: -1px;" })}${escapeHtml(domain)}</span>`);
    }

    (recipe.tags || []).forEach((t: string) => {
        if (t !== domain) {
            tagsHtml.push(`<span class="tag">${escapeHtml(t)} <button class="remove-tag" data-tag="${escapeHtml(t)}" title="Remove tag">&times;</button></span>`);
        }
    });
    tagsHtml.push(`<input type="text" class="tag-input" placeholder="+ Add tag" />`);

    metaEl.innerHTML = `
        <div class="meta-info">${metaItems.join(" &nbsp;·&nbsp; ")}</div>
        <div class="tags">${tagsHtml.join("")}</div>
    `;
}

// ─── Ingredients ──────────────────────────────────────────────────────────────

function parseBatchSize(yieldStr?: string): number {
    if (!yieldStr) return 1;
    const match = yieldStr.match(/\d+/);
    return match ? parseInt(match[0], 10) : 1;
}

function formatQuantity(q: number): string {
    return (Math.round(q * 100) / 100).toString();
}

export function renderIngredients(recipe: any, multiplier: number) {
    const ingredientsList = document.getElementById("ingredients-list");
    if (!ingredientsList || !recipe?.ingredients) return;

    ingredientsList.innerHTML = "";
    let currentGroup = "";

    recipe.ingredients.forEach((ing: any, idx: number) => {
        const actualGroup = ing.group ? ing.group.trim() : "";
        if (actualGroup !== currentGroup && actualGroup !== "") {
            const groupHeader = document.createElement("h3");
            groupHeader.className = "ingredient-group-header";
            groupHeader.textContent = actualGroup;
            ingredientsList.appendChild(groupHeader);
            currentGroup = actualGroup;
        }

        const li = document.createElement("li");
        let text = "";

        let resolvedAmount: number | null = null;
        let resolvedUnit: string | null = null;
        let amountWasConverted = false;

        if (currentUnitSystem === "metric") {
            if (ing.metric_amount !== null && ing.metric_amount !== undefined) {
                resolvedAmount = ing.metric_amount;
                resolvedUnit = ing.metric_unit;
            } else if (ing.us_amount !== null && ing.us_amount !== undefined) {
                const conversion = convertVolumeToWeight(ing.item, ing.us_amount, ing.us_unit);
                if (conversion) {
                    resolvedAmount = conversion.quantity as number;
                    resolvedUnit = conversion.unit;
                    amountWasConverted = true;
                } else {
                    resolvedAmount = ing.us_amount;
                    resolvedUnit = ing.us_unit;
                }
            }
        } else {
            if (ing.us_amount !== null && ing.us_amount !== undefined) {
                resolvedAmount = ing.us_amount;
                resolvedUnit = ing.us_unit;
            } else if (ing.metric_amount !== null && ing.metric_amount !== undefined) {
                resolvedAmount = ing.metric_amount;
                resolvedUnit = ing.metric_unit;
            }
        }

        if (resolvedAmount !== null && resolvedAmount !== undefined) {
            const scaled = resolvedAmount * multiplier;
            let displayQuantity: string | number = scaled;
            let displayUnit = resolvedUnit;

            if (!amountWasConverted && currentUnitSystem === "us") {
                const formatted = formatUSVolume(scaled, displayUnit);
                displayQuantity = formatted.displayQuantity;
                displayUnit = formatted.displayUnit;
            } else if (amountWasConverted || currentUnitSystem === "metric") {
                displayQuantity = formatQuantity(scaled);
            }

            text = `${displayQuantity}`;
            if (displayUnit) text += ` ${displayUnit}`;
            if (ing.item) text += ` ${ing.item}`;
            if (ing.preparation) text += `, ${ing.preparation}`;
        } else {
            text = ing.rawText || ing.item;
        }

        // Note references as superscripts
        if (ing.note_references?.length > 0) {
            const refs = ing.note_references
                .map(
                    (n: number) =>
                        `<a href="#recipe-note-${n}" style="color: var(--color-accent); text-decoration: none; font-size: 0.8em;">Note ${n}</a>`
                )
                .join(", ");
            text += ` <sup>${refs}</sup>`;
        }

        if (ing.substituted && typeof ing.substituted === "object") {
            const sub = ing.substituted;
            let subText = "";

            if (sub.quantity !== null && sub.quantity !== undefined) {
                const subScaled = sub.quantity * multiplier;
                let subDispQuantity: number | string = subScaled;
                let subDispUnit = sub.unit;

                if (currentUnitSystem === "metric" && subDispUnit) {
                    const conversion = convertVolumeToWeight(sub.item, subScaled, subDispUnit);
                    if (conversion) {
                        subDispQuantity = formatQuantity(conversion.quantity as number);
                        subDispUnit = conversion.unit;
                    } else {
                        const formatted = formatUSVolume(subScaled, subDispUnit);
                        subDispQuantity = formatted.displayQuantity;
                        subDispUnit = formatted.displayUnit;
                    }
                } else {
                    const formatted = formatUSVolume(subScaled, subDispUnit);
                    subDispQuantity = formatted.displayQuantity;
                    subDispUnit = formatted.displayUnit;
                }

                subText = `${subDispQuantity}`;
                if (subDispUnit) subText += ` ${subDispUnit}`;
                if (sub.item) subText += ` ${sub.item}`;
                if (sub.preparation) subText += `, ${sub.preparation}`;
            } else {
                subText = sub.rawText || sub.item;
            }

            li.innerHTML = `<span style="text-decoration: line-through; opacity: 0.6; margin-right: 8px;">${text}</span>
                            <span>${subText}</span>
                            <button class="revert-sub btn icon-btn" data-index="${idx}" title="Remove substitution" style="margin-left: 8px; font-size: 0.8em; padding: 2px 5px;">&times;</button>`;
        } else if (typeof ing.substituted === "string") {
            li.innerHTML = `<span style="text-decoration: line-through; opacity: 0.6; margin-right: 8px;">${text}</span>
                            <span>${ing.substituted}</span>
                            <button class="revert-sub btn icon-btn" data-index="${idx}" title="Remove substitution" style="margin-left: 8px; font-size: 0.8em; padding: 2px 5px;">&times;</button>`;
        } else {
            if (ing.subtext) {
                li.innerHTML = `<span class="ing-text">${text}</span><span class="ing-note">${ing.subtext}</span>`;
            } else {
                li.innerHTML = text;
            }
        }

        ingredientsList.appendChild(li);
    });
}

// ─── Instructions ──────────────────────────────────────────────────────────────

function renderInstructions(recipe: any) {
    const instructionsList = document.getElementById("instructions-list");
    if (!instructionsList || !recipe.instructions) return;

    let currentInstGroup = "";
    recipe.instructions.forEach((inst: any) => {
        const actualGroup = inst.group ? inst.group.trim() : "";
        if (actualGroup !== currentInstGroup && actualGroup !== "") {
            const groupHeader = document.createElement("h3");
            groupHeader.className = "instruction-group-header";
            groupHeader.textContent = actualGroup;
            instructionsList.appendChild(groupHeader);
            currentInstGroup = actualGroup;
        }

        const div = document.createElement("div");
        div.className = "instruction-step";
        div.innerHTML = `
            <span class="step-num">${inst.stepNumber}</span>
            <p>${inst.text}</p>
        `;
        instructionsList.appendChild(div);
    });
}

// ─── Notes ────────────────────────────────────────────────────────────────────

function renderNotes(recipe: any) {
    const notesSection = document.getElementById("recipe-notes-section");
    const notesList = document.getElementById("recipe-notes-list");
    if (!notesSection || !notesList) return;

    notesList.innerHTML = "";
    if (recipe.notes?.length > 0) {
        recipe.notes.forEach((noteText: string, idx: number) => {
            const li = document.createElement("li");
            li.id = `recipe-note-${idx + 1}`;
            li.textContent = noteText;
            li.style.marginBottom = "8px";
            notesList.appendChild(li);
        });
        notesSection.style.display = "block";
    } else {
        notesSection.style.display = "none";
    }
}
