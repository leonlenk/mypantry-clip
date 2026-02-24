import { Readability } from "@mozilla/readability";

// Expose Readability to the global scope so it can be accessed
// when this script is injected into the active tab by chrome.scripting.executeScript.
// We use window as target since we operate in the DOM environment or isolated world.
// @ts-ignore
window.Readability = Readability;
