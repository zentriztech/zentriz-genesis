/**
 * evolveClaim.ts — `/evolve` em DUAS ETAPAS (Fase 1' do plano EVOLUIR-PROJETO-BANCADA, tarefas 1.1 + 1.3;
 * desenho do Advisor em project/docs/analysis/EVOLUIR-PROJETO-H-desenho-tecnico-advisor.md §1, §2, §6).
 * Só roda com a flag `EVOLVE_CLAIM=on` (services/evolveFlags.ts); com `off` o handler histórico de
 * routes/projects.ts fica intocado.
 *
 *   ETAPA 1 — claim curto e transacional (conexão devolvida ao pool antes de qualquer passo lento):
 *     advisory lock por LINHAGEM (raiz) → idempotência (ticket_id | Idempotency-Key) → ticket FOR UPDATE →
 *     HEAD corrente (resolveLineageHead) → guard "um filho vivo por serviço" → versão = HEAD+1 → INSERT do
 *     filho em 'materializing' (já com o dono terminal do orçamento) → promoção do ticket com CAS
 *     (`WHERE status='open'`) NA MESMA transação. O filho só existe com o ticket promovido, e vice-versa.
 *   ETAPA 2 — passos idempotentes FORA da transação, marcados em `extra.materialization.steps`:
 *     spec_tree → code → ticket → triages → dialogue → finalize. Cada passo renova o lease (CAS por dono) e
 *     grava o marcador; uma repetição da mesma requisição retoma do ponto da falha (lease vencido) sem
 *     duplicar nada. O `git reset --hard` do passo `code` só roda enquanto o filho está 'materializing'.
 *
 * Respostas (H §2): 201 criado · 200 {replayed|resumed} · 409 EVOLUTION_IN_FLIGHT | MATERIALIZATION_IN_PROGRESS |
 * PARENT_SUPERSEDED | NO_ACCEPTED_HEAD | EVOLUTION_BUSY | TICKET_ALREADY_PROMOTED · 422 IDEMPOTENCY_KEY_REUSED ·
 * 402 (negativa do Guard / saldo livre mínimo — mesmo padrão do /run).
 */
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "crypto";
import type { AuthUser } from "../middleware/auth.js";
import { canAccessProjectRow } from "../lib/projectAccess.js";
import { sha256Hex } from "../lib/specTreeHash.js";
import { resolveLineageRoot, resolveLineageHead } from "./lineage.js";
import { loadTicket, ticketCode, evolutionRequestHeader, materializeTicketIntoSpecTree, type TicketRow } from "./tickets.js";
import { resolveInboxProductId } from "./inbox.js";
import { checkProjectBudgetGate, resolveBudgetOwner, getBudgetSpend } from "./llmGuard.js";
import { readEvolveMinFreeBudgetUsd } from "./evolveFlags.js";
import { isEvolutionUniqueViolation } from "./evolutionUniqueness.js";
import { gitLinkProjectFolder, checkoutNewBranch } from "./githubPush.js";
import { recomputeProductLifecycle } from "./productLifecycle.js";
import { inheritTriages } from "./findingTriage.js";

/** Espaço de chaves do advisory lock (forma de DOIS inteiros: não colide com as de 1 inteiro do credit-ledger). */
export const NS_EVOLVE = 7341;
export const LEASE_SECONDS = 600;
const LOCK_TIMEOUT = "5s";
const STATEMENT_TIMEOUT = "15s";

type Json = Record<string, unknown>;
export interface EvolveResult { status: number; body: Json; headers?: Record<string, string> }
export interface EvolveLog {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}
export interface EvolveClaimInput {
  parentId: string;
  user: AuthUser;
  ticketId: string;
  evolutionRequest: string;
  workMode: "copy" | "branch";
  idempotencyKey: string | null;
  log: EvolveLog;
}

// ── Injeção de falha (SÓ testes): simula a morte do processo em pontos exatos ─────────────
/** Lançada pelo hook de teste: NÃO é capturada pelo executor (lease e estado ficam como num crash real). */
export class SimulatedCrash extends Error {
  constructor(public readonly point: string) { super(`SimulatedCrash@${point}`); }
}
export const evolveTestHooks: { fault?: (point: string) => void } = {};
const fault = (point: string) => evolveTestHooks.fault?.(point);

class LeaseLost extends Error {}
class TerminalFailure extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

const iso = () => new Date().toISOString();
const retry = (s = 2) => ({ "Retry-After": String(s) });

// ── Orçamento (1.3) ───────────────────────────────────────────────────────────────────────
/**
 * Guard ANTES do claim: negativa ⇒ resposta sem criar filho. Padrão do produto (`/run`, pipeline.ts):
 * 402 com o código do Guard. Soma a regra de saldo livre mínimo (R1 do desenho: o filho divide o orçamento
 * do dono da versão corrente, então um filho que esgota o saldo PAUSA a versão em produção).
 * O Guard continua soberano: aqui só se consome `checkProjectBudgetGate`, `resolveBudgetOwner` e `getBudgetSpend`.
 */
async function budgetPreflight(pool: Pool, headCandidateId: string, tenantId: string | null): Promise<EvolveResult | null> {
  const gate = await checkProjectBudgetGate(pool, headCandidateId);
  if (!gate.ok) return { status: 402, body: { code: gate.code, message: gate.message } };
  const min = await readEvolveMinFreeBudgetUsd(pool, tenantId);
  if (min != null && min > 0) {
    const owner = await resolveBudgetOwner(pool, headCandidateId);
    if (owner && owner.budgetUsd != null) {
      const spend = await getBudgetSpend(pool, owner.ownerId);
      const free = owner.budgetUsd - spend.totalUsd;
      if (free < min) {
        return {
          status: 402,
          body: {
            code: "BUDGET_FREE_BELOW_MIN",
            message: `Saldo livre de US$ ${free.toFixed(2)} abaixo do mínimo de US$ ${min.toFixed(2)} exigido para abrir uma nova versão (o orçamento é compartilhado com a versão em produção). Aumente o orçamento.`,
            freeUsd: Math.round(free * 100) / 100,
            minFreeUsd: min,
          },
        };
      }
    }
  }
  return null;
}

// ── Idempotência ──────────────────────────────────────────────────────────────────────────
interface ExistingChild {
  id: string; status: string; version_number: number; parent_project_id: string | null;
  title: string; product_id: string | null; extra: Json; lease_valid: boolean;
}
async function findExisting(db: Pick<Pool | PoolClient, "query">, o: { ticketId: string | null; key: string | null; tenantId: string }): Promise<ExistingChild | null> {
  if (!o.ticketId && !o.key) return null;
  const r = await db.query(
    `SELECT id, status, version_number, parent_project_id, title, product_id, extra,
            COALESCE((extra->'materialization'->>'lease_until')::timestamptz > now(), false) AS lease_valid
       FROM projects
      WHERE status NOT IN ('failed', 'archived')
        AND ( ($1::text IS NOT NULL AND extra->>'ticket_id' = $1::text)
           OR ($2::text IS NOT NULL AND tenant_id = $3 AND extra->>'evolve_idempotency_key' = $2::text) )
      ORDER BY created_at DESC LIMIT 1`,
    [o.ticketId, o.key, o.tenantId],
  );
  return (r.rows[0] as ExistingChild | undefined) ?? null;
}

function replayBody(c: ExistingChild, extra: Json): Json {
  return {
    ok: true,
    replayed: true,
    childProjectId: c.id,
    parentProjectId: c.parent_project_id,
    lineageRootId: extra.evolution_root_id ?? null,
    versionNumber: c.version_number,
    workMode: extra.evolution_work_mode ?? null,
    evolutionSource: extra.evolution_source ?? null,
    evolutionSourceError: extra.evolution_source_error ?? null,
    inheritedFiles: extra.evolution_inherited_files ?? null,
    title: c.title,
    status: c.status,
    message: "Esta evolução já foi criada por uma requisição anterior com a mesma chave de idempotência.",
  };
}

const inProgress = (childId: string, version: number): EvolveResult => ({
  status: 409,
  body: {
    code: "MATERIALIZATION_IN_PROGRESS",
    message: `A evolução v${version} está sendo materializada por outra requisição. Aguarde e repita; a repetição é segura.`,
    childProjectId: childId,
  },
  headers: retry(),
});

async function respondExisting(
  pool: Pool, ex: ExistingChild,
  ctx: { reqSha: string; key: string | null; ticketId: string | null; user: AuthUser; log: EvolveLog },
): Promise<EvolveResult> {
  const extra = ex.extra ?? {};
  if (!ctx.ticketId && ctx.key && extra.evolve_request_sha && extra.evolve_request_sha !== ctx.reqSha) {
    return { status: 422, body: { code: "IDEMPOTENCY_KEY_REUSED", message: "A Idempotency-Key já foi usada com um pedido diferente.", childProjectId: ex.id } };
  }
  if (ex.status === "materializing") {
    if (ex.lease_valid) return inProgress(ex.id, ex.version_number);
    // claim vencido (crash/falha): assume e RETOMA do último marcador
    const r = await materialize(pool, ex.id, randomUUID(), ctx.user, ctx.log);
    if (r.status === 201) return { status: 200, body: { ...r.body, resumed: true } };
    return r;
  }
  return { status: 200, body: replayBody(ex, extra) };
}

// ── Entrada ───────────────────────────────────────────────────────────────────────────────
export async function runEvolveWithClaim(pool: Pool, input: EvolveClaimInput): Promise<EvolveResult> {
  const { parentId, user, ticketId, evolutionRequest, workMode, log } = input;

  const parentRow = (await pool.query(
    "SELECT id, title, status, product_id, tenant_id, created_by, version_number, complexity_hint FROM projects WHERE id = $1",
    [parentId],
  )).rows[0] as Record<string, unknown> | undefined;
  if (!parentRow || !canAccessProjectRow(user, parentRow)) {
    return { status: 404, body: { code: "NOT_FOUND", message: "Projeto não encontrado" } };
  }
  if (parentRow.status !== "accepted") {
    return { status: 409, body: { code: "CONFLICT", message: `Evolução só permitida em projetos aceitos. Status atual: ${parentRow.status}` } };
  }
  const tenantId = String(parentRow.tenant_id);

  let ticket: TicketRow | null = null;
  if (ticketId) {
    const t = await loadTicket(pool, ticketId);
    if (!t || !canAccessProjectRow(user, t)) {
      return { status: 404, body: { code: "TICKET_NOT_FOUND", message: "Pedido não encontrado" } };
    }
    if (t.product_id !== (parentRow.product_id as string | null)) {
      return { status: 400, body: { code: "TICKET_WRONG_PRODUCT", message: "O pedido é de outro produto." } };
    }
    ticket = t;
  }
  const requestText = ticket ? ticket.body : evolutionRequest;
  // Chave de idempotência: o ticket quando há (D-A1: sem número de tentativa); senão o header opcional.
  const key = ticket ? null : input.idempotencyKey;
  const reqSha = sha256Hex(`${parentId}|${requestText}|${workMode}`);
  const idemCtx = { reqSha, key, ticketId: ticket?.id ?? null, user, log };

  // Repetição de uma requisição já aceita: resolve ANTES de checar pedido/orçamento (uma repetição não cria nada novo).
  const pre = await findExisting(pool, { ticketId: ticket?.id ?? null, key, tenantId });
  if (pre) return respondExisting(pool, pre, idemCtx);

  if (ticket && ticket.status !== "open") {
    return {
      status: 409,
      body: {
        code: "TICKET_ALREADY_PROMOTED",
        message: `${ticketCode(ticket.number)} já foi promovido (status ${ticket.status}).`,
        childProjectId: ticket.child_project_id,
      },
    };
  }
  if (!requestText) {
    return { status: 400, body: { code: "BAD_REQUEST", message: "Campo 'request' é obrigatório (descreva o que evoluir)." } };
  }

  // 1.3 — Guard e saldo mínimo ANTES do claim: negativa ⇒ nenhum filho nasce.
  const denied = await budgetPreflight(pool, parentId, tenantId);
  if (denied) return denied;

  // Produto da nova versão (§4.6, migration 064) — mesma regra do caminho histórico; find-or-create idempotente, fora do lock.
  const parentProductId = (parentRow.product_id as string | null) ?? null;
  let childProductId: string;
  if (parentProductId) {
    const prod = (await pool.query("SELECT status, is_inbox FROM products WHERE id = $1 AND tenant_id = $2", [parentProductId, tenantId])).rows[0] as
      { status: string; is_inbox: boolean } | undefined;
    childProductId = (!prod || prod.is_inbox || prod.status === "archived")
      ? await resolveInboxProductId(pool, tenantId, user.id)
      : parentProductId;
  } else {
    childProductId = await resolveInboxProductId(pool, tenantId, user.id);
  }

  const root = await resolveLineageRoot(pool, parentId);
  const rootId = root?.id ?? parentId;

  let outcome: ClaimOutcome;
  try {
    outcome = await claim(pool, { parentId, rootId, parentRow, user, ticket, requestText, workMode, key, reqSha, childProductId, tenantId });
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "55P03" || code === "57014") {
      return {
        status: 409,
        body: { code: "EVOLUTION_BUSY", message: "Outra evolução desta linhagem está sendo registrada neste instante. Repita em instantes." },
        headers: retry(),
      };
    }
    if (isEvolutionUniqueViolation(e)) {
      // Corrida perdida no índice (rede de segurança): relê quem ganhou e responde 409/200.
      const again = await findExisting(pool, { ticketId: ticket?.id ?? null, key, tenantId });
      if (again) return respondExisting(pool, again, idemCtx);
      const live = await liveChildOf(pool, parentId);
      return live ? inFlightResult(live) : { status: 409, body: { code: "EVOLUTION_IN_FLIGHT", message: "Já existe uma evolução em andamento deste projeto." } };
    }
    throw e;
  }

  if (outcome.kind === "reject") return outcome.result;
  if (outcome.kind === "existing") return respondExisting(pool, outcome.child, idemCtx);

  fault("after_claim");
  return materialize(pool, outcome.childId, outcome.claimId, user, log);
}

// ── Etapa 1: claim ────────────────────────────────────────────────────────────────────────
type ClaimOutcome =
  | { kind: "created"; childId: string; claimId: string }
  | { kind: "existing"; child: ExistingChild }
  | { kind: "reject"; result: EvolveResult };

type InFlightRow = ExistingChild;
async function liveChildOf(db: Pick<Pool | PoolClient, "query">, headId: string): Promise<InFlightRow | undefined> {
  return (await db.query(
    `SELECT id, status, version_number, parent_project_id, title, product_id, extra,
            COALESCE((extra->'materialization'->>'lease_until')::timestamptz > now(), false) AS lease_valid
       FROM projects
      WHERE parent_project_id = $1 AND status NOT IN ('accepted', 'archived', 'failed')
      ORDER BY created_at DESC LIMIT 1`,
    [headId],
  )).rows[0] as InFlightRow | undefined;
}
function inFlightResult(f: InFlightRow): EvolveResult {
  return {
    status: 409,
    body: {
      code: "EVOLUTION_IN_FLIGHT",
      message: `Já existe uma evolução em andamento deste projeto (v${f.version_number}, status ${f.status}). Conclua-a, ou descarte-a com DELETE /api/projects/${f.id} (Meus apps → Excluir) antes de abrir outra.`,
      childProjectId: f.id,
      hint: `DELETE /api/projects/${f.id}`,
    },
  };
}

async function claim(pool: Pool, a: {
  parentId: string; rootId: string; parentRow: Record<string, unknown>; user: AuthUser; ticket: TicketRow | null;
  requestText: string; workMode: "copy" | "branch"; key: string | null; reqSha: string; childProductId: string; tenantId: string;
}): Promise<ClaimOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [NS_EVOLVE, a.rootId]);

    // (a) idempotência sob o lock
    const ex = await findExisting(client, { ticketId: a.ticket?.id ?? null, key: a.key, tenantId: a.tenantId });
    if (ex) { await client.query("ROLLBACK"); return { kind: "existing", child: ex }; }

    // (b) ticket travado
    let ticket = a.ticket;
    if (ticket) {
      const t = (await client.query("SELECT * FROM tickets WHERE id = $1 FOR UPDATE", [ticket.id])).rows[0] as TicketRow | undefined;
      if (!t || t.status !== "open") {
        await client.query("ROLLBACK");
        return {
          kind: "reject",
          result: {
            status: 409,
            body: {
              code: "TICKET_ALREADY_PROMOTED",
              message: `${ticketCode(ticket.number)} já foi promovido (status ${t?.status ?? "inexistente"}).`,
              childProjectId: t?.child_project_id ?? null,
            },
          },
        };
      }
      ticket = t;
    }

    // (c) HEAD corrente
    const head = await resolveLineageHead(client, a.rootId);
    if (!head) {
      await client.query("ROLLBACK");
      return { kind: "reject", result: { status: 409, body: { code: "NO_ACCEPTED_HEAD", message: "A linhagem não tem versão aceita para evoluir." } } };
    }
    if (head.id !== a.parentId) {
      await client.query("ROLLBACK");
      return {
        kind: "reject",
        result: { status: 409, body: { code: "PARENT_SUPERSEDED", message: "Este projeto já foi superado por uma versão mais nova — evolua a versão corrente.", currentProjectId: head.id } },
      };
    }

    // (d) um filho vivo por serviço
    const inFlight = await liveChildOf(client, head.id);
    if (inFlight) {
      await client.query("ROLLBACK");
      // Pedido idêntico (mesmo pai, texto e modo) cujo claim VENCEU (crash/falha): é a mesma intenção — retoma em vez de
      // exigir DELETE. Vale também sem ticket e sem Idempotency-Key. Lease vigente ou pedido diferente ⇒ 409 histórico.
      if (inFlight.status === "materializing" && !inFlight.lease_valid && inFlight.extra?.evolve_request_sha === a.reqSha) {
        return { kind: "existing", child: inFlight };
      }
      return { kind: "reject", result: inFlightResult(inFlight) };
    }

    // (e) versão contra o HEAD; título como no caminho histórico
    const nextVersion = head.version_number + 1;
    const childTitle = `${String(head.title ?? "").replace(/ — Evolução v\d+$/i, "")} — Evolução v${nextVersion}`;
    const headExtra = ((await client.query("SELECT extra, complexity_hint FROM projects WHERE id = $1", [head.id])).rows[0] ?? {}) as { extra?: Json; complexity_hint?: string | null };
    const parentExtra = (headExtra.extra ?? {}) as Json;
    const inheritedDeployPrefs: Json = {};
    for (const k of ["delivery_mode", "deploy_connection_id", "deploy_format", "deploy_ttl_days", "project_type", "runtime_target", "api_url"]) {
      if (parentExtra[k] !== undefined && parentExtra[k] !== null) inheritedDeployPrefs[k] = parentExtra[k];
    }

    // 1.3 — dono TERMINAL do orçamento da versão corrente (resolveBudgetOwner só sobe um nível)
    const owner = await resolveBudgetOwner(client, head.id);
    const ownerId = owner?.ownerId ?? head.id;

    const claimId = randomUUID();
    const extra: Json = {
      ...inheritedDeployPrefs,
      evolution: true,
      evolution_request: a.requestText,
      ...(ticket ? { ticket_id: ticket.id, ticket_number: ticket.number, ticket_kind: ticket.change_kind } : {}),
      evolution_work_mode: a.workMode,
      evolution_parent_id: head.id,
      evolution_root_id: a.rootId,
      evolution_branch: `evolution/v${nextVersion}`,
      evolve_request_sha: a.reqSha,
      ...(a.key ? { evolve_idempotency_key: a.key } : {}),
      materialization: { claim_id: claimId, lease_owner: claimId, attempt: 1, head_project_id: head.id, steps: {} },
    };

    // (f) INSERT em 'materializing' (U1/U2/U3/U4 são a rede de segurança)
    const ins = await client.query(
      `INSERT INTO projects
         (tenant_id, created_by, title, status, product_id, parent_project_id, version_number, budget_owner_project_id,
          extra, complexity_hint, updated_at)
       VALUES ($1, $2, $3, 'materializing', $4, $5, $6, $7,
               jsonb_set($8::jsonb, '{materialization,lease_until}', to_jsonb(now() + interval '${LEASE_SECONDS} seconds')),
               $9, now())
       RETURNING id`,
      [head.tenant_id ?? a.parentRow.tenant_id, a.user.id, childTitle, a.childProductId, head.id, nextVersion, ownerId,
        JSON.stringify(extra), headExtra.complexity_hint ?? (a.parentRow.complexity_hint ?? null)],
    );
    const childId = String(ins.rows[0].id);

    // (g) promoção do ticket com CAS, na MESMA transação (corrige o defeito (b) do estudo F)
    if (ticket) {
      const up = await client.query(
        `UPDATE tickets SET status = 'promoted', child_project_id = $2, promoted_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'open' RETURNING id`,
        [ticket.id, childId],
      );
      if ((up.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return { kind: "reject", result: { status: 409, body: { code: "TICKET_ALREADY_PROMOTED", message: `${ticketCode(ticket.number)} já foi promovido.` } } };
      }
    }

    fault("before_commit");
    await client.query("COMMIT");
    return { kind: "created", childId, claimId };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* conexão já caiu */ }
    throw e;
  } finally {
    client.release(); // F4: a conexão volta ao pool ANTES dos passos lentos (clone git etc.)
  }
}

// ── Etapa 2: executor idempotente com lease ───────────────────────────────────────────────
async function takeOrRenewLease(pool: Pool, childId: string, me: string): Promise<Json | null> {
  const r = await pool.query(
    `UPDATE projects
        SET extra = jsonb_set(jsonb_set(extra, '{materialization,lease_until}', to_jsonb(now() + interval '${LEASE_SECONDS} seconds')),
                              '{materialization,lease_owner}', to_jsonb($2::text)),
            updated_at = now()
      WHERE id = $1 AND status = 'materializing'
        AND (extra->'materialization'->>'lease_owner' = $2::text
             OR (extra->'materialization'->>'lease_until')::timestamptz < now())
      RETURNING COALESCE(extra->'materialization'->'steps', '{}'::jsonb) AS steps`,
    [childId, me],
  );
  return r.rows[0] ? (r.rows[0].steps as Json) : null;
}
async function releaseLease(pool: Pool, childId: string, me: string): Promise<void> {
  await pool.query(
    `UPDATE projects SET extra = jsonb_set(extra, '{materialization,lease_until}', to_jsonb(now() - interval '1 second')), updated_at = now()
      WHERE id = $1 AND status = 'materializing' AND extra->'materialization'->>'lease_owner' = $2::text`,
    [childId, me],
  ).catch(() => undefined);
}
async function markStep(pool: Pool, childId: string, me: string, name: string, value: Json): Promise<void> {
  const r = await pool.query(
    `UPDATE projects
        SET extra = jsonb_set(extra, ARRAY['materialization','steps',$2::text], $3::jsonb), updated_at = now()
      WHERE id = $1 AND status = 'materializing' AND extra->'materialization'->>'lease_owner' = $4::text`,
    [childId, name, JSON.stringify(value), me],
  );
  if ((r.rowCount ?? 0) === 0) throw new LeaseLost();
}

async function materialize(pool: Pool, childId: string, me: string, user: AuthUser, log: EvolveLog): Promise<EvolveResult> {
  const childRow = (await pool.query(
    "SELECT id, title, status, product_id, parent_project_id, version_number, extra FROM projects WHERE id = $1",
    [childId],
  )).rows[0] as { id: string; title: string; status: string; product_id: string | null; parent_project_id: string; version_number: number; extra: Json } | undefined;
  if (!childRow) return { status: 404, body: { code: "NOT_FOUND", message: "Projeto não encontrado" } };
  if (childRow.status !== "materializing") {
    return { status: 200, body: replayBody({ ...childRow, lease_valid: false }, childRow.extra ?? {}) };
  }
  const steps0 = await takeOrRenewLease(pool, childId, me);
  if (!steps0) return inProgress(childId, childRow.version_number);
  const steps = steps0 as Record<string, Json>;

  const extra = childRow.extra ?? {};
  const mat = (extra.materialization ?? {}) as Json;
  const claimId = String(mat.claim_id ?? "");
  const headId = String(mat.head_project_id ?? childRow.parent_project_id);
  const rootId = String(extra.evolution_root_id ?? headId);
  const version = childRow.version_number;
  const requestText = String(extra.evolution_request ?? "");
  const workMode = extra.evolution_work_mode === "branch" ? "branch" : "copy";
  const ticketId = typeof extra.ticket_id === "string" ? extra.ticket_id : null;

  try {
    const head = (await pool.query("SELECT id, title, product_id FROM projects WHERE id = $1", [headId])).rows[0] as
      { id: string; title: string; product_id: string | null } | undefined;
    if (!head) throw new TerminalFailure("HEAD_NOT_FOUND", "A versão corrente da linhagem não existe mais.");
    const ticket = ticketId ? (await loadTicket(pool, ticketId)) ?? null : null;

    const runStep = async (name: string, work: () => Promise<Json>) => {
      if (steps[name]) return; // já marcado em tentativa anterior
      if (!(await takeOrRenewLease(pool, childId, me))) throw new LeaseLost();
      fault(`before:${name}`);
      const out = await work();
      fault(`after_work:${name}`);
      const marker = { ...out, at: iso() };
      await markStep(pool, childId, me, name, marker);
      steps[name] = marker;
      fault(`after_mark:${name}`);
    };

    // S1 — árvore de spec: copia os arquivos da versão corrente (upsert + arquivo temporário/rename)
    await runStep("spec_tree", () => stepSpecTree(pool, { childId, headId, version, requestText, ticket }));
    // S2 — código: clone do repo `dev` em evolution/vN (ou cópia do apps/ da versão corrente)
    await runStep("code", () => stepCode(pool, { childId, headId, rootId, version, headProductId: head.product_id, log }));
    // S3 — request.md do ticket (+ anexos) na árvore da spec
    if (ticket) {
      await runStep("ticket", async () => {
        const mat3 = await materializeTicketIntoSpecTree(pool, {
          ticket, childProjectId: childId, authorEmail: user.email, projectTitle: String(head.title ?? ""), versionLabel: `v${version}`,
        });
        if (!mat3.ok) log.warn({ childId, ticketId: ticket.id, err: mat3.error }, "[evolve] materialização do ticket falhou");
        return { files: mat3.files, error: mat3.ok ? null : (mat3.error ?? "falhou") };
      });
    }
    // S4 — triagens de GAPs vivas da versão corrente
    await runStep("triages", async () => {
      let n = 0;
      try {
        n = await inheritTriages(pool, headId, childId);
      } catch (err) {
        log.warn({ err, childId }, "[evolve] herança de triagens falhou (não crítico)");
      }
      return { n };
    });
    // S5 — mensagem no diálogo do filho
    await runStep("dialogue", async () => {
      const src = String(steps.code?.source ?? "none");
      const inherited = Number(steps.spec_tree?.files ?? 0);
      await pool.query(
        `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human)
         VALUES ($1, 'system', 'system', 'step', $2)`,
        [childId, `🔄 Evolução v${version} criada a partir de "${head.title}". Código-base: ${src === "git-clone" ? `clone do repo (dev) em evolution/v${version}` : src === "disk-copy" ? "cópia do apps/ do pai (sem repo GitHub — Deadpool pode ter alterado)" : "NENHUM (apps/ vazio — verifique PROJECT_FILES_ROOT/repo)"}. Arquivos herdados: ${inherited}. Pedido${ticket ? ` ${ticketCode(ticket.number)}` : ""}: "${requestText}"`],
      );
      return { posted: true };
    });

    // S6 — finalize: CAS por status + claim_id + dono do lease
    fault("before_finalize");
    const inheritedFiles = Number(steps.spec_tree?.files ?? 0);
    const finalExtra: Json = {
      evolution_source: steps.code?.source ?? "none",
      evolution_source_error: steps.code?.error ?? null,
      evolution_inherited_files: inheritedFiles,
      evolution_inherited_spec: steps.spec_tree?.inherited_spec ?? [],
      ...(ticket ? { ticket_files: steps.ticket?.files ?? [], ticket_materialize_error: steps.ticket?.error ?? null } : {}),
    };
    const fin = await pool.query(
      `UPDATE projects
          SET status = $3,
              extra = jsonb_set(COALESCE(extra, '{}'::jsonb) || $4::jsonb, '{materialization,finalized_at}', to_jsonb(now())),
              updated_at = now()
        WHERE id = $1 AND status = 'materializing'
          AND extra->'materialization'->>'claim_id' = $2::text
          AND extra->'materialization'->>'lease_owner' = $5::text
        RETURNING id`,
      [childId, claimId, inheritedFiles > 0 ? "spec_submitted" : "draft", JSON.stringify(finalExtra), me],
    );
    if ((fin.rowCount ?? 0) === 0) throw new LeaseLost();
    await recomputeProductLifecycle(pool, childRow.product_id); // best-effort por contrato (nunca lança)
    fault("after_finalize");

    log.info({ parentId: headId, childId, version, workMode, evolutionSource: finalExtra.evolution_source, inherited: inheritedFiles }, "[evolve] Projeto filho criado (claim)");
    return {
      status: 201,
      body: {
        ok: true,
        childProjectId: childId,
        parentProjectId: headId,
        lineageRootId: rootId,
        versionNumber: version,
        workMode,
        evolutionSource: finalExtra.evolution_source,
        evolutionSourceError: finalExtra.evolution_source_error,
        inheritedFiles,
        title: childRow.title,
        message: "Projeto de evolução criado. Envie ao pipeline via POST /run quando estiver pronto.",
      },
    };
  } catch (e) {
    if (e instanceof SimulatedCrash) throw e; // processo "morto": lease e marcadores ficam como estão
    if (e instanceof LeaseLost) return inProgress(childId, version);
    if (e instanceof TerminalFailure) return failTerminal(pool, childId, rootId, e);
    await releaseLease(pool, childId, me); // falha recuperável: libera para a repetição retomar já
    log.warn({ err: e, childId }, "[evolve] materialização interrompida — repetir a requisição retoma");
    return {
      status: 500,
      body: { code: "MATERIALIZATION_FAILED", message: "A materialização da evolução foi interrompida. Repita a requisição: ela retoma do ponto da falha.", childProjectId: childId },
    };
  }
}

/** Falha terminal: filho `failed` + ticket volta a `open` (a execução morreu, o pedido não — RFC-0009 inv. 3). */
async function failTerminal(pool: Pool, childId: string, rootId: string, f: TerminalFailure): Promise<EvolveResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [NS_EVOLVE, rootId]);
    await client.query(
      `UPDATE projects
          SET status = 'failed',
              extra = jsonb_set(COALESCE(extra, '{}'::jsonb), '{materialization,error}', $2::jsonb),
              updated_at = now()
        WHERE id = $1 AND status = 'materializing'`,
      [childId, JSON.stringify({ code: f.code, message: f.message, at: iso() })],
    );
    await client.query(
      `UPDATE tickets SET status = 'open', child_project_id = NULL, promoted_at = NULL, updated_at = now()
        WHERE child_project_id = $1 AND status = 'promoted'`,
      [childId],
    );
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
  return { status: 422, body: { code: f.code, message: f.message, childProjectId: childId } };
}

// ── Passos ────────────────────────────────────────────────────────────────────────────────
async function stepSpecTree(
  pool: Pool,
  a: { childId: string; headId: string; version: number; requestText: string; ticket: TicketRow | null },
): Promise<Json> {
  const rows = (await pool.query(
    "SELECT file_path, filename, mime_type, rel_dir, is_primary FROM project_spec_files WHERE project_id = $1 ORDER BY is_primary DESC, created_at ASC",
    [a.headId],
  )).rows as Array<{ file_path: string; filename: string; mime_type: string | null; rel_dir: string | null; is_primary: boolean }>;

  let inherited = 0;
  const inheritedSpec: Array<{ path: string; sha: string }> = [];
  if (rows.length > 0) {
    const { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } = await import("fs");
    const { join } = await import("path");
    const uploadDir = (process.env.UPLOAD_DIR ?? "/shared/uploads").trim();
    const childSpecDir = join(uploadDir, a.childId);
    mkdirSync(childSpecDir, { recursive: true });
    const primary = rows.find((r) => r.is_primary) ?? rows[0];
    for (const r of rows) {
      if (!r.file_path || !existsSync(r.file_path)) continue;
      const isPrimary = r === primary;
      const relDir = (r.rel_dir ?? "").replace(/^\/+|\/+$/g, "");
      const original = readFileSync(r.file_path);
      const filename = isPrimary ? `spec-evolution-v${a.version}.md` : r.filename;
      const content = isPrimary
        ? Buffer.from(`${evolutionRequestHeader(a.version, a.ticket)}\n\n> ${a.requestText}\n\n---\n\n` + original.toString("utf-8"), "utf-8")
        : original;
      const dir = relDir ? join(childSpecDir, relDir) : childSpecDir;
      mkdirSync(dir, { recursive: true });
      const childPath = join(dir, filename);
      const tmp = `${childPath}.tmp-${process.pid}`;
      writeFileSync(tmp, content);
      renameSync(tmp, childPath);
      await pool.query(
        `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (project_id, rel_dir, filename)
         DO UPDATE SET file_path = EXCLUDED.file_path, mime_type = EXCLUDED.mime_type, is_primary = EXCLUDED.is_primary, content_sha256 = EXCLUDED.content_sha256`,
        [a.childId, filename, childPath, r.mime_type ?? "text/markdown", isPrimary ? "" : relDir, isPrimary, sha256Hex(content)],
      );
      if (!isPrimary) inheritedSpec.push({ path: relDir ? `${relDir}/${filename}` : filename, sha: sha256Hex(content) });
      inherited++;
    }
    if (inherited === 0) {
      throw new TerminalFailure("HEAD_SPEC_UNREADABLE", "Nenhum arquivo de spec da versão corrente pôde ser lido do disco; a evolução não foi criada.");
    }
  }
  return { files: inherited, inherited_spec: inheritedSpec };
}

async function stepCode(
  pool: Pool,
  a: { childId: string; headId: string; rootId: string; version: number; headProductId: string | null; log: EvolveLog },
): Promise<Json> {
  let source: "git-clone" | "disk-copy" | "none" = "none";
  let error: string | null = null;
  try {
    const { existsSync, mkdirSync, cpSync, rmSync, readdirSync } = await import("fs");
    const { join } = await import("path");
    const filesRoot = (process.env.PROJECT_FILES_ROOT ?? "").trim();
    if (filesRoot) {
      const childApps = join(filesRoot, a.childId, "apps");
      mkdirSync(childApps, { recursive: true });
      const repoRow = (await pool.query(
        `SELECT gr.repo_url, gi.installation_id
           FROM project_github_repos gr
           JOIN projects p ON p.id = gr.project_id
           LEFT JOIN tenant_github_installations gi ON gi.tenant_id = p.tenant_id
          WHERE gr.project_id = ANY($1::uuid[])
          ORDER BY (gr.project_id = $2) DESC LIMIT 1`,
        [[a.rootId, a.headId], a.rootId],
      )).rows[0] as { repo_url: string; installation_id: number | null } | undefined;
      const fullName = repoRow?.repo_url ? repoRow.repo_url.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "") : null;
      if (fullName && repoRow?.installation_id) {
        // Reexecutável: `git init` em repo existente, remote remove/add, fetch --depth=1 + checkout -B + reset --hard
        // origin/dev. O reset é seguro SÓ porque o filho está 'materializing' (nada foi trabalhado nele ainda).
        const link = await gitLinkProjectFolder({ projectId: a.childId, fullName, installationId: Number(repoRow.installation_id), branch: "dev" });
        if (link.ok) {
          const br = await checkoutNewBranch(a.childId, `evolution/v${a.version}`);
          source = "git-clone";
          if (!br.ok) error = `branch local não criado: ${br.error}`;
        } else {
          error = link.error ?? "git-link falhou";
        }
      }
      if (source !== "git-clone") {
        const hasContent = (dir: string) => {
          try { return readdirSync(dir).some((n) => ![".git", "node_modules", ".next", "dist"].includes(n)); } catch { return false; }
        };
        const candidates = [
          join(filesRoot, a.headId, "apps"),
          ...(a.headProductId ? [join(filesRoot, a.headProductId, a.headId, "apps")] : []),
        ];
        const src = candidates.find((c) => existsSync(c) && hasContent(c));
        if (src) {
          // Reexecução: começa do zero (cópia parcial anterior) — seguro só em 'materializing'.
          rmSync(childApps, { recursive: true, force: true });
          mkdirSync(childApps, { recursive: true });
          cpSync(src, childApps, { recursive: true, filter: (s) => !/(^|\/)(node_modules|\.next|dist|__pycache__|\.venv|venv)(\/|$)/.test(s) });
          source = "disk-copy";
          if (existsSync(join(childApps, ".git"))) {
            const br = await checkoutNewBranch(a.childId, `evolution/v${a.version}`);
            if (!br.ok) error = `branch local não criado (disk-copy): ${br.error}`;
          } else {
            error = (error ? error + "; " : "") + "cópia sem .git — sem branch evolution/vN";
          }
        }
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    a.log.warn({ err, childId: a.childId }, "[evolve] Falha ao preparar o código do filho");
  }
  return { source, error };
}
