from fastapi import HTTPException, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import jwt
from jwt import PyJWK
from src.config import settings
from loguru import logger
import json
import os
from functools import lru_cache

security = HTTPBearer()

@lru_cache()
def get_supabase_public_key():
    """Loads and caches the public key used to verify Supabase JWTs."""
    # Try multiple paths to find the public key file
    possible_paths = [
        os.path.join(os.getcwd(), settings.supabase_pub_key_path),
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), settings.supabase_pub_key_path)
    ]
    
    key_path = None
    for path in possible_paths:
        if os.path.exists(path):
            key_path = path
            break
            
    if not key_path:
        logger.error(f"Supabase public key not found at any of: {possible_paths}")
        raise RuntimeError("Missing Supabase public key")
        
    assert key_path is not None
    logger.info(f"Loading Supabase public key from: {key_path}")
    with open(key_path, "r") as f:
        jwk_data = json.load(f)
        
    return PyJWK(jwk_data).key

def verify_jwt(credentials: HTTPAuthorizationCredentials = Security(security)) -> str:
    """Verifies the Supabase JWT using ES256 and returns the user ID."""
    token = credentials.credentials
    try:
        public_key = get_supabase_public_key()
        # Decode and verify the ES256 signature
        payload = jwt.decode(
            token,
            public_key,
            algorithms=["ES256"],
            audience="authenticated"
        )
        return payload["sub"]
    except jwt.ExpiredSignatureError:
        logger.warning("Expired JWT token received")
        raise HTTPException(status_code=401, detail="Token has expired")
    except jwt.InvalidTokenError as e:
        logger.warning(f"Invalid JWT token received: {e}")
        raise HTTPException(status_code=401, detail="Invalid token")
