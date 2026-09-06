/**
 * A5.5 (2026-09-06) — o irmão CITADO pelo GAP vai como contexto só-leitura.
 *
 * ## O que foi medido (NVX LastMile, prod, run `dd587b75` passe 1)
 *
 * O "Resolver GAPs por arquivo" funcionou no nível do ARQUIVO (21 findings resolvidos, entre eles os
 * 9 de `privacidade-lgpd.md` que antes falhavam 4/4) e **falhou no nível da SPEC**: a contagem de GAPs
 * importantes subiu de 20 → 24, com 24 findings NOVOS. O par mais claro:
 *
 *  • RESOLVIDO em `api-entregas-entregadores.md`: "Conflito de status HTTP para VALIDATION_ERROR: 422 vs 400";
 *  • NOVO em `definicao-de-pronto.md`: "Status HTTP de erro de validação divergente: 400 vs 422".
 *
 * Ou seja: o CTO-editor **escolheu um valor** para resolver o conflito dentro do arquivo que estava
 * editando; como não via o irmão, a contradição não foi resolvida — foi MOVIDA. Cada rodada paga LLM
 * para empurrar o mesmo conflito de arquivo em arquivo, e o laço nunca converge.
 *
 * ## O que este módulo faz
 *
 * Seleciona, por CITAÇÃO LITERAL, os arquivos irmãos que os próprios GAPs mencionam (medido: 19 de 25
 * findings citam um `.md` no `rationale`) e os entrega como bloco SÓ LEITURA, mais o índice primário
 * quando sobra orçamento. A seleção é determinística — é transporte de fato ("o GAP cita este
 * arquivo"), não julgamento: o que fazer com a divergência continua sendo decisão do agente.
 *
 * ## A5.6 — por que o recorte deixou de ser head-truncate
 *
 * A primeira versão mandava os primeiros 20k chars de cada irmão. Medido no run `75b3cf5d` (a rodada
 * que PROVOU o A5.5 em prod): com arquivos de ~20k, **só 2 irmãos citados cabiam** e em
 * `modelo-dados.md` **8 ficaram de fora** — e os 20k gastos eram justamente o começo do arquivo, que
 * raramente é onde mora a regra em disputa. Agora o irmão grande vira RESUMO DIRIGIDO: sumário
 * COMPLETO de cabeçalhos (para o modelo saber o que existe) + só as seções que mencionam os termos que
 * o GAP coloca em disputa. Mesmo orçamento, mais irmãos e sinal melhor.
 */
import { readFile } from "node:fs/promises";
import { splitSections, clipSection, headingOutline } from "../lib/markdownSections.js";
import type { ValidationFinding } from "./specValidation.js";

/** Orçamento total do bloco de irmãos. ~21k tokens: cabe com o arquivo (≤120k chars) na janela. */
export const SIBLING_TOTAL_BUDGET = 60_000;
/** Teto por irmão, para um arquivo gigante não comer o orçamento dos outros citados. */
export const SIBLING_FILE_BUDGET = 12_000;
/** Abaixo disto o irmão vai INTEIRO — recortar um arquivo pequeno só cria risco de omitir a regra. */
export const SIBLING_FILE_FULL_MAX = 8_000;
/** Teto de uma seção dentro do resumo, para uma seção quilométrica não virar o resumo todo. */
export const SIBLING_SECTION_BUDGET = 3_000;

export interface SiblingRef {
  path: string;
  filename: string;
  filePath: string;
  isPrimary: boolean;
}

export interface SiblingContext {
  /** Bloco pronto para o prompt (vazio quando não há irmão citado nem orçamento). */
  block: string;
  /** Paths efetivamente incluídos, em ordem — vai para o log da rodada. */
  used: string[];
  /** Paths citados que NÃO couberam no orçamento (o modelo é avisado no bloco). */
  omitted: string[];
}

/** Texto onde procurar citações: título + motivo + âncora de cada GAP. */
function findingsText(findings: ValidationFinding[]): string {
  return findings
    .map((f) => `${f.title}\n${f.rationale ?? ""}\n${(f as { anchor?: string | null }).anchor ?? ""}`)
    .join("\n")
    .toLowerCase();
}

/**
 * Quantas vezes os GAPs citam este irmão. Conta pelo `path` E pelo `filename` porque o validador
 * escreve das duas formas (`tecnico/modelo-dados.md` e `modelo-dados.md`).
 */
function citations(text: string, ref: SiblingRef): number {
  const needles = new Set([ref.path.toLowerCase(), ref.filename.toLowerCase()]);
  let n = 0;
  for (const needle of needles) {
    if (!needle) continue;
    let i = text.indexOf(needle);
    while (i !== -1) { n += 1; i = text.indexOf(needle, i + needle.length); }
  }
  return n;
}

/**
 * A5.6 — TERMOS EM DISPUTA extraídos do próprio GAP.
 *
 * O head-truncate do A5.5 gastava 20k chars nas PRIMEIRAS linhas do irmão, que raramente são onde a
 * regra contestada mora — e com isso só 2 irmãos citados caíam no orçamento (medido em prod:
 * `modelo-dados.md` deixou 8 de fora). Estes termos são o que o GAP literalmente coloca em disputa:
 * identificadores entre backticks, códigos em CAIXA_ALTA e números de 3–4 dígitos (é assim que
 * "422 vs 400" e "VALIDATION_ERROR" aparecem). Servem para escolher QUAIS seções do irmão mostrar.
 */
export function disputedTerms(findings: ValidationFinding[]): string[] {
  const text = findings
    .map((f) => `${f.title}\n${f.rationale ?? ""}`)
    .join("\n");
  const terms = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]{2,60})`/g)) terms.add(m[1].toLowerCase());
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)) terms.add(m[0].toLowerCase());
  for (const m of text.matchAll(/\b\d{3,4}\b/g)) terms.add(m[0]);
  return [...terms];
}

/**
 * A5.7/GAP-7: o recorte por seção vive em `lib/markdownSections.ts` porque o arquivo ALVO passou a
 * precisar exatamente do mesmo comportamento. Duas réguas diferentes fariam o modelo montar um
 * `SEARCH` que não casa no arquivo.
 */
const sections = splitSections;
const clip = clipSection;

/**
 * Recorte de UM irmão. Arquivo pequeno vai inteiro; grande vira RESUMO DIRIGIDO: o sumário completo
 * de cabeçalhos (para o modelo saber o que existe) + só as seções que mencionam os termos em disputa.
 *
 * O aviso é obrigatório nos dois casos de corte: sem ele o modelo concluiria "o irmão não define
 * isso" e escreveria a regra de novo no arquivo errado — trocaria uma divergência por uma duplicação
 * normativa, que é o mesmo defeito com outro nome.
 */
function excerpt(path: string, content: string, terms: string[]): { text: string; truncated: boolean } {
  if (content.length <= SIBLING_FILE_FULL_MAX) return { text: content, truncated: false };

  const secs = sections(content);
  const outline = headingOutline(secs);
  const scored = secs
    .map((s, i) => {
      const hay = s.body.toLowerCase();
      let hits = 0;
      for (const t of terms) if (t && hay.includes(t)) hits += 1;
      return { i, s, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.i - b.i);

  if (scored.length > 0) {
    const parts: string[] = [];
    let spent = outline.length;
    // Ordem de LEITURA (i crescente) depois de escolher por relevância: o arquivo continua fazendo
    // sentido de cima para baixo, o que importa quando as seções se referenciam entre si.
    const chosen: typeof scored = [];
    for (const x of scored) {
      const body = clip(x.s.body, SIBLING_SECTION_BUDGET);
      if (spent + body.length > SIBLING_FILE_BUDGET) continue;
      spent += body.length;
      chosen.push(x);
    }
    if (chosen.length > 0) {
      for (const x of chosen.sort((a, b) => a.i - b.i)) parts.push(clip(x.s.body, SIBLING_SECTION_BUDGET));
      return {
        text: [
          `[RESUMO DIRIGIDO de \`${path}\` (${content.length} chars) — abaixo, o SUMÁRIO COMPLETO de seções e,`,
          "em seguida, apenas as seções que mencionam o que o GAP disputa. Uma regra pode existir numa seção",
          "NÃO transcrita: o sumário diz o que existe, então não conclua que o irmão "
            + "silencia sobre um assunto listado ali.]",
          "",
          "SUMÁRIO DE SEÇÕES:",
          outline,
          "",
          "SEÇÕES RELEVANTES:",
          parts.join("\n\n"),
        ].join("\n"),
        truncated: true,
      };
    }
  }

  // Nenhum termo casou (ou nada caberia): volta ao head-truncate, que ao menos preserva o começo.
  return {
    text: `${content.slice(0, SIBLING_FILE_BUDGET)}\n\n[… \`${path}\` truncado aqui (${content.length} chars no total) — a ausência de um trecho neste recorte NÃO significa que ele não exista no arquivo …]`,
    truncated: true,
  };
}

/**
 * Monta o bloco de irmãos citados pelos GAPs deste arquivo.
 *
 * Ordem: mais citado primeiro (é o que o GAP realmente discute); o índice primário entra por último e
 * só se sobrar orçamento (ele situa, não normatiza). O arquivo alvo NUNCA entra — ele já vai inteiro
 * como conteúdo a editar.
 */
export async function buildSiblingContext(
  files: SiblingRef[],
  targetPath: string,
  findings: ValidationFinding[],
  opts: { totalBudget?: number } = {},
): Promise<SiblingContext> {
  const budget = opts.totalBudget ?? SIBLING_TOTAL_BUDGET;
  const text = findingsText(findings);
  const others = files.filter((f) => f.path !== targetPath);
  const cited = others
    .map((f) => ({ ref: f, n: citations(text, f) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.ref.path.localeCompare(b.ref.path))
    .map((x) => x.ref);
  const primary = others.find((f) => f.isPrimary);
  const queue = primary && !cited.includes(primary) ? [...cited, primary] : cited;

  const terms = disputedTerms(findings);
  const parts: string[] = [];
  const used: string[] = [];
  const omitted: string[] = [];
  let spent = 0;
  for (const ref of queue) {
    const raw = await readFile(ref.filePath, "utf-8").catch(() => null);
    if (raw === null) continue;
    const { text: body } = excerpt(ref.path, raw, terms);
    if (spent + body.length > budget) { omitted.push(ref.path); continue; }
    spent += body.length;
    used.push(ref.path);
    parts.push(`─── IRMÃO SÓ LEITURA: \`${ref.path}\`${ref.isPrimary ? " (índice da spec)" : ""} ───\n${body}`);
  }
  if (parts.length === 0) return { block: "", used, omitted };
  const warn = omitted.length
    ? `\n[… ${omitted.length} outro(s) arquivo(s) citado(s) não couberam nesta rodada: ${omitted.join(", ")} …]`
    : "";
  return { block: `${parts.join("\n\n")}${warn}`, used, omitted };
}
