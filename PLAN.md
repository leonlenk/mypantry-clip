# Plan for Python Backend Implementation (`apps/api`)

## 1. Goal
Implement the Python backend in accordance with the `architecture.md` specification. This includes setting up a FastAPI app with Supabase authentication, Upstash Redis rate limiting, and configuring local CUDA acceleration for embedding generation.

## 2. User Review Required
> [!IMPORTANT]
> The setup involves adding dependencies for PyTorch with CUDA support, which can be quite large. Please review the planned dependencies and the endpoint structure before I begin implementation. Ensure you have the `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_JWT_SECRET`, `UPSTASH_REDIS_REST_URL`, and `UPSTASH_REDIS_REST_TOKEN` ready in your environment or `.env` file eventually.

## 3. Proposed Changes

### Dependencies (`apps/api`)
Using `uv`, I will add the necessary dependencies:
- **Framework:** `fastapi`, `uvicorn`, `pydantic`, `pydantic-settings`
- **Auth & DB:** `supabase`, `PyJWT` (for fast offline JWT verification of Supabase tokens)
- **Rate Limiting:** `upstash-redis`
- **AI & ML:** `torch` (CUDA configured), `sentence-transformers` for local embedding generation.

### Directory Structure
```text
apps/api/
├── pyproject.toml
├── .env.example
└── src/
    ├── main.py (App entrypoint & routing)
    ├── core/
    │   ├── config.py (Environment variables loading)
    │   ├── auth.py (Supabase JWT verification middleware/dependency)
    │   ├── rate_limit.py (Upstash token bucket implementation)
    │   └── llm.py (Local GPU embedding generator & LLM proxy)
    ├── models/
    │   └── schema.py (Pydantic models for API payloads)
    └── api/
        └── routes.py (FastAPI endpoints)
```

### Core Features to Implement
1. **Config & Environment**: Handle `.env` loading for Supabase and Upstash credentials.
2. **Supabase Auth Middleware**: A FastAPI `Depends` function that intercepts the `Authorization: Bearer <token>`, decodes it securely, and extracts the authenticated User ID.
3. **Upstash Rate Limiting**: A strict Token Bucket algorithm (e.g., 50 requests/day per User ID) checked before allowing access to LLM routes.
4. **Local CUDA Embedding Engine**: A singleton class loading `all-MiniLM-L6-v2` via `sentence-transformers` mapped to `cuda` device, utilizing your local Nvidia 5050.
5. **Endpoints**:
   - `POST /api/v1/extract`: Proxies recipe extraction to an LLM for cloud users (rate-limited).
   - `POST /api/v1/embeddings`: Generates vector embeddings for a given text using the local active GPU.
   - `GET /api/v1/recipes` & `POST /api/v1/recipes`: Endpoints to sync recipes with Supabase pgvector database.

## 4. Verification Plan
- Run `uv sync` to ensure all CUDA and web dependencies install properly.
- Run `uv run uvicorn src.main:app --reload` and check the `/docs` Swagger UI.
- Implement a dummy test client script in Python to ping the `/api/v1/embeddings` endpoint and verify the CUDA tensor generation works without errors.
- Ensure the rate limiting correctly throws a `429 Too Many Requests` after consecutive automated hits (with a low test threshold).
