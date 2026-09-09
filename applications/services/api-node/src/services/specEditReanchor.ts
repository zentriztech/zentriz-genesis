/**
 * 🔴 GAP-170 (2026-09-09) — a rodada cuja EDIÇÃO NÃO ANCORA morre perdendo o passe inteiro.
 *
 * ## O que foi MEDIDO em prod (NVX LastMile `e2a1988c`, 954 rodadas em `spec_autonomy_runs.rounds`)
 *
 * ```
 * 954 rodadas · 818 aplicadas (85,7%) · 122 vetadas
 *    7 vetadas com "A IA devolveu edições que não puderam ser ancoradas — nada foi alterado"
 *      (a mais recente em 2026-09-09 15:36, logo DEPOIS do GAP-26 ⇒ não é resíduo antigo)
 * ```
 *
 * Sete passes de Opus 5 (~145k chars de entrada cada, ver o censo do GAP-146) descartados **inteiros**.
 * E as âncoras recusadas dizem qual é o defeito de verdade — duas rodadas seguidas do mesmo arquivo:
 *
 * ```
 * âncora: "> - **MTOK-AGE-01 — Identificação observável do segredo (normativo).**…"
 * âncora: "> **MTOK-AGE-01 — Identificação observável do segredo (normativo).** `…"
 * ```
 *
 * O modelo estava **acertando o conteúdo e errando os bytes** — aqui, um marcador de lista (`- `) a
 * mais. O arquivo tem a linha; o `SEARCH` não casa por um caractere invisível de formatação.
 *
 * ## A diferença concreta com o Claude Code (o pedido do Jean)
 *
 * A ferramenta `Edit` do Claude Code falha com erro preciso e **o modelo corrige no MESMO turno**.
 * A Bancada, no mesmo cenário, joga fora ~145k chars e espera a próxima rodada — que reofertará o
 * mesmo arquivo e provavelmente errará de novo (foi o que os 7 casos mostram, 5 no mesmo arquivo).
 *
 * ## O que este módulo faz — e o que NÃO faz (Lei: Genesis é 100% LLM)
 *
 * Faz UMA coisa: localiza no arquivo REAL as linhas que se aproximam da âncora que falhou e as
 * devolve **VERBATIM**, com número de linha e dizendo QUAL diferença fez o casamento falhar. É
 * transporte de fato, exatamente como um `Read` do arquivo — os bytes são do arquivo, não meus.
 *
 * NÃO faz: não conserta o bloco, não escolhe âncora, não reescreve `SEARCH`, não aplica nada e não
 * decide o que corrigir. Se o código "consertasse" a âncora, estaria decidindo conteúdo de spec —
 * proibido, e é a mesma linha que `specFileEdits` já respeita ("só TRANSPORTA e VETA corrupção").
 *
 * ## A disciplina que impede isto de virar queima de token
 *
 * A retentativa só acontece quando **este módulo encontrou pelo menos um trecho verbatim** — isto é,
 * quando o código tem um FATO NOVO para entregar. Sem fato novo, repetir o pedido seria pagar outra
 * chamada para receber a mesma resposta (o defeito que o GAP-29 mediu: Opus pago 3× pela MESMA
 * resposta). Nesse caso a rodada falha como hoje, sem gasto extra.
 *
 * Consequência: o custo máximo é **uma** chamada extra em ~0,7% das rodadas (7 de 954), e só onde a
 * rodada já estava 100% perdida. O fato vai **NO FIM** do `user_message` de propósito: o prefixo
 * (`prompt_override` + cabeça estável) continua byte a byte igual e o cache de prompt do GAP-142
 * segue valendo — anexar no meio jogaria fora o desconto de leitura de 0,1×.
 */

/** Uma linha do arquivo REAL que se aproxima da âncora recusada. */
export interface NearMiss {
  /** Linha 1-based no conteúdo base — o mesmo endereço que o agente vê ao ler o arquivo. */
  line: number;
  /** Texto do ARQUIVO, verbatim (nunca normalizado): é isto que o `SEARCH` tem de conter. */
  verbatim: string;
  /** Que diferença fez o casamento falhar. Declarado para o agente saber o que corrigir. */
  difference: string;
}

/** Níveis de normalização, do mais inocente ao mais agressivo. A ordem É a mensagem. */
const LEVELS: Array<{ name: string; apply: (s: string) => string }> = [
  { name: "indentação ou espaço no fim da linha", apply: (s) => s.trim() },
  {
    // O caso MEDIDO em prod: `> - **MTOK-AGE-01` contra `> **MTOK-AGE-01`.
    name: "marcador de lista ou de citação no início da linha (`-`, `*`, `>`, `1.`)",
    apply: (s) => s.replace(/^[\s>]*(?:[-*+]\s+|\d+[.)]\s+)?/, "").trim(),
  },
  { name: "quantidade de espaços DENTRO da linha", apply: (s) => s.trim().replace(/\s+/g, " ") },
  {
    name: "acentuação ou caixa (maiúscula/minúscula)",
    apply: (s) => s.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().trim().replace(/\s+/g, " "),
  },
];

/** Aplica os níveis 0..i acumulados — o nível 2 também tolera o que o 1 tolerava. */
function normalizeUpTo(s: string, level: number): string {
  let out = s;
  for (let i = 0; i <= level; i += 1) out = LEVELS[i].apply(out);
  return out;
}

/** Primeira linha não vazia da âncora — é ela que endereça o trecho. */
export function anchorProbe(search: string): string {
  return search.replace(/\r\n/g, "\n").split("\n").find((l) => l.trim()) ?? "";
}

/**
 * Localiza no arquivo as linhas que casariam com a âncora sob alguma tolerância.
 *
 * Sobe a escada de normalização e PARA no primeiro nível que produz resultado: o nível mais inocente
 * que explica a falha é o diagnóstico mais útil (e o menos sujeito a casar por acidente). Uma âncora
 * curta demais não é procurada — casaria em dezenas de linhas e o "fato" seria ruído.
 */
export function nearMissesFor(base: string, search: string, opts: { max?: number } = {}): NearMiss[] {
  const max = opts.max ?? 3;
  const probe = anchorProbe(search);
  // Menos de 12 chars úteis não endereça nada num arquivo de 60k+; devolver isso seria ruído.
  if (probe.trim().length < 12) return [];
  const lines = base.replace(/\r\n/g, "\n").split("\n");
  for (let level = 0; level < LEVELS.length; level += 1) {
    const alvo = normalizeUpTo(probe, level);
    if (!alvo) continue;
    const hits: NearMiss[] = [];
    for (let i = 0; i < lines.length && hits.length < max; i += 1) {
      if (normalizeUpTo(lines[i], level) === alvo) {
        hits.push({ line: i + 1, verbatim: lines[i], difference: LEVELS[level].name });
      }
    }
    if (hits.length > 0) return hits;
  }
  return [];
}

/** Uma edição recusada, do ponto de vista deste módulo. */
export interface FailedAnchor {
  /** Índice 0-based do bloco, como o aplicador numera. */
  index: number;
  /** O texto que o agente pediu para casar. */
  search: string;
  /** A mensagem que o aplicador já produziu (não reescrita aqui). */
  message: string;
}

export interface ReanchorFacts {
  /** Bloco pronto para ser anexado ao FIM do `user_message`. */
  text: string;
  /** Quantas âncoras recusadas ganharam trecho verbatim. Zero ⇒ este objeto não é produzido. */
  located: number;
  /** Quantas âncoras recusadas ficaram sem nenhum trecho aproximado. */
  unlocated: number;
  /** O que ficou de fora por teto — declarado, nunca cortado em silêncio (GAP-128). */
  truncated: string[];
}

/** Tetos do bloco de fato. Pequenos de propósito: é diagnóstico, não uma segunda cópia do arquivo. */
const MAX_ANCHORS_IN_BLOCK = 6;
const MAX_VERBATIM_CHARS = 240;

function cut(s: string): string {
  return s.length <= MAX_VERBATIM_CHARS ? s : `${s.slice(0, MAX_VERBATIM_CHARS)}… (linha cortada em ${MAX_VERBATIM_CHARS} chars)`;
}

/**
 * Monta o bloco de fatos da retentativa — ou devolve `null` quando não há fato novo a dar.
 *
 * `null` é a decisão de NÃO gastar: sem nenhum trecho verbatim localizado, a retentativa receberia o
 * mesmo pedido de antes e (medido no GAP-29) devolveria a mesma resposta. Melhor falhar como hoje.
 *
 * `digested` NÃO habilita a retentativa por si — mas quando ela acontece, é dito ao agente, porque a
 * âncora inexistente pode estar num trecho que ele nunca recebeu, e nesse caso o certo é ele
 * DECLARAR o GAP como não corrigido em vez de inventar âncora.
 */
export function buildReanchorFacts(
  base: string,
  failures: FailedAnchor[],
  opts: { digested?: boolean } = {},
): ReanchorFacts | null {
  const truncated: string[] = [];
  const considered = failures.slice(0, MAX_ANCHORS_IN_BLOCK);
  if (failures.length > considered.length) {
    truncated.push(`${failures.length - considered.length} âncora(s) recusada(s) além das ${MAX_ANCHORS_IN_BLOCK} primeiras não estão neste bloco`);
  }
  const partes: string[] = [];
  let located = 0;
  let unlocated = 0;
  for (const f of considered) {
    const hits = nearMissesFor(base, f.search);
    if (hits.length === 0) {
      unlocated += 1;
      partes.push(
        `— Edição ${f.index + 1}: nenhuma linha do arquivo se aproxima desta âncora.\n`
        + `  âncora pedida: ${JSON.stringify(cut(anchorProbe(f.search)))}`,
      );
      continue;
    }
    located += 1;
    const linhas = hits
      .map((h) => `  linha ${h.line} do arquivo, VERBATIM: ${JSON.stringify(cut(h.verbatim))}`)
      .join("\n");
    partes.push(
      `— Edição ${f.index + 1}: a única diferença é ${hits[0].difference}.\n`
      + `  âncora pedida: ${JSON.stringify(cut(anchorProbe(f.search)))}\n${linhas}`
      + (hits.length >= 3 ? "\n  (há mais linhas parecidas; só as 3 primeiras estão aqui)" : ""),
    );
  }
  // A regra que impede isto de virar queima de token: sem fato novo, não há retentativa.
  if (located === 0) return null;

  const text = [
    "",
    "=== FATO: A TENTATIVA ANTERIOR NÃO PÔDE SER APLICADA (releitura do arquivo REAL) ===",
    "",
    "Nenhuma das suas edições ancorou no arquivo, então NADA foi alterado — o arquivo continua",
    "exatamente como está no bloco de conteúdo acima. O conteúdo do que você propôs não está em",
    "questão: o que falhou foi o texto do `SEARCH` não ser byte a byte igual ao do arquivo.",
    "",
    "As linhas abaixo foram lidas do arquivo AGORA e são verbatim. Reemita os blocos usando",
    "exatamente estes bytes no `SEARCH` (copie a linha inteira, incluindo `>`, `-`, indentação e",
    "acentos como aparecem), e inclua linhas de contexto suficientes para a âncora ser ÚNICA:",
    "",
    ...partes,
    "",
    ...(opts.digested === true
      ? [
        "⚠️ Este arquivo é grande e chegou RECORTADO no bloco de conteúdo: existem trechos que você",
        "NÃO recebeu. Se uma âncora sua não aparece acima, provavelmente ela está fora do recorte —",
        "nesse caso NÃO invente âncora: declare aquele GAP como não corrigido e resolva os demais.",
        "",
      ]
      : []),
    ...(truncated.length > 0 ? [`(Fora deste bloco, declarado: ${truncated.join("; ")}.)`, ""] : []),
    "Devolva agora SOMENTE os blocos <<<<<<< SEARCH / ======= / >>>>>>> REPLACE. Não reemita o arquivo.",
  ].join("\n");

  return { text, located, unlocated, truncated };
}

/** Códigos de falha que são da ÂNCORA (o agente pode corrigir relendo) e não do RESULTADO. */
const ANCHOR_CODES = new Set(["SEARCH_NOT_FOUND", "SEARCH_AMBIGUOUS", "EMPTY_SEARCH"]);

/**
 * A retentativa vale a pena para este código de falha?
 *
 * Três ficam de fora, por motivos diferentes e todos deliberados:
 *  • `SHRUNK` fala do RESULTADO (o arquivo esvaziaria) — reancorar não muda isso;
 *  • `MARKER_IN_REPLACE` já traz na própria mensagem a instrução exata do que fazer, e insistir sem
 *    fato novo é o gasto que o GAP-29 proibiu;
 *  • `NO_BLOCKS` não tem bloco nenhum ⇒ não há âncora para reler ⇒ não há fato novo a transportar
 *    (a resposta veio em prosa; o caminho de arquivo inteiro logo abaixo já a aproveita).
 */
export function isReanchorable(code: string): boolean {
  return ANCHOR_CODES.has(code);
}
