from google import genai
from google.genai import types
from src.config import settings
from pydantic import BaseModel, Field
from typing import List, Optional
from loguru import logger

client = genai.Client(
    api_key=settings.gemini_api_key,
    http_options=types.HttpOptions(timeout=150000)
)

class Ingredient(BaseModel):
    name: str = Field(description="The core ingredient name ONLY, absolutely NO parentheses")
    us_amount: float | None = Field(default=None, description="US volume quantity if present (e.g. cups, oz, lbs)")
    us_unit: str | None = Field(default=None, description="US volume unit if present")
    metric_amount: float | None = Field(default=None, description="Metric weight/volume if present (e.g. grams, ml)")
    metric_unit: str | None = Field(default=None, description="Metric unit if present")
    preparation: str | None = Field(default=None, description="A cooking action ONLY, e.g. 'sifted', 'chopped'")
    subtext: str | None = Field(default=None, description="Alternative ingredients or minor descriptive context (e.g. 'or substitute water') without parentheses")
    note_references: List[int] = Field(default=[], description="List of note indexes (1-based) that this ingredient references from the Recipe's notes array")
    group: str | None = Field(default=None, description="Section name if the recipe has multiple components")

class Recipe(BaseModel):
    title: str = Field(description="Title of the recipe")
    description: Optional[str] = Field(default="", description="Description of the recipe")
    prepTime: Optional[str] = Field(default="", description="Preparation time")
    cookTime: Optional[str] = Field(default="", description="Cooking time")
    servings: Optional[int] = Field(default=1, description="Number of servings")
    ingredients: List[Ingredient] = Field(description="List of ingredients")
    instructions: List[str] = Field(description="List of instruction steps as strings")
    notes: List[str] = Field(default=[], description="List of full-text recipe notes referenced by the ingredients")

class Substitution(BaseModel):
    target_ingredient: str = Field(description="The original ingredient")
    substitution_name: str = Field(description="The name of the substitute ingredient")
    amount: float = Field(description="The mathematically adjusted amount for the substitution")
    unit: str = Field(description="Unit of measurement for the substitute")
    reasoning: str = Field(description="Chemical or culinary reasoning for this substitution")

def extract_recipe(payload: str) -> Recipe:
    """Extracts a structured recipe from a raw HTML or JSON-LD payload."""
    prompt = f"""Extract the recipe from the following HTML or JSON-LD payload.
    
CRITICALLY IMPORTANT INSTRUCTIONS:
1. The 'name' field MUST contain the primary ingredient name. Keep it concise but descriptive. NO parentheses.
2. The 'preparation' field MUST ONLY contain cooking actions (e.g. "sifted", "chopped", "melted").
3. AMOUNTS AND UNITS: If a recipe provides both US and Metric measurements (e.g., "1 cup / 120g", "7oz / 200g"), you MUST extract BOTH into their respective us_amount/us_unit and metric_amount/metric_unit fields. Do not put them in subtext.
4. The 'subtext' field MUST contain alternative ingredient suggestions or descriptive context (e.g. "or substitute other plain biscuits", "at room temperature"). NO parentheses.
5. RECIPE NOTES: If an ingredient mentions a note (e.g. "Note 1", "see Note 2"), DO NOT put the note text in the ingredient. Instead:
   a) Search the entire payload (usually at the bottom) for the full text of that note.
   b) Add the full text as a string to the `Recipe.notes` array.
   c) Add the 1-based index of that note to the `Ingredient.note_references` array (e.g., `[1]`).
6. NEVER put parentheses ( ) in ANY field.
7. If the recipe has multiple components (e.g. "Cake" and "Frosting"), you MUST extract these section names and put them in the "group" field for EVERY corresponding ingredient.

Payload:
{payload}
"""

    try:
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=Recipe,
                temperature=0.0,
                # Disable thinking — gemini-2.5-flash enables it by default, which can produce
                # an empty response.text when combined with response_schema constrained output.
                thinking_config=types.ThinkingConfig(thinking_budget=0)
            )
        )
        if not response.text:
            # Log candidates for debug insight (safety blocks etc.)
            finish_reason = response.candidates[0].finish_reason if response.candidates else "unknown"
            raise ValueError(f"Empty response from LLM (finish_reason={finish_reason})")
        return Recipe.model_validate_json(response.text)
    except Exception as e:
        logger.error(f"Error extracting recipe: {e}")
        raise

def get_substitution(recipe_context: dict, target_ingredient: str) -> Substitution:
    """Analyzes a recipe and returns a chemically/mathematically adjusted substitution."""
    prompt = f"Analyze this recipe: {recipe_context}\n\nThe user wants a substitution for: {target_ingredient}.\nAnalyze its chemical and culinary role in the recipe and output a mathematically adjusted substitution."
    try:
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=Substitution,
                temperature=0.2,
                thinking_config=types.ThinkingConfig(thinking_budget=0)
            )
        )
        if not response.text:
            finish_reason = response.candidates[0].finish_reason if response.candidates else "unknown"
            raise ValueError(f"Empty response from LLM (finish_reason={finish_reason})")
        return Substitution.model_validate_json(response.text)
    except Exception as e:
        logger.error(f"Error getting substitution: {e}")
        raise
