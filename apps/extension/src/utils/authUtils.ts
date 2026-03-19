/**
 * Supabase JWT authentication utilities for the background service worker.
 *
 * - isTokenExpired: checks if a JWT is expired or about to expire
 * - refreshSupabaseToken: silently refreshes the access token via the refresh token
 */

import { getLocal, setLocal } from "./storage";

/** Decodes the payload of a JWT and returns it as a plain object, or null on failure. */
export function parseJwt(token: string): Record<string, any> | null {
    try {
        const payloadBase64Url = token.split(".")[1];
        if (!payloadBase64Url) return null;
        const payloadBase64 = payloadBase64Url.replace(/-/g, "+").replace(/_/g, "/");
        const jsonPayload = decodeURIComponent(
            atob(payloadBase64)
                .split("")
                .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
                .join("")
        );
        return JSON.parse(jsonPayload);
    } catch {
        return null;
    }
}

/** Returns true if the JWT is missing, malformed, or within `bufferMinutes` of expiring. */
export function isTokenExpired(token: string, bufferMinutes: number = 5): boolean {
    const decoded = parseJwt(token);
    if (!decoded?.exp) return true;
    const bufferMs = bufferMinutes * 60 * 1000;
    return Date.now() >= decoded.exp * 1000 - bufferMs;
}

/**
 * Attempts to silently refresh the Supabase access token using the stored refresh token.
 * Persists the new access token to chrome.storage.local on success.
 * Returns the fresh access token, or null if refresh fails.
 */
export async function refreshSupabaseToken(): Promise<string | null> {
    const stored = await getLocal(["supabaseRefreshToken", "supabaseToken", "supabaseUrl", "supabaseAnonKey"]);

    const supabaseUrl = stored.supabaseUrl;
    const supabaseAnonKey = stored.supabaseAnonKey;
    const refreshToken = stored.supabaseRefreshToken as string | undefined;
    const currentToken = stored.supabaseToken as string | undefined;

    if (!refreshToken) {
        console.warn("[Auth] No refresh token stored — user must re-authenticate.");
        return null;
    }

    if (!supabaseUrl || supabaseUrl.includes("your-project-ref")) {
        // BYOK mode — no Supabase configured, skip refresh
        return currentToken ?? null;
    }

    if (currentToken && !isTokenExpired(currentToken)) {
        return currentToken;
    }

    console.log("[Auth] Token is missing or expiring soon. Attempting refresh...");

    if (!supabaseAnonKey) {
        throw new Error("Session expired. Please sign out and sign in again to refresh your credentials.");
    }

    try {
        const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: supabaseAnonKey },
            body: JSON.stringify({ refresh_token: refreshToken }),
        });

        if (!res.ok) {
            console.warn("[Auth] Token refresh failed:", res.status, await res.text());
            return null;
        }

        const data = await res.json();
        const newAccessToken: string = data.access_token;
        const newRefreshToken: string = data.refresh_token;

        if (newAccessToken) {
            await setLocal({
                supabaseToken: newAccessToken,
                supabaseRefreshToken: newRefreshToken ?? refreshToken,
            });
            console.log("[Auth] Token refreshed successfully.");
            return newAccessToken;
        }
    } catch (err) {
        console.warn("[Auth] Token refresh threw:", err);
    }

    return null;
}
