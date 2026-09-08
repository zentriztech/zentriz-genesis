/**
 * gapFocus.ts — 🔴 GAP-81: o arquivo teimoso recebia o MESMO tratamento em todo passe.
 *
 * ## O que foi medido (NVX LastMile, prod, 8 runs)
 *
 * Os 62 eventos "âncora intocada" se dividiram em duas famílias. Uma era cegueira de recorte/medição
 * (GAP-78: cabeçalho falso dentro de cerca de código; GAP-79: a âncora endereça a subárvore, não o
 * preâmbulo do cabeçalho). A outra é real — o agente recebeu o trecho e simplesmente não editou:
 *
 *  • `observabilidade-operacao.md §1.2` — 9 eventos em 8 runs (corpo próprio 5.306 chars, sem filhos);
 *  • `privacidade-lgpd.md §3.2-bis` — 7 · `§7.1` — 6 (arquivo de 109.850 chars: abaixo do teto de
 *    120.000, logo vai INTEIRO ao CTO; não é falta de visibilidade);
 *  • `modelo-dados.md §7.2` — 5 · `§9.1 item 0-bis` — 5.
 *
 * E a fila (`importantFileQueue`) e o despacho (`startFileRound`) davam a esse arquivo, passe após
 * passe, exatamente o mesmo pedido: TODOS os GAPs importantes dele de uma vez. O agente triava dentro
 * do orçamento de saída e os mesmos 3–4 itens perdiam a triagem sempre — sem nenhuma escalada.
 *
 * ## O que este módulo faz
 *
 * Decide o ESCOPO da rodada por arquivo, em três degraus:
 *
 *  • **0 — normal:** todos os GAPs importantes do arquivo (comportamento anterior);
 *  • **1 — foco:** só os TEIMOSOS (reincidência medida ≥ `FOCUS_MIN_RECURRENCE` ou âncora que voltou
 *    intocada), quando eles são um subconjunto próprio da lista. O agente não pode mais gastar o
 *    orçamento nos itens fáceis e deixar o teimoso para a próxima;
 *  • **2 — foco individual:** UM defeito por rodada, depois de `FOCUS_INDIVIDUAL_AFTER` rodadas já
 *    pagas neste arquivo. É o degrau que o Jean descreveu ("focamos neles individualmente algumas
 *    vezes") e é o que abre a porta do veredicto do GAP-77.
 *
 * O que este módulo NÃO faz: decidir conteúdo. Ele escolhe QUAIS defeitos entram na rodada — a mesma
 * natureza de decisão que a fila de arquivos já toma — e entrega ao agente o FATO de que a rodada é
 * dedicada, com os números. O que escrever continua sendo do agente (Lei: 100% LLM).
 *
 * ## Por que restringir não perde trabalho
 *
 * Os GAPs que ficam de fora seguem ATIVOS e voltam à fila no passe seguinte — nada é triado, nada é
 * fechado por omissão. O que muda é a ORDEM em que o orçamento é gasto, e ordem foi a causa-raiz de
 * três GAPs medidos antes deste (72, 73, 75). O preço é um passe a mais para os itens fáceis do
 * arquivo teimoso; o retorno é o teimoso deixar de ser eterno.
 */

import { anchorSearchKey } from "../lib/markdownSections.js";
import { findingFingerprint } from "./findingTriage.js";
import type { PersistentGapRef } from "./gapContinuity.js";

/**
 * Em quantas validações COMPETENTES o defeito precisa ter reaparecido para o arquivo entrar em foco.
 * `2` porque é o menor número que já é reincidência (a 1ª aparição não prova teimosia), e porque é o
 * mesmo piso que o `stableRecurrenceRefs` usa para sequer registrar uma ref.
 */
export const FOCUS_MIN_RECURRENCE = 2;

/**
 * Rodadas já pagas NESTE arquivo (em todas as runs do projeto) antes de o foco virar individual.
 * `3` porque com 2 o degrau 2 chegaria antes de o degrau 1 ter sido tentado uma única vez, e a
 * escalada perderia o sentido de escalada.
 */
export const FOCUS_INDIVIDUAL_AFTER = 3;

/**
 * O mínimo que este módulo precisa saber de um finding: o que a régua de identidade exige
 * (`findingFingerprint`) mais a âncora. Derivar do parâmetro real evita a divergência de tipo que faria
 * o foco casar por uma identidade e a validação por outra — a família do GAP-49/50.
 */
export type FocusFinding = Parameters<typeof findingFingerprint>[0] & { anchor?: string | null };

/**
 * 🔴 GAP-111/112 — o histórico CRU de uma âncora, para o degrau 2.
 *
 * `dedicatedRounds` é quantas rodadas de foco INDIVIDUAL esta âncora já recebeu no projeto (a mesma
 * conta que `gapPromotionVerdict.focusRoundsByAnchor` produz — medida única, não uma segunda régua).
 * `reportedTitles` são os títulos que o juiz reportou NESTA âncora, em ordem cronológica.
 *
 * Os dois campos são FATO, sem rótulo: nada aqui diz "isto não funcionou" nem "a spec está crescendo".
 * Interpretar a cadeia é decisão de conteúdo e é do agente (Lei: 100% LLM). O revisor cross-family
 * derrubou a primeira versão deste bloco justamente por interpretar em nome do agente.
 */
export interface AnchorHistory {
  dedicatedRounds: number;
  reportedTitles: string[];
}

export interface FocusPlan {
  /** 0 = rodada normal · 1 = só os teimosos · 2 = um defeito só. */
  level: 0 | 1 | 2;
  /** Os findings que VÃO ao agente nesta rodada. Em `level 0`, a lista inteira. */
  findings: FocusFinding[];
  /** Âncoras sob foco (vazio em `level 0`) — é o que o log grava e o veredicto do GAP-77 conta. */
  anchors: string[];
  /** Quantos GAPs deste arquivo ficaram para outro passe (seguem ATIVOS). */
  deferred: number;
  /** Frase para o log da rodada e para o chat. Em `level 0`, vazia. */
  reason: string;
  /**
   * 🔴 GAP-112 — o histórico cru das âncoras EM FOCO, já resolvido, para o prompt não precisar do banco.
   * Viaja dentro do plano (e não como parâmetro novo da rota) porque quem tem o `db` é o despacho e
   * quem monta o bloco é o `specChat` — e um array simples sobrevive a serialização, um `Map` não.
   */
  anchorHistory?: Array<AnchorHistory & { anchor: string }>;
}

/**
 * Quantos títulos por âncora vão ao prompt. `6` porque a cadeia medida em `PRIV-ETAPAS-01` tinha 7
 * elos e 6 já mostram a forma dela, e porque isto é orçamento de transporte — a única coisa que o
 * código pode limitar sem decidir conteúdo.
 */
export const FOCUS_HISTORY_TITLES = 6;

/** Os N títulos MAIS RECENTES da âncora, na ordem cronológica original (o fim da cadeia é o que importa). */
function historyFor(
  anchors: string[],
  history?: Map<string, AnchorHistory>,
): Array<AnchorHistory & { anchor: string }> | undefined {
  if (!history || history.size === 0) return undefined;
  const out: Array<AnchorHistory & { anchor: string }> = [];
  for (const anchor of anchors) {
    const h = history.get(anchorSearchKey(anchor));
    if (!h) continue;
    const titulos = h.reportedTitles.filter((t) => (t ?? "").trim().length > 0);
    if (h.dedicatedRounds === 0 && titulos.length === 0) continue;
    out.push({ anchor, dedicatedRounds: h.dedicatedRounds, reportedTitles: titulos.slice(-FOCUS_HISTORY_TITLES) });
  }
  return out.length > 0 ? out : undefined;
}

/** Reincidência conhecida por fingerprint e por âncora normalizada (a ref pode ter só a âncora). */
function stubbornKeys(refs: PersistentGapRef[]): { fps: Set<string>; anchors: Set<string> } {
  const fps = new Set<string>();
  const anchors = new Set<string>();
  for (const r of refs) {
    const teimoso = (r.times ?? 0) >= FOCUS_MIN_RECURRENCE || r.untouched === true;
    if (!teimoso) continue;
    if (r.fingerprint) fps.add(r.fingerprint);
    // A âncora entra como chave alternativa porque o rebatismo (GAP-67) troca o fingerprint do MESMO
    // defeito: casar só por fingerprint faria o teimoso escapar do foco justamente quando ele muda de
    // nome, que é o comportamento medido no GAP-49/50.
    for (const a of [r.anchor, r.anchorBefore]) {
      const k = anchorSearchKey(a ?? "");
      if (k) anchors.add(k);
    }
  }
  return { fps, anchors };
}

/** Ordem de teimosia: mais reincidente primeiro; empate desce para a âncora intocada. */
function stubbornRank(refs: PersistentGapRef[], f: FocusFinding): number {
  const key = anchorSearchKey(f.anchor ?? "");
  const fp = findingFingerprint(f);
  let best = 0;
  for (const r of refs) {
    const casa = (r.fingerprint && r.fingerprint === fp)
      || (key && (anchorSearchKey(r.anchor ?? "") === key || anchorSearchKey(r.anchorBefore ?? "") === key));
    if (!casa) continue;
    best = Math.max(best, (r.times ?? 0) * 10 + (r.untouched === true ? 5 : 0));
  }
  return best;
}

/**
 * 🔴 GAP-81 — o escopo desta rodada do arquivo.
 *
 * `fileRounds` é quantas rodadas de autonomia já despacharam ESTE arquivo ao CTO-editor, contando
 * todas as runs do projeto. Precisa ser a conta ampla: os arquivos teimosos do NVX levaram 16h e
 * várias runs, e zerar a escalada a cada run faria o degrau 2 nunca chegar.
 *
 * Cuidado deliberado com o degrau 1: ele só existe quando os teimosos são um subconjunto PRÓPRIO da
 * lista. Se todos os GAPs do arquivo são teimosos, restringir não restringiria nada — declarar foco ali
 * inflaria a conta de "foco pago" que o veredicto do GAP-77 exige, e o gatilho do Jean viraria um
 * carimbo. Nesse caso o arquivo espera o degrau 2, que é restrição de verdade.
 */
export function planFocus(args: {
  findings: FocusFinding[];
  refs: PersistentGapRef[];
  fileRounds: number;
  /**
   * Histórico por âncora normalizada (`anchorSearchKey`), de `focusRoundsByAnchor` +
   * `reportedTitlesByAnchor`. Ausente ⇒ o degrau 2 se comporta como antes (o mais teimoso primeiro),
   * que é o que os testes anteriores a este GAP descrevem.
   */
  history?: Map<string, AnchorHistory>;
}): FocusPlan {
  const todos = args.findings;
  const nada: FocusPlan = { level: 0, findings: todos, anchors: [], deferred: 0, reason: "" };
  if (todos.length === 0) return nada;

  const { fps, anchors } = stubbornKeys(args.refs);
  if (fps.size === 0 && anchors.size === 0) return nada;

  const teimosos = todos.filter((f) => {
    const k = anchorSearchKey(f.anchor ?? "");
    return fps.has(findingFingerprint(f)) || (!!k && anchors.has(k));
  });
  // Sem âncora não há foco possível: a rodada dedicada se prova pela âncora que ela ataca, e um
  // finding sem endereço não pode ser medido depois (`untouchedAnchors` não afirma nada sem trecho).
  const focaveis = teimosos.filter((f) => (f.anchor ?? "").trim().length > 0);
  if (focaveis.length === 0) return nada;

  const ordenados = focaveis.slice().sort((a, b) =>
    stubbornRank(args.refs, b) - stubbornRank(args.refs, a)
    || todos.indexOf(a) - todos.indexOf(b));

  if (args.fileRounds >= FOCUS_INDIVIDUAL_AFTER) {
    // 🔴 GAP-111 — o mais teimoso TAMPONAVA o arquivo. Medido em `privacidade-lgpd.md` (12 GAPs):
    // 4 rodadas em 24, todas em nível 2, e a MESMA âncora (`PRIV-ETAPAS-01`) foi o foco em 3 delas —
    // escreveu nas 3, fechou 0, e os outros 11 GAPs nunca foram pedidos em 24 rodadas. `ordenados[0]`
    // é sempre o mais reincidente, e quem não fecha só fica MAIS reincidente ⇒ o pódio é dele para
    // sempre. A premissa que este módulo declarava ("os que ficam de fora voltam em outra rodada")
    // era FALSA por construção.
    //
    // A ordenação primária passa a ser rodadas dedicadas já pagas, crescente: um teimoso só recebe a
    // 2ª rodada dedicada depois que todos os outros receberam a 1ª. Como o `sort` do V8 é estável e
    // `ordenados` já vem por teimosia, a teimosia continua valendo como desempate — o que muda é só
    // que ela não pode mais monopolizar. Isso não decide conteúdo: é a mesma natureza de decisão que
    // a fila de arquivos já toma, e nenhum GAP é fechado nem descartado por causa dela.
    const dedicadas = (f: FocusFinding): number => {
      const k = anchorSearchKey(f.anchor ?? "");
      if (!k) return 0;
      return args.history?.get(k)?.dedicatedRounds ?? 0;
    };
    const fila = ordenados.slice().sort((a, b) => dedicadas(a) - dedicadas(b));
    const um = fila[0];
    const alvo = (um.anchor ?? "").trim();
    const pagas = dedicadas(um);
    const virgens = fila.filter((f) => dedicadas(f) === 0).length;
    return {
      level: 2,
      findings: [um],
      anchors: [alvo],
      deferred: todos.length - 1,
      reason: `foco INDIVIDUAL: ${args.fileRounds} rodada(s) já pagas neste arquivo e o defeito voltou — esta rodada trata SÓ \`${alvo}\` (${pagas} rodada(s) dedicada(s) a ele até aqui; ${virgens} teimoso(s) deste arquivo ainda sem nenhuma)`,
      anchorHistory: historyFor([alvo], args.history),
    };
  }
  if (ordenados.length < todos.length) {
    const alvos = ordenados.map((f) => (f.anchor ?? "").trim());
    return {
      level: 1,
      findings: ordenados,
      anchors: alvos,
      deferred: todos.length - ordenados.length,
      reason: `foco: ${ordenados.length} de ${todos.length} GAP(s) deste arquivo são REINCIDENTES — esta rodada trata só eles`,
      anchorHistory: historyFor(alvos, args.history),
    };
  }
  return nada;
}

/**
 * O FATO da rodada dedicada, para o prompt.
 *
 * Precisa dizer três coisas, e todas por um motivo medido: (1) que a lista está restrita — senão o
 * modelo conclui que o arquivo só tem esses defeitos e "consolida" o resto; (2) que os outros voltam,
 * e agora isso é verdade por construção (o GAP-111 fez o foco rodar) — senão ele tenta resolvê-los de
 * qualquer jeito, que é o comportamento que o foco existe para impedir; (3) o HISTÓRICO CRU desta
 * âncora: quantas rodadas dedicadas ela já teve e os títulos que o juiz reportou nela, em ordem.
 *
 * 🔴 GAP-112 — o bloco NÃO interpreta a cadeia. A versão anterior afirmava "o que foi tentado até
 * aqui não funcionou", e o revisor cross-family (DeepSeek, blocker) apontou que isso é o CÓDIGO
 * decidindo conteúdo: o código não sabe se a correção falhou, se o juiz rebatizou o defeito (GAP-67)
 * ou se ele duplicou dentro da mesma validação (medido: o mesmo defeito 3× numa validação). Agora ele
 * entrega a cadeia literal e a leitura é do agente (Lei: 100% LLM).
 *
 * O que a cadeia revelou, e é o motivo de ela ir ao prompt: rastreando `PRIV-ETAPAS-01` em 33
 * validações, o defeito MUTA em cadeia, e cada elo nasce da correção do elo anterior — a pergunta
 * original ("o job tem 3 ou 4 etapas?") nunca foi decidida, foi cercada de maquinaria normativa, e
 * cada adição amplia a superfície verificável e portanto a de defeito. Por isso o bloco declara que
 * DECIDIR POR REDUÇÃO é desfecho legítimo: o mecanismo de remoção já é seguro (GAP-12 exige o bloco
 * ancorado completo, então remoção é decisão declarada, nunca perda silenciosa). Declarar que a saída
 * existe não é escolhê-la — proibir adição ou contar aparato é que seria automação fixa.
 */
export function focusFactBlock(plan: FocusPlan): string {
  if (plan.level === 0) return "";
  const alvo = plan.level === 2 ? "UM único defeito" : `${plan.findings.length} defeito(s) REINCIDENTE(S)`;
  const linhas = [
    "--- RODADA DEDICADA (leia antes de editar) ---",
    `Esta rodada é dedicada a ${alvo}. A lista de GAPs abaixo foi RESTRINGIDA de propósito:`,
    `${plan.deferred} outro(s) GAP(s) deste arquivo ficaram FORA desta rodada — eles seguem ATIVOS e`,
    "voltam em outra rodada. NÃO os resolva agora e NÃO conclua que o arquivo não os tem.",
    "Estes defeitos já foram apontados em validações anteriores, você já editou este arquivo antes, e",
    "eles VOLTARAM.",
  ];

  // O histórico entra CRU, um título por linha, na ordem em que o juiz os reportou. Sem rótulo, sem
  // contagem interpretada, sem conclusão: é o material que permite ao agente ver se está diante do
  // mesmo defeito, de um rebatismo ou de uma cadeia que ele próprio criou.
  for (const h of plan.anchorHistory ?? []) {
    linhas.push("");
    linhas.push(`HISTÓRICO DESTA ÂNCORA — \`${h.anchor}\``);
    linhas.push(`rodadas dedicadas só a ela até aqui: ${h.dedicatedRounds}`);
    if (h.reportedTitles.length > 0) {
      linhas.push("títulos que o juiz reportou nesta âncora, na ordem em que apareceram:");
      for (const [i, t] of h.reportedTitles.entries()) linhas.push(`  ${i + 1}. ${t.trim()}`);
    }
  }

  linhas.push(
    "",
    "Leia o histórico acima antes de escrever e decida você o que ele significa.",
    "Se a correção exige mexer no trecho ancorado, mexa NO TRECHO — errata em outra seção declarando o",
    "trecho nulo já foi tentada e o defeito reapareceu.",
    "DECIDIR POR REDUÇÃO é desfecho legítimo e às vezes é o único: se o defeito é uma contradição,",
    "escolher um valor normativo e REMOVER ou SUBORDINAR o outro fecha o defeito. Remover exige o bloco",
    "ancorado completo, então a remoção fica declarada e auditável — não é perda. Adicionar cláusula",
    "nova para explicar a contradição não a resolve se os dois lados continuarem valendo.",
    "Gaste o orçamento desta rodada AQUI. Uma correção que de fato resolve vale mais que várias parciais.",
    "--- FIM DA RODADA DEDICADA ---",
    "",
  );
  return linhas.join("\n");
}
