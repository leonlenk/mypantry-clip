/**
 * Ingredient list renderer with unit system switching and batch scaling.
 *
 * renderIngredients() is exported and consumed by both recipeController
 * (initial render + batch-size changes) and substitutionController
 * (re-render after applying a substitution).
 */

import { convertVolumeToWeight, formatUSVolume, escapeHtml } from "../../utils/conversions";
import { recipeState } from "./recipeState";

function formatQuantity(q: number): string {
    return (Math.round(q * 100) / 100).toString();
}

export function parseBatchSize(yieldStr?: string): number {
    if (!yieldStr) return 1;
    const match = yieldStr.match(/\d+/);
    return match ? parseInt(match[0], 10) : 1;
}

export function getCurrentMultiplier(): number {
    const batchInput = document.getElementById("batch-input") as HTMLInputElement;
    if (!batchInput) return 1;
    const mult = parseFloat(batchInput.value) / recipeState.originalBatchSize;
    return isNaN(mult) ? 1 : mult;
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

        if (recipeState.currentUnitSystem === "metric") {
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

            if (!amountWasConverted && recipeState.currentUnitSystem === "us") {
                const formatted = formatUSVolume(scaled, displayUnit);
                displayQuantity = formatted.displayQuantity;
                displayUnit = formatted.displayUnit;
            } else if (amountWasConverted || recipeState.currentUnitSystem === "metric") {
                displayQuantity = formatQuantity(scaled);
            }

            text = `${displayQuantity}`;
            if (displayUnit) text += ` ${escapeHtml(displayUnit)}`;
            if (ing.item) text += ` ${escapeHtml(ing.item)}`;
            if (ing.preparation) text += `, ${escapeHtml(ing.preparation)}`;
        } else {
            text = escapeHtml(ing.rawText || ing.item);
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

                if (recipeState.currentUnitSystem === "metric" && subDispUnit) {
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
                if (subDispUnit) subText += ` ${escapeHtml(subDispUnit)}`;
                if (sub.item) subText += ` ${escapeHtml(sub.item)}`;
                if (sub.preparation) subText += `, ${escapeHtml(sub.preparation)}`;
            } else {
                subText = escapeHtml(sub.rawText || sub.item);
            }

            li.innerHTML = `<span style="text-decoration: line-through; opacity: 0.6; margin-right: 8px;">${text}</span>
                            <span>${subText}</span>
                            <button class="revert-sub btn icon-btn" data-index="${idx}" title="Remove substitution" style="margin-left: 8px; font-size: 0.8em; padding: 2px 5px;">&times;</button>`;
        } else if (typeof ing.substituted === "string") {
            li.innerHTML = `<span style="text-decoration: line-through; opacity: 0.6; margin-right: 8px;">${text}</span>
                            <span>${escapeHtml(ing.substituted)}</span>
                            <button class="revert-sub btn icon-btn" data-index="${idx}" title="Remove substitution" style="margin-left: 8px; font-size: 0.8em; padding: 2px 5px;">&times;</button>`;
        } else {
            if (ing.subtext) {
                li.innerHTML = `<span class="ing-text">${text}</span><span class="ing-note">${escapeHtml(ing.subtext)}</span>`;
            } else {
                li.innerHTML = text;
            }
        }

        ingredientsList.appendChild(li);
    });
}
