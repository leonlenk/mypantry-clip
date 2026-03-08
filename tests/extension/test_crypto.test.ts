/**
 * Tests for src/utils/crypto.ts — PBKDF2 + AES-GCM encrypt/decrypt.
 *
 * Uses Node's webcrypto (bridged via setupTests.ts) to exercise the
 * real cryptographic operations without a browser.
 */

import { describe, it, expect } from "vitest";
import {
    encryptData,
    decryptData,
} from "../../apps/extension/src/utils/crypto";

describe("encryptData / decryptData", () => {
    const PASSWORD = "correct-horse-battery-staple";

    it("round-trips a plaintext string through encrypt → decrypt", async () => {
        const plaintext = "sk-abc123-secret-api-key";
        const encrypted = await encryptData(plaintext, PASSWORD);
        const decrypted = await decryptData(encrypted, PASSWORD);
        expect(decrypted).toBe(plaintext);
    });

    it("round-trips an empty string", async () => {
        const encrypted = await encryptData("", PASSWORD);
        const decrypted = await decryptData(encrypted, PASSWORD);
        expect(decrypted).toBe("");
    });

    it("round-trips unicode content", async () => {
        const plaintext = "🍳 Ñoño crème brûlée 日本語";
        const encrypted = await encryptData(plaintext, PASSWORD);
        const decrypted = await decryptData(encrypted, PASSWORD);
        expect(decrypted).toBe(plaintext);
    });

    it("produces output with ciphertext, iv, and salt fields", async () => {
        const encrypted = await encryptData("test", PASSWORD);
        expect(encrypted).toHaveProperty("ciphertext");
        expect(encrypted).toHaveProperty("iv");
        expect(encrypted).toHaveProperty("salt");
        // All should be non-empty base64 strings
        expect(encrypted.ciphertext.length).toBeGreaterThan(0);
        expect(encrypted.iv.length).toBeGreaterThan(0);
        expect(encrypted.salt.length).toBeGreaterThan(0);
    });

    it("produces different ciphertexts for the same plaintext (random IV/salt)", async () => {
        const enc1 = await encryptData("same-key", PASSWORD);
        const enc2 = await encryptData("same-key", PASSWORD);
        // IV and salt are random, so ciphertexts should differ
        expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    });

    it("fails to decrypt with the wrong password", async () => {
        const encrypted = await encryptData("secret", PASSWORD);
        await expect(decryptData(encrypted, "wrong-password")).rejects.toThrow(
            /Decryption failed/
        );
    });

    it("round-trips a long string (>1KB)", async () => {
        const long = "A".repeat(2000);
        const encrypted = await encryptData(long, PASSWORD);
        const decrypted = await decryptData(encrypted, PASSWORD);
        expect(decrypted).toBe(long);
    });
});
