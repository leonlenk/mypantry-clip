/**
 * Recipe edit page controller.
 *
 * Responsibilities:
 *  - Parse ?id= URL param, load recipe from DB
 *  - Populate edit form fields (details, ingredients, instructions, notes)
 *  - Handle add/remove rows for list fields
 *  - Save updated recipe to IndexedDB and redirect back to recipe view
 */

import { getRecipe, saveRecipeLocally } from "../../utils/db";

// ─── Unit datalists (injected once into the document) ─────────────────────────

const US_UNITS = [
    "cup", "cups", "tbsp", "tsp", "fl oz", "oz", "lb", "lbs",
    "pt", "qt", "gal", "ml", "l", "pinch", "dash",
    "piece", "clove", "slice", "can", "bunch", "sprig", "head",
];

const METRIC_UNITS = [
    "g", "kg", "mg", "ml", "l", "cl", "dl",
    "piece", "clove", "slice",
];

function injectUnitDataLists() {
    if (document.getElementById("us-units-list")) return;
    const make = (id: string, units: string[]) => {
        const dl = document.createElement("datalist");
        dl.id = id;
        units.forEach(u => {
            const opt = document.createElement("option");
            opt.value = u;
            dl.appendChild(opt);
        });
        document.body.appendChild(dl);
    };
    make("us-units-list", US_UNITS);
    make("metric-units-list", METRIC_UNITS);
}

document.addEventListener("DOMContentLoaded", async () => {
    injectUnitDataLists();
    const urlParams = new URLSearchParams(window.location.search);
    const recipeId = urlParams.get("id");
    const isNew = !recipeId;

    document.getElementById("cancel-edit-btn")?.addEventListener("click", () => {
        window.location.href = recipeId
            ? `recipe.html?id=${recipeId}`
            : "pantry.html";
    });

    let recipe: any;

    if (isNew) {
        // Blank recipe for manual creation
        recipe = {
            id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            url: `manual://created-by-user`,
            title: "",
            servings: null,
            ingredients: [],
            instructions: [],
            notes: [],
            createdAt: Date.now(),
        };
        const saveBtn = document.getElementById("save-edit-btn") as HTMLButtonElement;
        if (saveBtn) saveBtn.textContent = "Create Recipe";
    } else {
        try {
            recipe = await getRecipe(recipeId!);
            if (!recipe) {
                showError();
                return;
            }
        } catch (e) {
            console.error(e);
            showError();
            return;
        }
    }

    populateForm(recipe);

    document.getElementById("save-edit-btn")?.addEventListener("click", async () => {
        const btn = document.getElementById("save-edit-btn") as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = "Saving…";
        try {
            const saved = await saveForm(recipe);
            if (isNew) {
                // Generate embedding for the new recipe before navigating
                try {
                    const embeddingText = [
                        saved.title,
                        saved.semantic_summary,
                        ...(saved.ingredients?.map((i: any) => i.item) || []),
                    ].filter(Boolean).join(". ");
                    if (embeddingText) {
                        const result: { success: boolean; embedding?: number[] } =
                            await chrome.runtime.sendMessage({ type: "generate-embedding", text: embeddingText });
                        if (result?.success && result.embedding) {
                            await saveRecipeLocally({ ...saved, embedding: result.embedding });
                        }
                    }
                } catch {
                    // Embedding is optional — proceed without it
                }
            }
            window.location.href = `recipe.html?id=${recipe.id}`;
        } catch (e) {
            console.error(e);
            btn.disabled = false;
            btn.textContent = isNew ? "Create Recipe" : "Save Changes";
        }
    });
});

// ─── Error state ──────────────────────────────────────────────────────────────

function showError() {
    document.getElementById("edit-loading")?.classList.add("hidden");
    document.getElementById("edit-error")?.classList.remove("hidden");
}

// ─── Populate form ────────────────────────────────────────────────────────────

function populateForm(recipe: any) {
    document.getElementById("edit-loading")?.classList.add("hidden");
    document.getElementById("edit-form")?.classList.remove("hidden");

    // Meta fields
    const titleInput = document.getElementById("edit-title") as HTMLInputElement;
    const prepInput = document.getElementById("edit-prep-time") as HTMLInputElement;
    const cookInput = document.getElementById("edit-cook-time") as HTMLInputElement;
    const servingsInput = document.getElementById("edit-servings") as HTMLInputElement;
    const yieldInput = document.getElementById("edit-yield") as HTMLInputElement;

    if (titleInput) titleInput.value = recipe.title || "";
    if (prepInput && recipe.prepTimeMinutes != null) prepInput.value = String(recipe.prepTimeMinutes);
    if (cookInput && recipe.cookTimeMinutes != null) cookInput.value = String(recipe.cookTimeMinutes);
    if (servingsInput && recipe.servings != null) servingsInput.value = String(recipe.servings);
    if (yieldInput && recipe.yield) yieldInput.value = recipe.yield;

    // Ingredients
    const ingredientsList = document.getElementById("edit-ingredients-list");
    if (ingredientsList) {
        (recipe.ingredients || []).forEach((ing: any) => {
            ingredientsList.appendChild(createIngredientGridRow(ing));
        });
        document.getElementById("add-ingredient-btn")?.addEventListener("click", () => {
            const row = createIngredientGridRow({});
            ingredientsList.appendChild(row);
            (row.querySelector(".ing-item") as HTMLInputElement)?.focus();
        });
    }

    // Instructions
    const instructionsList = document.getElementById("edit-instructions-list");
    if (instructionsList) {
        (recipe.instructions || []).forEach((inst: any) => {
            instructionsList.appendChild(createTextareaRow(inst.text || ""));
        });
        document.getElementById("add-instruction-btn")?.addEventListener("click", () => {
            const row = createTextareaRow("");
            instructionsList.appendChild(row);
            row.querySelector("textarea")?.focus();
        });
    }

    // Notes
    const notesList = document.getElementById("edit-notes-list");
    if (notesList) {
        (recipe.notes || []).forEach((note: string) => {
            notesList.appendChild(createTextareaRow(note));
        });
        document.getElementById("add-note-btn")?.addEventListener("click", () => {
            const row = createTextareaRow("");
            notesList.appendChild(row);
            row.querySelector("textarea")?.focus();
        });
    }
}

// ─── Row builders ─────────────────────────────────────────────────────────────

function col(label: string, ...inputs: HTMLElement[]): HTMLElement {
    const div = document.createElement("div");
    div.className = "ing-col";
    const lbl = document.createElement("span");
    lbl.className = "ing-col-label";
    lbl.textContent = label;
    div.appendChild(lbl);
    inputs.forEach(i => div.appendChild(i));
    return div;
}

function numInput(cls: string, val: number | null, placeholder: string): HTMLInputElement {
    const el = document.createElement("input");
    el.type = "number";
    el.className = cls;
    el.placeholder = placeholder;
    el.min = "0";
    el.step = "any";
    if (val != null) el.value = String(val);
    return el;
}

function textInput(cls: string, val: string | undefined, placeholder: string): HTMLInputElement {
    const el = document.createElement("input");
    el.type = "text";
    el.className = cls;
    el.placeholder = placeholder;
    el.value = val || "";
    return el;
}

function unitInputWrap(cls: string, val: string | undefined, listId: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ing-unit-wrap";

    const input = textInput(cls, val, "unit");
    input.setAttribute("list", listId);
    input.setAttribute("autocomplete", "off");

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "ing-unit-clear";
    clearBtn.innerHTML = "&times;";
    clearBtn.title = "Clear unit";
    // Only show clear button when there's a value
    clearBtn.style.display = val ? "flex" : "none";
    input.addEventListener("input", () => {
        clearBtn.style.display = input.value ? "flex" : "none";
    });
    clearBtn.addEventListener("click", () => {
        input.value = "";
        clearBtn.style.display = "none";
        input.focus();
    });

    wrap.appendChild(input);
    wrap.appendChild(clearBtn);
    return wrap;
}

function createIngredientGridRow(ing: any): HTMLElement {
    const row = document.createElement("div");
    row.className = "ing-grid-row";
    if (ing.group) row.dataset.group = ing.group;

    // US column
    const usAmt = numInput("ing-us-amount", ing.us_amount, "qty");
    const usUnitWrap = unitInputWrap("ing-us-unit", ing.us_unit ?? undefined, "us-units-list");
    const usPair = document.createElement("div");
    usPair.className = "ing-pair";
    usPair.appendChild(usAmt);
    usPair.appendChild(usUnitWrap);
    row.appendChild(col("US", usPair));

    // Metric column
    const mAmt = numInput("ing-metric-amount", ing.metric_amount, "qty");
    const mUnitWrap = unitInputWrap("ing-metric-unit", ing.metric_unit ?? undefined, "metric-units-list");
    const mPair = document.createElement("div");
    mPair.className = "ing-pair";
    mPair.appendChild(mAmt);
    mPair.appendChild(mUnitWrap);
    row.appendChild(col("Metric", mPair));

    // Details column (item + preparation stacked)
    const item = textInput("ing-item", ing.item, "ingredient name");
    const prep = textInput("ing-prep", ing.preparation, "preparation (optional)");
    prep.className += " ing-prep-input";
    row.appendChild(col("Ingredient", item, prep));

    // Note # column
    const noteVal = (ing.note_references || []).join(", ");
    const noteInput = textInput("ing-notes", noteVal, "1, 2, 3");
    row.appendChild(col("Note #", noteInput));

    // Remove button
    const removeCell = document.createElement("div");
    removeCell.className = "ing-remove-cell";
    removeCell.appendChild(createRemoveBtn(() => row.remove()));
    row.appendChild(removeCell);

    return row;
}

function readIngredientRow(row: Element): any {
    const usAmt = (row.querySelector(".ing-us-amount") as HTMLInputElement)?.value;
    const usUnit = (row.querySelector(".ing-us-unit") as HTMLInputElement)?.value.trim();
    const mAmt = (row.querySelector(".ing-metric-amount") as HTMLInputElement)?.value;
    const mUnit = (row.querySelector(".ing-metric-unit") as HTMLInputElement)?.value.trim();
    const item = (row.querySelector(".ing-item") as HTMLInputElement)?.value.trim();
    const prep = (row.querySelector(".ing-prep") as HTMLInputElement)?.value.trim();
    const noteStr = (row.querySelector(".ing-notes") as HTMLInputElement)?.value.trim();

    if (!item) return null;

    const noteRefs = noteStr
        ? noteStr.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0)
        : [];

    // Reconstruct rawText from structured fields
    let rawText = "";
    if (usAmt) rawText = `${usAmt}${usUnit ? " " + usUnit : ""}`;
    rawText = (rawText ? rawText + " " : "") + item;
    if (prep) rawText += `, ${prep}`;

    const result: any = {
        rawText,
        item,
        us_amount: usAmt !== "" ? (parseFloat(usAmt) || null) : null,
        us_unit: usUnit || null,
        metric_amount: mAmt !== "" ? (parseFloat(mAmt) || null) : null,
        metric_unit: mUnit || null,
    };
    if (prep) result.preparation = prep;
    if (noteRefs.length > 0) result.note_references = noteRefs;
    const group = (row as HTMLElement).dataset.group;
    if (group) result.group = group;
    return result;
}

function createTextareaRow(value: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "edit-row";

    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.rows = 2;
    // Auto-grow
    textarea.addEventListener("input", () => {
        textarea.style.height = "auto";
        textarea.style.height = `${textarea.scrollHeight}px`;
    });
    // Set initial height after insert
    requestAnimationFrame(() => {
        textarea.style.height = `${textarea.scrollHeight}px`;
    });

    const removeBtn = createRemoveBtn(() => row.remove());

    row.appendChild(textarea);
    row.appendChild(removeBtn);
    return row;
}

function createRemoveBtn(onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn icon-btn edit-remove-btn";
    btn.innerHTML = "&times;";
    btn.title = "Remove";
    btn.addEventListener("click", onClick);
    return btn;
}

// ─── Save form ────────────────────────────────────────────────────────────────

async function saveForm(originalRecipe: any): Promise<any> {
    const recipe = { ...originalRecipe };

    // Meta fields
    const titleVal = (document.getElementById("edit-title") as HTMLInputElement)?.value.trim();
    const prepVal = (document.getElementById("edit-prep-time") as HTMLInputElement)?.value;
    const cookVal = (document.getElementById("edit-cook-time") as HTMLInputElement)?.value;
    const servingsVal = (document.getElementById("edit-servings") as HTMLInputElement)?.value;
    const yieldVal = (document.getElementById("edit-yield") as HTMLInputElement)?.value;

    if (titleVal) recipe.title = titleVal;
    recipe.prepTimeMinutes = prepVal !== "" ? parseInt(prepVal, 10) || null : null;
    recipe.cookTimeMinutes = cookVal !== "" ? parseInt(cookVal, 10) || null : null;
    recipe.servings = servingsVal !== "" ? parseInt(servingsVal, 10) || null : null;
    recipe.yield = yieldVal.trim() || undefined;

    // Recalculate total time
    const prep = recipe.prepTimeMinutes || 0;
    const cook = recipe.cookTimeMinutes || 0;
    recipe.totalTimeMinutes = (prep + cook) || null;

    // Ingredients
    recipe.ingredients = Array.from(
        document.querySelectorAll("#edit-ingredients-list .ing-grid-row")
    )
        .map(row => readIngredientRow(row))
        .filter(Boolean);

    // Instructions
    const originalInstructions: any[] = originalRecipe.instructions || [];
    const instructionTextareas = document.querySelectorAll<HTMLTextAreaElement>(
        "#edit-instructions-list .edit-row textarea"
    );
    recipe.instructions = Array.from(instructionTextareas)
        .map((textarea, idx) => {
            const newText = textarea.value.trim();
            if (!newText) return null;
            const orig = originalInstructions[idx];
            return orig
                ? { ...orig, text: newText }
                : { stepNumber: idx + 1, text: newText };
        })
        .filter(Boolean)
        .map((inst: any, idx: number) => ({ ...inst, stepNumber: idx + 1 }));

    // Notes
    const noteTextareas = document.querySelectorAll<HTMLTextAreaElement>(
        "#edit-notes-list .edit-row textarea"
    );
    recipe.notes = Array.from(noteTextareas)
        .map((t) => t.value.trim())
        .filter(Boolean);

    await saveRecipeLocally(recipe);
    return recipe;
}
