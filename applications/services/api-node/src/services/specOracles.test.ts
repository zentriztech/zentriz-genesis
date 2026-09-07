/**
 * specOracles.test.ts — GAP-22: registro de ORÁCULOS (quem é a fonte única de cada contrato).
 *
 * O que estes testes protegem (e por quê):
 *  - TRANSPORTE, não julgamento: o código só manda ao agente os findings que CITAM outro arquivo, e só
 *    grava decisão cujo path existe na árvore. Path inventado pelo modelo → nada gravado (a mesma régua
 *    do roteador de GAPs; ver feedback-genesis-100-llm-nunca-automacao-fixa).
 *  - IDEMPOTÊNCIA por conteúdo: uma decisão por `spec_hash`, não uma por rodada. Re-decidir a cada
 *    rodada é EXATAMENTE o defeito medido em prod (o contrato de paginação migrou por 5 rodadas).
 *  - SEM LLM não há fallback: falha de rede/JSON devolve o que já existia — nunca inventa oráculo.
 *  - O bloco de prompt diz "SUBSTITUA a redeclaração por citação" para quem redeclara e "mantenha aqui"
 *    para o oráculo — as duas faces da consolidação. E fecha pedindo ENCOLHIMENTO (contrato de saída).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EnrichedFinding } from "./findingTriage.js";

const httpPost = vi.fn<(url: string, body: string, timeoutMs: number) => Promise<string>>();
vi.mock("../routes/specs.js", () => ({ httpPost: (...a: [string, string, number]) => httpPost(...a) }));
vi.mock("fs/promises", () => ({
  readFile: vi.fn(async (p: string) => Buffer.from(`# ${p}\n## Contrato\ntexto\n`)),
}));

const {
  crossFileFindings, parseOracleResponse, oracleRegistryEnabled, oracleRoleForFile, oracleFactBlock,
  ensureOracleDecisions, _resetOracleMemo,
} = await import("./specOracles.js");

type Decision = import("./specOracles.js").OracleDecision;

let fpSeq = 0;
const F = (o: Partial<EnrichedFinding> = {}): EnrichedFinding => ({
  file: "", line: null, severity: "blocker", title: `t${++fpSeq}`, rationale: "", source: "stage_b",
  category: "other", anchor: null, fingerprint: `fp${fpSeq}`, triageable: true, triage: null, ...o,
});

const D = (o: Partial<Decision> = {}): Decision => ({
  contractKey: "paginacao", oraclePath: "contratos-erros.md", ruleSummary: "page/pageSize (1-based)",
  restatedIn: ["modelo-dados.md"], specHash: "h1", model: "m", ...o,
});

/** Banco de mentira que registra os INSERTs — o que importa é O QUE foi gravado. */
const fakeDb = (opts: { files: string[]; rows?: Record<string, unknown>[]; sameHash?: boolean } = { files: [] }) => {
  const inserts: unknown[][] = [];
  let rows = opts.rows ?? [];
  const db = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("FROM project_spec_files")) {
        return {
          rows: opts.files.map((p) => {
            const idx = p.lastIndexOf("/");
            return {
              filename: idx === -1 ? p : p.slice(idx + 1),
              rel_dir: idx === -1 ? null : p.slice(0, idx),
              file_path: `/shared/uploads/p/${p}`,
              is_primary: p === opts.files[0],
            };
          }) as unknown as Record<string, unknown>[],
        };
      }
      if (text.includes("SELECT 1 FROM spec_oracle_decisions")) return { rows: opts.sameHash ? [{ n: 1 }] : [] };
      if (text.startsWith("SELECT DISTINCT ON (contract_key)")) return { rows };
      if (text.includes("INSERT INTO spec_oracle_decisions")) {
        inserts.push(values ?? []);
        rows = [...rows, {
          contract_key: (values ?? [])[2], oracle_path: (values ?? [])[3], rule_summary: (values ?? [])[4],
          restated_in: JSON.parse(String((values ?? [])[5])), spec_hash: (values ?? [])[1],
          decided_by_model: (values ?? [])[6],
        }];
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    }),
  };
  return { db, inserts };
};

const rawOk = (contracts: unknown[], model = "us.anthropic.claude-haiku-4-5-20251001-v1:0") =>
  JSON.stringify({ response: JSON.stringify({ contracts }), model_used: model });

// ── Seleção por citação literal (transporte) ──────────────────────────────────

describe("crossFileFindings — só o que fala de MAIS DE UM arquivo", () => {
  const paths = ["contratos-erros.md", "modelo-dados.md", "backend/api.md"];

  it("pega o finding que cita outro arquivo no motivo", () => {
    const out = crossFileFindings([
      F({ file: "modelo-dados.md", title: "Paginação contraditória", rationale: "contratos-erros.md diz page/pageSize" }),
    ], paths);
    expect(out).toHaveLength(1);
    expect(out[0].cites).toEqual(["contratos-erros.md"]);
  });

  it("casa por basename mesmo quando o path tem diretório", () => {
    const out = crossFileFindings([
      F({ file: "modelo-dados.md", title: "Rotas divergem de api.md" }),
    ], paths);
    expect(out[0].cites).toEqual(["backend/api.md"]);
  });

  it("IGNORA o finding que só cita o PRÓPRIO arquivo (não há contrato entre arquivos)", () => {
    expect(crossFileFindings([
      F({ file: "modelo-dados.md", title: "modelo-dados.md se contradiz internamente" }),
    ], paths)).toHaveLength(0);
  });

  it("IGNORA `info` — baixo risco não sustenta decisão de arquitetura", () => {
    expect(crossFileFindings([
      F({ severity: "info", file: "modelo-dados.md", rationale: "ver contratos-erros.md" }),
    ], paths)).toHaveLength(0);
  });
});

// ── Parser ────────────────────────────────────────────────────────────────────

describe("parseOracleResponse", () => {
  it("aceita JSON cercado por ```json (o modelo desobedece)", () => {
    const out = parseOracleResponse('```json\n{"contracts":[{"key":"Paginacao","oracle":"a.md","rule":"r","restated_in":["b.md"]}]}\n```');
    expect(out).toEqual([{ key: "paginacao", oracle: "a.md", rule: "r", restated_in: ["b.md"] }]);
  });

  it("aceita prosa em volta do objeto", () => {
    const out = parseOracleResponse('Claro! {"contracts":[{"key":"k","oracle":"a.md"}]} — pronto.');
    expect(out).toEqual([{ key: "k", oracle: "a.md", rule: "", restated_in: [] }]);
  });

  it("descarta contrato sem key ou sem oracle (não inventa)", () => {
    expect(parseOracleResponse('{"contracts":[{"key":"","oracle":"a.md"},{"key":"k"}]}')).toEqual([]);
  });

  it("resposta não-JSON → null", () => {
    expect(parseOracleResponse("não consegui decidir")).toBeNull();
  });
});

// ── ensureOracleDecisions ─────────────────────────────────────────────────────

describe("ensureOracleDecisions", () => {
  beforeEach(() => {
    httpPost.mockReset();
    _resetOracleMemo();
    process.env.API_AGENTS_URL = "http://agents:8000";
    delete process.env.SPEC_ORACLE_REGISTRY;
  });

  const findings = [
    F({ file: "modelo-dados.md", title: "Paginação contraditória", rationale: "contratos-erros.md diz outro valor" }),
  ];

  it("grava a decisão do agente e devolve o que ficou vigente", async () => {
    httpPost.mockResolvedValue(rawOk([
      { key: "paginacao", oracle: "contratos-erros.md", rule: "page/pageSize", restated_in: ["modelo-dados.md"] },
    ]));
    const { db, inserts } = fakeDb({ files: ["contratos-erros.md", "modelo-dados.md"] });
    const res = await ensureOracleDecisions(db, "p1", { specHash: "h1", findings });
    expect(res.decided).toBe(1);
    expect(res.skipped).toBe(false);
    expect(inserts[0][2]).toBe("paginacao");
    expect(inserts[0][3]).toBe("contratos-erros.md");
    expect(JSON.parse(String(inserts[0][5]))).toEqual(["modelo-dados.md"]);
    expect(res.decisions[0].oraclePath).toBe("contratos-erros.md");
  });

  it("path INVENTADO pelo modelo não vira decisão", async () => {
    httpPost.mockResolvedValue(rawOk([{ key: "k", oracle: "docs/inventado.md", rule: "r", restated_in: [] }]));
    const { db, inserts } = fakeDb({ files: ["contratos-erros.md", "modelo-dados.md"] });
    const res = await ensureOracleDecisions(db, "p1", { specHash: "h1", findings });
    expect(inserts).toHaveLength(0);
    expect(res.decided).toBe(0);
  });

  it("o oráculo NUNCA entra no próprio restated_in", async () => {
    httpPost.mockResolvedValue(rawOk([
      { key: "k", oracle: "contratos-erros.md", rule: "r", restated_in: ["contratos-erros.md", "modelo-dados.md"] },
    ]));
    const { db, inserts } = fakeDb({ files: ["contratos-erros.md", "modelo-dados.md"] });
    await ensureOracleDecisions(db, "p1", { specHash: "h1", findings });
    expect(JSON.parse(String(inserts[0][5]))).toEqual(["modelo-dados.md"]);
  });

  it("não pergunta duas vezes pelo MESMO conteúdo (idempotência por spec_hash)", async () => {
    httpPost.mockResolvedValue(rawOk([{ key: "k", oracle: "contratos-erros.md", rule: "r", restated_in: [] }]));
    const { db } = fakeDb({ files: ["contratos-erros.md", "modelo-dados.md"] });
    await ensureOracleDecisions(db, "p1", { specHash: "h1", findings });
    const again = await ensureOracleDecisions(db, "p1", { specHash: "h1", findings });
    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(again.skipped).toBe(true);
  });

  it("decisão já gravada em outro processo (memória fria) também não repaga o LLM", async () => {
    const { db } = fakeDb({ files: ["a.md", "b.md"], sameHash: true });
    const res = await ensureOracleDecisions(db, "p1", { specHash: "h1", findings });
    expect(httpPost).not.toHaveBeenCalled();
    expect(res.reason).toMatch(/já decidido/);
  });

  it("nenhum GAP citando outro arquivo → não paga LLM", async () => {
    const { db } = fakeDb({ files: ["a.md", "b.md"] });
    const res = await ensureOracleDecisions(db, "p1", {
      specHash: "h1", findings: [F({ file: "a.md", title: "falta seção de erros" })],
    });
    expect(httpPost).not.toHaveBeenCalled();
    expect(res.reason).toMatch(/nenhum GAP cita/);
  });

  it("spec de UM arquivo → não existe contrato entre arquivos", async () => {
    const { db } = fakeDb({ files: ["unica.md"] });
    const res = await ensureOracleDecisions(db, "p1", { specHash: "h1", findings });
    expect(httpPost).not.toHaveBeenCalled();
    expect(res.reason).toMatch(/1 arquivo/);
  });

  it("LLM indisponível → devolve o que já existia e NÃO inventa (sem fallback burro)", async () => {
    httpPost.mockRejectedValue(new Error("socket hang up"));
    const { db, inserts } = fakeDb({
      files: ["contratos-erros.md", "modelo-dados.md"],
      rows: [{ contract_key: "paginacao", oracle_path: "contratos-erros.md", rule_summary: "r", restated_in: ["modelo-dados.md"], spec_hash: "h0", decided_by_model: "m" }],
    });
    const res = await ensureOracleDecisions(db, "p1", { specHash: "h9", findings });
    expect(inserts).toHaveLength(0);
    expect(res.skipped).toBe(true);
    expect(res.decisions).toHaveLength(1);
  });

  it("flag OFF devolve as decisões vigentes sem chamar o agente", async () => {
    process.env.SPEC_ORACLE_REGISTRY = "off";
    const { db } = fakeDb({ files: ["a.md", "b.md"] });
    const res = await ensureOracleDecisions(db, "p1", { specHash: "h1", findings });
    expect(oracleRegistryEnabled()).toBe(false);
    expect(httpPost).not.toHaveBeenCalled();
    expect(res.reason).toMatch(/off/);
  });

  it("manda ao agente os contratos JÁ decididos (estabilidade entre rodadas)", async () => {
    httpPost.mockResolvedValue(rawOk([]));
    const { db } = fakeDb({
      files: ["contratos-erros.md", "modelo-dados.md"],
      rows: [{ contract_key: "paginacao", oracle_path: "contratos-erros.md", rule_summary: "r", restated_in: [], spec_hash: "h0", decided_by_model: "m" }],
    });
    await ensureOracleDecisions(db, "p1", { specHash: "h9", findings });
    const body = JSON.parse(httpPost.mock.calls[0][1]) as { user_message: string };
    expect(body.user_message).toContain("CONTRATOS JÁ DECIDIDOS");
    expect(body.user_message).toContain("paginacao → contratos-erros.md");
  });
});

// ── Papel do arquivo + bloco de prompt ────────────────────────────────────────

describe("oracleRoleForFile", () => {
  const decisions = [D(), D({ contractKey: "envelope-erro", oraclePath: "modelo-dados.md", restatedIn: ["contratos-erros.md"] })];

  it("o mesmo arquivo pode SER oráculo de um contrato e redeclarar outro", () => {
    const role = oracleRoleForFile(decisions, "contratos-erros.md");
    expect(role.owns.map((d) => d.contractKey)).toEqual(["paginacao"]);
    expect(role.restates.map((d) => d.contractKey)).toEqual(["envelope-erro"]);
  });

  it("arquivo sem papel algum → nada", () => {
    const role = oracleRoleForFile(decisions, "infra.md");
    expect(role.owns).toHaveLength(0);
    expect(role.restates).toHaveLength(0);
  });
});

describe("oracleFactBlock — o que o CTO lê", () => {
  it("arquivo sem papel → bloco VAZIO (não polui o prompt)", () => {
    expect(oracleFactBlock([D()], "infra.md")).toBe("");
  });

  it("quem redeclara é instruído a CITAR e a NÃO se autodeclarar fonte única", () => {
    const block = oracleFactBlock([D()], "modelo-dados.md");
    expect(block).toContain("o oráculo é `contratos-erros.md`");
    expect(block).toContain("SUBSTITUA a redeclaração");
    expect(block).toContain("NÃO acrescente um parágrafo dizendo que este arquivo é a fonte única");
    expect(block).toContain("deve ENCOLHER");
  });

  it("o oráculo é instruído a MANTER a definição (não movê-la)", () => {
    const block = oracleFactBlock([D()], "contratos-erros.md");
    expect(block).toContain("ESTE arquivo é o oráculo");
    expect(block).toContain("page/pageSize (1-based)");
    expect(block).not.toContain("SUBSTITUA a redeclaração");
  });
});
