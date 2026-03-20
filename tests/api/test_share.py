"""
Tests for the recipe sharing endpoints.

POST /api/share  — authenticated; creates a single shareable link for a batch
                   of recipes (all stored in one DB row as a JSON array).
GET  /s/{id}     — public; returns an HTML recipe card (single recipe) or
                   a mini-pantry grid (multiple recipes), or 404.
"""

from datetime import datetime, timezone, timedelta
from unittest.mock import patch, MagicMock
from tests.api.conftest import FAKE_USER_ID


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_share_mock(data=None):
    """Returns a mock Supabase client wired for the share router's query patterns."""
    mock_client = MagicMock()
    mock_result = MagicMock()
    mock_result.data = data or []

    chain = MagicMock()
    chain.execute.return_value = mock_result
    chain.eq.return_value = chain
    chain.gt.return_value = chain
    chain.limit.return_value = chain
    chain.select.return_value = chain
    chain.insert.return_value = chain   # share router uses insert, not upsert

    mock_client.table.return_value = chain
    return mock_client, chain, mock_result


def _share_patch(mock_client):
    """Context manager that patches get_supabase_client in the share router."""
    return patch("src.routers.share.get_supabase_client", return_value=mock_client)


def _future_expiry():
    return (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()


def _past_expiry():
    return (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()


# ---------------------------------------------------------------------------
# POST /api/share
# ---------------------------------------------------------------------------

class TestSharePost:

    def test_share_single_recipe_returns_url(self, client, mock_verify_jwt):
        """Sharing one recipe returns a single URL string."""
        mock_client, _, _ = _build_share_mock()
        with _share_patch(mock_client):
            resp = client.post(
                "/api/share",
                json={"recipes": [{"id": "recipe-001", "title": "Pancakes"}]},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert "url" in body
        assert "/s/" in body["url"]

    def test_share_batch_returns_one_url(self, client, mock_verify_jwt):
        """Multiple recipes in the batch produce a single shared URL (one DB row)."""
        mock_client, _, _ = _build_share_mock()
        recipes = [
            {"id": "r1", "title": "Pancakes"},
            {"id": "r2", "title": "Waffles"},
            {"id": "r3", "title": "French Toast"},
        ]
        with _share_patch(mock_client):
            resp = client.post("/api/share", json={"recipes": recipes})
        assert resp.status_code == 200
        body = resp.json()
        # Exactly one URL — all recipes are bundled into a single share link
        assert "url" in body
        assert isinstance(body["url"], str)
        assert "/s/" in body["url"]

    def test_share_url_uses_public_base_url(self, client, mock_verify_jwt):
        """The returned URL is built from settings.public_base_url."""
        mock_client, _, _ = _build_share_mock()
        # settings is a module-level singleton; patch the attribute directly.
        with _share_patch(mock_client), \
             patch("src.routers.share.settings") as mock_settings:
            mock_settings.public_base_url = "https://example.dev"
            mock_settings.share_expiry_days = 30
            resp = client.post(
                "/api/share",
                json={"recipes": [{"id": "r1", "title": "Test"}]},
            )
        assert resp.status_code == 200
        url = resp.json()["url"]
        assert url.startswith("https://example.dev/s/")

    def test_share_strips_embedding(self, client, mock_verify_jwt):
        """The embedding field is stripped before inserting into shared_recipes."""
        mock_client, chain, _ = _build_share_mock()
        recipe = {"id": "r1", "title": "Soup", "embedding": [0.1, 0.2, 0.3]}
        with _share_patch(mock_client):
            resp = client.post("/api/share", json={"recipes": [recipe]})
        assert resp.status_code == 200

        insert_call = chain.insert.call_args
        row = insert_call[0][0]  # single row dict
        for clean_recipe in row["recipe_json"]:
            assert "embedding" not in clean_recipe

    def test_share_strips_tags(self, client, mock_verify_jwt):
        """Personal tags are stripped before inserting into shared_recipes."""
        mock_client, chain, _ = _build_share_mock()
        recipe = {"id": "r1", "title": "Soup", "tags": ["dinner", "easy"]}
        with _share_patch(mock_client):
            resp = client.post("/api/share", json={"recipes": [recipe]})
        assert resp.status_code == 200

        insert_call = chain.insert.call_args
        row = insert_call[0][0]
        for clean_recipe in row["recipe_json"]:
            assert "tags" not in clean_recipe

    def test_share_recipe_json_is_array(self, client, mock_verify_jwt):
        """recipe_json stored in DB is always a JSON array (even for one recipe)."""
        mock_client, chain, _ = _build_share_mock()
        with _share_patch(mock_client):
            client.post(
                "/api/share",
                json={"recipes": [{"id": "r1", "title": "Tacos"}]},
            )
        insert_call = chain.insert.call_args
        row = insert_call[0][0]
        assert isinstance(row["recipe_json"], list)

    def test_share_empty_list_returns_400(self, client, mock_verify_jwt):
        """Empty recipes list is rejected with 400."""
        mock_client, _, _ = _build_share_mock()
        with _share_patch(mock_client):
            resp = client.post("/api/share", json={"recipes": []})
        assert resp.status_code == 400

    def test_share_unauthenticated_returns_401(self, client):
        """Request without auth header returns 401/403."""
        resp = client.post("/api/share", json={"recipes": [{"id": "r1"}]})
        assert resp.status_code in (401, 403)

    def test_share_supabase_error_returns_500(self, client, mock_verify_jwt):
        """Supabase failure returns 500."""
        mock_client = MagicMock()
        chain = MagicMock()
        chain.insert.return_value = chain
        chain.execute.side_effect = RuntimeError("DB down")
        mock_client.table.return_value = chain

        with _share_patch(mock_client):
            resp = client.post(
                "/api/share",
                json={"recipes": [{"id": "r1", "title": "Test"}]},
            )
        assert resp.status_code == 500

    def test_share_id_is_url_safe(self, client, mock_verify_jwt):
        """Generated share IDs contain only URL-safe characters."""
        import re
        mock_client, _, _ = _build_share_mock()
        with _share_patch(mock_client):
            resp = client.post(
                "/api/share",
                json={"recipes": [{"id": "r1", "title": "Test"}]},
            )
        assert resp.status_code == 200
        url = resp.json()["url"]
        share_id = url.split("/s/")[-1]
        # secrets.token_urlsafe produces only A-Z a-z 0-9 - _
        assert re.fullmatch(r"[A-Za-z0-9\-_]+", share_id), f"Non-URL-safe ID: {share_id!r}"


# ---------------------------------------------------------------------------
# GET /s/{id}
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Helper function unit tests
# ---------------------------------------------------------------------------

class TestDecimalToFraction:
    """Tests for src/routers/share._decimal_to_fraction"""

    def _fn(self, q):
        from src.routers.share import _decimal_to_fraction
        return _decimal_to_fraction(q)

    def test_zero_returns_zero(self):
        assert self._fn(0) == "0"

    def test_negative_returns_zero(self):
        assert self._fn(-1) == "0"

    def test_whole_number(self):
        assert self._fn(2.0) == "2"

    def test_half(self):
        assert self._fn(0.5) == "1/2"

    def test_one_and_a_half(self):
        assert self._fn(1.5) == "1 1/2"

    def test_quarter(self):
        assert self._fn(0.25) == "1/4"

    def test_three_quarters(self):
        assert self._fn(0.75) == "3/4"

    def test_third(self):
        assert self._fn(1 / 3) == "1/3"

    def test_fraction_close_to_one_rounds_up(self):
        # 0.97 is closer to 1 than any fraction entry, so rounds to whole+1
        assert self._fn(0.97) == "1"

    def test_whole_with_very_small_frac_dropped(self):
        # frac < 0.05 → just show whole
        assert self._fn(2.02) == "2"

    def test_fraction_with_large_error_shows_decimal(self):
        # 0.19 is more than 0.05 from any named fraction → falls back to round(q, 2)
        # Nearest fraction is 1/8 (0.125); abs(0.125 - 0.19) = 0.065 > 0.05
        result = self._fn(0.19)
        assert result == "0.19"


class TestFormatIngredientText:
    """Tests for src/routers/share._format_ingredient_text"""

    def _fn(self, ing):
        from src.routers.share import _format_ingredient_text
        return _format_ingredient_text(ing)

    def test_falls_back_to_raw_text_when_no_item(self):
        ing = {"rawText": "1 cup flour", "item": ""}
        assert self._fn(ing) == "1 cup flour"

    def test_item_with_amount_and_unit(self):
        ing = {"item": "flour", "us_amount": 1.5, "us_unit": "cups"}
        result = self._fn(ing)
        assert "1 1/2" in result
        assert "cups" in result
        assert "flour" in result

    def test_item_with_preparation(self):
        ing = {"item": "onion", "us_amount": 1.0, "us_unit": "cup", "preparation": "chopped"}
        result = self._fn(ing)
        assert ", chopped" in result

    def test_item_without_amount(self):
        ing = {"item": "salt"}
        assert self._fn(ing) == "salt"

    def test_invalid_amount_is_skipped(self):
        ing = {"item": "butter", "us_amount": "not-a-number", "us_unit": "cup"}
        result = self._fn(ing)
        # amount can't be parsed, so skip it but still include item
        assert "butter" in result

    def test_falls_back_to_raw_when_result_empty(self):
        # If item is present but everything else is empty, return item
        ing = {"item": "salt", "rawText": "a pinch of salt"}
        assert self._fn(ing) == "salt"


class TestFormatTime:
    """Tests for src/routers/share._format_time"""

    def _fn(self, minutes):
        from src.routers.share import _format_time
        return _format_time(minutes)

    def test_none_returns_none(self):
        assert self._fn(None) is None

    def test_zero_returns_none(self):
        assert self._fn(0) is None

    def test_minutes_only(self):
        assert self._fn(30) == "30 min"

    def test_hours_only(self):
        assert self._fn(120) == "2h"

    def test_hours_and_minutes(self):
        assert self._fn(90) == "1h 30min"


class TestIngredientsHtml:
    """Tests for src/routers/share._ingredients_html"""

    def _fn(self, ingredients):
        from src.routers.share import _ingredients_html
        return _ingredients_html(ingredients)

    def test_group_header_rendered(self):
        ings = [
            {"group": "Cake", "item": "flour"},
            {"group": "Cake", "item": "sugar"},
        ]
        html = self._fn(ings)
        assert "ing-group-header" in html
        assert "Cake" in html

    def test_group_header_not_repeated_for_same_group(self):
        ings = [
            {"group": "Sauce", "item": "tomato"},
            {"group": "Sauce", "item": "garlic"},
        ]
        html = self._fn(ings)
        # Group header should appear exactly once
        assert html.count("ing-group-header") == 1

    def test_subtext_rendered(self):
        ings = [{"item": "butter", "subtext": "or margarine"}]
        html = self._fn(ings)
        assert "ing-subtext" in html
        assert "or margarine" in html

    def test_no_subtext_plain_li(self):
        ings = [{"item": "salt"}]
        html = self._fn(ings)
        assert "ing-subtext" not in html
        assert "<li>salt</li>" in html


class TestInstructionsHtml:
    """Tests for src/routers/share._instructions_html"""

    def _fn(self, instructions):
        from src.routers.share import _instructions_html
        return _instructions_html(instructions)

    def test_group_header_rendered(self):
        steps = [
            {"group": "Sauce", "text": "Simmer tomatoes."},
            {"group": "Sauce", "text": "Add garlic."},
        ]
        html = self._fn(steps)
        assert "inst-group-header" in html
        assert "Sauce" in html

    def test_group_header_not_repeated(self):
        steps = [
            {"group": "Frosting", "text": "Beat butter."},
            {"group": "Frosting", "text": "Add sugar."},
        ]
        html = self._fn(steps)
        assert html.count("inst-group-header") == 1

    def test_plain_step_rendered(self):
        steps = [{"text": "Mix ingredients."}]
        html = self._fn(steps)
        assert "Mix ingredients." in html
        assert "inst-group-header" not in html


class TestRenderSingleRecipePage:
    """Tests for _render_single_recipe_page — optional field branches."""

    def _render(self, recipe, expiry_days=30):
        from src.routers.share import _render_single_recipe_page
        return _render_single_recipe_page(recipe, expiry_days)

    def test_author_rendered(self):
        recipe = {"title": "Soup", "author": "Julia", "ingredients": [], "instructions": []}
        html = self._render(recipe)
        assert "By Julia" in html

    def test_source_url_rendered(self):
        recipe = {"title": "Soup", "url": "https://example.com/soup", "ingredients": [], "instructions": []}
        html = self._render(recipe)
        assert "View original" in html
        assert "https://example.com/soup" in html

    def test_yield_text_rendered(self):
        recipe = {"title": "Soup", "yield": "6 servings", "ingredients": [], "instructions": []}
        html = self._render(recipe)
        assert "Yield: 6 servings" in html

    def test_servings_rendered_when_no_yield(self):
        recipe = {"title": "Soup", "servings": 4, "ingredients": [], "instructions": []}
        html = self._render(recipe)
        assert "Servings: 4" in html

    def test_notes_rendered(self):
        recipe = {
            "title": "Soup",
            "ingredients": [],
            "instructions": [],
            "notes": ["Use fresh herbs.", "Can be frozen."],
        }
        html = self._render(recipe)
        assert "Notes" in html
        assert "Use fresh herbs." in html

    def test_expiry_days_in_footer(self):
        recipe = {"title": "Soup", "ingredients": [], "instructions": []}
        html = self._render(recipe, expiry_days=7)
        assert "7 days" in html


class TestShareGetView:

    def _valid_row(self, title="Pancakes"):
        """recipe_json is stored as a JSON array of recipe dicts."""
        return [{
            "recipe_json": [{
                "id": "r1",
                "title": title,
                "description": "Fluffy pancakes.",
                "ingredients": [{"rawText": "1 cup flour", "item": "flour"}],
                "instructions": [{"stepNumber": 1, "text": "Mix everything."}],
            }],
            "expires_at": _future_expiry(),
        }]

    def _valid_multi_row(self, titles=("Pancakes", "Waffles")):
        """A row with multiple recipes — rendered as a mini-pantry grid."""
        return [{
            "recipe_json": [
                {"id": f"r{i}", "title": t, "ingredients": [], "instructions": []}
                for i, t in enumerate(titles)
            ],
            "expires_at": _future_expiry(),
        }]

    def test_valid_id_returns_html(self, client):
        """A valid, non-expired share ID returns 200 HTML with the recipe title."""
        mock_client, _, mock_result = _build_share_mock()
        mock_result.data = self._valid_row("Pancakes")
        with _share_patch(mock_client):
            resp = client.get("/s/abc12345")
        assert resp.status_code == 200
        assert "text/html" in resp.headers["content-type"]
        assert "Pancakes" in resp.text

    def test_valid_id_embeds_recipe_json(self, client):
        """The HTML page embeds the recipe JSON in a <script> tag for extension import."""
        mock_client, _, mock_result = _build_share_mock()
        mock_result.data = self._valid_row("Waffles")
        with _share_patch(mock_client):
            resp = client.get("/s/abc12345")
        assert resp.status_code == 200
        assert 'id="recipe-data"' in resp.text
        assert "Waffles" in resp.text

    def test_valid_id_contains_save_button(self, client):
        """The HTML page includes the 'Save to MyPantry' button."""
        mock_client, _, mock_result = _build_share_mock()
        mock_result.data = self._valid_row()
        with _share_patch(mock_client):
            resp = client.get("/s/abc12345")
        assert resp.status_code == 200
        assert "save-btn" in resp.text
        assert "Save to MyPantry" in resp.text

    def test_multi_recipe_returns_mini_pantry(self, client):
        """Multiple recipes in one share link render as a grid, not a single card."""
        mock_client, _, mock_result = _build_share_mock()
        mock_result.data = self._valid_multi_row(("Pancakes", "Waffles"))
        with _share_patch(mock_client):
            resp = client.get("/s/abc12345")
        assert resp.status_code == 200
        assert "Pancakes" in resp.text
        assert "Waffles" in resp.text
        # Mini-pantry grid uses recipe-card elements and a Save All button
        assert "recipe-card" in resp.text
        assert "save-all-btn" in resp.text

    def test_unknown_id_returns_404(self, client):
        """A share ID that doesn't exist returns 404 HTML."""
        mock_client, _, mock_result = _build_share_mock()
        mock_result.data = []  # no rows found
        with _share_patch(mock_client):
            resp = client.get("/s/doesnotexist")
        assert resp.status_code == 404
        assert "text/html" in resp.headers["content-type"]

    def test_expired_id_returns_404(self, client):
        """
        The endpoint filters by expires_at > now() via .gt(); when the DB
        returns no rows (as it would for expired records), a 404 is served.
        """
        mock_client, _, mock_result = _build_share_mock()
        mock_result.data = []  # DB filtered out the expired row
        with _share_patch(mock_client):
            resp = client.get("/s/expiredid")
        assert resp.status_code == 404

    def test_expired_filter_is_applied(self, client):
        """Confirm .gt('expires_at', ...) is called on every GET /s/{id} request."""
        mock_client, chain, mock_result = _build_share_mock()
        mock_result.data = []
        with _share_patch(mock_client):
            client.get("/s/somerecipe")
        chain.gt.assert_called()
        call_args = chain.gt.call_args[0]
        assert call_args[0] == "expires_at"

    def test_supabase_error_returns_500(self, client):
        """A Supabase failure on GET returns 500."""
        mock_client = MagicMock()
        chain = MagicMock()
        chain.select.return_value = chain
        chain.eq.return_value = chain
        chain.gt.return_value = chain
        chain.limit.return_value = chain
        chain.execute.side_effect = RuntimeError("DB down")
        mock_client.table.return_value = chain

        with _share_patch(mock_client):
            resp = client.get("/s/errorcase")
        assert resp.status_code == 500
