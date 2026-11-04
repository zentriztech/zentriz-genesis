/**
 * evolutionPromote.ts — tarefa 1.7 da Fase 1' (plano EVOLUIR-PROJETO-BANCADA v2): promoção, na Bancada, do filho de EVOLUÇÃO.
 *
 * Por que existe (defeitos (d) e (h) do estudo F):
 *   (d) o `/evolve` deixa o filho em `spec_submitted` (herdou a spec do pai), mas `POST /api/projects/:id/promote` só admitia `draft`
 *       ⇒ 409 NOT_ON_WORKBENCH num filho que acabou de entrar na Bancada;
 *   (h) o produto de um serviço já aceito nunca está em `draft` (fica `accepted`/`partially_accepted`), então `POST /api/products/:id/promote`
 *       e o veredito da tela (`promotability.ts`) diziam "já saiu da Bancada" para o filho de evolução.
 *
 * Decisão R4 (H §9): o filho CONTINUA `spec_submitted` (o `/run` legado o aceita); em vez de mudar o status, a promoção aprende a aceitá-lo
 * quando `extra.evolution === true`. NENHUM gate é enfraquecido:
 *   1. RFC válido (`evaluateEvolutionGate` — o MESMO do `/run`, invariante);
 *   2. `connect.yaml` + validação do conteúdo atual (`assessProjectReadiness`);
 *   3. orçamento do dono (`checkProjectBudgetGate`).
 * A única dispensa é a TRAVA DE NORMALIZAÇÃO: para evolução o RFC é o documento de decisão (D-A6), então "Normalizar" não se aplica.
 *
 * A avaliação de prontidão (`assessEvolutionReadiness`) vive em `promotability.ts` (junto do veredito) para não criar import circular.
 *
 * Flag `EVOLUTION_PROMOTE_BANCADA` (`off` padrão = comportamento histórico byte a byte). Resolução (M-03; featureFlags.ts):
 * tenant explícito > padrão global em `genesis_runtime_config` > env como DEFAULT de plataforma (nunca sobrepõe o tenant) > `off`.
 */
import type { RuntimeConfigDb } from "./runtimeTunables.js";
import { flagEnabled, parseEnvFlag } from "./featureFlags.js";

export const EVOLUTION_PROMOTE_BANCADA_KEY = "EVOLUTION_PROMOTE_BANCADA";
/** Status do filho de evolução que a Bancada pode promover (R4: `spec_submitted` fica; `draft` = pai sem arquivos). */
export const EVOLUTION_PROMOTABLE_STATUSES = ["draft", "spec_submitted"] as const;

/** Default de PLATAFORMA vindo do ambiente (`null` = ausente). Não sobrepõe o tenant. */
export function evolutionPromoteEnvDefault(): boolean | null {
  const n = parseEnvFlag(process.env.EVOLUTION_PROMOTE_BANCADA, "bool");
  return n === null ? null : n === 1;
}

/** Ligada para este recurso? Tenant do RECURSO (projeto ou produto) primeiro; o do usuário é reserva. */
export async function evolutionPromoteEnabled(
  db: RuntimeConfigDb,
  opts: { projectId?: string | null; productId?: string | null; tenantId?: string | null; userTenantId?: string | null } = {},
): Promise<boolean> {
  let tenantId: string | null = opts.tenantId ?? null;
  try {
    if (!tenantId && opts.projectId) {
      tenantId = (await db.query("SELECT tenant_id FROM projects WHERE id = $1", [opts.projectId])).rows[0]?.tenant_id as string | null ?? null;
    }
    if (!tenantId && opts.productId) {
      tenantId = (await db.query("SELECT tenant_id FROM products WHERE id = $1", [opts.productId])).rows[0]?.tenant_id as string | null ?? null;
    }
  } catch {
    tenantId = null;
  }
  tenantId = tenantId ? String(tenantId) : (opts.userTenantId ?? null);
  return flagEnabled(db, "EVOLUTION_PROMOTE_BANCADA", tenantId);
}

export function isEvolutionExtra(extra: Record<string, unknown> | null | undefined): boolean {
  return !!extra && extra.evolution === true;
}

type Db = RuntimeConfigDb;

export interface EvolutionCandidate { projectId: string; title: string; status: string }

/** Filhos de evolução vivos do produto que a Bancada pode promover. */
export async function listPromotableEvolutionChildren(db: Db, productId: string): Promise<EvolutionCandidate[]> {
  const r = await db.query(
    `SELECT id, title, status FROM projects
      WHERE product_id = $1 AND status = ANY($2) AND (extra->>'evolution') = 'true'
      ORDER BY created_at ASC`,
    [productId, [...EVOLUTION_PROMOTABLE_STATUSES]],
  );
  return r.rows.map((x) => ({ projectId: String(x.id), title: String(x.title ?? ""), status: String(x.status) }));
}
