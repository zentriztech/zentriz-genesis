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
import { effectiveFingerprints, findingTitleFingerprint } from "./findingTriage.js";
import { cutEvidence } from "./evidenceCut.js";

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
   * Identidade do GAP pela MESMA função que o resto do sistema usa para decidir o que está ativo:
   * `effectiveFingerprints` (âncora normalizada, GAP-49, com desempate por título SÓ para os que
   * colidem). Gravada no desfecho porque é o que permite, na rodada seguinte, devolver o relato ao
   * agente SEM comparar títulos por semelhança.
   *
   * 🔴 Por que EFETIVO e não `findingFingerprint` cru: o primário é `file|source|anchor`, e dois
   * defeitos DISTINTOS sob a mesma seção têm o mesmo primário. Medido em prod 2026-09-08 numa
   * varredura das 98 últimas validações: **17 delas** têm ao menos um par colidido (ex.: run
   * `bcb1ada3`, `modelo-dados.md §11.3` — "job de retenção depende de infraestrutura" e "Etapa C
   * referencia 'o ADMIN corrente'" são dois GAPs diferentes com o mesmo primário). Com o primário
   * cru, o relato do GAP A voltaria ao agente colado no GAP B: falso positivo, exatamente o que não
   * podemos criar.
   */
  fingerprint: string;
  /**
   * Fingerprint de TÍTULO do mesmo GAP. Segundo degrau do casamento, para o caso em que a colisão
   * existe numa rodada e não na outra (aí o efetivo muda de valor sem o GAP mudar). Só é usado quando
   * é ÚNICO nos dois lados — título repetido (o caso `(sem título)` do GAP-50) não casa nada.
   */
  titleFingerprint: string;
  /** `nao_declarado` NUNCA vem do agente: é o código dizendo que ninguém falou deste GAP. */
  verb: GapOutcomeVerb | "nao_declarado";
  /** O que o agente tentou / por que não fechou / onde deveria ser corrigido. Cru, do agente. */
  note: string;
  /**
   * Contradição MEDIDA entre o que o agente declarou e o que o arquivo recebeu. `null` = sem
   * contradição verificável. Não anula o desfecho (não é papel do código) — fica ao lado dele.
   */
  contested: string | null;
  /**
   * 🔴 A2 — `corrigido` DESMENTIDO pela revalidação. Não é persistido: é derivado na LEITURA
   * (`lastDeclaredOutcomes`) e só vale se uma validação rodou DEPOIS da declaração e o GAP continua
   * na lista que o juiz devolveu.
   *
   * MEDIDO em prod 2026-09-08 (run `10b1a4e1`, passe 1): dos 10 GAPs declarados `corrigido` — todos
   * com edição ancorada aplicada, nenhum contestado — **5 continuavam na MESMA âncora** na validação
   * seguinte, com o título reescrito pelo juiz (jaccard 0,03..0,30). O agente corrige o SINTOMA
   * nomeado no título, não a contradição; e como o título muda, cada rodada parece progresso.
   *
   * Sem este campo o relato do A1 escondia exatamente o fato mais útil: `priorOutcomeFactBlock` só
   * devolvia `permanece_aberto`/`nao_e_defeito`/`corrigido` contestado — um `corrigido` "limpo" que
   * NÃO fechou não voltava ao agente, então ele repetia a mesma via.
   */
  refutedByJudge?: boolean;
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
  // Identidade calculada sobre a lista DESPACHADA inteira: é ela que define quem colide com quem.
  const effFps = effectiveFingerprints(dispatched);
  const base = (f: ValidationFinding, i: number): GapOutcome => ({
    index: i + 1,
    file: f.file,
    anchor: (f as { anchor?: string | null }).anchor ?? null,
    title: f.title,
    severity: f.severity ?? "info",
    fingerprint: effFps[i],
    titleFingerprint: findingTitleFingerprint(f),
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
 * O casamento é por IDENTIDADE, não semelhança, em dois degraus e com VETO DE AMBIGUIDADE:
 *
 *  1. fingerprint efetivo igual (os dois lados calculados por `effectiveFingerprints`);
 *  2. fingerprint de título igual — cobre a colisão que existe numa rodada e não na outra;
 *
 * e em ambos: se mais de um candidato casar, NADA é devolvido. Um relato colado no GAP errado é pior
 * que relato nenhum — o agente receberia como FATO ("você declarou que permanece aberto") algo que
 * disse sobre outro defeito. Perder o relato só custa uma rodada; inventá-lo cria falso positivo.
 *
 * Desfecho antigo sem `fingerprint` (gravado antes deste campo existir) é ignorado em vez de casado
 * por título por semelhança.
 */
export function selectPriorOutcomes(
  prior: GapOutcome[] | null | undefined,
  dispatched: ValidationFinding[],
): GapOutcome[] {
  if (!prior || prior.length === 0 || dispatched.length === 0) return [];
  const eff = effectiveFingerprints(dispatched);
  const titles = dispatched.map((f) => findingTitleFingerprint(f));
  const out = new Set<GapOutcome>();
  for (let i = 0; i < dispatched.length; i += 1) {
    const porFp = prior.filter((o) => typeof o.fingerprint === "string" && o.fingerprint.length > 0 && o.fingerprint === eff[i]);
    if (porFp.length === 1) { out.add(porFp[0]); continue; }
    if (porFp.length > 1) continue; // ambíguo do lado do relato ⇒ o laço não afirma nada
    // Degrau 2: só quando o título identifica UM GAP de cada lado.
    if (titles.filter((t) => t === titles[i]).length > 1) continue;
    const porTitulo = prior.filter((o) => typeof o.titleFingerprint === "string" && o.titleFingerprint.length > 0 && o.titleFingerprint === titles[i]);
    if (porTitulo.length === 1) out.add(porTitulo[0]);
  }
  return [...out];
}

/**
 * O FATO que volta ao agente no despacho seguinte: o que ELE MESMO declarou sobre estes GAPs na
 * rodada anterior deste arquivo.
 *
 * Só entra o que muda a decisão desta rodada — `permanece_aberto` (com o que faltou),
 * `nao_e_defeito` (o argumento ainda não convenceu o juiz), `corrigido` CONTESTADO (declarou e nada
 * foi aplicado) e, 🔴 A2, `corrigido` DESMENTIDO (a edição foi aplicada e o juiz, relendo depois,
 * manteve o defeito na mesma âncora — 5 de 10 casos medidos em prod). `nao_declarado` e o
 * `corrigido` que de fato fechou ficam fora: o primeiro não afirma nada e o segundo já saiu da lista.
 *
 * `""` quando não há nada a dizer — bloco vazio no prompt seria ruído pago.
 */
export function priorOutcomeFactBlock(prior: GapOutcome[] | null | undefined): string {
  if (!prior || prior.length === 0) return "";
  const relevantes = prior.filter(
    (o) => o.verb === "permanece_aberto" || o.verb === "nao_e_defeito"
      || (o.verb === "corrigido" && (o.contested || o.refutedByJudge)),
  );
  if (relevantes.length === 0) return "";
  const linhas = relevantes.slice(0, 20).map((o) => {
    const onde = o.anchor ? ` (em: ${o.anchor})` : "";
    // 🔴 GAP-128: citar o agente pela metade sem dizer que cortou faz ele defender uma frase que
    // não é a dele. O teto fica; o corte se declara.
    const nota = o.note ? ` — você disse: “${cutEvidence(o.note, 300)}”` : " — sem justificativa registrada";
    if (o.verb === "corrigido" && o.contested) {
      return `• ${o.title}${onde}: você declarou CORRIGIDO na rodada anterior, mas NENHUMA edição foi aplicada${nota}.`;
    }
    if (o.verb === "corrigido") {
      // A2: a edição FOI aplicada, o juiz releu o arquivo DEPOIS dela e o defeito continua nesta
      // âncora. É o fato que o agente não tem como deduzir do texto: a via que ele escolheu falhou.
      return `• ${o.title}${onde}: você declarou CORRIGIDO na rodada anterior e a edição FOI aplicada, mas o juiz releu o arquivo depois disso e o defeito CONTINUA nesta âncora${nota}. Não repita esta via.`;
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
 * 🔴 GAP-131 — a memória de tentativas tinha PROFUNDIDADE 1, e o agente repetia vias já refutadas.
 *
 * MEDIDO em prod (NVX LastMile, rodadas de 2026-09-08/09): agrupando os desfechos por identidade
 * (`fingerprint`), o MESMO GAP foi declarado `corrigido` **8×** (`visao-escopo.md §1.3`), 6× em três
 * outros e ≥3× em quinze — e `modelo-dados.md §7.2` teve **4 de 4** rodadas com o aviso "trecho
 * apontado ficou IDÊNTICO". No mesmo período o núcleo de ~40 GAPs importantes sobreviveu a TODAS as
 * validações (medição de herança: 47 = 40 herdados + 7 novos; 53 = 40 + 13; 49 = 49 + 0).
 *
 * A causa no código: `lastDeclaredOutcomes` lê **um** job (`LIMIT 1`). O agente recebia "na rodada
 * anterior você disse X e o juiz manteve o GAP" e mais nada — sem saber que já havia tentado outras
 * 6 vias, ele podia (e podia legitimamente) voltar a uma delas. `anchorHistories` (GAP-111/112) dá a
 * CONTAGEM de rodadas dedicadas, não o CONTEÚDO do que foi tentado.
 *
 * O conserto é transporte: entregar a cadeia de vias já tentadas, em ordem, com corte declarado.
 * Quem decide o que fazer com isso continua sendo o agente — inclusive contestar (`nao_e_defeito`) ou
 * apontar para fora (`nao_e_deste_arquivo`).
 */
/**
 * 🔴 GAP-132 — a janela e o piso do PRÓPRIO GAP-131 escondiam a cadeia.
 *
 * MEDIDO em prod logo após o deploy (run `7ba39011`, 2026-09-09 01:0x): com `jobs = 8` e
 * `minAttempts = 2`, das 4 primeiras rodadas dedicadas **só 1** recebeu o bloco de vias — as outras
 * três tinham GAP com reincidência `pior=8ª` e ZERO via entregue. A causa é aritmética, não conceitual:
 * a rodada dedicada RODA entre 6–9 GAPs do arquivo, então em 8 jobs cada identidade reaparece ~1×,
 * e o piso de 2 descartava justamente a 1ª repetição. Medição por arquivo (fingerprint despachado ×
 * vias visíveis): janela 8 ⇒ 3 de 13 arquivos com ≥2 vias; janela 24 ⇒ **12 de 13** com ≥1 via e uma
 * cadeia de **7** (`api-entregas-entregadores.md`).
 *
 * Piso volta a 1 porque UMA via refutada já é fato: se o GAP está sendo despachado agora, a validação
 * que veio depois daquela tentativa o MANTEVE — "nenhuma fechou o GAP" continua verdadeiro.
 */
export const ATTEMPT_HISTORY_JOBS = 24;
/** Quantos GAPs entram no bloco (os mais teimosos primeiro). Teto de custo, DECLARADO. */
export const ATTEMPT_HISTORY_GAPS = 6;
/** Quantas vias por GAP. As mais RECENTES são as que importam; o corte diz quantas ficaram fora. */
export const ATTEMPT_HISTORY_VIAS = 8;
/** Teto da nota de cada via — o bloco multiplica por via × GAP. */
export const ATTEMPT_NOTE_MAX = 220;

/** Uma via já tentada neste GAP, do jeito que o agente a declarou. */
export interface GapAttempt {
  verb: GapOutcomeVerb | "nao_declarado";
  note: string;
  contested: string | null;
}

/** A cadeia de tentativas de UM GAP, da mais antiga para a mais recente. */
export interface GapAttemptHistory {
  fingerprint: string;
  titleFingerprint: string;
  title: string;
  anchor: string | null;
  attempts: GapAttempt[];
}

/**
 * A cadeia de desfechos declarados para ESTE arquivo, agrupada por identidade do GAP.
 *
 * Atravessa runs pelo mesmo motivo do `lastDeclaredOutcomes`/`focusRoundsByFile` (GAP-81): os arquivos
 * teimosos do NVX atravessaram várias runs. `nao_declarado` fica FORA da cadeia: "ninguém disse" não é
 * uma via tentada, e entrar aqui faria o agente se defender de algo que não afirmou.
 */
export async function declaredAttemptHistory(
  db: Db,
  projectId: string,
  filePath: string,
  jobs: number = ATTEMPT_HISTORY_JOBS,
): Promise<GapAttemptHistory[]> {
  try {
    const rows = (await db.query(
      `SELECT gap_outcomes FROM spec_chat_jobs
        WHERE project_id = $1 AND lower(file_path) = lower($2)
          AND gap_outcomes IS NOT NULL AND status = 'done'
        ORDER BY created_at DESC LIMIT $3`,
      [projectId, filePath, Math.max(1, jobs)],
    )).rows as Array<{ gap_outcomes?: unknown }>;
    const porFp = new Map<string, GapAttemptHistory>();
    // `DESC` no SQL (queremos os N mais recentes) → percorrer ao contrário para a cadeia ficar
    // cronológica: o agente lê "1ª via … 2ª via …" na ordem em que tentou.
    for (const row of [...rows].reverse()) {
      const raw = row?.gap_outcomes;
      if (!Array.isArray(raw)) continue;
      for (const o of raw as GapOutcome[]) {
        const fp = typeof o?.fingerprint === "string" ? o.fingerprint : "";
        if (!fp || o.verb === "nao_declarado") continue;
        const rec = porFp.get(fp) ?? {
          fingerprint: fp,
          titleFingerprint: typeof o.titleFingerprint === "string" ? o.titleFingerprint : "",
          title: typeof o.title === "string" ? o.title : "",
          anchor: typeof o.anchor === "string" ? o.anchor : null,
          attempts: [],
        };
        rec.attempts.push({ verb: o.verb, note: typeof o.note === "string" ? o.note : "", contested: o.contested ?? null });
        // O título/âncora mais RECENTES ganham: é assim que o GAP é nomeado hoje.
        rec.title = typeof o.title === "string" && o.title ? o.title : rec.title;
        rec.anchor = typeof o.anchor === "string" && o.anchor ? o.anchor : rec.anchor;
        porFp.set(fp, rec);
      }
    }
    return [...porFp.values()];
  } catch (e) {
    // Mesma lei do `lastDeclaredOutcomes`: ler o histórico é um AJUSTE do pedido e nenhuma falha aqui
    // pode derrubar a rodada que ia escrever o arquivo.
    console.warn(`[GapOutcomes] declaredAttemptHistory falhou: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * Das cadeias lidas, as que falam de um GAP que ESTE despacho está mandando E que já têm ao menos uma
 * via tentada (GAP-132: o piso 2 escondia a 1ª repetição, que é onde o fato mais ajuda). Mesmo
 * casamento por IDENTIDADE do `selectPriorOutcomes` (fingerprint efetivo, depois título, com veto de
 * ambiguidade nos dois degraus): cadeia colada no GAP errado é falso positivo.
 */
export function selectAttemptHistory(
  history: GapAttemptHistory[] | null | undefined,
  dispatched: ValidationFinding[],
  minAttempts = 1,
): GapAttemptHistory[] {
  if (!history || history.length === 0 || dispatched.length === 0) return [];
  const eff = effectiveFingerprints(dispatched);
  const titles = dispatched.map((f) => findingTitleFingerprint(f));
  const out = new Set<GapAttemptHistory>();
  for (let i = 0; i < dispatched.length; i += 1) {
    const porFp = history.filter((h) => h.fingerprint === eff[i]);
    if (porFp.length === 1) { out.add(porFp[0]); continue; }
    if (porFp.length > 1) continue;
    if (titles.filter((t) => t === titles[i]).length > 1) continue;
    const porTitulo = history.filter((h) => h.titleFingerprint.length > 0 && h.titleFingerprint === titles[i]);
    if (porTitulo.length === 1) out.add(porTitulo[0]);
  }
  return [...out]
    .filter((h) => h.attempts.length >= minAttempts)
    .sort((a, b) => b.attempts.length - a.attempts.length);
}

/**
 * O bloco de FATO das vias já tentadas. Entra GAP com 1+ tentativa declarada (GAP-132): o
 * `priorOutcomeFactBlock` conta a rodada ANTERIOR do arquivo, que muitas vezes é de OUTRO GAP —
 * só esta cadeia diz "nesta âncora, você já tentou isto".
 *
 * Não manda o agente fazer nada específico: diz o que já foi tentado e lista as SAÍDAS legítimas
 * (editar dentro do trecho ancorado, apontar para fora, ou contestar com argumento). A escolha é dele
 * — código que escolhesse a via seria a automação fixa que a Lei do Jean proíbe.
 */
export function attemptHistoryFactBlock(history: GapAttemptHistory[] | null | undefined): string {
  if (!history || history.length === 0) return "";
  const entram = history.slice(0, ATTEMPT_HISTORY_GAPS);
  const linhas: string[] = [];
  for (const h of entram) {
    const onde = h.anchor ? ` (em: ${h.anchor})` : "";
    linhas.push(`• ${h.title}${onde} — ${h.attempts.length} tentativa(s) anterior(es), NENHUMA fechou o GAP:`);
    const vias = h.attempts.slice(-ATTEMPT_HISTORY_VIAS);
    const foraVias = h.attempts.length - vias.length;
    if (foraVias > 0) linhas.push(`    …⟨CORTADO: ${vias.length} de ${h.attempts.length} vias — as mais recentes⟩`);
    vias.forEach((a, i) => {
      const ordinal = h.attempts.length - vias.length + i + 1;
      const nota = a.note ? `“${cutEvidence(a.note, ATTEMPT_NOTE_MAX)}”` : "(sem justificativa registrada)";
      const extra = a.contested ? ` [contestado pelo código: ${a.contested}]` : "";
      linhas.push(`    ${ordinal}ª via — você declarou \`${a.verb}\`: ${nota}${extra}`);
    });
  }
  const cortados = history.length - entram.length;
  return [
    "--- VIAS QUE VOCÊ JÁ TENTOU NESTES GAPS (fato: seu próprio relato, rodadas anteriores) ---",
    ...linhas,
    cortados > 0 ? `• …⟨CORTADO: ${entram.length} de ${history.length} GAPs reincidentes — os mais teimosos⟩` : "",
    "Cada via acima foi seguida de uma revalidação que MANTEVE o GAP. Repetir qualquer uma delas custa",
    "uma rodada e não muda o resultado. Saídas legítimas: (a) editar DENTRO do trecho ancorado que o",
    "GAP aponta, mudando o texto que o juiz lê; (b) `nao_e_deste_arquivo` apontando onde a decisão vive;",
    "(c) `nao_e_defeito` com o argumento — que volta ao juiz e não fecha o GAP por si.",
    "--- FIM DAS VIAS JÁ TENTADAS ---",
    "",
  ].filter(Boolean).join("\n");
}

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
      // 🔴 A2: `judged_after` = uma validação com findings rodou DEPOIS desta declaração. Sem isso,
      // duas rodadas do mesmo arquivo no MESMO passe (sem revalidação entre elas) fariam todo
      // `corrigido` parecer desmentido — o GAP ainda estaria na lista por ser a MESMA medição.
      `SELECT j.gap_outcomes,
              EXISTS (SELECT 1 FROM spec_validation_runs v
                       WHERE v.project_id = $1 AND v.findings IS NOT NULL
                         AND v.created_at > j.created_at) AS judged_after
         FROM spec_chat_jobs j
        WHERE j.project_id = $1 AND lower(j.file_path) = lower($2)
          AND j.gap_outcomes IS NOT NULL AND j.status = 'done'
        ORDER BY j.created_at DESC LIMIT 1`,
      [projectId, filePath],
    )).rows[0] as { gap_outcomes?: unknown; judged_after?: boolean } | undefined;
    const raw = r?.gap_outcomes;
    if (!Array.isArray(raw)) return null;
    const outcomes = raw as GapOutcome[];
    // O desmentido é DERIVADO aqui e não gravado: quem chama só recebe `refutedByJudge` nos
    // `corrigido` cuja edição foi aplicada (sem `contested`) e que o juiz reviu depois. Quem decide
    // se o GAP casa com o despacho de agora continua sendo `selectPriorOutcomes`.
    if (!r?.judged_after) return outcomes;
    return outcomes.map((o) => (o.verb === "corrigido" && !o.contested ? { ...o, refutedByJudge: true } : o));
  } catch (e) {
    // Ler o relato é um AJUSTE do pedido: nenhuma falha aqui pode derrubar a rodada que ia escrever
    // o arquivo (mesma lei do `fileRounds`/`anchorHistory`).
    console.warn(`[GapOutcomes] lastDeclaredOutcomes falhou: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
