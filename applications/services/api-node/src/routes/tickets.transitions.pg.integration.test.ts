/**
 * Tarefa 1.4 (Fase 1', EVOLUIR-PROJETO-BANCADA v2) — transições de ticket VALIDADAS, em Postgres REAL (efêmero).
 * Flag TICKET_TRANSITIONS: `off` (padrão) preserva o PATCH permissivo e o `reopenTicketsOfChild` histórico (byte a byte);
 * `on` aplica a tabela de transições, CAS, idempotência, `reopenTicketsOfChild` só em `promoted` e auditoria em `ticket_events`.
 * Só roda com PG_TEST_URL (ver src/testing/evolvePg.ts). Sem ele: skip.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import {
  describePg, openPg, dbClientMock, authMock, seedAcceptedProduct, seedTicket, buildApp, raceN, ticketRow, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { projectRoutes } from "./projects.js";
import { ticketRoutes } from "./tickets.js";
import { reopenTicketsOfChild } from "../services/tickets.js";
import { isValidTicketTransition } from "../services/ticketTransitions.js";

const STATES = ["open", "promoted", "delivered", "rejected"] as const;
const TARGETS = ["open", "rejected", "delivered"] as const;

describe("tabela de transições (pura)", () => {
  it("humano: open→rejected, promoted→delivered|rejected, rejected→open; nunca promoted→open nem saída de delivered", () => {
    expect(isValidTicketTransition("open", "rejected", "user")).toBe(true);
    expect(isValidTicketTransition("promoted", "delivered", "user")).toBe(true);
    expect(isValidTicketTransition("promoted", "rejected", "user")).toBe(true);
    expect(isValidTicketTransition("rejected", "open", "user")).toBe(true);
    expect(isValidTicketTransition("promoted", "open", "user")).toBe(false);
    for (const to of ["open", "promoted", "rejected"]) expect(isValidTicketTransition("delivered", to, "user")).toBe(false);
    expect(isValidTicketTransition("open", "delivered", "user")).toBe(false);
  });
  it("sistema: open→promoted e promoted→open (somente ele)", () => {
    expect(isValidTicketTransition("open", "promoted", "system")).toBe(true);
    expect(isValidTicketTransition("promoted", "open", "system")).toBe(true);
    expect(isValidTicketTransition("delivered", "open", "system")).toBe(false);
    expect(isValidTicketTransition("rejected", "open", "system")).toBe(false);
  });
});

describePg("Fase 1' / 1.4 — transições de ticket (Postgres real)", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  beforeAll(async () => {
    pool = await openPg();
    app = await buildApp([projectRoutes, ticketRoutes]);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await app?.close();
    for (const s of seeds) s.cleanup();
    await pool?.end();
  });
  const seed = async () => { const s = await seedAcceptedProduct(pool); seeds.push(s); return s; };
  const mkChild = async (s: Seed, status = "draft") => (await pool.query(
    `INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id, version_number)
     VALUES ($1,$2,'filho',$3,$4,$5,2) RETURNING id`, [s.tenantId, s.userId, status, s.productId, s.parentId])).rows[0].id as string;
  const patch = (id: string, payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/api/tickets/${id}`, payload });
  const events = async (ticketId: string) => (await pool.query(
    "SELECT from_status, to_status, actor_kind, actor_id, reason, child_project_id FROM ticket_events WHERE ticket_id=$1 ORDER BY created_at, id", [ticketId])).rows;

  describe("flag OFF (padrão) — byte-idêntico ao comportamento histórico", () => {
    beforeAll(() => { vi.stubEnv("TICKET_TRANSITIONS", "off"); });
    afterAll(() => { vi.unstubAllEnvs(); });
    it("PATCH permissivo: promoted→open e delivered→rejected continuam 200, sem nenhum evento", async () => {
      const s = await seed();
      const c = await mkChild(s);
      const t1 = await seedTicket(pool, s, { status: "promoted", childProjectId: c });
      const t2 = await seedTicket(pool, s, { status: "delivered", childProjectId: c });
      expect((await patch(t1.id, { status: "open" })).statusCode).toBe(200);
      expect((await patch(t2.id, { status: "rejected" })).statusCode).toBe(200);
      expect((await ticketRow(pool, t1.id)).status).toBe("open");
      expect((await ticketRow(pool, t2.id)).status).toBe("rejected");
      expect(await events(t1.id)).toHaveLength(0);
      expect(await events(t2.id)).toHaveLength(0);
    });
    it("PATCH sem mudança de status continua 400 'Nada a alterar' e repetição de status continua 200 reescrevendo", async () => {
      const s = await seed();
      const t = await seedTicket(pool, s, { status: "rejected" });
      expect((await patch(t.id, {})).statusCode).toBe(400);
      expect((await patch(t.id, { status: "rejected" })).statusCode).toBe(200);
    });
    it("reopenTicketsOfChild histórico: reabre 'delivered' (defeito preservado com a flag off), preserva 'rejected'", async () => {
      const s = await seed();
      const c = await mkChild(s);
      const d = await seedTicket(pool, s, { status: "delivered", childProjectId: c });
      const r = await seedTicket(pool, s, { status: "rejected", childProjectId: c });
      await reopenTicketsOfChild(pool, c);
      expect((await ticketRow(pool, d.id)).status).toBe("open");
      expect((await ticketRow(pool, r.id)).status).toBe("rejected");
    });
    it("DELETE do projeto filho com flag off reabre o 'delivered' (histórico) e não grava evento", async () => {
      const s = await seed();
      const c = await mkChild(s);
      const d = await seedTicket(pool, s, { status: "delivered", childProjectId: c });
      expect((await app.inject({ method: "DELETE", url: `/api/projects/${c}?keepFiles=true` })).statusCode).toBeLessThan(300);
      expect((await ticketRow(pool, d.id)).status).toBe("open");
      expect(await events(d.id)).toHaveLength(0);
    });
  });

  describe("flag ON — matriz exaustiva do PATCH (todos os de × para)", () => {
    beforeAll(() => { vi.stubEnv("TICKET_TRANSITIONS", "on"); });
    afterAll(() => { vi.unstubAllEnvs(); });
    // esperado por (de, para) para o ator humano
    const expected: Record<string, number> = {
      "open→open": 200, "open→rejected": 200, "open→delivered": 409,
      "promoted→open": 409, "promoted→rejected": 200, "promoted→delivered": 200,
      "delivered→open": 409, "delivered→rejected": 409, "delivered→delivered": 200,
      "rejected→open": 200, "rejected→rejected": 200, "rejected→delivered": 409,
    };
    for (const from of STATES) {
      for (const to of TARGETS) {
        const key = `${from}→${to}`;
        it(`${key} ⇒ ${expected[key]}`, async () => {
          const s = await seed();
          const withChild = from === "promoted" || from === "delivered"; // rejected sem filho (rejected→open com filho é caso próprio abaixo)
          const c = withChild ? await mkChild(s) : null;
          const t = await seedTicket(pool, s, { status: from, childProjectId: c });
          const r = await patch(t.id, { status: to });
          expect(r.statusCode).toBe(expected[key]);
          const after = (await ticketRow(pool, t.id)).status;
          const ev = await events(t.id);
          if (r.statusCode === 409) {
            expect(after).toBe(from);
            expect(ev).toHaveLength(0);
            // → delivered sem filho mantém o código histórico NOT_PROMOTED; as demais usam o código novo
            expect(r.json().code).toBe((!withChild && to === "delivered") ? "NOT_PROMOTED" : "TICKET_INVALID_TRANSITION");
          } else if (from === to) {
            expect(after).toBe(from);
            expect(ev).toHaveLength(0); // repetição idempotente: sem efeito nem evento
          } else {
            expect(after).toBe(to);
            expect(ev).toHaveLength(1);
            expect(ev[0]).toMatchObject({ from_status: from, to_status: to, actor_kind: "user", reason: "manual_patch" });
            expect(ev[0].actor_id).toBe(s.userId);
          }
        });
      }
    }
    it("rejected→open é recusado (409) se o ticket recusado ainda aponta para um filho", async () => {
      const s = await seed();
      const c = await mkChild(s);
      const t = await seedTicket(pool, s, { status: "rejected", childProjectId: c });
      const r = await patch(t.id, { status: "open" });
      expect(r.statusCode).toBe(409);
      expect(r.json().code).toBe("TICKET_INVALID_TRANSITION");
    });
    it("repetir a MESMA transição já aplicada ⇒ 200 e nenhum evento novo", async () => {
      const s = await seed();
      const t = await seedTicket(pool, s, {});
      expect((await patch(t.id, { status: "rejected" })).statusCode).toBe(200);
      expect((await patch(t.id, { status: "rejected" })).statusCode).toBe(200);
      expect(await events(t.id)).toHaveLength(1);
    });
    it("corrida: 'rejected' × 'delivered' sobre o mesmo promoted ⇒ exatamente uma vence, a outra 409; 1 evento", async () => {
      const s = await seed();
      const c = await mkChild(s);
      const t = await seedTicket(pool, s, { status: "promoted", childProjectId: c });
      const res = await raceN(2, (i) => patch(t.id, { status: i === 0 ? "rejected" : "delivered" }));
      const codes = res.map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 409]);
      const ev = await events(t.id);
      expect(ev).toHaveLength(1);
      expect((await ticketRow(pool, t.id)).status).toBe(ev[0].to_status);
    });
    it("edição de conteúdo + recusa na mesma chamada: aplica as duas coisas em um só UPDATE", async () => {
      const s = await seed();
      const t = await seedTicket(pool, s, {});
      const r = await patch(t.id, { title: "Novo título", status: "rejected" });
      expect(r.statusCode).toBe(200);
      const row = await ticketRow(pool, t.id);
      expect(row.status).toBe("rejected");
      expect((await pool.query("SELECT title FROM tickets WHERE id=$1", [t.id])).rows[0].title).toBe("Novo título");
    });
    it("edição de conteúdo em ticket promovido continua 409 TICKET_IMMUTABLE", async () => {
      const s = await seed();
      const c = await mkChild(s);
      const t = await seedTicket(pool, s, { status: "promoted", childProjectId: c });
      const r = await patch(t.id, { title: "x" });
      expect(r.statusCode).toBe(409);
      expect(r.json().code).toBe("TICKET_IMMUTABLE");
    });
  });

  describe("flag ON — reopenTicketsOfChild só reabre 'promoted' (e audita)", () => {
    beforeAll(() => { vi.stubEnv("TICKET_TRANSITIONS", "on"); });
    afterAll(() => { vi.unstubAllEnvs(); });
    it("função: promoted→open com evento system; delivered e rejected intocados", async () => {
      const s = await seed();
      const c = await mkChild(s);
      const p = await seedTicket(pool, s, { status: "promoted", childProjectId: c });
      const d = await seedTicket(pool, s, { status: "delivered", childProjectId: c });
      const r = await seedTicket(pool, s, { status: "rejected", childProjectId: c });
      const n = await reopenTicketsOfChild(pool, c, { strict: true, reason: "child_deleted" });
      expect(n).toBe(1);
      expect((await ticketRow(pool, p.id)).status).toBe("open");
      expect((await ticketRow(pool, p.id)).child_project_id).toBeNull();
      expect((await ticketRow(pool, d.id)).status).toBe("delivered");
      expect((await ticketRow(pool, r.id)).status).toBe("rejected");
      const ev = await events(p.id);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ from_status: "promoted", to_status: "open", actor_kind: "system", reason: "child_deleted", child_project_id: c });
      expect(await events(d.id)).toHaveLength(0);
    });
    it("rota: DELETE do filho reabre o promovido e preserva o entregue (flag lida pelo tenant/env)", async () => {
      const s = await seed();
      const c = await mkChild(s);
      const p = await seedTicket(pool, s, { status: "promoted", childProjectId: c });
      const d = await seedTicket(pool, s, { status: "delivered", childProjectId: c });
      const r = await app.inject({ method: "DELETE", url: `/api/projects/${c}?keepFiles=true` });
      expect(r.statusCode).toBeLessThan(300);
      expect((await ticketRow(pool, p.id)).status).toBe("open");
      expect((await ticketRow(pool, d.id)).status).toBe("delivered");
      const ev = await events(p.id);
      expect(ev[0]).toMatchObject({ actor_kind: "system", reason: "child_deleted" });
    });
  });

  describe("flag ON via genesis_runtime_config (override por tenant)", () => {
    it("valor 1 do tenant liga a validação só para ele", async () => {
      vi.unstubAllEnvs();
      const a = await seed();
      await pool.query("INSERT INTO genesis_runtime_config (key, value, description, tenant_id) VALUES ('TICKET_TRANSITIONS','1','teste',$1)", [a.tenantId]);
      const c = await mkChild(a);
      const tA = await seedTicket(pool, a, { status: "promoted", childProjectId: c });
      expect((await patch(tA.id, { status: "open" })).statusCode).toBe(409);
      const b = await seed(); // outro tenant, sem override
      const cb = await mkChild(b);
      const tB = await seedTicket(pool, b, { status: "promoted", childProjectId: cb });
      expect((await patch(tB.id, { status: "open" })).statusCode).toBe(200);
    });
  });
});
