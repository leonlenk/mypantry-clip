/**
 * Tests for src/utils/messages.ts — Chrome message type constants.
 *
 * Importing the module is enough to achieve coverage of the const declaration.
 * These tests also verify correctness: all values are unique non-empty strings
 * covering every message type the extension uses.
 */

import { describe, it, expect } from "vitest";
import { MSG, type MsgType } from "../../apps/extension/src/utils/messages";

describe("MSG constants", () => {
    it("exports all expected message type keys", () => {
        expect(MSG.authSessionCaptured).toBe("AUTH_SESSION_CAPTURED");
        expect(MSG.authComplete).toBe("AUTH_COMPLETE");
        expect(MSG.generateEmbedding).toBe("GENERATE_EMBEDDING");
        expect(MSG.startExtraction).toBe("START_EXTRACTION");
        expect(MSG.getExtractionStatus).toBe("GET_EXTRACTION_STATUS");
        expect(MSG.getAllExtractions).toBe("GET_ALL_EXTRACTIONS");
        expect(MSG.cancelExtraction).toBe("CANCEL_EXTRACTION");
        expect(MSG.extractionStatusUpdate).toBe("EXTRACTION_STATUS_UPDATE");
        expect(MSG.extractPage).toBe("EXTRACT_PAGE");
        expect(MSG.askSubstitution).toBe("ASK_SUBSTITUTION");
        expect(MSG.substitutionStatusUpdate).toBe("SUBSTITUTION_STATUS_UPDATE");
        expect(MSG.syncFromCloud).toBe("SYNC_FROM_CLOUD");
        expect(MSG.pushAllLocalToCloud).toBe("PUSH_ALL_LOCAL_TO_CLOUD");
        expect(MSG.getCloudLatest).toBe("GET_CLOUD_LATEST");
        expect(MSG.shareRecipe).toBe("SHARE_RECIPE");
        expect(MSG.recipeSavedFromShare).toBe("RECIPE_SAVED_FROM_SHARE");
        expect(MSG.importSharedRecipe).toBe("IMPORT_SHARED_RECIPE");
        expect(MSG.mypantrySaveResult).toBe("MYPANTRY_SAVE_RESULT");
        expect(MSG.mypantrySaveRecipe).toBe("MYPANTRY_SAVE_RECIPE");
    });

    it("all values are non-empty strings", () => {
        for (const value of Object.values(MSG)) {
            expect(typeof value).toBe("string");
            expect(value.length).toBeGreaterThan(0);
        }
    });

    it("all values are unique (no duplicate message type strings)", () => {
        const values = Object.values(MSG);
        expect(new Set(values).size).toBe(values.length);
    });

    it("MsgType is a union of all string values", () => {
        // Verify a known value is assignable to MsgType at runtime
        const val: MsgType = "START_EXTRACTION";
        expect(val).toBe(MSG.startExtraction);
    });
});
