/**
 * GAP-10 (2026-09-06) — o validador julgava 27% da spec e reprovava os outros 73% por "ausência".
 *
 * ## O que foi medido (NVX LastMile – Backend, prod, run de validação `18111140`)
 *
 * A spec tem **12 arquivos / 747.170 chars**. O estágio B mandava
 * `spec_text: specText.slice(0, 200_000)` — um corte **silencioso** no meio do 5º arquivo. O validador
 * então relatou, corretamente para o que viu e falsamente para o que existe:
 *
 * ```
 * blocker: "Spec entregue viola o próprio gate de completude: 9 dos 12 arquivos obrigatórios estão ausentes"
 * blocker: "Catálogo fechado de 26 códigos é declarado fonte única mas não está presente na spec entregue"
 * blocker: "Inventário FR/NFR/RN declarado fonte única e fechada está ausente"
 * blocker: "Documento de Definição de Pronto está truncado, reprovando-se por construção"
 * ```
 *
 * Os quatro são FANTASMAS: `contratos-erros.md` (74.196 chars) e `definicao-de-pronto.md` (87.631)
 * existem, íntegros, no disco. E o ciclo é vicioso: o CTO-editor "resolve" o fantasma ACRESCENTANDO
 * conteúdo aos arquivos que o validador vê, o que empurra ainda mais texto para além do corte e
 * produz MAIS fantasmas na rodada seguinte. Foi assim que a contagem de GAPs importantes subiu
 * 17 → 22 no passe que finalmente revisou `modelo-dados.md`.
 *
 * ## A regra que este módulo implementa
 *
 * A mesma do A5.7, aplicada à outra ponta: **cortar é aceitável, mentir sobre o corte não é.**
 *
 *  1. o INVENTÁRIO COMPLETO vai sempre — todos os arquivos, com tamanho e marca de tratamento;
 *  2. cabe INTEGRAL ⇒ vai integral (prioridade por tamanho crescente: maximiza quantos arquivos o
 *     validador vê por inteiro, e é critério de FATO, não julgamento de conteúdo);
 *  3. não cabe ⇒ vai o SUMÁRIO DE CABEÇALHOS do arquivo, marcado como tal;
 *  4. a regra "arquivo em SÓ SUMÁRIO **existe**; é proibido reportá-lo como ausente/truncado" vai
 *     escrita no prompt, porque é exatamente o erro que ele cometeu.
 *
 * O que este módulo NÃO faz: escolher o que é relevante, resumir prosa ou decidir severidade. Ele
 * transporta fatos (existe / tamanho / cabeçalhos) e o julgamento continua 100% do agente.
 */
import { splitSections, headingOutline } from "../lib/markdownSections.js";

/** Teto de entrada do estágio B (era um `slice` mudo dentro do `runStageB`). */
export const VALIDATION_INPUT_CAP = 200_000;
/** Teto do sumário de UM arquivo, para um arquivo com centenas de seções não comer o inventário. */
export const VALIDATION_OUTLINE_CAP = 6_000;

export interface ValidationInputFile {
  /** Caminho relativo como o validador deve citá-lo (`rel_dir/filename`). */
  path: string;
  content: string;
}

export interface ValidationInput {
  /** Texto final para `spec_text` — já dentro do teto, sem corte cego. */
  text: string;
  /** Arquivos enviados por inteiro. */
  full: string[];
  /** Arquivos enviados apenas como sumário de cabeçalhos. */
  outlineOnly: string[];
  /** Soma dos tamanhos de TODOS os arquivos (o que a spec realmente tem). */
  totalChars: number;
}

function outlineOf(content: string): string {
  const o = headingOutline(splitSections(content));
  return o.length > VALIDATION_OUTLINE_CAP
    ? `${o.slice(0, VALIDATION_OUTLINE_CAP)}\n[… sumário truncado …]`
    : o;
}

function inventory(
  files: ValidationInputFile[],
  fullSet: Set<string>,
  totalChars: number,
  cut: boolean,
): string {
  const lines = files.map((f) => {
    const mark = fullSet.has(f.path) ? "INTEGRAL" : "SÓ SUMÁRIO";
    return `  • \`${f.path}\` — ${f.content.length} chars — ${mark}`;
  });
  const head = [
    `[INVENTÁRIO DA SPEC — ${files.length} arquivo(s), ${totalChars} chars no total.`,
    "Todos os arquivos listados abaixo EXISTEM no repositório da spec.]",
    "",
    ...lines,
  ];
  if (!cut) return head.join("\n");
  return [
    ...head,
    "",
    "[REGRAS DESTA VALIDAÇÃO — a spec não cabe inteira na janela desta chamada:",
    "  • os arquivos marcados `SÓ SUMÁRIO` vão apenas com a lista de cabeçalhos. Eles EXISTEM e estão",
    "    ÍNTEGROS: é PROIBIDO reportá-los como ausentes, faltando, truncados ou não entregues;",
    "  • também é proibido concluir que uma definição não existe só porque você não a viu: se ela",
    "    deveria estar num arquivo `SÓ SUMÁRIO`, isso NÃO é achado — não relate;",
    "  • reporte apenas contradições que você possa APONTAR em texto presente aqui, citando o arquivo;",
    "  • um cabeçalho no sumário é evidência de que a seção existe.]",
  ].join("\n");
}

/**
 * Monta o `spec_text` do estágio B respeitando o teto SEM esconder o que ficou de fora.
 *
 * Estratégia de orçamento: parte do pior caso (todos os arquivos em sumário, que é o que garante o
 * inventário) e vai PROMOVENDO arquivos a integral, do menor para o maior, enquanto couber.
 */
export function buildValidationInput(
  files: ValidationInputFile[],
  cap: number = VALIDATION_INPUT_CAP,
): ValidationInput {
  const totalChars = files.reduce((n, f) => n + f.content.length, 0);
  const outlines = new Map(files.map((f) => [f.path, outlineOf(f.content)]));
  const header = (fullSet: Set<string>, cut: boolean) => inventory(files, fullSet, totalChars, cut);

  // Custo de cada arquivo nas duas formas (inclui a moldura `===== path =====`).
  const frame = (f: ValidationInputFile, full: boolean) =>
    full
      ? `===== ${f.path} =====\n${f.content}`
      : `===== ${f.path} — SÓ SUMÁRIO (arquivo EXISTE, ${f.content.length} chars) =====\n${outlines.get(f.path) ?? ""}`;

  const fullSet = new Set<string>();
  let spent = header(fullSet, true).length + files.reduce((n, f) => n + frame(f, false).length + 2, 0);

  for (const f of [...files].sort((a, b) => a.content.length - b.content.length)) {
    const delta = frame(f, true).length - frame(f, false).length;
    if (spent + delta > cap) continue;
    spent += delta;
    fullSet.add(f.path);
  }

  const cut = fullSet.size < files.length;
  const body = files.map((f) => frame(f, fullSet.has(f.path))).join("\n\n");
  const text = `${header(fullSet, cut)}\n\n${body}`;

  return {
    // Rede de segurança: se até o pior caso estourar o teto (spec absurda), o corte volta a existir —
    // mas agora depois do inventário, que é a parte que impede o falso "ausente".
    text: text.length > cap ? `${text.slice(0, cap)}\n[… corte por teto de janela …]` : text,
    full: files.filter((f) => fullSet.has(f.path)).map((f) => f.path),
    outlineOnly: files.filter((f) => !fullSet.has(f.path)).map((f) => f.path),
    totalChars,
  };
}
