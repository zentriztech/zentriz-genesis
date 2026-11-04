/**
 * evolveFlags.ts — flag `EVOLVE_CLAIM` (Fase 1' do plano EVOLUIR-PROJETO-BANCADA, tarefas 1.1–1.3).
 *
 * `off` (padrão) = comportamento HISTÓRICO do `/evolve` e da criação de versão, byte a byte.
 * `on`  = claim curto/transacional com advisory lock por linhagem + passos idempotentes fora da
 *         transação + orçamento herdado do dono da versão corrente (services/evolveClaim.ts).
 *
 * Resolução (M-03; featureFlags.ts): tenant explícito > padrão global em `genesis_runtime_config` > env `EVOLVE_CLAIM`
 * (on|off, 1|0, true|false) como DEFAULT de plataforma (nunca sobrepõe o tenant) > `off`. Só `zentriz_admin` grava a chave.
 */
import { readRuntimeNumber, type RuntimeConfigDb } from "./runtimeTunables.js";
import { flagEnabled, parseEnvFlag, tenantOfProject } from "./featureFlags.js";

export const EVOLVE_CLAIM_KEY = "EVOLVE_CLAIM";
/** Saldo livre mínimo (US$, inteiro) do dono do orçamento para criar/promover uma versão. */
export const EVOLVE_MIN_FREE_BUDGET_KEY = "EVOLVE_MIN_FREE_BUDGET_USD";

/** Default de PLATAFORMA vindo do ambiente (`null` = ausente). Não sobrepõe o tenant. */
export function evolveClaimEnvDefault(): boolean | null {
  const n = parseEnvFlag(process.env.EVOLVE_CLAIM, "bool");
  return n === null ? null : n === 1;
}

/**
 * A flag está ligada para este recurso? `parentProjectId` resolve o tenant do RECURSO (padrão do
 * chat da Bancada); `userTenantId` é a reserva (zentriz_admin não tem tenant).
 */
export async function evolveClaimEnabled(
  db: RuntimeConfigDb,
  opts: { parentProjectId?: string | null; userTenantId?: string | null },
): Promise<boolean> {
  const tenantId = (await tenantOfProject(db, opts.parentProjectId)) ?? opts.userTenantId ?? null;
  return flagEnabled(db, "EVOLVE_CLAIM", tenantId);
}

/** Saldo livre mínimo configurado (US$) ou `null` (chave ausente/inválida: vale só a regra do Guard). */
export async function readEvolveMinFreeBudgetUsd(db: RuntimeConfigDb, tenantId: string | null): Promise<number | null> {
  return readRuntimeNumber(db, EVOLVE_MIN_FREE_BUDGET_KEY, tenantId, { min: 0, max: 100000 });
}
