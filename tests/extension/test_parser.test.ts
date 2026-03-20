/**
 * Tests for src/utils/parser.ts — recipe extraction (cloud and BYOK paths).
 *
 * `callLlm` is mocked so no real network calls are made.
 * The cloud path is tested by mocking `fetch` and setting `apiUrl` in storage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetChromeStorage, setChromeStorageData } from "./setupTests";
import type { ExtractionResult } from "../../apps/extension/src/utils/llmClient";

// Mock callLlm only — all other llmClient exports stay real
vi.mock("../../apps/extension/src/utils/llmClient", async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return { ...actual, callLlm: vi.fn() };
});

let parserModule: typeof import("../../apps/extension/src/utils/parser");
let llmClientModule: typeof import("../../apps/extension/src/utils/llmClient");

beforeEach(async () => {
    resetChromeStorage();
    setChromeStorageData({ apiUrl: "https://api.example.com" });
    parserModule = await import("../../apps/extension/src/utils/parser");
    llmClientModule = await import("../../apps/extension/src/utils/llmClient");
    vi.mocked(llmClientModule.callLlm).mockClear();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseExtraction: ExtractionResult = {
    url: "https://example.com/pasta",
    title: "Pasta Carbonara",
    source: "dom-target",
    recipeText: "Boil pasta. Mix eggs. Combine.",
};

const cloudRecipeResponse = {
    recipe: {
        title: "Pasta Carbonara",
        semantic_summary: "A savory Italian main dish.",
        prepTime: 10,
        cookTime: 20,
        tags: ["ITALIAN", "PASTA"],
        servings: 2,
        notes: ["Use guanciale if possible."],
        ingredients: [
            {
                us_amount: 200,
                us_unit: "g",
                metric_amount: 200,
                metric_unit: "g",
                name: "pasta",
                preparation: null,
                subtext: null,
                note_references: null,
                group: null,
            },
        ],
        instructions: ["Boil pasta.", "Mix eggs and cheese.", "Combine."],
    },
};

// ---------------------------------------------------------------------------
// Cloud path
// ---------------------------------------------------------------------------

describe("extractRecipe — cloud path (dom-target)", () => {
    it("maps a successful cloud response to a Recipe", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: async () => cloudRecipeResponse,
        }));

        const { recipeData } = await parserModule.extractRecipe(
            baseExtraction, "jwt-token", "", "google", "cloud"
        );

        expect(recipeData.title).toBe("Pasta Carbonara");
        expect(recipeData.semantic_summary).toBe("A savory Italian main dish.");
        expect(recipeData.url).toBe("https://example.com/pasta");
        expect(recipeData.servings).toBe(2);
        expect(recipeData.ingredients).toHaveLength(1);
        expect(recipeData.ingredients[0].item).toBe("pasta");
        expect(recipeData.instructions).toHaveLength(3);
        expect(recipeData.instructions[0].stepNumber).toBe(1);
    });

    it("uses the extraction image when the cloud response omits one", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: async () => cloudRecipeResponse,
        }));

        const withImage = { ...baseExtraction, image: "https://example.com/img.jpg" };
        const { recipeData } = await parserModule.extractRecipe(
            withImage, "jwt-token", "", "google", "cloud"
        );
        expect(recipeData.image).toBe("https://example.com/img.jpg");
    });

    it("throws on 401 with a session-expired message", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
        }));

        await expect(
            parserModule.extractRecipe(baseExtraction, "bad-token", "", "google", "cloud")
        ).rejects.toThrow("Session expired");
    });

    it("throws when the cloud response contains an error field", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ error: "No recipe found on this page." }),
        }));

        await expect(
            parserModule.extractRecipe(baseExtraction, "jwt", "", "google", "cloud")
        ).rejects.toThrow("No recipe found");
    });

    it("throws when the cloud recipe has no ingredients", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                recipe: { ...cloudRecipeResponse.recipe, ingredients: [] },
            }),
        }));

        await expect(
            parserModule.extractRecipe(baseExtraction, "jwt", "", "google", "cloud")
        ).rejects.toThrow("No recipe found");
    });
});

describe("extractRecipe — cloud path (json-ld source)", () => {
    it("sends json-ld payload and maps response", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => cloudRecipeResponse,
        });
        vi.stubGlobal("fetch", fetchMock);

        const jsonLdExtraction: ExtractionResult = {
            url: "https://example.com/pasta",
            title: "Pasta",
            source: "json-ld",
            jsonLd: { "@type": "Recipe", name: "Pasta" },
            recipeText: "Some text",
        };

        const { recipeData } = await parserModule.extractRecipe(
            jsonLdExtraction, "jwt", "", "google", "cloud"
        );

        expect(recipeData.title).toBe("Pasta Carbonara");
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.payload).toContain("STRUCTURED METADATA");
    });

    it("sends json-ld payload without recipeText section when recipeText is absent", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => cloudRecipeResponse,
        });
        vi.stubGlobal("fetch", fetchMock);

        const jsonLdExtraction: ExtractionResult = {
            url: "https://example.com/pasta",
            title: "Pasta",
            source: "json-ld",
            jsonLd: { "@type": "Recipe", name: "Pasta" },
        };

        await parserModule.extractRecipe(jsonLdExtraction, "jwt", "", "google", "cloud");

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.payload).not.toContain("PAGE TEXT REFERENCE");
    });
});

// ---------------------------------------------------------------------------
// BYOK path
// ---------------------------------------------------------------------------

const byokRecipeJson = {
    id: "pasta-abc",
    url: "https://example.com/pasta",
    title: "Pasta Carbonara",
    semantic_summary: "A savory Italian classic.",
    servings: 2,
    ingredients: [{ rawText: "200g pasta", item: "pasta", us_amount: null, us_unit: null, metric_amount: 200, metric_unit: "g" }],
    instructions: [{ stepNumber: 1, text: "Boil pasta." }],
};

describe("extractRecipe — BYOK path", () => {
    it("calls callLlm and maps the parsed JSON to a Recipe", async () => {
        vi.mocked(llmClientModule.callLlm).mockResolvedValue({} as any);

        // Spy on extractTextFromResult and extractJsonObject via the real implementations
        // by making callLlm return a shape that the real extractTextFromResult handles
        vi.mocked(llmClientModule.callLlm).mockResolvedValue({
            content: [{ type: "text", text: JSON.stringify(byokRecipeJson) }],
        } as any);

        const { recipeData } = await parserModule.extractRecipe(
            baseExtraction, "sk-ant-key", "claude-3-5-haiku-20241022", "claude", "byok"
        );

        expect(recipeData.title).toBe("Pasta Carbonara");
        expect(recipeData.semantic_summary).toBe("A savory Italian classic.");
        expect(recipeData.createdAt).toBeGreaterThan(0);
        expect(vi.mocked(llmClientModule.callLlm)).toHaveBeenCalledTimes(1);
    });

    it("attaches the image from extraction when BYOK recipe has none", async () => {
        vi.mocked(llmClientModule.callLlm).mockResolvedValue({
            content: [{ type: "text", text: JSON.stringify(byokRecipeJson) }],
        } as any);

        const withImage = { ...baseExtraction, image: "https://example.com/img.jpg" };
        const { recipeData } = await parserModule.extractRecipe(
            withImage, "sk-ant-key", "claude-3-haiku-20240307", "claude", "byok"
        );
        expect(recipeData.image).toBe("https://example.com/img.jpg");
    });

    it("throws when the LLM returns an error field", async () => {
        vi.mocked(llmClientModule.callLlm).mockResolvedValue({
            content: [{ type: "text", text: JSON.stringify({ error: "No recipe found on this page." }) }],
        } as any);

        await expect(
            parserModule.extractRecipe(baseExtraction, "sk-ant-key", "claude-3-5-haiku-20241022", "claude", "byok")
        ).rejects.toThrow("No recipe found");
    });

    it("throws when the LLM returns a recipe with no ingredients", async () => {
        vi.mocked(llmClientModule.callLlm).mockResolvedValue({
            content: [{ type: "text", text: JSON.stringify({ ...byokRecipeJson, ingredients: [] }) }],
        } as any);

        await expect(
            parserModule.extractRecipe(baseExtraction, "sk-ant-key", "claude-3-5-haiku-20241022", "claude", "byok")
        ).rejects.toThrow("No recipe found");
    });

    it("builds correct user prompt for default (full-page) source", async () => {
        vi.mocked(llmClientModule.callLlm).mockResolvedValue({
            content: [{ type: "text", text: JSON.stringify(byokRecipeJson) }],
        } as any);

        const fullPageExtraction: ExtractionResult = {
            url: "https://example.com/pasta",
            title: "Pasta",
            source: "full-page",
            textContent: "Full page text here.",
        };

        await parserModule.extractRecipe(fullPageExtraction, "sk-key", "claude-3-5-haiku-20241022", "claude", "byok");

        const callArgs = vi.mocked(llmClientModule.callLlm).mock.calls[0][0];
        const bodyStr = JSON.stringify(callArgs.body);
        expect(bodyStr).toContain("Full page text here.");
        expect(bodyStr).toContain("CONTENT START");
    });
});
