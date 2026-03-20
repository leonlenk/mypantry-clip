from fastapi import HTTPException
from upstash_redis import Redis
from src.config import settings
from loguru import logger
import time

# Initialize synchronous Redis client with retries for transient disconnects
redis = Redis(
    url=settings.upstash_redis_rest_url,
    token=settings.upstash_redis_rest_token,
    rest_retries=3
)

_DAILY_WINDOW = 86400      # 24 hours in seconds
_WEEKLY_WINDOW = 604800    # 7 days in seconds


def _incr_with_expiry(key: str, window_seconds: int) -> int:
    """Increment a fixed-window counter, setting expiry on first write. Returns new count."""
    count = redis.incr(key)
    if count == 1:
        redis.expire(key, window_seconds)
    return count


def check_rate_limit_and_telemetry(
    user_id: str,
    endpoint: str,
    daily_limit: int = 15,
    weekly_limit: int = 50,
):
    """
    Two-tier fixed-window rate limiter + telemetry via Upstash Redis.

    Tier 1: daily_limit requests per rolling 24-hour window.
    Tier 2: weekly_limit requests per rolling 7-day window.

    Raises HTTP 429 with reset_at (Unix timestamp) on breach.
    """
    try:
        # Telemetry: total lifetime hits
        redis.incr(f"user:{user_id}:hits")

        now = int(time.time())

        # ── Tier 1: daily ────────────────────────────────────────────────────
        daily_window = now // _DAILY_WINDOW
        daily_key = f"rate_limit:{user_id}:{endpoint}:daily:{daily_window}"
        daily_count = _incr_with_expiry(daily_key, _DAILY_WINDOW)

        if daily_count > daily_limit:
            reset_at = (daily_window + 1) * _DAILY_WINDOW
            logger.warning(
                f"Daily rate limit exceeded: user={user_id} endpoint={endpoint} "
                f"count={daily_count}/{daily_limit}"
            )
            raise HTTPException(
                status_code=429,
                detail={"message": "Daily limit reached", "reset_at": reset_at},
                headers={"Retry-After": str(reset_at - now)},
            )

        # ── Tier 2: weekly ───────────────────────────────────────────────────
        weekly_window = now // _WEEKLY_WINDOW
        weekly_key = f"rate_limit:{user_id}:{endpoint}:weekly:{weekly_window}"
        weekly_count = _incr_with_expiry(weekly_key, _WEEKLY_WINDOW)

        if weekly_count > weekly_limit:
            reset_at = (weekly_window + 1) * _WEEKLY_WINDOW
            logger.warning(
                f"Weekly rate limit exceeded: user={user_id} endpoint={endpoint} "
                f"count={weekly_count}/{weekly_limit}"
            )
            raise HTTPException(
                status_code=429,
                detail={"message": "Weekly limit reached", "reset_at": reset_at},
                headers={"Retry-After": str(reset_at - now)},
            )

        logger.info(
            f"Request allowed: user={user_id} endpoint={endpoint} "
            f"daily={daily_count}/{daily_limit} weekly={weekly_count}/{weekly_limit}"
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Redis error in rate_limit: {e}")
        raise HTTPException(status_code=503, detail="Rate limiting service unavailable")
