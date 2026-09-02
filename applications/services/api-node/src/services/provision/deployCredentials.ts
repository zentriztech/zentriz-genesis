/**
 * deployCredentials.ts — Política de origem da credencial para o pipeline autônomo (host/FTS).
 *
 * Modelo (Jean, 2026-09-02): "nada dos produtos Zentriz deve viver em outras contas — tudo na
 * conta Zentriz. Quando o cliente configura o cloud dele (AWS/Azure/GCP), a conta que ele
 * configura recebe o Deploy (Demo/Prod) VIA GITHUB ACTIONS. Atualmente, na conta da Zentriz,
 * apenas quem está na whitelist."
 *
 * Consequência para o PIPELINE DO HOST (full-test-server → S3 estático / build ECR):
 *   • O host SEMPRE publica na conta da Zentriz (via instance role da EC2 / chaves dedicadas 820).
 *   • Só os tenants da WHITELIST podem usar essa infra da Zentriz pelo host.
 *   • Qualquer outro tenant é BLOQUEADO neste caminho — o deploy no cloud PRÓPRIO dele acontece
 *     por GitHub Actions (com os secrets sincronizados), NÃO pelo push do host.
 *
 * Não existe mais "empurrar na conta do tenant pelo host" (o antigo source "tenant") nem
 * AssumeRole cross-account no runner (o antigo GATE 2): cross-account é responsabilidade do
 * GitHub Actions, não do host.
 *
 * ── "Virar a chave" (feature flag) ────────────────────────────────────────────────────────
 * GENESIS_BYOC_ENFORCED (default OFF). Enquanto OFF, o comportamento é BYTE-IDÊNTICO ao legado
 * (todos empurram na conta da Zentriz via credencial de ambiente) — zero regressão. Quando ON,
 * a whitelist passa a ser o único portão do host para a conta da Zentriz e o fail-closed vale.
 * Rollback = desligar a flag.
 */

import { pool } from "../../db/client.js";

export type DeployCredsDecision =
  /** Tenant na whitelist → o host publica na conta designada da Zentriz. */
  | { source: "zentriz-whitelist" }
  /** Flag OFF → comportamento legado (conta Zentriz para todos). */
  | { source: "zentriz-fallback" }
  /** Fail-closed: o host não publica (o cloud do cliente é servido por GitHub Actions). */
  | { source: "blocked"; reason: string };

const TRUTHY = /^(1|true|yes|on)$/i;

/** A "chave": quando ligada, a política de whitelist passa a valer (fail-closed). Default OFF. */
export function isByocEnforced(): boolean {
  return TRUTHY.test((process.env.GENESIS_BYOC_ENFORCED ?? "").trim());
}

/**
 * Whitelist via env var (CSV de UUIDs) — mantida como fallback/retrocompat. Síncrona.
 * A fonte primária passou a ser a coluna `tenants.byoc_exempt` (gerenciável pelo Portal).
 */
export function isTenantExemptEnv(tenantId: string): boolean {
  const raw = (process.env.GENESIS_BYOC_EXEMPT_TENANTS ?? "").trim();
  if (!raw) return false;
  const exempt = new Set(
    raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  return exempt.has(tenantId.trim().toLowerCase());
}

/**
 * Tenant autorizado a usar a conta da Zentriz pelo host. Verdadeiro se estiver na coluna
 * `tenants.byoc_exempt` (gerenciável no Portal por zentriz_admin) OU na env CSV (fallback).
 * A env é checada primeiro (barata, sem tocar o banco); erro no banco degrada para "não isento".
 */
export async function isTenantExempt(tenantId: string): Promise<boolean> {
  if (isTenantExemptEnv(tenantId)) return true;
  try {
    const { rows } = await pool.query<{ byoc_exempt: boolean }>(
      `SELECT byoc_exempt FROM tenants WHERE id = $1`,
      [tenantId],
    );
    return rows[0]?.byoc_exempt === true;
  } catch {
    // Fail-closed: não elevar para isento por causa de erro de banco.
    return false;
  }
}

/**
 * Resolve a origem da credencial de push para um tenant no pipeline do HOST. Só consulta a
 * whitelist quando a flag está ligada (o caminho legado não faz query nova — preserva a
 * latência/comportamento atuais).
 */
export async function resolveDeployCredentials(tenantId: string): Promise<DeployCredsDecision> {
  // "Antes de virar a chave": flag OFF ⇒ legado byte-idêntico (conta Zentriz para todos).
  if (!isByocEnforced()) return { source: "zentriz-fallback" };

  // Flag ON — só a whitelist usa a infra da Zentriz pelo host.
  if (await isTenantExempt(tenantId)) return { source: "zentriz-whitelist" };

  // Qualquer outro tenant: o host NÃO publica. O cloud próprio do cliente recebe o deploy
  // (Demo/Prod) por GitHub Actions.
  return {
    source: "blocked",
    reason:
      "O deploy pela infraestrutura da Zentriz é restrito à whitelist. O cloud próprio do seu " +
      "tenant (AWS/Azure/GCP) recebe o deploy (Demo/Prod) via GitHub Actions — configure-o em " +
      "Configurações → Cloud.",
  };
}
