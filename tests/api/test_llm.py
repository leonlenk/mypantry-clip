"""
Tests for src/services/llm.py — extract_recipe and get_substitution.

Mocks client.models.generate_content to test all branches:
success, empty response, 429 rate limit, non-429 client error,
generic exception, and ValidationError.
"""

import sys
import os
import pytest
from unittest.mock import patch, MagicMock

# Ensure API root is on the path
API_ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "apps", "api")
sys.path.insert(0, os.path.abspath(API_ROOT))

# Patch env before any src imports
import tests.api.conftest  # noqa: F401 — triggers _patch_env autouse via conftest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_response(text: str | None, candidates=None):
    """Build a fake Gemini response object."""
    resp = MagicMock()
    resp.text = text
    resp.candidates = candidates or []
    return resp


def _import_llm():
    """Import llm module fresh after env is patched."""
    for m in list(sys.modules.keys()):
        if m.startswith("src"):
            del sys.modules[m]
    import importlib
    import src.services.llm as llm
    return llm


# ---------------------------------------------------------------------------
# extract_recipe
# ---------------------------------------------------------------------------

class TestExtractRecipe:

    def test_success(self, monkeypatch):
        """Valid Gemini response returns a parsed Recipe."""
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)

        llm = _import_llm()

        recipe_json = (
            '{"title": "Pancakes", "semantic_summary": "Fluffy", '
            '"ingredients": [], "instructions": [], "notes": [], '
            '"servings": 2, "prepTime": 5, "cookTime": 10}'
        )
        fake_response = _make_response(recipe_json)

        with patch.object(llm.client.models, "generate_content", return_value=fake_response):
            result = llm.extract_recipe("<html>pancake page</html>")

        assert result.title == "Pancakes"

    def test_empty_response_raises(self, monkeypatch):
        """Empty LLM response (text=None) raises ValueError."""
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)

        llm = _import_llm()

        candidate = MagicMock()
        candidate.finish_reason = "SAFETY"
        fake_response = _make_response(None, candidates=[candidate])

        with patch.object(llm.client.models, "generate_content", return_value=fake_response):
            with pytest.raises(ValueError, match="Empty response"):
                llm.extract_recipe("<html>blocked</html>")

    def test_empty_response_no_candidates(self, monkeypatch):
        """Empty LLM response with no candidates still raises ValueError."""
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)

        llm = _import_llm()
        fake_response = _make_response(None, candidates=[])

        with patch.object(llm.client.models, "generate_content", return_value=fake_response):
            with pytest.raises(ValueError, match="unknown"):
                llm.extract_recipe("<html></html>")

    def test_rate_limit_raises_llm_capacity_error(self, monkeypatch):
        """Gemini 429 ClientError is converted to LLMCapacityError."""
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)

        llm = _import_llm()

        from google.genai.errors import ClientError

        class _429Error(ClientError):
            code = 429
            def __init__(self): Exception.__init__(self, "rate limited")

        with patch.object(llm.client.models, "generate_content", side_effect=_429Error()):
            with pytest.raises(llm.LLMCapacityError):
                llm.extract_recipe("<html></html>")

    def test_non_429_client_error_reraises(self, monkeypatch):
        """Non-429 Gemini ClientError propagates as-is."""
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)

        llm = _import_llm()

        from google.genai.errors import ClientError

        class _500Error(ClientError):
            code = 500
            def __init__(self): Exception.__init__(self, "server error")

        with patch.object(llm.client.models, "generate_content", side_effect=_500Error()):
            with pytest.raises(ClientError):
                llm.extract_recipe("<html></html>")

    def test_generic_exception_reraises(self, monkeypatch):
        """Any unexpected exception propagates out of extract_recipe."""
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)

        llm = _import_llm()

        with patch.object(llm.client.models, "generate_content", side_effect=RuntimeError("boom")):
            with pytest.raises(RuntimeError, match="boom"):
                llm.extract_recipe("<html></html>")

    def test_validation_error_reraises(self, monkeypatch):
        """Schema mismatch in returned JSON propagates as ValidationError."""
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)

        llm = _import_llm()
        # Return JSON that doesn't match the Recipe schema
        fake_response = _make_response('{"bad_field": 123}')

        with patch.object(llm.client.models, "generate_content", return_value=fake_response):
            from pydantic import ValidationError
            with pytest.raises(ValidationError):
                llm.extract_recipe("<html></html>")


# ---------------------------------------------------------------------------
# get_substitution
# ---------------------------------------------------------------------------

class TestGetSubstitution:

    def test_success(self, monkeypatch):
        """Valid response returns a parsed Substitution."""
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)

        llm = _import_llm()

        sub_json = (
            '{"target_ingredient": "butter", "substitution_name": "coconut oil",'
            ' "amount": 0.75, "unit": "cup", "reasoning": "Same fat content."}'
        )
        fake_response = _make_response(sub_json)

        with patch.object(llm.client.models, "generate_content", return_value=fake_response):
            result = llm.get_substitution({"title": "Cake"}, "butter")

        assert result.substitution_name == "coconut oil"

    def test_empty_response_raises(self, monkeypatch):
        """Empty substitution response raises ValueError."""
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)

        llm = _import_llm()
        candidate = MagicMock()
        candidate.finish_reason = "SAFETY"
        fake_response = _make_response(None, candidates=[candidate])

        with patch.object(llm.client.models, "generate_content", return_value=fake_response):
            with pytest.raises(ValueError, match="Empty response"):
                llm.get_substitution({}, "butter")

    def test_rate_limit_raises_llm_capacity_error(self, monkeypatch):
        """Gemini 429 during substitution raises LLMCapacityError."""
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)

        llm = _import_llm()

        from google.genai.errors import ClientError

        class _429Error(ClientError):
            code = 429
            def __init__(self): Exception.__init__(self, "rate limited")

        with patch.object(llm.client.models, "generate_content", side_effect=_429Error()):
            with pytest.raises(llm.LLMCapacityError):
                llm.get_substitution({}, "butter")

    def test_non_429_client_error_reraises(self, monkeypatch):
        """Non-429 ClientError propagates from get_substitution."""
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)

        llm = _import_llm()

        from google.genai.errors import ClientError

        class _503Error(ClientError):
            code = 503
            def __init__(self): Exception.__init__(self, "server error")

        with patch.object(llm.client.models, "generate_content", side_effect=_503Error()):
            with pytest.raises(ClientError):
                llm.get_substitution({}, "butter")

    def test_generic_exception_reraises(self, monkeypatch):
        """Generic exception propagates from get_substitution."""
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)

        llm = _import_llm()

        with patch.object(llm.client.models, "generate_content", side_effect=RuntimeError("network")):
            with pytest.raises(RuntimeError, match="network"):
                llm.get_substitution({}, "butter")

    def test_validation_error_reraises(self, monkeypatch):
        """Schema mismatch in substitution JSON raises ValidationError."""
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)

        llm = _import_llm()
        fake_response = _make_response('{"wrong": true}')

        with patch.object(llm.client.models, "generate_content", return_value=fake_response):
            from pydantic import ValidationError
            with pytest.raises(ValidationError):
                llm.get_substitution({}, "butter")
