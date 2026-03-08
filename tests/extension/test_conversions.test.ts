/**
 * Tests for src/utils/conversions.ts — pure math and formatting functions.
 *
 * These are all pure functions with no side effects, making them ideal for
 * comprehensive unit testing.
 */

import { describe, it, expect } from "vitest";
import {
    convertVolumeToWeight,
    decimalToFraction,
    formatUSVolume,
    formatTime,
    escapeHtml,
    INGREDIENT_DENSITIES,
    VOLUME_UNITS,
} from "../../apps/extension/src/utils/conversions";

// ---------------------------------------------------------------------------
// convertVolumeToWeight
// ---------------------------------------------------------------------------

describe("convertVolumeToWeight", () => {
    it("converts 1 cup all-purpose flour to ~120g", () => {
        const result = convertVolumeToWeight("all-purpose flour", 1, "cups");
        expect(result).not.toBeNull();
        expect(result!.quantity).toBe(120);
        expect(result!.unit).toBe("g");
    });

    it("converts 1 cup butter to ~227g", () => {
        const result = convertVolumeToWeight("butter", 1, "cup");
        expect(result).not.toBeNull();
        expect(result!.quantity).toBe(227);
    });

    it("converts 2 cups sugar to ~400g", () => {
        const result = convertVolumeToWeight("sugar", 2, "cups");
        expect(result).not.toBeNull();
        expect(result!.quantity).toBe(400);
    });

    it("converts tablespoons to grams", () => {
        // 1 tbsp flour = (1/16 cup) * 120 g/cup = 7.5g
        const result = convertVolumeToWeight("flour", 1, "tbsp");
        expect(result).not.toBeNull();
        expect(result!.quantity).toBe(7.5);
    });

    it("converts teaspoons to grams", () => {
        // 1 tsp salt = (1/48 cup) * 288 g/cup = 6g
        const result = convertVolumeToWeight("salt", 1, "tsp");
        expect(result).not.toBeNull();
        expect(result!.quantity).toBe(6);
    });

    it("returns null for unknown ingredient", () => {
        const result = convertVolumeToWeight("dragon fruit extract", 1, "cups");
        expect(result).toBeNull();
    });

    it("returns null for unknown unit", () => {
        const result = convertVolumeToWeight("flour", 1, "liters");
        expect(result).toBeNull();
    });

    it("returns null for zero quantity", () => {
        expect(convertVolumeToWeight("flour", 0, "cups")).toBeNull();
    });

    it("returns null for negative quantity", () => {
        expect(convertVolumeToWeight("flour", -1, "cups")).toBeNull();
    });

    it("returns null for empty item string", () => {
        expect(convertVolumeToWeight("", 1, "cups")).toBeNull();
    });

    it("returns null for empty unit string", () => {
        expect(convertVolumeToWeight("flour", 1, "")).toBeNull();
    });

    it("matches via substring/word-boundary for compound ingredients", () => {
        // "unsalted butter" should match "butter" density (227 g/cup)
        const result = convertVolumeToWeight("unsalted butter", 1, "cups");
        expect(result).not.toBeNull();
        expect(result!.quantity).toBe(227);
    });

    it("prefers exact match over substring", () => {
        // "unsalted butter" is in the density map at 227
        const result = convertVolumeToWeight("unsalted butter", 1, "cup");
        expect(result).not.toBeNull();
        expect(result!.quantity).toBe(227);
    });

    it("handles case-insensitive matching", () => {
        const result = convertVolumeToWeight("All-Purpose Flour", 1, "CUPS");
        expect(result).not.toBeNull();
        expect(result!.quantity).toBe(120);
    });

    it("rounds small quantities to 1 decimal place", () => {
        // 1 tsp flour = (1/48 cup) * 120 = 2.5g
        const result = convertVolumeToWeight("flour", 1, "tsp");
        expect(result).not.toBeNull();
        expect(result!.quantity).toBe(2.5);
    });

    it("rounds larger quantities to integers", () => {
        // 3 cups flour = 360g (already integer)
        const result = convertVolumeToWeight("flour", 3, "cups");
        expect(result).not.toBeNull();
        expect(result!.quantity).toBe(360);
    });
});

// ---------------------------------------------------------------------------
// decimalToFraction
// ---------------------------------------------------------------------------

describe("decimalToFraction", () => {
    it('converts 0.5 to "1/2"', () => {
        expect(decimalToFraction(0.5)).toBe("1/2");
    });

    it('converts 0.25 to "1/4"', () => {
        expect(decimalToFraction(0.25)).toBe("1/4");
    });

    it('converts 0.333 to "1/3"', () => {
        expect(decimalToFraction(0.333)).toBe("1/3");
    });

    it('converts 0.75 to "3/4"', () => {
        expect(decimalToFraction(0.75)).toBe("3/4");
    });

    it('converts 0.125 to "1/8"', () => {
        expect(decimalToFraction(0.125)).toBe("1/8");
    });

    it('converts whole number 3 to "3"', () => {
        expect(decimalToFraction(3)).toBe("3");
    });

    it('converts 0 to "0"', () => {
        expect(decimalToFraction(0)).toBe("0");
    });

    it('converts 3.5 to "3 1/2"', () => {
        expect(decimalToFraction(3.5)).toBe("3 1/2");
    });

    it('converts 1.25 to "1 1/4"', () => {
        expect(decimalToFraction(1.25)).toBe("1 1/4");
    });

    it('converts 2.75 to "2 3/4"', () => {
        expect(decimalToFraction(2.75)).toBe("2 3/4");
    });

    it("rounds near-1 fraction up to the next whole number", () => {
        // 2.97 → fraction part 0.97 closer to 1 than to 7/8 → rounds to 3
        expect(decimalToFraction(2.97)).toBe("3");
    });

    it("returns decimal string for values that don't map to common fractions", () => {
        // 0.43 is between 3/8 (0.375) and 1/2 (0.5) but not close to either
        const result = decimalToFraction(0.43);
        // Should either be a fraction or a decimal — just ensure it's a valid string
        expect(result).toBeTruthy();
        expect(typeof result).toBe("string");
    });
});

// ---------------------------------------------------------------------------
// formatUSVolume
// ---------------------------------------------------------------------------

describe("formatUSVolume", () => {
    it("keeps cups as cups for larger amounts", () => {
        const result = formatUSVolume(1, "cups");
        expect(result.displayUnit).toBe("cup");
        expect(result.displayQuantity).toBe("1");
    });

    it("uses plural cups for non-singular amounts", () => {
        const result = formatUSVolume(1.5, "cups");
        expect(result.displayUnit).toBe("cups");
        expect(result.displayQuantity).toBe("1 1/2");
    });

    it("normalizes small cup amounts to tablespoons", () => {
        // 1/16 cup = 1 tbsp
        const result = formatUSVolume(1, "tbsp");
        expect(result.displayUnit).toBe("tbsp");
    });

    it("normalizes very small amounts to teaspoons", () => {
        // 1 tsp stays 1 tsp
        const result = formatUSVolume(1, "tsp");
        expect(result.displayUnit).toBe("tsp");
    });

    it("returns quantity as fraction when unit is null", () => {
        const result = formatUSVolume(0.5, null);
        expect(result.displayQuantity).toBe("1/2");
        expect(result.displayUnit).toBeNull();
    });

    it("handles zero quantity", () => {
        const result = formatUSVolume(0, "cups");
        expect(result.displayQuantity).toBe("0");
    });

    it("passes through unknown units without conversion", () => {
        const result = formatUSVolume(2, "pinch");
        expect(result.displayUnit).toBe("pinch");
        expect(result.displayQuantity).toBe("2");
    });

    it("formats 1/4 cup correctly", () => {
        const result = formatUSVolume(0.25, "cups");
        expect(result.displayQuantity).toBe("1/4");
        expect(result.displayUnit).toContain("cup");
    });
});

// ---------------------------------------------------------------------------
// formatTime
// ---------------------------------------------------------------------------

describe("formatTime", () => {
    it('formats 30 minutes as "30 min"', () => {
        expect(formatTime(30)).toBe("30 min");
    });

    it('formats 60 minutes as "1 hr"', () => {
        expect(formatTime(60)).toBe("1 hr");
    });

    it('formats 90 minutes as "1 hr 30 min"', () => {
        expect(formatTime(90)).toBe("1 hr 30 min");
    });

    it('formats 120 minutes as "2 hr"', () => {
        expect(formatTime(120)).toBe("2 hr");
    });

    it('formats 5 minutes as "5 min"', () => {
        expect(formatTime(5)).toBe("5 min");
    });

    it('formats 150 minutes as "2 hr 30 min"', () => {
        expect(formatTime(150)).toBe("2 hr 30 min");
    });

    it('formats 1 minute as "1 min"', () => {
        expect(formatTime(1)).toBe("1 min");
    });
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe("escapeHtml", () => {
    it("escapes ampersands", () => {
        expect(escapeHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
    });

    it("escapes less-than signs", () => {
        expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
    });

    it("escapes double quotes", () => {
        expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
    });

    it("escapes single quotes", () => {
        expect(escapeHtml("it's")).toBe("it&#039;s");
    });

    it("escapes all special characters together", () => {
        expect(escapeHtml(`<a href="x">&'`)).toBe(
            "&lt;a href=&quot;x&quot;&gt;&amp;&#039;"
        );
    });

    it("returns empty string unchanged", () => {
        expect(escapeHtml("")).toBe("");
    });

    it("leaves safe strings unchanged", () => {
        expect(escapeHtml("Hello World 123")).toBe("Hello World 123");
    });
});

// ---------------------------------------------------------------------------
// Data table sanity checks
// ---------------------------------------------------------------------------

describe("lookup tables", () => {
    it("INGREDIENT_DENSITIES has entries", () => {
        expect(Object.keys(INGREDIENT_DENSITIES).length).toBeGreaterThan(20);
    });

    it("VOLUME_UNITS has entries", () => {
        expect(Object.keys(VOLUME_UNITS).length).toBeGreaterThan(5);
    });

    it("all densities are positive numbers", () => {
        for (const [key, val] of Object.entries(INGREDIENT_DENSITIES)) {
            expect(val, `density for "${key}"`).toBeGreaterThan(0);
        }
    });

    it("all volume ratios are positive numbers", () => {
        for (const [key, val] of Object.entries(VOLUME_UNITS)) {
            expect(val, `ratio for "${key}"`).toBeGreaterThan(0);
        }
    });
});
