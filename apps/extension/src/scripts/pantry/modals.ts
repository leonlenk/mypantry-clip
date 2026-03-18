/**
 * Pantry toast notification and confirmation/result modals.
 */

import feather from "feather-icons";
import { escapeHtml } from "../../utils/conversions";

// ─── DOM handles ─────────────────────────────────────────────────────────────

const pantryToastEl = document.getElementById("pantry-toast");
const shareConfirmOverlay = document.getElementById("share-confirm-overlay");
const shareConfirmList = document.getElementById("share-confirm-list");
const shareConfirmCancelBtn = document.getElementById("share-confirm-cancel");
const shareConfirmContinueBtn = document.getElementById("share-confirm-continue") as HTMLButtonElement | null;
const shareLinksOverlay = document.getElementById("share-links-overlay");
const shareLinksList = document.getElementById("share-links-list");
const shareLinksCloseBtn = document.getElementById("share-links-close");

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(message: string, type: "success" | "error" | "info" = "info", duration = 3500) {
    if (!pantryToastEl) return;
    if (toastTimer) clearTimeout(toastTimer);
    pantryToastEl.textContent = message;
    pantryToastEl.className = `pantry-toast toast-${type}`;
    toastTimer = setTimeout(() => {
        pantryToastEl.classList.add("hidden");
        toastTimer = null;
    }, duration);
}

// ─── Share Links Modal ────────────────────────────────────────────────────────

export function showShareLinksModal(urls: string[]) {
    if (!shareLinksOverlay || !shareLinksList || !shareLinksCloseBtn) return;

    shareLinksList.innerHTML = "";
    for (const url of urls) {
        const row = document.createElement("div");
        row.className = "share-link-row";

        const input = document.createElement("input");
        input.type = "text";
        input.readOnly = true;
        input.value = url;
        input.addEventListener("click", () => input.select());

        const copyBtn = document.createElement("button");
        copyBtn.className = "share-link-copy";
        copyBtn.textContent = "Copy";
        copyBtn.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(url);
                copyBtn.textContent = "Copied!";
                copyBtn.classList.add("copied");
                setTimeout(() => {
                    copyBtn.textContent = "Copy";
                    copyBtn.classList.remove("copied");
                }, 2000);
            } catch {
                input.select();
            }
        });

        row.appendChild(input);
        row.appendChild(copyBtn);
        shareLinksList.appendChild(row);
    }

    shareLinksOverlay.classList.remove("hidden");

    const close = () => {
        shareLinksOverlay.classList.add("hidden");
        shareLinksCloseBtn.removeEventListener("click", close);
        shareLinksOverlay.removeEventListener("click", onOverlay);
        document.removeEventListener("keydown", onKey);
    };
    const onOverlay = (e: MouseEvent) => { if (e.target === shareLinksOverlay) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };

    shareLinksCloseBtn.addEventListener("click", close);
    shareLinksOverlay.addEventListener("click", onOverlay);
    document.addEventListener("keydown", onKey);
}

// ─── Share Confirm Modal ──────────────────────────────────────────────────────

export function confirmShareModal(initialIds: string[], initialTitles: string[]): Promise<string[]> {
    return new Promise((resolve) => {
        const overlay = shareConfirmOverlay;
        const list = shareConfirmList;
        const cancelBtn = shareConfirmCancelBtn;
        const continueBtn = shareConfirmContinueBtn;
        if (!overlay || !list || !cancelBtn || !continueBtn) { resolve(initialIds); return; }

        const xIcon = feather.icons["x"]?.toSvg({ width: 14, height: 14 }) ?? "×";
        const pending = new Map<string, string>(initialIds.map((id, i) => [id, initialTitles[i]]));

        const renderList = () => {
            list.innerHTML = "";
            pending.forEach((title, id) => {
                const li = document.createElement("li");
                li.dataset.id = id;
                li.innerHTML = `<span>${escapeHtml(title)}</span><button class="delete-list-remove" title="Remove from list">${xIcon}</button>`;
                li.querySelector("button")!.addEventListener("click", () => {
                    pending.delete(id);
                    if (pending.size === 0) { onCancel(); return; }
                    renderList();
                    continueBtn.textContent = `Share ${pending.size}`;
                });
                list.appendChild(li);
            });
        };

        renderList();
        continueBtn.textContent = `Share ${pending.size}`;
        overlay.classList.remove("hidden");

        const cleanup = () => {
            overlay.classList.add("hidden");
            cancelBtn.removeEventListener("click", onCancel);
            continueBtn!.removeEventListener("click", onConfirm);
            overlay.removeEventListener("click", onOverlayClick);
            document.removeEventListener("keydown", onKeyDown);
        };
        const onCancel = () => { cleanup(); resolve([]); };
        const onConfirm = () => { cleanup(); resolve(Array.from(pending.keys())); };
        const onOverlayClick = (e: MouseEvent) => { if (e.target === overlay) onCancel(); };
        const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };

        cancelBtn.addEventListener("click", onCancel);
        continueBtn.addEventListener("click", onConfirm);
        overlay.addEventListener("click", onOverlayClick);
        document.addEventListener("keydown", onKeyDown);
    });
}

// ─── Delete Confirm Modal ─────────────────────────────────────────────────────

export function confirmDeleteModal(initialIds: string[], initialTitles: string[]): Promise<string[]> {
    return new Promise((resolve) => {
        const overlay = document.getElementById("delete-confirm-overlay");
        const list = document.getElementById("delete-confirm-list");
        const cancelBtn = document.getElementById("delete-confirm-cancel");
        const continueBtn = document.getElementById("delete-confirm-continue") as HTMLButtonElement | null;
        if (!overlay || !list || !cancelBtn || !continueBtn) { resolve(initialIds); return; }

        const xIcon = feather.icons["x"]?.toSvg({ width: 14, height: 14 }) ?? "×";
        const pending = new Map<string, string>(initialIds.map((id, i) => [id, initialTitles[i]]));

        const renderList = () => {
            list.innerHTML = "";
            pending.forEach((title, id) => {
                const li = document.createElement("li");
                li.dataset.id = id;
                li.innerHTML = `<span>${escapeHtml(title)}</span><button class="delete-list-remove" title="Remove from list">${xIcon}</button>`;
                li.querySelector("button")!.addEventListener("click", () => {
                    pending.delete(id);
                    if (pending.size === 0) { onCancel(); return; }
                    renderList();
                    if (continueBtn) continueBtn.textContent = `Delete ${pending.size}`;
                });
                list.appendChild(li);
            });
        };

        renderList();
        continueBtn.textContent = `Delete ${pending.size}`;
        overlay.classList.remove("hidden");

        const cleanup = () => {
            overlay.classList.add("hidden");
            cancelBtn.removeEventListener("click", onCancel);
            continueBtn!.removeEventListener("click", onConfirm);
            overlay.removeEventListener("click", onOverlayClick);
            document.removeEventListener("keydown", onKeyDown);
        };
        const onCancel = () => { cleanup(); resolve([]); };
        const onConfirm = () => { cleanup(); resolve(Array.from(pending.keys())); };
        const onOverlayClick = (e: MouseEvent) => { if (e.target === overlay) onCancel(); };
        const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };

        cancelBtn.addEventListener("click", onCancel);
        continueBtn.addEventListener("click", onConfirm);
        overlay.addEventListener("click", onOverlayClick);
        document.addEventListener("keydown", onKeyDown);
    });
}
