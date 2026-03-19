/**
 * Pantry backup import and export handlers.
 */

import feather from "feather-icons";
import { getAllRecipes, importRecipesLocally } from "../../utils/db";
import type { Recipe } from "../../types/recipe";
import { loadRecipes } from "./recipeRenderer";
import { showToast } from "./modals";
import { MSG } from "../../utils/messages";

declare const chrome: any;

export function wireImportExport() {
    // ── Export backup ──────────────────────────────────────────────────────────
    const exportBtn = document.getElementById("export-btn");
    exportBtn?.addEventListener("click", async () => {
        try {
            const recipes = await getAllRecipes();
            const exportRecipes = recipes.map((r) => {
                const { embedding, ...rest } = r;
                return rest;
            });
            const blob = new Blob([JSON.stringify(exportRecipes, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `mypantry_backup_${new Date().toISOString().split("T")[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error("Export failed:", err);
            alert("Failed to export database.");
        }
    });

    // ── Import backup ──────────────────────────────────────────────────────────
    const importBtn = document.getElementById("import-btn") as HTMLButtonElement | null;
    const importFile = document.getElementById("import-file") as HTMLInputElement | null;

    importBtn?.addEventListener("click", () => importFile?.click());

    importFile?.addEventListener("change", async (e: Event) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file || !importBtn) return;

        const originalHtml = importBtn.innerHTML;
        importBtn.disabled = true;
        importBtn.innerHTML = feather.icons["loader"]?.toSvg({ width: 16, height: 16, class: "spin-svg" }) || "";

        try {
            const text = await file.text();
            const recipes = JSON.parse(text);

            if (Array.isArray(recipes)) {
                let embeddedCount = 0;
                // Re-generate embeddings for any recipes that don't have them
                for (const r of recipes) {
                    if (r.embedding) {
                        embeddedCount++;
                        continue;
                    }
                    const embeddingText = [
                        r.title,
                        r.semantic_summary || "",
                        ...(r.ingredients?.map((i: any) => i.item) || []),
                    ].filter(Boolean).join(". ");

                    const embeddingResult = await chrome.runtime.sendMessage({
                        type: MSG.generateEmbedding,
                        text: embeddingText,
                    });
                    if (embeddingResult.success && embeddingResult.embedding) {
                        r.embedding = embeddingResult.embedding;
                        embeddedCount++;
                    }
                }
                await importRecipesLocally(recipes as Recipe[]);
                await loadRecipes();
                importFile.value = "";

                const n = recipes.length;
                const missing = n - embeddedCount;
                const msg = missing > 0
                    ? `Imported ${n} recipe${n !== 1 ? "s" : ""} (${missing} without semantic search — embedding failed).`
                    : `Imported ${n} recipe${n !== 1 ? "s" : ""} successfully.`;
                showToast(msg, missing > 0 ? "info" : "success");
            } else {
                alert("Invalid backup file format. Expected an array of recipes.");
            }
        } catch (err) {
            console.error("Import failed:", err);
            alert("Failed to read backup file. Make sure it is a valid JSON file.");
        } finally {
            importBtn.innerHTML = originalHtml;
            importBtn.disabled = false;
        }
    });
}
