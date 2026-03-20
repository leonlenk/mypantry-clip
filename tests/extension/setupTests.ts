/**
 * Global test setup for extension tests.
 *
 * Stubs all Chrome extension APIs used by the source code so tests
 * can run in a plain Node/jsdom environment without a real browser.
 */
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Chrome API stubs
// ---------------------------------------------------------------------------

const storageData: Record<string, unknown> = {};

const chromeStorageLocal = {
    get: vi.fn(async (keys?: string | string[] | Record<string, unknown>) => {
        if (!keys) return { ...storageData };
        if (typeof keys === "string") return { [keys]: storageData[keys] };
        if (Array.isArray(keys)) {
            const result: Record<string, unknown> = {};
            for (const k of keys) result[k] = storageData[k];
            return result;
        }
        // keys is a defaults object
        const result: Record<string, unknown> = {};
        for (const k of Object.keys(keys)) {
            result[k] = storageData[k] ?? keys[k];
        }
        return result;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(storageData, items);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) delete storageData[k];
    }),
};

const sessionData: Record<string, unknown> = {};

const chromeStorageSession = {
    get: vi.fn(async (keys?: string | string[]) => {
        if (!keys) return { ...sessionData };
        if (typeof keys === "string") return { [keys]: sessionData[keys] };
        const result: Record<string, unknown> = {};
        for (const k of Array.isArray(keys) ? keys : [keys]) result[k] = sessionData[k];
        return result;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(sessionData, items);
    }),
};

const chromeRuntime = {
    sendMessage: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    getURL: vi.fn((path: string) => `chrome-extension://fake-id/${path}`),
};

const chromeAction = {
    setBadgeText: vi.fn().mockResolvedValue(undefined),
    setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
};

const chromeTabs = {
    create: vi.fn(),
    remove: vi.fn(),
    query: vi.fn(async () => []),
};

// Assign to globalThis so extension code can reference `chrome.*`
Object.defineProperty(globalThis, "chrome", {
    value: {
        storage: { local: chromeStorageLocal, session: chromeStorageSession },
        runtime: chromeRuntime,
        tabs: chromeTabs,
        action: chromeAction,
    },
    writable: true,
    configurable: true,
});

// ---------------------------------------------------------------------------
// Web Crypto polyfill — jsdom doesn't provide window.crypto.subtle.
// Node ≥ 20 has webcrypto on globalThis.crypto, but window.crypto may be
// missing or incomplete in jsdom. We bridge it here.
// ---------------------------------------------------------------------------

import { webcrypto } from "node:crypto";

if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.subtle) {
    Object.defineProperty(globalThis, "crypto", {
        value: webcrypto,
        writable: true,
        configurable: true,
    });
}

// Also ensure window.crypto is set (crypto.ts uses window.crypto.subtle)
if (typeof window !== "undefined") {
    Object.defineProperty(window, "crypto", {
        value: globalThis.crypto,
        writable: true,
        configurable: true,
    });
}

// ---------------------------------------------------------------------------
// Expose a helper to reset the mock storage between tests
// ---------------------------------------------------------------------------

export function resetChromeStorage() {
    for (const key of Object.keys(storageData)) delete storageData[key];
    for (const key of Object.keys(sessionData)) delete sessionData[key];
    chromeStorageLocal.get.mockClear();
    chromeStorageLocal.set.mockClear();
    chromeStorageLocal.remove.mockClear();
    chromeStorageSession.get.mockClear();
    chromeStorageSession.set.mockClear();
    chromeAction.setBadgeText.mockClear();
    chromeAction.setBadgeBackgroundColor.mockClear();
    chromeRuntime.sendMessage.mockClear();
}

export function setChromeStorageData(data: Record<string, unknown>) {
    Object.assign(storageData, data);
}

export { chromeStorageLocal, chromeStorageSession, chromeRuntime, chromeTabs, chromeAction };
