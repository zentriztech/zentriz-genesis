/**
 * gapPersistence.ts — 🔴 GAP-71: o CTO ANULA o trecho ofensor por errata em vez de REESCREVÊ-LO, e o
 * laço não tinha nenhum fato para lhe dizer isso.
 *
 * ## O que foi MEDIDO em prod (NVX LastMile – Backend, run `f101303f`, 2026-09-07)
 *
 * `modelo-dados.md` recebeu **4 rodadas pagas** do CTO-editor (passes 0 a 3), todas APLICADAS, com
 * 13 / 7 / 7 / 8 edições ancoradas cada e nenhuma truncada. As mesmas **11 âncoras** voltaram nas
 * **6 validações** seguidas — âncora por âncora, sem uma única troca de endereço:
 *
 * ```
 * §11.3 etapa c   | 11:25 11:44 12:02 12:38 12:57 13:16
 * §11.5           | 11:25 11:44 12:02 12:38 12:57 13:16
 * §8.6 (c)        | 11:25 11:44 12:02 12:38 12:57 13:16
 * §5.2 §6 §8.4 §2.3.1 item 2 §2.3.2 (e.1) §9.1 item 0-bis cli-anon-01 cred-ver-01  (idem)
 * ```
 *
 * O juiz explica o motivo no próprio `rationale`, e ele não é ambíguo:
 *
 * > "VISIB-ANON-01/01.1/01.2 e D-24 declaram esse texto 'errata nula com efeito de remoção' e mandam
 * >  404 `COURIER_NOT_FOUND`. **Duas prescrições executáveis opostas coexistem no mesmo arquivo** …
 * >  **A correção é reescrever fisicamente §8.6 (c)**, o bloco e o critério de aceite."
 *
 * Confirmado no disco: os dois literais ofensores (`com os valores sentinela` e
 * `requester_contact='[ANONYMIZED]'`) **continuam presentes** no snapshot mais recente, e a expressão
 * `errata nula` aparece **23 vezes** no arquivo (eram 38 ocorrências de "errata" na 1ª versão desta
 * run, hoje 50). Ou seja: o CTO desenvolveu uma convenção própria — declarar o trecho nulo e mandar
 * ler outro requisito — que **não fecha GAP** (o juiz relê o texto original) e **só faz a spec
 * crescer**. É o motor do GAP-8 na sua forma mais pura, e a razão pela qual o diff finding-a-finding
 * dá `0 fechado / 0 novo` passe após passe.
 *
 * ## Por que o GAP-68 não pegava isto
 *
 * O `persistentGapFactBlock` (GAP-68) é o lugar certo para o aviso, mas só era alimentado pela
 * reconciliação do GAP-67 — que pareia o que SAIU da lista com o que ENTROU (deriva de âncora). Um
 * GAP que persiste com o **mesmo fingerprint** não sai nem entra: `closed: 0, opened: 0`. Logo
 * `persisted` vem vazio e o agente recebe, pela 4ª vez, os mesmos 11 GAPs **como se fossem novidade**
 * — medido: `persistedGaps` está ausente/`null` em TODAS as 23 rodadas desta run.
 *
 * ## Os dois fatos que este módulo produz (e nada mais)
 *
 *  • `stableRecurrenceRefs` — quantas validações COMPETENTES (que julgaram este arquivo por inteiro,
 *    regra do GAP-20) trouxeram o MESMO fingerprint. É contagem de banco, não julgamento.
 *  • `untouchedAnchors` — de quais âncoras o texto ancorado permaneceu **byte-a-byte idêntico**
 *    depois da rodada. Também é fato: a seção que contém a âncora sobreviveu verbatim ou não.
 *
 * Nenhuma das duas decide conteúdo (Lei: Genesis é 100% LLM). Elas dizem ao agente a única coisa que
 * ele não pode deduzir do arquivo que recebe: que a resposta que ele já deu ali NÃO funcionou.
 */
import { splitSections, buildAnchorIndex, locateSectionIndex, anchorSearchKey } from "../lib/markdownSections.js";
import { findingFingerprint, effectiveFingerprints, judgedFilesOf } from "./findingTriage.js";
import type { PersistentGapRef } from "./gapContinuity.js";
import type { ValidationFinding } from "./specValidation.js";

/** Recorte do título nas refs — o mesmo do `gapContinuity`, para as duas fontes ficarem iguais. */
const TITLE_SLICE = 200;
/** Teto de refs devolvidas. Espelha `PERSIST_REF_MAX` do `gapContinuity` (o bloco do prompt é finito). */
const REF_MAX = 12;

/** Uma validação passada, do jeito que o banco a devolve. `coverage` = `stage_b_coverage` cru. */
export interface PastValidation {
  findings: ValidationFinding[];
  coverage?: unknown;
}

/**
 * A régua de âncora (`anchorSearchKey`, `locateSectionIndex`) MUDOU DE CASA no GAP-72: vive em
 * `lib/markdownSections.ts`, ao lado do `splitSections`, porque quem MEDE se o trecho foi tocado (aqui)
 * e quem DECIDE qual trecho o CTO vê (`specFileDigest`) têm de usar a MESMA. Duas cópias fariam o laço
 * afirmar "seção intocada" sobre uma seção que ele nunca mostrou — foi exatamente o par de defeitos
 * medido em prod. Reexportado para não quebrar quem já importava daqui.
 */
export { anchorSearchKey };

export interface AnchorTouchReport {
  /** Âncoras que o código conseguiu LOCALIZAR no texto de antes (as únicas mensuráveis). */
  measured: string[];
  /** Âncoras localizadas cujo trecho ancorado sobreviveu **verbatim** à rodada. */
  untouched: string[];
  /**
   * Âncoras que não foram encontradas no texto de antes — tipicamente IDs que o juiz cunhou
   * (`cli-anon-01`) ou seções que já não existem. NUNCA contam como intocadas: afirmar que o agente
   * não mexeu num trecho que o código não achou seria acusação sem prova.
   */
  unlocatable: string[];
}

/**
 * 🔴 GAP-71, fato A — de quais âncoras o trecho ficou INTACTO depois da rodada.
 *
 * Mecânica, sem heurística de conteúdo: `splitSections` corta o texto ANTES em seções por cabeçalho;
 * a seção de uma âncora é a primeira cujo corpo contém a chave de busca. A âncora é "intocada" quando
 * o corpo INTEIRO dessa seção reaparece **verbatim** no texto DEPOIS (`after.includes(body)`).
 *
 * Por que a seção inteira e não só a linha: é o critério CONSERVADOR. Mexer em qualquer ponto da
 * seção que contém o trecho ofensor já conta como "tocou" — o fato só é afirmado quando o agente
 * demonstravelmente não encostou naquela vizinhança. É exatamente a assinatura da patologia medida:
 * a errata é acrescentada em OUTRO lugar (ou numa seção nova no fim) e o trecho ofensor fica idêntico.
 */
export function untouchedAnchors(before: string, after: string, anchors: Array<string | null | undefined>): AnchorTouchReport {
  const measured: string[] = [];
  const untouched: string[] = [];
  const unlocatable: string[] = [];
  if (!before || !after) return { measured, untouched, unlocatable };
  const sections = splitSections(before);
  const index = buildAnchorIndex(sections);
  const seen = new Set<string>();
  for (const raw of anchors) {
    const anchor = (raw ?? "").trim();
    if (!anchor || seen.has(anchor)) continue;
    seen.add(anchor);
    if (!anchorSearchKey(anchor)) continue;
    const i = locateSectionIndex(index, anchor);
    if (i === null) { unlocatable.push(anchor); continue; }
    measured.push(anchor);
    if (after.includes(sections[i].body)) untouched.push(anchor);
  }
  return { measured, untouched, unlocatable };
}

/**
 * 🔴 GAP-71, fato B — reincidência de fingerprint ESTÁVEL.
 *
 * `runs` vem da mais recente para a mais antiga. Uma validação só conta como aparição se ela foi
 * **competente sobre este arquivo** — `stage_b_coverage.full` contém o arquivo (regra do GAP-20: a
 * ausência só é prova se alguém olhou; e a PRESENÇA só é comparável entre quem olhou). Sem cobertura
 * registrada a run é ignorada, nunca contada como aparição: inventar histórico faria o bloco do
 * prompt acusar o agente de não ter fechado um GAP que talvez ninguém tenha rejulgado.
 *
 * `times` = número de validações competentes em que o fingerprint apareceu, incluindo a atual. Só
 * volta ref com `times >= 2` porque é esse o contrato do `persistentGapFactBlock` (1 = novidade).
 */
export function stableRecurrenceRefs(
  runs: PastValidation[],
  filePath: string,
  dispatched: ValidationFinding[],
): PersistentGapRef[] {
  if (dispatched.length === 0) return [];
  const target = filePath.trim().toLowerCase();
  const base = target.slice(target.lastIndexOf("/") + 1);
  const competent = runs.filter((r) => {
    const judged = judgedFilesOf(r.coverage);
    if (!judged) return false;
    if (judged.has(target)) return true;
    for (const p of judged) if (p.slice(p.lastIndexOf("/") + 1) === base) return true;
    return false;
  });
  if (competent.length === 0) return [];
  const count = new Map<string, number>();
  for (const r of competent) {
    // `effectiveFingerprints` (e não `findingFingerprint` puro) porque é a MESMA identidade que o
    // `surveyFindings` usa para decidir ativo × resolvido: contar por outra régua produziria um
    // "times" que não corresponde a nenhuma contagem que o laço mostra ao humano.
    const fps = new Set(effectiveFingerprints(r.findings ?? []));
    for (const fp of fps) count.set(fp, (count.get(fp) ?? 0) + 1);
  }
  const refs: PersistentGapRef[] = [];
  for (const f of dispatched) {
    const fp = findingFingerprint(f);
    const times = count.get(fp) ?? 0;
    if (times < 2) continue;
    refs.push({
      fingerprint: fp,
      file: f.file ?? filePath,
      anchor: (f.anchor ?? null) || null,
      // Âncora ESTÁVEL: não houve rebatismo. `anchorBefore` igual à atual é o que faz o
      // `persistentGapFactBlock` imprimir uma âncora só, em vez de um "X → X" que confundiria.
      anchorBefore: (f.anchor ?? null) || null,
      title: String(f.title ?? "").slice(0, TITLE_SLICE),
      why: "",
      times,
      kind: "stable",
    });
  }
  refs.sort((a, b) => b.times - a.times);
  return refs.slice(0, REF_MAX);
}

/**
 * União das duas fontes de reincidência (reconciliador do GAP-67 × fingerprint estável).
 *
 * Conflito no mesmo fingerprint vence quem tem MAIOR `times`, e o `kind` do vencedor manda: as duas
 * medidas contam a mesma coisa por caminhos diferentes, e afirmar o número menor esconderia
 * linhagem já provada. O `renamed` do reconciliador é preferido em EMPATE porque ele carrega o
 * `anchorBefore` real e o `why` do revisor — mais informação para a mesma afirmação.
 */
export function mergeRecurrenceRefs(renamed: PersistentGapRef[], stable: PersistentGapRef[]): PersistentGapRef[] {
  const by = new Map<string, PersistentGapRef>();
  for (const r of renamed) by.set(r.fingerprint, r);
  for (const s of stable) {
    const prev = by.get(s.fingerprint);
    if (!prev || s.times > prev.times) by.set(s.fingerprint, prev && prev.times === s.times ? prev : s);
  }
  return [...by.values()].sort((a, b) => b.times - a.times).slice(0, REF_MAX);
}

/**
 * Marca nas refs quais âncoras a rodada ANTERIOR neste arquivo deixou intactas (fato A cruzado com o
 * fato B). É o que transforma "este GAP voltou" em "este GAP voltou **e você não encostou no trecho**"
 * — a diferença entre uma advertência genérica e uma instrução acionável.
 *
 * Casa por `anchorSearchKey` (não por igualdade crua): o log da rodada guarda a âncora como o juiz a
 * escreveu, e entre validações ela pode vir `§8.6 (c)` ou `8.6 (c)`.
 */
export function markUntouched(refs: PersistentGapRef[], untouched: string[]): PersistentGapRef[] {
  if (refs.length === 0 || untouched.length === 0) return refs;
  const keys = new Set(untouched.map(anchorSearchKey).filter(Boolean));
  return refs.map((r) => {
    const k = anchorSearchKey(r.anchor ?? "");
    return k && keys.has(k) ? { ...r, untouched: true } : r;
  });
}
