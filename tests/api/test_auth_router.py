"""
Tests for the auth router endpoints.

Covers:
  GET /api/auth/callback   — HTML callback page
"""

class TestAuthCallback:
    """Tests for the auth callback HTML page."""

    def test_callback_returns_html(self, client):
        """GET /api/auth/callback returns an HTML page."""
        resp = client.get("/api/auth/callback")
        assert resp.status_code == 200
        assert "text/html" in resp.headers["content-type"]

    def test_callback_contains_brand_text(self, client):
        """The callback page includes MyPantry branding."""
        resp = client.get("/api/auth/callback")
        body = resp.text
        assert "MyPantry Clip" in body
        assert "Completing login" in body or "login" in body.lower()
