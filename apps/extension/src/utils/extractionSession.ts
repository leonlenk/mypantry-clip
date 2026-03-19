/**
 * Extraction session state backed by chrome.storage.session.
 *
 * storage.session survives service-worker restarts (unlike in-memory state)
 * and is cleared automatically when the browser closes — the correct lifetime
 * for "currently extracting" state.
 */

import { type ExtractionState, getSession, setSession } from "./storage";
import { MSG } from "./messages";

// Re-export so existing callers don't need to change their import path.
export type { ExtractionState };

declare const chrome: any;

export function normalizeUrl(url: string): string {
    return url.replace(/\/$/, "");
}

export async function getActiveExtractions(): Promise<Record<string, ExtractionState>> {
    const stored = await getSession(["activeExtractions"]);
    return stored.activeExtractions ?? {};
}

export async function setActiveExtractions(map: Record<string, ExtractionState>): Promise<void> {
    await setSession({ activeExtractions: map });
}

export async function isCancelled(url: string): Promise<boolean> {
    const stored = await getSession(["cancelledExtractions"]);
    const list = stored.cancelledExtractions ?? [];
    return list.includes(url);
}

export async function markCancelled(url: string): Promise<void> {
    const stored = await getSession(["cancelledExtractions"]);
    const list = stored.cancelledExtractions ?? [];
    if (!list.includes(url)) list.push(url);
    await setSession({ cancelledExtractions: list });
}

export async function updateExtractionStatus(
    url: string,
    tabId: number,
    status: string,
    isError: boolean = false,
    isComplete: boolean = false,
    recipeTitle?: string
): Promise<void> {
    const normUrl = normalizeUrl(url);
    if (await isCancelled(normUrl)) return;

    const map = await getActiveExtractions();
    const existingTitle = map[normUrl]?.title;
    const finalTitle = recipeTitle || existingTitle;

    if (isComplete || isError) {
        delete map[normUrl];
        chrome.action.setBadgeText({ text: isError ? "ERR" : "✓", tabId }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ color: isError ? "#EF4444" : "#10B981", tabId }).catch(() => {});
    } else {
        map[normUrl] = { status, tabId, title: finalTitle };
        chrome.action.setBadgeText({ text: "...", tabId }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ color: "#F59E0B", tabId }).catch(() => {});
    }
    await setActiveExtractions(map);

    try {
        await chrome.runtime.sendMessage({
            type: MSG.extractionStatusUpdate,
            url: normUrl,
            status,
            isError,
            isComplete,
            recipeTitle: finalTitle,
        });
    } catch {
        // Popup is closed — ignore
    }

    // Artificial delay so the user can read status messages as they stream in
    if (!isComplete && !isError) {
        await new Promise((r) => setTimeout(r, 1500));
    }
}
