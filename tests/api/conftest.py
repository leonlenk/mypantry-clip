"""
Shared fixtures for all API tests.

Every external dependency (Supabase, Redis, Gemini LLM) is mocked here so
tests run entirely offline with zero side-effects.
"""

import sys
import os
import pytest
from unittest.mock import patch, MagicMock

# Ensure the API source root is importable without installing the package.
API_ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "apps", "api")
sys.path.insert(0, os.path.abspath(API_ROOT))

# ---------------------------------------------------------------------------
# Must patch settings BEFORE importing `main`, because module-level code in
# routers/services reads settings at import time.
# ---------------------------------------------------------------------------

_ENV_OVERRIDES = {
    "SUPABASE_URL": "https://fake.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY": "fake-service-role-key",
    "SUPABASE_JWT_SECRET": "fake-jwt-secret",
    "UPSTASH_REDIS_REST_URL": "https://fake-redis.upstash.io",
    "UPSTASH_REDIS_REST_TOKEN": "fake-redis-token",
    "GEMINI_API_KEY": "fake-gemini-key",
    "EXTENSION_ID": "fake-extension-id",
    "MAX_PAYLOAD_CHARS": "200",
    "EXTRACT_DAILY_LIMIT": "3",
    "EXTRACT_WEEKLY_LIMIT": "5",
    "SUBSTITUTE_DAILY_LIMIT": "3",
    "SUBSTITUTE_WEEKLY_LIMIT": "5",
}


@pytest.fixture(autouse=True)
def _patch_env(monkeypatch):
    """Inject fake env vars so `Settings()` never needs a real .env file."""
    for key, value in _ENV_OVERRIDES.items():
        monkeypatch.setenv(key, value)


@pytest.fixture(autouse=True)
def _mock_genai_client():
    """
    Mock google.genai.Client so the module-level constructor in src/services/llm.py
    never attempts a real HTTP connection (blocked by SOCKS proxy in sandbox/CI).
    Tests that need specific call behaviour patch `src.services.llm.client` directly.
    """
    with patch("google.genai.Client") as mock_ctor:
        mock_ctor.return_value = MagicMock()
        yield


# ---------------------------------------------------------------------------
# Lazy app import — deferred until after env is patched.
# ---------------------------------------------------------------------------

@pytest.fixture()
def app():
    """Import and return the FastAPI app with patched env."""
    # Force re-import so settings pick up the monkeypatched env.
    # We invalidate cached modules to get a clean slate per test.
    modules_to_clear = [m for m in sys.modules if m.startswith("src") or m == "main"]
    for m in modules_to_clear:
        del sys.modules[m]

    from main import app as _app
    return _app


@pytest.fixture()
def client(app):
    """HTTPX TestClient wrapping the live FastAPI app."""
    from fastapi.testclient import TestClient
    return TestClient(app)


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------

FAKE_USER_ID = "test-user-00000000-0000-0000-0000-000000000000"


@pytest.fixture()
def auth_headers():
    """Returns a Bearer Authorization header with a fake token."""
    return {"Authorization": "Bearer fake-jwt-token"}


@pytest.fixture()
def mock_verify_jwt(app):
    """
    Overrides the verify_jwt dependency globally so every authenticated
    endpoint returns FAKE_USER_ID without touching real keys.
    """
    from src.dependencies.auth import verify_jwt

    app.dependency_overrides[verify_jwt] = lambda: FAKE_USER_ID
    yield
    app.dependency_overrides.pop(verify_jwt, None)


# ---------------------------------------------------------------------------
# Rate-limit mock
# ---------------------------------------------------------------------------

@pytest.fixture()
def mock_rate_limit():
    """Patches check_rate_limit_and_telemetry at each router's import site."""
    with patch("src.routers.extract.check_rate_limit_and_telemetry") as m_extract, \
         patch("src.routers.substitute.check_rate_limit_and_telemetry") as m_substitute:
        yield m_extract


# ---------------------------------------------------------------------------
# Supabase mock
# ---------------------------------------------------------------------------

def _build_supabase_mock(data=None):
    """Returns a mock Supabase client with a chainable .table() interface."""
    mock_client = MagicMock()
    mock_result = MagicMock()
    mock_result.data = data or []

    # Every chain method returns itself for fluent calls.
    chain = MagicMock()
    chain.execute.return_value = mock_result
    chain.eq.return_value = chain
    chain.gt.return_value = chain
    chain.order.return_value = chain
    chain.limit.return_value = chain
    chain.range.return_value = chain
    chain.select.return_value = chain
    chain.upsert.return_value = chain
    chain.delete.return_value = chain

    mock_client.table.return_value = chain
    return mock_client, chain, mock_result


@pytest.fixture()
def mock_supabase():
    """Patches get_supabase_client and yields (mock_client, chain, mock_result).

    Must patch at every import site — Python caches the name binding in each
    module, so patching only the definition module has no effect on callers
    that already imported the symbol.
    """
    mock_client, chain, mock_result = _build_supabase_mock()
    with patch("src.services.supabase_client.get_supabase_client", return_value=mock_client), \
         patch("src.routers.sync.get_supabase_client", return_value=mock_client):
        yield mock_client, chain, mock_result


# ---------------------------------------------------------------------------
# Redis mock
# ---------------------------------------------------------------------------

@pytest.fixture()
def mock_redis():
    """Patches the Redis instance used by the rate limiter."""
    with patch("src.dependencies.rate_limit.redis") as m:
        m.incr.return_value = 1
        m.expire.return_value = True
        yield m


# ---------------------------------------------------------------------------
# Sample data
# ---------------------------------------------------------------------------

@pytest.fixture()
def sample_recipe_dict():
    """A realistic recipe dict matching the Recipe Pydantic schema."""
    return {
        "id": "recipe-001",
        "title": "Classic Pancakes",
        "description": "Fluffy buttermilk pancakes.",
        "prepTime": 10,
        "cookTime": 15,
        "servings": 4,
        "ingredients": [
            {
                "name": "all-purpose flour",
                "us_amount": 1.5,
                "us_unit": "cups",
                "metric_amount": 190,
                "metric_unit": "g",
                "preparation": "sifted",
                "subtext": None,
                "note_references": [],
                "group": None,
            }
        ],
        "instructions": ["Mix dry ingredients.", "Add wet ingredients.", "Cook on griddle."],
        "tags": ["breakfast", "quick"],
        "notes": [],
    }
