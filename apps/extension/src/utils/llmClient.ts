/**
 * Shared BYOK LLM client utilities.
 *
 * Centralises the per-provider request building, fetch-with-timeout,
 * and response-text extraction so extractRecipe and
 * askSubstitution don't duplicate ~80 lines of provider setup.
 */

declare const chrome: any;

import { getLocal } from "./storage";

// ─── Extraction result type ───────────────────────────────────────────────────

/**
 * Discriminated union representing the result of the hybrid DOM extraction.
 *
 * - "json-ld"     → a valid Recipe schema.org object was found; we also try to get targeted DOM text.
 * - "dom-target"  → JSON-LD absent; we successfully found a recipe card container.
 * - "readability" → JSON-LD and recipe card absent; Readability was used after DOM pruning.
 */
export type ExtractionResult =
    | { source: "json-ld"; jsonLd: object; recipeText?: string; url: string; title: string; image?: string }
    | { source: "dom-target"; recipeText: string; url: string; title: string; image?: string }
    | { source: "readability"; title: string; textContent: string; url: string; image?: string };

// ─── API base URL ─────────────────────────────────────────────────────────────

export async function getApiBase(): Promise<string> {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
        return "http://127.0.0.1:8000";
    }
    const data = await getLocal(["apiUrl"]);
    return data.apiUrl ?? "http://127.0.0.1:8000";
}

// ─── BYOK request config ──────────────────────────────────────────────────────

export interface LlmRequestConfig {
    url: string;
    headers: Record<string, string>;
    body: any;
}

/**
 * Builds the URL, headers, and body for a BYOK LLM request.
 * Handles Anthropic, Google (Gemini), OpenAI, and OpenRouter.
 */
export function buildByokRequestConfig(
    provider: string,
    model: string,
    apiKey: string,
    systemPrompt: string,
    userContent: string,
    maxTokens = 8192
): LlmRequestConfig {
    if (provider === "google") {
        return {
            url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            headers: { "Content-Type": "application/json" },
            body: {
                contents: [{ parts: [{ text: `${systemPrompt}\n\n${userContent}` }] }],
                generationConfig: { temperature: 0, responseMimeType: "application/json" },
            },
        };
    }

    if (provider === "openai") {
        return {
            url: "https://api.openai.com/v1/chat/completions",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: {
                model,
                response_format: { type: "json_object" },
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userContent },
                ],
                temperature: 0,
            },
        };
    }

    if (provider === "openrouter") {
        const referer =
            typeof window !== "undefined"
                ? window.location.origin
                : typeof chrome !== "undefined" && chrome.runtime
                    ? chrome.runtime.getURL("")
                    : "https://pantry-clip.extension";
        return {
            url: "https://openrouter.ai/api/v1/chat/completions",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                "HTTP-Referer": referer,
                "X-Title": "MyPantry Clip",
            },
            body: {
                model,
                response_format: { type: "json_object" },
                messages: [{ role: "user", content: `${systemPrompt}\n\n${userContent}` }],
                temperature: 0,
            },
        };
    }

    // Anthropic (default)
    const isOlderClaude =
        model.startsWith("claude-3-haiku") ||
        model.startsWith("claude-3-sonnet") ||
        model.startsWith("claude-3-opus");
    return {
        url: "https://api.anthropic.com/v1/messages",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
        },
        body: {
            model,
            max_tokens: isOlderClaude ? 4096 : maxTokens,
            system: systemPrompt,
            messages: [{ role: "user", content: userContent }],
            temperature: 0,
        },
    };
}

// ─── Fetch with timeout ───────────────────────────────────────────────────────

export async function callLlm(config: LlmRequestConfig, timeoutMs: number): Promise<any> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
        response = await fetch(config.url, {
            method: "POST",
            headers: config.headers,
            body: JSON.stringify(config.body),
            signal: controller.signal,
        });
    } catch (error: any) {
        if (error.name === "AbortError") {
            throw new Error(
                `LLM API request timed out after ${timeoutMs / 1000}s. The page might be too long. Try a faster or smaller model.`
            );
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 401) {
            throw new Error(`Invalid API key (401). Please re-enter your key in API Settings.`);
        }
        throw new Error(`LLM API Error (${response.status}): ${errorText}. Try a different model or provider.`);
    }

    return response.json();
}

// ─── Response parsing helpers ─────────────────────────────────────────────────

/** Extracts the raw text content from a provider-specific LLM result. */
export function extractTextFromResult(result: any, provider: string): string {
    if (result.error) {
        throw new Error(`LLM API Error: ${result.error.message || JSON.stringify(result.error)}`);
    }
    if (provider === "openrouter" || provider === "openai") {
        const text = result.choices?.[0]?.message?.content;
        if (!text) {
            const finishReason = result.choices?.[0]?.finish_reason;
            throw new Error(`LLM returned an empty response${finishReason ? ` (finish_reason: ${finishReason})` : ""}. Try a different model.`);
        }
        return text;
    }
    if (provider === "google") {
        const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
            const finishReason = result.candidates?.[0]?.finishReason;
            throw new Error(`LLM returned an empty response${finishReason ? ` (finish_reason: ${finishReason})` : ""}. The request may have been blocked by safety filters.`);
        }
        return text;
    }
    const text = result.content?.[0]?.text;
    if (!text) {
        const stopReason = result.stop_reason;
        throw new Error(`LLM returned an empty response${stopReason ? ` (stop_reason: ${stopReason})` : ""}. Try a different model.`);
    }
    return text;
}

/** Extracts and parses the first JSON object found in a text string. */
/**
 * Parses a failed cloud API response into a user-friendly error message.
 * Handles 413 (payload too large) and 429 (rate limit) with reset time.
 */
export async function parseCloudApiError(response: Response): Promise<Error> {
    if (response.status === 503) {
        return new Error("The server is busy right now. Please try again in a moment.");
    }
    if (response.status === 413) {
        return new Error(
            "Payload too large. The page content exceeds the limit after cleanup. Try a page with a dedicated recipe card."
        );
    }
    if (response.status === 429) {
        try {
            const body = await response.json();
            const resetAt: number | undefined = body?.detail?.reset_at;
            if (resetAt) {
                const resetDate = new Date(resetAt * 1000);
                const now = Date.now();
                const diffMs = resetAt * 1000 - now;
                let resetStr: string;
                if (diffMs <= 0) {
                    resetStr = "shortly";
                } else if (diffMs < 60 * 60 * 1000) {
                    const mins = Math.ceil(diffMs / 60000);
                    resetStr = `in ${mins} minute${mins === 1 ? "" : "s"}`;
                } else if (diffMs < 24 * 60 * 60 * 1000) {
                    const hrs = Math.ceil(diffMs / 3600000);
                    resetStr = `in ${hrs} hour${hrs === 1 ? "" : "s"}`;
                } else {
                    resetStr = `on ${resetDate.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}`;
                }
                return new Error(`Weekly limit reached. Your quota resets ${resetStr}.`);
            }
        } catch {
            // fall through to generic message
        }
        return new Error("Weekly limit reached. Please try again next week.");
    }
    const errText = await response.text().catch(() => "");
    return new Error(`Cloud API Error (${response.status}): ${errText}`);
}

export function extractJsonObject(text: string): any {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1) {
        throw new Error("No JSON object found in response. Try using a smarter model.");
    }
    const jsonString = text.substring(firstBrace, lastBrace + 1);
    try {
        return JSON.parse(jsonString);
    } catch (parseError: any) {
        throw new Error(
            `LLM returned malformed JSON (length ${jsonString.length}). Error: ${parseError.message}`
        );
    }
}
