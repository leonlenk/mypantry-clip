import { initializeByokForm } from "./byok";
import { getLocal, setLocal } from "./storage";
import { MSG } from "./messages";

// Elements
const stepIdentity  = document.getElementById("step-identity");
const stepApiChoice = document.getElementById("step-api-choice");
const stepByok      = document.getElementById("step-byok");
const stepSyncing   = document.getElementById("step-syncing");
const stepReady     = document.getElementById("step-ready");

const btnOauth            = document.getElementById("btn-oauth-google");
const btnContinueAnonymous = document.getElementById("btn-continue-anonymous");
const btnChooseCloud      = document.getElementById("btn-choose-cloud");
const btnChooseByok       = document.getElementById("btn-choose-byok");
const btnBackByok         = document.getElementById("btn-back-byok");
const syncBar  = document.getElementById("sync-bar-fill");
const syncText = document.getElementById("sync-text");
const btnCloseTab = document.getElementById("btn-close-tab");

let byokPreviousStep: HTMLElement | null = null;

function showState(stateElement: HTMLElement | null) {
    document.querySelectorAll(".view-state").forEach((el) => el.classList.remove("active"));
    if (stateElement) stateElement.classList.add("active");
}

// Initialize the shared BYOK form logic (used for both anonymous and Google+BYOK paths)
initializeByokForm({
    idPrefix: "setup-byok-",
    onSaveSuccess: async () => {
        await doPostModelSync();
    },
    isSettingsMode: false,
});

// ─── STEP 1: Identity choice ─────────────────────────────────────────────────

/** Puts the Google choice card into a loading state while the OAuth tab is open. */
function setOauthLoading(loading: boolean) {
    const btn = btnOauth as HTMLButtonElement | null;
    if (!btn) return;
    if (loading) {
        btn.disabled = true;
        btn.dataset.originalHtml = btn.innerHTML;
        const body = btn.querySelector(".choice-card-body");
        if (body) {
            body.innerHTML = `<div class="choice-card-title"><span class="btn-spinner"></span>Opening Google sign-in…</div>`;
        }
    } else {
        btn.disabled = false;
        if (btn.dataset.originalHtml) {
            btn.innerHTML = btn.dataset.originalHtml;
            delete btn.dataset.originalHtml;
        }
    }
}

// OAuth Flow — Tab-Capture strategy (no `identity` permission required)
btnOauth?.addEventListener("click", async () => {
    const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL as string;
    const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string;

    if (!supabaseUrl || supabaseUrl.includes("your-project-ref")) {
        console.error("PUBLIC_SUPABASE_URL is not configured in .env");
        alert("OAuth is not configured. Please continue anonymously and add your own API key.");
        return;
    }

    setOauthLoading(true);

    await setLocal({
        identityMode: "google",
        supabaseUrl,
        supabaseAnonKey,
        apiUrl: import.meta.env.PUBLIC_API_URL ?? "http://127.0.0.1:8000",
    });

    const redirectTo = "https://mypantry.dev/api/auth/callback";
    const authUrl = `${supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}&prompt=consent`;

    console.log("[OAuth] Opening auth tab:", authUrl);
    chrome.tabs.create({ url: authUrl });
});

// Anonymous path — go directly to BYOK form
btnContinueAnonymous?.addEventListener("click", async () => {
    await setLocal({
        identityMode: "anonymous",
        apiUrl: import.meta.env.PUBLIC_API_URL ?? "http://127.0.0.1:8000",
    });
    byokPreviousStep = stepIdentity;
    showState(stepByok);
});

// ─── STEP 2: API choice (Google users only) ───────────────────────────────────

btnChooseCloud?.addEventListener("click", async () => {
    await setLocal({
        apiMode: "cloud",
        llmProvider: "google",
        llmModel: "gemini-2.5-flash",
        plaintextApiKey: null,
        setupComplete: true,
    });
    await doPostModelSync();
});

btnChooseByok?.addEventListener("click", () => {
    byokPreviousStep = stepApiChoice;
    showState(stepByok);
});

btnBackByok?.addEventListener("click", () => {
    showState(byokPreviousStep ?? stepIdentity);
});

// ─── AUTH_COMPLETE: background persisted the Supabase session ────────────────

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "AUTH_COMPLETE") {
        setOauthLoading(false);

        (async () => {
            // Mark setup complete now so the popup doesn't redirect to setup on next open.
            // The user still needs to pick their API mode on step-api-choice.
            await setLocal({ setupComplete: true });
            showState(stepApiChoice);
        })();
    }
});

// ─── Post-setup sync ─────────────────────────────────────────────────────────

/**
 * Runs after the model/API choice is finalised.
 * For Google Cloud users on a fresh device: shows the "Populating your Pantry..."
 * screen and cold-boot syncs all cloud recipes.
 * For BYOK or anonymous users: goes straight to the ready screen.
 */
async function doPostModelSync() {
    const { apiMode } = await getLocal(["apiMode"]);

    if (apiMode !== "cloud") {
        // BYOK or anonymous — no cloud to sync, go straight to ready
        showState(stepReady);
        return;
    }

    // Check if the user already has cloud recipes (avoid redundant full syncs on relog)
    const { lastSyncAt } = await getLocal(["lastSyncAt"]);
    if (lastSyncAt) {
        showState(stepReady);
        return;
    }

    // Cold boot: show the syncing state and pull + push simultaneously
    showState(stepSyncing);
    if (syncText) syncText.textContent = "Connecting to cloud...";
    if (syncBar) syncBar.style.width = "5%";

    try {
        const pullResult: { success: boolean; merged: number; total: number } =
            await chrome.runtime.sendMessage({ type: MSG.syncFromCloud, since: undefined });

        if (syncBar) syncBar.style.width = "50%";
        if (syncText) syncText.textContent = "Syncing your library...";

        const pushResult: { success: boolean; pushed: number; total: number } =
            await chrome.runtime.sendMessage({ type: MSG.pushAllLocalToCloud });

        if (syncBar) syncBar.style.width = "100%";

        const pulled = pullResult.success ? pullResult.merged : 0;

        if (syncText) {
            syncText.textContent = pulled > 0
                ? `Synced ${pulled} recipe${pulled !== 1 ? "s" : ""}!`
                : "You're all set — recipes will sync automatically!";
        }
    } catch (err) {
        console.warn("[Setup] Cold boot sync failed (non-fatal):", err);
        if (syncText) syncText.textContent = "Sync skipped — recipes sync automatically when you save them.";
    }

    await new Promise((r) => setTimeout(r, 1200));
    showState(stepReady);
}

btnCloseTab?.addEventListener("click", () => {
    window.close();
});
