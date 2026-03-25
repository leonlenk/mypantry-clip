"""
Unit tests for src/dependencies/rate_limit.py — two-tier fixed-window rate limiter.

Covers:
  - Within-limit requests pass both tiers
  - Daily limit breach (tier 1): 429 before weekly is checked
  - Weekly limit breach (tier 2): 429 after daily passes
  - Exact-limit boundary (should pass, not block)
  - reset_at timestamp present and correct in 429 detail
  - Retry-After header present on 429
  - Telemetry key incremented on every call
  - TTL set on first request per key, not on subsequent requests
  - Per-endpoint key isolation
  - Redis failure → 503 (fail-closed)
"""

import pytest
import time
from unittest.mock import patch, call
from fastapi import HTTPException

_DAILY_WINDOW = 86400
_WEEKLY_WINDOW = 604800


def _incr_sequence(*counts):
    """
    Build a side_effect list for mock_redis.incr.

    Call order in check_rate_limit_and_telemetry:
      1. telemetry incr
      2. daily incr
      3. weekly incr  (only reached if daily passes)
    """
    return list(counts)


class TestWithinLimits:

    def test_request_within_both_limits(self, _patch_env, mock_redis):
        """Request within daily and weekly limits passes without exception."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.side_effect = _incr_sequence(10, 2, 4)  # telemetry, daily, weekly
        # Should not raise
        check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)

    def test_request_at_exact_daily_limit_passes(self, _patch_env, mock_redis):
        """Request at exactly the daily limit should still pass (only > triggers block)."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.side_effect = _incr_sequence(10, 3, 4)  # daily == limit
        check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)

    def test_request_at_exact_weekly_limit_passes(self, _patch_env, mock_redis):
        """Request at exactly the weekly limit should still pass."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.side_effect = _incr_sequence(10, 2, 5)  # weekly == limit
        check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)


class TestDailyTier:

    def test_daily_limit_exceeded_raises_429(self, _patch_env, mock_redis):
        """Exceeding daily limit raises HTTP 429."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.side_effect = _incr_sequence(10, 4)  # daily count exceeds limit=3
        with pytest.raises(HTTPException) as exc_info:
            check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)
        assert exc_info.value.status_code == 429

    def test_daily_limit_exceeded_detail_contains_reset_at(self, _patch_env, mock_redis):
        """429 detail includes reset_at as a Unix timestamp in the daily window."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        now = int(time.time())
        mock_redis.incr.side_effect = _incr_sequence(10, 4)
        with pytest.raises(HTTPException) as exc_info:
            check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)

        detail = exc_info.value.detail
        assert "reset_at" in detail
        expected_reset = ((now // _DAILY_WINDOW) + 1) * _DAILY_WINDOW
        # Allow ±1s for timing
        assert abs(detail["reset_at"] - expected_reset) <= 1

    def test_daily_limit_exceeded_has_retry_after_header(self, _patch_env, mock_redis):
        """429 from daily tier includes a Retry-After header."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.side_effect = _incr_sequence(10, 4)
        with pytest.raises(HTTPException) as exc_info:
            check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)

        assert "Retry-After" in exc_info.value.headers
        retry_after = int(exc_info.value.headers["Retry-After"])
        assert 0 < retry_after <= _DAILY_WINDOW

    def test_daily_limit_short_circuits_before_weekly_check(self, _patch_env, mock_redis):
        """When daily limit is exceeded, the weekly counter is never incremented."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.side_effect = _incr_sequence(10, 4)  # only 2 incr calls happen
        with pytest.raises(HTTPException):
            check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)

        # incr called twice: telemetry + daily; weekly never reached
        assert mock_redis.incr.call_count == 2

    def test_daily_detail_message(self, _patch_env, mock_redis):
        """429 detail message identifies the daily limit."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.side_effect = _incr_sequence(10, 4)
        with pytest.raises(HTTPException) as exc_info:
            check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)

        assert "daily" in exc_info.value.detail["message"].lower()


class TestWeeklyTier:

    def test_weekly_limit_exceeded_raises_429(self, _patch_env, mock_redis):
        """Exceeding weekly limit (after daily passes) raises HTTP 429."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.side_effect = _incr_sequence(10, 2, 6)  # daily ok, weekly over
        with pytest.raises(HTTPException) as exc_info:
            check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)
        assert exc_info.value.status_code == 429

    def test_weekly_limit_exceeded_detail_contains_reset_at(self, _patch_env, mock_redis):
        """429 detail includes reset_at aligned to the weekly window."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        now = int(time.time())
        mock_redis.incr.side_effect = _incr_sequence(10, 2, 6)
        with pytest.raises(HTTPException) as exc_info:
            check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)

        detail = exc_info.value.detail
        assert "reset_at" in detail
        expected_reset = ((now // _WEEKLY_WINDOW) + 1) * _WEEKLY_WINDOW
        assert abs(detail["reset_at"] - expected_reset) <= 1

    def test_weekly_limit_exceeded_has_retry_after_header(self, _patch_env, mock_redis):
        """429 from weekly tier includes a Retry-After header."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.side_effect = _incr_sequence(10, 2, 6)
        with pytest.raises(HTTPException) as exc_info:
            check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)

        assert "Retry-After" in exc_info.value.headers
        retry_after = int(exc_info.value.headers["Retry-After"])
        assert 0 < retry_after <= _WEEKLY_WINDOW

    def test_weekly_detail_message(self, _patch_env, mock_redis):
        """429 detail message identifies the weekly limit."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.side_effect = _incr_sequence(10, 2, 6)
        with pytest.raises(HTTPException) as exc_info:
            check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)

        assert "weekly" in exc_info.value.detail["message"].lower()

    def test_weekly_retry_after_longer_than_daily(self, _patch_env, mock_redis):
        """Weekly Retry-After is longer than daily Retry-After (different window sizes).

        Pin time to day 1 of week 0 (now=86400) so both windows are clearly mid-week:
          daily_retry  = 86400  (full day remaining)
          weekly_retry = 518400 (6 days remaining)
        Without pinning, this fails on the last day of any weekly window because
        the daily and weekly resets coincide (7 days = 7 × 1 day).
        """
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        fixed_now = 86400  # start of day 1, well within week 0
        with patch("src.dependencies.rate_limit.time.time", return_value=fixed_now):
            mock_redis.incr.side_effect = _incr_sequence(10, 4)  # daily breach
            with pytest.raises(HTTPException) as daily_exc:
                check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)
            daily_retry = int(daily_exc.value.headers["Retry-After"])

            mock_redis.incr.side_effect = _incr_sequence(10, 2, 6)  # weekly breach
            with pytest.raises(HTTPException) as weekly_exc:
                check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)
            weekly_retry = int(weekly_exc.value.headers["Retry-After"])

        assert weekly_retry > daily_retry


class TestTelemetryAndTTL:

    def test_telemetry_key_incremented_on_every_request(self, _patch_env, mock_redis):
        """Total hits telemetry key is always incremented, even for blocked requests."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.side_effect = _incr_sequence(10, 2, 3)
        check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)

        telemetry_call = mock_redis.incr.call_args_list[0]
        assert "hits" in telemetry_call[0][0]
        assert "u1" in telemetry_call[0][0]

    def test_telemetry_incremented_even_when_daily_blocked(self, _patch_env, mock_redis):
        """Telemetry is still incremented before the 429 is raised."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.side_effect = _incr_sequence(10, 4)
        with pytest.raises(HTTPException):
            check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)

        telemetry_call = mock_redis.incr.call_args_list[0]
        assert "hits" in telemetry_call[0][0]

    def test_ttl_set_on_first_daily_request(self, _patch_env, mock_redis):
        """expire() is called for the daily key when count is 1."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        # telemetry=5, daily=1 (first), weekly=2
        mock_redis.incr.side_effect = _incr_sequence(5, 1, 2)
        check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)

        expire_calls = mock_redis.expire.call_args_list
        daily_expire = [c for c in expire_calls if c[0][1] == _DAILY_WINDOW]
        assert len(daily_expire) == 1

    def test_ttl_set_on_first_weekly_request(self, _patch_env, mock_redis):
        """expire() is called for the weekly key when count is 1."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        # telemetry=5, daily=2, weekly=1 (first)
        mock_redis.incr.side_effect = _incr_sequence(5, 2, 1)
        check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)

        expire_calls = mock_redis.expire.call_args_list
        weekly_expire = [c for c in expire_calls if c[0][1] == _WEEKLY_WINDOW]
        assert len(weekly_expire) == 1

    def test_ttl_not_set_on_subsequent_requests(self, _patch_env, mock_redis):
        """expire() is NOT called when counts are > 1."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.side_effect = _incr_sequence(5, 2, 3)  # no count == 1
        check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)
        mock_redis.expire.assert_not_called()


class TestKeyIsolation:

    def test_different_endpoints_use_different_keys(self, _patch_env, mock_redis):
        """Each endpoint has its own daily and weekly key namespace."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.return_value = 1

        check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)
        check_rate_limit_and_telemetry(user_id="u1", endpoint="substitute", daily_limit=3, weekly_limit=5)

        rate_keys = [c[0][0] for c in mock_redis.incr.call_args_list if "rate_limit" in c[0][0]]
        extract_keys = [k for k in rate_keys if "extract" in k]
        substitute_keys = [k for k in rate_keys if "substitute" in k]
        assert len(extract_keys) >= 1
        assert len(substitute_keys) >= 1

    def test_different_users_use_different_keys(self, _patch_env, mock_redis):
        """Each user has their own isolated rate-limit keys."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.return_value = 1

        check_rate_limit_and_telemetry(user_id="userA", endpoint="extract", daily_limit=3, weekly_limit=5)
        check_rate_limit_and_telemetry(user_id="userB", endpoint="extract", daily_limit=3, weekly_limit=5)

        rate_keys = [c[0][0] for c in mock_redis.incr.call_args_list if "rate_limit" in c[0][0]]
        userA_keys = [k for k in rate_keys if "userA" in k]
        userB_keys = [k for k in rate_keys if "userB" in k]
        assert len(userA_keys) >= 1
        assert len(userB_keys) >= 1

    def test_daily_and_weekly_keys_are_distinct(self, _patch_env, mock_redis):
        """Daily and weekly counters use separate Redis keys."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.return_value = 1
        check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)

        rate_keys = [c[0][0] for c in mock_redis.incr.call_args_list if "rate_limit" in c[0][0]]
        assert len(set(rate_keys)) == 2, "Daily and weekly must use distinct Redis keys"


class TestRedisFailure:

    def test_redis_failure_returns_503(self, _patch_env, mock_redis):
        """When Redis is down, requests are rejected with 503."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        mock_redis.incr.side_effect = ConnectionError("Redis down")
        with pytest.raises(HTTPException) as exc_info:
            check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)
        assert exc_info.value.status_code == 503

    def test_redis_failure_mid_check_returns_503(self, _patch_env, mock_redis):
        """Redis failure after telemetry incr (during rate-limit check) still gives 503."""
        from src.dependencies.rate_limit import check_rate_limit_and_telemetry

        # Telemetry succeeds, daily incr fails
        mock_redis.incr.side_effect = [1, ConnectionError("Redis down")]
        with pytest.raises(HTTPException) as exc_info:
            check_rate_limit_and_telemetry(user_id="u1", endpoint="extract", daily_limit=3, weekly_limit=5)
        assert exc_info.value.status_code == 503
