/**
 * sync.ts — Cloud sync utilities for the MyPantry Clip extension.
 *
 * Cloud sync is JSON-only backup/restore. Embeddings are computed client-side,
 * kept in IndexedDB, and are NEVER sent to or returned from the cloud —
 * Supabase is not used for vector search. This keeps the schema simple and
 * avoids any pgvector dependency.
 *
 * All functions silently no-op for BYOK / unauthenticated users.
 * Cloud failures are caught and logged but never thrown — local data is always
 * the source of truth.
 */

import type { Recipe } from "../types/recipe";
import { getLocal } from "./storage";
import { getApiBase } from "./llmClient";

/** Reads the stored access token, returns null for BYOK/unauthenticated users. */
async function getAccessToken(): Promise<string | null> {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
        console.warn("[Sync] chrome.storage.local unavailable — skipping sync.");
        return null;
    }
    const data = await getLocal(["supabaseToken", "llmProvider"]);
    // Only OAuth users (`google` provider) have a Supabase JWT.
    if (data.llmProvider !== "google") {
        return null;
    }
    if (!data.supabaseToken) {
        console.warn("[Sync:auth] llmProvider=google but supabaseToken is missing from storage.");
        return null;
    }
    return data.supabaseToken;
}


/**
 * Upserts a recipe to the cloud backend.
 * The embedding is explicitly excluded — it lives in IndexedDB only.
 */
export async function syncRecipeToCloud(recipe: Recipe): Promise<void> {
    const token = await getAccessToken();
    if (!token) return;

    const apiBase = await getApiBase();
    const url = `${apiBase}/sync/save`;

    // Strip the embedding before sending — the cloud schema has no vector column.
    const { embedding: _embedding, ...recipeWithoutEmbedding } = recipe;

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ recipe: recipeWithoutEmbedding }),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => res.status.toString());
            console.warn(`[Sync] Cloud save failed (${res.status}):`, text);
        }
    } catch (err: any) {
        console.warn(`[Sync] Cloud save network error (url=${url}):`, err?.message ?? err);
    }
}

/**
 * Upserts a batch of recipes to the cloud backend.
 * The embeddings are explicitly excluded.
 */
export async function syncBatchToCloud(recipes: Recipe[]): Promise<void> {
    if (recipes.length === 0) return;

    const token = await getAccessToken();
    if (!token) return;

    const apiBase = await getApiBase();
    const url = `${apiBase}/sync/import`;

    // Strip embeddings before sending
    const recipesWithoutEmbeddings = recipes.map(r => {
        const { embedding: _embedding, ...rest } = r;
        return rest;
    });

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ recipes: recipesWithoutEmbeddings }),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => res.status.toString());
            console.warn(`[Sync] Cloud batch save failed (${res.status}):`, text);
        }
    } catch (err: any) {
        console.warn(`[Sync] Cloud batch save network error (url=${url}):`, err?.message ?? err);
    }
}

/**
 * Deletes a recipe from the cloud backend.
 */
export async function deleteRecipeFromCloud(recipeId: string): Promise<void> {
    const token = await getAccessToken();
    if (!token) return;

    const apiBase = await getApiBase();
    const url = `${apiBase}/sync/delete/${encodeURIComponent(recipeId)}`;

    try {
        const res = await fetch(url, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
            const text = await res.text().catch(() => res.status.toString());
            console.warn(`[Sync] Cloud delete failed (${res.status}):`, text);
        }
    } catch (err: any) {
        console.warn(`[Sync] Cloud delete network error (url=${url}):`, err?.message ?? err);
    }
}

/**
 * Returns the newest `updated_at` ISO timestamp from the cloud (one DB row).
 * Used by the pantry dashboard to cheaply check if cloud is ahead of local.
 * Returns null if the user has no cloud recipes or is not authenticated.
 */
export async function getCloudLatestTimestamp(): Promise<string | null> {
    const token = await getAccessToken();
    if (!token) return null;

    const apiBase = await getApiBase();
    try {
        const res = await fetch(`${apiBase}/sync/latest`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return null;
        const data: { latest_updated_at: string | null } = await res.json();
        return data.latest_updated_at;
    } catch {
        return null;
    }
}

/**
 * Fetches recipes from the cloud updated after `since` (ISO-8601 timestamp).
 * Omit `since` for a full sync (first-time install). For frequent button-triggered
 * polls, pass the stored `lastSyncAt` so only changed recipes are returned.
 */
export async function syncAllFromCloud(since?: string): Promise<Recipe[]> {
    const token = await getAccessToken();
    if (!token) return [];

    const apiBase = await getApiBase();
    const url = since
        ? `${apiBase}/sync/list?since=${encodeURIComponent(since)}`
        : `${apiBase}/sync/list`;

    try {
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
            console.warn(`[Sync] Cloud list failed (${res.status})`);
            return [];
        }

        const data: { recipes: ({ id: string; recipe_json: Recipe; updated_at: string } | { __error: string })[] } =
            await res.json();

        const rows = data.recipes ?? [];
        const errorSentinel = rows.find((r): r is { __error: string } => "__error" in r);
        if (errorSentinel) {
            console.warn("[Sync] Cloud list stream was truncated by a server error:", errorSentinel.__error);
        }
        const recipes = rows
            .filter((r): r is { id: string; recipe_json: Recipe; updated_at: string } => !("__error" in r))
            .map((row) => row.recipe_json);
        return recipes;
    } catch (err) {
        console.warn("[Sync] Cloud list network error:", err);
        return [];
    }
}
