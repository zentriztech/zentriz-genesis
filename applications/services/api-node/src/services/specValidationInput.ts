/**
 * GAP-10 (2026-09-06) — o validador julgava 27% da spec e reprovava os outros 73% por "ausência".
 *
 * ## O que foi medido (NVX LastMile – Backend, prod, run de validação `18111140`)
 *
 * A spec tem **12 arquivos / 747.170 chars**. O estágio B mandava
 * `spec_text: specText.slice(0, 200_000)` — um corte **silencioso** no meio do 5º arquivo. O validador
 * então relatou, corretamente para o que viu e falsamente para o que existe:
 *
 * ```
 * blocker: "Spec entregue viola o próprio gate de completude: 9 dos 12 arquivos obrigatórios estão ausentes"
 * blocker: "Catálogo fechado de 26 códigos é declarado fonte única mas não está presente na spec entregue"
 * blocker: "Inventário FR/NFR/RN declarado fonte única e fechada está ausente"
 * blocker: "Documento de Definição de Pronto está truncado, reprovando-se por construção"
 * ```
 *
 * Os quatro são FANTASMAS: `contratos-erros.md` (74.196 chars) e `definicao-de-pronto.md` (87.631)
 * existem, íntegros, no disco. E o ciclo é vicioso: o CTO-editor "resolve" o fantasma ACRESCENTANDO
 * conteúdo aos arquivos que o validador vê, o que empurra ainda mais texto para além do corte e
 * produz MAIS fantasmas na rodada seguinte. Foi assim que a contagem de GAPs importantes subiu
 * 17 → 22 no passe que finalmente revisou `modelo-dados.md`.
 *
 * ## A regra que este módulo implementa
 *
 * A mesma do A5.7, aplicada à outra ponta: **cortar é aceitável, mentir sobre o corte não é.**
 *
 *  1. o INVENTÁRIO COMPLETO vai sempre — todos os arquivos, com tamanho e marca de tratamento;
 *  2. cabe INTEGRAL ⇒ vai integral (prioridade por tamanho crescente: maximiza quantos arquivos o
 *     validador vê por inteiro, e é critério de FATO, não julgamento de conteúdo);
 *  3. não cabe ⇒ vai o SUMÁRIO DE CABEÇALHOS do arquivo, marcado como tal;
 *  4. a regra "arquivo em SÓ SUMÁRIO **existe**; é proibido reportá-lo como ausente/truncado" vai
 *     escrita no prompt, porque é exatamente o erro que ele cometeu.
 *
 * O que este módulo NÃO faz: escolher o que é relevante, resumir prosa ou decidir severidade. Ele
 * transporta fatos (existe / tamanho / cabeçalhos) e o julgamento continua 100% do agente.
 */
import { splitSections, headingOutline } from "../lib/markdownSections.js";

/**
 * Teto de entrada do estágio B (era um `slice` mudo dentro do `runStageB`).
 *
 * 🔴 GAP-18 (2026-09-06) — os 200.000 originais eram um número tirado do ar, e ERRAVAM a unidade: o
 * teto é em CHARS, a janela do modelo é em TOKENS. Markdown em PT-BR fica em ~3,5 chars/token, então
 * 200.000 chars ≈ 57k tokens de uma janela de ~200k — o validador descartava ~70% da própria
 * capacidade. Medido em prod na spec do NVX LastMile (12 arquivos, 950.965 chars): **2** arquivos
 * julgados por inteiro, 10 só em sumário, rodada após rodada.
 *
 * Aritmética do teto atual: 400.000 chars ÷ 3,5 ≈ 114k tokens de entrada + 32k de saída
 * (`_refuter_max_tokens`) ≈ 146k — dentro da janela de 200k com folga para o system prompt e para
 * português mais denso que a média. Subir mais exige medir tokens de verdade, não chutar chars.
 * `SPEC_VALIDATION_INPUT_CAP` (env) sobrepõe, para spec grande com modelo de janela maior.
 */
export const VALIDATION_INPUT_CAP = (() => {
  const raw = parseInt((process.env.SPEC_VALIDATION_INPUT_CAP ?? "").trim(), 10);
  return Number.isFinite(raw) && raw >= 50_000 ? raw : 400_000;
})();
/** Teto do sumário de UM arquivo, para um arquivo com centenas de seções não comer o inventário. */
export const VALIDATION_OUTLINE_CAP = 6_000;

export interface ValidationInputFile {
  /** Caminho relativo como o validador deve citá-lo (`rel_dir/filename`). */
  path: string;
  content: string;
  /**
   * GAP-18: este arquivo JÁ foi julgado integralmente pelo estágio adversarial **neste conteúdo**
   * (`project_spec_files.stage_b_full_sha` == sha atual). Quem ainda não foi julgado entra primeiro
   * na promoção a integral — é o que faz a cobertura ROTACIONAR em vez de repetir os mesmos arquivos.
   * Ausente/false = ainda não julgado.
   */
  judged?: boolean;
  /**
   * GAP-42: instante da última ESCRITA deste arquivo (o snapshot mais recente da migração 092), ISO.
   * Só é consultado quando `judged !== true` — aí ele significa "há trabalho escrito aqui que ninguém
   * julgou desde então", e a fila dos não julgados vira FIFO por esse instante (o mais antigo primeiro).
   * Ausente/null = não sei quando foi escrito ⇒ o arquivo cai atrás dos datados, na ordem de tamanho
   * (comportamento legado, byte-idêntico).
   */
  pendingSince?: string | null;
}

export interface ValidationInput {
  /** Texto final para `spec_text` — já dentro do teto, sem corte cego. */
  text: string;
  /** Arquivos enviados por inteiro. */
  full: string[];
  /** Arquivos enviados apenas como sumário de cabeçalhos. */
  outlineOnly: string[];
  /** Soma dos tamanhos de TODOS os arquivos (o que a spec realmente tem). */
  totalChars: number;
  /** Teto usado (vai para `stage_b_coverage`: sem ele o registro não é interpretável depois). */
  cap: number;
  /**
   * GAP-19: arquivos que NÃO cabem integralmente nem sozinhos (nem com todos os outros em sumário).
   * Rotação nenhuma resolve isso — o arquivo precisa ser DIVIDIDO. Sem este fato o laço autônomo
   * revalidaria para sempre esperando uma cobertura que não pode acontecer.
   */
  oversized: string[];
}

function outlineOf(content: string): string {
  const o = headingOutline(splitSections(content));
  return o.length > VALIDATION_OUTLINE_CAP
    ? `${o.slice(0, VALIDATION_OUTLINE_CAP)}\n[… sumário truncado …]`
    : o;
}

function inventory(
  files: ValidationInputFile[],
  fullSet: Set<string>,
  totalChars: number,
  cut: boolean,
): string {
  const lines = files.map((f) => {
    const mark = fullSet.has(f.path) ? "INTEGRAL" : "SÓ SUMÁRIO";
    return `  • \`${f.path}\` — ${f.content.length} chars — ${mark}`;
  });
  const head = [
    `[INVENTÁRIO DA SPEC — ${files.length} arquivo(s), ${totalChars} chars no total.`,
    "Todos os arquivos listados abaixo EXISTEM no repositório da spec.]",
    "",
    ...lines,
  ];
  if (!cut) return head.join("\n");
  return [
    ...head,
    "",
    "[REGRAS DESTA VALIDAÇÃO — a spec não cabe inteira na janela desta chamada:",
    "  • os arquivos marcados `SÓ SUMÁRIO` vão apenas com a lista de cabeçalhos. Eles EXISTEM e estão",
    "    ÍNTEGROS: é PROIBIDO reportá-los como ausentes, faltando, truncados ou não entregues;",
    "  • também é proibido concluir que uma definição não existe só porque você não a viu: se ela",
    "    deveria estar num arquivo `SÓ SUMÁRIO`, isso NÃO é achado — não relate;",
    "  • reporte apenas contradições que você possa APONTAR em texto presente aqui, citando o arquivo;",
    "  • um cabeçalho no sumário é evidência de que a seção existe.]",
  ].join("\n");
}

/**
 * Monta o `spec_text` do estágio B respeitando o teto SEM esconder o que ficou de fora.
 *
 * Estratégia de orçamento: parte do pior caso (todos os arquivos em sumário, que é o que garante o
 * inventário) e vai PROMOVENDO arquivos a integral enquanto couber, em DUAS FILAS:
 *
 *   1ª fila — arquivos AINDA NÃO julgados integralmente no conteúdo atual (`judged !== true`),
 *             em FIFO pelo instante da última escrita (`pendingSince`); sem data, por tamanho;
 *   2ª fila — os já julgados, que só entram se sobrar orçamento, do menor para o maior.
 *
 * A 1ª fila é o que corrige o GAP-18: sem ela a ordem por tamanho é determinística e os arquivos
 * grandes NUNCA são julgados — a cobertura fica congelada nos mesmos arquivinhos e "GAPs = 0" passa a
 * significar "0 GAPs no pedaço que eu olhei".
 *
 * ## GAP-42 (2026-09-07) — por que DENTRO da 1ª fila a ordem deixou de ser por tamanho
 *
 * "Menor primeiro" maximiza QUANTOS arquivos o validador vê por inteiro, mas escolhe sempre os
 * mesmos: os maiores só entram quando não há nenhum menor pendente. E o laço autônomo corrige
 * primeiro os arquivos com MAIS blockers — que são justamente os maiores. O resultado medido em prod
 * (NVX LastMile, run de autonomia `5d377da0`, passe 0) é que a validação que MEDE o passe julga tudo
 * MENOS o que o passe acabou de escrever:
 *
 * ```
 * passe 0 reescreveu: privacidade-lgpd(96k) modelo-dados(183k) README(77k)
 *                     definicao-de-pronto(94k) visao-escopo(62k) observabilidade(89k)
 * validação 525b22f5 julgou por INTEIRO: README, observabilidade, visao-escopo,
 *                     definicao-de-pronto, nvx-lastmile-backend   ← os 2 GIGANTES ficaram de fora
 * ```
 *
 * Consequência provada finding a finding: os 15 GAPs importantes de `privacidade-lgpd.md` ficaram
 * **byte-a-byte idênticos** antes e depois de o arquivo ser reescrito — ninguém os rejulgou, então
 * `absentRuns` continuou 0 e nenhum pôde fechar. Enquanto isso a validação achava GAPs novos nos
 * arquivos que o passe NÃO tocou, e a contagem só subia (36 → 44). O laço pagava LLM para escrever e
 * media outra coisa.
 *
 * FIFO por `pendingSince` conserta isso com um FATO (quando foi escrito), não com julgamento: quem
 * está esperando medição há mais tempo entra na frente, ninguém é preterido para sempre e, depois de
 * julgado, o arquivo vai para o fim da fila naturalmente. Preço declarado: um gigante consome o
 * orçamento de ~3 arquivos médios, então cabem MENOS arquivos por validação — o que se ganha é que os
 * que entram são os que têm trabalho novo dentro.
 */
export function buildValidationInput(
  files: ValidationInputFile[],
  cap: number = VALIDATION_INPUT_CAP,
): ValidationInput {
  const totalChars = files.reduce((n, f) => n + f.content.length, 0);
  const outlines = new Map(files.map((f) => [f.path, outlineOf(f.content)]));
  const header = (fullSet: Set<string>, cut: boolean) => inventory(files, fullSet, totalChars, cut);

  // Custo de cada arquivo nas duas formas (inclui a moldura `===== path =====`).
  const frame = (f: ValidationInputFile, full: boolean) =>
    full
      ? `===== ${f.path} =====\n${f.content}`
      : `===== ${f.path} — SÓ SUMÁRIO (arquivo EXISTE, ${f.content.length} chars) =====\n${outlines.get(f.path) ?? ""}`;

  const fullSet = new Set<string>();
  const baseline = header(fullSet, true).length + files.reduce((n, f) => n + frame(f, false).length + 2, 0);
  let spent = baseline;

  // GAP-19: quem não cabe nem SOZINHO (pior caso + só o seu delta) nunca será julgado por rotação.
  const oversized = files
    .filter((f) => baseline + (frame(f, true).length - frame(f, false).length) > cap)
    .map((f) => f.path);

  const bySize = (a: ValidationInputFile, b: ValidationInputFile) => a.content.length - b.content.length;
  // GAP-42: FIFO da medição pendente. Quem tem data de escrita vem antes de quem não tem (não datado
  // não é "escrito agora", é "não sei" — e chutar que é antigo furaria a fila de quem tem prova).
  const pending = (f: ValidationInputFile) => (typeof f.pendingSince === "string" && f.pendingSince ? f.pendingSince : null);
  const byPendingThenSize = (a: ValidationInputFile, b: ValidationInputFile) => {
    const pa = pending(a), pb = pending(b);
    if (pa && pb) return pa < pb ? -1 : pa > pb ? 1 : bySize(a, b);
    if (pa) return -1;
    if (pb) return 1;
    return bySize(a, b);
  };
  const naoJulgados = files.filter((f) => f.judged !== true).sort(byPendingThenSize);
  const jaJulgados = files.filter((f) => f.judged === true).sort(bySize);
  for (const f of [...naoJulgados, ...jaJulgados]) {
    const delta = frame(f, true).length - frame(f, false).length;
    if (spent + delta > cap) continue;
    spent += delta;
    fullSet.add(f.path);
  }

  const cut = fullSet.size < files.length;
  const body = files.map((f) => frame(f, fullSet.has(f.path))).join("\n\n");
  const text = `${header(fullSet, cut)}\n\n${body}`;

  return {
    // Rede de segurança: se até o pior caso estourar o teto (spec absurda), o corte volta a existir —
    // mas agora depois do inventário, que é a parte que impede o falso "ausente".
    text: text.length > cap ? `${text.slice(0, cap)}\n[… corte por teto de janela …]` : text,
    full: files.filter((f) => fullSet.has(f.path)).map((f) => f.path),
    outlineOnly: files.filter((f) => !fullSet.has(f.path)).map((f) => f.path),
    totalChars,
    cap,
    oversized,
  };
}
