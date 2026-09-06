/**
 * specGapScope.test.ts — PR-4 (F2): escopo de GAPs por arquivo.
 *
 * O que estes testes protegem (e por quê):
 *  - TRANSPORTE nunca "escolhe o primeiro" quando há ambiguidade — isso seria julgamento por código,
 *    o que a lei 100% LLM proíbe (feedback-genesis-100-llm-nunca-automacao-fixa).
 *  - A árvore é a verdade: rota persistida apontando para arquivo que não existe mais é IGNORADA.
 *  - Falha do roteador (rede, JSON inválido, path inventado) NÃO inventa rota: o GAP fica `unrouted`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EnrichedFinding } from "./findingTriage.js";

const httpPost = vi.fn<(url: string, body: string, timeoutMs: number) => Promise<string>>();
vi.mock("../routes/specs.js", () => ({ httpPost: (...a: [string, string, number]) => httpPost(...a) }));
vi.mock("fs/promises", () => ({ readFile: vi.fn(async () => Buffer.from("# Título\n## Seção\n")) }));

const projectFindingsState = vi.fn();
vi.mock("./findingTriage.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./findingTriage.js")>();
  return { ...real, projectFindingsState: (...a: unknown[]) => projectFindingsState(...a) };
});

const {
  resolveFindingPath, groupActiveFindings, buckets, gapQueue, toWire,
  loadSpecFiles, gapScopeForProject, routeUnroutedFindings, ensureGapScope,
} = await import("./specGapScope.js");
type SpecFileRef = Awaited<ReturnType<typeof loadSpecFiles>>[number];

const ref = (path: string, isPrimary = false): SpecFileRef => {
  const idx = path.lastIndexOf("/");
  const relDir = idx === -1 ? "" : path.slice(0, idx);
  const filename = idx === -1 ? path : path.slice(idx + 1);
  return { path, filename, relDir, filePath: `/shared/uploads/p/${path}`, isPrimary };
};

let fpSeq = 0;
const F = (o: Partial<EnrichedFinding> = {}): EnrichedFinding => ({
  file: "", line: null, severity: "warning", title: `t${++fpSeq}`, rationale: "", source: "stage_b",
  category: "other", anchor: null, fingerprint: `fp${fpSeq}`, triageable: true, triage: null, ...o,
});

// ── Transporte ────────────────────────────────────────────────────────────────

describe("resolveFindingPath — casar o que o LLM escreveu com a árvore real", () => {
  const paths = ["00-indice.md", "backend/01-api.md", "frontend/01-web.md"];

  it("resolve exato, com ruído de prefixo/marcador, e por basename único", () => {
    expect(resolveFindingPath("backend/01-api.md", paths)).toBe("backend/01-api.md");
    expect(resolveFindingPath("./backend/01-api.md", paths)).toBe("backend/01-api.md");
    expect(resolveFindingPath("/docs/spec/backend/01-api.md", paths)).toBe("backend/01-api.md");
    expect(resolveFindingPath("===== backend/01-api.md =====", paths)).toBe("backend/01-api.md");
    expect(resolveFindingPath("backend\\01-api.md", paths)).toBe("backend/01-api.md");
    expect(resolveFindingPath("BACKEND/01-API.MD", paths)).toBe("backend/01-api.md");
    expect(resolveFindingPath("00-INDICE.md", paths)).toBe("00-indice.md");
  });

  it("basename ambíguo (mesmo nome em 2 pastas) devolve null — a decisão volta para o agente", () => {
    expect(resolveFindingPath("01-api.md", paths)).toBe("backend/01-api.md");
    expect(resolveFindingPath("01-web.md", paths)).toBe("frontend/01-web.md");
    // dois arquivos com o MESMO basename: nada de "escolhe o primeiro"
    const dup = ["backend/01-api.md", "frontend/01-api.md"];
    expect(resolveFindingPath("01-api.md", dup)).toBeNull();
  });

  it("vazio, árvore vazia e path inexistente devolvem null", () => {
    expect(resolveFindingPath("", paths)).toBeNull();
    expect(resolveFindingPath(null, paths)).toBeNull();
    expect(resolveFindingPath(undefined, paths)).toBeNull();
    expect(resolveFindingPath("backend/01-api.md", [])).toBeNull();
    expect(resolveFindingPath("nao-existe.md", paths)).toBeNull();
  });

  it("sufixo único resolve nos dois sentidos (modelo escreveu mais ou menos caminho do que a árvore tem)", () => {
    expect(resolveFindingPath("spec/backend/01-api.md", paths)).toBe("backend/01-api.md");
    expect(resolveFindingPath("01-web.md", ["produto/frontend/01-web.md"])).toBe("produto/frontend/01-web.md");
  });
});

// ── Agrupamento ───────────────────────────────────────────────────────────────

describe("groupActiveFindings", () => {
  const files = [ref("00-indice.md", true), ref("backend/01-api.md"), ref("frontend/01-web.md")];

  it("usa o `file` do validador, ignora findings com triagem e conta o total ativo", () => {
    const a = F({ file: "backend/01-api.md", severity: "blocker" });
    const b = F({ file: "frontend/01-web.md" });
    const ignored = F({
      file: "backend/01-api.md",
      triage: { id: "t", state: "ignored", reasonCode: "accepted_risk", reason: "", actorRole: "user", createdAt: "", expiresAt: null, inherited: false, recurrenceCount: 0, severityChanged: false },
    });
    const g = groupActiveFindings(files, [a, b, ignored]);
    expect(g.totalActive).toBe(2);
    expect(g.byPath.get("backend/01-api.md")).toEqual([a]);
    expect(g.byPath.get("frontend/01-web.md")).toEqual([b]);
    expect(g.unrouted).toEqual([]);
    expect(g.routesUsed).toEqual({});
  });

  it("global do Stage A (file vazio) fica unrouted; com rota persistida vai para o arquivo e aparece em routesUsed", () => {
    const global = F({ file: "", source: "stage_a", severity: "blocker" });
    expect(groupActiveFindings(files, [global]).unrouted).toEqual([global]);

    const g = groupActiveFindings(files, [global], { [global.fingerprint]: "backend/01-api.md" });
    expect(g.byPath.get("backend/01-api.md")).toEqual([global]);
    expect(g.unrouted).toEqual([]);
    expect(g.routesUsed).toEqual({ [global.fingerprint]: "backend/01-api.md" });
  });

  it("rota obsoleta (arquivo saiu da árvore) é ignorada — a verdade é a árvore, não a rota gravada", () => {
    const global = F({ file: "" });
    const g = groupActiveFindings(files, [global], { [global.fingerprint]: "backend/99-removido.md" });
    expect(g.unrouted).toEqual([global]);
    expect(g.routesUsed).toEqual({});
  });

  it("árvore de UM arquivo: todo GAP é daquele arquivo, sem gastar roteador", () => {
    const one = [ref("PRODUCT_SPEC.md", true)];
    const g = groupActiveFindings(one, [F({ file: "" }), F({ file: "arquivo-que-nao-existe.md" })]);
    expect(g.byPath.get("PRODUCT_SPEC.md")).toHaveLength(2);
    expect(g.unrouted).toEqual([]);
  });

  it("`file` do validador vence a rota persistida (rota é só para o que sobrou)", () => {
    const f = F({ file: "frontend/01-web.md" });
    const g = groupActiveFindings(files, [f], { [f.fingerprint]: "backend/01-api.md" });
    expect(g.byPath.get("frontend/01-web.md")).toEqual([f]);
    expect(g.routesUsed).toEqual({});
  });
});

describe("buckets / gapQueue / toWire", () => {
  const files = [ref("00-indice.md", true), ref("backend/01-api.md"), ref("frontend/01-web.md")];

  it("conta severidades e roteados por arquivo; fila prioriza blockers, depois volume, depois path", () => {
    const routed = F({ file: "" });
    const findings = [
      F({ file: "backend/01-api.md", severity: "blocker" }),
      F({ file: "backend/01-api.md", severity: "warning" }),
      F({ file: "frontend/01-web.md", severity: "warning" }),
      F({ file: "frontend/01-web.md", severity: "info" }),
      F({ file: "frontend/01-web.md", severity: "warning" }),
      routed,
    ];
    const grouped = groupActiveFindings(files, findings, { [routed.fingerprint]: "00-indice.md" });
    const groups = { latestRunId: "run1", files, ...grouped };
    const list = buckets(groups);

    expect(list.find((b) => b.path === "backend/01-api.md")).toMatchObject({ active: 2, blockers: 1, warnings: 1, routed: 0, isPrimary: false });
    expect(list.find((b) => b.path === "frontend/01-web.md")).toMatchObject({ active: 3, blockers: 0, warnings: 2, routed: 0 });
    expect(list.find((b) => b.path === "00-indice.md")).toMatchObject({ active: 1, routed: 1, isPrimary: true });

    // blocker primeiro, depois o arquivo com mais GAPs
    expect(gapQueue(list)).toEqual(["backend/01-api.md", "frontend/01-web.md", "00-indice.md"]);
    // arquivo sem GAP ativo não entra na fila
    expect(gapQueue([{ path: "vazio.md", isPrimary: false, active: 0, blockers: 0, warnings: 0, routed: 0 }])).toEqual([]);

    const wire = toWire(groups);
    expect(wire).toMatchObject({ latestRunId: "run1", fileCount: 3, totalActive: 6, unrouted: 0 });
    expect(wire.queue[0]).toBe("backend/01-api.md");
  });

  it("empate de blockers e de volume desempata por path (fila determinística para o laço autônomo)", () => {
    const list = [
      { path: "b.md", isPrimary: false, active: 2, blockers: 1, warnings: 1, routed: 0 },
      { path: "a.md", isPrimary: false, active: 2, blockers: 1, warnings: 1, routed: 0 },
    ];
    expect(gapQueue(list)).toEqual(["a.md", "b.md"]);
  });
});

// ── Leitura do banco + roteador ───────────────────────────────────────────────

const fakeDb = (files: Array<{ filename: string; rel_dir: string | null; is_primary: boolean }>, routes: Record<string, string> | null = null) => {
  const updates: Array<{ text: string; values: unknown[] }> = [];
  const db = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("FROM project_spec_files")) {
        return { rows: files.map((f) => ({ ...f, file_path: `/shared/uploads/p/${f.rel_dir ? `${f.rel_dir}/` : ""}${f.filename}` })) as unknown as Record<string, unknown>[] };
      }
      if (text.includes("SELECT finding_routes")) return { rows: routes ? [{ finding_routes: routes }] : [{}] };
      if (text.includes("UPDATE spec_validation_runs")) { updates.push({ text, values: values ?? [] }); return { rows: [] }; }
      return { rows: [] };
    }),
  };
  return { db, updates };
};

const rawOk = (routes: Array<{ id: string; file: string }>, model = "us.anthropic.claude-haiku-4-5-20251001-v1:0") =>
  JSON.stringify({ response: JSON.stringify({ routes }), model_used: model, usage: { input_tokens: 10, output_tokens: 5 } });

describe("loadSpecFiles / gapScopeForProject", () => {
  beforeEach(() => { projectFindingsState.mockReset(); httpPost.mockReset(); });

  it("monta o path canônico (rel_dir + filename) e limpa barras", async () => {
    const { db } = fakeDb([
      { filename: "00-indice.md", rel_dir: null, is_primary: true },
      { filename: "01-api.md", rel_dir: "/backend/", is_primary: false },
    ]);
    const files = await loadSpecFiles(db, "p1");
    expect(files.map((f) => f.path)).toEqual(["00-indice.md", "backend/01-api.md"]);
    expect(files[0].isPrimary).toBe(true);
    expect(files[1].relDir).toBe("backend");
  });

  it("gapScopeForProject passa a árvore atual para a triagem e aplica as rotas gravadas", async () => {
    const global = F({ file: "" });
    projectFindingsState.mockResolvedValue({ latestRunId: "run9", findings: [global], resolved: [], counts: {} });
    const { db } = fakeDb(
      [{ filename: "00-indice.md", rel_dir: null, is_primary: true }, { filename: "01-api.md", rel_dir: "backend", is_primary: false }],
      { [global.fingerprint]: "backend/01-api.md" },
    );
    const scope = await gapScopeForProject(db, "p1");
    expect(projectFindingsState).toHaveBeenCalledWith(db, "p1", { currentFiles: ["00-indice.md", "backend/01-api.md"] });
    expect(scope.latestRunId).toBe("run9");
    expect(scope.byPath.get("backend/01-api.md")).toEqual([global]);
    expect(scope.unrouted).toEqual([]);
  });

  it("coluna finding_routes ausente (migração 094 não aplicada) não derruba a Bancada", async () => {
    projectFindingsState.mockResolvedValue({ latestRunId: "run9", findings: [F({ file: "" })], resolved: [], counts: {} });
    const { db } = fakeDb([{ filename: "a.md", rel_dir: null, is_primary: true }, { filename: "b.md", rel_dir: null, is_primary: false }]);
    db.query.mockImplementation(async (text: string) => {
      if (text.includes("FROM project_spec_files")) {
        return { rows: [
          { filename: "a.md", rel_dir: null, is_primary: true, file_path: "/x/a.md" },
          { filename: "b.md", rel_dir: null, is_primary: false, file_path: "/x/b.md" },
        ] as unknown as Record<string, unknown>[] };
      }
      if (text.includes("SELECT finding_routes")) throw new Error('column "finding_routes" does not exist');
      return { rows: [] };
    });
    const scope = await gapScopeForProject(db, "p1");
    expect(scope.unrouted).toHaveLength(1);
  });
});

describe("routeUnroutedFindings — o roteador é LLM e não tem fallback burro", () => {
  const OLD = process.env.API_AGENTS_URL;
  beforeEach(() => { projectFindingsState.mockReset(); httpPost.mockReset(); process.env.API_AGENTS_URL = "http://agents:8000"; });
  afterEach(() => { if (OLD === undefined) delete process.env.API_AGENTS_URL; else process.env.API_AGENTS_URL = OLD; });

  const twoFiles = [
    { filename: "00-indice.md", rel_dir: null, is_primary: true },
    { filename: "01-api.md", rel_dir: "backend", is_primary: false },
  ];

  it("sem API_AGENTS_URL: skip, sem chamada e sem rota", async () => {
    delete process.env.API_AGENTS_URL;
    const { db } = fakeDb(twoFiles);
    const r = await routeUnroutedFindings(db, "p1");
    expect(r).toMatchObject({ skipped: true, routed: 0 });
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("sem run de validação, com 1 arquivo só, ou sem nada a rotear: não gasta LLM", async () => {
    projectFindingsState.mockResolvedValue({ latestRunId: null, findings: [F({ file: "" })], resolved: [], counts: {} });
    expect(await routeUnroutedFindings(fakeDb(twoFiles).db, "p1")).toMatchObject({ skipped: true, reason: "sem run de validação" });

    projectFindingsState.mockResolvedValue({ latestRunId: "r1", findings: [F({ file: "" })], resolved: [], counts: {} });
    expect(await routeUnroutedFindings(fakeDb([twoFiles[0]]).db, "p1")).toMatchObject({ skipped: true, reason: "árvore com 1 arquivo" });

    projectFindingsState.mockResolvedValue({ latestRunId: "r1", findings: [F({ file: "backend/01-api.md" })], resolved: [], counts: {} });
    expect(await routeUnroutedFindings(fakeDb(twoFiles).db, "p1")).toMatchObject({ skipped: true, reason: "nada a rotear" });
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("caminho felizJSON do agente vira rota persistida (fingerprint → path)", async () => {
    const g1 = F({ file: "" });
    const g2 = F({ file: "" });
    projectFindingsState.mockResolvedValue({ latestRunId: "r1", findings: [g1, g2], resolved: [], counts: {} });
    const { db, updates } = fakeDb(twoFiles);
    httpPost.mockResolvedValue(rawOk([{ id: "g1", file: "backend/01-api.md" }, { id: "g2", file: "00-indice.md" }]));

    const r = await routeUnroutedFindings(db, "p1");
    expect(r).toMatchObject({ routed: 2, stillUnrouted: 0, skipped: false, model: "us.anthropic.claude-haiku-4-5-20251001-v1:0" });
    expect(updates).toHaveLength(1);
    expect(JSON.parse(String(updates[0].values[1]))).toEqual({
      [g1.fingerprint]: "backend/01-api.md",
      [g2.fingerprint]: "00-indice.md",
    });
    // o prompt leva a lista de arquivos e marca o conteúdo como dado não-confiável (anti-injection)
    const body = JSON.parse(String(httpPost.mock.calls[0][1])) as { prompt_override: string; user_message: string; temperature: number; model_id: string };
    expect(body.user_message).toContain("backend/01-api.md");
    expect(body.user_message).toContain("não-confiável");
    expect(body.prompt_override).toContain("SOMENTE caminhos");
    expect(body.temperature).toBe(0);
    // ID com versão: o apelido curto é recusado pelo Bedrock (400), medido em prod 2026-09-06.
    expect(body.model_id).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
  });

  it("path inventado pelo modelo, id inexistente ou JSON inválido NÃO gravam rota", async () => {
    const g1 = F({ file: "" });
    projectFindingsState.mockResolvedValue({ latestRunId: "r1", findings: [g1], resolved: [], counts: {} });

    const inventado = fakeDb(twoFiles);
    httpPost.mockResolvedValue(rawOk([{ id: "g1", file: "backend/99-inexistente.md" }]));
    expect(await routeUnroutedFindings(inventado.db, "p1")).toMatchObject({ routed: 0, stillUnrouted: 1 });
    expect(inventado.updates).toHaveLength(0);

    const idErrado = fakeDb(twoFiles);
    httpPost.mockResolvedValue(rawOk([{ id: "g99", file: "backend/01-api.md" }]));
    expect(await routeUnroutedFindings(idErrado.db, "p1")).toMatchObject({ routed: 0, stillUnrouted: 1 });

    const lixo = fakeDb(twoFiles);
    httpPost.mockResolvedValue(JSON.stringify({ response: "desculpe, não consigo classificar", model_used: "m" }));
    expect(await routeUnroutedFindings(lixo.db, "p1")).toMatchObject({ routed: 0, stillUnrouted: 1 });
    expect(lixo.updates).toHaveLength(0);
  });

  it("falha de rede/timeout do agente: nada é inventado e o GAP segue unrouted", async () => {
    projectFindingsState.mockResolvedValue({ latestRunId: "r1", findings: [F({ file: "" })], resolved: [], counts: {} });
    const { db, updates } = fakeDb(twoFiles);
    httpPost.mockRejectedValue(new Error("ETIMEDOUT"));
    expect(await routeUnroutedFindings(db, "p1")).toMatchObject({ routed: 0, stillUnrouted: 1, skipped: false });
    expect(updates).toHaveLength(0);
  });

  it("resposta em cerca de código ainda é aceita (transporte, não julgamento)", async () => {
    const g1 = F({ file: "" });
    projectFindingsState.mockResolvedValue({ latestRunId: "r1", findings: [g1], resolved: [], counts: {} });
    const { db } = fakeDb(twoFiles);
    httpPost.mockResolvedValue(JSON.stringify({
      response: '```json\n{"routes":[{"id":"g1","file":"backend/01-api.md"}]}\n```',
      model_used: "m",
    }));
    expect(await routeUnroutedFindings(db, "p1")).toMatchObject({ routed: 1 });
  });
});

describe("ensureGapScope", () => {
  const OLD = process.env.API_AGENTS_URL;
  beforeEach(() => { projectFindingsState.mockReset(); httpPost.mockReset(); process.env.API_AGENTS_URL = "http://agents:8000"; });
  afterEach(() => { if (OLD === undefined) delete process.env.API_AGENTS_URL; else process.env.API_AGENTS_URL = OLD; });

  const twoFiles = [
    { filename: "00-indice.md", rel_dir: null, is_primary: true },
    { filename: "01-api.md", rel_dir: "backend", is_primary: false },
  ];

  it("route:false só lê o que está gravado (GET nunca gasta LLM)", async () => {
    projectFindingsState.mockResolvedValue({ latestRunId: "r1", findings: [F({ file: "" })], resolved: [], counts: {} });
    const { scope, routing } = await ensureGapScope(fakeDb(twoFiles).db, "p1");
    expect(routing).toBeNull();
    expect(scope.unrouted).toHaveLength(1);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("route:true com GAP sem arquivo roteia e recalcula o escopo", async () => {
    const g1 = F({ file: "" });
    let routesGravadas: Record<string, string> | null = null;
    projectFindingsState.mockResolvedValue({ latestRunId: "r1", findings: [g1], resolved: [], counts: {} });
    const db = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        if (text.includes("FROM project_spec_files")) {
          return { rows: twoFiles.map((f) => ({ ...f, file_path: `/x/${f.filename}` })) as unknown as Record<string, unknown>[] };
        }
        if (text.includes("SELECT finding_routes")) return { rows: [{ finding_routes: routesGravadas }] };
        if (text.includes("UPDATE spec_validation_runs")) { routesGravadas = JSON.parse(String(values?.[1])); return { rows: [] }; }
        return { rows: [] };
      }),
    };
    httpPost.mockResolvedValue(rawOk([{ id: "g1", file: "backend/01-api.md" }]));

    const { scope, routing } = await ensureGapScope(db, "p1", { route: true });
    expect(routing).toMatchObject({ routed: 1 });
    expect(scope.unrouted).toEqual([]);
    expect(scope.byPath.get("backend/01-api.md")).toHaveLength(1);
    expect(toWire(scope).queue).toEqual(["backend/01-api.md"]);
  });

  it("route:true sem nada a rotear não chama o agente", async () => {
    projectFindingsState.mockResolvedValue({ latestRunId: "r1", findings: [F({ file: "backend/01-api.md" })], resolved: [], counts: {} });
    const { routing } = await ensureGapScope(fakeDb(twoFiles).db, "p1", { route: true });
    expect(routing).toBeNull();
    expect(httpPost).not.toHaveBeenCalled();
  });

  /**
   * Regressão medida em PROD 2026-09-06 (spec dividida do LastMile): o default era o APELIDO
   * `us.anthropic.claude-haiku-4-5`, que o Bedrock recusa com `400 The provided model identifier is
   * invalid`. Resultado: todo lote caía no catch e os 5 GAPs globais ficavam `unrouted` para sempre
   * (`routed: 0`, `model: null`) — falha silenciosa, porque o roteador não inventa rota.
   */
  it("o modelo default do roteador é um inference profile COM VERSÃO (não o apelido)", async () => {
    delete process.env.SPEC_GAP_ROUTER_MODEL;
    projectFindingsState.mockResolvedValue({ latestRunId: "r1", findings: [F({ file: "" })], resolved: [], counts: {} });
    httpPost.mockResolvedValue(rawOk([]));
    await routeUnroutedFindings(fakeDb(twoFiles).db, "p1");
    const sent = JSON.parse(httpPost.mock.calls[0][1]) as { model_id: string };
    expect(sent.model_id).toMatch(/^us\.anthropic\.claude-haiku-4-5-\d{8}-v\d+:\d+$/);
  });
});
