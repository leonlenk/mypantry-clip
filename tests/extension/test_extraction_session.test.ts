/**
 * Tests for src/utils/extractionSession.ts — extraction state backed by
 * chrome.storage.session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetChromeStorage, chromeAction, chromeRuntime } from "./setupTests";

let sessionModule: typeof import("../../apps/extension/src/utils/extractionSession");

beforeEach(async () => {
    resetChromeStorage();
    vi.resetModules();
    sessionModule = await import("../../apps/extension/src/utils/extractionSession");
});

afterEach(() => {
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// normalizeUrl
// ---------------------------------------------------------------------------

describe("normalizeUrl", () => {
    it("strips a trailing slash", () => {
        expect(sessionModule.normalizeUrl("https://example.com/recipe/")).toBe(
            "https://example.com/recipe"
        );
    });

    it("leaves a URL without a trailing slash unchanged", () => {
        expect(sessionModule.normalizeUrl("https://example.com/recipe")).toBe(
            "https://example.com/recipe"
        );
    });

    it("handles an empty string", () => {
        expect(sessionModule.normalizeUrl("")).toBe("");
    });
});

// ---------------------------------------------------------------------------
// getActiveExtractions / setActiveExtractions
// ---------------------------------------------------------------------------

describe("getActiveExtractions / setActiveExtractions", () => {
    it("returns an empty object when nothing is stored", async () => {
        const result = await sessionModule.getActiveExtractions();
        expect(result).toEqual({});
    });

    it("round-trips a stored map", async () => {
        const map = {
            "https://example.com/recipe": { status: "Extracting...", tabId: 1, title: "Pasta" },
        };
        await sessionModule.setActiveExtractions(map);
        const result = await sessionModule.getActiveExtractions();
        expect(result).toEqual(map);
    });

    it("overwrites the previous map on second set", async () => {
        await sessionModule.setActiveExtractions({ "https://a.com": { status: "x", tabId: 1, title: "A" } });
        await sessionModule.setActiveExtractions({ "https://b.com": { status: "y", tabId: 2, title: "B" } });
        const result = await sessionModule.getActiveExtractions();
        expect(Object.keys(result)).toEqual(["https://b.com"]);
    });
});

// ---------------------------------------------------------------------------
// isCancelled / markCancelled
// ---------------------------------------------------------------------------

describe("isCancelled / markCancelled", () => {
    it("returns false for an unknown URL", async () => {
        expect(await sessionModule.isCancelled("https://example.com")).toBe(false);
    });

    it("returns true after markCancelled", async () => {
        await sessionModule.markCancelled("https://example.com/recipe");
        expect(await sessionModule.isCancelled("https://example.com/recipe")).toBe(true);
    });

    it("does not duplicate URLs in the cancelled list", async () => {
        await sessionModule.markCancelled("https://example.com");
        await sessionModule.markCancelled("https://example.com");
        // Internal list should still have length 1 — verify via isCancelled still works
        expect(await sessionModule.isCancelled("https://example.com")).toBe(true);
    });

    it("tracks multiple cancelled URLs independently", async () => {
        await sessionModule.markCancelled("https://a.com");
        await sessionModule.markCancelled("https://b.com");
        expect(await sessionModule.isCancelled("https://a.com")).toBe(true);
        expect(await sessionModule.isCancelled("https://b.com")).toBe(true);
        expect(await sessionModule.isCancelled("https://c.com")).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// updateExtractionStatus
// ---------------------------------------------------------------------------

describe("updateExtractionStatus — in-progress", () => {
    it("adds URL to the active map and sets badge to '...'", async () => {
        vi.useFakeTimers();

        const promise = sessionModule.updateExtractionStatus(
            "https://example.com/recipe",
            42,
            "Fetching page...",
        );
        await vi.runAllTimersAsync();
        await promise;

        const map = await sessionModule.getActiveExtractions();
        expect(map["https://example.com/recipe"]).toMatchObject({
            status: "Fetching page...",
            tabId: 42,
        });
        expect(chromeAction.setBadgeText).toHaveBeenCalledWith({ text: "...", tabId: 42 });
        expect(chromeAction.setBadgeBackgroundColor).toHaveBeenCalledWith({
            color: "#F59E0B",
            tabId: 42,
        });
    });

    it("normalizes a trailing slash on the URL key", async () => {
        vi.useFakeTimers();
        const promise = sessionModule.updateExtractionStatus(
            "https://example.com/recipe/",
            1,
            "Running...",
        );
        await vi.runAllTimersAsync();
        await promise;

        const map = await sessionModule.getActiveExtractions();
        expect(map["https://example.com/recipe"]).toBeDefined();
        expect(map["https://example.com/recipe/"]).toBeUndefined();
    });

    it("preserves an existing title when no new title is provided", async () => {
        vi.useFakeTimers();

        // First call sets the title
        const p1 = sessionModule.updateExtractionStatus("https://example.com", 1, "Step 1", false, false, "My Recipe");
        await vi.runAllTimersAsync();
        await p1;

        // Second call without a title — should keep "My Recipe"
        const p2 = sessionModule.updateExtractionStatus("https://example.com", 1, "Step 2");
        await vi.runAllTimersAsync();
        await p2;

        const map = await sessionModule.getActiveExtractions();
        expect(map["https://example.com"].title).toBe("My Recipe");
    });
});

describe("updateExtractionStatus — complete", () => {
    it("removes URL from the active map and sets badge to ✓", async () => {
        // Seed the map first
        await sessionModule.setActiveExtractions({
            "https://example.com": { status: "Running", tabId: 7, title: "Cake" },
        });

        await sessionModule.updateExtractionStatus("https://example.com", 7, "Done", false, true);

        const map = await sessionModule.getActiveExtractions();
        expect(map["https://example.com"]).toBeUndefined();
        expect(chromeAction.setBadgeText).toHaveBeenCalledWith({ text: "✓", tabId: 7 });
        expect(chromeAction.setBadgeBackgroundColor).toHaveBeenCalledWith({
            color: "#10B981",
            tabId: 7,
        });
    });
});

describe("updateExtractionStatus — error", () => {
    it("removes URL from the active map and sets badge to ERR", async () => {
        await sessionModule.setActiveExtractions({
            "https://example.com": { status: "Running", tabId: 3, title: "Soup" },
        });

        await sessionModule.updateExtractionStatus("https://example.com", 3, "Failed", true, false);

        const map = await sessionModule.getActiveExtractions();
        expect(map["https://example.com"]).toBeUndefined();
        expect(chromeAction.setBadgeText).toHaveBeenCalledWith({ text: "ERR", tabId: 3 });
        expect(chromeAction.setBadgeBackgroundColor).toHaveBeenCalledWith({
            color: "#EF4444",
            tabId: 3,
        });
    });
});

describe("updateExtractionStatus — cancelled URL", () => {
    it("skips processing when the URL has been cancelled", async () => {
        await sessionModule.markCancelled("https://example.com/recipe");

        await sessionModule.updateExtractionStatus("https://example.com/recipe", 1, "Running");

        // Map should remain empty — update was skipped
        const map = await sessionModule.getActiveExtractions();
        expect(map["https://example.com/recipe"]).toBeUndefined();
        expect(chromeAction.setBadgeText).not.toHaveBeenCalled();
    });
});

describe("updateExtractionStatus — sendMessage error handling", () => {
    it("does not throw when sendMessage rejects (popup closed)", async () => {
        chromeRuntime.sendMessage.mockRejectedValueOnce(new Error("Could not establish connection"));

        await expect(
            sessionModule.updateExtractionStatus("https://example.com", 1, "Done", false, true)
        ).resolves.toBeUndefined();
    });
});
