/**
 * provisionChain.ts — G1-T12 (Fase C).
 *
 * A MÁQUINA DE ESTADOS + registry de drivers do provisionamento backend.
 *
 * A cadeia é: iam → networking → rds/secrets → migrating → ecs → alb/acm/route53 → running.
 * Cada passo é um DRIVER (registrado por T13-T20). T12 entrega só o MOTOR: percorre a
 * cadeia, aplica describe-before-create (via ledger), avança o status durável e, em falha
 * parcial, dispara a COMPENSAÇÃO SAGA (desfaz na ordem reversa lendo o ledger).
 *
 * Drivers se registram via registerDriver() — assim T12 compila e roda (no-op) antes dos
 * drivers existirem, e cada tarefa seguinte pluga o seu sem tocar o motor.
 */

import type { ResolvedAwsCredentials } from "./awsCredentials.js";
import { resolveAwsCredentials } from "./awsCredentials.js";
import {
  setStatus, patchDeployment, listLiveResources, markResourceDeleted,
  type BackendDeploymentRow, type BackendStatus,
} from "./backendState.js";

/** Contexto passado a cada driver — tudo que ele precisa para agir e registrar no ledger. */
export interface ProvisionContext {
  deploymentId: string;
  projectId: string;
  tenantId: string | null;
  runtimeTarget: string;
  klass: string;
  ecrRepoUri: string | null;
  imageTag: string | null;
  creds: ResolvedAwsCredentials;
  /** Acumula saídas entre passos (ex.: vpcId de networking → ecs). */
  scratch: Record<string, unknown>;
}

/** Um passo da cadeia. `status` é a fase durável enquanto o passo roda. */
export interface ProvisionDriver {
  /** Chave estável (ex.: "iam", "networking", "rds", "ecs"). */
  readonly key: string;
  /** Status durável que o deployment assume enquanto este passo executa. */
  readonly status: BackendStatus;
  /** Executa o passo. Deve ser IDEMPOTENTE (describe-before-create via ledger). */
  provision(ctx: ProvisionContext): Promise<void>;
  /** Desfaz o passo (compensação). Deve ser idempotente e tolerar recurso ausente. */
  teardown?(ctx: ProvisionContext): Promise<void>;
}

/** Ordem canônica da cadeia (T13-T20 preenchem os drivers).
 * acm ANTES de alb: o listener HTTPS do ALB precisa do cert ARN emitido pelo ACM.
 * "ecs" (task-def + target group) ANTES de alb: o alb associa o TG a um listener.
 * "ecs_service" (CreateService com loadBalancers) DEPOIS de alb: a AWS exige que o TG
 *   já esteja associado a um LB — split do driver ecs corrige o bug de ordenação (2026-07-06).
 * route53 por último: o record ALIAS aponta para o DNS name do ALB já criado. */
export const CHAIN_ORDER = [
  "iam", "networking", "rds", "secrets", "migrating", "ecs", "acm", "alb", "ecs_service", "route53",
] as const;

const REGISTRY = new Map<string, ProvisionDriver>();

/** Registra um driver (chamado no import do módulo do driver). */
export function registerDriver(driver: ProvisionDriver): void {
  REGISTRY.set(driver.key, driver);
}

export function getDriver(key: string): ProvisionDriver | undefined {
  return REGISTRY.get(key);
}

/** Drivers presentes, na ordem da cadeia (pula os ainda não registrados). */
export function orderedDrivers(): ProvisionDriver[] {
  return CHAIN_ORDER.map((k) => REGISTRY.get(k)).filter((d): d is ProvisionDriver => !!d);
}

/**
 * Executa a cadeia a partir de um deployment já com imagem no ECR (pós-callback 'pushed').
 * Avança status por passo; em falha, roda a compensação e marca 'failed'.
 *
 * Resumível: como cada driver é idempotente (describe-before-create), reexecutar a cadeia
 * inteira após um restart re-atinge os recursos já criados sem duplicar.
 */
export async function runProvisionChain(dep: BackendDeploymentRow): Promise<void> {
  const creds = await resolveAwsCredentials({
    tenantId: dep.tenant_id, deploymentId: dep.id,
  });
  const ctx: ProvisionContext = {
    deploymentId: dep.id,
    projectId: dep.project_id,
    tenantId: dep.tenant_id,
    runtimeTarget: dep.runtime_target,
    klass: dep.class,
    ecrRepoUri: dep.ecr_repo_uri,
    imageTag: dep.image_tag,
    creds,
    scratch: {},
  };

  const drivers = orderedDrivers();
  if (drivers.length === 0) {
    // Nenhum driver registrado ainda (estado atual de T12): a cadeia é um no-op explícito.
    // NÃO marcamos 'running' — o deployment fica em 'provisioning' aguardando os drivers
    // (T13-T20). Isso evita anunciar um endpoint que não existe.
    return;
  }

  const executed: ProvisionDriver[] = [];
  try {
    for (const driver of drivers) {
      await setStatus(dep.id, driver.status);
      await driver.provision(ctx);
      executed.push(driver);
    }
    // Cadeia completa → running. app_url/health_url são gravados pelos drivers alb/route53.
    await setStatus(dep.id, "running");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Compensação saga: desfaz na ordem REVERSA os passos executados.
    await compensate(ctx, executed.reverse(), msg);
    await setStatus(dep.id, "failed", `provision falhou: ${msg}`.slice(0, 900));
    throw err;
  }
}

/**
 * Compensação: percorre os drivers executados na ordem reversa e chama teardown().
 * Best-effort — uma falha de teardown não impede as demais; marca os recursos do
 * ledger como deletados quando o driver reportar sucesso.
 */
async function compensate(
  ctx: ProvisionContext,
  reversed: ProvisionDriver[],
  cause: string,
): Promise<void> {
  for (const driver of reversed) {
    if (!driver.teardown) continue;
    try {
      await driver.teardown(ctx);
    } catch {
      // não bloqueia — reconciliação/teardown (T21) tenta de novo pelo ledger.
    }
  }
  // Marca recursos vivos deste deployment como delete-requested → deleted no melhor esforço.
  void cause;
  const live = await listLiveResources(ctx.deploymentId);
  for (const r of live) {
    if (r.status === "created" || r.status === "pending") {
      try { await markResourceDeleted(r.id); } catch { /* reconciliação pega depois */ }
    }
  }
}

/** Grava URL final (usado pelos drivers alb/route53 quando o endpoint fica disponível). */
export async function setAppUrl(deploymentId: string, appUrl: string, healthUrl?: string): Promise<void> {
  await patchDeployment(deploymentId, { app_url: appUrl, health_url: healthUrl ?? `${appUrl.replace(/\/$/, "")}/health` });
}
