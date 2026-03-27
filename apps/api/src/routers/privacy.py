from fastapi import APIRouter
from fastapi.responses import HTMLResponse

# Public endpoint — no auth required.
# The privacy policy must be freely accessible (required for Chrome Web Store listing).
router = APIRouter(tags=["legal"])

_PRIVACY_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Privacy Policy – MyPantry Clip</title>
    <meta name="description" content="MyPantry is designed privacy-first. Your recipe data lives on your device by default. We never sell your data, run ads, or track your browsing.">
    <link rel="canonical" href="https://mypantry.dev/privacy">
    <meta name="theme-color" content="#4A4036">
    <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
    <link rel="icon" type="image/x-icon" sizes="32x32" href="/static/favicon.ico">
    <link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
    <meta property="og:title" content="Privacy Policy – MyPantry Clip">
    <meta property="og:description" content="MyPantry is designed privacy-first. Your recipe data lives on your device by default. We never sell your data, run ads, or track your browsing.">
    <meta property="og:url" content="https://mypantry.dev/privacy">
    <meta property="og:image" content="https://mypantry.dev/static/pantry_preview.png">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="MyPantry">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;1,9..144,400&family=Quicksand:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        /* --- Brand tokens (from architecture.md) --- */
        :root {
            --color-accent:     #E5B299;
            --color-primary:    #4A4036;
            --color-secondary:  #8C7F70;
            --color-tertiary:   #C4B7A6;
            --color-border:     #E8E3D9;
            --color-bg:         #FDFBF7;
            --color-surface:    #F4EFE6;
        }

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: 'Quicksand', sans-serif;
            background-color: var(--color-bg);
            color: var(--color-primary);
            line-height: 1.75;
            padding: 2rem 1rem;
        }

        .wrapper {
            max-width: 780px;
            margin: 0 auto;
        }

        /* Top bar */
        .site-header {
            display: flex;
            align-items: center;
            gap: 0.6rem;
            margin-bottom: 3rem;
            padding-bottom: 1.25rem;
            border-bottom: 1px solid var(--color-border);
        }
        .site-header .logo-mark {
            width: 32px;
            height: 32px;
            background: var(--color-accent);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .site-header .logo-mark svg { color: #fff; }
        .site-header .brand {
            font-family: 'Fraunces', serif;
            font-size: 1.2rem;
            font-weight: 600;
            color: var(--color-primary);
            text-decoration: none;
        }
        .site-header .pill {
            margin-left: auto;
            font-size: 0.75rem;
            font-weight: 600;
            color: var(--color-secondary);
            background: var(--color-surface);
            border: 1px solid var(--color-border);
            border-radius: 99px;
            padding: 0.2rem 0.7rem;
            letter-spacing: 0.04em;
            text-transform: uppercase;
        }

        /* Hero */
        .hero { margin-bottom: 2.5rem; }
        .hero h1 {
            font-family: 'Fraunces', serif;
            font-size: clamp(2rem, 5vw, 2.8rem);
            font-weight: 600;
            line-height: 1.2;
            margin-bottom: 0.6rem;
        }
        .hero .meta {
            font-size: 0.9rem;
            color: var(--color-secondary);
        }

        /* Intro card */
        .intro-card {
            background: var(--color-surface);
            border: 1px solid var(--color-border);
            border-left: 4px solid var(--color-accent);
            border-radius: 10px;
            padding: 1.25rem 1.5rem;
            margin-bottom: 2.5rem;
            font-size: 0.95rem;
            color: var(--color-secondary);
        }

        /* Sections */
        section { margin-bottom: 2.5rem; }

        h2 {
            font-family: 'Fraunces', serif;
            font-size: 1.25rem;
            font-weight: 600;
            margin-bottom: 0.75rem;
            padding-bottom: 0.4rem;
            border-bottom: 1px solid var(--color-border);
        }

        p { margin-bottom: 0.9rem; font-size: 0.95rem; color: var(--color-secondary); }
        p:last-child { margin-bottom: 0; }

        ul {
            margin: 0.5rem 0 0.9rem 1.25rem;
            font-size: 0.95rem;
            color: var(--color-secondary);
        }
        ul li { margin-bottom: 0.4rem; }

        /* Inline tags */
        .tag {
            display: inline-block;
            font-size: 0.72rem;
            font-weight: 600;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            border-radius: 4px;
            padding: 0.1rem 0.45rem;
            vertical-align: middle;
            margin-left: 0.3rem;
        }
        .tag-local { background: #d4f0d4; color: #2a6a2a; }
        .tag-cloud { background: #dde8f5; color: #234a80; }
        .tag-never  { background: #fde8e8; color: #8a1f1f; }

        /* Data table */
        .data-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.9rem;
            margin-bottom: 0.9rem;
        }
        .data-table th {
            text-align: left;
            padding: 0.55rem 0.75rem;
            background: var(--color-surface);
            border: 1px solid var(--color-border);
            color: var(--color-primary);
            font-weight: 600;
        }
        .data-table td {
            padding: 0.55rem 0.75rem;
            border: 1px solid var(--color-border);
            color: var(--color-secondary);
            vertical-align: top;
        }
        .data-table tr:hover td { background: var(--color-surface); }

        /* Footer */
        footer {
            margin-top: 3rem;
            padding-top: 1.25rem;
            border-top: 1px solid var(--color-border);
            font-size: 0.82rem;
            color: var(--color-tertiary);
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem;
            justify-content: space-between;
        }
        footer a { color: var(--color-accent); text-decoration: none; }
        footer a:hover { text-decoration: underline; }
    </style>
</head>
<body>
<div class="wrapper">

    <!-- Header -->
    <header class="site-header">
        <div class="logo-mark" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
                 fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 11l19-9-9 19-2-8-8-2z"/>
            </svg>
        </div>
        <a href="https://mypantry.dev" class="brand">MyPantry Clip</a>
        <span class="pill">Legal</span>
    </header>

    <!-- Hero -->
    <div class="hero">
        <h1>Privacy Policy</h1>
        <p class="meta">Effective date: March 5, 2026 &nbsp;·&nbsp; Domain: mypantry.dev</p>
    </div>

    <!-- TL;DR -->
    <div class="intro-card">
        <strong>Short version:</strong> MyPantry Clip is designed privacy-first. Your recipe data lives on <em>your device</em>
        by default. We never sell your data, run ads, or track your browsing. Cloud sync is opt-in and secured
        end-to-end by Supabase Auth. Your LLM API key is encrypted locally and is never transmitted to our servers.
    </div>

    <!-- 1. Operator -->
    <section id="operator">
        <h2>1. Who We Are</h2>
        <p>
            MyPantry ("<strong>we</strong>", "<strong>us</strong>", or "<strong>our</strong>") is the operator of the
            MyPantry browser extension ("MyPantry Clip") and the cloud synchronisation API hosted at
            <code>mypantry.dev</code>. For questions about this policy, contact us at
            <a href="mailto:support@mypantry.dev" style="color:var(--color-accent)">support@mypantry.dev</a>.
        </p>
    </section>

    <!-- 2. Scope -->
    <section id="scope">
        <h2>2. What This Policy Covers</h2>
        <p>This policy applies to:</p>
        <ul>
            <li>The <strong>MyPantry Clip</strong> Chrome extension (the "Extension").</li>
            <li>The <strong>MyPantry Cloud API</strong> at <code>https://mypantry.dev</code> (the "Service").</li>
            <li>Any authentication flows conducted via Supabase (Google OAuth / Email OTP).</li>
        </ul>
        <p>It does <em>not</em> apply to third-party services you may connect (e.g., Google, Anthropic, or OpenAI) —
        their own privacy policies govern your use of those services.</p>
    </section>

    <!-- 3. Data we collect -->
    <section id="data-collected">
        <h2>3. Data We Collect &amp; How</h2>

        <table class="data-table">
            <thead>
                <tr>
                    <th>Data element</th>
                    <th>Where it lives</th>
                    <th>Shared with us?</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>Saved recipes (title, ingredients, steps, image URL)</td>
                    <td>Browser <code>IndexedDB</code> <span class="tag tag-local">Local</span></td>
                    <td>Only if you enable Cloud Sync</td>
                </tr>
                <tr>
                    <td>Recipe vector embeddings (mathematical arrays)</td>
                    <td>Browser <code>IndexedDB</code> <span class="tag tag-local">Local</span></td>
                    <td>Only if you enable Cloud Sync</td>
                </tr>
                <tr>
                    <td>Your LLM API key (BYOK mode)</td>
                    <td>AES-GCM encrypted in <code>chrome.storage.local</code> <span class="tag tag-local">Local</span></td>
                    <td><span class="tag tag-never">Never</span></td>
                </tr>
                <tr>
                    <td>Session password / encryption salt &amp; IV</td>
                    <td><code>chrome.storage.session</code> <span class="tag tag-local">Local</span></td>
                    <td><span class="tag tag-never">Never</span></td>
                </tr>
                <tr>
                    <td>Supabase user ID + auth token (Cloud mode)</td>
                    <td>Supabase Auth + <code>chrome.storage.local</code> <span class="tag tag-cloud">Cloud</span></td>
                    <td>Yes — required for authentication</td>
                </tr>
                <tr>
                    <td>Raw recipe page HTML (during extraction)</td>
                    <td>Sent transiently to our API, pruned before LLM routing <span class="tag tag-cloud">Cloud</span></td>
                    <td>Yes — discarded after processing</td>
                </tr>
                <tr>
                    <td>Request timestamps &amp; endpoint hit counts</td>
                    <td>Upstash Redis (anonymous per user-ID) <span class="tag tag-cloud">Cloud</span></td>
                    <td>Yes — used solely for rate-limiting</td>
                </tr>
                <tr>
                    <td>Server-side request logs (latency, endpoint, user ID hash)</td>
                    <td>Fly.io log stream, rotated regularly <span class="tag tag-cloud">Cloud</span></td>
                    <td>Yes — used for debugging only</td>
                </tr>
                <tr>
                    <td>Browsing history / page content outside recipe extraction</td>
                    <td>N/A</td>
                    <td><span class="tag tag-never">Never collected</span></td>
                </tr>
            </tbody>
        </table>
    </section>

    <!-- 4. How we use data -->
    <section id="use">
        <h2>4. How We Use Your Data</h2>
        <ul>
            <li><strong>Recipe extraction &amp; normalisation:</strong> The raw page content you trigger via the Extension is sent to our API, stripped of images and scripts, and forwarded to an LLM (currently Gemini) to produce structured JSON. We do not store the raw HTML beyond the lifetime of the request.</li>
            <li><strong>Ingredient substitution:</strong> Your current recipe JSON is sent to the API and forwarded to an LLM to compute a science-backed substitution. Likewise not stored.</li>
            <li><strong>Cloud sync:</strong> If you sign in with Google OAuth or Email OTP, your normalised recipe JSON and pre-computed embedding vectors are stored in Supabase Postgres / pgvector under your Supabase user ID. This is the only persistent cloud storage we use.</li>
            <li><strong>Abuse prevention:</strong> We maintain an atomic per-user request counter in Redis to enforce weekly rate limits (configurable, default 50 requests/week per endpoint). No content is stored in Redis — only numeric counters keyed by your Supabase user ID.</li>
            <li><strong>Service improvement:</strong> Aggregated, anonymised request latency metrics may be reviewed to improve performance. Individual requests are not profiled.</li>
        </ul>
    </section>

    <!-- 5. BYOK -->
    <section id="byok">
        <h2>5. Bring Your Own Key (BYOK) Mode</h2>
        <p>
            BYOK mode lets you use MyPantry without a cloud account. Your LLM API key is encrypted locally
            in your browser using <strong>AES-256-GCM</strong> via the Web Crypto API, keyed with a password
            you create via PBKDF2. The raw key material is held only in ephemeral memory for up to 1 hour
            after decryption to avoid repeated password prompts, and is cleared upon browser restart or logout.
        </p>
        <p>
            In BYOK mode, your API key is <strong>never transmitted to our servers</strong>. All LLM calls
            are routed through your own key against the provider's API directly from our server acting as
            a stateless proxy — we never log or store the key value.
        </p>
    </section>

    <!-- 6. AI / LLM -->
    <section id="ai">
        <h2>6. Artificial Intelligence &amp; Third-Party LLMs</h2>
        <p>
            Recipe extraction and ingredient substitution use the <strong>Google Gemini</strong> API. The
            text payload we send is the pruned page content or your stored recipe JSON — no personally
            identifiable information is deliberately included. Please review
            <a href="https://policies.google.com/privacy" style="color:var(--color-accent)" target="_blank" rel="noopener noreferrer">
            Google's Privacy Policy</a> for how Gemini processes data.
        </p>
        <p>
            Semantic search embeddings are generated <strong>entirely on-device</strong> using
            <code>Transformers.js</code> (Xenova/all-MiniLM-L6-v2, quantized WASM build). No text is sent
            to any external service at the vectorisation step.
        </p>
    </section>

    <!-- 7. Permissions -->
    <section id="permissions">
        <h2>7. Chrome Extension Permissions</h2>
        <p>MyPantry Clip requests the following Chrome permissions and uses them strictly as described:</p>
        <ul>
            <li><strong>activeTab:</strong> Read the current tab's URL and title when you click the extension icon. We read only the tab you explicitly activate.</li>
            <li><strong>scripting:</strong> Inject a content script into the active tab on demand to extract the page's DOM for recipe parsing. The content script runs only when you initiate an extraction.</li>
            <li><strong>storage:</strong> Persist your encrypted API key, auth token, and local recipe database (<code>IndexedDB</code>) between sessions.</li>
            <li><strong>offscreen:</strong> Spawn an offscreen document to run the <code>Transformers.js</code> WASM pipeline without blocking the UI thread.</li>
        </ul>
        <p>We do <strong>not</strong> request <code>&lt;all_urls&gt;</code>, broad host permissions, or access to browser history.</p>
    </section>

    <!-- 8. Data retention -->
    <section id="retention">
        <h2>8. Data Retention &amp; Deletion</h2>
        <ul>
            <li><strong>Local data:</strong> Persists until you uninstall the Extension or use the "Export &amp; clear" function in Settings. We have no access to it.</li>
            <li><strong>Cloud sync data:</strong> Stored in Supabase linked to your user ID. You may delete your account and all associated data at any time by emailing <a href="mailto:support@mypantry.dev" style="color:var(--color-accent)">support@mypantry.dev</a>. Deletion is processed within 30 days.</li>
            <li><strong>Request logs:</strong> Retained for up to 30 days on Fly.io log streams, then automatically purged.</li>
            <li><strong>Redis counters:</strong> Rate-limit counters are keyed to a rolling 7-day window and expire automatically.</li>
        </ul>
    </section>

    <!-- 9. Sharing -->
    <section id="sharing">
        <h2>9. Data Sharing &amp; Sub-processors</h2>
        <p>We do <strong>not sell</strong> your data. We share data only with the following sub-processors, all of which are necessary for the service to function:</p>

        <table class="data-table">
            <thead>
                <tr><th>Sub-processor</th><th>Purpose</th><th>Data shared</th></tr>
            </thead>
            <tbody>
                <tr>
                    <td><a href="https://supabase.com/privacy" style="color:var(--color-accent)" target="_blank">Supabase</a></td>
                    <td>Auth &amp; cloud database</td>
                    <td>User ID, email (OAuth), recipe JSON, embedding vectors</td>
                </tr>
                <tr>
                    <td><a href="https://upstash.com/trust/privacy.pdf" style="color:var(--color-accent)" target="_blank">Upstash</a></td>
                    <td>Rate-limit counters</td>
                    <td>Supabase user ID (no content)</td>
                </tr>
                <tr>
                    <td><a href="https://fly.io/legal/privacy-policy" style="color:var(--color-accent)" target="_blank">Fly.io</a></td>
                    <td>API hosting</td>
                    <td>Server logs (IPs, request metadata)</td>
                </tr>
                <tr>
                    <td><a href="https://policies.google.com/privacy" style="color:var(--color-accent)" target="_blank">Google (Gemini)</a></td>
                    <td>LLM inference</td>
                    <td>Pruned page text / recipe JSON (transient)</td>
                </tr>
            </tbody>
        </table>
    </section>

    <!-- 10. Security -->
    <section id="security">
        <h2>10. Security</h2>
        <ul>
            <li>All data in transit is encrypted via <strong>TLS 1.2+</strong>.</li>
            <li>API keys stored locally use <strong>AES-256-GCM</strong> with a PBKDF2-derived key — the server never sees plaintext keys.</li>
            <li>All cloud API endpoints require a valid <strong>Supabase JWT</strong>; unauthenticated requests are rejected with HTTP 401.</li>
            <li>CORS is restricted to <code>chrome-extension://&lt;your-extension-id&gt;</code> and localhost for local development.</li>
        </ul>
    </section>

    <!-- 11. Children -->
    <section id="children">
        <h2>11. Children's Privacy</h2>
        <p>
            MyPantry is not directed at children under 13 (or the applicable age of digital consent in your
            jurisdiction). We do not knowingly collect personal information from children. If you believe
            a child has provided us with personal data, contact us at
            <a href="mailto:support@mypantry.dev" style="color:var(--color-accent)">support@mypantry.dev</a>
            and we will delete it promptly.
        </p>
    </section>

    <!-- 12. Your rights -->
    <section id="rights">
        <h2>12. Your Rights</h2>
        <p>Depending on your jurisdiction, you may have the following rights regarding your personal data:</p>
        <ul>
            <li><strong>Access:</strong> Request a copy of the data we hold about you.</li>
            <li><strong>Rectification:</strong> Correct inaccurate data.</li>
            <li><strong>Erasure:</strong> Request deletion of your account and associated cloud data.</li>
            <li><strong>Portability:</strong> Export your local recipe database at any time via the "Export to JSON" feature in the Extension settings.</li>
            <li><strong>Objection / Restriction:</strong> Object to or restrict certain processing.</li>
        </ul>
        <p>To exercise any of these rights, email <a href="mailto:support@mypantry.dev" style="color:var(--color-accent)">support@mypantry.dev</a>.</p>
    </section>

    <!-- 13. Changes -->
    <section id="changes">
        <h2>13. Changes to This Policy</h2>
        <p>
            We may update this policy to reflect changes in the service or legal requirements. Material
            changes will be announced on our website at <code>mypantry.dev</code>. The "Effective date"
            at the top of this page is always updated when changes are published.
        </p>
    </section>

    <!-- Footer -->
    <footer>
        <span>&copy; 2026 MyPantry &nbsp;·&nbsp; <a href="https://mypantry.dev">mypantry.dev</a></span>
        <span>
            <a href="mailto:support@mypantry.dev">support@mypantry.dev</a>
        </span>
    </footer>

</div>
</body>
</html>
"""


@router.get("/privacy", response_class=HTMLResponse, include_in_schema=True)
def privacy_policy():
    """
    Publicly accessible privacy policy page.
    - No authentication required (required for Chrome Web Store compliance).
    - Returns a fully self-contained HTML document styled with brand tokens.
    """
    return HTMLResponse(content=_PRIVACY_HTML, status_code=200)
