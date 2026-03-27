from contextlib import asynccontextmanager
from fastapi import FastAPI, APIRouter, Request, Response
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from src.utils.logger import setup_logging
from src.config import settings
from src.routers import extract, substitute, sync, privacy, home, share
from src.dependencies.auth import get_supabase_public_key
from loguru import logger
import uvicorn
import os

setup_logging()


class WwwRedirectMiddleware(BaseHTTPMiddleware):
    """301 redirect www.mypantry.dev → mypantry.dev for SEO canonicalization."""

    async def dispatch(self, request: Request, call_next) -> Response:
        host = request.headers.get("host", "")
        if host.startswith("www."):
            non_www = host[4:]  # strip "www."
            target = f"https://{non_www}{request.url.path}"
            if request.url.query:
                target += f"?{request.url.query}"
            return RedirectResponse(url=target, status_code=301)
        return await call_next(request)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response


class OriginValidationMiddleware(BaseHTTPMiddleware):
    """Reject requests to protected API routes whose Origin header is not in the
    CORS allowlist.  This closes the gap where non-browser clients (curl, scripts)
    bypass CORS by simply not sending a preflight — they still set an Origin that
    we can validate here."""

    _PROTECTED_PREFIXES = (
        "/api/extract",
        "/api/substitute",
        "/api/sync",
        "/api/share",
    )

    async def dispatch(self, request: Request, call_next) -> Response:
        # Let CORS middleware handle OPTIONS preflights normally.
        if request.method == "OPTIONS":
            return await call_next(request)

        if request.url.path.startswith(self._PROTECTED_PREFIXES):
            origin = request.headers.get("origin", "")
            if origin not in _build_cors_origins():
                logger.warning(
                    f"Rejected request from disallowed origin '{origin}' "
                    f"to {request.url.path}"
                )
                return Response(status_code=403, content="Forbidden")

        return await call_next(request)


@asynccontextmanager
async def lifespan(app: FastAPI):
    origins = _build_cors_origins()
    logger.info(f"CORS allowed origins: {origins}")
    # Validate the Supabase public key is present at startup so auth failures
    # are caught immediately rather than on the first authenticated request.
    get_supabase_public_key()
    yield


def _build_cors_origins() -> list[str]:
    origins = [
        f"chrome-extension://{settings.extension_id}",
        "https://mypantry.dev",
    ]
    if settings.cors_allow_localhost:
        origins += [
            "http://localhost",
            "http://127.0.0.1",
            "http://localhost:8000",
            "http://127.0.0.1:8000",
        ]
    return origins

app = FastAPI(
    title="MyPantry Clip Cloud API",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

# Mount static files directory
static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(static_dir):
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_build_cors_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "Authorization"],
)
app.add_middleware(OriginValidationMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(WwwRedirectMiddleware)

api_router = APIRouter(prefix="/api")
api_router.include_router(extract.router)
api_router.include_router(substitute.router)
api_router.include_router(sync.router)
api_router.include_router(share.api_router)


@api_router.get("/auth/callback", response_class=HTMLResponse)
def auth_callback():
    return """
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Authorizing... | MyPantry Clip</title>
        <meta name="robots" content="noindex, nofollow">
        <meta name="description" content="Securely linking your MyPantry Clip account.">
        <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                background-color: #FDFBF7;
                color: #4A4036;
            }
            .loader {
                border: 3px solid #E8E3D9;
                border-top: 3px solid #E5B299;
                border-radius: 50%;
                width: 24px;
                height: 24px;
                animation: spin 1s linear infinite;
                margin-bottom: 1rem;
            }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            p { margin: 0; font-size: 1.1rem; }
            .sub { color: #8C7F70; font-size: 0.9rem; margin-top: 0.5rem; }
        </style>
    </head>
    <body>
        <div class="loader"></div>
        <p>Completing login...</p>
        <span class="sub">This tab will close automatically.</span>
    </body>
    </html>
    """

app.include_router(api_router)
app.include_router(share.public_router)
app.include_router(privacy.router)
app.include_router(home.router)


@app.get("/sitemap.xml", include_in_schema=False)
def sitemap():
    path = os.path.join(os.path.dirname(__file__), "static", "sitemap.xml")
    return FileResponse(path, media_type="application/xml")


@app.get("/robots.txt", include_in_schema=False)
def robots():
    path = os.path.join(os.path.dirname(__file__), "static", "robots.txt")
    return FileResponse(path, media_type="text/plain")

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
