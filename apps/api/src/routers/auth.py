from fastapi import APIRouter, Query, Response
from fastapi.responses import RedirectResponse
import urllib.parse
from src.config import settings

router = APIRouter()

@router.get("/consent")
async def oauth_consent(redirect_to: str | None = Query(default=None)):
    """
    Initiates the Google OAuth flow via Supabase.
    This endpoint sits between the Chrome Extension and Supabase to hide the raw
    Supabase project URL and keys from the bundled client code.
    """
    
    # Base Supabase OAuth authorization URL
    auth_url = f"{settings.supabase_url}/auth/v1/authorize?provider=google"
    
    # If a redirect_to parameter is provided (e.g., the Chrome Extension deep link), append it
    if redirect_to:
        encoded_redirect = urllib.parse.quote(redirect_to)
        auth_url += f"&redirect_to={encoded_redirect}"
        
    return RedirectResponse(url=auth_url)
