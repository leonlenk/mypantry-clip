// content.ts
// Declared content script — auto-injected by Chrome on every page.
// Two responsibilities:
//   1. On mypantry.dev/api/auth/callback: capture the Supabase session from
//      localStorage after a tab-based OAuth redirect and relay it to the
//      background service worker (replaces the `identity` permission flow).
//   2. On all other pages: handle EXTRACT_PAGE messages for recipe extraction.

import { Readability } from "@mozilla/readability";
import type { ExtractionResult } from "./utils/parser";

// ─── Auth Session Capture ─────────────────────────────────────────────────────
// Only active on the mypantry.dev/api/auth/callback page. After a successful Google
// OAuth, Supabase redirects here and appends the session to the URL hash.
// We parse the hash and relay the tokens to the background worker, which
// persists them and closes this tab.
console.log(`[PantryClip] Content script loaded on ${window.location.hostname}${window.location.pathname}`);
if (window.location.hostname.includes('mypantry.dev') && window.location.pathname === '/api/auth/callback') {
    console.log('[PantryClip] Auth callback page detected. Checking URL hash...');
    // The hash looks like: #access_token=...&refresh_token=...&expires_in=...
    const hash = window.location.hash;
    console.log('[PantryClip] Raw hash:', hash ? `${hash.substring(0, 50)}...` : 'none');

    if (hash && hash.includes('access_token')) {
        try {
            // Remove the leading '#' so URLSearchParams can parse the fragments
            const cleanHash = hash.startsWith('#') ? hash.substring(1) : hash;
            const params = new URLSearchParams(cleanHash);

            const accessToken = params.get('access_token');
            const refreshToken = params.get('refresh_token');
            console.log(`[PantryClip] Parsed access_token: ${accessToken ? 'present' : 'missing'}`);
            console.log(`[PantryClip] Parsed refresh_token: ${refreshToken ? 'present' : 'missing'}`);

            if (accessToken) {
                console.log('[PantryClip] Sending AUTH_SESSION_CAPTURED message to background...');
                chrome.runtime.sendMessage({
                    type: 'AUTH_SESSION_CAPTURED',
                    accessToken,
                    refreshToken: refreshToken ?? null,
                }, (response) => {
                    console.log('[PantryClip] Response from background:', response);
                });
            } else {
                console.error('[PantryClip] Auth callback path hit but no access_token found in URL fragment.');
            }
        } catch (e) {
            console.error('[PantryClip] Failed to parse session hash:', e);
        }
    } else {
        console.warn('[PantryClip] Hash does not contain "access_token"');
    }
}

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
