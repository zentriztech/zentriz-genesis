import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { pool } from "../db/client.js";
import { initDb } from "../db/init.js";
import {
  createVerificationCode,
  verifyCode,
  invalidatePending,
  MAX_ATTEMPTS,
} from "./emailVerification.js";

// Testes que exigem Postgres. Sem DB (ex.: gate local), pulam graciosamente — mesmo
// padrão de integration.test.ts. Em CI com Postgres, exercitam a lógica de verdade.
let dbAvailable = false;
const EMAIL = "otp-test@exemplo.com";
const PURPOSE = "tenant_signup";

async function purge() {
  await pool.query("DELETE FROM email_verification_codes WHERE email = $1", [EMAIL]);
}

describe("emailVerification — OTP (cap atômico, cooldown, invalidate)", () => {
  beforeAll(async () => {
    try {
      await initDb();
      await pool.query("SELECT 1 FROM email_verification_codes LIMIT 1");
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  beforeEach(async () => {
    if (dbAvailable) await purge();
  });

  it("verifyCode: acerto consome e retorna ok", async () => {
    if (!dbAvailable) return;
    const created = await createVerificationCode(EMAIL, PURPOSE);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const res = await verifyCode(EMAIL, created.code, PURPOSE);
    expect(res.ok).toBe(true);
    // Segundo uso do mesmo código falha (consumido).
    const again = await verifyCode(EMAIL, created.code, PURPOSE);
    expect(again.ok).toBe(false);
  });

  it("verifyCode: erra MAX_ATTEMPTS vezes → too_many_attempts e trava", async () => {
    if (!dbAvailable) return;
    const created = await createVerificationCode(EMAIL, PURPOSE);
    if (!created.ok) return;
    const reasons: string[] = [];
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const r = await verifyCode(EMAIL, "000000", PURPOSE); // errado (assumindo != código real)
      if (!r.ok) reasons.push(r.reason);
    }
    // As primeiras são mismatch; a última bate no cap.
    expect(reasons[reasons.length - 1]).toBe("too_many_attempts");
    // Após travar, nem o código correto passa (foi consumido).
    const correct = await verifyCode(EMAIL, created.code, PURPOSE);
    expect(correct.ok).toBe(false);
  });

  it("cap atômico: verificações concorrentes não excedem MAX comparações válidas", async () => {
    if (!dbAvailable) return;
    const created = await createVerificationCode(EMAIL, PURPOSE);
    if (!created.ok) return;
    // Dispara 20 verificações erradas concorrentes. Só até MAX podem ser "mismatch";
    // o resto deve ser too_many_attempts (a corrida é serializada no UPDATE atômico).
    const results = await Promise.all(
      Array.from({ length: 20 }, () => verifyCode(EMAIL, "999999", PURPOSE)),
    );
    const mismatches = results.filter((r) => !r.ok && r.reason === "mismatch").length;
    expect(mismatches).toBeLessThanOrEqual(MAX_ATTEMPTS);
  });

  it("cooldown: reenvio imediato é bloqueado", async () => {
    if (!dbAvailable) return;
    const a = await createVerificationCode(EMAIL, PURPOSE);
    expect(a.ok).toBe(true);
    const b = await createVerificationCode(EMAIL, PURPOSE);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("cooldown");
  });

  it("cooldown considera código CONSUMIDO (fecha bypass de bombardeio)", async () => {
    if (!dbAvailable) return;
    const a = await createVerificationCode(EMAIL, PURPOSE);
    if (!a.ok) return;
    // Consome com sucesso.
    await verifyCode(EMAIL, a.code, PURPOSE);
    // Mesmo consumido, um novo pedido dentro da janela ainda respeita o cooldown.
    const b = await createVerificationCode(EMAIL, PURPOSE);
    expect(b.ok).toBe(false);
  });

  it("invalidatePending APAGA pendentes e libera reenvio imediato (path de falha de envio)", async () => {
    if (!dbAvailable) return;
    const a = await createVerificationCode(EMAIL, PURPOSE);
    expect(a.ok).toBe(true);
    await invalidatePending(EMAIL, PURPOSE);
    const b = await createVerificationCode(EMAIL, PURPOSE);
    expect(b.ok).toBe(true); // sem cooldown, pois a linha foi apagada
  });
});
