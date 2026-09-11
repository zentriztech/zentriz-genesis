/**
 * pipeline.promote.test.ts — POST /api/projects/:id/promote (migração 097).
 *
 * A rota ADMITE um projeto na fábrica e **NÃO INICIA NADA**: ela existe para que "promovido mas não
 * iniciado" seja verdade também no caso atômico (spec solta / App do INBOX), sem passar pelo /run.
 * O que se prova aqui: escreve `status='promoted'`, NUNCA dispara o runner, gradua o App do INBOX
 * (invariante da migração 064: projeto em fábrica não mora no INBOX) e recusa estado errado.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PROJ = "44444444-4444-4444-8444-444444444444";
const PROD = "55555555-5555-4555-8555-555555555555";

let currentUser: { id: string; role: "user" | "tenant_admin" | "zentriz_admin"; tenantId: string | null } = {
  id: "u1", role: "tenant_admin", tenantId: TENANT,
};
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    (request as { user: unknown }).user = currentUser;
  },
}));

const captured: Array<{ sql: string; params: unknown[] }> = [];
let queryHandler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number } = () => ({ rows: [] });
const fakeQuery = async (sql: string, params: unknown[] = []) => {
  captured.push({ sql, params });
  return queryHandler(sql, params);
};
vi.mock("../db/client.js", () => ({
  pool: { query: fakeQuery, connect: async () => ({ query: fakeQuery, release: () => {} }) },
}));

// O disparo do runner é o que NÃO pode acontecer — espionado para provar isso.
const dispatchSpy = vi.fn(async () => ({ dispatched: true, reason: "", projectId: PROJ }));
vi.mock("../services/runnerDispatch.js", () => ({
  dispatchProjectRun: () => dispatchSpy(),
  RUNNABLE_STATUSES: new Set(["draft", "promoted"]),
}));

const graduateSpy = vi.fn(async () => PROD);
vi.mock("../services/inbox.js", () => ({
  graduateFromInbox: () => graduateSpy(),
  demoteToInbox: async () => {},
}));

const recomputeSpy = vi.fn(async () => {});
vi.mock("../services/productLifecycle.js", () => ({
  recomputeProductLifecycle: (...a: unknown[]) => recomputeSpy(...(a as [])),
}));
const valueEventSpy = vi.fn(async () => {});
vi.mock("../services/valueEvents.js", () => ({
  emitValueEvent: (...a: unknown[]) => valueEventSpy(...(a as [])),
}));
// O gate de conteúdo lê o disco; aqui ele sempre aprova (o veto tem teste próprio).
vi.mock("../services/specContentGate.js", () => ({
  checkSpecContentReady: () => ({ ok: true }),
}));

// Trava de normalização (RFC-0008 emenda 01): o estado é controlado por teste. Por padrão a spec
// está documentada — os testes antigos provam o promote, não a trava.
let normState: { normalized: boolean; storedHash: string | null; currentHash: string | null } =
  { normalized: true, storedHash: "hash-atual", currentHash: "hash-atual" };
let normCheckThrows = false;
const normalizeSpy = vi.fn(async () => ({
  status: "normalized" as const,
  normalizedHash: "hash-novo",
  result: {
    productId: PROD, summary: "ok", anchorProjectId: PROJ,
    written: [{ projectId: PROJ, path: "docs/rfc/RFC-0001-x.md", action: "created" as const }],
    skippedProjects: [], warnings: [], truncated: [], rfcProblems: [],
    normalizedHash: "hash-novo", modelUsed: "claude-opus-5", inputTokens: 10, outputTokens: 20,
  },
}));
class FakeNormalizationError extends Error {
  usage?: { projectId: string; inputTokens: number; outputTokens: number; model: string | null };
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}
// Parâmetros DECLARADOS: sem eles o TS infere `calls` como tupla vazia e `calls[0][1]` não compila.
const debitSpy = vi.fn(async (..._args: unknown[]) => true);
vi.mock("../services/productNormalizer.js", () => ({
  isProjectNormalized: async () => {
    if (normCheckThrows) throw new Error("banco intermitente");
    return normState;
  },
  normalizeProject: (...a: unknown[]) => normalizeSpy(...(a as [])),
  debitNormalizerUsage: (...a: unknown[]) => debitSpy(...(a as [])),
  NormalizationError: FakeNormalizationError,
}));

/** Roteia as consultas do promote de projeto. */
function promoteHandler(opts: {
  status?: string; productId?: string | null; isInbox?: boolean; exists?: boolean;
} = {}) {
  const { status = "draft", productId = PROD, isInbox = false, exists = true } = opts;
  return (sql: string): { rows: unknown[]; rowCount?: number } => {
    if (sql.includes("SELECT tenant_id, created_by FROM projects")) {
      return { rows: exists ? [{ tenant_id: TENANT, created_by: "u1" }] : [] };
    }
    if (sql.includes("SELECT status, product_id, title, created_by FROM projects")) {
      return { rows: exists ? [{ status, product_id: productId, title: "Spec X", created_by: "u1" }] : [] };
    }
    if (sql.includes("FROM project_spec_files")) {
      return { rows: [{ file_path: "/nao/existe/spec.md" }] };
    }
    if (sql.includes("SELECT is_inbox FROM products")) {
      return { rows: [{ is_inbox: isInbox }] };
    }
    if (sql.includes("UPDATE projects SET status = 'promoted'")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  };
}

let app: FastifyInstance;
beforeEach(async () => {
  captured.length = 0;
  dispatchSpy.mockClear(); graduateSpy.mockClear(); recomputeSpy.mockClear(); valueEventSpy.mockClear();
  normalizeSpy.mockClear();
  debitSpy.mockClear();
  normState ={ normalized: true, storedHash: "hash-atual", currentHash: "hash-atual" };
  normCheckThrows = false;
  currentUser = { id: "u1", role: "tenant_admin", tenantId: TENANT };
  const { pipelineRoutes } = await import("./pipeline.js");
  app = Fastify();
  await app.register(pipelineRoutes);
  await app.ready();
});
afterEach(async () => { await app.close(); });

describe("POST /api/projects/:id/promote — admite na fábrica SEM iniciar", () => {
  it("rascunho com spec → 200 promoted, UPDATE para 'promoted' e ZERO disparo do runner", async () => {
    queryHandler = promoteHandler({});
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/promote` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, status: "promoted", productId: PROD, graduated: false });
    expect(captured.some((c) => c.sql.includes("UPDATE projects SET status = 'promoted'"))).toBe(true);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(recomputeSpy).toHaveBeenCalled();
  });

  it("UPDATE é condicionado a status='draft' (não atropela quem já saiu da Bancada)", async () => {
    queryHandler = promoteHandler({});
    await app.inject({ method: "POST", url: `/api/projects/${PROJ}/promote` });
    const upd = captured.find((c) => c.sql.includes("UPDATE projects SET status = 'promoted'"));
    expect(upd?.sql).toContain("AND status = 'draft'");
  });

  it("App do INBOX é GRADUADO a produto próprio na admissão (invariante da migração 064)", async () => {
    queryHandler = promoteHandler({ isInbox: true });
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/promote` });
    expect(res.statusCode).toBe(200);
    expect(graduateSpy).toHaveBeenCalledTimes(1);
    expect(res.json()).toMatchObject({ graduated: true, productId: PROD });
  });

  it("idempotente: já 'promoted' → 200 alreadyPromoted, sem novo UPDATE", async () => {
    queryHandler = promoteHandler({ status: "promoted" });
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/promote` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, status: "promoted", alreadyPromoted: true });
    expect(captured.some((c) => c.sql.includes("UPDATE projects SET status = 'promoted'"))).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("projeto já em fábrica (running) → 409 NOT_ON_WORKBENCH", async () => {
    queryHandler = promoteHandler({ status: "running" });
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/promote` });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("NOT_ON_WORKBENCH");
  });

  it("projeto sem arquivo de spec → 400 (a fábrica não recebe projeto vazio)", async () => {
    queryHandler = (sql: string) => {
      if (sql.includes("FROM project_spec_files")) return { rows: [] };
      return promoteHandler({})(sql);
    };
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/promote` });
    expect(res.statusCode).toBe(400);
    expect(captured.some((c) => c.sql.includes("UPDATE projects SET status = 'promoted'"))).toBe(false);
  });

  it("projeto inexistente → 404", async () => {
    queryHandler = promoteHandler({ exists: false });
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/promote` });
    expect(res.statusCode).toBe(404);
  });

  it("projeto de outro tenant → 404 (não revela existência)", async () => {
    currentUser = { id: "u9", role: "tenant_admin", tenantId: "99999999-9999-4999-8999-999999999999" };
    queryHandler = promoteHandler({});
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/promote` });
    expect(res.statusCode).toBe(404);
  });
});

/**
 * Trava de normalização no caminho ATÔMICO (RFC-0008 emenda 01, 2026-09-11). Este é o caminho que o
 * Jean usa de verdade ("Promover esta spec") e o único produto em `draft` em prod é o INBOX — logo,
 * sem esta trava a Fábrica continuaria recebendo spec sem documento de decisão por uma porta lateral.
 */
describe("POST /api/projects/:id/promote — trava de normalização", () => {
  it("spec nunca normalizada → 409 NOT_NORMALIZED e NENHUM UPDATE", async () => {
    normState = { normalized: false, storedHash: null, currentHash: "hash-atual" };
    queryHandler = promoteHandler({});
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/promote` });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("NOT_NORMALIZED");
    expect(res.json().message).toContain("Normalizar");
    expect(captured.some((c) => c.sql.includes("UPDATE projects SET status = 'promoted'"))).toBe(false);
    expect(graduateSpy).not.toHaveBeenCalled();
  });

  it("spec editada DEPOIS de normalizar retrava sozinha, com mensagem própria", async () => {
    normState = { normalized: false, storedHash: "hash-velho", currentHash: "hash-novo" };
    queryHandler = promoteHandler({});
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/promote` });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("mudou depois de normalizada");
    expect(res.json()).toMatchObject({ storedHash: "hash-velho", currentHash: "hash-novo" });
  });

  it("falha ao AVALIAR a trava não promove em silêncio → 500 declarado", async () => {
    normCheckThrows = true;
    queryHandler = promoteHandler({});
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/promote` });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe("NORMALIZATION_CHECK_FAILED");
    expect(captured.some((c) => c.sql.includes("UPDATE projects SET status = 'promoted'"))).toBe(false);
  });

  it("spec normalizada e em dia → promove normalmente", async () => {
    queryHandler = promoteHandler({});
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/promote` });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/projects/:id/normalize — [Normalizar] no escopo de uma spec", () => {
  function normalizeHandler(status = "draft", opts: { runInFlight?: boolean } = {}) {
    return (sql: string): { rows: unknown[]; rowCount?: number } => {
      if (sql.includes("SELECT tenant_id, created_by FROM projects")) {
        return { rows: [{ tenant_id: TENANT, created_by: "u1" }] };
      }
      if (sql.includes("product_name")) {
        return { rows: [{ id: PROJ, status, tenant_id: TENANT, product_id: PROD, title: "Spec X", product_name: "Rascunhos", system_id: null, description: null }] };
      }
      if (sql.includes("FROM pipeline_runs")) {
        return opts.runInFlight ? { rows: [{ "?column?": 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [] };
    };
  }

  it("rascunho → 200 normalized, com os documentos escritos e o modelo usado", async () => {
    queryHandler = normalizeHandler();
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/normalize` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "normalized", normalized: true, modelUsed: "claude-opus-5" });
    expect(normalizeSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * Mudança de 2026-09-11 (achado do Jean): DOCUMENTAR não depende de estar na Bancada. A regra
   * antiga (`status !== 'draft'` ⇒ 409) condenava 13 dos 15 produtos de prod a nunca ter RFC/ADR —
   * era o bug, não a trava. Quem exige `draft` é o promote, que é quem MOVE a spec.
   */
  it("spec que já saiu da Bancada AINDA pode ser documentada → 200", async () => {
    queryHandler = normalizeHandler("accepted");
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/normalize` });
    expect(res.statusCode).toBe(200);
    expect(normalizeSpy).toHaveBeenCalledTimes(1);
  });

  it("run EM VOO → 409 RUN_IN_FLIGHT, sem gastar token (não escreve debaixo do runner)", async () => {
    // O runner valida `extra.spec_hash` no meio da execução (runner.py:5791); escrever em `docs/**`
    // agora re-carimbaria o hash e ele abortaria a run com `spec_validation_failed`.
    queryHandler = normalizeHandler("running", { runInFlight: true });
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/normalize` });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("RUN_IN_FLIGHT");
    expect(normalizeSpy).not.toHaveBeenCalled();
  });

  it("recusa do normalizador vira 422 com o motivo (nada é escrito)", async () => {
    queryHandler = normalizeHandler();
    normalizeSpy.mockRejectedValueOnce(
      new FakeNormalizationError("SPEC_FILES_MISSING", "spec ausente no disco") as never,
    );
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/normalize` });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("SPEC_FILES_MISSING");
    // Recusa ANTES da chamada de LLM: não há gasto a debitar (ausente ≠ zero).
    expect(debitSpy).not.toHaveBeenCalled();
  });

  /**
   * Gasto no escopo PROJETO era invisível (família G5): só o normalize de PRODUTO debitava, e este é
   * o caminho que o Jean usa. Agora debita no sucesso E na recusa que já consumiu token.
   */
  it("sucesso debita o token gasto", async () => {
    queryHandler = normalizeHandler();
    await app.inject({ method: "POST", url: `/api/projects/${PROJ}/normalize` });
    expect(debitSpy).toHaveBeenCalledTimes(1);
    expect(debitSpy.mock.calls[0][1]).toMatchObject({
      productId: PROD, projectId: PROJ, inputTokens: 10, outputTokens: 20, model: "claude-opus-5",
    });
  });

  it("recusa DEPOIS da chamada (corte no teto de saída) também debita", async () => {
    queryHandler = normalizeHandler();
    const err = new FakeNormalizationError("NORMALIZER_BAD_RESPONSE", "cortada no teto de saída");
    err.usage = { projectId: PROJ, inputTokens: 9000, outputTokens: 32000, model: "claude-opus-5" };
    normalizeSpy.mockRejectedValueOnce(err as never);
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/normalize` });
    expect(res.statusCode).toBe(422);
    expect(debitSpy.mock.calls[0][1]).toMatchObject({ outputTokens: 32000, inputTokens: 9000 });
  });
});

/**
 * Armadilha MEDIDA em prod (2026-09-06): parar um projeto que NUNCA começou o jogava em `stopped` e
 * o produto ficava sem saída — `unpromote` recusa ("a fábrica já começou") e `promote` recusa
 * (lifecycle ≠ draft). Freio é para quem está andando.
 */
describe("POST /api/projects/:id/stop — não freia quem nunca começou", () => {
  function stopHandler(status: string) {
    return (sql: string): { rows: unknown[]; rowCount?: number } => {
      if (sql.includes("SELECT tenant_id, created_by FROM projects")) {
        return { rows: [{ tenant_id: TENANT, created_by: "u1" }] };
      }
      if (sql.includes("SELECT status FROM projects")) return { rows: [{ status }] };
      return { rows: [], rowCount: 1 };
    };
  }

  it("projeto 'promoted' → 409 NOTHING_TO_STOP e NENHUM UPDATE para 'stopped'", async () => {
    queryHandler = stopHandler("promoted");
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/stop` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "NOTHING_TO_STOP", status: "promoted" });
    expect(captured.some((c) => c.sql.includes("UPDATE projects SET status = $1"))).toBe(false);
  });

  it("rascunho → 409 (mesma razão: não há execução para parar)", async () => {
    queryHandler = stopHandler("draft");
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/stop` });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("NOTHING_TO_STOP");
  });

  it("projeto em execução → 200 e o UPDATE para 'stopped' acontece", async () => {
    queryHandler = stopHandler("running");
    const res = await app.inject({ method: "POST", url: `/api/projects/${PROJ}/stop` });
    expect(res.statusCode).toBe(200);
    const upd = captured.find((c) => c.sql.includes("UPDATE projects SET status = $1"));
    expect(upd?.params?.[0]).toBe("stopped");
  });
});
