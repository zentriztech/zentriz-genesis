/**
 * BJ A-N2 + W5 — token de MÁQUINA do run (`svc:"runner"`) em Postgres REAL. Só roda com PG_TEST_URL.
 *
 *  A-N2  `zentriz_admin` do tenant A dispara `/run` num projeto do tenant B: o token do run tem de levar o tenant e o `projectId`
 *        do PROJETO (B). Antes levava o tenant de quem disparou (A) e o Guard respondia 404 a toda chamada do runner.
 *        O `tenant_admin` de A continua recebendo o mesmo 404 ao consultar o projeto de B.
 *  W5    o token de run de um `zentriz_admin` (svc:"runner" + role zentriz_admin) NÃO cunha `cyborg-token` — nem para outro
 *        tenant/projeto, nem para renovar o próprio. O token estático e o `zentriz_admin` humano (sem `svc`) seguem cunhando.
 */
import { it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "http";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import {
  describePg, createScratchDb, dbClientMock, authMock, testUser, seedAcceptedProduct, buildApp, type Seed,
} from "../testing/evolvePg.js";

vi.mock("../db/client.js", () => dbClientMock());
vi.mock("../middleware/auth.js", () => authMock());

import { pipelineRoutes } from "./pipeline.js";
import { llmGuardInternalRoutes } from "./llmGuard.js";
import { internalLlmRoutes } from "./internalLlm.js";
import { signToken, verifyToken } from "../auth.js";
import { setGuardSetting } from "../services/llmGuard.js";

const STATIC = "x2-static-internal";

describePg("BJ A-N2 / W5 — token de run amarrado ao projeto (Postgres real)", () => {
  let scratch: Awaited<ReturnType<typeof createScratchDb>>;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let runner: http.Server;
  const received: Array<{ projectId: string; token: string }> = [];
  const seeds: Seed[] = [];
  const prevEnv = { url: process.env.RUNNER_SERVICE_URL, cmd: process.env.RUNNER_COMMAND, tok: process.env.GENESIS_API_TOKEN };

  const mkTenant = async (name: string) => {
    const s = await seedAcceptedProduct(pool, { budgetUsd: 50 });
    seeds.push(s);
    await pool.query(`INSERT INTO tenant_llm_configs (tenant_id, provider, model_id, credentials, priority, is_active)
                      VALUES ($1,'openai','gpt-4o',$2::jsonb,0,true)`, [s.tenantId, JSON.stringify({ api_key: `sk-${name}` })]);
    await pool.query("UPDATE projects SET status = 'spec_submitted' WHERE id = $1", [s.parentId]);
    return s;
  };
  const zAdmin = (s: Seed) => Object.assign(testUser, { id: `z-${s.userId}`, email: "z@t.test", role: "zentriz_admin", tenantId: s.tenantId });
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const preflight = (token: string, projectId: string) => app.inject({
    method: "POST", url: "/api/internal/llm-guard/preflight", headers: bearer(token),
    payload: { projectId, model: "gpt-4o", estInputTokens: 100, maxOutputTokens: 100, purpose: "t", source: "agents" },
  });
  const cyborg = (token: string, projectId: string) => app.inject({
    method: "POST", url: "/api/internal/cyborg-token", headers: bearer(token), payload: { projectId },
  });

  /** Dispara o /run como `zentriz_admin` do tenant `from` no projeto `target` e devolve o token entregue ao runner. */
  async function runAs(from: Seed, target: Seed) {
    zAdmin(from);
    received.length = 0;
    const res = await app.inject({ method: "POST", url: `/api/projects/${target.parentId}/run` });
    expect(res.statusCode, res.body).toBe(202);
    expect(received).toHaveLength(1);
    return received[0];
  }

  beforeAll(async () => {
    process.env.GENESIS_API_TOKEN = STATIC;
    delete process.env.RUNNER_COMMAND;
    runner = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => { received.push(JSON.parse(b)); res.writeHead(202).end("{}"); });
    });
    await new Promise<void>((r) => runner.listen(0, "127.0.0.1", r));
    process.env.RUNNER_SERVICE_URL = `http://127.0.0.1:${(runner.address() as { port: number }).port}`;
    scratch = await createScratchDb("evo_x2");
    pool = scratch.pool;
    const { initDb } = await import("../db/init.js");
    await initDb();
    await setGuardSetting(pool, "kill_switch", "off", "test");
    app = await buildApp([pipelineRoutes, llmGuardInternalRoutes, internalLlmRoutes]);
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await new Promise((r) => runner?.close(r));
    for (const x of seeds) x.cleanup();
    await scratch?.drop();
    for (const [k, v] of [["RUNNER_SERVICE_URL", prevEnv.url], ["RUNNER_COMMAND", prevEnv.cmd], ["GENESIS_API_TOKEN", prevEnv.tok]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it("A-N2: zentriz_admin do tenant A roda projeto do tenant B ⇒ token leva tenant+projeto de B e o Guard autoriza o runner", async () => {
    const A = await mkTenant("a");
    const B = await mkTenant("b");
    const { token, projectId } = await runAs(A, B);
    expect(projectId).toBe(B.parentId);
    const claims = verifyToken(token)!;
    expect(claims.svc).toBe("runner");
    expect(claims.projectId).toBe(B.parentId);
    expect(claims.tenantId).toBe(B.tenantId); // antes: A.tenantId (o de quem disparou)

    const ok = await preflight(token, B.parentId);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().code).not.toBe("PROJECT_NOT_FOUND");
    expect(ok.json(), JSON.stringify(ok.json())).toMatchObject({ allow: true });
    // O projeto do corpo é ignorado: o token de run só debita no PRÓPRIO projeto (runnerProjectOf).
    const other = await preflight(token, A.parentId);
    expect(other.json().projectId).toBe(B.parentId);
  });

  it("A-N2: o tenant_admin de A continua recebendo 404 ao consultar o projeto de B", async () => {
    const A = await mkTenant("a2");
    const B = await mkTenant("b2");
    const tenantAdminA = signToken({ sub: A.userId, email: "ta@a.test", role: "tenant_admin", tenantId: A.tenantId }, "1h");
    const res = await preflight(tenantAdminA, B.parentId);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("PROJECT_NOT_FOUND");
  });

  it("W5: o token de run de um zentriz_admin NÃO cunha cyborg-token (outro tenant, outro projeto nem o próprio)", async () => {
    const A = await mkTenant("a3");
    const B = await mkTenant("b3");
    const { token } = await runAs(A, B);
    expect(verifyToken(token)!.role).toBe("zentriz_admin");
    const crossTenant = await cyborg(token, A.parentId);
    expect(crossTenant.statusCode).toBe(403);
    expect(crossTenant.json().code).toBe("FORBIDDEN");
    const own = await cyborg(token, B.parentId); // renovar o próprio TTL também é negado
    expect(own.statusCode).toBe(403);
  });

  it("W5: caminhos legítimos seguem cunhando (token estático e zentriz_admin humano sem svc), com token escopado ao projeto", async () => {
    const B = await mkTenant("b4");
    const viaStatic = await cyborg(STATIC, B.parentId);
    expect(viaStatic.statusCode).toBe(200);
    const claims = verifyToken(viaStatic.json().token)!;
    expect(claims).toMatchObject({ svc: "runner", projectId: B.parentId, tenantId: B.tenantId });
    expect(claims.role).not.toBe("zentriz_admin");
    const human = signToken({ sub: "h1", email: "h@x.test", role: "zentriz_admin", tenantId: null }, "1h");
    expect((await cyborg(human, B.parentId)).statusCode).toBe(200);
    // O token cunhado (tenant_admin + svc) também não cunha de novo.
    expect((await cyborg(viaStatic.json().token, B.parentId)).statusCode).toBe(403);
  });
});
