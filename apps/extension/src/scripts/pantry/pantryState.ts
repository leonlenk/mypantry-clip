/**
 * Shared mutable state and constants for the pantry page.
 * All pantry modules import from here to avoid duplicating state.
 */

import { LS } from "../../utils/storage";

// Re-export for pantry sub-modules that already import these names from here.
export const VIEW_MODE_KEY = LS.pantryViewMode;
export const UNIT_PREFERENCE_KEY = LS.preferredUnitSystem;

function loadTagFilters(): string[] {
    try {
        const stored = localStorage.getItem(LS.pantryTagFilters);
        if (stored) return JSON.parse(stored);
        const oldSingle = localStorage.getItem(LS.pantryTagFilter);
        if (oldSingle) return [oldSingle.toUpperCase()];
    } catch { /* ignore */ }
    return [];
}

export const pantryState = {
    currentFilter: localStorage.getItem(LS.pantryFilter) || "all",
    currentViewMode: localStorage.getItem(LS.pantryViewMode) || "large",
    skipNextViewTransition: false,
    currentTagFilters: loadTagFilters(),
    allKnownTags: new Set<string>(),
    activeExtractions: {} as Record<string, { status: string; title: string }>,
    isSelectionMode: false,
    selectedRecipeIds: new Set<string>(),
    visibleRecipeOrder: [] as string[],
    lastSelectedRecipeId: null as string | null,
    isBulkTagEditorOpen: false,
    bulkPendingTags: [] as string[],
    bulkTagSuggestions: [] as string[],
    bulkTagSuggestionIndex: -1,
    currentSuggestions: [] as string[],
    selectedSuggestionIndex: -1,
};

export function normalizeTagInput(value: string): string {
    return value.trim().toUpperCase();
}
