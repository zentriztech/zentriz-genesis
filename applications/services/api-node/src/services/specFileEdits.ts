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
  /**
   * GAP-65 — quantas linhas separadoras (`=======`) o bloco trazia. Só serve à MENSAGEM de erro:
   * com 2+, "âncora não encontrada" quase sempre significa que o agente contou o separador errado,
   * e dizer isso é o que transforma a recusa em lição.
   */
  separators?: number;
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

/** `true` se a linha é um dos três marcadores do envelope de edição. */
function isMarkerLine(trimmed: string): boolean {
  return RE_START.test(trimmed) || RE_MID.test(trimmed) || RE_END.test(trimmed);
}

/**
 * Parser de blocos search/replace.
 *
 * Deliberadamente linha-a-linha (não regex global): a resposta pode terminar NO MEIO de um bloco
 * (truncamento) e um regex `[\s\S]*?` casaria pares errados atravessando blocos. Aqui um bloco só
 * existe quando os três marcadores apareceram na ordem certa.
 *
 * ## GAP-65 (2026-09-07) — o separador é o ÚLTIMO `=======` do bloco, não o primeiro
 *
 * O GAP-9 fechou a porta de ENTRADA da corrupção (marcador no lado REPLACE nunca é gravado), mas
 * deixou a de SAÍDA fechada também: para apagar uma linha `=======` que já está no arquivo, o agente
 * precisa copiá-la dentro do SEARCH — e o parser antigo lia essa cópia como o separador do bloco,
 * transformando a edição CORRETA em `NO_BLOCKS`. Medido em prod: `modelo-dados.md` (NVX LastMile)
 * carrega 4 marcadores e linhas duplicadas desde antes do GAP-9; o juiz reabre o blocker em toda
 * validação e o CTO, sem conseguir remover, passou a escrever prosa declarando o marcador "resíduo
 * nulo". Um blocker impossível de fechar impede a contagem de GAPs de cair, para sempre.
 *
 * Dividir no ÚLTIMO marcador resolve os dois lados de uma vez, e a segurança é ESTRUTURAL, não uma
 * tolerância: o lado REPLACE passa a ser, por construção, o texto depois do último marcador — logo
 * nunca contém marcador — e um SEARCH com `=======` só casa se o arquivo REALMENTE tiver aquela
 * linha. O formato ganha o poder de REMOVER corrupção sem ganhar o de CRIAR.
 */
export function parseSpecEditBlocks(raw: string): SpecEditParseResult {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const blocks: SpecEditBlock[] = [];
  const prose: string[] = [];
  let dropped = 0;
  let inBlock = false;
  let body: string[] = [];

  /** Fecha um bloco cujo `>>>>>>> REPLACE` chegou: divide no último separador ou descarta. */
  const closeComplete = () => {
    let mid = -1;
    let separators = 0;
    for (let i = 0; i < body.length; i += 1) {
      if (RE_MID.test(body[i].trim())) {
        mid = i;
        separators += 1;
      }
    }
    // Bloco sem separador nenhum é malformado — não há como saber o que substitui o quê.
    if (mid === -1) dropped += 1;
    else blocks.push({ search: body.slice(0, mid).join("\n"), replace: body.slice(mid + 1).join("\n"), separators });
    inBlock = false;
    body = [];
  };

  /** Bloco aberto que nunca fechou (resposta cortada, ou novo SEARCH antes do fim do anterior). */
  const closeIncomplete = () => {
    if (inBlock) dropped += 1;
    inBlock = false;
    body = [];
  };

  for (const line of lines) {
    const t = line.trim();
    if (RE_START.test(t)) {
      closeIncomplete();
      inBlock = true;
      continue;
    }
    if (inBlock && RE_END.test(t)) {
      closeComplete();
      continue;
    }
    if (inBlock) body.push(line);
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

/** Bloco recusado individualmente (GAP-26) — não impede os demais. */
export interface SpecEditSkipped {
  index: number;
  code: SpecEditApplyFailure["code"];
  message: string;
  /**
   * 🔴 GAP-170 — o texto que o agente pediu para casar. Sem ele, quem quiser dizer ao agente QUAL
   * linha do arquivo se aproxima da âncora recusada não tem o que comparar: a `message` já é prosa
   * com o rótulo cortado em 70 chars, e reconstruir a âncora a partir dela seria adivinhar.
   */
  search: string;
}

export type SpecEditApplyResult =
  | { ok: true; content: string; applied: number; dropped: number; skipped: SpecEditSkipped[] }
  /**
   * 🔴 GAP-170: `skipped` também no caminho de FALHA. Antes, quando nenhum bloco aplicava, só o
   * PRIMEIRO defeito sobrevivia (`firstFailure[0]`) e as outras 19 âncoras recusadas eram perdidas —
   * então o chamador não tinha como devolver ao agente a releitura do arquivo para as demais.
   */
  | ({ ok: false; skipped: SpecEditSkipped[] } & SpecEditApplyFailure);

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
 *
 * ## GAP-26 (2026-09-07) — o veto é POR BLOCO, não da rodada inteira
 *
 * MEDIDO em prod na run `875b2324` (NVX LastMile): `observabilidade-operacao.md`, 69.598 chars, uma
 * chamada de Opus 5 inteira perdida com
 * `Edição 20: o trecho a substituir não existe no arquivo` — as 19 edições ancoradas foram jogadas
 * fora junto. Isso contradizia a política que este próprio módulo já adota para TRUNCAMENTO
 * (cabeçalho: "o bloco cortado é jogado fora, os completos valem"): cada bloco é uma edição
 * AUTOCONTIDA, então um bloco imprestável não torna os outros inválidos.
 *
 * Passa a valer: bloco com defeito PRÓPRIO (âncora inexistente, ambígua, SEARCH vazio, marcador no
 * REPLACE) é RECUSADO e registrado em `skipped`; os demais são aplicados. Continuam fatais os vetos
 * que falam do RESULTADO, não de um bloco: `NO_BLOCKS` e `SHRUNK`. E se NENHUM bloco aplicar, a
 * rodada falha com o motivo do primeiro — o comportamento anterior para o caso "nada funcionou".
 *
 * Isto NÃO afrouxa a proteção contra corrupção: nenhum bloco duvidoso é adivinhado ou "consertado";
 * o GAP que ele tentava resolver simplesmente continua aberto para a rodada seguinte.
 */
export function applySpecEditBlocks(
  baseContent: string,
  blocks: SpecEditBlock[],
  opts: { dropped?: number; minRatio?: number } = {},
): SpecEditApplyResult {
  const dropped = opts.dropped ?? 0;
  const minRatio = opts.minRatio ?? 0.6;
  if (blocks.length === 0) {
    return { ok: false, code: "NO_BLOCKS", message: "A resposta não trouxe nenhum bloco de edição completo.", skipped: [] };
  }
  const skipped: SpecEditSkipped[] = [];
  const firstFailure: SpecEditApplyFailure[] = [];
  const skip = (f: SpecEditApplyFailure & { index: number; search: string }) => {
    skipped.push({ index: f.index, code: f.code, message: f.message, search: f.search });
    if (firstFailure.length === 0) firstFailure.push(f);
  };
  let current = baseContent.replace(/\r\n/g, "\n");
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    const search = b.search.replace(/\r\n/g, "\n");
    if (!search.trim()) {
      skip({ code: "EMPTY_SEARCH", index: i, search, message: `Edição ${i + 1}: bloco SEARCH vazio.` });
      continue;
    }
    // GAP-9 (invariante, não heurística): nenhuma substituição pode INTRODUZIR uma linha de marcador
    // no arquivo. Gravar `=======` numa spec normativa é corrupção — o validador a lê como conflito de
    // merge não resolvido, e com razão. O parser já descarta o bloco malformado; isto garante a
    // invariante para qualquer chamador, inclusive um bloco montado à mão em teste.
    const badLine = b.replace.replace(/\r\n/g, "\n").split("\n").find((l) => isMarkerLine(l.trim()));
    if (badLine !== undefined) {
      skip({
        code: "MARKER_IN_REPLACE", index: i, search,
        message: `Edição ${i + 1}: o texto novo contém uma linha de marcador de edição ("${badLine.trim().slice(0, 20)}") — recusado para não gravar conflito de merge na spec. Reemita o bloco; se a linha for mesmo conteúdo, use cabeçalho ATX (\`# Título\`) em vez de sublinhado.`,
      });
      continue;
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
      // GAP-65: com 2+ separadores, o motivo mais provável é o agente ter contado o separador errado.
      // Dizer QUAL é a regra é o que permite ele reemitir certo na rodada seguinte.
      const sep = (b.separators ?? 1) > 1
        ? ` Este bloco trazia ${b.separators} linhas separadoras (\`=======\`): a divisão usa a ÚLTIMA delas,`
          + " e todas as anteriores contam como texto do arquivo dentro do SEARCH."
        : "";
      skip({
        code: "SEARCH_NOT_FOUND", index: i, search,
        message: `Edição ${i + 1}: o trecho a substituir não existe no arquivo — âncora: "${label(search)}".${sep}`,
      });
      continue;
    }
    if (hits > 1) {
      skip({
        code: "SEARCH_AMBIGUOUS", index: i, search,
        message: `Edição ${i + 1}: o trecho a substituir aparece ${hits}× no arquivo (âncora ambígua) — "${label(search)}". Inclua mais linhas de contexto.`,
      });
      continue;
    }
    const at = current.indexOf(effective);
    current = current.slice(0, at) + b.replace.replace(/\r\n/g, "\n") + current.slice(at + effective.length);
  }
  const applied = blocks.length - skipped.length;
  // Nenhum bloco aplicou: a rodada é a mesma falha de antes, com o motivo do PRIMEIRO bloco recusado.
  if (applied === 0) return { ok: false, ...firstFailure[0], skipped };
  if (current.length < Math.floor(baseContent.length * minRatio)) {
    return {
      ok: false, code: "SHRUNK", skipped,
      message: `As edições encolheriam o arquivo de ${baseContent.length} para ${current.length} caracteres — recusado (possível remoção de conteúdo válido).`,
    };
  }
  return { ok: true, content: current, applied, dropped, skipped };
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
