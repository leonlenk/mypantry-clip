"""
/api/sync — Cloud recipe sync endpoints.

All endpoints are authenticated via verify_jwt (ES256 Supabase JWT).
The backend uses the service-role Supabase client to act on behalf of the
verified user_id, filtering every query by user_id explicitly.

Cloud sync is JSON-only backup/restore. Embeddings are computed client-side
and stored exclusively in IndexedDB — they are never sent to or returned from
the cloud, since Supabase is not used for vector search.

Endpoint summary:
  POST   /api/sync/save          — Upsert a recipe's JSON to the cloud.
  GET    /api/sync/latest        — Return just the newest updated_at timestamp.
  GET    /api/sync/list          — Return all (or delta) recipe JSON blobs.
  DELETE /api/sync/delete/{id}   — Delete a recipe by id for the user.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Any
from loguru import logger
import traceback

from src.dependencies.auth import verify_jwt
from src.services.supabase_client import get_supabase_client

router = APIRouter(prefix="/api/sync", tags=["sync"])

TABLE = "recipes"


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class SaveRecipeRequest(BaseModel):
    # The full Recipe object from the client (embedding field must be excluded
    # by the caller — it is not stored in the cloud).
    recipe: dict[str, Any]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/save")
def save_recipe(request: SaveRecipeRequest, user_id: str = Depends(verify_jwt)):
    """
    Upsert a recipe JSON blob for the authenticated user.
    The embedding is intentionally excluded — the cloud is a pure backup store.
    """
    recipe = request.recipe
    recipe_id = recipe.get("id")
    if not recipe_id:
        raise HTTPException(status_code=400, detail="Recipe must have an `id` field.")

    recipe_json = {k: v for k, v in recipe.items() if k != "embedding"}

    row = {
        "id": recipe_id,
        "user_id": user_id,
        "recipe_json": recipe_json,
        "updated_at": "now()",
    }

    try:
        client = get_supabase_client()
        client.table(TABLE).upsert(row, on_conflict="id").execute()
        logger.info(f"[Sync] Upserted recipe '{recipe_id}' for user {user_id}")
        return {"success": True, "id": recipe_id}
    except Exception as e:
        logger.error(f"[Sync] Save failed: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to save recipe: {e}")


@router.get("/latest")
def get_latest_timestamp(user_id: str = Depends(verify_jwt)):
    """
    Returns the most recent `updated_at` timestamp for the user.
    Used by the pantry dashboard on open for a cheap staleness check —
    only one row is fetched via the (user_id, updated_at desc) index.
    """
    try:
        client = get_supabase_client()
        result = (
            client.table(TABLE)
            .select("updated_at")
            .eq("user_id", user_id)
            .order("updated_at", desc=True)
            .limit(1)
            .execute()
        )
        rows = result.data or []
        latest = rows[0]["updated_at"] if rows else None
        return {"latest_updated_at": latest}
    except Exception as e:
        logger.error(f"[Sync] Latest timestamp query failed: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to get latest timestamp: {e}")


@router.get("/list")
def list_recipes(user_id: str = Depends(verify_jwt), since: str | None = None):
    """
    Return recipe JSON blobs for the authenticated user, ordered newest-first.

    Optional `since` (ISO-8601 timestamp) enables differential sync: only
    recipes with updated_at > since are returned, making frequent polls cheap.
    """
    try:
        client = get_supabase_client()
        query = (
            client.table(TABLE)
            .select("id, recipe_json, updated_at")
            .eq("user_id", user_id)
            .order("updated_at", desc=True)
        )
        if since:
            query = query.gt("updated_at", since)

        result = query.execute()
        recipes = result.data or []
        logger.info(f"[Sync] Listed {len(recipes)} recipes for user {user_id} (since={since or 'all'})")
        return {"recipes": recipes}
    except Exception as e:
        logger.error(f"[Sync] List failed: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to list recipes: {e}")


@router.delete("/delete/{recipe_id}")
def delete_recipe(recipe_id: str, user_id: str = Depends(verify_jwt)):
    """
    Delete a recipe by id, scoped to the authenticated user.
    Filters by both id and user_id to prevent cross-user deletion.
    """
    try:
        client = get_supabase_client()
        client.table(TABLE).delete().eq("id", recipe_id).eq("user_id", user_id).execute()
        logger.info(f"[Sync] Deleted recipe '{recipe_id}' for user {user_id}")
        return {"success": True, "id": recipe_id}
    except Exception as e:
        logger.error(f"[Sync] Delete failed: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to delete recipe: {e}")
