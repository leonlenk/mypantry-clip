import type { Recipe } from "../types/recipe";

// Anthropic constants
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";

/**
 * Discriminated union representing the result of the hybrid DOM extraction.
 *
 * - "json-ld"     → a valid Recipe schema.org object was found; we also try to get targeted DOM text.
 * - "dom-target"  → JSON-LD absent; we successfully found a recipe card container.
 * - "readability" → JSON-LD and recipe card absent; Readability was used after DOM pruning.
 */
export type ExtractionResult =
    | { source: "json-ld"; jsonLd: object; recipeText?: string; url: string; title: string; image?: string }
    | { source: "dom-target"; recipeText: string; url: string; title: string; image?: string }
    | { source: "readability"; title: string; textContent: string; url: string; image?: string };

/**
 * Resolves the backend API base URL from chrome.storage.local,
 * falling back to localhost for local development.
 * Mirrors the same pattern used in sync.ts to keep them in sync.
 */
async function getApiBase(): Promise<string> {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
        return "http://127.0.0.1:8000";
    }
    const data = await chrome.storage.local.get("apiUrl");
    return (data.apiUrl as string | undefined) ?? "http://127.0.0.1:8000";
}

/**
 * Sends the extracted content to the LLM and enforces the strict Recipe JSON schema output.
 *
 * The prompt strategy adapts to the extraction source:
 *   - "json-ld"     → passes the structured object directly; omits the noisy textContent block.
 *   - "readability" → passes the plain text content as before.
 */
export async function extractRecipeWithClaude(
    extractedData: ExtractionResult,
    apiKey: string,
    model: string,
    provider: string = "anthropic",
    authMode: string = "byok"
): Promise<{ recipeData: Recipe, payloadCharCount: number }> {
    const { url, title } = extractedData;

    const systemPrompt = `
You are an expert culinary AI designed to extract recipe information from web content.
Your task is to parse the provided data and output a STRICT JSON object representing the recipe.
You must adhere EXACTLY to the following TypeScript schema:

interface Recipe {
  id: string; // Generate a unique identifier (e.g., a short hash or slug based on the url)
  url: string; // Source URL
  title: string;
  description: string;
  author?: string; // If found
  image?: string; // If an image URL is obvious in the text or metadata provided (optional)
  prepTimeMinutes?: number; // Convert to minutes as a number
  cookTimeMinutes?: number; // Convert to minutes as a number
  totalTimeMinutes?: number; // Convert to minutes as a number
  servings: number | null; // The number of servings or yield
  yield?: string; // Descriptive yield if present (e.g., "2 dozen cookies", "1 9-inch pie")
  ingredients: Ingredient[];
  instructions: InstructionStep[];
  tags?: string[]; // e.g. ["vegan", "dessert", "dinner"]
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
  item: string; // The primary ingredient name ONLY. NO parentheses.
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
`;

    // Build the user prompt based on which extraction path was taken.
    // JSON-LD path: the structured object is high-fidelity; we also provide recipeText if found for grouping.
    // DOM-Target path: pass the targeted card text.
    // Readability path: pass the pruned plain text as before.
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

    const payloadCharCount = userPrompt.length + systemPrompt.length;

    let fetchUrl = "";
    let fetchHeaders: Record<string, string> = {};
    let fetchBody: any = {};

    if (authMode === "cloud") {
        // Cloud Mode: Proxy through our FastAPI backend
        const apiBase = await getApiBase();
        fetchUrl = `${apiBase}/api/extract/`;
        fetchHeaders = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        };
        // For our backend, we send the combined payload
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

        fetchBody = { payload };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000);

        try {
            const response = await fetch(fetchUrl, {
                method: "POST",
                headers: fetchHeaders,
                body: JSON.stringify(fetchBody),
                signal: controller.signal
            });

            if (!response.ok) {
                const errText = await response.text();
                if (response.status === 401) {
                    throw new Error("Session expired. Please sign out and sign in again to continue.");
                }
                if (response.status === 413) {
                    throw new Error(`Payload too large. The page content exceeds 20,000 characters after cleanup. Try a page with a dedicated recipe card.`);
                }
                throw new Error(`Cloud API Error (${response.status}): ${errText}`);
            }

            const cloudData = await response.json();

            if (cloudData.error) {
                throw new Error(cloudData.error);
            }
            if (!cloudData.recipe || !cloudData.recipe.ingredients || cloudData.recipe.ingredients.length === 0) {
                throw new Error("No recipe found on this page.");
            }

            // Map backend Recipe model to extension Recipe model
            // Backend: title, description, prepTime, cookTime, servings, ingredients (name, amount, unit), instructions (strings)
            const recipeData: Recipe = {
                id: Math.random().toString(36).substring(7),
                url,
                createdAt: Date.now(),
                title: cloudData.recipe.title,
                description: cloudData.recipe.description,
                prepTimeMinutes: parseInt(cloudData.recipe.prepTime) || undefined,
                cookTimeMinutes: parseInt(cloudData.recipe.cookTime) || undefined,
                servings: cloudData.recipe.servings,
                notes: cloudData.recipe.notes || [],
                ingredients: cloudData.recipe.ingredients.map((ing: any) => {
                    // Reconstruct a plausible raw text for reference
                    const rawTextParts = [
                        ing.us_amount,
                        ing.us_unit,
                        ing.metric_amount ? `(${ing.metric_amount}` : '',
                        ing.metric_unit ? `${ing.metric_unit})` : '',
                        ing.name,
                        ing.preparation ? `, ${ing.preparation}` : '',
                        ing.subtext ? ` (${ing.subtext})` : ''
                    ].filter(Boolean);

                    return {
                        rawText: rawTextParts.join(" ").replace(/\( /g, '(').trim(),
                        us_amount: ing.us_amount,
                        us_unit: ing.us_unit,
                        metric_amount: ing.metric_amount,
                        metric_unit: ing.metric_unit,
                        item: ing.name,
                        preparation: ing.preparation,
                        subtext: ing.subtext,
                        note_references: ing.note_references,
                        group: ing.group
                    };
                }),
                instructions: cloudData.recipe.instructions.map((text: string, idx: number) => ({
                    stepNumber: idx + 1,
                    text
                }))
            };
            if (extractedData.image && !recipeData.image) {
                recipeData.image = extractedData.image;
            }
            return { recipeData, payloadCharCount: payload.length };
        } catch (error: any) {
            if (error.name === 'AbortError') {
                throw new Error(`Cloud API request timed out after 120s.`);
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    } else if (provider === "google") {
        fetchUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        fetchHeaders = {
            "Content-Type": "application/json"
        };
        fetchBody = {
            contents: [
                { parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }
            ],
            generationConfig: {
                temperature: 0,
                responseMimeType: "application/json"
            }
        };
    } else if (provider === "openai") {
        fetchUrl = "https://api.openai.com/v1/chat/completions";
        fetchHeaders = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        };
        fetchBody = {
            model: model,
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature: 0,
        };
    } else if (provider === "openrouter") {
        fetchUrl = "https://openrouter.ai/api/v1/chat/completions";
        fetchHeaders = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "HTTP-Referer": typeof window !== "undefined" ? window.location.origin : (typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime.getURL("") : "https://pantry-clip.extension"),
            "X-Title": "Pantry Clip"
        };
        fetchBody = {
            model: model,
            response_format: { type: "json_object" },
            messages: [
                { role: "user", content: `${systemPrompt}\n\n${userPrompt}` }
            ],
            temperature: 0,
        };
    } else {
        const isOlderClaude = model.startsWith("claude-3-haiku") || model.startsWith("claude-3-sonnet") || model.startsWith("claude-3-opus");
        fetchUrl = CLAUDE_API_URL;
        fetchHeaders = {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true"
        };
        fetchBody = {
            model: model,
            max_tokens: isOlderClaude ? 4096 : 8192,
            system: systemPrompt,
            messages: [
                { role: "user", content: userPrompt }
            ],
            temperature: 0,
        };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 120 second timeout

    let response;
    try {
        response = await fetch(fetchUrl, {
            method: "POST",
            headers: fetchHeaders,
            body: JSON.stringify(fetchBody),
            signal: controller.signal
        });
    } catch (error: any) {
        if (error.name === 'AbortError') {
            throw new Error(`LLM API request timed out after 120s. The page might be too long. Try a faster or smaller model.`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LLM API Error (${response.status}): ${errorText}. Try a different model or provider.`);
    }

    const result = await response.json();

    if (result.error) {
        throw new Error(`LLM API Error: ${result.error.message || JSON.stringify(result.error)}`);
    }

    let jsonContent = "";

    if (provider === "openrouter" || provider === "openai") {
        jsonContent = result.choices?.[0]?.message?.content || "";
    } else if (provider === "google") {
        jsonContent = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
    } else {
        jsonContent = result.content?.[0]?.text || "";
    }

    try {
        // Defensively extract the JSON object in case the LLM wraps it in markdown fences.
        const firstBrace = jsonContent.indexOf("{");
        const lastBrace = jsonContent.lastIndexOf("}");

        if (firstBrace === -1 || lastBrace === -1) {
            console.error("Raw LLM response (no JSON braces found):", result);
            throw new Error("No JSON object found in response. Try using a smarter model.");
        }

        const jsonString = jsonContent.substring(firstBrace, lastBrace + 1);
        let parsedData: any;
        try {
            parsedData = JSON.parse(jsonString);
        } catch (parseError: any) {
            console.error("--- LLM PARSE ERROR ---");
            console.error("Error Message:", parseError.message);
            console.error("Extracted String Length:", jsonString.length);
            console.error("Ends with:", jsonString.substring(Math.max(0, jsonString.length - 150)));
            throw new Error(`LLM returned malformed JSON (length ${jsonString.length}). Check console for details. Error: ${parseError.message}`);
        }

        if (parsedData.error) {
            throw new Error(parsedData.error);
        }
        if (!parsedData.ingredients || parsedData.ingredients.length === 0) {
            throw new Error("No recipe found on this page.");
        }

        const recipeData: Recipe = parsedData;
        recipeData.createdAt = Date.now();
        if (extractedData.image && !recipeData.image) {
            recipeData.image = extractedData.image;
        }
        return { recipeData, payloadCharCount };
    } catch (error: any) {
        throw new Error(error.message || "LLM returned malformed JSON");
    }
}

/**
 * Asks the LLM for a substitution for an ingredient in a recipe.
 * Instructs the model to output strict JSON without markdown formatting.
 */
export async function askSubstitutionWithClaude(
    recipeData: Recipe,
    userPrompt: string,
    apiKey: string,
    model: string,
    provider: string = "anthropic",
    authMode: string = "byok"
): Promise<{ thoughtProcess: string; substitutions: Array<{ ingredientId: number, quantity: number | null, unit: string | null, item: string, preparation: string | null, rawText: string }> }> {
    const systemPrompt = `
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

    // Map ingredients to include an explicit ID so the LLM doesn't have to count
    const mappedIngredients = recipeData.ingredients.map((ing, index) => {
        return `[ID: ${index}] - ${ing.item} (${ing.rawText})`;
    }).join("\n");

    const userContent = `
Recipe Context:
Title: ${recipeData.title}
Yield: ${recipeData.yield ?? recipeData.servings}

Ingredients:
${mappedIngredients}

User Request: ${userPrompt}

Provide the precise JSON response.
`;

    let fetchUrl = "";
    let fetchHeaders: Record<string, string> = {};
    let fetchBody: any = {};

    if (authMode === "cloud") {
        const apiBase = await getApiBase();
        fetchUrl = `${apiBase}/api/substitute/`;
        fetchHeaders = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
        };
        fetchBody = {
            recipe_context: recipeData,
            target_ingredient: userPrompt
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        try {
            const response = await fetch(fetchUrl, {
                method: "POST",
                headers: fetchHeaders,
                body: JSON.stringify(fetchBody),
                signal: controller.signal
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Cloud API Error (${response.status}): ${errText}`);
            }

            const cloudData = await response.json();
            // Map backend Substitution model to extension result
            // Backend: target_ingredient, substitution_name, amount, unit, reasoning
            const result = {
                thoughtProcess: cloudData.substitution.reasoning,
                substitutions: [
                    {
                        ingredientId: -1, // We'll have to find it or let LLM return it later, for now we just show it
                        quantity: cloudData.substitution.amount,
                        unit: cloudData.substitution.unit,
                        item: cloudData.substitution.substitution_name,
                        preparation: null,
                        rawText: `${cloudData.substitution.amount} ${cloudData.substitution.unit} ${cloudData.substitution.substitution_name}`
                    }
                ]
            };

            // Try to fuzzy match find the ingredient ID if possible
            const targetLower = cloudData.substitution.target_ingredient.toLowerCase();
            const foundIdx = recipeData.ingredients.findIndex(ing =>
                ing.item.toLowerCase().includes(targetLower) || targetLower.includes(ing.item.toLowerCase())
            );
            if (foundIdx !== -1) {
                result.substitutions[0].ingredientId = foundIdx;
            }

            return result;
        } catch (error: any) {
            if (error.name === 'AbortError') {
                throw new Error(`Cloud API request timed out after 60s.`);
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    } else if (provider === "google") {
        fetchUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        fetchHeaders = {
            "Content-Type": "application/json"
        };
        fetchBody = {
            contents: [
                { parts: [{ text: `${systemPrompt}\n\n${userContent}` }] }
            ],
            generationConfig: {
                temperature: 0,
                responseMimeType: "application/json"
            }
        };
    } else if (provider === "openai") {
        fetchUrl = "https://api.openai.com/v1/chat/completions";
        fetchHeaders = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        };
        fetchBody = {
            model: model,
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userContent }
            ],
            temperature: 0,
        };
    } else if (provider === "openrouter") {
        fetchUrl = "https://openrouter.ai/api/v1/chat/completions";
        fetchHeaders = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "HTTP-Referer": typeof window !== "undefined" ? window.location.origin : (typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime.getURL("") : "https://pantry-clip.extension"),
            "X-Title": "Pantry Clip"
        };
        fetchBody = {
            model: model,
            response_format: { type: "json_object" },
            messages: [
                { role: "user", content: `${systemPrompt}\n\n${userContent}` }
            ],
            temperature: 0,
        };
    } else {
        const isOlderClaude = model.startsWith("claude-3-haiku") || model.startsWith("claude-3-sonnet") || model.startsWith("claude-3-opus");
        fetchUrl = CLAUDE_API_URL;
        fetchHeaders = {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true"
        };
        fetchBody = {
            model: model,
            max_tokens: isOlderClaude ? 4096 : 8192,
            system: systemPrompt,
            messages: [
                { role: "user", content: userContent }
            ],
            temperature: 0,
        };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

    let response;
    try {
        response = await fetch(fetchUrl, {
            method: "POST",
            headers: fetchHeaders,
            body: JSON.stringify(fetchBody),
            signal: controller.signal
        });
    } catch (error: any) {
        if (error.name === 'AbortError') {
            throw new Error(`LLM API request timed out after 60s.`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LLM API Error (${response.status}): ${errorText}`);
    }

    const result = await response.json();

    if (result.error) {
        throw new Error(`LLM API Error: ${result.error.message || JSON.stringify(result.error)}`);
    }

    let jsonContent = "";
    if (provider === "openrouter" || provider === "openai") {
        jsonContent = result.choices?.[0]?.message?.content || "";
    } else if (provider === "google") {
        jsonContent = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
    } else {
        jsonContent = result.content?.[0]?.text || "";
    }

    try {
        const firstBrace = jsonContent.indexOf("{");
        const lastBrace = jsonContent.lastIndexOf("}");

        if (firstBrace === -1 || lastBrace === -1) {
            throw new Error("No JSON object found in response.");
        }

        const jsonString = jsonContent.substring(firstBrace, lastBrace + 1);
        const parsed = JSON.parse(jsonString);

        if (!parsed.thoughtProcess || !parsed.substitutions || !Array.isArray(parsed.substitutions)) {
            throw new Error("Missing required fields in parsed JSON.");
        }

        return parsed;
    } catch (error) {
        console.error("Failed to parse LLM substitution response:", jsonContent);
        throw new Error("LLM returned malformed JSON");
    }
}
