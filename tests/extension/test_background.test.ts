/**
 * Tests for pure logic extracted from src/background.ts.
 *
 * Since background.ts is a service worker with many Chrome-API-dependent
 * functions, we test the extractable pure functions: normalizeUrl and
 * isTokenExpired. These are not exported, so we replicate them here
 * (testing the logic, not the import — avoids importing the whole
 * service worker which triggers Chrome API calls at module scope).
 */

import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Replicated pure functions from background.ts
// (These are private to the module, so we copy the implementations
//  here to test the logic in isolation.)
// ---------------------------------------------------------------------------

/** Strips trailing slash from a URL. */
function normalizeUrl(url: string): string {
    return url.replace(/\/$/, "");
}

/**
 * Parses a JWT payload and checks if it is expired or within
 * `bufferMinutes` of expiring.
 */
function isTokenExpired(token: string, bufferMinutes: number = 5): boolean {
    try {
        const payloadBase64Url = token.split(".")[1];
        if (!payloadBase64Url) return true;

        const payloadBase64 = payloadBase64Url
            .replace(/-/g, "+")
            .replace(/_/g, "/");
        const jsonPayload = decodeURIComponent(
            atob(payloadBase64)
                .split("")
                .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
                .join("")
        );

        const decoded = JSON.parse(jsonPayload);
        if (!decoded.exp) return true;

        const expiresAt = decoded.exp * 1000;
        const now = Date.now();
        const bufferMs = bufferMinutes * 60 * 1000;

        return now >= expiresAt - bufferMs;
    } catch {
        return true; // Assume expired if we can't parse it
    }
}

/** Builds a minimal JWT with the given payload (no real signature). */
function buildFakeJwt(payload: Record<string, unknown>): string {
    const header = btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }));
    const body = btoa(JSON.stringify(payload));
    return `${header}.${body}.fake-signature`;
}

// ---------------------------------------------------------------------------
// normalizeUrl
// ---------------------------------------------------------------------------

describe("normalizeUrl", () => {
    it("strips a trailing slash", () => {
        expect(normalizeUrl("https://example.com/")).toBe(
            "https://example.com"
        );
    });

    it("does nothing when there is no trailing slash", () => {
        expect(normalizeUrl("https://example.com")).toBe(
            "https://example.com"
        );
    });

    it("handles an empty string", () => {
        expect(normalizeUrl("")).toBe("");
    });

    it("only strips the last slash (path preserved)", () => {
        expect(normalizeUrl("https://example.com/path/to/page/")).toBe(
            "https://example.com/path/to/page"
        );
    });

    it("strips a trailing slash even if it follows a query string", () => {
        // The regex strips any final `/` in the string, including in query params
        expect(normalizeUrl("https://example.com/page?q=/")).toBe(
            "https://example.com/page?q="
        );
    });
});

// ---------------------------------------------------------------------------
// isTokenExpired
// ---------------------------------------------------------------------------

describe("isTokenExpired", () => {
    it("returns false for a fresh token (expires far in the future)", () => {
        const futureExp = Math.floor(Date.now() / 1000) + 3600; // +1 hour
        const token = buildFakeJwt({ sub: "user-1", exp: futureExp });
        expect(isTokenExpired(token)).toBe(false);
    });

    it("returns true for an expired token", () => {
        const pastExp = Math.floor(Date.now() / 1000) - 3600; // -1 hour
        const token = buildFakeJwt({ sub: "user-1", exp: pastExp });
        expect(isTokenExpired(token)).toBe(true);
    });

    it("returns true when token is within the buffer window", () => {
        // Expires in 3 minutes, but buffer is 5 minutes
        const soonExp = Math.floor(Date.now() / 1000) + 180;
        const token = buildFakeJwt({ sub: "user-1", exp: soonExp });
        expect(isTokenExpired(token, 5)).toBe(true);
    });

    it("returns false when token is just outside the buffer window", () => {
        // Expires in 10 minutes, buffer is 5 minutes → still valid
        const laterExp = Math.floor(Date.now() / 1000) + 600;
        const token = buildFakeJwt({ sub: "user-1", exp: laterExp });
        expect(isTokenExpired(token, 5)).toBe(false);
    });

    it("returns true for a malformed token (no dots)", () => {
        expect(isTokenExpired("not-a-jwt")).toBe(true);
    });

    it("returns true for a token with missing payload", () => {
        expect(isTokenExpired("header..signature")).toBe(true);
    });

    it("returns true when exp claim is missing", () => {
        const token = buildFakeJwt({ sub: "user-1" }); // no exp
        expect(isTokenExpired(token)).toBe(true);
    });

    it("returns true for an empty string", () => {
        expect(isTokenExpired("")).toBe(true);
    });

    it("uses default buffer of 5 minutes", () => {
        // Expires in exactly 4 minutes — should be within default 5-min buffer
        const soonExp = Math.floor(Date.now() / 1000) + 240;
        const token = buildFakeJwt({ sub: "user-1", exp: soonExp });
        expect(isTokenExpired(token)).toBe(true); // default 5 min buffer
    });

    it("handles a zero buffer", () => {
        // Expires in 1 minute with 0 buffer → should be valid
        const exp = Math.floor(Date.now() / 1000) + 60;
        const token = buildFakeJwt({ sub: "user-1", exp });
        expect(isTokenExpired(token, 0)).toBe(false);
    });
});
