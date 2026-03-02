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
const btnSubmitByok = document.getElementById("btn-submit-byok");

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

    await chrome.storage.local.set({
        plaintextApiKey: key,
        llmProvider: "google",
        llmModel: "gemini-2.5-flash",
        // BYOK users still need an apiUrl for cloud sync to work if they later sign in
        apiUrl: import.meta.env.PUBLIC_API_URL ?? "http://127.0.0.1:8000",
    });

    startModelDownload();
});

// 2. OAuth Flow

/** Puts the Google button into a loading state while the OAuth window opens. */
function setOauthLoading(loading: boolean) {
    const btn = btnOauth as HTMLButtonElement | null;
    if (!btn) return;
    if (loading) {
        btn.disabled = true;
        btn.classList.add("loading");
        btn.dataset.originalHtml = btn.innerHTML;
        // Show a spinner + message so the user knows something is happening
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

btnOauth?.addEventListener("click", () => {
    // chrome.identity.launchWebAuthFlow requires HTTPS - we call Supabase directly.
    // PUBLIC_SUPABASE_URL is injected at build time by Vite from the .env file.
    const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL as string;

    if (!supabaseUrl || supabaseUrl.includes("your-project-ref")) {
        console.error("PUBLIC_SUPABASE_URL is not configured in .env");
        alert("OAuth is not configured. Please add your Gemini key via 'Bring Your Own Key'.");
        return;
    }

    // Give immediate feedback — the OAuth window can take several seconds to appear
    setOauthLoading(true);

    const extensionId = chrome.runtime.id;
    // Chrome redirects auth responses to this ephemeral HTTPS origin so the extension can capture the token hash
    // Use chrome.identity.getRedirectURL() - the canonical way to get this URL
    const redirectUrl = chrome.identity.getRedirectURL();
    const authUrl = `${supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUrl)}`;

    console.log("[OAuth] Extension ID:", extensionId);
    console.log("[OAuth] Redirect URL:", redirectUrl);
    console.log("[OAuth] Auth URL:", authUrl);

    chrome.identity.launchWebAuthFlow(
        { url: authUrl, interactive: true },
        async (redirectUri) => {
            if (chrome.runtime.lastError || !redirectUri) {
                console.error("Auth flow failed or canceled", chrome.runtime.lastError);
                // Restore the button so the user can try again
                setOauthLoading(false);
                return;
            }

            // The URL will look like: https://<id>.chromiumapp.org/#access_token=...&refresh_token=...
            const hash = new URL(redirectUri).hash;
            if (!hash) {
                console.error("No hash fragment returned from auth flow");
                setOauthLoading(false);
                return;
            }

            const params = new URLSearchParams(hash.substring(1));
            const accessToken = params.get("access_token");
            const refreshToken = params.get("refresh_token");

            if (accessToken) {
                await chrome.storage.local.set({
                    supabaseToken: accessToken,
                    supabaseRefreshToken: refreshToken,
                    supabaseUrl: import.meta.env.PUBLIC_SUPABASE_URL,
                    supabaseAnonKey: import.meta.env.PUBLIC_SUPABASE_ANON_KEY,
                    // Persist the API base URL so the esbuild-compiled background worker
                    // (which can't use import.meta.env) can read it from storage.
                    apiUrl: import.meta.env.PUBLIC_API_URL ?? "http://127.0.0.1:8000",
                    llmProvider: "google",
                    llmModel: "gemini-2.5-flash",
                    plaintextApiKey: null,
                });
                console.log("Successfully authenticated with Supabase!");
                startModelDownload();
            } else {
                console.error("Authentication failed: No access token found in redirect URI.");
                setOauthLoading(false);
            }
        }
    );
});

// 3. Initiate model setup via Offscreen
// On relog the model is already in the browser's Cache API — skip the download screen entirely.
async function startModelDownload() {
    let cached = false;
    try {
        const res: { cached: boolean } = await chrome.runtime.sendMessage({ type: "CHECK_MODEL_CACHED" });
        cached = !!res?.cached;
    } catch {
        cached = false;
    }

    if (cached) {
        // Model already on disk — mark setup complete and jump straight to ready/sync
        await chrome.storage.local.set({ setupComplete: true });
        await doPostModelSync();
        return;
    }

    // First-time download: show progress UI and kick off the download
    showState(stepDownloading);
    chrome.runtime.sendMessage({ type: "INIT_MODEL_DOWNLOAD" });
}

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

// Listen for download progress from background/offscreen
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "DOWNLOAD_PROGRESS") {
        const { loaded, total } = msg;
        if (total && total > 0) {
            const percent = Math.round((loaded / total) * 100);
            if (progressBar) progressBar.style.width = `${percent}%`;
            if (progressText) progressText.textContent = `${percent}%`;
        } else if (msg.status === "ready" || msg.status === "done") {
            if (progressBar) progressBar.style.width = `100%`;
            if (progressText) progressText.textContent = `100%`;

            setTimeout(async () => {
                await chrome.storage.local.set({ setupComplete: true });
                await doPostModelSync();
            }, 500);
        }
    }
});

btnCloseTab?.addEventListener("click", () => {
    window.close();
});
