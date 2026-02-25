import sys
import traceback
from src.services.llm import extract_recipe

try:
    print("Extracting...")
    res = extract_recipe("<html><body>Spaghetti recipe</body></html>")
    print(res)
except Exception as e:
    with open("error.log", "w") as f:
        traceback.print_exc(file=f)
    print("Error saved to error.log")
