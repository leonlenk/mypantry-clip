/**
 * Tests for src/types/recipe.ts — Recipe interface shape validation.
 *
 * TypeScript interfaces are erased at runtime, so these tests verify
 * that sample objects conform to the expected shape by checking
 * property existence and types — a lightweight runtime contract test.
 */

import { describe, it, expect } from "vitest";
import type {
    Recipe,
    Ingredient,
    InstructionStep,
} from "../../apps/extension/src/types/recipe";

// ---------------------------------------------------------------------------
// Helper: checks that an object satisfies the Recipe shape at runtime
// ---------------------------------------------------------------------------

function isValidRecipe(obj: Record<string, unknown>): boolean {
    return (
        typeof obj.id === "string" &&
        typeof obj.url === "string" &&
        typeof obj.title === "string" &&
        typeof obj.description === "string" &&
        (obj.servings === null || typeof obj.servings === "number") &&
        Array.isArray(obj.ingredients) &&
        Array.isArray(obj.instructions)
    );
}

function isValidIngredient(obj: Record<string, unknown>): boolean {
    return (
        typeof obj.rawText === "string" &&
        typeof obj.item === "string" &&
        (obj.us_amount === null || typeof obj.us_amount === "number") &&
        (obj.us_unit === null || typeof obj.us_unit === "string") &&
        (obj.metric_amount === null || typeof obj.metric_amount === "number") &&
        (obj.metric_unit === null || typeof obj.metric_unit === "string")
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Recipe type shape", () => {
    it("a full Recipe object passes validation", () => {
        const recipe: Recipe = {
            id: "classic-pancakes-abc123",
            url: "https://example.com/pancakes",
            title: "Classic Pancakes",
            description: "Fluffy buttermilk pancakes",
            author: "Chef Pat",
            image: "https://example.com/pancakes.jpg",
            isFavorite: true,
            createdAt: Date.now(),
            prepTimeMinutes: 10,
            cookTimeMinutes: 15,
            totalTimeMinutes: 25,
            servings: 4,
            yield: "12 pancakes",
            ingredients: [
                {
                    rawText: "1 1/2 cups all-purpose flour, sifted",
                    us_amount: 1.5,
                    us_unit: "cups",
                    metric_amount: 190,
                    metric_unit: "g",
                    item: "all-purpose flour",
                    preparation: "sifted",
                    subtext: undefined,
                    note_references: [1],
                    group: "Dry Ingredients",
                },
            ],
            instructions: [
                { stepNumber: 1, text: "Mix dry ingredients.", group: "Batter" },
                { stepNumber: 2, text: "Add wet ingredients." },
            ],
            notes: ["Sifting gives a lighter texture"],
            tags: ["breakfast", "quick"],
            nutrition: {
                calories: 350,
                protein: "8g",
                fat: "12g",
                carbohydrates: "52g",
            },
            embedding: [0.1, 0.2, 0.3],
        };

        expect(isValidRecipe(recipe as unknown as Record<string, unknown>)).toBe(true);
    });

    it("a minimal Recipe (required fields only) passes validation", () => {
        const recipe: Recipe = {
            id: "min-recipe",
            url: "https://example.com/min",
            title: "Minimal",
            description: "",
            servings: null,
            ingredients: [],
            instructions: [],
        };

        expect(isValidRecipe(recipe as unknown as Record<string, unknown>)).toBe(true);
    });

    it("ingredient with all optional fields is valid", () => {
        const ingredient: Ingredient = {
            rawText: "2 tablespoons unsalted butter, melted",
            us_amount: 2,
            us_unit: "tablespoons",
            metric_amount: 28,
            metric_unit: "g",
            item: "unsalted butter",
            preparation: "melted",
            subtext: "or margarine",
            note_references: [1, 2],
            group: "Wet Ingredients",
            substituted: {
                quantity: 2,
                unit: "tablespoons",
                item: "coconut oil",
                preparation: "melted",
                rawText: "2 tablespoons coconut oil, melted",
            },
        };

        expect(isValidIngredient(ingredient as unknown as Record<string, unknown>)).toBe(true);
    });

    it("ingredient with null amounts is valid", () => {
        const ingredient: Ingredient = {
            rawText: "salt to taste",
            us_amount: null,
            us_unit: null,
            metric_amount: null,
            metric_unit: null,
            item: "salt",
        };

        expect(isValidIngredient(ingredient as unknown as Record<string, unknown>)).toBe(true);
    });

    it("InstructionStep with group field is valid", () => {
        const step: InstructionStep = {
            stepNumber: 1,
            text: "Preheat oven to 350°F.",
            group: "Preparation",
        };

        expect(typeof step.stepNumber).toBe("number");
        expect(typeof step.text).toBe("string");
        expect(step.group).toBe("Preparation");
    });
});
