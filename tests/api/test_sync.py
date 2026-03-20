"""
Tests for /api/sync/* — cloud recipe sync endpoints.

Covers: save, import, latest, list, delete — including auth, validation,
error handling, and embedding stripping.
"""

import json
from unittest.mock import patch, MagicMock
from tests.api.conftest import FAKE_USER_ID


# ---------------------------------------------------------------------------
# POST /api/sync/save
# ---------------------------------------------------------------------------

class TestSyncSave:

    def test_save_success(self, client, mock_verify_jwt, mock_supabase, sample_recipe_dict):
        """Upsert a recipe returns success and the recipe id."""
        resp = client.post("/api/sync/save", json={"recipe": sample_recipe_dict})
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["id"] == sample_recipe_dict["id"]

    def test_save_strips_embedding(self, client, mock_verify_jwt, mock_supabase, sample_recipe_dict):
        """The embedding field should be stripped before persisting."""
        sample_recipe_dict["embedding"] = [0.1, 0.2, 0.3]
        resp = client.post("/api/sync/save", json={"recipe": sample_recipe_dict})
        assert resp.status_code == 200

        # Verify the row passed to upsert does NOT contain 'embedding' in recipe_json
        mock_client, chain, _ = mock_supabase
        upsert_call = chain.upsert.call_args
        row = upsert_call[0][0]  # first positional arg
        assert "embedding" not in row["recipe_json"]

    def test_save_missing_id(self, client, mock_verify_jwt, mock_supabase):
        """Recipe without 'id' field returns 400."""
        resp = client.post("/api/sync/save", json={"recipe": {"title": "No ID"}})
        assert resp.status_code == 400
        assert "id" in resp.json()["detail"].lower()

    def test_save_unauthenticated(self, client):
        """Request without auth returns 401/403."""
        resp = client.post("/api/sync/save", json={"recipe": {"id": "x"}})
        assert resp.status_code in (401, 403)

    def test_save_supabase_error(self, client, mock_verify_jwt, sample_recipe_dict):
        """Supabase failure returns 500."""
        mock_client = MagicMock()
        mock_client.table.return_value.upsert.return_value.execute.side_effect = RuntimeError("DB down")

        with patch("src.routers.sync.get_supabase_client", return_value=mock_client):
            resp = client.post("/api/sync/save", json={"recipe": sample_recipe_dict})

        assert resp.status_code == 500


# ---------------------------------------------------------------------------
# POST /api/sync/import
# ---------------------------------------------------------------------------

class TestSyncImport:

    def test_import_batch_success(self, client, mock_verify_jwt, mock_supabase, sample_recipe_dict):
        """Batch import returns count of upserted recipes."""
        recipes = [sample_recipe_dict, {**sample_recipe_dict, "id": "recipe-002"}]
        resp = client.post("/api/sync/import", json={"recipes": recipes})
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["count"] == 2

    def test_import_empty_list(self, client, mock_verify_jwt, mock_supabase):
        """Empty recipe list returns count 0 without hitting Supabase."""
        resp = client.post("/api/sync/import", json={"recipes": []})
        assert resp.status_code == 200
        assert resp.json()["count"] == 0

    def test_import_skips_recipes_without_id(self, client, mock_verify_jwt, mock_supabase, sample_recipe_dict):
        """Recipes missing 'id' are silently skipped."""
        recipes = [sample_recipe_dict, {"title": "No ID Recipe"}]
        resp = client.post("/api/sync/import", json={"recipes": recipes})
        assert resp.status_code == 200
        assert resp.json()["count"] == 1

    def test_import_strips_embedding(self, client, mock_verify_jwt, mock_supabase, sample_recipe_dict):
        """Embedding fields are stripped from all recipes in a batch."""
        sample_recipe_dict["embedding"] = [0.1, 0.2]
        resp = client.post("/api/sync/import", json={"recipes": [sample_recipe_dict]})
        assert resp.status_code == 200

        _, chain, _ = mock_supabase
        rows = chain.upsert.call_args[0][0]
        for row in rows:
            assert "embedding" not in row["recipe_json"]

    def test_import_supabase_error(self, client, mock_verify_jwt, sample_recipe_dict):
        """Supabase failure during import returns 500."""
        mock_client = MagicMock()
        mock_client.table.return_value.upsert.return_value.execute.side_effect = RuntimeError("DB down")

        with patch("src.routers.sync.get_supabase_client", return_value=mock_client):
            resp = client.post("/api/sync/import", json={"recipes": [sample_recipe_dict]})

        assert resp.status_code == 500

    def test_import_unauthenticated(self, client):
        """Import without auth returns 401/403."""
        resp = client.post("/api/sync/import", json={"recipes": []})
        assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# GET /api/sync/latest
# ---------------------------------------------------------------------------

class TestSyncLatest:

    def test_latest_returns_timestamp(self, client, mock_verify_jwt, mock_supabase):
        """Returns the most recent updated_at when recipes exist."""
        _, _, mock_result = mock_supabase
        mock_result.data = [{"updated_at": "2026-03-01T00:00:00Z"}]

        resp = client.get("/api/sync/latest")
        assert resp.status_code == 200
        assert resp.json()["latest_updated_at"] == "2026-03-01T00:00:00Z"

    def test_latest_returns_null_when_empty(self, client, mock_verify_jwt, mock_supabase):
        """Returns null when no recipes exist for the user."""
        _, _, mock_result = mock_supabase
        mock_result.data = []

        resp = client.get("/api/sync/latest")
        assert resp.status_code == 200
        assert resp.json()["latest_updated_at"] is None

    def test_latest_unauthenticated(self, client):
        """Without auth, returns 401/403."""
        resp = client.get("/api/sync/latest")
        assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# GET /api/sync/list
# ---------------------------------------------------------------------------

class TestSyncList:

    def test_list_returns_recipes(self, client, mock_verify_jwt, mock_supabase):
        """Returns a JSON array of recipe objects."""
        _, _, mock_result = mock_supabase
        mock_result.data = [
            {"id": "r1", "recipe_json": {"title": "A"}, "updated_at": "2026-03-01T00:00:00Z"},
        ]

        resp = client.get("/api/sync/list")
        assert resp.status_code == 200
        body = resp.json()
        assert "recipes" in body
        assert len(body["recipes"]) == 1

    def test_list_returns_empty_array(self, client, mock_verify_jwt, mock_supabase):
        """When no recipes exist, returns an empty array."""
        _, _, mock_result = mock_supabase
        mock_result.data = []

        resp = client.get("/api/sync/list")
        assert resp.status_code == 200
        assert resp.json()["recipes"] == []

    def test_list_filters_by_since(self, client, mock_verify_jwt, mock_supabase):
        """When 'since' query param is given, it is forwarded to the DB query."""
        _, chain, mock_result = mock_supabase
        mock_result.data = []

        resp = client.get("/api/sync/list", params={"since": "2026-01-01T00:00:00Z"})
        assert resp.status_code == 200
        # Verify .gt() was called (since param triggers the filter)
        chain.gt.assert_called()

    def test_list_unauthenticated(self, client):
        """Without auth, returns 401/403."""
        resp = client.get("/api/sync/list")
        assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# DELETE /api/sync/delete/{recipe_id}
# ---------------------------------------------------------------------------

class TestSyncImportEdgeCases:
    """Additional import edge cases to cover missing branches."""

    def test_import_all_recipes_missing_id_returns_zero(self, client, mock_verify_jwt, mock_supabase):
        """When every recipe in the batch lacks an 'id', count returns 0 without hitting Supabase."""
        recipes = [{"title": "No ID A"}, {"title": "No ID B"}]
        resp = client.post("/api/sync/import", json={"recipes": recipes})
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["count"] == 0

        # Supabase upsert should NOT have been called
        _, chain, _ = mock_supabase
        chain.upsert.assert_not_called()


class TestSyncLatestError:
    """Exception path for GET /api/sync/latest."""

    def test_latest_supabase_error_returns_500(self, client, mock_verify_jwt):
        """Supabase failure in get_latest_timestamp returns 500."""
        mock_client = MagicMock()
        chain = MagicMock()
        chain.select.return_value = chain
        chain.eq.return_value = chain
        chain.order.return_value = chain
        chain.limit.return_value = chain
        chain.execute.side_effect = RuntimeError("DB down")
        mock_client.table.return_value = chain

        with patch("src.routers.sync.get_supabase_client", return_value=mock_client):
            resp = client.get("/api/sync/latest")

        assert resp.status_code == 500


class TestSyncListEdgeCases:
    """Streaming generator edge cases for GET /api/sync/list."""

    def test_list_multiple_recipes_comma_separated(self, client, mock_verify_jwt, mock_supabase):
        """Two recipes in the stream are comma-separated in the JSON output."""
        _, _, mock_result = mock_supabase
        mock_result.data = [
            {"id": "r1", "recipe_json": {"title": "A"}, "updated_at": "2026-03-01T00:00:00Z"},
            {"id": "r2", "recipe_json": {"title": "B"}, "updated_at": "2026-03-02T00:00:00Z"},
        ]

        resp = client.get("/api/sync/list")
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["recipes"]) == 2

    def test_list_generator_exception_returns_partial_json(self, client, mock_verify_jwt):
        """When Supabase raises inside the generator, the response ends abruptly."""
        mock_client = MagicMock()
        chain = MagicMock()
        chain.select.return_value = chain
        chain.eq.return_value = chain
        chain.order.return_value = chain
        chain.range.return_value = chain
        chain.execute.side_effect = RuntimeError("stream error")
        mock_client.table.return_value = chain

        with patch("src.routers.sync.get_supabase_client", return_value=mock_client):
            resp = client.get("/api/sync/list")

        # Response still comes back (generator catches and yields closing bracket)
        assert resp.status_code == 200

    def test_list_paginates_full_chunk(self, client, mock_verify_jwt):
        """When first page returns exactly 50 rows, a second query is issued."""
        mock_client = MagicMock()
        chain = MagicMock()
        chain.select.return_value = chain
        chain.eq.return_value = chain
        chain.order.return_value = chain
        chain.range.return_value = chain

        first_result = MagicMock()
        first_result.data = [
            {"id": f"r{i}", "recipe_json": {"title": f"R{i}"}, "updated_at": "2026-01-01"}
            for i in range(50)
        ]
        second_result = MagicMock()
        second_result.data = []  # second page is empty → loop ends

        chain.execute.side_effect = [first_result, second_result]
        mock_client.table.return_value = chain

        with patch("src.routers.sync.get_supabase_client", return_value=mock_client):
            resp = client.get("/api/sync/list")

        assert resp.status_code == 200
        assert len(resp.json()["recipes"]) == 50
        assert chain.execute.call_count == 2


class TestSyncDelete:

    def test_delete_success(self, client, mock_verify_jwt, mock_supabase):
        """Deleting an existing recipe returns success."""
        resp = client.delete("/api/sync/delete/recipe-001")
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["id"] == "recipe-001"

    def test_delete_scoped_to_user(self, client, mock_verify_jwt, mock_supabase):
        """Delete call filters by both recipe_id and user_id."""
        resp = client.delete("/api/sync/delete/recipe-001")
        assert resp.status_code == 200

        _, chain, _ = mock_supabase
        # .eq() should be called twice: once for id, once for user_id
        eq_calls = chain.eq.call_args_list
        call_args = [(c[0][0], c[0][1]) for c in eq_calls]
        assert ("id", "recipe-001") in call_args
        assert ("user_id", FAKE_USER_ID) in call_args

    def test_delete_unauthenticated(self, client):
        """Without auth, returns 401/403."""
        resp = client.delete("/api/sync/delete/recipe-001")
        assert resp.status_code in (401, 403)

    def test_delete_supabase_error(self, client, mock_verify_jwt):
        """Supabase failure returns 500."""
        mock_client = MagicMock()
        chain = MagicMock()
        chain.eq.return_value = chain
        chain.delete.return_value = chain
        chain.execute.side_effect = RuntimeError("DB down")
        mock_client.table.return_value = chain

        with patch("src.routers.sync.get_supabase_client", return_value=mock_client):
            resp = client.delete("/api/sync/delete/recipe-001")

        assert resp.status_code == 500
