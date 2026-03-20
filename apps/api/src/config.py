from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    supabase_url: str
    supabase_service_role_key: str | None = None
    supabase_jwt_secret: str | None = None
    supabase_pub_key_path: str = "supabase_pub_key.json"
    upstash_redis_rest_url: str
    upstash_redis_rest_token: str
    gemini_api_key: str
    extension_id: str
    max_payload_chars: int = 20_000
    extract_daily_limit: int = 15
    extract_weekly_limit: int = 50
    substitute_daily_limit: int = 15
    substitute_weekly_limit: int = 50
    public_base_url: str = "https://mypantry.dev"
    share_expiry_days: int = 30

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

settings = Settings()
