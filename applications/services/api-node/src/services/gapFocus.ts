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
    const um = ordenados[0];
    return {
      level: 2,
      findings: [um],
      anchors: [(um.anchor ?? "").trim()],
      deferred: todos.length - 1,
      reason: `foco INDIVIDUAL: ${args.fileRounds} rodada(s) já pagas neste arquivo e o defeito voltou — esta rodada trata SÓ \`${(um.anchor ?? "").trim()}\``,
    };
  }
  if (ordenados.length < todos.length) {
    return {
      level: 1,
      findings: ordenados,
      anchors: ordenados.map((f) => (f.anchor ?? "").trim()),
      deferred: todos.length - ordenados.length,
      reason: `foco: ${ordenados.length} de ${todos.length} GAP(s) deste arquivo são REINCIDENTES — esta rodada trata só eles`,
    };
  }
  return nada;
}

/**
 * O FATO da rodada dedicada, para o prompt.
 *
 * Precisa dizer três coisas, e todas por um motivo medido: (1) que a lista está restrita — senão o
 * modelo conclui que o arquivo só tem esses defeitos e "consolida" o resto; (2) que os outros seguem
 * ativos e voltam — senão ele tenta resolvê-los de qualquer jeito, que é o comportamento que o foco
 * existe para impedir; (3) que estes já voltaram N vezes e o que ele fez antes NÃO funcionou — o
 * mesmo fato do GAP-71, aqui com o peso de ser o único assunto da rodada.
 */
export function focusFactBlock(plan: FocusPlan): string {
  if (plan.level === 0) return "";
  const alvo = plan.level === 2 ? "UM único defeito" : `${plan.findings.length} defeito(s) REINCIDENTE(S)`;
  return [
    "--- RODADA DEDICADA (leia antes de editar) ---",
    `Esta rodada é dedicada a ${alvo}. A lista de GAPs abaixo foi RESTRINGIDA de propósito:`,
    `${plan.deferred} outro(s) GAP(s) deste arquivo ficaram FORA desta rodada — eles seguem ATIVOS e`,
    "voltam em outra rodada. NÃO os resolva agora e NÃO conclua que o arquivo não os tem.",
    "Estes defeitos já foram apontados em validações anteriores, você já editou este arquivo antes, e",
    "eles VOLTARAM. O que foi tentado até aqui não funcionou: não repita a mesma correção. Se a",
    "correção exige mexer no trecho ancorado, mexa NO TRECHO — errata em outra seção declarando o",
    "trecho nulo já foi tentada e o defeito reapareceu.",
    "Gaste o orçamento desta rodada AQUI. Uma correção que de fato resolve vale mais que várias parciais.",
    "--- FIM DA RODADA DEDICADA ---",
    "",
  ].join("\n");
}
