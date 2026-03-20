/**
 * Tests for src/utils/sync.ts — cloud sync utilities.
 *
 * Uses the Chrome storage stubs from setupTests.ts and mocks fetch
 * to test sync logic without real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    resetChromeStorage,
    setChromeStorageData,
} from "./setupTests";

// We dynamically import sync.ts so the Chrome stubs are already in place
// before the module evaluates.
let syncModule: typeof import("../../apps/extension/src/utils/sync");

beforeEach(async () => {
    resetChromeStorage();
    // Re-import each test to get fresh module state
    syncModule = await import("../../apps/extension/src/utils/sync");
});

// ---------------------------------------------------------------------------
// syncRecipeToCloud
// ---------------------------------------------------------------------------

describe("syncRecipeToCloud", () => {
    it("sends a POST request with the recipe (no embedding)", async () => {
        setChromeStorageData({
            supabaseToken: "fake-jwt",
            llmProvider: "google",
            apiUrl: "https://api.example.com",
        });

        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal("fetch", fetchMock);

        const recipe = {
            id: "r1",
            url: "https://example.com/recipe",
            title: "Pancakes",
            description: "Fluffy",
            servings: 4,
            ingredients: [],
            instructions: [],
            embedding: [0.1, 0.2, 0.3], // should be stripped
        } as any;

        await syncModule.syncRecipeToCloud(recipe);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe("https://api.example.com/sync/save");
        expect(options.method).toBe("POST");

        const body = JSON.parse(options.body);
        expect(body.recipe).not.toHaveProperty("embedding");
        expect(body.recipe.title).toBe("Pancakes");

        vi.unstubAllGlobals();
    });

    it("no-ops when user is not on google provider (BYOK)", async () => {
        setChromeStorageData({
            llmProvider: "anthropic",
            supabaseToken: null,
        });

        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await syncModule.syncRecipeToCloud({
            id: "r1",
            url: "u",
            title: "t",
            description: "",
            servings: 1,
            ingredients: [],
            instructions: [],
        } as any);

        expect(fetchMock).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it("no-ops when supabaseToken is missing", async () => {
        setChromeStorageData({
            llmProvider: "google",
            supabaseToken: undefined,
        });

        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await syncModule.syncRecipeToCloud({
            id: "r1",
            url: "u",
            title: "t",
            description: "",
            servings: 1,
            ingredients: [],
            instructions: [],
        } as any);

        expect(fetchMock).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it("does not throw on network error (fail-silent)", async () => {
        setChromeStorageData({
            supabaseToken: "token",
            llmProvider: "google",
            apiUrl: "https://api.example.com",
        });

        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network down")));

        await expect(
            syncModule.syncRecipeToCloud({
                id: "r1",
                url: "u",
                title: "t",
                description: "",
                servings: 1,
                ingredients: [],
                instructions: [],
            } as any)
        ).resolves.toBeUndefined();

        vi.unstubAllGlobals();
    });
});

// ---------------------------------------------------------------------------
// deleteRecipeFromCloud
// ---------------------------------------------------------------------------

describe("deleteRecipeFromCloud", () => {
    it("calls DELETE with the correct URL", async () => {
        setChromeStorageData({
            supabaseToken: "token",
            llmProvider: "google",
            apiUrl: "https://api.example.com",
        });

        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal("fetch", fetchMock);

        await syncModule.deleteRecipeFromCloud("recipe-123");

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toContain("/sync/delete/recipe-123");
        expect(options.method).toBe("DELETE");

        vi.unstubAllGlobals();
    });

    it("no-ops without auth", async () => {
        setChromeStorageData({ llmProvider: "anthropic" });

        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await syncModule.deleteRecipeFromCloud("r1");
        expect(fetchMock).not.toHaveBeenCalled();

        vi.unstubAllGlobals();
    });
});

// ---------------------------------------------------------------------------
// syncBatchToCloud
// ---------------------------------------------------------------------------

describe("syncBatchToCloud", () => {
    it("sends a batch of recipes without embeddings", async () => {
        setChromeStorageData({
            supabaseToken: "token",
            llmProvider: "google",
            apiUrl: "https://api.example.com",
        });

        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal("fetch", fetchMock);

        const recipes = [
            { id: "r1", url: "u", title: "A", description: "", servings: 1, ingredients: [], instructions: [], embedding: [1] },
            { id: "r2", url: "v", title: "B", description: "", servings: 2, ingredients: [], instructions: [], embedding: [2] },
        ] as any[];

        await syncModule.syncBatchToCloud(recipes);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.recipes).toHaveLength(2);
        body.recipes.forEach((r: any) => {
            expect(r).not.toHaveProperty("embedding");
        });

        vi.unstubAllGlobals();
    });

    it("no-ops for an empty array", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await syncModule.syncBatchToCloud([]);
        expect(fetchMock).not.toHaveBeenCalled();

        vi.unstubAllGlobals();
    });
});

// ---------------------------------------------------------------------------
// syncRecipeToCloud — non-ok response path
// ---------------------------------------------------------------------------

describe("syncRecipeToCloud — non-ok response", () => {
    it("logs a warning but does not throw on non-ok response", async () => {
        setChromeStorageData({
            supabaseToken: "token",
            llmProvider: "google",
            apiUrl: "https://api.example.com",
        });

        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            text: async () => "Internal Server Error",
        }));

        // Should resolve without throwing
        await expect(
            syncModule.syncRecipeToCloud({
                id: "r1", url: "u", title: "t", description: "", servings: 1,
                ingredients: [], instructions: [],
            } as any)
        ).resolves.toBeUndefined();

        vi.unstubAllGlobals();
    });
});

// ---------------------------------------------------------------------------
// syncBatchToCloud — non-ok and no-token paths
// ---------------------------------------------------------------------------

describe("syncBatchToCloud — no token (BYOK)", () => {
    it("no-ops when not authenticated", async () => {
        setChromeStorageData({ llmProvider: "anthropic" });

        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await syncModule.syncBatchToCloud([
            { id: "r1", url: "u", title: "A", description: "", servings: 1, ingredients: [], instructions: [] } as any,
        ]);
        expect(fetchMock).not.toHaveBeenCalled();

        vi.unstubAllGlobals();
    });

    it("does not throw on network error", async () => {
        setChromeStorageData({
            supabaseToken: "token",
            llmProvider: "google",
            apiUrl: "https://api.example.com",
        });

        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

        await expect(
            syncModule.syncBatchToCloud([
                { id: "r1", url: "u", title: "A", description: "", servings: 1, ingredients: [], instructions: [] } as any,
            ])
        ).resolves.toBeUndefined();

        vi.unstubAllGlobals();
    });
});

// ---------------------------------------------------------------------------
// deleteRecipeFromCloud — non-ok response
// ---------------------------------------------------------------------------

describe("deleteRecipeFromCloud — non-ok response", () => {
    it("logs a warning but does not throw on non-ok delete response", async () => {
        setChromeStorageData({
            supabaseToken: "token",
            llmProvider: "google",
            apiUrl: "https://api.example.com",
        });

        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: false,
            status: 404,
            text: async () => "Not Found",
        }));

        await expect(syncModule.deleteRecipeFromCloud("missing-id")).resolves.toBeUndefined();

        vi.unstubAllGlobals();
    });

    it("does not throw on network error during delete", async () => {
        setChromeStorageData({
            supabaseToken: "token",
            llmProvider: "google",
            apiUrl: "https://api.example.com",
        });

        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));

        await expect(syncModule.deleteRecipeFromCloud("r1")).resolves.toBeUndefined();

        vi.unstubAllGlobals();
    });
});

// ---------------------------------------------------------------------------
// getCloudLatestTimestamp
// ---------------------------------------------------------------------------

describe("getCloudLatestTimestamp", () => {
    it("returns null when not authenticated", async () => {
        setChromeStorageData({ llmProvider: "anthropic" });
        const result = await syncModule.getCloudLatestTimestamp();
        expect(result).toBeNull();
    });

    it("returns the timestamp from the API response", async () => {
        setChromeStorageData({
            supabaseToken: "token",
            llmProvider: "google",
            apiUrl: "https://api.example.com",
        });

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ latest_updated_at: "2026-03-01T00:00:00Z" }),
            })
        );

        const result = await syncModule.getCloudLatestTimestamp();
        expect(result).toBe("2026-03-01T00:00:00Z");

        vi.unstubAllGlobals();
    });

    it("returns null on network error", async () => {
        setChromeStorageData({
            supabaseToken: "token",
            llmProvider: "google",
            apiUrl: "https://api.example.com",
        });

        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fail")));

        const result = await syncModule.getCloudLatestTimestamp();
        expect(result).toBeNull();

        vi.unstubAllGlobals();
    });
});

// ---------------------------------------------------------------------------
// syncAllFromCloud
// ---------------------------------------------------------------------------

describe("syncAllFromCloud", () => {
    it("returns empty array when not authenticated", async () => {
        setChromeStorageData({ llmProvider: "anthropic" });
        const result = await syncModule.syncAllFromCloud();
        expect(result).toEqual([]);
    });

    it("returns recipes from the cloud (full sync)", async () => {
        setChromeStorageData({
            supabaseToken: "token",
            llmProvider: "google",
            apiUrl: "https://api.example.com",
        });

        const fakeRecipe = { id: "r1", title: "Soup" };
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                recipes: [{ id: "r1", recipe_json: fakeRecipe, updated_at: "2026-03-01" }],
            }),
        }));

        const result = await syncModule.syncAllFromCloud();
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual(fakeRecipe);

        vi.unstubAllGlobals();
    });

    it("passes the 'since' param to the API URL", async () => {
        setChromeStorageData({
            supabaseToken: "token",
            llmProvider: "google",
            apiUrl: "https://api.example.com",
        });

        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ recipes: [] }),
        });
        vi.stubGlobal("fetch", fetchMock);

        await syncModule.syncAllFromCloud("2026-01-01T00:00:00Z");

        const [url] = fetchMock.mock.calls[0];
        expect(url).toContain("since=");

        vi.unstubAllGlobals();
    });

    it("returns empty array on non-ok response", async () => {
        setChromeStorageData({
            supabaseToken: "token",
            llmProvider: "google",
            apiUrl: "https://api.example.com",
        });

        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

        const result = await syncModule.syncAllFromCloud();
        expect(result).toEqual([]);

        vi.unstubAllGlobals();
    });

    it("returns empty array on network error", async () => {
        setChromeStorageData({
            supabaseToken: "token",
            llmProvider: "google",
            apiUrl: "https://api.example.com",
        });

        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

        const result = await syncModule.syncAllFromCloud();
        expect(result).toEqual([]);

        vi.unstubAllGlobals();
    });
});
