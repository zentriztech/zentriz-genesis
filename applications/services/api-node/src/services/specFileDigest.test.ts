/**
 * A5.7 / GAP-7 — o arquivo ALVO grande entra RECORTADO em vez de sair da fila.
 *
 * O defeito medido em prod (run `75b3cf5d`, rodada 13): `modelo-dados.md` passou de 126.742 chars,
 * bateu no teto de 120.000 e **saiu da fila com os GAPs dele ativos** — e não nasceu grande, o próprio
 * CTO-editor o inflou rodada a rodada. Cada teste aqui trava uma propriedade sem a qual o recorte
 * seria pior que a recusa: mostrar a seção que o GAP aponta, mostrar VERBATIM (senão o `SEARCH` não
 * casa) e nunca deixar o modelo achar que o que não foi transcrito não existe.
 */
import { describe, it, expect } from "vitest";
import { buildFileDigest, TARGET_SECTION_BUDGET } from "./specFileDigest.js";
import type { ValidationFinding } from "./specValidation.js";

const CAP = 20_000;

function gap(title: string, rationale: string, anchor?: string): ValidationFinding {
  return { severity: "blocker", title, rationale, anchor } as unknown as ValidationFinding;
}

/** Enchimento identificável por seção — é como se distingue o que entrou do que ficou de fora. */
const filler = (tag: string, n: number) => `${`${tag} `.repeat(n)}\n`;

const BIG = [
  "# Modelo de dados",
  filler("abertura", 800),
  "## 1. Entidade Entrega",
  "O campo `status_entrega` é enum: PENDENTE, EM_ROTA, ENTREGUE.",
  filler("entrega", 200),
  "## 2. Paginação",
  filler("paginacao", 800),
  "## 3. Auditoria",
  filler("auditoria", 800),
].join("\n");

describe("buildFileDigest", () => {
  it("arquivo que CABE no teto não é tocado (recortar o que cabe só arrisca esconder o trecho a mudar)", () => {
    const d = buildFileDigest("m.md", "# M\n\nconteúdo curto.", [gap("x", "y")], CAP);
    expect(d.digested).toBe(false);
    expect(d.text).toBe("# M\n\nconteúdo curto.");
  });

  it("acima do teto: a seção apontada pelo GAP entra VERBATIM e as outras não gastam orçamento", () => {
    const d = buildFileDigest(
      "modelo-dados.md",
      BIG,
      [gap("Enum divergente", "O campo `status_entrega` contradiz o contrato de API.")],
      CAP,
    );
    expect(d.digested).toBe(true);
    expect(d.text).toContain("O campo `status_entrega` é enum: PENDENTE, EM_ROTA, ENTREGUE.");
    expect(d.text).not.toContain("paginacao paginacao");
    expect(d.text).not.toContain("auditoria auditoria");
    expect(d.text.length).toBeLessThan(CAP);
    expect(d.used).toBe(1);
    expect(d.total).toBeGreaterThan(1);
  });

  it("o sumário lista TODAS as seções — inclusive as não transcritas", () => {
    const d = buildFileDigest("modelo-dados.md", BIG, [gap("x", "`status_entrega`")], CAP);
    expect(d.text).toContain("SUMÁRIO DE SEÇÕES");
    expect(d.text).toContain("## 2. Paginação");
    expect(d.text).toContain("## 3. Auditoria");
  });

  it("as REGRAS do recorte vão no bloco (sem elas o modelo recria a seção que não viu)", () => {
    const d = buildFileDigest("modelo-dados.md", BIG, [gap("x", "`status_entrega`")], CAP);
    expect(d.text).toContain("NÃO recrie uma seção");
    expect(d.text).toContain("byte a byte igual ao arquivo");
    expect(d.text).toContain("diga isso na linha final");
  });

  it("a ÂNCORA do validador também seleciona a seção (é o endereço que ele achou do problema)", () => {
    const d = buildFileDigest("modelo-dados.md", BIG, [gap("Falta índice", "sem detalhe", "## 3. Auditoria")], CAP);
    expect(d.text).toContain("auditoria auditoria");
    expect(d.text).not.toContain("paginacao paginacao");
  });

  it("nenhum termo casou → mostra o INÍCIO com aviso de que o resto continua existindo", () => {
    const d = buildFileDigest("modelo-dados.md", BIG, [gap("Falta rigor", "melhore a redação")], CAP);
    expect(d.digested).toBe(true);
    expect(d.used).toBe(0);
    expect(d.text).toContain("SUMÁRIO DE SEÇÕES");
    expect(d.text).toContain("CONTINUA existindo no arquivo");
    expect(d.text).toContain("abertura abertura");
    expect(d.text.length).toBeLessThan(CAP);
  });

  it("seção quilométrica é truncada com marcador (uma seção não pode virar o recorte todo)", () => {
    const gigante = [
      "# G",
      "## 1. Enorme",
      `O campo \`status_entrega\` manda. ${"z".repeat(TARGET_SECTION_BUDGET + 5_000)}`,
      "## 2. Outra",
      filler("outra", 1_500),
    ].join("\n");
    // Teto folgado o bastante para a seção CLIPADA caber — o que se testa é o corte, não o orçamento.
    const d = buildFileDigest("g.md", gigante, [gap("x", "`status_entrega`")], 34_000);
    expect(gigante.length).toBeGreaterThan(34_000);
    expect(d.text).toContain("[… seção truncada …]");
  });
});

/**
 * 🔴 GAP-72 — a seleção por RELEVÂNCIA mandava o CTO corrigir o que ele não estava vendo.
 *
 * Medido em prod (run `95ba8636`, `modelo-dados.md` 215.168 chars / 57 seções, 11 GAPs ancorados):
 * `## Convenções gerais` (31.012 chars, 71 termos) comeu 34% do orçamento e 5 seções gastaram 89.789 de
 * 90.000 — **8 das 11 seções endereçadas pelos GAPs ficaram fora do prompt**, exatamente as 8 âncoras
 * que o GAP-71 media como byte-a-byte INTOCADAS (correlação 11/11). As 8 somam 35.413 chars: cabiam
 * folgadas. Era defeito de ORDEM, não de orçamento. Cada teste abaixo trava uma parte da ordem nova.
 */
function warn(title: string, rationale: string, anchor?: string): ValidationFinding {
  return { severity: "warning", title, rationale, anchor } as unknown as ValidationFinding;
}

/**
 * Réplica mínima da patologia, com as proporções de prod: uma seção genérica que menciona TUDO e come
 * quase todo o orçamento (13.600 de 15.000) + três seções pequenas (≈900 cada) que são as ENDEREÇADAS.
 * Na ordem antiga (só relevância) a genérica entrava primeiro e sobrava orçamento para UMA ancorada;
 * na ordem nova as três entram e a genérica é que fica de fora. A cauda sem termos só existe para o
 * arquivo passar do teto (senão o recorte não acontece).
 */
const PATOLOGIA = [
  "# Modelo de dados",
  "## Convenções gerais",
  // Superset dos identificadores em disputa — é o que a torna a mais "relevante" pela contagem de
  // acertos, exatamente como `## Convenções gerais` (71 acertos) em prod.
  "Aqui aparecem todos: `idx_rt_expires_at`, `revoked_at`, `courier_id`, `valores_sentinela`," +
  ` \`refresh_tokens\` e \`retention_job\`. ${filler("generico", 1_500)}`,
  "### 5.2 Índices e o requisito de cada um",
  `A justificativa de \`idx_rt_expires_at\` diz limpeza física, mas o job só marca \`revoked_at\`. ${filler("indices", 100)}`,
  "### 8.6 Efeito da anonimização",
  `(c) A consulta anônima por \`courier_id\` devolve os \`valores_sentinela\`. ${filler("visib", 100)}`,
  "### 11.3 Jobs de retenção",
  `A etapa C promete purga física de \`refresh_tokens\` que o \`retention_job\` não faz. ${filler("retencao", 100)}`,
  "## 99. Apêndice sem relação",
  filler("cauda", 700),
].join("\n");

describe("buildFileDigest — cobertura garantida das seções ancoradas (GAP-72)", () => {
  const CAP_P = 20_000; // orçamento = 15.000

  it("a seção ENDEREÇADA pela âncora entra mesmo quando uma seção genérica tem mais termos", () => {
    const findings = [
      gap("Índice mente", "`idx_rt_expires_at` promete o que só `revoked_at` faz", "§5.2"),
      gap("Sentinela executável", "a consulta por `courier_id` devolve `valores_sentinela`", "§8.6 (c)"),
      gap("Etapa C", "purga de `refresh_tokens` que o `retention_job` não faz", "§11.3 etapa C"),
    ];
    const d = buildFileDigest("modelo-dados.md", PATOLOGIA, findings, CAP_P);
    expect(d.digested).toBe(true);
    // As TRÊS seções ancoradas — no comportamento antigo a genérica comia o orçamento e sobrava uma só.
    expect(d.text).toContain("indices indices");
    expect(d.text).toContain("visib visib");
    expect(d.text).toContain("retencao retencao");
    expect(d.anchored).toBe(3);
    expect(d.anchorsLocated).toBe(3);
    expect(d.anchorsDropped).toEqual([]);
    expect(d.text.length).toBeLessThan(CAP_P);
  });

  it("duas âncoras na MESMA seção contam uma seção só (o orçamento não paga duas vezes)", () => {
    const findings = [
      gap("a", "x", "§5.2"),
      gap("b", "y", "§5.2 índices"),
    ];
    const d = buildFileDigest("modelo-dados.md", PATOLOGIA, findings, CAP_P);
    expect(d.anchored).toBe(1);
    expect(d.anchorsLocated).toBe(1);
  });

  it("âncora que o código não endereça é DECLARADA, nunca contada como coberta", () => {
    const d = buildFileDigest("modelo-dados.md", PATOLOGIA, [gap("x", "y", "PRIV-XYZ-99")], CAP_P);
    expect(d.anchorsUnlocatable).toEqual(["PRIV-XYZ-99"]);
    expect(d.anchorsLocated).toBe(0);
    expect(d.anchored).toBe(0);
  });

  it("blocker antes de warning quando só uma seção ancorada cabe", () => {
    const conteudo = [
      "# M",
      "## 1. Grande e ancorada",
      `bloqueio aqui. ${filler("grande", 200)}`,
      "## 2. Pequena e ancorada",
      `aviso aqui. ${filler("pequena", 60)}`,
      filler("cauda", 1_000),
    ].join("\n");
    // Orçamento apertado de propósito: cabe a maior (blocker) OU a menor (warning), não as duas.
    const d = buildFileDigest("m.md", conteudo, [
      gap("Contradição", "prescrições opostas", "§1"),
      warn("Redação", "melhorar", "§2"),
    ], 3_400); // orçamento = 2.550 → cabe a de ~1.400 (blocker), não as duas
    expect(d.text).toContain("grande grande");
    expect(d.anchored).toBe(1);
    expect(d.anchorsDropped).toEqual(["§2"]);
  });

  it("âncora que não caberia é declarada NO PROMPT (senão o modelo lê a ausência como inexistência)", () => {
    const d = buildFileDigest("m.md", PATOLOGIA, [
      gap("gigante", "a seção genérica é o alvo", "Convenções gerais"),
      gap("cabe", "índices", "§5.2"),
    ], 4_000);
    expect(d.anchorsDropped).toContain("Convenções gerais");
    expect(d.text).toContain("NÃO caberam no orçamento");
    expect(d.text).toContain("não anule o trecho por errata");
  });

  it("sem âncora nenhuma o comportamento por relevância é o de antes", () => {
    const d = buildFileDigest("modelo-dados.md", BIG, [gap("Enum", "`status_entrega` contradiz")], CAP);
    expect(d.anchored).toBe(0);
    expect(d.anchorsLocated).toBe(0);
    expect(d.used).toBe(1);
    expect(d.text).toContain("O campo `status_entrega` é enum: PENDENTE, EM_ROTA, ENTREGUE.");
  });
});
