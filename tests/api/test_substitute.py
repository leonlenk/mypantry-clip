"""
Tests for POST /api/substitute/ — ingredient substitution endpoint.

Covers: happy path, missing fields, auth, rate limiting, and LLM errors.
"""

from unittest.mock import patch, MagicMock


VALID_BODY = {
    "recipe_context": {
        "title": "Chocolate Cake",
        "ingredients": [{"name": "butter", "us_amount": 1, "us_unit": "cup"}],
        "instructions": ["Cream butter and sugar."],
    },
    "target_ingredient": "butter",
}


class TestSubstituteEndpoint:
    """Integration tests for the substitute router."""

    # ---- happy path --------------------------------------------------------

    def test_substitute_success(self, client, mock_verify_jwt, mock_rate_limit):
        """Valid request returns structured substitution JSON."""
        fake_sub = MagicMock()
        fake_sub.model_dump.return_value = {
            "target_ingredient": "butter",
            "substitution_name": "coconut oil",
            "amount": 1.0,
            "unit": "cup",
            "reasoning": "Similar fat content and melting point.",
        }

        with patch("src.routers.substitute.get_substitution", return_value=fake_sub):
            resp = client.post("/api/substitute/", json=VALID_BODY)

        assert resp.status_code == 200
        body = resp.json()
        assert "substitution" in body
        assert body["substitution"]["substitution_name"] == "coconut oil"

    def test_substitute_response_shape(self, client, mock_verify_jwt, mock_rate_limit):
        """Response includes all expected Substitution fields."""
        fake_sub = MagicMock()
        fake_sub.model_dump.return_value = {
            "target_ingredient": "butter",
            "substitution_name": "margarine",
            "amount": 1.0,
            "unit": "cup",
            "reasoning": "1:1 replacement in baking.",
        }

        with patch("src.routers.substitute.get_substitution", return_value=fake_sub):
            resp = client.post("/api/substitute/", json=VALID_BODY)

        data = resp.json()["substitution"]
        for key in ("target_ingredient", "substitution_name", "amount", "unit", "reasoning"):
            assert key in data, f"Missing key: {key}"

    # ---- validation --------------------------------------------------------

    def test_substitute_missing_recipe_context(self, client, mock_verify_jwt):
        """Request missing recipe_context returns 422."""
        resp = client.post("/api/substitute/", json={"target_ingredient": "butter"})
        assert resp.status_code == 422

    def test_substitute_missing_target_ingredient(self, client, mock_verify_jwt):
        """Request missing target_ingredient returns 422."""
        resp = client.post("/api/substitute/", json={"recipe_context": {"title": "Cake"}})
        assert resp.status_code == 422

    def test_substitute_empty_body(self, client, mock_verify_jwt):
        """Empty JSON body returns 422."""
        resp = client.post("/api/substitute/", json={})
        assert resp.status_code == 422

    # ---- auth / rate-limit -------------------------------------------------

    def test_substitute_unauthenticated(self, client):
        """Request without Authorization header returns 401 or 403."""
        resp = client.post("/api/substitute/", json=VALID_BODY)
        assert resp.status_code in (401, 403)

    def test_substitute_rate_limited(self, client, mock_verify_jwt):
        """When rate limiter raises 429, endpoint propagates it."""
        with patch(
            "src.routers.substitute.check_rate_limit_and_telemetry",
            side_effect=__import__("fastapi").HTTPException(status_code=429, detail="Rate limit exceeded"),
        ):
            resp = client.post("/api/substitute/", json=VALID_BODY)
        assert resp.status_code == 429

    # ---- LLM errors --------------------------------------------------------

    def test_substitute_llm_error(self, client, mock_verify_jwt, mock_rate_limit):
        """When the LLM service raises, endpoint returns 500."""
        with patch("src.routers.substitute.get_substitution", side_effect=RuntimeError("LLM failed")):
            resp = client.post("/api/substitute/", json=VALID_BODY)

        assert resp.status_code == 500
        assert "substitution" in resp.json()["detail"].lower()
