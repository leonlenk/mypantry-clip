# Recipe AI: Minimal-Permission Browser Extension

## 1. System Overview
A privacy-first, BYOK browser extension that extracts, stores, and semantically searches web recipes. It uses minimal permissions, executing only upon explicit user invocation. 

## 2. Tech Stack & Tooling
* **Package Manager:** pnpm
* **Framework:** Astro (for generating the static HTML/JS for the Popup, Options, and Setup pages).
* **Styling:** SCSS (compiled via Astro).
* **DOM Parsing:** `@mozilla/readability` (injected programmatically).
* **Vector Database (Modular):**
    * *Local:* `Orama` + `Transformers.js` (WebGPU/WASM).
    * *Cloud API:* REST interface connecting to a user-hosted backend.
* **Security:** Native Web Crypto API (`PBKDF2` + `AES-GCM`).

## 3. Strict Permission Model
* **DO NOT request `<all_urls>` or broad host permissions.**
* **Required Permissions:** `["activeTab", "scripting", "storage"]`.
* **Execution:** The content script must NOT run automatically. It must be injected programmatically via `chrome.scripting.executeScript` only after the user clicks the extension action button.

## 4. UI/UX Architecture
* **The Onboarding Flow (Setup Page):** An Astro page triggered by `chrome.runtime.onInstalled`. It guides the user to input their API key, create a local encryption password, and select their vector database preference.
* **The Action Panel (Popup):** A lightweight Astro UI for capturing the current page and a quick-chat interface for the Substitution Reasoning Agent.
* **The Pantry (Dashboard):** An internal extension page for viewing saved recipes and performing semantic searches.

## 5. Security Protocol
* Use `window.crypto.subtle` to derive an AES-GCM key from the user's password.
* Encrypt the API key and store only the `ciphertext` and `iv` in `chrome.storage.local`.
* Require the user to input their password to decrypt the key into ephemeral memory when performing AI actions.

## 6. Agentic Workflows
* **Extraction:** When invoked, inject `Readability.js`, clean the DOM, and send to the LLM via Structured Outputs to get a strict recipe JSON.
* **Substitution Loop:** Retrieve current recipe JSON, prompt the LLM to analyze the chemical role of the target ingredient, and output a mathematically adjusted substitution.

## 7. Development Directives for Antigravity
* **PLANNING:** Generate an Implementation Plan first. Detail the Astro build configuration required to output multiple HTML entry points (popup.html, setup.html, pantry.html) for the Chrome extension format.
* **ISOLATION:** Keep the SCSS styling modular and scoped to prevent CSS bleed when injecting UI elements into the active tab.