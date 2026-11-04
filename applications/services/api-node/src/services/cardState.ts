/**
 * cardState.ts — tarefa 2.4 da Fase 2 (plano EVOLUIR-PROJETO-BANCADA v2; desenho H §4): MÁQUINA DE ESTADOS do card.
 *
 * O card é um `tickets` com `card_state` não nulo. `NULL` = ticket legado, fora da máquina (nunca é tocado aqui).
 * Estados: draft, refining, ready, promoted, in_factory, delivered, blocked, rejected.
 *
 * Coexistência com `tickets.status` (expand, H §4.4): o status legado (open|promoted|delivered|rejected) é DERIVADO do
 * `card_state` e escrito NO MESMO `UPDATE`, então os leitores antigos continuam corretos por construção:
 *   draft/refining/ready → open · promoted/in_factory/blocked → promoted · delivered → delivered · rejected → rejected.
 * Fonte de verdade para ticket com `card_state`: o próprio `card_state`.
 *
 * Garantias de `transitionCard`:
 *   • uma transação curta: `SELECT … FOR UPDATE` do ticket serializa transições concorrentes do MESMO card;
 *   • validação contra a tabela `CARD_TRANSITIONS` (de → para, por tipo de ator);
 *   • idempotente: o card já está no estado de destino ⇒ `noop` (sem escrita e sem evento novo); `dedupeKey` repetido
 *     (mesmo ticket + destino + chave) também é `noop`;
 *   • `UPDATE … WHERE id = $1 AND card_state = <lido sob lock> AND status = <legado esperado>` (CAS defensivo);
 *   • status legado divergente do esperado (um escritor antigo mexeu no `status` sem a máquina) ⇒ `diverged`, nada é escrito;
 *   • auditoria em `ticket_card_events` na mesma transação (ator, de → para, motivo, filho, chave). Sem PII: `actor_id` é UUID
 *     e `reason` só carrega códigos do sistema.
 *
 * Pré-condições do FILHO (lote B, S-09), checadas sob o mesmo lock e na mesma transação do `UPDATE`:
 *   • `ready → promoted`: `childProjectId` existe, é do MESMO tenant e produto do ticket e está vivo (nem `failed` nem `archived`);
 *   • `blocked → in_factory`: o filho vinculado (`tickets.child_project_id`) existe e está vivo;
 *   • `in_factory → delivered`: o filho está `accepted`. Se o filho tem repositório GitHub (`project_github_repos`), a prova de PR mergeado
 *     é PARAMETRIZADA por `args.mergeCheck` (a verificação real do merge é da Fase 4, tarefa 4.3); sem `mergeCheck` a entrega com
 *     repositório é recusada (`merge_unverified`) — nunca se declara entregue sem prova;
 *   • `blocked → rejected`: um filho ainda vivo é ARQUIVADO (CAS no status lido, marca em `extra.card_rejected` e `child_project_id`
 *     no evento) para não prender `EVOLUTION_IN_FLIGHT`; se o filho está em execução (`materializing`, `running`, …) a recusa é negada
 *     (`child_active`) — pare/descarte o filho antes.
 * Aresta `ready → blocked` (H §6, `CARD_BUDGET_BLOCKED`): DECISÃO mantida da 2.6 — NÃO existe. Orçamento negado devolve 402 e o card
 * segue `ready` (nada a retomar, nada a bloquear); H §4.1 vale sobre H §6.
 *
 * Transação (S-13): com `Pool`, a função abre `BEGIN/COMMIT` próprio. Com cliente do chamador ela abre um `SAVEPOINT`, que FALHA fora de
 * transação (25P01) — então `UPDATE` e evento são atômicos ou o uso indevido é denunciado; nunca silenciosamente não atômico.
 *
 * A flag `CARDS_BANCADA` governa só as PORTAS DE ENTRADA (`enterCardMachine`, rotas da Fase 3). Para ticket que já tem
 * `card_state` as transições valem sempre, com a flag ligada ou não (consistência de dados, H §4.4).
 */
import { flagEnabled } from "./featureFlags.js";
import type { RuntimeConfigDb } from "./runtimeTunables.js";

export const CARD_STATES = ["draft", "refining", "ready", "promoted", "in_factory", "delivered", "blocked", "rejected"] as const;
export type CardState = (typeof CARD_STATES)[number];
export type CardActorKind = "user" | "system" | "reconciler" | "guard" | "backfill";
export type LegacyTicketStatus = "open" | "promoted" | "delivered" | "rejected";

/** Versão do contrato do card gravada em `tickets.card_contract_version` quando o ticket entra na máquina. */
export const CARD_CONTRACT_VERSION = 1;

export function isCardState(v: unknown): v is CardState {
  return typeof v === "string" && (CARD_STATES as readonly string[]).includes(v);
}

/** `card_state` → `tickets.status` legado (H §4.4). */
export function legacyStatusFor(state: CardState): LegacyTicketStatus {
  switch (state) {
    case "draft": case "refining": case "ready": return "open";
    case "promoted": case "in_factory": case "blocked": return "promoted";
    case "delivered": return "delivered";
    case "rejected": return "rejected";
  }
}

/** SQL equivalente de `legacyStatusFor` (uso na detecção de divergência e nos testes). */
export const LEGACY_STATUS_CASE_SQL = `CASE card_state
    WHEN 'draft' THEN 'open' WHEN 'refining' THEN 'open' WHEN 'ready' THEN 'open'
    WHEN 'promoted' THEN 'promoted' WHEN 'in_factory' THEN 'promoted' WHEN 'blocked' THEN 'promoted'
    WHEN 'delivered' THEN 'delivered' WHEN 'rejected' THEN 'rejected' END`;

export interface CardTransitionDef {
  from: readonly CardState[];
  to: CardState;
  actors: readonly CardActorKind[];
  /** Descrição curta (H §4.1). */
  note: string;
}

/**
 * Tabela de transições VÁLIDAS (H §4.1). Qualquer par fora dela é `CARD_INVALID_TRANSITION`.
 * `∅ → draft` não está aqui: é `enterCardMachine` (porta de entrada, exige a flag) ou o backfill.
 */
export const CARD_TRANSITIONS: readonly CardTransitionDef[] = [
  { from: ["draft"], to: "refining", actors: ["user", "system"], note: "1ª escrita na spec do rascunho" },
  { from: ["draft", "refining"], to: "ready", actors: ["system"], note: "Validar OK (gate de RFC, exigências do tipo, orçamento, base registrada)" },
  { from: ["ready"], to: "refining", actors: ["user", "system"], note: "escrita na spec do rascunho ou CARD_BASE_STALE" },
  { from: ["ready"], to: "promoted", actors: ["user", "system"], note: "promoção dentro do claim (exige o filho)" },
  { from: ["promoted"], to: "in_factory", actors: ["system"], note: "filho entrou em status de fábrica" },
  { from: ["promoted", "in_factory"], to: "blocked", actors: ["system", "guard", "reconciler"], note: "falha de materialização, Guard, filho failed (motivo obrigatório)" },
  { from: ["blocked"], to: "in_factory", actors: ["user", "system"], note: "retomada: filho voltou à fábrica" },
  { from: ["promoted", "in_factory", "blocked"], to: "ready", actors: ["system"], note: "filho descartado (reopenTicketsOfChild)" },
  { from: ["in_factory"], to: "delivered", actors: ["system"], note: "filho accepted + PR mergeado (4.3)" },
  { from: ["draft", "refining", "ready", "blocked"], to: "rejected", actors: ["user"], note: "recusa humana" },
];

export function isValidCardTransition(from: string, to: string, actor: CardActorKind): boolean {
  return CARD_TRANSITIONS.some((t) => t.to === to && (t.from as readonly string[]).includes(from) && t.actors.includes(actor));
}

/** Destinos permitidos a partir de `from` para o ator (para mensagens de erro e testes). */
export function allowedCardTargets(from: string, actor: CardActorKind): CardState[] {
  return CARD_TRANSITIONS.filter((t) => (t.from as readonly string[]).includes(from) && t.actors.includes(actor)).map((t) => t.to);
}

type Row = Record<string, unknown>;
type QueryResult = { rows: Row[]; rowCount?: number | null };
type Db = { query(sql: string, params?: unknown[]): Promise<QueryResult> };
/** Pool (abre a própria transação) ou cliente já dentro de uma transação do chamador (usa-a via SAVEPOINT). */
type PoolLike = Db & { connect(): Promise<Db & { release(): void }> };
export type CardDb = Db | PoolLike;

function isClient(db: CardDb): boolean {
  return typeof (db as { release?: unknown }).release === "function";
}
function isPool(db: CardDb): db is PoolLike {
  return !isClient(db) && typeof (db as { connect?: unknown }).connect === "function";
}

/** Aborta a transação/savepoint corrente e faz `withTx` devolver `result` (nenhuma escrita da função permanece). */
class TxAbort<T> { constructor(readonly result: T) {} }

let savepointSeq = 0;

/**
 * Executa `fn` numa transação atômica. Pool ⇒ BEGIN/COMMIT próprio. Cliente/Db do chamador ⇒ SAVEPOINT (exige transação aberta:
 * fora dela o Postgres recusa o SAVEPOINT e o erro sobe — S-13), RELEASE no sucesso, ROLLBACK TO em falha ou `TxAbort`.
 */
async function withTx<T>(db: CardDb, fn: (q: Db) => Promise<T>): Promise<T> {
  if (!isPool(db)) {
    const sp = `card_tr_${++savepointSeq}`;
    await db.query(`SAVEPOINT ${sp}`);
    try {
      const out = await fn(db);
      await db.query(`RELEASE SAVEPOINT ${sp}`);
      return out;
    } catch (e) {
      await db.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => undefined);
      if (e instanceof TxAbort) return e.result as T;
      throw e;
    }
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (e instanceof TxAbort) return e.result as T;
    throw e;
  } finally {
    client.release();
  }
}

/** Status de projeto filho que contam como "morto" (o card não tem mais o que acompanhar). */
const DEAD_CHILD_STATUSES = ["failed", "archived"] as const;
/** Filho em execução/materialização: não se arquiva por baixo dele ao recusar um card. */
const ACTIVE_CHILD_STATUSES = ["materializing", "running", "queued", "cto_charter", "pm_backlog", "dev_qa", "devops", "pending_cyborg"] as const;

export interface CardTransitionArgs {
  ticketId: string;
  to: CardState;
  actorKind: CardActorKind;
  actorId?: string | null;
  /** Código do sistema. OBRIGATÓRIO quando `to = 'blocked'` (gravado em `blocked_reason`). */
  reason?: string | null;
  /** OBRIGATÓRIO em `ready → promoted` (vira `child_project_id`). Opcional nas demais (registrado no evento). */
  childProjectId?: string | null;
  /** Chave de idempotência do evento (claim_id, run_id, request id). Repetir a mesma chave para o mesmo destino é `noop`. */
  dedupeKey?: string | null;
  /**
   * `in_factory → delivered` com filho que tem repositório GitHub: prova de PR mergeado (Fase 4, tarefa 4.3). Recebe o executor da
   * transação e o id do filho; `true` = mergeado. Ausente + repositório ⇒ `precondition_failed: merge_unverified`.
   */
  mergeCheck?: (q: { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }, childProjectId: string) => Promise<boolean>;
}

export type CardPreconditionCode =
  | "child_not_found" | "child_wrong_scope" | "child_dead" | "child_not_accepted" | "merge_unverified" | "child_active" | "child_changed";

export type CardTransitionResult =
  | { kind: "applied"; from: CardState; to: CardState; status: LegacyTicketStatus }
  | { kind: "noop"; state: CardState; why: "already_in_state" | "dedupe_key_replayed" }
  | { kind: "invalid"; from: CardState; to: CardState; allowed: CardState[] }   // 409 CARD_INVALID_TRANSITION
  | { kind: "not_a_card" }                                                       // ticket legado (card_state NULL)
  | { kind: "not_found" }
  | { kind: "reason_required" }                                                  // to = blocked sem motivo
  | { kind: "child_required" }                                                   // ready → promoted sem filho
  | { kind: "precondition_failed"; code: CardPreconditionCode }                  // pré-condição do filho (S-09)
  | { kind: "diverged"; cardState: CardState; status: string };                  // status legado != derivado do card_state

/**
 * Aplica `card_state → to` com validação, CAS, auditoria e status legado no mesmo `UPDATE`. Nunca lança por regra de negócio
 * (devolve o `kind`); erros de banco propagam e, com Pool, desfazem a transação.
 */
export async function transitionCard(db: CardDb, args: CardTransitionArgs): Promise<CardTransitionResult> {
  const { ticketId, to, actorKind } = args;
  const reason = (args.reason ?? "").trim() || null;
  if (to === "blocked" && !reason) return { kind: "reason_required" };
  return withTx(db, async (q) => {
    const cur = (await q.query(
      "SELECT tenant_id, product_id, card_state, status, child_project_id, blocked_reason FROM tickets WHERE id = $1 FOR UPDATE", [ticketId],
    )).rows[0];
    if (!cur) return { kind: "not_found" } as const;
    if (cur.card_state === null || cur.card_state === undefined) return { kind: "not_a_card" } as const;
    const from = String(cur.card_state);
    if (!isCardState(from)) return { kind: "diverged", cardState: from as CardState, status: String(cur.status) } as const;
    if (args.dedupeKey) {
      const seen = await q.query(
        "SELECT 1 FROM ticket_card_events WHERE ticket_id = $1 AND to_state = $2 AND dedupe_key = $3 LIMIT 1",
        [ticketId, to, args.dedupeKey],
      );
      if (from !== to && seen.rows.length > 0) return { kind: "noop", state: from, why: "dedupe_key_replayed" } as const;
      if (from === to && to === "blocked" && seen.rows.length > 0) return { kind: "noop", state: from, why: "dedupe_key_replayed" } as const;
    }
    if (from === to) {
      // `blocked → blocked` com MOTIVO DIFERENTE atualiza `blocked_reason` (S-13) — só por quem pode bloquear; o resto é noop.
      const canReblock = to === "blocked" && !!reason && reason !== (cur.blocked_reason ? String(cur.blocked_reason) : null)
        && (["system", "guard", "reconciler"] as CardActorKind[]).includes(actorKind);
      if (!canReblock) return { kind: "noop", state: to, why: "already_in_state" } as const;
      const re = await q.query(
        "UPDATE tickets SET blocked_reason = $2, updated_at = now() WHERE id = $1 AND card_state = 'blocked' AND status = 'promoted' RETURNING id",
        [ticketId, reason],
      );
      if ((re.rowCount ?? re.rows.length) === 0) return { kind: "diverged", cardState: from, status: String(cur.status) } as const;
      await recordCardEvent(q, {
        ticketId, from, to, actorKind, actorId: args.actorId, reason,
        childProjectId: cur.child_project_id ? String(cur.child_project_id) : null, dedupeKey: args.dedupeKey,
      });
      return { kind: "applied", from, to, status: legacyStatusFor(to) } as const;
    }
    if (!isValidCardTransition(from, to, actorKind)) {
      return { kind: "invalid", from, to, allowed: allowedCardTargets(from, actorKind) } as const;
    }
    if (String(cur.status) !== legacyStatusFor(from)) return { kind: "diverged", cardState: from, status: String(cur.status) } as const;
    if (from === "ready" && to === "promoted" && !args.childProjectId) return { kind: "child_required" } as const;

    // Pré-condições do filho (S-09), sob o lock do ticket e na mesma transação do UPDATE.
    const pre = await childPrecondition(q, cur, from, to, args);
    if (pre.fail) return { kind: "precondition_failed", code: pre.fail } as const;

    // Efeitos nas colunas legadas que acompanham o destino (mesmo UPDATE).
    const set: string[] = ["card_state = $2", "status = $3", "blocked_reason = $4", "updated_at = now()"];
    const vals: unknown[] = [ticketId, to, legacyStatusFor(to), to === "blocked" ? reason : null];
    if (to === "promoted") {
      vals.push(args.childProjectId);
      set.push(`child_project_id = $${vals.length}`, "promoted_at = now()");
    } else if (to === "ready" && (from === "promoted" || from === "in_factory" || from === "blocked")) {
      // filho descartado: o card volta à fila sem vínculo (espelha reopenTicketsOfChild)
      set.push("child_project_id = NULL", "promoted_at = NULL", "delivered_at = NULL");
    } else if (to === "delivered") {
      set.push("delivered_at = now()");
    }
    vals.push(from, legacyStatusFor(from));
    const up = await q.query(
      `UPDATE tickets SET ${set.join(", ")} WHERE id = $1 AND card_state = $${vals.length - 1} AND status = $${vals.length} RETURNING id`,
      vals,
    );
    if ((up.rowCount ?? up.rows.length) === 0) {
      // Não deveria ocorrer sob FOR UPDATE; se ocorrer, não escrevemos evento e deixamos o chamador tentar de novo.
      return { kind: "invalid", from, to, allowed: allowedCardTargets(from, actorKind) } as const;
    }
    if (pre.archiveChild) {
      // `blocked → rejected` com filho vivo e parado: arquiva (CAS no status lido). Se mudou no meio, desfaz TUDO (ticket incluído).
      const ar = await q.query(
        `UPDATE projects SET status = 'archived', updated_at = now(),
                extra = COALESCE(extra, '{}'::jsonb) || jsonb_build_object('card_rejected', jsonb_build_object('ticket_id', $2::text, 'previous_status', $3::text))
          WHERE id = $1 AND status = $3 RETURNING id`,
        [pre.archiveChild.id, ticketId, pre.archiveChild.status],
      );
      if ((ar.rowCount ?? ar.rows.length) === 0) throw new TxAbort({ kind: "precondition_failed", code: "child_changed" } as CardTransitionResult);
    }
    await recordCardEvent(q, {
      ticketId, from, to, actorKind, actorId: args.actorId, reason,
      childProjectId: args.childProjectId ?? (cur.child_project_id ? String(cur.child_project_id) : null),
      dedupeKey: args.dedupeKey,
    });
    return { kind: "applied", from, to, status: legacyStatusFor(to) } as const;
  });
}

type ChildPre = { fail?: CardPreconditionCode; archiveChild?: { id: string; status: string } };

/** Pré-condições do filho por aresta (S-09). Só leitura; quem escreve (arquivar o filho) é `transitionCard`, depois do CAS do ticket. */
async function childPrecondition(q: Db, cur: Row, from: CardState, to: CardState, args: CardTransitionArgs): Promise<ChildPre> {
  const dead = DEAD_CHILD_STATUSES as readonly string[];
  const loadChild = async (id: string) =>
    (await q.query("SELECT tenant_id, product_id, status FROM projects WHERE id = $1", [id])).rows[0];
  const sameScope = (c: Row) =>
    String(c.status) !== "card_draft"
    && (c.tenant_id ?? null) === (cur.tenant_id ?? null) && (c.product_id ?? null) === (cur.product_id ?? null);

  if (from === "ready" && to === "promoted") {
    const c = await loadChild(String(args.childProjectId));
    if (!c) return { fail: "child_not_found" };
    if (!sameScope(c)) return { fail: "child_wrong_scope" };
    if (dead.includes(String(c.status))) return { fail: "child_dead" };
    return {};
  }
  if (from === "blocked" && to === "in_factory") {
    const c = cur.child_project_id ? await loadChild(String(cur.child_project_id)) : undefined;
    if (!c) return { fail: "child_not_found" };
    if (dead.includes(String(c.status))) return { fail: "child_dead" };
    return {};
  }
  if (from === "in_factory" && to === "delivered") {
    const childId = cur.child_project_id ? String(cur.child_project_id) : null;
    const c = childId ? await loadChild(childId) : undefined;
    if (!c) return { fail: "child_not_found" };
    if (String(c.status) !== "accepted") return { fail: "child_not_accepted" };
    const hasRepo = (await q.query("SELECT 1 FROM project_github_repos WHERE project_id = $1 LIMIT 1", [childId])).rows.length > 0;
    if (hasRepo && !(args.mergeCheck && (await args.mergeCheck(q, childId!)))) return { fail: "merge_unverified" };
    return {};
  }
  if (from === "blocked" && to === "rejected" && cur.child_project_id) {
    const c = await loadChild(String(cur.child_project_id));
    if (!c || dead.includes(String(c.status))) return {};
    if ((ACTIVE_CHILD_STATUSES as readonly string[]).includes(String(c.status))) return { fail: "child_active" };
    return { archiveChild: { id: String(cur.child_project_id), status: String(c.status) } };
  }
  return {};
}

export interface CardEventInput {
  ticketId: string;
  from: string | null;
  to: string;
  actorKind: CardActorKind;
  actorId?: string | null;
  reason?: string | null;
  childProjectId?: string | null;
  dedupeKey?: string | null;
}

/** Auditoria: UMA linha em `ticket_card_events`. Repetir (ticket, destino, chave) é no-op (índice parcial único). */
export async function recordCardEvent(db: Db, e: CardEventInput): Promise<void> {
  await db.query(
    `INSERT INTO ticket_card_events (ticket_id, from_state, to_state, actor_kind, actor_id, reason, child_project_id, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (ticket_id, to_state, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [e.ticketId, e.from, e.to, e.actorKind, e.actorId ?? null, e.reason ?? null, e.childProjectId ?? null, e.dedupeKey ?? null],
  );
}

export type EnterCardResult =
  | { kind: "applied" }
  | { kind: "noop"; state: CardState }
  | { kind: "flag_off" }
  | { kind: "not_found" }
  | { kind: "not_open"; status: string }       // só ticket legado `open` entra (promoted/delivered/rejected: backfill)
  | { kind: "invalid"; state: CardState };     // já está na máquina em outro estado

/**
 * `∅ → draft`: porta de entrada de um ticket legado `open` na máquina. Exige `CARDS_BANCADA` ligada para o tenant do ticket.
 * Não toca `tickets.status` (continua `open`). Idempotente.
 */
export async function enterCardMachine(
  db: CardDb,
  args: { ticketId: string; actorKind?: CardActorKind; actorId?: string | null; dedupeKey?: string | null },
): Promise<EnterCardResult> {
  const actorKind = args.actorKind ?? "user";
  return withTx(db, async (q) => {
    const cur = (await q.query("SELECT tenant_id, card_state, status FROM tickets WHERE id = $1 FOR UPDATE", [args.ticketId])).rows[0];
    if (!cur) return { kind: "not_found" } as const;
    if (cur.card_state !== null && cur.card_state !== undefined) {
      const st = String(cur.card_state) as CardState;
      return st === "draft" ? ({ kind: "noop", state: st } as const) : ({ kind: "invalid", state: st } as const);
    }
    if (!(await flagEnabled(q as unknown as RuntimeConfigDb, "CARDS_BANCADA", cur.tenant_id ? String(cur.tenant_id) : null))) {
      return { kind: "flag_off" } as const;
    }
    if (String(cur.status) !== "open") return { kind: "not_open", status: String(cur.status) } as const;
    const up = await q.query(
      `UPDATE tickets SET card_state = 'draft', card_contract_version = $2, updated_at = now()
        WHERE id = $1 AND card_state IS NULL AND status = 'open' RETURNING id`,
      [args.ticketId, CARD_CONTRACT_VERSION],
    );
    if ((up.rowCount ?? up.rows.length) === 0) return { kind: "invalid", state: "draft" } as const;
    await recordCardEvent(q, { ticketId: args.ticketId, from: null, to: "draft", actorKind, actorId: args.actorId, dedupeKey: args.dedupeKey });
    return { kind: "applied" } as const;
  });
}

/** A flag `CARDS_BANCADA` está ligada para o tenant? (precedência tenant > global > env; erro/ausente ⇒ desligada). */
export async function cardsBancadaEnabled(db: RuntimeConfigDb, tenantId: string | null): Promise<boolean> {
  return flagEnabled(db, "CARDS_BANCADA", tenantId);
}

export interface CardDivergence { ticketId: string; cardState: string; status: string; expectedStatus: string }

/**
 * Q6 do reconciliador (H §7): tickets com `card_state` cujo `status` legado não é o derivado. Só LEITURA — quem corrige
 * é um humano ou a próxima transição pela máquina (que recusa com `diverged` enquanto houver divergência).
 */
export async function findCardStatusDivergences(db: Db, opts: { tenantId?: string | null; limit?: number } = {}): Promise<CardDivergence[]> {
  const r = await db.query(
    `SELECT id, card_state, status, ${LEGACY_STATUS_CASE_SQL} AS expected
       FROM tickets
      WHERE card_state IS NOT NULL AND status IS DISTINCT FROM (${LEGACY_STATUS_CASE_SQL})
        AND ($1::uuid IS NULL OR tenant_id = $1)
      ORDER BY updated_at DESC LIMIT $2`,
    [opts.tenantId ?? null, opts.limit ?? 100],
  );
  return r.rows.map((x) => ({ ticketId: String(x.id), cardState: String(x.card_state), status: String(x.status), expectedStatus: String(x.expected) }));
}
