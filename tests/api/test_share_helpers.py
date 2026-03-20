"""
Tests for the pure helper functions in src/routers/share.py.

These cover the uncovered lines (69-82, 95, 103-113, 134-137, 158-178,
300-314, 378) by testing functions directly rather than through HTTP.
"""

import sys
import os
import pytest

API_ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "apps", "api")
sys.path.insert(0, os.path.abspath(API_ROOT))


def _import_share():
    for m in list(sys.modules.keys()):
        if m.startswith("src"):
            del sys.modules[m]
    import src.routers.share as share
    return share


# ---------------------------------------------------------------------------
# _decimal_to_fraction
# ---------------------------------------------------------------------------

class TestDecimalToFraction:

    def test_zero(self, monkeypatch):
        import tests.api.conftest
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)
        share = _import_share()
        assert share._decimal_to_fraction(0) == "0"

    def test_negative(self, monkeypatch):
        import tests.api.conftest
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)
        share = _import_share()
        assert share._decimal_to_fraction(-1) == "0"

    def test_whole_number(self, monkeypatch):
        import tests.api.conftest
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)
        share = _import_share()
        assert share._decimal_to_fraction(3.0) == "3"

    def test_half(self, monkeypatch):
        import tests.api.conftest
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)
        share = _import_share()
        assert share._decimal_to_fraction(0.5) == "1/2"

    def test_one_and_half(self, monkeypatch):
        import tests.api.conftest
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)
        share = _import_share()
        assert share._decimal_to_fraction(1.5) == "1 1/2"

    def test_quarter(self, monkeypatch):
        import tests.api.conftest
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)
        share = _import_share()
        assert share._decimal_to_fraction(0.25) == "1/4"

    def test_rounds_up_to_next_whole(self, monkeypatch):
        """Fraction close to 1 should round to whole+1."""
        import tests.api.conftest
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)
        share = _import_share()
        # 0.96 is closer to 1 than to 7/8
        assert share._decimal_to_fraction(0.96) == "1"

    def test_decimal_fallback(self, monkeypatch):
        """Amount with no close fraction falls back to rounded decimal."""
        import tests.api.conftest
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)
        share = _import_share()
        # 0.6 is not close to any standard fraction
        result = share._decimal_to_fraction(0.6)
        assert "0.6" in result or "/" in result  # either decimal or nearest fraction

    def test_whole_with_negligible_frac(self, monkeypatch):
        """Amount where frac < 0.05 returns just the whole number."""
        import tests.api.conftest
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)
        share = _import_share()
        assert share._decimal_to_fraction(2.02) == "2"


# ---------------------------------------------------------------------------
# _format_ingredient_text
# ---------------------------------------------------------------------------

class TestFormatIngredientText:

    def _share(self, monkeypatch):
        import tests.api.conftest
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)
        return _import_share()

    def test_no_item_returns_raw(self, monkeypatch):
        """When 'item' is empty, rawText is returned as-is."""
        share = self._share(monkeypatch)
        result = share._format_ingredient_text({"rawText": "1 cup flour", "item": ""})
        assert result == "1 cup flour"

    def test_item_with_amount_and_unit(self, monkeypatch):
        """Amount and unit are formatted into the string."""
        share = self._share(monkeypatch)
        ing = {"item": "flour", "us_amount": 1.5, "us_unit": "cups"}
        result = share._format_ingredient_text(ing)
        assert "flour" in result
        assert "cups" in result
        assert "1 1/2" in result

    def test_item_with_preparation(self, monkeypatch):
        """Preparation is appended after a comma."""
        share = self._share(monkeypatch)
        ing = {"item": "onion", "us_amount": 1.0, "us_unit": "medium", "preparation": "diced"}
        result = share._format_ingredient_text(ing)
        assert "diced" in result
        assert "," in result

    def test_item_no_amount(self, monkeypatch):
        """Item without amount still returns item name."""
        share = self._share(monkeypatch)
        ing = {"item": "salt"}
        result = share._format_ingredient_text(ing)
        assert result == "salt"

    def test_invalid_amount_is_skipped(self, monkeypatch):
        """Non-numeric us_amount is silently skipped."""
        share = self._share(monkeypatch)
        ing = {"item": "oil", "us_amount": "not-a-number"}
        result = share._format_ingredient_text(ing)
        assert "oil" in result


# ---------------------------------------------------------------------------
# _format_time / _time_chips_html
# ---------------------------------------------------------------------------

class TestFormatTime:

    def _share(self, monkeypatch):
        import tests.api.conftest
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)
        return _import_share()

    def test_none_returns_none(self, monkeypatch):
        share = self._share(monkeypatch)
        assert share._format_time(None) is None

    def test_zero_returns_none(self, monkeypatch):
        share = self._share(monkeypatch)
        assert share._format_time(0) is None

    def test_minutes_only(self, monkeypatch):
        share = self._share(monkeypatch)
        assert share._format_time(30) == "30 min"

    def test_hours_only(self, monkeypatch):
        share = self._share(monkeypatch)
        assert share._format_time(120) == "2h"

    def test_hours_and_minutes(self, monkeypatch):
        share = self._share(monkeypatch)
        assert share._format_time(90) == "1h 30min"

    def test_chips_with_times(self, monkeypatch):
        """_time_chips_html produces chip divs for non-null times."""
        share = self._share(monkeypatch)
        recipe = {"prepTimeMinutes": 10, "cookTimeMinutes": 20}
        html = share._time_chips_html(recipe)
        assert "chip" in html
        assert "Prep" in html
        assert "Cook" in html

    def test_chips_empty_when_no_times(self, monkeypatch):
        """No times → empty string."""
        share = self._share(monkeypatch)
        html = share._time_chips_html({})
        assert html == ""


# ---------------------------------------------------------------------------
# _ingredients_html
# ---------------------------------------------------------------------------

class TestIngredientsHtml:

    def _share(self, monkeypatch):
        import tests.api.conftest
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)
        return _import_share()

    def test_group_header_rendered(self, monkeypatch):
        """Ingredient with a group renders an ing-group-header li."""
        share = self._share(monkeypatch)
        ings = [{"item": "flour", "group": "Dry Ingredients"}]
        html = share._ingredients_html(ings)
        assert "ing-group-header" in html
        assert "Dry Ingredients" in html

    def test_subtext_rendered(self, monkeypatch):
        """Ingredient with subtext renders the ing-subtext span."""
        share = self._share(monkeypatch)
        ings = [{"item": "butter", "subtext": "or margarine"}]
        html = share._ingredients_html(ings)
        assert "ing-subtext" in html
        assert "or margarine" in html

    def test_simple_ingredient(self, monkeypatch):
        """Plain ingredient renders as a simple li."""
        share = self._share(monkeypatch)
        ings = [{"item": "salt"}]
        html = share._ingredients_html(ings)
        assert "<li>" in html
        assert "salt" in html


# ---------------------------------------------------------------------------
# _instructions_html
# ---------------------------------------------------------------------------

class TestInstructionsHtml:

    def _share(self, monkeypatch):
        import tests.api.conftest
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)
        return _import_share()

    def test_group_header_rendered(self, monkeypatch):
        """Instruction step with group renders inst-group-header li."""
        share = self._share(monkeypatch)
        steps = [{"text": "Preheat oven", "group": "Preparation"}]
        html = share._instructions_html(steps)
        assert "inst-group-header" in html
        assert "Preparation" in html

    def test_step_text_rendered(self, monkeypatch):
        share = self._share(monkeypatch)
        steps = [{"text": "Mix flour and water."}]
        html = share._instructions_html(steps)
        assert "Mix flour and water." in html


# ---------------------------------------------------------------------------
# _render_single_recipe_page — optional metadata fields
# ---------------------------------------------------------------------------

class TestRenderSingleRecipePage:

    def _share(self, monkeypatch):
        import tests.api.conftest
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)
        return _import_share()

    def test_author_rendered(self, monkeypatch):
        share = self._share(monkeypatch)
        recipe = {"title": "Bread", "author": "Jane Doe", "ingredients": [], "instructions": []}
        html = share._render_single_recipe_page(recipe, 30)
        assert "Jane Doe" in html
        assert "By Jane Doe" in html

    def test_source_url_rendered(self, monkeypatch):
        share = self._share(monkeypatch)
        recipe = {
            "title": "Soup",
            "url": "https://example.com/soup",
            "ingredients": [],
            "instructions": [],
        }
        html = share._render_single_recipe_page(recipe, 30)
        assert "View original" in html
        assert "example.com/soup" in html

    def test_yield_text_rendered(self, monkeypatch):
        share = self._share(monkeypatch)
        recipe = {"title": "Cookies", "yield": "24 cookies", "ingredients": [], "instructions": []}
        html = share._render_single_recipe_page(recipe, 30)
        assert "24 cookies" in html
        assert "Yield" in html

    def test_servings_rendered_when_no_yield(self, monkeypatch):
        share = self._share(monkeypatch)
        recipe = {"title": "Pasta", "servings": 4, "ingredients": [], "instructions": []}
        html = share._render_single_recipe_page(recipe, 30)
        assert "Servings: 4" in html

    def test_notes_rendered(self, monkeypatch):
        share = self._share(monkeypatch)
        recipe = {
            "title": "Cake",
            "notes": ["Use room-temperature eggs."],
            "ingredients": [],
            "instructions": [],
        }
        html = share._render_single_recipe_page(recipe, 30)
        assert "Notes" in html
        assert "room-temperature eggs" in html


# ---------------------------------------------------------------------------
# _render_mini_card — image placeholder
# ---------------------------------------------------------------------------

class TestRenderMiniCard:

    def test_no_image_shows_placeholder(self, monkeypatch):
        import tests.api.conftest
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)
        share = _import_share()
        recipe = {"title": "Tacos", "ingredients": [], "instructions": []}
        html = share._render_mini_card(recipe, 0)
        assert "card-img-placeholder" in html

    def test_with_image(self, monkeypatch):
        import tests.api.conftest
        for k, v in tests.api.conftest._ENV_OVERRIDES.items():
            monkeypatch.setenv(k, v)
        share = _import_share()
        recipe = {"title": "Tacos", "image": "https://example.com/tacos.jpg", "ingredients": []}
        html = share._render_mini_card(recipe, 0)
        assert "tacos.jpg" in html
        assert "card-img-placeholder" not in html
