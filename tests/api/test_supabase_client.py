"""
Unit tests for src/services/supabase_client.py — get_supabase_client.

Uses lru_cache clearing + settings patching to test both the error branch
(missing key) and the happy path (client creation).
"""

import pytest
from unittest.mock import patch, MagicMock


class TestGetSupabaseClient:

    def setup_method(self):
        """Clear the lru_cache before each test to ensure a fresh call."""
        from src.services.supabase_client import get_supabase_client
        get_supabase_client.cache_clear()

    def teardown_method(self):
        """Clear the cache after each test so other tests start clean."""
        from src.services.supabase_client import get_supabase_client
        get_supabase_client.cache_clear()

    def test_raises_when_service_role_key_missing(self):
        """Raises RuntimeError when SUPABASE_SERVICE_ROLE_KEY is falsy."""
        from src.services import supabase_client

        with patch.object(supabase_client, "settings") as mock_settings:
            mock_settings.supabase_service_role_key = None
            mock_settings.supabase_url = "https://fake.supabase.co"

            with pytest.raises(RuntimeError, match="SUPABASE_SERVICE_ROLE_KEY"):
                supabase_client.get_supabase_client()

    def test_raises_when_service_role_key_empty_string(self):
        """Raises RuntimeError when key is an empty string (falsy)."""
        from src.services import supabase_client

        with patch.object(supabase_client, "settings") as mock_settings:
            mock_settings.supabase_service_role_key = ""
            mock_settings.supabase_url = "https://fake.supabase.co"

            with pytest.raises(RuntimeError, match="SUPABASE_SERVICE_ROLE_KEY"):
                supabase_client.get_supabase_client()

    def test_returns_client_when_key_present(self):
        """Creates and returns a Supabase client when the service role key is set."""
        from src.services import supabase_client

        mock_instance = MagicMock()

        with patch.object(supabase_client, "settings") as mock_settings, \
             patch.object(supabase_client, "create_client", return_value=mock_instance) as mock_create:
            mock_settings.supabase_service_role_key = "service-role-key"
            mock_settings.supabase_url = "https://fake.supabase.co"

            result = supabase_client.get_supabase_client()

        assert result is mock_instance
        mock_create.assert_called_once_with(
            "https://fake.supabase.co",
            "service-role-key",
        )

    def test_result_is_cached(self):
        """Repeated calls return the same cached instance without calling create_client again."""
        from src.services import supabase_client

        mock_instance = MagicMock()

        with patch.object(supabase_client, "settings") as mock_settings, \
             patch.object(supabase_client, "create_client", return_value=mock_instance) as mock_create:
            mock_settings.supabase_service_role_key = "service-role-key"
            mock_settings.supabase_url = "https://fake.supabase.co"

            r1 = supabase_client.get_supabase_client()
            r2 = supabase_client.get_supabase_client()

        assert r1 is r2
        mock_create.assert_called_once()  # only one real call despite two invocations
