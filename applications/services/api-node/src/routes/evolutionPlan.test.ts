/**
 * evolutionPlan.test.ts — rotas da evolução (E2/H2/H3/H7/F4): guardas de papel/estado, job persistido,
 * republicar, RFC do modelo e estado da evolução (checkpoint do runner via volume compartilhado).
 * Padrão do harness: auth/pool mockados, Fastify inject.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "fs/promises";
import os from "os";
import path from "path";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PROJ = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const JOB = "66666666-6666-4666-8666-666666666666";

let currentUser: { id: string; role: string; tenantId: string | null; svc?: string } = { id: USER_ID, role: "user", tenantId: TENANT };
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => { (request as { user: unknown }).user = currentUser; },
}));

let project: Record<string, unknown> = { id: PROJ, tenant_id: TENANT, created_by: USER_ID, status: "spec_submitted", extra: { evolution: true } };
let queries: Array<{ sql: string; params: unknown[] }> = [];
vi.mock("../db/client.js", () => ({
  pool: {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (/FROM projects WHERE id/.test(sql)) return { rows: [project] };
      if (/UPDATE evolution_plan_jobs/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
  },
}));
vi.mock("./specs.js", () => ({ httpPost: async () => JSON.stringify({ response: "{}" }), httpGet: async () => "{}", extractSpecMarkdown: () => "" }));

const planner = {
  createPlanJob: vi.fn(async () => ({ ok: true, job: { id: JOB, projectId: PROJ, ownerUserId: USER_ID, status: "pending", createdAt: "2026-09-04T00:00:00Z" } })),
  getPlanJob: vi.fn(async (_db: unknown, id: string) => (id === JOB ? { id: JOB, projectId: PROJ, ownerUserId: USER_ID, status: "done", createdAt: "x", finishedAt: "y", result: { written: [] }, error: null } : null)),
  runEvolutionPlan: vi.fn(async () => {}),
  slugify: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
  upsertSpecFile: vi.fn(async () => "created"),
  nextRfcNumber: vi.fn(async () => 7),
};
vi.mock("../services/evolutionPlanner.js", () => planner);
vi.mock("../services/evolutionGate.js", () => ({ loadRfcTemplate: () => "# RFC-NNNN — <título>\n\n## Sumário\n", RFC_DIR: "docs/rfc" }));
const accept = { runEvolutionAcceptFlow: vi.fn(async () => { project = { ...project, extra: { ...(project.extra as object), evolution_push_pending: false } }; return true; }) };
vi.mock("../services/evolutionAccept.js", () => accept);
const merge = { tryAutoMergeEvolution: vi.fn(async (): Promise<{ state: string; sha?: string; detail?: string }> => ({ state: "merged", sha: "MERGESHA" })) };
vi.mock("../services/evolutionMerge.js", () => merge);

let app: FastifyInstance;
let filesRoot: string;
beforeEach(async () => {
  filesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "evo-state-"));
  process.env.PROJECT_FILES_ROOT = filesRoot;
  process.env.API_AGENTS_URL = "http://agents.local";
  const { evolutionPlanRoutes } = await import("./evolutionPlan.js");
  app = Fastify();
  await app.register(evolutionPlanRoutes);
  await app.ready();
  currentUser = { id: USER_ID, role: "user", tenantId: TENANT };
  project = { id: PROJ, tenant_id: TENANT, created_by: USER_ID, status: "spec_submitted", extra: { evolution: true, evolution_request: "quero pdf" } };
  queries = [];
  planner.createPlanJob.mockClear(); planner.runEvolutionPlan.mockClear(); planner.upsertSpecFile.mockClear(); accept.runEvolutionAcceptFlow.mockClear();
  merge.tryAutoMergeEvolution.mockClear(); merge.tryAutoMergeEvolution.mockResolvedValue({ state: "merged", sha: "MERGESHA" });
});

describe("POST /api/projects/:id/evolution-plan", () => {
  it("não-evolução → 409 NOT_EVOLUTION; spec bloqueada → 409 SPEC_LOCKED; runner → 403", async () => {
    project = { ...project, extra: { foo: 1 } };
    let r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution-plan`, payload: {} });
    expect(r.statusCode).toBe(409); expect(JSON.parse(r.body).code).toBe("NOT_EVOLUTION");
    project = { ...project, status: "accepted", extra: { evolution: true } };
    r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution-plan`, payload: {} });
    expect(r.statusCode).toBe(409); expect(JSON.parse(r.body).code).toBe("SPEC_LOCKED");
    project = { ...project, status: "spec_submitted" };
    currentUser = { ...currentUser, svc: "runner" };
    r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution-plan`, payload: {} });
    expect(r.statusCode).toBe(403);
  });
  it("evolução editável → 202 com jobId (persistido) e job disparado; job vivo → 409 PLAN_IN_PROGRESS", async () => {
    let r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution-plan`, payload: { request: "  novo pedido " } });
    expect(r.statusCode).toBe(202); expect(JSON.parse(r.body).jobId).toBe(JOB);
    expect(planner.createPlanJob).toHaveBeenCalledWith(expect.anything(), PROJ, USER_ID, "novo pedido");
    expect(planner.runEvolutionPlan).toHaveBeenCalled();
    planner.createPlanJob.mockResolvedValueOnce({ ok: false, code: "PLAN_IN_PROGRESS", job: { id: JOB } } as never);
    r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution-plan`, payload: {} });
    expect(r.statusCode).toBe(409); expect(JSON.parse(r.body).code).toBe("PLAN_IN_PROGRESS");
  });
  it("GET job: id inválido/outro dono → 404; dono → status", async () => {
    let r = await app.inject({ method: "GET", url: `/api/projects/${PROJ}/evolution-plan/not-a-uuid` });
    expect(r.statusCode).toBe(404);
    currentUser = { id: OTHER, role: "user", tenantId: TENANT };
    r = await app.inject({ method: "GET", url: `/api/projects/${PROJ}/evolution-plan/${JOB}` });
    expect(r.statusCode).toBe(404);
    currentUser = { id: USER_ID, role: "user", tenantId: TENANT };
    r = await app.inject({ method: "GET", url: `/api/projects/${PROJ}/evolution-plan/${JOB}` });
    expect(r.statusCode).toBe(200); expect(JSON.parse(r.body).status).toBe("done");
  });
});

describe("POST /api/projects/:id/evolution/republish (H2)", () => {
  it("não dono nem tenant_admin → 403; gestão → 403; não aceito → 409; sem pendência → 409", async () => {
    currentUser = { id: OTHER, role: "user", tenantId: TENANT };
    project = { ...project, status: "accepted", extra: { evolution: true, evolution_push_pending: true } };
    let r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution/republish` });
    expect(r.statusCode).toBe(403);
    currentUser = { id: "z", role: "zentriz_admin", tenantId: null };
    r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution/republish` });
    expect(r.statusCode).toBe(403); expect(JSON.parse(r.body).code).toBe("MANAGEMENT_ACCOUNT");
    currentUser = { id: USER_ID, role: "user", tenantId: TENANT };
    project = { ...project, status: "running" };
    r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution/republish` });
    expect(r.statusCode).toBe(409); expect(JSON.parse(r.body).code).toBe("NOT_ACCEPTED");
    project = { ...project, status: "accepted", extra: { evolution: true, evolution_push_pending: false } };
    r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution/republish` });
    expect(r.statusCode).toBe(409); expect(JSON.parse(r.body).code).toBe("NOTHING_PENDING");
    expect(accept.runEvolutionAcceptFlow).not.toHaveBeenCalled();
  });
  it("dono com pendência → executa o flow com republish:true e devolve 200 quando a flag limpa", async () => {
    project = { ...project, status: "accepted", extra: { evolution: true, evolution_push_pending: true, evolution_version: "1.1.0" } };
    const r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution/republish` });
    expect(r.statusCode).toBe(200);
    expect(accept.runEvolutionAcceptFlow).toHaveBeenCalledWith(expect.anything(), PROJ, { republish: true });
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, pending: false, version: "1.1.0" });
  });
});

describe("POST /api/projects/:id/evolution/merge (M1)", () => {
  it("guardas: runner → 403; gestão → 403; não-dono → 403; não-evolução → 409; não-aceito → 409; sem PR → 409 NO_PR", async () => {
    project = { ...project, status: "accepted", extra: { evolution: true, evolution_pr_number: 5 } };
    currentUser = { ...currentUser, svc: "runner" };
    let r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution/merge`, payload: {} });
    expect(r.statusCode).toBe(403);
    currentUser = { id: "z", role: "zentriz_admin", tenantId: null };
    r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution/merge`, payload: {} });
    expect(r.statusCode).toBe(403); expect(JSON.parse(r.body).code).toBe("MANAGEMENT_ACCOUNT");
    currentUser = { id: OTHER, role: "user", tenantId: TENANT };
    r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution/merge`, payload: {} });
    expect(r.statusCode).toBe(403);
    currentUser = { id: USER_ID, role: "user", tenantId: TENANT };
    project = { ...project, extra: { evolution: false } };
    r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution/merge`, payload: {} });
    expect(r.statusCode).toBe(409); expect(JSON.parse(r.body).code).toBe("NOT_EVOLUTION");
    project = { ...project, status: "running", extra: { evolution: true, evolution_pr_number: 5 } };
    r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution/merge`, payload: {} });
    expect(r.statusCode).toBe(409); expect(JSON.parse(r.body).code).toBe("NOT_ACCEPTED");
    project = { ...project, status: "accepted", extra: { evolution: true } };
    r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution/merge`, payload: {} });
    expect(r.statusCode).toBe(409); expect(JSON.parse(r.body).code).toBe("NO_PR");
    expect(merge.tryAutoMergeEvolution).not.toHaveBeenCalled();
  });

  it("MAJOR sem confirm → 400 CONFIRM_REQUIRED; com confirm → chama force:true + actorUserId e devolve 200", async () => {
    project = { ...project, status: "accepted", extra: { evolution: true, evolution_pr_number: 5, evolution_compat: "major" } };
    let r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution/merge`, payload: {} });
    expect(r.statusCode).toBe(400); expect(JSON.parse(r.body).code).toBe("CONFIRM_REQUIRED");
    expect(merge.tryAutoMergeEvolution).not.toHaveBeenCalled();
    r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution/merge`, payload: { confirm: "MERGE" } });
    expect(r.statusCode).toBe(200);
    expect(merge.tryAutoMergeEvolution).toHaveBeenCalledWith(expect.anything(), PROJ, { force: true, actorUserId: USER_ID });
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, state: "merged", sha: "MERGESHA" });
  });

  it("estado de risco (blocked_regressions) sem confirm → 400; minor limpo → 200 sem confirm", async () => {
    project = { ...project, status: "accepted", extra: { evolution: true, evolution_pr_number: 5, evolution_compat: "minor", evolution_merge_state: "blocked_regressions" } };
    let r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution/merge`, payload: {} });
    expect(r.statusCode).toBe(400); expect(JSON.parse(r.body).code).toBe("CONFIRM_REQUIRED");
    project = { ...project, extra: { evolution: true, evolution_pr_number: 5, evolution_compat: "minor" } };
    r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution/merge`, payload: {} });
    expect(r.statusCode).toBe(200);
  });

  it("estado não-merged → 409 com o estado", async () => {
    merge.tryAutoMergeEvolution.mockResolvedValueOnce({ state: "blocked_conflict", detail: "conflito com 'dev'" });
    project = { ...project, status: "accepted", extra: { evolution: true, evolution_pr_number: 5, evolution_compat: "minor" } };
    const r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/evolution/merge`, payload: {} });
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body)).toMatchObject({ ok: false, state: "blocked_conflict", detail: "conflito com 'dev'" });
  });
});

describe("POST /api/projects/:id/rfc-from-template (H7)", () => {
  it("não-evolução → 409; evolução editável → 201 com RFC numerado a partir do título", async () => {
    project = { ...project, extra: { foo: 1 } };
    let r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/rfc-from-template`, payload: { title: "Exportar PDF" } });
    expect(r.statusCode).toBe(409); expect(JSON.parse(r.body).code).toBe("NOT_EVOLUTION");
    project = { ...project, extra: { evolution: true } };
    r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/rfc-from-template`, payload: { title: "Exportar PDF do Extrato" } });
    expect(r.statusCode).toBe(201);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, number: 7, path: "docs/rfc/RFC-0007-exportar-pdf-do-extrato.md" });
    const [, , relPath, content, overwrite] = planner.upsertSpecFile.mock.calls[0] as unknown as [unknown, string, string, string, boolean];
    expect(relPath).toBe("docs/rfc/RFC-0007-exportar-pdf-do-extrato.md");
    expect(content).toMatch(/^# RFC-0007 — Exportar PDF do Extrato/);
    expect(overwrite).toBe(false);
    planner.upsertSpecFile.mockResolvedValueOnce("skipped" as never);
    r = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/rfc-from-template`, payload: { title: "Exportar PDF do Extrato" } });
    expect(r.statusCode).toBe(409); expect(JSON.parse(r.body).code).toBe("EXISTS");
  });
});

describe("GET /api/projects/:id/evolution-state (F4)", () => {
  it("não-evolução → 409; sem checkpoint → checkpoint:false com extra; com checkpoint → campos projetados (nunca artifacts)", async () => {
    project = { ...project, extra: { foo: 1 } };
    let r = await app.inject({ method: "GET", url: `/api/projects/${PROJ}/evolution-state` });
    expect(r.statusCode).toBe(409);
    project = { ...project, extra: { evolution: true, evolution_scope: ["apps/api/**"], evolution_compat: "minor", evolution_rfcs: ["docs/rfc/RFC-0001-x.md"], evolution_push_pending: true, evolution_version: "1.1.0" } };
    r = await app.inject({ method: "GET", url: `/api/projects/${PROJ}/evolution-state` });
    let b = JSON.parse(r.body);
    expect(r.statusCode).toBe(200); expect(b.checkpoint).toBe(false); expect(b.scope).toEqual(["apps/api/**"]); expect(b.publish.pending).toBe(true);
    // checkpoint do runner no volume compartilhado
    const dir = path.join(filesRoot, ".runner-state", PROJ); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "checkpoint.json"), JSON.stringify({
      saved_at: "2026-09-04T10:00:00Z", evolution_touched_files: ["apps/api/src/a.ts"], evolution_violations: { T1: ["FORA DO ESCOPO do RFC: apps/web/x.ts"] },
      evolution_violation_rounds: { T1: 1 }, completed_tasks: ["TSK-INH-BE-001"], evolution_baseline: { status: "no_tests", no_tests: true }, artifacts: { "apps/a.ts": "conteúdo grande" },
    }));
    r = await app.inject({ method: "GET", url: `/api/projects/${PROJ}/evolution-state` });
    b = JSON.parse(r.body);
    expect(b.checkpoint).toBe(true); expect(b.touchedFiles).toEqual(["apps/api/src/a.ts"]); expect(b.violations).toEqual({ T1: ["FORA DO ESCOPO do RFC: apps/web/x.ts"] });
    expect(b.violationRounds).toEqual({ T1: 1 }); expect(b.completedTasks).toEqual(["TSK-INH-BE-001"]); expect(b.baseline).toEqual({ status: "no_tests", no_tests: true });
    expect(JSON.stringify(b)).not.toContain("conteúdo grande");
    // checkpoint inválido (JSON parcial) → checkpoint:false sem 500
    await fs.writeFile(path.join(dir, "checkpoint.json"), "{ parcial");
    r = await app.inject({ method: "GET", url: `/api/projects/${PROJ}/evolution-state` });
    expect(r.statusCode).toBe(200); expect(JSON.parse(r.body).checkpoint).toBe(false);
  });
});
