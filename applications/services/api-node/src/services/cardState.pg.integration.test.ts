/**
 * Fase 2 / 2.4 — máquina de estados do card em Postgres REAL: transições válidas, inválidas (matriz exaustiva contra o banco),
 * repetição idempotente, chave de idempotência, corrida e auditoria em ticket_card_events.
 * Só roda com PG_TEST_URL (localhost:55432|55440|55441). Sem ele: skip.
 */
import { it, expect, beforeAll, afterAll, vi } from "vitest";
import type pg from "pg";
import { describePg, openPg, seedAcceptedProduct, seedTicket, raceN, newUuid, type Seed } from "../testing/evolvePg.js";
import {
  CARD_STATES, enterCardMachine, findCardStatusDivergences, legacyStatusFor, transitionCard, type CardActorKind, type CardState,
} from "./cardState.js";

vi.mock("../db/client.js", () => ({ get pool() { return null; } }));

const ev = (tag: string, data: unknown) => console.log(`[F2-${tag}] EVIDÊNCIA ${JSON.stringify(data)}`);
const ACTORS: CardActorKind[] = ["user", "system", "reconciler", "guard"];
const EDGES: Record<string, CardActorKind[]> = {
  "draft>refining": ["user", "system"], "draft>ready": ["system"], "refining>ready": ["system"], "ready>refining": ["user", "system"],
  "ready>promoted": ["user", "system"], "promoted>in_factory": ["system"], "promoted>blocked": ["system", "guard", "reconciler"],
  "in_factory>blocked": ["system", "guard", "reconciler"], "blocked>in_factory": ["user", "system"], "promoted>ready": ["system"],
  "in_factory>ready": ["system"], "blocked>ready": ["system"], "in_factory>delivered": ["system"], "draft>rejected": ["user"],
  "refining>rejected": ["user"], "ready>rejected": ["user"], "blocked>rejected": ["user"],
};

describePg("Fase 2 / 2.4 — cardState (Postgres real)", () => {
  let pool: pg.Pool;
  const seeds: Seed[] = [];
  let s: Seed;

  beforeAll(async () => {
    pool = await openPg();
    s = await seedAcceptedProduct(pool, { budgetUsd: 50 });
    seeds.push(s);
  }, 60_000);
  afterAll(async () => {
    await pool.query("DELETE FROM genesis_runtime_config WHERE tenant_id = $1", [s.tenantId]);
    for (const x of seeds) x.cleanup();
    await pool.end();
  });

  /** Ticket já dentro da máquina no estado `st`, com o status legado coerente (e motivo quando o estado exige). */
  async function cardIn(st: CardState): Promise<string> {
    const t = await seedTicket(pool, s);
    await pool.query(
      `UPDATE tickets SET card_state = $2, status = $3, blocked_reason = $4, child_project_id = NULL, card_contract_version = 1 WHERE id = $1`,
      [t.id, st, legacyStatusFor(st), st === "blocked" ? "seed" : null],
    );
    return t.id;
  }
  const row = async (id: string) => (await pool.query("SELECT card_state, status, blocked_reason, child_project_id, promoted_at, delivered_at FROM tickets WHERE id = $1", [id])).rows[0];
  const events = async (id: string) => (await pool.query("SELECT from_state, to_state, actor_kind, reason, dedupe_key FROM ticket_card_events WHERE ticket_id = $1 ORDER BY created_at, id", [id])).rows;

  it("matriz exaustiva 8×8×4 atores contra o banco: aplica só as arestas de H §4.1; nunca escreve em inválido", async () => {
    let applied = 0, noop = 0, invalid = 0;
    for (const from of CARD_STATES) for (const to of CARD_STATES) for (const actor of ACTORS) {
      const id = await cardIn(from);
      const r = await transitionCard(pool, {
        ticketId: id, to, actorKind: actor, reason: to === "blocked" ? "t" : null,
        childProjectId: from === "ready" && to === "promoted" ? s.parentId : null,
      });
      const want = from === to ? "noop" : (EDGES[`${from}>${to}`] ?? []).includes(actor) ? "applied" : "invalid";
      expect(r.kind, `${from}>${to} por ${actor}`).toBe(want);
      const after = await row(id);
      const ev1 = await events(id);
      if (want === "applied") {
        applied++;
        expect(after.card_state).toBe(to);
        expect(after.status).toBe(legacyStatusFor(to));
        expect(ev1).toHaveLength(1);
        expect(ev1[0]).toMatchObject({ from_state: from, to_state: to, actor_kind: actor });
      } else {
        want === "noop" ? noop++ : invalid++;
        expect(after.card_state).toBe(from);
        expect(after.status).toBe(legacyStatusFor(from));
        expect(ev1).toHaveLength(0); // inválido e repetição não deixam evento
      }
    }
    ev("matriz", { applied, noop, invalid, total: applied + noop + invalid });
    expect(applied).toBe(Object.values(EDGES).reduce((n, a) => n + a.filter((x) => ACTORS.includes(x)).length, 0));
    expect(noop).toBe(8 * ACTORS.length);
    expect(applied + noop + invalid).toBe(8 * 8 * ACTORS.length);
  }, 120_000);

  it("ciclo completo com auditoria: draft → refining → ready → promoted → in_factory → blocked → in_factory → delivered", async () => {
    const id = await cardIn("draft");
    const steps: Array<[CardState, CardActorKind, Record<string, string | null>]> = [
      ["refining", "system", {}], ["ready", "system", {}], ["promoted", "user", { childProjectId: s.parentId }],
      ["in_factory", "system", {}], ["blocked", "guard", { reason: "budget:BUDGET_INSUFFICIENT" }], ["in_factory", "user", {}], ["delivered", "system", {}],
    ];
    for (const [to, actor, extra] of steps) {
      const r = await transitionCard(pool, { ticketId: id, to, actorKind: actor, ...extra });
      expect(r.kind, `→ ${to}`).toBe("applied");
      const t = await row(id);
      expect(t.status).toBe(legacyStatusFor(to));
      if (to === "blocked") expect(t.blocked_reason).toBe("budget:BUDGET_INSUFFICIENT"); else expect(t.blocked_reason).toBeNull();
    }
    const end = await row(id);
    expect(end.card_state).toBe("delivered");
    expect(end.promoted_at).not.toBeNull();
    expect(end.delivered_at).not.toBeNull();
    expect(end.child_project_id).toBe(s.parentId);
    const ev1 = await events(id);
    ev("ciclo", ev1.map((e) => `${e.from_state}>${e.to_state}:${e.actor_kind}`));
    expect(ev1.map((e) => `${e.from_state}>${e.to_state}`)).toEqual([
      "draft>refining", "refining>ready", "ready>promoted", "promoted>in_factory", "in_factory>blocked", "blocked>in_factory", "in_factory>delivered",
    ]);
    // terminal: sem saída
    expect((await transitionCard(pool, { ticketId: id, to: "ready", actorKind: "system" })).kind).toBe("invalid");
  });

  it("filho descartado (→ ready) limpa o vínculo e devolve o status legado a open", async () => {
    const id = await cardIn("ready");
    await transitionCard(pool, { ticketId: id, to: "promoted", actorKind: "user", childProjectId: s.parentId });
    expect((await row(id)).child_project_id).toBe(s.parentId);
    expect((await transitionCard(pool, { ticketId: id, to: "ready", actorKind: "system", reason: "child_discarded" })).kind).toBe("applied");
    const t = await row(id);
    expect(t).toMatchObject({ card_state: "ready", status: "open", child_project_id: null, promoted_at: null });
  });

  it("pré-condições: blocked exige motivo, promoted exige filho, status legado divergente recusa, ticket legado e inexistente", async () => {
    const a = await cardIn("promoted");
    expect((await transitionCard(pool, { ticketId: a, to: "blocked", actorKind: "system" })).kind).toBe("reason_required");
    expect((await transitionCard(pool, { ticketId: a, to: "blocked", actorKind: "system", reason: "   " })).kind).toBe("reason_required");
    const r = await cardIn("ready");
    expect((await transitionCard(pool, { ticketId: r, to: "promoted", actorKind: "user" })).kind).toBe("child_required");
    expect((await row(r)).card_state).toBe("ready");
    // um escritor antigo mexeu no status sem a máquina
    const d = await cardIn("ready");
    await pool.query("UPDATE tickets SET status = 'rejected' WHERE id = $1", [d]);
    const div = await findCardStatusDivergences(pool, { tenantId: s.tenantId });
    expect(div.map((x) => x.ticketId)).toContain(d);
    expect(await transitionCard(pool, { ticketId: d, to: "refining", actorKind: "user" })).toMatchObject({ kind: "diverged", cardState: "ready", status: "rejected" });
    // legado e inexistente
    const legacy = await seedTicket(pool, s);
    expect((await transitionCard(pool, { ticketId: legacy.id, to: "refining", actorKind: "user" })).kind).toBe("not_a_card");
    expect((await row(legacy.id)).card_state).toBeNull();
    expect((await transitionCard(pool, { ticketId: newUuid(), to: "refining", actorKind: "user" })).kind).toBe("not_found");
  });

  it("repetição: mesma transição N vezes ⇒ 1 aplicada, o resto noop, 1 evento; dedupeKey repetido é noop mesmo após sair e voltar", async () => {
    const id = await cardIn("draft");
    const first = await transitionCard(pool, { ticketId: id, to: "refining", actorKind: "system", dedupeKey: "run-1" });
    const again = await transitionCard(pool, { ticketId: id, to: "refining", actorKind: "system", dedupeKey: "run-1" });
    expect(first.kind).toBe("applied");
    expect(again).toMatchObject({ kind: "noop", why: "already_in_state" });
    // sai e volta ao mesmo destino com a mesma chave: não aplica de novo
    await transitionCard(pool, { ticketId: id, to: "ready", actorKind: "system" });
    const replay = await transitionCard(pool, { ticketId: id, to: "refining", actorKind: "user", dedupeKey: "run-1" });
    expect(replay).toMatchObject({ kind: "noop", why: "dedupe_key_replayed" });
    expect((await row(id)).card_state).toBe("ready");
    // chave nova aplica
    expect((await transitionCard(pool, { ticketId: id, to: "refining", actorKind: "user", dedupeKey: "run-2" })).kind).toBe("applied");
    expect((await events(id)).filter((e) => e.to_state === "refining")).toHaveLength(2);
  });

  it("corrida: 8× a mesma transição ⇒ 1 applied + 7 noop e 1 evento; ready→promoted × ready→rejected ⇒ exatamente um vence", async () => {
    const id = await cardIn("ready");
    const res = await raceN(8, () => transitionCard(pool, { ticketId: id, to: "refining", actorKind: "system" }));
    const kinds = res.map((r) => r.kind).sort();
    ev("corrida-mesma", kinds);
    expect(kinds.filter((k) => k === "applied")).toHaveLength(1);
    expect(kinds.filter((k) => k === "noop")).toHaveLength(7);
    expect(await events(id)).toHaveLength(1);

    const id2 = await cardIn("ready");
    const dup = await raceN(10, (i) => i % 2 === 0
      ? transitionCard(pool, { ticketId: id2, to: "promoted", actorKind: "user", childProjectId: s.parentId })
      : transitionCard(pool, { ticketId: id2, to: "rejected", actorKind: "user" }));
    const won = dup.filter((r) => r.kind === "applied");
    ev("corrida-conflito", dup.map((r) => r.kind).sort());
    expect(won).toHaveLength(1);
    const final = (await row(id2)).card_state;
    expect(["promoted", "rejected"]).toContain(final);
    // os perdedores do destino oposto são invalid (a partir do estado final); os do mesmo destino, noop
    for (const r of dup) expect(["applied", "noop", "invalid"]).toContain(r.kind);
    expect(await events(id2)).toHaveLength(1);
    expect((await row(id2)).status).toBe(legacyStatusFor(final as CardState));
  });

  it("CHECKs do banco: blocked sem motivo e estado fora da lista são rejeitados; origin só manual|import", async () => {
    const t = await seedTicket(pool, s);
    const fails = async (sql: string) => { try { await pool.query(sql, [t.id]); return null; } catch (e) { return (e as { constraint?: string }).constraint ?? "erro"; } };
    expect(await fails("UPDATE tickets SET card_state = 'blocked', status = 'promoted' WHERE id = $1")).toBe("tickets_blocked_reason_check");
    expect(await fails("UPDATE tickets SET card_state = 'failed' WHERE id = $1")).toBe("tickets_card_state_check");
    expect(await fails("UPDATE tickets SET origin = 'deadpool_incident' WHERE id = $1")).toBe("tickets_origin_check");
    expect((await pool.query("SELECT origin, card_state FROM tickets WHERE id = $1", [t.id])).rows[0]).toEqual({ origin: "manual", card_state: null });
  });

  it("enterCardMachine: flag off ⇒ flag_off e nada muda; flag do tenant on ⇒ draft (status continua open); outro tenant não é afetado; idempotente", async () => {
    const other = await seedAcceptedProduct(pool, { budgetUsd: 10 });
    seeds.push(other);
    const mine = await seedTicket(pool, s);
    const theirs = await seedTicket(pool, other);
    expect((await enterCardMachine(pool, { ticketId: mine.id })).kind).toBe("flag_off");
    expect((await row(mine.id)).card_state).toBeNull();

    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA', '1', $1)", [s.tenantId]);
    try {
      expect((await enterCardMachine(pool, { ticketId: mine.id, actorId: s.userId })).kind).toBe("applied");
      expect(await row(mine.id)).toMatchObject({ card_state: "draft", status: "open" });
      expect((await pool.query("SELECT card_contract_version FROM tickets WHERE id = $1", [mine.id])).rows[0].card_contract_version).toBe(1);
      expect((await enterCardMachine(pool, { ticketId: mine.id })).kind).toBe("noop");
      expect((await events(mine.id)).map((e) => `${e.from_state}>${e.to_state}`)).toEqual(["null>draft"]);
      expect((await enterCardMachine(pool, { ticketId: theirs.id })).kind).toBe("flag_off"); // outro tenant segue desligado
      expect((await row(theirs.id)).card_state).toBeNull();
      // só ticket `open` entra
      const prom = await seedTicket(pool, s, { status: "rejected" });
      expect(await enterCardMachine(pool, { ticketId: prom.id })).toMatchObject({ kind: "not_open", status: "rejected" });
      // já na máquina em outro estado
      await transitionCard(pool, { ticketId: mine.id, to: "refining", actorKind: "system" });
      expect(await enterCardMachine(pool, { ticketId: mine.id })).toMatchObject({ kind: "invalid", state: "refining" });
    } finally {
      await pool.query("DELETE FROM genesis_runtime_config WHERE key = 'CARDS_BANCADA' AND tenant_id = $1", [s.tenantId]);
    }
    // flag desligada depois de ligada: o card que já está na máquina segue transitando (consistência de dados)
    expect((await transitionCard(pool, { ticketId: mine.id, to: "ready", actorKind: "system" })).kind).toBe("applied");
  });

  it("dentro de transação do chamador (cliente): rollback desfaz estado e evento", async () => {
    const id = await cardIn("draft");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      expect((await transitionCard(c, { ticketId: id, to: "refining", actorKind: "system" })).kind).toBe("applied");
      await c.query("ROLLBACK");
    } finally { c.release(); }
    expect((await row(id)).card_state).toBe("draft");
    expect(await events(id)).toHaveLength(0);
  });
});
