/**
 * Recipe extraction from web content.
 *
 * extractRecipeWithClaude handles both cloud mode (FastAPI proxy) and BYOK.
 * Shared LLM infrastructure (request building, fetch, response parsing) lives in llmClient.ts.
 * Substitution logic lives in substitutionParser.ts.
 */

import type { Recipe } from "../types/recipe";
import {
    buildByokRequestConfig,
    callLlm,
    extractTextFromResult,
    extractJsonObject,
    getApiBase,
    parseCloudApiError,
    type ExtractionResult,
} from "./llmClient";

// Re-export for consumers that import ExtractionResult from this module
export type { ExtractionResult } from "./llmClient";

const EXTRACTION_SYSTEM_PROMPT = `
You are an expert culinary AI designed to extract recipe information from web content.
Your task is to parse the provided data and output a STRICT JSON object representing the recipe.
You must adhere EXACTLY to the following TypeScript schema:

interface Recipe {
  id: string; // Generate a unique identifier (e.g., a short hash or slug based on the url)
  url: string; // Source URL
  title: string;
  semantic_summary: string; // 1-2 sentences YOU write, displayed on the recipe card. ALWAYS start with 'savory' or 'sweet', then the course type ('main dish', 'dessert', 'side dish', 'breakfast', 'snack', 'appetizer'). Cover: cuisine type, texture/consistency, vegetable-heavy vs meat-centric, key ingredients, dietary flags. E.g.: "A savory, hearty main dish — Italian-American baked chicken pasta with a golden breadcrumb crust." / "A sweet Japanese-inspired dessert with matcha and caramel custard. Vegetarian, gluten-free."
  author?: string; // If found
  image?: string; // If an image URL is obvious in the text or metadata provided (optional)
  prepTimeMinutes?: number; // Convert to minutes as a number
  cookTimeMinutes?: number; // Convert to minutes as a number
  totalTimeMinutes?: number; // Convert to minutes as a number
  servings: number | null; // The number of servings or yield
  yield?: string; // Descriptive yield if present (e.g., "2 dozen cookies", "1 9-inch pie")
  ingredients: Ingredient[];
  instructions: InstructionStep[];
  nutrition?: {
    calories?: number;
    protein?: string;
    fat?: string;
    carbohydrates?: string;
  };
}

interface Ingredient {
  rawText: string; // The original line text verbatim from the source
  us_amount: number | null; // US volume quantity if present
  us_unit: string | null; // US volume unit if present
  metric_amount: number | null; // Metric weight/volume if present
  metric_unit: string | null; // Metric unit if present
  item: string; // The minimal semantic core ingredient name — strip size/quality adjectives and cooking states. NO parentheses. E.g.: "olive oil" not "extra virgin olive oil", "chicken thighs" not "boneless skinless chicken thighs", "onion" not "large yellow onion". Prep actions go in preparation, alternatives go in subtext.
  preparation?: string; // A cooking action ONLY (e.g. "sifted", "chopped", "melted", "softened"). Omit if none.
  subtext?: string; // Alternative ingredients or minor descriptive context.
  note_references?: number[]; // List of note indexes (1-based) referencing the Recipe's notes array.
  group?: string; // e.g. "Cake", "Frosting", "Crust". Omit or use null if the recipe has no sections.
}

interface InstructionStep {
  stepNumber: number;
  text: string;
  group?: string; // e.g. "Cake", "Frosting", "Crust". Omit or use null if the recipe has no sections.
}

Constraints:
1. ONLY output the valid JSON object. Do not include markdown formatting like \`\`\`json.
2. NO COMMENTS. Do NOT include any // or /* */ comments in the JSON output. JSON does not support comments.
3. NO TRAILING COMMAS. Ensure the JSON is strictly valid.
4. Ensure the JSON is strictly valid.
5. YOU MUST DO YOUR BEST TO EXTRACT QUANTITIES AND UNITS.
6. If a value is unknown, use null or omit optional fields. Do not make up values.
7. EXTREMELY IMPORTANT: If the recipe has multiple components (e.g. "Cake" and "Frosting", or "Crust" and "Filling"), you MUST extract these section names and put them in the "group" field for EVERY corresponding ingredient and instruction. In JSON-LD, this sometimes looks like an ingredient that is just a label (e.g. "For the Cake"). DO NOT miss the sections.
8. NEVER put parentheses ( ) in any field. If the source has parenthetical text like "(Note 1)", extract the intent WITHOUT the parentheses.
9. RECIPE NOTES: If you see "Note 1", "Note 2", etc. mentioned in ingredients:
   a) Search the payload for the actual full text of that note (often at the bottom).
   b) Put the full explanation string in a top-level "notes" array on the recipe object.
   c) Add the 1-based index (e.g., [1]) to the ingredient's "note_references" array.
10. AMOUNTS AND UNITS: If a recipe provides both US and Metric (e.g., "1 cup / 120g", "7oz / 200g"), extract BOTH into their respective us/metric fields.
11. The "preparation" field is ONLY for cooking actions (e.g. "sifted", "chopped", "melted").
12. IF NO RECIPE IS FOUND ON THE PAGE, YOU MUST OUTPUT EXACTLY: { "error": "No recipe found on this page." }
13. EXTREMELY IMPORTANT: Keep \`rawText\` and \`instructions\` concise! DO NOT output excessively verbose descriptions.
14. MINIFY YOUR JSON: Output the JSON exactly as a single continuous line. Do NOT use newlines, indentation, or extra spaces. This saves output tokens and prevents truncation.
15. SEMANTIC SUMMARY: Write a \`semantic_summary\` of 1-2 sentences displayed directly on the recipe card. ALWAYS start with 'savory' or 'sweet', then include the course type ('main dish', 'dessert', 'side dish', 'breakfast', 'snack', 'appetizer', 'drink'). Then cover: cuisine type, texture/consistency (creamy, crispy, soupy, hearty, light, rich), vegetable-heavy vs meat-centric, cooking method, key primary ingredients, AND applicable dietary flags (vegan, vegetarian, gluten-free, dairy-free, contains nuts, high-protein, etc.). Do NOT copy the scraped description. Write original engaging prose. E.g.: "A savory, hearty main dish — Italian-American baked chicken pasta with a golden breadcrumb crust. Comforting and indulgent, ready in under an hour." / "A sweet Japanese-inspired dessert with a vibrant matcha flavour and rich caramel custard base. Vegetarian and gluten-free." / "A light, savory main dish — vegetable-heavy Thai green curry with silken tofu and coconut milk. Vegan, 30 minutes."
`;

/**
 * Sends extracted page content to the LLM and returns a structured Recipe.
 *
 * In cloud mode, proxies through the FastAPI backend.
 * In BYOK mode, calls the configured provider directly using llmClient helpers.
 */
export async function extractRecipe(
    extractedData: ExtractionResult,
    apiKey: string,
    model: string,
    provider: string = "anthropic",
    authMode: string = "byok"
): Promise<{ recipeData: Recipe; payloadCharCount: number }> {
    const { url, title } = extractedData;

    let userPrompt: string;
    if (extractedData.source === "json-ld") {
        userPrompt = `
Here is the structured Recipe schema data extracted from the page:
Title: ${title}
URL: ${url}

--- STRUCTURED RECIPE METADATA START ---
${JSON.stringify(extractedData.jsonLd, null, 2)}
--- STRUCTURED RECIPE METADATA END ---
`;
        if (extractedData.recipeText && extractedData.recipeText.length > 0) {
            userPrompt += `
The author's schema often omits component group names (e.g. "Cake", "Frosting") and full recipe notes. The following is the text extracted from the recipe card.
Extract the recipe into the specified JSON format. CRITICAL: Use the STRUCTURED RECIPE METADATA as the authoritative source for all ingredient quantities, units, and names. Use the RECIPE CARD TEXT below to infer the correct \`group\` names, and to extract full text for any mentioned Recipe Notes.

--- RECIPE CARD TEXT START ---
${extractedData.recipeText}
--- RECIPE CARD TEXT END ---
`;
        } else {
            userPrompt += `
Extract the recipe into the specified JSON format. CRITICAL: Use the structured metadata above as the authoritative source for all ingredient quantities, units, and names.
`;
        }
    } else if (extractedData.source === "dom-target") {
        userPrompt = `
Here is the extracted recipe card text from the page:
Title: ${title}
URL: ${url}

--- RECIPE CARD TEXT START ---
${extractedData.recipeText}
--- RECIPE CARD TEXT END ---

Extract the recipe into the specified JSON format.
`;
    } else {
        userPrompt = `
Here is the extracted text from the page:
Title: ${title}
URL: ${url}

--- CONTENT START ---
${extractedData.textContent}
--- CONTENT END ---

Extract the recipe into the specified JSON format.
`;
    }

    const payloadCharCount = userPrompt.length + EXTRACTION_SYSTEM_PROMPT.length;

    if (authMode === "cloud") {
        const apiBase = await getApiBase();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 180000);

        let payload = "";
        if (extractedData.source === "json-ld") {
            payload = `--- STRUCTURED METADATA ---\n${JSON.stringify(extractedData.jsonLd, null, 2)}\n`;
            if (extractedData.recipeText) {
                payload += `\n--- PAGE TEXT REFERENCE ---\n${extractedData.recipeText}`;
            }
        } else if (extractedData.source === "dom-target") {
            payload = extractedData.recipeText;
        } else {
            payload = (extractedData as any).textContent;
        }

        try {
            const response = await fetch(`${apiBase}/extract/`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({ payload }),
                signal: controller.signal,
            });

            if (!response.ok) {
                if (response.status === 401) {
                    throw new Error("Session expired. Please sign out and sign in again to continue.");
                }
                throw await parseCloudApiError(response);
            }

            const cloudData = await response.json();

            if (cloudData.error) throw new Error(cloudData.error);
            if (!cloudData.recipe?.ingredients?.length) throw new Error("No recipe found on this page.");

            const recipeData: Recipe = {
                id: Math.random().toString(36).substring(7),
                url,
                createdAt: Date.now(),
                title: cloudData.recipe.title,
                semantic_summary: cloudData.recipe.semantic_summary || undefined,
                prepTimeMinutes: cloudData.recipe.prepTime || undefined,
                cookTimeMinutes: cloudData.recipe.cookTime || undefined,
                tags: cloudData.recipe.tags || undefined,
                servings: cloudData.recipe.servings,
                notes: cloudData.recipe.notes || [],
                ingredients: cloudData.recipe.ingredients.map((ing: any) => {
                    const rawTextParts = [
                        ing.us_amount,
                        ing.us_unit,
                        ing.metric_amount ? `(${ing.metric_amount}` : "",
                        ing.metric_unit ? `${ing.metric_unit})` : "",
                        ing.name,
                        ing.preparation ? `, ${ing.preparation}` : "",
                        ing.subtext ? ` (${ing.subtext})` : "",
                    ].filter(Boolean);
                    return {
                        rawText: rawTextParts.join(" ").replace(/\( /g, "(").trim(),
                        us_amount: ing.us_amount,
                        us_unit: ing.us_unit,
                        metric_amount: ing.metric_amount,
                        metric_unit: ing.metric_unit,
                        item: ing.name,
                        preparation: ing.preparation,
                        subtext: ing.subtext,
                        note_references: ing.note_references,
                        group: ing.group,
                    };
                }),
                instructions: cloudData.recipe.instructions.map((text: string, idx: number) => ({
                    stepNumber: idx + 1,
                    text,
                })),
            };
            if (extractedData.image && !recipeData.image) {
                recipeData.image = extractedData.image;
            }
            return { recipeData, payloadCharCount: payload.length };
        } catch (error: any) {
            if (error.name === "AbortError") {
                throw new Error("Cloud API request timed out after 180s.");
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    // BYOK path
    const config = buildByokRequestConfig(provider, model, apiKey, EXTRACTION_SYSTEM_PROMPT, userPrompt, 8192);
    const result = await callLlm(config, 180000);
    const jsonContent = extractTextFromResult(result, provider);
    const parsedData = extractJsonObject(jsonContent);

    if (parsedData.error) throw new Error(parsedData.error);
    if (!parsedData.ingredients?.length) throw new Error("No recipe found on this page.");

    const recipeData: Recipe = parsedData;
    recipeData.createdAt = Date.now();
    if (extractedData.image && !recipeData.image) {
        recipeData.image = extractedData.image;
    }
    return { recipeData, payloadCharCount };
}
