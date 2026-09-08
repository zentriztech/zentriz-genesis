/**
 * specAutonomy.ts — MODO AUTÔNOMO da Bancada (migração 090).
 *
 * Pedido do Jean (2026-09-05): *"[x] Ativar modo autônomo, para o CTO entrar em modo recursivo
 * registrando ações e resolver os GAPs atuais, rodar o validar, e repetir até 5 vezes"*, com
 * *"apenas GAPs vermelhos e amarelos sustenta a necessidade de mais uma rodada"*.
 *
 * O que isto automatiza são as QUATRO ações manuais de hoje, encadeadas pelo servidor:
 *   Resolver GAPs (CTO) → Salvar rascunho (disco) → Validar (adversarial) → contar GAPs → repetir.
 * O passo "Salvar rascunho" é o que o humano esquecia: a validação lê do DISCO, então sem a
 * escrita a rodada seguinte revalidaria a spec ANTIGA e o laço nunca convergiria.
 *
 * DESENHO (ver project/docs/plans/BANCADA-MODO-AUTONOMO-GAPS-2026-09-05.md):
 *  • Estado 100% no Postgres (`spec_autonomy_runs`) e avanço pelo tick de 20 s do specChatWorker —
 *    zero processos novos, e um restart da api no meio de uma rodada NÃO perde o laço.
 *  • Toda transição é um claim (`WHERE id = $ AND status = <esperado>` + rowCount): dois ticks
 *    sobrepostos não aplicam a mesma spec duas vezes.
 *  • Cada rodada grava um item em `rounds` (JSONB) — o "registrando ações" do pedido — e um turno
 *    de assistente em `spec_chat_messages`, para as ações aparecerem NO CHAT da Bancada.
 *  • Reusa o caminho do botão manual (`dispatchResolveGapsJob` → mesmo contexto, prompt e gate H4)
 *    e o ciclo de validação (`startValidation` + `projectFindingsState`). Nada é reimplementado.
 *
 * GUARDAS (cada uma fecha um modo de falha real deste sistema — GAPs A–L do plano):
 *  • edição humana no meio do laço → NÃO sobrescreve (stalled);
 *  • revisão que ENCOLHE a spec (< 70% dos chars) → NÃO aplica (stalled);
 *  • spec idêntica / GAPs que não caem 2× seguidas → stalled (não queima as 5 rodadas em vão);
 *  • `SPEC_EDITABLE_STATUSES` revalidado a CADA rodada (a spec pode entrar em fábrica no meio);
 *  • rate-limit de 4 validações/h NÃO derruba o laço: a rodada espera e revalida no tick seguinte;
 *  • deadline global + kill-switch `SPEC_AUTONOMY=off`.
 *
 * PR-5 (2026-09-05) — MODO POR ARQUIVO (migração 095). Com a spec dividida (PR-3) o arquivo
 * primário é só o ÍNDICE: o laço acima mandaria o índice ao CTO normalizador e receberia uma spec
 * inteira de volta — a MESMA causa do truncamento de 64k tokens de saída que este épico mata. Com
 * 2+ arquivos na árvore o laço passa a operar assim:
 *
 *   fila de arquivos (mais blockers primeiro, specGapScope/094)
 *     → 1 ARQUIVO por rodada (CTO-EDITOR escopado, só os GAPs daquele arquivo)
 *     → escreve NAQUELE arquivo (snapshot + guardas idênticas)
 *     → repete até a fila esvaziar  → então UMA validação adversarial (PASSE) → mede e recomeça.
 *
 * Por que a validação só no fim do passe: ela é caríssima (2 estágios de LLM sobre a spec inteira) e
 * limitada a 4/h por spec — validar depois de cada arquivo esgotaria o limite antes do 5º arquivo.
 * Por isso `max_rounds` (o teto do Jean) passa a contar PASSES, e `round` conta arquivos revisados,
 * com teto próprio (`AUTONOMY_MAX_FILE_ROUNDS`) só para limitar o custo.
 *
 * Falha em UM arquivo (CTO recusou, revisão truncada, encolhimento) NÃO derruba o laço: o arquivo é
 * marcado como tratado no passe, com o motivo no log, e a fila segue. Duas falhas de arquivo
 * SEGUIDAS param (o problema não é do arquivo, é do modelo/serviço). O que continua derrubando o
 * laço é o que é do PROJETO: edição humana, spec que saiu de edição, snapshot indisponível.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { sha256Hex } from "../lib/specTreeHash.js";
import {
  projectFindingsState, gapDeltaSinceLastRun, findingFingerprint, comparableTallySinceLastRun,
  judgedFilesOf, fileJudgedIn, type EnrichedFinding,
} from "./findingTriage.js";
// 🔴 GAP-77 — a autoridade do juiz sobre promovibilidade (ver gapPromotionVerdict.ts). O laço monta os
// fatos de elegibilidade; quem julga é agente. Só o TIPO entra aqui: o módulo alcança
// `routes/specs.js` → `db/client.js` e é carregado por `import()` dinâmico nos DOIS fins de laço em que
// o veredicto existe — o caminho comum não paga por ele (mesma disciplina do `specGapScope`).
import type {
  CandidateGate, VerdictRound, PromotabilityReport, WorkProof, LoopWork,
} from "./gapPromotionVerdict.js";
import { reconcileGapDelta, buildPersistentRefs, type PersistentGapRef } from "./gapContinuity.js";
// 🔴 GAP-71 — os dois FATOS que dizem ao CTO que a errata dele não fechou o GAP (ver gapPersistence.ts).
import { untouchedAnchors, stableRecurrenceRefs, mergeRecurrenceRefs, markUntouched } from "./gapPersistence.js";
import { planFocus } from "./gapFocus.js";
import { startValidation, unjudgedSpecFiles, type ValidationFinding } from "./specValidation.js";
import { getSpecChatJob } from "./specChatJobs.js";
import { snapshotSpecFile } from "./specSnapshots.js";
import { resolveWorkbenchLlm, agentsLlmFields } from "./tenantLlmConfig.js";
// Só o TIPO: o módulo em si é carregado por `import()` dinâmico apenas no modo por arquivo (ele
// alcança `routes/specs.js` → `db/client.js`, que o modo `whole` não precisa pagar).
import type { GapFileBucket, GapGroups } from "./specGapScope.js";
import { MANIFEST_PATH, assessManifest, expectedArchetype } from "./specManifest.js";

type Db = Pick<Pool, "query" | "connect">;

export type AutonomyStatus =
  | "pending" | "cto_running" | "applying" | "validating"
  | "succeeded" | "exhausted" | "stalled" | "failed" | "stopped";

const ACTIVE_STATUSES: AutonomyStatus[] = ["pending", "cto_running", "applying", "validating"];

/** Teto de rodadas do pedido do Jean. Serve de teto DURO também para o body da rota. */
export const AUTONOMY_MAX_ROUNDS = 5;
/**
 * Deadline global: 5 rodadas × (40 min de teto do job do CTO + validação) ≈ 3,75 h. 4,5 h dá
 * folga sem deixar um laço órfão vivo para sempre. Expira a ESPERA, nunca o TRABALHO.
 */
export const AUTONOMY_DEADLINE_MS = 4.5 * 60 * 60_000;
/** Abaixo disto a "revisão" perdeu conteúdo — o CTO normalizador já descartou spec em prod. */
const MIN_SHRINK_RATIO = 0.7;
/** Duas rodadas seguidas sem derrubar GAP importante = o modelo não está convergindo. */
const MAX_NO_PROGRESS = 2;
/**
 * Teto de RODADAS-ARQUIVO **por passe**. Existe só para limitar custo: um arquivo revisado pelo
 * CTO-editor custa ~1/10 de uma rodada de spec inteira, então 12 arquivos cabem folgadamente no
 * orçamento de uma rodada antiga. Quem manda na convergência é `max_rounds` (passes), não este número.
 *
 * GAP-3 (medido 2026-09-06): este teto era GLOBAL (`round >= 12`, e `round` nunca zera). Com uma spec
 * de 11 arquivos, o passe 1 consumia 8 rodadas e o passe 2 morria na 4ª — o laço encerrava em
 * `exhausted` com "teto de 12 arquivos", tendo feito UM único passe de validação, embora a UI e a
 * própria mensagem anunciassem "até 5 passes". Provado nos runs `a4ad542f` (morreu exatamente em
 * `round=12`, `passes=1`) e `dd587b75` (`round=9` ao ENTRAR no passe 2). Agora o teto conta o passe
 * corrente; o custo total continua limitado por `AUTONOMY_MAX_TOTAL_FILE_ROUNDS`, pelo `max_rounds`
 * e pelo `AUTONOMY_DEADLINE_MS`.
 */
export const AUTONOMY_MAX_FILE_ROUNDS = 12;
/**
 * Teto ABSOLUTO de rodadas-arquivo do laço inteiro (todos os passes). É a trava de custo que o teto
 * por passe deixou de ser: 5 passes × 12 arquivos seria caro demais para rodar sem humano na frente.
 */
export const AUTONOMY_MAX_TOTAL_FILE_ROUNDS = 30;
/** Duas falhas SEGUIDAS em nível de arquivo = o problema é o modelo/serviço, não o arquivo. */
const MAX_FILE_FAILURES = 2;

/**
 * Kill-switch sem redeploy. **Nasce DESLIGADO** (G4, 2026-09-05): a feature escreve na spec do
 * cliente sem humano no meio, então qualquer instalação nova (dev, homolog, um deploy futuro que
 * esqueça o `.env`) tem de ser fail-closed. Em prod a flag é ligada EXPLICITAMENTE no `.env`.
 */
export function autonomyEnabled(): boolean {
  return (process.env.SPEC_AUTONOMY ?? "off").trim().toLowerCase() !== "off";
}

// ── T2: guarda de INTEGRIDADE da revisão (truncamento / perda de seções) ─────

/** Títulos de seção de nível 2 — a unidade que o CTO normalizador perde quando corta. */
function headingsOf(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[1].trim().toLowerCase());
  }
  return out;
}

/** Cercas de código abertas e não fechadas indicam documento cortado no meio de um bloco. */
function fenceCount(md: string): number {
  let n = 0;
  for (const line of md.split("\n")) if (/^\s*```/.test(line)) n += 1;
  return n;
}

export type RevisionIntegrity =
  | { ok: true; removedSections?: string[] }
  | { ok: false; reason: string; detail: string };

/**
 * Recusa aplicar uma revisão INCOMPLETA. Medido em prod 2026-09-05: a spec do NVX LastMile
 * (98.045 chars) faz o CTO regenerar o documento inteiro e bater no teto de 64k tokens de SAÍDA
 * do Opus 5 — `stop_reason=max_tokens`. O texto para no meio de uma linha (`… ON deliveries(
 * courier_id) WHERE`) e, se aplicado, o que o modelo não chegou a reescrever é APAGADO da spec.
 * A guarda de encolhimento (70%) não pega isso: cortar 3 das 14 seções ainda deixa 80% dos chars.
 *
 * Três sinais, do mais forte para o mais fraco:
 *  1. `truncated` — o próprio provedor disse que cortou (`_truncated` do runtime);
 *  2. contagem de `##` menor que a base — tolerante a RENOMEAÇÃO (o set-diff só compõe a mensagem);
 *  3. cerca ``` ímpar quando a base tinha número par — bloco de código aberto e nunca fechado.
 *
 * 🔴 GAP-12 (medido 2026-09-06, run `c3757985`, passe 1, rodada 1) — `anchoredEdits`.
 *
 * O sinal 2 é uma HEURÍSTICA de truncamento do formato ARQUIVO INTEIRO, e estava sendo aplicada
 * também a conteúdo que veio de EDIÇÕES ancoradas. Consequência medida: o laço finalmente removeu as
 * quatro seções-fantasma que o próprio sistema havia escrito na spec do cliente por causa do GAP-10
 * (`contrato mínimo … substitui X enquanto ausente`) — `6 aplicadas, 0 descartadas,
 * 34531→28232 chars` — e esta função **descartou a rodada paga** (in=46.907 / out=21.190 tokens)
 * porque a contagem de `##` caiu de 9 para 6. É a explicação mecânica do GAP-8 (a spec só cresce
 * ~18% por rodada): o código vetava a ÚNICA operação capaz de encolhê-la, e vetava justamente o
 * conserto do estrago que ele mesmo tinha causado.
 *
 * Por que é seguro liberar no formato `edits` — e só nele: uma seção só desaparece por um bloco
 * SEARCH/REPLACE **completo**, cuja âncora casou byte a byte e de forma única no arquivo do disco
 * (bloco incompleto é descartado antes de tocar o arquivo — `specFileEdits.ts`). Ou seja, remoção em
 * `edits` é DECISÃO do agente (LEI: estrutura e conteúdo de spec são decisão de agente), não perda
 * por corte. O que continua vetando corrupção: `truncated`, cerca ímpar, âncora inexistente/ambígua,
 * marcador no REPLACE (GAP-9) e o teto de encolhimento em chars (`MIN_SHRINK_RATIO`, no chamador) —
 * mais o snapshot obrigatório e o versionamento da spec, que tornam a remoção reversível.
 *
 * A remoção liberada NÃO é silenciosa: os títulos que sumiram voltam em `removedSections` para o
 * chamador escrever no log da rodada e no chat ("cortar é aceitável, mentir sobre o corte não").
 */
export function assessRevisionIntegrity(
  base: string,
  revised: string,
  truncated: boolean,
  opts: { anchoredEdits?: boolean } = {},
): RevisionIntegrity {
  if (truncated) {
    return {
      ok: false,
      reason: "truncada no teto de saída do modelo",
      detail: `a resposta do CTO foi CORTADA no limite de tokens de saída — o fim do documento não chegou a ser gerado (revisão com ${revised.length} caracteres; a spec atual tem ${base.length})`,
    };
  }
  const baseHeads = headingsOf(base);
  const revHeads = headingsOf(revised);
  const removed = baseHeads.filter((h) => !revHeads.includes(h));
  if (revHeads.length < baseHeads.length && opts.anchoredEdits !== true) {
    const missing = removed.slice(0, 6);
    return {
      ok: false,
      reason: "seções desaparecidas",
      detail: `a revisão tem ${revHeads.length} seções contra ${baseHeads.length} da spec atual` +
        (missing.length ? ` — sumiram, entre outras: ${missing.map((h) => `“${h}”`).join(", ")}` : ""),
    };
  }
  const baseFences = fenceCount(base);
  const revFences = fenceCount(revised);
  if (revFences % 2 === 1 && baseFences % 2 === 0) {
    return {
      ok: false,
      reason: "bloco de código aberto",
      detail: `a revisão terminou com um bloco de código sem fechar (${revFences} cercas, ímpar) — sinal de documento cortado no meio`,
    };
  }
  // Só reporta como REMOÇÃO quando a contagem líquida caiu: com contagem igual ou maior, um título
  // que "sumiu" do set é RENOMEAÇÃO (que o sinal 2 sempre tolerou de propósito), não perda.
  return revHeads.length < baseHeads.length && removed.length > 0
    ? { ok: true, removedSections: removed }
    : { ok: true };
}

export interface AutonomyRoundLog {
  round: number;
  startedAt: string;
  finishedAt?: string;
  /** PR-5: arquivo tratado nesta rodada (`null`/ausente = rodada de spec inteira). */
  filePath?: string | null;
  /** PR-5: a que PASSE de validação esta rodada pertence (0-based). */
  pass?: number;
  chatJobId?: string | null;
  validationRunId?: string | null;
  gapsBefore?: number | null;
  gapsAfter?: number | null;
  blockers?: number | null;
  warnings?: number | null;
  applied?: boolean;
  specChars?: number | null;
  /**
   * GAP-28: quanto ESTA rodada acrescentou (+) ou removeu (−) de caracteres. É o que permite ao passe
   * ter um orçamento de crescimento único em vez de um teto por arquivo. Ausente em rodadas antigas ⇒
   * conta como 0 (não inventa gasto retroativo).
   */
  deltaChars?: number | null;
  /**
   * GAP-29: a rodada foi DESCARTADA pelo veto de consolidação — aqui fica o tamanho que ela tinha
   * entregado e a margem que havia. Serve à tentativa SEGUINTE deste arquivo: sem este fato, o laço
   * repete uma tentativa já reprovada ao preço cheio de Opus 5 (medido: `autenticacao-sessao.md`
   * entregou +2.661 e depois +2.740 contra margens de 580 e 1.143 — quase a MESMA resposta, 3 vezes).
   *
   * GAP-31: o MOTIVO textual também é gravado, porque o veto tem DUAS causas (estourar a margem do
   * passe **ou** não consolidar nada — nem citar o oráculo nem encolher). Sem `rejectedReason` o fato
   * devolvido ao agente atribuía toda recusa a tamanho: numa recusa por "não consolidou" com delta
   * pequeno, o laço diria "você entregou +50 chars contra margem de 2.000" — verdadeiro nos números e
   * MENTIROSO na causa, mandando o agente encolher quando o pedido era citar o oráculo.
   */
  rejectedDelta?: number | null;
  rejectedBudget?: number | null;
  rejectedReason?: string | null;
  /**
   * GAP-38: a margem ANUNCIADA ao agente no despacho desta rodada. Só a RECUSA era registrada, então a
   * afirmação "o agente sabia onde estava a linha" (o contrato de saída do GAP-25) era indemonstrável:
   * dava para ver que a revisão estourou, não o que tinha sido pedido. Com o anunciado no log, comparar
   * pedido × entrega é aritmética — foi assim que se mediu que 447 anunciados voltaram como +1.431.
   */
  announcedBudget?: number | null;
  /**
   * 🔴 GAP-64: chars que a rodada passou da margem e o laço decidiu PAGAR em vez de descartar a rodada
   * inteira (quase-conformidade). Presente só quando > 0. O contrário do `rejectedDelta`: ali a margem
   * foi estourada e nada foi escrito; aqui foi estourada por pouco, o texto foi escrito e a dívida
   * aparece automaticamente como margem menor nas rodadas seguintes (`growthAllowance`).
   */
  toleratedOverflow?: number | null;
  /**
   * 🔴 GAP-70: a parcela do `toleratedOverflow` que só passou porque a rodada **consolidou** (citou o
   * oráculo) e o laço lhe EMPRESTOU chars do pool do passe. Separada do `toleratedOverflow` porque é
   * ela que consome o pool: se a tolerância comum do GAP-64 também o consumisse, um estouro sem
   * nenhuma relação com consolidação esgotaria a graça de quem realmente removeu redeclaração.
   */
  consolidationGrace?: number | null;
  /**
   * GAP-41: a diferença finding-a-finding do PASSE — quantos GAPs saíram e quantos entraram. O
   * agregado (`gapsBefore`/`gapsAfter`) pode ficar parado com o laço fechando e abrindo a mesma
   * quantidade; foi exatamente o que aconteceu em prod, e sem estes dois números não havia como
   * distinguir "não fez nada" de "fez e a reformulação comeu o resultado".
   */
  gapsClosed?: number | null;
  gapsOpened?: number | null;
  /**
   * 🔴 GAP-76 — o NÍVEL de GAPs no subconjunto que ESTA validação e a anterior julgaram por inteiro.
   *
   * `gapsBefore`/`gapsAfter` são agregados do PROJETO, e o agregado sobe e desce sozinho por rotação de
   * cobertura: medido em prod, 23 → 20 findings sem uma única âncora fechada, só porque um arquivo saiu
   * do julgamento integral. Estes campos são a única leitura de nível auditável — `comparableFiles = 0`
   * significa "as duas validações não julgaram nenhum arquivo em comum", e aí nem eles valem como nível.
   */
  gapsComparableBefore?: number | null;
  gapsComparableNow?: number | null;
  gapsComparableSame?: number | null;
  comparableFiles?: number | null;
  /**
   * 🔴 GAP-77 — a rodada adversarial de promovibilidade, quando ela aconteceu (só nos fins de laço).
   *
   * `verdictImpeditive` é o número que decide a entrega à Fábrica; `gapsAfter` continua sendo o total
   * importante, e os dois convivem de propósito — o limite (a) do Jean é que a severidade não muda, e
   * esconder o total faria o parecer parecer reclassificação. `verdictRejected` guarda a auditoria das
   * guardas de elegibilidade (por que cada GAP NÃO pôde ser julgado).
   */
  verdictCandidates?: number | null;
  verdictReleased?: number | null;
  verdictImpeditive?: number | null;
  promotable?: boolean | null;
  verdictRejected?: string[] | null;
  /**
   * 🔴 GAP-82 — QUAL prova de trabalho abriu a porta do veredicto, e os números que a sustentam.
   *
   * `workProof` é `resolved` (fechou GAPs) ou `exhausted` (gastou o orçamento inteiro e fechou zero).
   * `gapsClosedTotal` é o total fechado E reconciliado na run — vai gravado inclusive quando é `0`,
   * porque é essa a informação que impede o parecer de parecer aprovação de trabalho que não houve.
   */
  workProof?: "resolved" | "exhausted" | "none" | null;
  verdictWork?: string | null;
  gapsClosedTotal?: number | null;
  verdictFocusRounds?: number | null;
  /**
   * 🔴 F2 — o POLICY GATE no log, com a COBERTURA junto do resultado.
   *
   * `policyBlocking` é o único número que pesou no veredicto; `policyJudged`/`policyJudgeable` estão do
   * lado dele porque sem eles um `policyBlocking: 0` seria indistinguível de "o juiz não olhou nada" —
   * é exatamente a confusão que fez `21 → 1 GAP` passar por progresso no GAP-13. `policyPending` são
   * as constraints de build/runtime, que a Bancada não pode decidir e a frente F3 vai executar.
   * Todos `null` ⇒ o gate não rodou, e nenhuma constraint pesou (fail-CLOSED, comportamento antigo).
   */
  policyConstraints?: number | null;
  policyJudged?: number | null;
  policyJudgeable?: number | null;
  policySatisfied?: number | null;
  policyBlocking?: number | null;
  policyPending?: number | null;
  policyNote?: string | null;
  /**
   * 🔴 GAP-67 — quantos daqueles "fechado + novo" eram O MESMO defeito com âncora nova.
   *
   * Sem este número, `gapsClosed`/`gapsOpened` não são auditáveis: em prod (run `b1bc1195`, passe 1)
   * `11 fechado / 12 novo` tinha 8+ pares idênticos, só renumerados pela edição do CTO. `null` ⇒ a
   * reconciliação NÃO rodou e os dois números acima são crus (limite superior, não medida).
   */
  gapsPersisted?: number | null;
  /**
   * 🔴 GAP-68 — QUAIS defeitos sobreviveram à edição, não só quantos.
   *
   * `gapsPersisted` é o número; sem a identidade, o fato morre no log e o CTO recebe o mesmo defeito
   * como novidade na rodada seguinte — reescreve a seção, a âncora muda outra vez, e a spec engorda
   * (o motor medido do GAP-8). Estas refs são o que volta ao agente em `persistentGapFactBlock`, com
   * a linhagem (`times`) acumulada entre rodadas. Ausente/`null` ⇒ a reconciliação não rodou ou não
   * achou reincidente, e aí o laço NÃO afirma nada ao agente.
   */
  persistedGaps?: PersistentGapRef[] | null;
  /**
   * 🔴 GAP-71 — as âncoras dos GAPs que ESTA rodada mandou ao CTO, gravadas no DESPACHO.
   *
   * Existem porque o fato do GAP-71 só pode ser medido na APLICAÇÃO (é aí que se tem o texto de antes
   * e o de depois) e nesse tick o escopo dos findings já não está em memória — o laço relê a run do
   * banco. Sem as âncoras no log, medir "o agente encostou no trecho apontado?" exigiria refazer o
   * roteamento de GAPs, que custa LLM.
   */
  gapAnchors?: string[] | null;
  /**
   * 🔴 GAP-71 — destas âncoras, quais tiveram o trecho ancorado INALTERADO (byte-a-byte) pela rodada
   * que acabou de ser APLICADA. Ver `untouchedAnchors`.
   *
   * É a assinatura mecânica da patologia medida em prod: o CTO acrescenta uma errata declarando o
   * trecho nulo em OUTRO lugar do arquivo, o trecho ofensor fica idêntico, e o juiz — que relê o texto
   * original — reabre o mesmo GAP na validação seguinte. Lista vazia = tocou em todas as âncoras
   * mensuráveis; ausente = a rodada não tinha âncora mensurável (nada é afirmado).
   */
  anchorsUntouched?: string[] | null;
  /**
   * 🔴 GAP-79 — destas âncoras, quais endereçam um cabeçalho cujo corpo PRÓPRIO é toco: o texto que a
   * âncora aponta mora nas subseções, não no preâmbulo. Medido em prod: `visao-escopo.md §1.3` tem 415
   * chars próprios de uma subárvore de 21.839 (1,9%) e acumulou 15 acusações de "intocada" em 8 runs,
   * porque o GAP fala da tabela que mora no filho `#### Serviço api`.
   *
   * Não é acusação nem absolvição — é o fato que explica por que exigir "edição no próprio trecho" era
   * um pedido impossível de atender, e que torna auditável a decisão do juiz (GAP-77).
   */
  anchorsStubParent?: string[] | null;
  /**
   * 🔴 GAP-81 — o DEGRAU da escalada nesta rodada: `1` = só os GAPs reincidentes do arquivo, `2` = um
   * defeito só. Ausente = rodada normal (todos os GAPs do arquivo), que é o comportamento anterior.
   *
   * É o campo que o veredicto do GAP-77 conta para saber se o "foco individual" que o Jean exigiu
   * realmente foi pago ("focamos neles individualmente algumas vezes, se insistir a reaparecer ai sim o
   * juiz usa o novo poder"). Contar rodadas do arquivo, como a primeira versão fazia, chamava de foco a
   * rodada normal — e o gatilho virava carimbo.
   */
  focusLevel?: 1 | 2 | null;
  /** As âncoras que a rodada dedicada atacou — é por elas que o veredicto conta o foco pago. */
  focusAnchors?: string[] | null;
  /** Quantos GAPs do arquivo ficaram FORA desta rodada. Seguem ATIVOS e voltam à fila. */
  focusDeferred?: number | null;
  /**
   * 🔴 GAP-45 — o recorte 🔴/🟡 do PASSE, separado do recorte 🔴/🟡 do ARQUIVO.
   *
   * `blockers`/`warnings` significam "GAPs DESTE arquivo" numa rodada `per_file` (gravados no despacho,
   * de `fileFindings`). A validação, que é evento do PASSE, sobrescrevia esses dois campos com o total
   * do PROJETO na ÚLTIMA rodada de arquivo — e o portal desenha `🔴 {blockers} · 🟡 {warnings}` colado
   * no nome do arquivo. Medido em prod (run `5d377da0`): a rodada 6 diz
   * `observabilidade-operacao.md — 🔴 23 · 🟡 21` (23+21 = 44 = o total do projeto), enquanto a rodada 9,
   * o MESMO arquivo, diz 🔴 2 · 🟡 4. O log — que é a única evidência do método — atribuía ao arquivo
   * GAPs de outros onze. Irmão do GAP-30, que salvou a `note` e deixou os números.
   */
  passBlockers?: number | null;
  passWarnings?: number | null;
  note?: string;
  /**
   * A5.3/GAP-5: esta rodada é a CRIAÇÃO do manifesto (e não a edição de um `README.md` que já
   * existe). Discriminar pelo caminho não serve: depois de criado, o manifesto ganha GAPs próprios e
   * volta à fila como arquivo normal — foi assim que o laço pagou uma rodada de criação para o guard
   * recusá-la com "o manifesto passou a existir" (medido no run `75b3cf5d`, passe 2, rodada 11).
   */
  manifestCreation?: boolean;
  /**
   * 🔴 GAP-43: o passe terminou e a validação que devia medi-lo NÃO mediu (`error`/`superseded`). Isso
   * é diferente de "o passe não progrediu": não se sabe se progrediu. O fato fica no log porque é o que
   * permite ao passe seguinte distinguir uma falha ISOLADA de medição (perdoável uma vez) de um
   * validador consistentemente quebrado (aí o laço para e DIZ que parou por falta de medição, não por
   * falta de convergência). Ausente = a validação deste passe mediu.
   */
  unmeasured?: boolean;
}

/** PR-5: `whole` = spec de um arquivo só (comportamento da 090); `per_file` = fila de arquivos. */
export type AutonomyMode = "whole" | "per_file";

export interface AutonomyRun {
  id: string;
  projectId: string;
  tenantId: string | null;
  ownerUserId: string;
  status: AutonomyStatus;
  mode: AutonomyMode;
  /** `whole`: rodadas do ciclo completo. `per_file`: ARQUIVOS revisados (teto próprio). */
  round: number;
  /** PR-5: passes de validação concluídos — é este que respeita `maxRounds`. */
  passes: number;
  /** Arquivo em revisão nesta rodada (só em `per_file`). */
  currentFile: string | null;
  /** Arquivos já tratados no passe corrente (zerado a cada validação). */
  filesDone: string[];
  /** Falhas consecutivas em nível de arquivo (2 param o laço). */
  fileFailures: number;
  /**
   * GAP-36 — massa da spec em bytes NO INÍCIO do laço: denominador do orçamento de crescimento
   * (`proportionalGrowthBudget`). Fixo de propósito; `null` em laço anterior à migração 103, e aí o
   * orçamento cai no piso por passe. Ver `specTotalBytes`.
   */
  specBytes: number | null;
  maxRounds: number;
  chatJobId: string | null;
  validationRunId: string | null;
  baseSpecSha: string | null;
  gapsInitial: number | null;
  gapsCurrent: number | null;
  noProgressStreak: number;
  rounds: AutonomyRoundLog[];
  lastError: string | null;
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

const COLS =
  "id, project_id, tenant_id, owner_user_id, status, round, max_rounds, chat_job_id, validation_run_id, " +
  "base_spec_sha, gaps_initial, gaps_current, no_progress_streak, rounds, last_error, deadline_at, " +
  "created_at, updated_at, finished_at, mode, passes, current_file, files_done, file_failures, spec_bytes";

function rowToRun(r: Record<string, unknown>): AutonomyRun {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    tenantId: (r.tenant_id as string | null) ?? null,
    ownerUserId: String(r.owner_user_id ?? ""),
    status: (r.status as AutonomyStatus) ?? "pending",
    // Migração 095 ausente (banco atrás do código) → `whole`: o laço segue exatamente como na 090.
    mode: r.mode === "per_file" ? "per_file" : "whole",
    passes: Number(r.passes ?? 0),
    currentFile: (r.current_file as string | null) ?? null,
    filesDone: Array.isArray(r.files_done) ? (r.files_done as unknown[]).map((x) => String(x)) : [],
    fileFailures: Number(r.file_failures ?? 0),
    specBytes: r.spec_bytes == null ? null : Number(r.spec_bytes),
    round: Number(r.round ?? 0),
    maxRounds: Number(r.max_rounds ?? AUTONOMY_MAX_ROUNDS),
    chatJobId: (r.chat_job_id as string | null) ?? null,
    validationRunId: (r.validation_run_id as string | null) ?? null,
    baseSpecSha: (r.base_spec_sha as string | null) ?? null,
    gapsInitial: r.gaps_initial === null || r.gaps_initial === undefined ? null : Number(r.gaps_initial),
    gapsCurrent: r.gaps_current === null || r.gaps_current === undefined ? null : Number(r.gaps_current),
    noProgressStreak: Number(r.no_progress_streak ?? 0),
    rounds: Array.isArray(r.rounds) ? (r.rounds as AutonomyRoundLog[]) : [],
    lastError: (r.last_error as string | null) ?? null,
    deadlineAt: String(r.deadline_at ?? ""),
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function isTerminalAutonomyStatus(s: AutonomyStatus): boolean {
  return !ACTIVE_STATUSES.includes(s);
}

// ── contagem de GAPs "importantes" (a regra de parada do Jean) ────────────────

export interface GapTally { important: number; blockers: number; warnings: number; active: number; info: number }

/**
 * "Apenas GAPs vermelhos e amarelos sustenta mais uma rodada" (Jean, 2026-09-05).
 * ATIVO = sem triagem humana (`ignored` é risco aceito, `refuted` é falso positivo — nenhum dos
 * dois conta). `info` NUNCA sustenta rodada: é o "baixo risco" do pedido.
 * `countFindings` do findingTriage não expõe `warningsActive`, por isso derivamos aqui.
 */
export function tallyGaps(findings: EnrichedFinding[]): GapTally {
  const t: GapTally = { important: 0, blockers: 0, warnings: 0, active: 0, info: 0 };
  for (const f of findings) {
    if (f.triage) continue;
    t.active += 1;
    if (f.severity === "blocker") { t.blockers += 1; t.important += 1; }
    else if (f.severity === "warning") { t.warnings += 1; t.important += 1; }
    else t.info += 1;
  }
  return t;
}

/**
 * 🔴 GAP-46 — a lista de arquivos ATUAIS da spec, para a contagem do laço enxergar arquivo REMOVIDO.
 *
 * `surveyFindings` só marca um finding como resolvido-por-remoção quando recebe `currentFiles`
 * (`findingTriage.ts:268`). O laço autônomo chamava `projectFindingsState` SEM esse argumento, então
 * um GAP apontado para arquivo que saiu da spec ficava ATIVO para sempre — nenhuma rotação de
 * cobertura o julgaria de novo, e a contagem que decide a parada nunca poderia cair. Pior: a lista de
 * GAPs da Bancada (`specGapScope.ts:240`) SEMPRE passou `currentFiles`, então UI e laço divergiam —
 * a tela podia mostrar zero enquanto o laço queimava os 5 passes atrás de um fantasma.
 *
 * ⚠️ Guarda contra o próprio remédio: lista VAZIA marcaria TODOS os findings como removidos e o laço
 * declararia `succeeded` sobre uma spec cheia de GAPs. Vazio ⇒ `null` ⇒ comportamento legado (nenhuma
 * remoção detectada), que é o erro seguro. Falha de leitura idem.
 */
async function specFilePaths(db: Db, projectId: string): Promise<string[] | null> {
  const rows = (await db.query(
    "SELECT filename, rel_dir FROM project_spec_files WHERE project_id = $1", [projectId],
  )).rows as unknown as Array<{ filename: string; rel_dir: string | null }>;
  // Mesma canonicalização do `loadSpecFiles` (é a que a UI, o PUT e a fila de GAPs usam).
  const paths = rows.map((r) => {
    const relDir = (r.rel_dir ?? "").replace(/^\/+|\/+$/g, "");
    return relDir ? `${relDir}/${r.filename}` : r.filename;
  });
  return paths.length > 0 ? paths : null;
}

async function currentGaps(db: Db, projectId: string): Promise<GapTally> {
  const currentFiles = await specFilePaths(db, projectId).catch(() => null); // GAP-46
  const state = await projectFindingsState(db, projectId, { currentFiles });
  return tallyGaps(state.findings);
}

// ── leitura/escrita da spec primária (espelha PATCH /api/projects/:id/spec-content) ──

interface PrimarySpec { filePath: string; content: string; sha: string }

/**
 * PR-5: quantos arquivos a spec tem. É o ÚNICO sinal que decide o modo da rodada — e é decisão de
 * transporte, não de julgamento (com 1 arquivo não existe "por arquivo"). Recalculado a cada rodada:
 * se o humano dividir a spec no meio do laço, a rodada seguinte já entra no modo certo.
 */
async function specFileCount(db: Db, projectId: string): Promise<number> {
  const row = (await db.query(
    "SELECT count(*)::int AS n FROM project_spec_files WHERE project_id = $1", [projectId],
  )).rows[0] as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * PR-5: um arquivo da árvore pelo path canônico (`rel_dir/filename`). A canonicalização vive no
 * `specGapScope` (mesma da UI, do PUT e da fila de GAPs) — importada dinamicamente para o modo
 * `whole` não pagar o módulo.
 */
async function readSpecFileAt(db: Db, projectId: string, path: string): Promise<PrimarySpec | null> {
  const { loadSpecFiles } = await import("./specGapScope.js");
  const ref = (await loadSpecFiles(db, projectId)).find((f) => f.path === path);
  if (!ref) return null;
  const buf = await readFile(ref.filePath).catch(() => null);
  if (buf === null) return null;
  return { filePath: ref.filePath, content: buf.toString("utf-8"), sha: sha256Hex(buf) };
}

async function readPrimarySpec(db: Db, projectId: string): Promise<PrimarySpec | null> {
  const row = (await db.query(
    "SELECT file_path FROM project_spec_files WHERE project_id = $1 ORDER BY is_primary DESC, created_at DESC LIMIT 1",
    [projectId],
  )).rows[0] as { file_path?: string } | undefined;
  if (!row?.file_path) return null;
  const buf = await readFile(row.file_path).catch(() => null);
  if (buf === null) return null;
  return { filePath: row.file_path, content: buf.toString("utf-8"), sha: sha256Hex(buf) };
}

/**
 * Mesma sequência do PATCH manual: conteúdo → content_sha256 → spec_dirty_at.
 *
 * G2: antes de sobrescrever, o conteúdo ANTERIOR vai para `project_spec_snapshots`. Aqui o
 * snapshot é OBRIGATÓRIO (lança se falhar): o laço escreve sem humano no meio, então sem rede de
 * segurança ele não escreve. `previous` é o que está no disco AGORA (já lido pelo chamador).
 *
 * PR-5: serve aos DOIS modos — recebe o `filePath` do arquivo a escrever (o primário no modo
 * `whole`, o arquivo da rodada no modo `per_file`). O snapshot é por arquivo, então a rede de
 * segurança continua exata em qualquer um dos dois.
 */
async function writeSpecFile(
  db: Db, projectId: string, filePath: string, content: string,
  snapshot: { previous: string; reason: string; createdBy?: string | null },
): Promise<void> {
  const saved = await snapshotSpecFile(db as Pool, {
    projectId, filePath, content: snapshot.previous,
    reason: snapshot.reason, createdBy: snapshot.createdBy ?? null,
  });
  if (!saved) {
    throw new Error("não foi possível guardar o snapshot da spec atual — escrita abortada para não perder conteúdo");
  }
  await writeFile(filePath, content, "utf-8");
  await db.query(
    "UPDATE project_spec_files SET content_sha256 = $1 WHERE project_id = $2 AND file_path = $3",
    [sha256Hex(Buffer.from(content, "utf-8")), projectId, filePath],
  );
  await db.query("UPDATE projects SET spec_dirty_at = now() WHERE id = $1", [projectId]);
}

async function projectStatusOf(db: Db, projectId: string): Promise<string | null> {
  const row = (await db.query("SELECT status FROM projects WHERE id = $1", [projectId])).rows[0] as
    { status?: string } | undefined;
  return row?.status ? String(row.status) : null;
}

async function specEditable(db: Db, projectId: string): Promise<{ ok: true } | { ok: false; status: string }> {
  const { SPEC_EDITABLE_STATUSES } = await import("./projectStatus.js");
  const st = await projectStatusOf(db, projectId);
  if (!st || !SPEC_EDITABLE_STATUSES.has(st)) return { ok: false, status: st ?? "desconhecido" };
  return { ok: true };
}

// ── persistência do log de ações ─────────────────────────────────────────────

/** Turno de assistente SEM job_id: o log do laço aparece no chat da Bancada, não num arquivo. */
async function postChatNote(db: Db, run: AutonomyRun, content: string): Promise<void> {
  try {
    await db.query(
      `INSERT INTO spec_chat_messages (project_id, tenant_id, role, content, file_path, job_id)
         VALUES ($1, $2, 'assistant', $3, NULL, NULL)`,
      [run.projectId, run.tenantId, content],
    );
  } catch (e) {
    console.warn(`[SpecAutonomy] nota no chat falhou (best-effort): ${msg(e)}`);
  }
}

async function appendRoundLog(db: Db, runId: string, entry: AutonomyRoundLog): Promise<void> {
  await db.query(
    "UPDATE spec_autonomy_runs SET rounds = rounds || $2::jsonb, updated_at = now() WHERE id = $1",
    [runId, JSON.stringify([entry])],
  );
}

/**
 * 🔴 GAP-71 — merge de campos no ÚLTIMO item de `rounds` **dentro do banco**.
 *
 * Existe porque `patchLastRound` (abaixo) reconstrói o array a partir de `run.rounds` EM MEMÓRIA, e no
 * despacho essa cópia é **stale**: o `appendRoundLog` já gravou uma rodada nova que o objeto `run` não
 * conhece. Usar `patchLastRound` ali gravaria o array antigo de volta e **apagaria a rodada recém
 * criada** — perda silenciosa do log que é a única prova do que o laço fez.
 *
 * Aqui o `jsonb_set` opera sobre o valor ATUAL da coluna, então nenhuma leitura velha participa. Não
 * escreve `finishedAt`: a rodada continua ABERTA (quem a fecha é o apply).
 */
async function mergeIntoLastRound(db: Db, runId: string, patch: Partial<AutonomyRoundLog>): Promise<void> {
  await db.query(
    `UPDATE spec_autonomy_runs
        SET rounds = jsonb_set(
              rounds,
              ARRAY[(jsonb_array_length(rounds) - 1)::text],
              (rounds -> (jsonb_array_length(rounds) - 1)) || $2::jsonb
            ),
            updated_at = now()
      WHERE id = $1 AND jsonb_typeof(rounds) = 'array' AND jsonb_array_length(rounds) > 0`,
    [runId, JSON.stringify(patch)],
  );
}

/** Atualiza o ÚLTIMO item de `rounds` (fecha a rodada com o resultado medido). */
async function patchLastRound(
  db: Db, run: AutonomyRun, patch: Partial<AutonomyRoundLog>,
  /**
   * 🔴 GAP-30 — `keepNote` PRESERVA a nota que a rodada já tinha, concatenando a nova.
   *
   * A validação é evento do PASSE, mas era gravada sobre a ÚLTIMA rodada de arquivo. Medido nesta
   * sessão na run `d7acccb8`: a rodada 10 (`visao-escopo.md`) registrava "consolidação recusada …" e,
   * na leitura seguinte, a MESMA rodada dizia apenas "Validação failed: 42 → 30" — o motivo da recusa
   * desapareceu do log. O método inteiro depende desse log ("cortar é aceitável, mentir sobre o corte
   * não"), e sem a nota da rodada não há como diferenciar arquivo recusado de arquivo aplicado.
   */
  opts: { keepNote?: boolean } = {},
): Promise<void> {
  const rounds = run.rounds;
  if (rounds.length === 0) return;
  const prevNote = rounds[rounds.length - 1]?.note;
  const note = opts.keepNote && prevNote && patch.note && !prevNote.includes(patch.note)
    ? `${prevNote} ⟶ ${patch.note}`
    : patch.note;
  const merged: Partial<AutonomyRoundLog> = {
    ...patch,
    ...(note === undefined ? {} : { note }),
    finishedAt: new Date().toISOString(),
  };
  // 🔴 GAP-83 — a gravação é MERGE no banco (`jsonb_set`), nunca reescrita do array em memória.
  //
  // MEDIDO em prod na run `88339651` (rodada 21, a terminal): a validação gravou `gapsAfter`,
  // `gapsClosed`, `gapsComparableBefore/Now/Same` e `comparableFiles`; poucos milissegundos depois, no
  // MESMO tick, o veredicto do GAP-77 gravou os campos dele — e os oito campos da validação
  // DESAPARECERAM, junto com a nota "Validação exhausted: …". Causa: as duas chamadas partiam do MESMO
  // snapshot `run.rounds`; a segunda reescrevia o array inteiro e apagava o que a primeira havia
  // escrito (lost update dentro do próprio processo). Consequência prática: em TODA run que termina
  // pelo caminho do veredicto, a rodada terminal ficava sem a medição comparável do GAP-76 — ou seja,
  // o parecer de promovibilidade era auditável contra nada. É a mesma lição do GAP-71b
  // (`mergeIntoLastRound`), que aqui faltava aplicar.
  //
  // O snapshot em memória é sincronizado depois da gravação, para que a próxima chamada no mesmo tick
  // veja a nota e os campos já escritos (é o que preserva a semântica do `keepNote` do GAP-30).
  await mergeIntoLastRound(db, run.id, merged);
  rounds[rounds.length - 1] = { ...rounds[rounds.length - 1], ...merged };
}

const FINAL_LABEL: Record<string, string> = {
  succeeded: "✅ Modo autônomo concluído — nenhum GAP vermelho ou amarelo ativo restante",
  exhausted: "⏹️ Modo autônomo encerrado no limite de rodadas",
  stalled: "⚠️ Modo autônomo interrompido (sem progresso ou guarda de segurança)",
  failed: "🔴 Modo autônomo falhou",
  stopped: "⏹️ Modo autônomo interrompido pelo usuário",
};

async function finishRun(
  db: Db, run: AutonomyRun, status: AutonomyStatus, note: string, extra: { gaps?: GapTally | null } = {},
): Promise<void> {
  const r = await db.query(
    `UPDATE spec_autonomy_runs
        SET status = $2, last_error = $3, gaps_current = COALESCE($4, gaps_current),
            finished_at = now(), updated_at = now()
      WHERE id = $1 AND status = ANY($5::text[])`,
    [run.id, status, note.slice(0, 800), extra.gaps ? extra.gaps.important : null, ACTIVE_STATUSES],
  );
  if ((r.rowCount ?? 0) === 0) return; // outra transição já encerrou (claim perdido)
  const tally = extra.gaps
    ? ` · GAPs importantes restantes: ${extra.gaps.important} (🔴 ${extra.gaps.blockers} · 🟡 ${extra.gaps.warnings})`
    : "";
  // PR-5: no modo por arquivo "rodada 7/5" mentiria — `round` conta ARQUIVOS e `passes` conta os
  // ciclos de validação (que são o teto do Jean).
  const progress = run.mode === "per_file"
    ? `arquivos revisados: ${run.round} em ${run.passes} passe(s) de ${run.maxRounds}`
    : `rodadas executadas: ${run.round}/${run.maxRounds}`;
  await postChatNote(db, run,
    `${FINAL_LABEL[status] ?? "Modo autônomo encerrado"} — ${progress}${tally}\n\n${note}`);
  console.info(`[SpecAutonomy] run=${run.id} project=${run.projectId} → ${status} (${progress}): ${note}`);
}

// ── ciclo de vida ────────────────────────────────────────────────────────────

export type StartAutonomyResult =
  | { ok: true; run: AutonomyRun }
  | { ok: false; status: number; code: string; message: string };

/**
 * Cria o laço. Recusa cedo (com motivo acionável) tudo o que tornaria o laço inútil ou perigoso:
 * flag desligada, spec em fábrica, spec ilegível no disco, sem validação anterior, sem GAP
 * importante ativo, ou laço já ativo no mesmo projeto (índice único parcial da migração 090).
 */
export async function startAutonomyRun(db: Db, opts: {
  projectId: string; tenantId: string | null; ownerUserId: string; maxRounds?: number;
}): Promise<StartAutonomyResult> {
  if (!autonomyEnabled()) {
    return { ok: false, status: 503, code: "AUTONOMY_DISABLED", message: "Modo autônomo desligado nesta instalação (SPEC_AUTONOMY=off)." };
  }
  const maxRounds = Math.min(Math.max(Math.trunc(opts.maxRounds ?? AUTONOMY_MAX_ROUNDS) || AUTONOMY_MAX_ROUNDS, 1), AUTONOMY_MAX_ROUNDS);

  const editable = await specEditable(db, opts.projectId);
  if (!editable.ok) {
    return { ok: false, status: 409, code: "SPEC_LOCKED", message: `Spec bloqueada para edição: projeto em '${editable.status}'. Pare o projeto ou use Evoluir.` };
  }
  const spec = await readPrimarySpec(db, opts.projectId);
  if (!spec) {
    return { ok: false, status: 422, code: "SPEC_FILES_MISSING", message: "Spec sem arquivo legível no disco — o modo autônomo não tem o que revisar." };
  }
  const state = await projectFindingsState(db, opts.projectId);
  if (!state.latestRunId) {
    return { ok: false, status: 409, code: "NO_VALIDATION", message: "Rode Validar uma vez antes: o modo autônomo parte dos GAPs da última validação." };
  }
  const gaps = tallyGaps(state.findings);
  if (gaps.important === 0) {
    return { ok: false, status: 409, code: "NO_GAPS", message: `Nenhum GAP vermelho ou amarelo ATIVO na última validação${gaps.info ? ` (${gaps.info} de baixo risco não sustentam rodada)` : ""}.` };
  }

  // PR-5: o modo é DERIVADO da árvore (2+ arquivos = por arquivo) e revalidado a cada rodada. Aqui
  // ele entra na linha só para a Bancada já desenhar o laço certo desde o primeiro poll.
  const fileCount = await specFileCount(db, opts.projectId).catch(() => 1);
  const mode: AutonomyMode = fileCount > 1 ? "per_file" : "whole";
  // GAP-36: a massa da spec é medida AQUI e só aqui — é o denominador FIXO do orçamento de
  // crescimento do laço (ver `specTotalBytes`). Falhar em medir não impede o laço: sem o número o
  // orçamento cai no piso por passe, que é a regra anterior.
  const specBytes = await specTotalBytes(db, opts.projectId).catch(() => 0);

  const id = randomUUID();
  try {
    await db.query(
      `INSERT INTO spec_autonomy_runs
         (id, project_id, tenant_id, owner_user_id, status, round, max_rounds, gaps_initial, gaps_current, deadline_at, mode, spec_bytes)
       VALUES ($1, $2, $3, $4, 'pending', 0, $5, $6, $6, now() + ($7 || ' milliseconds')::interval, $8, $9)`,
      [id, opts.projectId, opts.tenantId, opts.ownerUserId, maxRounds, gaps.important, String(AUTONOMY_DEADLINE_MS), mode, specBytes],
    );
  } catch (e) {
    // 23505 = índice único parcial → já existe laço ativo neste projeto.
    if ((e as { code?: string }).code === "23505") {
      const active = await getActiveAutonomyRun(db, opts.projectId);
      return { ok: false, status: 409, code: "AUTONOMY_ALREADY_RUNNING", message: `Já existe um modo autônomo em andamento neste projeto (rodada ${active?.round ?? "?"}/${active?.maxRounds ?? maxRounds}).` };
    }
    throw e;
  }
  const run = (await getAutonomyRun(db, id))!;
  await postChatNote(db, run, mode === "per_file"
    ? `🤖 **Modo autônomo ativado (por arquivo)** — a spec tem ${fileCount} arquivos, então vou tratar **um arquivo por rodada** (os com bloqueadores primeiro), salvar cada um, e só validar a spec inteira quando a fila terminar. Até ${maxRounds} passe(s) de validação, enquanto sobrar GAP 🔴 blocker ou 🟡 warning ATIVO (itens de baixo risco não sustentam rodada).\n\nPonto de partida: ${gaps.important} GAP(s) importante(s) — 🔴 ${gaps.blockers} · 🟡 ${gaps.warnings}.`
    : `🤖 **Modo autônomo ativado** — vou resolver os GAPs, salvar, validar e repetir por até ${maxRounds} rodada(s), enquanto sobrar GAP 🔴 blocker ou 🟡 warning ATIVO (itens de baixo risco não sustentam rodada).\n\nPonto de partida: ${gaps.important} GAP(s) importante(s) — 🔴 ${gaps.blockers} · 🟡 ${gaps.warnings}.`);
  // Primeira rodada já neste request (latência), sem bloquear a resposta.
  setImmediate(() => { void advanceAutonomyRun(db, id).catch((e) => console.error(`[SpecAutonomy] advance inicial falhou: ${msg(e)}`)); });
  return { ok: true, run };
}

export async function getAutonomyRun(db: Db, id: string): Promise<AutonomyRun | null> {
  const r = (await db.query(`SELECT ${COLS} FROM spec_autonomy_runs WHERE id = $1`, [id])).rows[0] as
    Record<string, unknown> | undefined;
  return r ? rowToRun(r) : null;
}

export async function getActiveAutonomyRun(db: Db, projectId: string): Promise<AutonomyRun | null> {
  const r = (await db.query(
    `SELECT ${COLS} FROM spec_autonomy_runs WHERE project_id = $1 AND status = ANY($2::text[]) ORDER BY created_at DESC LIMIT 1`,
    [projectId, ACTIVE_STATUSES],
  )).rows[0] as Record<string, unknown> | undefined;
  return r ? rowToRun(r) : null;
}

/** Último laço do projeto (ativo ou terminal) — é o que a Bancada desenha ao abrir a tela. */
export async function getLatestAutonomyRun(db: Db, projectId: string): Promise<AutonomyRun | null> {
  const r = (await db.query(
    `SELECT ${COLS} FROM spec_autonomy_runs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  )).rows[0] as Record<string, unknown> | undefined;
  return r ? rowToRun(r) : null;
}

/** Parada pelo humano. Não cancela o job do CTO em voo (o resultado dele continua coletável). */
export async function stopAutonomyRun(db: Db, id: string): Promise<boolean> {
  const run = await getAutonomyRun(db, id);
  if (!run || isTerminalAutonomyStatus(run.status)) return false;
  await finishRun(db, run, "stopped", "Interrompido pelo usuário. A revisão em voo (se houver) continua disponível no chat.");
  return true;
}

// ── a máquina de estados ─────────────────────────────────────────────────────

/**
 * Um tick: avança TODAS as runs vivas (mais antiga primeiro). Chamado pelo specChatWorker.
 * Nunca lança — uma run com problema não pode parar as outras.
 */
export async function advanceAutonomyRunsTick(db: Db): Promise<{ scanned: number; advanced: number }> {
  const out = { scanned: 0, advanced: 0 };
  if (!autonomyEnabled()) return out;
  let ids: string[] = [];
  try {
    ids = ((await db.query(
      `SELECT id FROM spec_autonomy_runs WHERE status = ANY($1::text[]) ORDER BY updated_at LIMIT 10`,
      [ACTIVE_STATUSES],
    )).rows as Array<{ id: string }>).map((r) => String(r.id));
  } catch (e) {
    console.warn(`[SpecAutonomy] varredura falhou: ${msg(e)}`);
    return out;
  }
  out.scanned = ids.length;
  for (const id of ids) {
    try {
      if (await advanceAutonomyRun(db, id)) out.advanced += 1;
    } catch (e) {
      console.error(`[SpecAutonomy] run=${id} erro no avanço: ${msg(e)}`);
    }
  }
  return out;
}

/** Avança UMA run um passo. Devolve true se houve transição de estado. */
export async function advanceAutonomyRun(db: Db, id: string): Promise<boolean> {
  const run = await getAutonomyRun(db, id);
  if (!run || isTerminalAutonomyStatus(run.status)) return false;

  // Deadline global: encerra a ESPERA (o job do CTO em voo permanece coletável pelo worker).
  if (run.deadlineAt && Date.now() > new Date(run.deadlineAt).getTime()) {
    const gaps = await currentGaps(db, run.projectId).catch(() => null);
    await finishRun(db, run, "stalled", "Tempo máximo do laço autônomo atingido (4h30). Rode Validar para ver o estado atual da spec.", { gaps });
    return true;
  }

  switch (run.status) {
    case "pending": return startRound(db, run);
    case "cto_running": return checkCto(db, run);
    case "applying": return applyStep(db, run);
    case "validating": return checkValidation(db, run);
    default: return false;
  }
}

/** PR-5: qual "apply" roda — o do arquivo da rodada ou o da spec inteira. */
function applyStep(db: Db, run: AutonomyRun): Promise<boolean> {
  return run.mode === "per_file" && run.currentFile ? applyFileRound(db, run) : applyAndValidate(db, run);
}

/**
 * pending → começa a rodada. O MODO é decidido aqui, pela árvore (não por flag): 2+ arquivos →
 * fila por arquivo (PR-5); 1 arquivo → o ciclo da 090, byte por byte como era.
 */
async function startRound(db: Db, run: AutonomyRun): Promise<boolean> {
  const fileCount = await specFileCount(db, run.projectId).catch(() => 1);
  if (fileCount > 1) return startFileRound(db, run);
  return startWholeRound(db, run);
}

/** pending (spec de 1 arquivo) → dispara Resolver GAPs pelo MESMO caminho do botão manual. */
async function startWholeRound(db: Db, run: AutonomyRun): Promise<boolean> {
  if (run.round >= run.maxRounds) {
    const gaps = await currentGaps(db, run.projectId).catch(() => null);
    await finishRun(db, run, "exhausted",
      `Limite de ${run.maxRounds} rodada(s) atingido. Revise os GAPs restantes na aba GAPs e triagem o que for risco aceito.`, { gaps });
    return true;
  }
  const editable = await specEditable(db, run.projectId);
  if (!editable.ok) {
    await finishRun(db, run, "stalled", `A spec deixou de ser editável no meio do laço (projeto em '${editable.status}') — nada foi alterado.`);
    return true;
  }
  const spec = await readPrimarySpec(db, run.projectId);
  if (!spec) {
    await finishRun(db, run, "failed", "Spec sem arquivo legível no disco — laço encerrado sem alterar nada.");
    return true;
  }
  const gaps = await currentGaps(db, run.projectId);
  if (gaps.important === 0) {
    await finishRun(db, run, "succeeded",
      `Nenhum GAP vermelho ou amarelo ATIVO restante${gaps.info ? ` (${gaps.info} item(ns) de baixo risco seguem em aberto, por desenho)` : ""}.`, { gaps });
    return true;
  }
  const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim();
  if (!agentsUrl) {
    await finishRun(db, run, "failed", "Serviço de agentes não configurado (API_AGENTS_URL) — laço encerrado.");
    return true;
  }

  const nextRound = run.round + 1;
  const jobId = randomUUID();
  // CLAIM antes do dispatch: se dois ticks se sobrepuserem, só um dispara o CTO (Opus 5 é caro).
  const claim = await db.query(
    `UPDATE spec_autonomy_runs
        SET status = 'cto_running', round = $2, chat_job_id = $3, base_spec_sha = $4,
            gaps_current = $5, validation_run_id = NULL, mode = 'whole', current_file = NULL,
            updated_at = now()
      WHERE id = $1 AND status = 'pending' AND round = $6`,
    [run.id, nextRound, jobId, spec.sha, gaps.important, run.round],
  );
  if ((claim.rowCount ?? 0) === 0) return false;

  await appendRoundLog(db, run.id, {
    round: nextRound, startedAt: new Date().toISOString(), chatJobId: jobId,
    gapsBefore: gaps.important, blockers: gaps.blockers, warnings: gaps.warnings,
    specChars: spec.content.length,
    note: `Resolver GAPs enviado ao CTO (${gaps.important} GAP importante(s)).`,
  });

  const { dispatchResolveGapsJob } = await import("../routes/specChat.js");
  try {
    const llm = agentsLlmFields(await resolveWorkbenchLlm({ projectId: run.projectId, tenantId: run.tenantId }));
    const res = await dispatchResolveGapsJob({
      jobId, projectId: run.projectId, tenantId: run.tenantId, ownerUserId: run.ownerUserId,
      specMarkdown: spec.content, agentsUrl, llm,
      userMessage: `🤖 Modo autônomo — rodada ${nextRound}/${run.maxRounds}: resolver ${gaps.important} GAP(s) importante(s) (🔴 ${gaps.blockers} · 🟡 ${gaps.warnings}).`,
    });
    if (!res.ok) {
      // O contexto do chat não viu GAP ativo → nada a resolver = sucesso, não erro (GAP-E).
      const fresh = (await getAutonomyRun(db, run.id))!;
      await finishRun(db, fresh, "succeeded", "Nenhum GAP ATIVO restante ao montar a rodada — laço encerrado com sucesso.");
      return true;
    }
    console.info(`[SpecAutonomy] run=${run.id} rodada ${nextRound}/${run.maxRounds} → CTO job=${jobId} (${res.gaps} GAPs no contexto)`);
    return true;
  } catch (e) {
    const fresh = (await getAutonomyRun(db, run.id))!;
    await finishRun(db, fresh, "failed", `Falha ao acionar o CTO: ${msg(e).slice(0, 300)}`);
    return true;
  }
}

// ── PR-5: a fila de arquivos ─────────────────────────────────────────────────

/**
 * Fila de arquivos da rodada: só os que têm GAP IMPORTANTE (🔴/🟡) ativo, blockers primeiro. A
 * `gapQueue` do specGapScope inclui arquivos que só têm `info` — para o laço isso seria gastar Opus
 * em "baixo risco", contra a regra do Jean ("apenas vermelhos e amarelos sustenta rodada").
 */
function importantFileQueue(list: GapFileBucket[]): string[] {
  return list
    .filter((b) => b.blockers + b.warnings > 0)
    .slice()
    .sort((a, b) => b.blockers - a.blockers
      || (b.blockers + b.warnings) - (a.blockers + a.warnings)
      || a.path.localeCompare(b.path))
    .map((b) => b.path);
}

/**
 * A5.3 — o GAP `no_readme` está ATIVO? É o único finding que aponta um arquivo que NÃO EXISTE, e
 * por isso jamais entrou na fila (que é por arquivo da árvore). Ele é procurado nos DOIS lados do
 * escopo: `unrouted` (onde nasce, com `file` vazio) e `byPath` (se o roteador LLM o tiver atribuído
 * a algum arquivo — atribuição que não o resolve, porque o Estágio A só aceita `README.md` na raiz).
 *
 * Se o humano triou o finding (risco aceito / falso positivo), ele não vem em `scope` — logo o laço
 * NÃO cria manifesto contra a decisão do humano.
 */
function manifestGapFindings(scope: GapGroups): EnrichedFinding[] {
  const isManifestGap = (f: EnrichedFinding) =>
    (f.anchor ?? "") === "no_readme" && (f.severity === "blocker" || f.severity === "warning");
  const out = scope.unrouted.filter(isManifestGap);
  for (const list of scope.byPath.values()) out.push(...list.filter(isManifestGap));
  return out;
}

/** Quantos arquivos foram efetivamente ESCRITOS no passe corrente (lido do log de rodadas). */
function appliedInPass(run: AutonomyRun): number {
  return run.rounds.filter((r) => (r.pass ?? 0) === run.passes && r.applied === true).length;
}

/**
 * GAP-28 — quanto o passe corrente JÁ cresceu, somando só as rodadas escritas (as recusadas não
 * gastaram nada, porque nada foi para o disco). Encolhimento devolve margem, e é esse o ponto: quem
 * consolidou paga o arquivo que precisa acrescentar.
 */
export function passGrowthUsed(run: Pick<AutonomyRun, "rounds" | "passes">): number {
  return run.rounds
    .filter((r) => (r.pass ?? 0) === run.passes && r.applied === true)
    .reduce((sum, r) => sum + (typeof r.deltaChars === "number" ? r.deltaChars : 0), 0);
}

/**
 * GAP-33 — quanto a RUN INTEIRA já cresceu (todas as rodadas escritas, de todos os passes).
 *
 * MEDIDO na run `d7acccb8`, passe 4: **3 de 6 rodadas descartadas** com deltas de +2.873, +448 e
 * +143 chars. As duas últimas são absurdas de proporção — o laço jogou fora uma chamada de Opus 5
 * inteira para poupar 143 caracteres numa spec de ~950 mil. A causa é a granularidade: o orçamento
 * do passe é gasto por ORDEM DE FILA, e quem chega depois encontra margem zero, mesmo entregando
 * uma correção minúscula. É a mesma família dos GAP-26/GAP-28 (destruir trabalho pago por causa de
 * um limite local), um nível acima.
 *
 * O objetivo é "a spec não INFLAR", e isso é propriedade do LAÇO, não de um passe: nada justifica
 * ser mais rígido no passe 4 só porque o passe 1 gastou primeiro. Então a conta passa a ser
 * cumulativa — o laço tem `ORÇAMENTO × (passes já feitos + 1)` e desconta tudo o que já escreveu.
 * Estourar num passe aperta o seguinte (nada é de graça); encolher gera crédito que atravessa
 * passes, que é exatamente o "quem encolhe financia quem cresce" do GAP-28 levado à escala certa.
 *
 * Medido no mesmo passe 4: sob a conta cumulativa a margem seria 3.373 em vez de 329 ⇒ as três
 * rodadas descartadas teriam sido aplicadas, com a spec crescendo 0,5% no laço todo.
 */
export function runGrowthUsed(run: Pick<AutonomyRun, "rounds">): number {
  return run.rounds
    .filter((r) => r.applied === true)
    .reduce((sum, r) => sum + (typeof r.deltaChars === "number" ? r.deltaChars : 0), 0);
}

/**
 * 🔴 GAP-70 — quanto da graça de consolidação a run já tomou emprestado. Lê o log da rodada
 * (`consolidationGrace`), que o GAP-64 já ensinou a declarar — nada de coluna nova.
 */
export function runConsolidationGraceUsed(run: Pick<AutonomyRun, "rounds">): number {
  if (!Array.isArray(run.rounds)) return 0;
  return run.rounds.reduce(
    (sum, r) => sum + (typeof r?.consolidationGrace === "number" && r.consolidationGrace > 0 ? r.consolidationGrace : 0),
    0,
  );
}

/**
 * 🔴 GAP-70 — a graça que AINDA resta ao laço. Pool por PASSE (`pool × (passes + 1)`) e não por
 * rodada: com 12 arquivos, uma graça por rodada seria um segundo orçamento pela porta dos fundos.
 *
 * Nunca negativa: se a run já tomou mais do que o pool (log de run antiga, pool reduzido por env no
 * meio da run), a graça acabou — não vira dívida que proibiria o encolhimento.
 */
export function consolidationGraceLeft(
  run: Pick<AutonomyRun, "rounds" | "passes">,
  pool: number,
): number {
  if (!Number.isFinite(pool) || pool <= 0) return 0;
  const total = pool * ((run.passes ?? 0) + 1);
  return Math.max(0, total - runConsolidationGraceUsed(run));
}

/**
 * GAP-28 — margem que resta ao passe. Nunca negativa: se o passe já estourou, a margem é ZERO (o
 * arquivo não pode crescer), não uma dívida que proibiria até o encolhimento.
 */
/**
 * GAP-29 — a ÚLTIMA tentativa deste arquivo que o veto de consolidação descartou, se houver.
 *
 * MEDIDO na run `d7acccb8`: `autenticacao-sessao.md` foi descartado 3 vezes entregando +2.661,
 * +2.740 e +2.740 chars contra margens de 580 e 1.143 — praticamente a MESMA resposta, paga em
 * Opus 5 sobre um arquivo de 74k, três vezes. O pedido era idêntico nas três: nada dizia ao agente
 * que a tentativa anterior existiu e por quanto ela passou. O código não decide o que fazer com o
 * fato (isso é do agente); ele só para de esconder o fato.
 *
 * Procura de trás para frente, em TODO o log da run (a retentativa é no passe seguinte, não no
 * mesmo), e devolve só a mais recente — as anteriores são história, não instrução.
 *
 * GAP-31: devolve também o MOTIVO gravado. Rodada antiga (anterior ao GAP-31) não tem motivo ⇒
 * `reason: null`, e quem monta o texto entrega só os números em vez de inventar a causa.
 */
export function lastRejectedAttempt(
  run: Pick<AutonomyRun, "rounds">, filePath: string,
): { delta: number; budget: number; pass: number; reason: string | null } | null {
  const norm = (p: string) => p.trim().toLowerCase();
  for (let i = run.rounds.length - 1; i >= 0; i--) {
    const r = run.rounds[i];
    if (norm(r.filePath ?? "") !== norm(filePath)) continue;
    if (typeof r.rejectedDelta !== "number") continue;
    return {
      delta: r.rejectedDelta,
      budget: typeof r.rejectedBudget === "number" ? r.rejectedBudget : 0,
      pass: (r.pass ?? 0) + 1,
      reason: typeof r.rejectedReason === "string" && r.rejectedReason.trim() ? r.rejectedReason.trim() : null,
    };
  }
  return null;
}

/**
 * 🔴 GAP-68 — as refs de reincidência da medição MAIS RECENTE desta run.
 *
 * Só a última interessa: cada validação recalcula o conjunto inteiro de reincidentes a partir do diff
 * daquele momento, e uma ref de dois passes atrás já foi ou reconfirmada (aparece na nova) ou
 * fechada. Devolver o acumulado histórico faria o laço afirmar ao agente que um GAP já fechado
 * continua voltando.
 *
 * A busca é de trás para frente por `persistedGaps` presente, NÃO por `gapsPersisted > 0`: uma
 * validação que reconciliou e não achou reincidente grava `gapsPersisted: 0` sem refs, e isso é a
 * informação "a lista atual é vazia" — parar nela é o comportamento correto.
 */
export function lastPersistedGaps(run: Pick<AutonomyRun, "rounds">): PersistentGapRef[] {
  for (let i = run.rounds.length - 1; i >= 0; i--) {
    const r = run.rounds[i];
    if (Array.isArray(r.persistedGaps)) return r.persistedGaps;
    // A rodada mediu e reconciliou sem achar reincidente ⇒ a lista corrente é vazia, e uma ref mais
    // antiga não pode ressuscitar. `null`/ausente (não reconciliou) segue procurando.
    if (r.gapsPersisted === 0) return [];
  }
  return [];
}

/**
 * 🔴 GAP-68 (revisão adversarial da própria correção) — reincidência é conhecimento do PROJETO, não da
 * run.
 *
 * `lastPersistedGaps` só olha o log da run corrente, e uma run NASCE com `rounds: []`. Consequência
 * medida no desenho: a run `b1bc1195` terminou `exhausted` sabendo de 8 defeitos rebatizados, e a run
 * seguinte (`f101303f`) começaria cega — o primeiro passe de TODA run repetiria exatamente o erro que
 * esta correção existe para evitar. Como o Jean opera o laço em runs sucessivas, esse primeiro passe é
 * uma fração grande do gasto.
 *
 * O fallback só entra quando a run corrente AINDA não mediu nada (nenhuma rodada com `persistedGaps`
 * nem `gapsPersisted`): dentro da run, a medição de agora sempre vence a herdada.
 *
 * Herdar é seguro porque quem afirma reincidência é `persistentGapsFor`, e ele casa por fingerprint
 * EXATO contra os findings da validação ATUAL: defeito já corrigido simplesmente não casa e nada é
 * dito. Falha de banco devolve o que a run tem — o fato é um extra, nunca uma pré-condição.
 */
export async function knownPersistentGaps(db: Db, run: AutonomyRun): Promise<PersistentGapRef[]> {
  const own = lastPersistedGaps(run);
  if (own.length > 0) return own;
  const mediu = run.rounds.some((r) => Array.isArray(r.persistedGaps) || r.gapsPersisted === 0);
  if (mediu) return own;
  const rows = (await db.query(
    `SELECT rounds FROM spec_autonomy_runs
      WHERE project_id = $1 AND id <> $2
      ORDER BY created_at DESC LIMIT 3`,
    [run.projectId, run.id],
  ).catch(() => ({ rows: [] as Array<{ rounds: unknown }> }))).rows as Array<{ rounds: unknown }>;
  for (const row of rows) {
    const refs = lastPersistedGaps({ rounds: Array.isArray(row.rounds) ? (row.rounds as AutonomyRoundLog[]) : [] });
    if (refs.length > 0) {
      console.info(`[SpecAutonomy] run=${run.id}: ${refs.length} ref(s) de reincidência HERDADAS da run anterior do projeto (esta run ainda não mediu).`);
      return refs;
    }
  }
  return [];
}

/**
 * 🔴 GAP-68 — quais dos GAPs que vão AGORA para o CTO são reincidentes conhecidos.
 *
 * Casa por fingerprint EXATO com os findings do despacho, porque as refs foram gravadas a partir da
 * MESMA validação que produziu estes findings — se o fingerprint não casar, algo mudou entre o
 * registro e o despacho e afirmar reincidência seria chute. Por isso o chamador LOGA quantos casaram:
 * "0 casados com refs presentes" é o sintoma de ação inerte, não de spec limpa.
 */
export function persistentGapsFor(
  refs: PersistentGapRef[], filePath: string,
  findings: Array<Parameters<typeof findingFingerprint>[0]>,
): PersistentGapRef[] {
  if (refs.length === 0 || findings.length === 0) return [];
  const norm = (p: string) => p.trim().toLowerCase();
  const fps = new Set(findings.map((f) => findingFingerprint(f)));
  return refs.filter((r) => norm(r.file ?? "") === norm(filePath) && fps.has(r.fingerprint));
}

/**
 * 🔴 GAP-71 — as âncoras dos GAPs desta leva, únicas e sem vazias, para o log do despacho.
 *
 * Finding sem âncora simplesmente não entra: o fato "o trecho ficou intocado" não é mensurável sem um
 * trecho, e um `null` na lista faria a medição do apply contar uma âncora que não existe.
 */
export function gapAnchorsOf(findings: Array<{ anchor?: string | null }>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of findings) {
    const a = (f.anchor ?? "").trim();
    if (!a || seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

/**
 * 🔴 GAP-71 — as âncoras que a rodada ANTERIOR **deste arquivo** deixou intocadas.
 *
 * Busca de trás para frente pela última rodada do mesmo arquivo que tenha `anchorsUntouched` gravado
 * (a rodada mais recente pode ser de outro arquivo, ou ter sido descartada por veto e aí não mediu
 * nada). Não olha rodadas de OUTROS arquivos: a afirmação é sobre este trecho, neste arquivo.
 */
export function lastUntouchedAnchors(run: Pick<AutonomyRun, "rounds">, filePath: string): string[] {
  const norm = (p: string) => p.trim().toLowerCase();
  for (let i = run.rounds.length - 1; i >= 0; i--) {
    const r = run.rounds[i];
    if (norm(r.filePath ?? "") !== norm(filePath)) continue;
    if (Array.isArray(r.anchorsUntouched)) return r.anchorsUntouched;
  }
  return [];
}

/**
 * 🔴 GAP-71 — reincidência de fingerprint estável, lida das validações recentes do PROJETO.
 *
 * A janela é `RESOLVED_WINDOW`-ish por escolha explícita: 8 validações cobrem com folga os passes de
 * uma run (`AUTONOMY_MAX_ROUNDS = 5`) e ainda alcançam a run anterior, que é onde o GAP-68 já provou
 * que a cegueira custa caro (toda run nova começaria em "1ª aparição").
 *
 * Falha de banco devolve `[]` **com `console.warn`**: o fato é um extra do prompt, nunca pré-condição
 * da rodada — mas um degrade silencioso aqui reabriria exatamente o GAP que isto fecha.
 */
export async function stableRecurrenceFor(
  db: Db, run: AutonomyRun, filePath: string, findings: ValidationFinding[],
): Promise<PersistentGapRef[]> {
  try {
    const rows = (await db.query(
      `SELECT findings, stage_b_coverage FROM spec_validation_runs
        WHERE project_id = $1 AND status IN ('passed','failed')
        ORDER BY created_at DESC LIMIT 8`,
      [run.projectId],
    )).rows as Array<{ findings: unknown; stage_b_coverage: unknown }>;
    const past = rows.map((r) => ({
      findings: Array.isArray(r.findings) ? (r.findings as ValidationFinding[]) : [],
      coverage: r.stage_b_coverage,
    }));
    const refs = stableRecurrenceRefs(past, filePath, findings);
    if (refs.length > 0) {
      console.info(`[SpecAutonomy] run=${run.id} ${filePath}: ${refs.length} GAP(s) reincidente(s) de âncora ESTÁVEL (máx ${Math.max(...refs.map((r) => r.times))} aparições).`);
    }
    return refs;
  } catch (e) {
    console.warn(`[SpecAutonomy] run=${run.id} ${filePath}: reincidência estável indisponível (${msg(e)}) — o CTO recebe os GAPs sem o fato do GAP-71.`);
    return [];
  }
}

/**
 * 🔴 F2 — o POLICY GATE no fim do laço: as constraints DECLARADAS da spec, uma por uma.
 *
 * Por que aqui e não num estágio próprio por rodada: `arXiv:2609.04167` mede que **34% dos patches que
 * passam nos testes violam constraints declaradas na revisão** — o buraco é no momento de ENTREGAR,
 * não em cada iteração. E rodar por task multiplicaria a conta do projeto (o Dev/QA rodam por task).
 * Então o gate roda no MESMO ponto do veredicto de promovibilidade: uma vez por candidato.
 *
 * O que ele acrescenta ao juiz de GAP: caçar GAP é busca em espaço ABERTO (a superfície medida
 * rotaciona — GAP-76 — e a cada rodada nascem GAPs novos). Constraint declarada é espaço FECHADO e
 * ENUMERÁVEL: N constraints, cada uma satisfeita/violada/indecidível/pendente/dispensada. É o critério
 * de parada que a caça a GAP nunca deu.
 *
 * Fail-CLOSED e unidirecional: qualquer falha devolve `null`, e `null` não muda nada — o relatório de
 * promovibilidade fica idêntico ao de antes desta frente. **Não existe caminho pelo qual este gate
 * torne promovível um candidato que os GAPs já barravam.**
 */
async function policyGateFor(
  db: Db, run: AutonomyRun, specHash: string,
): Promise<import("./specPolicyGate.js").PolicyGateResult | null> {
  try {
    const { runPolicyGate, policyGateEnabled } = await import("./specPolicyGate.js");
    if (!policyGateEnabled() || !specHash) return null;
    const { loadSpecFiles } = await import("./specGapScope.js");
    const refs = await loadSpecFiles(db, run.projectId);
    const artifacts: Array<{ name: string; content: string }> = [];
    for (const ref of refs) {
      const buf = await readFile(ref.filePath, "utf8").catch(() => null);
      if (buf) artifacts.push({ name: ref.path, content: buf });
    }
    // Sem artefato não há o que conferir — e "nada a conferir" jamais pode virar "tudo cumprido".
    if (artifacts.length === 0) return null;
    const { expectedArchetype } = await import("./specManifest.js");
    const extra = (await db.query("SELECT extra FROM projects WHERE id = $1", [run.projectId]))
      .rows[0] as { extra?: unknown } | undefined;
    const llm = agentsLlmFields(await resolveWorkbenchLlm({ projectId: run.projectId, tenantId: run.tenantId }));
    const res = await runPolicyGate(db, {
      projectId: run.projectId, specHash, archetype: expectedArchetype(extra?.extra ?? null),
      artifacts, autonomyRunId: run.id, validationRunId: run.validationRunId, llm,
    });
    const { policyNote } = await import("./specPolicyGate.js");
    console.info(
      `[SpecAutonomy] run=${run.id.slice(0, 8)} policy gate: ${res.ran ? policyNote(res.tally) : `NÃO rodou (${res.reason})`}`
      + `${res.rejected.length ? ` — ${res.rejected.length} constraint(s) recusada(s) na derivação` : ""}`,
    );
    return res.ran ? res : null;
  } catch (e) {
    // Igual a todo degrau deste laço: gate indisponível = nada liberado, e o motivo é DECLARADO.
    console.warn(`[SpecAutonomy] run=${run.id} policy gate indisponível (${msg(e)}) — nenhuma constraint pesa no veredicto.`);
    return null;
  }
}

/**
 * 🔴 GAP-77 — a rodada adversarial de PROMOVIBILIDADE, montada com o que só o laço tem em mão.
 *
 * O Jean deu ao juiz autoridade para dizer se um GAP realmente impede promover à Fábrica, com um
 * gatilho explícito: **o defeito tem de ter insistido em voltar DEPOIS de foco individual pago**
 * (verbatim: "focamos neles individualmente algumas vezes, se insistir a reaparecer ai sim o juiz usa
 * o novo poder"). Este é o ponto do código onde reincidência, cobertura e âncoras intocadas existem
 * juntas — por isso a montagem é aqui e o julgamento é no `gapPromotionVerdict`.
 *
 * Roda só nos DOIS fins de laço (`exhausted` por teto, `stalled` por não-progresso): é lá que o laço
 * ia dizer "trate à mão" sobre defeitos que ele já provou não conseguir fechar. Nunca roda no caminho
 * de sucesso — spec sem GAP importante não precisa de veredicto.
 *
 * Falha em qualquer degrau devolve `null` e o laço encerra com a mensagem antiga: fail-CLOSED.
 */
async function promotionVerdictFor(
  db: Db, run: AutonomyRun,
  ctx: { coverage: unknown; unjudged: string[]; endReason: "exhausted" | "stalled" },
): Promise<{
  gate: CandidateGate; round: VerdictRound | null; report: PromotabilityReport; saved: number;
  work: WorkProof; loop: LoopWork;
  policy: import("./specPolicyGate.js").PolicyGateResult | null;
} | null> {
  try {
    const {
      verdictConfig, selectVerdictCandidates, runVerdictRound, saveVerdicts, livePromotionVerdicts,
      specFileShas, promotabilityReport, focusRoundsByFile, focusRoundsByAnchor, anchoredSection,
      proveWork,
    } = await import("./gapPromotionVerdict.js");
    const cfg = verdictConfig();
    // `SPEC_VERDICT_MIN_GAPS_RESOLVED=0` desliga o recurso sem deploy: o laço encerra com a mensagem
    // antiga, sem uma linha de veredicto no log.
    if (cfg.minGapsResolved === 0) return null;
    const currentFiles = await specFilePaths(db, run.projectId).catch(() => null);
    const state = await projectFindingsState(db, run.projectId, { currentFiles });
    // Limite (b): só conta fechamento RECONCILIADO. `gapsPersisted` não-nulo é a marca de que o
    // reconciliador do GAP-67 rodou naquela rodada — sem ela, "fechado" inclui rebatismo de âncora.
    const gapsResolved = run.rounds.reduce(
      (acc, r) => acc + (r.gapsPersisted === null || r.gapsPersisted === undefined ? 0 : (r.gapsClosed ?? 0)), 0);
    // 🔴 GAP-82 — a segunda prova de trabalho: o que ESTA run gastou. Tudo medido no log da própria
    // run (nunca somando esforço de outras runs, senão "trabalho feito" viraria histórico do projeto).
    const loop: LoopWork = {
      gapsResolved,
      endReason: ctx.endReason,
      passes: run.passes,
      appliedRounds: run.rounds.filter((r) => r.applied === true).length,
      reconciledValidations: run.rounds.filter((r) => r.gapsPersisted !== null && r.gapsPersisted !== undefined).length,
      focusRounds: run.rounds.filter((r) => r.focusLevel === 2).length,
    };
    const work = proveWork(loop, cfg);
    const judged = judgedFilesOf(ctx.coverage);
    const important = state.findings.filter((f) => !f.triage && (f.severity === "blocker" || f.severity === "warning"));
    // Trechos VERBATIM só dos arquivos que esta validação julgou por inteiro — os únicos elegíveis, e
    // no máximo 3 na spec do NVX, então a leitura é barata.
    const sections = new Map<string, string>();
    const untouched = new Set<string>();
    const byFile = new Map<string, EnrichedFinding[]>();
    for (const f of important) {
      const p = String(f.file ?? "").trim();
      if (!p || !f.anchor) continue;
      if (judged && !fileJudgedIn(p.toLowerCase(), judged)) continue;
      byFile.set(p, [...(byFile.get(p) ?? []), f]);
    }
    for (const [p, list] of byFile) {
      const file = await readSpecFileAt(db, run.projectId, p);
      if (!file) continue;
      for (const a of lastUntouchedAnchors(run, p)) untouched.add(a);
      for (const f of list) {
        const anchor = String(f.anchor ?? "").trim();
        if (!anchor || sections.has(anchor)) continue;
        const sec = anchoredSection(file.content, anchor);
        if (sec) sections.set(anchor, sec);
      }
    }
    const rows = (await db.query(
      `SELECT findings, stage_b_coverage FROM spec_validation_runs
        WHERE project_id = $1 AND status IN ('passed','failed')
        ORDER BY created_at DESC LIMIT 8`,
      [run.projectId],
    )).rows as Array<{ findings: unknown; stage_b_coverage: unknown }>;
    const past = rows.map((r) => ({
      findings: Array.isArray(r.findings) ? (r.findings as ValidationFinding[]) : [],
      coverage: r.stage_b_coverage,
    }));
    const gate = selectVerdictCandidates({
      findings: important, runs: past, judged, untouched, sections, gapsResolved, work, cfg,
      focusByFile: await focusRoundsByFile(db, run.projectId).catch(() => new Map<string, number>()),
      // 🔴 GAP-81: a guarda do foco pago é por ÂNCORA e conta só rodada DEDICADA. Falha de leitura cai
      // em mapa vazio ⇒ ninguém é elegível: fail-CLOSED, como todo degrau deste recurso.
      focusByAnchor: await focusRoundsByAnchor(db, run.projectId).catch(() => new Map<string, number>()),
    });
    let round: VerdictRound | null = null;
    let saved = 0;
    const shaByFile = await specFileShas(db, run.projectId).catch(() => new Map<string, string>());
    if (gate.candidates.length > 0) {
      round = await runVerdictRound(gate.candidates, { maxRelease: cfg.maxPerRun });
      if (round.verdicts.length > 0) {
        saved = await saveVerdicts(db, {
          projectId: run.projectId, autonomyRunId: run.id, validationRunId: run.validationRunId,
          verdicts: round.verdicts, shaByFile, model: round.model,
        });
      }
    }
    const { gapScopeForProject } = await import("./specGapScope.js");
    const scope = await gapScopeForProject(db, run.projectId).catch(() => null);
    // 🔴 F2 — o mesmo `spec_hash` do veredicto de GAP: é o conteúdo em que tudo foi medido, e amarrar
    // as duas contas ao mesmo hash é o que impede um gate sobre spec A virar aval sobre a spec B.
    const specHash = String((await db.query(
      "SELECT spec_hash FROM spec_validation_runs WHERE id = $1", [run.validationRunId],
    ).catch(() => ({ rows: [] as Array<{ spec_hash?: string }> }))).rows[0]?.spec_hash ?? "");
    const policy = await policyGateFor(db, run, specHash);
    const { policyNote } = await import("./specPolicyGate.js");
    const report = promotabilityReport({
      findings: state.findings,
      verdicts: await livePromotionVerdicts(db, run.projectId, shaByFile),
      unroutedImportant: scope
        ? scope.unrouted.filter((f) => f.severity === "blocker" || f.severity === "warning").length
        : 0,
      unjudgedFiles: ctx.unjudged, cfg,
      // Só o `blocking` pesa: violação dispensada por INAPLICABILIDADE, ou que a outra família chamou
      // de vaga, fica no relatório sem bloquear — as duas pernas do equilíbrio pedido pelo Jean.
      policyViolations: policy?.tally.blocking ?? 0,
      policyNote: policy ? policyNote(policy.tally) : undefined,
    });
    console.info(
      `[SpecAutonomy] run=${run.id.slice(0, 8)} veredicto: ${gate.candidates.length} candidato(s), ` +
      `${round?.released ?? 0} liberado(s), ${report.impeditive} impeditivo(s), promovível=${report.promotable}` +
      ` — prova de trabalho ${work.kind}: ${work.detail}`,
    );
    return { gate, round, report, saved, work, loop, policy };
  } catch (e) {
    console.warn(`[SpecAutonomy] run=${run.id} veredicto de promovibilidade indisponível (${msg(e)}) — todos os GAPs seguem impeditivos.`);
    return null;
  }
}

/**
 * 🔴 GAP-77 — o parecer em prosa, para o fim do laço e para o chat.
 *
 * Diz os DOIS números (total importante e quantos seguem impeditivos), porque o limite (a) do Jean é
 * que a severidade não muda: esconder o total faria o veredicto parecer reclassificação.
 */
function verdictNote(v: NonNullable<Awaited<ReturnType<typeof promotionVerdictFor>>>): string {
  if (!v.gate.enabled) return ` ${v.gate.reason}.`;
  // 🔴 GAP-82: quando a porta abriu por ESGOTAMENTO, o parecer diz isso primeiro e com os números —
  // "o laço gastou tudo e fechou zero" é premissa da decisão, não rodapé.
  const prova = v.work.kind === "exhausted"
    ? ` ⚠️ O juiz só pôde julgar porque o **laço esgotou o orçamento sem fechar GAP**: ${v.work.detail}.`
    : "";
  const head = v.round?.ran
    ? `${prova} **Rodada adversarial de promovibilidade** (${v.gate.candidates.length} GAP(s) reincidente(s) elegível(is), com foco individual já pago): ${v.round.reason}.`
    : `${prova} **Veredicto de promovibilidade não rodou**: ${v.round?.reason ?? v.gate.reason} — todos os GAPs seguem impeditivos.`;
  const liberados = (v.round?.verdicts ?? []).filter((x) => x.impact === "nao_impeditivo");
  const lista = liberados.length > 0
    ? ` Declarado(s) NÃO impeditivo(s) — a severidade 🔴/🟡 **não muda**, isto é parecer paralelo e auditável: ` +
      liberados.map((x) => `\`${x.file}\` ${x.anchor} (${x.reason})`).join("; ") + "."
    : "";
  // 🔴 F2 — o Policy Gate entra no parecer com a COBERTURA na frente: um gate que julgou 3 de 20
  // constraints não é um gate verde, é um gate cego (foi assim que o Estágio B do GAP-13 passou por
  // progresso). Quando ele não roda, a linha DIZ que não rodou em vez de sumir.
  const policy = v.policy
    ? ` 🧾 **Policy Gate** (constraints declaradas da spec, o buraco dos 34% de `
      + `\`arXiv:2609.04167\`): ${v.policy.constraints.length} constraint(s) — `
      + `${(() => { const { tally } = v.policy; return [
        `${tally.judged}/${tally.judgeable} julgada(s)`, `${tally.satisfied} cumprida(s)`,
        `${tally.blocking} violação(ões) impeditiva(s)`,
      ].join(", "); })()}.`
    : "";
  const veredito = v.report.promotable
    ? ` ✅ **Spec PROMOVÍVEL à Fábrica** pelo parecer do juiz: nenhum GAP importante impeditivo, nenhum sem arquivo, nenhum arquivo pendente de julgamento. A promoção continua sendo sua (ato humano com confirmação).`
    : ` 🚫 **Spec NÃO promovível**: ${v.report.blockers.join("; ")}.`;
  return head + lista + policy + veredito;
}

/**
 * 🔴 GAP-43 — quantas vezes esta run já terminou um passe SEM medição?
 *
 * Deriva do log (nada de coluna nova): a rodada que fecha um passe não medido leva a marca
 * `unmeasured`, e a marca do passe corrente só é escrita DEPOIS desta conta — então o retorno é
 * "quantas vezes eu já perdoei". Deliberadamente NÃO exige que sejam consecutivas: a marca existe para
 * frear custo de LLM, e duas medições perdidas na mesma run já são sinal de validador instável, não de
 * azar. Contar por rodada em vez de por índice de passe mantém a conta correta nos dois modos
 * (`whole` não incrementa `passes`). Rodada antiga sem a marca ⇒ não conta (não inventa falha
 * retroativa).
 */
export function unmeasuredPassesSoFar(run: Pick<AutonomyRun, "rounds">): number {
  return run.rounds.filter((r) => r.unmeasured === true).length;
}

/**
 * GAP-28/GAP-33 — margem de crescimento que resta ao LAÇO. Nunca negativa: se já estourou, a margem
 * é ZERO (o arquivo não pode crescer), não uma dívida que proibiria até o encolhimento.
 *
 * A conta é cumulativa (GAP-33): `ORÇAMENTO × (passes concluídos + 1) − tudo o que a run já
 * escreveu`. Relê a run FRESCA do banco porque a rodada anterior acabou de gravar o `deltaChars`.
 */
export function growthAllowance(
  run: Pick<AutonomyRun, "rounds" | "passes">,
  budgetPerPass: number,
  /**
   * GAP-36 — parcela PROPORCIONAL à massa da spec (`proportionalGrowthBudget`). O orçamento do laço é
   * o MAIOR entre ela e o piso por passe: nenhum projeto fica mais restrito do que já era, e spec
   * grande deixa de ser estrangulada por um número absoluto. Ausente/0 ⇒ só o piso (regra do GAP-33).
   */
  proportional = 0,
  /**
   * 🔴 GAP-69 — o que as runs IRMÃS do mesmo projeto já escreveram na janela. Ver
   * `projectGrowthUsedInWindow`: sem isto o teto de "não inflar" se REGENERA a cada run.
   */
  siblingUsed = 0,
): number {
  const floor = budgetPerPass * (run.passes + 1);
  const base = Math.max(floor, proportional);
  // GAP-69: a dívida das irmãs corta a parcela PROPORCIONAL e PARA NO PISO.
  //
  // Duas guardas numa linha, e as duas foram medidas:
  //  • só entra quando o proporcional governa (spec grande). Enquanto o piso governa, o projeto é
  //    jovem e o NORTE é o contrário — texto simples tem de virar spec completa;
  //  • nunca desce abaixo do piso. Sem esta parte a dívida real do NVX LastMile (154.456 chars em 24 h,
  //    medida em prod) zeraria a margem de TODA run nova por um dia inteiro. Margem zero não faz o
  //    laço consolidar: faz cada rodada que cresça um caractere ser descartada inteira (é o penhasco
  //    do GAP-64), o laço queimar passes de Opus sem aplicar nada, e a contagem de GAPs ficar
  //    parada — exatamente o oposto do critério do Jean ("a contagem tem de CAIR").
  //
  // O que morre é o COMPOSTO, que é o defeito: em vez de ~2% da massa por run, cada run passa a ter no
  // máximo a regra pré-GAP-36 (`ORÇAMENTO × passes`) depois que a janela foi gasta. Nas 9 runs medidas
  // isso seria ~45.000 chars em vez de ~150.000 — e nenhum caso fica mais restrito do que a regra do
  // GAP-33, que rodou por semanas.
  const afterSibling = proportional > floor ? Math.max(floor, base - siblingUsed) : base;
  return Math.max(0, afterSibling - runGrowthUsed(run));
}

/**
 * 🔴 GAP-69 (2026-09-07) — o teto de crescimento se REGENERA a cada run: 2% compostos.
 *
 * ## O que estava errado (MEDIDO em prod, NVX LastMile, projeto `e2a1988c`)
 *
 * O GAP-36 fez o orçamento ser uma fração da massa da spec, e o próprio `specTotalBytes` registra por
 * que a massa é medida UMA vez: "remedir a cada rodada faria cada crescimento aplicado ampliar o
 * orçamento da rodada seguinte, um laço que se auto-autoriza a inflar (o motor do GAP-8)". Isso foi
 * resolvido DENTRO da run — e continua valendo integralmente entre runs, um nível acima: **cada run
 * nova remede a massa e ganha 2% dela outra vez**.
 *
 * Nove runs de 2026-09-07, mesma spec, medido em `spec_autonomy_runs`:
 *
 *   04:40  986.117 bytes  ·  orçamento anunciado 19.723  ·  GAPs 26
 *   ...
 *   12:26  1.136.538 bytes ·  orçamento anunciado 22.731  ·  GAPs 38
 *
 * **+150.421 bytes (+15,3%) em 7h46**, com a contagem de GAPs SUBINDO de 26 para 38. E não é abuso do
 * teto: cada run gastou quase exatamente o que lhe foi dado (19.414 de 28.455; 20.157 de 21.913;
 * 19.925 de 21.498). O orçamento não estava funcionando como teto — estava funcionando como **meta de
 * gasto**, e como é proporcional a uma massa que ele mesmo faz crescer, a próxima run recebe um
 * orçamento maior. Juros compostos com o sinal errado, contra o critério do Jean: a contagem de GAPs
 * importantes tem de CAIR.
 *
 * ## O que muda
 *
 * "A spec não INFLAR" é propriedade da SPEC, não de uma run. A dívida passa a ser lida numa JANELA do
 * projeto (`SPEC_ORACLE_GROWTH_WINDOW_HOURS`, 24 h por padrão): o que as runs irmãs escreveram nessa
 * janela é descontado do orçamento desta. Duas runs seguidas não ganham 2% cada uma — ganham 2% no
 * total, e a segunda nasce em modo consolidação se a primeira gastou tudo.
 *
 * Encolher continua gerando crédito (mesma regra do GAP-33, agora atravessando runs): a soma é o delta
 * LÍQUIDO das rodadas aplicadas, então uma run que consolidou de verdade financia a seguinte.
 *
 * ## O que a correção NÃO faz, e por quê (revisão adversarial dela mesma)
 *
 * A dívida real deste projeto na janela é **154.456 chars** (medido em prod). Descontada crua, ela
 * zeraria a margem de toda run nova por 24 h — e margem zero não faz o laço consolidar: faz cada
 * rodada que cresça um caractere ser DESCARTADA inteira (o penhasco do GAP-64), o laço queimar passes
 * de Opus sem aplicar nada e a contagem de GAPs ficar parada. Seria trocar um defeito por outro pior,
 * contra o critério do Jean.
 *
 * Então a dívida **para no piso** (`growthAllowance`): depois de gasta a janela, cada run cai para a
 * regra pré-GAP-36 em vez de zero. O que morre é o COMPOSTO — nas 9 runs medidas, ~45.000 chars em vez
 * de ~150.000 — e nenhum caso fica mais restrito do que a regra do GAP-33, que rodou por semanas.
 *
 * `SPEC_ORACLE_GROWTH_WINDOW_HOURS=0` desliga a dívida sem deploy se a medição mostrar o contrário.
 */
export async function projectGrowthUsedInWindow(
  db: Db, projectId: string, excludeRunId: string, windowHours: number,
): Promise<number> {
  if (!Number.isFinite(windowHours) || windowHours <= 0) return 0;
  try {
    const r = await db.query(
      `SELECT COALESCE(SUM((e->>'deltaChars')::int), 0) AS used
         FROM spec_autonomy_runs r, jsonb_array_elements(r.rounds) e
        WHERE r.project_id = $1
          AND r.id <> $2
          AND r.created_at > now() - make_interval(hours => $3::int)
          AND e ? 'deltaChars'
          AND (e->>'applied') = 'true'`,
      [projectId, excludeRunId, Math.ceil(windowHours)],
    );
    const used = Number((r.rows[0] as { used?: unknown } | undefined)?.used ?? 0);
    return Number.isFinite(used) ? used : 0;
  } catch (e) {
    // Orçamento é guarda-corpo, não pré-condição de escrita: falha de leitura degrada para o
    // comportamento do GAP-36 (sem dívida de irmãs) em vez de travar o laço. Declarado no log porque
    // um degrade silencioso aqui reabre o GAP-69 sem ninguém notar.
    console.warn(`[SpecAutonomy] GAP-69: não foi possível ler o crescimento das runs irmãs (${msg(e)}) — orçamento sem a dívida da janela.`);
    return 0;
  }
}

/**
 * GAP-36 — massa da spec em bytes, somando os arquivos da árvore legíveis no disco.
 *
 * `project_spec_files` NÃO guarda o conteúdo (só `file_path`/`content_sha256`), então a massa vem de
 * `stat`: uma syscall por arquivo, sem ler bytes. Arquivo ilegível conta 0 em vez de derrubar o laço —
 * orçamento é guarda-corpo, não pré-condição de escrita.
 *
 * Chamada UMA vez, na criação do laço (`spec_bytes`), e nunca dentro da rodada. São duas razões:
 *  • o denominador tem de ser FIXO — remedir a cada rodada faria cada crescimento aplicado ampliar o
 *    orçamento da rodada seguinte, um laço que se auto-autoriza a inflar (o motor do GAP-8);
 *  • o caminho da rodada não ganha `await` novo. `startAutonomyRun` agenda um advance de FUNDO em
 *    `setImmediate`, e ele corre com o advance do request — cada `await` a mais no meio muda quem vence
 *    o CLAIM. É inócuo em produção (o claim serializa e o perdedor vira no-op), mas é a diferença entre
 *    um teste determinístico e um teste que passa por sorte.
 */
async function specTotalBytes(db: Db, projectId: string): Promise<number> {
  const { loadSpecFiles } = await import("./specGapScope.js");
  const { stat } = await import("node:fs/promises");
  const refs = await loadSpecFiles(db, projectId);
  const sizes = await Promise.all(
    refs.map((r) => stat(r.filePath).then((s) => s.size).catch(() => 0)),
  );
  return sizes.reduce((a, b) => a + b, 0);
}

async function passGrowthBudget(db: Db, run: AutonomyRun): Promise<number> {
  const { ORACLE_GROWTH_BUDGET, ORACLE_GROWTH_WINDOW_HOURS, proportionalGrowthBudget } = await import("./specOracles.js");
  const fresh = (await getAutonomyRun(db, run.id)) ?? run;
  const proportional = proportionalGrowthBudget(fresh.specBytes ?? 0);
  // 🔴 GAP-69: a dívida das runs IRMÃS da janela. Lida aqui (e não em `growthAllowance`, que segue
  // pura e testável) porque quem tem o `db` é o laço.
  const sibling = await projectGrowthUsedInWindow(db, fresh.projectId, fresh.id, ORACLE_GROWTH_WINDOW_HOURS);
  // GAP-36: `specBytes` foi medido na criação do laço. Laço criado antes da migração 103 vem `null` ⇒
  // parcela proporcional 0 ⇒ vale o piso por passe (comportamento do GAP-33, sem regressão).
  const allowance = growthAllowance(fresh, ORACLE_GROWTH_BUDGET, proportional, sibling);
  if (sibling !== 0) {
    console.info(
      `[SpecAutonomy] run=${fresh.id} orçamento de crescimento: proporcional=${proportional}`
      + ` gasto_nesta_run=${runGrowthUsed(fresh)} gasto_runs_irmãs_${ORACLE_GROWTH_WINDOW_HOURS}h=${sibling}`
      + ` ⇒ margem=${allowance}`,
    );
  }
  return allowance;
}

/**
 * Fecha o arquivo corrente SEM aplicar e devolve o laço para a fila. Não é falha do laço: outro
 * arquivo pode ser revisado com sucesso no mesmo passe. `failure` conta para o `MAX_FILE_FAILURES`
 * (duas seguidas = o problema é o modelo/serviço, não o arquivo).
 */
async function skipFileAndContinue(
  db: Db, run: AutonomyRun, path: string, note: string,
  opts: {
    failure: boolean; fromStatus: AutonomyStatus;
    /** GAP-29: fatos da recusa que a PRÓXIMA tentativa deste arquivo precisa receber. */
    patch?: Partial<AutonomyRoundLog>;
  },
): Promise<boolean> {
  const failures = opts.failure ? run.fileFailures + 1 : run.fileFailures;
  const fresh = (await getAutonomyRun(db, run.id)) ?? run;
  await patchLastRound(db, fresh, { applied: false, filePath: path, note, ...(opts.patch ?? {}) });
  if (opts.failure && failures >= MAX_FILE_FAILURES) {
    await finishRun(db, fresh, "stalled",
      `${MAX_FILE_FAILURES} arquivos seguidos sem revisão aplicável (último: \`${path}\` — ${note}). Parei para não gastar mais LLM. Os arquivos já revisados neste passe estão salvos e íntegros no disco.`,
      { gaps: await currentGaps(db, run.projectId).catch(() => null) });
    return true;
  }
  await db.query(
    `UPDATE spec_autonomy_runs
        SET status = 'pending', chat_job_id = NULL, current_file = NULL, file_failures = $2,
            files_done = files_done || $3::jsonb, last_error = $4, updated_at = now()
      WHERE id = $1 AND status = $5`,
    // 🔴 GAP-70: era 500, e a coluna é TEXT — o corte era auto-imposto. O veto de consolidação já
    // tinha ~530 chars com a explicação do GAP-37 ("a rodada pediu DUAS coisas"), então a parte
    // ACIONÁVEL da recusa vinha sendo truncada no único lugar onde o humano a lê. Descoberto porque a
    // nota da graça empurrou o texto para fora do limite e o teste mostrou a frase cortada no meio.
    [run.id, failures, JSON.stringify([path]), note.slice(0, 1200), opts.fromStatus],
  );
  return true;
}

/**
 * GAP-22 — garante o registro de oráculos do conteúdo atual (best-effort).
 *
 * A chave de idempotência é o `spec_hash` da VALIDAÇÃO que produziu estes findings: é o conteúdo em que
 * a contradição foi medida, e é o recorte natural (uma decisão por conteúdo validado, não por rodada).
 * Sem run de validação não há findings — nada a decidir.
 */
async function ensureOracles(
  db: Db, run: AutonomyRun, scope: GapGroups, llm: Record<string, unknown>,
): Promise<void> {
  if (!scope.latestRunId) return;
  const row = (await db.query(
    "SELECT spec_hash FROM spec_validation_runs WHERE id = $1", [scope.latestRunId],
  )).rows[0] as { spec_hash?: string } | undefined;
  const specHash = String(row?.spec_hash ?? "");
  if (!specHash) return;
  const findings = [...[...scope.byPath.values()].flat(), ...scope.unrouted];
  const { ensureOracleDecisions } = await import("./specOracles.js");
  const res = await ensureOracleDecisions(db, run.projectId, { specHash, findings, llm });
  console.info(
    `[SpecAutonomy] run=${run.id} oráculos: vigentes=${res.decisions.length} novos=${res.decided}`
    + `${res.skipped ? ` (skip: ${res.reason})` : ` por ${res.model ?? "?"}`}`,
  );
}

/**
 * Quanto um arquivo que REDECLARA um contrato decidido pode crescer numa rodada de consolidação.
 *
 * Não é zero porque a mesma rodada resolve outros GAPs do arquivo (uma seção que faltava é crescimento
 * legítimo). É pequeno porque a patologia medida é justamente "acrescentar um parágrafo normativo em vez
 * de remover a redeclaração": num arquivo de 100k, 1% de tolerância seria toothless.
 *
 * GAP-25: o valor vive em `specOracles` porque o MESMO número é ANUNCIADO ao agente no prompt. Definir
 * duas vezes faria o critério julgado divergir do critério comunicado — o pior tipo de bug de agente.
 */

/**
 * GAP-22 — veto de consolidação. Devolve o MOTIVO da recusa, ou `null` se pode aplicar.
 *
 * Só age sobre arquivo que redeclara contrato COM oráculo já decidido (fora disso não existe "o que
 * consolidar" e nada muda em relação ao comportamento anterior).
 *
 * ## GAP-28 (2026-09-07) — o orçamento é do PASSE, não de cada arquivo
 *
 * MEDIDO na run `889af4f3`, passe 2: **8 de 11 rodadas descartadas inteiras** por este veto, cada uma
 * uma chamada de Opus 5 já paga. O teto de +2.000 chars POR ARQUIVO é impossível de respeitar quando a
 * mesma rodada também resolve 2 a 6 GAPs daquele arquivo — e o descarte total é o mesmo anti-padrão que
 * o GAP-26 acabou de matar um nível abaixo (jogar fora o trabalho bom por causa de um limite local).
 *
 * O objetivo verdadeiro nunca foi "nenhum arquivo cresce": é **a spec não inflar**. Então o orçamento
 * passa a ser um só, e quem consolidou devolve margem para quem precisa acrescentar. O número que
 * sobra é o mesmo que o prompt ANUNCIA (GAP-25) — o laço calcula e informa, o veto julga contra ele.
 *
 * ## GAP-33 (2026-09-07) — e o orçamento é do LAÇO, não de um passe
 *
 * Com o orçamento fechado dentro do passe, ele é gasto por ORDEM DE FILA: medido no passe 4 da run
 * `d7acccb8`, **3 de 6 rodadas descartadas** com deltas de +2.873, +448 e **+143** chars. Descartar
 * uma chamada de Opus 5 para poupar 143 caracteres numa spec de ~950 mil não protege nada — é o
 * mesmo desperdício que o GAP-28 veio matar, reaparecendo por granularidade. Nada justifica ser mais
 * rígido no passe 4 porque o passe 1 gastou primeiro: "não inflar" é propriedade do LAÇO.
 */
/**
 * Veredito do veto de consolidação. `veto` = motivo da recusa (`null` = pode aplicar);
 * `toleratedOverflow` = chars que passaram da margem e o laço decidiu PAGAR (GAP-64).
 */
type ConsolidationVerdict = { veto: string | null; toleratedOverflow: number; consolidationGrace: number };

async function consolidationVeto(
  db: Db, projectId: string, target: string, before: string, after: string, budget: number,
  /**
   * GAP-37 — quantos GAPs a rodada TAMBÉM pediu para resolver neste arquivo. Sem isto a recusa mentia
   * sobre a causa (ver o texto abaixo).
   */
  gapsDispatched = 0,
  /**
   * 🔴 GAP-70 — a graça de consolidação. `left` = chars que o laço ainda pode EMPRESTAR a uma rodada
   * que provadamente consolidou; `pool` = o teto por passe.
   *
   * São DOIS números porque a recusa tem de dizer a verdade: `left === 0` com `pool > 0` é "a graça
   * deste passe acabou", e `pool === 0` é "a graça está DESLIGADA" (kill-switch). Com um número só, o
   * kill-switch faria a recusa acusar rodadas anteriores de ter gasto uma graça que nunca existiu.
   */
  grace: { pool: number; left: number } = { pool: 0, left: 0 },
): Promise<ConsolidationVerdict> {
  const NADA: ConsolidationVerdict = { veto: null, toleratedOverflow: 0, consolidationGrace: 0 };
  const { loadOracleDecisions, oracleRoleForFile, oracleRegistryEnabled, growthOverflowTolerance } = await import("./specOracles.js");
  if (!oracleRegistryEnabled()) return NADA;
  const decisions = await loadOracleDecisions(db, projectId);
  if (decisions.length === 0) return NADA;
  const { restates } = oracleRoleForFile(decisions, target);
  if (restates.length === 0) return NADA;

  const delta = after.length - before.length;
  const contracts = restates.map((d) => `\`${d.contractKey}\` → \`${d.oraclePath}\``).join(", ");
  // GAP-64: quase-conformidade é COBRADA, não descartada. Ver `growthOverflowTolerance`.
  const tolerance = growthOverflowTolerance(budget);
  // 🔴 GAP-70: o fato mecânico "consolidou" é medido ANTES do teto de tamanho. Era medido DEPOIS, e por
  // isso a rodada 10 da run `f101303f` — que removeu 9 redeclarações e fechou 4 GAPs — foi descartada
  // por +692 chars sem que ninguém olhasse se ela havia consolidado.
  const cites = restates.some((d) => {
    const p = d.oraclePath.toLowerCase();
    const base = p.split("/").pop() ?? p;
    const hay = after.toLowerCase();
    return hay.includes(p) || hay.includes(base);
  });
  const gracePool = Number.isFinite(grace.pool) ? Math.max(0, grace.pool) : 0;
  const graceLeft = gracePool > 0 && Number.isFinite(grace.left) ? Math.max(0, grace.left) : 0;
  const graceHere = cites ? graceLeft : 0;
  if (delta > budget + tolerance + graceHere) {
    // 🔴 GAP-37 (2026-09-07) — a recusa dizia "a correção pedida era REMOVER a redeclaração", e isso é
    // FALSO numa rodada do laço: o mesmo pedido mandou resolver os GAPs do arquivo (medido na run
    // `6d407460`: `privacidade-lgpd.md` recebeu 🔴 5 + 🟡 2). Este texto é o `rejectedReason` que o
    // GAP-31 entrega de volta ao agente na retentativa — dizer-lhe que o pedido era só consolidar faz
    // a próxima tentativa ABANDONAR os blockers para caber na margem, e o laço "converge" sem fechar
    // nada. O código continua não escolhendo a estratégia (cortar, dividir, insistir): ele apenas
    // para de descrever o pedido errado (mesma lei do GAP-31,
    // ver feedback-genesis-100-llm-nunca-automacao-fixa).
    const alsoAsked = gapsDispatched > 0
      ? ` A rodada pediu DUAS coisas: resolver ${gapsDispatched} GAP(s) deste arquivo E consolidar as`
        + " redeclarações acima. Nenhuma das duas foi abandonada pelo veto — o que estourou foi o"
        + " TAMANHO do resultado; a remoção das redeclarações é o que paga o texto novo dos GAPs."
      : "";
    // 🔴 GAP-70: a recusa tem de dizer QUAL limite valeu e por quê. "Cite o oráculo e o laço te
    // empresta chars" é a única instrução que empurra o agente para a REMOÇÃO em vez da reescrita —
    // e mentir sobre o limite (GAP-31/37) faz a retentativa otimizar a coisa errada.
    const graceNote = gracePool <= 0
      // Graça DESLIGADA (kill-switch): a recusa não pode inventar um empréstimo que não existe.
      ? ""
      : cites
        ? (graceHere > 0
          ? ` O laço reconheceu a consolidação (o arquivo passa a citar o oráculo) e EMPRESTOU ${graceHere} chars`
            + ` de graça, mesmo assim o resultado passou: o limite desta rodada era ${budget + tolerance + graceHere}.`
          : " O laço reconheceu a consolidação (o arquivo cita o oráculo), mas a graça de consolidação deste"
            + " passe já foi toda emprestada a rodadas anteriores — não há mais chars para emprestar.")
        : " A graça de consolidação NÃO se aplica: ela só vale quando o arquivo passa a CITAR o oráculo em"
          + " vez de redeclarar a regra, e esta revisão não cita nenhum dos oráculos acima.";
    return {
      veto: `consolidação recusada: este arquivo redeclara contrato de outro (${contracts}) e a correção pedida`
        + ` incluía REMOVER a redeclaração deixando a citação do oráculo — a revisão CRESCEU ${delta} chars`
        + ` e a margem de crescimento que restava ao laço era ${budget}`
        + (tolerance > 0 ? ` (com a tolerância de ${tolerance}, o limite desta rodada era ${budget + tolerance})` : "")
        + `. Nada foi escrito.${graceNote}${alsoAsked}`,
      toleratedOverflow: 0,
      consolidationGrace: 0,
    };
  }
  // Fato de transporte, não julgamento: consolidar deixa rastro — ou o path do oráculo aparece
  // (citação), ou o arquivo encolheu (a redeclaração saiu). Nenhum dos dois = a rodada não consolidou.
  if (!cites && delta >= 0) {
    return {
      veto: `consolidação recusada: a revisão não cita o oráculo (${contracts}) nem encolheu o arquivo`
        + ` (${delta >= 0 ? "+" : ""}${delta} chars) — não houve consolidação a aplicar. Nada foi escrito.`,
      toleratedOverflow: 0,
      consolidationGrace: 0,
    };
  }
  // GAP-64: passou. Se passou DENTRO da tolerância, o excesso é fato de log — o orçamento do laço já o
  // cobra na rodada seguinte (`growthAllowance` desconta tudo o que a run escreveu).
  // GAP-70: e o que passou ALÉM da tolerância só passou porque foi EMPRESTADO do pool do passe —
  // contabilizado à parte para que o pool seja consumido por quem consolidou, não por quem só estourou.
  return {
    veto: null,
    toleratedOverflow: delta > budget ? delta - budget : 0,
    consolidationGrace: delta > budget + tolerance ? delta - (budget + tolerance) : 0,
  };
}

/**
 * pending (spec DIVIDIDA) → uma rodada = UM arquivo. Ordem de decisões (cada uma fecha um modo de
 * falha real): teto de passes → teto de custo → spec ainda editável → GAPs restantes → escopo
 * (quem é de quem, via specGapScope/094) → oráculos (GAP-22) → fila → despacho do CTO-EDITOR.
 */
async function startFileRound(db: Db, run: AutonomyRun): Promise<boolean> {
  if (run.passes >= run.maxRounds) {
    const gaps = await currentGaps(db, run.projectId).catch(() => null);
    await finishRun(db, run, "exhausted",
      `Limite de ${run.maxRounds} passe(s) de validação atingido (${run.round} arquivo(s) revisado(s)). Revise os GAPs restantes na aba GAPs e triagem o que for risco aceito.`, { gaps });
    return true;
  }
  // GAP-3: o teto de arquivos é do PASSE (o do laço inteiro é o `TOTAL`). Sem isto, uma spec com mais
  // arquivos que o teto gastava todos os passes no primeiro e nunca chegava à 2ª validação.
  const roundsInPass = run.rounds.filter((r) => (r.pass ?? 0) === run.passes).length;
  if (roundsInPass >= AUTONOMY_MAX_FILE_ROUNDS || run.round >= AUTONOMY_MAX_TOTAL_FILE_ROUNDS) {
    const gaps = await currentGaps(db, run.projectId).catch(() => null);
    const perPass = roundsInPass >= AUTONOMY_MAX_FILE_ROUNDS;
    await finishRun(db, run, "exhausted",
      perPass
        ? `Teto de ${AUTONOMY_MAX_FILE_ROUNDS} arquivos revisados neste passe atingido (${run.round} no laço todo). Tudo o que foi revisado está salvo — rode o modo autônomo de novo para continuar de onde parou.`
        : `Teto de ${AUTONOMY_MAX_TOTAL_FILE_ROUNDS} arquivos revisados neste laço atingido. Tudo o que foi revisado está salvo — rode o modo autônomo de novo para continuar de onde parou.`,
      { gaps });
    return true;
  }
  const editable = await specEditable(db, run.projectId);
  if (!editable.ok) {
    await finishRun(db, run, "stalled", `A spec deixou de ser editável no meio do laço (projeto em '${editable.status}') — nada foi alterado.`);
    return true;
  }
  const gaps = await currentGaps(db, run.projectId);
  if (gaps.important === 0) {
    await finishRun(db, run, "succeeded",
      `Nenhum GAP vermelho ou amarelo ATIVO restante${gaps.info ? ` (${gaps.info} item(ns) de baixo risco seguem em aberto, por desenho)` : ""}.`, { gaps });
    return true;
  }
  const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim();
  if (!agentsUrl) {
    await finishRun(db, run, "failed", "Serviço de agentes não configurado (API_AGENTS_URL) — laço encerrado.");
    return true;
  }

  // A que arquivo pertence cada GAP. `route: true` paga UMA vez por run de validação o agente que
  // decide os globais (Stage A) — sem ele os transversais ficariam eternamente fora da fila.
  const { ensureGapScope, buckets } = await import("./specGapScope.js");
  const llm = agentsLlmFields(await resolveWorkbenchLlm({ projectId: run.projectId, tenantId: run.tenantId }));
  const { scope, routing } = await ensureGapScope(db, run.projectId, { route: true, llm });
  if (routing) {
    console.info(`[SpecAutonomy] run=${run.id} roteamento de GAPs: routed=${routing.routed} restantes=${routing.stillUnrouted}${routing.skipped ? ` (skip: ${routing.reason})` : ""}`);
  }
  // GAP-22: ANTES de despachar, quem é a FONTE ÚNICA de cada contrato em disputa. Sem isto a rodada
  // por arquivo não tem correção possível para uma contradição ENTRE arquivos (escolher um valor aqui
  // deixa o irmão dizendo o outro) — e o CTO só consegue ACRESCENTAR mais um parágrafo normativo, que
  // é o motor medido do GAP-8. A decisão é do agente e é PERSISTIDA: uma vez por conteúdo de spec, não
  // uma vez por rodada (re-decidir a cada rodada é o que fazia a contradição migrar de arquivo).
  await ensureOracles(db, run, scope, llm).catch((e) =>
    console.warn(`[SpecAutonomy] run=${run.id} registro de oráculos indisponível (segue sem ele): ${msg(e).slice(0, 200)}`));
  // A5.3: o manifesto é o ÚNICO alvo que pode não existir ainda — entra no FIM da fila (os GAPs de
  // conteúdo valem mais que o índice, e criar o arquivo muda o hash da árvore).
  const manifestTarget = manifestGapFindings(scope).length > 0
    && !run.filesDone.includes(MANIFEST_PATH)
    && !scope.files.some((f) => f.path.toLowerCase() === MANIFEST_PATH.toLowerCase());
  const queue = [
    ...importantFileQueue(buckets(scope)),
    ...(manifestTarget ? [MANIFEST_PATH] : []),
  ].filter((p) => !run.filesDone.includes(p));

  if (queue.length === 0) {
    const applied = appliedInPass(run);
    if (applied === 0) {
      // Nada foi escrito neste passe: validar seria queimar uma das 4 validações/h para medir a
      // MESMA spec. O motivo mais comum é GAP importante sem arquivo definido (o roteador não
      // decidiu) — dizê-lo é melhor que "sem progresso".
      const unroutedImportant = scope.unrouted.filter((f) => f.severity === "blocker" || f.severity === "warning").length;
      await finishRun(db, run, "stalled", unroutedImportant > 0
        ? `${unroutedImportant} GAP(s) importante(s) continuam SEM arquivo definido — não sei em qual arquivo da spec resolvê-los, e não vou adivinhar. Abra a aba GAPs e resolva-os no arquivo certo (ou rode Validar de novo para o validador reatribuí-los).`
        : "Nenhum arquivo da spec pôde ser revisado neste passe — a spec no disco está intacta. Veja o log das rodadas para o motivo de cada arquivo.",
        { gaps });
      return true;
    }
    // Fila esvaziada com trabalho aplicado → UMA validação adversarial para medir o passe inteiro.
    const claim = await db.query(
      `UPDATE spec_autonomy_runs
          SET status = 'validating', passes = passes + 1, files_done = '[]'::jsonb, current_file = NULL,
              validation_run_id = NULL, gaps_current = $2, updated_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [run.id, gaps.important],
    );
    if ((claim.rowCount ?? 0) === 0) return false;
    await postChatNote(db, run,
      `🤖 **Passe ${run.passes + 1}/${run.maxRounds} — fila de arquivos concluída** (${applied} arquivo(s) revisado(s) e salvo(s)). Validando a spec inteira para medir o resultado.`);
    const fresh = (await getAutonomyRun(db, run.id))!;
    await kickValidation(db, fresh);
    return true;
  }

  const target = queue[0];
  const file = await readSpecFileAt(db, run.projectId, target);
  // A5.3: o manifesto não tem arquivo para ler nem GAPs "deste arquivo" — é criação, não edição.
  // GAP-5: o que decide é a EXISTÊNCIA, não o nome. Depois de criado, o `README.md` ganha GAPs
  // próprios e volta à fila como qualquer outro arquivo — aí o caminho certo é o CTO-editor.
  if (target === MANIFEST_PATH && !file) return startManifestRound(db, run, scope, gaps, agentsUrl, llm);
  if (!file) {
    // Arquivo saiu da árvore/disco entre a validação e agora (split, remoção). Não é falha do
    // modelo: só sai da fila deste passe.
    return skipFileAndContinue(db, run, target, "arquivo não está mais legível no disco", { failure: false, fromStatus: "pending" });
  }
  // Só 🔴/🟡 vão ao CTO: `info` é "baixo risco" e não sustenta rodada — mandá-los inflaria a saída
  // (o arquivo volta inteiro) sem mover o critério de parada.
  const fileFindings = (scope.byPath.get(target) ?? []).filter((f) => f.severity === "blocker" || f.severity === "warning");
  const fileBlockers = fileFindings.filter((f) => f.severity === "blocker").length;

  const nextRound = run.round + 1;
  const jobId = randomUUID();
  // CLAIM antes do dispatch (dois ticks sobrepostos não pagam dois CTOs pelo mesmo arquivo).
  const claim = await db.query(
    `UPDATE spec_autonomy_runs
        SET status = 'cto_running', mode = 'per_file', round = $2, chat_job_id = $3, base_spec_sha = $4,
            current_file = $5, gaps_current = $6, validation_run_id = NULL, updated_at = now()
      WHERE id = $1 AND status = 'pending' AND round = $7`,
    [run.id, nextRound, jobId, file.sha, target, gaps.important, run.round],
  );
  if ((claim.rowCount ?? 0) === 0) return false;

  // GAP-28: a margem ANUNCIADA é a que sobrou do passe — a mesma que o veto vai julgar no apply.
  // GAP-38: calculada ANTES do log da rodada, porque agora ela também é registrada (auditoria do
  // contrato de saída: pedido × entrega). O CLAIM já aconteceu acima, então nada aqui compete.
  const growthBudget = await passGrowthBudget(db, run);

  await appendRoundLog(db, run.id, {
    round: nextRound, pass: run.passes, startedAt: new Date().toISOString(), chatJobId: jobId,
    filePath: target, gapsBefore: gaps.important, blockers: fileBlockers, warnings: fileFindings.length - fileBlockers,
    specChars: file.content.length, announcedBudget: growthBudget,
    // GAP-71: as âncoras vão para o log AQUI porque só o despacho as tem; a medição "o trecho ficou
    // intocado?" acontece no apply, num tick em que o escopo já não existe.
    gapAnchors: gapAnchorsOf(fileFindings),
    note: `\`${target}\` enviado ao CTO (${fileFindings.length} GAP(s) deste arquivo).`,
  });

  const { dispatchGapFileJob } = await import("../routes/specChat.js");
  // GAP-29: se a tentativa anterior neste arquivo foi descartada por tamanho, o agente recebe o FATO.
  const priorRejection = lastRejectedAttempt(run, target);
  // 🔴 GAP-68: e se algum destes GAPs já foi entregue antes e SOBREVIVEU à edição, o agente recebe
  // esse fato também — é a única coisa que ele não pode deduzir do texto do arquivo.
  const knownRefs = await knownPersistentGaps(db, run);
  // 🔴 GAP-71: a reincidência de fingerprint ESTÁVEL — o caso que o reconciliador do GAP-67 não vê (um
  // GAP que não sai nem entra da lista dá `closed: 0, opened: 0` e `persisted` vazio). Cruzada com as
  // âncoras que a rodada anterior deixou INTOCADAS, é o que diz ao agente que a errata não funcionou.
  const stableRefs = await stableRecurrenceFor(db, run, target, fileFindings);
  const persistentGaps = markUntouched(
    mergeRecurrenceRefs(persistentGapsFor(knownRefs, target, fileFindings), stableRefs),
    lastUntouchedAnchors(run, target),
  );
  // 🔴 GAP-81: o arquivo teimoso recebia o MESMO pedido em todo passe — todos os GAPs dele de uma vez —
  // e os mesmos 3–4 itens perdiam a triagem interna do agente rodada após rodada (medido: 5 âncoras
  // com 5 a 9 eventos "intocada" em 8 runs, em arquivos que iam INTEIROS ao CTO). A escalada é o que
  // faltava: primeiro só os reincidentes, depois um só. A conta de rodadas é do PROJETO, não da run —
  // os arquivos teimosos do NVX atravessaram várias runs, e zerar a escalada faria o degrau 2 nunca
  // chegar. Falha de banco degrada para "nenhuma rodada paga" (fail-CLOSED: sem escalada, não escalada
  // por acidente de leitura).
  // O `catch` cobre o import inteiro, não só a consulta: a escalada é um AJUSTE de escopo, e nenhuma
  // falha ao lê-la pode derrubar a rodada que ia escrever o arquivo.
  const fileRounds = await (async () => {
    try {
      const { focusRoundsByFile } = await import("./gapPromotionVerdict.js");
      return (await focusRoundsByFile(db, run.projectId)).get(target.toLowerCase()) ?? 0;
    } catch { return 0; }
  })();
  const focus = planFocus({ findings: fileFindings, refs: persistentGaps, fileRounds });
  const dispatched = focus.level === 0 ? fileFindings : (focus.findings as EnrichedFinding[]);
  // As refs de reincidência acompanham a lista restrita: mandar o fato de um GAP que NÃO está na lista
  // faria o agente trabalhar fora do foco, que é exatamente o que esta rodada existe para evitar.
  const dispatchedFps = new Set(dispatched.map((f) => findingFingerprint(f)));
  const dispatchGaps = focus.level === 0
    ? persistentGaps
    : persistentGaps.filter((r) => dispatchedFps.has(r.fingerprint));
  if (focus.level > 0) {
    console.info(`[SpecAutonomy] run=${run.id} ${target}: rodada DEDICADA nível ${focus.level} — ${dispatched.length} de ${fileFindings.length} GAP(s), ${fileRounds} rodada(s) já pagas neste arquivo.`);
    await mergeIntoLastRound(db, run.id, {
      focusLevel: focus.level as 1 | 2, focusAnchors: focus.anchors, focusDeferred: focus.deferred,
      // A âncora medida no apply tem de ser a da lista RESTRITA: medir as outras produziria
      // "intocada" para GAPs que esta rodada nem pediu — acusação sem pedido.
      gapAnchors: gapAnchorsOf(dispatched),
      note: `\`${target}\` enviado ao CTO — ${focus.reason} (${dispatched.length} de ${fileFindings.length} GAP(s); ${focus.deferred} adiado(s), seguem ATIVOS).`,
    });
  }
  if (persistentGaps.length > 0) {
    // 🔴 GAP-71 (medido em prod na PRIMEIRA rodada da run 95ba8636): as 11 refs `stable` foram
    // calculadas e ENTREGUES ao CTO (2.561 chars de bloco), mas o log da rodada ficou com
    // `persistedGaps: null` — o campo só era escrito pelo reconciliador do GAP-67, na validação.
    // Consequência: nem o humano no chat nem uma consulta ao banco conseguiam ver que o agente já
    // tinha sido avisado, e a única leitura possível ("ninguém avisou") é a oposta da verdade.
    // Registrar aqui é o que faz a afirmação AUDITÁVEL — e não altera a linhagem, porque as refs
    // estáveis são recontadas do banco a cada despacho (`mergeRecurrenceRefs` mantém o maior `times`).
    // ⚠️ `mergeIntoLastRound`, NÃO `patchLastRound`: aqui `run.rounds` é stale (o `appendRoundLog`
    // acima já gravou a rodada nova) e reescrever o array de memória a APAGARIA.
    await mergeIntoLastRound(db, run.id, { persistedGaps: persistentGaps });
  } else if (knownRefs.length > 0) {
    // Refs existem mas nenhuma casou com este arquivo: normal se os reincidentes são de OUTRO arquivo.
    // Vira sintoma quando acontece para todos os arquivos do passe — aí a ação está inerte.
    console.info(`[SpecAutonomy] run=${run.id} ${target}: ${knownRefs.length} ref(s) de reincidência conhecidas, nenhuma deste arquivo/leva.`);
  }
  try {
    const res = await dispatchGapFileJob({
      jobId, projectId: run.projectId, tenantId: run.tenantId, ownerUserId: run.ownerUserId,
      filePath: target, fileContent: file.content, findings: dispatched, agentsUrl, llm, growthBudget,
      priorRejection, persistentGaps: dispatchGaps, focus,
      userMessage: focus.level > 0
        ? `🤖 Modo autônomo — passe ${run.passes + 1}/${run.maxRounds}, arquivo ${nextRound}: rodada DEDICADA em \`${target}\` — ${dispatched.length} GAP(s) reincidente(s) de ${fileFindings.length} (${focus.deferred} adiado(s), seguem ativos).`
        : `🤖 Modo autônomo — passe ${run.passes + 1}/${run.maxRounds}, arquivo ${nextRound}: resolver ${fileFindings.length} GAP(s) de \`${target}\` (🔴 ${fileBlockers} · 🟡 ${fileFindings.length - fileBlockers}).`,
    });
    if (!res.ok) {
      // Arquivo grande demais para caber no orçamento de saída, ou sem GAP no fim das contas: o
      // arquivo sai da fila com o motivo registrado e o laço segue no próximo.
      const fresh = (await getAutonomyRun(db, run.id))!;
      return skipFileAndContinue(db, fresh, target, res.message, { failure: false, fromStatus: "cto_running" });
    }
    console.info(`[SpecAutonomy] run=${run.id} passe ${run.passes + 1}/${run.maxRounds} arquivo ${nextRound} (${target}) → CTO job=${jobId} (${res.gaps} GAPs)`);
    return true;
  } catch (e) {
    const fresh = (await getAutonomyRun(db, run.id))!;
    await finishRun(db, fresh, "failed", `Falha ao acionar o CTO: ${msg(e).slice(0, 300)}`);
    return true;
  }
}

/** Sha do vazio: a pré-condição de CRIAÇÃO é "o arquivo continua não existindo" (If-Match de criação). */
const EMPTY_SHA = sha256Hex(Buffer.alloc(0));

/**
 * A5.3 — rodada que CRIA o manifesto (`README.md`), o único alvo do laço que ainda não existe.
 *
 * Difere da rodada normal em três pontos, todos consequência de ser criação e não edição:
 *  • não há arquivo para ler → a base é o vazio (`EMPTY_SHA`), e a guarda de edição humana passa a
 *    significar "alguém criou o README no meio da rodada" (aí o laço NÃO sobrescreve);
 *  • não há "GAPs deste arquivo" para mandar ao CTO — o insumo é a árvore + o arquivo primário;
 *  • o conteúdo é do agente; o código só entrega fatos e veta (`assessManifest`).
 */
async function startManifestRound(
  db: Db, run: AutonomyRun, scope: GapGroups, gaps: GapTally,
  agentsUrl: string, llm: Record<string, unknown>,
): Promise<boolean> {
  const row = (await db.query("SELECT title, extra FROM projects WHERE id = $1", [run.projectId])).rows[0] as
    { title?: string; extra?: unknown } | undefined;
  const primary = scope.files.find((f) => f.isPrimary) ?? scope.files[0];
  if (!primary) {
    return skipFileAndContinue(db, run, MANIFEST_PATH,
      "a spec não tem nenhum arquivo para basear o manifesto", { failure: false, fromStatus: "pending" });
  }
  const primaryContent = await readFile(primary.filePath, "utf-8").catch(() => null);
  if (primaryContent === null) {
    return skipFileAndContinue(db, run, MANIFEST_PATH,
      `arquivo primário \`${primary.path}\` não está legível no disco`, { failure: false, fromStatus: "pending" });
  }

  const nextRound = run.round + 1;
  const jobId = randomUUID();
  const claim = await db.query(
    `UPDATE spec_autonomy_runs
        SET status = 'cto_running', mode = 'per_file', round = $2, chat_job_id = $3, base_spec_sha = $4,
            current_file = $5, gaps_current = $6, validation_run_id = NULL, updated_at = now()
      WHERE id = $1 AND status = 'pending' AND round = $7`,
    [run.id, nextRound, jobId, EMPTY_SHA, MANIFEST_PATH, gaps.important, run.round],
  );
  if ((claim.rowCount ?? 0) === 0) return false;

  const manifestGaps = manifestGapFindings(scope);
  await appendRoundLog(db, run.id, {
    round: nextRound, pass: run.passes, startedAt: new Date().toISOString(), chatJobId: jobId,
    filePath: MANIFEST_PATH, manifestCreation: true, gapsBefore: gaps.important,
    blockers: manifestGaps.filter((f) => f.severity === "blocker").length,
    warnings: manifestGaps.filter((f) => f.severity === "warning").length,
    specChars: 0,
    note: `\`${MANIFEST_PATH}\` não existe — pedindo ao CTO o manifesto do projeto (${scope.files.length} arquivo(s) na árvore).`,
  });

  const { dispatchManifestJob } = await import("../routes/specChat.js");
  try {
    await dispatchManifestJob({
      jobId, projectId: run.projectId, tenantId: run.tenantId, ownerUserId: run.ownerUserId,
      projectTitle: (row?.title ?? "").trim() || "projeto sem título",
      archetype: expectedArchetype(row?.extra ?? null),
      files: scope.files.map((f) => f.path),
      primaryPath: primary.path, primaryContent, agentsUrl, llm,
      userMessage: `🤖 Modo autônomo — passe ${run.passes + 1}/${run.maxRounds}, arquivo ${nextRound}: criar o manifesto \`${MANIFEST_PATH}\` (GAP "Spec sem manifesto").`,
    });
    console.info(`[SpecAutonomy] run=${run.id} passe ${run.passes + 1}/${run.maxRounds} arquivo ${nextRound} (${MANIFEST_PATH}, CRIAÇÃO) → CTO job=${jobId}`);
    return true;
  } catch (e) {
    const fresh = (await getAutonomyRun(db, run.id))!;
    return skipFileAndContinue(db, fresh, MANIFEST_PATH, `falha ao pedir o manifesto: ${msg(e).slice(0, 300)}`,
      { failure: true, fromStatus: "cto_running" });
  }
}

/**
 * A5.3 — escreve o manifesto APROVADO no disco e registra o arquivo novo na árvore.
 *
 * Ordem: disco → linha em `project_spec_files` → `spec_dirty_at`. Não há snapshot porque não há
 * conteúdo anterior a preservar; a pré-condição (`ON CONFLICT DO NOTHING` + checagem do chamador) é
 * "não existia". `is_primary` fica FALSO: o primário atual continua sendo o primário — o manifesto é
 * a porta de entrada, e mudar o primário no meio de um laço trocaria o alvo de todas as outras ações.
 */
async function createManifestFile(db: Db, projectId: string, content: string): Promise<string> {
  const uploadDir = (process.env.UPLOAD_DIR ?? "/shared/uploads").trim();
  const physical = path.resolve(uploadDir, projectId, MANIFEST_PATH);
  await mkdir(path.dirname(physical), { recursive: true });
  await writeFile(physical, content, "utf-8");
  await db.query(
    `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256)
     VALUES ($1, $2, $3, 'text/markdown', '', false, $4) ON CONFLICT DO NOTHING`,
    [projectId, MANIFEST_PATH, physical, sha256Hex(Buffer.from(content, "utf-8"))],
  );
  await db.query("UPDATE projects SET spec_dirty_at = now() WHERE id = $1", [projectId]);
  return physical;
}

/**
 * applying (manifesto) → CRIA o arquivo se o veto aprovar. As guardas aqui são de outra natureza:
 * não existe "encolheu" nem "veio igual" (não havia base), e o que substitui `assessRevisionIntegrity`
 * é o `assessManifest` — cada recusa dele corresponde a um finding que o Estágio A reaplicaria, ou
 * seja: escrever assim faria o laço andar para trás.
 */
async function applyManifestRound(db: Db, run: AutonomyRun, revised: string, truncated: boolean): Promise<boolean> {
  const editable = await specEditable(db, run.projectId);
  if (!editable.ok) {
    await finishRun(db, run, "stalled",
      `A spec deixou de ser editável antes de criar o manifesto (projeto em '${editable.status}') — nada foi escrito.`);
    return true;
  }
  if (truncated) {
    return skipFileAndContinue(db, run, MANIFEST_PATH,
      "o manifesto voltou truncado (teto de saída) — não escrevo índice pela metade", { failure: true, fromStatus: "applying" });
  }
  // Guarda de criação concorrente: se o README passou a existir durante a rodada (humano, split),
  // a proposta do CTO NÃO sobrescreve — ela fica no chat do arquivo.
  const already = await readSpecFileAt(db, run.projectId, MANIFEST_PATH);
  if (already) {
    return skipFileAndContinue(db, run, MANIFEST_PATH,
      "o manifesto passou a existir durante a rodada — não sobrescrevi", { failure: false, fromStatus: "applying" });
  }
  const row = (await db.query("SELECT extra FROM projects WHERE id = $1", [run.projectId])).rows[0] as
    { extra?: unknown } | undefined;
  const verdict = assessManifest(revised, { expected: expectedArchetype(row?.extra ?? null) });
  if (!verdict.ok) {
    return skipFileAndContinue(db, run, MANIFEST_PATH, `manifesto recusado (${verdict.code}): ${verdict.message}`,
      { failure: true, fromStatus: "applying" });
  }
  try {
    await createManifestFile(db, run.projectId, verdict.content);
  } catch (e) {
    await patchLastRound(db, run, { applied: false, filePath: MANIFEST_PATH, note: `criação abortada: ${msg(e)}` });
    await finishRun(db, run, "stalled",
      `NÃO criei o manifesto \`${MANIFEST_PATH}\`: ${msg(e)}. A spec no disco está INTACTA e a proposta continua no chat.`);
    return true;
  }
  await patchLastRound(db, run, {
    applied: true, filePath: MANIFEST_PATH, specChars: verdict.content.length,
    note: `\`${MANIFEST_PATH}\` CRIADO (${verdict.content.length} chars, arquétipo \`${verdict.archetypeId}\`).`,
  });
  const claim = await db.query(
    `UPDATE spec_autonomy_runs
        SET status = 'pending', chat_job_id = NULL, current_file = NULL, file_failures = 0,
            files_done = files_done || $2::jsonb, updated_at = now()
      WHERE id = $1 AND status = 'applying'`,
    [run.id, JSON.stringify([MANIFEST_PATH])],
  );
  if ((claim.rowCount ?? 0) === 0) return false;
  await postChatNote(db, run,
    `🤖 **Arquivo ${run.round} do passe ${run.passes + 1}** — \`${MANIFEST_PATH}\`: manifesto do projeto **criado** (${verdict.content.length} chars, arquétipo \`${verdict.archetypeId}\`). Era o GAP que nenhuma ação da Bancada sabia resolver.`);
  return true;
}

/**
 * applying (modo por arquivo) → escreve NO ARQUIVO da rodada e volta para a fila (a validação só
 * roda quando a fila esvazia). As guardas são as MESMAS do modo inteiro, com uma diferença de
 * escopo: o que é problema DAQUELE arquivo (truncamento, encolhimento, revisão idêntica) tira o
 * arquivo da fila; o que é do PROJETO (edição humana, spec travada, snapshot indisponível) para o
 * laço, porque vale para todos os arquivos.
 */
async function applyFileRound(db: Db, run: AutonomyRun): Promise<boolean> {
  const target = run.currentFile!;
  if (!run.chatJobId) {
    return skipFileAndContinue(db, run, target, "rodada sem job do CTO associado", { failure: true, fromStatus: "applying" });
  }
  const job = await getSpecChatJob(db, run.chatJobId);
  const revised = job?.specMarkdown ?? null;
  if (!revised) {
    return skipFileAndContinue(db, run, target, "a revisão do CTO desapareceu antes de ser aplicada", { failure: true, fromStatus: "applying" });
  }
  // A5.3: o manifesto é CRIAÇÃO — as guardas de edição (base, encolhimento, integridade) não se
  // aplicam a um arquivo que não existia, e `readSpecFileAt` abaixo devolveria null.
  // GAP-5: quem decide é a rodada REGISTRADA, não o nome do arquivo. Se o `README.md` já existia, a
  // rodada foi de edição e tem de ser aplicada como tal — senão o guard de criação descartaria uma
  // revisão paga com "o manifesto passou a existir".
  const lastRound = run.rounds[run.rounds.length - 1];
  if (lastRound?.manifestCreation === true && lastRound.round === run.round) {
    return applyManifestRound(db, run, revised, job?.truncated === true);
  }
  const file = await readSpecFileAt(db, run.projectId, target);
  if (!file) {
    return skipFileAndContinue(db, run, target, "arquivo não está mais legível no disco", { failure: false, fromStatus: "applying" });
  }
  const editable = await specEditable(db, run.projectId);
  if (!editable.ok) {
    await finishRun(db, run, "stalled", `A spec deixou de ser editável antes de aplicar (projeto em '${editable.status}') — nada foi escrito.`);
    return true;
  }

  const revisedSha = sha256Hex(Buffer.from(revised, "utf-8"));
  if (revisedSha === file.sha) {
    // O CTO devolveu o arquivo IGUAL tendo GAPs para resolver: não há o que escrever e não houve
    // progresso — conta como falha de arquivo (duas seguidas param o laço).
    return skipFileAndContinue(db, run, target, "o CTO devolveu o arquivo sem alteração", { failure: true, fromStatus: "applying" });
  }
  if (file.sha !== run.baseSpecSha) {
    // 🔴 GUARDA DE EDIÇÃO HUMANA (do PROJETO): o humano mexeu neste arquivo durante a rodada.
    await patchLastRound(db, run, { applied: false, filePath: target, note: "arquivo editado por fora durante a rodada" });
    await finishRun(db, run, "stalled",
      `O arquivo \`${target}\` foi editado por fora durante a rodada — NÃO sobrescrevi sua edição. A revisão do CTO continua disponível no chat deste arquivo para você aplicar manualmente.`);
    return true;
  }
  if (revised.length < file.content.length * MIN_SHRINK_RATIO) {
    return skipFileAndContinue(db, run, target,
      `revisão encolheu (${revised.length} < ${Math.round(file.content.length * MIN_SHRINK_RATIO)} chars)`,
      { failure: true, fromStatus: "applying" });
  }
  // GAP-12: `editsApplied != null` é o FATO de que o conteúdo saiu de blocos ancorados — nesse
  // formato, seção que sai é remoção DECIDIDA, não perda por corte (ver `assessRevisionIntegrity`).
  const anchoredEdits = (job?.editsApplied ?? 0) > 0;
  const integrity = assessRevisionIntegrity(file.content, revised, job?.truncated === true, { anchoredEdits });
  if (!integrity.ok) {
    return skipFileAndContinue(db, run, target, `revisão recusada (${integrity.reason}): ${integrity.detail}`,
      { failure: true, fromStatus: "applying" });
  }
  // A remoção autorizada é DECLARADA: no log da rodada e no chat, com os títulos que saíram.
  const removedNote = integrity.removedSections?.length
    ? ` ${integrity.removedSections.length} seção(ões) REMOVIDA(S) por edição ancorada: ` +
      `${integrity.removedSections.slice(0, 6).map((h) => `“${h}”`).join(", ")}` +
      `${integrity.removedSections.length > 6 ? " …" : ""}.`
    : "";
  // 🔴 GAP-14 (medido em prod 2026-09-06, run c3757985 rodada 2): o CTO REESCREVEU o `README.md`
  // (15.720 → 19.392 chars) e trocou o arquétipo por `backend_api` — que não existe no catálogo. O
  // veto de manifesto (`assessManifest`) só protegia a CRIAÇÃO (A5.3); na EDIÇÃO o laço podia
  // rebaixar o próprio manifesto a BLOCKER estrutural (`archetype_unknown`), e aí o Estágio A cala o
  // adversarial: a validação seguinte mediu 1 GAP em vez de 21 (o GAP-13 acima é o outro lado disto).
  // O manifesto é o ÚNICO arquivo cujo frontmatter a fábrica LÊ para rotear o projeto — o código não
  // escolhe o conteúdo (isso é do agente), só recusa o que quebraria a leitura da própria fábrica.
  // A regra é NÃO-REGRESSÃO, não perfeição: um manifesto que JÁ está sem frontmatter continua
  // editável (adicioná-lo pode levar rodadas, e é um GAP legítimo deste arquivo). O que o código
  // recusa é a rodada que ESTRAGA um manifesto que estava válido.
  if (target.toLowerCase() === MANIFEST_PATH.toLowerCase()) {
    const prj = (await db.query("SELECT extra FROM projects WHERE id = $1", [run.projectId])).rows[0] as
      { extra?: unknown } | undefined;
    const expected = expectedArchetype(prj?.extra ?? null);
    const wasValid = assessManifest(file.content, { expected }).ok;
    const verdict = assessManifest(revised, { expected });
    if (wasValid && !verdict.ok) {
      return skipFileAndContinue(db, run, target,
        `manifesto recusado (${verdict.code}): ${verdict.message}`, { failure: true, fromStatus: "applying" });
    }
  }
  // 🔴 GAP-22 — ORÇAMENTO DE CONSOLIDAÇÃO (o "contrato de saída" do G1, aplicado onde ele é
  // verificável). Quando este arquivo REDECLARA um contrato cujo oráculo já foi decidido, a correção
  // pedida é REMOVER a redeclaração e deixar uma citação — ou seja, o arquivo deve encolher. A
  // patologia medida em prod é o oposto: o CTO acrescenta mais um parágrafo normativo, o arquivo
  // cresce e a contradição reaparece na rodada seguinte em outro arquivo (motor do GAP-8).
  // O código não julga o conteúdo: mede DELTA DE TAMANHO e CITAÇÃO LITERAL do path do oráculo — dois
  // fatos. Recusar não é falha de arquivo (`failure: false`): é o laço se negando a pagar crescimento
  // como se fosse correção, deixando o disco intacto e seguindo para o próximo arquivo.
  const passBudget = await passGrowthBudget(db, run);
  // GAP-37: quantos GAPs esta rodada pediu — o log do despacho é a fonte (o escopo já não está em
  // memória neste tick). Sem o número, a recusa descreveria o pedido errado ao agente.
  const dispatched = lastRound?.round === run.round
    ? (lastRound.blockers ?? 0) + (lastRound.warnings ?? 0)
    : 0;
  // 🔴 GAP-70: quanto o laço ainda pode emprestar a uma rodada que consolidou. Lido do log da run —
  // pool por PASSE, não por rodada (ver `consolidationGraceLeft`).
  const { ORACLE_CONSOLIDATION_GRACE } = await import("./specOracles.js");
  const graceLeft = consolidationGraceLeft(run, ORACLE_CONSOLIDATION_GRACE);
  const { veto: oracleVeto, toleratedOverflow, consolidationGrace } = await consolidationVeto(
    db, run.projectId, target, file.content, revised, passBudget, dispatched,
    { pool: ORACLE_CONSOLIDATION_GRACE, left: graceLeft },
  );
  if (oracleVeto) {
    // GAP-29: o TAMANHO da tentativa recusada vai para o log — é o único jeito de a próxima
    // tentativa deste arquivo não ser uma repetição paga da mesma resposta reprovada.
    // GAP-31: e o MOTIVO vai junto, porque este veto recusa por duas razões diferentes e mandar o
    // agente encolher quando o problema era não citar o oráculo é pior que não dizer nada.
    return skipFileAndContinue(db, run, target, oracleVeto, {
      failure: false, fromStatus: "applying",
      patch: {
        rejectedDelta: revised.length - file.content.length,
        rejectedBudget: passBudget,
        rejectedReason: oracleVeto,
      },
    });
  }
  if (removedNote) {
    console.log(
      `[SpecAutonomy] run=${run.id.slice(0, 8)} ${target}: ${integrity.removedSections!.length} seção(ões) removida(s) ` +
      `por ${job?.editsApplied ?? 0} edição(ões) ancorada(s) (${file.content.length}→${revised.length} chars)`,
    );
  }
  try {
    await writeSpecFile(db, run.projectId, file.filePath, revised, {
      previous: file.content,
      reason: `autonomy:pass-${run.passes + 1}:file-${run.round}`,
      createdBy: run.ownerUserId,
    });
  } catch (e) {
    // G2: snapshot é pré-condição da escrita autônoma — e a falha é do BANCO, não do arquivo.
    await patchLastRound(db, run, { applied: false, filePath: target, note: `escrita abortada: ${msg(e)}` });
    await finishRun(db, run, "stalled",
      `NÃO apliquei a revisão de \`${target}\`: ${msg(e)}. A spec no disco está INTACTA e a revisão continua no chat.`);
    return true;
  }

  // 🔴 GAP-71 — a MEDIÇÃO só é possível AQUI: este é o único ponto do laço que tem os dois textos (o
  // de antes, `file.content`, e o que acabou de ser escrito) e as âncoras que o despacho pediu. Roda
  // DEPOIS da escrita porque medir antes afirmaria algo sobre uma rodada que ainda podia ser vetada.
  // Só as âncoras do DESPACHO DESTA rodada (`lastRound.round === run.round`): as de uma rodada
  // anterior falariam de um pedido que não é este.
  const touch = lastRound?.round === run.round
    ? untouchedAnchors(file.content, revised, lastRound.gapAnchors ?? [])
    : { measured: [], untouched: [], unlocatable: [], stubParents: [] };
  if (touch.untouched.length > 0) {
    console.info(
      `[SpecAutonomy] run=${run.id.slice(0, 8)} ${target}: ${touch.untouched.length}/${touch.measured.length} ` +
      `âncora(s) INTOCADA(S) apesar de ${job?.editsApplied ?? 0} edição(ões) — ${touch.untouched.slice(0, 6).join(", ")}`,
    );
  }
  await patchLastRound(db, run, {
    // GAP-28: `deltaChars` é o que ESTA rodada gastou (+) ou devolveu (−) do orçamento do passe.
    // Só a rodada APLICADA conta — o que foi vetado não saiu do disco, logo não consumiu margem.
    applied: true, filePath: target, specChars: revised.length,
    deltaChars: revised.length - file.content.length,
    // GAP-71: as âncoras cujo trecho sobreviveu VERBATIM. Lista vazia não polui o log, mas a
    // diferença entre "vazia" e "ausente" importa: ausente = não medido (rodada de criação, sem
    // âncoras no despacho), vazia = medido e o agente encostou em todos os trechos.
    ...(touch.measured.length > 0 ? { anchorsUntouched: touch.untouched } : {}),
    // GAP-79: âncora de cabeçalho-PAI cujo corpo próprio é toco — o texto que ela endereça mora nas
    // subseções. Declarado para a decisão do juiz (GAP-77) ser auditável: era ESTE fato que faltava
    // quando o laço exigia "edição no próprio trecho" de um preâmbulo sem nada a corrigir.
    ...(touch.stubParents.length > 0 ? { anchorsStubParent: touch.stubParents } : {}),
    // GAP-64: o excesso tolerado é DECLARADO — foi decisão do laço pagar, e a próxima rodada nasce com
    // a margem já menor. Zero não polui o log.
    ...(toleratedOverflow > 0 ? { toleratedOverflow } : {}),
    // GAP-70: a parcela EMPRESTADA do pool do passe, separada — é ela que esgota a graça.
    ...(consolidationGrace > 0 ? { consolidationGrace } : {}),
    note: `\`${target}\` salvo no disco (${file.content.length} → ${revised.length} chars).${removedNote}`
      + (toleratedOverflow > 0
        ? ` A revisão passou ${toleratedOverflow} chars da margem de ${passBudget} e o laço PAGOU o excesso`
          + " (dentro da tolerância) em vez de descartar a rodada — a margem das rodadas seguintes já desconta isto."
        : "")
      + (consolidationGrace > 0
        ? ` Deste excesso, ${consolidationGrace} chars foram EMPRESTADOS da graça de consolidação (GAP-70):`
          + " a rodada removeu redeclaração e passou a citar o oráculo, então o laço preferiu escrever a"
          + ` remoção a descartar a rodada inteira. Restam ${Math.max(0, graceLeft - consolidationGrace)} chars`
          + " de graça neste passe."
        : "")
      // GAP-71: o fato vai para o log em PROSA também, porque é ele que o humano lê no chat quando
      // pergunta por que a contagem de GAPs não cai.
      + (touch.untouched.length > 0
        ? ` ⚠️ ${touch.untouched.length} de ${touch.measured.length} trecho(s) apontado(s) ficaram`
          + ` IDÊNTICOS (${touch.untouched.slice(0, 4).join(", ")}) — a rodada seguinte vai exigir a`
          + " edição no próprio trecho."
        : "")
      // GAP-79: sem esta linha o humano lê "§1.3 intocada" e procura o defeito no preâmbulo do
      // cabeçalho, onde ele não está. A medida é sobre a subárvore; o endereço útil é a subseção.
      + (touch.stubParents.length > 0
        ? ` ℹ️ ${touch.stubParents.slice(0, 4).join(", ")}: o corpo próprio do cabeçalho é preâmbulo — o`
          + " texto endereçado mora nas SUBSEÇÕES, e é a subárvore inteira que foi medida (GAP-79)."
        : ""),
  });
  const claim = await db.query(
    `UPDATE spec_autonomy_runs
        SET status = 'pending', chat_job_id = NULL, current_file = NULL, file_failures = 0,
            files_done = files_done || $2::jsonb, updated_at = now()
      WHERE id = $1 AND status = 'applying'`,
    [run.id, JSON.stringify([target])],
  );
  if ((claim.rowCount ?? 0) === 0) return false;
  await postChatNote(db, run,
    `🤖 **Arquivo ${run.round} do passe ${run.passes + 1}** — \`${target}\`: revisão do CTO aplicada e salva (${file.content.length} → ${revised.length} chars).${removedNote} Seguindo para o próximo arquivo da fila.`);
  return true;
}

/** cto_running → o job é durável: só LEMOS o estado (quem finaliza é o poll/worker do chat). */
async function checkCto(db: Db, run: AutonomyRun): Promise<boolean> {
  if (!run.chatJobId) {
    await finishRun(db, run, "failed", "Rodada sem job do CTO associado (estado inconsistente).");
    return true;
  }
  const perFile = run.mode === "per_file" && !!run.currentFile;
  const job = await getSpecChatJob(db, run.chatJobId);
  if (!job) {
    // A escrita do job pode ter falhado (createSpecChatJob é best-effort). Sem linha não há o que
    // coletar: dá a rodada por perdida em vez de esperar para sempre.
    if (perFile) {
      return skipFileAndContinue(db, run, run.currentFile!, "o job do CTO deste arquivo não existe no banco",
        { failure: true, fromStatus: "cto_running" });
    }
    await finishRun(db, run, "failed", "O job do CTO desta rodada não existe mais no banco — laço encerrado sem alterar a spec.");
    return true;
  }
  if (job.status === "pending" || job.status === "running") return false; // segue em voo

  if (job.status === "done" && job.specMarkdown) {
    const claim = await db.query(
      "UPDATE spec_autonomy_runs SET status = 'applying', updated_at = now() WHERE id = $1 AND status = 'cto_running'",
      [run.id],
    );
    if ((claim.rowCount ?? 0) === 0) return false;
    // Aplica já neste tick (não faz sentido esperar 20 s com a revisão pronta na mão).
    const fresh = (await getAutonomyRun(db, run.id))!;
    await applyStep(db, fresh);
    return true;
  }

  // error | interrupted | lost — inclui o gate H4 (BLOCKED/FAIL do envelope do CTO).
  // Por arquivo: a falha é DAQUELE arquivo (429, arquivo difícil, BLOCKED do envelope) — o laço
  // segue na fila e só para com `MAX_FILE_FAILURES` seguidas.
  if (perFile) {
    return skipFileAndContinue(db, run, run.currentFile!, `CTO não entregou revisão: ${job.error ?? job.status}`,
      { failure: true, fromStatus: "cto_running" });
  }
  const streak = run.noProgressStreak + 1;
  await patchLastRound(db, run, { applied: false, note: `CTO não entregou revisão: ${job.error ?? job.status}` });
  if (streak >= MAX_NO_PROGRESS || run.round >= run.maxRounds) {
    await finishRun(db, { ...run, noProgressStreak: streak }, "stalled",
      `O CTO não conseguiu entregar a revisão (${job.error ?? job.status}). Laço encerrado sem alterar a spec.`);
    return true;
  }
  await db.query(
    "UPDATE spec_autonomy_runs SET status = 'pending', no_progress_streak = $2, last_error = $3, chat_job_id = NULL, updated_at = now() WHERE id = $1 AND status = 'cto_running'",
    [run.id, streak, (job.error ?? job.status).slice(0, 500)],
  );
  return true;
}

/** applying → guardas de segurança, escrita no disco e disparo da validação. */
async function applyAndValidate(db: Db, run: AutonomyRun): Promise<boolean> {
  if (!run.chatJobId) {
    await finishRun(db, run, "failed", "Rodada sem job do CTO associado (estado inconsistente).");
    return true;
  }
  const job = await getSpecChatJob(db, run.chatJobId);
  const revised = job?.specMarkdown ?? null;
  if (!revised) {
    await finishRun(db, run, "failed", "A revisão do CTO desapareceu antes de ser aplicada.");
    return true;
  }
  const spec = await readPrimarySpec(db, run.projectId);
  if (!spec) {
    await finishRun(db, run, "failed", "Spec sem arquivo legível no disco na hora de aplicar — nada foi escrito.");
    return true;
  }
  const editable = await specEditable(db, run.projectId);
  if (!editable.ok) {
    await finishRun(db, run, "stalled", `A spec deixou de ser editável antes de aplicar (projeto em '${editable.status}') — nada foi escrito.`);
    return true;
  }

  const revisedSha = sha256Hex(Buffer.from(revised, "utf-8"));
  let applied = false;
  let note = "";
  if (spec.sha === revisedSha) {
    // Já está no disco: ou a revisão é idêntica à base, ou um tick anterior aplicou e morreu
    // antes do UPDATE. Nos dois casos: não escreve, mas segue para a validação (idempotente).
    note = "Revisão idêntica ao conteúdo em disco — nada a escrever.";
  } else if (spec.sha !== run.baseSpecSha) {
    // 🔴 GUARDA DE EDIÇÃO HUMANA: a spec mudou desde o envio ao CTO. Aplicar apagaria a edição
    // do humano em silêncio — exatamente o que o card "Revisão recuperada" existe para evitar.
    await patchLastRound(db, run, { applied: false, note: "spec editada por fora durante a rodada" });
    await finishRun(db, run, "stalled",
      "A spec foi editada por fora durante a rodada — NÃO sobrescrevi sua edição. A revisão do CTO continua disponível no chat para você aplicar manualmente.");
    return true;
  } else if (revised.length < spec.content.length * MIN_SHRINK_RATIO) {
    // 🔴 GUARDA DE ENCOLHIMENTO: o CTO normalizador já descartou conteúdo válido em prod.
    await patchLastRound(db, run, { applied: false, note: `revisão encolheu (${revised.length} < ${Math.round(spec.content.length * MIN_SHRINK_RATIO)} chars)` });
    await finishRun(db, run, "stalled",
      `A revisão do CTO veio com ${revised.length} caracteres contra ${spec.content.length} da spec atual (perda > ${Math.round((1 - MIN_SHRINK_RATIO) * 100)}%). NÃO apliquei — a revisão está no chat para você conferir.`);
    return true;
  } else {
    // 🔴 T2 — GUARDA DE INTEGRIDADE: revisão truncada no teto de saída ou com seções a menos.
    // Sem ela, o laço APLICAVA uma spec cortada e a rodada seguinte partia do documento mutilado
    // (foi assim que 7 das 14 seções do NVX LastMile desapareceram em prod, 2026-09-05).
    // GAP-12: o modo `whole` também pode receber edições ancoradas (o CTO da spec inteira roda com
    // `SPEC_CTO_EDIT_FORMAT=edits`). O fato vem do job, não da flag — a flag diz o que foi PEDIDO.
    const integrity = assessRevisionIntegrity(spec.content, revised, job?.truncated === true,
      { anchoredEdits: (job?.editsApplied ?? 0) > 0 });
    if (!integrity.ok) {
      await patchLastRound(db, run, { applied: false, note: `revisão recusada (${integrity.reason}): ${integrity.detail}` });
      await finishRun(db, run, "stalled",
        `NÃO apliquei a revisão desta rodada: ${integrity.detail}. A spec no disco está INTACTA e a revisão parcial continua no chat para você aproveitar o que servir. ` +
        `Caminho recomendado para specs grandes: revisar POR ARQUIVO (spec dividida) ou tratar os GAPs em blocos menores — a resposta inteira não cabe no teto de saída do modelo.`);
      return true;
    }
    try {
      await writeSpecFile(db, run.projectId, spec.filePath, revised, {
        previous: spec.content,
        reason: `autonomy:round-${run.round}`,
        createdBy: run.ownerUserId,
      });
    } catch (e) {
      // G2: snapshot é pré-condição da escrita autônoma. Falhou → não escreve, encerra com motivo.
      await patchLastRound(db, run, { applied: false, note: `escrita abortada: ${msg(e)}` });
      await finishRun(db, run, "stalled",
        `NÃO apliquei a revisão: ${msg(e)}. A spec no disco está INTACTA e a revisão continua no chat.`);
      return true;
    }
    applied = true;
    note = `Spec aplicada no disco (${spec.content.length} → ${revised.length} chars).` +
      (integrity.removedSections?.length
        ? ` ${integrity.removedSections.length} seção(ões) REMOVIDA(S) por edição ancorada: ` +
          `${integrity.removedSections.slice(0, 6).map((h) => `“${h}”`).join(", ")}` +
          `${integrity.removedSections.length > 6 ? " …" : ""}.`
        : "");
  }

  await patchLastRound(db, run, { applied, specChars: revised.length, note });
  const claim = await db.query(
    "UPDATE spec_autonomy_runs SET status = 'validating', validation_run_id = NULL, updated_at = now() WHERE id = $1 AND status = 'applying'",
    [run.id],
  );
  if ((claim.rowCount ?? 0) === 0) return false;
  const fresh = (await getAutonomyRun(db, run.id))!;
  await kickValidation(db, fresh);
  return true;
}

/** Dispara a validação; rate-limit NÃO derruba o laço (GAP-A) — espera o tick seguinte. */
async function kickValidation(db: Db, run: AutonomyRun): Promise<void> {
  const res = await startValidation(db as Pool, {
    projectId: run.projectId, tenantId: run.tenantId, requestedBy: run.ownerUserId,
  });
  // 🔴 GAP-44: o one-flight de validação é por PROJETO. Se já havia uma validação em voo quando o
  // passe terminou, `startValidation` devolve ELA — e ela está medindo o conteúdo de ANTES do passe.
  // Adotá-la é gravar como "a medição deste passe" uma leitura que não viu nada do que o passe
  // escreveu: o resultado sai como "sem progresso" mesmo que todo o trabalho tenha dado certo.
  // Medido em prod: passe 0 da run `fb57dec7` reescreveu 7 arquivos (06:02→06:13) e herdou a validação
  // `a17bf391` de 05:58, que terminou em `error` ⇒ `no_progress_streak = 1` sobre uma medição que
  // nunca existiu. Espero o tick seguinte, como no rate-limit: a run em voo termina (ou cai no
  // deadline) e aí a próxima validação nasce do conteúdo certo. O teto de 4h30 do laço é o freio.
  if (res.ok && res.staleReuse) {
    const why = "Havia uma validação em voo iniciada antes deste passe (one-flight por projeto): ela não mede o que o passe escreveu. Aguardando ela terminar para validar o conteúdo atual (GAP-44).";
    await db.query("UPDATE spec_autonomy_runs SET last_error = $2 WHERE id = $1", [run.id, why]);
    console.info(`[SpecAutonomy] run=${run.id} validação ${res.runId.slice(0, 8)} em voo é de conteúdo ANTERIOR ao passe — não adotada; revalida no próximo tick (GAP-44).`);
    return;
  }
  if (res.ok) {
    await db.query(
      "UPDATE spec_autonomy_runs SET validation_run_id = $2, updated_at = now() WHERE id = $1 AND status = 'validating'",
      [run.id, res.runId],
    );
    await patchLastRound(db, run, { validationRunId: res.runId });
    return;
  }
  if (res.code === "RATE_LIMITED") {
    // 4 validações/h por spec. Não é falha do laço: registra e revalida no próximo tick.
    await db.query("UPDATE spec_autonomy_runs SET last_error = $2, updated_at = now() WHERE id = $1", [run.id, res.message]);
    console.info(`[SpecAutonomy] run=${run.id} validação em espera (rate-limit) — revalida no próximo tick.`);
    return;
  }
  await finishRun(db, run, "failed", `Validação não pôde ser iniciada (${res.code}): ${res.message}`);
}

// ── GAP-18/GAP-19: cobertura do estágio adversarial ───────────────────────────

/** O que a run de validação MEDIU (migração 101). Ausente/legado = `null` = cobertura desconhecida. */
interface StageBCoverage { full: string[]; outlineOnly: string[]; oversized: string[] }

export function readStageBCoverage(raw: unknown): StageBCoverage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.full) && !Array.isArray(o.outlineOnly)) return null;
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { full: arr(o.full), outlineOnly: arr(o.outlineOnly), oversized: arr(o.oversized) };
}

/** Cobertura da validação ANTERIOR do mesmo projeto — para saber se a superfície medida MUDOU. */
async function previousCoverage(db: Db, projectId: string, exceptRunId: string): Promise<StageBCoverage | null> {
  const row = (await db.query(
    `SELECT stage_b_coverage FROM spec_validation_runs
      WHERE project_id = $1 AND id <> $2 AND stage_b_coverage IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [projectId, exceptRunId],
  ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }))).rows[0] as { stage_b_coverage?: unknown } | undefined;
  return readStageBCoverage(row?.stage_b_coverage);
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/** validating → lê a run de validação e decide: sucesso, nova rodada, esgotado ou travado. */
async function checkValidation(db: Db, run: AutonomyRun): Promise<boolean> {
  if (!run.validationRunId) {
    await kickValidation(db, run); // retry do rate-limit / da falha transitória
    return false;
  }
  const vr = (await db.query(
    "SELECT status, stage_b_ran, stage_b_coverage FROM spec_validation_runs WHERE id = $1", [run.validationRunId],
  )).rows[0] as { status?: string; stage_b_ran?: boolean | null; stage_b_coverage?: unknown } | undefined;
  if (!vr) {
    await finishRun(db, run, "failed", "A run de validação desta rodada desapareceu.");
    return true;
  }
  const st = String(vr.status);
  if (st === "pending" || st === "running") return false;

  // PR-5: no modo por arquivo o teto do Jean é medido em PASSES (uma validação por passe); `round`
  // conta arquivos e tem teto próprio (`AUTONOMY_MAX_FILE_ROUNDS`).
  const perFile = run.mode === "per_file";
  const atCap = perFile ? run.passes >= run.maxRounds : run.round >= run.maxRounds;

  // superseded/error: não mediu GAP nenhum. Conta como rodada sem progresso e tenta de novo.
  if (st !== "passed" && st !== "failed") {
    // 🔴 GAP-11 (migração 100): `error` por teto de ESPERA não significa que o resultado morreu — o
    // job adversarial pode seguir vivo no agents, e o coletor server-side ainda vai buscá-lo (medido
    // em prod: run 16e467cf esperou 20m40s e a leitura paga foi descartada). Contar rodada sem
    // progresso aqui joga fora o trabalho E aproxima o laço do `stalled` por um relógio, não por
    // falta de convergência. Espero: o coletor encerra o assunto (resultado recuperado, job perdido
    // ou teto duro) e no tick seguinte esta run cai no caminho normal.
    const pend = await db.query(
      `SELECT 1 FROM spec_validation_runs
        WHERE id = $1 AND agents_job_id IS NOT NULL AND stage_b_collected_at IS NULL`,
      [run.validationRunId],
    ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
    if (pend.rows[0]) {
      console.log(`[SpecAutonomy] run=${run.id} validação em '${st}' com resultado do estágio B PENDENTE de coleta — aguardando em vez de contar rodada sem progresso (GAP-11).`);
      return false;
    }
    // 🔴 GAP-43: um passe NÃO MEDIDO não é um passe SEM PROGRESSO — não se sabe se progrediu, e
    // `no_progress_streak` existe para matar laço que não converge, não para punir medição perdida.
    // Medido em prod: o passe 0 da run `fb57dec7` reescreveu 7 arquivos com sucesso e levou streak = 1
    // porque a validação que herdou (GAP-44) morreu no deadline. A tolerância é de UMA vez por run: na
    // segunda o laço para e diz que parou por FALTA DE MEDIÇÃO — atribuir isto a "não convergiu" seria
    // a mesma mentira que o resto desta onda existe para matar.
    const forgiven = unmeasuredPassesSoFar(run);
    // GAP-30: a nota da rodada de arquivo sobrevive à nota do passe.
    await patchLastRound(db, run, { note: `validação terminou em '${st}' (sem medição de GAPs)`, unmeasured: true }, { keepNote: true });
    if (forgiven >= 1) {
      await finishRun(db, run, "stalled",
        `Duas validações desta run terminaram sem medir os GAPs (a última em '${st}'). Não é falta de convergência: é falta de medição — o trabalho dos passes pode estar correto e nunca ter sido conferido. Rode Validar manualmente para ver o estado atual.`);
      return true;
    }
    if (atCap) {
      await finishRun(db, run, "exhausted",
        `A validação do último passe terminou em '${st}' e não foi possível medir os GAPs, e o teto de passes foi atingido. Rode Validar manualmente para ver o estado atual.`);
      return true;
    }
    await postChatNote(db, run,
      `🤖 ${perFile ? `**Passe ${run.passes}/${run.maxRounds}**` : `**Rodada ${run.round}/${run.maxRounds}**`} — a validação terminou em **${st}** e não mediu GAP nenhum. ` +
      `Não conto isto como passe sem progresso (não sei se progrediu): revalido. Se acontecer de novo, encerro dizendo que faltou medição.`);
    await db.query(
      "UPDATE spec_autonomy_runs SET status = 'pending', updated_at = now() WHERE id = $1 AND status = 'validating'",
      [run.id],
    );
    return true;
  }

  // 🔴 GAP-13 (migração 099): validação PARCIAL — o Estágio A achou blocker estrutural e o
  // adversarial não rodou. A contagem existe, mas é de outra SUPERFÍCIE: em prod (run c3757985) isto
  // virou "21 → 1 GAP" registrado como progresso e, no tick seguinte, "1 → 21" como regressão. Nenhum
  // dos dois aconteceu. Aqui o laço mantém a última contagem COMPARÁVEL, não conta progresso e diz o
  // motivo — e nunca declara `succeeded` sobre uma medição que não olhou a spec inteira.
  if (vr.stage_b_ran === false) {
    const partial = await currentGaps(db, run.projectId);
    const streakP = run.noProgressStreak + 1;
    const why = `Validação ${st} PARCIAL: o estágio adversarial não rodou (🔴 ${partial.blockers} blocker(s) estrutural(is) do estágio determinístico barram a spec antes dele). ` +
      `Os ${partial.important} GAP(s) desta leitura NÃO são comparáveis com os ${run.gapsCurrent ?? partial.important} da última validação completa — contagem mantida.`;
    await patchLastRound(db, run, { validationRunId: run.validationRunId, note: why }, { keepNote: true });
    await postChatNote(db, run,
      `🤖 ${perFile ? `**Passe ${run.passes}/${run.maxRounds}**` : `**Rodada ${run.round}/${run.maxRounds}**`} — validação **${st}**, porém **parcial**: ` +
      `${partial.blockers} bloqueador(es) estrutural(is) impediram o estágio adversarial, então a spec não foi julgada por inteiro. ` +
      `Não conto isto como progresso: sigo tratando o(s) bloqueador(es) e revalido.`);
    if (streakP >= MAX_NO_PROGRESS || atCap) {
      await finishRun(db, { ...run, noProgressStreak: streakP }, "stalled",
        `${why} Resolva o(s) bloqueador(es) estrutural(is) (aba GAPs) para que a validação volte a julgar a spec completa.`);
      return true;
    }
    await db.query(
      "UPDATE spec_autonomy_runs SET status = 'pending', no_progress_streak = $2, file_failures = 0, updated_at = now() WHERE id = $1 AND status = 'validating'",
      [run.id, streakP],
    );
    return true;
  }

  const gaps = await currentGaps(db, run.projectId);
  const before = run.gapsCurrent ?? gaps.important;
  // 🔴 GAP-41: o total pode ficar PARADO com o laço fechando e abrindo a mesma quantidade — medido em
  // prod (NVX LastMile): 10–16 GAPs saindo e 11–25 entrando por passe, nos MESMOS arquivos. A pergunta
  // do Jean ("a contagem tem de CAIR") só é respondível pela diferença finding-a-finding, então ela
  // entra no log e no chat. Falha aqui não derruba o passe: sem diff, o laço volta a decidir só pelo
  // agregado, como antes.
  // GAP-46: o diff também precisa saber quais arquivos AINDA existem — sem isso um GAP de arquivo
  // removido não aparece como fechado nem no agregado nem no diff, e o laço fica sem nenhuma via para
  // registrar progresso por remoção (justamente o mecanismo do GAP-12).
  const rawDelta = await gapDeltaSinceLastRun(db, run.projectId, await specFilePaths(db, run.projectId).catch(() => null))
    .catch(() => null);
  // 🔴 GAP-67: o `gapDelta` casa por fingerprint EXATO (`file|source|anchor`), então a renumeração de
  // seção feita pela edição DO PRÓPRIO CTO rebatiza o defeito não-corrigido e ele conta como 1 fechado
  // + 1 novo. MEDIDO em prod (run `b1bc1195`, passe 1): `11 fechado / 12 novo` com **8+ dos 11**
  // idênticos a um "novo" em outra âncora (`§6.1`→`§6`, `§4.2 Passo 3`→`PRIV-JANELA-01`). Quem separa
  // reformulação de resolução é um agente (`reconcileGapDelta`) — string matching já falhou: Jaccard de
  // título sobre os pares REAIS deu ZERO fantasma, porque o estilo de título do juiz muda entre runs.
  const cont = rawDelta ? await reconcileGapDelta(rawDelta.closed, rawDelta.opened).catch(() => null) : null;
  // `openedOnNewSurface` é do diff cru e não pode passar da parcela de novos que sobrou.
  const delta = rawDelta
    ? {
        closed: cont?.reconciled ? cont.closed : rawDelta.closed,
        opened: cont?.reconciled ? cont.opened : rawDelta.opened,
        openedOnNewSurface: cont?.reconciled
          ? Math.min(rawDelta.openedOnNewSurface, cont.opened.length)
          : rawDelta.openedOnNewSurface,
      }
    : null;
  const persisted = cont?.reconciled ? cont.persisted.length : 0;
  // 🔴 GAP-68: a identidade dos reincidentes, com a linhagem carregada da rodada anterior. Sem isto o
  // fato do GAP-67 fica só no log e o agente recebe o defeito como novidade no próximo despacho.
  const persistedRefs = cont?.reconciled && cont.persisted.length > 0
    ? buildPersistentRefs(cont.persisted, lastPersistedGaps(run))
    : null;
  // ⚠️ Revisão adversarial da própria correção: aceitar `closed > 0` como progresso premiaria justamente
  // o comportamento medido no NVX (1 fecha, 25 entram) e o laço queimaria os 5 passes sem convergir —
  // matando a função do `no_progress_streak`, que é cortar gasto de LLM que não anda. Progresso é SALDO:
  // ou o agregado caiu, ou saíram mais GAPs do que entraram (o caminho que sobrevive à rotação de
  // cobertura, quando o agregado não é comparável).
  // GAP-67: e o saldo só vale se a diferença foi RECONCILIADA. Sem reconciliação, `closed > opened` é
  // gatilho que a deriva de âncora fabrica sozinha — zeraria o `no_progress_streak` de graça. Aí o
  // agregado volta a ser o único juiz de progresso, como antes do GAP-41.
  const cov = readStageBCoverage(vr.stage_b_coverage);
  const prevCov = cov ? await previousCoverage(db, run.projectId, run.validationRunId) : null;
  const surfaceChanged = !!cov && !!prevCov && !sameSet(cov.full, prevCov.full);
  // 🔴 GAP-76: o NÍVEL medido só no subconjunto que as duas validações julgaram por inteiro.
  const comp = await comparableTallySinceLastRun(db, run.projectId, run.validationRunId).catch(() => null);
  // 🔴 GAP-76 — com a superfície MUDADA, `gaps.important < before` é rotação de cobertura, não correção.
  // Medido em prod: 23 → 20 com as MESMAS 20 âncoras no subconjunto comparável. Deixar esse agregado
  // valer como progresso zerava o `no_progress_streak` de graça — o laço seguia pagando LLM por uma
  // melhora que nunca houve, exatamente o que o streak existe para cortar. Quando a superfície muda,
  // quem responde "melhorou?" é o NÍVEL comparável ou o saldo reconciliado do GAP-67.
  const aggregateFell = gaps.important < before && !surfaceChanged;
  const comparableFell = !!comp && comp.files.length > 0 && comp.now < comp.before;
  const progressed = aggregateFell || comparableFell
    || (!!delta && !!cont?.reconciled && delta.closed.length > delta.opened.length);
  // 🔴 GAP-18: com rotação de cobertura, duas validações seguidas podem julgar CONJUNTOS DIFERENTES de
  // arquivos. Aí a contagem pode SUBIR porque um arquivo novo entrou no julgamento — não porque a spec
  // piorou. Mesma lei do GAP-13: superfície diferente = contagem não comparável. Então o streak de
  // "sem progresso" não avança (ele existe para matar laço que não converge, não para punir cobertura
  // nova); o teto de rodadas continua sendo o freio. (`cov`/`surfaceChanged` são medidos acima, porque
  // o GAP-76 precisa deles ANTES para decidir se o agregado vale como progresso.)
  const streak = progressed ? 0 : surfaceChanged ? run.noProgressStreak : run.noProgressStreak + 1;
  // 🔴 A pendência de cobertura é ACUMULADA, nunca o `outlineOnly` de UMA run: a spec do NVX LastMile
  // tem 950.965 chars contra um teto de 400.000, então nenhuma validação isolada leva os 12 arquivos
  // por inteiro e `outlineOnly` nunca fica vazio. Quem fecha a conta é a UNIÃO das rodadas —
  // `project_spec_files.stage_b_full_sha` (migração 101). Medir pelo `outlineOnly` faria este laço
  // revalidar até o teto e terminar `exhausted` mesmo com a spec inteira já julgada.
  const cobertura = await unjudgedSpecFiles(db as never, run.projectId).catch(() => null);
  const covNote = cov && cov.outlineOnly.length > 0
    ? ` Cobertura desta validação: ${cov.full.length} de ${cov.full.length + cov.outlineOnly.length} arquivo(s) julgado(s) por INTEIRO (os demais entraram só como sumário).` +
      (cobertura ? ` Acumulado da spec: ${cobertura.judged}/${cobertura.total} arquivo(s) já julgado(s) neste conteúdo.` : "")
    : "";
  // GAP-41: a diferença finding-a-finding dita em voz alta. `openedOnNewSurface` separa a parcela de
  // DESCOBERTA (arquivo inédito) da de REGRESSÃO (arquivo já julgado antes) — medida em ZERO nos dados
  // de prod, o que refuta a hipótese de que a rotação de cobertura explicava a subida do total.
  // GAP-67: `persisted` é a parcela que o diff cru chamava de "fechado + novo" e que na verdade é o
  // MESMO defeito com âncora nova. Ela vai dita em voz alta, e a falta de reconciliação também — um
  // número não reconciliado não pode passar por medida de progresso.
  const contNote = !delta
    ? ""
    : cont?.reconciled
      ? (persisted > 0
        ? ` ${persisted} dele(s) era(m) o MESMO defeito rebatizado pela edição (seção renumerada/movida) — continua(m) ABERTO(s), não conta como fechado nem como novo.`
        : ` Reconciliação por agente não achou defeito rebatizado: os números acima são identidade real.`)
      : ` ⚠️ Números NÃO reconciliados (${cont?.reason ?? "reconciliador indisponível"}) — parte pode ser o mesmo defeito com âncora nova, então não os uso como prova de progresso.`;
  // 🔴 GAP-76: o nível comparável dito em voz alta, com a BASE declarada (quantos arquivos as duas
  // julgaram por inteiro). Sem a base, "20 → 20" seria mais um número sem procedência; com ela, é a
  // única leitura de nível que a rotação de cobertura não distorce.
  const compNote = !comp
    ? ""
    : comp.files.length === 0
      ? ` ⚠️ As duas validações não julgaram por INTEIRO nenhum arquivo em comum: NÃO existe nível comparável entre elas (só a diferença finding-a-finding vale).`
      : ` Nível COMPARÁVEL (${comp.files.length} arquivo(s) julgado(s) por inteiro nas duas): ${comp.before} → ${comp.now} GAP(s) importante(s)` +
        (comp.now > 0 && comp.same === comp.now && comp.same === comp.before
          ? ` — as MESMAS ${comp.same} âncoras, zero fechado.`
          : ` (${comp.same} âncora(s) idêntica(s) nas duas).`);
  const deltaNote = delta
    ? ` Diferença finding-a-finding: ${delta.closed.length} fechado(s), ${delta.opened.length} novo(s)` +
      (delta.openedOnNewSurface > 0
        ? ` (${delta.openedOnNewSurface} em arquivo julgado por INTEIRO pela 1ª vez — descoberta, não regressão).`
        : ` — todos em arquivo já julgado antes, ou seja REGRESSÃO/reformulação, não descoberta.`) +
      contNote
    : "";
  // GAP-30: `keepNote` — a nota da última rodada de ARQUIVO não é apagada pela nota do PASSE.
  // GAP-45: e os números do PASSE vão em campos próprios — `blockers`/`warnings` continuam sendo os do
  // ARQUIVO desta rodada (é o que o portal desenha ao lado do nome dele). `gapsAfter` já carrega o total.
  // 🔴 GAP-76: a seta `antes → agora` só é dita quando as duas contagens SÃO comparáveis. Com a
  // superfície mudada ela era uma trajetória inventada — e a nota antiga a imprimia primeiro, deixando
  // a ressalva no fim (foi ela que me fez quase reportar 23 → 20 como progresso).
  const aggNote = surfaceChanged
    ? `Validação ${st}: ${gaps.important} GAP(s) importante(s) (🔴 ${gaps.blockers} · 🟡 ${gaps.warnings} · ℹ️ ${gaps.info}) — ⚠️ NÃO comparável com os ${before} da validação anterior: a superfície medida MUDOU (rotação de cobertura).`
    : `Validação ${st}: ${before} → ${gaps.important} GAP(s) importante(s) (🔴 ${gaps.blockers} · 🟡 ${gaps.warnings} · ℹ️ ${gaps.info}).`;
  await patchLastRound(db, run, {
    gapsAfter: gaps.important, passBlockers: gaps.blockers, passWarnings: gaps.warnings,
    validationRunId: run.validationRunId,
    gapsClosed: delta?.closed.length ?? null, gapsOpened: delta?.opened.length ?? null,
    gapsPersisted: cont?.reconciled ? persisted : null,
    persistedGaps: persistedRefs,
    gapsComparableBefore: comp?.before ?? null, gapsComparableNow: comp?.now ?? null,
    gapsComparableSame: comp?.same ?? null, comparableFiles: comp?.files.length ?? null,
    note: `${aggNote}${covNote}${compNote}${deltaNote}`,
  }, { keepNote: true });
  const cycleLabel = perFile
    ? `**Passe ${run.passes}/${run.maxRounds} concluído** (${appliedInPass({ ...run, passes: run.passes - 1 })} arquivo(s) revisado(s))`
    : `**Rodada ${run.round}/${run.maxRounds} concluída**`;
  await postChatNote(db, run,
    `🤖 ${cycleLabel} — validação **${st}**: ` +
    (surfaceChanged
      ? `**${gaps.important}** GAP(s) importante(s) (🔴 ${gaps.blockers} · 🟡 ${gaps.warnings}; ℹ️ ${gaps.info} de baixo risco não sustentam nova rodada) — ⚠️ **não comparáveis** com os ${before} da validação anterior, que julgou outro conjunto de arquivos por inteiro.`
      : `GAPs importantes ${before} → **${gaps.important}** (🔴 ${gaps.blockers} · 🟡 ${gaps.warnings}; ℹ️ ${gaps.info} de baixo risco não sustentam nova rodada).`) +
    covNote + compNote +
    (delta ? ` **${delta.closed.length} GAP(s) fechado(s)** e ${delta.opened.length} novo(s) desde a validação anterior${delta.openedOnNewSurface > 0 ? `, ${delta.openedOnNewSurface} deles em arquivo julgado por inteiro pela primeira vez` : ""}.` : "") +
    // GAP-67: o chat é onde o Jean lê o resultado do passe — a parcela rebatizada tem de aparecer AQUI,
    // não só no detalhe da rodada, senão "11 fechados" segue passando por progresso.
    (persisted > 0 ? ` ⚠️ **${persisted} defeito(s) apenas REBATIZADO(s)** pela edição (seção renumerada/movida): continuam abertos e não entram em nenhuma das duas contagens.` : "") +
    (delta && cont && !cont.reconciled ? ` ⚠️ Estes dois números **não foram reconciliados** (${cont.reason ?? "reconciliador indisponível"}) — parte pode ser o mesmo defeito com âncora nova.` : ""));

  if (gaps.important === 0) {
    // 🔴 GAP-19: "zero GAPs" só é sucesso se o juiz LEU a spec inteira. Medido em prod 2026-09-06
    // (NVX LastMile, 12 arquivos/950.965 chars): o estágio adversarial julgava 2 arquivos por INTEIRO e
    // os outros 10 só pelo sumário de cabeçalhos — sempre os mesmos, porque a promoção a integral era
    // determinística por tamanho. Declarar `succeeded` ali seria dizer "spec sem GAP" sobre 2/12 da
    // spec. Com a rotação (GAP-18) a cobertura avança a cada validação: aqui o laço só REVALIDA até
    // todo arquivo ter sido julgado no conteúdo atual.
    // Pendência ACUMULADA (não a desta run). Cobertura não medível (`null`) → comportamento legado:
    // zero GAP importante encerra em sucesso, como antes da migração 101.
    const pendentes = cobertura?.unjudged ?? [];
    if (pendentes.length === 0) {
      await finishRun(db, run, "succeeded",
        `Nenhum GAP vermelho ou amarelo ATIVO restante${gaps.info ? ` (${gaps.info} item(ns) de baixo risco seguem em aberto, por desenho)` : ""}${cobertura ? ` — e o estágio adversarial julgou os ${cobertura.total} arquivo(s) da spec por INTEIRO` : ""}.`, { gaps });
      return true;
    }
    const grandes = pendentes.filter((p) => (cov?.oversized ?? []).includes(p));
    if (grandes.length === pendentes.length) {
      // Rotação nenhuma resolve: o arquivo não cabe integralmente nem sozinho. Quem resolve é a
      // divisão da spec (ação da Bancada) — e isso é decisão do humano, não do laço.
      await finishRun(db, run, "stalled",
        `Nenhum GAP importante restante NA PARTE JULGADA, mas ${grandes.length} arquivo(s) não cabem numa janela de validação nem sozinhos e por isso NUNCA foram julgados por inteiro: ${grandes.map((p) => `\`${p}\``).join(", ")}. Divida esse(s) arquivo(s) (ação "Dividir" da Bancada) e rode o modo autônomo de novo — só assim a spec passa a ser julgada completa.`, { gaps });
      return true;
    }
    if (atCap) {
      await finishRun(db, run, "exhausted",
        `Zero GAP importante na superfície medida, porém o estágio adversarial ainda não julgou por inteiro ${pendentes.length} arquivo(s) (${pendentes.slice(0, 6).map((p) => `\`${p}\``).join(", ")}${pendentes.length > 6 ? ", …" : ""}) e o limite de ${run.maxRounds} ${perFile ? "passe(s)" : "rodada(s)"} acabou. NÃO declaro a spec validada: rode o modo autônomo novamente para cobrir o resto.`, { gaps });
      return true;
    }
    await db.query(
      `UPDATE spec_autonomy_runs
          SET validation_run_id = NULL, gaps_current = $2, no_progress_streak = 0,
              ${perFile ? "passes = passes + 1," : "round = round + 1,"} updated_at = now()
        WHERE id = $1 AND status = 'validating'`,
      [run.id, gaps.important],
    );
    await postChatNote(db, run,
      `🤖 Zero GAP importante nos arquivos que o validador leu por inteiro — mas ${pendentes.length} de ${cobertura?.total ?? "?"} arquivo(s) da spec ainda não passaram por um juiz neste conteúdo. **Não declaro a spec validada com base em parte dela**: vou revalidar priorizando ${pendentes.slice(0, 4).map((p) => `\`${p}\``).join(", ")}${pendentes.length > 4 ? " e os demais" : ""}.`);
    console.info(`[SpecAutonomy] run=${run.id} 0 GAP na superfície medida, cobertura ACUMULADA incompleta (${pendentes.length} arquivo(s) nunca julgados por inteiro) — revalidando com rotação (GAP-19).`);
    return true;
  }
  if (atCap || streak >= MAX_NO_PROGRESS) {
    // 🔴 GAP-77 — antes de mandar o humano "tratar à mão", o juiz julga os REINCIDENTES. É o fim de
    // laço que o Jean descreveu: o defeito voltou depois de foco individual pago, então cabe decidir
    // se ele impede a entrega — em vez de o laço empatar para sempre num número que oscila (GAP-76).
    const v = await promotionVerdictFor(db, run, {
      coverage: vr.stage_b_coverage, unjudged: cobertura?.unjudged ?? [],
      // 🔴 GAP-82: qual dos dois fins de laço chegou aqui — é o fato que sustenta a prova por
      // esgotamento. `atCap` = teto de passes/rodadas; senão, streak de não-progresso.
      endReason: atCap ? "exhausted" : "stalled",
    });
    if (v) {
      await patchLastRound(db, run, {
        verdictCandidates: v.gate.candidates.length,
        verdictReleased: v.round?.released ?? 0,
        verdictImpeditive: v.report.impeditive,
        promotable: v.report.promotable,
        // 🔴 GAP-82 — a prova de trabalho gravada com os números, inclusive `gapsClosedTotal: 0`. Sem
        // isto o log mostraria um veredicto sem dizer por que o juiz teve autoridade para dá-lo.
        workProof: v.work.kind,
        verdictWork: v.work.detail,
        gapsClosedTotal: v.loop.gapsResolved,
        verdictFocusRounds: v.loop.focusRounds,
        // 🔴 F2 — gravado só quando o gate rodou. `null` diz "não rodou", que é diferente de zero.
        policyConstraints: v.policy?.constraints.length ?? null,
        policyJudged: v.policy?.tally.judged ?? null,
        policyJudgeable: v.policy?.tally.judgeable ?? null,
        policySatisfied: v.policy?.tally.satisfied ?? null,
        policyBlocking: v.policy?.tally.blocking ?? null,
        policyPending: v.policy?.tally.pending ?? null,
        policyNote: v.policy ? (await import("./specPolicyGate.js")).policyNote(v.policy.tally) : null,
        // As RECUSAS de elegibilidade vão no log: é a auditoria da guarda (c) do Jean — dá para
        // conferir, GAP por GAP, por que o juiz não pôde julgá-lo.
        verdictRejected: v.gate.rejected.slice(0, 12).map((r) => `${r.file} ${r.anchor}: ${r.why}`),
        note: verdictNote(v).trim(),
      }, { keepNote: true });
    }
    const verdicto = v ? verdictNote(v) : "";
    if (atCap) {
      await finishRun(db, run, "exhausted",
        `Limite de ${run.maxRounds} ${perFile ? "passe(s) de validação" : "rodada(s)"} atingido com ${gaps.important} GAP(s) importante(s) em aberto (🔴 ${gaps.blockers} · 🟡 ${gaps.warnings}).${verdicto} Trate na aba GAPs ou rode o modo autônomo de novo.`, { gaps });
      return true;
    }
    await finishRun(db, { ...run, noProgressStreak: streak }, "stalled",
      `Dois ${perFile ? "passes" : "rodadas"} seguidos sem derrubar GAP importante (${gaps.important} em aberto).${verdicto} Parei para não gastar mais LLM em um laço que não converge — trate os GAPs restantes à mão ou triagem o que for risco aceito.`, { gaps });
    return true;
  }
  await db.query(
    `UPDATE spec_autonomy_runs
        SET status = 'pending', gaps_current = $2, no_progress_streak = $3, file_failures = 0, updated_at = now()
      WHERE id = $1 AND status = 'validating'`,
    [run.id, gaps.important, streak],
  );
  return true;
}

/**
 * Reaper de BOOT: nada a "matar" — o laço é reconstruível do banco e o tick o retoma. Só corrige
 * o caso irrecuperável: `cto_running` cuja linha de job nunca existiu (a api caiu entre o claim e
 * o `createSpecChatJob`), que ficaria girando no `checkCto` para sempre.
 */
export async function reapAutonomyRuns(db: Db): Promise<number> {
  try {
    const r = await db.query(
      `UPDATE spec_autonomy_runs a
          SET status = 'failed', last_error = $1, finished_at = now(), updated_at = now()
        WHERE a.status = 'cto_running'
          AND NOT EXISTS (SELECT 1 FROM spec_chat_jobs j WHERE j.id = a.chat_job_id)`,
      ["A rodada foi interrompida antes de o job do CTO ser registrado — reinicie o modo autônomo."],
    );
    const n = r.rowCount ?? 0;
    if (n) console.info(`[SpecAutonomy] reaper de boot: ${n} laço(s) sem job do CTO encerrado(s).`);
    return n;
  } catch (e) {
    console.warn(`[SpecAutonomy] reapAutonomyRuns falhou: ${msg(e)}`);
    return 0;
  }
}
