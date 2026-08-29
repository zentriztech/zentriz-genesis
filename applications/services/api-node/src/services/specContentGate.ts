/**
 * specContentGate.ts — gate de CONTEÚDO da spec para iniciar um projeto.
 *
 * Motivo (incidente Cabral 2026-08-29): a Bancada permite promover para a fábrica um
 * spec que ainda é o GUIA-TEMPLATE em branco (placeholders). O validador de intake do
 * runner só checa *presença* de `FR-NN` + Gherkin (DADO/QUANDO/ENTÃO) — e o template tem
 * cabeçalhos `### FR-01 — [título do requisito]` + `DADO [pré-condição]`, que satisfazem
 * a regex. Resultado: o spec vazio passa intake/readiness, roda a fábrica cara inteira
 * (~1076s) e termina em `blocked_backlog_empty_with_frs` com 0 tarefas — falha confusa e
 * cara para o cliente.
 *
 * Este gate barra o template NA PORTA (custo ZERO de LLM), com mensagem acionável, e é
 * chamado tanto pelo `/run` interativo (pipeline.ts) quanto pela cascata/promoção
 * (runnerDispatch.ts) — os dois pontos por onde um projeto vira `running`.
 *
 * Regra de detecção (baixo falso-positivo): um spec REAL não contém títulos de FR entre
 * colchetes, nem cláusulas Gherkin entre colchetes, nem os sentinelas do guia. Diagramas
 * Mermaid usam `[Label]`, então NUNCA contamos colchetes soltos — só os padrões ancorados
 * abaixo, que só ocorrem em template não preenchido.
 */

export interface SpecContentBlock {
  code: "SPEC_PLACEHOLDER_TEMPLATE";
  message: string;
  /** Sinais detectados (para log/telemetria e para exibir no portal). */
  signals: string[];
}

export type SpecContentResult = { ok: true } | { ok: false; block: SpecContentBlock };

/** Frases-sentinela do GUIA-TEMPLATE / rascunho vazio (o próprio texto se declara template). */
const GUIDE_SENTINELS: RegExp[] = [
  /GUIA-?TEMPLATE/i,
  /RASCUNHO\s+VAZIO/i,
  /aguardando\s+(a\s+)?descri[çc][ãa]o\s+do\s+produto/i,
  /substituindo\s+os\s+campos\s+entre\s+colchetes/i,
  /Como\s+usar\s+este\s+guia/i,
  /Este\s+documento\s+[ée]\s+um\s+GUIA/i,
  /Nenhum\s+requisito\s+foi\s+preenchido/i,
];

/** Cabeçalho de FR cujo TÍTULO ainda é placeholder: "### FR-01 — [título do requisito]". */
const PLACEHOLDER_FR_HEADING = /(?:^|\n)\s{0,3}#{1,4}\s*FR-\d+\s*[—:\-]?\s*\[[^\]\n]*\]/gi;

/** Cláusula Gherkin cujo corpo ainda é placeholder: "DADO [pré-condição]", "QUANDO [ação]". */
const PLACEHOLDER_GHERKIN = /(?:^|\n)\s*(?:DADO|QUANDO|ENT[ÃA]O|GIVEN|WHEN|THEN)\b\s*\[[^\]\n]*\]/gi;

/** Nome do produto ainda não informado: "**Produto:** [..." ou "UNKNOWN"/"TBD". */
const PRODUCT_PLACEHOLDER = /\*\*\s*Produto\s*:?\s*\*\*\s*(?:\[|UNKNOWN\b|TBD\b|a\s+definir\b)/i;

/** project_type ainda como o menu do template: "project_type:** [frontend_web | backend_api | ...]". */
const PROJECT_TYPE_MENU = /project_type\s*:?\s*\*{0,2}\s*\[\s*frontend_web\s*\|/i;

/** Contagem de tokens explícitos TBD:/UNKNOWN: (marcadores do esqueleto). */
function countUnfilledTokens(text: string): number {
  const m = text.match(/\b(?:TBD|UNKNOWN)\s*:/gi);
  return m ? m.length : 0;
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

/**
 * Verifica se o conteúdo do spec ainda é um template/rascunho vazio.
 *
 * Bloqueia quando QUALQUER um destes for verdadeiro:
 *   - contém uma frase-sentinela de guia; OU
 *   - tem ≥1 cabeçalho de FR com título entre colchetes (placeholder); OU
 *   - o nome do produto ainda é placeholder/UNKNOWN/TBD; OU
 *   - o project_type ainda é o menu do template; OU
 *   - tem ≥2 cláusulas Gherkin entre colchetes; OU
 *   - tem ≥3 tokens TBD:/UNKNOWN:.
 *
 * Um spec real (títulos de FR reais, cláusulas Gherkin reais, produto nomeado) passa.
 */
export function checkSpecContentReady(specText: string | null | undefined): SpecContentResult {
  const text = (specText ?? "").trim();
  if (!text) {
    return {
      ok: false,
      block: {
        code: "SPEC_PLACEHOLDER_TEMPLATE",
        message:
          "A especificação está vazia. Descreva o produto na Bancada (visão, personas, requisitos funcionais reais) antes de iniciar a fábrica.",
        signals: ["spec_vazia"],
      },
    };
  }

  const signals: string[] = [];

  if (GUIDE_SENTINELS.some((re) => re.test(text))) signals.push("sentinela_guia_template");

  const frPlaceholders = countMatches(text, PLACEHOLDER_FR_HEADING);
  if (frPlaceholders >= 1) signals.push(`fr_titulo_placeholder(${frPlaceholders})`);

  if (PRODUCT_PLACEHOLDER.test(text)) signals.push("produto_placeholder");
  if (PROJECT_TYPE_MENU.test(text)) signals.push("project_type_menu");

  const gherkinPlaceholders = countMatches(text, PLACEHOLDER_GHERKIN);
  if (gherkinPlaceholders >= 2) signals.push(`gherkin_placeholder(${gherkinPlaceholders})`);

  const unfilled = countUnfilledTokens(text);
  if (unfilled >= 3) signals.push(`tokens_tbd_unknown(${unfilled})`);

  if (signals.length === 0) return { ok: true };

  return {
    ok: false,
    block: {
      code: "SPEC_PLACEHOLDER_TEMPLATE",
      message:
        "A especificação ainda é um rascunho/modelo em branco — os requisitos não foram preenchidos " +
        "(títulos entre colchetes como “[título do requisito]”, cláusulas “DADO […]”, ou o produto ainda como TBD/UNKNOWN). " +
        "Volte à Bancada e descreva o produto (o que faz, para quem, requisitos funcionais reais com critérios de aceite) " +
        "antes de iniciar a fábrica. Isso evita um ciclo completo do pipeline que terminaria sem tarefas.",
      signals,
    },
  };
}
