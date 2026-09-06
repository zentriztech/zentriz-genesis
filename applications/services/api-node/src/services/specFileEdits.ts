/**
 * A5.2 (2026-09-06) — EDIÇÕES CIRÚRGICAS no caminho "Resolver GAPs POR ARQUIVO".
 *
 * ## A causa que este módulo mata (MEDIDA em prod, não suposta)
 *
 * `privacidade-lgpd.md` (NVX LastMile – Backend, ~47k chars, 9 GAPs / 5 blockers) falhou **4 vezes
 * seguidas** no laço autônomo, sempre igual:
 *
 * ```
 * [SpecChat] job=aeaefbc1 raw TRUNCADO (stop_reason=max_tokens) — 69058 chars descartados
 * [SpecChatJobs] usage: job=aeaefbc1 in=27481 out=32000
 * ```
 *
 * O teto de saída (`GAP_FILE_MAX_TOKENS = 32.000`) foi consumido **inteiro**, produziu 69.058 chars
 * — mais que o arquivo original — e **ainda não havia terminado**. O guard T1 então descartou 100%
 * do resultado (correto: aplicar arquivo cortado é perda de dados). Resultado: 4 rodadas pagas
 * (~27k in + 32k out cada) para ZERO progresso, e o mesmo arquivo reofertado para sempre.
 *
 * **O teto não era o defeito — o FORMATO era.** Pedir "devolva o conteúdo final COMPLETO do arquivo"
 * faz o custo de saída crescer com o TAMANHO DO ARQUIVO, não com o tamanho da correção: ~90% dos
 * tokens eram gastos copiando texto que não mudou. Nenhum teto resolve isso; arquivo grande sempre
 * volta a estourar. A flag `SPEC_CTO_EDIT_FORMAT=edits` (F1) já atacava exatamente isto — mas só no
 * caminho do CTO da spec inteira (`/invoke/cto/async`); no caminho por-arquivo (`/invoke/raw`) ela é
 * INERTE, porque o prompt daquele caminho exige o arquivo completo.
 *
 * ## O que passa a acontecer
 *
 * O CTO-editor devolve BLOCOS de busca/substituição e a api os aplica:
 *
 * ```
 * <<<<<<< SEARCH
 * (trecho exato do arquivo atual)
 * =======
 * (trecho novo)
 * >>>>>>> REPLACE
 * ```
 *
 * A saída passa a ser proporcional à CORREÇÃO. Para 9 GAPs isso é da ordem de 10–20k chars em vez
 * de 69k+ — e sobra teto para o modelo ser CONCRETO (que é o que a Lei "100% LLM" pede).
 *
 * ## Por que truncar deixa de ser perda total
 *
 * No formato "arquivo inteiro", um corte no meio = documento mutilado ⇒ tem de ser descartado.
 * No formato de edições, um corte no meio deixa os blocos JÁ FECHADOS íntegros e válidos: cada bloco
 * é uma edição autocontida, e o que não chegou simplesmente **não muda**. Então truncamento passa a
 * significar *progresso parcial*, não corrupção — o bloco cortado é jogado fora, os completos valem.
 *
 * ## Onde este código NÃO decide nada (Lei: Genesis é 100% LLM)
 *
 * Aqui não há heurística de conteúdo: o módulo não escolhe o que corrigir, não reescreve texto e não
 * "conserta" um bloco que não casou. Ele só TRANSPORTA a decisão do agente e VETA corrupção —
 * âncora ambígua, âncora inexistente, arquivo encolhendo. Quando veta, a rodada falha com o motivo
 * exato (que é o que o laço precisa para virar lição).
 */

/** Um bloco de edição já parseado. `search` é texto EXATO do arquivo; `replace` é o substituto. */
export interface SpecEditBlock {
  search: string;
  replace: string;
}

export interface SpecEditParseResult {
  blocks: SpecEditBlock[];
  /**
   * Blocos abertos e não fechados (só acontece quando a resposta foi CORTADA no meio de um bloco).
   * Contá-los é o que permite dizer "apliquei 7 de 8 edições" em vez de "falhou".
   */
  dropped: number;
  /** Texto fora dos blocos (o modelo às vezes comenta o que fez). Preservado só para diagnóstico. */
  prose: string;
}

const RE_START = /^<{5,}\s*SEARCH\s*$/;
const RE_MID = /^={5,}$/;
const RE_END = /^>{5,}\s*REPLACE\s*$/;

/** `true` se o texto contém pelo menos a ABERTURA de um bloco de edição. */
export function looksLikeEdits(text: string): boolean {
  return text.replace(/\r\n/g, "\n").split("\n").some((l) => RE_START.test(l.trim()));
}

/**
 * Parser de blocos search/replace.
 *
 * Deliberadamente linha-a-linha (não regex global): a resposta pode terminar NO MEIO de um bloco
 * (truncamento) e um regex `[\s\S]*?` casaria pares errados atravessando blocos. Aqui um bloco só
 * existe quando os três marcadores apareceram na ordem certa.
 */
export function parseSpecEditBlocks(raw: string): SpecEditParseResult {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const blocks: SpecEditBlock[] = [];
  const prose: string[] = [];
  let dropped = 0;
  let state: "idle" | "search" | "replace" = "idle";
  let search: string[] = [];
  let replace: string[] = [];

  const closeIncomplete = () => {
    if (state !== "idle") dropped += 1;
    state = "idle";
    search = [];
    replace = [];
  };

  for (const line of lines) {
    const t = line.trim();
    if (RE_START.test(t)) {
      // Um novo SEARCH antes de fechar o anterior = bloco anterior corrompido/cortado.
      closeIncomplete();
      state = "search";
      continue;
    }
    if (state === "search" && RE_MID.test(t)) {
      state = "replace";
      continue;
    }
    if (state === "replace" && RE_END.test(t)) {
      blocks.push({ search: search.join("\n"), replace: replace.join("\n") });
      state = "idle";
      search = [];
      replace = [];
      continue;
    }
    // GAP-9: um SEGUNDO separador dentro do lado REPLACE = bloco malformado. Antes esta linha era
    // engolida como CONTEÚDO e o `=======` ia para o disco — foi assim que `modelo-dados.md` ganhou
    // um marcador de conflito no meio de uma tabela (e a linha substituída ficou DUPLICADA), com o
    // log dizendo "16 aplicadas, 0 descartadas". Descartar só ESTE bloco preserva a rodada: os
    // demais continuam válidos, exatamente como no truncamento.
    if (state === "replace" && RE_MID.test(t)) {
      closeIncomplete();
      continue;
    }
    if (state === "search") search.push(line);
    else if (state === "replace") replace.push(line);
    else if (t) prose.push(line);
  }
  closeIncomplete();
  return { blocks, dropped, prose: prose.join("\n").trim() };
}

export type SpecEditApplyFailure =
  | { code: "NO_BLOCKS"; message: string }
  | { code: "EMPTY_SEARCH"; message: string; index: number }
  | { code: "SEARCH_NOT_FOUND"; message: string; index: number }
  | { code: "SEARCH_AMBIGUOUS"; message: string; index: number }
  | { code: "MARKER_IN_REPLACE"; message: string; index: number }
  | { code: "SHRUNK"; message: string };

export type SpecEditApplyResult =
  | { ok: true; content: string; applied: number; dropped: number }
  | ({ ok: false } & SpecEditApplyFailure);

/** Quantas vezes `needle` aparece em `hay` (busca literal, sem regex). */
function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Tolerância MÍNIMA de casamento: espaço em branco no FIM das linhas.
 *
 * Editores e o próprio modelo comem trailing spaces; recusar a rodada por isso desperdiçaria uma
 * geração inteira por um caractere invisível. Qualquer coisa além disto (indentação, acento,
 * pontuação) NÃO é tolerada: seria o código adivinhando conteúdo, o que a Lei proíbe.
 */
function stripTrailingWs(s: string): string {
  return s.split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n");
}

/** Rótulo curto de um trecho, para a mensagem de erro apontar QUAL bloco falhou. */
function label(s: string): string {
  const first = s.split("\n").find((l) => l.trim()) ?? "";
  const t = first.trim();
  return t.length > 70 ? `${t.slice(0, 70)}…` : t || "(vazio)";
}

/**
 * Aplica os blocos ao conteúdo base, em ordem, com veto de corrupção.
 *
 * Regras (todas são veto, nenhuma é heurística de conteúdo):
 *  • `search` vazio → recusa (um bloco vazio casaria em qualquer lugar);
 *  • `search` que não existe no conteúdo ATUAL → recusa (a âncora era imaginária);
 *  • `search` que aparece 2+ vezes → recusa (não sabemos QUAL o agente quis; adivinhar é corromper);
 *  • resultado abaixo de `minRatio` do tamanho base → recusa (o arquivo estaria sendo esvaziado).
 *
 * A unicidade é verificada no conteúdo **corrente** (já com os blocos anteriores aplicados), que é o
 * que o agente vê acontecer ao editar de cima para baixo — e é determinístico.
 */
export function applySpecEditBlocks(
  baseContent: string,
  blocks: SpecEditBlock[],
  opts: { dropped?: number; minRatio?: number } = {},
): SpecEditApplyResult {
  const dropped = opts.dropped ?? 0;
  const minRatio = opts.minRatio ?? 0.6;
  if (blocks.length === 0) {
    return { ok: false, code: "NO_BLOCKS", message: "A resposta não trouxe nenhum bloco de edição completo." };
  }
  let current = baseContent.replace(/\r\n/g, "\n");
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    const search = b.search.replace(/\r\n/g, "\n");
    if (!search.trim()) {
      return { ok: false, code: "EMPTY_SEARCH", index: i, message: `Edição ${i + 1}: bloco SEARCH vazio.` };
    }
    // GAP-9 (invariante, não heurística): nenhuma substituição pode INTRODUZIR uma linha de marcador
    // no arquivo. Gravar `=======` numa spec normativa é corrupção — o validador a lê como conflito de
    // merge não resolvido, e com razão. O parser já descarta o bloco malformado; isto garante a
    // invariante para qualquer chamador, inclusive um bloco montado à mão em teste.
    const badLine = b.replace.replace(/\r\n/g, "\n").split("\n")
      .find((l) => { const s = l.trim(); return RE_START.test(s) || RE_MID.test(s) || RE_END.test(s); });
    if (badLine !== undefined) {
      return {
        ok: false, code: "MARKER_IN_REPLACE", index: i,
        message: `Edição ${i + 1}: o texto novo contém uma linha de marcador de edição ("${badLine.trim().slice(0, 20)}") — recusado para não gravar conflito de merge na spec. Reemita o bloco; se a linha for mesmo conteúdo, use cabeçalho ATX (\`# Título\`) em vez de sublinhado.`,
      };
    }
    let hits = countOccurrences(current, search);
    let effective = search;
    if (hits === 0) {
      // Segunda (e última) tentativa: ignorar espaço no fim das linhas dos DOIS lados.
      const loose = stripTrailingWs(current);
      const looseSearch = stripTrailingWs(search);
      const looseHits = countOccurrences(loose, looseSearch);
      if (looseHits === 1) {
        current = loose;
        effective = looseSearch;
        hits = 1;
      }
    }
    if (hits === 0) {
      return {
        ok: false, code: "SEARCH_NOT_FOUND", index: i,
        message: `Edição ${i + 1}: o trecho a substituir não existe no arquivo — âncora: "${label(search)}".`,
      };
    }
    if (hits > 1) {
      return {
        ok: false, code: "SEARCH_AMBIGUOUS", index: i,
        message: `Edição ${i + 1}: o trecho a substituir aparece ${hits}× no arquivo (âncora ambígua) — "${label(search)}". Inclua mais linhas de contexto.`,
      };
    }
    const at = current.indexOf(effective);
    current = current.slice(0, at) + b.replace.replace(/\r\n/g, "\n") + current.slice(at + effective.length);
  }
  if (current.length < Math.floor(baseContent.length * minRatio)) {
    return {
      ok: false, code: "SHRUNK",
      message: `As edições encolheriam o arquivo de ${baseContent.length} para ${current.length} caracteres — recusado (possível remoção de conteúdo válido).`,
    };
  }
  return { ok: true, content: current, applied: blocks.length, dropped };
}

/**
 * Caminho completo: texto do modelo → conteúdo final do arquivo.
 *
 * `truncated` é informativo: no formato de edições ele NÃO invalida a rodada (ver o cabeçalho deste
 * módulo). Quem decide o que fazer com `dropped > 0` é o chamador, que sabe se aquilo era o último
 * GAP da fila ou não.
 */
export function applySpecEditResponse(
  baseContent: string,
  responseText: string,
  opts: { minRatio?: number } = {},
): SpecEditApplyResult {
  const parsed = parseSpecEditBlocks(responseText);
  return applySpecEditBlocks(baseContent, parsed.blocks, { dropped: parsed.dropped, minRatio: opts.minRatio });
}
