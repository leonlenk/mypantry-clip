"""
Unit tests for src/dependencies/rate_limit.py — fixed-window rate limiter.

Covers: within-limit, over-limit, telemetry counting, TTL setting, per-endpoint
isolation, and Redis failure (fail-open).
"""

import pytest
from unittest.mock import patch, MagicMock, call
from fastapi import HTTPException


class TestCheckRateLimitAndTelemetry:

    def _import_fresh(self):
        """Re-import the rate_limit module with a fresh mock Redis."""
        import sys
        for m in [m for m in sys.modules if m.startswith("src")]:
            del sys.modules[m]
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry
        return check_rate_limit_and_telemetry

    def test_request_within_limit(self, _patch_env, mock_redis):
        """Request within limit passes without exception."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.return_value = 1
        # Should not raise
        check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", limit=5)

    def test_request_exceeding_limit(self, _patch_env, mock_redis):
        """Request exceeding limit raises 429."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        # First call to incr is telemetry, second is rate limit count
        mock_redis.incr.side_effect = [10, 6]  # telemetry=10, rate count=6
        with pytest.raises(HTTPException) as exc_info:
            check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", limit=5)
        assert exc_info.value.status_code == 429

    def test_request_at_exact_limit(self, _patch_env, mock_redis):
        """Request at exactly the limit should still pass."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.side_effect = [10, 5]  # telemetry=10, count == limit
        # Should NOT raise — only exceeding (>) triggers 429
        check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", limit=5)

    def test_telemetry_increments(self, _patch_env, mock_redis):
        """Total hits telemetry key is incremented."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.return_value = 1
        check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", limit=50)

        # incr is called twice: once for telemetry, once for rate limit
        assert mock_redis.incr.call_count == 2
        telemetry_call = mock_redis.incr.call_args_list[0]
        assert "hits" in telemetry_call[0][0]

    def test_sets_ttl_on_first_request(self, _patch_env, mock_redis):
        """TTL (expire) is set when count==1 (first request in window)."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.return_value = 1  # first request
        check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", limit=50)
        mock_redis.expire.assert_called_once()

    def test_no_ttl_on_subsequent_requests(self, _patch_env, mock_redis):
        """TTL is NOT re-set on subsequent requests (count > 1)."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.side_effect = [5, 3]  # telemetry=5, count=3
        check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", limit=50)
        mock_redis.expire.assert_not_called()

    def test_different_endpoints_use_different_keys(self, _patch_env, mock_redis):
        """Each endpoint has its own rate-limit key namespace."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.return_value = 1

        check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", limit=50)
        check_rate_limit_and_telemetry(user_id="u1", endpoint="substitute", limit=50)

        # Should have 4 incr calls: 2 per invocation (telemetry + rate)
        rate_keys = [c[0][0] for c in mock_redis.incr.call_args_list if "rate_limit" in c[0][0]]
        # The two rate-limit keys must differ
        assert len(set(rate_keys)) == 2

    def test_redis_failure_fails_closed(self, _patch_env, mock_redis):
        """When Redis is down, requests are rejected with 503 (fail-closed strategy)."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.side_effect = ConnectionError("Redis down")
        with pytest.raises(HTTPException) as exc_info:
            check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", limit=5)
        assert exc_info.value.status_code == 503
