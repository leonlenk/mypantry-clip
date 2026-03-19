/**
 * messages.ts — All chrome.runtime (and postMessage) type strings in one place.
 *
 * Use MSG.foo instead of the raw string literal "FOO" so that:
 *   • Typos are caught at compile time rather than silently failing at runtime.
 *   • Renaming a message only requires one change here.
 *   • Every message is documented in one readable table.
 *
 * To add a new message: add an entry below and wire it up in background.ts.
 */

export const MSG = {
    // ── Auth ──────────────────────────────────────────────────────────────────
    /** content.ts → background: OAuth callback page captured tokens, relay to SW */
    authSessionCaptured: "AUTH_SESSION_CAPTURED",
    /** background → setup page: OAuth session persisted, advance to API-choice step */
    authComplete: "AUTH_COMPLETE",

    // ── Embedding ─────────────────────────────────────────────────────────────
    /** any → offscreen doc (via background relay): compute a 384-dim embedding */
    generateEmbedding: "GENERATE_EMBEDDING",

    // ── Extraction ────────────────────────────────────────────────────────────
    /** popup → background: start the full recipe extraction pipeline */
    startExtraction: "START_EXTRACTION",
    /** popup → background: poll status of an in-flight extraction */
    getExtractionStatus: "GET_EXTRACTION_STATUS",
    /** pantry → background: get the full active-extractions map */
    getAllExtractions: "GET_ALL_EXTRACTIONS",
    /** pantry → background: cancel an in-flight extraction */
    cancelExtraction: "CANCEL_EXTRACTION",
    /** background → popup / pantry: live status update during extraction */
    extractionStatusUpdate: "EXTRACTION_STATUS_UPDATE",
    /** background → content script (tab): extract and return page DOM/text */
    extractPage: "EXTRACT_PAGE",

    // ── Substitution ──────────────────────────────────────────────────────────
    /** recipe page → background: start an ingredient-substitution analysis */
    askSubstitution: "ASK_SUBSTITUTION",
    /** background → recipe page tab: progressive status / final result */
    substitutionStatusUpdate: "SUBSTITUTION_STATUS_UPDATE",

    // ── Cloud sync ────────────────────────────────────────────────────────────
    /** setup / pantry → background: pull recipes from cloud newer than `since` */
    syncFromCloud: "SYNC_FROM_CLOUD",
    /** setup → background: push all local recipes up to cloud */
    pushAllLocalToCloud: "PUSH_ALL_LOCAL_TO_CLOUD",
    /** pantry → background: get the newest cloud timestamp (cheap staleness check) */
    getCloudLatest: "GET_CLOUD_LATEST",

    // ── Share / Import ────────────────────────────────────────────────────────
    /** selectionManager → background: create a share link for selected recipes */
    shareRecipe: "SHARE_RECIPE",
    /** background → pantry: a shared recipe was just imported, reload the grid */
    recipeSavedFromShare: "RECIPE_SAVED_FROM_SHARE",
    /** content.ts → background: user clicked Save on a shared-recipe page */
    importSharedRecipe: "IMPORT_SHARED_RECIPE",
    /**
     * content.ts → shared page (via window.postMessage): result of save attempt.
     * Also used as the incoming postMessage type sent by the shared page to content.ts.
     */
    mypantrySaveResult: "MYPANTRY_SAVE_RESULT",
    /** Shared page → content.ts (via window.postMessage): user wants to save recipes */
    mypantrySaveRecipe: "MYPANTRY_SAVE_RECIPE",
} as const;

export type MsgType = typeof MSG[keyof typeof MSG];
