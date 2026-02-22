import type { Recipe } from "../types/recipe";

// Anthropic constants
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 4096;

/**
 * Discriminated union representing the result of the hybrid DOM extraction.
 *
 * - "json-ld"     → a valid Recipe schema.org object was found; no Readability needed.
 * - "readability" → JSON-LD was absent; Readability was used after DOM pruning.
 */
export type ExtractionResult =
    | { source: "json-ld"; jsonLd: object; url: string; title: string }
    | { source: "readability"; title: string; textContent: string; url: string };

/**
 * Checks for a valid Recipe JSON-LD schema on the page.
 * Returns the extraction result if found, otherwise null.
 * 
 * IMPORTANT: This function is serialized and injected as source text via chrome.scripting.
 */
export function checkJsonLd(): ExtractionResult | null {
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
        return {
            source: "json-ld",
            jsonLd,
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
): Promise<Recipe> {
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
}

interface InstructionStep {
  stepNumber: number;
  text: string;
}

Constraints:
1. ONLY output the valid JSON object. Do not include markdown formatting like \`\`\`json.
2. Ensure the "ingredients" array breaks down the quantity, unit, and item clearly.
   - Example 1: "2 cups + 2 tbsp all purpose flour" -> quantity: 2.125, unit: "cups", item: "all purpose flour", rawText: "2 cups + 2 tbsp all purpose flour"
   - Example 2: "1 tsp baking soda" -> quantity: 1, unit: "tsp", item: "baking soda", rawText: "1 tsp baking soda"
   - Example 3: "½ cup granulated sugar" -> quantity: 0.5, unit: "cup", item: "granulated sugar", rawText: "½ cup granulated sugar"
3. YOU MUST DO YOUR BEST TO EXTRACT QUANTITY AND UNIT. ONLY use null if absolutely no quantity or unit is mentioned.
4. If a value is unknown, use null or omit optional fields. Do not make up values.
`;

    // Build the user prompt based on which extraction path was taken.
    // JSON-LD path: the structured object is high-fidelity; skip the noisy text block.
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

Extract the recipe into the specified JSON format. CRITICAL: Use the structured metadata above as the authoritative source for all ingredient quantities, units, and names.
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

    const response = await fetch(fetchUrl, {
        method: "POST",
        headers: fetchHeaders,
        body: JSON.stringify(fetchBody),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LLM API Error (${response.status}): ${errorText}`);
    }

    const result = await response.json();
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
            throw new Error("No JSON object found in response");
        }

        const jsonString = jsonContent.substring(firstBrace, lastBrace + 1);
        const recipeData: Recipe = JSON.parse(jsonString);
        return recipeData;
    } catch (error) {
        console.error("Failed to parse LLM response as JSON:", jsonContent);
        throw new Error("LLM returned malformed JSON");
    }
}
