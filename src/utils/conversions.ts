// src/utils/conversions.ts

// Typical grams per 1 US Cup
// Note: Densities vary based on packing/sifting, these are common approximations.
export const INGREDIENT_DENSITIES: Record<string, number> = {
    // Flours
    "all-purpose flour": 120,
    "all purpose flour": 120,
    "flour": 120,
    "bread flour": 120,
    "cake flour": 114,
    "whole wheat flour": 113,
    "almond flour": 96,

    // Sugars
    "sugar": 200,
    "granulated sugar": 200,
    "white sugar": 200,
    "brown sugar": 213,
    "light brown sugar": 213,
    "dark brown sugar": 213,
    "powdered sugar": 113,
    "confectioners sugar": 113,
    "confectioner's sugar": 113,

    // Fats
    "butter": 227,
    "unsalted butter": 227,
    "salted butter": 227,
    "margarine": 227,
    "oil": 216,
    "vegetable oil": 216,
    "canola oil": 216,
    "olive oil": 216,
    "coconut oil": 216,
    "peanut butter": 258,
    "shortening": 190,

    // Leavening & Seasoning (often measured in tbsp/tsp, but ratios map up to a cup)
    "salt": 288,
    "kosher salt": 250,
    "baking powder": 192,
    "baking soda": 240,
    "yeast": 144, // active dry yeast
    "cinnamon": 125,

    // Liquids
    "water": 240,
    "milk": 240,
    "heavy cream": 240,
    "buttermilk": 240,
    "honey": 340,
    "maple syrup": 315,
    "molasses": 340,
    "vanilla extract": 240,
    "vanilla": 240,

    // Mix-ins and others
    "cocoa powder": 85, // unsweetened
    "chocolate chips": 170, // semi-sweet
    "rolled oats": 90,
    "oats": 90,
    "quick oats": 80,
    "walnuts": 117, // chopped
    "pecans": 109,  // chopped
    "almonds": 140, // sliced
    "cornstarch": 128,
};

// Volume to US cup ratio
export const VOLUME_UNITS: Record<string, number> = {
    "cup": 1,
    "cups": 1,
    "c": 1,
    "c.": 1,
    "tbsp": 1 / 16,
    "tbsps": 1 / 16,
    "tablespoon": 1 / 16,
    "tablespoons": 1 / 16,
    "t": 1 / 16,
    "tsp": 1 / 48,
    "tsps": 1 / 48,
    "teaspoon": 1 / 48,
    "teaspoons": 1 / 48,
    "fluid ounce": 1 / 8,
    "fl oz": 1 / 8,
    "oz": 1 / 8, // interpreted as volume fl oz here
    "ml": 1 / 236.588, // strict US customary cup is ~236.59 ml
    "milliliter": 1 / 236.588,
};

/**
 * Attempts to convert an imperial volume measurement to metric weight (grams)
 * by looking up the ingredient's typical density.
 * 
 * @param item - The ingredient text (e.g. "all-purpose flour, sifted")
 * @param quantity - The numeric quantity (e.g. 1.5)
 * @param unit - The volume unit (e.g. "cups", "tbsp")
 * @returns A `{ quantity, unit }` object or `null` if the conversion shouldn't/can't happen.
 */
export function convertVolumeToWeight(item: string, quantity: number, unit: string): { quantity: number, unit: string } | null {
    if (!unit || !item || quantity <= 0) return null;

    // 1. Identify the volume conversion ratio to 1 US Cup
    const normalizedUnit = unit.toLowerCase().trim();
    const cupRatio = VOLUME_UNITS[normalizedUnit];

    if (cupRatio === undefined) {
        return null; // The unit is not a recognizable volume unit
    }

    const normalizedItem = item.toLowerCase().trim();

    // 2. Identify the ingredient density
    let density = INGREDIENT_DENSITIES[normalizedItem];

    if (density === undefined) {
        // If not an exact match, fall back to checking substring matches with word boundaries.
        // We sort by length descending to match the most specific first (e.g. "unsalted butter" before "butter").
        const sortedKeys = Object.keys(INGREDIENT_DENSITIES).sort((a, b) => b.length - a.length);

        for (const knownItem of sortedKeys) {
            const regex = new RegExp(`\\b${knownItem}\\b`);
            if (regex.test(normalizedItem)) {
                density = INGREDIENT_DENSITIES[knownItem];
                break;
            }
        }
    }

    // 3. Perform conversion
    if (density !== undefined) {
        const cups = quantity * cupRatio;
        const grams = cups * density;

        // Round to nearest integer (or keep 1 decimal if very small? Let's keep it simple with integers or 1 dec)
        const roundedGrams = grams >= 10 ? Math.round(grams) : Math.round(grams * 10) / 10;

        return {
            quantity: roundedGrams,
            unit: "g"
        };
    }

    return null; // Could not map ingredient to a known density
}

/**
 * Converts a decimal number to a common fraction string (e.g. 3.5 -> "3 1/2").
 */
export function decimalToFraction(q: number): string {
    const whole = Math.floor(q);
    const fraction = q - whole;

    if (fraction < 0.05) return whole > 0 ? whole.toString() : "0";

    const fractions = [
        { val: 1 / 8, text: "1/8" },
        { val: 1 / 4, text: "1/4" },
        { val: 1 / 3, text: "1/3" },
        { val: 3 / 8, text: "3/8" },
        { val: 1 / 2, text: "1/2" },
        { val: 5 / 8, text: "5/8" },
        { val: 2 / 3, text: "2/3" },
        { val: 3 / 4, text: "3/4" },
        { val: 7 / 8, text: "7/8" }
    ];

    let closest = fractions[0];
    let minDiff = Math.abs(fraction - fractions[0].val);

    for (let i = 1; i < fractions.length; i++) {
        const diff = Math.abs(fraction - fractions[i].val);
        if (diff < minDiff) {
            minDiff = diff;
            closest = fractions[i];
        }
    }

    if (Math.abs(1 - fraction) < minDiff) {
        return (whole + 1).toString();
    }

    if (fraction < minDiff) {
        return whole > 0 ? whole.toString() : "0";
    }

    if (whole > 0) {
        return `${whole} ${closest.text}`;
    }

    return closest.text;
}

/**
 * Normalizes US Volume units to practical sizes (cups, tbsp, tsp)
 * and formats the quantity as a fraction.
 */
export function formatUSVolume(quantity: number, unitStr: string | null): { displayQuantity: string, displayUnit: string | null } {
    if (!unitStr || quantity <= 0) {
        return { displayQuantity: decimalToFraction(quantity), displayUnit: unitStr };
    }

    const normalizedUnit = unitStr.toLowerCase().trim();
    const cupRatio = VOLUME_UNITS[normalizedUnit];

    if (cupRatio === undefined) {
        return { displayQuantity: decimalToFraction(quantity), displayUnit: unitStr };
    }

    // Convert everything to teaspoons first to find the best unit
    let totalTeaspoons = quantity * cupRatio * 48; // since 1 cup = 48 tsp
    const cups = totalTeaspoons / 48;

    // For cups, we usually use fractions down to 1/4 (or 1/3)
    if (cups >= 0.23) {
        // Just checking if value is plural
        // But 0.75 cups is still "cups", 1 cup is "cup", 1.5 is "cups"
        const isSingular = Math.abs(cups - 1) < 0.05;
        return {
            displayQuantity: decimalToFraction(cups),
            displayUnit: isSingular ? "cup" : "cups"
        };
    }

    // If less than 1/4 cup, check tablespoons
    const tbls = totalTeaspoons / 3;
    if (tbls >= 0.9) {
        const isSingular = Math.abs(tbls - 1) < 0.05;
        return {
            displayQuantity: decimalToFraction(tbls),
            displayUnit: isSingular ? "tbsp" : "tbsp"
        };
    }

    // Otherwise teaspoons
    const isSingular = Math.abs(totalTeaspoons - 1) < 0.05;
    return {
        displayQuantity: decimalToFraction(totalTeaspoons),
        displayUnit: isSingular ? "tsp" : "tsp"
    };
}
