export interface Recipe {
    id: string; // Unique identifier (hash of the URL)
    url: string; // Source URL
    title: string;
    description: string;
    author?: string;
    image?: string; // URL to the main recipe image
    isFavorite?: boolean;

    prepTimeMinutes?: number;
    cookTimeMinutes?: number;
    totalTimeMinutes?: number;

    servings: number | null; // The number of servings
    yield?: string; // The descriptive yield (e.g., "2 dozen cookies", "1 9x13 inch pan")

    ingredients: Ingredient[];
    instructions: InstructionStep[];

    tags?: string[];

    nutrition?: {
        calories?: number;
        protein?: string;
        fat?: string;
        carbohydrates?: string;
    };

    embedding?: number[]; // Semantic vector representation of the recipe
}

export interface Ingredient {
    // The original text from the DOM for reference (e.g., "1 1/2 cups all-purpose flour, sifted")
    rawText: string;

    // Parsed fields critical for the Substitution Loop
    quantity: number | null; // e.g., 1.5
    unit: string | null;     // e.g., "cups", "tbsp", "grams"
    item: string;            // e.g., "all-purpose flour"
    preparation?: string;    // e.g., "sifted", "chopped"
    group?: string;          // Optional section name (e.g., "Cake", "Frosting")
    substituted?: {
        quantity?: number;
        unit?: string;
        item?: string;
        preparation?: string;
        rawText?: string;
    } | string; // Keep string for backwards compatibility with older stored data
}

export interface InstructionStep {
    stepNumber: number;
    text: string;
    group?: string;          // Optional section name (e.g., "Cake", "Frosting")
}
