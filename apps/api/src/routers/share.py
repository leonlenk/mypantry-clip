"""
Recipe sharing endpoints.

POST /api/share  — Authenticated. Accepts a batch of recipe objects, strips
                   personal data (tags, embedding), stores them ALL in a single
                   shared_recipes row, and returns one URL for the whole batch.

GET  /s/{id}     — Public (no auth). Serves either:
                     - A single full recipe card  (1 recipe in the batch)
                     - A "mini pantry" grid view  (2+ recipes in the batch)
                   Both views include a "Save to MyPantry Clip" button wired to the
                   extension's content script via window.postMessage.
"""

import json as _json
import re
import secrets
import traceback
from datetime import datetime, timezone, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, field_validator
from loguru import logger

from src.dependencies.auth import verify_jwt
from src.dependencies.rate_limit import check_public_rate_limit, check_rate_limit_and_telemetry
from src.services.supabase_client import get_supabase_client
from src.config import settings

api_router = APIRouter(prefix="/share", tags=["share"])
public_router = APIRouter(tags=["share-public"])

TABLE = "shared_recipes"


# ---------------------------------------------------------------------------
# Request model
# ---------------------------------------------------------------------------

class ShareRecipesRequest(BaseModel):
    recipes: list[dict[str, Any]]

    @field_validator("recipes")
    @classmethod
    def recipes_not_empty(cls, v: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not v:
            raise ValueError("No recipes provided.")
        return v


# ---------------------------------------------------------------------------
# Helpers — IDs and cleaning
# ---------------------------------------------------------------------------

def _short_id() -> str:
    return secrets.token_urlsafe(6)   # 8-char URL-safe base64url string


def _clean_recipe(recipe: dict[str, Any]) -> dict[str, Any]:
    """Strip embedding and tags — never store personal metadata in shared rows."""
    return {k: v for k, v in recipe.items() if k not in ("embedding", "tags")}


# ---------------------------------------------------------------------------
# Helpers — ingredient formatting (mirrors conversions.ts logic)
# ---------------------------------------------------------------------------

_FRACS = [
    (1 / 8, "1/8"), (1 / 4, "1/4"), (1 / 3, "1/3"), (3 / 8, "3/8"),
    (1 / 2, "1/2"), (5 / 8, "5/8"), (2 / 3, "2/3"), (3 / 4, "3/4"),
    (7 / 8, "7/8"),
]


def _decimal_to_fraction(q: float) -> str:
    """Convert a decimal to a human-friendly fraction string (e.g. 1.5 → '1 1/2')."""
    if q <= 0:
        return "0"
    whole = int(q)
    frac = q - whole
    if frac < 0.05:
        return str(whole) if whole else "0"
    best_val, best_text = min(_FRACS, key=lambda f: abs(f[0] - frac))
    if abs(1 - frac) < abs(best_val - frac):
        return str(whole + 1)
    if frac < abs(best_val - frac):
        return str(whole) if whole else "0"
    if abs(best_val - frac) > 0.05:
        return str(round(q, 2))
    return f"{whole} {best_text}" if whole else best_text


def _format_ingredient_text(ing: dict[str, Any]) -> str:
    """
    Format an ingredient dict as a readable string with fraction amounts.
    Prefers parsed fields (us_amount, us_unit, item) over rawText so that
    decimals like 5.5 are displayed as '5 1/2' rather than the raw float.
    Falls back to rawText when parsed fields are unavailable.
    """
    item = (ing.get("item") or "").strip()
    raw = (ing.get("rawText") or "").strip()
    if not item:
        return raw  # no parsed data — show original text as-is

    us_amount = ing.get("us_amount")
    us_unit = (ing.get("us_unit") or "").strip()
    preparation = (ing.get("preparation") or "").strip()

    parts: list[str] = []
    if us_amount is not None:
        try:
            parts.append(_decimal_to_fraction(float(us_amount)))
        except (TypeError, ValueError):
            pass
    if us_unit:
        parts.append(us_unit)
    parts.append(item)
    result = " ".join(parts)
    if preparation:
        result += f", {preparation}"
    return result or raw


# ---------------------------------------------------------------------------
# Helpers — HTML fragments
# ---------------------------------------------------------------------------

def _upgrade_image_url(url: str) -> str:
    """Attempt to get a higher-resolution version of common CDN image URLs.

    WordPress: strips the dimension suffix added during media resizing so the
    original full-size upload is used instead of a thumbnail.
      e.g. /image-700x467.jpg  →  /image.jpg
           /image-1024x683.webp →  /image.webp
    """
    # WordPress dimension suffix: -WIDTHxHEIGHT before the file extension
    return re.sub(r"-\d{2,5}x\d{2,5}(\.[a-zA-Z0-9]{2,5})$", r"\1", url)


def _safe_image_url(url: str) -> str | None:
    """Return the URL only if it is a safe absolute https:// URL; else None."""
    if not url or not isinstance(url, str):
        return None
    stripped = url.strip()
    if stripped.startswith("https://"):
        return _upgrade_image_url(stripped)
    return None


def _esc(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#x27;")
    )


def _format_time(minutes: int | None) -> str | None:
    if not minutes:
        return None
    h, m = divmod(int(minutes), 60)
    if h and m:
        return f"{h}h {m}min"
    return f"{h}h" if h else f"{m} min"


def _time_chips_html(recipe: dict[str, Any]) -> str:
    pairs = [("Prep", _format_time(recipe.get("prepTimeMinutes"))),
             ("Cook", _format_time(recipe.get("cookTimeMinutes"))),
             ("Total", _format_time(recipe.get("totalTimeMinutes")))]
    chips = "".join(
        f'<div class="chip"><span class="chip-label">{label}</span>'
        f'<span class="chip-value">{val}</span></div>'
        for label, val in pairs if val
    )
    return f'<div class="chips">{chips}</div>' if chips else ""


def _ingredients_html(ingredients: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    cur_group: str | None = None
    for ing in ingredients:
        grp = ing.get("group")
        if grp and grp != cur_group:
            cur_group = grp
            parts.append(f'<li class="ing-group-header">{_esc(grp)}</li>')
        main = _esc(_format_ingredient_text(ing))
        subtext = (ing.get("subtext") or "").strip()
        if subtext:
            parts.append(
                f'<li>{main}<span class="ing-subtext">{_esc(subtext)}</span></li>'
            )
        else:
            parts.append(f"<li>{main}</li>")
    return "\n".join(parts)


def _instructions_html(instructions: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    cur_group: str | None = None
    for step in instructions:
        grp = step.get("group")
        if grp and grp != cur_group:
            cur_group = grp
            parts.append(f'<li class="inst-group-header">{_esc(grp)}</li>')
        parts.append(f"<li>{_esc(step.get('text', ''))}</li>")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Page shell — shared chrome (nav, fonts, base CSS)
# ---------------------------------------------------------------------------

_FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,600;0,700;1,400&family=Quicksand:wght@400;500;600;700&display=swap" rel="stylesheet">'

_BASE_CSS = """
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Quicksand', sans-serif; background: #FDFBF7; color: #4A4036; line-height: 1.7; }
a { color: #E5B299; text-decoration: none; }
a:hover { text-decoration: underline; }
nav { display: flex; align-items: center; justify-content: space-between; padding: 1rem 2rem; border-bottom: 1px solid #E8E3D9; background: #FDFBF7; position: sticky; top: 0; z-index: 10; }
.nav-logo { font-family: 'Fraunces', serif; font-size: 1.25rem; color: #4A4036; font-weight: 700; text-decoration: none; }
.nav-logo:hover { text-decoration: none; }
footer { text-align: center; padding: 2rem; font-size: 0.8rem; color: #8C7F70; border-top: 1px solid #E8E3D9; }
.chips { display: flex; flex-wrap: wrap; gap: .6rem; margin: .75rem 0; }
.chip { background: #F4EFE6; border-radius: 8px; padding: .35rem .75rem; display: flex; flex-direction: column; align-items: center; min-width: 60px; }
.chip-label { font-size: .65rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #8C7F70; }
.chip-value { font-size: .9rem; font-weight: 700; color: #4A4036; }
.save-btn { display: inline-flex; align-items: center; gap: .4rem; background: #E5B299; color: #fff; border: none; border-radius: 8px; padding: .55rem 1.25rem; font-family: 'Quicksand', sans-serif; font-size: .95rem; font-weight: 700; cursor: pointer; transition: background .15s, opacity .15s; white-space: nowrap; }
.save-btn:hover { background: #d99e82; }
.save-btn:disabled { opacity: .6; cursor: not-allowed; }
.save-btn.saved { background: #10B981; }
.install-prompt { display: none; font-size: .78rem; color: #8C7F70; margin-top: .35rem; text-align: right; }
"""


def _page_shell(
    title: str,
    body: str,
    embedded_json: str,
    nav_right: str,
    extra_css: str,
    js: str,
    expiry_days: int,
    description: str = "",
    og_image: str = "",
    share_id: str = "",
) -> str:
    canonical = f"https://mypantry.dev/s/{share_id}" if share_id else "https://mypantry.dev/"
    desc_tag = f'<meta name="description" content="{_esc(description)}">' if description else ""
    og_image_abs = og_image if og_image.startswith("http") else "https://mypantry.dev/static/pantry_preview.png"
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>{_esc(title)} | MyPantry Clip</title>
  <link rel="canonical" href="{canonical}">
  {desc_tag}
  <meta property="og:title" content="{_esc(title)} | MyPantry Clip">
  <meta property="og:description" content="{_esc(description) if description else 'A recipe shared via MyPantry.'}">
  <meta property="og:url" content="{canonical}">
  <meta property="og:image" content="{og_image_abs}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="MyPantry">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{_esc(title)} | MyPantry Clip">
  <meta name="twitter:image" content="{og_image_abs}">
  {_FONTS}
  <style>{_BASE_CSS}{extra_css}</style>
  <script type="application/json" id="recipe-data">{embedded_json}</script>
</head>
<body>
  <nav>
    <a class="nav-logo" href="https://mypantry.dev">MyPantry</a>
    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:.25rem">
      {nav_right}
      <p class="install-prompt" id="install-prompt">
        Don&rsquo;t have MyPantry?
        <a href="https://chromewebstore.google.com/detail/mypantry/{settings.extension_id}" target="_blank" rel="noopener">Install &rarr;</a>
      </p>
    </div>
  </nav>
  {body}
  <footer>
    Shared via <a href="https://mypantry.dev">MyPantry</a>
    &middot; Links expire in {expiry_days} days
  </footer>
  <script>{js}</script>
</body>
</html>"""


# ---------------------------------------------------------------------------
# Single recipe page
# ---------------------------------------------------------------------------

_SINGLE_CSS = """
.page { max-width: 740px; margin: 0 auto; padding: 2rem 1.5rem 4rem; }
.hero-img { margin: 0 -1.5rem 2rem; overflow: hidden; aspect-ratio: 16/9; max-height: 420px; }
.hero-img img { width: 100%; height: 100%; object-fit: cover; object-position: center; display: block; }
h1 { font-family: 'Fraunces', serif; font-size: 2.1rem; line-height: 1.2; margin-bottom: .5rem; }
.desc { color: #8C7F70; font-size: 1.05rem; margin-bottom: .75rem; }
.meta { color: #8C7F70; font-size: .875rem; margin-bottom: .5rem; }
.servings { font-size: .9rem; color: #8C7F70; margin-top: .25rem; }
section { margin-top: 2rem; }
h2 { font-family: 'Fraunces', serif; font-size: 1.3rem; margin-bottom: .9rem; padding-bottom: .4rem; border-bottom: 2px solid #E8E3D9; }
.ingredients ul { list-style: none; }
.ingredients li { padding: .45rem 0; border-bottom: 1px solid #F4EFE6; font-size: .975rem; display: flex; flex-direction: column; gap: 2px; }
.ingredients li:last-child { border-bottom: none; }
.ing-group-header { font-weight: 700 !important; color: #8C7F70 !important; font-size: .78rem !important; text-transform: uppercase; letter-spacing: .05em; border-bottom: none !important; }
.ing-subtext { font-size: .82rem; color: #8C7F70; font-style: italic; }
.instructions ol { list-style: none; counter-reset: step; }
.instructions li { counter-increment: step; padding: .85rem 0 .85rem 3.25rem; border-bottom: 1px solid #F4EFE6; position: relative; font-size: .975rem; }
.instructions li:last-child { border-bottom: none; }
.instructions li::before { content: counter(step); position: absolute; left: 0; top: .85rem; width: 2rem; height: 2rem; background: #E5B299; color: #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: .78rem; font-weight: 700; }
.inst-group-header { font-weight: 700; color: #8C7F70; font-size: .78rem; text-transform: uppercase; padding-left: 0 !important; border-bottom: none !important; }
.inst-group-header::before { display: none !important; }
.notes ul { list-style: disc; padding-left: 1.5rem; }
.notes li { padding: .3rem 0; font-size: .9rem; color: #8C7F70; }
@media (max-width: 600px) { h1 { font-size: 1.6rem; } .page { padding: 1.5rem 1rem 3rem; } .hero-img { margin: 0 -1rem 1.5rem; } }
"""


def _render_single_recipe_page(recipe: dict[str, Any], expiry_days: int, share_id: str = "") -> str:
    title = recipe.get("title", "Untitled Recipe")
    description = recipe.get("semantic_summary", "")
    author = recipe.get("author", "")
    image = _safe_image_url(recipe.get("image", ""))
    servings = recipe.get("servings")
    yield_text = recipe.get("yield", "")
    source_url = recipe.get("url", "")
    ingredients: list = recipe.get("ingredients", [])
    instructions: list = recipe.get("instructions", [])
    notes: list = recipe.get("notes", [])

    image_html = (
        f'<div class="hero-img"><img src="{_esc(image)}" alt="{_esc(title)}" loading="lazy"></div>'
        if image else ""
    )

    meta_parts = []
    if author:
        meta_parts.append(f"By {_esc(author)}")
    if source_url:
        meta_parts.append(f'<a href="{_esc(source_url)}" target="_blank" rel="noopener">View original</a>')
    meta_html = f'<p class="meta">{" &middot; ".join(meta_parts)}</p>' if meta_parts else ""

    servings_html = ""
    if yield_text:
        servings_html = f'<p class="servings">Yield: {_esc(str(yield_text))}</p>'
    elif servings:
        servings_html = f'<p class="servings">Servings: {_esc(str(servings))}</p>'

    notes_html = ""
    if notes:
        items = "".join(f"<li>{_esc(n)}</li>" for n in notes)
        notes_html = f'<section class="notes"><h2>Notes</h2><ul>{items}</ul></section>'

    # Embed just this single recipe as an array for consistent JS handling
    embedded = _json.dumps([recipe])

    nav_right = (
        '<button class="save-btn" id="save-btn">'
        '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>'
        'Save to MyPantry Clip</button>'
    )

    body = f"""<main class="page">
    {image_html}
    <header style="margin-bottom:1.5rem">
      <h1>{_esc(title)}</h1>
      {"<p class='desc'>" + _esc(description) + "</p>" if description else ""}
      {meta_html}
    </header>
    {_time_chips_html(recipe)}
    {servings_html}
    <section class="ingredients"><h2>Ingredients</h2><ul>{_ingredients_html(ingredients)}</ul></section>
    <section class="instructions"><h2>Instructions</h2><ol>{_instructions_html(instructions)}</ol></section>
    {notes_html}
  </main>"""

    js = _save_js(single=True)

    return _page_shell(title, body, embedded, nav_right, _SINGLE_CSS, js, expiry_days,
                       description=description, og_image=image, share_id=share_id)


# ---------------------------------------------------------------------------
# Mini-pantry page (2+ recipes)
# ---------------------------------------------------------------------------

_PANTRY_CSS = """
.pantry-header { max-width: 960px; margin: 2rem auto 0; padding: 0 1.5rem 1.5rem; border-bottom: 1px solid #E8E3D9; }
.pantry-header h1 { font-family: 'Fraunces', serif; font-size: 1.8rem; margin-bottom: .4rem; }
.pantry-header p { color: #8C7F70; font-size: .9rem; }
.recipe-grid { max-width: 960px; margin: 0 auto; padding: 2rem 1.5rem 4rem; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1.25rem; align-content: start; }
.recipe-card { background: #F4EFE6; border: 1px solid #E8E3D9; border-radius: 16px; overflow: hidden; display: flex; flex-direction: column; transition: box-shadow .15s, transform .15s; }
.recipe-card:hover { box-shadow: 0 8px 24px rgba(74,64,54,.12); transform: translateY(-2px); }
.card-img { height: 160px; overflow: hidden; background: #E8E3D9; }
.card-img img { width: 100%; height: 100%; object-fit: cover; object-position: center; display: block; }
.card-img-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: #8C7F70; font-size: 2.5rem; }
.card-body { padding: 1rem 1.1rem 1.1rem; display: flex; flex-direction: column; gap: .5rem; flex: 1; }
.card-title { font-family: 'Fraunces', serif; font-size: 1.1rem; line-height: 1.3; color: #4A4036; }
.card-desc { font-size: .83rem; color: #8C7F70; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.card-meta { font-size: .8rem; color: #8C7F70; }
.card-save-btn { margin-top: auto; width: 100%; justify-content: center; border-radius: 10px; padding: .5rem 1rem; font-size: .88rem; }
.save-all-btn { background: #E5B299; color: #fff; border: none; border-radius: 8px; padding: .55rem 1.25rem; font-family: 'Quicksand', sans-serif; font-size: .9rem; font-weight: 700; cursor: pointer; transition: background .15s; white-space: nowrap; }
.save-all-btn:hover { background: #d99e82; }
.save-all-btn:disabled { opacity: .6; cursor: not-allowed; }
.save-all-btn.saved { background: #10B981; }
@media (max-width: 600px) { .recipe-grid { padding: 1.25rem 1rem 3rem; gap: 1rem; } }
"""


def _render_mini_card(recipe: dict[str, Any], index: int) -> str:
    title = recipe.get("title", "Untitled")
    description = recipe.get("semantic_summary", "")
    image = _safe_image_url(recipe.get("image", ""))
    ingredients: list = recipe.get("ingredients", [])

    if image:
        img_html = f'<div class="card-img"><img src="{_esc(image)}" alt="{_esc(title)}" loading="lazy"></div>'
    else:
        img_html = '<div class="card-img"><div class="card-img-placeholder">🍽</div></div>'

    chips_html = _time_chips_html(recipe)
    ing_count = len(ingredients)
    meta_html = f'<p class="card-meta">{ing_count} ingredient{"s" if ing_count != 1 else ""}</p>' if ing_count else ""

    return f"""<div class="recipe-card">
  {img_html}
  <div class="card-body">
    <h2 class="card-title">{_esc(title)}</h2>
    {"<p class='card-desc'>" + _esc(description) + "</p>" if description else ""}
    {chips_html}
    {meta_html}
    <button class="save-btn card-save-btn" id="save-btn-{index}" data-index="{index}">
      Save to MyPantry Clip
    </button>
  </div>
</div>"""


def _render_mini_pantry_page(recipes: list[dict[str, Any]], expiry_days: int, share_id: str = "") -> str:
    n = len(recipes)
    title = f"{n} recipes shared"
    embedded = _json.dumps(recipes)

    cards = "\n".join(_render_mini_card(r, i) for i, r in enumerate(recipes))

    nav_right = (
        f'<button class="save-all-btn" id="save-all-btn">'
        f'Save All ({n})</button>'
    )

    body = f"""<div class="pantry-header">
    <h1>{_esc(title)}</h1>
    <p>Shared via MyPantry</p>
  </div>
  <div class="recipe-grid">{cards}</div>"""

    js = _save_js(single=False)

    description = f"{n} recipes shared via MyPantry."
    return _page_shell(title, body, embedded, nav_right, _PANTRY_CSS, js, expiry_days,
                       description=description, share_id=share_id)


# ---------------------------------------------------------------------------
# Shared JavaScript (handles extension detection + save flow)
# ---------------------------------------------------------------------------

def _save_js(single: bool) -> str:
    """
    JavaScript embedded in each share page.
    `single`: True for the single-recipe view, False for the mini-pantry view.

    Features:
    - Detects extension via #__mypantry_installed marker
    - Persists saved indices to localStorage so already-saved recipes stay
      marked after a page refresh (keyed by share ID + recipe index)
    - For multi-recipe pages: tracks unsaved count and keeps Save All updated
    """
    store_url = f"https://chromewebstore.google.com/detail/mypantry/{settings.extension_id}"
    if single:
        return _save_js_single().replace("__STORE_URL__", store_url)
    return _save_js_multi().replace("__STORE_URL__", store_url)


def _save_js_single() -> str:
    """Save button JS for the single-recipe view."""
    return """(function () {
  var recipes = null;
  try { recipes = JSON.parse(document.getElementById('recipe-data').textContent); } catch (e) {}
  if (!Array.isArray(recipes)) return;

  var installPrompt = document.getElementById('install-prompt');

  // ── Saved-state persistence ───────────────────────────────────────────────
  var shareId = window.location.pathname.split('/').pop() || 'share';
  var STORAGE_KEY = 'mypantry_saved:' + shareId;

  function isSaved() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]').indexOf(0) !== -1; } catch { return false; }
  }
  function markPersistedSaved() {
    try {
      var arr = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (arr.indexOf(0) === -1) { arr.push(0); localStorage.setItem(STORAGE_KEY, JSON.stringify(arr)); }
    } catch {}
  }

  function setSavedUI() {
    var btn = document.getElementById('save-btn');
    if (!btn) return;
    btn.textContent = 'Saved!';
    btn.classList.add('saved');
    btn.disabled = true;
  }

  // ── Apply saved state immediately (no delay) to prevent flash ────────────
  if (isSaved()) { setSavedUI(); return; }

  // ── Wait for content script to inject the extension marker ────────────────
  function _initSaveButton(hasExtension) {
    if (!hasExtension) {
      if (installPrompt) installPrompt.style.display = 'block';
      var btn = document.getElementById('save-btn');
      if (btn) btn.addEventListener('click', function () {
        window.open('__STORE_URL__', '_blank');
      });
      return;
    }

    var saveBtn = document.getElementById('save-btn');
    if (!saveBtn) return;
    saveBtn.addEventListener('click', function () {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving\u2026';
      window.postMessage({ type: 'MYPANTRY_SAVE_RECIPE', recipes: recipes }, '*');
    });

    window.addEventListener('message', function (event) {
      if (event.origin !== window.location.origin) return;
      if (!event.data || event.data.type !== 'MYPANTRY_SAVE_RESULT') return;
      if (event.data.success) {
        markPersistedSaved();
        setSavedUI();
      } else {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save to MyPantry Clip';
      }
    });
  }

  if (document.getElementById('__mypantry_installed')) {
    _initSaveButton(true);
  } else {
    var _obs = new MutationObserver(function (_, obs) {
      if (document.getElementById('__mypantry_installed')) {
        obs.disconnect();
        clearTimeout(_fallback);
        _initSaveButton(true);
      }
    });
    _obs.observe(document.documentElement, { childList: true, subtree: true });
    var _fallback = setTimeout(function () { _obs.disconnect(); _initSaveButton(false); }, 1500);
  }
})();"""


def _save_js_multi() -> str:
    """Save button JS for the mini-pantry (multi-recipe) view."""
    return """(function () {
  var recipes = null;
  try { recipes = JSON.parse(document.getElementById('recipe-data').textContent); } catch (e) {}
  if (!Array.isArray(recipes)) return;

  var installPrompt = document.getElementById('install-prompt');
  var _pending = null; // { indices: number[] } for current in-flight save

  // ── Saved-state persistence ───────────────────────────────────────────────
  var shareId = window.location.pathname.split('/').pop() || 'share';
  var STORAGE_KEY = 'mypantry_saved:' + shareId;

  function getSavedSet() {
    try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')); } catch { return new Set(); }
  }
  function persistSavedIndices(indices) {
    var s = getSavedSet();
    indices.forEach(function (i) { s.add(i); });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(s)));
  }

  // ── Save All button ───────────────────────────────────────────────────────
  function updateSaveAllBtn() {
    var saved = getSavedSet();
    var remaining = recipes.length - saved.size;
    var btn = document.getElementById('save-all-btn');
    if (!btn) return;
    if (remaining <= 0) {
      btn.textContent = 'All Saved!';
      btn.classList.add('saved');
      btn.disabled = true;
    } else {
      btn.textContent = 'Save All (' + remaining + ')';
      btn.disabled = false;
      btn.classList.remove('saved');
    }
  }

  // ── Card button helpers ───────────────────────────────────────────────────
  function markCardSaved(idx) {
    var btn = document.getElementById('save-btn-' + idx);
    if (!btn) return;
    btn.textContent = 'Saved!';
    btn.classList.add('saved');
    btn.disabled = true;
  }

  function markCardFailed(idx) {
    var btn = document.getElementById('save-btn-' + idx);
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = 'Save to MyPantry Clip';
  }

  // ── Result listener ───────────────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    if (event.origin !== window.location.origin) return;
    if (!event.data || event.data.type !== 'MYPANTRY_SAVE_RESULT') return;
    var p = _pending;
    _pending = null;
    if (!p) return;
    if (event.data.success) {
      persistSavedIndices(p.indices);
      p.indices.forEach(function (i) { markCardSaved(i); });
      updateSaveAllBtn();
    } else {
      p.indices.forEach(function (i) { markCardFailed(i); });
      updateSaveAllBtn();
    }
  });

  // ── Apply saved state immediately (no delay) to prevent flash ────────────
  var initialSaved = getSavedSet();
  if (initialSaved.size > 0) {
    initialSaved.forEach(function (idx) { markCardSaved(idx); });
    updateSaveAllBtn();
  }

  // ── Wait for content script to inject the extension marker ────────────────
  function _initSaveButtons(hasExtension) {
    if (!hasExtension) {
      if (installPrompt) installPrompt.style.display = 'block';
      document.querySelectorAll('.save-btn, .save-all-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          window.open('__STORE_URL__', '_blank');
        });
      });
      return;
    }

    var savedSet = getSavedSet();

    document.querySelectorAll('.card-save-btn').forEach(function (btn) {
      var idx = parseInt(btn.dataset.index, 10);
      if (savedSet.has(idx)) {
        // Already marked saved above — just skip wiring the click handler
      } else {
        btn.addEventListener('click', function () {
          btn.disabled = true;
          btn.textContent = 'Saving\u2026';
          _pending = { indices: [idx] };
          window.postMessage({ type: 'MYPANTRY_SAVE_RECIPE', recipes: [recipes[idx]] }, '*');
        });
      }
    });

    // ── Save All button: only sends unsaved recipes ────────────────────────
    updateSaveAllBtn();
    var saveAllBtn = document.getElementById('save-all-btn');
    if (saveAllBtn) {
      saveAllBtn.addEventListener('click', function () {
        var currentlySaved = getSavedSet();
        var unsavedIndices = recipes.map(function (_, i) { return i; })
                                    .filter(function (i) { return !currentlySaved.has(i); });
        if (unsavedIndices.length === 0) return;

        // Disable all unsaved card buttons while saving
        unsavedIndices.forEach(function (i) {
          var b = document.getElementById('save-btn-' + i);
          if (b) { b.disabled = true; b.textContent = 'Saving\u2026'; }
        });
        saveAllBtn.disabled = true;
        saveAllBtn.textContent = 'Saving\u2026';

        _pending = { indices: unsavedIndices };
        var toSave = unsavedIndices.map(function (i) { return recipes[i]; });
        window.postMessage({ type: 'MYPANTRY_SAVE_RECIPE', recipes: toSave }, '*');
      });
    }
  }

  if (document.getElementById('__mypantry_installed')) {
    _initSaveButtons(true);
  } else {
    var _obs = new MutationObserver(function (_, obs) {
      if (document.getElementById('__mypantry_installed')) {
        obs.disconnect();
        clearTimeout(_fallback);
        _initSaveButtons(true);
      }
    });
    _obs.observe(document.documentElement, { childList: true, subtree: true });
    var _fallback = setTimeout(function () { _obs.disconnect(); _initSaveButtons(false); }, 1500);
  }
})();"""


# ---------------------------------------------------------------------------
# 404 page
# ---------------------------------------------------------------------------

def _render_404() -> str:
    return """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Recipe Not Found | MyPantry Clip</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,700;1,400&family=Quicksand:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Quicksand', sans-serif; background: #FDFBF7; color: #4A4036; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem; text-align: center; }
    .logo { font-family: 'Fraunces', serif; font-size: 1.25rem; color: #E5B299; margin-bottom: 2rem; }
    h1 { font-family: 'Fraunces', serif; font-size: 2rem; margin-bottom: .75rem; }
    p { color: #8C7F70; font-size: 1.05rem; line-height: 1.6; }
    a { color: #E5B299; font-weight: 600; }
  </style>
</head>
<body>
  <div class="logo">MyPantry</div>
  <h1>Recipe not found</h1>
  <p>This link may have expired or been removed.<br>Shared recipes are available for 30 days.</p>
  <p style="margin-top:1.5rem"><a href="https://mypantry.dev">Go to MyPantry &rarr;</a></p>
</body>
</html>"""


# ---------------------------------------------------------------------------
# POST /api/share  (authenticated)
# ---------------------------------------------------------------------------

@api_router.post("")
def share_recipes(
    request: ShareRecipesRequest,
    user_id: str = Depends(verify_jwt),
):
    """
    Create a single shareable link for a batch of recipes.
    All recipes are stored together in one row; tags and embeddings are stripped.
    Returns one URL regardless of how many recipes are in the batch.
    """
    check_rate_limit_and_telemetry(user_id=user_id, endpoint="share", daily_limit=settings.share_daily_limit, weekly_limit=settings.share_weekly_limit)

    share_id = _short_id()
    expiry_days = settings.share_expiry_days
    expires_at = (
        datetime.now(timezone.utc) + timedelta(days=expiry_days)
    ).isoformat()

    cleaned = [_clean_recipe(r) for r in request.recipes]

    try:
        client = get_supabase_client()
        client.table(TABLE).insert({
            "id": share_id,
            "user_id": user_id,
            "recipe_json": cleaned,   # always an array, even for a single recipe
            "expires_at": expires_at,
        }).execute()
        logger.info(
            f"[Share] User {user_id} shared {len(cleaned)} recipe(s) → id={share_id}"
        )
    except Exception as e:
        logger.error(f"[Share] Insert failed: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail="Failed to create share link.")

    base_url = settings.public_base_url.rstrip("/")
    return {"url": f"{base_url}/s/{share_id}"}


# ---------------------------------------------------------------------------
# GET /s/{id}  (public)
# ---------------------------------------------------------------------------

@public_router.get("/s/{share_id}", response_class=HTMLResponse)
def view_shared_recipe(share_id: str, request: Request):
    check_public_rate_limit(
        request,
        endpoint="share_view",
        daily_limit=settings.share_daily_limit,
        weekly_limit=settings.share_weekly_limit,
    )
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        client = get_supabase_client()
        result = (
            client.table(TABLE)
            .select("recipe_json, expires_at")
            .eq("id", share_id)
            .gt("expires_at", now_iso)
            .limit(1)
            .execute()
        )
    except Exception as e:
        logger.error(f"[Share] DB read failed for id={share_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch recipe.")

    rows = result.data or []
    if not rows:
        return HTMLResponse(content=_render_404(), status_code=404)

    recipes: list[dict[str, Any]] = rows[0]["recipe_json"]
    expiry_days = settings.share_expiry_days

    if len(recipes) == 1:
        return HTMLResponse(content=_render_single_recipe_page(recipes[0], expiry_days, share_id=share_id))
    return HTMLResponse(content=_render_mini_pantry_page(recipes, expiry_days, share_id=share_id))
