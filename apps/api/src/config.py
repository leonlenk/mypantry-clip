import os
import re
from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_EXTENSION_ID_RE = re.compile(r"^[a-p]{32}$")


class Settings(BaseSettings):
    supabase_url: str
    supabase_service_role_key: str
    supabase_pub_key_path: str = "supabase_pub_key.json"
    upstash_redis_rest_url: str
    upstash_redis_rest_token: str
    gemini_api_key: str
    gemini_model: str = "gemini-2.5-flash"
    extension_id: str
    max_payload_chars: int = 20_000
    extract_daily_limit: int = 15
    extract_weekly_limit: int = 50
    substitute_daily_limit: int = 15
    substitute_weekly_limit: int = 50
    share_daily_limit: int = 100
    share_weekly_limit: int = 500
    public_base_url: str = "https://mypantry.dev"
    share_expiry_days: int = 30
    # Set to true in development to allow localhost CORS origins
    cors_allow_localhost: bool = False
    supabase_request_timeout: int = 30
    jwt_audience: str = "authenticated"

    model_config = SettingsConfigDict(
        env_file=(
            (".env", os.environ["ENV_FILE"])
            if os.environ.get("ENV_FILE") and os.environ["ENV_FILE"] != ".env"
            else ".env"
        ),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @model_validator(mode="after")
    def validate_required_fields(self) -> "Settings":
        if not self.supabase_url:
            raise ValueError("SUPABASE_URL is required")
        if not self.supabase_service_role_key:
            raise ValueError("SUPABASE_SERVICE_ROLE_KEY is required")
        if not self.upstash_redis_rest_url:
            raise ValueError("UPSTASH_REDIS_REST_URL is required")
        if not self.upstash_redis_rest_token:
            raise ValueError("UPSTASH_REDIS_REST_TOKEN is required")
        if not self.gemini_api_key:
            raise ValueError("GEMINI_API_KEY is required")
        if not self.extension_id:
            raise ValueError("EXTENSION_ID is required")
        if not _EXTENSION_ID_RE.match(self.extension_id):
            raise ValueError(
                f"EXTENSION_ID '{self.extension_id}' is not a valid Chrome extension ID "
                "(must be 32 lowercase a-p characters)"
            )
        return self


settings = Settings()
