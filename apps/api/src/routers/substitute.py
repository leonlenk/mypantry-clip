from fastapi import APIRouter, Depends, HTTPException
from src.dependencies.auth import verify_jwt
from src.dependencies.rate_limit import check_rate_limit_and_telemetry
from src.services.llm import get_substitution
from pydantic import BaseModel
from loguru import logger
from typing import Dict, Any
import traceback

router = APIRouter(prefix="/api/substitute", tags=["substitute"])

class SubstituteRequest(BaseModel):
    recipe_context: Dict[str, Any]
    target_ingredient: str

@router.post("/")
def substitute_endpoint(request: SubstituteRequest, user_id: str = Depends(verify_jwt)):
    """Suggests an ingredient substitution given a recipe context. Rate limited."""
    check_rate_limit_and_telemetry(user_id=user_id, endpoint="substitute")
    
    try:
        sub = get_substitution(request.recipe_context, request.target_ingredient)
        return {"substitution": sub.model_dump()}
    except Exception as e:
        logger.error(f"Substitution failed: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail="Failed to calculate substitution")
