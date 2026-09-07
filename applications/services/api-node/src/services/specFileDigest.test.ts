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

/**
 * 🔴 GAP-73 — a âncora chegava, a OUTRA PONTA da contradição não.
 *
 * Medido em prod na rodada seguinte ao GAP-72 (run `32992636`): âncoras 11/11 no prompt, 26 edições
 * aplicadas, −3.007 chars — e as MESMAS 12 constatações voltaram. O juiz diz por quê: o defeito
 * ancorado em `§5.2` é o literal *"Sim, quando `expires_at < NOW()`"* que mora em **§8.1**. Das 25
 * seções citadas nos `rationale`, **8 estavam fora** do recorte (as ausentes tinham 758 a 3.014 chars:
 * cabiam). Sem ver o literal, a única saída do agente é uma regra de substituição textual global —
 * errata com outro nome. Os testes abaixo travam a segunda reserva e a declaração do que não couber.
 */
const CITADA = [
  "# Modelo de dados",
  "## Convenções gerais",
  // Mesma armadilha do GAP-72: superset dos identificadores, logo a mais "relevante" pela contagem.
  "Aqui aparecem todos: `idx_rt_expires_at`, `revoked_at`, `expires_at` e `refresh_tokens`." +
  ` ${filler("generico", 1_600)}`,
  "### 5.2 Índices e o requisito de cada um",
  `A justificativa de \`idx_rt_expires_at\` fala de limpeza física. ${filler("indices", 100)}`,
  // Nenhum termo em disputa aparece aqui de propósito: pela contagem de relevância esta seção vale
  // ZERO e nunca seria escolhida — é só o texto dos GAPs que a aponta. É a forma do defeito em prod.
  "### 8.1 RN-05 — Nenhum registro físico removido",
  `A linha da tabela diz "Sim, quando expirado". ${filler("rn05", 100)}`,
  "## 99. Apêndice sem relação",
  filler("cauda", 1_500),
].join("\n");

/** O GAP ancora em §5.2 e diz, no texto, que a outra prescrição está em §8.1 — o padrão de prod. */
const OUTRA_PONTA = gap(
  "Duas prescrições para o único DELETE",
  "A justificativa de índice de §5.2 e a linha de `refresh_tokens` de §8.1 prescrevem remoção física.",
  "§5.2",
);

describe("buildFileDigest — a outra ponta da contradição (GAP-73)", () => {
  const CAP_C = 20_000; // orçamento = 15.000

  it("a seção CITADA no texto do GAP entra antes da genérica, mesmo sem ser a âncora", () => {
    const d = buildFileDigest("modelo-dados.md", CITADA, [OUTRA_PONTA], CAP_C);
    expect(d.digested).toBe(true);
    expect(d.anchored).toBe(1);
    expect(d.text).toContain("indices indices");
    // O literal que o juiz manda matar mora AQUI — antes ficava fora e sobrava só inventar errata.
    expect(d.cited).toBe(1);
    expect(d.citedLocated).toBe(1);
    expect(d.citedDropped).toEqual([]);
    expect(d.text).toContain("rn05 rn05");
    expect(d.text).not.toContain("generico generico");
  });

  it("citação com nome de OUTRO arquivo não puxa a seção homônima do alvo (mostraria o trecho errado)", () => {
    const d = buildFileDigest("modelo-dados.md", CITADA, [gap(
      "Divergência com irmão",
      "O par (`code`, HTTP) é de `contratos-erros.md` §8.1 — fonte única daquele contrato.",
      "§5.2",
    )], CAP_C);
    expect(d.citedLocated).toBe(0);
    expect(d.cited).toBe(0);
    expect(d.text).not.toContain("rn05 rn05");
  });

  it("citação pelo PRÓPRIO nome do arquivo continua valendo (auto-referência não é cross-file)", () => {
    const d = buildFileDigest("specs/modelo-dados.md", CITADA, [gap(
      "Auto-referência",
      "A linha de `modelo-dados.md` §8.1 contradiz a justificativa do índice.",
      "§5.2",
    )], CAP_C);
    expect(d.cited).toBe(1);
    expect(d.text).toContain("rn05 rn05");
  });

  it("seção citada que já é a ANCORADA não é reservada duas vezes", () => {
    const d = buildFileDigest("modelo-dados.md", CITADA, [gap(
      "Mesma seção",
      "A justificativa de §5.2 contradiz a própria §5.2.",
      "§5.2",
    )], CAP_C);
    expect(d.anchored).toBe(1);
    expect(d.citedLocated).toBe(0);
    expect(d.cited).toBe(0);
  });

  it("citada que não cabe é DECLARADA, com a proibição da substituição textual global", () => {
    // Orçamento só para a ancorada (~1.100 chars com o sumário): a citada fica de fora.
    const d = buildFileDigest("modelo-dados.md", CITADA, [OUTRA_PONTA], 2_000);
    expect(d.anchored).toBe(1);
    expect(d.cited).toBe(0);
    expect(d.citedDropped).toEqual(["§8.1"]);
    expect(d.text).toContain("outra ponta da contradição");
    expect(d.text).toContain("substituição textual global");
  });

  it("GAP sem citação nenhuma no texto não muda nada do comportamento do GAP-72", () => {
    const d = buildFileDigest("modelo-dados.md", CITADA, [gap("Índice", "`idx_rt_expires_at` mente", "§5.2")], CAP_C);
    expect(d.cited).toBe(0);
    expect(d.citedLocated).toBe(0);
    expect(d.citedDropped).toEqual([]);
    expect(d.anchored).toBe(1);
    expect(d.windowed).toBe(0);
    expect(d.text).not.toContain("[JANELA:");
  });
});

/**
 * 🔴 GAP-74 — a seção que não cabe INTEIRA passava a não vir, e travava o GAP para sempre.
 *
 * Medido em prod (run `a33a0d29`, rodada seguinte ao GAP-73): `ancoradas 9/9`, `citadas 3/4`, **10
 * edições aplicadas / 0 recusadas** — e 4 dos 10 trechos endereçados ficaram byte-a-byte IDÊNTICOS,
 * com o arquivo crescendo 2.039 chars (diff por seção: 5 seções, todas por acréscimo). O footprint dos
 * 4 GAPs que não fecharam é `§6+§7.4`, `§8.6`, `§7.4+§8.4`, `§1.3+§9`: **dois dependem de `§7.4`**, a
 * única seção grande demais (16.399 chars) para caber no orçamento — recusada nas duas rodadas. O
 * agente escrevia em outro lugar porque o lugar certo nunca chegava. Os testes abaixo travam a janela.
 */
const linhas = (tag: string, n: number): string =>
  Array.from({ length: n }, (_, k) => `${tag} linha ${k}: ${"detalhe ".repeat(6)}`).join("\n");

/**
 * Réplica da patologia: a seção ENDEREÇADA (`§7.4`) é maior que o orçamento inteiro, então nem a
 * reserva do GAP-72 nem o preenchimento por relevância conseguem trazê-la — no algoritmo anterior ela
 * saía apenas DECLARADA em `anchorsDropped`, rodada após rodada, e o GAP não tinha como fechar.
 */
const GRANDE = [
  "# Modelo de dados",
  "## Convenções gerais",
  `Nada em disputa aqui. ${filler("generico", 300)}`,
  // 🔴 GAP-79: a `§7.4` precisa de um PAI próprio. Na versão anterior deste fixture ela era filha de
  // `## Convenções gerais`, o que não existe no arquivo real (medido em prod: `## Convenções gerais`
  // ocupa as linhas 7–135 sem nenhuma subseção; a `### 7.4` mora sob `## 7. Tabela privacy_requests`,
  // linha 990). Com a âncora endereçando a SUBÁRVORE, o aninhamento irreal fundia a seção endereçada
  // com a citada e o teste deixava de exercitar o GAP-73 (duas reservas distintas).
  "## 7. Tabela `privacy_requests`",
  "### 7.4 Retenção e expurgo de tokens",
  linhas("retencao", 120),
  "O DELETE físico de `refresh_tokens` roda no expurgo trimestral.",
  linhas("expurgo", 120),
  "## 99. Apêndice",
  filler("cauda", 200),
].join("\n");

describe("buildFileDigest — janela da seção que não cabe inteira (GAP-74)", () => {
  const CAP_G = 20_000; // orçamento = 15.000; a §7.4 sozinha tem ~17k

  it("a seção endereçada que não cabe vem RECORTADA em vez de não vir", () => {
    const d = buildFileDigest("modelo-dados.md", GRANDE, [
      gap("Duas prescrições para o DELETE", "o expurgo de `refresh_tokens` contradiz a retenção", "§7.4"),
    ], CAP_G);
    expect(d.digested).toBe(true);
    // No algoritmo anterior isto era `anchorsDropped: ["§7.4"]` e `used` sem a seção.
    expect(d.anchorsDropped).toEqual([]);
    expect(d.anchorsWindowed).toEqual(["§7.4"]);
    expect(d.windowed).toBe(1);
    // O literal que o juiz manda corrigir, verbatim — é o que permite montar um SEARCH válido.
    expect(d.text).toContain("O DELETE físico de `refresh_tokens` roda no expurgo trimestral.");
    // …e só ele: se a seção inteira tivesse entrado, o orçamento teria estourado.
    expect(d.text).not.toContain("retencao linha 0:");
    expect(d.text.length).toBeLessThan(CAP_G);
  });

  it("a janela avisa que é PARCIAL (senão o modelo reescreve a seção 'completa' e perde conteúdo)", () => {
    const d = buildFileDigest("modelo-dados.md", GRANDE, [
      gap("x", "`refresh_tokens`", "§7.4"),
    ], CAP_G);
    expect(d.text).toContain("[JANELA:");
    expect(d.text).toContain("§7.4");
    expect(d.text).toContain("[… trecho omitido da mesma seção …]");
    expect(d.text).toContain("NÃO reescreva a seção inteira");
  });

  it("a mesma janela vale para a seção CITADA no texto do GAP (a outra ponta do GAP-73)", () => {
    const d = buildFileDigest("modelo-dados.md", GRANDE, [
      gap("Índice mente", "a purga de `refresh_tokens` prometida em §7.4 não acontece", "Convenções gerais"),
    ], CAP_G);
    expect(d.anchored).toBe(1); // `## Convenções gerais` cabe
    expect(d.citedWindowed).toEqual(["§7.4"]);
    expect(d.citedDropped).toEqual([]);
    expect(d.windowed).toBe(1);
    expect(d.text).toContain("O DELETE físico de `refresh_tokens` roda no expurgo trimestral.");
  });

  it("seção que não cabe NEM em janela continua DECLARADA (nunca omitida em silêncio)", () => {
    // Nenhum termo em disputa aparece dentro da seção endereçada ⇒ não há o que janelar.
    const semTermo = [
      "# M",
      "## 1. Endereçada e sem o termo",
      linhas("opaca", 300),
      // Existe só para o recorte não cair no caminho "nenhuma seção casou" — o que se testa é a §1.
      "## 2. Pequena e relevante",
      "O `courier_id` aparece aqui.",
      "## 3. Cauda",
      filler("cauda", 200),
    ].join("\n");
    const d = buildFileDigest("m.md", semTermo, [gap("x", "`courier_id` some", "§1")], CAP_G);
    expect(d.windowed).toBe(0);
    expect(d.anchorsWindowed).toEqual([]);
    expect(d.anchorsDropped).toEqual(["§1"]);
    expect(d.text).toContain("NÃO caberam no orçamento");
  });

  it("seção que cabe inteira NÃO é janelada (janela é último recurso, não o padrão)", () => {
    const d = buildFileDigest("modelo-dados.md", PATOLOGIA, [
      gap("Índice mente", "`idx_rt_expires_at` promete o que só `revoked_at` faz", "§5.2"),
    ], 20_000);
    expect(d.anchored).toBe(1);
    expect(d.windowed).toBe(0);
    expect(d.text).toContain("indices indices");
    expect(d.text).not.toContain("[JANELA:");
  });
});
