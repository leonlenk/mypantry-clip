from fastapi import APIRouter, Depends, HTTPException
from src.config import settings
from src.dependencies.auth import verify_jwt
from src.dependencies.rate_limit import check_rate_limit_and_telemetry
from src.services.llm import get_substitution
from pydantic import BaseModel
from loguru import logger
from typing import Dict, Any
import traceback
import json

router = APIRouter(prefix="/substitute", tags=["substitute"])

class SubstituteRequest(BaseModel):
    recipe_context: Dict[str, Any]
    target_ingredient: str

@router.post("/")
def substitute_endpoint(request: SubstituteRequest, user_id: str = Depends(verify_jwt)):
    """Suggests an ingredient substitution given a recipe context. Rate limited."""
    max_chars = settings.max_payload_chars
    payload_size = len(json.dumps(request.recipe_context)) + len(request.target_ingredient)
    if payload_size > max_chars:
        raise HTTPException(
            status_code=413,
            detail=f"Payload too large ({payload_size:,} chars). Maximum is {max_chars:,} characters."
        )

    check_rate_limit_and_telemetry(user_id=user_id, endpoint="substitute", daily_limit=settings.substitute_daily_limit, weekly_limit=settings.substitute_weekly_limit)
    
    try:
        sub = get_substitution(request.recipe_context, request.target_ingredient)
        return {"substitution": sub.model_dump()}
    except Exception as e:
        logger.error(f"Substitution failed: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail="Failed to calculate substitution")
