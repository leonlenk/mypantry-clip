/**
 * Pantry page controller — startup and top-level wiring.
 *
 * This module is the entry point imported by pantry.astro's <script> block.
 * It handles the initial cloud-sync check, filter/view-mode toggles, and
 * delegates all other concerns to focused sub-modules.
 *
 * Sub-modules:
 *  - pantryState      shared mutable state
 *  - tagFilter        extractTags + renderSearchBadges
 *  - tagPopover       overflow tag popover
 *  - modals           toast + confirmation/result overlays
 *  - bulkTagEditor    bulk tag chip + suggestion UI
 *  - selectionManager selection mode + bulk actions
 *  - recipeRenderer   loadRecipes + renderRecipes + wireCardEvents
 *  - searchManager    handleSearch + wireSearchHandlers
 *  - extractionManager extraction placeholder lifecycle
 *  - importExport     backup import/export
 */

import { pantryState, VIEW_MODE_KEY, UNIT_PREFERENCE_KEY } from "./pantryState";
import { getLocal, LS } from "../../utils/storage";
import { MSG } from "../../utils/messages";
import { loadRecipes } from "./recipeRenderer";
import { wireSearchHandlers } from "./searchManager";
import { wireSelectionControls } from "./selectionManager";
import { wireCancelExtractionHandler, wireExtractionListener } from "./extractionManager";
import { wireImportExport } from "./importExport";
import { closeTagPopover } from "./tagPopover";

declare const chrome: any;

document.addEventListener("DOMContentLoaded", async () => {
    // ── Setup guard ────────────────────────────────────────────────────────────
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
        const { setupComplete, llmProvider } = await getLocal(["setupComplete", "llmProvider"]);

        if (!setupComplete) {
            window.location.href = "setup.html";
            return;
        }

        // Silent background sync when cloud is ahead of local
        if (llmProvider === "google") {
            (async () => {
                try {
                    const stored = await getLocal(["lastSyncAt"]);
                    const lastSyncAt = stored.lastSyncAt;

                    const latestRes: { success: boolean; latest_updated_at: string | null } =
                        await chrome.runtime.sendMessage({ type: MSG.getCloudLatest });

                    if (!latestRes.success || !latestRes.latest_updated_at) return;

                    const cloudIsAhead = !lastSyncAt || latestRes.latest_updated_at > lastSyncAt;
                    if (!cloudIsAhead) return;

                    console.log("[Pantry] Cloud is ahead of local — fetching delta...");

                    const syncRes: { success: boolean; merged: number } =
                        await chrome.runtime.sendMessage({ type: MSG.syncFromCloud, since: lastSyncAt });

                    if (syncRes.success && syncRes.merged > 0) {
                        console.log(`[Pantry] Silently merged ${syncRes.merged} new recipe(s) from cloud.`);
                        await loadRecipes();
                    }
                } catch (err) {
                    console.warn("[Pantry] Dashboard-open sync check failed (non-fatal):", err);
                }
            })();
        }
    }

    // ── Filter links ───────────────────────────────────────────────────────────
    const filterLinks = document.querySelectorAll(".filter-btn");
    if (filterLinks.length > 0) {
        filterLinks.forEach((l) => l.classList.remove("active"));
        const activeLink =
            Array.from(filterLinks).find(
                (l) => (l as HTMLElement).dataset.filter === pantryState.currentFilter
            ) || filterLinks[0];
        activeLink.classList.add("active");
    }

    filterLinks.forEach((link) => {
        link.addEventListener("click", async (e) => {
            e.preventDefault();
            filterLinks.forEach((l) => l.classList.remove("active"));
            (e.currentTarget as HTMLElement).classList.add("active");
            pantryState.currentFilter = (e.currentTarget as HTMLElement).dataset.filter || "all";
            localStorage.setItem(LS.pantryFilter, pantryState.currentFilter);
            await loadRecipes();
        });
    });

    // ── View mode toggle ───────────────────────────────────────────────────────
    applyViewMode();
    document.querySelectorAll<HTMLElement>(".view-mode-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            pantryState.currentViewMode = btn.dataset.view || "large";
            localStorage.setItem(VIEW_MODE_KEY, pantryState.currentViewMode);
            pantryState.skipNextViewTransition = true;
            const grid = document.getElementById("recipe-grid");
            if (grid) grid.innerHTML = "";
            applyViewMode();
            loadRecipes();
        });
    });

    // Close overflow tag popover when clicking outside
    document.addEventListener("click", () => closeTagPopover());

    // ── Unit preference dropdown ───────────────────────────────────────────────
    const unitPreferenceDropdown = document.getElementById("pantry-unit-pref");
    if (unitPreferenceDropdown) {
        const storedUnitPreference = localStorage.getItem(UNIT_PREFERENCE_KEY);
        const selected = storedUnitPreference === "metric" ? "metric" : "us";

        const unitLabel = document.getElementById("pantry-unit-pref-label");
        if (unitLabel) unitLabel.textContent = selected === "metric" ? "MET" : "US";

        const menu = document.getElementById("pantry-unit-pref-menu");
        if (menu) {
            menu.querySelectorAll(".dropdown-item").forEach((item) => {
                item.classList.toggle("active", item.getAttribute("data-value") === selected);
            });
        }

        unitPreferenceDropdown.addEventListener("change", (e: any) => {
            const selectedValue = e?.detail?.value === "metric" ? "metric" : "us";
            localStorage.setItem(UNIT_PREFERENCE_KEY, selectedValue);
        });
    }

    // ── Restore in-flight extractions across page refreshes ───────────────────
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        try {
            const activeRes = await chrome.runtime.sendMessage({ type: MSG.getAllExtractions });
            if (activeRes?.extractions) {
                for (const [url, data] of Object.entries(activeRes.extractions as Record<string, any>)) {
                    let displayTitle = data.title;
                    if (!displayTitle) {
                        try { displayTitle = new URL(url).hostname.replace("www.", ""); }
                        catch { displayTitle = "Website"; }
                    }
                    pantryState.activeExtractions[url] = { status: data.status, title: displayTitle };
                }
            }
        } catch (e) {
            console.warn("[Pantry] Failed to fetch active extractions:", e);
        }
    }

    // ── Initial render and event wiring ───────────────────────────────────────
    await loadRecipes();
    wireCancelExtractionHandler();
    wireExtractionListener();
    wireSearchHandlers();
    wireSelectionControls();
    wireImportExport();

    requestAnimationFrame(() =>
        requestAnimationFrame(() => document.body.classList.add("page-ready"))
    );
});

function applyViewMode() {
    const grid = document.getElementById("recipe-grid");
    if (!grid) return;
    grid.classList.remove("view-large", "view-medium", "view-small");
    grid.classList.add(`view-${pantryState.currentViewMode}`);
    document.querySelectorAll<HTMLElement>(".view-mode-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.view === pantryState.currentViewMode);
    });
}
