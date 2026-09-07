/**
 * A5.7 / GAP-7 (2026-09-06) — o arquivo GRANDE deixa de ser irrevisável.
 *
 * ## O que foi medido (NVX LastMile, prod, run `75b3cf5d`, rodada 13)
 *
 * ```
 * modelo-dados.md tem 126742 caracteres (teto 120000) — não cabe na janela de contexto desta rodada.
 * ```
 *
 * O arquivo **saiu da fila com os GAPs dele ativos** — e não nasceu grande: o CTO-editor só
 * ACRESCENTA (na mesma sequência, `definicao-de-pronto.md` foi de 49.362 → 56.692 chars em UMA
 * rodada). Ou seja, o próprio laço empurra os arquivos maiores contra o teto até torná-los
 * irrevisáveis, e duas recusas seguidas ainda param o laço inteiro (`MAX_FILE_FAILURES`).
 *
 * Subir o teto não resolve: com ~7k chars de crescimento por rodada, qualquer teto é alcançado. E a
 * mensagem "divida este arquivo" pede ao humano exatamente o que ele acionou o autônomo para não
 * fazer.
 *
 * ## O que este módulo faz
 *
 * No formato `edits` (blocos SEARCH/REPLACE), o modelo **não precisa ler o arquivo inteiro** — precisa
 * ler os trechos que vai mudar. Então o arquivo alvo entra como RESUMO DIRIGIDO: sumário COMPLETO de
 * cabeçalhos (o modelo sabe o que existe) + as seções que os GAPs deste arquivo apontam, VERBATIM.
 * Cada trecho mostrado é byte a byte igual ao arquivo, que é o que permite montar um `SEARCH` válido;
 * o `apply` continua rodando contra o arquivo COMPLETO no disco (`runFileChatJob` recebe o conteúdo
 * integral), então o recorte é só de LEITURA — nada é perdido na escrita.
 *
 * A seleção é determinística e é transporte de FATO ("o GAP aponta esta seção"): o que fazer com ela
 * continua sendo decisão do agente (Lei 100% LLM).
 *
 * ## Por que NÃO no formato `whole`
 *
 * Lá o modelo devolve o arquivo inteiro. Mostrar um recorte e pedir o arquivo completo produziria um
 * arquivo MUTILADO — perda de dados. Com `SPEC_GAP_FILE_EDIT_FORMAT=whole` o teto volta a valer e a
 * recusa por tamanho continua sendo o comportamento correto.
 */
import {
  splitSections, clipSection, headingOutline, scoreSections, buildAnchorIndex, locateSectionIndex,
} from "../lib/markdownSections.js";
import { disputedTerms } from "./specSiblingContext.js";
import type { ValidationFinding } from "./specValidation.js";

/** Teto de UMA seção no resumo do alvo — generoso: é a seção que o modelo vai EDITAR. */
export const TARGET_SECTION_BUDGET = 24_000;
/** Fração do teto de entrada que o resumo pode ocupar; o resto é prompt, GAPs e irmãos. */
export const TARGET_DIGEST_FRACTION = 0.75;

export interface FileDigest {
  /** Texto a mandar no lugar do conteúdo integral. */
  text: string;
  /** `false` = o arquivo caiu inteiro (nada foi recortado). */
  digested: boolean;
  /** Seções transcritas / total de seções do arquivo — vai para o log da rodada. */
  used: number;
  total: number;
  /** 🔴 GAP-72 — quantas das seções transcritas são as ENDEREÇADAS pelas âncoras dos GAPs. */
  anchored: number;
  /** Âncoras dos GAPs desta rodada que o código conseguiu endereçar a uma seção. */
  anchorsLocated: number;
  /** Âncoras endereçadas cuja seção NÃO caberia no orçamento — declaradas, nunca omitidas em silêncio. */
  anchorsDropped: string[];
  /** Âncoras que o código não endereçou a nenhuma seção (IDs cunhados pelo juiz, p.ex.). */
  anchorsUnlocatable: string[];
}

/**
 * Termos que apontam as seções relevantes: o que os GAPs colocam em disputa (identificadores,
 * códigos, números) MAIS as âncoras que o validador atribuiu — a âncora é literalmente o endereço
 * que ele achou do problema, então é o sinal mais forte que existe.
 */
function targetTerms(findings: ValidationFinding[]): string[] {
  const terms = new Set(disputedTerms(findings));
  for (const f of findings) {
    const anchor = (f as { anchor?: string | null }).anchor;
    if (!anchor) continue;
    const clean = anchor.trim().toLowerCase().replace(/^#+\s*/, "");
    if (clean.length >= 3) terms.add(clean);
  }
  return [...terms];
}

function severityRank(sev: unknown): number {
  const s = String(sev ?? "").toLowerCase();
  if (s === "blocker") return 0;
  if (s === "warning") return 1;
  return 2;
}

interface AnchoredSection {
  i: number;
  /** Corpo já recortado pelo teto de seção — é o custo real no orçamento. */
  body: string;
  anchors: string[];
  /** Peso do GAP mais grave que aponta esta seção. */
  rank: number;
}

/**
 * 🔴 GAP-72 — as seções que os GAPs desta rodada ENDEREÇAM, pela mesma régua que mede se o trecho foi
 * tocado (`locateSectionIndex`). Uma seção pode ser apontada por vários GAPs: entra uma vez, com o peso
 * do mais grave.
 */
function anchoredSections(secs: ReturnType<typeof splitSections>, findings: ValidationFinding[]): {
  picks: AnchoredSection[];
  unlocatable: string[];
} {
  const index = buildAnchorIndex(secs);
  const byIndex = new Map<number, AnchoredSection>();
  const unlocatable: string[] = [];
  const seen = new Set<string>();
  for (const f of findings) {
    const anchor = String((f as { anchor?: string | null }).anchor ?? "").trim();
    if (!anchor || seen.has(anchor)) continue;
    seen.add(anchor);
    const i = locateSectionIndex(index, anchor);
    if (i === null) { unlocatable.push(anchor); continue; }
    const rank = severityRank((f as { severity?: unknown }).severity);
    const cur = byIndex.get(i);
    if (cur) { cur.anchors.push(anchor); cur.rank = Math.min(cur.rank, rank); continue; }
    byIndex.set(i, { i, body: clipSection(secs[i].body, TARGET_SECTION_BUDGET), anchors: [anchor], rank });
  }
  return { picks: [...byIndex.values()], unlocatable };
}

/**
 * Recorta o arquivo ALVO quando ele não cabe no teto de entrada. Abaixo do teto nada muda —
 * recortar um arquivo que cabe só criaria risco de o modelo não ver o trecho que precisa mudar.
 *
 * ## 🔴 GAP-72 — a ordem de seleção mandava o CTO corrigir o que ele não estava vendo
 *
 * MEDIDO em prod (run `95ba8636`, `modelo-dados.md`, 215.168 chars / 57 seções, 11 GAPs ancorados):
 * a seleção era só `scoreSections` — número de termos distintos que a seção menciona. Isso premia
 * seção GRANDE e GENÉRICA: `## Convenções gerais` (31.012 chars, 71 hits) sozinha comeu 34% do
 * orçamento, e 5 seções consumiram 89.789 dos 90.000. Resultado: **8 das 11 seções endereçadas pelos
 * GAPs nunca entraram no prompt** — e são exatamente as **8 âncoras que ficaram byte-a-byte intocadas**
 * na rodada (correlação 11/11 com a medição do GAP-71). O CTO não estava se recusando a corrigir: não
 * tinha o texto. E o orçamento nunca foi o limite — as 8 seções somam **35.413 chars**, cabem folgadas
 * nos 90.000; o defeito era de ORDEM.
 *
 * Agora as seções ENDEREÇADAS pelas âncoras são reservadas ANTES do preenchimento por relevância, e o
 * que não couber é DECLARADO ao modelo (nome da âncora) em vez de desaparecer. Continua sendo transporte
 * de fato — "o juiz disse que o defeito está neste endereço" —, não julgamento de conteúdo.
 */
export function buildFileDigest(
  filePath: string,
  content: string,
  findings: ValidationFinding[],
  cap: number,
): FileDigest {
  const secs = splitSections(content);
  if (content.length <= cap) {
    return {
      text: content, digested: false, used: secs.length, total: secs.length,
      anchored: 0, anchorsLocated: 0, anchorsDropped: [], anchorsUnlocatable: [],
    };
  }

  const budget = Math.floor(cap * TARGET_DIGEST_FRACTION);
  const outline = headingOutline(secs);
  let spent = outline.length;
  const chosenIdx = new Set<number>();
  const chosen: Array<{ i: number; body: string }> = [];

  // 1) COBERTURA GARANTIDA: as seções que os GAPs endereçam. Blocker antes de warning; dentro do mesmo
  //    peso, a MENOR primeiro (cabem mais GAPs acionáveis na rodada); empate pela ordem do arquivo.
  const { picks, unlocatable } = anchoredSections(secs, findings);
  picks.sort((a, b) => a.rank - b.rank || a.body.length - b.body.length || a.i - b.i);
  const dropped: string[] = [];
  for (const p of picks) {
    if (spent + p.body.length > budget) { dropped.push(...p.anchors); continue; }
    spent += p.body.length;
    chosenIdx.add(p.i);
    chosen.push({ i: p.i, body: p.body });
  }
  const anchored = chosen.length;

  // 2) O que sobrou do orçamento vai para o contexto por relevância (comportamento anterior).
  for (const x of scoreSections(secs, targetTerms(findings))) {
    if (chosenIdx.has(x.i)) continue;
    const body = clipSection(x.section.body, TARGET_SECTION_BUDGET);
    if (spent + body.length > budget) continue;
    spent += body.length;
    chosenIdx.add(x.i);
    chosen.push({ i: x.i, body });
  }

  if (chosen.length === 0) {
    // Nenhuma seção casou (ou nenhuma cabe): mostrar o começo ainda permite edições válidas, porque o
    // que aparece é VERBATIM. O aviso é obrigatório — sem ele o modelo trata o corte como fim do
    // arquivo e reescreve no lugar errado.
    return {
      text: [
        `[RECORTE de \`${filePath}\` — o arquivo tem ${content.length} chars e não cabe inteiro nesta rodada.`,
        "Abaixo, o SUMÁRIO COMPLETO de seções e, em seguida, o INÍCIO do arquivo. Nenhuma seção casou com",
        "o que os GAPs apontam, então mostro o começo. Só edite trechos que você está VENDO aqui.]",
        "",
        "SUMÁRIO DE SEÇÕES:",
        outline,
        "",
        "TRECHO (verbatim, do início do arquivo):",
        content.slice(0, budget),
        "",
        `[… corte por orçamento em ${budget} de ${content.length} chars — o que não aparece CONTINUA existindo no arquivo …]`,
      ].join("\n"),
      digested: true,
      used: 0,
      total: secs.length,
      anchored: 0,
      anchorsLocated: picks.length,
      anchorsDropped: dropped,
      anchorsUnlocatable: unlocatable,
    };
  }

  // Ordem de LEITURA depois de escolher: o arquivo continua fazendo sentido de cima para baixo, o que
  // importa quando uma seção referencia a outra.
  const parts = chosen.sort((a, b) => a.i - b.i).map((x) => x.body);

  return {
    text: [
      `[RESUMO DIRIGIDO de \`${filePath}\` — o arquivo tem ${content.length} chars e NÃO cabe inteiro nesta`,
      `rodada. Abaixo, o SUMÁRIO COMPLETO de seções e, VERBATIM, as ${parts.length} seção(ões) selecionadas —`,
      `${anchored} delas é/são a(s) seção(ões) que os GAPs desta rodada ENDEREÇAM. REGRAS desta rodada:`,
      "  • cada bloco SEARCH deve copiar texto que você está VENDO aqui — é byte a byte igual ao arquivo;",
      "  • NÃO recrie uma seção que aparece no sumário e não foi transcrita: ela EXISTE no arquivo e",
      "    duplicá-la troca um GAP por uma contradição interna;",
      "  • se um GAP só puder ser resolvido numa seção que não está aqui, diga isso na linha final em vez",
      "    de adivinhar o conteúdo dela.]",
      // 🔴 GAP-72: âncora cuja seção não caberia sai DECLARADA. Sem esta linha o modelo lê a ausência
      // como "o trecho não existe" e responde com errata — a patologia do GAP-71 causada pelo recorte.
      ...(dropped.length > 0
        ? [`[ATENÇÃO: a(s) seção(ões) endereçada(s) por ${dropped.join(", ")} NÃO caberam no orçamento desta`,
           " rodada. Para esses GAPs, DECLARE na linha final que o trecho não veio — não improvise o conteúdo",
           " e não anule o trecho por errata.]"]
        : []),
      "",
      "SUMÁRIO DE SEÇÕES:",
      outline,
      "",
      "SEÇÕES APONTADAS PELOS GAPs (verbatim):",
      parts.join("\n\n"),
    ].join("\n"),
    digested: true,
    used: parts.length,
    total: secs.length,
    anchored,
    anchorsLocated: picks.length,
    anchorsDropped: dropped,
    anchorsUnlocatable: unlocatable,
  };
}
