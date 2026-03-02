from fastapi import APIRouter, Depends, HTTPException
from src.config import settings
from src.dependencies.auth import verify_jwt
from src.dependencies.rate_limit import check_rate_limit_and_telemetry
from src.services.llm import extract_recipe
from pydantic import BaseModel
from loguru import logger
import traceback

router = APIRouter(prefix="/api/extract", tags=["extract"])

class ExtractRequest(BaseModel):
    payload: str

@router.post("/")
def extract_endpoint(request: ExtractRequest, user_id: str = Depends(verify_jwt)):
    """Extracts a recipe from raw HTML/JSON-LD. Rate limited."""
    # Guard against oversized payloads before touching the LLM.
    # Limit is driven by MAX_PAYLOAD_CHARS in .env (default 20,000).
    max_chars = settings.max_payload_chars
    if len(request.payload) > max_chars:
        raise HTTPException(
            status_code=413,
            detail=f"Payload too large ({len(request.payload):,} chars). Maximum is {max_chars:,} characters."
        )

    check_rate_limit_and_telemetry(user_id=user_id, endpoint="extract")

    try:
        recipe = extract_recipe(request.payload)
        return {"recipe": recipe.model_dump()}
    except Exception as e:
        logger.error(f"Extraction failed: {traceback.format_exc()}")
        # Surface the real error message — this is a private internal API so no info-disclosure risk.
        raise HTTPException(status_code=500, detail=f"Failed to extract recipe: {e}")
