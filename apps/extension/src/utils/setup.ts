import { encryptData } from "../utils/crypto";

// Elements
const stepLogin = document.getElementById("step-login");
const stepDownloading = document.getElementById("step-downloading");
const stepSyncing = document.getElementById("step-syncing");
const stepReady = document.getElementById("step-ready");

const btnOauth = document.getElementById("btn-oauth-google");
const btnShowByok = document.getElementById("btn-show-byok");
const byokForm = document.getElementById("byok-form");
const inputApiKey = document.getElementById("input-api-key") as HTMLInputElement | null;
const selectProvider = document.getElementById("select-provider") as HTMLSelectElement | null;
const selectModel = document.getElementById("select-model") as HTMLSelectElement | null;
const btnSubmitByok = document.getElementById("btn-submit-byok");

const hardcodedPricing: Record<string, string> = {
    // Google
    "models/gemini-2.5-flash": "Cheaper",
    "models/gemini-2.0-flash": "Fast",
    "models/gemini-2.5-pro": "Powerful, More Expensive",
    "models/gemini-2.0-pro-exp": "Experimental",
    // OpenAI
    "gpt-4o-mini": "$0.15/1M in",
    "o3-mini": "$1.10/1M in",
    "gpt-4o": "$2.50/1M in",
    // Claude
    "claude-3-haiku-20240307": "$0.25/1M in",
    "claude-3-5-haiku-20241022": "$0.80/1M in",
    "claude-3-5-sonnet-20241022": "$3.00/1M in"
};

const hardcodedPricingSort: Record<string, number> = {
    // Google
    "models/gemini-2.5-flash": 1,
    "models/gemini-2.0-flash": 2,
    "models/gemini-2.5-pro": 3,
    "models/gemini-2.0-pro-exp": 4,
    // OpenAI
    "gpt-4o-mini": 0.15,
    "o3-mini": 1.10,
    "gpt-4o": 2.50,
    // Claude
    "claude-3-haiku-20240307": 0.25,
    "claude-3-5-haiku-20241022": 0.80,
    "claude-3-5-sonnet-20241022": 3.00
};

async function fetchModels() {
    if (!selectProvider || !selectModel) return;

    const provider = selectProvider.value;
    const apiKey = inputApiKey?.value || "";

    // OpenRouter doesn't strictly need an API key to fetch the public models list
    if (provider !== "openrouter" && !apiKey) {
        selectModel.innerHTML = `<option value="">Enter API Key to load models...</option>`;
        selectModel.disabled = true;
        return;
    }

    selectModel.innerHTML = `<option value="">Loading models...</option>`;
    selectModel.disabled = true;

    try {
        let optionsHtml = "";

        if (provider === "openrouter") {
            const res = await fetch("https://openrouter.ai/api/v1/models");
            if (!res.ok) throw new Error("Failed to load models");
            const data = await res.json();

            // OpenRouter provides pricing! Sort by prompt price.
            optionsHtml = data.data.sort((a: any, b: any) =>
                parseFloat(a.pricing?.prompt || "999") - parseFloat(b.pricing?.prompt || "999")
            ).map((m: any) => {
                const promptPrice = (parseFloat(m.pricing?.prompt || "0") * 1000000).toFixed(2);
                const compPrice = (parseFloat(m.pricing?.completion || "0") * 1000000).toFixed(2);
                const priceLabel = promptPrice === "0.00" && compPrice === "0.00"
                    ? "Free"
                    : `$${promptPrice} in / $${compPrice} out`;
                return `<option value="${m.id}">${m.name} (${priceLabel})</option>`;
            }).join("");

        } else if (provider === "google") {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
            if (!res.ok) throw new Error("Invalid API Key or network error");
            const data = await res.json();

            // Filter to models that support text generation
            const validModels = data.models.filter((m: any) =>
                m.supportedGenerationMethods?.includes("generateContent")
            ).sort((a: any, b: any) =>
                (hardcodedPricingSort[a.name] ?? 999) - (hardcodedPricingSort[b.name] ?? 999)
            );

            optionsHtml = validModels.map((m: any) => {
                // Return just the model name without "models/" if possible, but Google API usually accepts both. Let's send the ID they provide.
                const val = m.name.replace("models/", "");
                const priceLabel = hardcodedPricing[m.name] ? ` (${hardcodedPricing[m.name]})` : "";
                return `<option value="${val}">${m.displayName || val}${priceLabel}</option>`;
            }).join("");

        } else if (provider === "openai") {
            const res = await fetch("https://api.openai.com/v1/models", {
                headers: { "Authorization": `Bearer ${apiKey}` }
            });
            if (!res.ok) throw new Error("Invalid API Key or network error");
            const data = await res.json();

            // OpenAI returns hundreds of models, let's filter to chat models roughly
            const validModels = data.data.filter((m: any) =>
                m.id.startsWith("gpt-") || m.id.startsWith("o1") || m.id.startsWith("o3")
            ).sort((a: any, b: any) =>
                (hardcodedPricingSort[a.id] ?? 999) - (hardcodedPricingSort[b.id] ?? 999)
            );

            optionsHtml = validModels.map((m: any) => {
                const priceLabel = hardcodedPricing[m.id] ? ` (${hardcodedPricing[m.id]})` : "";
                return `<option value="${m.id}">${m.id}${priceLabel}</option>`;
            }).join("");

        } else if (provider === "claude") {
            const res = await fetch("https://api.anthropic.com/v1/models", {
                headers: {
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01",
                    "anthropic-dangerous-direct-browser-access": "true"
                }
            });
            if (!res.ok) throw new Error("Invalid API Key or network error");
            const data = await res.json();

            optionsHtml = data.data.sort((a: any, b: any) =>
                (hardcodedPricingSort[a.id] ?? 999) - (hardcodedPricingSort[b.id] ?? 999)
            ).map((m: any) => {
                const priceLabel = hardcodedPricing[m.id] ? ` (${hardcodedPricing[m.id]})` : "";
                return `<option value="${m.id}">${m.display_name || m.id}${priceLabel}</option>`;
            }).join("");
        }

        if (optionsHtml) {
            selectModel.innerHTML = optionsHtml;
            selectModel.disabled = false;
        } else {
            selectModel.innerHTML = `<option value="">No valid models found</option>`;
            selectModel.disabled = false;
        }

    } catch (err) {
        selectModel.innerHTML = `<option value="">Error loading models. Check API Key.</option>`;
        selectModel.disabled = false;
    }
}

// Initialize logic
if (selectProvider) {
    selectProvider.addEventListener("change", (e) => {
        const target = e.target as HTMLSelectElement;
        fetchModels();
    });
}

if (inputApiKey) {
    inputApiKey.addEventListener("blur", () => {
        fetchModels();
    });
}

// Initial fetch attempt (in case of OpenRouter default, or autocomplete)
setTimeout(() => {
    fetchModels();
}, 100);

const progressBar = document.getElementById("progress-bar-fill");
const progressText = document.getElementById("progress-text");
const syncBar = document.getElementById("sync-bar-fill");
const syncText = document.getElementById("sync-text");
const btnCloseTab = document.getElementById("btn-close-tab");

function showState(stateElement: HTMLElement | null) {
    document.querySelectorAll(".view-state").forEach((el) => el.classList.remove("active"));
    if (stateElement) stateElement.classList.add("active");
}

// 1. BYOK Flow
btnShowByok?.addEventListener("click", () => {
    byokForm?.classList.toggle("hidden");
    if (!byokForm?.classList.contains("hidden")) inputApiKey?.focus();
});

btnSubmitByok?.addEventListener("click", async () => {
    const key = inputApiKey?.value;
    if (!key) return;

    const provider = selectProvider?.value || "google";
    const model = selectModel?.value || "gemini-2.5-flash";

    await chrome.storage.local.set({
        plaintextApiKey: key,
        encryptedApiKey: null, // Clear any legacy encrypted keys just in case
        supabaseToken: null, // Ensure cloud auth is totally wiped
        supabaseRefreshToken: null,
        llmProvider: provider,
        llmModel: model,
        // BYOK users still need an apiUrl for cloud sync to work if they later sign in
        apiUrl: import.meta.env.PUBLIC_API_URL ?? "http://127.0.0.1:8000",
    });

    await doPostModelSync();
});

// 2. OAuth Flow — Tab-Capture strategy (no `identity` permission required)
//
// Instead of chrome.identity.launchWebAuthFlow (which needs the `identity`
// permission), we open a real tab to mypantry.dev/auth/callback. Supabase
// redirects to that URL after Google consent and writes the session to
// localStorage. The content script on that page reads the session and sends
// AUTH_SESSION_CAPTURED → background, which persists the tokens, closes the
// tab, then fires AUTH_COMPLETE → here to advance the UI.

/** Puts the Google button into a loading state while the OAuth tab is open. */
function setOauthLoading(loading: boolean) {
    const btn = btnOauth as HTMLButtonElement | null;
    if (!btn) return;
    if (loading) {
        btn.disabled = true;
        btn.classList.add("loading");
        btn.dataset.originalHtml = btn.innerHTML;
        btn.innerHTML = `<span class="btn-spinner"></span>Opening Google sign-in…`;
    } else {
        btn.disabled = false;
        btn.classList.remove("loading");
        if (btn.dataset.originalHtml) {
            btn.innerHTML = btn.dataset.originalHtml;
            delete btn.dataset.originalHtml;
        }
    }
}

btnOauth?.addEventListener("click", async () => {
    const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL as string;
    const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string;

    if (!supabaseUrl || supabaseUrl.includes("your-project-ref")) {
        console.error("PUBLIC_SUPABASE_URL is not configured in .env");
        alert("OAuth is not configured. Please add your Gemini key via 'Bring Your Own Key'.");
        return;
    }

    setOauthLoading(true);

    // Pre-save the environment variables to storage so the background script
    // can access them without crashing from esbuild's lack of import.meta
    await chrome.storage.local.set({
        supabaseUrl,
        supabaseAnonKey,
        apiUrl: import.meta.env.PUBLIC_API_URL ?? 'http://127.0.0.1:8000',
        llmProvider: 'google',
        llmModel: 'gemini-2.5-flash',
        plaintextApiKey: null,
    });

    // Supabase will redirect back to this page after the Google consent screen.
    // The content script running on that page captures the session and notifies us.
    const redirectTo = "https://mypantry.dev/auth/callback";
    const authUrl = `${supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`;

    console.log("[OAuth] Opening auth tab:", authUrl);
    chrome.tabs.create({ url: authUrl });
    // startModelDownload() used to be here, but we now jump straight to doPostModelSync
    // since the model is pre-downloaded during build and bundled.
});

/**
 * Runs after the model is ready (downloaded or already cached).
 * For Google OAuth users on a fresh device: shows the "Populating your Pantry..."
 * screen and cold-boot syncs all cloud recipes before redirecting to the pantry.
 * For BYOK users: goes straight to the ready screen.
 */
async function doPostModelSync() {
    const { llmProvider } = await chrome.storage.local.get("llmProvider");

    if (llmProvider !== "google") {
        // BYOK users have no cloud — show ready immediately
        showState(stepReady);
        return;
    }

    // Check if the user already has cloud recipes (avoid redundant full syncs on relog)
    const { lastSyncAt } = await chrome.storage.local.get("lastSyncAt");
    if (lastSyncAt) {
        // Already synced before — go straight to ready
        showState(stepReady);
        return;
    }

    // Cold boot: show the syncing state and pull + push simultaneously
    showState(stepSyncing);
    if (syncText) syncText.textContent = "Connecting to cloud...";
    if (syncBar) syncBar.style.width = "5%";

    try {
        // Step 1: Pull recipes from cloud → local (handles multi-device restore)
        const pullResult: { success: boolean; merged: number; total: number } =
            await chrome.runtime.sendMessage({ type: "SYNC_FROM_CLOUD", since: undefined });

        if (syncBar) syncBar.style.width = "50%";
        if (syncText) syncText.textContent = "Syncing your library...";

        // Step 2: Push local recipes → cloud (recovers recipes that were saved
        // before cloud sync was working, or saved on this device while offline)
        const pushResult: { success: boolean; pushed: number; total: number } =
            await chrome.runtime.sendMessage({ type: "PUSH_ALL_LOCAL_TO_CLOUD" });

        if (syncBar) syncBar.style.width = "100%";

        const pulled = pullResult.success ? pullResult.merged : 0;
        const pushed = pushResult.success ? pushResult.pushed : 0;
        const total = pulled + pushed;

        if (syncText) {
            syncText.textContent = total > 0
                ? `Synced ${total} recipe${total !== 1 ? "s" : ""}!`
                : "You're all set — recipes will sync automatically!";
        }
    } catch (err) {
        console.warn("[Setup] Cold boot sync failed (non-fatal):", err);
        if (syncText) syncText.textContent = "Sync skipped — recipes sync automatically when you save them.";
    }

    // Brief pause so the user can read the result, then go to ready
    await new Promise((r) => setTimeout(r, 1200));
    showState(stepReady);
}

chrome.runtime.onMessage.addListener((msg) => {
    // AUTH_COMPLETE: background persisted the Supabase session after the
    // content script captured it on mypantry.dev/auth/callback.
    if (msg.type === "AUTH_COMPLETE") {
        setOauthLoading(false);

        // Mark setup complete and jump to sync since model is bundled
        (async () => {
            await chrome.storage.local.set({ setupComplete: true });
            await doPostModelSync();
        })();
    }
});

btnCloseTab?.addEventListener("click", () => {
    window.close();
});
