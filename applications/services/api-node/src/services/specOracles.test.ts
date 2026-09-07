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
  growthMarginIsNoise,
  ensureOracleDecisions, dropImpossibleDecisions, loadOracleDecisions, decidedContractsBlock,
  _resetOracleMemo,
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

const LOCK = "__decision_lock__";

/**
 * Banco de mentira que registra os INSERTs — o que importa é O QUE foi gravado.
 * `lockTaken: true` simula a reserva de decisão (GAP-23) já feita por OUTRO processo.
 */
const fakeDb = (
  opts: { files: string[]; rows?: Record<string, unknown>[]; sameHash?: boolean; lockTaken?: boolean } = { files: [] },
) => {
  const inserts: unknown[][] = [];
  const locks: string[] = [];
  const released: string[] = [];
  let rows = opts.rows ?? [];
  const db = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("INSERT INTO spec_oracle_decisions") && (values ?? [])[2] === LOCK) {
        locks.push(String((values ?? [])[1]));
        return { rows: [], rowCount: opts.lockTaken ? 0 : 1 };
      }
      if (text.startsWith("DELETE FROM spec_oracle_decisions")) {
        released.push(String((values ?? [])[1]));
        return { rows: [], rowCount: 1 };
      }
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
      if (text.startsWith("SELECT DISTINCT ON (contract_key)")) {
        // Honra o `contract_key <> $2` real: o marcador de decisão nunca pode vazar como contrato.
        const skip = (values ?? [])[1];
        return { rows: rows.filter((r) => r.contract_key !== skip) };
      }
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
  return { db, inserts, locks, released };
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
      rows: [{ contract_key: "paginacao", oracle_path: "contratos-erros.md", rule_summary: "r", restated_in: ["modelo-dados.md"], spec_hash: "h0", decided_by_model: "m" }],
    });
    await ensureOracleDecisions(db, "p1", { specHash: "h9", findings });
    const body = JSON.parse(httpPost.mock.calls[0][1]) as { user_message: string };
    expect(body.user_message).toContain("CONTRATOS JÁ DECIDIDOS");
    // GAP-34: o fato transportado é key → oráculo → REDECLARADORES → regra. Sem os dois últimos, o
    // pedido de "UM ASSUNTO = UM CONTRATO" e o de reparar aposentadoria são impossíveis de atender.
    expect(body.user_message).toContain("`paginacao` → oráculo `contratos-erros.md`");
    expect(body.user_message).toContain("redeclarado em `modelo-dados.md`");
    expect(body.user_message).toContain("regra vigente: r");
  });
});

// ── GAP-23: uma decisão por conteúdo, mesmo com chamadas concorrentes ─────────

describe("GAP-23 — corrida de decisão (medida em prod: 27 contratos + 13 no MESMO hash)", () => {
  beforeEach(() => {
    httpPost.mockReset();
    _resetOracleMemo();
    process.env.API_AGENTS_URL = "http://agents:8000";
    delete process.env.SPEC_ORACLE_REGISTRY;
  });

  const findings = [
    F({ file: "modelo-dados.md", title: "METRICS_TOKEN contraditório", rationale: "contratos-erros.md diz outro" }),
  ];

  it("duas chamadas simultâneas (o `setImmediate` do laço) pagam UM LLM só", async () => {
    let release: (v: string) => void = () => {};
    httpPost.mockReturnValue(new Promise<string>((res) => { release = res; }));
    const { db, inserts } = fakeDb({ files: ["contratos-erros.md", "modelo-dados.md", "observabilidade-operacao.md"] });
    const a = ensureOracleDecisions(db, "p1", { specHash: "h1", findings });
    const b = ensureOracleDecisions(db, "p1", { specHash: "h1", findings });
    release(rawOk([{ key: "metrics-token", oracle: "observabilidade-operacao.md", rule: "r", restated_in: [] }]));
    const [ra, rb] = await Promise.all([a, b]);
    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);
    // Quem chegou depois recebe a MESMA decisão — não um estado que ignora a decisão em curso.
    expect(rb.decisions).toEqual(ra.decisions);
  });

  it("reserva já tomada por OUTRO processo → não paga LLM e não grava contrato", async () => {
    httpPost.mockResolvedValue(rawOk([{ key: "k", oracle: "contratos-erros.md", rule: "r", restated_in: [] }]));
    const { db, inserts } = fakeDb({ files: ["contratos-erros.md", "modelo-dados.md"], lockTaken: true });
    const res = await ensureOracleDecisions(db, "p1", { specHash: "h1", findings });
    expect(httpPost).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(res.reason).toMatch(/em curso/);
  });

  it("LLM falhou → DEVOLVE a reserva (senão o conteúdo congela como 'decidido' sem decisão)", async () => {
    httpPost.mockRejectedValue(new Error("socket hang up"));
    const { db, locks, released } = fakeDb({ files: ["contratos-erros.md", "modelo-dados.md"] });
    await ensureOracleDecisions(db, "p1", { specHash: "h7", findings });
    expect(locks).toEqual(["h7"]);
    expect(released).toEqual(["h7"]);
  });

  it("resposta não-JSON também devolve a reserva", async () => {
    httpPost.mockResolvedValue(JSON.stringify({ response: "não sei decidir" }));
    const { db, released } = fakeDb({ files: ["contratos-erros.md", "modelo-dados.md"] });
    await ensureOracleDecisions(db, "p1", { specHash: "h8", findings });
    expect(released).toEqual(["h8"]);
  });

  it("o modelo NÃO consegue gravar um contrato com a chave reservada do marcador", async () => {
    httpPost.mockResolvedValue(rawOk([{ key: LOCK, oracle: "contratos-erros.md", rule: "r", restated_in: [] }]));
    const { db, inserts } = fakeDb({ files: ["contratos-erros.md", "modelo-dados.md"] });
    const res = await ensureOracleDecisions(db, "p1", { specHash: "h1", findings });
    expect(inserts).toHaveLength(0);
    expect(res.decided).toBe(0);
  });

  it("o marcador nunca vaza como decisão na leitura", async () => {
    const { db } = fakeDb({
      files: ["a.md", "b.md"],
      rows: [
        { contract_key: LOCK, oracle_path: "-", rule_summary: "", restated_in: [], spec_hash: "h1", decided_by_model: null },
        { contract_key: "paginacao", oracle_path: "a.md", rule_summary: "r", restated_in: ["b.md"], spec_hash: "h1", decided_by_model: "m" },
      ],
    });
    const out = await loadOracleDecisions(db, "p1");
    expect(out.map((d) => d.contractKey)).toEqual(["paginacao"]);
  });
});

// ── GAP-24 → GAP-27: só a decisão IMPOSSÍVEL é suprimida ─────────────────────

describe("dropImpossibleDecisions — GAP-24/27", () => {
  it("suprime a decisão AUTO-INVERSA (o oráculo constava como redeclarador de si mesmo)", () => {
    const out = dropImpossibleDecisions([
      D({ contractKey: "paginacao", oraclePath: "contratos-erros.md", restatedIn: ["modelo-dados.md", "contratos-erros.md"] }),
      D({ contractKey: "colunas-users", oraclePath: "modelo-dados.md", restatedIn: ["privacidade-lgpd.md"] }),
    ]);
    expect(out.map((d) => d.contractKey)).toEqual(["colunas-users"]);
  });

  it("suprime OS DOIS lados quando o MESMO contrato aparece com dois donos", () => {
    const out = dropImpossibleDecisions([
      D({ contractKey: "paginacao", oraclePath: "contratos-erros.md", restatedIn: ["modelo-dados.md"] }),
      D({ contractKey: "paginacao", oraclePath: "modelo-dados.md", restatedIn: ["contratos-erros.md"] }),
      D({ contractKey: "colunas-users", oraclePath: "modelo-dados.md", restatedIn: ["privacidade-lgpd.md"] }),
    ]);
    // Nenhum vencedor escolhido por código: escolher seria julgamento, e julgamento é do agente.
    expect(out.map((d) => d.contractKey)).toEqual(["colunas-users"]);
  });

  it("GAP-27: contratos DIFERENTES que se redeclaram mutuamente SOBREVIVEM (é o caso normal)", () => {
    // Medido em prod na run b344e699: a regra anterior derrubou 38 de 40 decisões (vigentes=2) porque
    // "A é oráculo do tema dele e redeclara o tema de B" é exatamente como a spec dividida funciona.
    const decisions = [
      D({ contractKey: "catalogo-erros", oraclePath: "contratos-erros.md", restatedIn: ["api-entregas-entregadores.md"] }),
      D({ contractKey: "limites-string-campos", oraclePath: "api-entregas-entregadores.md", restatedIn: ["contratos-erros.md"] }),
    ];
    expect(dropImpossibleDecisions(decisions)).toHaveLength(2);
  });

  it("o par de assuntos iguais com CHAVES diferentes não é decidido por código (fica para o agente)", () => {
    // O par METRICS_TOKEN medido em prod: para o código são dois contratos distintos. Quem sabe que é o
    // mesmo assunto é o agente — a cura vive no prompt de decisão, não numa heurística de string.
    const decisions = [
      D({ contractKey: "metrics-token-boot", oraclePath: "observabilidade-operacao.md", restatedIn: ["infraestrutura-deploy.md"] }),
      D({ contractKey: "obrigatoriedade-metrics-token", oraclePath: "infraestrutura-deploy.md", restatedIn: ["observabilidade-operacao.md"] }),
    ];
    expect(dropImpossibleDecisions(decisions)).toHaveLength(2);
  });

  it("o mesmo oráculo em dois contratos é normal", () => {
    const decisions = [
      D({ contractKey: "a", oraclePath: "modelo-dados.md", restatedIn: ["x.md"] }),
      D({ contractKey: "b", oraclePath: "modelo-dados.md", restatedIn: ["x.md"] }),
    ];
    expect(dropImpossibleDecisions(decisions)).toHaveLength(2);
  });

  it("a decisão impossível também não chega ao prompt do CTO", async () => {
    const { db } = fakeDb({
      files: ["observabilidade-operacao.md", "infraestrutura-deploy.md"],
      rows: [
        { contract_key: "metrics-token-boot", oracle_path: "observabilidade-operacao.md", rule_summary: "r", restated_in: ["observabilidade-operacao.md"], spec_hash: "h1", decided_by_model: "m" },
      ],
    });
    const vigentes = await loadOracleDecisions(db, "p1");
    expect(vigentes).toHaveLength(0);
    expect(oracleFactBlock(vigentes, "infraestrutura-deploy.md")).toBe("");
  });

  it("GAP-27 ao vivo: a árvore inteira de contratos cruzados continua chegando ao prompt", async () => {
    const { db } = fakeDb({
      files: ["contratos-erros.md", "api-entregas-entregadores.md", "modelo-dados.md"],
      rows: [
        { contract_key: "catalogo-erros", oracle_path: "contratos-erros.md", rule_summary: "r1", restated_in: ["api-entregas-entregadores.md", "modelo-dados.md"], spec_hash: "h1", decided_by_model: "m" },
        { contract_key: "limites-string-campos", oracle_path: "api-entregas-entregadores.md", rule_summary: "r2", restated_in: ["contratos-erros.md"], spec_hash: "h1", decided_by_model: "m" },
        { contract_key: "inventario-rotas", oracle_path: "modelo-dados.md", rule_summary: "r3", restated_in: ["api-entregas-entregadores.md"], spec_hash: "h1", decided_by_model: "m" },
      ],
    });
    const vigentes = await loadOracleDecisions(db, "p1");
    expect(vigentes).toHaveLength(3);
    const bloco = oracleFactBlock(vigentes, "api-entregas-entregadores.md");
    expect(bloco).toContain("limites-string-campos");
    expect(bloco).toContain("catalogo-erros");
    expect(bloco).toContain("inventario-rotas");
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
    expect(role.ownsRetired).toHaveLength(0);
  });
});

// ── GAP-35: `restated_in: []` é APOSENTADORIA — não vira ordem de manter a definição ──
//
// Medido em prod (NVX LastMile, 61 contratos): 9 tinham `restated_in` vazio, e o par
// `erasure-ja-executada`/`erro-eliminacao-ja-executada` oscilou entre "aposentada" e normativa. O
// `ORACLE_SYSTEM` define `restated_in: []` como a forma de aposentar sem apagar histórico; emitir
// "ESTE arquivo é o oráculo, mantenha a definição aqui" para ela é o CÓDIGO mandando ressuscitar.
describe("oracleRoleForFile — GAP-35: contrato sem redeclarador não vira instrução", () => {
  it("contrato aposentado (`restated_in: []`) sai de `owns` e vai para `ownsRetired`", () => {
    const role = oracleRoleForFile([
      D({ contractKey: "paginacao", restatedIn: ["modelo-dados.md"] }),
      D({ contractKey: "cli-admin-recover", restatedIn: [] }),
    ], "contratos-erros.md");
    expect(role.owns.map((d) => d.contractKey)).toEqual(["paginacao"]);
    expect(role.ownsRetired.map((d) => d.contractKey)).toEqual(["cli-admin-recover"]);
  });

  it("arquivo que SÓ tem contratos aposentados recebe bloco VAZIO", () => {
    expect(oracleFactBlock([D({ restatedIn: [] })], "contratos-erros.md")).toBe("");
  });

  it("a aposentadoria de um contrato não apaga a instrução dos outros", () => {
    const block = oracleFactBlock([
      D({ contractKey: "paginacao", restatedIn: ["modelo-dados.md"] }),
      D({ contractKey: "limites-campos", restatedIn: [] }),
    ], "contratos-erros.md");
    expect(block).toContain("`paginacao`: ESTE arquivo é o oráculo");
    expect(block).not.toContain("limites-campos");
  });

  it("quem REDECLARA continua sendo instruído mesmo que o oráculo tenha outros contratos aposentados", () => {
    const block = oracleFactBlock([
      D({ contractKey: "paginacao", restatedIn: ["modelo-dados.md"] }),
      D({ contractKey: "orfao", oraclePath: "modelo-dados.md", restatedIn: [] }),
    ], "modelo-dados.md");
    expect(block).toContain("o oráculo é `contratos-erros.md`");
    expect(block).not.toContain("`orfao`");
  });
});

// ── GAP-34: a lista de CONTRATOS JÁ DECIDIDOS transportava slug+path e nada mais ──
//
// O `ORACLE_SYSTEM` pede "UM ASSUNTO = UM CONTRATO … reemita a chave PERDEDORA com `restated_in: []`".
// Sem `restated_in` e sem a regra no fato transportado, esse julgamento é impossível de fazer: em prod
// o registro do NVX acumulou 6 pares de chaves para o mesmo assunto (≈20% dos 61 contratos).
describe("decidedContractsBlock (GAP-34)", () => {
  it("registro vazio → bloco vazio (não polui o prompt de estreia)", () => {
    expect(decidedContractsBlock([])).toBe("");
  });

  it("leva oráculo, redeclaradores E a regra vigente de cada contrato", () => {
    const block = decidedContractsBlock([D()]);
    expect(block).toContain("`paginacao` → oráculo `contratos-erros.md`");
    expect(block).toContain("redeclarado em `modelo-dados.md`");
    expect(block).toContain("regra vigente: page/pageSize (1-based)");
  });

  it("contrato sem redeclarador é declarado como tal — é o sinal de aposentadoria pela metade", () => {
    const block = decidedContractsBlock([D({ contractKey: "limites-campos", restatedIn: [] })]);
    expect(block).toContain("SEM redeclaração registrada");
    expect(block).not.toContain("redeclarado em");
  });

  it("anuncia o total e manda comparar ASSUNTOS, não slugs (é o par duplicado medido em prod)", () => {
    const block = decidedContractsBlock([
      D({ contractKey: "metrics-token-boot", oraclePath: "infraestrutura-deploy.md", restatedIn: ["observabilidade-operacao.md"] }),
      D({ contractKey: "obrigatoriedade-metrics-token", oraclePath: "infraestrutura-deploy.md", restatedIn: ["observabilidade-operacao.md"] }),
    ]);
    expect(block).toContain("CONTRATOS JÁ DECIDIDOS (2)");
    expect(block).toContain("Compare os ASSUNTOS, não os slugs");
    expect(block).toContain("metrics-token-boot");
    expect(block).toContain("obrigatoriedade-metrics-token");
  });

  it("regra longa é truncada — o fato entra sem estourar o prompt", () => {
    const block = decidedContractsBlock([D({ ruleSummary: "x".repeat(400) })], 50);
    expect(block).toContain(`regra vigente: ${"x".repeat(50)}`);
    expect(block).not.toContain("x".repeat(51));
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

// ── GAP-25: o critério de aceitação vira NÚMERO no pedido ─────────────────────
//
// Nas 5 primeiras rodadas em prod com o registro ligado, 2 foram DESCARTADAS por crescer (+7.837 e
// +2.786 chars). O bloco só dizia "deve encolher" — o agente não tinha como saber onde estava a linha.
describe("oracleFactBlock — GAP-25: orçamento de saída como contrato", () => {
  it("anuncia o teto em NÚMERO para quem redeclara, quando o chamador de fato veta", () => {
    const block = oracleFactBlock([D()], "modelo-dados.md", 50_000);
    expect(block).toContain("50000");
    expect(block).toContain("52000"); // 50.000 + ORACLE_GROWTH_BUDGET (2.000)
    expect(block).toContain("DESCARTADA INTEIRA");
    expect(block).toContain("FICAR ABAIXO de 50000");
  });

  it("sem tamanho informado NÃO promete descarte (o botão humano não passa pelo veto)", () => {
    const block = oracleFactBlock([D()], "modelo-dados.md");
    expect(block).toContain("deve ENCOLHER");
    expect(block).not.toContain("DESCARTADA INTEIRA");
  });

  it("arquivo que só É oráculo não recebe teto — ele mantém a definição, não consolida nada", () => {
    const block = oracleFactBlock([D()], "contratos-erros.md", 50_000);
    expect(block).toContain("ESTE arquivo é o oráculo");
    expect(block).not.toContain("DESCARTADA INTEIRA");
  });
});

// ── GAP-28: a margem anunciada é a que RESTA do passe ─────────────────────────
//
// Medido na run `889af4f3`, passe 2: 8 de 11 rodadas descartadas inteiras pelo veto de crescimento,
// cada uma uma chamada de Opus 5 já paga. O orçamento é do PASSE (a spec não pode inflar), não de
// cada arquivo isolado — quem encolhe financia quem precisa crescer. O laço informa o saldo.
describe("oracleFactBlock — GAP-28: margem restante do passe", () => {
  it("anuncia o SALDO informado pelo laço, não o orçamento cheio", () => {
    const block = oracleFactBlock([D()], "modelo-dados.md", 50_000, 500);
    expect(block).toContain("50500"); // teto = 50.000 + 500 restantes
    expect(block).toContain("Você tem 500 caracteres de margem");
    expect(block).not.toContain("52000");
  });

  it("saldo ZERO é dito como zero — não vira o orçamento cheio por omissão", () => {
    const block = oracleFactBlock([D()], "modelo-dados.md", 50_000, 0);
    expect(block).toContain("Se a revisão passar de 50000");
    expect(block).toContain("NÃO pode crescer nem um caractere");
    expect(block).not.toContain("caracteres de margem");
  });

  it("saldo negativo (o passe já estourou) é tratado como zero, nunca como crédito", () => {
    const block = oracleFactBlock([D()], "modelo-dados.md", 50_000, -3_000);
    expect(block).toContain("Se a revisão passar de 50000");
    expect(block).toContain("NÃO pode crescer nem um caractere");
    expect(block).not.toContain("-3000");
  });

  it("sem saldo informado (botão humano) mantém o orçamento cheio do GAP-25", () => {
    const block = oracleFactBlock([D()], "modelo-dados.md", 50_000);
    expect(block).toContain("52000");
  });
});

// ── GAP-38: margem de RUÍDO — anunciar o número convida a estourá-lo ──────────
//
// Medido na run `be406f3c` (passe 1, com o GAP-36 já em prod): `README.md` voltou +1.431 contra 447
// anunciados, `definicao-de-pronto.md` +1.511 contra 447 e `observabilidade-operacao.md` +2.827 contra
// 680. Três chamadas de Opus 5 pagas e descartadas. O teto está certo (é a guarda contra o GAP-8); o que
// falhava era o ENQUADRAMENTO: "Você tem 447 caracteres de margem" num arquivo de 68.590 lê-se como
// folga. O número continua sendo dito — mentir dizendo "zero" seria o defeito oposto.
describe("oracleFactBlock — GAP-38: margem irrisória é dita como impossibilidade, não como folga", () => {
  it("margem abaixo de 1% do arquivo vira CONSOLIDAÇÃO OBRIGATÓRIA (caso medido: 447 em 68.590)", () => {
    const block = oracleFactBlock([D()], "modelo-dados.md", 68_590, 447);
    expect(block).toContain("CONSOLIDAÇÃO OBRIGATÓRIA");
    expect(block).toContain("447");                          // o número REAL continua no texto
    expect(block).toContain("praticamente nada");
    expect(block).not.toContain("Você tem 447 caracteres de margem");
    // O teto verificado por código não muda: quem julga é o veto, não a redação.
    expect(block).toContain("Se a revisão passar de 69037");
  });

  it("oferece a saída honesta: consolidar primeiro e DIZER qual GAP ficou para depois", () => {
    const block = oracleFactBlock([D()], "modelo-dados.md", 68_590, 447);
    expect(block).toContain("qual GAP");
    expect(block).toContain("ficou para a próxima rodada");
  });

  it("margem folgada NÃO muda de tom — zero regressão no caminho normal", () => {
    const block = oracleFactBlock([D()], "modelo-dados.md", 68_590, 12_000);
    expect(block).toContain("Você tem 12000 caracteres de margem");
    expect(block).not.toContain("CONSOLIDAÇÃO OBRIGATÓRIA");
  });

  it("saldo zero continua com o texto próprio do GAP-28 (não é caso de ruído)", () => {
    const block = oracleFactBlock([D()], "modelo-dados.md", 68_590, 0);
    expect(block).toContain("NÃO pode crescer nem um caractere");
    expect(block).not.toContain("CONSOLIDAÇÃO OBRIGATÓRIA");
  });

  it("piso de 500: em arquivo PEQUENO, 1% seria ruído demais para servir de limiar", () => {
    // 1% de 8.000 = 80. Sem o piso, 300 chars de margem passariam por "folga" num arquivo em que 300
    // chars são 3,75% — e é justamente aí que o agente ainda tem espaço real para trabalhar.
    expect(growthMarginIsNoise(300, 8_000)).toBe(true);
    expect(growthMarginIsNoise(600, 8_000)).toBe(false);
  });

  it("não classifica como ruído o que não é margem (zero, negativo, arquivo sem tamanho)", () => {
    expect(growthMarginIsNoise(0, 68_590)).toBe(false);
    expect(growthMarginIsNoise(-100, 68_590)).toBe(false);
    expect(growthMarginIsNoise(447, 0)).toBe(false);
    expect(growthMarginIsNoise(Number.NaN, 68_590)).toBe(false);
  });
});
