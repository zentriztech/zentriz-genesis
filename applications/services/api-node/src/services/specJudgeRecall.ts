/**
 * specJudgeRecall.ts — 🔴 F4: o RECALL do juiz, medido por INJEÇÃO DE DEFEITO.
 *
 * ## A metade que faltava da medição
 *
 * O falso positivo do juiz já foi MEDIDO em prod (2026-09-07): um revisor de outra família auditou 12
 * findings da NVX LastMile e não achou **nenhum** inventado (`ausente = 0`). O que nunca medimos é o
 * outro lado: **de todos os defeitos realmente presentes, quantos o juiz encontra?** `arXiv:2609.03230`
 * mede a mediana de **47%** para juiz LLM em defeito de requisito. Se o nosso recall for 47%, "0 GAPs
 * ATIVOS" quer dizer "0 GAPs na metade que eu vejo" — e o laço autônomo estaria fechando por cegueira,
 * não por qualidade. Sem este número, o veredicto de promovibilidade (migr. 105) não é interpretável.
 *
 * ## Por que injeção, e não "spec com defeitos conhecidos"
 *
 * Um gold set escrito à mão mede o juiz contra a NOSSA imaginação. Injeção parte do texto **verbatim**
 * de uma spec real: o defeito nasce dentro do documento que o juiz já lê, na redação que ele já viu.
 * A mutação vive **só em memória** — nenhum arquivo persistido é alterado, nunca.
 *
 * ## O juiz medido é O JUIZ, não uma imitação dele
 *
 * O estágio B recebe a spec por `spec_text` (`/invoke/spec_validator/async`). Este módulo manda o texto
 * MUTADO pelo mesmo endpoint, com o mesmo prompt e o mesmo modelo do tenant. Se medíssemos um juiz
 * montado aqui, mediríamos uma coisa acreditando medir outra — o defeito mais caro desta família.
 *
 * ## Os oito achados da revisão adversarial cross-family (Nova Pro + Mistral Large 3), fechados AQUI
 *
 *  * **GAP-90 (viés de ancoragem)** — injetar só em seção nomeada infla o recall: o juiz olha títulos.
 *    ⇒ `position` (`secao_nomeada` | `corpo_sem_titulo`) é campo obrigatório e o recall é ESTRATIFICADO
 *    por ela. Gold set sem `corpo_sem_titulo` é limitação DECLARADA na nota.
 *  * **GAP-91 (sobreajuste ao vocabulário)** — medir só as 13 categorias da triagem mede o que já
 *    sabemos procurar. ⇒ `inVocabulary` é campo, e a nota separa recall dentro/fora do vocabulário.
 *  * **GAP-92 (defeito distribuído)** — "incoerência interna" injetada numa só âncora é fácil: não
 *    exige correlacionar arquivos. ⇒ `scope` (`local` | `distribuido`), e `distribuido` obriga um
 *    SEGUNDO trecho em OUTRO arquivo; recall separado por escopo.
 *  * **GAP-93 (o casador também erra)** — quem decide "este finding é aquele defeito" é um agente, e o
 *    erro dele entra direto no recall. ⇒ o casador é obrigatoriamente de OUTRA família que o juiz
 *    (mesma família = limitação declarada), a citação dele é conferida VERBATIM contra os findings, e
 *    uma AMOSTRA é recasada por um terceiro modelo para medir a discordância entre casadores.
 *  * **GAP-94 (dificuldade)** — gold set só com defeito óbvio produz recall alto e inútil.
 *    ⇒ `difficulty` (`obvia` | `sutil`) declarada pelo injetor, com recall por faixa.
 *  * **GAP-95 (viés de seleção)** — arquivo escolhido a dedo pode ser o mais fácil. ⇒ a versão do gold
 *    set (`goldSetVersion`) inclui a lista de arquivos e os tamanhos: a amostra fica auditável, e
 *    comparar recall entre versões diferentes é comparar medições diferentes.
 *  * **GAP-96 (classe ambígua)** — injetor e casador lendo definições diferentes de "classe" produzem
 *    discordância que parece recall. ⇒ o vocabulário vai VERBATIM da MESMA constante para os dois prompts.
 *  * **GAP-97 (cobertura ≠ recall)** — se o arquivo mutado nem chegou ao juiz (recorte/orçamento), o
 *    defeito não foi "perdido pelo juiz". ⇒ ele sai do DENOMINADOR do recall e entra num número próprio.
 *
 * ## Um achado dos revisores REFUTADO pela nossa própria medição (e por isso declarado)
 *
 * Os dois modelos pediram casamento ESTRITO: âncora **E** classe iguais. Isso está errado aqui, e o
 * dado é nosso: o **GAP-49** mediu em prod que **32 dos 152 pares (arquivo, âncora) apareceram com 2 ou
 * 3 categorias diferentes** para o MESMO defeito — a `category` é interpretação livre do juiz entre 13
 * valores, e por isso já foi tirada da identidade do finding. Exigir classe exata DEPRIMIRIA o recall
 * medido por um defeito de vocabulário, não por cegueira do juiz. ⇒ o casamento é por âncora + sentido,
 * e a concordância de classe é REGISTRADA (`classAgreed`) para estratificar, nunca para casar.
 *
 * ## Direção do erro residual: para BAIXO
 *
 * Todo caso duvidoso (citação do casador que não confere, `parcial`, casador ausente) fica FORA do
 * numerador. Então o número que sai é um **piso** do recall, e o teto é publicado junto: recall
 * verdadeiro vive na banda `[min, max]`. Recall inflado é o número perigoso — é ele que autoriza
 * confiar num juiz cego. Um piso pessimista custa rodada extra; um teto otimista custa a spec.
 *
 * ## O que a PRIMEIRA medição em prod descobriu sobre si mesma (2026-09-08)
 *
 * O número saiu — **recall entre 14% e 29%** — e a leitura da prova abriu três defeitos NA MEDIÇÃO, todos
 * da mesma linhagem: declarar a intenção no lugar do fato. **Aquele número está MORTO: era auto-revisão**
 * (GAP-98). Depois do fix, a segunda prova mediu **43% a 57%** — os 14% eram artefato do instrumento, não
 * cegueira do juiz. Fica registrado porque é a lição: número publicado sobre instrumento não conferido
 * mede o instrumento.
 *
 *  * **GAP-98 (grave)** — `callPolicyAgent` montava `model_id` ANTES de espalhar `llm`, então o modelo do
 *    tenant sobrescrevia o explícito: o casador pedido em `amazon.nova-pro-v1:0` rodou em
 *    `us.anthropic.claude-opus-5`, **o modelo do próprio juiz**. A garantia cross-family — a única coisa
 *    que esta frente inteira depende de ter — foi negada pelos bytes e afirmada pelo relatório, porque
 *    `sameFamily` era calculado sobre o PEDIDO. ⇒ pedido explícito vence, e a família sai do
 *    `model_used`. É o GAP-88 outra vez, num lugar novo.
 *  * **GAP-99 (médio)** — a checagem de faixa era de um lado só. Os 7 defeitos caíram todos em
 *    `corpo_sem_titulo` e NADA foi declarado, porque só existia a frase para o caso inverso. ⇒ faixa com
 *    um lado só é limitação nas DUAS direções; muda para que lado o número engana, não se engana.
 *  * **GAP-100 (médio)** — 7 elegíveis × 0,3 = amostra de 2, que devolveu "50% de discordância". Isso é
 *    uma moeda, não uma estimativa. ⇒ piso de amostra (`AUDIT_MIN_SAMPLE`) e, abaixo dele, o número vai
 *    declarado como INDICAÇÃO. Auditor da mesma família do casador também passa a ser declarado.
 *
 * ## O que a SEGUNDA medição (a primeira cross-family de verdade) descobriu sobre si mesma
 *
 * Recall **43%..57%** — em cima da mediana publicada de 47%, não abaixo dela. E os estratos mostram que a
 * cegueira do juiz não é uniforme: `obvia` **100%**, `sutil` **20%..40%**, `fora_do_vocabulario` **0%**.
 * Ler essa prova abriu dois defeitos novos, ambos de LEGIBILIDADE do número:
 *
 *  * **GAP-101 (médio)** — a auditoria devolveu "100% de discordância sobre 3" sem dizer de que tipo:
 *    `auditMatches` contava igual o terceiro casador dizendo o CONTRÁRIO e o terceiro casador não dizendo
 *    NADA (ausente, ou `indecidivel` por `sem_parecer`). Silêncio e desacordo significam coisas opostas —
 *    um mede incerteza do instrumento, o outro mede desacordo real entre famílias. É o GAP-89/GAP-63 num
 *    lugar novo. ⇒ `noOpinion` é medido, gravado e declarado SEPARADO; a discordância continua incluindo
 *    o silêncio (a incerteza sobe, o recall nunca).
 *  * **GAP-102 (baixo, declarado)** — um finding só pode ser o achado de UM defeito, senão o casador fecha
 *    dois com uma frase e o recall infla. Mas quem fica com ele é decidido pela ORDEM da lista do casador,
 *    não pela força da evidência: D06 perdeu para D03 o finding do payload `delivery.created` e virou
 *    `nao_encontrado` sem contagem própria. A regra FICA (deprime o recall, nunca infla); o que não fica é
 *    o número sem nome. ⇒ limitação declarada, com contagem.
 */
import { evidenceIsVerbatim } from "./crossFamilyAudit.js";
import { FINDING_CATEGORIES, type Db } from "./findingTriage.js";
import { parseListResponse } from "./gapPromotionVerdict.js";
import { callPolicyAgent, sha256Hex } from "./specPolicyGate.js";
import type { ValidationFinding } from "./specValidation.js";

function num(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** `SPEC_JUDGE_RECALL=on` liga. Nasce OFF: é medição caríssima (uma validação inteira por rodada). */
export function judgeRecallEnabled(): boolean {
  return (process.env.SPEC_JUDGE_RECALL ?? "").trim().toLowerCase() === "on";
}

/**
 * GAP-100: abaixo disto a discordância entre casadores não é estimativa, é anedota — e vai DECLARADA
 * como tal. Medido em prod: 7 defeitos elegíveis × 0,3 = amostra de 2, que devolveu "50%".
 */
export const AUDIT_MIN_SAMPLE = 3;

export function recallConfig() {
  return {
    /** Quem INJETA. Vazio = modelo do tenant. */
    injectModel: (process.env.SPEC_RECALL_INJECT_MODEL ?? "").trim(),
    /** GAP-93: quem CASA finding↔defeito. Tem de ser de outra família que o juiz. */
    matchModel: (process.env.SPEC_RECALL_MATCH_MODEL ?? "amazon.nova-pro-v1:0").trim(),
    /** GAP-93: o terceiro modelo que recasa a AMOSTRA, para medir a discordância entre casadores. */
    auditModel: (process.env.SPEC_RECALL_AUDIT_MODEL ?? "mistral.mistral-large-3-675b-instruct").trim(),
    /** Quantos defeitos por gold set. Poucos = recall com intervalo de confiança inútil. */
    defects: num(process.env.SPEC_RECALL_DEFECTS, 10),
    /** Fração da amostra recasada pelo terceiro modelo (0 = não audita). */
    auditFraction: Math.min(1, Math.max(0, Number(process.env.SPEC_RECALL_AUDIT_FRACTION ?? "0.3") || 0)),
    /** GAP-100: piso da amostra recasada. "50% de discordância sobre 2" é moeda, não estimativa. */
    auditMin: num(process.env.SPEC_RECALL_AUDIT_MIN, AUDIT_MIN_SAMPLE),
    /** Orçamento de saída do injetor (10 defeitos com trecho original + mutado é texto longo). */
    injectTokens: num(process.env.SPEC_RECALL_INJECT_TOKENS, 16_000),
    /** Orçamento de saída do casador. */
    matchTokens: num(process.env.SPEC_RECALL_MATCH_TOKENS, 8_000),
    /** Teto do trecho de arquivo mandado ao injetor (ele precisa de texto verbatim para ancorar). */
    injectChars: num(process.env.SPEC_RECALL_INJECT_CHARS, 40_000),
    /** Minutos de espera pelo juiz. O estágio B real leva minutos; menos que isso mede o timeout. */
    judgeDeadlineMin: num(process.env.SPEC_RECALL_JUDGE_DEADLINE_MIN, 20),
  };
}

// ── o gold set ────────────────────────────────────────────────────────────────────────────────────

export type DefectPosition = "secao_nomeada" | "corpo_sem_titulo";
export type DefectDifficulty = "obvia" | "sutil";
export type DefectScope = "local" | "distribuido";

export interface GoldDefect {
  id: string;
  file: string;
  /** Onde o defeito mora, como o juiz o citaria (seção, FR-NN, entidade). */
  anchor: string;
  /** GAP-90: seção nomeada é o caso fácil. `corpo_sem_titulo` é o que revela viés de ancoragem. */
  position: DefectPosition;
  /** A classe declarada pelo injetor — texto livre de propósito (GAP-91 exige sair do vocabulário). */
  defectClass: string;
  /** GAP-91: a classe está entre as 13 da triagem? */
  inVocabulary: boolean;
  /** GAP-94: declarada pelo injetor. Gold set só com `obvia` é limitação declarada. */
  difficulty: DefectDifficulty;
  /** GAP-92: `distribuido` exige contradição em OUTRO arquivo. */
  scope: DefectScope;
  /** O que o defeito é, em prosa — é isto que o casador compara com o finding. */
  description: string;
  /** Trecho VERBATIM do arquivo original. Se não existir literalmente, o defeito é RECUSADO. */
  original: string;
  mutated: string;
  /** Segundo par (só `scope=distribuido`). */
  file2?: string | null;
  original2?: string | null;
  mutated2?: string | null;
}

/** GAP-96: uma única fonte do vocabulário, lida verbatim pelo injetor E pelo casador. */
export const VOCABULARY_BLOCK = FINDING_CATEGORIES.filter((c) => c !== "other" && c !== "structural")
  .map((c) => `  - ${c}`).join("\n");

export const INJECT_SYSTEM = `Você injeta DEFEITOS CONTROLADOS numa especificação de software real, para medir o quanto um revisor automático consegue encontrar.

Responda SOMENTE com JSON:
{"defects":[{"file":"...","anchor":"...","position":"secao_nomeada|corpo_sem_titulo","class":"...","in_vocabulary":true|false,"difficulty":"obvia|sutil","scope":"local|distribuido","description":"...","original":"trecho VERBATIM do arquivo","mutated":"o mesmo trecho com o defeito","file2":"...","original2":"...","mutated2":"..."}]}

REGRAS (a ordem importa):
1. \`original\` tem de ser um trecho COPIADO LETRA POR LETRA do arquivo, com 40 a 600 caracteres. Se você
   reescrever, resumir ou corrigir espaçamento, o defeito será RECUSADO por não ser verbatim.
2. \`mutated\` é o MESMO trecho com o defeito introduzido. Nada fora desse trecho pode mudar.
3. O defeito tem de ser um defeito de ESPECIFICAÇÃO plausível — algo que um autor distraído escreveria —,
   não um erro de digitação nem um absurdo evidente.
4. VARIE a posição: pelo menos um terço dos defeitos em \`corpo_sem_titulo\` (parágrafo, item de lista,
   célula de tabela — texto que NÃO é um título de seção). Defeito só em seção nomeada mede a atenção do
   revisor a títulos, não a capacidade dele de ler o documento.
5. VARIE a dificuldade: metade \`obvia\`, metade \`sutil\`. \`sutil\` = exige comparar com outro trecho,
   inferir consequência ou notar ausência; \`obvia\` = contradição visível no próprio parágrafo.
6. VARIE a classe. Estas são as classes que o revisor conhece:
${VOCABULARY_BLOCK}
   Injete pelo menos DOIS defeitos de classe FORA dessa lista (\`in_vocabulary: false\`) — descreva a
   classe com suas palavras. Medir só o que o revisor já sabe procurar é medir o próprio vocabulário.
7. \`scope: "distribuido"\` significa que o defeito só existe quando se comparam DOIS arquivos: preencha
   \`file2\`, \`original2\` e \`mutated2\` (ex.: a mesma regra reafirmada com valor diferente em outro
   arquivo). Injete pelo menos UM distribuído. Sem os três campos, o defeito é recusado.
8. Um defeito por âncora. Dois defeitos na mesma âncora se contaminam e a medição perde o sentido.
9. NUNCA remova requisito inteiro nem apague seção: o defeito tem de estar no texto, não na sua ausência.`;

function str(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

const KNOWN_CLASSES = new Set<string>(FINDING_CATEGORIES as readonly string[]);

/**
 * Do parecer do injetor para gold set gravável — RECUSANDO tudo que não seja verbatim.
 *
 * O único guard que o código faz aqui é Context Integrity: `original` tem de existir LITERALMENTE no
 * arquivo. Sem isso a "mutação" seria uma reescrita, o restante do documento mudaria junto e o recall
 * mediria a reação do juiz a um texto que a Fábrica nunca escreveu. A classe, a dificuldade, a posição
 * e o escopo são DECLARAÇÃO do agente — o código não os recalcula (Lei: 100% LLM).
 */
export function parseInjections(
  raw: Array<Record<string, unknown>>,
  files: Array<{ path: string; content: string }>,
): { defects: GoldDefect[]; rejected: Array<{ anchor: string; reason: string }> } {
  const porArquivo = new Map(files.map((f) => [f.path, f.content]));
  const defects: GoldDefect[] = [];
  const rejected: Array<{ anchor: string; reason: string }> = [];
  const anchorsUsados = new Set<string>();
  for (const [i, r] of raw.entries()) {
    const anchor = str(r.anchor).trim().slice(0, 160);
    const file = str(r.file).trim();
    const original = str(r.original);
    const mutated = str(r.mutated);
    const rec = (reason: string) => rejected.push({ anchor: anchor || `#${i + 1}`, reason });
    const conteudo = porArquivo.get(file);
    if (!file || conteudo === undefined) { rec(`arquivo "${file.slice(0, 80)}" não é arquivo real da spec`); continue; }
    if (!anchor) { rec("defeito sem âncora — não haveria como casar o finding"); continue; }
    if (!original || !mutated) { rec("defeito sem trecho original ou mutado"); continue; }
    if (original === mutated) { rec("trecho mutado idêntico ao original — nada foi injetado"); continue; }
    if (!conteudo.includes(original)) { rec("trecho original NÃO é verbatim do arquivo (mutação viraria reescrita)"); continue; }
    const chave = `${file}|${anchor.toLowerCase()}`;
    if (anchorsUsados.has(chave)) { rec("segunda injeção na mesma âncora (defeitos se contaminam)"); continue; }
    const scope: DefectScope = str(r.scope).trim().toLowerCase() === "distribuido" ? "distribuido" : "local";
    let file2: string | null = null;
    let original2: string | null = null;
    let mutated2: string | null = null;
    if (scope === "distribuido") {
      file2 = str(r.file2).trim() || null;
      original2 = str(r.original2) || null;
      mutated2 = str(r.mutated2) || null;
      const conteudo2 = file2 ? porArquivo.get(file2) : undefined;
      if (!file2 || !original2 || !mutated2) { rec("escopo distribuído sem o segundo par (file2/original2/mutated2)"); continue; }
      if (conteudo2 === undefined) { rec(`segundo arquivo "${file2.slice(0, 80)}" não é arquivo real da spec`); continue; }
      if (!conteudo2.includes(original2)) { rec("segundo trecho original NÃO é verbatim do arquivo"); continue; }
      if (original2 === mutated2) { rec("segundo trecho mutado idêntico ao original"); continue; }
    }
    const klass = str(r.class ?? r.defect_class).trim().slice(0, 120) || "nao_declarada";
    anchorsUsados.add(chave);
    defects.push({
      id: `D${String(defects.length + 1).padStart(2, "0")}`,
      file, anchor,
      position: str(r.position).trim().toLowerCase() === "corpo_sem_titulo" ? "corpo_sem_titulo" : "secao_nomeada",
      defectClass: klass,
      // A declaração do agente vale; o código só a confere contra a lista quando ele diz que está
      // dentro dela (declarar `in_vocabulary` para uma classe que não existe seria mentir na medição).
      inVocabulary: r.in_vocabulary === true && KNOWN_CLASSES.has(klass),
      difficulty: str(r.difficulty).trim().toLowerCase() === "sutil" ? "sutil" : "obvia",
      scope,
      description: str(r.description).trim().slice(0, 800),
      original, mutated, file2, original2, mutated2,
    });
  }
  return { defects, rejected };
}

/**
 * Aplica as mutações em memória. Substituição verbatim da PRIMEIRA ocorrência, arquivo por arquivo.
 *
 * Nada aqui toca o banco nem o disco. O retorno é um corpus novo — o original segue intacto na mão do
 * chamador, e é ele que continua sendo a spec do projeto.
 */
export function applyInjections(
  files: Array<{ path: string; content: string }>,
  defects: GoldDefect[],
): { files: Array<{ path: string; content: string }>; applied: GoldDefect[]; rejected: Array<{ anchor: string; reason: string }> } {
  const mapa = new Map(files.map((f) => [f.path, f.content]));
  const applied: GoldDefect[] = [];
  const rejected: Array<{ anchor: string; reason: string }> = [];
  for (const d of defects) {
    const pares: Array<[string, string, string]> = [[d.file, d.original, d.mutated]];
    if (d.scope === "distribuido" && d.file2 && d.original2 && d.mutated2) {
      pares.push([d.file2, d.original2, d.mutated2]);
    }
    // Todos os pares do defeito entram, ou nenhum: defeito distribuído aplicado pela metade não é o
    // defeito que o injetor declarou (seria uma contradição a menos, e o casador cobraria a errada).
    const podem = pares.every(([f, o]) => (mapa.get(f) ?? "").includes(o));
    if (!podem) { rejected.push({ anchor: d.anchor, reason: "trecho não encontrado no corpus no momento de aplicar (mutação anterior o consumiu)" }); continue; }
    for (const [f, o, m] of pares) {
      const atual = mapa.get(f) ?? "";
      mapa.set(f, atual.replace(o, m));
    }
    applied.push(d);
  }
  return {
    files: files.map((f) => ({ path: f.path, content: mapa.get(f.path) ?? f.content })),
    applied, rejected,
  };
}

/**
 * GAP-95: a versão do gold set inclui a AMOSTRA, não só os defeitos.
 *
 * Arquivo escolhido, tamanho do arquivo, classe, âncora e o trecho mutado — tudo entra no hash. Duas
 * medições com versões diferentes não são comparáveis, e é isso que o hash torna impossível de esquecer:
 * recall que subiu porque a amostra ficou mais fácil não é recall que subiu.
 */
export function goldSetVersion(
  files: Array<{ path: string; content: string }>,
  defects: GoldDefect[],
): string {
  const amostra = files.map((f) => `${f.path}:${f.content.length}`).sort().join("|");
  const corpo = defects
    .map((d) => [d.file, d.anchor, d.defectClass, d.position, d.difficulty, d.scope, sha256Hex(d.mutated).slice(0, 16)].join("~"))
    .sort().join("|");
  return sha256Hex(`${amostra}\n${corpo}`).slice(0, 32);
}

// ── o casador (LLM de outra família) ──────────────────────────────────────────────────────────────

export const MATCH_SYSTEM = `Você decide se um REVISOR automático encontrou defeitos que foram injetados de propósito numa especificação.

Responda SOMENTE com JSON:
{"matches":[{"defect_id":"D01","verdict":"encontrado|parcial|nao_encontrado","finding_ref":"título do finding que corresponde","class_agreed":true|false,"citation":"citação VERBATIM do finding","reason":"por que"}]}

REGRAS (a ordem importa):
1. "encontrado" = existe um finding que aponta O MESMO defeito, no MESMO lugar. Cite VERBATIM o trecho
   do finding (título ou justificativa) que prova isso. Sem citação literal, não é encontrado.
2. "parcial" = o finding aponta o lugar certo mas descreve outro problema, ou aponta o problema certo em
   lugar errado. Também exige citação verbatim.
3. "nao_encontrado" = nenhum finding corresponde. Este é um veredicto legítimo e comum — o revisor
   realmente perde defeitos, e esconder isso arruína a medição.
4. A CLASSE NÃO DECIDE O CASAMENTO. O revisor escolhe a categoria entre uma lista fechada e chama o
   mesmo defeito por nomes diferentes; está medido que 32 de 152 âncoras receberam 2 ou 3 categorias
   distintas para o mesmo defeito. Case por LUGAR e por SENTIDO, e use \`class_agreed\` apenas para
   registrar se a categoria do finding bate com a classe do defeito injetado.
5. Um finding pode casar com no máximo UM defeito. Se dois defeitos disputam o mesmo finding, o que
   tiver correspondência mais específica fica com ele e o outro é "nao_encontrado".
6. Uma linha de resposta para CADA defect_id recebido. Não invente id.
7. NUNCA suponha que o revisor "deve" ter visto porque o defeito é grave. Só o texto do finding conta.

CLASSES QUE O REVISOR CONHECE (para preencher class_agreed):
${VOCABULARY_BLOCK}`;

export type MatchVerdict = "encontrado" | "parcial" | "nao_encontrado" | "indecidivel";

export interface RecallItem {
  defectId: string;
  file: string;
  anchor: string;
  defectClass: string;
  inVocabulary: boolean;
  difficulty: DefectDifficulty;
  position: DefectPosition;
  scope: DefectScope;
  /** GAP-97: o arquivo mutado chegou INTEGRAL ao juiz? `false` ⇒ fora do denominador do recall. */
  covered: boolean;
  verdict: MatchVerdict;
  findingRef: string;
  citation: string;
  citationVerbatim: boolean;
  /** GAP-49 aplicado: registrado, nunca exigido para casar. */
  classAgreed: boolean;
  reason: string;
}

/** O texto contra o qual a citação do casador é conferida: tudo que o juiz escreveu, verbatim. */
export function findingsEvidenceText(findings: ValidationFinding[]): string {
  return findings.map((f) => `${f.title}\n${f.rationale}`).join("\n");
}

/**
 * Do parecer do casador para item de recall — com a citação conferida e o erro empurrado para BAIXO.
 *
 * Três casos deixam o defeito FORA do numerador, sempre com o motivo dito: casador silencioso
 * (`sem_parecer`), citação que não existe nos findings (`citacao_nao_confere`) e `parcial`. Nenhum deles
 * é "o juiz achou". Preferir errar para baixo é decisão de desenho: recall inflado é o número que
 * autoriza confiar num juiz cego, e é o único erro aqui que custa a spec.
 */
export function normalizeMatches(
  raw: Array<Record<string, unknown>>,
  defects: GoldDefect[],
  findings: ValidationFinding[],
  judgedFiles: string[],
): RecallItem[] {
  const evidencia = findingsEvidenceText(findings);
  const integrais = new Set(judgedFiles);
  const porId = new Map<string, Record<string, unknown>>();
  const ids = new Set(defects.map((d) => d.id));
  for (const r of raw) {
    const id = str(r.defect_id ?? r.defectId).trim().toUpperCase();
    if (!id || !ids.has(id) || porId.has(id)) continue;
    porId.set(id, r);
  }
  // GAP-93 regra 5: um finding não pode ser o achado de dois defeitos — quem chega primeiro (ordem do
  // gold set) fica com ele, e o segundo cai para `nao_encontrado` com o motivo declarado.
  const findingTomado = new Set<string>();
  return defects.map((d) => {
    // GAP-92: defeito distribuído só está coberto se OS DOIS arquivos chegaram integrais ao juiz.
    const arquivos = d.scope === "distribuido" && d.file2 ? [d.file, d.file2] : [d.file];
    const covered = arquivos.every((f) => integrais.has(f));
    const base: RecallItem = {
      defectId: d.id, file: d.file, anchor: d.anchor, defectClass: d.defectClass,
      inVocabulary: d.inVocabulary, difficulty: d.difficulty, position: d.position, scope: d.scope,
      covered, verdict: "nao_encontrado", findingRef: "", citation: "", citationVerbatim: false,
      classAgreed: false, reason: "",
    };
    const r = porId.get(d.id);
    if (!r) return { ...base, verdict: "indecidivel", reason: "sem_parecer" };
    const veredicto = str(r.verdict).trim().toLowerCase();
    const citation = str(r.citation).trim();
    const findingRef = str(r.finding_ref ?? r.findingRef).trim().slice(0, 240);
    const reason = str(r.reason).trim().slice(0, 500);
    const classAgreed = r.class_agreed === true;
    const verbatim = citation.length > 0 && evidenceIsVerbatim(citation, evidencia);
    if (veredicto === "nao_encontrado") {
      return { ...base, verdict: "nao_encontrado", findingRef, citation, reason: reason || "nao_encontrado", classAgreed };
    }
    if (veredicto !== "encontrado" && veredicto !== "parcial") {
      return { ...base, verdict: "indecidivel", findingRef, citation, reason: `veredicto ilegível ("${veredicto.slice(0, 40)}")`, classAgreed };
    }
    if (!verbatim) {
      return { ...base, verdict: "indecidivel", findingRef, citation, reason: "citacao_nao_confere", classAgreed };
    }
    const chave = findingRef.toLowerCase() || citation.toLowerCase();
    if (veredicto === "encontrado" && findingTomado.has(chave)) {
      return { ...base, verdict: "nao_encontrado", findingRef, citation, citationVerbatim: true, classAgreed, reason: "finding já casado com outro defeito" };
    }
    if (veredicto === "encontrado") findingTomado.add(chave);
    return {
      ...base, verdict: veredicto === "encontrado" ? "encontrado" : "parcial",
      findingRef, citation, citationVerbatim: true, classAgreed, reason,
    };
  });
}

// ── a conta ───────────────────────────────────────────────────────────────────────────────────────

export interface RecallStratum {
  eligible: number;
  found: number;
  partial: number;
  missed: number;
  undecided: number;
  uncovered: number;
  /** Piso: só `encontrado`. */
  recallMin: number;
  /** Teto: `encontrado` + tudo que ficou em dúvida. O recall verdadeiro vive nesta banda. */
  recallMax: number;
}

export interface RecallTally extends RecallStratum {
  injected: number;
  classAgreed: number;
  byClass: Record<string, RecallStratum>;
  byDifficulty: Record<string, RecallStratum>;
  byPosition: Record<string, RecallStratum>;
  byScope: Record<string, RecallStratum>;
  byVocabulary: Record<string, RecallStratum>;
}

function stratum(items: RecallItem[]): RecallStratum {
  const uncovered = items.filter((i) => !i.covered).length;
  const elegiveis = items.filter((i) => i.covered);
  const found = elegiveis.filter((i) => i.verdict === "encontrado").length;
  const partial = elegiveis.filter((i) => i.verdict === "parcial").length;
  const missed = elegiveis.filter((i) => i.verdict === "nao_encontrado").length;
  const undecided = elegiveis.filter((i) => i.verdict === "indecidivel").length;
  const n = elegiveis.length;
  return {
    eligible: n, found, partial, missed, undecided, uncovered,
    recallMin: n > 0 ? found / n : 0,
    recallMax: n > 0 ? (found + partial + undecided) / n : 0,
  };
}

function group(items: RecallItem[], key: (i: RecallItem) => string): Record<string, RecallStratum> {
  const out: Record<string, RecallStratum> = {};
  const buckets = new Map<string, RecallItem[]>();
  for (const i of items) {
    const k = key(i);
    const arr = buckets.get(k);
    if (arr) arr.push(i); else buckets.set(k, [i]);
  }
  for (const [k, arr] of buckets) out[k] = stratum(arr);
  return out;
}

/**
 * O recall, estratificado por tudo que a revisão adversarial disse que podia falsear o agregado.
 *
 * O número global é o menos informativo dos que saem daqui: um recall agregado de 60% com 100% em
 * `secao_nomeada` e 20% em `corpo_sem_titulo` não descreve um juiz razoável — descreve um juiz que lê
 * títulos. É o mesmo raciocínio do GAP-76 (agregado não é progresso quando a superfície roda).
 */
export function recallTally(items: RecallItem[]): RecallTally {
  return {
    ...stratum(items),
    injected: items.length,
    classAgreed: items.filter((i) => i.verdict === "encontrado" && i.classAgreed).length,
    byClass: group(items, (i) => i.defectClass),
    byDifficulty: group(items, (i) => i.difficulty),
    byPosition: group(items, (i) => i.position),
    byScope: group(items, (i) => i.scope),
    byVocabulary: group(items, (i) => (i.inVocabulary ? "no_vocabulario" : "fora_do_vocabulario")),
  };
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/**
 * As limitações que a própria medição descobriu sobre si — DECLARADAS, nunca escondidas.
 *
 * Gold set sem defeito fora do vocabulário, sem defeito distribuído, sem `corpo_sem_titulo` ou sem
 * `sutil` mede menos do que o nome "recall do juiz" promete. Casador da MESMA família do juiz é o
 * cenário que a pesquisa mede como pior (`arXiv:2609.04270`: auto-revisão dá ZERO ganho). Cada uma
 * dessas frases é uma ressalva que quem ler o número precisa ler junto.
 */
export function recallLimitations(args: {
  tally: RecallTally;
  sameFamily: boolean;
  judgeModel: string;
  matchModel: string;
  matcherDisagreement: number | null;
  /** GAP-101: fração da amostra em que o terceiro casador não opinou (silêncio ≠ discordância). */
  matcherNoOpinion?: number | null;
  auditSample: number;
  auditModel?: string;
  rejected: number;
  /** GAP-102: defeitos recusados porque outro defeito reivindicou o finding primeiro. */
  priorClaim?: number;
}): string[] {
  const t = args.tally;
  const out: string[] = [];
  if (t.byPosition.corpo_sem_titulo === undefined) out.push("gold set sem defeito em `corpo_sem_titulo` — este recall mede a atenção do juiz a SEÇÕES NOMEADAS (GAP-90 não coberto nesta versão)");
  // GAP-99: a checagem de faixa era de um lado só. Na primeira medição em prod os 7 defeitos caíram
  // TODOS em `corpo_sem_titulo` e nada foi declarado — o relatório publicou 14% como se descrevesse o
  // juiz inteiro, quando descrevia apenas o lado difícil. Faixa com um lado só é limitação nas DUAS
  // direções; a diferença é para que lado o número engana, e é isso que cada frase diz.
  if (t.byPosition.secao_nomeada === undefined) out.push("gold set sem defeito em `secao_nomeada` — todo o recall veio do corpo sem título, que é o lado DIFÍCIL: este número é um PISO e não descreve o juiz em seções nomeadas (GAP-99)");
  if (t.byVocabulary.fora_do_vocabulario === undefined) out.push("gold set inteiro dentro do vocabulário conhecido — o recall não diz nada sobre defeito que o juiz não sabe procurar (GAP-91)");
  if (t.byVocabulary.no_vocabulario === undefined) out.push("gold set inteiro FORA do vocabulário conhecido — é o lado difícil, e o número não descreve o juiz nas 13 categorias que ele foi ensinado a procurar (GAP-99)");
  if (t.byScope.distribuido === undefined) out.push("gold set sem defeito distribuído — nada aqui mede se o juiz correlaciona arquivos (GAP-92)");
  if (t.byScope.local === undefined) out.push("gold set só com defeito distribuído — nada aqui mede o defeito que cabe num arquivo só, que é a maioria da spec (GAP-99)");
  if (t.byDifficulty.sutil === undefined) out.push("gold set só com defeito `obvia` — recall alto aqui não se transfere para defeito sutil (GAP-94)");
  if (t.byDifficulty.obvia === undefined) out.push("gold set só com defeito `sutil` — é o lado difícil: o número é um PISO e não descreve o juiz no defeito óbvio (GAP-99)");
  if (args.sameFamily) out.push(`casador (${args.matchModel || "?"}) da MESMA família do juiz (${args.judgeModel || "?"}) — a pesquisa mede ZERO ganho em auto-revisão; este casamento é o cenário mais frágil (GAP-93)`);
  // Não saber a família do juiz não é o mesmo que saber que são diferentes. Sem esta linha, `sameFamily
  // = false` por ignorância pareceria a garantia cross-family que a frente inteira depende de ter.
  else if (modelFamily(args.judgeModel) === "desconhecida") out.push(`modelo do juiz não declarado nesta chamada (a Bancada usou o padrão do tenant) — o casador é ${args.matchModel || "?"}, mas NÃO se pode afirmar que é de outra família (GAP-93)`);
  if (args.matcherDisagreement === null) out.push("nenhuma amostra recasada por terceiro modelo — o erro do casador entra no recall sem estimativa (GAP-93)");
  else {
    const magro = args.auditSample < AUDIT_MIN_SAMPLE
      ? ` — amostra de ${args.auditSample} está ABAIXO do piso de ${AUDIT_MIN_SAMPLE}: é indicação, não estimativa (GAP-100)`
      : "";
    out.push(`erro do casador estimado em ${pct(args.matcherDisagreement)} de discordância sobre ${args.auditSample} defeito(s) recasado(s) — a banda do recall NÃO inclui essa incerteza${magro}`);
    // GAP-101: "100% de discordância" lido sem isto parece opinião contrária; pode ser SILÊNCIO.
    const calado = args.matcherNoOpinion ?? null;
    if (calado !== null && calado > 0) {
      out.push(calado >= (args.matcherDisagreement ?? 0)
        ? `dessa discordância, ${pct(calado)} é o terceiro casador NÃO OPINANDO, não opinando o contrário — silêncio não mede desacordo entre famílias (GAP-101)`
        : `${pct(calado)} da amostra ficou sem parecer do terceiro casador e entrou como discordância — silêncio empurra a incerteza para CIMA, nunca o recall (GAP-101)`);
    }
    // O auditor da mesma família do casador não é uma segunda opinião: mede a consistência de um modelo
    // consigo mesmo e chama isso de discordância entre casadores (a ponta de GAP-98 no terceiro modelo).
    if (args.auditModel && sameFamily(args.auditModel, args.matchModel)) {
      out.push(`terceiro casador (${args.auditModel}) da MESMA família do casador (${args.matchModel}) — a discordância mede consistência de uma família consigo mesma, não erro entre famílias (GAP-98/93)`);
    }
  }
  // GAP-102: um finding só pode ser o achado de UM defeito (senão o casador fecha dois defeitos com uma
  // frase), mas quem fica com ele é decidido pela ORDEM da lista do casador, não pela força da evidência.
  // Medido em prod: D06 perdeu para D03 o finding do payload `delivery.created` e ficou `nao_encontrado`.
  // A direção do erro é a desenhada (para baixo), mas o número perdido não pode ficar sem nome.
  if ((args.priorClaim ?? 0) > 0) out.push(`${args.priorClaim} defeito(s) recusado(s) porque outro reivindicou o MESMO finding antes — o critério é a ORDEM da lista do casador, não a força da evidência; deprime o recall (GAP-102)`);
  if (t.uncovered > 0) out.push(`${t.uncovered} defeito(s) fora da cobertura do juiz — falha de COBERTURA do harness, fora do denominador do recall (GAP-97)`);
  if (args.rejected > 0) out.push(`${args.rejected} injeção(ões) recusada(s) por não serem verbatim — o gold set é menor do que o injetor propôs`);
  out.push("mutação só em memória: nada aqui mede defeito que dependa de persistência, de link entre arquivos gravados ou de estado do sistema");
  return out;
}

/** A nota em prosa. Diz a BANDA primeiro — um número só de recall esconde por onde ele foi obtido. */
export function recallNote(t: RecallTally, limits: string[] = []): string {
  if (t.eligible === 0) {
    return t.injected === 0
      ? "nenhum defeito injetado — nada foi medido"
      : `${t.injected} defeito(s) injetado(s) e NENHUM chegou ao juiz — falha de cobertura do harness, não recall (${t.uncovered} fora de cobertura)`;
  }
  const partes = [
    `recall do juiz entre ${pct(t.recallMin)} e ${pct(t.recallMax)} (${t.found} de ${t.eligible} defeito(s) elegível(is) encontrado(s))`,
    `${t.missed} perdido(s)`,
  ];
  if (t.partial) partes.push(`${t.partial} parcial(is)`);
  if (t.undecided) partes.push(`${t.undecided} sem casamento conferido`);
  if (t.uncovered) partes.push(`${t.uncovered} fora da cobertura do juiz (não conta como perda dele)`);
  const est = Object.entries(t.byPosition).map(([k, s]) => `${k} ${pct(s.recallMin)}`).join(", ");
  if (est) partes.push(`por posição: ${est}`);
  const dif = Object.entries(t.byDifficulty).map(([k, s]) => `${k} ${pct(s.recallMin)}`).join(", ");
  if (dif) partes.push(`por dificuldade: ${dif}`);
  const voc = Object.entries(t.byVocabulary).map(([k, s]) => `${k} ${pct(s.recallMin)}`).join(", ");
  if (voc) partes.push(`por vocabulário: ${voc}`);
  if (limits.length) partes.push(`limitações: ${limits.length}`);
  return partes.join(", ");
}

/**
 * GAP-93: casador e juiz da MESMA família não são duas opiniões — é a mesma opinião duas vezes.
 *
 * Comparação pelo PREFIXO do id do Bedrock (`us.anthropic.…` → `anthropic`), que é o que separa
 * famílias no catálogo. Não é heurística de qualidade: é a única informação de família que o id carrega.
 */
export function modelFamily(modelId: string): string {
  const id = (modelId || "").trim().toLowerCase().replace(/^(us|eu|apac)\./, "");
  const fam = id.split(".")[0] ?? "";
  return fam || "desconhecida";
}

export function sameFamily(a: string, b: string): boolean {
  const fa = modelFamily(a);
  const fb = modelFamily(b);
  return fa !== "desconhecida" && fa === fb;
}

/**
 * GAP-93: recasa uma AMOSTRA com um terceiro modelo e devolve a taxa de discordância.
 *
 * Não corrige o recall — ESTIMA o erro de quem o mediu. Corrigir seria fingir que o terceiro modelo é
 * a verdade; ele é só uma segunda opinião, e a distância entre as duas é a incerteza que fica DECLARADA.
 */
export async function auditMatches(args: {
  items: RecallItem[];
  defects: GoldDefect[];
  findings: ValidationFinding[];
  judgedFiles: string[];
  model: string;
  llm?: Record<string, unknown> | null;
  cfg?: ReturnType<typeof recallConfig>;
}): Promise<{ sample: number; disagreement: number | null; noOpinion: number | null; why: string; modelUsed: string }> {
  const cfg = args.cfg ?? recallConfig();
  const elegiveis = args.items.filter((i) => i.covered);
  // GAP-100: a fração sozinha produziu amostra de 2 na primeira medição em prod — e "50% de
  // discordância sobre 2" é uma moeda, não uma estimativa. O piso `auditMin` sobe a amostra; quando
  // nem ele cabe (gold set minúsculo), a limitação declara que o número é INDICATIVO, não estimativa.
  const n = Math.min(elegiveis.length, Math.max(cfg.auditMin, Math.round(elegiveis.length * cfg.auditFraction)));
  if (!args.model || cfg.auditFraction <= 0 || n === 0) {
    return { sample: 0, disagreement: null, noOpinion: null, why: "auditoria do casador desligada", modelUsed: "" };
  }
  // Amostra determinística por ordem do gold set: reprodutível na mesma versão, e a versão está no hash.
  const amostra = elegiveis.slice(0, n);
  const porId = new Map(args.defects.map((d) => [d.id, d]));
  const res = await callPolicyAgent({
    system: MATCH_SYSTEM,
    user: matchUserMessage(amostra.map((i) => porId.get(i.defectId)).filter((d): d is GoldDefect => !!d), args.findings),
    maxTokens: cfg.matchTokens, modelId: args.model, llm: args.llm,
  });
  if (!res.ok) return { sample: 0, disagreement: null, noOpinion: null, why: `terceiro casador indisponível: ${res.why}`, modelUsed: "" };
  const modelUsed = res.modelUsedRaw || args.model;
  const parsed = parseListResponse(res.text, "matches");
  if (!parsed || parsed.length === 0) return { sample: 0, disagreement: null, noOpinion: null, why: "terceiro casador sem JSON legível", modelUsed };
  const segundos = normalizeMatches(
    parsed, amostra.map((i) => porId.get(i.defectId)).filter((d): d is GoldDefect => !!d),
    args.findings, args.judgedFiles,
  );
  // GAP-101: SILÊNCIO não é discordância. `normalizeMatches` preenche todo defeito sem parecer com
  // `indecidivel`/`sem_parecer` — se contássemos isso como "o outro modelo discordou", o auditor que
  // simplesmente não opinou viraria evidência de que a medição está errada. Medido em prod: a primeira
  // auditoria cross-family devolveu "100% de discordância sobre 3" sem dizer de que tipo. É a mesma
  // família do GAP-89 (o `indecidivel` que desaparecia da nota) e do GAP-63 (corte silencioso).
  const porIdSegundo = new Map(segundos.map((s) => [s.defectId, s] as const));
  let divergentes = 0;
  let calados = 0;
  for (const i of amostra) {
    const s = porIdSegundo.get(i.defectId);
    if (!s) { calados++; divergentes++; continue; }
    if (s.verdict === "indecidivel" && s.reason === "sem_parecer") { calados++; divergentes++; continue; }
    if (s.verdict !== i.verdict) divergentes++;
  }
  return {
    sample: amostra.length, disagreement: divergentes / amostra.length,
    noOpinion: calados / amostra.length, why: "", modelUsed,
  };
}

/** O que o casador lê: os defeitos injetados e TODOS os findings do juiz, verbatim. */
export function matchUserMessage(defects: GoldDefect[], findings: ValidationFinding[]): string {
  return [
    "DEFEITOS INJETADOS (o revisor não sabia que existiam):",
    ...defects.map((d) => [
      `- ${d.id} | arquivo: ${d.file} | âncora: ${d.anchor} | classe declarada: ${d.defectClass}`,
      `  o que é: ${d.description}`,
      `  texto ANTES (verbatim): ${d.original.slice(0, 400)}`,
      `  texto DEPOIS (com o defeito): ${d.mutated.slice(0, 400)}`,
      d.scope === "distribuido" && d.file2
        ? `  contradição no segundo arquivo ${d.file2}: ${String(d.mutated2 ?? "").slice(0, 300)}`
        : "",
    ].filter(Boolean).join("\n")),
    "",
    `FINDINGS QUE O REVISOR REPORTOU (${findings.length}):`,
    ...(findings.length
      ? findings.map((f, i) => `- #${i + 1} | ${f.file} | ${f.anchor ?? "(sem âncora)"} | ${f.severity} | ${f.category ?? "?"}\n  ${f.title}\n  ${f.rationale.slice(0, 600)}`)
      : ["(nenhum finding — o revisor não reportou nada)"]),
    "",
    "Decida, para CADA defect_id, se algum finding o encontrou.",
  ].join("\n");
}

// ── o juiz REAL, sobre o texto mutado ─────────────────────────────────────────────────────────────

async function httpJson(url: string, method: string, body: unknown, timeoutMs: number): Promise<{ status: number; data: Record<string, unknown> }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: ctrl.signal,
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: r.status, data };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Roda O JUIZ (o `spec_validator` de verdade) sobre o texto mutado, sem gravar nada.
 *
 * É o mesmo endpoint, o mesmo prompt e o mesmo modelo do estágio B. Nenhuma linha de
 * `spec_validation_runs` é criada: esta medição não é uma validação do projeto e não pode aparecer como
 * uma — se aparecesse, o laço autônomo passaria a contar GAPs INJETADOS por nós como GAPs da spec.
 */
export async function judgeMutatedSpec(args: {
  specText: string;
  projectId: string;
  llm?: Record<string, unknown> | null;
  cfg?: ReturnType<typeof recallConfig>;
}): Promise<{ findings: ValidationFinding[]; error?: string; jobId: string }> {
  const cfg = args.cfg ?? recallConfig();
  const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim();
  if (!agentsUrl) return { findings: [], error: "agents indisponível (API_AGENTS_URL ausente)", jobId: "" };
  const base = agentsUrl.replace(/\/$/, "");
  const { parseStageBFindings } = await import("./specValidation.js");
  const start = await httpJson(`${base}/invoke/spec_validator/async`, "POST", {
    spec_text: args.specText,
    originProjectId: args.projectId,
    ...(args.llm ?? {}),
  }, 30_000).catch((e) => ({ status: 0, data: { error: String(e) } as Record<string, unknown> }));
  const jobId = String(start.data.jobId ?? "");
  if (start.status !== 200 || !jobId) {
    return { findings: [], jobId: "", error: `juiz não iniciou (${start.status}): ${String(start.data.error ?? "")}`.slice(0, 300) };
  }
  const deadline = Date.now() + cfg.judgeDeadlineMin * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8_000));
    const poll = await httpJson(`${base}/invoke/spec_validator/status/${jobId}`, "GET", undefined, 30_000)
      .catch(() => ({ status: 0, data: {} as Record<string, unknown> }));
    if (poll.status === 404) return { findings: [], jobId, error: "agents reiniciou durante a medição (job perdido)" };
    if (poll.status !== 200) continue;
    const st = String(poll.data.status ?? "");
    if (st === "done") {
      const result = (poll.data.result ?? {}) as Record<string, unknown>;
      return { findings: parseStageBFindings(result.findings), jobId };
    }
    if (st === "error") return { findings: [], jobId, error: String(poll.data.error ?? "spec_validator error").slice(0, 300) };
  }
  return { findings: [], jobId, error: `espera do juiz expirou (${cfg.judgeDeadlineMin} min)` };
}

// ── orquestração ──────────────────────────────────────────────────────────────────────────────────

export interface JudgeRecallResult {
  ran: boolean;
  reason?: string;
  goldSetVersion: string;
  defects: GoldDefect[];
  rejectedInjections: Array<{ anchor: string; reason: string }>;
  items: RecallItem[];
  tally: RecallTally;
  findingsCount: number;
  judgedFiles: string[];
  judgeModel: string;
  /** O modelo que RESPONDEU ao casamento (GAP-98), não o que foi pedido. */
  matchModel: string;
  /** O modelo que RESPONDEU à auditoria do casador. Vazio = auditoria não rodou. */
  auditModel: string;
  sameFamily: boolean;
  matcherSample: number;
  matcherDisagreement: number | null;
  /** GAP-101: quanto da discordância é SILÊNCIO do terceiro casador, não opinião contrária. */
  matcherNoOpinion: number | null;
  limitations: string[];
  note: string;
}

function emptyTally(): RecallTally {
  return recallTally([]);
}

/**
 * A medição completa: injeta, roda O JUIZ sobre o texto mutado, casa com um agente de outra família,
 * estima o erro do casador com um terceiro, e grava — com as limitações declaradas junto.
 *
 * Idempotente por `(projectId, specHash, goldSetVersion, judgeModel)`: o gold set é derivado por LLM e
 * muda a cada derivação, então repetir a medição é caro **e** legítimo — o que a chave impede é gravar
 * duas vezes o MESMO gold set contra o MESMO juiz e depois comparar os dois como se fossem progresso.
 */
export async function runJudgeRecall(db: Db, args: {
  projectId: string;
  specHash: string;
  files: Array<{ path: string; content: string }>;
  /** Arquivos que o juiz recebeu INTEGRAIS (`buildValidationInput().full`). Vazio = injetor decide sozinho e a cobertura fica desconhecida. */
  judgedFilesHint?: string[];
  llm?: Record<string, unknown> | null;
  autonomyRunId?: string | null;
  /** Injeta e mede sem gravar — para provar o caminho sem sujar a trilha do projeto. */
  evaluateOnly?: boolean;
}): Promise<JudgeRecallResult> {
  const cfg = recallConfig();
  const empty = (reason: string, extra: Partial<JudgeRecallResult> = {}): JudgeRecallResult => ({
    ran: false, reason, goldSetVersion: "", defects: [], rejectedInjections: [], items: [],
    tally: emptyTally(), findingsCount: 0, judgedFiles: [], judgeModel: "", matchModel: cfg.matchModel,
    auditModel: "", sameFamily: false, matcherSample: 0, matcherDisagreement: null,
    matcherNoOpinion: null, limitations: [], note: reason,
    ...extra,
  });
  if (!judgeRecallEnabled()) return empty("SPEC_JUDGE_RECALL != on");
  if (!args.projectId || !args.specHash) return empty("projeto ou spec sem hash");
  const files = args.files.filter((f) => f.path && f.content);
  if (files.length === 0) return empty("spec sem arquivos legíveis");

  // 1. INJEÇÃO — decisão 100% do agente; o código só recusa o que não é verbatim.
  const alvo = args.judgedFilesHint?.length
    ? files.filter((f) => args.judgedFilesHint!.includes(f.path))
    : files;
  if (alvo.length === 0) return empty("nenhum arquivo da spec chegou integral ao juiz — injetar aqui mediria cobertura, não recall (GAP-97)");
  const inj = await callPolicyAgent({
    system: INJECT_SYSTEM,
    user: [
      `ESPECIFICAÇÃO REAL — ${alvo.length} arquivo(s). Injete ${cfg.defects} defeitos.`,
      "",
      ...alvo.map((f) => `=== ARQUIVO: ${f.path} (${f.content.length} chars) ===\n${f.content.slice(0, cfg.injectChars)}`),
    ].join("\n\n"),
    maxTokens: cfg.injectTokens,
    ...(cfg.injectModel ? { modelId: cfg.injectModel } : {}),
    llm: args.llm,
  });
  if (!inj.ok) return empty(`injetor indisponível: ${inj.why}`);
  const parsedInj = parseListResponse(inj.text, "defects");
  if (!parsedInj || parsedInj.length === 0) return empty("injetor sem JSON legível");
  const { defects, rejected } = parseInjections(parsedInj, alvo);
  if (defects.length === 0) {
    return empty(`nenhuma injeção verbatim aproveitável (${rejected.length} recusada(s): ${rejected.map((r) => r.reason).slice(0, 3).join("; ")})`,
      { rejectedInjections: rejected });
  }
  const aplicado = applyInjections(files, defects);
  const usados = aplicado.applied;
  const recusados = [...rejected, ...aplicado.rejected];
  if (usados.length === 0) return empty("nenhuma mutação pôde ser aplicada ao corpus", { rejectedInjections: recusados });
  const version = goldSetVersion(alvo, usados);

  // 2. O JUIZ REAL sobre o texto mutado.
  const { buildValidationInput } = await import("./specValidationInput.js");
  const input = buildValidationInput(aplicado.files.map((f) => ({ path: f.path, content: f.content })));
  const juiz = await judgeMutatedSpec({ specText: input.text, projectId: args.projectId, llm: args.llm, cfg });
  if (juiz.error && juiz.findings.length === 0) {
    return empty(`o juiz não produziu parecer: ${juiz.error}`, { goldSetVersion: version, defects: usados, rejectedInjections: recusados });
  }

  // 3. O CASADOR (outra família) e a estimativa do erro dele.
  const judgeModel = String((args.llm?.model_id ?? args.llm?.modelId ?? "") || "").trim();
  const cas = await callPolicyAgent({
    system: MATCH_SYSTEM, user: matchUserMessage(usados, juiz.findings),
    maxTokens: cfg.matchTokens, modelId: cfg.matchModel, llm: args.llm,
  });
  // GAP-98: a família sai do modelo que RESPONDEU, nunca do que foi pedido. A primeira medição em prod
  // pediu Nova Pro, rodou opus-5 (o modelo do juiz) e publicou `same_family = false` — a única coisa
  // que a frente inteira precisa garantir, negada pelos próprios bytes e afirmada pelo relatório.
  const matchModel = cas.ok ? (cas.modelUsedRaw || cfg.matchModel) : cfg.matchModel;
  const familia = sameFamily(judgeModel, matchModel);
  const rawMatches = cas.ok ? (parseListResponse(cas.text, "matches") ?? []) : [];
  const items = normalizeMatches(rawMatches, usados, juiz.findings, input.full);
  const tally = recallTally(items);
  const auditoria = await auditMatches({
    items, defects: usados, findings: juiz.findings, judgedFiles: input.full,
    model: cfg.auditModel, llm: args.llm, cfg,
  }).catch((e) => ({ sample: 0, disagreement: null as number | null, noOpinion: null as number | null, why: String(e).slice(0, 200), modelUsed: "" }));

  const limitations = recallLimitations({
    tally, sameFamily: familia, judgeModel, matchModel,
    matcherDisagreement: auditoria.disagreement, matcherNoOpinion: auditoria.noOpinion,
    auditSample: auditoria.sample, auditModel: auditoria.modelUsed, rejected: recusados.length,
    priorClaim: items.filter((i) => i.reason === "finding já casado com outro defeito").length,
  });
  if (!cas.ok) limitations.unshift(`casador indisponível (${cas.why}) — todos os defeitos ficaram sem casamento conferido, o que DEPRIME o recall`);

  const res: JudgeRecallResult = {
    ran: true, goldSetVersion: version, defects: usados, rejectedInjections: recusados, items, tally,
    findingsCount: juiz.findings.length, judgedFiles: input.full,
    judgeModel: judgeModel || "modelo do tenant", matchModel: cas.ok ? cas.model : cfg.matchModel,
    auditModel: auditoria.modelUsed,
    sameFamily: familia, matcherSample: auditoria.sample, matcherDisagreement: auditoria.disagreement,
    matcherNoOpinion: auditoria.noOpinion,
    limitations, note: "",
  };
  res.note = recallNote(tally, limitations);

  if (!args.evaluateOnly) {
    await db.query(
      `INSERT INTO spec_judge_recall_runs
         (project_id, spec_hash, gold_set_version, judge_model, match_model, same_family,
          injected, eligible, found, partial_matches, missed, undecided, uncovered,
          recall_min, recall_max, findings_count, matcher_sample, matcher_disagreement,
          note, limitations, defects, items, strata, autonomy_run_id, audit_model, matcher_no_opinion)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::jsonb,$22::jsonb,$23::jsonb,$24,$25,$26)
       ON CONFLICT (project_id, spec_hash, gold_set_version, judge_model) DO UPDATE SET
         match_model = EXCLUDED.match_model, same_family = EXCLUDED.same_family,
         audit_model = EXCLUDED.audit_model, matcher_no_opinion = EXCLUDED.matcher_no_opinion,
         injected = EXCLUDED.injected, eligible = EXCLUDED.eligible, found = EXCLUDED.found,
         partial_matches = EXCLUDED.partial_matches, missed = EXCLUDED.missed,
         undecided = EXCLUDED.undecided, uncovered = EXCLUDED.uncovered,
         recall_min = EXCLUDED.recall_min, recall_max = EXCLUDED.recall_max,
         findings_count = EXCLUDED.findings_count, matcher_sample = EXCLUDED.matcher_sample,
         matcher_disagreement = EXCLUDED.matcher_disagreement, note = EXCLUDED.note,
         limitations = EXCLUDED.limitations, defects = EXCLUDED.defects, items = EXCLUDED.items,
         strata = EXCLUDED.strata, created_at = now()`,
      [args.projectId, args.specHash, version, res.judgeModel, res.matchModel, familia,
       tally.injected, tally.eligible, tally.found, tally.partial, tally.missed, tally.undecided,
       tally.uncovered, tally.recallMin, tally.recallMax, juiz.findings.length,
       auditoria.sample, auditoria.disagreement, res.note, JSON.stringify(limitations),
       JSON.stringify(usados), JSON.stringify(items),
       JSON.stringify({
         byClass: tally.byClass, byDifficulty: tally.byDifficulty, byPosition: tally.byPosition,
         byScope: tally.byScope, byVocabulary: tally.byVocabulary,
       }),
       args.autonomyRunId ?? null, res.auditModel, auditoria.noOpinion],
    ).catch((err) => {
      // Gravar é ACESSÓRIO à medição: nunca derruba o número que acabou de ser produzido.
      console.warn(`[specJudgeRecall] persistência falhou: ${String(err).slice(0, 300)}`);
    });
  }
  return res;
}
