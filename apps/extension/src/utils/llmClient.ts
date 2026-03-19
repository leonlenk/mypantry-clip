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
                "X-Title": "Pantry Clip",
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
        return result.choices?.[0]?.message?.content || "";
    }
    if (provider === "google") {
        return result.candidates?.[0]?.content?.parts?.[0]?.text || "";
    }
    return result.content?.[0]?.text || "";
}

/** Extracts and parses the first JSON object found in a text string. */
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
