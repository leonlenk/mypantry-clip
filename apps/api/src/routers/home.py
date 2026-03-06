from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter(tags=["home"])

_HOME_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pantry Clip – MyPantry</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;1,9..144,400&family=Quicksand:wght@400;500;600;700&display=swap" rel="stylesheet">
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
            -webkit-font-smoothing: antialiased;
            overflow-x: hidden;
        }

        /* --- Header --- */
        header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 1.5rem 2rem;
            max-width: 1100px;
            margin: 0 auto;
        }

        .brand-group {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            text-decoration: none;
        }

        .logo-mark {
            width: 36px;
            height: 36px;
            background: var(--color-accent);
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            box-shadow: 0 4px 12px rgba(229, 178, 153, 0.4);
        }

        .brand-name {
            font-family: 'Fraunces', serif;
            font-size: 1.4rem;
            font-weight: 600;
            color: var(--color-primary);
            letter-spacing: -0.02em;
        }

        .nav-links {
            display: flex;
            gap: 1.5rem;
            align-items: center;
        }
        
        .nav-links a {
            color: var(--color-secondary);
            text-decoration: none;
            font-weight: 500;
            font-size: 0.95rem;
            transition: color 0.2s ease;
        }

        .nav-links a:hover {
            color: var(--color-primary);
        }

        /* --- Hero Section --- */
        .hero {
            padding: 6rem 2rem 4rem;
            max-width: 900px;
            margin: 0 auto;
            text-align: center;
        }

        .hero h1 {
            font-family: 'Fraunces', serif;
            font-size: clamp(2.5rem, 6vw, 4.5rem);
            font-weight: 600;
            line-height: 1.1;
            margin-bottom: 1.5rem;
            color: var(--color-primary);
            letter-spacing: -0.02em;
        }

        .hero p {
            font-size: clamp(1.1rem, 2vw, 1.35rem);
            color: var(--color-secondary);
            max-width: 650px;
            margin: 0 auto 2.5rem;
            line-height: 1.6;
        }

        .cta-button {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            background-color: var(--color-primary);
            color: var(--color-surface);
            padding: 1rem 2rem;
            border-radius: 99px;
            font-weight: 600;
            font-size: 1.1rem;
            text-decoration: none;
            transition: transform 0.2s ease, box-shadow 0.2s ease;
            box-shadow: 0 8px 24px rgba(74, 64, 54, 0.2);
            border: 2px solid transparent;
        }

        .cta-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 12px 32px rgba(74, 64, 54, 0.3);
            background-color: #383029;
        }

        .cta-secondary {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            background-color: transparent;
            color: var(--color-primary);
            padding: 1rem 2rem;
            border-radius: 99px;
            font-weight: 600;
            font-size: 1.1rem;
            text-decoration: none;
            transition: background-color 0.2s ease;
            border: 2px solid var(--color-border);
            margin-left: 1rem;
        }

        .cta-secondary:hover {
            background-color: var(--color-surface);
        }

        .hero-image-container {
            margin-top: 4rem;
            position: relative;
            max-width: 1000px;
            margin-left: auto;
            margin-right: auto;
            padding: 0 1rem;
        }
        
        .browser-mockup {
            background: #fff;
            border-radius: 12px;
            border: 1px solid var(--color-border);
            box-shadow: 0 24px 48px rgba(74, 64, 54, 0.08);
            overflow: hidden;
            display: flex;
            flex-direction: column;
            aspect-ratio: 16/9;
            background-color: var(--color-bg);
            position: relative;
        }
        
        .browser-bar {
            height: 40px;
            background: var(--color-surface);
            border-bottom: 1px solid var(--color-border);
            display: flex;
            align-items: center;
            padding: 0 1rem;
            gap: 0.5rem;
        }
        
        .browser-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: var(--color-tertiary);
        }

        .mockup-content {
            flex: 1;
            padding: 2rem;
            display: flex;
            align-items: center;
            justify-content: center;
            background-image: radial-gradient(var(--color-border) 1px, transparent 1px);
            background-size: 20px 20px;
        }

        .extension-popup-mock {
            width: 380px;
            background: #fff;
            border-radius: 16px;
            box-shadow: 0 16px 40px rgba(0,0,0,0.1);
            border: 1px solid var(--color-border);
            padding: 1.5rem;
            text-align: left;
        }

        .mock-recipe-title {
            font-family: 'Fraunces', serif;
            font-size: 1.5rem;
            color: var(--color-primary);
            margin-bottom: 1rem;
        }

        .mock-skeleton {
            height: 12px;
            background: var(--color-surface);
            border-radius: 6px;
            margin-bottom: 0.75rem;
            width: 100%;
        }
        .mock-skeleton.short { width: 60%; }
        .mock-skeleton.medium { width: 85%; }

        .mock-tag {
            display: inline-block;
            background: var(--color-accent);
            color: white;
            font-size: 0.75rem;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-weight: 600;
            margin-bottom: 1rem;
        }

        /* --- Features Section --- */
        .features {
            background-color: var(--color-surface);
            padding: 6rem 2rem;
            border-top: 1px solid var(--color-border);
            border-bottom: 1px solid var(--color-border);
        }

        .features-grid {
            max-width: 1100px;
            margin: 0 auto;
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 3rem;
        }

        .feature-card {
            background: var(--color-bg);
            padding: 2.5rem;
            border-radius: 16px;
            border: 1px solid var(--color-border);
            transition: transform 0.3s ease, box-shadow 0.3s ease;
        }

        .feature-card:hover {
            transform: translateY(-4px);
            box-shadow: 0 12px 24px rgba(74, 64, 54, 0.06);
        }

        .feature-icon {
            width: 48px;
            height: 48px;
            background: var(--color-surface);
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--color-accent);
            margin-bottom: 1.5rem;
        }

        .feature-card h3 {
            font-family: 'Fraunces', serif;
            font-size: 1.4rem;
            margin-bottom: 1rem;
            color: var(--color-primary);
        }

        .feature-card p {
            color: var(--color-secondary);
            font-size: 1rem;
            line-height: 1.6;
            margin-bottom: 0;
        }
        
        .feature-tag {
            display: inline-block;
            font-family: monospace;
            font-size: 0.8rem;
            background: var(--color-border);
            padding: 0.2rem 0.5rem;
            border-radius: 4px;
            color: var(--color-primary);
            margin-top: 1rem;
        }

        /* --- Footer --- */
        footer {
            max-width: 1100px;
            margin: 0 auto;
            padding: 4rem 2rem;
            display: flex;
            flex-direction: column;
            align-items: center;
            text-align: center;
        }

        .footer-brand {
            font-family: 'Fraunces', serif;
            font-size: 1.5rem;
            color: var(--color-primary);
            margin-bottom: 1rem;
            font-weight: 600;
        }

        .footer-links {
            display: flex;
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        .footer-links a {
            color: var(--color-secondary);
            text-decoration: none;
            font-weight: 500;
        }
        
        .footer-links a:hover {
            color: var(--color-primary);
        }

        .copyright {
            color: var(--color-tertiary);
            font-size: 0.9rem;
        }

        @media (max-width: 768px) {
            .hero h1 { font-size: 2.5rem; }
            .cta-secondary { margin-left: 0; margin-top: 1rem; }
            .extension-popup-mock { width: 90%; }
        }
    </style>
</head>
<body>

    <!-- Header -->
    <header>
        <a href="/" class="brand-group">
            <div class="logo-mark">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 11l19-9-9 19-2-8-8-2z"/>
                </svg>
            </div>
            <span class="brand-name">MyPantry</span>
        </a>
        <nav class="nav-links">
            <a href="https://github.com/leonlenk/my-pantry" target="_blank" rel="noopener">GitHub</a>
            <a href="/privacy">Privacy</a>
        </nav>
    </header>

    <!-- Hero -->
    <main>
        <section class="hero">
            <h1>Save recipes instantly. <br>Find them magically.</h1>
            <p>Pantry Clip is a privacy-first, secure Chrome extension that extracts perfectly formatted recipes from any website and lets you search your personal cookbook semantically.</p>
            
            <div style="display: flex; flex-wrap: wrap; justify-content: center; gap: 1rem;">
                <a href="#" class="cta-button" onclick="alert('Extension published soon!'); return false;">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                    Add to Chrome
                </a>
            </div>
            
            <div class="hero-image-container">
                <div class="browser-mockup">
                    <div class="browser-bar">
                        <div class="browser-dot"></div>
                        <div class="browser-dot"></div>
                        <div class="browser-dot"></div>
                        <div style="margin-left: auto; width: 60%; max-width: 300px; height: 20px; background: var(--color-bg); border-radius: 4px; border: 1px solid var(--color-border);"></div>
                    </div>
                    <div class="mockup-content">
                        <div class="extension-popup-mock">
                            <div class="mock-tag">Recipe Detected</div>
                            <div class="mock-recipe-title">Rustic Sourdough Bread</div>
                            <div class="mock-skeleton"></div>
                            <div class="mock-skeleton medium"></div>
                            <div class="mock-skeleton short"></div>
                            <div style="margin-top: 1.5rem; display: flex; justify-content: space-between; border-top: 1px solid var(--color-border); padding-top: 1rem;">
                                <div style="color: var(--color-secondary); font-size: 0.85rem; font-weight: 600;">Prep: 20m</div>
                                <div style="color: var(--color-secondary); font-size: 0.85rem; font-weight: 600;">Cook: 45m</div>
                            </div>
                            <div style="margin-top: 1.5rem; background: var(--color-accent); color: white; text-align: center; padding: 0.75rem; border-radius: 8px; font-weight: 600; font-size: 0.9rem;">
                                Save to Pantry
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </section>

        <!-- Features -->
        <section class="features">
            <div class="features-grid">
                <!-- Feature 1 -->
                <div class="feature-card">
                    <div class="feature-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                    </div>
                    <h3>BYOK Privacy</h3>
                    <p>Bring Your Own Key mode means your LLM API keys are AES-256-GCM encrypted locally in your browser. When decrypted, they are held securely in memory for only up to 1 hour to avoid repeated password prompts. We never see your raw key material.</p>
                    <div class="feature-tag">window.crypto.subtle</div>
                </div>

                <!-- Feature 2 -->
                <div class="feature-card">
                    <div class="feature-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                    </div>
                    <h3>Edge AI Search</h3>
                    <p>Mathematical embeddings for recipe semantic search are computed entirely on-device using a quantized Transformers model. Fast, private, and zero cloud costs.</p>
                    <div class="feature-tag">WASM execution</div>
                </div>

                <!-- Feature 3 -->
                <div class="feature-card">
                    <div class="feature-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6.364 6.364 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
                    </div>
                    <h3>Smart Extraction</h3>
                    <p>Pantry Clip aggressively prunes the bloat from food blogs, extracting only the ingredients and instructions into clean, structured JSON.</p>
                    <div class="feature-tag">Structured Output</div>
                </div>
            </div>
        </section>
    </main>

    <!-- Footer -->
    <footer>
        <div class="footer-brand">MyPantry</div>
        <div class="footer-links">
            <a href="https://github.com/leonlenk/my-pantry" target="_blank" rel="noopener">GitHub</a>
            <a href="/privacy">Privacy Policy</a>
            <a href="mailto:support@mypantry.dev">Contact Support</a>
        </div>
        <div class="copyright">
            &copy; 2026 MyPantry. Open source and privacy-first.
        </div>
    </footer>

</body>
</html>
"""

@router.get("/", response_class=HTMLResponse, include_in_schema=True)
def homepage():
    """
    Publicly accessible homepage for advertising the Pantry Clip extension.
    - No authentication required.
    - Returns a fully self-contained HTML document styled with brand tokens.
    """
    return HTMLResponse(content=_HOME_HTML, status_code=200)
