/**
 * gapOutcomes.ts — A1: DESFECHO NOMEADO por GAP despachado.
 *
 * ## O problema medido em prod
 *
 * O laço despacha N GAPs de um arquivo ao CTO-editor, recebe blocos SEARCH/REPLACE e depois
 * REVALIDA. O que aconteceu com cada GAP era, até aqui, sempre INFERIDO: se o defeito reaparece na
 * validação seguinte "não fechou"; se não reaparece "fechou". Duas leituras erradas nascem daí:
 *
 *  • um GAP que o agente NÃO conseguiu fechar (e sabia disso) só é descoberto uma validação depois,
 *    ao preço cheio de um passe inteiro de Opus 5 — e sem o MOTIVO, a rodada seguinte repete o
 *    mesmo pedido (é o motor da reincidência que o GAP-68/GAP-81 combatem por fora);
 *  • um GAP que o agente considera INEXISTENTE (o juiz errou) não tem canal nenhum: o agente escreve
 *    uma errata no arquivo declarando o trecho nulo, o arquivo cresce, o juiz relê o texto original
 *    e reabre o mesmo GAP. É o GAP-8 pela porta dos fundos.
 *
 * ## O desenho
 *
 * Quem diz o que aconteceu com cada GAP é o AGENTE (Lei do Jean: nada de automação fixa). O código
 * aqui só faz três coisas, todas mecânicas:
 *
 *  1. **transporta o pedido** — a lista de GAPs vai NUMERADA e o agente devolve, num bloco próprio,
 *     um verbo do vocabulário FECHADO por número;
 *  2. **veta corrupção** — número fora da lista, número repetido, verbo inventado, e a única
 *     contradição que é FATO verificável: declarar `corrigido` quando ZERO edição ancorada foi
 *     aplicada ao arquivo. Nada de similaridade de texto, nada de adivinhar desfecho;
 *  3. **declara a não-declaração** — GAP despachado sem desfecho vira `nao_declarado`, na mesma
 *     linha do C7 (`notMeasured`): "ninguém disse" é diferente de "está fechado".
 *
 * ## O que este módulo NÃO faz (deliberado)
 *
 * `nao_e_defeito` **não fecha GAP**. O desfecho é a POSIÇÃO do agente, não a decisão: o argumento
 * volta ao juiz na validação seguinte, e quem decide promovibilidade continua sendo ele (decisão do
 * Jean 2026-09-07). Um desfecho que apagasse GAP seria exatamente o fechamento fake que estamos
 * caçando — e o Jean foi explícito: "os agentes devem fechar … não podemos regredir e nem criar
 * falsos positivos".
 */
import type { ValidationFinding } from "./specValidation.js";
import { findingFingerprint } from "./findingTriage.js";

/**
 * Vocabulário FECHADO. Fechado porque desfecho é o que o laço LÊ para decidir a rodada seguinte:
 * verbo livre viraria prosa e a leitura voltaria a ser inferência.
 */
export const GAP_OUTCOME_VERBS = ["corrigido", "permanece_aberto", "nao_e_deste_arquivo", "nao_e_defeito"] as const;
export type GapOutcomeVerb = (typeof GAP_OUTCOME_VERBS)[number];

/** Desfecho de UM GAP despachado, do jeito que fica gravado no job (migração 112). */
export interface GapOutcome {
  /** Posição 1-based do GAP na lista que ESTE despacho enviou — a chave do contrato com o agente. */
  index: number;
  file: string;
  anchor: string | null;
  title: string;
  severity: string;
  /**
   * Identidade do GAP pela MESMA função que todo o resto do sistema usa (`findingFingerprint`,
   * âncora normalizada com fallback de título — GAP-49). Gravada no desfecho porque é o que permite,
   * na rodada seguinte, devolver o relato ao agente SEM comparar títulos por semelhança: ou o GAP
   * despachado agora tem o mesmo fingerprint, ou o relato antigo não fala dele.
   */
  fingerprint: string;
  /** `nao_declarado` NUNCA vem do agente: é o código dizendo que ninguém falou deste GAP. */
  verb: GapOutcomeVerb | "nao_declarado";
  /** O que o agente tentou / por que não fechou / onde deveria ser corrigido. Cru, do agente. */
  note: string;
  /**
   * Contradição MEDIDA entre o que o agente declarou e o que o arquivo recebeu. `null` = sem
   * contradição verificável. Não anula o desfecho (não é papel do código) — fica ao lado dele.
   */
  contested: string | null;
}

export interface GapOutcomeParse {
  outcomes: GapOutcome[];
  /** Linhas do bloco que o código RECUSOU, com o motivo — auditoria do veto. */
  rejected: Array<{ line: string; why: string }>;
  /** `false` = o agente não devolveu o bloco (ou devolveu vazio) ⇒ todos os GAPs `nao_declarado`. */
  ran: boolean;
}

const RE_OPEN = /^-{2,}\s*DESFECHO DOS GAPS\s*-{2,}$/i;
const RE_CLOSE = /^-{2,}\s*FIM DO DESFECHO\s*-{2,}$/i;
/** `12) permanece_aberto: …` — aceita `.`/`)`/`-` depois do número e `:`/`—`/`-` depois do verbo. */
const RE_ITEM = /^(\d{1,3})\s*[).:-]\s*([a-z_]{3,30})\s*[:—-]?\s*(.*)$/i;
const NOTE_MAX = 600;

/**
 * O bloco de INSTRUÇÃO que vai no pedido ao CTO-editor.
 *
 * Fica no fim do `user_message`, DEPOIS da lista de GAPs e ANTES da instrução de formato: é uma
 * qualificação da lista ("para cada item daquela lista, um verbo"), e longe dela o modelo lê como
 * pedido genérico e devolve prosa. Não descreve o que corrigir — só o contrato de prestação de contas.
 */
export function gapOutcomeInstruction(count: number): string {
  return [
    "--- PRESTAÇÃO DE CONTAS (obrigatória, e SEPARADA das edições) ---",
    `Depois dos blocos de edição, escreva um bloco declarando o que aconteceu com CADA um dos ${count} GAPs`,
    "acima, pelo NÚMERO com que ele apareceu na lista. Um verbo por GAP, deste vocabulário FECHADO:",
    "  • `corrigido` — você emitiu edição que resolve este GAP neste arquivo;",
    "  • `permanece_aberto` — você NÃO conseguiu fechar. Diga o que tentou e o que faltou;",
    "  • `nao_e_deste_arquivo` — a correção pertence a outro arquivo. Diga qual;",
    "  • `nao_e_defeito` — na sua avaliação o GAP não existe. Diga o argumento.",
    "Formato exato (uma linha por GAP, nada além disto dentro do bloco):",
    "--- DESFECHO DOS GAPS ---",
    "1) corrigido: passei a citar o oráculo em vez de redeclarar o contrato",
    "2) permanece_aberto: o valor normativo mora em outro arquivo e eu não podia editá-lo",
    "--- FIM DO DESFECHO ---",
    "REGRAS deste bloco:",
    "• `nao_e_defeito` NÃO apaga o GAP: seu argumento vai ao juiz na próxima validação, e é ele que decide.",
    "  Por isso NÃO escreva errata no arquivo declarando o trecho nulo — isso engorda a spec sem fechar nada.",
    "• Declarar `corrigido` sem ter emitido bloco de edição é contradição e fica registrada como tal.",
    "• GAP que você não citar fica registrado como NÃO DECLARADO — não como resolvido.",
    "--- FIM DA PRESTAÇÃO DE CONTAS ---",
  ].join("\n");
}

/** Recorta o bloco de desfecho. `null` = o agente não devolveu o bloco. */
export function extractOutcomeBlock(text: string): string[] | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let open = -1;
  // O ÚLTIMO bloco vence: o modelo às vezes repete o exemplo do enunciado antes de responder de
  // verdade, e o exemplo viria primeiro. Ler o último é ler a resposta, não a cópia do pedido.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (RE_OPEN.test(lines[i].trim())) { open = i; break; }
  }
  if (open === -1) return null;
  const body: string[] = [];
  for (let i = open + 1; i < lines.length; i += 1) {
    if (RE_CLOSE.test(lines[i].trim())) return body;
    body.push(lines[i]);
  }
  // Bloco aberto e nunca fechado (resposta cortada): o que chegou vale — cada linha é autocontida.
  return body;
}

function isVerb(v: string): v is GapOutcomeVerb {
  return (GAP_OUTCOME_VERBS as readonly string[]).includes(v);
}

/**
 * Lê o bloco de desfecho contra a lista EXATA que foi despachada.
 *
 * `appliedEdits` é o número de blocos ANCORADOS que o aplicador gravou no arquivo (GAP-12). Serve a
 * um único veto, e só ao caso em que a contradição é FATO: `corrigido` com zero edição aplicada.
 * Com uma edição ou mais, o código não tem como saber QUAL GAP ela fechou — e inventar o mapa seria
 * a automação fixa que a Lei proíbe.
 */
export function parseGapOutcomes(
  raw: string,
  dispatched: ValidationFinding[],
  opts: { appliedEdits: number },
): GapOutcomeParse {
  const base = (f: ValidationFinding, i: number): GapOutcome => ({
    index: i + 1,
    file: f.file,
    anchor: (f as { anchor?: string | null }).anchor ?? null,
    title: f.title,
    severity: f.severity ?? "info",
    fingerprint: findingFingerprint(f),
    verb: "nao_declarado",
    note: "",
    contested: null,
  });
  const outcomes = dispatched.map(base);
  const rejected: Array<{ line: string; why: string }> = [];
  const body = extractOutcomeBlock(raw);
  if (!body || body.every((l) => !l.trim())) return { outcomes, rejected, ran: false };

  const seen = new Set<number>();
  for (const line of body) {
    const t = line.trim();
    if (!t) continue;
    const m = RE_ITEM.exec(t);
    if (!m) {
      rejected.push({ line: t.slice(0, 200), why: "linha fora do formato `N) verbo: nota`" });
      continue;
    }
    const idx = Number(m[1]);
    const verb = m[2].toLowerCase();
    if (!Number.isInteger(idx) || idx < 1 || idx > dispatched.length) {
      rejected.push({ line: t.slice(0, 200), why: `GAP ${idx} não estava nesta lista (${dispatched.length} despachados)` });
      continue;
    }
    if (seen.has(idx)) {
      // Repetido é ambíguo: o primeiro fica (é o que o modelo decidiu antes de se corrigir sem dizer).
      rejected.push({ line: t.slice(0, 200), why: `GAP ${idx} declarado mais de uma vez — vale a primeira` });
      continue;
    }
    if (!isVerb(verb)) {
      rejected.push({ line: t.slice(0, 200), why: `verbo \`${verb}\` fora do vocabulário fechado` });
      continue;
    }
    seen.add(idx);
    const o = outcomes[idx - 1];
    o.verb = verb;
    o.note = m[3].trim().slice(0, NOTE_MAX);
    if (verb === "corrigido" && opts.appliedEdits <= 0) {
      o.contested = "declarou `corrigido` sem nenhuma edição ancorada ter sido aplicada ao arquivo";
    }
  }
  return { outcomes, rejected, ran: true };
}

/** Contagem por verbo — é o que vai ao log da rodada e ao chat, sem carregar as notas. */
export function summarizeOutcomes(outcomes: GapOutcome[]): Record<string, number> {
  const acc: Record<string, number> = {};
  for (const o of outcomes) acc[o.verb] = (acc[o.verb] ?? 0) + 1;
  const contested = outcomes.filter((o) => o.contested).length;
  if (contested > 0) acc.contestados = contested;
  return acc;
}

/**
 * Dos desfechos de uma rodada anterior, quais falam de um GAP que ESTE despacho está mandando.
 *
 * O casamento é por `fingerprint` — identidade, não semelhança. Um desfecho cujo GAP não está mais
 * na lista NÃO volta ao agente: falar de um defeito que o juiz já não vê seria pedir trabalho sobre
 * o que não existe (e é assim que a spec engorda, GAP-8). Desfecho antigo sem `fingerprint` (gravado
 * antes deste campo existir) é ignorado em vez de casado por título.
 */
export function selectPriorOutcomes(
  prior: GapOutcome[] | null | undefined,
  dispatched: ValidationFinding[],
): GapOutcome[] {
  if (!prior || prior.length === 0) return [];
  const alvo = new Set(dispatched.map((f) => findingFingerprint(f)));
  return prior.filter((o) => typeof o.fingerprint === "string" && o.fingerprint.length > 0 && alvo.has(o.fingerprint));
}

/**
 * O FATO que volta ao agente no despacho seguinte: o que ELE MESMO declarou sobre estes GAPs na
 * rodada anterior deste arquivo.
 *
 * Só entra o que muda a decisão desta rodada — `permanece_aberto` (com o que faltou),
 * `nao_e_defeito` (o argumento ainda não convenceu o juiz) e `corrigido` CONTESTADO (declarou e
 * nada foi aplicado). `corrigido` limpo e `nao_declarado` ficam fora: o primeiro já foi medido pela
 * revalidação, o segundo não afirma nada.
 *
 * `""` quando não há nada a dizer — bloco vazio no prompt seria ruído pago.
 */
export function priorOutcomeFactBlock(prior: GapOutcome[] | null | undefined): string {
  if (!prior || prior.length === 0) return "";
  const relevantes = prior.filter(
    (o) => o.verb === "permanece_aberto" || o.verb === "nao_e_defeito" || (o.verb === "corrigido" && o.contested),
  );
  if (relevantes.length === 0) return "";
  const linhas = relevantes.slice(0, 20).map((o) => {
    const onde = o.anchor ? ` (em: ${o.anchor})` : "";
    const nota = o.note ? ` — você disse: “${o.note.slice(0, 300)}”` : " — sem justificativa registrada";
    if (o.verb === "corrigido") {
      return `• ${o.title}${onde}: você declarou CORRIGIDO na rodada anterior, mas NENHUMA edição foi aplicada${nota}.`;
    }
    if (o.verb === "nao_e_defeito") {
      return `• ${o.title}${onde}: você declarou que NÃO É DEFEITO${nota}. O juiz releu o arquivo e manteve o GAP.`;
    }
    return `• ${o.title}${onde}: você declarou que PERMANECE ABERTO${nota}.`;
  });
  return [
    "--- O QUE VOCÊ DECLAROU NA RODADA ANTERIOR DESTE ARQUIVO (fato, não opinião) ---",
    ...linhas,
    relevantes.length > 20 ? `• … e mais ${relevantes.length - 20}.` : "",
    "Este é o seu próprio relato. Se o GAP continua na lista acima, a via anterior não resolveu:",
    "tente uma DIFERENTE. Se o obstáculo é real e está fora deste arquivo, diga `nao_e_deste_arquivo`",
    "e aponte o arquivo — repetir a mesma tentativa custa uma rodada e não muda o resultado.",
    "--- FIM DO SEU RELATO ANTERIOR ---",
    "",
  ].filter(Boolean).join("\n");
}

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

/**
 * O último relato declarado para ESTE arquivo deste projeto.
 *
 * Atravessa runs de propósito, pela mesma razão de `focusRoundsByFile` (GAP-81): os arquivos teimosos
 * do NVX atravessaram várias runs, e limitar à run corrente faria o relato desaparecer justamente nos
 * casos que ele existe para resolver. `null` = nenhum job deste arquivo pediu contas ainda — e o laço
 * então não afirma nada ao agente.
 */
export async function lastDeclaredOutcomes(
  db: Db,
  projectId: string,
  filePath: string,
): Promise<GapOutcome[] | null> {
  try {
    const r = (await db.query(
      `SELECT gap_outcomes FROM spec_chat_jobs
        WHERE project_id = $1 AND lower(file_path) = lower($2)
          AND gap_outcomes IS NOT NULL AND status = 'done'
        ORDER BY created_at DESC LIMIT 1`,
      [projectId, filePath],
    )).rows[0] as { gap_outcomes?: unknown } | undefined;
    const raw = r?.gap_outcomes;
    return Array.isArray(raw) ? (raw as GapOutcome[]) : null;
  } catch (e) {
    // Ler o relato é um AJUSTE do pedido: nenhuma falha aqui pode derrubar a rodada que ia escrever
    // o arquivo (mesma lei do `fileRounds`/`anchorHistory`).
    console.warn(`[GapOutcomes] lastDeclaredOutcomes falhou: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
