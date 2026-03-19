/**
 * Active extraction lifecycle — placeholder cards and live status updates.
 *
 * wireCancelExtractionHandler() lets users cancel an in-flight extraction.
 * wireExtractionListener() listens for EXTRACTION_STATUS_UPDATE messages
 * from the background script and updates the grid in real time.
 */

import { pantryState } from "./pantryState";
import { loadRecipes } from "./recipeRenderer";
import { MSG } from "../../utils/messages";

declare const chrome: any;

const grid = document.getElementById("recipe-grid");
const emptyState = document.getElementById("empty-state");

export function wireCancelExtractionHandler() {
    if (!grid) return;
    grid.addEventListener("click", (e) => {
        const btn = (e.target as Element).closest<HTMLElement>(".cancel-extraction-btn");
        if (!btn) return;
        e.stopPropagation();

        const url = btn.dataset.url || "";
        delete pantryState.activeExtractions[url];

        const safeId = "placeholder-" + url.replace(/[^a-zA-Z0-9_-]/g, "");
        const placeholderEl = document.getElementById(safeId);
        if (placeholderEl) {
            placeholderEl.classList.add("skeleton-fade-out");
            placeholderEl.addEventListener("animationend", () => {
                placeholderEl.remove();
                const remaining = grid?.querySelectorAll(".recipe-card").length ?? 0;
                if (remaining === 0) {
                    grid?.classList.add("hidden");
                    emptyState?.classList.remove("hidden");
                }
            }, { once: true });
        }

        if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
            chrome.runtime.sendMessage({ type: MSG.cancelExtraction, url }).catch(() => {});
        }
    });
}

export function wireExtractionListener() {
    if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return;

    chrome.runtime.onMessage.addListener((message: any) => {
        if (message.type === MSG.recipeSavedFromShare) {
            loadRecipes();
            return;
        }

        if (message.type !== MSG.extractionStatusUpdate) return;

        if (message.isComplete) {
            if (message.isError) {
                const safeId = "placeholder-" + message.url.replace(/[^a-zA-Z0-9_-]/g, "");
                const placeholderEl = document.getElementById(safeId);
                if (placeholderEl) {
                    placeholderEl.classList.add("skeleton-error");
                    const statusBadge = placeholderEl.querySelector(".status-badge");
                    if (statusBadge) statusBadge.textContent = message.status;
                    const titleEl = placeholderEl.querySelector(".skeleton-title");
                    if (titleEl) (titleEl as HTMLElement).style.opacity = "1";

                    setTimeout(() => {
                        placeholderEl.classList.add("skeleton-fade-out");
                        placeholderEl.addEventListener("animationend", () => {
                            placeholderEl.remove();
                            const remaining = grid?.querySelectorAll(".recipe-card").length ?? 0;
                            if (remaining === 0) {
                                grid?.classList.add("hidden");
                                emptyState?.classList.remove("hidden");
                            }
                        }, { once: true });
                    }, 3000);
                }
                delete pantryState.activeExtractions[message.url];
            } else {
                loadRecipes();
                delete pantryState.activeExtractions[message.url];
            }
        } else {
            let displayTitle = message.recipeTitle;
            if (!displayTitle) {
                try { displayTitle = new URL(message.url).hostname.replace("www.", ""); }
                catch { displayTitle = "Website"; }
            }

            const isNew = !pantryState.activeExtractions[message.url];
            pantryState.activeExtractions[message.url] = { status: message.status, title: displayTitle };

            if (isNew) {
                loadRecipes();
            } else {
                const safeId = "placeholder-" + message.url.replace(/[^a-zA-Z0-9_-]/g, "");
                const placeholderEl = document.getElementById(safeId);
                if (placeholderEl) {
                    const statusBadge = placeholderEl.querySelector(".status-badge");
                    if (statusBadge) statusBadge.textContent = message.status;
                    const titleEl = placeholderEl.querySelector(".skeleton-title");
                    if (titleEl) titleEl.textContent = displayTitle;
                }
            }
        }
    });
}
