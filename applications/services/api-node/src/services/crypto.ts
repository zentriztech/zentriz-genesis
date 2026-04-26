/**
 * crypto.ts — AES-256-GCM encryption for tenant cloud credentials.
 *
 * Key: CREDENTIALS_ENCRYPTION_KEY env var (32-byte hex string = 64 hex chars).
 * Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Never stores credentials in plaintext. Each encryption uses a fresh random IV.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LEN   = 32; // bytes
const IV_LEN    = 16; // bytes
const TAG_LEN   = 16; // bytes (GCM auth tag)

function getKey(): Buffer {
  const raw = (process.env.CREDENTIALS_ENCRYPTION_KEY ?? "").trim();
  if (raw.length === 64) {
    // 64 hex chars = 32 bytes
    return Buffer.from(raw, "hex");
  }
  if (raw.length >= 16) {
    // Derive from passphrase using scrypt
    return scryptSync(raw, "zentriz-genesis-salt", KEY_LEN);
  }
  // Development fallback — warn loudly
  console.warn(
    "[Crypto] CREDENTIALS_ENCRYPTION_KEY not set or too short. " +
    "Set a 64-char hex key: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
  return scryptSync("dev-insecure-key-change-in-prod", "zentriz-genesis-salt", KEY_LEN);
}

export interface EncryptedPayload {
  encrypted: string; // base64
  iv: string;        // hex
  tag: string;       // hex
}

export function encryptCredentials(plaintext: string): EncryptedPayload {
  const key = getKey();
  const iv  = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    encrypted: encrypted.toString("base64"),
    iv:        iv.toString("hex"),
    tag:       tag.toString("hex"),
  };
}

export function decryptCredentials(payload: EncryptedPayload): string {
  const key    = getKey();
  const iv     = Buffer.from(payload.iv, "hex");
  const tag    = Buffer.from(payload.tag, "hex");
  const data   = Buffer.from(payload.encrypted, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf-8");
}
