"""
Tests for the static HTML page endpoints.

Covers:
  GET /          — Home / landing page
  GET /privacy   — Privacy policy page
"""


class TestHomePage:

    def test_home_returns_200(self, client):
        """GET / returns 200."""
        resp = client.get("/")
        assert resp.status_code == 200

    def test_home_content_type(self, client):
        """Home page returns text/html content type."""
        resp = client.get("/")
        assert "text/html" in resp.headers["content-type"]

    def test_home_contains_brand_name(self, client):
        """Landing page includes 'MyPantry' branding."""
        resp = client.get("/")
        assert "MyPantry" in resp.text or "Pantry Clip" in resp.text

    def test_home_contains_seo_meta(self, client):
        """Landing page contains essential SEO meta tags."""
        body = resp = client.get("/").text
        assert "<title>" in body
        assert 'meta name="description"' in body or 'meta name="viewport"' in body


class TestPrivacyPage:

    def test_privacy_returns_200(self, client):
        """GET /privacy returns 200."""
        resp = client.get("/privacy")
        assert resp.status_code == 200

    def test_privacy_content_type(self, client):
        """Privacy page returns text/html content type."""
        resp = client.get("/privacy")
        assert "text/html" in resp.headers["content-type"]

    def test_privacy_contains_legal_content(self, client):
        """Privacy page contains expected legal policy sections."""
        body = client.get("/privacy").text
        # Should mention who we are, data collection, etc.
        assert "Privacy Policy" in body or "privacy" in body.lower()
        assert "Data" in body or "data" in body.lower()

    def test_privacy_contains_brand(self, client):
        """Privacy page includes MyPantry branding."""
        body = client.get("/privacy").text
        assert "MyPantry" in body
