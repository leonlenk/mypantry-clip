# Plan for "Ask for Substitution" Feature

## 1. Goal
Implement backend LLM prompting and background worker status updates for the "Ask for substitution" chat interface in the recipe page.

## 2. Changes Needed
- **`src/utils/parser.ts`**: Create a new function `askSubstitutionLLM` (or similar) that takes the current recipe JSON and the user's prompt (e.g. "Substitute egg"). The single prompt needs to ask the model to analyze the chemical role of the target ingredient, and output a mathematically adjusted substitution, returning a simple response containing the thought process and the final substitution. 
- **`src/background.ts`**: Add a message listener for `ASK_SUBSTITUTION`. The logic will be similar to `executeExtractionInBackground`: post status updates ("Analyzing chemical role...", "Calculating mathematically adjusted substitution...", etc.), call the LLM, and return the result.
- **`src/pages/recipe.astro`**: Add event listeners for the chat input. Display status messages dynamically while loading, and then display the final result.

## 3. Reflect & Safety
- Ensure `Readability.js` isn't used here since we already have the `recipe.json` object.
- Ensure status updates match the `EXTRACTION_STATUS_UPDATE` pattern natively used by the popup, but since the user is in the `recipe.astro` page, `recipe.astro` will receive these messages and display them in the chat UI.
- Use `chrome.runtime.sendMessage` and listener.
