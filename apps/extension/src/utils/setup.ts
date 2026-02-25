import { encryptData } from "../utils/crypto";

// Elements
const stepLogin = document.getElementById("step-login");
const stepDownloading = document.getElementById("step-downloading");
const stepReady = document.getElementById("step-ready");

const btnOauth = document.getElementById("btn-oauth-google");
const btnShowByok = document.getElementById("btn-show-byok");
const byokForm = document.getElementById("byok-form");
const inputApiKey = document.getElementById("input-api-key") as HTMLInputElement | null;
const btnSubmitByok = document.getElementById("btn-submit-byok");

const progressBar = document.getElementById("progress-bar-fill");
const progressText = document.getElementById("progress-text");
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
    });

    startModelDownload();
});

// 2. OAuth Flow
btnOauth?.addEventListener("click", () => {
    // chrome.identity.launchWebAuthFlow requires HTTPS - we call Supabase directly.
    // PUBLIC_SUPABASE_URL is injected at build time by Vite from the .env file.
    const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL as string;

    if (!supabaseUrl || supabaseUrl.includes("your-project-ref")) {
        console.error("PUBLIC_SUPABASE_URL is not configured in .env");
        alert("OAuth is not configured. Please add your Gemini key via 'Bring Your Own Key'.");
        return;
    }

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
                return;
            }

            // The URL will look like: https://<id>.chromiumapp.org/#access_token=...&refresh_token=...
            const hash = new URL(redirectUri).hash;
            if (!hash) {
                console.error("No hash fragment returned from auth flow");
                return;
            }

            const params = new URLSearchParams(hash.substring(1));
            const accessToken = params.get("access_token");
            const refreshToken = params.get("refresh_token");

            if (accessToken) {
                await chrome.storage.local.set({
                    supabaseToken: accessToken,
                    supabaseRefreshToken: refreshToken,
                    llmProvider: "google",
                    llmModel: "gemini-2.5-flash",
                    plaintextApiKey: null,
                });
                console.log("Successfully authenticated with Supabase!");
                startModelDownload();
            } else {
                console.error("Authentication failed: No access token found in redirect URI.");
            }
        }
    );
});

// 3. Initiate Download via Offscreen
async function startModelDownload() {
    showState(stepDownloading);
    chrome.runtime.sendMessage({ type: "INIT_MODEL_DOWNLOAD" });
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

            setTimeout(() => {
                showState(stepReady);
                chrome.storage.local.set({ setupComplete: true });
            }, 500);
        }
    }
});

btnCloseTab?.addEventListener("click", () => {
    window.close();
});
