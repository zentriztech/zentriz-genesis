/**
 * ticketTransitions.ts — tarefa 1.4 da Fase 1' (plano EVOLUIR-PROJETO-BANCADA v2): transições de ticket VALIDADAS.
 *
 * Flag `TICKET_TRANSITIONS` (`off` padrão):
 *   • `off` = comportamento histórico byte a byte (PATCH permissivo, `reopenTicketsOfChild` reabre tudo que não é `rejected`);
 *   • `on`  = tabela de transições (abaixo) aplicada ao PATCH, `UPDATE … WHERE status = <esperado>` (CAS),
 *             repetição idempotente, `reopenTicketsOfChild` só reabre `promoted` e cada transição grava
 *             uma linha em `ticket_events` (ator, de→para, motivo; migration 144).
 *
 * Resolução da flag (M-03; featureFlags.ts): tenant explícito > padrão global em `genesis_runtime_config` > env
 * `TICKET_TRANSITIONS` como DEFAULT de plataforma (nunca sobrepõe o tenant) > `off`.
 *
 * Escopo desta fase: só `tickets.status` (open|promoted|delivered|rejected). `card_state` (Fase 2) NÃO existe ainda.
 */
import type { RuntimeConfigDb } from "./runtimeTunables.js";
import { flagEnabled, parseEnvFlag, tenantOfProject } from "./featureFlags.js";

export const TICKET_TRANSITIONS_KEY = "TICKET_TRANSITIONS";

export type TicketStatus = "open" | "promoted" | "delivered" | "rejected";
export type TicketActorKind = "user" | "system";

/** Default de PLATAFORMA vindo do ambiente (`null` = ausente). Não sobrepõe o tenant. */
export function ticketTransitionsEnvDefault(): boolean | null {
  const n = parseEnvFlag(process.env.TICKET_TRANSITIONS, "bool");
  return n === null ? null : n === 1;
}

/** A flag está ligada? `tenantId` do recurso (ticket) primeiro; `projectId` resolve o tenant de um projeto. */
export async function ticketTransitionsEnabled(
  db: RuntimeConfigDb,
  opts: { tenantId?: string | null; projectId?: string | null; userTenantId?: string | null } = {},
): Promise<boolean> {
  let tenantId: string | null = opts.tenantId ?? null;
  if (!tenantId) tenantId = await tenantOfProject(db, opts.projectId);
  tenantId = tenantId ?? opts.userTenantId ?? null;
  return flagEnabled(db, "TICKET_TRANSITIONS", tenantId);
}

/**
 * Tabela de transições VÁLIDAS (de ⇒ para, por tipo de ator). Fonte: H §4.1/§4.4 (subconjunto legado) + código atual.
 *
 *   open      → promoted   (sistema: claim do /evolve)         | → rejected (humano)
 *   promoted  → delivered  (humano)  | → rejected (humano)     | → open (SÓ sistema: descarte/falha do filho — reopenTicketsOfChild)
 *   rejected  → open       (humano; só sem filho vinculado — "desfazer a recusa")
 *   delivered → (terminal)
 *
 * `open → delivered` e `rejected → delivered` não existem: entregar exige ter sido promovido.
 */
const TABLE: Record<TicketStatus, Partial<Record<TicketStatus, TicketActorKind[]>>> = {
  open: { promoted: ["system"], rejected: ["user"] },
  promoted: { delivered: ["user"], rejected: ["user"], open: ["system"] },
  rejected: { open: ["user"] },
  delivered: {},
};

export function isTicketStatus(v: unknown): v is TicketStatus {
  return v === "open" || v === "promoted" || v === "delivered" || v === "rejected";
}

export function isValidTicketTransition(from: string, to: string, actor: TicketActorKind): boolean {
  if (!isTicketStatus(from) || !isTicketStatus(to)) return false;
  return (TABLE[from][to] ?? []).includes(actor);
}

/** Destinos que existem na tabela para o `from` (para a mensagem de erro). */
export function allowedTicketTargets(from: string, actor: TicketActorKind): TicketStatus[] {
  if (!isTicketStatus(from)) return [];
  return (Object.keys(TABLE[from]) as TicketStatus[]).filter((to) => (TABLE[from][to] ?? []).includes(actor));
}

type Db = { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }> };

export interface TicketEventInput {
  ticketId: string;
  from: string | null;
  to: string;
  actorKind: TicketActorKind;
  actorId?: string | null;
  reason?: string | null;
  childProjectId?: string | null;
}

/** Auditoria: UMA linha em `ticket_events`. Sem PII (`actor_id` é UUID; `reason` é código do sistema). */
export async function recordTicketEvent(db: Db, e: TicketEventInput): Promise<void> {
  await db.query(
    `INSERT INTO ticket_events (ticket_id, from_status, to_status, actor_kind, actor_id, reason, child_project_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.ticketId, e.from, e.to, e.actorKind, e.actorId ?? null, e.reason ?? null, e.childProjectId ?? null],
  );
}

export type TransitionOutcome =
  | { kind: "applied" }
  | { kind: "noop" }                                  // mesma transição já aplicada: 200 sem efeito nem evento
  | { kind: "invalid"; from: string; to: string };    // 409 TICKET_INVALID_TRANSITION (inclui perder a corrida)

/**
 * Aplica `from → to` com CAS (`WHERE status = $from`) e grava o evento — tudo na mesma transação do `db`.
 * `extraSet` = fragmentos SQL (valores por parâmetro `$2..`, que casam com `extraVals`) para colunas além de `status`/`updated_at`.
 * `from` é o status lido pelo chamador; se mudou no meio, relê e decide: igual ao destino ⇒ noop; senão ⇒ invalid.
 */
export async function applyTicketTransition(
  db: Db,
  args: {
    ticketId: string; from: string; to: TicketStatus; actorKind: TicketActorKind; actorId?: string | null;
    reason?: string | null; childProjectId?: string | null; extraSet?: string[]; extraVals?: unknown[];
  },
): Promise<TransitionOutcome & { row?: Record<string, unknown> }> {
  const { ticketId, from, to } = args;
  if (from === to) return { kind: "noop" };
  if (!isValidTicketTransition(from, to, args.actorKind)) return { kind: "invalid", from, to };
  // Parâmetros: $1 = id, $2..$k+1 = extraVals (referenciados por extraSet), $k+2 = from, $k+3 = to.
  const extraVals = args.extraVals ?? [];
  const iFrom = extraVals.length + 2;
  const iTo = extraVals.length + 3;
  const vals: unknown[] = [ticketId, ...extraVals, from, to];
  const set = [`status = $${iTo}`, ...(args.extraSet ?? []), "updated_at = now()"];
  const up = await db.query(`UPDATE tickets SET ${set.join(", ")} WHERE id = $1 AND status = $${iFrom} RETURNING *`, vals);
  if ((up.rowCount ?? up.rows.length) === 0) {
    const cur = (await db.query("SELECT status FROM tickets WHERE id = $1", [ticketId])).rows[0]?.status;
    if (cur === to) return { kind: "noop" };
    return { kind: "invalid", from: String(cur ?? from), to };
  }
  await recordTicketEvent(db, {
    ticketId, from, to, actorKind: args.actorKind, actorId: args.actorId, reason: args.reason, childProjectId: args.childProjectId,
  });
  return { kind: "applied", row: up.rows[0] };
}
