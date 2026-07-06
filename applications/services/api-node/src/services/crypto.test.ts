/**
 * G1-T3: crypto — hardening (fail-closed em prod) + rotação dual-key.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const HEX_A = "a".repeat(64); // chave válida 64-hex (v atual)
const HEX_B = "b".repeat(64); // chave válida 64-hex (v anterior)

async function freshCrypto() {
  // re-importa o módulo para reavaliar as envs (getKey lê process.env a cada uso, então basta importar)
  return await import("./crypto.js");
}

describe("crypto hardening + rotação", () => {
  const saved = { key: process.env.CREDENTIALS_ENCRYPTION_KEY, prev: process.env.CREDENTIALS_ENCRYPTION_KEY_PREV, env: process.env.NODE_ENV };
  beforeEach(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = HEX_A;
    delete process.env.CREDENTIALS_ENCRYPTION_KEY_PREV;
    process.env.NODE_ENV = "test";
  });
  afterEach(() => {
    if (saved.key) process.env.CREDENTIALS_ENCRYPTION_KEY = saved.key; else delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    if (saved.prev) process.env.CREDENTIALS_ENCRYPTION_KEY_PREV = saved.prev; else delete process.env.CREDENTIALS_ENCRYPTION_KEY_PREV;
    if (saved.env) process.env.NODE_ENV = saved.env; else delete process.env.NODE_ENV;
  });

  it("round-trip encrypt/decrypt com chave 64-hex", async () => {
    const { encryptCredentials, decryptCredentials, CURRENT_KEY_VERSION } = await freshCrypto();
    const p = encryptCredentials(JSON.stringify({ api_key: "segredo" }));
    expect(p.keyVersion).toBe(CURRENT_KEY_VERSION);
    expect(JSON.parse(decryptCredentials(p)).api_key).toBe("segredo");
  });

  it("PRODUÇÃO: chave inválida (não 64-hex) lança erro (fail-closed)", async () => {
    process.env.NODE_ENV = "production";
    process.env.CREDENTIALS_ENCRYPTION_KEY = "curta";
    const { encryptCredentials } = await freshCrypto();
    expect(() => encryptCredentials("x")).toThrow(/64 hex/);
  });

  it("PRODUÇÃO: chave 64-hex válida NÃO lança", async () => {
    process.env.NODE_ENV = "production";
    process.env.CREDENTIALS_ENCRYPTION_KEY = HEX_A;
    const { encryptCredentials, decryptCredentials } = await freshCrypto();
    const p = encryptCredentials("ok");
    expect(decryptCredentials(p)).toBe("ok");
  });

  it("fora de produção: passphrase (scrypt) ainda funciona", async () => {
    process.env.NODE_ENV = "test";
    process.env.CREDENTIALS_ENCRYPTION_KEY = "uma-passphrase-de-dev-16+";
    const { encryptCredentials, decryptCredentials } = await freshCrypto();
    expect(decryptCredentials(encryptCredentials("dev"))).toBe("dev");
  });

  it("rotação dual-key: payload cifrado com a chave ANTERIOR ainda descriptografa", async () => {
    // 1) cifra com HEX_B como chave atual
    process.env.CREDENTIALS_ENCRYPTION_KEY = HEX_B;
    let mod = await freshCrypto();
    const old = mod.encryptCredentials("dado-antigo");
    // 2) rotaciona: HEX_A vira atual, HEX_B vira anterior
    process.env.CREDENTIALS_ENCRYPTION_KEY = HEX_A;
    process.env.CREDENTIALS_ENCRYPTION_KEY_PREV = HEX_B;
    mod = await freshCrypto();
    // decrypt do payload antigo funciona (via chave anterior)
    expect(mod.decryptCredentials(old)).toBe("dado-antigo");
    // reencryptIfStale regrava com a chave atual
    const rotated = mod.reencryptIfStale({ ...old, keyVersion: 1 });
    expect(rotated).not.toBeNull();
    expect(mod.decryptCredentials(rotated!)).toBe("dado-antigo");
  });

  it("assertCryptoReady lança em prod sem chave válida", async () => {
    process.env.NODE_ENV = "production";
    process.env.CREDENTIALS_ENCRYPTION_KEY = "";
    const { assertCryptoReady } = await freshCrypto();
    expect(() => assertCryptoReady()).toThrow();
  });
});
