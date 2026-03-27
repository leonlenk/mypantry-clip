# MyPantry: Secure Monorepo Browser Extension & API

## 1. System Overview
A privacy-first, hybrid-architecture recipe assistant. The project is structured as a monorepo containing a minimal-permission browser extension (client) and a rate-limited Python backend (cloud sync). It supports a "Bring Your Own Key" (BYOK) local mode and a freemium cloud-synced mode. Crucially, all vector embedding generation is handled via Edge AI on the client device to ensure zero-cost backend scaling.

## 2. Monorepo Tech Stack & Tooling
* **Package Management:** `pnpm` (Workspace root & Extension) / `uv` (Strictly for the Python API backend).
* **Extension Web Client:** Astro (HTML/JS), SCSS (scoped styling), and `@mozilla/readability`.
* **Client Edge AI:** `Transformers.js` generating local embeddings via WASM using `pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { quantized: true })`.
* **Local Storage:** `Orama` persisted to `IndexedDB`.
* **Cloud API Server:** FastAPI (Python) acting strictly as a secure router and LLM proxy.
* **Database & Auth:** Supabase (Postgres with `pgvector`, Google OAuth, Email OTP).
* **Rate Limiting & Analytics:** Upstash (Serverless Redis) for token-bucket abuse prevention and atomic hit counting. Limits must be configurable from the `.env` file (defaulting to 50 requests/week per user per endpoint).
* **Logging:** `loguru` for structured, colorized, and queryable backend logging.
* **Security Layer:** Strict permission scoping; BYOK API keys stored in extension-sandboxed `chrome.storage.local`.

## 3. Strict Permission Model & Chrome APIs
* **DO NOT request `<all_urls>` or broad host permissions.**
* **Required Permissions:** `["activeTab", "scripting", "storage", "offscreen"]`.
* **Content Security Policy (CSP):** The `manifest.json` MUST explicitly define a `content_security_policy` that allows `wasm-unsafe-eval` for the offscreen document (to run Transformers.js) and whitelists the FastAPI backend URL for external connections.
* **Execution (DOM & Local AI):** The content script is injected programmatically via `chrome.scripting.executeScript` only after explicit user invocation. `Transformers.js` MUST run inside a spawned `chrome.offscreen` document, not the background worker.
* **Message Routing:**  Implement a strongly-typed central message hub in the background service worker to orchestrate communication between the Popup, Content Script, and Offscreen Document (e.g., `EXTRACT_RECIPE`, `GENERATE_EMBEDDING`) to avoid callback hell.

## 4. Security, Analytics, & Abuse Prevention
* **Extension Key Storage:** BYOK API keys are stored in `chrome.storage.local`, which is sandboxed to the extension origin and inaccessible to web pages.
* **Cloud API Protection & CORS:** All backend endpoints are protected by Supabase Auth middleware. The FastAPI app MUST configure `CORSMiddleware` to explicitly accept requests from the extension's `chrome-extension://` origin.
* **Dual Endpoint Routing:** Expose two distinct endpoints: `/api/extract` (for scraping) and `/api/substitute` (for reasoning). Both should use the `gemini-2.5-flash` model.
* **Independent Rate Limits:** Each endpoint uses a separate Redis-backed token bucket (e.g., 50 requests/week for `/api/extract` and 50 requests/week for `/api/substitute` per authenticated user ID).
* **Hit Counting & Telemetry:** Implement FastAPI middleware using `loguru` to log request latency, endpoint, and authenticated User ID. Use Redis to maintain an atomic counter of total lifetime hits per user (`INCR user:{id}:hits`).
* **OAUTH:** Use Supabase Google OAuth for authentication. Will be at endpoint /oauth/consent.

## 5. UI/UX Architecture
* **The Onboarding Flow (Setup Page):** An Astro page triggered by `chrome.runtime.onInstalled` guiding the user to create an account, input an API key/password, and select their vector database preference.
* **Cold Start UX:** The UI must handle the initial 22MB `Transformers.js` model download gracefully. Implement a dedicated loading state/progress bar that listens to the pipeline's progress callback so the user knows the AI model is caching locally.
* **Data Escape Hatch:** The settings page must include an "Export to JSON" and "Import from JSON" button that allows the user to export and import their entire local `IndexedDB` recipe database, ensuring true data ownership.
* **The Action Panel (Popup):** A lightweight Astro UI for capturing the page and querying substitutions. This should be called MyPantry Clip.
* **The Pantry (Dashboard):** An internal `chrome://` full-tab extension page for viewing saved recipes and performing semantic searches.

## 6. Agentic Workflows & Edge Optimizations
* **Hybrid Extraction (`/api/extract`):** Queries `application/ld+json` for the `@type: "Recipe"` schema. If missing, falls back to `Readability.js` (strictly pruning `<img>`, `<svg>`, and comment nodes) before sending the payload to the LLM via Structured Outputs for JSON normalization.
* **Edge Vectorization:** The extension client computes the mathematical embedding array locally using the quantized `Transformers.js` pipeline.
* **Zero-Compute Cloud Sync:** The client sends the normalized JSON and the pre-computed vector array to the FastAPI backend. The backend strictly routes this to Supabase `pgvector` without executing any server-side AI compute.
* **Substitution Loop (`/api/substitute`):** Retrieves current recipe JSON, prompts the LLM to analyze the chemical role of the target ingredient, and outputs a mathematically adjusted substitution.

## 7. Global Rules & Directives for Antigravity
* **PLANNING FIRST:** You must always generate a structured Implementation Plan artifact detailing Manifest V3 permissions, Astro build outputs, and backend routing before writing code.
* **ENVIRONMENT & COMPUTE CONTEXT:** The Python backend (`/apps/api`) MUST NOT generate embeddings. Vectorization is strictly client-side. Configure Python dependencies via `uv`, utilizing the local Nvidia 5050 strictly for backend LLM proxy orchestration or isolated server testing, not vector math. 
* **ISOLATION:** Keep SCSS styling modular and scoped to prevent CSS bleed. Maintain a strict separation of concerns between the client logic and the Python API router.

## 8. Brand Identity & Naming
* **Primary Brand:** MyPantry Clip
* **Domain:** mypantry.dev
* **Extension Name:** MyPantry Clip
* **UI Voice:** Minimalist, utility-focused, "Engineering-chic" (using monospace fonts for data/vectors).
* **Visual Strategy:** SCSS variables should favor a "NYT Cooking" palette.

| Layer | Color Name | Hex Code | Usage |
| :--- | :--- | :--- | :--- |
| **Accent** | **Warm Apricot** | `#E5B299` | Primary buttons, active toggles, soft highlights. |
| **Primary** | **Espresso** | `#4A4036` | Main headings and titles. |
| **Secondary** | **Warm Taupe** | `#8C7F70` | Body text and ingredient instructions. |
| **Tertiary** | **Pale Latte** | `#C4B7A6` | Metadata (e.g., "Prep time", "Yield"). |
| **Border** | **Oat Milk** | `#E8E3D9` | Soft dividers between ingredients. |
| **Background** | **Vanilla Cream**| `#FDFBF7` | Main card/popup background. |
| **Surface** | **Almond** | `#F4EFE6` | Subtle backgrounds for "AI Substitution" boxes. |

* **Typography:** Fraunces for headings, Quicksand for body text.
* **Icons:** Use Feather icons.
