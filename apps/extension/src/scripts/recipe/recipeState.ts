/**
 * Shared mutable state for the recipe page.
 *
 * Using an object reference rather than a bare `let` export so that all
 * recipe sub-modules always read the same live values regardless of
 * ES-module import ordering.
 */
import { LS } from "../../utils/storage";

// Re-export so recipeRenderer doesn't need to change its import path.
export const UNIT_PREFERENCE_KEY = LS.preferredUnitSystem;

export const recipeState = {
    currentRecipe: null as any,
    originalBatchSize: 1,
    currentUnitSystem: "us" as "us" | "metric",
};
