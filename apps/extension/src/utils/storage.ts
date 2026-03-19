/**
 * storage.ts — Centralized browser-storage schema and typed accessors.
 *
 * All browser-storage interactions in the extension go through this module:
 *   • chrome.storage.local   — persistent settings, auth tokens, URL cache
 *   • chrome.storage.session — in-flight extraction state (cleared on browser close)
 *   • localStorage (DOM)     — pantry/recipe UI preferences (keys via LS constant)
 *
 * To add a new stored value: add it to the relevant interface below, then
 * access it via getLocal / setLocal / removeLocal / getSession / setSession.
 * No raw string keys needed anywhere else.
 */

declare const chrome: any;

// ── chrome.storage.local schema ───────────────────────────────────────────────

/** All keys persisted in chrome.storage.local. */
export interface LocalStorage {
    // Setup & identity
    setupComplete: boolean;
    identityMode: "google" | "anonymous";
    apiMode: "cloud" | "byok";

    // Supabase credentials (cloud / Google OAuth mode only)
    supabaseToken: string;
    supabaseRefreshToken: string;
    supabaseUrl: string;
    supabaseAnonKey: string;

    // LLM configuration
    llmProvider: "google" | "claude" | "openai" | "openrouter";
    llmModel: string;
    /** Plaintext BYOK API key supplied by the user */
    plaintextApiKey: string | null;

    // Runtime config
    apiUrl: string;
    lastSyncAt: string;
    /** Cache of recipe source URLs already saved — used for the "Already Saved" badge */
    savedUrls: string[];
}

export type LocalKey = keyof LocalStorage;

// ── chrome.storage.session schema ─────────────────────────────────────────────

export interface ExtractionState {
    status: string;
    tabId: number;
    title?: string;
}

/** All keys in chrome.storage.session (auto-cleared when the browser closes). */
export interface SessionStorage {
    /** Maps normalised recipe URLs → their current extraction status. */
    activeExtractions: Record<string, ExtractionState>;
    /** URLs for which extraction was cancelled by the user. */
    cancelledExtractions: string[];
}

export type SessionKey = keyof SessionStorage;

// ── DOM localStorage keys ─────────────────────────────────────────────────────

/** String keys for window.localStorage (UI preferences only). */
export const LS = {
    pantryFilter: "pantryFilter",
    pantryViewMode: "pantryViewMode",
    pantryTagFilters: "pantryTagFilters",
    /** @deprecated superseded by pantryTagFilters (kept for backward-compat read) */
    pantryTagFilter: "pantryTagFilter",
    preferredUnitSystem: "preferredUnitSystem",
} as const;

// ── Typed accessors: chrome.storage.local ─────────────────────────────────────

export function getLocal<K extends LocalKey>(keys: K[]): Promise<Pick<LocalStorage, K>> {
    return chrome.storage.local.get(keys) as Promise<Pick<LocalStorage, K>>;
}

export function setLocal(data: Partial<LocalStorage>): Promise<void> {
    return chrome.storage.local.set(data);
}

export function removeLocal(keys: LocalKey | LocalKey[]): Promise<void> {
    return chrome.storage.local.remove(keys as string | string[]);
}

/**
 * The set of local-storage keys that constitute an auth session.
 * Clearing these logs the user out.
 */
export const AUTH_KEYS: LocalKey[] = [
    "setupComplete",
    "plaintextApiKey",
    "supabaseToken",
    "supabaseRefreshToken",
    "llmProvider",
    "llmModel",
    "identityMode",
    "apiMode",
];

// ── Typed accessors: chrome.storage.session ───────────────────────────────────

export function getSession<K extends SessionKey>(keys: K | K[]): Promise<Pick<SessionStorage, K>> {
    return chrome.storage.session.get(keys) as Promise<Pick<SessionStorage, K>>;
}

export function setSession(data: Partial<SessionStorage>): Promise<void> {
    return chrome.storage.session.set(data);
}
