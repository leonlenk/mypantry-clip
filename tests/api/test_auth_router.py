"""
Tests for the OAuth / auth router endpoints.

Covers:
  GET /api/oauth/consent   — Supabase OAuth redirect
  GET /api/auth/callback   — HTML callback page
"""


class TestOAuthConsent:
    """Tests for the OAuth consent redirect endpoint."""

    def test_consent_redirects_to_supabase(self, client):
        """GET /api/oauth/consent redirects (307) to the Supabase auth URL."""
        resp = client.get("/api/oauth/consent", follow_redirects=False)
        assert resp.status_code == 307
        assert "supabase" in resp.headers["location"].lower()
        assert "provider=google" in resp.headers["location"]

    def test_consent_includes_redirect_to_param(self, client):
        """When redirect_to is provided, it appears in the Supabase URL."""
        redirect_target = "https://example.com/callback"
        resp = client.get(
            "/api/oauth/consent",
            params={"redirect_to": redirect_target},
            follow_redirects=False,
        )
        assert resp.status_code == 307
        location = resp.headers["location"]
        assert "redirect_to=" in location

    def test_consent_without_redirect_to(self, client):
        """Without redirect_to, the redirect URL still points to Supabase."""
        resp = client.get("/api/oauth/consent", follow_redirects=False)
        assert resp.status_code == 307
        location = resp.headers["location"]
        # Should NOT contain redirect_to when none given
        assert "redirect_to=" not in location


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
        assert "MyPantry" in body
        assert "Completing login" in body or "login" in body.lower()
