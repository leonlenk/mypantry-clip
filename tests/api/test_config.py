"""
Tests for src/config.py — Settings loading and defaults.

NOTE: pydantic-settings reads BOTH os.environ AND the .env file.
To test true defaults we must pass `_env_file=None` so the real
apps/api/.env doesn't bleed into the assertions.
"""

import os
import sys
import pytest


def _fresh_settings_class():
    """Force a fresh import of the Settings class."""
    for m in [m for m in sys.modules if m.startswith("src")]:
        del sys.modules[m]
    from src.config import Settings
    return Settings


class TestSettings:

    def test_settings_loads_from_env(self, _patch_env):
        """Settings can be instantiated from environment variables."""
        Settings = _fresh_settings_class()
        s = Settings(_env_file=None)
        assert s.supabase_url == "https://fake.supabase.co"
        assert s.gemini_api_key == "fake-gemini-key"
        assert s.extension_id == "fake-extension-id"

    def test_default_max_payload_chars(self, _patch_env, monkeypatch):
        """Default max_payload_chars is 20000 when not overridden."""
        monkeypatch.delenv("MAX_PAYLOAD_CHARS", raising=False)

        Settings = _fresh_settings_class()
        s = Settings(_env_file=None)
        assert s.max_payload_chars == 20_000

    def test_default_extract_weekly_limit(self, _patch_env, monkeypatch):
        """Default extract_weekly_limit is 50."""
        monkeypatch.delenv("EXTRACT_WEEKLY_LIMIT", raising=False)

        Settings = _fresh_settings_class()
        s = Settings(_env_file=None)
        assert s.extract_weekly_limit == 50

    def test_default_substitute_weekly_limit(self, _patch_env, monkeypatch):
        """Default substitute_weekly_limit is 50."""
        monkeypatch.delenv("SUBSTITUTE_WEEKLY_LIMIT", raising=False)

        Settings = _fresh_settings_class()
        s = Settings(_env_file=None)
        assert s.substitute_weekly_limit == 50

    def test_override_limits_from_env(self, _patch_env, monkeypatch):
        """Limits can be overridden via env vars."""
        monkeypatch.setenv("MAX_PAYLOAD_CHARS", "100")
        monkeypatch.setenv("EXTRACT_WEEKLY_LIMIT", "10")
        monkeypatch.setenv("SUBSTITUTE_WEEKLY_LIMIT", "20")

        Settings = _fresh_settings_class()
        s = Settings(_env_file=None)
        assert s.max_payload_chars == 100
        assert s.extract_weekly_limit == 10
        assert s.substitute_weekly_limit == 20
