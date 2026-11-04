/**
 * cardsBackfill.ts — tarefas 2.2 e 2.5 da Fase 2 (plano EVOLUIR-PROJETO-BANCADA v2; desenho H §4.4, §8):
 * BACKFILL que roda QUANDO a flag `CARDS_BANCADA` liga para o tenant (hook em `routes/runtimeConfig.ts`) e, de forma
 * idêntica e idempotente, por chamada direta (script/teste). Nunca roda com a flag desligada.
 *
 *  (a) `backfillCardState`  — `tickets.card_state` para os tickets do tenant que ainda têm `card_state IS NULL`.
 *      NÃO altera `tickets.status` nem `updated_at` (expand: o status legado já está correto por construção).
 *        open → draft · rejected → rejected · delivered → delivered
 *        promoted → conforme o filho: ausente/failed/archived ⇒ blocked (blocked_reason backfill:child_*)
 *                                      pré-fábrica (draft, spec_submitted, materializing, …, promoted) ⇒ promoted
 *                                      demais (running, accepted, stopped, blocked_*, …) ⇒ in_factory
 *      Um ticket legado `promoted` com filho `accepted` fica `in_factory` (e não `delivered`): `delivered` exige PR mergeado
 *      comprovado (tarefa 4.3) e manteria `status` coerente só com o `delivered` humano do legado.
 *      Cada ticket ganha um evento `ticket_card_events` (ator backfill, chave `backfill:v1`).
 *  (b) `backfillSpecOrigin` — `project_spec_files.spec_origin` onde está NULL:
 *        projeto que não é filho de evolução (raiz da linhagem e demais) ⇒ initial;
 *        filho de evolução: arquivo listado em `extra.evolution_inherited_spec` ⇒ a origem que o MESMO caminho tem no pai
 *        (initial se o pai não tem); o restante (o `spec-evolution-vN.md` e os arquivos do ticket) ⇒ card:legacy.
 *        Pais são processados antes dos filhos (ordem por versão), então uma herança v3 ← v2 preserva `card:legacy`.
 *        `card_draft` fica de fora (quem grava a origem do rascunho é a Fase 3).
 *  Idempotência: só linhas NULL são tocadas; segunda execução = 0 alterações.
 */
import { resolveFlag } from "./featureFlags.js";
import { CARD_CONTRACT_VERSION } from "./cardState.js";

type Row = Record<string, unknown>;
type Db = { query(sql: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }> };
type PoolLike = Db & { connect(): Promise<Db & { release(): void }> };

export const BACKFILL_DEDUPE_KEY = "backfill:v1";

/** Status de projeto filho em que o card legado `promoted` ainda está antes da fábrica (H §4.1: promoted → in_factory). */
export const PRE_FACTORY_CHILD_STATUSES = ["draft", "spec_submitted", "pending_conversion", "spec_validation_failed", "materializing", "promoted"] as const;

export interface CardStateBackfillReport { tenantId: string; byState: Record<string, number>; total: number }

export async function backfillCardState(db: Db, tenantId: string): Promise<CardStateBackfillReport> {
  const r = await db.query(
    `WITH target AS (
       SELECT t.id,
              CASE
                WHEN t.status = 'open' THEN 'draft'
                WHEN t.status = 'rejected' THEN 'rejected'
                WHEN t.status = 'delivered' THEN 'delivered'
                WHEN p.id IS NULL THEN 'blocked'
                WHEN p.status IN ('failed', 'archived') THEN 'blocked'
                WHEN p.status = ANY($2::text[]) THEN 'promoted'
                ELSE 'in_factory'
              END AS new_state,
              CASE
                WHEN t.status = 'promoted' AND p.id IS NULL THEN 'backfill:child_missing'
                WHEN t.status = 'promoted' AND p.status IN ('failed', 'archived') THEN 'backfill:child_' || p.status
              END AS new_reason,
              p.id AS child_id
         FROM tickets t
         LEFT JOIN projects p ON p.id = t.child_project_id
        WHERE t.tenant_id = $1 AND t.card_state IS NULL
          AND t.status IN ('open', 'promoted', 'delivered', 'rejected')
     ), upd AS (
       UPDATE tickets t
          SET card_state = target.new_state, blocked_reason = target.new_reason, card_contract_version = $3
         FROM target
        WHERE t.id = target.id AND t.card_state IS NULL
        RETURNING t.id, t.card_state
     ), ev AS (
       INSERT INTO ticket_card_events (ticket_id, from_state, to_state, actor_kind, reason, child_project_id, dedupe_key)
       SELECT upd.id, NULL, upd.card_state, 'backfill', 'cards_bancada_on', target.child_id, $4
         FROM upd JOIN target ON target.id = upd.id
       ON CONFLICT (ticket_id, to_state, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING 1
     )
     SELECT card_state, count(*)::int AS n FROM upd GROUP BY card_state`,
    [tenantId, [...PRE_FACTORY_CHILD_STATUSES], CARD_CONTRACT_VERSION, BACKFILL_DEDUPE_KEY],
  );
  const byState: Record<string, number> = {};
  let total = 0;
  for (const x of r.rows) { byState[String(x.card_state)] = Number(x.n); total += Number(x.n); }
  return { tenantId, byState, total };
}

export interface SpecOriginBackfillReport { tenantId: string; initial: number; inheritedFromParent: number; cardLegacy: number; total: number }

export async function backfillSpecOrigin(db: Db, tenantId: string): Promise<SpecOriginBackfillReport> {
  const rep: SpecOriginBackfillReport = { tenantId, initial: 0, inheritedFromParent: 0, cardLegacy: 0, total: 0 };
  // (1) tudo que NÃO é filho de evolução (raiz da linhagem, specs avulsas, versões criadas por POST /api/specs) ⇒ initial.
  const base = await db.query(
    `UPDATE project_spec_files f SET spec_origin = 'initial'
       FROM projects p
      WHERE f.project_id = p.id AND p.tenant_id = $1 AND f.spec_origin IS NULL
        AND p.status <> 'card_draft'
        AND NOT (p.parent_project_id IS NOT NULL AND (p.extra->>'evolution') = 'true')`,
    [tenantId],
  );
  rep.initial += base.rowCount ?? 0;
  // (2) filhos de evolução, pais antes dos filhos.
  const kids = (await db.query(
    `SELECT p.id, p.parent_project_id, p.extra->'evolution_inherited_spec' AS inherited
       FROM projects p
      WHERE p.tenant_id = $1 AND p.parent_project_id IS NOT NULL AND (p.extra->>'evolution') = 'true'
        AND p.status <> 'card_draft'
        AND EXISTS (SELECT 1 FROM project_spec_files f WHERE f.project_id = p.id AND f.spec_origin IS NULL)
      ORDER BY p.version_number ASC, p.created_at ASC`,
    [tenantId],
  )).rows;
  for (const k of kids) {
    const listed = Array.isArray(k.inherited)
      ? (k.inherited as Array<{ path?: unknown }>).map((x) => (typeof x?.path === "string" ? x.path : "")).filter(Boolean)
      : null;
    // Sem a lista (extra antigo): os não primários são tratados como herdados (initial); o primário é o pedido (card:legacy).
    const r = await db.query(
      `WITH upd AS (
         UPDATE project_spec_files f SET spec_origin = CASE
             WHEN $3::text[] IS NOT NULL AND (CASE WHEN f.rel_dir = '' THEN f.filename ELSE f.rel_dir || '/' || f.filename END) = ANY($3::text[])
               THEN COALESCE((SELECT pf.spec_origin FROM project_spec_files pf
                               WHERE pf.project_id = $2 AND pf.rel_dir = f.rel_dir AND pf.filename = f.filename), 'initial')
             WHEN $3::text[] IS NULL AND NOT f.is_primary
               THEN COALESCE((SELECT pf.spec_origin FROM project_spec_files pf
                               WHERE pf.project_id = $2 AND pf.rel_dir = f.rel_dir AND pf.filename = f.filename), 'initial')
             ELSE 'card:legacy' END
          WHERE f.project_id = $1 AND f.spec_origin IS NULL
          RETURNING f.spec_origin)
       SELECT spec_origin, count(*)::int AS n FROM upd GROUP BY spec_origin`,
      [k.id, k.parent_project_id, listed],
    );
    for (const x of r.rows) {
      const n = Number(x.n);
      rep.total += n;
      if (x.spec_origin === "card:legacy") rep.cardLegacy += n;
      else { rep.inheritedFromParent += n; }
    }
  }
  rep.total += rep.initial;
  return rep;
}

export interface CardsBackfillOutcome {
  tenantId: string;
  cardState?: CardStateBackfillReport;
  specOrigin?: SpecOriginBackfillReport;
  error?: string;
}

/**
 * Hook da flag: roda os dois backfills para UM tenant (se a flag estiver ligada para ele) ou, com `tenantId = null`
 * (padrão GLOBAL mudou), para todos os tenants em que a flag resolve ligada. Falha de um tenant não impede os outros.
 * Idempotente: pode ser chamada de novo (liga/desliga/liga) sem duplicar nem perder nada.
 */
export async function runCardsFlagBackfill(pool: PoolLike, tenantId: string | null): Promise<CardsBackfillOutcome[]> {
  const tenants: string[] = tenantId
    ? [tenantId]
    : (await pool.query("SELECT id FROM tenants")).rows.map((r) => String(r.id));
  const out: CardsBackfillOutcome[] = [];
  for (const t of tenants) {
    try {
      const flag = await resolveFlag(pool, "CARDS_BANCADA", t);
      if (flag.value < 1) continue;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const cardState = await backfillCardState(client, t);
        const specOrigin = await backfillSpecOrigin(client, t);
        await client.query("COMMIT");
        out.push({ tenantId: t, cardState, specOrigin });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      out.push({ tenantId: t, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
