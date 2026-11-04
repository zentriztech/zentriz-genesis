/**
 * evolveFlags.ts — flag `EVOLVE_CLAIM` (Fase 1' do plano EVOLUIR-PROJETO-BANCADA, tarefas 1.1–1.3).
 *
 * `off` (padrão) = comportamento HISTÓRICO do `/evolve` e da criação de versão, byte a byte.
 * `on`  = claim curto/transacional com advisory lock por linhagem + passos idempotentes fora da
 *         transação + orçamento herdado do dono da versão corrente (services/evolveClaim.ts).
 *
 * Resolução (a mais específica vence):
 *   1. env `EVOLVE_CLAIM` = on|off (também 1|0, true|false) — chave geral de emergência/teste;
 *   2. `genesis_runtime_config.EVOLVE_CLAIM` (0|1) lido por `readRuntimeNumber`: override do TENANT
 *      do recurso vence o global. A leitura por tenant já está pronta; LIGAR por tenant é decisão da
 *      Fase 2 (a chave ainda não está em CONFIG_KEYS, então nenhum tenant_admin a edita pela UI);
 *   3. ausente/ inválido / erro de banco ⇒ `off`.
 */
import { readRuntimeNumber, type RuntimeConfigDb } from "./runtimeTunables.js";

export const EVOLVE_CLAIM_KEY = "EVOLVE_CLAIM";
/** Saldo livre mínimo (US$, inteiro) do dono do orçamento para criar/promover uma versão. */
export const EVOLVE_MIN_FREE_BUDGET_KEY = "EVOLVE_MIN_FREE_BUDGET_USD";

export function evolveClaimEnvOverride(): boolean | null {
  const raw = (process.env.EVOLVE_CLAIM ?? "").trim().toLowerCase();
  if (["on", "1", "true"].includes(raw)) return true;
  if (["off", "0", "false"].includes(raw)) return false;
  return null;
}

/**
 * A flag está ligada para este recurso? `parentProjectId` resolve o tenant do RECURSO (padrão do
 * chat da Bancada); `userTenantId` é a reserva (zentriz_admin não tem tenant).
 */
export async function evolveClaimEnabled(
  db: RuntimeConfigDb,
  opts: { parentProjectId?: string | null; userTenantId?: string | null },
): Promise<boolean> {
  const env = evolveClaimEnvOverride();
  if (env !== null) return env;
  let tenantId: string | null = null;
  if (opts.parentProjectId) {
    try {
      const r = await db.query("SELECT tenant_id FROM projects WHERE id = $1", [opts.parentProjectId]);
      const t = r.rows[0]?.tenant_id;
      tenantId = t ? String(t) : null;
    } catch {
      tenantId = null; // id inválido etc.: a rota devolve o erro de sempre
    }
  }
  tenantId = tenantId ?? opts.userTenantId ?? null;
  return (await readRuntimeNumber(db, EVOLVE_CLAIM_KEY, tenantId, { min: 0, max: 1 })) === 1;
}

/** Saldo livre mínimo configurado (US$) ou `null` (chave ausente/inválida: vale só a regra do Guard). */
export async function readEvolveMinFreeBudgetUsd(db: RuntimeConfigDb, tenantId: string | null): Promise<number | null> {
  return readRuntimeNumber(db, EVOLVE_MIN_FREE_BUDGET_KEY, tenantId, { min: 0, max: 100000 });
}
