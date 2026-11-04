/**
 * evolveReconciler.ts — reconciliador do /evolve (Fase 1', tarefa 1.8 do plano EVOLUIR-PROJETO-BANCADA;
 * desenho do Advisor em project/docs/analysis/EVOLUIR-PROJETO-H-desenho-tecnico-advisor.md §1.5 e §7).
 *
 * DETECTA e NOTIFICA. A ÚNICA ação automática é limpar um claim VENCIDO SEM EFEITOS COLATERAIS (Q1): marca o filho
 * `failed` (reason `claim_expired_no_effects`) e reabre o ticket (`promoted → open`), numa transação com o advisory
 * lock da linhagem e `UPDATE … WHERE`. Nunca apaga projeto, ticket ou arquivo; nunca toca filho com efeitos
 * (a retomada é do repetir do pedido). Zero LLM, zero escrita fora de `evolve_reconciler_findings` e do Q1.
 *
 * Flag `EVOLVE_RECONCILER`:
 *   off    (padrão) nada roda, nada é lido nem escrito, nenhum timer;
 *   shadow detecta e grava achados; NÃO limpa e NÃO notifica;
 *   on     detecta, grava, limpa o Q1 sem efeitos e notifica (e-mail SES de operações, se configurado).
 * Valor ausente ou desconhecido ⇒ off (fail-safe).
 *
 * Achados (kind): claim_expired_no_effects · claim_expired_with_effects · ticket_promoted_without_child ·
 * child_ticket_mismatch · evolution_in_flight_stuck · uniqueness_index_missing · card_status_divergence (Q6, Fase 2: só detecta).
 * Sem PII: o achado guarda só hash (sha256/16 hex) de id, códigos, contagens e idades.
 */
import type { Pool, PoolClient } from "pg";
import { existsSync, statSync } from "fs";
import { join } from "path";
import { hashId } from "./anomalyDetectors.js";
import { NS_EVOLVE } from "./evolveClaim.js";
import { recordTicketEvent, ticketTransitionsEnabled } from "./ticketTransitions.js";
import { recomputeProductLifecycle } from "./productLifecycle.js";
import { UNIQUENESS_INDEXES, getUniquenessCounters } from "./evolutionUniqueness.js";
import { isSesConfigured, sendEmail } from "./emailSender.js";
import { readRuntimeNumber } from "./runtimeTunables.js";
import { resolveReconcilerMode } from "./featureFlags.js";
import { findCardStatusDivergences, transitionCard } from "./cardState.js";

export type ReconcilerMode = "off" | "shadow" | "on";
export function reconcilerMode(env: NodeJS.ProcessEnv = process.env): ReconcilerMode {
  const raw = (env.EVOLVE_RECONCILER ?? "off").trim().toLowerCase();
  return raw === "shadow" || raw === "on" ? raw : "off";
}

export const RECONCILER_INTERVAL_KEY = "EVOLVE_RECONCILER_INTERVAL_MIN";
/** Padrões conservadores (H §7: 5 min; carência de 5 min além do lease de 10; esperas humanas legítimas até 72 h). */
export const RECONCILER_DEFAULTS = { intervalMin: 5, claimGraceS: 300, stuckHours: 72, orphanGraceS: 300, publishGraceS: 900 } as const;

export interface ReconcilerParams { claimGraceS: number; stuckHours: number; orphanGraceS: number; publishGraceS: number }
export function resolveReconcilerParams(env: NodeJS.ProcessEnv = process.env): ReconcilerParams {
  const num = (k: string, d: number) => { const n = Number(env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    claimGraceS: num("EVOLVE_RECONCILER_CLAIM_GRACE_S", RECONCILER_DEFAULTS.claimGraceS),
    stuckHours: num("EVOLVE_RECONCILER_STUCK_HOURS", RECONCILER_DEFAULTS.stuckHours),
    orphanGraceS: num("EVOLVE_RECONCILER_ORPHAN_GRACE_S", RECONCILER_DEFAULTS.orphanGraceS),
    publishGraceS: num("EVOLVE_RECONCILER_PUBLISH_GRACE_S", RECONCILER_DEFAULTS.publishGraceS),
  };
}

/**
 * Lock de sessão do job. M-22: NAMESPACE PRÓPRIO (7342) — em `(7341, 0)` ele dividia o espaço de `(7341, hashtext(raiz))`
 * e, se `hashtext(raiz)` desse 0 (1 em 2³²), o claim dessa linhagem receberia EVOLUTION_BUSY a cada passada.
 */
export const RECONCILER_LOCK_NS = 7342;
export const RECONCILER_LOCK_KEY = 0;

export type FindingKind =
  | "claim_expired_no_effects" | "claim_expired_with_effects" | "ticket_promoted_without_child"
  | "child_ticket_mismatch" | "evolution_in_flight_stuck" | "uniqueness_index_missing" | "reconciler_disk_unverifiable"
  | "card_status_divergence" | "evolution_publish_incomplete";

export interface Finding {
  kind: FindingKind;
  entityHash: string;
  projectHash: string | null;
  ticketHash: string | null;
  severity: "info" | "warning" | "critical";
  detail: Record<string, unknown>;
  /** Preenchido só quando o job EXECUTOU (ou, em shadow, TERIA executado) a limpeza segura. */
  action?: string;
}

export interface ReconcilerResult {
  mode: ReconcilerMode;
  skipped?: "off" | "locked" | "error";
  detected: number;
  cleaned: number;
  resolved: number;
  notified: number;
  byKind: Record<string, number>;
  /** Fase 3 (3.5): transições card × filho aplicadas nesta passada (só em `on`; ausente nos demais modos). */
  cardsSynced?: number;
  cardsDelivered?: number;
}
const empty = (mode: ReconcilerMode, skipped?: ReconcilerResult["skipped"]): ReconcilerResult =>
  ({ mode, skipped, detected: 0, cleaned: 0, resolved: 0, notified: 0, byKind: {} });

const ALL_KINDS: FindingKind[] = [
  "claim_expired_no_effects", "claim_expired_with_effects", "ticket_promoted_without_child",
  "child_ticket_mismatch", "evolution_in_flight_stuck", "uniqueness_index_missing", "reconciler_disk_unverifiable",
  "card_status_divergence", "evolution_publish_incomplete",
];

type Json = Record<string, unknown>;

// ── Q1: claim vencido ───────────────────────────────────────────────────────────────────
interface ExpiredClaim { id: string; root: string; version: number; ageS: number; steps: string[]; specFiles: number }

async function loadExpiredClaims(db: Pool | PoolClient, p: ReconcilerParams): Promise<ExpiredClaim[]> {
  const r = await db.query(
    `SELECT p.id::text AS id,
            COALESCE(p.extra->>'evolution_root_id', p.parent_project_id::text, p.id::text) AS root,
            p.version_number AS version,
            extract(epoch FROM (now() - (p.extra->'materialization'->>'lease_until')::timestamptz))::int AS age_s,
            COALESCE((SELECT array_agg(k) FROM jsonb_object_keys(COALESCE(p.extra->'materialization'->'steps','{}'::jsonb)) k), '{}') AS steps,
            (SELECT count(*)::int FROM project_spec_files f WHERE f.project_id = p.id) AS spec_files
       FROM projects p
      WHERE p.status = 'materializing'
        AND (p.extra->'materialization'->>'lease_until')::timestamptz < now() - ($1::int * interval '1 second')
      ORDER BY p.created_at
      LIMIT 200`,
    [Math.floor(p.claimGraceS)],
  );
  return r.rows.map((x) => ({
    id: String(x.id), root: String(x.root), version: Number(x.version), ageS: Number(x.age_s),
    steps: (x.steps as string[]) ?? [], specFiles: Number(x.spec_files),
  }));
}

/**
 * M-15: a classificação "sem efeitos" lê o disco da PRÓPRIA api. Para limpar (`on`) o job exige `PROJECT_FILES_ROOT` e
 * `UPLOAD_DIR` definidos e EXISTENTES — senão um volume vazio/diferente do usado pelo executor faria uma cópia parcial
 * parecer "sem efeitos". Devolve os nomes das variáveis que falham.
 */
export function reconcilerDiskProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const bad: string[] = [];
  const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
  const files = (env.PROJECT_FILES_ROOT ?? "").trim();
  const upload = (env.UPLOAD_DIR ?? "/shared/uploads").trim();
  if (!files || !isDir(files)) bad.push("PROJECT_FILES_ROOT");
  if (!upload || !isDir(upload)) bad.push("UPLOAD_DIR");
  return bad;
}

/** Efeitos no DISCO do filho (o reconciliador roda na api, que monta os dois volumes). */
function diskEffects(childId: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const upload = (env.UPLOAD_DIR ?? "/shared/uploads").trim();
  const files = (env.PROJECT_FILES_ROOT ?? "").trim();
  if (upload && existsSync(join(upload, childId))) out.push("upload_dir");
  if (files && existsSync(join(files, childId))) out.push("project_files_dir");
  return out;
}

/**
 * Limpeza segura de UM claim vencido sem efeitos. Transação com o advisory lock da linhagem; os `WHERE` repetem as
 * condições (vencido + sem passos + sem arquivos de spec), então uma retomada concorrente (que renova o lease) ou uma
 * segunda execução do job viram no-op (rowCount 0). Devolve true só se ESTA chamada limpou.
 */
export async function cleanExpiredClaim(pool: Pool, c: { id: string; root: string }, p: ReconcilerParams): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [NS_EVOLVE, c.root]);
    const up = await client.query(
      `UPDATE projects
          SET status = 'failed',
              extra = jsonb_set(COALESCE(extra, '{}'::jsonb), '{materialization}',
                        COALESCE(extra->'materialization', '{}'::jsonb)
                        || jsonb_build_object('reaped_at', to_jsonb(now()), 'reason', 'claim_expired_no_effects', 'reaped_by', 'evolve_reconciler')),
              updated_at = now()
        WHERE id = $1 AND status = 'materializing'
          AND (extra->'materialization'->>'lease_until')::timestamptz < now() - ($2::int * interval '1 second')
          AND COALESCE(extra->'materialization'->'steps', '{}'::jsonb) = '{}'::jsonb
          AND NOT EXISTS (SELECT 1 FROM project_spec_files f WHERE f.project_id = projects.id)
        RETURNING product_id`,
      [c.id, Math.floor(p.claimGraceS)],
    );
    if ((up.rowCount ?? 0) === 0) { await client.query("ROLLBACK"); return false; }
    // Fase 2 (2.6 d): card cujo claim vencido sem efeitos foi limpo volta a `ready` PELA máquina (vínculo limpo + evento `ticket_card_events`).
    const cards = await client.query("SELECT id FROM tickets WHERE child_project_id = $1 AND card_state = 'promoted'", [c.id]);
    for (const k of cards.rows) {
      await transitionCard(client, { ticketId: String(k.id), to: "ready", actorKind: "system", reason: "claim_expired_no_effects", dedupeKey: `claim_expired:${c.id}` });
    }
    const reopened = await client.query(
      `UPDATE tickets SET status = 'open', child_project_id = NULL, promoted_at = NULL, updated_at = now()
        WHERE child_project_id = $1 AND status = 'promoted' AND card_state IS NULL RETURNING id, tenant_id`,
      [c.id],
    );
    // M-07: com TICKET_TRANSITIONS=on a reabertura promoted → open deixa evento (ator `system`), como o failTerminal.
    for (const t of reopened.rows) {
      if (await ticketTransitionsEnabled(client, { tenantId: t.tenant_id ? String(t.tenant_id) : null })) {
        await recordTicketEvent(client, { ticketId: String(t.id), from: "promoted", to: "open", actorKind: "system", reason: "claim_expired_no_effects", childProjectId: c.id });
      }
    }
    await client.query("COMMIT");
    // M-06: o filho `failed` (tentativa) muda o agregado do produto — recompute best-effort depois do commit.
    await recomputeProductLifecycle(pool, (up.rows[0]?.product_id as string | null) ?? null);
    return true;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* conexão caiu */ }
    console.error("[reconciler] limpeza do claim falhou (ignorado, nada foi alterado):", e instanceof Error ? e.message : String(e));
    return false;
  } finally {
    client.release();
  }
}

// ── Detectores (somente SELECT) ──────────────────────────────────────────────────────────
async function detectTicketsWithoutChild(db: Pool | PoolClient, p: ReconcilerParams): Promise<Finding[]> {
  const r = await db.query(
    `SELECT t.id::text AS id, t.child_project_id::text AS child, c.status AS child_status,
            extract(epoch FROM (now() - t.updated_at))::int AS age_s
       FROM tickets t LEFT JOIN projects c ON c.id = t.child_project_id
      WHERE t.status = 'promoted'
        AND (t.child_project_id IS NULL OR c.id IS NULL OR c.status = 'failed')
        AND t.updated_at < now() - ($1::int * interval '1 second')
      ORDER BY t.updated_at LIMIT 200`,
    [Math.floor(p.orphanGraceS)],
  );
  return r.rows.map((x) => ({
    kind: "ticket_promoted_without_child" as const, entityHash: hashId(String(x.id)),
    projectHash: x.child ? hashId(String(x.child)) : null, ticketHash: hashId(String(x.id)), severity: "warning" as const,
    detail: { reason: !x.child ? "child_null" : x.child_status ? "child_failed" : "child_missing", age_s: Number(x.age_s) },
  }));
}

async function detectChildTicketMismatch(db: Pool | PoolClient, p: ReconcilerParams): Promise<Finding[]> {
  // (a) o filho cita um ticket que não aponta de volta para ele; (b) um ticket promovido aponta para um filho
  // de evolução cujo `extra.ticket_id` está ausente (origem de ticket sem a marca).
  const a = await db.query(
    `SELECT p.id::text AS id, p.extra->>'ticket_id' AS ticket, extract(epoch FROM (now() - p.updated_at))::int AS age_s
       FROM projects p
      WHERE (p.extra->>'evolution') = 'true' AND (p.extra->>'ticket_id') IS NOT NULL
        AND p.status NOT IN ('failed', 'archived', 'materializing')
        AND p.updated_at < now() - ($1::int * interval '1 second')
        AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.id::text = p.extra->>'ticket_id' AND t.child_project_id = p.id)
      ORDER BY p.updated_at LIMIT 200`,
    [Math.floor(p.orphanGraceS)],
  );
  const b = await db.query(
    `SELECT p.id::text AS id, t.id::text AS ticket, extract(epoch FROM (now() - p.updated_at))::int AS age_s
       FROM tickets t JOIN projects p ON p.id = t.child_project_id
      WHERE t.status IN ('promoted', 'delivered') AND (p.extra->>'ticket_id') IS NULL
        AND p.status NOT IN ('failed', 'archived', 'materializing')
        AND p.updated_at < now() - ($1::int * interval '1 second')
      ORDER BY p.updated_at LIMIT 200`,
    [Math.floor(p.orphanGraceS)],
  );
  const out: Finding[] = [];
  for (const x of a.rows) out.push({ kind: "child_ticket_mismatch", entityHash: hashId(String(x.id)), projectHash: hashId(String(x.id)),
    ticketHash: x.ticket ? hashId(String(x.ticket)) : null, severity: "warning", detail: { reason: "child_cites_ticket_not_linked_back", age_s: Number(x.age_s) } });
  const seen = new Set(out.map((f) => f.entityHash));
  for (const x of b.rows) {
    const h = hashId(String(x.id));
    if (seen.has(h)) continue;
    out.push({ kind: "child_ticket_mismatch", entityHash: h, projectHash: h, ticketHash: hashId(String(x.ticket)), severity: "warning",
      detail: { reason: "ticket_points_to_child_without_ticket_id", age_s: Number(x.age_s) } });
  }
  return out;
}

const STUCK_STATUSES = ["blocked_cyborg", "stopped", "needs_spec_input", "draft", "spec_submitted"];
async function detectStuckInFlight(db: Pool | PoolClient, p: ReconcilerParams): Promise<Finding[]> {
  const r = await db.query(
    `SELECT id::text AS id, status, extract(epoch FROM (now() - updated_at))::int AS age_s
       FROM projects
      WHERE (extra->>'evolution') = 'true' AND parent_project_id IS NOT NULL
        AND (status = ANY($1::text[]) OR status LIKE 'blocked%')
        AND updated_at < now() - ($2::float8 * interval '1 hour')
      ORDER BY updated_at LIMIT 200`,
    [STUCK_STATUSES, p.stuckHours],
  );
  return r.rows.map((x) => ({
    kind: "evolution_in_flight_stuck" as const, entityHash: hashId(String(x.id)), projectHash: hashId(String(x.id)), ticketHash: null,
    severity: "warning" as const, detail: { status: String(x.status), idle_hours: Math.round(Number(x.age_s) / 360) / 10 },
  }));
}

/** Q6 (H §7): `card_state` × `tickets.status` divergentes. Só detecta — a correção é humana ou a próxima transição pela máquina. */
async function detectCardDivergences(db: Pool | PoolClient): Promise<Finding[]> {
  const rows = await findCardStatusDivergences(db, { limit: 200 });
  return rows.map((x) => ({
    kind: "card_status_divergence" as const, entityHash: hashId(x.ticketId), projectHash: null, ticketHash: hashId(x.ticketId), severity: "warning" as const,
    detail: { card_state: x.cardState, status: x.status, expected_status: x.expectedStatus },
  }));
}

// ── Q7 (Fase 4, M1/C1/C3): publicação da evolução aceita que não terminou ─────────────────────────────
/**
 * Evolução ACEITA cuja publicação não fechou: (a) o aceite marcou `evolution_publish_state='pending'` e a API morreu antes de fechar
 * (C1: entre o aceite e o push; C3: entre o registro do repositório e a gravação do número do PR), ou (b) o filho tem repositório da linhagem
 * registrado mas `evolution_pr_number` nulo (PR não aberto/registrado) — nos dois casos depois de `publishGraceS` (o push legítimo leva minutos).
 * Filho de `fallback_new_repo` (repositório próprio ≠ linhagem, sem PR por desenho) NÃO é achado. Ação (`on`): `evolution_push_pending=true`
 * ⇒ a ação "Republicar" aparece e a entrega do card segue bloqueada; republicar reusa o PR aberto (`openPullRequest` lista antes de criar).
 */
export interface IncompletePublish { id: string; reason: "publish_pending_stale" | "pr_not_registered"; ageS: number }
export async function findIncompletePublications(db: Pool | PoolClient, p: Pick<ReconcilerParams, "publishGraceS">): Promise<IncompletePublish[]> {
  const r = await db.query(
    `SELECT p.id::text AS id, p.parent_project_id, p.extra, g.repo_full_name AS own_repo,
            extract(epoch FROM (now() - COALESCE((p.extra->>'evolution_publish_at')::timestamptz, g.pushed_at, p.updated_at)))::int AS age_s
       FROM projects p LEFT JOIN project_github_repos g ON g.project_id = p.id
      WHERE p.status = 'accepted' AND p.extra->>'evolution' = 'true'
        AND COALESCE(p.extra->>'evolution_push_pending', '') <> 'true'
        AND COALESCE(p.extra->>'evolution_merged_at', '') = ''
        AND ( ( p.extra->>'evolution_publish_state' = 'pending'
                AND COALESCE((p.extra->>'evolution_publish_at')::timestamptz, p.updated_at) < now() - ($1::int * interval '1 second') )
           OR ( g.project_id IS NOT NULL AND COALESCE(p.extra->>'evolution_pr_number', '') = ''
                AND COALESCE(p.extra->>'evolution_publish_state', '') <> 'pending'
                AND g.pushed_at < now() - ($1::int * interval '1 second') ) )
      ORDER BY p.updated_at LIMIT 200`,
    [Math.floor(p.publishGraceS)],
  );
  const { findLineageRepo } = await import("./evolutionAccept.js");
  const out: IncompletePublish[] = [];
  for (const x of r.rows) {
    const ex = (x.extra ?? {}) as Json;
    const parent = (typeof ex.evolution_parent_id === "string" ? ex.evolution_parent_id : null) ?? (x.parent_project_id as string | null) ?? null;
    const lineage = await findLineageRepo(db as never, String(x.id), parent);
    const pendingStale = ex.evolution_publish_state === "pending";
    // Sem repositório na linhagem e com repositório próprio = fallback_new_repo (sem PR por desenho): não é falha de publicação.
    if (!pendingStale && (!lineage || (x.own_repo && x.own_repo !== lineage.repo_full_name))) continue;
    out.push({ id: String(x.id), reason: pendingStale ? "publish_pending_stale" : "pr_not_registered", ageS: Number(x.age_s) });
  }
  return out;
}

async function detectIncompletePublish(db: Pool, p: ReconcilerParams, mode: "shadow" | "on", repaired: Finding[]): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const c of await findIncompletePublications(db, p)) {
    const f: Finding = { kind: "evolution_publish_incomplete", entityHash: hashId(c.id), projectHash: hashId(c.id), ticketHash: null, severity: "critical",
      detail: { reason: c.reason, age_s: c.ageS, rule: "marks_push_pending_then_republish_reuses_open_pr" } };
    if (mode === "shadow") { f.action = "shadow_would_mark_push_pending"; out.push(f); continue; }
    const up = await db.query(
      `UPDATE projects SET extra = COALESCE(extra,'{}'::jsonb) || '{"evolution_push_pending":true,"evolution_publish_state":"failed"}'::jsonb, updated_at = now()
        WHERE id = $1 AND status = 'accepted' AND COALESCE(extra->>'evolution_push_pending','') <> 'true' AND COALESCE(extra->>'evolution_merged_at','') = '' RETURNING id`,
      [c.id]);
    if ((up.rowCount ?? up.rows.length) === 0) continue; // outro processo fechou/marcou no meio: não é achado
    await db.query(
      "INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human) VALUES ($1, 'system', 'system', 'step', $2)",
      [c.id, `⚠️ Publicação da evolução não foi concluída (${c.reason === "pr_not_registered" ? "PR não registrado" : "push interrompido"}). Marcada como pendente: use \"Republicar\" — o PR aberto é reaproveitado.`],
    ).catch(() => undefined);
    f.action = "cleaned_marked_push_pending";
    repaired.push(f);
  }
  return out;
}

async function detectMissingIndexes(db: Pool | PoolClient): Promise<Finding[]> {
  const r = await db.query("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ANY($1::text[])",
    [UNIQUENESS_INDEXES.map((i) => i.name)]);
  const have = new Set(r.rows.map((x) => String(x.indexname)));
  const counters = getUniquenessCounters(); // log da pré-checagem do boot deste processo
  return UNIQUENESS_INDEXES.filter((i) => !have.has(i.name)).map((i) => ({
    kind: "uniqueness_index_missing" as const, entityHash: hashId(i.name), projectHash: null, ticketHash: null, severity: "critical" as const,
    detail: { index: i.name, boot_dirty_groups: counters.dirty, boot_errors: counters.errors, hint: "duplicata pré-existente ou falha no boot: ver log evolution_uniqueness_dirty" },
  }));
}

// ── Persistência ─────────────────────────────────────────────────────────────────────────
/** UPSERT idempotente por (kind, entity_hash). Reaparição de achado resolvido reabre (e rearma a notificação). */
async function upsertFinding(db: Pool | PoolClient, f: Finding, mode: "shadow" | "on", resolvedNow = false): Promise<void> {
  await db.query(
    `INSERT INTO evolve_reconciler_findings (kind, entity_hash, project_hash, ticket_hash, severity, mode, detail, action_taken, action_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, CASE WHEN $8::text IS NULL THEN NULL ELSE now() END, CASE WHEN $9::boolean THEN now() ELSE NULL END)
     ON CONFLICT (kind, entity_hash) DO UPDATE SET
       last_seen_at = now(),
       seen_count = evolve_reconciler_findings.seen_count + 1,
       severity = EXCLUDED.severity, mode = EXCLUDED.mode, detail = EXCLUDED.detail,
       detected_at = CASE WHEN evolve_reconciler_findings.resolved_at IS NOT NULL AND NOT $9::boolean THEN now() ELSE evolve_reconciler_findings.detected_at END,
       notified_at = CASE WHEN evolve_reconciler_findings.resolved_at IS NOT NULL AND NOT $9::boolean THEN NULL ELSE evolve_reconciler_findings.notified_at END,
       resolved_at = CASE WHEN $9::boolean THEN COALESCE(evolve_reconciler_findings.resolved_at, now()) ELSE NULL END,
       action_taken = COALESCE(EXCLUDED.action_taken, CASE WHEN evolve_reconciler_findings.resolved_at IS NOT NULL THEN NULL ELSE evolve_reconciler_findings.action_taken END),
       action_at = COALESCE(EXCLUDED.action_at, CASE WHEN evolve_reconciler_findings.resolved_at IS NOT NULL THEN NULL ELSE evolve_reconciler_findings.action_at END)`,
    [f.kind, f.entityHash, f.projectHash, f.ticketHash, f.severity, mode, JSON.stringify(f.detail), f.action ?? null, resolvedNow],
  );
}

/** Achados abertos de `kinds` que NÃO foram vistos nesta passada somem: `resolved_at` (a condição deixou de existir). */
async function resolveGone(db: Pool | PoolClient, kinds: FindingKind[], seen: Set<string>): Promise<number> {
  if (!kinds.length) return 0;
  const r = await db.query(
    `UPDATE evolve_reconciler_findings
        SET resolved_at = now(), action_taken = COALESCE(action_taken, 'condition_cleared')
      WHERE resolved_at IS NULL AND kind = ANY($1::text[]) AND NOT ((kind || ':' || entity_hash) = ANY($2::text[]))`,
    [kinds, [...seen]],
  );
  return r.rowCount ?? 0;
}

function esc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

/** Notifica pelo canal de operações existente (e-mail SES, `OPS_NOTIFY_EMAIL`), um e-mail por passada. Sem canal ⇒ não marca. */
async function notifyNew(pool: Pool): Promise<number> {
  try {
    const to = (process.env.OPS_NOTIFY_EMAIL ?? "jean@zentriz.com.br").trim();
    if (!to || !isSesConfigured()) return 0;
    const r = await pool.query(
      `SELECT id, kind, entity_hash, severity, action_taken, detail FROM evolve_reconciler_findings
        WHERE notified_at IS NULL AND mode = 'on' AND (resolved_at IS NULL OR action_taken LIKE 'cleaned%')
        ORDER BY detected_at LIMIT 50`,
    );
    if (!r.rows.length) return 0;
    const lines = r.rows.map((x) => `${x.kind} · ${x.severity} · ${x.entity_hash}${x.action_taken ? ` · ação: ${x.action_taken}` : ""}`);
    const html = `<table width="100%" cellpadding="0" cellspacing="0" style="background:#0b1220"><tr><td style="padding:24px;font-family:Arial,sans-serif;color:#e5e7eb">`
      + `<div style="border-left:4px solid #f59e0b;padding-left:12px"><h2 style="margin:0 0 8px;color:#f9fafb">Reconciliador do /evolve: ${lines.length} achado(s) novo(s)</h2>`
      + lines.map((l) => `<p style="margin:0 0 4px;color:#e5e7eb">${esc(l)}</p>`).join("") + `</div>`
      + `<p style="color:#9ca3af">Identificadores em hash. Consulta: GET /api/admin/evolve-reconciler/findings. A única ação automática é limpar claim vencido sem efeitos.</p></td></tr></table>`;
    const sent = await sendEmail({ to, subject: `[Genesis] Reconciliador /evolve — ${lines.length} achado(s)`, html, text: lines.join("\n") });
    if (sent.delivered !== true) return 0;
    await pool.query("UPDATE evolve_reconciler_findings SET notified_at = now() WHERE id = ANY($1::bigint[])", [r.rows.map((x) => x.id)]);
    return lines.length;
  } catch {
    return 0;
  }
}

function logFinding(f: Finding, mode: string): void {
  console.warn(`[reconciler] ${JSON.stringify({ kind: f.kind, entity: f.entityHash, severity: f.severity, mode, action: f.action ?? null, ...f.detail })}`);
}

/**
 * Uma passada. `off` retorna sem tocar no banco. Só uma instância roda por vez (advisory lock de SESSÃO em cliente
 * dedicado; quem não obtém o lock devolve `skipped: "locked"`). Nunca lança.
 */
export async function runReconcilerPass(pool: Pool, env: NodeJS.ProcessEnv = process.env): Promise<ReconcilerResult> {
  // M-03: o modo vem de `genesis_runtime_config` (tenant explícito > global) com o env só como default de plataforma.
  const configured = await resolveReconcilerMode(pool, env).catch(() => reconcilerMode(env));
  if (configured === "off") return empty(configured, "off");
  // M-15: `on` sem os dois volumes verificáveis rebaixa para `shadow` (detecta, NÃO limpa) e registra o achado.
  const diskBad = reconcilerDiskProblems(env);
  const mode: ReconcilerMode = configured === "on" && diskBad.length > 0 ? "shadow" : configured;
  const p = resolveReconcilerParams(env);
  const lockClient = await pool.connect().catch(() => null);
  if (!lockClient) return empty(mode, "error");
  let locked = false;
  try {
    const got = await lockClient.query("SELECT pg_try_advisory_lock($1::int, $2::int) AS ok", [RECONCILER_LOCK_NS, RECONCILER_LOCK_KEY]);
    locked = got.rows[0]?.ok === true;
    if (!locked) return empty(mode, "locked");

    const res = empty(mode);
    const findings: Finding[] = [];
    const okKinds = new Set<FindingKind>();
    const run = async (kinds: FindingKind[], fn: () => Promise<void>) => {
      try { await fn(); kinds.forEach((k) => okKinds.add(k)); }
      catch (e) { console.error(`[reconciler] detector ${kinds[0]} falhou (ignorado):`, e instanceof Error ? e.message : String(e)); }
    };

    // Q1 — claim vencido (classifica e, em `on`, limpa só o que não tem efeito algum)
    const cleanedNow: Finding[] = [];
    await run(["claim_expired_no_effects", "claim_expired_with_effects"], async () => {
      for (const c of await loadExpiredClaims(pool, p)) {
        const disk = diskEffects(c.id, env);
        const effects: Json = { steps: c.steps, spec_files: c.specFiles, disk };
        const hasEffects = c.steps.length > 0 || c.specFiles > 0 || disk.length > 0;
        const base = { entityHash: hashId(c.id), projectHash: hashId(c.id), ticketHash: null as string | null };
        if (hasEffects) {
          findings.push({ ...base, kind: "claim_expired_with_effects", severity: "critical",
            detail: { lease_expired_s: c.ageS, version: c.version, steps: c.steps, spec_files: c.specFiles, disk, rule: "notify_only_resume_by_repeating_request" } });
          continue;
        }
        const f: Finding = { ...base, kind: "claim_expired_no_effects", severity: "warning", detail: { lease_expired_s: c.ageS, version: c.version, effects } };
        if (mode === "shadow") { f.action = "shadow_would_clean"; findings.push(f); continue; }
        if (await cleanExpiredClaim(pool, c, p)) {
          f.action = "cleaned_claim_expired_no_effects"; res.cleaned++; cleanedNow.push(f);
        } // rowCount 0: retomado ou já limpo por outro — não é achado
      }
    });
    // M-15: o rebaixamento (ou volumes ausentes em shadow) vira achado visível; some sozinho quando o ambiente é corrigido.
    await run(["reconciler_disk_unverifiable"], async () => {
      if (diskBad.length === 0) return;
      findings.push({ kind: "reconciler_disk_unverifiable", entityHash: hashId("reconciler_disk"), projectHash: null, ticketHash: null,
        severity: "critical", detail: { missing_or_invalid: diskBad, configured_mode: configured, effective_mode: mode,
          hint: "defina e monte PROJECT_FILES_ROOT e UPLOAD_DIR (os mesmos volumes do executor) antes de usar EVOLVE_RECONCILER=on" } });
    });
    // Q2/Q3/Q4/Q5
    await run(["ticket_promoted_without_child"], async () => { findings.push(...await detectTicketsWithoutChild(pool, p)); });
    await run(["child_ticket_mismatch"], async () => { findings.push(...await detectChildTicketMismatch(pool, p)); });
    await run(["evolution_in_flight_stuck"], async () => { findings.push(...await detectStuckInFlight(pool, p)); });
    await run(["uniqueness_index_missing"], async () => { findings.push(...await detectMissingIndexes(pool)); });
    await run(["card_status_divergence"], async () => { findings.push(...await detectCardDivergences(pool)); });
    // Fase 4 (M1): publicação do filho aceito que não fechou — detecta em `shadow`; em `on` marca `push_pending` (republicável) e notifica.
    await run(["evolution_publish_incomplete"], async () => {
      const before = cleanedNow.length;
      findings.push(...await detectIncompletePublish(pool, p, mode === "on" ? "on" : "shadow", cleanedNow));
      res.cleaned += cleanedNow.length - before;
    });
    // Fase 3 (3.5): card × filho. O Guard de custo pausa o filho (`stopped_by='budget'`) sem saber que há um card ligado a ele; aqui o card
    // vai a `blocked` (reason `budget:<código>`) e, com a pausa liberada, volta a `in_factory` — nunca `failed`. Só em `on` (age sobre dados).
    if (mode === "on") {
      const { syncCardsWithChildren } = await import("./cardPromote.js");
      res.cardsSynced = await syncCardsWithChildren(pool);
      // Fase 4 (4.3): card cujo filho já está `accepted` (merge feito no GitHub, aceite sem o gancho) é entregue pela mesma transição idempotente.
      const { deliverAcceptedCards } = await import("./cardDelivery.js");
      res.cardsDelivered = await deliverAcceptedCards(pool);
    }

    const seen = new Set<string>();
    for (const f of findings) {
      await upsertFinding(pool, f, mode);
      seen.add(`${f.kind}:${f.entityHash}`);
      res.detected++; res.byKind[f.kind] = (res.byKind[f.kind] ?? 0) + 1;
      logFinding(f, mode);
    }
    for (const f of cleanedNow) { // limpo agora: o achado nasce já resolvido, com a ação auditada
      await upsertFinding(pool, f, "on", true);
      seen.add(`${f.kind}:${f.entityHash}`);
      res.detected++; res.byKind[f.kind] = (res.byKind[f.kind] ?? 0) + 1;
      logFinding(f, mode);
    }
    res.resolved = await resolveGone(pool, ALL_KINDS.filter((k) => okKinds.has(k)), seen);
    if (mode === "on") res.notified = await notifyNew(pool);
    return res;
  } catch (e) {
    console.error("[reconciler] passada falhou (ignorado, nada depende dela):", e instanceof Error ? e.message : String(e));
    return empty(mode, "error");
  } finally {
    if (locked) await lockClient.query("SELECT pg_advisory_unlock($1::int, $2::int)", [RECONCILER_LOCK_NS, RECONCILER_LOCK_KEY]).catch(() => undefined);
    lockClient.release();
  }
}

// ── Consulta (rota admin) ────────────────────────────────────────────────────────────────
export interface FindingFilter { kind?: string; entityHash?: string; projectHash?: string; ticketHash?: string; open?: boolean; limit?: number }
export async function listFindings(db: Pick<Pool, "query">, f: FindingFilter = {}): Promise<Record<string, unknown>[]> {
  const where: string[] = []; const params: unknown[] = [];
  if (f.kind) { params.push(f.kind); where.push(`kind = $${params.length}`); }
  if (f.entityHash) { params.push(f.entityHash); where.push(`entity_hash = $${params.length}`); }
  if (f.projectHash) { params.push(f.projectHash); where.push(`project_hash = $${params.length}`); }
  if (f.ticketHash) { params.push(f.ticketHash); where.push(`ticket_hash = $${params.length}`); }
  if (f.open === true) where.push("resolved_at IS NULL");
  if (f.open === false) where.push("resolved_at IS NOT NULL");
  params.push(Math.min(500, Math.max(1, Math.floor(f.limit ?? 100))));
  const r = await db.query(
    `SELECT id, kind, entity_hash, project_hash, ticket_hash, severity, mode, detected_at, last_seen_at, resolved_at,
            action_taken, action_at, notified_at, seen_count, detail
       FROM evolve_reconciler_findings ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY detected_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

// ── Worker (padrão do anomalyWorker): com `off` nem agenda timer ─────────────────────────
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

async function nextDelayMs(pool: Pool): Promise<number> {
  const envMin = Number(process.env.EVOLVE_RECONCILER_INTERVAL_MIN);
  let min: number = Number.isFinite(envMin) && envMin > 0 ? envMin : RECONCILER_DEFAULTS.intervalMin;
  if (!(Number.isFinite(envMin) && envMin > 0)) {
    const cfg = await readRuntimeNumber(pool, RECONCILER_INTERVAL_KEY, null, { min: 1, max: 1440 }).catch(() => null);
    if (cfg) min = cfg;
  }
  return Math.max(60_000, min * 60_000);
}

export function startReconcilerWorker(getPool: () => Pool): void {
  // M-03: sem o atalho de env. O worker sempre agenda; cada passada consulta o modo efetivo (1 leitura de config a cada
  // intervalo) e, com `off`, retorna sem tocar nas tabelas do /evolve. Assim ligar/desligar por config não exige reinício.
  if (!stopped) return;
  stopped = false;
  const loop = async () => {
    if (stopped) return;
    try { await runReconcilerPass(getPool()); } catch { /* runReconcilerPass nunca lança */ }
    if (stopped) return;
    const delay = await nextDelayMs(getPool()).catch(() => RECONCILER_DEFAULTS.intervalMin * 60_000);
    timer = setTimeout(() => { void loop(); }, delay);
  };
  console.info(`[reconciler] iniciado (modo efetivo resolvido a cada passada; intervalo padrão=${RECONCILER_DEFAULTS.intervalMin}min)`);
  timer = setTimeout(() => { void loop(); }, 90_000);
}

export function stopReconcilerWorker(): void {
  stopped = true;
  if (timer) { clearTimeout(timer); timer = null; }
}
