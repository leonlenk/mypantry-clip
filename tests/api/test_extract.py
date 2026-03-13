"""
Tests for POST /api/extract/ — recipe extraction endpoint.

Covers: happy path, payload size limits, auth, rate limiting, and LLM errors.
"""

from unittest.mock import patch, MagicMock
from tests.api.conftest import FAKE_USER_ID


class TestExtractEndpoint:
    """Integration tests for the extract router."""

    # ---- happy path --------------------------------------------------------

    def test_extract_success(self, client, mock_verify_jwt, mock_rate_limit):
        """Valid payload returns structured recipe JSON."""
        fake_recipe = MagicMock()
        fake_recipe.model_dump.return_value = {
            "title": "Test Recipe",
            "ingredients": [],
            "instructions": ["Step 1"],
        }

        with patch("src.routers.extract.extract_recipe", return_value=fake_recipe):
            resp = client.post(
                "/api/extract/",
                json={"payload": "<html>recipe html</html>"},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert "recipe" in body
        assert body["recipe"]["title"] == "Test Recipe"

    def test_extract_returns_full_recipe_shape(self, client, mock_verify_jwt, mock_rate_limit):
        """Response includes all expected Recipe fields."""
        full_recipe = {
            "title": "Pancakes",
            "description": "Fluffy",
            "prepTime": 10,
            "cookTime": 15,
            "servings": 4,
            "ingredients": [{"name": "flour"}],
            "instructions": ["Mix", "Cook"],
            "notes": [],
        }
        fake_recipe = MagicMock()
        fake_recipe.model_dump.return_value = full_recipe

        with patch("src.routers.extract.extract_recipe", return_value=fake_recipe):
            resp = client.post("/api/extract/", json={"payload": "some html"})

        assert resp.status_code == 200
        data = resp.json()["recipe"]
        for key in ("title", "description", "prepTime", "cookTime", "servings",
                     "ingredients", "instructions", "notes"):
            assert key in data, f"Missing key: {key}"

    # ---- payload size guard ------------------------------------------------

    def test_extract_payload_too_large(self, client, mock_verify_jwt):
        """Payloads exceeding MAX_PAYLOAD_CHARS (200 in test env) get 413."""
        oversized = "x" * 300
        resp = client.post("/api/extract/", json={"payload": oversized})
        assert resp.status_code == 413
        assert "too large" in resp.json()["detail"].lower()

    def test_extract_payload_at_exact_limit(self, client, mock_verify_jwt, mock_rate_limit):
        """Payload exactly at the limit should be accepted."""
        exact = "x" * 200
        fake_recipe = MagicMock()
        fake_recipe.model_dump.return_value = {"title": "OK"}

        with patch("src.routers.extract.extract_recipe", return_value=fake_recipe):
            resp = client.post("/api/extract/", json={"payload": exact})

        assert resp.status_code == 200

    def test_extract_payload_one_over_limit(self, client, mock_verify_jwt):
        """Payload one char over the limit should be rejected."""
        over_by_one = "x" * 201
        resp = client.post("/api/extract/", json={"payload": over_by_one})
        assert resp.status_code == 413

    def test_extract_empty_payload(self, client, mock_verify_jwt, mock_rate_limit):
        """Empty string payload is technically valid (LLM handles it)."""
        fake_recipe = MagicMock()
        fake_recipe.model_dump.return_value = {"title": "Empty"}

        with patch("src.routers.extract.extract_recipe", return_value=fake_recipe):
            resp = client.post("/api/extract/", json={"payload": ""})

        assert resp.status_code == 200

    # ---- auth / rate-limit -------------------------------------------------

    def test_extract_unauthenticated(self, client):
        """Request without Authorization header returns 401 or 403."""
        resp = client.post("/api/extract/", json={"payload": "html"})
        assert resp.status_code in (401, 403)

    def test_extract_rate_limited(self, client, mock_verify_jwt):
        """When rate limiter raises 429, endpoint propagates it."""
        with patch(
            "src.routers.extract.check_rate_limit_and_telemetry",
            side_effect=__import__("fastapi").HTTPException(status_code=429, detail="Rate limit exceeded"),
        ):
            resp = client.post("/api/extract/", json={"payload": "ok"})

        assert resp.status_code == 429

    # ---- LLM errors --------------------------------------------------------

    def test_extract_llm_error_returns_500(self, client, mock_verify_jwt, mock_rate_limit):
        """When the LLM service raises, endpoint returns 500 with safe message."""
        with patch("src.routers.extract.extract_recipe", side_effect=RuntimeError("LLM down")):
            resp = client.post("/api/extract/", json={"payload": "html"})

        assert resp.status_code == 500
        assert "failed to extract" in resp.json()["detail"].lower()

    def test_extract_llm_empty_response(self, client, mock_verify_jwt, mock_rate_limit):
        """When LLM returns empty text, endpoint should still 500 gracefully."""
        with patch("src.routers.extract.extract_recipe", side_effect=ValueError("Empty response")):
            resp = client.post("/api/extract/", json={"payload": "html"})

        assert resp.status_code == 500

    # ---- request validation ------------------------------------------------

    def test_extract_missing_payload_field(self, client, mock_verify_jwt):
        """Request body without 'payload' key returns 422 validation error."""
        resp = client.post("/api/extract/", json={"wrong_key": "data"})
        assert resp.status_code == 422

    def test_extract_non_json_body(self, client, mock_verify_jwt):
        """Non-JSON body returns 422."""
        resp = client.post(
            "/api/extract/",
            content="raw string body",
            headers={"Content-Type": "application/json", "Authorization": "Bearer fake"},
        )
        assert resp.status_code == 422
