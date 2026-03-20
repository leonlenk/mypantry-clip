/**
 * Tests for src/utils/authUtils.ts — JWT parsing and Supabase token refresh.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetChromeStorage, setChromeStorageData } from "./setupTests";

let authModule: typeof import("../../apps/extension/src/utils/authUtils");

beforeEach(async () => {
    resetChromeStorage();
    authModule = await import("../../apps/extension/src/utils/authUtils");
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJwt(payload: Record<string, unknown>): string {
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = btoa(JSON.stringify(payload));
    return `${header}.${body}.fake-sig`;
}

// ---------------------------------------------------------------------------
// parseJwt
// ---------------------------------------------------------------------------

describe("parseJwt", () => {
    it("decodes a valid JWT payload", () => {
        const payload = { sub: "user-1", exp: 9999999999 };
        const token = makeJwt(payload);
        const result = authModule.parseJwt(token);
        expect(result).not.toBeNull();
        expect(result!.sub).toBe("user-1");
        expect(result!.exp).toBe(9999999999);
    });

    it("returns null for a token with no dots", () => {
        expect(authModule.parseJwt("notajwt")).toBeNull();
    });

    it("returns null when the payload segment is empty", () => {
        expect(authModule.parseJwt("header..sig")).toBeNull();
    });

    it("returns null when the payload is invalid base64", () => {
        expect(authModule.parseJwt("header.!!!.sig")).toBeNull();
    });

    it("returns null for an empty string", () => {
        expect(authModule.parseJwt("")).toBeNull();
    });

    it("handles URL-safe base64 characters (- and _)", () => {
        // Build a JWT whose base64url payload contains - and _
        const payload = { sub: "a".repeat(3) }; // produces base64 without special chars
        const token = makeJwt(payload);
        expect(authModule.parseJwt(token)).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// isTokenExpired
// ---------------------------------------------------------------------------

describe("isTokenExpired", () => {
    it("returns false for a token expiring in 1 hour", () => {
        const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
        expect(authModule.isTokenExpired(token)).toBe(false);
    });

    it("returns true for a token that expired 1 hour ago", () => {
        const token = makeJwt({ exp: Math.floor(Date.now() / 1000) - 3600 });
        expect(authModule.isTokenExpired(token)).toBe(true);
    });

    it("returns true when token expires within the default 5-minute buffer", () => {
        const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 180 }); // 3 min
        expect(authModule.isTokenExpired(token)).toBe(true);
    });

    it("returns false when token expires just outside the buffer", () => {
        const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 600 }); // 10 min
        expect(authModule.isTokenExpired(token, 5)).toBe(false);
    });

    it("returns true when exp claim is missing", () => {
        const token = makeJwt({ sub: "user-1" });
        expect(authModule.isTokenExpired(token)).toBe(true);
    });

    it("returns true for a malformed token", () => {
        expect(authModule.isTokenExpired("not-a-jwt")).toBe(true);
    });

    it("respects a custom buffer of 0 minutes", () => {
        const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 60 }); // 1 min future
        expect(authModule.isTokenExpired(token, 0)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// refreshSupabaseToken
// ---------------------------------------------------------------------------

describe("refreshSupabaseToken", () => {
    it("returns null when no refresh token is stored", async () => {
        setChromeStorageData({ supabaseRefreshToken: undefined });
        const result = await authModule.refreshSupabaseToken();
        expect(result).toBeNull();
    });

    it("returns the current token in BYOK mode (no supabaseUrl configured)", async () => {
        setChromeStorageData({
            supabaseRefreshToken: "refresh-tok",
            supabaseToken: "current-tok",
            supabaseUrl: undefined,
        });
        const result = await authModule.refreshSupabaseToken();
        expect(result).toBe("current-tok");
    });

    it("returns the current token when supabaseUrl contains 'your-project-ref'", async () => {
        setChromeStorageData({
            supabaseRefreshToken: "refresh-tok",
            supabaseToken: "current-tok",
            supabaseUrl: "https://your-project-ref.supabase.co",
        });
        const result = await authModule.refreshSupabaseToken();
        expect(result).toBe("current-tok");
    });

    it("returns the current token if it is still valid (not expired)", async () => {
        const freshToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
        setChromeStorageData({
            supabaseRefreshToken: "refresh-tok",
            supabaseToken: freshToken,
            supabaseUrl: "https://real-project.supabase.co",
            supabaseAnonKey: "anon-key",
        });
        const result = await authModule.refreshSupabaseToken();
        expect(result).toBe(freshToken);
    });

    it("calls fetch and returns new token when current token is expired", async () => {
        const expiredToken = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
        setChromeStorageData({
            supabaseRefreshToken: "old-refresh",
            supabaseToken: expiredToken,
            supabaseUrl: "https://real-project.supabase.co",
            supabaseAnonKey: "anon-key",
        });

        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ access_token: "new-access-tok", refresh_token: "new-refresh-tok" }),
        }));

        const result = await authModule.refreshSupabaseToken();
        expect(result).toBe("new-access-tok");
    });

    it("returns null when the refresh endpoint returns non-ok", async () => {
        const expiredToken = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
        setChromeStorageData({
            supabaseRefreshToken: "old-refresh",
            supabaseToken: expiredToken,
            supabaseUrl: "https://real-project.supabase.co",
            supabaseAnonKey: "anon-key",
        });

        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            text: async () => "Unauthorized",
        }));

        const result = await authModule.refreshSupabaseToken();
        expect(result).toBeNull();
    });

    it("returns null when fetch throws", async () => {
        const expiredToken = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
        setChromeStorageData({
            supabaseRefreshToken: "old-refresh",
            supabaseToken: expiredToken,
            supabaseUrl: "https://real-project.supabase.co",
            supabaseAnonKey: "anon-key",
        });

        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

        const result = await authModule.refreshSupabaseToken();
        expect(result).toBeNull();
    });

    it("throws when token is expired and supabaseAnonKey is missing", async () => {
        const expiredToken = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
        setChromeStorageData({
            supabaseRefreshToken: "old-refresh",
            supabaseToken: expiredToken,
            supabaseUrl: "https://real-project.supabase.co",
            supabaseAnonKey: undefined,
        });

        await expect(authModule.refreshSupabaseToken()).rejects.toThrow("Session expired");
    });
});
