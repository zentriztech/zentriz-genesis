/**
 * skills.feedback.test.ts — rotas de skills sob a flag SKILL_FEEDBACK (plano 1.1/1.2).
 * O ponto central: com a flag OFF o comportamento é byte-idêntico ao legado (mesmas queries, mesmos
 * parâmetros, mesma resposta). shadow/on usam o motor novo.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "crypto";

const P = "11111111-1111-4111-8111-111111111111";
const SK = "22222222-2222-4222-8222-222222222222";

vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    (request as { user: unknown }).user = { id: "u1", role: "zentriz_admin", tenantId: null };
  },
}));

const h = vi.hoisted(() => {
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const state = { handler: ((_sql: string, _params: unknown[]) => ({ rows: [] as unknown[] })) as (sql: string, params: unknown[]) => { rows: unknown[] } };
  const fakeQuery = async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    return state.handler(sql, params);
  };
  return { captured, state, fakeQuery };
});
const captured = h.captured;
const fakeQuery = h.fakeQuery;
vi.mock("../db/client.js", () => ({
  pool: { query: h.fakeQuery, connect: async () => ({ query: h.fakeQuery, release: () => {} }) },
}));

import { skillsRoutes } from "./skills.js";

let app: FastifyInstance;
const saved = process.env.SKILL_FEEDBACK;
beforeEach(async () => {
  captured.length = 0;
  h.state.handler = () => ({ rows: [] });
  delete process.env.SKILL_FEEDBACK;
  app = Fastify();
  await app.register(skillsRoutes);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  if (saved === undefined) delete process.env.SKILL_FEEDBACK; else process.env.SKILL_FEEDBACK = saved;
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// SQL do caminho LEGADO, copiado verbatim da versão anterior à tarefa 1.1.
const LEGACY_INSERT = `INSERT INTO skill_feedback
         (skill_id, bundle_id, task_id, project_id, signal, weight, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`;
const LEGACY_SCORE = `UPDATE skill
       SET quality_score = GREATEST(0, LEAST(1,
             quality_score * 0.95 + ($1::numeric * 0.05 + 0.5) * 0.05
           )),
           updated_at = NOW()
       WHERE id = $2`;
const LEGACY_PROMOTE = `UPDATE skill
       SET status = 'trusted', updated_at = NOW()
       WHERE id = $1
         AND status = 'shadow'
         AND quality_score >= 0.7
         AND use_count >= 5`;
const LEGACY_DEPRECATE = `UPDATE skill
       SET status = 'deprecated', updated_at = NOW()
       WHERE id = $1
         AND hard_rule = FALSE
         AND status = 'trusted'
         AND quality_score < 0.3
         AND use_count >= 10`;
const LEGACY_USE_COUNT = `UPDATE skill
           SET use_count = use_count + 1, last_used_at = NOW()
           WHERE id = ANY($1::uuid[])`;

describe("flag OFF (padrão) — byte-idêntico ao legado", () => {
  it("POST /feedback legado: mesmas 4 queries, mesmos params, mesma resposta", async () => {
    const res = await app.inject({ method: "POST", url: "/api/skills/feedback",
      payload: { skill_id: SK, task_id: "T1", project_id: P, signal: "qa_pass" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });
    expect(captured.map((c) => c.sql)).toEqual([LEGACY_INSERT, LEGACY_SCORE, LEGACY_PROMOTE, LEGACY_DEPRECATE]);
    expect(captured.map((c) => c.params)).toEqual([
      [SK, null, "T1", P, "qa_pass", 0, null], [0.5, SK], [SK], [SK],
    ]);
    // hash do conjunto exato de SQL (qualquer byte alterado no caminho legado quebra aqui)
    expect(sha(captured.map((c) => c.sql).join("\n---\n"))).toBe(
      sha([LEGACY_INSERT, LEGACY_SCORE, LEGACY_PROMOTE, LEGACY_DEPRECATE].join("\n---\n")));
  });

  it("POST /feedback legado com signal inválido: 400 como antes", async () => {
    const res = await app.inject({ method: "POST", url: "/api/skills/feedback", payload: { skill_id: SK, signal: "oracle_pass" } });
    expect(res.statusCode).toBe(400); // sinal novo não existe no caminho legado
    expect(captured).toHaveLength(0);
  });

  it("chamada nova (v=2) com flag off: 202 skipped, nenhuma query", async () => {
    const res = await app.inject({ method: "POST", url: "/api/skills/feedback", payload: { v: 2, project_id: P, task_id: "T1", signal: "qa_pass" } });
    expect(res.statusCode).toBe(202);
    expect(res.json().skipped).toBe("SKILL_FEEDBACK=off");
    expect(captured).toHaveLength(0);
  });

  it("lesson-injections com flag off: 202 skipped, nenhuma query", async () => {
    const res = await app.inject({ method: "POST", url: "/api/skills/lesson-injections", payload: { project_id: P, task_id: "T1", slugs: ["a"] } });
    expect(res.statusCode).toBe(202);
    expect(captured).toHaveLength(0);
  });

  it("assemble com off e shadow: use_count continua contando a montagem (SQL legado)", async () => {
    for (const mode of [undefined, "shadow"]) {
      captured.length = 0;
      if (mode) process.env.SKILL_FEEDBACK = mode; else delete process.env.SKILL_FEEDBACK;
      h.state.handler = (sql) => (sql.includes("hard_rule = TRUE") ? { rows: [{ id: SK, slug: "s", body_md: "b", title: "t" }] } : { rows: [] });
      const res = await app.inject({ method: "GET", url: `/api/skills/assemble?role=dev&stack_key=generic&project_id=${P}&task_id=T1` });
      expect(res.statusCode).toBe(200);
      const upd = captured.find((c) => c.sql.startsWith("UPDATE skill") && c.sql.includes("last_used_at"));
      expect(upd!.sql).toBe(LEGACY_USE_COUNT);
    }
  });
});

describe("flag ON — use_count não conta a montagem do prompt (ADR-020 §2)", () => {
  it("assemble só atualiza last_used_at", async () => {
    process.env.SKILL_FEEDBACK = "on";
    h.state.handler = (sql) => (sql.includes("hard_rule = TRUE") ? { rows: [{ id: SK, slug: "s", body_md: "b", title: "t" }] } : { rows: [] });
    await app.inject({ method: "GET", url: `/api/skills/assemble?role=dev&stack_key=generic&project_id=${P}&task_id=T1` });
    const upd = captured.find((c) => c.sql.startsWith("UPDATE skill") && c.sql.includes("last_used_at"));
    expect(upd!.sql).not.toContain("use_count");
  });
});

describe("flag ON — motor novo via rota", () => {
  it("feedback v2 por skill é idempotente (2ª chamada → 200 duplicate, sem UPDATE)", async () => {
    process.env.SKILL_FEEDBACK = "on";
    let inserts = 0;
    h.state.handler = (sql) => {
      if (sql.includes("FOR UPDATE")) return { rows: [{ id: SK, quality_score: "0.800", status: "shadow", hard_rule: false }] };
      if (sql.includes("INSERT INTO skill_feedback")) { inserts++; return { rows: inserts === 1 ? [{ id: "f1" }] : [] }; }
      if (sql.includes("COUNT(*)")) return { rows: [{ positive: 1, negative: 0 }] };
      return { rows: [] };
    };
    const body = { v: 2, project_id: P, task_id: "T1", skill_id: SK, signal: "oracle_pass" };
    const r1 = await app.inject({ method: "POST", url: "/api/skills/feedback", payload: body });
    expect(r1.statusCode).toBe(201);
    const updates1 = captured.filter((c) => /UPDATE skill SET/.test(c.sql)).length;
    expect(updates1).toBe(1);
    captured.length = 0;
    const r2 = await app.inject({ method: "POST", url: "/api/skills/feedback", payload: body });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().duplicate).toBe(true);
    expect(captured.filter((c) => /UPDATE skill SET/.test(c.sql))).toHaveLength(0);
    expect(captured.some((c) => c.sql === "COMMIT")).toBe(true);
  });

  it("qa_pass v2 não gera UPDATE de status nem use_count", async () => {
    process.env.SKILL_FEEDBACK = "on";
    h.state.handler = (sql) => {
      if (sql.includes("FOR UPDATE")) return { rows: [{ id: SK, quality_score: "1.000", status: "shadow", hard_rule: false }] };
      if (sql.includes("INSERT INTO skill_feedback")) return { rows: [{ id: "f1" }] };
      return { rows: [] };
    };
    const res = await app.inject({ method: "POST", url: "/api/skills/feedback", payload: { v: 2, project_id: P, task_id: "T1", skill_id: SK, signal: "qa_pass" } });
    expect(res.statusCode).toBe(201);
    expect(captured.some((c) => /SET status/.test(c.sql))).toBe(false);
    const upd = captured.find((c) => /UPDATE skill SET quality_score/.test(c.sql))!;
    expect(upd.params[1]).toBe(0); // incUse = 0
  });

  it("validações: sinal inválido, project_id não-uuid, skill_id sem task_id → 400", async () => {
    process.env.SKILL_FEEDBACK = "shadow";
    const bad = [
      { v: 2, project_id: P, signal: "xx" },
      { v: 2, project_id: "nao-uuid", signal: "qa_pass" },
      { v: 2, project_id: P, skill_id: SK, signal: "qa_pass" },
    ];
    for (const b of bad) {
      const r = await app.inject({ method: "POST", url: "/api/skills/feedback", payload: b });
      expect(r.statusCode).toBe(400);
    }
  });

  it("lesson-injections registra com ON CONFLICT DO NOTHING (idempotente)", async () => {
    process.env.SKILL_FEEDBACK = "on";
    const res = await app.inject({ method: "POST", url: "/api/skills/lesson-injections", payload: { project_id: P, task_id: "T1", slugs: ["a", "a", "b"] } });
    expect(res.statusCode).toBe(201);
    expect(res.json().recorded).toBe(2);
    expect(captured.every((c) => c.sql.includes("ON CONFLICT DO NOTHING"))).toBe(true);
  });
});
