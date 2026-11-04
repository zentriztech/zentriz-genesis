/**
 * D-12 (AR) — token sem `sub` não pode derrubar `POST /cards` com 500 (created_by nulo no INSERT): 401 claro, antes de tocar o banco.
 * Postgres real (PG_TEST_URL). Rotas reais, sem LLM.
 */
import { it, expect, beforeAll, afterAll, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { describePg, openPg, dbClientMock, authMock, testUser, seedAcceptedProduct, buildApp, type Seed } from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { cardRoutes } from "./cards.js";

describePg("D-12 — POST /cards com token sem sub (Postgres real)", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let s: Seed;

  beforeAll(async () => {
    pool = await openPg();
    app = await buildApp([cardRoutes]);
    s = await seedAcceptedProduct(pool, { budgetUsd: 50 });
    await pool.query("INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ('CARDS_BANCADA', '1', $1)", [s.tenantId]);
  }, 60_000);
  afterAll(async () => { await app?.close(); s?.cleanup(); await pool?.end(); });

  const create = () => app.inject({ method: "POST", url: `/api/products/${s.productId}/cards`, payload: { kind: "fix", title: "Corrige", body: "Descreve o defeito a corrigir." } });

  it("sem sub ⇒ 401 UNAUTHORIZED (antes: 500 INTERNAL) e nenhum ticket é criado", async () => {
    Object.assign(testUser, { id: undefined, email: "u@t.test", role: "tenant_admin", tenantId: s.tenantId });
    const r = await create();
    expect(r.statusCode, r.body).toBe(401);
    expect(r.json()).toMatchObject({ code: "UNAUTHORIZED" });
    expect(r.json().message).toMatch(/sub/);
    expect((await pool.query("SELECT count(*)::int n FROM tickets WHERE product_id = $1", [s.productId])).rows[0].n).toBe(0);
  });

  it("com sub (controle) ⇒ 201", async () => {
    Object.assign(testUser, { id: s.userId, email: "u@t.test", role: "tenant_admin", tenantId: s.tenantId });
    expect((await create()).statusCode).toBe(201);
  });
});
