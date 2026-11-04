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
 *     M-04: durante o passo o lease é PULSADO (heartbeat a cada LEASE/3, CAS por `lease_owner`); perdeu o lease ⇒ o
 *     trabalho aborta antes de qualquer efeito destrutivo e `failTerminal` só vale para quem ainda é o dono.
 *     M-05: erro TRANSITÓRIO de git/rede/disco ⇒ lança (500 MATERIALIZATION_FAILED, lease liberado, a repetição retoma);
 *     PERMANENTE ⇒ TerminalFailure. O marcador do passo só é gravado quando ele concluiu de fato.
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
import { recordTicketEvent, ticketTransitionsEnabled } from "./ticketTransitions.js";
import { inheritTriages } from "./findingTriage.js";
import { transitionCard } from "./cardState.js";
import { computeCurrentSpecHash } from "./specValidation.js";
import { evaluateCardKindGate, type CardKind } from "./evolutionGate.js";
import { cardAttachmentsSnapshot } from "./cardAttachments.js";
import { findBaseCollisions, loadCardDraftInfo } from "./cardSpecGuard.js";

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
/**
 * Fase 2 (2.6): promoção de CARD. O mesmo claim em duas etapas, adaptado: `parentId` é o HEAD registrado na maturação do card
 * (`card_ready.base_head_project_id`); o HEAD corrente diferente ⇒ 409 CARD_BASE_STALE; o ticket precisa estar `ready` e a promoção
 * do ticket é `ready → promoted` PELA máquina de estados (mesma transação do INSERT do filho); a etapa 2 ganha o passo `card_spec`
 * (move a spec do rascunho para o filho). Sem `card`, nada muda no caminho legado.
 */
export interface EvolveCardInput { draftProjectId: string; actorId: string }
export interface EvolveClaimInput {
  card?: EvolveCardInput;
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
export const evolveTestHooks: {
  fault?: (point: string) => void;
  /** SÓ testes: await no meio do trabalho de cada passo (`during:<passo>`) — simula passo longo (M-04). */
  stall?: (point: string) => Promise<void>;
  /** SÓ testes: período do heartbeat do lease, em ms (padrão LEASE/3). */
  heartbeatMs?: number;
} = {};
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
/**
 * M-23: dono do orçamento com herança. Linhagem mista (HEAD criado pelo /evolve legado, `budget_usd` NULL e sem dono) não
 * pode travar a evolução se um ANCESTRAL (avô…raiz) tem orçamento: sobe `parent_project_id` (≤ 8 níveis) até achar um dono
 * com `budget_usd`. Devolve o projeto-âncora (para o Guard) e o dono terminal; `null` = nenhum na cadeia.
 */
export async function resolveBudgetAnchor(db: Pick<Pool | PoolClient, "query">, projectId: string): Promise<{ anchorId: string; ownerId: string; inherited: boolean } | null> {
  let cur: string | null = projectId;
  for (let depth = 0; cur && depth < 8; depth++) {
    const owner = await resolveBudgetOwner(db, cur);
    if (owner && owner.budgetUsd != null) return { anchorId: cur, ownerId: owner.ownerId, inherited: depth > 0 };
    cur = ((await db.query("SELECT parent_project_id FROM projects WHERE id = $1", [cur])).rows[0]?.parent_project_id as string | null | undefined) ?? null;
  }
  return null;
}

export async function budgetPreflight(pool: Pool, headCandidateId: string, tenantId: string | null, versionNumber: number): Promise<EvolveResult | null> {
  const anchor = await resolveBudgetAnchor(pool, headCandidateId);
  const gateTarget = anchor?.anchorId ?? headCandidateId;
  const gate = await checkProjectBudgetGate(pool, gateTarget);
  if (!gate.ok) {
    if (gate.code === "BUDGET_MISSING") {
      return { status: 402, body: {
        code: "BUDGET_MISSING",
        message: `A versão corrente (v${versionNumber}) não tem orçamento de LLM e nenhuma versão anterior da linhagem tem (linhagem mista, criada pelo fluxo antigo). Defina o orçamento em US$ na página da versão corrente antes de evoluir.`,
        projectId: headCandidateId,
      } };
    }
    return { status: 402, body: { code: gate.code, message: gate.message } };
  }
  const min = await readEvolveMinFreeBudgetUsd(pool, tenantId);
  if (min != null && min > 0) {
    const owner = await resolveBudgetOwner(pool, gateTarget);
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
  // M-21: crash entre o COMMIT do finalize e o recompute deixaria o lifecycle do produto velho. Replay de um filho
  // finalizado há pouco (< 15 min) reexecuta o recompute (idempotente, best-effort).
  const finalizedAt = Date.parse(String(((extra.materialization ?? {}) as Json).finalized_at ?? ""));
  if (Number.isFinite(finalizedAt) && Date.now() - finalizedAt < 15 * 60_000) {
    await recomputeProductLifecycle(pool, ex.product_id);
  }
  return { status: 200, body: replayBody(ex, extra) };
}

// ── Entrada ───────────────────────────────────────────────────────────────────────────────
export async function runEvolveWithClaim(pool: Pool, input: EvolveClaimInput): Promise<EvolveResult> {
  const { parentId, user, ticketId, evolutionRequest, workMode, log, card } = input;

  const parentRow = (await pool.query(
    "SELECT id, title, status, product_id, tenant_id, created_by, version_number, complexity_hint FROM projects WHERE id = $1",
    [parentId],
  )).rows[0] as Record<string, unknown> | undefined;
  if (!parentRow || !canAccessProjectRow(user, parentRow)) {
    return { status: 404, body: { code: "NOT_FOUND", message: "Projeto não encontrado" } };
  }
  if (parentRow.status !== "accepted") {
    if (card) return { status: 409, body: { code: "CARD_BASE_STALE", message: `A versão-base do card (status ${parentRow.status}) não é mais uma versão aceita. Revalide o card.`, expectedHead: parentId } };
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
    if (card) {
      // Y-17: a promoção de CARD que perde a corrida responde com o estado REAL do card (antes: "já foi promovido" para um card rejeitado).
      const cs = (ticket as unknown as { card_state?: string | null }).card_state ?? null;
      return { status: 409, body: { code: "CARD_NOT_READY", state: cs, message: `${ticketCode(ticket.number)} não está pronto para promover (estado ${cs ?? ticket.status}).` } };
    }
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
  const denied = await budgetPreflight(pool, parentId, tenantId, Number(parentRow.version_number ?? 1));
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
    outcome = await claim(pool, { parentId, rootId, parentRow, user, ticket, requestText, workMode, key, reqSha, childProductId, tenantId, card });
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

/**
 * Promoção de card, DENTRO do lock da linhagem e do ticket: o carimbo `card_ready` precisa ainda valer.
 *   • o hash da spec do rascunho = o do carimbo (e o conjunto de anexos, quando o carimbo o registrou);
 *   • o gate de RFC (invariante + tipo) é reavaliado sobre o MESMO conteúdo lido para o hash;
 *   • nenhum arquivo do rascunho reescreve um da versão corrente (Y-02).
 * `null` = pode seguir. Falha ⇒ 409 `CARD_NOT_READY` (ou o código do gate / da colisão) com `revertToRefining`, que `promoteCard` consome
 * (o card volta a `refining`; o campo não vai ao cliente).
 */
async function verifyCardStampUnderLock(client: PoolClient, ticketRow: TicketRow, draftId: string): Promise<EvolveResult | null> {
  const t = ticketRow as unknown as TicketRow & { card_state?: string | null };
  const d = (await client.query("SELECT extra FROM projects WHERE id = $1 AND status = 'card_draft'", [draftId])).rows[0] as { extra: Json | null } | undefined;
  const extra = d?.extra ?? null;
  const stamp = (extra?.card_ready ?? null) as { draft_spec_hash?: string; attachments_hash?: string } | null;
  const notReady = (reason: string, message: string): EvolveResult => ({
    status: 409, body: { code: "CARD_NOT_READY", state: "refining", message, next: `POST /api/cards/${t.id}/ready`, revertToRefining: reason },
  });
  if (!extra || !stamp?.draft_spec_hash) return notReady("ready_stamp_missing", "O card não tem o carimbo da validação. Valide de novo.");
  const snap = await computeCurrentSpecHash(client, draftId).catch(() => null);
  if (!snap || snap.specHash !== stamp.draft_spec_hash) {
    return notReady("draft_changed_after_ready", "A spec do rascunho mudou depois da validação. Valide de novo antes de promover.");
  }
  if (stamp.attachments_hash) {
    const att = await cardAttachmentsSnapshot(client as never, { id: t.id, tenant_id: t.tenant_id ?? null });
    if (att.hash !== stamp.attachments_hash) return notReady("attachments_changed_after_ready", "Os anexos do card mudaram (ou uma conversão terminou) depois da validação. Valide de novo antes de promover.");
  }
  const kind = (["evolution", "fix", "feature"].includes(String(t.change_kind)) ? t.change_kind : "evolution") as CardKind;
  const gate = await evaluateCardKindGate(client, draftId, extra, kind, {
    files: snap.files.map((f) => ({ filename: f.filename, rel_dir: f.rel_dir ?? null, content: f.content, contentSha256: f.contentSha256 })),
  });
  if (!gate.ok) {
    return { status: 409, body: { code: gate.code, message: gate.message, ...(gate.details !== undefined ? { details: gate.details } : {}), state: "refining", revertToRefining: "gate_failed_at_promotion" } };
  }
  const info = await loadCardDraftInfo(client as never, draftId);
  if (info) {
    const clash = await findBaseCollisions(client as never, info, snap.files.map((f) => ({ rel_dir: f.rel_dir ?? null, filename: f.filename })));
    if (clash.length > 0) {
      return { status: 409, body: { code: "CARD_PATH_COLLIDES_WITH_BASE", paths: clash, state: "refining", message: `O rascunho tem arquivo(s) que já existem na versão corrente: ${clash.join(", ")}.`, revertToRefining: "path_collides_with_base" } };
    }
  }
  return null;
}

async function claim(pool: Pool, a: {
  parentId: string; rootId: string; parentRow: Record<string, unknown>; user: AuthUser; ticket: TicketRow | null;
  requestText: string; workMode: "copy" | "branch"; key: string | null; reqSha: string; childProductId: string; tenantId: string;
  card?: EvolveCardInput;
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
      if (a.card && (!t || t.status !== "open")) {
        await client.query("ROLLBACK");
        const cs = (t as unknown as { card_state?: string | null } | undefined)?.card_state ?? null;
        return { kind: "reject", result: { status: 409, body: { code: "CARD_NOT_READY", state: cs, message: `${ticketCode(ticket.number)} não está pronto para promover (estado ${cs ?? t?.status ?? "inexistente"}).` } } };
      }
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
      // Fase 2: um ticket-card só é promovido pelo caminho do card (`ready`); o caminho legado nunca o promove (H §9 item 10).
      const cs = (t as unknown as { card_state?: string | null }).card_state ?? null;
      if (a.card && cs !== "ready") {
        await client.query("ROLLBACK");
        return { kind: "reject", result: { status: 409, body: { code: "CARD_NOT_READY", message: `${ticketCode(ticket.number)} não está pronto para promover (estado ${cs ?? "legado"}).`, state: cs } } };
      }
      if (a.card) {
        // Y-01: sob o lock do ticket, a promoção reavalia o gate de RFC e o hash sobre a MESMA leitura do rascunho — nunca cria filho sem RFC.
        const bad = await verifyCardStampUnderLock(client, t, a.card.draftProjectId);
        if (bad) {
          await client.query("ROLLBACK");
          return { kind: "reject", result: bad };
        }
      }
      if (!a.card && cs !== null) {
        await client.query("ROLLBACK");
        return { kind: "reject", result: { status: 409, body: { code: "USE_CARD_PROMOTE", message: `${ticketCode(ticket.number)} é um card: promova por POST /api/cards/${ticket.id}/promote.`, cardId: ticket.id } } };
      }
    }

    // (c) HEAD corrente
    const head = await resolveLineageHead(client, a.rootId);
    if (!head) {
      await client.query("ROLLBACK");
      return { kind: "reject", result: { status: 409, body: { code: "NO_ACCEPTED_HEAD", message: "A linhagem não tem versão aceita para evoluir." } } };
    }
    if (head.id !== a.parentId) {
      await client.query("ROLLBACK");
      if (a.card) {
        return { kind: "reject", result: { status: 409, body: { code: "CARD_BASE_STALE", message: "A versão-base do card foi superada por uma versão mais nova da linhagem. Revalide o card (POST /api/cards/:id/revalidate) e valide de novo antes de promover.", expectedHead: a.parentId, currentHead: head.id } } };
      }
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
    // M-23: sem orçamento no HEAD (linhagem mista) herda o dono do ancestral mais próximo que tem (o preflight já validou).
    const anchor = await resolveBudgetAnchor(client, head.id);
    const ownerId = anchor?.ownerId ?? (await resolveBudgetOwner(client, head.id))?.ownerId ?? head.id;

    const claimId = randomUUID();
    const extra: Json = {
      ...inheritedDeployPrefs,
      evolution: true,
      evolution_request: a.requestText,
      ...(ticket ? { ticket_id: ticket.id, ticket_number: ticket.number, ticket_kind: ticket.change_kind } : {}),
      ...(a.card ? { card_draft_project_id: a.card.draftProjectId, evolution_origin: "card" } : {}),
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
    if (ticket && a.card) {
      // Card: `ready → promoted` pela máquina (CAS, status legado derivado e evento auditado na MESMA transação do INSERT do filho).
      const tr = await transitionCard(client, { ticketId: ticket.id, to: "promoted", actorKind: "user", actorId: a.card.actorId, childProjectId: childId, dedupeKey: claimId });
      if (tr.kind !== "applied") {
        await client.query("ROLLBACK");
        return { kind: "reject", result: { status: 409, body: { code: tr.kind === "invalid" ? "CARD_INVALID_TRANSITION" : "CARD_NOT_READY", message: `${ticketCode(ticket.number)} mudou de estado durante a promoção.`, result: tr.kind } } };
      }
    } else if (ticket) {
      const up = await client.query(
        `UPDATE tickets SET status = 'promoted', child_project_id = $2, promoted_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'open' RETURNING id`,
        [ticket.id, childId],
      );
      if ((up.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return { kind: "reject", result: { status: 409, body: { code: "TICKET_ALREADY_PROMOTED", message: `${ticketCode(ticket.number)} já foi promovido.` } } };
      }
      // 1.4 (TICKET_TRANSITIONS=on): auditoria open → promoted na mesma transação do CAS.
      if (await ticketTransitionsEnabled(client, { tenantId: ticket.tenant_id, userTenantId: a.user.tenantId ?? null })) {
        await recordTicketEvent(client, { ticketId: ticket.id, from: "open", to: "promoted", actorKind: "system", actorId: a.user.id, reason: "evolve_claim", childProjectId: childId });
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
/** Renovação ESTRITA (heartbeat): só o dono atual do lease renova — nunca assume o de outro (≠ `takeOrRenewLease`). */
async function renewLease(pool: Pool, childId: string, me: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE projects
        SET extra = jsonb_set(extra, '{materialization,lease_until}', to_jsonb(now() + interval '${LEASE_SECONDS} seconds')), updated_at = now()
      WHERE id = $1 AND status = 'materializing' AND extra->'materialization'->>'lease_owner' = $2::text
      RETURNING id`,
    [childId, me],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Contexto entregue a cada passo: aborta o trabalho quando o lease se perde (M-04). */
export interface StepCtx {
  signal: AbortSignal;
  /** Lança LeaseLost se o heartbeat já viu o lease perdido. */
  assertAlive(): void;
  /** Renovação estrita imediata: chamar ANTES de qualquer efeito destrutivo (rm/reset --hard/cópia). */
  ensureLease(): Promise<void>;
}

/** Heartbeat do lease: `setTimeout` encadeado a cada LEASE/3 (CAS por dono). Erro de banco no pulso não derruba o passo. */
function startHeartbeat(pool: Pool, childId: string, me: string): StepCtx & { stop(): void } {
  const ac = new AbortController();
  let stopped = false;
  let lost = false;
  const periodMs = evolveTestHooks.heartbeatMs ?? Math.floor((LEASE_SECONDS * 1000) / 3);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const markLost = () => { lost = true; ac.abort(); };
  const tick = async () => {
    if (stopped) return;
    try {
      if (!(await renewLease(pool, childId, me))) { markLost(); return; }
    } catch { /* erro transitório de banco: tenta no próximo pulso */ }
    if (!stopped && !lost) timer = setTimeout(() => { void tick(); }, periodMs);
  };
  timer = setTimeout(() => { void tick(); }, periodMs);
  const assertAlive = () => { if (lost || ac.signal.aborted) throw new LeaseLost(); };
  return {
    signal: ac.signal,
    assertAlive,
    async ensureLease() {
      assertAlive();
      if (!(await renewLease(pool, childId, me))) { markLost(); throw new LeaseLost(); }
    },
    stop() { stopped = true; if (timer) clearTimeout(timer); },
  };
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
  const cardDraftId = typeof extra.card_draft_project_id === "string" ? extra.card_draft_project_id : null;

  try {
    const head = (await pool.query("SELECT id, title, product_id FROM projects WHERE id = $1", [headId])).rows[0] as
      { id: string; title: string; product_id: string | null } | undefined;
    if (!head) throw new TerminalFailure("HEAD_NOT_FOUND", "A versão corrente da linhagem não existe mais.");
    const ticket = ticketId ? (await loadTicket(pool, ticketId)) ?? null : null;
    // M-11: nunca materializar filho para um pedido que o humano recusou (ou que deixou de estar 'promoted') enquanto o claim esperava.
    if (ticketId && (!ticket || ticket.status !== "promoted" || ticket.child_project_id !== childId)) {
      throw new TerminalFailure(ticket?.status === "rejected" ? "TICKET_REJECTED" : "TICKET_NOT_PROMOTED",
        `O pedido deixou de estar promovido para esta evolução (status ${ticket?.status ?? "inexistente"}); a evolução foi cancelada.`);
    }

    const runStep = async (name: string, work: (ctx: StepCtx) => Promise<Json>) => {
      if (steps[name]) return; // já marcado em tentativa anterior
      if (!(await takeOrRenewLease(pool, childId, me))) throw new LeaseLost();
      // M-15: marcador `_started` ANTES do primeiro efeito em disco — o reconciliador (Q1) distingue "sem efeitos" só pelo banco.
      if (!steps._started) {
        const m = { at: iso() };
        await markStep(pool, childId, me, "_started", m);
        steps._started = m;
      }
      fault(`before:${name}`);
      const hb = startHeartbeat(pool, childId, me); // M-04: lease pulsado enquanto o passo roda
      let out: Json;
      try {
        await evolveTestHooks.stall?.(`during:${name}`);
        hb.assertAlive();
        out = await work(hb);
        hb.assertAlive(); // lease perdido durante o trabalho ⇒ não grava marcador
      } finally {
        hb.stop();
      }
      fault(`after_work:${name}`);
      const marker = { ...out, at: iso() };
      await markStep(pool, childId, me, name, marker);
      steps[name] = marker;
      fault(`after_mark:${name}`);
    };

    // S1 — árvore de spec: copia os arquivos da versão corrente (upsert + arquivo temporário/rename)
    await runStep("spec_tree", (ctx) => stepSpecTree(pool, { childId, headId, version, requestText, ticket, ctx }));
    // S2 — código: clone do repo `dev` em evolution/vN (ou cópia do apps/ da versão corrente)
    await runStep("code", (ctx) => stepCode(pool, { childId, headId, rootId, version, headProductId: head.product_id, log, ctx }));
    // S3 — request.md do ticket (+ anexos) na árvore da spec
    if (ticket) {
      await runStep("ticket", async () => {
        const mat3 = await materializeTicketIntoSpecTree(pool, {
          ticket, childProjectId: childId, authorEmail: user.email, projectTitle: String(head.title ?? ""), versionLabel: `v${version}`,
        });
        if (!mat3.ok) {
          // M-05: anexo de texto ilegível (ATTACHMENTS_STRICT) é PERMANENTE ⇒ falha terminal explícita; o resto (disco, banco) é
          // transitório ⇒ lança (500, lease liberado) e a repetição refaz o passo. Marcador só quando concluiu de fato.
          log.warn({ childId, ticketId: ticket.id, err: mat3.error }, "[evolve] materialização do ticket falhou");
          if (mat3.errorKind === "permanent") throw new TerminalFailure("ATTACHMENT_UNREADABLE", mat3.error ?? "anexo ilegível");
          throw new Error(`materialização do ticket falhou: ${mat3.error ?? "erro desconhecido"}`);
        }
        return { files: mat3.files, error: null };
      });
    }
    // S3b (card) — move a spec do rascunho do card (RFCs, documentos) para a árvore do filho, com `spec_origin = card:TK-NNNN`
    if (ticket && cardDraftId) {
      await runStep("card_spec", (ctx) => stepCardSpec(pool, { childId, draftId: cardDraftId, headId, ticket, ctx }));
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
      ...(cardDraftId ? { card_spec_files: steps.card_spec?.paths ?? [] } : {}),
    };
    // M-11: CAS conjunto — o filho só finaliza se o pedido AINDA estiver 'promoted' apontando para ele.
    const fin = await pool.query(
      `UPDATE projects
          SET status = $3,
              extra = jsonb_set(COALESCE(extra, '{}'::jsonb) || $4::jsonb, '{materialization,finalized_at}', to_jsonb(now())),
              updated_at = now()
        WHERE id = $1 AND status = 'materializing'
          AND extra->'materialization'->>'claim_id' = $2::text
          AND extra->'materialization'->>'lease_owner' = $5::text
          AND ( COALESCE(extra->>'ticket_id', '') = ''
                OR EXISTS (SELECT 1 FROM tickets t WHERE t.id::text = projects.extra->>'ticket_id'
                            AND t.status = 'promoted' AND t.child_project_id = projects.id) )
        RETURNING id`,
      [childId, claimId, inheritedFiles > 0 ? "spec_submitted" : "draft", JSON.stringify(finalExtra), me],
    );
    if ((fin.rowCount ?? 0) === 0) {
      const tNow = ticketId ? await loadTicket(pool, ticketId) : null;
      if (ticketId && (!tNow || tNow.status !== "promoted" || tNow.child_project_id !== childId)) {
        throw new TerminalFailure(tNow?.status === "rejected" ? "TICKET_REJECTED" : "TICKET_NOT_PROMOTED",
          `O pedido deixou de estar promovido para esta evolução (status ${tNow?.status ?? "inexistente"}); a evolução foi cancelada.`);
      }
      throw new LeaseLost();
    }
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
    if (e instanceof TerminalFailure) return failTerminal(pool, { childId, rootId, me, version, productId: childRow.product_id }, e);
    await releaseLease(pool, childId, me); // falha recuperável: libera para a repetição retomar já
    log.warn({ err: e, childId }, "[evolve] materialização interrompida — repetir a requisição retoma");
    return {
      status: 500,
      body: { code: "MATERIALIZATION_FAILED", message: "A materialização da evolução foi interrompida. Repita a requisição: ela retoma do ponto da falha.", childProjectId: childId },
    };
  }
}

/**
 * Falha terminal: filho `failed` + ticket volta a `open` (a execução morreu, o pedido não — RFC-0009 inv. 3).
 * M-04: o `UPDATE` confere `lease_owner` — quem perdeu o lease NÃO mata o filho que outro executor está materializando
 * (nesse caso nada muda: 409 MATERIALIZATION_IN_PROGRESS). M-06: recomputa o lifecycle do produto depois do commit.
 */
async function failTerminal(
  pool: Pool,
  c: { childId: string; rootId: string; me: string; version: number; productId: string | null },
  f: TerminalFailure,
): Promise<EvolveResult> {
  const { childId, rootId } = c;
  const client = await pool.connect();
  let marked = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))", [NS_EVOLVE, rootId]);
    const up = await client.query(
      `UPDATE projects
          SET status = 'failed',
              extra = jsonb_set(COALESCE(extra, '{}'::jsonb), '{materialization,error}', $2::jsonb),
              updated_at = now()
        WHERE id = $1 AND status = 'materializing' AND extra->'materialization'->>'lease_owner' = $3::text
        RETURNING id`,
      [childId, JSON.stringify({ code: f.code, message: f.message, at: iso() }), c.me],
    );
    marked = (up.rowCount ?? 0) > 0;
    if (!marked) {
      await client.query("ROLLBACK");
    } else {
      // Fase 2: card cujo filho morreu na materialização vai a `blocked` PELA máquina (H §4.1); o ticket legado reabre como sempre.
      const cards = await client.query("SELECT id FROM tickets WHERE child_project_id = $1 AND card_state IS NOT NULL AND card_state IN ('promoted', 'in_factory')", [childId]);
      for (const c of cards.rows) {
        await transitionCard(client, { ticketId: String(c.id), to: "blocked", actorKind: "system", reason: `materialization_failed:${f.code}`, dedupeKey: `mat_failed:${childId}` });
      }
      const reopened = await client.query(
        `UPDATE tickets SET status = 'open', child_project_id = NULL, promoted_at = NULL, updated_at = now()
          WHERE child_project_id = $1 AND status = 'promoted' AND card_state IS NULL
        RETURNING id, tenant_id`,
        [childId],
      );
      // 1.4 (TICKET_TRANSITIONS=on): auditoria promoted → open (falha terminal do filho).
      for (const t of reopened.rows) {
        if (await ticketTransitionsEnabled(client, { tenantId: t.tenant_id ? String(t.tenant_id) : null })) {
          await recordTicketEvent(client, { ticketId: String(t.id), from: "promoted", to: "open", actorKind: "system", reason: `materialization_failed:${f.code}`, childProjectId: childId });
        }
      }
      await client.query("COMMIT");
    }
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
  if (!marked) return inProgress(childId, c.version); // perdeu o lease: outro executor é o dono, não derruba o filho dele
  await recomputeProductLifecycle(pool, c.productId); // M-06: o produto deixa de mostrar o filho vivo
  return { status: 422, body: { code: f.code, message: f.message, childProjectId: childId } };
}

// ── Passos ────────────────────────────────────────────────────────────────────────────────
async function stepSpecTree(
  pool: Pool,
  a: { childId: string; headId: string; version: number; requestText: string; ticket: TicketRow | null; ctx: StepCtx },
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
      a.ctx.assertAlive(); // M-04: lease perdido ⇒ para de escrever na árvore do filho
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

/**
 * Passo `card_spec` (Fase 2): copia para o filho tudo que o rascunho do card tem FORA da pasta `tickets/TK-NNNN/` (RFCs, notas, anexos
 * de texto nascidos na maturação) — a pasta do ticket é regenerada pelo passo `ticket`. Idempotente (upsert + tmp/rename). O rascunho
 * não é alterado: continua como histórico do card. Grava `spec_origin = card:TK-NNNN` nos arquivos do card no filho.
 */
async function stepCardSpec(
  pool: Pool,
  a: { childId: string; draftId: string; headId: string; ticket: TicketRow; ctx: StepCtx },
): Promise<Json> {
  const code = ticketCode(a.ticket.number);
  const tkDir = `tickets/${code}`;
  const rows = (await pool.query(
    "SELECT file_path, filename, mime_type, rel_dir FROM project_spec_files WHERE project_id = $1 ORDER BY rel_dir, filename",
    [a.draftId],
  )).rows as Array<{ file_path: string; filename: string; mime_type: string | null; rel_dir: string | null }>;
  const { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } = await import("fs");
  const { join } = await import("path");
  const uploadDir = (process.env.UPLOAD_DIR ?? "/shared/uploads").trim();
  const childSpecDir = join(uploadDir, a.childId);
  const paths: string[] = [];
  const headCollisions = new Set(
    ((await pool.query("SELECT rel_dir, filename FROM project_spec_files WHERE project_id = $1", [a.headId])).rows as Array<{ rel_dir: string | null; filename: string }>)
      .map((h) => `${(h.rel_dir ?? "").replace(/^\/+|\/+$/g, "").toLowerCase()}\u0000${h.filename.toLowerCase()}`),
  );
  for (const r of rows) {
    a.ctx.assertAlive();
    const rel = (r.rel_dir ?? "").replace(/^\/+|\/+$/g, "");
    if (rel === tkDir || rel.startsWith(`${tkDir}/`)) continue;
    if (!r.file_path || !existsSync(r.file_path)) throw new TerminalFailure("CARD_DRAFT_UNREADABLE", `Arquivo do rascunho do card não encontrado no disco: ${rel ? rel + "/" : ""}${r.filename}.`);
    // Y-02: o upsert abaixo reescreveria, no filho, o RFC/ADR herdado do HEAD. Defesa em profundidade: o `ready` e o claim já recusam.
    if (headCollisions.has(`${rel.toLowerCase()}\u0000${r.filename.toLowerCase()}`)) {
      throw new TerminalFailure("CARD_PATH_COLLIDES_WITH_BASE", `'${rel ? rel + "/" : ""}${r.filename}' já existe na versão corrente; o card não pode reescrevê-lo.`);
    }
    const content = readFileSync(r.file_path);
    const dir = rel ? join(childSpecDir, rel) : childSpecDir;
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, r.filename);
    const tmp = `${dest}.tmp-${process.pid}`;
    writeFileSync(tmp, content);
    renameSync(tmp, dest);
    await pool.query(
      `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256, spec_origin)
       VALUES ($1, $2, $3, $4, $5, false, $6, $7)
       ON CONFLICT (project_id, rel_dir, filename)
       DO UPDATE SET file_path = EXCLUDED.file_path, mime_type = EXCLUDED.mime_type, content_sha256 = EXCLUDED.content_sha256, spec_origin = EXCLUDED.spec_origin`,
      [a.childId, r.filename, dest, r.mime_type ?? "text/markdown", rel, sha256Hex(content), `card:${code}`],
    );
    paths.push(rel ? `${rel}/${r.filename}` : r.filename);
  }
  await pool.query(
    "UPDATE project_spec_files SET spec_origin = $2 WHERE project_id = $1 AND spec_origin IS NULL AND (rel_dir = $3 OR rel_dir LIKE $4)",
    [a.childId, `card:${code}`, tkDir, `${tkDir}/%`],
  );
  return { files: paths.length, paths };
}

/** Erros de git que NÃO se resolvem repetindo (repo/credencial/ref inexistentes, git ausente). O resto é tratado como transitório. */
const PERMANENT_GIT_ERROR = /repository not found|authentication failed|permission denied|could not read username|invalid credentials|couldn't find remote ref|remote branch .* not found|not a git repository|does not appear to be a git repository|requested url returned error: 40[134]|bin[aá]rio `git` ausente/i;
export function isPermanentGitError(msg: string | null | undefined): boolean {
  return !!msg && PERMANENT_GIT_ERROR.test(msg);
}
/** Mensagem de erro de git sem credencial (header Basic / x-access-token) — defesa em profundidade para log e exceção. */
function redactGit(msg: string | null | undefined): string {
  return String(msg ?? "").replace(/Basic [A-Za-z0-9+/=]{8,}/g, "Basic ***").replace(/x-access-token:[^@\s]+/g, "x-access-token:***");
}

async function stepCode(
  pool: Pool,
  a: { childId: string; headId: string; rootId: string; version: number; headProductId: string | null; log: EvolveLog; ctx: StepCtx },
): Promise<Json> {
  let source: "git-clone" | "disk-copy" | "none" = "none";
  let error: string | null = null;
  const { existsSync, mkdirSync, rmSync, readdirSync } = await import("fs");
  const { cp } = await import("fs/promises");
  const { join } = await import("path");
  const filesRoot = (process.env.PROJECT_FILES_ROOT ?? "").trim();
  // M-05: nada aqui engole exceção — fs/git/rede transitórios sobem (500 MATERIALIZATION_FAILED, a repetição retoma) e o
  // marcador do passo só é gravado quando ele concluiu. `source:"none"` sem erro = nada a copiar (configuração, não falha).
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
      // origin/dev. O reset é seguro SÓ porque o filho está 'materializing' E (M-04) o lease foi reconfirmado agora.
      await a.ctx.ensureLease();
      const link = await gitLinkProjectFolder({ projectId: a.childId, fullName, installationId: Number(repoRow.installation_id), branch: "dev" });
      a.ctx.assertAlive();
      if (link.ok) {
        const br = await checkoutNewBranch(a.childId, `evolution/v${a.version}`);
        if (!br.ok) throw new Error(`branch local evolution/v${a.version} não criado: ${redactGit(br.error)}`);
        source = "git-clone";
      } else if (isPermanentGitError(link.error)) {
        error = redactGit(link.error ?? "git-link falhou"); // permanente: cai no fallback do disco, se houver
      } else {
        throw new Error(`git-link falhou (transitório): ${redactGit(link.error)}`);
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
        // Reexecução: começa do zero (cópia parcial anterior) — seguro só em 'materializing' e com o lease reconfirmado (M-04).
        await a.ctx.ensureLease();
        rmSync(childApps, { recursive: true, force: true });
        mkdirSync(childApps, { recursive: true });
        // `fs.promises.cp` (assíncrono): o heartbeat do lease continua pulsando durante a cópia (o cpSync bloqueava o event loop).
        await cp(src, childApps, { recursive: true, filter: (s) => !/(^|\/)(node_modules|\.next|dist|__pycache__|\.venv|venv)(\/|$)/.test(s) });
        a.ctx.assertAlive();
        source = "disk-copy";
        if (existsSync(join(childApps, ".git"))) {
          const br = await checkoutNewBranch(a.childId, `evolution/v${a.version}`);
          if (!br.ok) error = `branch local não criado (disk-copy): ${redactGit(br.error)}`;
        } else {
          error = (error ? error + "; " : "") + "cópia sem .git — sem branch evolution/vN";
        }
      } else if (error) {
        // git permanentemente indisponível E sem cópia do disco: não há código-base a entregar.
        throw new TerminalFailure("CODE_BASE_UNAVAILABLE", `Não foi possível obter o código-base da versão corrente (${error}) e não há cópia no disco.`);
      }
    }
  }
  return { source, error };
}
