/**
 * crypto.ts — AES-256-GCM encryption for tenant cloud credentials.
 *
 * Key: CREDENTIALS_ENCRYPTION_KEY env var (32-byte hex string = 64 hex chars).
 * Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Never stores credentials in plaintext. Each encryption uses a fresh random IV.
 *
 * G1-T3 (hardening):
 * - PRODUÇÃO (NODE_ENV=production): aceita SÓ chave 64-hex. Recusa o tier
 *   passphrase (scrypt) e o fallback dev inseguro — throw no boot/uso.
 * - key_version + rotação dual-key: `CREDENTIALS_ENCRYPTION_KEY` (v atual) +
 *   `CREDENTIALS_ENCRYPTION_KEY_PREV` (v-1). Decrypt tenta a versão do payload
 *   (ou ambas quando não versionado); encrypt sempre usa a atual e carimba
 *   `keyVersion`. Assim a rotação decripta com a antiga e re-encripta com a nova
 *   sem travar linhas pré-existentes.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LEN   = 32; // bytes
const IV_LEN    = 16; // bytes

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Deriva a Buffer da chave a partir de uma env, respeitando o hardening de prod. */
function deriveKey(raw: string, envName: string): Buffer {
  const v = (raw ?? "").trim();
  if (v.length === 64 && /^[0-9a-fA-F]+$/.test(v)) {
    return Buffer.from(v, "hex"); // 64 hex chars = 32 bytes (formato canônico)
  }
  if (isProd()) {
    throw new Error(
      `[Crypto] ${envName} inválida em produção — exige 64 hex chars (32 bytes). ` +
      "Gere com: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  // Fora de produção: tolera passphrase (scrypt) ou fallback dev, com aviso.
  if (v.length >= 16) return scryptSync(v, "zentriz-genesis-salt", KEY_LEN);
  console.warn(
    `[Crypto] ${envName} ausente/curta (dev). Set 64-hex em produção. Usando fallback INSEGURO de dev.`,
  );
  return scryptSync("dev-insecure-key-change-in-prod", "zentriz-genesis-salt", KEY_LEN);
}

/** Versão atual (2) e anterior (1). Versão anterior só existe se a env estiver setada. */
export const CURRENT_KEY_VERSION = 2;

function currentKey(): Buffer {
  return deriveKey(process.env.CREDENTIALS_ENCRYPTION_KEY ?? "", "CREDENTIALS_ENCRYPTION_KEY");
}

function previousKey(): Buffer | null {
  const raw = (process.env.CREDENTIALS_ENCRYPTION_KEY_PREV ?? "").trim();
  if (!raw) return null;
  return deriveKey(raw, "CREDENTIALS_ENCRYPTION_KEY_PREV");
}

/** Chamado no boot (index.ts) — falha cedo em produção se a chave for inválida. */
export function assertCryptoReady(): void {
  currentKey(); // throw em prod se inválida
  previousKey(); // valida a anterior se presente
}

export interface EncryptedPayload {
  encrypted: string;     // base64
  iv: string;            // hex
  tag: string;           // hex
  keyVersion?: number;   // versão da chave usada (ausente = legado v1/atual)
}

export function encryptCredentials(plaintext: string): EncryptedPayload {
  const key = currentKey();
  const iv  = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    encrypted:  encrypted.toString("base64"),
    iv:         iv.toString("hex"),
    tag:        tag.toString("hex"),
    keyVersion: CURRENT_KEY_VERSION,
  };
}

function tryDecryptWith(key: Buffer, payload: EncryptedPayload): string {
  const iv     = Buffer.from(payload.iv, "hex");
  const tag    = Buffer.from(payload.tag, "hex");
  const data   = Buffer.from(payload.encrypted, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf-8");
}

export function decryptCredentials(payload: EncryptedPayload): string {
  // Rotação: tenta a chave atual; se falhar (GCM auth error) e houver chave
  // anterior, tenta a anterior. Payloads pré-rotação são lidos transparentemente.
  try {
    return tryDecryptWith(currentKey(), payload);
  } catch (errCurrent) {
    const prev = previousKey();
    if (prev) {
      try {
        return tryDecryptWith(prev, payload);
      } catch { /* cai no throw abaixo */ }
    }
    throw errCurrent;
  }
}

/**
 * Rotação: re-encripta um payload com a chave ATUAL (usado por um job de rotação
 * que lê linhas com keyVersion antiga e regrava). Retorna null se já está atual.
 */
export function reencryptIfStale(payload: EncryptedPayload): EncryptedPayload | null {
  if (payload.keyVersion === CURRENT_KEY_VERSION) return null;
  const plaintext = decryptCredentials(payload);
  return encryptCredentials(plaintext);
}
