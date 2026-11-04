/**
 * Fase 2 / lote B — S-01: TRAVA da flag CARDS_BANCADA (PUT/DELETE de /api/admin/runtime-config) em Postgres REAL (banco descartável).
 *
 *  • Liga a flag num tenant com tickets e reproduz os TRÊS cenários que o revisor mostrou (PATCH `rejected`, `/evolve` legado com
 *    ticket-card, `reopenTicketsOfChild`): agora SEM divergência card_state × status (a 2.6 roteia os escritores pela máquina).
 *  • Com a flag OFF nada muda (tickets legados seguem o caminho antigo, sem card_state nem eventos).
 *  • Divergência pré-existente ⇒ o PUT/DELETE recusa com 409 CARD_DIVERGENCE e reverte TUDO (flag + backfill): o tenant fica como estava.
 * Só roda com PG_TEST_URL (localhost:55432|55440|55441).
 */
import { it, expect, beforeAll, afterAll, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import {
  describePg, createScratchDb, dbClientMock, authMock, testUser, seedAcceptedProduct, seedTicket, buildApp, childrenOf, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { runtimeConfigRoutes } from "./runtimeConfig.js";
import { projectRoutes } from "./projects.js";
import { ticketRoutes } from "./tickets.js";
import { reopenTicketsOfChild } from "../services/tickets.js";
import { findCardStatusDivergences } from "../services/cardState.js";

const ev = (tag: string, data: unknown) => console.log(`[F2-B-${tag}] EVIDÊNCIA ${JSON.stringify(data)}`);

describePg("Fase 2 / S-01 — trava da flag CARDS_BANCADA (Postgres real)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  let app: FastifyInstance;
  const seeds: Seed[] = [];
  const admin = (s: Seed) => Object.assign(testUser, { id: s.userId, role: "zentriz_admin", tenantId: null });
  const asTenant = (s: Seed) => Object.assign(testUser, { id: s.userId, role: "tenant_admin", tenantId: s.tenantId });
  const put = (value: number, tenantId?: string) =>
    app.inject({ method: "PUT", url: "/api/admin/runtime-config/CARDS_BANCADA", payload: { value, ...(tenantId ? { tenantId } : {}) } });
  const del = (tenantId: string) => app.inject({ method: "DELETE", url: `/api/admin/runtime-config/CARDS_BANCADA?tenantId=${tenantId}` });
  const mk = async () => { const s = await seedAcceptedProduct(pool, { budgetUsd: 50 }); seeds.push(s); return s; };
  const mkChild = async (s: Seed, status: string) =>
    (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id, version_number) VALUES ($1,$2,'filho',$3,$4,2) RETURNING id`,
      [s.tenantId, s.userId, status, s.productId],
    )).rows[0].id as string;
  const flagRow = async (tenantId: string | null) =>
    (await pool.query("SELECT value FROM genesis_runtime_config WHERE key = 'CARDS_BANCADA' AND tenant_id IS NOT DISTINCT FROM $1", [tenantId])).rows[0]?.value ?? null;
  const row = async (id: string) => (await pool.query("SELECT status, card_state, child_project_id FROM tickets WHERE id = $1", [id])).rows[0];
  const nEvents = async (tenantId: string) =>
    Number((await pool.query("SELECT count(*)::int AS n FROM ticket_card_events WHERE ticket_id IN (SELECT id FROM tickets WHERE tenant_id = $1)", [tenantId])).rows[0].n);

  beforeAll(async () => {
    scratch = await createScratchDb("evo_flagguard");
    pool = scratch.pool;
    const { initDb } = await import("../db/init.js");
    await initDb();
    app = await buildApp([runtimeConfigRoutes, projectRoutes, ticketRoutes]);
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    for (const x of seeds) x.cleanup();
    await scratch?.drop();
  });

  it("flag ON num tenant com tickets: PATCH rejected, /evolve legado e reopenTicketsOfChild NÃO geram divergência card_state × status", async () => {
    const A = await mk();
    const tReject = (await seedTicket(pool, A)).id;
    const tEvolve = (await seedTicket(pool, A)).id;
    const kid = await mkChild(A, "running");
    const tReopen = (await seedTicket(pool, A, { status: "promoted", childProjectId: kid })).id;
    admin(A);
    const on = await put(1, A.tenantId);
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().cardsBackfill[0].cardState.total).toBe(3);
    expect(await findCardStatusDivergences(pool, { tenantId: A.tenantId })).toEqual([]);
    expect(await row(tReject)).toMatchObject({ card_state: "draft", status: "open" });
    expect(await row(tReopen)).toMatchObject({ card_state: "in_factory", status: "promoted" });

    // (1) PATCH legado `rejected`: antes deixava [rejected, draft]; agora passa pela máquina
    asTenant(A);
    const rej = await app.inject({ method: "PATCH", url: `/api/tickets/${tReject}`, payload: { status: "rejected" } });
    expect(rej.statusCode, rej.body).toBe(200);
    expect(await row(tReject)).toMatchObject({ status: "rejected", card_state: "rejected" });

    // (2) /evolve legado com o ticket-card: antes 201 e [promoted, draft]; agora 409 USE_CARD_PROMOTE e nada é criado
    const evolve = await app.inject({ method: "POST", url: `/api/projects/${A.parentId}/evolve`, payload: { request: "Exportar CSV", ticketId: tEvolve } });
    expect(evolve.statusCode, evolve.body).toBe(409);
    expect(evolve.json().code).toBe("USE_CARD_PROMOTE");
    expect(await row(tEvolve)).toMatchObject({ status: "open", card_state: "draft", child_project_id: null });
    expect(await childrenOf(pool, A.parentId)).toEqual([]);                       // nenhum filho de evolução criado

    // (3) reopenTicketsOfChild: antes {open, in_factory}; agora grava card_state='ready' na mesma instrução
    expect(await reopenTicketsOfChild(pool, kid, { strict: true, reason: "child_deleted" })).toBe(1);
    expect(await row(tReopen)).toMatchObject({ status: "open", card_state: "ready", child_project_id: null });

    const div = await findCardStatusDivergences(pool, { tenantId: A.tenantId });
    ev("tres-cenarios", { divergencias: div.length, estados: [await row(tReject), await row(tEvolve), await row(tReopen)].map((r) => `${r.status}/${r.card_state}`) });
    expect(div).toEqual([]);
  });

  it("flag OFF: nada muda — os mesmos três caminhos seguem o legado (sem card_state, sem eventos)", async () => {
    const B = await mk();
    const tReject = (await seedTicket(pool, B)).id;
    const tEvolve = (await seedTicket(pool, B)).id;
    const kid = await mkChild(B, "running");
    const tReopen = (await seedTicket(pool, B, { status: "promoted", childProjectId: kid })).id;
    asTenant(B);
    expect((await app.inject({ method: "PATCH", url: `/api/tickets/${tReject}`, payload: { status: "rejected" } })).statusCode).toBe(200);
    const evolve = await app.inject({ method: "POST", url: `/api/projects/${B.parentId}/evolve`, payload: { request: "Exportar CSV", ticketId: tEvolve } });
    expect(evolve.statusCode, evolve.body).toBe(201);
    expect(await reopenTicketsOfChild(pool, kid)).toBe(1);
    expect(await row(tReject)).toMatchObject({ status: "rejected", card_state: null });
    expect(await row(tEvolve)).toMatchObject({ status: "promoted", card_state: null });
    expect(await row(tReopen)).toMatchObject({ status: "open", card_state: null, child_project_id: null });
    expect(await nEvents(B.tenantId)).toBe(0);
    expect(await flagRow(B.tenantId)).toBeNull();
    // desligar uma flag que nunca esteve ligada para o tenant não é bloqueado nem escreve card_state
    admin(B);
    const off = await put(0, B.tenantId);
    expect(off.statusCode).toBe(200);
    expect(off.json().cardsBackfill).toEqual([]);
    expect(await row(tReject)).toMatchObject({ card_state: null });
  });

  it("divergência pré-existente: PUT 1 recusa com 409 CARD_DIVERGENCE, lista a ocorrência e REVERTE flag e backfill (tenant intacto)", async () => {
    const C = await mk();
    const bad = (await seedTicket(pool, C)).id;                       // card_state/status incoerentes (escritor antigo, flag ligada e desligada antes)
    await pool.query("UPDATE tickets SET card_state = 'draft', status = 'rejected', card_contract_version = 1 WHERE id = $1", [bad]);
    const legacy = (await seedTicket(pool, C)).id;                    // legado ainda NULL: o backfill o tocaria
    admin(C);
    const r = await put(1, C.tenantId);
    ev("recusa", { status: r.statusCode, body: r.json() });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: "CARD_DIVERGENCE", divergences: [{ ticketId: bad, tenantId: C.tenantId, cardState: "draft", status: "rejected", expectedStatus: "open" }] });
    expect(await flagRow(C.tenantId)).toBeNull();                      // flag NÃO gravada
    expect(await row(legacy)).toMatchObject({ card_state: null });     // backfill desfeito
    expect(await nEvents(C.tenantId)).toBe(0);
    // corrigida a divergência, a mesma chamada passa
    await pool.query("UPDATE tickets SET status = 'open' WHERE id = $1", [bad]);
    const ok = await put(1, C.tenantId);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await flagRow(C.tenantId)).toBe("1");
    expect(await row(legacy)).toMatchObject({ card_state: "draft", status: "open" });
  });

  it("DELETE do override que religaria a flag (volta ao global ligado) também é travado; e o padrão GLOBAL recusa se um tenant a ser ligado diverge", async () => {
    const D = await mk();
    const E = await mk();
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA','0',$1)", [D.tenantId]);
    const bad = (await seedTicket(pool, D)).id;
    await pool.query("UPDATE tickets SET card_state = 'in_factory', status = 'open', card_contract_version = 1 WHERE id = $1", [bad]);
    const eLegacy = (await seedTicket(pool, E)).id;
    admin(D);

    // global 1: D tem override 0 (fora); E liga e é migrado; os tenants A/C (já ligados) não bloqueiam
    const g = await put(1);
    expect(g.statusCode, g.body).toBe(200);
    expect((g.json().cardsBackfill as Array<{ tenantId: string }>).map((x) => x.tenantId)).toContain(E.tenantId);
    expect((g.json().cardsBackfill as Array<{ tenantId: string }>).map((x) => x.tenantId)).not.toContain(D.tenantId);
    expect(await row(eLegacy)).toMatchObject({ card_state: "draft" });
    expect(await flagRow(null)).toBe("1");

    // remover o override 0 de D religa D (global=1) ⇒ divergência ⇒ 409 e o override continua lá
    const d = await del(D.tenantId);
    ev("delete-recusa", { status: d.statusCode, divergencias: d.json().divergences?.length });
    expect(d.statusCode).toBe(409);
    expect(d.json().code).toBe("CARD_DIVERGENCE");
    expect(await flagRow(D.tenantId)).toBe("0");
    // corrige e repete
    await pool.query("UPDATE tickets SET status = 'promoted' WHERE id = $1", [bad]);
    expect((await del(D.tenantId)).statusCode).toBe(200);
    expect(await flagRow(D.tenantId)).toBeNull();

    // global novo: reverter o global ligado num tenant divergente não é bloqueado ao DESLIGAR; ligar de novo com divergência é
    expect((await put(0)).statusCode).toBe(200);
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA','0',$1)", [E.tenantId]);
    const eBad = (await seedTicket(pool, E)).id;
    await pool.query("UPDATE tickets SET card_state = 'draft', status = 'delivered', card_contract_version = 1 WHERE id = $1", [eBad]);
    await pool.query("DELETE FROM genesis_runtime_config WHERE key = 'CARDS_BANCADA' AND tenant_id = $1", [E.tenantId]);
    const g2 = await put(1);
    expect(g2.statusCode).toBe(409);
    expect((g2.json().divergences as Array<{ ticketId: string }>).map((x) => x.ticketId)).toEqual([eBad]);
    expect(await flagRow(null)).toBe("0");                              // global ficou como estava (0)
    // PUT global repetido não duplica a linha global (UNIQUE com NULL não conflita)
    expect(Number((await pool.query("SELECT count(*)::int AS n FROM genesis_runtime_config WHERE key = 'CARDS_BANCADA' AND tenant_id IS NULL")).rows[0].n)).toBe(1);
  });

  it("DELETE de override inexistente continua 404 e chave comum não passa pela trava (sem cardsBackfill)", async () => {
    const F = await mk();
    admin(F);
    expect((await del(F.tenantId)).statusCode).toBe(404);
    const other = await app.inject({ method: "PUT", url: "/api/admin/runtime-config/AGENT_TIMEOUT_PM", payload: { value: 600, tenantId: F.tenantId } });
    expect(other.statusCode).toBe(200);
    expect(other.json()).not.toHaveProperty("cardsBackfill");
    await pool.query("DELETE FROM genesis_runtime_config WHERE key = 'AGENT_TIMEOUT_PM' AND tenant_id = $1", [F.tenantId]);
  });
});
