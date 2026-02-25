from google import genai
from google.genai import types
from src.config import settings
from pydantic import BaseModel, Field
from typing import List, Optional
from loguru import logger

client = genai.Client(api_key=settings.gemini_api_key)

class Ingredient(BaseModel):
    name: str = Field(description="Name of the ingredient")
    amount: float = Field(description="Quantity or amount")
    unit: str = Field(description="Unit of measurement, empty string if none")

class Recipe(BaseModel):
    title: str = Field(description="Title of the recipe")
    description: Optional[str] = Field(default="", description="Description of the recipe")
    prepTime: Optional[str] = Field(default="", description="Preparation time")
    cookTime: Optional[str] = Field(default="", description="Cooking time")
    servings: Optional[int] = Field(default=1, description="Number of servings")
    ingredients: List[Ingredient] = Field(description="List of ingredients")
    instructions: List[str] = Field(description="List of instruction steps as strings")

class Substitution(BaseModel):
    target_ingredient: str = Field(description="The original ingredient")
    substitution_name: str = Field(description="The name of the substitute ingredient")
    amount: float = Field(description="The mathematically adjusted amount for the substitution")
    unit: str = Field(description="Unit of measurement for the substitute")
    reasoning: str = Field(description="Chemical or culinary reasoning for this substitution")

def extract_recipe(payload: str) -> Recipe:
    """Extracts a structured recipe from a raw HTML or JSON-LD payload."""
    prompt = f"Extract the recipe from the following HTML or JSON-LD payload:\n\n{payload}"
    try:
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=Recipe,
                temperature=0.0
            )
        )
        if response.text:
            return Recipe.model_validate_json(response.text)
        else:
            raise ValueError("Empty response from LLM")
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
                temperature=0.2
            )
        )
        if response.text:
            return Substitution.model_validate_json(response.text)
        else:
            raise ValueError("Empty response from LLM")
    except Exception as e:
        logger.error(f"Error getting substitution: {e}")
        raise
