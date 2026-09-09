/**
 * gapClosureAudit.ts — 🔴 GAP-169: FECHAR GAP passa a exigir PROVA, não silêncio do juiz.
 *
 * ## O que foi medido (prod 2026-09-09, NVX LastMile `e2a1988c`, 39 validações em 36 h)
 *
 * ```
 * 186 âncoras (arquivo, âncora) distintas já vistas · 70–77 ATIVAS a qualquer instante
 * 56 RESSURREIÇÕES em 46 âncoras — ausentes ≥2 validações que JULGARAM o arquivo, depois VOLTARAM
 * piso do erro: 46 de 153 âncoras declaradas resolvidas voltaram = 30% de FECHAMENTO FALSO
 * custo: 1,44 ressurreição por validação contra ~6 aberturas ⇒ ~24% dos "GAPs novos" são REDESCOBERTA
 * cobertura já não explica: média de 11,7 arquivos julgados por inteiro em 13 (a rotação acabou)
 * ```
 *
 * O que explica é o **recall do juiz**: `arXiv:2609.03230` mede ~47% para defeito de requisito. Com
 * p ≈ 0,5, omitir o mesmo defeito em duas passadas seguidas tem chance ≈ 25% — a ordem exata dos 30%
 * medidos. Ou seja: **ausência de um juiz que vê metade não é prova de correção, em nenhuma quantidade
 * razoável de passadas.** O limiar `RESOLVED_AFTER_RUNS = 2` foi calibrado (GAP-20) quando a ausência
 * vinha da ROTAÇÃO DE COBERTURA; a rotação acabou, o limiar ficou, e passou a medir outra coisa.
 *
 * ## Por que isso é grave, e não contabilidade
 *
 * A única saída positiva do laço é `gaps.important === 0` (`specAutonomy.ts`), calculada sobre o
 * conjunto ATIVO — de onde os fechamentos por silêncio saíram. A saída positiva não era só
 * inalcançável (nenhuma convergência em 57 runs): era **insegura**, podia declarar "spec validada"
 * sobre spec com ~30% de defeito vivo escondido. O Jean foi explícito: *"os agentes devem fechar …
 * não podemos regredir e nem criar falsos positivos"*.
 *
 * ## O desenho (Lei 100% LLM)
 *
 * `gapOutcomes.ts` (A1) já matou a inferência do lado do AGENTE: cada GAP despachado volta com um verbo
 * declarado. Do lado do JUIZ o fechamento continuava inferido por silêncio. Agora:
 *
 *   ausência ≥2 runs que olharam  ⇒  CANDIDATO (não fecha nada, continua ATIVO)
 *   auditor de OUTRA família lê o texto ATUAL:
 *      `ausente` + citação verbatim  ⇒  FECHA, com prova, e a prova expira se o arquivo mudar
 *      `presente`                    ⇒  REABRE (o silêncio era cegueira)
 *      `indecidivel` / sem veredicto ⇒  continua ATIVO (fail-CLOSED)
 *
 * Quem decide é o agente. O código transporta o dossiê, confere se a citação existe no texto enviado
 * (transporte, não conteúdo) e amarra a prova ao sha do arquivo.
 *
 * ## Por que aqui o veredicto pode DECIDIR (e na auditoria de acusação não podia)
 *
 * Assimetria, e é o argumento central: para um finding PRESENTE, deixar `ausente` liberar seria
 * anistia — por isso `SPEC_CROSS_AUDIT` de 2026-09-07 só MEDE. Para um finding que o sistema **já
 * tratava como fechado às cegas**, `presente` só APERTA (reabre) e `ausente` apenas confirma COM PROVA
 * o que já era feito sem prova nenhuma. Exigir prova é **monotonicamente mais estrito** que o status
 * quo: não existe caminho em que esta mudança crie um fechamento que hoje não aconteceria.
 *
 * ## Economia de token (o pedido do Jean: assertivo, sem queimar token)
 *
 * Redescobrir um fechamento falso custa um passe inteiro do juiz Opus (~140k chars medidos no censo do
 * GAP-168) e acontece ~1,44× por validação. Verificar um candidato custa um dossiê mid-tier de outra
 * família (`amazon.nova-pro-v1:0`, teto de 40k chars). Trocar redescoberta por verificação é a troca
 * barata — e ainda tira do laço as rodadas gastas reabrindo o que nunca fechou.
 *
 * ## O que este módulo NÃO faz
 *
 * Não reclassifica severidade, não triaga (isso é do humano), não promove, e não inventa fechamento
 * quando o LLM está fora do ar: sem auditoria, nada fecha. Sem fallback burro
 * (`feedback-genesis-100-llm-nunca-automacao-fixa`).
 */
import { auditFindings, tally, type CrossFamilyAuditResult } from "./crossFamilyAudit.js";
import type { ClosureCandidate, Db } from "./findingTriage.js";

/**
 * Teto de candidatos por chamada. Alto o bastante para o laço andar (o NVX tinha 107 candidatos), baixo
 * o bastante para a fatura não ser surpresa. Sobra fica para a rodada seguinte — e a sobra é DECLARADA,
 * nunca cortada em silêncio (disciplina do A5.7).
 */
const CLOSURE_MAX_PER_ROUND = num(process.env.SPEC_CLOSURE_AUDIT_MAX, 25);

function num(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface ClosureAuditResult {
  ran: boolean;
  reason?: string;
  /** Candidatos que ENTRARAM nesta chamada (após o teto). */
  audited: number;
  /** Fecharam COM prova: `ausente` + citação conferida verbatim. */
  fechados: number;
  /** `ausente` SEM citação verbatim — não fecha, e o número existe para não parecer que fechou. */
  ausenteSemProva: number;
  /** O auditor achou o defeito no texto atual: o silêncio do juiz era cegueira. */
  reabertos: number;
  /** Ninguém pôde decidir — continua ATIVO. */
  indecidiveis: number;
  /** Candidatos que não couberam no teto desta rodada. */
  sobraram: number;
  falhas: number;
  model: string;
}

/**
 * Ordem de atendimento dos candidatos: **blocker antes de warning**, e dentro da severidade o mais
 * ANTIGO primeiro (maior `absentRuns`).
 *
 * Não é estética. Blocker é o que trava a promoção e o que ordena a fila de arquivos do laço; e o
 * candidato mais antigo é o que há mais tempo está mentindo na contagem — priorizar o recente deixaria
 * o passivo velho eternamente no fim da fila, que é a forma de um teto virar esquecimento.
 */
export function orderClosureCandidates(cands: ClosureCandidate[]): ClosureCandidate[] {
  const rank = (s: string) => (s === "blocker" ? 0 : s === "warning" ? 1 : 2);
  return [...cands].sort((a, b) => {
    const r = rank(a.finding.severity) - rank(b.finding.severity);
    if (r !== 0) return r;
    return b.absentRuns - a.absentRuns;
  });
}

/**
 * Audita os candidatos a fechamento com um modelo de OUTRA família.
 *
 * Reusa `auditFindings` inteiro de propósito: mesmo dossiê que o CTO-editor recebe (lição do GAP-72 —
 * o auditor não pode ser mais cego que o escritor, senão `indecidivel` vira o veredicto padrão: medido
 * 8/10 na run `2eafbd95` quando ele só via a seção ancorada), mesmo prompt, mesma checagem de citação.
 * Duas máquinas de julgar o mesmo texto divergiriam, e a divergência apareceria como progresso.
 */
export async function auditClosureCandidates(db: Db, args: {
  projectId: string;
  candidates: ClosureCandidate[];
  validationRunId?: string | null;
  autonomyRunId?: string | null;
  llm?: Record<string, unknown> | null;
  max?: number;
}): Promise<ClosureAuditResult> {
  const max = args.max && args.max > 0 ? args.max : CLOSURE_MAX_PER_ROUND;
  const ordered = orderClosureCandidates(args.candidates);
  const lote = ordered.slice(0, max);
  const sobraram = ordered.length - lote.length;
  const base = { audited: 0, fechados: 0, ausenteSemProva: 0, reabertos: 0, indecidiveis: 0, sobraram, falhas: 0 };

  if (lote.length === 0) {
    return { ran: false, reason: "nenhum candidato a fechamento", ...base, model: "" };
  }

  let res: CrossFamilyAuditResult;
  try {
    res = await auditFindings(db, {
      projectId: args.projectId,
      findings: lote.map((c) => c.finding),
      validationRunId: args.validationRunId ?? null,
      autonomyRunId: args.autonomyRunId ?? null,
      llm: args.llm ?? null,
      purpose: "fechamento",
      max,
    });
  } catch (e) {
    // Falha da auditoria NÃO fecha e NÃO reabre: o candidato continua ATIVO, que é onde ele já estava.
    return { ran: false, reason: `auditoria falhou: ${e instanceof Error ? e.message : String(e)}`, ...base, model: "" };
  }

  if (!res.ran) return { ran: false, reason: res.reason, ...base, model: res.model };

  const t = tally(res.audits);
  return {
    ran: true,
    audited: res.audits.length,
    // `ausenteComProva` é a única classe que fecha — e é a MESMA régua que `loadClosureProofs` usa para
    // ler a prova depois. Contar aqui por `ausente` cheio faria o log prometer fechamento que a leitura
    // seguinte não confirmaria (a família do log mentiroso, GAP-45/46).
    fechados: t.ausenteComProva,
    ausenteSemProva: t.ausente - t.ausenteComProva,
    reabertos: t.presente,
    indecidiveis: t.indecidivel,
    sobraram,
    falhas: res.failed,
    model: res.model,
  };
}

/**
 * A frase que vai ao chat/log. Diz os quatro destinos e o que sobrou — nunca só o número bom.
 *
 * Regra da casa: cortar é aceitável, mentir sobre o corte não é. Um candidato que não foi auditado
 * continua ATIVO e isso aparece aqui, senão o Jean leria "3 fechados" como "3 a menos".
 */
export function describeClosureAudit(r: ClosureAuditResult): string {
  if (!r.ran) return `verificação de fechamento não rodou — ${r.reason ?? "motivo não declarado"}.`;
  const partes = [
    `${r.audited} candidato(s) verificado(s) por ${r.model}`,
    `**${r.fechados} fechado(s) COM prova**`,
    `${r.reabertos} REABERTO(s) (o defeito ainda está no texto)`,
    `${r.indecidiveis} indecidível(is)`,
  ];
  if (r.ausenteSemProva > 0) partes.push(`${r.ausenteSemProva} disse(ram) "ausente" SEM citação verbatim — não fecha`);
  if (r.falhas > 0) partes.push(`${r.falhas} falha(s) de auditoria`);
  if (r.sobraram > 0) partes.push(`${r.sobraram} candidato(s) ficaram para a próxima rodada e seguem ATIVOS`);
  return `${partes.join(", ")}.`;
}
