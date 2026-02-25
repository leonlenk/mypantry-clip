# AI Recipes: Pantry Clip

A privacy-first, hybrid-architecture recipe assistant featuring a local vector database, cloud syncing, and edge-AI embedding generation.

## Monorepo Structure

* `/apps/extension` - The Chrome Extension built with Astro
* `/apps/api` - The FastAPI Python backend

## Backend Setup (/apps/api)

The backend acts as a secure router, rate limiter, and LLM proxy. It does **not** process embeddings locally; all embeddings are strictly computed on the client via WASM.

### Prerequisites
* Python 3.14+
* `uv` (the ultrafast Python package installer and resolver)

### Installation
1. Ensure `uv` is installed globally.
2. In the `apps/api` directory, create a `.env` file from the sample:
   ```bash
   cp apps/api/.env.example apps/api/.env
   ```
3. Populate `.env` with your actual credentials:

#### Supabase Setup
- Create a new project in [Supabase](https://supabase.com).
- Go to **Project Settings -> API** to find your `SUPABASE_URL` and `SUPABASE_JWT_SECRET`.
- To enable authentication, go to **Authentication -> Providers** and enable Google OAuth.
- You will need to configure your Google Cloud Console OAuth credentials (Client ID and Client Secret) to allow users to sign in.

#### Upstash Redis Setup
- Create a new Redis database in [Upstash](https://upstash.com).
- Under the **REST API** section of your new database dashboard, securely copy the `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

#### Other Credentials
- `GEMINI_API_KEY` for recipe extraction and substitution reasoning. Get this from Google AI Studio.
- `EXTENSION_ID` required for CORS (matches your local or published Chrome Extension ID).

### Running the Backend
From the root of the project, run:
```bash
pnpm run dev:api
```
This command changes into the `apps/api` directory and starts the server via `uv run uvicorn main:app --reload`. The backend will be available at `http://localhost:8000`.
