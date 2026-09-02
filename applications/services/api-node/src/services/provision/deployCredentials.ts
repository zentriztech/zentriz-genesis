/**
 * deployCredentials.ts — Política BYOC (bring-your-own-cloud) para o pipeline autônomo.
 *
 * Decide a ORIGEM da credencial AWS que o pipeline usa para empurrar artefatos (ECR / S3):
 * a conta do PRÓPRIO tenant (BYOC), a conta da Zentriz (exceção whitelisted / legado), ou
 * BLOQUEAR quando não há conta configurada. É o ponto único que os dois caminhos de deploy
 * (deployBackendCloud e s3StaticDeploy) consultam antes de disparar o full-test-server.
 *
 * Requisito (Jean, 2026-09-02): "o pipeline autônomo NÃO deve empurrar produtos para ECR
 * nenhum, exceto quando o tenant tem a própria conta Cloud configurada — cada um usa a sua.
 * Cabral Org e Salif Org são exceção (representantes EU testando o Genesis para a Zentriz):
 * as contas-tenant deles podem empurrar usando a conta designada da Zentriz."
 *
 * ── "Virar a chave" (feature flag) ────────────────────────────────────────────────────────
 * GENESIS_BYOC_ENFORCED (default OFF). Enquanto OFF, o comportamento é BYTE-IDÊNTICO ao legado
 * (todos os tenants empurram na conta da Zentriz via credencial de ambiente) — zero regressão.
 * Quando ligada (ON), a política BYOC passa a valer e o fail-closed entra em ação. O rollback é
 * simplesmente desligar a flag. GENESIS_BYOC_EXEMPT_TENANTS = lista de tenant UUIDs (CSV) que
 * podem usar a conta da Zentriz (Cabral/Salif) mesmo sem conta própria.
 */

import { getAwsDeployCredentials, type AwsDeployCredentials } from "../cloudConnector.js";

export type DeployCredsDecision =
  /** Tenant tem conta AWS própria usável → empurra na conta DELE (BYOC). */
  | { source: "tenant"; accessKeyId: string; secretAccessKey: string; region: string | null; roleArn: string | null }
  /** Tenant na whitelist (Cabral/Salif) sem conta própria → usa a conta designada da Zentriz. */
  | { source: "zentriz-whitelist" }
  /** Flag OFF → comportamento legado (conta Zentriz para todos). */
  | { source: "zentriz-fallback" }
  /** Fail-closed: não empurra para lugar nenhum (razão exibível ao usuário). */
  | { source: "blocked"; reason: string };

const TRUTHY = /^(1|true|yes|on)$/i;

/** A "chave": quando ligada, a política BYOC passa a valer (fail-closed). Default OFF. */
export function isByocEnforced(): boolean {
  return TRUTHY.test((process.env.GENESIS_BYOC_ENFORCED ?? "").trim());
}

/** Tenants autorizados a usar a conta da Zentriz sem conta própria (Cabral/Salif). CSV de UUIDs. */
export function isTenantExempt(tenantId: string): boolean {
  const raw = (process.env.GENESIS_BYOC_EXEMPT_TENANTS ?? "").trim();
  if (!raw) return false;
  const exempt = new Set(
    raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  return exempt.has(tenantId.trim().toLowerCase());
}

/**
 * Resolve a origem da credencial de push para um tenant. Só consulta o banco quando a flag
 * está ligada (o caminho legado não faz query nova — preserva latência/comportamento atuais).
 */
export async function resolveDeployCredentials(tenantId: string): Promise<DeployCredsDecision> {
  // "Antes de virar a chave": flag OFF ⇒ legado byte-idêntico (conta Zentriz para todos).
  if (!isByocEnforced()) return { source: "zentriz-fallback" };

  // Flag ON — BYOC obrigatório. Tenant com credencial própria usável → empurra na conta dele.
  const tenantCreds: AwsDeployCredentials | null = await getAwsDeployCredentials(tenantId);
  if (tenantCreds && tenantCreds.accessKeyId && tenantCreds.secretAccessKey) {
    return {
      source: "tenant",
      accessKeyId: tenantCreds.accessKeyId,
      secretAccessKey: tenantCreds.secretAccessKey,
      region: tenantCreds.region,
      roleArn: tenantCreds.roleArn,
    };
  }

  // Conexão só-role (cross-account): o runner do host ainda NÃO faz AssumeRole (GATE 2 pendente).
  // Fail-closed — nunca cair silenciosamente na conta da Zentriz por causa de chaves vazias.
  if (tenantCreds && tenantCreds.roleArn) {
    return {
      source: "blocked",
      reason:
        "A conexão AWS deste tenant é cross-account (role) e o pipeline ainda não assume role " +
        "(GATE 2 pendente). Cadastre chaves de acesso na conexão de Cloud para publicar.",
    };
  }

  // Sem conta própria: a whitelist (Cabral/Salif — representantes EU testando p/ a Zentriz)
  // pode usar a conta designada da Zentriz.
  if (isTenantExempt(tenantId)) return { source: "zentriz-whitelist" };

  // Caso contrário: não empurra para ECR/S3 nenhum.
  return {
    source: "blocked",
    reason:
      "Nenhuma conta Cloud configurada para este tenant. Configure sua conta em " +
      "Configurações → Cloud para publicar o produto na sua própria conta.",
  };
}
