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
import { splitSections, clipSection, headingOutline, scoreSections } from "../lib/markdownSections.js";
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

/**
 * Recorta o arquivo ALVO quando ele não cabe no teto de entrada. Abaixo do teto nada muda —
 * recortar um arquivo que cabe só criaria risco de o modelo não ver o trecho que precisa mudar.
 */
export function buildFileDigest(
  filePath: string,
  content: string,
  findings: ValidationFinding[],
  cap: number,
): FileDigest {
  const secs = splitSections(content);
  if (content.length <= cap) return { text: content, digested: false, used: secs.length, total: secs.length };

  const budget = Math.floor(cap * TARGET_DIGEST_FRACTION);
  const outline = headingOutline(secs);
  const scored = scoreSections(secs, targetTerms(findings));

  const chosen: typeof scored = [];
  let spent = outline.length;
  for (const x of scored) {
    const body = clipSection(x.section.body, TARGET_SECTION_BUDGET);
    if (spent + body.length > budget) continue;
    spent += body.length;
    chosen.push(x);
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
    };
  }

  // Ordem de LEITURA depois de escolher por relevância: o arquivo continua fazendo sentido de cima
  // para baixo, o que importa quando uma seção referencia a outra.
  const parts = chosen
    .sort((a, b) => a.i - b.i)
    .map((x) => clipSection(x.section.body, TARGET_SECTION_BUDGET));

  return {
    text: [
      `[RESUMO DIRIGIDO de \`${filePath}\` — o arquivo tem ${content.length} chars e NÃO cabe inteiro nesta`,
      `rodada. Abaixo, o SUMÁRIO COMPLETO de seções e, VERBATIM, as ${parts.length} seção(ões) que os GAPs`,
      "apontam. REGRAS desta rodada:",
      "  • cada bloco SEARCH deve copiar texto que você está VENDO aqui — é byte a byte igual ao arquivo;",
      "  • NÃO recrie uma seção que aparece no sumário e não foi transcrita: ela EXISTE no arquivo e",
      "    duplicá-la troca um GAP por uma contradição interna;",
      "  • se um GAP só puder ser resolvido numa seção que não está aqui, diga isso na linha final em vez",
      "    de adivinhar o conteúdo dela.]",
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
  };
}
