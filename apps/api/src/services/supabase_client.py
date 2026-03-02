from functools import lru_cache
from supabase import create_client, Client
from src.config import settings
from loguru import logger


@lru_cache(maxsize=1)
def get_supabase_client() -> Client:
    """
    Returns a cached Supabase client authenticated with the service-role key.

    We deliberately use the service-role key (not the anon key) so the backend
    can bypass Row Level Security and write on behalf of any user_id it extracts
    from the already-verified JWT.  User ownership is enforced by passing
    user_id into every query — NOT by relying on RLS auth.uid() here.
    """
    if not settings.supabase_service_role_key:
        raise RuntimeError(
            "SUPABASE_SERVICE_ROLE_KEY is not set. "
            "Add it to apps/api/.env to enable cloud sync."
        )

    client: Client = create_client(
        settings.supabase_url,
        settings.supabase_service_role_key,
    )
    logger.info("Supabase client initialised (service-role).")
    return client
