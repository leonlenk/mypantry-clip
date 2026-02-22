import type { Recipe } from "../types/recipe";

const DB_NAME = "recipe-ai";
const DB_VERSION = 1;
const STORE_NAME = "recipes";

/**
 * Opens (and initialises on first run) the IndexedDB database.
 * The `recipes` object store uses `id` (a URL-derived slug) as its keyPath.
 */
function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                // Use the recipe `id` field as the primary key
                db.createObjectStore(STORE_NAME, { keyPath: "id" });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Persists a recipe object (with embedding) to IndexedDB.
 * Uses `put` so re-extracting the same URL simply updates the existing record.
 */
/**
 * Persists a recipe object (with embedding) to IndexedDB
 * and updates the saved URLs cache in chrome.storage.local.
 */
export async function saveRecipeLocally(recipe: Recipe): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const request = store.put(recipe);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
    });

    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local && recipe.url) {
        try {
            const data: Record<string, any> = await chrome.storage.local.get("savedUrls");
            const urls: string[] = Array.isArray(data.savedUrls) ? data.savedUrls : [];
            if (!urls.includes(recipe.url)) {
                urls.push(recipe.url);
                await chrome.storage.local.set({ savedUrls: urls });
            }
        } catch (e) {
            console.warn("Failed to update savedUrls cache", e);
        }
    }
}

/**
 * Retrieves a single recipe by its id from IndexedDB.
 */
export async function getRecipe(id: string): Promise<Recipe | undefined> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(id);
        request.onsuccess = () => resolve(request.result as Recipe | undefined);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
    });
}

/**
 * Retrieves all recipes from IndexedDB.
 */
export async function getAllRecipes(): Promise<Recipe[]> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result as Recipe[]);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
    });
}

/**
 * Deletes a recipe by its id.
 */
/**
 * Deletes a recipe by its id
 * and removes its URL from the chrome.storage.local cache.
 */
export async function deleteRecipe(id: string): Promise<void> {
    // Attempt to get the recipe first so we know its URL
    const recipe = await getRecipe(id);

    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const request = store.delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
    });

    if (recipe && recipe.url && typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        try {
            const data: Record<string, any> = await chrome.storage.local.get("savedUrls");
            let urls: string[] = Array.isArray(data.savedUrls) ? data.savedUrls : [];
            urls = urls.filter(u => u !== recipe.url);
            await chrome.storage.local.set({ savedUrls: urls });
        } catch (e) {
            console.warn("Failed to clear savedUrls cache", e);
        }
    }
}

/**
 * Performs an in-memory cosine similarity search across all recipes.
 * Returns the top-k results sorted by relevance to the query embedding.
 */
export async function searchRecipes(
    queryEmbedding: number[],
    topK = 10
): Promise<Recipe[]> {
    const all = await getAllRecipes();

    const cosine = (a: number[], b: number[]): number => {
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] ** 2;
            normB += b[i] ** 2;
        }
        return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
    };

    return all
        .filter(r => r.embedding && r.embedding.length > 0)
        .map(r => ({ recipe: r, score: cosine(queryEmbedding, r.embedding!) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map(r => r.recipe);
}
