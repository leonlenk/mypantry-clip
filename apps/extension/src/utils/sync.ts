/**
 * sync.ts — Cloud sync utilities for the MyPantry extension.
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
    console.log(`[Sync:auth] llmProvider=${data.llmProvider ?? "(unset)"} | token=${data.supabaseToken ? "present" : "MISSING"}`);
    // Only OAuth users (`google` provider) have a Supabase JWT.
    if (data.llmProvider !== "google") {
        console.log(`[Sync:auth] Skipping — not a google-provider session (llmProvider=${data.llmProvider}).`);
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
    console.log(`[Sync] syncRecipeToCloud called for '${recipe.id}'`);
    const token = await getAccessToken();
    if (!token) {
        console.log(`[Sync] No token — aborting cloud save for '${recipe.id}'.`);
        return;
    }

    const apiBase = await getApiBase();
    const url = `${apiBase}/sync/save`;

    // Strip the embedding before sending — the cloud schema has no vector column.
    const { embedding: _embedding, ...recipeWithoutEmbedding } = recipe;

    console.log(`[Sync] Saving recipe '${recipe.id}' → POST ${url}`);

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
        } else {
            console.log(`[Sync] Recipe '${recipe.id}' synced to cloud.`);
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
    console.log(`[Sync] syncBatchToCloud called for ${recipes.length} recipes`);
    if (recipes.length === 0) return;

    const token = await getAccessToken();
    if (!token) {
        console.log(`[Sync] No token — aborting cloud batch save.`);
        return;
    }

    const apiBase = await getApiBase();
    const url = `${apiBase}/sync/import`;

    // Strip embeddings before sending
    const recipesWithoutEmbeddings = recipes.map(r => {
        const { embedding: _embedding, ...rest } = r;
        return rest;
    });

    console.log(`[Sync] Batch saving ${recipes.length} recipes → POST ${url}`);

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
        } else {
            console.log(`[Sync] ${recipes.length} recipes batch-synced to cloud.`);
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

    console.log(`[Sync] Deleting recipe '${recipeId}' → DELETE ${url}`);

    try {
        const res = await fetch(url, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
            const text = await res.text().catch(() => res.status.toString());
            console.warn(`[Sync] Cloud delete failed (${res.status}):`, text);
        } else {
            console.log(`[Sync] Recipe '${recipeId}' deleted from cloud.`);
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

    console.log(`[Sync] Fetching cloud recipes${since ? ` since ${since}` : " (full sync)"}`);

    try {
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
            console.warn(`[Sync] Cloud list failed (${res.status})`);
            return [];
        }

        const data: { recipes: { id: string; recipe_json: Recipe; updated_at: string }[] } =
            await res.json();

        const recipes = (data.recipes ?? []).map((row) => row.recipe_json);
        console.log(`[Sync] Received ${recipes.length} recipe(s) from cloud.`);
        return recipes;
    } catch (err) {
        console.warn("[Sync] Cloud list network error:", err);
        return [];
    }
}
