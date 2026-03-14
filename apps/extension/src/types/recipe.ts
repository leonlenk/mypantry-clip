export interface Recipe {
    id: string; // Unique identifier (hash of the URL)
    url: string; // Source URL
    title: string;
    semantic_summary?: string; // LLM-written dense summary for high-quality semantic search
    author?: string;
    image?: string; // URL to the main recipe image
    isFavorite?: boolean;
    createdAt?: number; // Unix timestamp

    prepTimeMinutes?: number;
    cookTimeMinutes?: number;
    totalTimeMinutes?: number;

    servings: number | null; // The number of servings
    yield?: string; // The descriptive yield (e.g., "2 dozen cookies", "1 9x13 inch pan")

    ingredients: Ingredient[];
    instructions: InstructionStep[];
    notes?: string[]; // Recipe-level string notes (extracted from bottom of page)

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

    // Explicit unit and quantity splits
    us_amount: number | null;
    us_unit: string | null;
    metric_amount: number | null;
    metric_unit: string | null;

    item: string;            // e.g., "all-purpose flour"
    preparation?: string;    // Cooking action only — e.g., "sifted", "chopped", "melted"
    subtext?: string;        // Alternative context — e.g., "or graham crackers"
    note_references?: number[]; // Indexes referencing the Recipe.notes array
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
