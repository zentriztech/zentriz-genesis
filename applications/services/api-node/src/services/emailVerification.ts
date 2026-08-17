/**
 * emailVerification.ts — códigos OTP de verificação de e-mail (cadastro de tenant).
 *
 * Guarda apenas o HASH do código (bcrypt) — nunca o código em claro. Um código:
 *   - expira em CODE_TTL_MS (15 min);
 *   - tem limite de MAX_ATTEMPTS tentativas de verificação;
 *   - é consumido (consumed_at) no primeiro acerto;
 *   - respeita um cooldown de reenvio (RESEND_COOLDOWN_MS).
 *
 * Ao gerar um novo código, os códigos anteriores não consumidos do mesmo (email,purpose)
 * são invalidados (consumidos) para evitar acúmulo/ambiguidade.
 *
 * O código em claro só é retornado por createVerificationCode() ao chamador (a rota),
 * que o envia por e-mail (SES). Nunca é logado nem persistido em claro.
 */
import crypto from "node:crypto";
import { pool } from "../db/client.js";
import { hashPassword, comparePassword } from "../auth.js";

export const CODE_TTL_MS = 15 * 60 * 1000; // 15 minutos
export const MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_MS = 60 * 1000; // 1 minuto entre reenvios
const DEFAULT_PURPOSE = "tenant_signup";

/** Gera um código numérico de 6 dígitos criptograficamente seguro. */
export function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export type CreateCodeResult =
  | { ok: true; code: string; expiresAt: Date }
  | { ok: false; reason: "cooldown"; retryAfterMs: number };

/**
 * Cria um novo código para (email, purpose). Aplica cooldown de reenvio e invalida
 * códigos anteriores não consumidos. Retorna o código em claro para envio por e-mail.
 */
export async function createVerificationCode(
  email: string,
  purpose: string = DEFAULT_PURPOSE,
): Promise<CreateCodeResult> {
  const normEmail = email.trim().toLowerCase();
  const client = await pool.connect();
  try {
    // Cooldown: existe código recente (não consumido) criado há menos de RESEND_COOLDOWN?
    const recent = await client.query(
      `SELECT created_at FROM email_verification_codes
       WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [normEmail, purpose],
    );
    if (recent.rows.length > 0) {
      const createdAt = new Date(recent.rows[0].created_at as string).getTime();
      const elapsed = Date.now() - createdAt;
      if (elapsed < RESEND_COOLDOWN_MS) {
        return { ok: false, reason: "cooldown", retryAfterMs: RESEND_COOLDOWN_MS - elapsed };
      }
    }

    const code = generateCode();
    const codeHash = await hashPassword(code);
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);

    await client.query("BEGIN");
    // Invalida códigos anteriores pendentes (consome sem uso).
    await client.query(
      `UPDATE email_verification_codes SET consumed_at = now()
       WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL`,
      [normEmail, purpose],
    );
    await client.query(
      `INSERT INTO email_verification_codes (email, code_hash, purpose, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [normEmail, codeHash, purpose, expiresAt],
    );
    await client.query("COMMIT");

    return { ok: true, code, expiresAt };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "expired" | "too_many_attempts" | "mismatch" };

/**
 * Verifica um código para (email, purpose). Consome no acerto. Conta tentativas e
 * invalida o código ao exceder MAX_ATTEMPTS.
 */
export async function verifyCode(
  email: string,
  code: string,
  purpose: string = DEFAULT_PURPOSE,
): Promise<VerifyResult> {
  const normEmail = email.trim().toLowerCase();
  const candidate = (code ?? "").trim();
  const client = await pool.connect();
  try {
    const row = await client.query(
      `SELECT id, code_hash, attempts, expires_at FROM email_verification_codes
       WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [normEmail, purpose],
    );
    if (row.rows.length === 0) {
      return { ok: false, reason: "not_found" };
    }
    const rec = row.rows[0] as { id: string; code_hash: string; attempts: number; expires_at: string };

    if (new Date(rec.expires_at).getTime() <= Date.now()) {
      await client.query(`UPDATE email_verification_codes SET consumed_at = now() WHERE id = $1`, [rec.id]);
      return { ok: false, reason: "expired" };
    }

    if (rec.attempts >= MAX_ATTEMPTS) {
      await client.query(`UPDATE email_verification_codes SET consumed_at = now() WHERE id = $1`, [rec.id]);
      return { ok: false, reason: "too_many_attempts" };
    }

    const match = candidate.length > 0 && (await comparePassword(candidate, rec.code_hash));
    if (!match) {
      const updated = await client.query(
        `UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
        [rec.id],
      );
      const attempts = (updated.rows[0]?.attempts as number) ?? rec.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await client.query(`UPDATE email_verification_codes SET consumed_at = now() WHERE id = $1`, [rec.id]);
        return { ok: false, reason: "too_many_attempts" };
      }
      return { ok: false, reason: "mismatch" };
    }

    await client.query(`UPDATE email_verification_codes SET consumed_at = now() WHERE id = $1`, [rec.id]);
    return { ok: true };
  } finally {
    client.release();
  }
}

/**
 * Invalida (consome sem uso) todos os códigos pendentes de (email,purpose). Usado
 * quando o envio do e-mail falha, para liberar reenvio imediato sem esbarrar no cooldown.
 */
export async function invalidatePending(email: string, purpose: string = DEFAULT_PURPOSE): Promise<void> {
  const normEmail = email.trim().toLowerCase();
  await pool.query(
    `UPDATE email_verification_codes SET consumed_at = now()
     WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL`,
    [normEmail, purpose],
  );
}

/**
 * Retorna true se (email,purpose) tem um código CONSUMIDO recentemente com sucesso —
 * usado por fluxos que separam "verificar código" de "criar conta". Não usado no fluxo
 * atômico atual (verify+create na mesma request), mas exposto para reuso.
 */
export async function hasRecentlyVerified(
  email: string,
  purpose: string = DEFAULT_PURPOSE,
  withinMs: number = CODE_TTL_MS,
): Promise<boolean> {
  const normEmail = email.trim().toLowerCase();
  const since = new Date(Date.now() - withinMs);
  const res = await pool.query(
    `SELECT 1 FROM email_verification_codes
     WHERE email = $1 AND purpose = $2 AND consumed_at IS NOT NULL AND consumed_at >= $3
     LIMIT 1`,
    [normEmail, purpose, since],
  );
  return res.rows.length > 0;
}
