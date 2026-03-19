/**
 * Popup action panel controller.
 *
 * Handles all popup UI interactions:
 *   - Auth state detection and profile badge setup
 *   - Extraction triggering and live status display
 *   - Settings / BYOK panel
 *   - Logout and switch account
 */

import { initializeByokForm, loadByokSettings } from "../../utils/byok";
import { getLocal, setLocal, removeLocal, AUTH_KEYS } from "../../utils/storage";
import { MSG } from "../../utils/messages";
import { parseJwt } from "../../utils/authUtils";

declare const chrome: any;

// ─── DOM handles ─────────────────────────────────────────────────────────────

const mainView = document.getElementById("main-view");
const profileBadgeBtn = document.getElementById("profile-badge-btn");
const profileDropdownMenu = document.getElementById("profile-dropdown-menu");
const apiSettingsBtn = document.getElementById("api-settings-btn");
const switchApiModeBtn = document.getElementById("switch-api-mode-btn");
const switchAccountBtn = document.getElementById("switch-account-btn");
const cloudLogoutBtn = document.getElementById("cloud-logout-btn");
const openPantryBtn = document.getElementById("open-pantry-btn");
const visitHomepageBtn = document.getElementById("visit-homepage-btn");
const extractBtn = document.getElementById("extract-btn");
const statusContainer = document.getElementById("status-container");
const statusViewport = document.getElementById("status-viewport");
const statusBadge = document.getElementById("status-badge");
const safeToCloseMsg = document.getElementById("safe-to-close-msg");
const errorContainer = document.getElementById("error-container");
const errorDetails = document.getElementById("error-details");
const btnBackSettings = document.getElementById("btn-back-settings");
const actionCard = document.querySelector(".action-card");
const settingsPanel = document.getElementById("settings-panel");

// ─── Key validation ───────────────────────────────────────────────────────────

/**
 * Returns the stored API key only if it's a plain string of reasonable length.
 * Rejects old encrypted-object values and base64 ciphertext blobs left over
 * from the previous crypto.ts key-encryption scheme.
 */
function getValidStoredKey(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    // Encrypted ciphertext would be base64 and far longer than any real API key
    if (value.length === 0 || value.length > 300) return undefined;
    return value;
}

// ─── Status messages ─────────────────────────────────────────────────────────

function addStatusMessage(text: string, isError: boolean = false, isComplete: boolean = false) {
    if (!statusViewport || !statusBadge) return;

    statusContainer?.classList.remove("hidden");
    statusViewport.classList.remove("hidden");
    statusBadge.textContent = isError ? "Extraction failed" : text;
    statusBadge.classList.remove("error", "done");
    if (isError) statusBadge.classList.add("error");
    else if (isComplete) statusBadge.classList.add("done");

    if (safeToCloseMsg) {
        if (!isError && !isComplete && (text.includes("Asking") || text.includes("tokens"))) {
            safeToCloseMsg.classList.remove("hidden");
        } else if (isError || isComplete) {
            safeToCloseMsg.classList.add("hidden");
        } else if (text.includes("Starting") || text.includes("Initializing")) {
            safeToCloseMsg.classList.add("hidden");
        }
    }

    if (isError && errorContainer && errorDetails) {
        errorContainer.classList.remove("hidden");
        errorDetails.textContent = text;
    } else if (!isError && errorContainer) {
        errorContainer.classList.add("hidden");
    }
}

// ─── Extraction ───────────────────────────────────────────────────────────────

async function executeExtraction(apiKey: string, llmModel: string, llmProvider: string, authMode: "cloud" | "byok") {
    addStatusMessage("Initializing background extraction...");

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
        addStatusMessage("Could not find active tab.", true);
        return;
    }

    console.log(`[MyPantry] Triggering background extraction for tab: ${tab.url}`);
    chrome.runtime.sendMessage({
        type: MSG.startExtraction,
        tabId: tab.id,
        url: tab.url,
        apiKey,
        llmModel,
        llmProvider,
        authMode,
    });
}

// ─── Clearance helper ─────────────────────────────────────────────────────────

async function clearAuthAndClose() {
    await removeLocal(AUTH_KEYS);
    window.close();
}

// ─── Init: auth state detection ───────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
    try {
        if (typeof chrome !== "undefined" && chrome.storage) {
            const data = await getLocal(["setupComplete", "plaintextApiKey", "supabaseToken", "identityMode", "apiMode"]);

            // Sanitize: if the stored key is not a valid plain string (old encrypted format),
            // clear it so the user is prompted to re-enter rather than getting silent 401s.
            const validKey = getValidStoredKey(data.plaintextApiKey);
            if (data.plaintextApiKey && !validKey) {
                await removeLocal(["plaintextApiKey"]);
            }

            const hasAuth =
                data.setupComplete || validKey || data.supabaseToken;

            if (!hasAuth) {
                chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") });
                return;
            }

            mainView?.classList.remove("hidden");

            const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
            const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
            if (supabaseUrl && supabaseAnonKey) {
                setLocal({ supabaseUrl, supabaseAnonKey });
            }

            // Backward compat: derive identityMode from token presence if not stored
            const identityMode: "google" | "anonymous" =
                data.identityMode ?? (data.supabaseToken ? "google" : "anonymous");

            const emailDisplay = document.getElementById("profile-email-display");
            const avatar = document.getElementById("profile-avatar") as HTMLImageElement;
            const anonIcon = document.getElementById("profile-anon-icon");

            if (identityMode === "google" && data.supabaseToken) {
                const payload = parseJwt(data.supabaseToken);
                if (payload?.email && emailDisplay) {
                    emailDisplay.textContent = payload.email;
                }
                if (payload?.user_metadata?.avatar_url && avatar) {
                    avatar.src = payload.user_metadata.avatar_url;
                    avatar.style.display = "block";
                    if (anonIcon) (anonIcon as HTMLElement).style.display = "none";
                }
                switchAccountBtn?.classList.remove("hidden");

                // Show API mode toggle for Google users
                const apiMode: "cloud" | "byok" =
                    data.apiMode ?? (data.supabaseToken ? "cloud" : "byok");
                if (switchApiModeBtn) {
                    switchApiModeBtn.textContent = apiMode === "cloud" ? "Switch to BYOK" : "Switch to Cloud";
                    switchApiModeBtn.classList.remove("hidden");
                }
            } else {
                if (emailDisplay) emailDisplay.textContent = "Anonymous";
            }
        }
    } catch (e) {
        console.warn("Storage check failed on load", e);
    }
});

// ─── Init: active extraction / already saved check ───────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
    try {
        if (typeof chrome !== "undefined" && chrome.tabs) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id) {
                const response = await chrome.runtime.sendMessage({
                    type: MSG.getExtractionStatus,
                    url: tab.url,
                });
                if (response?.isActive) {
                    extractBtn?.classList.add("hidden");
                    statusContainer?.classList.remove("hidden");
                    addStatusMessage(response.status || "Extracting in background...");
                }
            }
        }
    } catch (e) {
        console.warn("Could not check extraction status", e);
    }

    try {
        if (typeof chrome !== "undefined" && chrome.tabs && chrome.storage?.local) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.url) {
                const data = await getLocal(["savedUrls"]);
                const urls = data.savedUrls ?? [];
                const normTabUrl = tab.url.replace(/\/$/, "");
                if (urls.some((u) => u.replace(/\/$/, "") === normTabUrl)) {
                    if (extractBtn) {
                        extractBtn.textContent = "✓ Already Saved inside Pantry";
                        extractBtn.classList.remove("primary");
                        extractBtn.classList.add("outline");
                        (extractBtn as HTMLButtonElement).disabled = true;
                    }
                }
            }
        }
    } catch (e) {
        console.warn("Could not check saved status", e);
    }
});

// ─── BYOK settings form ───────────────────────────────────────────────────────

initializeByokForm({
    idPrefix: "popup-byok-",
    onSaveSuccess: () => {
        setTimeout(() => {
            if (actionCard && settingsPanel) {
                settingsPanel.classList.add("hidden");
                actionCard.classList.remove("hidden");
            }
        }, 600);
    },
    isSettingsMode: true,
});

// ─── Navigation buttons ───────────────────────────────────────────────────────

openPantryBtn?.addEventListener("click", () => {
    if (typeof chrome !== "undefined" && chrome.tabs) {
        chrome.tabs.create({ url: chrome.runtime.getURL("pantry.html") });
    } else {
        window.open("/pantry", "_blank");
    }
});

visitHomepageBtn?.addEventListener("click", () => {
    if (typeof chrome !== "undefined" && chrome.tabs) {
        chrome.tabs.create({ url: "https://mypantry.dev" });
    } else {
        window.open("https://mypantry.dev", "_blank");
    }
});

// ─── Auth buttons ─────────────────────────────────────────────────────────────

cloudLogoutBtn?.addEventListener("click", clearAuthAndClose);

switchApiModeBtn?.addEventListener("click", async () => {
    profileDropdownMenu?.classList.add("hidden");

    if (typeof chrome !== "undefined" && chrome.storage) {
        const { apiMode } = await getLocal(["apiMode"]);
        const currentMode: "cloud" | "byok" = apiMode ?? "cloud";
        const newMode: "cloud" | "byok" = currentMode === "cloud" ? "byok" : "cloud";

        await setLocal({ apiMode: newMode });

        if (switchApiModeBtn) {
            switchApiModeBtn.textContent = newMode === "cloud" ? "Switch to BYOK" : "Switch to Cloud";
        }
    }
});

switchAccountBtn?.addEventListener("click", async () => {
    if (typeof chrome !== "undefined" && chrome.storage) {
        await removeLocal(AUTH_KEYS);
        const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
        if (supabaseUrl && chrome.tabs) {
            const redirectTo = "https://mypantry.dev/api/auth/callback";
            const authUrl = `${supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}&prompt=consent`;
            chrome.tabs.create({ url: authUrl });
        }
        window.close();
    }
});

// ─── Profile dropdown ─────────────────────────────────────────────────────────

profileBadgeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    profileDropdownMenu?.classList.toggle("hidden");
});

document.addEventListener("click", (e) => {
    if (profileDropdownMenu?.classList.contains("hidden")) return;
    const rect = profileDropdownMenu!.getBoundingClientRect();
    const badgeRect = profileBadgeBtn?.getBoundingClientRect();
    const inside =
        e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    const onBadge = badgeRect
        ? e.clientX >= badgeRect.left &&
          e.clientX <= badgeRect.right &&
          e.clientY >= badgeRect.top &&
          e.clientY <= badgeRect.bottom
        : false;
    if (!inside && !onBadge) profileDropdownMenu!.classList.add("hidden");
});

// ─── Settings panel ───────────────────────────────────────────────────────────

apiSettingsBtn?.addEventListener("click", async () => {
    profileDropdownMenu?.classList.add("hidden");

    if (actionCard?.classList.contains("hidden")) {
        // Already open — close it
        settingsPanel?.classList.add("hidden");
        actionCard?.classList.remove("hidden");
        return;
    }

    if (!actionCard || !settingsPanel) return;

    const storageResult = await getLocal(["plaintextApiKey"]);

    actionCard.classList.add("hidden");
    settingsPanel.classList.remove("hidden");
    await loadByokSettings("popup-byok-", getValidStoredKey(storageResult.plaintextApiKey) || "");
});

btnBackSettings?.addEventListener("click", () => {
    if (actionCard && settingsPanel) {
        settingsPanel.classList.add("hidden");
        actionCard.classList.remove("hidden");
    }
});

// ─── Extract button ───────────────────────────────────────────────────────────

extractBtn?.addEventListener("click", async () => {
    if (extractBtn) {
        (extractBtn as HTMLButtonElement).disabled = true;
        extractBtn.textContent = "Loading...";
    }

    try {
        const storageResult = await getLocal(["plaintextApiKey", "supabaseToken", "llmModel", "llmProvider", "apiMode"]);

        // Backward compat: derive apiMode from token presence if not stored
        const apiMode: "cloud" | "byok" =
            storageResult.apiMode ?? (storageResult.supabaseToken ? "cloud" : "byok");

        const hasCloudMode = apiMode === "cloud" && !!storageResult.supabaseToken;
        const storedKey = getValidStoredKey(storageResult.plaintextApiKey);
        const hasPlaintextKey = apiMode === "byok" && !!storedKey;

        const llmModel = storageResult.llmModel || "gemini-2.5-flash";
        const llmProvider = storageResult.llmProvider || (hasCloudMode ? "google" : "anthropic");

        if (hasCloudMode || hasPlaintextKey) {
            extractBtn?.classList.add("hidden");
            statusContainer?.classList.remove("hidden");
            addStatusMessage("Starting extraction...");

            try {
                const activeKey = hasCloudMode ? storageResult.supabaseToken : storedKey;
                const authMode = hasCloudMode ? "cloud" : "byok";
                await executeExtraction(activeKey, llmModel, llmProvider, authMode);
            } catch (err: any) {
                let msg = err.message || "Unknown error occurred";
                if (msg.length > 80) msg = msg.substring(0, 80) + "...";
                addStatusMessage(`Error: ${msg}`, true);
            }
            return;
        }
    } catch (e: any) {
        console.error("Storage error", e);
    }

    // No key configured — open settings
    addStatusMessage("No API key configured. Please add one in API Settings.", true);
    if (extractBtn) {
        (extractBtn as HTMLButtonElement).disabled = false;
        extractBtn.textContent = "Extract & Add to Pantry";
    }
});

// ─── Background status listener ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: any) => {
    if (message.type !== MSG.extractionStatusUpdate) return;
    const { status, isError, isComplete } = message;
    addStatusMessage(status, isError, isComplete);

    if (isComplete || isError) {
        if (extractBtn) {
            (extractBtn as HTMLButtonElement).disabled = false;
            extractBtn.textContent = "Extract & Add to Pantry";
        }
    }
});
