/**
 * dnsConfig.ts — G1-T18 (Fase C). Config de domínio/hosted zone do provisionamento.
 *
 * GATE 1: tudo na conta Zentriz. O subdomínio de deploy e a hosted zone vêm de env:
 *   GENESIS_DEPLOY_DOMAIN     — zona base (default "deploys.zentriz.com.br")
 *   GENESIS_DEPLOY_HOSTED_ZONE_ID — Route53 hosted zone id da zona base
 *
 * O hostname final de um deployment é determinístico: <slug>.<GENESIS_DEPLOY_DOMAIN>.
 * Sem hosted zone configurada, o driver route53 opera em modo no-op explícito (o ALB
 * ainda sobe com DNS name próprio da AWS — útil em dev/homolog sem zona dedicada).
 */

import type { ProvisionContext } from "./provisionChain.js";

export function deployDomain(): string {
  return (process.env.GENESIS_DEPLOY_DOMAIN ?? "deploys.zentriz.com.br").trim().replace(/^\.+|\.+$/g, "");
}

export function hostedZoneId(): string | undefined {
  const v = (process.env.GENESIS_DEPLOY_HOSTED_ZONE_ID ?? "").trim();
  return v || undefined;
}

/** Hostname público determinístico do deployment (<slug>.<domain>). */
export function appHostname(ctx: ProvisionContext): string {
  return `${ctx.deploymentId.slice(0, 12)}.${deployDomain()}`;
}
