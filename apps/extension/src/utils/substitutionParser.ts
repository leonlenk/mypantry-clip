/**
 * BYOK + cloud substitution request parser.
 *
 * Sends an ingredient-substitution request to the configured LLM
 * (or backend proxy in cloud mode) and returns the structured result.
 */

import type { Recipe } from "../types/recipe";
import { buildByokRequestConfig, callLlm, extractTextFromResult, extractJsonObject, getApiBase, parseCloudApiError } from "./llmClient";

declare const chrome: any;

const SUBSTITUTION_SYSTEM_PROMPT = `
You are an expert culinary AI and food scientist.
The user is asking for ingredient substitution(s) for the provided recipe.
You must perform the following thinking steps:
1. Analyze the chemical role of the target ingredient(s) in the context of the recipe (e.g., moisture, binding, leavening, flavor).
2. Calculate mathematically adjusted substitutions based on the original recipe yields and properties.

CRITICAL INSTRUCTIONS:
- You must output your response as EXACTLY a valid JSON object.
- NO MARKDOWN AT ALL. Do not wrap in \`\`\`json ... \`\`\`.
- Do not use markdown inside the text values.
- DO NOT include parentheses ( ) in the "item" or "preparation" fields.
- Adhere to the following schema for the root object:
{
  "thoughtProcess": "A clear, concise explanation of the chemical role of the target ingredient and why the substitution works. Do not use markdown.",
  "substitutions": [
     {
       "ingredientId": <The exact integer ID from the provided ingredients list that this substitution replaces>,
       "quantity": <Number or null. E.g., 0.25>,
       "unit": <String or null. E.g., "cup", "teaspoon", "g">,
       "item": <String. The core ingredient name. E.g., "applesauce">,
       "preparation": <String or null. E.g., "unsweetened", "melted">,
       "rawText": <String. The full display text. E.g., "1/4 cup unsweetened applesauce">
     }
  ]
}
`;

export type SubstitutionResult = {
    thoughtProcess: string;
    substitutions: Array<{
        ingredientId: number;
        quantity: number | null;
        unit: string | null;
        item: string;
        preparation: string | null;
        rawText: string;
    }>;
};

export async function askSubstitution(
    recipeData: Recipe,
    userPrompt: string,
    apiKey: string,
    model: string,
    provider: string = "anthropic",
    authMode: string = "byok"
): Promise<SubstitutionResult> {
    const mappedIngredients = recipeData.ingredients
        .map((ing, index) => `[ID: ${index}] - ${ing.item} (${ing.rawText})`)
        .join("\n");

    const userContent = `
Recipe Context:
Title: ${recipeData.title}
Yield: ${recipeData.yield ?? recipeData.servings}

Ingredients:
${mappedIngredients}

User Request: ${userPrompt}

Provide the precise JSON response.
`;

    if (authMode === "cloud") {
        const apiBase = await getApiBase();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        try {
            const response = await fetch(`${apiBase}/substitute/`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    recipe_context: recipeData,
                    target_ingredient: userPrompt,
                }),
                signal: controller.signal,
            });

            if (!response.ok) {
                throw await parseCloudApiError(response);
            }

            const cloudData = await response.json();
            const result: SubstitutionResult = {
                thoughtProcess: cloudData.substitution.reasoning,
                substitutions: [
                    {
                        ingredientId: -1,
                        quantity: cloudData.substitution.amount,
                        unit: cloudData.substitution.unit,
                        item: cloudData.substitution.substitution_name,
                        preparation: null,
                        rawText: `${cloudData.substitution.amount} ${cloudData.substitution.unit} ${cloudData.substitution.substitution_name}`,
                    },
                ],
            };

            // Fuzzy-match the ingredient ID if possible
            const targetLower = cloudData.substitution.target_ingredient.toLowerCase();
            const foundIdx = recipeData.ingredients.findIndex(
                (ing) =>
                    ing.item.toLowerCase().includes(targetLower) ||
                    targetLower.includes(ing.item.toLowerCase())
            );
            if (foundIdx !== -1) {
                result.substitutions[0].ingredientId = foundIdx;
            }

            return result;
        } catch (error: any) {
            if (error.name === "AbortError") {
                throw new Error("Cloud API request timed out after 60s.");
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    // BYOK path
    const config = buildByokRequestConfig(provider, model, apiKey, SUBSTITUTION_SYSTEM_PROMPT, userContent, 8192);
    const llmResult = await callLlm(config, 60000);
    const jsonContent = extractTextFromResult(llmResult, provider);

    try {
        const parsed = extractJsonObject(jsonContent);
        if (!parsed.thoughtProcess || !parsed.substitutions || !Array.isArray(parsed.substitutions)) {
            throw new Error("Missing required fields in parsed JSON.");
        }
        return parsed;
    } catch (error) {
        console.error("Failed to parse LLM substitution response:", jsonContent);
        throw new Error("LLM returned malformed JSON");
    }
}
