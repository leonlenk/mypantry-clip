import { initializeByokForm } from "./byok";

// Elements
const stepLogin = document.getElementById("step-login");
const stepDownloading = document.getElementById("step-downloading");
const stepSyncing = document.getElementById("step-syncing");
const stepReady = document.getElementById("step-ready");

const btnOauth = document.getElementById("btn-oauth-google");
const btnShowByok = document.getElementById("btn-show-byok");
const byokFormWrapper = document.getElementById("byok-form-wrapper");

// Initialize the shared BYOK form logic for the setup page
initializeByokForm({
    idPrefix: "setup-byok-",
    onSaveSuccess: async (provider: string, model: string, isNewKey: boolean) => {
        await doPostModelSync();
    },
    isSettingsMode: false
});

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
    byokFormWrapper?.classList.toggle("hidden");
    if (!byokFormWrapper?.classList.contains("hidden")) {
        const inputApiKey = document.getElementById("setup-byok-input-api-key") as HTMLInputElement | null;
        inputApiKey?.focus();
    }
});

// 2. OAuth Flow — Tab-Capture strategy (no `identity` permission required)
//
// Instead of chrome.identity.launchWebAuthFlow (which needs the `identity`
// permission), we open a real tab to mypantry.dev/api/auth/callback. Supabase
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
    const redirectTo = "https://mypantry.dev/api/auth/callback";
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
    // content script captured it on mypantry.dev/api/auth/callback.
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
