"""
Unit tests for src/dependencies/auth.py — JWT verification.

Covers: valid tokens, expired tokens, invalid signatures, missing headers,
and public key loading.
"""

import json
import os
import time
import pytest
from unittest.mock import patch, MagicMock

# We test the dependency functions directly, not via HTTP,
# so we can exercise the exact error branches.


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_fake_jwk_file(tmp_path):
    """Write a fake JWK file and return its path."""
    # Minimal EC P-256 public key in JWK format (not cryptographically valid,
    # but structurally correct for PyJWK to parse).
    jwk = {
        "kty": "EC",
        "crv": "P-256",
        "x": "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
        "y": "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
        "kid": "test-key-id",
    }
    path = tmp_path / "test_pub_key.json"
    path.write_text(json.dumps(jwk))
    return str(path)


# ---------------------------------------------------------------------------
# get_supabase_public_key
# ---------------------------------------------------------------------------

class TestGetSupabasePublicKey:

    def test_loads_key_from_file(self, tmp_path, _patch_env, monkeypatch):
        """Successfully loads and caches the public key from a JWK file."""
        key_path = _make_fake_jwk_file(tmp_path)
        monkeypatch.setenv("SUPABASE_PUB_KEY_PATH", os.path.basename(key_path))

        # Clear cached modules to get fresh imports with new env
        import sys
        for m in [m for m in sys.modules if m.startswith("src")]:
            del sys.modules[m]

        from src.dependencies.auth import get_supabase_public_key

        # Clear lru_cache so we get a fresh load
        get_supabase_public_key.cache_clear()

        # Patch os.getcwd to point to the tmp_path directory
        monkeypatch.chdir(tmp_path)
        key = get_supabase_public_key()
        assert key is not None

    def test_missing_key_file_raises(self, _patch_env, monkeypatch):
        """Raises RuntimeError when the public key file doesn't exist."""
        monkeypatch.setenv("SUPABASE_PUB_KEY_PATH", "nonexistent_key.json")

        import sys
        for m in [m for m in sys.modules if m.startswith("src")]:
            del sys.modules[m]

        from src.dependencies.auth import get_supabase_public_key
        get_supabase_public_key.cache_clear()

        monkeypatch.chdir("/tmp")
        with pytest.raises(RuntimeError, match="Missing Supabase public key"):
            get_supabase_public_key()


# ---------------------------------------------------------------------------
# verify_jwt
# ---------------------------------------------------------------------------

class TestVerifyJwt:

    def test_valid_token_returns_user_id(self, _patch_env):
        """A valid JWT returns the 'sub' claim."""
        import sys
        for m in [m for m in sys.modules if m.startswith("src")]:
            del sys.modules[m]

        from src.dependencies.auth import verify_jwt
        from fastapi.security import HTTPAuthorizationCredentials

        fake_payload = {"sub": "user-123", "aud": "authenticated", "exp": time.time() + 3600}

        with patch("src.dependencies.auth.get_supabase_public_key") as mock_key, \
             patch("src.dependencies.auth.jwt.decode", return_value=fake_payload):
            mock_key.return_value = "fake-key"
            creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="fake-token")
            result = verify_jwt(creds)

        assert result == "user-123"

    def test_expired_token_raises_401(self, _patch_env):
        """Expired JWT raises HTTPException with 401."""
        import sys
        import jwt as pyjwt
        for m in [m for m in sys.modules if m.startswith("src")]:
            del sys.modules[m]

        from src.dependencies.auth import verify_jwt
        from fastapi.security import HTTPAuthorizationCredentials
        from fastapi import HTTPException

        with patch("src.dependencies.auth.get_supabase_public_key", return_value="fake"), \
             patch("src.dependencies.auth.jwt.decode", side_effect=pyjwt.ExpiredSignatureError("expired")):
            creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="expired-token")
            with pytest.raises(HTTPException) as exc_info:
                verify_jwt(creds)
            assert exc_info.value.status_code == 401
            assert "expired" in exc_info.value.detail.lower()

    def test_invalid_token_raises_401(self, _patch_env):
        """Invalid JWT raises HTTPException with 401."""
        import sys
        import jwt as pyjwt
        for m in [m for m in sys.modules if m.startswith("src")]:
            del sys.modules[m]

        from src.dependencies.auth import verify_jwt
        from fastapi.security import HTTPAuthorizationCredentials
        from fastapi import HTTPException

        with patch("src.dependencies.auth.get_supabase_public_key", return_value="fake"), \
             patch("src.dependencies.auth.jwt.decode", side_effect=pyjwt.InvalidTokenError("bad")):
            creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="bad-token")
            with pytest.raises(HTTPException) as exc_info:
                verify_jwt(creds)
            assert exc_info.value.status_code == 401
            assert "invalid" in exc_info.value.detail.lower()

    def test_missing_bearer_header_via_endpoint(self, client):
        """An endpoint with verify_jwt dependency rejects requests without Bearer auth."""
        # Use any authenticated endpoint (e.g. sync/latest)
        resp = client.get("/api/sync/latest")
        assert resp.status_code in (401, 403)
