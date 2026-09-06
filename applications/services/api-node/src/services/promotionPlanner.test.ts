import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mocka o transporte ao agente (mesmo padrão de specSemanticGate.test.ts) e o resolvedor de LLM do
// tenant — o que se prova aqui é o VETO e a ORDEM, não a chamada HTTP.
const { httpPostMock } = vi.hoisted(() => ({ httpPostMock: vi.fn() }));
vi.mock("../routes/specs.js", () => ({ httpPost: httpPostMock }));
vi.mock("./tenantLlmConfig.js", () => ({
  resolveWorkbenchLlm: vi.fn(async () => null),
  agentsLlmFields: vi.fn(() => ({})),
}));

import {
  orderIntoWaves,
  buildPromotionPlan,
  PromotionPlanError,
  type PromotionCandidate,
  type Queryable,
} from "./promotionPlanner.js";

const DB = "11111111-1111-4111-8111-111111111111";
const DAL = "22222222-2222-4222-8222-222222222222";
const API = "33333333-3333-4333-8333-333333333333";
const WEB = "44444444-4444-4444-8444-444444444444";

function cand(projectId: string, title: string, extra: Partial<PromotionCandidate> = {}): PromotionCandidate {
  return {
    projectId, title, projectType: null, status: "draft",
    files: ["spec.md"], primaryPath: `/nao/existe/${projectId}.md`, primaryHead: null, bytes: 0,
    ...extra,
  };
}

function agentItem(projectId: string, position: number, dependsOn: string[] = [], layer: string | null = null) {
  return { projectId, position, layer, dependsOn, rationale: null };
}

/** Duplo de banco: cada SQL é roteado por trecho reconhecível. */
function fakeDb(handler: (sql: string, params?: unknown[]) => { rows: Record<string, unknown>[]; rowCount?: number }): Queryable {
  return { query: async (sql: string, params?: unknown[]) => handler(sql, params) };
}

const OLD_ENV = { ...process.env };
beforeEach(() => {
  process.env.API_AGENTS_URL = "http://agents:8000";
  httpPostMock.mockReset();
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.restoreAllMocks();
});

describe("orderIntoWaves — a ORDEM (Kahn por níveis)", () => {
  it("cadeia banco → acesso a dados → backend → frontend virá 4 ondas, uma por elo", () => {
    const candidates = [cand(DB, "Banco"), cand(DAL, "Acesso a dados"), cand(API, "Backend"), cand(WEB, "Dashboard")];
    const { items, warnings } = orderIntoWaves(candidates, [
      agentItem(DB, 1, [], "banco"),
      agentItem(DAL, 2, [DB], "acesso a dados"),
      agentItem(API, 3, [DAL], "backend"),
      agentItem(WEB, 4, [API], "frontend"),
    ], []);
    expect(warnings).toEqual([]);
    expect(items.map((i) => [i.projectId, i.wave, i.position])).toEqual([
      [DB, 1, 1], [DAL, 2, 2], [API, 3, 3], [WEB, 4, 4],
    ]);
  });

  it("projetos independentes cabem na MESMA onda (paralelismo não é serializado à força)", () => {
    const candidates = [cand(DB, "Banco"), cand(API, "Backend A"), cand(WEB, "Backend B")];
    const { items } = orderIntoWaves(candidates, [
      agentItem(DB, 1, []),
      agentItem(API, 2, [DB]),
      agentItem(WEB, 3, [DB]),
    ], []);
    expect(items.find((i) => i.projectId === DB)?.wave).toBe(1);
    expect(items.find((i) => i.projectId === API)?.wave).toBe(2);
    expect(items.find((i) => i.projectId === WEB)?.wave).toBe(2);
  });

  it("FATO vence OPINIÃO: aresta do banco não declarada pelo agente muda a onda e vira warning", () => {
    const candidates = [cand(DB, "Banco"), cand(API, "Backend")];
    // O agente pediu o backend PRIMEIRO e sem dependência; o banco registra que ele depende do banco.
    const { items, warnings } = orderIntoWaves(candidates, [
      agentItem(API, 1, []),
      agentItem(DB, 2, []),
    ], [[API, DB]]);
    expect(items.find((i) => i.projectId === DB)?.wave).toBe(1);
    expect(items.find((i) => i.projectId === API)?.wave).toBe(2);
    expect(items.find((i) => i.projectId === API)?.dependsOn).toEqual([DB]);
    expect(warnings.join(" ")).toContain("aresta do banco não declarada");
  });

  it("dependência para fora do produto é ignorada COM warning (não silenciosamente)", () => {
    const candidates = [cand(DB, "Banco"), cand(API, "Backend")];
    const foreign = "99999999-9999-4999-8999-999999999999";
    const { items, warnings } = orderIntoWaves(candidates, [
      agentItem(DB, 1, []),
      agentItem(API, 2, [foreign]),
    ], []);
    expect(items.find((i) => i.projectId === API)?.dependsOn).toEqual([]);
    expect(warnings.join(" ")).toContain(foreign);
  });

  it("CICLO → PromotionPlanError DEPENDENCY_CYCLE (falha honesta, não chuta ordem)", () => {
    const candidates = [cand(DB, "A"), cand(API, "B")];
    try {
      orderIntoWaves(candidates, [agentItem(DB, 1, [API]), agentItem(API, 2, [DB])], []);
      throw new Error("deveria ter lançado");
    } catch (e) {
      expect(e).toBeInstanceOf(PromotionPlanError);
      expect((e as PromotionPlanError).code).toBe("DEPENDENCY_CYCLE");
    }
  });

  it("auto-dependência é descartada (não gera ciclo de um nó)", () => {
    const { items } = orderIntoWaves([cand(DB, "A")], [agentItem(DB, 1, [DB])], []);
    expect(items[0].wave).toBe(1);
    expect(items[0].dependsOn).toEqual([]);
  });
});

describe("buildPromotionPlan — vetos antes de gastar LLM", () => {
  /** Roteia as 3 consultas de leitura do planejador. */
  function planDb(opts: {
    projects: Array<{ id: string; title: string; status?: string; project_type?: string | null }>;
    files?: Array<{ project_id: string; filename: string }>;
    edges?: Array<[string, string]>;
  }): Queryable {
    const files = opts.files ?? opts.projects.map((p) => ({ project_id: p.id, filename: "spec.md" }));
    return fakeDb((sql) => {
      if (sql.includes("FROM projects p")) {
        return { rows: opts.projects.map((p) => ({
          id: p.id, title: p.title, status: p.status ?? "draft", project_type: p.project_type ?? null,
        })) };
      }
      if (sql.includes("FROM project_spec_files")) {
        return { rows: files.map((f) => ({
          project_id: f.project_id, filename: f.filename, rel_dir: "",
          file_path: `/nao/existe/${f.filename}`, is_primary: true,
        })) };
      }
      if (sql.includes("FROM project_triggers")) {
        return { rows: (opts.edges ?? []).map(([dep, pred]) => ({ project_id: dep, trigger_project_id: pred })) };
      }
      return { rows: [] };
    });
  }

  const ARGS = { productId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", productName: "Produto X", tenantId: "t1" };

  it("produto sem rascunho → NO_PROMOTABLE_PROJECTS e nenhuma chamada ao agente", async () => {
    await expect(buildPromotionPlan(planDb({ projects: [] }), ARGS)).rejects.toMatchObject({
      code: "NO_PROMOTABLE_PROJECTS",
    });
    expect(httpPostMock).not.toHaveBeenCalled();
  });

  it("projeto sem arquivo de spec → PROJECT_WITHOUT_SPEC (a fábrica não recebe projeto vazio)", async () => {
    const db = planDb({
      projects: [{ id: DB, title: "Banco" }, { id: API, title: "Backend" }],
      files: [{ project_id: DB, filename: "spec.md" }],
    });
    await expect(buildPromotionPlan(db, ARGS)).rejects.toMatchObject({ code: "PROJECT_WITHOUT_SPEC" });
    expect(httpPostMock).not.toHaveBeenCalled();
  });

  it("produto de UM projeto: ordem trivial SEM pagar LLM", async () => {
    const plan = await buildPromotionPlan(planDb({ projects: [{ id: DB, title: "Banco" }] }), ARGS);
    expect(httpPostMock).not.toHaveBeenCalled();
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ projectId: DB, wave: 1, position: 1 });
    expect(plan.modelUsed).toBeNull();
    expect(plan.inputTokens).toBe(0);
  });

  it("sem API_AGENTS_URL com 2+ projetos → AGENTS_UNAVAILABLE (sem fallback burro por heurística)", async () => {
    delete process.env.API_AGENTS_URL;
    const db = planDb({ projects: [{ id: DB, title: "Banco" }, { id: API, title: "Backend" }] });
    await expect(buildPromotionPlan(db, ARGS)).rejects.toMatchObject({ code: "AGENTS_UNAVAILABLE" });
  });

  it("agente fora do ar (httpPost lança) → AGENTS_UNAVAILABLE", async () => {
    httpPostMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const db = planDb({ projects: [{ id: DB, title: "Banco" }, { id: API, title: "Backend" }] });
    await expect(buildPromotionPlan(db, ARGS)).rejects.toMatchObject({ code: "AGENTS_UNAVAILABLE" });
  });

  it("resposta cortada no teto (truncated) → PLANNER_BAD_RESPONSE", async () => {
    httpPostMock.mockResolvedValueOnce(JSON.stringify({ response: '{"order":[]}', truncated: true }));
    const db = planDb({ projects: [{ id: DB, title: "Banco" }, { id: API, title: "Backend" }] });
    await expect(buildPromotionPlan(db, ARGS)).rejects.toMatchObject({ code: "PLANNER_BAD_RESPONSE" });
  });

  it("JSON ilegível → PLANNER_BAD_RESPONSE", async () => {
    httpPostMock.mockResolvedValueOnce(JSON.stringify({ response: "não sei ordenar isso" }));
    const db = planDb({ projects: [{ id: DB, title: "Banco" }, { id: API, title: "Backend" }] });
    await expect(buildPromotionPlan(db, ARGS)).rejects.toMatchObject({ code: "PLANNER_BAD_RESPONSE" });
  });

  it("projeto de fora do produto na ordem → PLANNER_UNKNOWN_PROJECT", async () => {
    httpPostMock.mockResolvedValueOnce(JSON.stringify({
      response: JSON.stringify({ order: [{ project_id: DB, position: 1 }, { project_id: WEB, position: 2 }] }),
    }));
    const db = planDb({ projects: [{ id: DB, title: "Banco" }, { id: API, title: "Backend" }] });
    await expect(buildPromotionPlan(db, ARGS)).rejects.toMatchObject({ code: "PLANNER_UNKNOWN_PROJECT" });
  });

  it("projeto repetido na ordem → PLANNER_BAD_RESPONSE", async () => {
    httpPostMock.mockResolvedValueOnce(JSON.stringify({
      response: JSON.stringify({ order: [{ project_id: DB, position: 1 }, { project_id: DB, position: 2 }] }),
    }));
    const db = planDb({ projects: [{ id: DB, title: "Banco" }, { id: API, title: "Backend" }] });
    await expect(buildPromotionPlan(db, ARGS)).rejects.toMatchObject({ code: "PLANNER_BAD_RESPONSE" });
  });

  it("projeto deixado FORA da ordem → PLANNER_INCOMPLETE_ORDER (nada é promovido pela metade)", async () => {
    httpPostMock.mockResolvedValueOnce(JSON.stringify({
      response: JSON.stringify({ order: [{ project_id: DB, position: 1 }] }),
    }));
    const db = planDb({ projects: [{ id: DB, title: "Banco" }, { id: API, title: "Backend" }] });
    await expect(buildPromotionPlan(db, ARGS)).rejects.toMatchObject({ code: "PLANNER_INCOMPLETE_ORDER" });
  });

  it("caminho felizes: ordem do agente + fato do banco → ondas, notes, usage e edgesSource=triggers", async () => {
    httpPostMock.mockResolvedValueOnce(JSON.stringify({
      response: "```json\n" + JSON.stringify({
        order: [
          { project_id: DB, position: 1, wave: 1, layer: "banco", depends_on: [], rationale: "migrações primeiro" },
          { project_id: API, position: 2, wave: 2, layer: "backend", depends_on: [DB] },
          { project_id: WEB, position: 3, wave: 3, layer: "frontend", depends_on: [API] },
        ],
        notes: "produto de três camadas",
      }) + "\n```",
      model_used: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      usage: { input_tokens: 1200, output_tokens: 340 },
    }));
    const db = planDb({
      projects: [{ id: DB, title: "Banco" }, { id: API, title: "Backend" }, { id: WEB, title: "Dashboard" }],
      edges: [[WEB, DB]],   // fato: o dashboard também depende do banco
    });
    const plan = await buildPromotionPlan(db, ARGS);
    expect(plan.items.map((i) => i.projectId)).toEqual([DB, API, WEB]);
    expect(plan.items.map((i) => i.wave)).toEqual([1, 2, 3]);
    expect(plan.items[2].dependsOn.sort()).toEqual([API, DB].sort());
    expect(plan.notes).toBe("produto de três camadas");
    expect(plan.edgesSource).toBe("triggers");
    expect(plan.modelUsed).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(plan.inputTokens).toBe(1200);
    expect(plan.outputTokens).toBe(340);
    expect(plan.warnings.join(" ")).toContain("aresta do banco não declarada");
  });

  it("sem aresta no banco → edgesSource=agent (a ordem saiu só do arquiteto)", async () => {
    httpPostMock.mockResolvedValueOnce(JSON.stringify({
      response: JSON.stringify({
        order: [{ project_id: DB, position: 1, depends_on: [] }, { project_id: API, position: 2, depends_on: [DB] }],
      }),
    }));
    const db = planDb({ projects: [{ id: DB, title: "Banco" }, { id: API, title: "Backend" }] });
    const plan = await buildPromotionPlan(db, ARGS);
    expect(plan.edgesSource).toBe("agent");
    expect(plan.warnings).toEqual([]);
  });

  it("teto de projetos → TOO_MANY_PROJECTS antes de qualquer leitura de spec", async () => {
    const many = Array.from({ length: 61 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, title: `P${i}`,
    }));
    await expect(buildPromotionPlan(planDb({ projects: many }), ARGS)).rejects.toMatchObject({
      code: "TOO_MANY_PROJECTS",
    });
    expect(httpPostMock).not.toHaveBeenCalled();
  });
});
