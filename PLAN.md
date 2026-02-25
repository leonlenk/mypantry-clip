# Plan for Python Backend Implementation (`apps/api`)

## 1. Goal
Implement the Python backend in accordance with the updated `architecture.md` specification. The backend will act strictly as a secure API router and LLM proxy, utilizing Supabase for the database, authentication, and vector search, and Upstash Redis for rate limiting. **Crucially, the API will not perform any vector mathematics or generate embeddings; all embeddings are pre-computed on the client Edge AI (via `Transformers.js`).**

## 2. Dependencies Setup
Using `uv`, we will install the required lightweight dependencies, completely avoiding heavy ML libraries like PyTorch:
- **Framework & Config:** `fastapi`, `uvicorn`, `pydantic`, `pydantic-settings`
- **Database & Auth:** `supabase`, `PyJWT` (for fast and secure offline verification of Supabase access tokens)
- **Rate Limiting:** `upstash-redis`

## 3. Proposed Architecture & Architecture

### Directory Structure
```text
apps/api/
├── pyproject.toml
├── .env.example
└── src/
    ├── main.py (App entrypoint & routing)
    ├── core/
    │   ├── config.py (Environment variables loading: SUPABASE_URL, UPSTASH_REDIS, etc.)
    │   ├── auth.py (Supabase JWT verification middleware/dependency)
    │   ├── rate_limit.py (Upstash token bucket implementation)
    │   └── llm.py (Orchestrates LLM proxy calls, using local 5050 if applicable for testing)
    ├── models/
    │   └── schema.py (Pydantic models mapping to recipe schema and pre-computed embeddings)
    └── api/
        └── routes.py (FastAPI endpoints)
```

### Core Features to Implement
1. **Config Validation**: Strongly typed environment variable loading with `pydantic-settings`.
2. **Supabase Auth Middleware**: A `Depends` function in FastAPI built to intercept `Authorization: Bearer <token>`, securely verify the JWT against Supabase's secret, and extract the authenticated User ID.
3. **Upstash Rate Limiting**: Token Bucket setup (e.g., 50 req/day per User ID) checking on routes before permitting any LLM proxy requests to prevent abuse.
4. **Endpoints**:
   - `POST /api/v1/extract`: Proxies DOM/JSON-LD text payloads to the configured LLM for extraction (rate-limited).
   - `POST /api/v1/recipes`: Receives a finished recipe object *including the pre-computed vector embedding* and saves it to the user's Supabase `pgvector` container.
   - `GET /api/v1/recipes`: Retrieves the user's saved recipes to sync with the local extension pantry.

## 4. Execution Plan
1. Delete any heavy ML dependencies if they were temporarily added earlier.
2. Initialize and lock the `uv` dependencies.
3. Build the core modules (`config.py`, `auth.py`, `rate_limit.py`).
4. Implement the Pydantic schemas in `models/schema.py`, ensuring the embedding array is accepted.
5. Create the API routes and tie them into `main.py`.
6. Test using an offline mock JWT or script to ensure auth and routing function correctly without invoking heavy ML processes.
