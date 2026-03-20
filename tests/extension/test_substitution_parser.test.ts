/**
 * Tests for src/utils/substitutionParser.ts — cloud + BYOK error handling.
 *
 * Covers:
 * - Cloud path: 401 session-expired error
 * - Cloud path: null guard on cloudData.substitution
 * - BYOK path: original parse error is preserved in the thrown message
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetChromeStorage, setChromeStorageData } from "./setupTests";

let parserModule: typeof import("../../apps/extension/src/utils/substitutionParser");

beforeEach(async () => {
    resetChromeStorage();
    setChromeStorageData({ apiUrl: "https://api.example.com" });
    // Re-import each test for a fresh module state
    vi.resetModules();
    parserModule = await import("../../apps/extension/src/utils/substitutionParser");
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const MINIMAL_RECIPE: any = {
    id: "r1",
    url: "https://example.com/cake",
    title: "Chocolate Cake",
    servings: 8,
    ingredients: [{ item: "butter", rawText: "1 cup butter" }],
    instructions: [{ stepNumber: 1, text: "Cream butter." }],
    createdAt: Date.now(),
};

// ---------------------------------------------------------------------------
// Cloud path — 401 handling
// ---------------------------------------------------------------------------

describe("askSubstitution cloud — 401 session expired", () => {
    it("throws a session-expired message on 401", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: false,
                status: 401,
                text: async () => "Unauthorized",
                json: async () => ({ detail: "Unauthorized" }),
            })
        );
        setChromeStorageData({ supabaseToken: "expired-token", apiUrl: "https://api.example.com" });

        await expect(
            parserModule.askSubstitution(MINIMAL_RECIPE, "butter", "expired-token", "none", "anthropic", "cloud")
        ).rejects.toThrow(/session expired/i);
    });
});

// ---------------------------------------------------------------------------
// Cloud path — null guard on cloudData.substitution
// ---------------------------------------------------------------------------

describe("askSubstitution cloud — null guard on substitution field", () => {
    it("throws a clean error when substitution is missing from response", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ substitution: null }),
            })
        );

        await expect(
            parserModule.askSubstitution(MINIMAL_RECIPE, "butter", "token", "none", "anthropic", "cloud")
        ).rejects.toThrow("No substitution returned from server.");
    });

    it("throws a clean error when the response body has no substitution key", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ unexpected: "shape" }),
            })
        );

        await expect(
            parserModule.askSubstitution(MINIMAL_RECIPE, "butter", "token", "none", "anthropic", "cloud")
        ).rejects.toThrow("No substitution returned from server.");
    });

    it("succeeds when substitution is well-formed", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    substitution: {
                        target_ingredient: "butter",
                        substitution_name: "coconut oil",
                        amount: 1.0,
                        unit: "cup",
                        reasoning: "Similar fat content.",
                    },
                }),
            })
        );

        const result = await parserModule.askSubstitution(
            MINIMAL_RECIPE, "butter", "token", "none", "anthropic", "cloud"
        );
        expect(result.thoughtProcess).toBe("Similar fat content.");
        expect(result.substitutions[0].item).toBe("coconut oil");
    });
});

// ---------------------------------------------------------------------------
// BYOK path — parse error message preservation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cloud path — non-401 error (parseCloudApiError branch)
// ---------------------------------------------------------------------------

describe("askSubstitution cloud — non-401 error", () => {
    it("throws a cloud-API error for 503", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: false,
                status: 503,
                text: async () => "Service Unavailable",
                json: async () => ({}),
            })
        );

        await expect(
            parserModule.askSubstitution(MINIMAL_RECIPE, "butter", "token", "none", "anthropic", "cloud")
        ).rejects.toThrow(/busy/i);
    });
});

// ---------------------------------------------------------------------------
// Cloud path — fuzzy ingredient ID match (second OR condition)
// ---------------------------------------------------------------------------

describe("askSubstitution cloud — fuzzy ingredient match", () => {
    it("matches when target_ingredient contains the ingredient item name", async () => {
        // target_ingredient = "unsalted butter", ingredient item = "butter"
        // Second OR: targetLower.includes(ing.item.toLowerCase())
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    substitution: {
                        target_ingredient: "unsalted butter",  // contains "butter"
                        substitution_name: "coconut oil",
                        amount: 1.0,
                        unit: "cup",
                        reasoning: "Similar fat.",
                    },
                }),
            })
        );

        const recipe = {
            ...MINIMAL_RECIPE,
            ingredients: [{ item: "butter", rawText: "1 cup butter" }],
        };

        const result = await parserModule.askSubstitution(recipe, "unsalted butter", "token", "none", "anthropic", "cloud");
        expect(result.substitutions[0].ingredientId).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Cloud path — AbortError (timeout)
// ---------------------------------------------------------------------------

describe("askSubstitution cloud — AbortError timeout", () => {
    it("throws a timeout error when the request is aborted", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }))
        );

        await expect(
            parserModule.askSubstitution(MINIMAL_RECIPE, "butter", "token", "none", "anthropic", "cloud")
        ).rejects.toThrow(/timed out/i);
    });
});

// ---------------------------------------------------------------------------
// BYOK path — happy path (return parsed)
// ---------------------------------------------------------------------------

describe("askSubstitution BYOK — happy path", () => {
    it("returns parsed result when LLM returns valid substitution JSON", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    content: [{
                        text: JSON.stringify({
                            thoughtProcess: "Coconut oil has similar fat content.",
                            substitutions: [{
                                ingredientId: 0,
                                quantity: 1.0,
                                unit: "cup",
                                item: "coconut oil",
                                preparation: null,
                                rawText: "1 cup coconut oil",
                            }],
                        }),
                    }],
                    stop_reason: "end_turn",
                }),
            })
        );

        const result = await parserModule.askSubstitution(
            MINIMAL_RECIPE, "butter", "sk-ant-key", "claude-3-5-haiku-20241022", "anthropic", "byok"
        );
        expect(result.thoughtProcess.toLowerCase()).toContain("coconut oil");
        expect(result.substitutions[0].item).toBe("coconut oil");
    });
});

describe("askSubstitution BYOK — parse error detail preserved", () => {
    it("includes the underlying parse error in the thrown message", async () => {
        // Return a response whose text content is not valid JSON
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    content: [{ text: 'not valid json {{{' }],
                    stop_reason: "end_turn",
                }),
            })
        );

        await expect(
            parserModule.askSubstitution(MINIMAL_RECIPE, "butter", "sk-ant-key", "claude-3-5-haiku-20241022", "anthropic", "byok")
        ).rejects.toThrow(/LLM returned malformed JSON:/);
    });

    it("includes 'missing required fields' when JSON is valid but schema is wrong", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    content: [{ text: '{"wrong": "schema"}' }],
                    stop_reason: "end_turn",
                }),
            })
        );

        await expect(
            parserModule.askSubstitution(MINIMAL_RECIPE, "butter", "sk-ant-key", "claude-3-5-haiku-20241022", "anthropic", "byok")
        ).rejects.toThrow(/LLM returned malformed JSON:/);
    });
});
