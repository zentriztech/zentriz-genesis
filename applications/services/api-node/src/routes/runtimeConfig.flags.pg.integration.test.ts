/**
 * D-8 (AR) — flag de rollout gravada como 'on' na tabela não pode ficar morta em silêncio, e `GET .../resolved` mostra as flags.
 * Postgres real, banco descartável (grava linhas GLOBAIS de genesis_runtime_config). Só com PG_TEST_URL.
 */
import { it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { describePg, createScratchDb, dbClientMock, authMock, testUser, seedAcceptedProduct, buildApp, type Seed } from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { runtimeConfigRoutes } from "./runtimeConfig.js";

describePg("D-8 — flags de rollout: 'on' na tabela vale; inválido é recusado e exposto (banco descartável)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let A: Seed;

  beforeAll(async () => {
    scratch = await createScratchDb("evo_d8");
    pool = scratch.pool;
    pool.on("error", () => undefined);
    const { initDb } = await import("../db/init.js");
    await initDb();
    app = await buildApp([runtimeConfigRoutes]);
    A = await seedAcceptedProduct(pool);
  }, 120_000);
  afterAll(async () => { await app?.close(); A?.cleanup(); await scratch?.drop(); });
  afterEach(async () => {
    await pool.query("DELETE FROM genesis_runtime_config WHERE key IN ('CARDS_BANCADA','EVOLVE_CLAIM','TICKET_TRANSITIONS','EVOLVE_RECONCILER')");
  });

  const asAdmin = () => { testUser.id = A.userId; testUser.tenantId = null; testUser.role = "zentriz_admin"; };
  const setRow = (key: string, value: string, tenantId: string | null) => pool.query(
    "INSERT INTO genesis_runtime_config (key, value, tenant_id) VALUES ($1,$2,$3)", [key, value, tenantId]);
  const resolved = async () => (await app.inject({ method: "GET", url: "/api/admin/runtime-config/resolved" })).json() as
    { rolloutFlags: Record<string, { value: number; source: string; ignored?: Array<{ level: string; raw: string }> }> } & Record<string, unknown>;

  it("CARDS_BANCADA='on' gravada por fora (SQL) vale 1 e aparece em resolved.rolloutFlags (antes: ignorada, capabilities:false)", async () => {
    asAdmin();
    await setRow("CARDS_BANCADA", "on", null);
    const r = await resolved();
    expect(r.rolloutFlags.CARDS_BANCADA).toEqual({ value: 1, source: "global" });
    expect(r.CARDS_BANCADA).toBe("on");   // chave plana original preservada (consumidores existentes)
  });

  it("valor inválido na tabela: efetivo 0, e a linha morta é LISTADA em `ignored` (não só console.warn)", async () => {
    asAdmin();
    await setRow("EVOLVE_CLAIM", "banana", null);
    const r = await resolved();
    expect(r.rolloutFlags.EVOLVE_CLAIM.value).toBe(0);
    expect(r.rolloutFlags.EVOLVE_CLAIM.ignored).toEqual([expect.objectContaining({ level: "global", raw: "banana" })]);
    expect(Object.keys(r.rolloutFlags).sort()).toContain("EVOLVE_RECONCILER");
  });

  it("PUT aceita 'on'/'true' e grava o inteiro canônico; 'banana' é recusado com INVALID_FLAG_VALUE e NADA é gravado", async () => {
    asAdmin();
    const put = (key: string, value: unknown) => app.inject({ method: "PUT", url: `/api/admin/runtime-config/${key}`, payload: { value } });
    expect((await put("EVOLVE_CLAIM", "on")).statusCode).toBe(200);
    expect((await pool.query("SELECT value FROM genesis_runtime_config WHERE key='EVOLVE_CLAIM'")).rows[0].value).toBe("1");
    expect((await put("TICKET_TRANSITIONS", "true")).json().value).toBe("1");
    expect((await put("EVOLVE_RECONCILER", "shadow")).json().value).toBe("1");
    const bad = await put("EVOLVE_CLAIM", "banana");
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("INVALID_FLAG_VALUE");
    expect((await pool.query("SELECT value FROM genesis_runtime_config WHERE key='EVOLVE_CLAIM'")).rows[0].value).toBe("1");   // intacto
    expect((await put("EVOLVE_CLAIM", 2)).statusCode).toBe(400);   // bool: faixa 0..1 continua valendo
  });
});
