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
