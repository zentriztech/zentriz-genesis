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
 */
import { readFile } from "node:fs/promises";
import type { ValidationFinding } from "./specValidation.js";

/** Orçamento total do bloco de irmãos. ~21k tokens: cabe com o arquivo (≤120k chars) na janela. */
export const SIBLING_TOTAL_BUDGET = 60_000;
/** Teto por irmão, para um arquivo gigante não comer o orçamento dos outros citados. */
export const SIBLING_FILE_BUDGET = 20_000;

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

function excerpt(path: string, content: string): { text: string; truncated: boolean } {
  if (content.length <= SIBLING_FILE_BUDGET) return { text: content, truncated: false };
  // Head-truncate e AVISA: sem o aviso o modelo concluiria "o irmão não define isso" e escreveria a
  // regra de novo no arquivo errado — trocaria uma divergência por uma duplicação normativa.
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

  const parts: string[] = [];
  const used: string[] = [];
  const omitted: string[] = [];
  let spent = 0;
  for (const ref of queue) {
    const raw = await readFile(ref.filePath, "utf-8").catch(() => null);
    if (raw === null) continue;
    const { text: body } = excerpt(ref.path, raw);
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
