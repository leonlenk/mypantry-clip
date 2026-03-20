"""
Unit tests for src/services/llm.py — extract_recipe and get_substitution.

These tests mock `src.services.llm.client` (the module-level genai.Client
instance) so no real Gemini API calls are made.

The conftest `_mock_genai_client` autouse fixture patches `google.genai.Client`
before each test, and the `_fresh_llm_module` fixture below clears the cached
module so it re-imports with the mock active.
"""

import sys
import pytest
from unittest.mock import patch, MagicMock


@pytest.fixture(autouse=True)
def _fresh_llm_module():
    """Force src.services.llm to re-import in each test so the mock client is used."""
    sys.modules.pop("src.services.llm", None)
    yield
    sys.modules.pop("src.services.llm", None)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _client_error(code: int):
    """Create a google.genai ClientError instance with the given HTTP code."""
    from google.genai.errors import ClientError
    # Bypass __init__ to avoid needing the exact constructor signature
    err = Exception.__new__(ClientError)
    err.code = code
    err.args = (f"ClientError {code}",)
    return err


def _mock_response(text: str, finish_reason: str | None = None):
    """Build a fake genai response object."""
    resp = MagicMock()
    resp.text = text
    if finish_reason:
        candidate = MagicMock()
        candidate.finish_reason = finish_reason
        resp.candidates = [candidate]
    else:
        resp.candidates = []
    return resp


_VALID_RECIPE_JSON = """{
    "title": "Pancakes",
    "semantic_summary": "A sweet breakfast dish.",
    "ingredients": [],
    "instructions": []
}"""

_VALID_SUBSTITUTION_JSON = """{
    "target_ingredient": "butter",
    "substitution_name": "coconut oil",
    "amount": 1.0,
    "unit": "cup",
    "reasoning": "Similar fat content and melting point."
}"""


# ---------------------------------------------------------------------------
# extract_recipe
# ---------------------------------------------------------------------------

class TestExtractRecipe:

    def test_success(self):
        """Returns a validated Recipe when LLM response is valid JSON."""
        from src.services.llm import extract_recipe

        with patch("src.services.llm.client") as mock_client:
            mock_client.models.generate_content.return_value = _mock_response(_VALID_RECIPE_JSON)
            result = extract_recipe("<html>Pancakes recipe</html>")

        assert result.title == "Pancakes"
        assert result.semantic_summary == "A sweet breakfast dish."

    def test_empty_response_raises_value_error(self):
        """Raises ValueError when LLM returns empty text with a finish_reason."""
        from src.services.llm import extract_recipe

        with patch("src.services.llm.client") as mock_client:
            mock_client.models.generate_content.return_value = _mock_response("", "SAFETY")
            with pytest.raises(ValueError, match="Empty response"):
                extract_recipe("<html>payload</html>")

    def test_empty_response_no_candidates_shows_unknown(self):
        """Raises ValueError mentioning 'unknown' when candidates list is empty."""
        from src.services.llm import extract_recipe

        resp = MagicMock()
        resp.text = ""
        resp.candidates = []

        with patch("src.services.llm.client") as mock_client:
            mock_client.models.generate_content.return_value = resp
            with pytest.raises(ValueError, match="unknown"):
                extract_recipe("<html>payload</html>")

    def test_invalid_json_raises_validation_error(self):
        """Raises Pydantic ValidationError when JSON doesn't match the Recipe schema."""
        from src.services.llm import extract_recipe
        from pydantic import ValidationError

        with patch("src.services.llm.client") as mock_client:
            mock_client.models.generate_content.return_value = _mock_response('{"wrong_field": 42}')
            with pytest.raises(ValidationError):
                extract_recipe("<html>payload</html>")

    def test_rate_limit_raises_llm_capacity_error(self):
        """Converts a 429 ClientError into LLMCapacityError."""
        from src.services.llm import extract_recipe, LLMCapacityError

        mock_err = _client_error(429)

        with patch("src.services.llm.client") as mock_client:
            mock_client.models.generate_content.side_effect = mock_err
            with pytest.raises(LLMCapacityError):
                extract_recipe("<html>payload</html>")

    def test_non_429_client_error_reraises(self):
        """Re-raises non-429 ClientErrors unchanged."""
        from src.services.llm import extract_recipe

        mock_err = _client_error(500)

        with patch("src.services.llm.client") as mock_client:
            mock_client.models.generate_content.side_effect = mock_err
            with pytest.raises(type(mock_err)):
                extract_recipe("<html>payload</html>")

    def test_generic_exception_reraises(self):
        """Re-raises unexpected exceptions unchanged."""
        from src.services.llm import extract_recipe

        with patch("src.services.llm.client") as mock_client:
            mock_client.models.generate_content.side_effect = RuntimeError("network error")
            with pytest.raises(RuntimeError, match="network error"):
                extract_recipe("<html>payload</html>")


# ---------------------------------------------------------------------------
# get_substitution
# ---------------------------------------------------------------------------

class TestGetSubstitution:

    def test_success(self):
        """Returns a validated Substitution when LLM response is valid JSON."""
        from src.services.llm import get_substitution

        with patch("src.services.llm.client") as mock_client:
            mock_client.models.generate_content.return_value = _mock_response(_VALID_SUBSTITUTION_JSON)
            result = get_substitution({"title": "Cake"}, "butter")

        assert result.substitution_name == "coconut oil"
        assert result.amount == 1.0
        assert result.unit == "cup"

    def test_empty_response_raises_value_error(self):
        """Raises ValueError when LLM returns empty text."""
        from src.services.llm import get_substitution

        with patch("src.services.llm.client") as mock_client:
            mock_client.models.generate_content.return_value = _mock_response("", "MAX_TOKENS")
            with pytest.raises(ValueError, match="Empty response"):
                get_substitution({"title": "Cake"}, "butter")

    def test_empty_response_no_candidates_shows_unknown(self):
        """Raises ValueError with 'unknown' when candidates list is empty."""
        from src.services.llm import get_substitution

        resp = MagicMock()
        resp.text = ""
        resp.candidates = []

        with patch("src.services.llm.client") as mock_client:
            mock_client.models.generate_content.return_value = resp
            with pytest.raises(ValueError, match="unknown"):
                get_substitution({"title": "Cake"}, "butter")

    def test_invalid_json_raises_validation_error(self):
        """Raises Pydantic ValidationError for malformed schema."""
        from src.services.llm import get_substitution
        from pydantic import ValidationError

        with patch("src.services.llm.client") as mock_client:
            mock_client.models.generate_content.return_value = _mock_response('{"nope": true}')
            with pytest.raises(ValidationError):
                get_substitution({"title": "Cake"}, "butter")

    def test_rate_limit_raises_llm_capacity_error(self):
        """Converts a 429 ClientError into LLMCapacityError."""
        from src.services.llm import get_substitution, LLMCapacityError

        mock_err = _client_error(429)

        with patch("src.services.llm.client") as mock_client:
            mock_client.models.generate_content.side_effect = mock_err
            with pytest.raises(LLMCapacityError):
                get_substitution({"title": "Cake"}, "butter")

    def test_non_429_client_error_reraises(self):
        """Re-raises non-429 ClientErrors unchanged."""
        from src.services.llm import get_substitution

        mock_err = _client_error(503)

        with patch("src.services.llm.client") as mock_client:
            mock_client.models.generate_content.side_effect = mock_err
            with pytest.raises(type(mock_err)):
                get_substitution({"title": "Cake"}, "butter")

    def test_generic_exception_reraises(self):
        """Re-raises unexpected exceptions unchanged."""
        from src.services.llm import get_substitution

        with patch("src.services.llm.client") as mock_client:
            mock_client.models.generate_content.side_effect = RuntimeError("boom")
            with pytest.raises(RuntimeError, match="boom"):
                get_substitution({"title": "Cake"}, "butter")
