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
/** Pool (abre a própria transação) ou cliente já dentro de uma transação do chamador (usa-a como está). */
type PoolLike = Db & { connect(): Promise<Db & { release(): void }> };
export type CardDb = Db | PoolLike;

function isClient(db: CardDb): boolean {
  return typeof (db as { release?: unknown }).release === "function";
}
function isPool(db: CardDb): db is PoolLike {
  return !isClient(db) && typeof (db as { connect?: unknown }).connect === "function";
}

/** Executa `fn` numa transação: Pool ⇒ BEGIN/COMMIT próprio; cliente/Db simples ⇒ a transação (ou a falta dela) é do chamador. */
async function withTx<T>(db: CardDb, fn: (q: Db) => Promise<T>): Promise<T> {
  if (!isPool(db)) return fn(db);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

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
}

export type CardTransitionResult =
  | { kind: "applied"; from: CardState; to: CardState; status: LegacyTicketStatus }
  | { kind: "noop"; state: CardState; why: "already_in_state" | "dedupe_key_replayed" }
  | { kind: "invalid"; from: CardState; to: CardState; allowed: CardState[] }   // 409 CARD_INVALID_TRANSITION
  | { kind: "not_a_card" }                                                       // ticket legado (card_state NULL)
  | { kind: "not_found" }
  | { kind: "reason_required" }                                                  // to = blocked sem motivo
  | { kind: "child_required" }                                                   // ready → promoted sem filho
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
    const cur = (await q.query("SELECT card_state, status, child_project_id FROM tickets WHERE id = $1 FOR UPDATE", [ticketId])).rows[0];
    if (!cur) return { kind: "not_found" } as const;
    if (cur.card_state === null || cur.card_state === undefined) return { kind: "not_a_card" } as const;
    const from = String(cur.card_state);
    if (!isCardState(from)) return { kind: "diverged", cardState: from as CardState, status: String(cur.status) } as const;
    if (from === to) return { kind: "noop", state: to, why: "already_in_state" } as const;
    if (args.dedupeKey) {
      const seen = await q.query(
        "SELECT 1 FROM ticket_card_events WHERE ticket_id = $1 AND to_state = $2 AND dedupe_key = $3 LIMIT 1",
        [ticketId, to, args.dedupeKey],
      );
      if (seen.rows.length > 0) return { kind: "noop", state: from, why: "dedupe_key_replayed" } as const;
    }
    if (!isValidCardTransition(from, to, actorKind)) {
      return { kind: "invalid", from, to, allowed: allowedCardTargets(from, actorKind) } as const;
    }
    if (String(cur.status) !== legacyStatusFor(from)) return { kind: "diverged", cardState: from, status: String(cur.status) } as const;
    if (from === "ready" && to === "promoted" && !args.childProjectId) return { kind: "child_required" } as const;

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
    await recordCardEvent(q, {
      ticketId, from, to, actorKind, actorId: args.actorId, reason,
      childProjectId: args.childProjectId ?? (cur.child_project_id ? String(cur.child_project_id) : null),
      dedupeKey: args.dedupeKey,
    });
    return { kind: "applied", from, to, status: legacyStatusFor(to) } as const;
  });
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
