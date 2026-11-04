/**
 * AV / M-1 — o aceite NÃO promove `TSK-FULL-TEST` reprovada/não executada a `DONE`: `project_tasks.status` mantém o estado real.
 * Task ainda aberta (IN_PROGRESS) continua sendo fechada no aceite (comportamento legado). Postgres real; só roda com PG_TEST_URL.
 */
import { it, expect, beforeAll, afterAll, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { describePg, openPg, dbClientMock, authMock, seedAcceptedProduct, buildApp, type Seed } from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { projectRoutes } from "./projects.js";

describePg("M-1 (AV) — aceite preserva o estado real da TSK-FULL-TEST (Postgres real)", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let s: Seed;
  beforeAll(async () => {
    pool = await openPg();
    s = await seedAcceptedProduct(pool, { budgetUsd: 50 });
    app = await buildApp([projectRoutes]);
  }, 60_000);
  afterAll(async () => { await app?.close(); s?.cleanup(); await pool?.end(); });

  const acceptWith = async (taskStatus: string) => {
    const p = (await pool.query(
      `INSERT INTO projects (tenant_id, created_by, title, status, product_id) VALUES ($1,$2,'run','running',$3) RETURNING id`, [s.tenantId, s.userId, s.productId])).rows[0].id as string;
    await pool.query(
      `INSERT INTO project_tasks (project_id, task_id, module, owner_role, status) VALUES ($1,'TSK-FULL-TEST','backend','QA_BACKEND',$2)`, [p, taskStatus]);
    const r = await app.inject({ method: "POST", url: `/api/projects/${p}/accept`, payload: {} });
    expect(r.statusCode, r.body).toBe(200);
    expect((await pool.query("SELECT status FROM projects WHERE id = $1", [p])).rows[0].status).toBe("accepted");
    return String((await pool.query("SELECT status FROM project_tasks WHERE project_id = $1 AND task_id = 'TSK-FULL-TEST'", [p])).rows[0].status);
  };

  it.each(["QA_FAIL", "BLOCKED", "CANCELLED"])("TSK-FULL-TEST %s mantém o estado depois do aceite", async (st) => {
    expect(await acceptWith(st)).toBe(st);
  });
  it.each(["IN_PROGRESS", "NEW"])("TSK-FULL-TEST ainda aberta (%s) é fechada como DONE (legado preservado)", async (st) => {
    expect(await acceptWith(st)).toBe("DONE");
  });
  it("QA_PASS e DONE seguem intactas", async () => {
    expect(await acceptWith("QA_PASS")).toBe("QA_PASS");
    expect(await acceptWith("DONE")).toBe("DONE");
  });
});
