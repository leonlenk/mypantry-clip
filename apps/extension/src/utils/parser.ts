import type { Recipe } from "../types/recipe";

// Anthropic constants
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 4096;

/**
 * Discriminated union representing the result of the hybrid DOM extraction.
 *
 * - "json-ld"     → a valid Recipe schema.org object was found; we also try to get targeted DOM text.
 * - "dom-target"  → JSON-LD absent; we successfully found a recipe card container.
 * - "readability" → JSON-LD and recipe card absent; Readability was used after DOM pruning.
 */
export type ExtractionResult =
    | { source: "json-ld"; jsonLd: object; recipeText?: string; url: string; title: string }
    | { source: "dom-target"; recipeText: string; url: string; title: string }
    | { source: "readability"; title: string; textContent: string; url: string };

/**
 * Checks for a valid Recipe JSON-LD schema on the page.
 * Returns the extraction result if found, otherwise null.
 * 
 * IMPORTANT: This function is serialized and injected as source text via chrome.scripting.
 */
export function checkJsonLd(): ExtractionResult | null {
    function tryExtractRecipeText(doc: Document): string | null {
        const classes = [".wprm-recipe-container", ".tasty-recipes", ".recipe-callout", ".mv-create-wrapper", ".recipe-card"];
        for (const cls of classes) {
            const el = doc.querySelector(cls) as HTMLElement;
            if (el) {
                return el.innerText.replace(/\s+/g, ' ').trim();
            }
        }
        return null;
    }

    function tryExtractJsonLd(): object | null {
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of Array.from(scripts)) {
            try {
                const raw = script.textContent;
                if (!raw) continue;
                const parsed = JSON.parse(raw);

                const candidates: any[] = Array.isArray(parsed)
                    ? parsed
                    : parsed["@graph"]
                        ? parsed["@graph"]
                        : [parsed];

                for (const candidate of candidates) {
                    const type: string = candidate["@type"] ?? "";
                    const types = Array.isArray(type) ? type : [type];
                    if (types.some((t: string) => t.toLowerCase() === "recipe")) {
                        return candidate;
                    }
                }
            } catch {
                // Malformed JSON in a script tag — skip and try the next one.
            }
        }
        return null;
    }

    const jsonLd = tryExtractJsonLd();
    if (jsonLd !== null) {
        // Try to get recipe text for grouping info, even if we have JSON-LD
        const recipeText = tryExtractRecipeText(document);
        return {
            source: "json-ld",
            jsonLd,
            recipeText: recipeText || undefined,
            url: window.location.href,
            title: document.title,
        };
    }

    return null;
}

/**
 * Attempt to extract JUST the recipe text from known containers if JSON-LD fails.
 * This is faster and uses fewer tokens than readability.
 */
export function extractDomTarget(): ExtractionResult | null {
    function tryExtractRecipeText(doc: Document): string | null {
        const classes = [".wprm-recipe-container", ".tasty-recipes", ".recipe-callout", ".mv-create-wrapper", ".recipe-card"];
        for (const cls of classes) {
            const el = doc.querySelector(cls) as HTMLElement;
            if (el) {
                return el.innerText.replace(/\s+/g, ' ').trim();
            }
        }
        return null;
    }

    const recipeText = tryExtractRecipeText(document);
    if (recipeText) {
        return {
            source: "dom-target",
            recipeText,
            url: window.location.href,
            title: document.title,
        };
    }
    return null;
}

/**
 * Fallback extraction strategy using Readability.
 * Assumes Readability has already been injected into the page.
 * 
 * IMPORTANT: This function is serialized and injected as source text via chrome.scripting.
 */
export function extractWithReadability(): ExtractionResult {
    function pruneToRecipeContainer(docClone: Document): void {
        const links = Array.from(docClone.querySelectorAll("a"));
        const skipBtn = links.find(el => {
            const text = el.textContent?.toLowerCase() || "";
            return text.includes("skip to recipe") || text.includes("jump to recipe");
        });

        if (skipBtn) {
            const href = skipBtn.getAttribute("href");
            if (href && href.startsWith("#") && href.length > 1) {
                // The URL might have the full URL # id, we just want the hash part if it's purely internal
                const targetId = href.substring(1);
                try {
                    let targetElement = docClone.getElementById(targetId);
                    if (!targetElement) {
                        targetElement = docClone.querySelector(`[name="${CSS.escape(targetId)}"]`);
                    }

                    if (targetElement && docClone.body) {
                        docClone.body.innerHTML = "";
                        docClone.body.appendChild(targetElement);
                    }
                } catch (e) {
                    // Ignore DOMException for malformed queries
                }
            }
        }
    }

    function pruneDocumentForReadability(docClone: Document): void {
        docClone
            .querySelectorAll("img, picture, figure > img, svg, canvas, video, audio")
            .forEach((el) => el.remove());

        const walker = document.createTreeWalker(docClone, NodeFilter.SHOW_COMMENT);
        const commentNodes: Node[] = [];
        while (walker.nextNode()) {
            commentNodes.push(walker.currentNode);
        }
        commentNodes.forEach((node) => node.parentNode?.removeChild(node));
    }

    // @ts-ignore
    if (typeof window.Readability === "undefined" && typeof Readability === "undefined") {
        throw new Error("Readability library is not loaded in the content script.");
    }

    const documentClone = document.cloneNode(true) as Document;
    pruneToRecipeContainer(documentClone);
    pruneDocumentForReadability(documentClone);

    // @ts-ignore
    const ReadabilityClass = typeof window.Readability !== "undefined" ? window.Readability : Readability;
    const reader = new ReadabilityClass(documentClone);
    const article = reader.parse();

    if (!article) {
        throw new Error("Could not extract content from this page. Readability failed to parse the DOM.");
    }

    return {
        source: "readability",
        title: article.title || document.title,
        textContent: article.textContent || "",
        url: window.location.href,
    };
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
    provider: string = "anthropic"
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
  rawText: string; // The original line text
  quantity: number | null; // Parse the number (e.g. 1.5 for 1 1/2)
  unit: string | null; // e.g. "cup", "tsp", "g"
  item: string; // The core ingredient name e.g. "all-purpose flour"
  preparation?: string; // e.g. "sifted", "chopped"
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
4. Ensure the "ingredients" array breaks down the quantity, unit, and item clearly.
   - Example: "2 cups + 2 tbsp all purpose flour" -> quantity: 2.125, unit: "cups", item: "all purpose flour", rawText: "2 cups + ... "
5. YOU MUST DO YOUR BEST TO EXTRACT QUANTITY AND UNIT. ONLY use null if absolutely no quantity or unit is mentioned.
6. If a value is unknown, use null or omit optional fields. Do not make up values.
7. EXTREMELY IMPORTANT: If the recipe has multiple components (e.g. "Cake" and "Frosting", or "Crust" and "Filling"), you MUST extract these section names and put them in the "group" field for EVERY corresponding ingredient and instruction. In JSON-LD, this sometimes looks like an ingredient that is just a label (e.g. "For the Cake"). DO NOT miss the sections.
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
The author's schema often omits component group names (e.g. "Cake", "Frosting"). The following is the text extracted from the recipe card. 
Extract the recipe into the specified JSON format. CRITICAL: Use the STRUCTURED RECIPE METADATA as the authoritative source for all ingredient quantities, units, and names. Use the RECIPE CARD TEXT below ONLY to infer the correct \`group\` names and assign them to the ingredients and instructions.

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

    if (provider === "openrouter") {
        fetchUrl = "https://openrouter.ai/api/v1/chat/completions";
        fetchHeaders = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "HTTP-Referer": typeof window !== "undefined" ? window.location.origin : (typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime.getURL("") : "https://recipe-ai.extension"),
            "X-Title": "Recipe AI"
        };
        fetchBody = {
            model: model,
            messages: [
                { role: "user", content: `${systemPrompt}\n\n${userPrompt}` }
            ],
            temperature: 0,
        };
    } else {
        fetchUrl = CLAUDE_API_URL;
        fetchHeaders = {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true"
        };
        fetchBody = {
            model: model,
            max_tokens: MAX_TOKENS,
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

    if (provider === "openrouter") {
        jsonContent = result.choices?.[0]?.message?.content || "";
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
        try {
            const recipeData: Recipe = JSON.parse(jsonString);
            return { recipeData, payloadCharCount };
        } catch (parseError) {
            console.error("--- MALFORMED JSON START ---\n" + jsonString + "\n--- MALFORMED JSON END ---");
            throw parseError; // Rethrow to be caught by the outer catch
        }
    } catch (error) {
        console.error("Failed to parse LLM response as JSON. See the printed string above.");
        throw new Error("LLM returned malformed JSON");
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
    provider: string = "anthropic"
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

    if (provider === "openrouter") {
        fetchUrl = "https://openrouter.ai/api/v1/chat/completions";
        fetchHeaders = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "HTTP-Referer": typeof window !== "undefined" ? window.location.origin : (typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime.getURL("") : "https://recipe-ai.extension"),
            "X-Title": "Recipe AI"
        };
        fetchBody = {
            model: model,
            messages: [
                { role: "user", content: `${systemPrompt}\n\n${userContent}` }
            ],
            temperature: 0,
        };
    } else {
        fetchUrl = CLAUDE_API_URL;
        fetchHeaders = {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true"
        };
        fetchBody = {
            model: model,
            max_tokens: 1500,
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
    if (provider === "openrouter") {
        jsonContent = result.choices?.[0]?.message?.content || "";
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
