// content.ts
// Declared content script — auto-injected by Chrome on every page.
// Receives an "EXTRACT_PAGE" message from the background service worker,
// runs the three-tier extraction cascade, and replies with the result.
// By using a declared content script instead of chrome.scripting.executeScript,
// we avoid needing the "scripting" permission and host_permissions in the manifest.

import { Readability } from "@mozilla/readability";
import type { ExtractionResult } from "./utils/parser";

// ─── Tier 1: JSON-LD ──────────────────────────────────────────────────────────

function checkJsonLd(): ExtractionResult | null {
    function tryExtractRecipeText(doc: Document): string | null {
        const classes = [".wprm-recipe-container", ".tasty-recipes", ".recipe-callout", ".mv-create-wrapper", ".recipe-card"];
        for (const cls of classes) {
            const el = doc.querySelector(cls) as HTMLElement;
            if (el) {
                let text = el.innerText;
                // Many blogs put the notes immediately after the recipe card wrapper
                let next = el.nextElementSibling as HTMLElement;
                while (next && text.length < 20000) {
                    text += "\n\n" + next.innerText;
                    next = next.nextElementSibling as HTMLElement;
                }
                return text.replace(/\s+/g, ' ').trim();
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

    function extractImage(jsonLd: any): string | undefined {
        if (jsonLd.image) {
            if (typeof jsonLd.image === 'string') return jsonLd.image;
            if (Array.isArray(jsonLd.image) && jsonLd.image.length > 0) {
                if (typeof jsonLd.image[0] === 'string') return jsonLd.image[0];
                if (jsonLd.image[0].url) return jsonLd.image[0].url;
            }
            if (jsonLd.image.url) return jsonLd.image.url;
        }
        const ogImage = document.querySelector('meta[property="og:image"]') as HTMLMetaElement;
        if (ogImage && ogImage.content) return ogImage.content;
        return undefined;
    }

    const jsonLd = tryExtractJsonLd();
    if (jsonLd !== null) {
        const recipeText = tryExtractRecipeText(document);
        return {
            source: "json-ld",
            jsonLd,
            recipeText: recipeText || undefined,
            url: window.location.href,
            title: document.title,
            image: extractImage(jsonLd)
        };
    }

    return null;
}

// ─── Tier 2: Targeted DOM ────────────────────────────────────────────────────

function extractDomTarget(): ExtractionResult | null {
    function tryExtractRecipeText(doc: Document): string | null {
        const classes = [".wprm-recipe-container", ".tasty-recipes", ".recipe-callout", ".mv-create-wrapper", ".recipe-card"];
        for (const cls of classes) {
            const el = doc.querySelector(cls) as HTMLElement;
            if (el) {
                let text = el.innerText;
                let next = el.nextElementSibling as HTMLElement;
                while (next && text.length < 20000) {
                    text += "\n\n" + next.innerText;
                    next = next.nextElementSibling as HTMLElement;
                }
                return text.replace(/\s+/g, ' ').trim();
            }
        }
        return null;
    }

    function extractImage(): string | undefined {
        const ogImage = document.querySelector('meta[property="og:image"]') as HTMLMetaElement;
        if (ogImage && ogImage.content) return ogImage.content;
        return undefined;
    }

    const recipeText = tryExtractRecipeText(document);
    if (recipeText) {
        return {
            source: "dom-target",
            recipeText,
            url: window.location.href,
            title: document.title,
            image: extractImage()
        };
    }
    return null;
}

// ─── Tier 3: Readability ─────────────────────────────────────────────────────

function extractWithReadability(): ExtractionResult {
    function pruneToRecipeContainer(docClone: Document): void {
        const links = Array.from(docClone.querySelectorAll("a"));
        const skipBtn = links.find(el => {
            const text = el.textContent?.toLowerCase() || "";
            return text.includes("skip to recipe") || text.includes("jump to recipe");
        });

        if (skipBtn) {
            const href = skipBtn.getAttribute("href");
            if (href && href.startsWith("#") && href.length > 1) {
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
        // Kill-list: strip noisy/irrelevant tags before Readability parses the DOM.
        // These tags add token bloat without contributing recipe content.
        docClone
            .querySelectorAll("script, style, noscript, iframe, nav")
            .forEach((el) => el.remove());

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

    function extractImage(): string | undefined {
        const ogImage = document.querySelector('meta[property="og:image"]') as HTMLMetaElement;
        if (ogImage && ogImage.content) return ogImage.content;
        return undefined;
    }

    const documentClone = document.cloneNode(true) as Document;
    pruneToRecipeContainer(documentClone);
    pruneDocumentForReadability(documentClone);

    const reader = new Readability(documentClone);
    const article = reader.parse();

    if (!article) {
        throw new Error("Could not extract content from this page. Readability failed to parse the DOM.");
    }

    return {
        source: "readability",
        title: article.title || document.title,
        textContent: article.textContent || "",
        url: window.location.href,
        image: extractImage()
    };
}

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "EXTRACT_PAGE") return false;

    // Run the extraction cascade synchronously — all DOM access must happen
    // here in the content script's page context; results are sent back to
    // the background service worker via sendResponse.
    try {
        // Tier 1: JSON-LD structured data (fastest, most reliable)
        let result = checkJsonLd();

        // Tier 2: Known recipe card containers
        if (!result) {
            result = extractDomTarget();
        }

        // Tier 3: Full-page Readability parse (slowest, most permissive)
        if (!result) {
            result = extractWithReadability();
        }

        sendResponse({ result });
    } catch (err: any) {
        sendResponse({ result: null, error: err.message });
    }

    // Returning true is not needed here because sendResponse is called
    // synchronously — the listener does not need to keep the channel open.
    return false;
});
