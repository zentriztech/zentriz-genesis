import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import {
  collapseDuplicateFindings,
  parseCollapseGroups,
  parsePairs,
  reconcileGapDelta,
} from "./gapContinuity.js";
import * as specs from "../routes/specs.js";
import type { ValidationFinding } from "./specValidation.js";

/** Finding mínimo — só os campos que o reconciliador mostra ao agente. */
function f(over: Partial<ValidationFinding> & { title: string }): ValidationFinding {
  return {
    file: "modelo-dados.md", line: null, severity: "blocker", rationale: "", source: "stage_b",
    category: "consistency", anchor: null, ...over,
  };
}

/**
 * Os pares REAIS medidos em prod 2026-09-07 (run `b1bc1195`, passe 1): o mesmo defeito com a âncora
 * renumerada pela edição do CTO. Nenhum deles casa por fingerprint, e o Jaccard de título deu 0.
 */
const CLOSED_REAL = [
  f({ anchor: "§6.1", severity: "warning", title: "Domínio de `audit_log.actor_role` declarado fechado por constraint e aberto no mesmo DDL" }),
  f({ anchor: "§4.2 Passo 3", file: "privacidade-lgpd.md", title: "Janela residual zero após anonimização exigida sem mecanismo em texto presente" }),
];
const OPENED_REAL = [
  f({ anchor: "§6", severity: "warning", title: "O `CREATE TABLE audit_log` de §6 declara `actor_role VARCHAR(10)` sem CHECK" }),
  f({ anchor: "PRIV-JANELA-01", file: "privacidade-lgpd.md", title: "Exige-se tolerância zero de janela residual após anonimização (403 `ACCOUNT_INACTIVE`)" }),
];

describe("parsePairs", () => {
  it("extrai pares de JSON puro", () => {
    expect(parsePairs('{"pairs":[{"a":"a1","b":"b2","why":"seção renumerada"}]}')).toEqual([
      { a: "a1", b: "b2", why: "seção renumerada" },
    ]);
  });
  it("extrai pares de dentro de cerca de código e prosa", () => {
    const t = 'Segue a análise:\n```json\n{"pairs":[{"a":"a3","b":"b1"}]}\n```\nEspero ter ajudado.';
    expect(parsePairs(t)).toEqual([{ a: "a3", b: "b1", why: "" }]);
  });
  it("devolve null quando não há JSON — sem inventar par", () => {
    expect(parsePairs("não consegui comparar")).toBeNull();
    expect(parsePairs("")).toBeNull();
  });
  it("descarta par sem `a` ou `b` utilizável", () => {
    expect(parsePairs('{"pairs":[{"a":"a1"},{"b":"b1"},{"a":"","b":"b2"},{"a":"a2","b":"b3"}]}')).toEqual([
      { a: "a2", b: "b3", why: "" },
    ]);
  });
});

describe("GAP-67 — reconciliação da diferença finding-a-finding", () => {
  const OLD_URL = process.env.API_AGENTS_URL;
  let post: MockInstance<(url: string, body: string, timeoutMs?: number) => Promise<string>>;

  beforeEach(() => {
    process.env.API_AGENTS_URL = "http://agents:8000";
    post = vi.spyOn(specs, "httpPost");
  });
  afterEach(() => {
    post.mockRestore();
    if (OLD_URL === undefined) delete process.env.API_AGENTS_URL;
    else process.env.API_AGENTS_URL = OLD_URL;
  });

  const reply = (pairs: unknown) =>
    post.mockResolvedValue(JSON.stringify({ response: JSON.stringify({ pairs }), model_used: "haiku-4-5" }));

  it("par confirmado sai das DUAS listas e vira `persisted` — o defeito continua aberto", async () => {
    reply([{ a: "a1", b: "b1", why: "mesma contradição, §6.1 virou §6" },
           { a: "a2", b: "b2", why: "mesma janela residual" }]);
    const r = await reconcileGapDelta(CLOSED_REAL, OPENED_REAL);
    expect(r.reconciled).toBe(true);
    expect(r.persisted).toHaveLength(2);
    expect(r.closed).toHaveLength(0);
    expect(r.opened).toHaveLength(0);
    expect(r.model).toBe("haiku-4-5");
  });

  it("o que NÃO foi pareado sobrevive como fechado/novo de verdade", async () => {
    reply([{ a: "a1", b: "b1" }]);
    const r = await reconcileGapDelta(CLOSED_REAL, OPENED_REAL);
    expect(r.persisted).toHaveLength(1);
    expect(r.closed.map((x) => x.anchor)).toEqual(["§4.2 Passo 3"]);
    expect(r.opened.map((x) => x.anchor)).toEqual(["PRIV-JANELA-01"]);
  });

  it("id inventado pelo modelo é descartado, não vira par", async () => {
    reply([{ a: "a9", b: "b1" }, { a: "a1", b: "b7" }]);
    const r = await reconcileGapDelta(CLOSED_REAL, OPENED_REAL);
    expect(r.reconciled).toBe(true);
    expect(r.persisted).toHaveLength(0);
    expect(r.closed).toHaveLength(2);
    expect(r.opened).toHaveLength(2);
  });

  it("o MESMO item não pode ser pareado duas vezes (senão sumiria com dois novos de uma vez)", async () => {
    reply([{ a: "a1", b: "b1" }, { a: "a1", b: "b2" }]);
    const r = await reconcileGapDelta(CLOSED_REAL, OPENED_REAL);
    expect(r.persisted).toHaveLength(1);
    expect(r.opened.map((x) => x.anchor)).toEqual(["PRIV-JANELA-01"]);
  });

  it("resposta não-JSON ⇒ `reconciled: false` com as listas CRUAS e motivo declarado", async () => {
    post.mockResolvedValue(JSON.stringify({ response: "não consegui", model_used: "haiku-4-5" }));
    const r = await reconcileGapDelta(CLOSED_REAL, OPENED_REAL);
    expect(r.reconciled).toBe(false);
    expect(r.reason).toMatch(/não era JSON/);
    expect(r.closed).toHaveLength(2);
    expect(r.opened).toHaveLength(2);
    expect(r.persisted).toHaveLength(0);
  });

  it("falha de rede NÃO inventa reconciliação — fail-closed declarado", async () => {
    post.mockRejectedValue(new Error("ETIMEDOUT"));
    const r = await reconcileGapDelta(CLOSED_REAL, OPENED_REAL);
    expect(r.reconciled).toBe(false);
    expect(r.reason).toMatch(/ETIMEDOUT/);
    expect(r.closed).toHaveLength(2);
  });

  it("sem `API_AGENTS_URL` não chama nada e devolve o diff cru", async () => {
    delete process.env.API_AGENTS_URL;
    const r = await reconcileGapDelta(CLOSED_REAL, OPENED_REAL);
    expect(r.reconciled).toBe(false);
    expect(r.reason).toMatch(/API_AGENTS_URL/);
    expect(post).not.toHaveBeenCalled();
  });

  it("um dos lados vazio é reconciliado por CONSTRUÇÃO, sem gastar LLM", async () => {
    const a = await reconcileGapDelta(CLOSED_REAL, []);
    expect(a.reconciled).toBe(true);
    expect(a.persisted).toHaveLength(0);
    expect(a.closed).toHaveLength(2);
    const b = await reconcileGapDelta([], OPENED_REAL);
    expect(b.reconciled).toBe(true);
    expect(b.opened).toHaveLength(2);
    expect(post).not.toHaveBeenCalled();
  });

  it("o prompt leva âncora e arquivo dos dois lados — é o que distingue rebatismo de defeito novo", async () => {
    reply([]);
    await reconcileGapDelta(CLOSED_REAL, OPENED_REAL);
    const body = JSON.parse(String(post.mock.calls[0][1])) as { user_message: string; prompt_override: string; temperature: number };
    expect(body.user_message).toContain("âncora=§6.1");
    expect(body.user_message).toContain("âncora=§6");
    expect(body.user_message).toContain("arquivo=privacidade-lgpd.md");
    expect(body.user_message).toContain("(A) PROBLEMAS QUE DESAPARECERAM");
    expect(body.user_message).toContain("(B) PROBLEMAS QUE APARECERAM");
    // Critério estrito e defesa contra injeção fazem parte do contrato, não do estilo.
    expect(body.prompt_override).toContain("corrigir um necessariamente corrigir o outro");
    expect(body.prompt_override).toContain("NÃO-CONFIÁVEL");
    expect(body.temperature).toBe(0);
  });

  it("modelo default vem COM versão — o apelido curto é 400 no Bedrock", async () => {
    reply([]);
    await reconcileGapDelta(CLOSED_REAL, OPENED_REAL);
    const body = JSON.parse(String(post.mock.calls[0][1])) as { model_id: string };
    expect(body.model_id).toMatch(/-v\d+:\d+$/);
  });

  it("excedente do teto é DECLARADO em `truncated`, não pareado às cegas", async () => {
    const many = Array.from({ length: 45 }, (_, i) => f({ anchor: `§${i}`, title: `defeito ${i}` }));
    reply([]);
    const r = await reconcileGapDelta(many, OPENED_REAL);
    expect(r.truncated).toBe(5);
    expect(r.reason).toMatch(/acima do teto/);
    // Ninguém foi perdido: os 45 fechados continuam nas contagens.
    expect(r.closed).toHaveLength(45);
  });
});

/**
 * 🔴 C2 — o MESMO defeito contado 3× DENTRO de uma validação.
 *
 * Réplica do caso REAL medido em prod (NVX LastMile, validação de 2026-09-07 05:08): o par
 * `code`/HTTP da reexecução de eliminação veio três vezes, com três âncoras e títulos quase
 * idênticos. A contagem que o laço persegue já nascia inflada.
 */
describe("C2 — colapso de duplicata dentro de uma validação", () => {
  const OLD_URL = process.env.API_AGENTS_URL;
  let post: MockInstance<(url: string, body: string, timeoutMs?: number) => Promise<string>>;

  beforeEach(() => {
    process.env.API_AGENTS_URL = "http://agents:8000";
    post = vi.spyOn(specs, "httpPost");
  });
  afterEach(() => {
    post.mockRestore();
    if (OLD_URL === undefined) delete process.env.API_AGENTS_URL;
    else process.env.API_AGENTS_URL = OLD_URL;
  });

  const reply = (groups: unknown) =>
    post.mockResolvedValue(JSON.stringify({ response: JSON.stringify({ groups }), model_used: "haiku-4-5" }));

  // Os três literais reais, na ordem em que a validação os reportou.
  const TRIPLICADO = [
    f({ file: "privacidade-lgpd.md", anchor: "### 3.1 POST /api/privacy/erasure-requests", title: "Reexecução de eliminação define dois pares (code,HTTP) incompatíveis" }),
    f({ file: "privacidade-lgpd.md", anchor: "§3.1 POST /api/privacy/erasure-requests", title: "Reexecução de eliminação define dois pares (code, HTTP)" }),
    f({ file: "privacidade-lgpd.md", anchor: "§3.1", title: "Dois pares (code, HTTP) para a mesma reexecução" }),
  ];

  it("🔴 o defeito triplicado vira UM, e a fusão cita os DOIS literais", async () => {
    reply([{ keep: "f1", drop: ["f2", "f3"], why: "mesma contradição, âncora reescrita pelo juiz" }]);
    const r = await collapseDuplicateFindings(TRIPLICADO);
    expect(r.ran).toBe(true);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].anchor).toBe("### 3.1 POST /api/privacy/erasure-requests");
    expect(r.collapsed).toHaveLength(2);
    // Auditabilidade: cada registro carrega o literal do que FICOU e do que SAIU.
    expect(r.collapsed[0].kept.anchor).toBe("### 3.1 POST /api/privacy/erasure-requests");
    expect(r.collapsed[0].dropped.anchor).toBe("§3.1 POST /api/privacy/erasure-requests");
    expect(r.collapsed[1].dropped.anchor).toBe("§3.1");
    expect(r.collapsed[0].why).toMatch(/âncora reescrita/);
    expect(r.model).toBe("haiku-4-5");
    expect(r.vetoed).toEqual([]);
  });

  it("a ordem original sobrevive ao colapso (o log da validação continua legível)", async () => {
    const lista = [f({ title: "A" }), ...TRIPLICADO, f({ title: "Z" })];
    reply([{ keep: "f2", drop: ["f3", "f4"], why: "mesmo defeito" }]);
    const r = await collapseDuplicateFindings(lista);
    expect(r.findings.map((x) => x.title)).toEqual(["A", TRIPLICADO[0].title, "Z"]);
  });

  it("nenhum grupo proposto: a lista sai intacta e `ran` é true (procurou e não achou)", async () => {
    reply([]);
    const r = await collapseDuplicateFindings(TRIPLICADO);
    expect(r.ran).toBe(true);
    expect(r.findings).toHaveLength(3);
    expect(r.collapsed).toEqual([]);
  });

  it("🔴 agente indisponível: lista CRUA e `ran: false` — nunca colapso por semelhança de string", async () => {
    post.mockRejectedValue(new Error("timeout"));
    const r = await collapseDuplicateFindings(TRIPLICADO);
    expect(r.ran).toBe(false);
    expect(r.findings).toHaveLength(3);
    expect(r.reason).toMatch(/chamada ao agente falhou/);
  });

  it("resposta não-JSON: lista CRUA e `ran: false`", async () => {
    post.mockResolvedValue(JSON.stringify({ response: "não consegui agrupar", model_used: "haiku-4-5" }));
    const r = await collapseDuplicateFindings(TRIPLICADO);
    expect(r.ran).toBe(false);
    expect(r.findings).toHaveLength(3);
    expect(r.reason).toMatch(/não era JSON/);
  });

  it("sem `API_AGENTS_URL` não inventa colapso", async () => {
    delete process.env.API_AGENTS_URL;
    const r = await collapseDuplicateFindings(TRIPLICADO);
    expect(r.ran).toBe(false);
    expect(r.findings).toHaveLength(3);
  });

  it("menos de 2 findings: nem chama o agente (custo sem pergunta)", async () => {
    const r = await collapseDuplicateFindings([TRIPLICADO[0]]);
    expect(r.ran).toBe(true);
    expect(post).not.toHaveBeenCalled();
    expect(r.findings).toHaveLength(1);
  });

  // ── os cinco vetos de corrupção ────────────────────────────────────────────────────────────────

  it("🔴 VETO: agrupar entre ARQUIVOS diferentes — cada arquivo precisa da própria correção", async () => {
    const cruzado = [
      f({ file: "privacidade-lgpd.md", anchor: "§3.1", title: "prazo de retenção divergente" }),
      f({ file: "modelo-dados.md", anchor: "§6", title: "prazo de retenção divergente" }),
    ];
    reply([{ keep: "f1", drop: ["f2"], why: "é a mesma contradição" }]);
    const r = await collapseDuplicateFindings(cruzado);
    expect(r.findings).toHaveLength(2);
    expect(r.collapsed).toEqual([]);
    expect(r.vetoed[0].veto).toMatch(/arquivos diferentes/);
  });

  it("🔴 VETO: colapsar um BLOCKER num warning rebaixaria a severidade", async () => {
    const misto = [
      f({ severity: "warning", anchor: "§3.1", title: "par (code,HTTP) ambíguo" }),
      f({ severity: "blocker", anchor: "§3.1 POST", title: "par (code,HTTP) ambíguo" }),
    ];
    reply([{ keep: "f1", drop: ["f2"], why: "mesmo defeito" }]);
    const r = await collapseDuplicateFindings(misto);
    expect(r.findings).toHaveLength(2);
    expect(r.vetoed[0].veto).toMatch(/rebaixaria a severidade/);
  });

  it("blocker como sobrevivente é ACEITO — o veto é só contra o rebaixamento", async () => {
    const misto = [
      f({ severity: "blocker", anchor: "§3.1 POST", title: "par (code,HTTP) ambíguo" }),
      f({ severity: "warning", anchor: "§3.1", title: "par (code,HTTP) ambíguo" }),
    ];
    reply([{ keep: "f1", drop: ["f2"], why: "mesmo defeito" }]);
    const r = await collapseDuplicateFindings(misto);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].severity).toBe("blocker");
  });

  it("🔴 VETO: finding do ORÁCULO (execução real) nunca é colapsado em leitura de spec", async () => {
    const comOraculo = [
      f({ source: "stage_b", anchor: "§7", title: "healthcheck não declarado" }),
      f({ source: "oracle", anchor: "§7", title: "healthcheck não declarado — container subiu unhealthy" }),
    ];
    reply([{ keep: "f1", drop: ["f2"], why: "mesmo defeito" }]);
    const r = await collapseDuplicateFindings(comOraculo);
    expect(r.findings).toHaveLength(2);
    expect(r.vetoed[0].veto).toMatch(/EXECUÇÃO REAL/);
  });

  it("🔴 VETO: id inventado pelo modelo derruba o grupo inteiro", async () => {
    reply([{ keep: "f1", drop: ["f99"], why: "mesmo defeito" }]);
    const r = await collapseDuplicateFindings(TRIPLICADO);
    expect(r.findings).toHaveLength(3);
    expect(r.vetoed[0].veto).toMatch(/não existe na lista/);
  });

  it("🔴 VETO: o mesmo id em dois grupos — senão um item sumiria duas vezes", async () => {
    reply([
      { keep: "f1", drop: ["f2"], why: "mesmo defeito" },
      { keep: "f3", drop: ["f2"], why: "também é o mesmo" },
    ]);
    const r = await collapseDuplicateFindings(TRIPLICADO);
    // O 1º grupo passa (f2 sai), o 2º é vetado por reuso de f2.
    expect(r.findings).toHaveLength(2);
    expect(r.collapsed).toHaveLength(1);
    expect(r.vetoed[0].veto).toMatch(/já foi usado/);
  });

  it("🔴 VETO: `keep` dentro do próprio `drop` (o item se apagaria)", async () => {
    reply([{ keep: "f1", drop: ["f1", "f2"], why: "mesmo defeito" }]);
    const r = await collapseDuplicateFindings(TRIPLICADO);
    expect(r.findings).toHaveLength(3);
    expect(r.vetoed[0].veto).toMatch(/também está na lista de removidos/);
  });

  it("grupo vetado NÃO impede o grupo válido seguinte (veto é por grupo, não por resposta)", async () => {
    const lista = [...TRIPLICADO, f({ file: "outro.md", anchor: "§1", title: "X" }), f({ file: "outro.md", anchor: "§1.1", title: "X" })];
    reply([
      { keep: "f1", drop: ["f9"], why: "id que não existe" },
      { keep: "f4", drop: ["f5"], why: "mesma seção renumerada" },
    ]);
    const r = await collapseDuplicateFindings(lista);
    expect(r.collapsed).toHaveLength(1);
    expect(r.vetoed).toHaveLength(1);
    expect(r.findings).toHaveLength(4);
  });

  it("acima do teto: o excedente é DECLARADO e fica fora da comparação (nunca colapsado às cegas)", async () => {
    const muitos = Array.from({ length: 65 }, (_, i) => f({ anchor: `§${i}`, title: `defeito ${i}` }));
    reply([]);
    const r = await collapseDuplicateFindings(muitos);
    expect(r.truncated).toBe(5);
    expect(r.reason).toMatch(/acima do teto/);
    expect(r.findings).toHaveLength(65); // ninguém perdido
  });
});

describe("parseCollapseGroups", () => {
  it("extrai grupos de JSON puro e de dentro de cerca de código", () => {
    expect(parseCollapseGroups('{"groups":[{"keep":"f1","drop":["f2"],"why":"igual"}]}'))
      .toEqual([{ keep: "f1", drop: ["f2"], why: "igual" }]);
    expect(parseCollapseGroups('```json\n{"groups":[{"keep":"f3","drop":["f4","f5"]}]}\n```'))
      .toEqual([{ keep: "f3", drop: ["f4", "f5"], why: "" }]);
  });
  it("grupo sem ninguém para remover é ignorado (não colapsa nada)", () => {
    expect(parseCollapseGroups('{"groups":[{"keep":"f1","drop":[]}]}')).toEqual([]);
  });
  it("devolve null quando não há JSON — sem inventar grupo", () => {
    expect(parseCollapseGroups("não achei duplicata")).toBeNull();
    expect(parseCollapseGroups("")).toBeNull();
  });
});
