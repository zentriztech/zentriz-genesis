/**
 * Fase 4 (4.2) — `POST /api/projects/:id/tasks` grava o vínculo task → card (`card_id`, `origin_spec_file`).
 * Regras: só com CARDS_BANCADA ligada para o tenant; o card tem de ser o ticket que originou o projeto (extra.ticket_id);
 * COALESCE no upsert (reenvio sem card não apaga o vínculo); tasks herdadas DONE seguem intactas. Postgres REAL, tenant isolado.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { describePg, openPg, dbClientMock, authMock, seedAcceptedProduct, seedTicket, buildApp, childrenOf, type Seed } from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { projectRoutes } from "./projects.js";
import { ticketRoutes } from "./tickets.js";

describePg("Fase 4 (4.2) — POST /tasks com card_id (Postgres real)", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let s: Seed;
  let kidId: string;
  let ticketId: string;

  beforeAll(async () => {
    pool = await openPg();
    s = await seedAcceptedProduct(pool, { budgetUsd: 50 });
    app = await buildApp([projectRoutes, ticketRoutes]);
    const t = await seedTicket(pool, s);
    ticketId = t.id;
    const ev = await app.inject({ method: "POST", url: `/api/projects/${s.parentId}/evolve`, payload: { request: "Exportar CSV", ticketId } });
    expect(ev.statusCode, ev.body).toBe(201);
    kidId = (await childrenOf(pool, s.parentId))[0].id;
  }, 60_000);
  afterAll(async () => { await app?.close(); s?.cleanup(); await pool?.end(); });

  const post = (tasks: object[]) => app.inject({ method: "POST", url: `/api/projects/${kidId}/tasks`, payload: { tasks } });
  const row = async (taskId: string) => (await pool.query("SELECT status, card_id, origin_spec_file FROM project_tasks WHERE project_id = $1 AND task_id = $2", [kidId, taskId])).rows[0];

  it("flag OFF: card_id é ignorado (estado do banco idêntico ao de antes)", async () => {
    const r = await post([{ task_id: "TSK-EVO-001", module: "backend", owner_role: "DEV_BACKEND", card_id: ticketId, origin_spec_file: "tickets/TK-0001/request.md" }]);
    expect(r.statusCode, r.body).toBe(201);
    expect(await row("TSK-EVO-001")).toMatchObject({ card_id: null, origin_spec_file: null });
  });

  it("flag ON: TSK-EVO nova ligada ao card; reenvio sem card mantém; herdada DONE intacta; card alheio => 400", async () => {
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA', '1', $1)", [s.tenantId]);
    try {
      expect((await post([{ task_id: "TSK-INH-V1-BE-001", module: "backend", owner_role: "DEV", status: "DONE", requirements: "[HERDADA da v1 — TSK-BE-001] CRUD" }])).statusCode).toBe(201);
      const r = await post([{ task_id: "TSK-EVO-001", module: "backend", owner_role: "DEV_BACKEND", card_id: ticketId, origin_spec_file: "tickets/TK-0001/request.md" }]);
      expect(r.statusCode, r.body).toBe(201);
      expect(await row("TSK-EVO-001")).toMatchObject({ card_id: ticketId, origin_spec_file: "tickets/TK-0001/request.md" });
      expect(await row("TSK-INH-V1-BE-001")).toMatchObject({ status: "DONE", card_id: null, origin_spec_file: null });
      // retomada do runner: reenvio sem card_id não apaga o vínculo; id da task não duplica
      expect((await post([{ task_id: "TSK-EVO-001", module: "backend", owner_role: "DEV_BACKEND" }])).statusCode).toBe(201);
      expect(await row("TSK-EVO-001")).toMatchObject({ card_id: ticketId });
      expect((await pool.query("SELECT count(*)::int AS n FROM project_tasks WHERE project_id = $1 AND task_id = 'TSK-EVO-001'", [kidId])).rows[0].n).toBe(1);
      // GET expõe o vínculo (leitura da Fase 2) com a flag ligada
      const g = await app.inject({ method: "GET", url: `/api/projects/${kidId}/tasks` });
      expect(g.json().find((t: { taskId: string }) => t.taskId === "TSK-EVO-001")).toMatchObject({ cardId: ticketId, originSpecFile: "tickets/TK-0001/request.md" });
      // card que não originou o projeto
      const bad = await post([{ task_id: "TSK-EVO-002", module: "backend", owner_role: "DEV_BACKEND", card_id: "00000000-0000-4000-8000-000000000000" }]);
      expect(bad.statusCode).toBe(400);
      expect(bad.json().code).toBe("CARD_MISMATCH");
      expect(await row("TSK-EVO-002")).toBeUndefined();
    } finally {
      await pool.query("DELETE FROM genesis_runtime_config WHERE key = 'CARDS_BANCADA' AND tenant_id = $1", [s.tenantId]);
    }
  });
});

describePg("Fase 4 (AG) — A3 card_id por padrão e M2 POST /tasks atômico (Postgres real)", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let s: Seed;
  let kidId: string;
  let ticketId: string;

  beforeAll(async () => {
    pool = await openPg();
    s = await seedAcceptedProduct(pool, { budgetUsd: 50 });
    app = await buildApp([projectRoutes, ticketRoutes]);
    ticketId = (await seedTicket(pool, s)).id;
    const ev = await app.inject({ method: "POST", url: `/api/projects/${s.parentId}/evolve`, payload: { request: "Exportar CSV", ticketId } });
    expect(ev.statusCode, ev.body).toBe(201);
    kidId = (await childrenOf(pool, s.parentId))[0].id;
  }, 60_000);
  afterAll(async () => { await app?.close(); s?.cleanup(); await pool?.end(); });

  const post = (tasks: object[]) => app.inject({ method: "POST", url: `/api/projects/${kidId}/tasks`, payload: { tasks } });
  const cardOf = async (taskId: string) => (await pool.query("SELECT card_id FROM project_tasks WHERE project_id = $1 AND task_id = $2", [kidId, taskId])).rows[0] as { card_id: string | null } | undefined;
  const count = async () => (await pool.query("SELECT count(*)::int AS n FROM project_tasks WHERE project_id = $1", [kidId])).rows[0].n as number;
  const flagOn = () => pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA', '1', $1)", [s.tenantId]);
  const flagOff = () => pool.query("DELETE FROM genesis_runtime_config WHERE key = 'CARDS_BANCADA' AND tenant_id = $1", [s.tenantId]);
  const asCard = () => pool.query("UPDATE tickets SET card_state = 'in_factory', status = 'promoted', card_contract_version = 1 WHERE id = $1", [ticketId]);
  const asLegacy = () => pool.query("UPDATE tickets SET card_state = NULL, status = 'promoted' WHERE id = $1", [ticketId]);

  it("A3: flag ON + filho de card ⇒ TODA task não herdada recebe card_id sem o runner enviar; TSK-INH-* fica sem (mesmo com card_id explícito)", async () => {
    await asCard(); await flagOn();
    try {
      const r = await post([
        { task_id: "TSK-EVO-001", module: "backend", owner_role: "DEV_BACKEND" },
        { task_id: "TSK-FULL-TEST", module: "backend", owner_role: "QA" },
        { task_id: "TSK-DEVOPS-001", module: "backend", owner_role: "DEVOPS" },
        { task_id: "TSK-TRIVIAL-001", module: "backend", owner_role: "DEV_BACKEND" },
        { task_id: "TSK-INH-V1-BE-001", module: "backend", owner_role: "DEV", status: "DONE" },
        { task_id: "TSK-INH-V1-BE-002", module: "backend", owner_role: "DEV", status: "DONE", card_id: ticketId },
      ]);
      expect(r.statusCode, r.body).toBe(201);
      for (const id of ["TSK-EVO-001", "TSK-FULL-TEST", "TSK-DEVOPS-001", "TSK-TRIVIAL-001"]) expect((await cardOf(id))?.card_id, id).toBe(ticketId);
      expect((await cardOf("TSK-INH-V1-BE-001"))?.card_id).toBeNull();
      expect((await cardOf("TSK-INH-V1-BE-002"))?.card_id).toBeNull();
      // critério §1 medido: nenhuma task NÃO herdada do filho fica sem vínculo
      const orphan = (await pool.query("SELECT count(*)::int AS n FROM project_tasks WHERE project_id = $1 AND task_id NOT LIKE 'TSK-INH-%' AND card_id IS NULL", [kidId])).rows[0].n;
      expect(orphan).toBe(0);
    } finally { await flagOff(); await pool.query("DELETE FROM project_tasks WHERE project_id = $1", [kidId]); }
  });

  it("A3: flag OFF, ticket legado (sem card_state) ou card religado a OUTRO filho ⇒ nenhum card_id por padrão", async () => {
    await asCard();
    expect((await post([{ task_id: "TSK-OFF-1", module: "backend", owner_role: "DEV" }])).statusCode).toBe(201);
    expect((await cardOf("TSK-OFF-1"))?.card_id).toBeNull();                       // flag OFF
    await flagOn();
    try {
      await asLegacy();
      expect((await post([{ task_id: "TSK-LEG-1", module: "backend", owner_role: "DEV" }])).statusCode).toBe(201);
      expect((await cardOf("TSK-LEG-1"))?.card_id).toBeNull();                     // legado: invisível
      await asCard();
      await pool.query("UPDATE tickets SET child_project_id = $2 WHERE id = $1", [ticketId, s.parentId]);   // card religado a outro filho (B-3)
      expect((await post([{ task_id: "TSK-OLD-1", module: "backend", owner_role: "DEV" }])).statusCode).toBe(201);
      expect((await cardOf("TSK-OLD-1"))?.card_id).toBeNull();
      await pool.query("UPDATE tickets SET child_project_id = $2 WHERE id = $1", [ticketId, kidId]);
    } finally { await flagOff(); await pool.query("DELETE FROM project_tasks WHERE project_id = $1", [kidId]); }
  });

  it("M2: CARD_MISMATCH no meio da lista ⇒ 400 e NADA gravado (antes ficavam as tasks anteriores)", async () => {
    await asCard(); await flagOn();
    try {
      const before = await count();
      const r = await post([
        { task_id: "TSK-ATOM-1", module: "backend", owner_role: "DEV" },
        { task_id: "TSK-ATOM-2", module: "backend", owner_role: "DEV", card_id: "00000000-0000-4000-8000-000000000000" },
        { task_id: "TSK-ATOM-3", module: "backend", owner_role: "DEV" },
      ]);
      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe("CARD_MISMATCH");
      expect(await count()).toBe(before);
      expect(await cardOf("TSK-ATOM-1")).toBeUndefined();
      expect(await cardOf("TSK-ATOM-3")).toBeUndefined();
    } finally { await flagOff(); }
  });

  it("M2: erro de banco no meio do laço (CHECK de module) faz ROLLBACK de todo o lote — nenhuma task anterior fica", async () => {
    const before = await count();
    const r = await post([
      { task_id: "TSK-DB-1", module: "backend", owner_role: "DEV" },
      { task_id: "TSK-DB-2", module: "modulo_invalido", owner_role: "DEV" },
      { task_id: "TSK-DB-3", module: "backend", owner_role: "DEV" },
    ]);
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(await count()).toBe(before);
    expect(await cardOf("TSK-DB-1")).toBeUndefined();
  });
});
