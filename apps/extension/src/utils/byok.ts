import { encryptData } from "./crypto";

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

export async function fetchModels(
    selectProvider: HTMLSelectElement,
    selectModel: HTMLSelectElement,
    apiKey: string,
    preselectModelId?: string
) {
    const provider = selectProvider.value;

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

            if (preselectModelId) {
                // Check if the preselect option actually exists in the fetched list
                if (Array.from(selectModel.options).some(opt => opt.value === preselectModelId)) {
                    selectModel.value = preselectModelId;
                }
            }
        } else {
            selectModel.innerHTML = `<option value="">No valid models found</option>`;
            // If they are on OpenRouter they still need a way to input a custom one maybe, 
            // but for dropdown it's disabled
            selectModel.disabled = false;
        }

    } catch (err) {
        selectModel.innerHTML = `<option value="">Error loading models. Check API Key.</option>`;
        selectModel.disabled = false;
    }
}

export async function loadByokSettings(idPrefix: string, apiKey: string) {
    const selectProvider = document.getElementById(`${idPrefix}select-provider`) as HTMLSelectElement | null;
    const selectModel = document.getElementById(`${idPrefix}select-model`) as HTMLSelectElement | null;

    if (!selectProvider || !selectModel) return;

    const storageResult: Record<string, any> = await chrome.storage.local.get(["llmProvider", "llmModel"]);
    let currentModel = "";

    if (storageResult.llmProvider) selectProvider.value = storageResult.llmProvider;
    if (storageResult.llmModel) currentModel = storageResult.llmModel;

    await fetchModels(selectProvider, selectModel, apiKey, currentModel);
}

export interface ByokFormOptions {
    idPrefix: string;
    onSaveSuccess: (provider: string, model: string, isNewKey: boolean) => void | Promise<void>;
    isSettingsMode?: boolean;
    getPassword?: () => string;
}

export async function initializeByokForm(options: ByokFormOptions) {
    const { idPrefix, onSaveSuccess, isSettingsMode = false, getPassword } = options;

    const selectProvider = document.getElementById(`${idPrefix}select-provider`) as HTMLSelectElement | null;
    const selectModel = document.getElementById(`${idPrefix}select-model`) as HTMLSelectElement | null;
    const inputApiKey = document.getElementById(`${idPrefix}input-api-key`) as HTMLInputElement | null;
    // Password input might be hidden in settings mode, so we use getPassword if provided, otherwise fallback to DOM
    const inputPassword = document.getElementById(`${idPrefix}input-password`) as HTMLInputElement | null;
    const btnSubmit = document.getElementById(`${idPrefix}btn-submit`) as HTMLButtonElement | null;
    const statusMsg = document.getElementById(`${idPrefix}status-message`);
    const apiKeyHelp = document.getElementById(`${idPrefix}api-key-help`);

    if (!selectProvider || !selectModel || !inputApiKey || !btnSubmit) {
        console.warn("BYOK Form core elements not found for prefix:", idPrefix);
        return;
    }

    if (isSettingsMode) {
        if (apiKeyHelp) apiKeyHelp.classList.remove("hidden");
    } else {
        setTimeout(() => {
            fetchModels(selectProvider, selectModel, inputApiKey.value);
        }, 100);
    }

    selectProvider.addEventListener("change", () => {
        fetchModels(selectProvider, selectModel, inputApiKey.value);
    });

    inputApiKey.addEventListener("blur", () => {
        if (inputApiKey.value.trim().length > 0) {
            fetchModels(selectProvider, selectModel, inputApiKey.value);
        }
    });

    btnSubmit.addEventListener("click", async () => {
        const key = inputApiKey.value.trim();
        // If they provided a custom getPassword function (e.g. settings auth), use that, otherwise use the input
        const password = getPassword ? getPassword() : (inputPassword?.value || "");

        const provider = selectProvider.value;
        const model = selectModel.value;

        // Validation based on mode
        if (!isSettingsMode && !key) {
            if (statusMsg) {
                statusMsg.textContent = "API Key is required.";
                statusMsg.style.color = "#ef4444";
                statusMsg.classList.remove("hidden");
            }
            return;
        }

        btnSubmit.disabled = true;
        const origText = btnSubmit.textContent;
        btnSubmit.textContent = "Saving...";

        try {
            let storagePayload: any = {
                llmProvider: provider,
                llmModel: model
            };

            let isNewKey = false;

            if (key.length > 0) {
                isNewKey = true;
                if (password && password.length > 0) {
                    const encrypted = await encryptData(key, password);
                    storagePayload.encryptedApiKey = encrypted;
                    storagePayload.plaintextApiKey = null;
                } else {
                    storagePayload.plaintextApiKey = key;
                    storagePayload.encryptedApiKey = null;
                }

                // Clear any cached key since we are changing it
                chrome.runtime.sendMessage({ type: "CLEAR_CACHED_API_KEY" });
            }

            // Always clear supabase token if they are saving from a BYOK form explicitly
            if (!isSettingsMode) {
                storagePayload.supabaseToken = null;
                storagePayload.supabaseRefreshToken = null;
                storagePayload.setupComplete = true; // Mark setup as complete
                storagePayload.apiUrl = import.meta.env.PUBLIC_API_URL ?? "http://127.0.0.1:8000";
            }

            await chrome.storage.local.set(storagePayload);

            if (statusMsg) {
                statusMsg.textContent = "Settings saved!";
                statusMsg.style.color = "var(--color-accent)";
                statusMsg.classList.remove("hidden");
            }

            await onSaveSuccess(provider, model, isNewKey);

        } catch (e: any) {
            console.error("BYOK Save Error:", e);
            if (statusMsg) {
                statusMsg.textContent = "Failed to save: " + e.message;
                statusMsg.style.color = "#ef4444";
                statusMsg.classList.remove("hidden");
            }
        } finally {
            btnSubmit.disabled = false;
            btnSubmit.textContent = origText || "Save Key";
        }
    });
}
