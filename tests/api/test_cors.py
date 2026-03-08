"""
Tests for CORS middleware configuration.

Verifies that the FastAPI app's CORS policy accepts allowed origins
and rejects disallowed ones.
"""


class TestCorsPolicy:

    def test_extension_origin_allowed(self, client):
        """Preflight from the Chrome extension origin returns CORS headers."""
        resp = client.options(
            "/api/extract/",
            headers={
                "Origin": "chrome-extension://fake-extension-id",
                "Access-Control-Request-Method": "POST",
            },
        )
        # CORS middleware should respond with the Access-Control-Allow-Origin header
        allow_origin = resp.headers.get("access-control-allow-origin", "")
        assert "chrome-extension://fake-extension-id" in allow_origin

    def test_localhost_origin_allowed(self, client):
        """Preflight from localhost is accepted."""
        resp = client.options(
            "/api/extract/",
            headers={
                "Origin": "http://localhost",
                "Access-Control-Request-Method": "POST",
            },
        )
        allow_origin = resp.headers.get("access-control-allow-origin", "")
        assert "localhost" in allow_origin

    def test_localhost_with_port_allowed(self, client):
        """Preflight from localhost:8000 is accepted."""
        resp = client.options(
            "/api/extract/",
            headers={
                "Origin": "http://localhost:8000",
                "Access-Control-Request-Method": "POST",
            },
        )
        allow_origin = resp.headers.get("access-control-allow-origin", "")
        assert "localhost:8000" in allow_origin

    def test_unknown_origin_rejected(self, client):
        """Preflight from a random origin is rejected (no allow-origin header)."""
        resp = client.options(
            "/api/extract/",
            headers={
                "Origin": "https://evil.example.com",
                "Access-Control-Request-Method": "POST",
            },
        )
        allow_origin = resp.headers.get("access-control-allow-origin", "")
        assert "evil.example.com" not in allow_origin

    def test_credentials_allowed(self, client):
        """CORS allows credentials for authenticated extension requests."""
        resp = client.options(
            "/api/extract/",
            headers={
                "Origin": "chrome-extension://fake-extension-id",
                "Access-Control-Request-Method": "POST",
            },
        )
        assert resp.headers.get("access-control-allow-credentials") == "true"
