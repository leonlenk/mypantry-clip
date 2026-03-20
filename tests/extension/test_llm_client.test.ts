/**
 * Tests for src/utils/llmClient.ts — shared BYOK LLM client utilities.
 *
 * Covers: extractTextFromResult empty-response handling across providers,
 * error field propagation, and extractJsonObject parse-error details.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
    extractTextFromResult,
    extractJsonObject,
    buildByokRequestConfig,
    callLlm,
    parseCloudApiError,
} from "../../apps/extension/src/utils/llmClient";

afterEach(() => {
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// extractTextFromResult — happy paths
// ---------------------------------------------------------------------------

describe("extractTextFromResult — happy paths", () => {
    it("returns text for openai provider", () => {
        const result = { choices: [{ message: { content: "hello" }, finish_reason: "stop" }] };
        expect(extractTextFromResult(result, "openai")).toBe("hello");
    });

    it("returns text for openrouter provider", () => {
        const result = { choices: [{ message: { content: "world" }, finish_reason: "stop" }] };
        expect(extractTextFromResult(result, "openrouter")).toBe("world");
    });

    it("returns text for google provider", () => {
        const result = { candidates: [{ content: { parts: [{ text: "gemini response" }] }, finishReason: "STOP" }] };
        expect(extractTextFromResult(result, "google")).toBe("gemini response");
    });

    it("returns text for anthropic provider (default)", () => {
        const result = { content: [{ text: "claude response" }], stop_reason: "end_turn" };
        expect(extractTextFromResult(result, "anthropic")).toBe("claude response");
    });
});

// ---------------------------------------------------------------------------
// extractTextFromResult — result.error field
// ---------------------------------------------------------------------------

describe("extractTextFromResult — result.error propagation", () => {
    it("throws with message when result.error has a message field", () => {
        const result = { error: { message: "Invalid API key", code: 401 } };
        expect(() => extractTextFromResult(result, "openai")).toThrow("Invalid API key");
    });

    it("throws with JSON when result.error has no message field", () => {
        const result = { error: { code: 500 } };
        expect(() => extractTextFromResult(result, "openai")).toThrow("LLM API Error:");
    });
});

// ---------------------------------------------------------------------------
// extractTextFromResult — empty response (safety blocks / finish_reason)
// ---------------------------------------------------------------------------

describe("extractTextFromResult — empty response throws", () => {
    it("throws for openai with finish_reason in message", () => {
        const result = { choices: [{ message: { content: null }, finish_reason: "content_filter" }] };
        expect(() => extractTextFromResult(result, "openai"))
            .toThrow("finish_reason: content_filter");
    });

    it("throws for openrouter with finish_reason in message", () => {
        const result = { choices: [{ message: { content: "" }, finish_reason: "length" }] };
        expect(() => extractTextFromResult(result, "openrouter"))
            .toThrow("finish_reason: length");
    });

    it("throws for openai without finish_reason (graceful fallback)", () => {
        const result = { choices: [{ message: { content: undefined } }] };
        expect(() => extractTextFromResult(result, "openai"))
            .toThrow("LLM returned an empty response");
    });

    it("throws for google with finishReason in message (safety block)", () => {
        const result = { candidates: [{ content: null, finishReason: "SAFETY" }] };
        expect(() => extractTextFromResult(result, "google"))
            .toThrow("finish_reason: SAFETY");
    });

    it("throws for google mentioning safety filters when no finishReason", () => {
        const result = { candidates: [{ content: { parts: [{ text: "" }] } }] };
        expect(() => extractTextFromResult(result, "google"))
            .toThrow("safety filters");
    });

    it("throws for google when candidates is empty", () => {
        const result = { candidates: [] };
        expect(() => extractTextFromResult(result, "google"))
            .toThrow("LLM returned an empty response");
    });

    it("throws for anthropic with stop_reason in message", () => {
        const result = { content: [{ text: "" }], stop_reason: "max_tokens" };
        expect(() => extractTextFromResult(result, "anthropic"))
            .toThrow("stop_reason: max_tokens");
    });

    it("throws for anthropic when content array is empty", () => {
        const result = { content: [], stop_reason: "end_turn" };
        expect(() => extractTextFromResult(result, "anthropic"))
            .toThrow("LLM returned an empty response");
    });
});

// ---------------------------------------------------------------------------
// extractJsonObject — parse error detail preservation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// buildByokRequestConfig — all four providers
// ---------------------------------------------------------------------------

describe("buildByokRequestConfig — google", () => {
    it("builds a URL with the API key as query param", () => {
        const config = buildByokRequestConfig("google", "gemini-2.0-flash", "gkey", "sys", "user");
        expect(config.url).toContain("googleapis.com");
        expect(config.url).toContain("gkey");
        expect(config.headers["Content-Type"]).toBe("application/json");
        expect(config.body.contents[0].parts[0].text).toContain("sys");
        expect(config.body.generationConfig.responseMimeType).toBe("application/json");
    });
});

describe("buildByokRequestConfig — openai", () => {
    it("builds an OpenAI chat completions request", () => {
        const config = buildByokRequestConfig("openai", "gpt-4o", "sk-openai", "sys", "user");
        expect(config.url).toContain("openai.com");
        expect(config.headers["Authorization"]).toBe("Bearer sk-openai");
        expect(config.body.messages[0].role).toBe("system");
        expect(config.body.messages[0].content).toBe("sys");
        expect(config.body.response_format.type).toBe("json_object");
    });
});

describe("buildByokRequestConfig — openrouter", () => {
    it("builds an OpenRouter request with required headers", () => {
        const config = buildByokRequestConfig("openrouter", "some/model", "sk-or", "sys", "user");
        expect(config.url).toContain("openrouter.ai");
        expect(config.headers["Authorization"]).toBe("Bearer sk-or");
        expect(config.headers["X-Title"]).toBe("Pantry Clip");
        expect(config.body.messages[0].role).toBe("user");
    });
});

describe("buildByokRequestConfig — anthropic (default)", () => {
    it("builds an Anthropic messages request", () => {
        const config = buildByokRequestConfig("anthropic", "claude-3-5-sonnet-20241022", "sk-ant", "sys", "user");
        expect(config.url).toContain("anthropic.com");
        expect(config.headers["x-api-key"]).toBe("sk-ant");
        expect(config.body.system).toBe("sys");
        expect(config.body.max_tokens).toBe(8192);
    });

    it("caps max_tokens at 4096 for older claude-3 models", () => {
        const config = buildByokRequestConfig("anthropic", "claude-3-haiku-20240307", "sk-ant", "sys", "user", 8192);
        expect(config.body.max_tokens).toBe(4096);
    });

    it("uses provided maxTokens for current models", () => {
        const config = buildByokRequestConfig("anthropic", "claude-sonnet-4-5", "sk-ant", "sys", "user", 16384);
        expect(config.body.max_tokens).toBe(16384);
    });
});

// ---------------------------------------------------------------------------
// callLlm — fetch wrapper
// ---------------------------------------------------------------------------

describe("callLlm — happy path", () => {
    it("returns parsed JSON on a successful response", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ content: [{ text: "hello" }] }),
        }));

        const config = { url: "https://api.example.com", headers: {}, body: {} };
        const result = await callLlm(config, 5000);
        expect(result.content[0].text).toBe("hello");
    });
});

describe("callLlm — 401 error", () => {
    it("throws an 'Invalid API key' error on 401", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            text: async () => "Unauthorized",
        }));

        const config = { url: "https://api.example.com", headers: {}, body: {} };
        await expect(callLlm(config, 5000)).rejects.toThrow("Invalid API key (401)");
    });
});

describe("callLlm — non-ok status", () => {
    it("throws an error with the status code and body for other errors", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            text: async () => "Internal Server Error",
        }));

        const config = { url: "https://api.example.com", headers: {}, body: {} };
        await expect(callLlm(config, 5000)).rejects.toThrow("LLM API Error (500)");
    });
});

describe("callLlm — timeout/abort", () => {
    it("throws a timeout error when AbortController fires", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" })));

        const config = { url: "https://api.example.com", headers: {}, body: {} };
        await expect(callLlm(config, 1)).rejects.toThrow("timed out");
    });

    it("re-throws non-abort fetch errors", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network failure")));

        const config = { url: "https://api.example.com", headers: {}, body: {} };
        await expect(callLlm(config, 5000)).rejects.toThrow("network failure");
    });
});

// ---------------------------------------------------------------------------
// parseCloudApiError — all status branches
// ---------------------------------------------------------------------------

describe("parseCloudApiError", () => {
    it("returns a server-busy message for 503", async () => {
        const resp = { status: 503 } as Response;
        const err = await parseCloudApiError(resp);
        expect(err.message).toContain("busy");
    });

    it("returns a payload-too-large message for 413", async () => {
        const resp = { status: 413 } as Response;
        const err = await parseCloudApiError(resp);
        expect(err.message).toContain("too large");
    });

    it("returns a rate-limit message with reset time for 429 with reset_at", async () => {
        const resetAt = Math.floor(Date.now() / 1000) + 10 * 60; // 10 min from now
        const resp = {
            status: 429,
            json: async () => ({ detail: { reset_at: resetAt } }),
        } as unknown as Response;
        const err = await parseCloudApiError(resp);
        expect(err.message).toContain("minute");
    });

    it("returns a generic rate-limit message for 429 without reset_at", async () => {
        const resp = {
            status: 429,
            json: async () => ({ detail: {} }),
        } as unknown as Response;
        const err = await parseCloudApiError(resp);
        expect(err.message).toContain("limit reached");
    });

    it("returns a generic rate-limit message for 429 when json() throws", async () => {
        const resp = {
            status: 429,
            json: async () => { throw new Error("not json"); },
        } as unknown as Response;
        const err = await parseCloudApiError(resp);
        expect(err.message).toContain("limit reached");
    });

    it("returns hours message for reset_at more than 1h away", async () => {
        const resetAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60; // 2 hours
        const resp = {
            status: 429,
            json: async () => ({ detail: { reset_at: resetAt } }),
        } as unknown as Response;
        const err = await parseCloudApiError(resp);
        expect(err.message).toContain("hour");
    });

    it("returns a day-of-week message for reset_at more than 24h away", async () => {
        const resetAt = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60; // 2 days
        const resp = {
            status: 429,
            json: async () => ({ detail: { reset_at: resetAt } }),
        } as unknown as Response;
        const err = await parseCloudApiError(resp);
        // "on Monday" or similar — just check it doesn't say "minute" or "hour"
        expect(err.message).toMatch(/on [A-Z]/);
    });

    it("returns a message with reset_at = 'shortly' for past/zero reset time", async () => {
        const resetAt = Math.floor(Date.now() / 1000) - 60; // already past
        const resp = {
            status: 429,
            json: async () => ({ detail: { reset_at: resetAt } }),
        } as unknown as Response;
        const err = await parseCloudApiError(resp);
        expect(err.message).toContain("shortly");
    });

    it("returns a generic error for other status codes", async () => {
        const resp = {
            status: 422,
            text: async () => "Unprocessable Entity",
        } as unknown as Response;
        const err = await parseCloudApiError(resp);
        expect(err.message).toContain("422");
    });
});

describe("extractJsonObject — error detail", () => {
    it("throws with length info when JSON is syntactically invalid", () => {
        const badJson = '{"key": "value", broken}';
        expect(() => extractJsonObject(badJson)).toThrow(/length \d+/);
    });

    it("throws 'No JSON object found' when input has no braces", () => {
        expect(() => extractJsonObject("plain text")).toThrow("No JSON object found");
    });

    it("returns parsed object for valid JSON", () => {
        const result = extractJsonObject('prefix {"title": "Pancakes"} suffix');
        expect(result).toEqual({ title: "Pancakes" });
    });

    it("includes the parse error message in the thrown error", () => {
        const badJson = '{"a": undefined}'; // undefined is not valid JSON
        expect(() => extractJsonObject(badJson)).toThrow("Error:");
    });
});
