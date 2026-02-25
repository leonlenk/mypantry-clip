from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    supabase_url: str
    supabase_jwt_secret: str | None = None
    supabase_pub_key_path: str = "supabase_pub_key.json"
    upstash_redis_rest_url: str
    upstash_redis_rest_token: str
    gemini_api_key: str
    extension_id: str

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

settings = Settings()
