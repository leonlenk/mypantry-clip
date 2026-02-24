# Recipe AI: Secure Monorepo Browser Extension & API

## 1. System Overview
A privacy-first, hybrid-architecture recipe assistant. The project is structured as a monorepo containing a minimal-permission browser extension (client) and a rate-limited Python backend (cloud sync). It supports a "Bring Your Own Key" (BYOK) local mode and a freemium cloud-synced mode.

## 2. Monorepo Tech Stack & Tooling
* **Package Management:** `pnpm` (Workspace root & Extension) / `uv` (Strictly for the Python API backend).
* **Extension Client (`/apps/extension`):**
    * **Framework:** Astro (Static HTML/JS for Popup, Options, Setup).
    * **Styling:** SCSS (compiled via Astro, strictly scoped).
    * **DOM Parsing:** Hybrid (JSON-LD first, `@mozilla/readability` fallback).
    * **Local AI:** `Transformers.js` (`Xenova/all-MiniLM-L6-v2` via WASM).
    * **Local DB:** `Orama` persisted to `IndexedDB`.
* **Cloud API (`/apps/api`):**
    * **Framework:** FastAPI (Python), utilizing local Nvidia 5050 for dev/inference testing.
    * **Database & Auth:** Supabase (Postgres with `pgvector`, Google OAuth, Email OTP).
    * **Rate Limiting:** Upstash (Serverless Redis) for token-bucket abuse prevention.
* **Security Layer:** Native Web Crypto API (`PBKDF2` + `AES-GCM`).

## 3. Strict Permission Model & Chrome APIs
* **DO NOT request `<all_urls>` or broad host permissions.**
* **Required Permissions:** `["activeTab", "scripting", "storage", "offscreen"]`.
* **Execution (DOM):** The content script must NOT run automatically. It must be injected programmatically via `chrome.scripting.executeScript` only after explicit user invocation.
* **Execution (Local AI):** `Transformers.js` MUST NOT run in the background service worker to prevent memory termination. The service worker must spawn a hidden `chrome.offscreen` document to execute the WASM embedding math, returning the vector to the worker.

## 4. Security & Abuse Prevention Protocol
* **Extension (Local):** * Use `window.crypto.subtle` to derive an AES-GCM key from a user-created session password.
    * Encrypt the raw LLM API key; store ONLY the `ciphertext` and `iv` in `chrome.storage.local`.
    * Decrypt into ephemeral memory only when a local AI action is triggered.
* **API (Cloud):** * All backend endpoints must be protected by Supabase Auth middleware.
    * Implement a strict Redis-backed token bucket rate limit (e.g., 50 requests/day per authenticated user ID) to prevent LLM API billing abuse.

## 5. UI/UX Architecture
* **The Onboarding Flow (Setup Page):** An Astro page triggered by `chrome.runtime.onInstalled`. Guides the user to create an account (Supabase), input a BYOK API key with a local encryption password, and select their vector database preference (Local vs. Cloud).
* **The Action Panel (Popup):** A lightweight Astro UI for capturing the current page and a quick-chat interface for the Substitution Reasoning Agent.
* **The Pantry (Dashboard):** An internal `chrome://` full-tab extension page for viewing saved recipes and performing semantic searches.

## 6. Agentic Workflows & Optimizations
* **Hybrid Extraction Pipeline:** 1. Content script first attempts to parse `script[type="application/ld+json"]` for the `@type: "Recipe"` schema. 
    2. If missing, fallback to `Readability.js`, strictly pruning all `<img>`, `<svg>`, and comment nodes before stringifying.
    3. Send cleaned payload to LLM via Structured Outputs for standard JSON normalization.
* **Substitution Loop:** Retrieve current recipe JSON, prompt the LLM to analyze the chemical role of the target ingredient, and output a mathematically adjusted substitution.

## 7. Global Rules & Directives for Antigravity
* **PLANNING FIRST:** You must always generate a structured Implementation Plan artifact before writing code. Map out Manifest V3 permissions, Astro build outputs, or backend routing before executing.
* **ENVIRONMENT CONTEXT:** The backend Python development environment is local, not a remote Linux server. You have direct access to an Nvidia 5050. Configure embedding generation and Python dependencies via `uv` to utilize local CUDA acceleration when working in the `/apps/api` directory.
* **ISOLATION:** Keep SCSS styling modular and scoped to prevent CSS bleed when injecting UI elements into the active tab. Maintain a strict separation of concerns between the web client code and the Python AI backend.