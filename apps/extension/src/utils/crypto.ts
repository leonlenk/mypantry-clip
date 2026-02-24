/**
 * Utility functions for securing sensitive data (like API keys) in the browser extension.
 * Operates entirely client-side using the native Web Crypto API.
 */

// We use PBKDF2 to derive a strong AES-GCM key from a user's password.
const ITERATIONS = 100000;
const KEY_LENGTH = 256;
const DIGEST = "SHA-256";

/**
 * Derives an AES-GCM key from a plaintext password and a salt.
 */
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveBits", "deriveKey"]
    );

    return window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt as BufferSource,
            iterations: ITERATIONS,
            hash: DIGEST,
        },
        keyMaterial,
        { name: "AES-GCM", length: KEY_LENGTH },
        false,
        ["encrypt", "decrypt"]
    );
}

/**
 * Encrypts a plaintext string using a master password.
 * Returns the cypher object containing the base64 encoded ciphertext, iv, and salt.
 */
export async function encryptData(plaintext: string, password: string) {
    const enc = new TextEncoder();
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));

    const key = await deriveKey(password, salt);

    const encryptedBuffer = await window.crypto.subtle.encrypt(
        {
            name: "AES-GCM",
            iv: iv as BufferSource,
        },
        key,
        enc.encode(plaintext)
    );

    return {
        ciphertext: bufferToBase64(encryptedBuffer),
        iv: bufferToBase64(iv),
        salt: bufferToBase64(salt),
    };
}

/**
 * Decrypts a cipher object using the master password.
 */
export async function decryptData(
    encryptedData: { ciphertext: string; iv: string; salt: string },
    password: string
): Promise<string> {
    const salt = base64ToBuffer(encryptedData.salt);
    const iv = base64ToBuffer(encryptedData.iv);
    const ciphertextStr = base64ToBuffer(encryptedData.ciphertext);

    const key = await deriveKey(password, salt);

    try {
        const decryptedBuffer = await window.crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: iv,
            },
            key,
            ciphertextStr
        );

        const dec = new TextDecoder();
        return dec.decode(decryptedBuffer);
    } catch (e) {
        throw new Error("Decryption failed. Incorrect password or corrupted data.");
    }
}

// Helpers for ArrayBuffer <-> Base64 conversion
function bufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function base64ToBuffer(base64: string): Uint8Array {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes;
}
