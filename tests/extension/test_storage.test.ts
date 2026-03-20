/**
 * Tests for src/utils/storage.ts — getSession, setSession, and removeLocal.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { resetChromeStorage, setChromeStorageData, chromeStorageLocal, chromeStorageSession } from "./setupTests";

let storageModule: typeof import("../../apps/extension/src/utils/storage");

beforeEach(async () => {
    resetChromeStorage();
    storageModule = await import("../../apps/extension/src/utils/storage");
});

// ---------------------------------------------------------------------------
// getLocal / setLocal / removeLocal
// ---------------------------------------------------------------------------

describe("getLocal", () => {
    it("returns values stored via setChromeStorageData", async () => {
        setChromeStorageData({ supabaseToken: "tok123", llmProvider: "google" });
        const data = await storageModule.getLocal(["supabaseToken", "llmProvider"]);
        expect(data.supabaseToken).toBe("tok123");
        expect(data.llmProvider).toBe("google");
    });
});

describe("setLocal", () => {
    it("stores values in chrome.storage.local", async () => {
        await storageModule.setLocal({ llmModel: "claude-3-5-sonnet-20241022" });
        expect(chromeStorageLocal.set).toHaveBeenCalledWith({ llmModel: "claude-3-5-sonnet-20241022" });
    });
});

describe("removeLocal", () => {
    it("removes a single key from chrome.storage.local", async () => {
        setChromeStorageData({ supabaseToken: "tok" });
        await storageModule.removeLocal("supabaseToken");
        expect(chromeStorageLocal.remove).toHaveBeenCalledWith("supabaseToken");
    });

    it("removes an array of keys from chrome.storage.local", async () => {
        await storageModule.removeLocal(["supabaseToken", "supabaseRefreshToken"]);
        expect(chromeStorageLocal.remove).toHaveBeenCalledWith(["supabaseToken", "supabaseRefreshToken"]);
    });
});

// ---------------------------------------------------------------------------
// getSession / setSession
// ---------------------------------------------------------------------------

describe("getSession", () => {
    it("returns session values set via chrome.storage.session", async () => {
        chromeStorageSession.get.mockResolvedValueOnce({
            activeExtractions: { "https://example.com": { status: "extracting", tabId: 1 } },
        });
        const data = await storageModule.getSession("activeExtractions");
        expect(data.activeExtractions).toBeDefined();
        expect(data.activeExtractions["https://example.com"].status).toBe("extracting");
    });

    it("accepts an array of keys", async () => {
        chromeStorageSession.get.mockResolvedValueOnce({
            activeExtractions: {},
            cancelledExtractions: ["https://gone.com"],
        });
        const data = await storageModule.getSession(["activeExtractions", "cancelledExtractions"]);
        expect(data.cancelledExtractions).toContain("https://gone.com");
    });
});

describe("setSession", () => {
    it("writes to chrome.storage.session", async () => {
        await storageModule.setSession({ cancelledExtractions: ["https://example.com"] });
        expect(chromeStorageSession.set).toHaveBeenCalledWith({
            cancelledExtractions: ["https://example.com"],
        });
    });

    it("writes activeExtractions to chrome.storage.session", async () => {
        const state = { "https://recipe.com": { status: "done", tabId: 5 } };
        await storageModule.setSession({ activeExtractions: state });
        expect(chromeStorageSession.set).toHaveBeenCalledWith({ activeExtractions: state });
    });
});

// ---------------------------------------------------------------------------
// AUTH_KEYS constant
// ---------------------------------------------------------------------------

describe("AUTH_KEYS", () => {
    it("includes setupComplete and supabaseToken", () => {
        expect(storageModule.AUTH_KEYS).toContain("setupComplete");
        expect(storageModule.AUTH_KEYS).toContain("supabaseToken");
    });
});

// ---------------------------------------------------------------------------
// LS constant
// ---------------------------------------------------------------------------

describe("LS", () => {
    it("exposes pantryViewMode and preferredUnitSystem keys", () => {
        expect(storageModule.LS.pantryViewMode).toBe("pantryViewMode");
        expect(storageModule.LS.preferredUnitSystem).toBe("preferredUnitSystem");
    });
});
