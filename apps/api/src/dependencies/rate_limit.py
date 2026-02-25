from fastapi import HTTPException
from upstash_redis import Redis
from src.config import settings
from loguru import logger
import time

# Initialize synchronous Redis client
redis = Redis(url=settings.upstash_redis_rest_url, token=settings.upstash_redis_rest_token)

def check_rate_limit_and_telemetry(user_id: str, endpoint: str, limit: int = 50, window_seconds: int = 604800):
    """
    Fixed-window rate limiter and telemetry tracking using Upstash Redis.
    Defaults to 50 requests per week (604800 seconds) per endpoint.
    """
    try:
        # Telemetry: Total Hits
        telemetry_key = f"user:{user_id}:hits"
        total_hits = redis.incr(telemetry_key)
        
        # Rate Limiting: Fixed Window
        current_window = int(time.time()) // window_seconds
        rate_limit_key = f"rate_limit:{user_id}:{endpoint}:{current_window}"
        
        count = redis.incr(rate_limit_key)
        if count == 1:
            redis.expire(rate_limit_key, window_seconds)
            
        if count > limit:
            logger.warning(f"Rate limit exceeded: user={user_id} endpoint={endpoint} count={count}/{limit}")
            raise HTTPException(status_code=429, detail="Rate limit exceeded")
            
        logger.info(f"Request allowed: user={user_id} endpoint={endpoint} hits={total_hits}")
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Redis error in rate_limit: {e}")
        # Fail-open approach if Redis is down, to maintain availability
        pass
