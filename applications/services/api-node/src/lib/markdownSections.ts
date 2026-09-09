/**
 * Recorte de Markdown por SEÇÃO — usado por dois caminhos que precisam do MESMO comportamento.
 *
 * Nasceu privado em `services/specSiblingContext.ts` (A5.6, para mostrar o irmão citado sem gastar o
 * orçamento na abertura do arquivo) e foi extraído aqui quando o arquivo ALVO passou a precisar do
 * mesmo recorte (A5.7 / GAP-7). Se as duas cópias divergirem, o modelo vê o irmão com uma régua e o
 * alvo com outra — e um `SEARCH` montado com a régua errada não casa no arquivo, queimando a rodada.
 *
 * Regra que vale para os dois usos: o texto devolvido é sempre trecho VERBATIM do arquivo. É o que
 * permite ao CTO-editor montar blocos `SEARCH/REPLACE` a partir de um recorte — o que ele leu existe
 * no arquivo, byte a byte.
 */

export interface MdSection {
  /** Linha de cabeçalho ATX (`## 3. Erros`) ou `(topo do arquivo)` para o preâmbulo. */
  heading: string;
  /** Corpo VERBATIM, incluindo a própria linha de cabeçalho. */
  body: string;
  /** Nível do cabeçalho ATX (1–6); `0` no preâmbulo. É o que define quem é filho de quem. */
  level: number;
}

const ATX_RE = /^#{1,6}\s+\S/;
/** Abre/fecha cerca de código: 3+ backticks ou 3+ tis, com indentação opcional. */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/**
 * 🔴 GAP-78 — linhas dentro de cerca de código NÃO são cabeçalhos.
 *
 * MEDIDO em prod (NVX LastMile, 12 arquivos): **25 cabeçalhos falsos em 2 arquivos**. Em
 * `definicao-de-pronto.md` o comentário `# 3) paridade do catálogo…` na linha 21, dentro de uma cerca
 * ```bash aberta na linha 13, é lido como `<h1>` — e essa "seção" fantasma engole **96,6% do arquivo**
 * (94.132 de 97.416 chars, 29 subseções). Em `infraestrutura-deploy.md` são 22 comentários de `.env`
 * (`# Servidor`, `# Banco de dados`) que reparentam toda a árvore a partir da linha 267. Com o mapa de
 * seções corrompido, TUDO que depende dele erra junto: o sumário mostrado ao juiz, o recorte do alvo, o
 * recorte do irmão e a medida de trecho intocado.
 *
 * Devolve os intervalos `[abre, fecha]` das cercas FECHADAS. **Cerca que nunca fecha é descartada** — na
 * dúvida, preferir o comportamento antigo (mais cabeçalhos) a engolir em silêncio o resto do arquivo.
 * Fechamento exige o MESMO caractere e comprimento ≥ o da abertura (CommonMark), e nada além do marcador
 * na linha: `` ```ts `` abre, `` ``` `` fecha.
 */
function fencedRanges(lines: string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let open: { at: number; mark: string } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(FENCE_RE);
    if (!m) continue;
    if (open === null) { open = { at: i, mark: m[1] }; continue; }
    const closes = m[1][0] === open.mark[0]
      && m[1].length >= open.mark.length
      && lines[i].trim() === m[1].trim();
    if (closes) { out.push([open.at, i]); open = null; }
  }
  return out;
}

/** Quebra o Markdown em seções por cabeçalho ATX, preservando o cabeçalho em cada pedaço. */
export function splitSections(content: string): MdSection[] {
  const out: MdSection[] = [];
  const lines = content.split("\n");
  const fenced = fencedRanges(lines);
  let fence = 0;
  let heading = "(topo do arquivo)";
  let level = 0;
  let buf: string[] = [];
  const flush = (): void => { if (buf.join("\n").trim()) out.push({ heading, body: buf.join("\n"), level }); };
  for (let i = 0; i < lines.length; i += 1) {
    while (fence < fenced.length && fenced[fence][1] < i) fence += 1;
    const inFence = fence < fenced.length && i > fenced[fence][0] && i < fenced[fence][1];
    if (!inFence && ATX_RE.test(lines[i])) {
      flush();
      heading = lines[i].trim();
      level = (lines[i].match(/^#+/)?.[0].length ?? 0);
      buf = [lines[i]];
      continue;
    }
    buf.push(lines[i]);
  }
  flush();
  return out;
}

/**
 * 🔴 GAP-79 — a âncora endereça a SUBÁRVORE, não o preâmbulo do cabeçalho.
 *
 * MEDIDO em prod: `visao-escopo.md §1.3` é a âncora nº 1 dos GAPs eternos — **15 dos 62 eventos** de
 * "trecho ficou byte a byte intocado", em 8 runs diferentes. O corpo PRÓPRIO de `### 1.3 Serviços e
 * Interfaces` tem **415 chars**; a subárvore (`#### Serviço api`, `#### 1.3.0`, `#### 1.3.1`,
 * `#### Serviço worker`) tem **21.839** — o preâmbulo é 1,9% do que a âncora endereça. E o GAP real fala
 * da *"tabela abaixo"* de interfaces, que mora no FILHO. Ou seja: o CTO reescrevia a tabela certa e o
 * laço o acusava de não ter tocado no trecho, rodada após rodada, exigindo edição num preâmbulo onde não
 * havia nada errado. Pior: pela guarda 3 do GAP-77, âncora intocada NÃO é candidata a veredicto — então
 * o defeito não podia nem ser corrigido nem ser absolvido. Trava eterna.
 *
 * A subárvore é `i` mais todas as seções seguintes de nível MAIOR (positional, não pela numeração do
 * título: em `modelo-dados.md` a `§2.3` aparece depois da `§2.3.2`, e agrupar por número juntaria trechos
 * que não são vizinhos). O corpo devolvido é a concatenação dos corpos, que é **verbatim**: as seções são
 * fatias contíguas do arquivo (só o preâmbulo pode ser descartado, e ele vem antes de tudo).
 */
export interface MdSubtree {
  /** Corpo VERBATIM do cabeçalho `i` até o fim dos descendentes. */
  body: string;
  /** Índice da primeira seção depois da subárvore (exclusivo). */
  to: number;
  /** Quantas seções descendentes entraram além da própria. */
  children: number;
}

export function sectionSubtree(secs: MdSection[], i: number): MdSubtree {
  if (i < 0 || i >= secs.length) return { body: "", to: i, children: 0 };
  const lv = secs[i].level;
  let to = i + 1;
  // Nível 0 só existe no preâmbulo (índice 0), que não tem cabeçalho e portanto não tem descendentes.
  if (lv > 0) while (to < secs.length && secs[to].level > lv) to += 1;
  return {
    body: secs.slice(i, to).map((s) => s.body).join("\n"),
    to,
    children: to - i - 1,
  };
}

/** Sumário só com os cabeçalhos reais (o preâmbulo não tem cabeçalho para listar). */
export function headingOutline(secs: MdSection[]): string {
  return secs.map((s) => s.heading).filter((h) => h.startsWith("#")).join("\n");
}

/**
 * Corta preservando o começo. O marcador é explícito porque o modelo precisa saber que o trecho
 * acabou ali por ORÇAMENTO, não porque o arquivo acabou.
 */
export function clipSection(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n[… seção truncada …]`;
}

/** Linhas de contexto de cada lado da linha que casa um termo, na janela de seção. */
const WINDOW_CONTEXT_LINES = 2;
/** Marcador entre dois pedaços da MESMA seção — o modelo precisa saber que faltou texto no meio. */
export const WINDOW_GAP_MARK = "[… trecho omitido da mesma seção …]";

/**
 * 🔴 GAP-74 — JANELA de uma seção grande demais para caber inteira.
 *
 * Medido em prod: `§7.4` (16.399 chars) foi recusada por orçamento em duas medições seguidas, e é
 * citada por 2 dos 4 GAPs cuja seção ficou byte-a-byte intocada na rodada — ou seja, aqueles GAPs
 * **não tinham como fechar**. Recusar a seção inteira era o pior dos mundos: o agente sabia que faltava
 * texto e não tinha o texto.
 *
 * A janela mantém o CABEÇALHO (endereço) e os blocos de linhas em torno de cada termo em disputa, com
 * `WINDOW_CONTEXT_LINES` de folga. Cada bloco é **verbatim** — é o que permite montar um `SEARCH`
 * válido — e cada salto é marcado. Devolve `null` quando nada casou ou nada cabe: melhor declarar a
 * ausência do que entregar um recorte que o modelo confunda com a seção completa.
 */
export function sectionWindow(body: string, terms: string[], max: number): string | null {
  const lines = body.split("\n");
  const head = lines[0]?.startsWith("#") ? lines[0] : null;
  const needles = terms.map((t) => String(t ?? "").trim().toLowerCase()).filter((t) => t.length >= 3);
  if (needles.length === 0 || max <= 0) return null;
  const keep = new Set<number>();
  for (let i = head ? 1 : 0; i < lines.length; i += 1) {
    const hay = lines[i].toLowerCase();
    if (!needles.some((t) => hay.includes(t))) continue;
    for (let j = Math.max(head ? 1 : 0, i - WINDOW_CONTEXT_LINES); j <= Math.min(lines.length - 1, i + WINDOW_CONTEXT_LINES); j += 1) {
      keep.add(j);
    }
  }
  if (keep.size === 0) return null;
  const out: string[] = head ? [head] : [];
  let spent = out.join("\n").length;
  let prev = -2;
  let cut = false;
  for (const i of [...keep].sort((a, b) => a - b)) {
    const piece = (i === prev + 1 ? "" : `${WINDOW_GAP_MARK}\n`) + lines[i];
    // Pula a linha que não cabe em vez de PARAR: uma linha longa no meio (tabela, bloco de código)
    // não pode custar as linhas seguintes, que podem ser exatamente a que o GAP endereça.
    if (spent + piece.length + 1 > max) { cut = true; continue; }
    out.push(...piece.split("\n"));
    spent += piece.length + 1;
    prev = i;
  }
  // Só cabeçalho (ou cabeçalho + marcador) não é janela: não mostra nenhum texto editável.
  if (out.filter((l) => l !== WINDOW_GAP_MARK && l !== head).length === 0) return null;
  if ((cut || prev < lines.length - 1) && out[out.length - 1] !== WINDOW_GAP_MARK) out.push(WINDOW_GAP_MARK);
  return out.join("\n");
}

/**
 * Seções que mencionam pelo menos um dos termos, ordenadas por número de acertos (mais relevante
 * primeiro) e, em empate, pela ordem do arquivo. O índice original vai junto para quem quiser
 * reemitir em ordem de LEITURA depois de escolher por relevância.
 */
export function scoreSections(secs: MdSection[], terms: string[]): Array<{ i: number; section: MdSection; hits: number }> {
  return secs
    .map((section, i) => {
      const hay = section.body.toLowerCase();
      let hits = 0;
      for (const t of terms) if (t && hay.includes(t)) hits += 1;
      return { i, section, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.i - b.i);
}

/** Endereço de seção citado no texto de um GAP (`§8.1`, `§2.3.1`). */
const SECTION_REF_RE = /§\s?\d+(?:\.\d+)*/g;
/** Janela de texto antes da citação onde se procura um nome de arquivo (`contratos-erros.md §2.3`). */
const CROSS_FILE_WINDOW = 48;
/** Caracteres que podem compor um nome de arquivo — usada para RECONSTITUIR um nome cortado pela janela. */
const NAME_CHAR_RE = /[A-Za-z0-9._-]/;

export interface CitedSectionRef {
  /** O endereço como o juiz escreveu (`§8.1`). */
  ref: string;
  /** Nome do arquivo (minúsculo) que precede a citação, ou `null` quando ela não nomeia arquivo. */
  file: string | null;
}

/**
 * Endereços de seção citados num texto de GAP, cada um com o arquivo a que a citação se refere.
 *
 * ⚠️ Vive AQUI porque as DUAS pontas dependem dela e precisam ser complementares: o recorte do arquivo
 * ALVO (`specFileDigest`, GAP-73) aceita `file === null` ou o próprio alvo e DESCARTA citação de outro
 * arquivo; o recorte do IRMÃO (`specSiblingContext`, GAP-75) aceita exatamente o que o alvo descartou.
 * Com duas réguas, a citação `privacidade-lgpd.md §3.3` cairia no vão entre elas — e foi isso que se
 * mediu em prod: 7 de 14 seções de irmão citadas pelos GAPs nunca chegavam ao prompt.
 *
 * 🔴 GAP-162 — a janela mede DISTÂNCIA, não recorta NOME. Enquanto o nome era buscado só dentro dos 48
 * chars anteriores, um nome que começasse antes disso era devolvido pela METADE
 * (`observabilidade-operacao.md` → `vabilidade-operacao.md`), porque a regex casa o fragmento que sobrou
 * na borda da janela. Um nome truncado é pior que nome nenhum: ele não casa com arquivo algum, então a
 * ponta do ALVO o descarta como "citação de outro arquivo" e a ponta do IRMÃO não o reconhece como irmão
 * — a citação cai calada no vão que esta função existe para fechar. Medido na spec do NVX LastMile:
 * 13 de 932 remissões do texto (nos rationales dos GAPs de hoje, 0 de 27 — o defeito era LATENTE).
 * Correção: a janela continua decidindo SE há nome perto; o nome é então completado para a esquerda até a
 * primeira fronteira real. Distância aceita não muda — só para de mentir sobre o nome.
 */
export function citedSectionRefs(text: string): CitedSectionRef[] {
  const out: CitedSectionRef[] = [];
  const s = String(text ?? "");
  SECTION_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SECTION_REF_RE.exec(s)) !== null) {
    const janela = Math.max(0, m.index - CROSS_FILE_WINDOW);
    const fileHit = /([A-Za-z0-9._-]+\.md)[^.]*$/i.exec(s.slice(janela, m.index));
    let file: string | null = null;
    if (fileHit) {
      let ini = janela + fileHit.index; // início do nome DENTRO do texto, não da janela
      while (ini > 0 && NAME_CHAR_RE.test(s[ini - 1])) ini--;
      file = s.slice(ini, janela + fileHit.index + fileHit[1].length).toLowerCase();
    }
    out.push({ ref: m[0], file });
  }
  return out;
}

/**
 * Normalização de âncora para BUSCA NO TEXTO (não para identidade — isso é `normalizeAnchor`).
 *
 * O juiz escreve `§8.6 (c)`, `§9.1 item 0-bis`, `CLI-ANON-01`; o arquivo escreve `## 8.6 Visibilidade`,
 * `**§8.6**`, `REQ CLI-ANON-01`. Então a busca casa por uma CHAVE mínima e estável: minúsculas, sem
 * `§`, sem pontuação de enfeite, espaços colapsados. Dígitos são PRESERVADOS (`8.6` ≠ `8.7`).
 *
 * ⚠️ Vive AQUI, junto do `splitSections`, porque quem MEDE se o trecho ancorado foi tocado
 * (`gapPersistence.untouchedAnchors`) e quem DECIDE qual trecho o CTO vai ver
 * (`specFileDigest.buildFileDigest`) precisam da MESMA régua — ver GAP-72: réguas diferentes fazem o
 * laço acusar de "intocada" uma seção que ele mesmo nunca mostrou.
 */
export function anchorSearchKey(anchor: string): string {
  return (anchor ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/§/g, " ")
    .replace(/[^a-z0-9.\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tokens comparáveis de um texto. Pontuação de borda cai (`8.6.` no fim de frase é o mesmo `8.6` do
 * cabeçalho) — sem isso a âncora deixaria de casar por causa de um ponto final.
 */
export function anchorTokens(s: string): string[] {
  return anchorSearchKey(s)
    .split(" ")
    .map((t) => t.replace(/^[.-]+/, "").replace(/[.-]+$/, ""))
    .filter(Boolean);
}

/**
 * Índice da seção que uma âncora endereça, ou `null` se o texto não a contém.
 *
 * ⚠️ Por que NÃO é `body.includes(anchor)`: a chave de `§8.6 (c)` é `8.6 c`, mas no arquivo o `8.6` e o
 * `(c)` estão separados pelo título da seção (`## 8.6 Visibilidade` … `(c) A consulta anônima…`).
 * Casar substring contígua devolveria `null` para TODAS as âncoras reais medidas em prod.
 *
 * Regra: o PRIMEIRO token é o localizador (`8.6`, `11.3`, `cli-anon-01`); os demais só desempatam.
 * Seção cujo CABEÇALHO contém o localizador vence qualquer seção que só o mencione no corpo — uma
 * referência cruzada (`ver §8.6`) não é a seção §8.6. Empate mantém a ordem do arquivo (determinístico).
 */
export interface AnchorIndex {
  entries: Array<{ i: number; tokens: Set<string>; headingTokens: Set<string> }>;
}

/**
 * Tokeniza as seções UMA vez para localizar N âncoras. Tokenizar um arquivo de 200k chars por âncora
 * seria quadrático no caminho quente (cada rodada localiza ~12 âncoras).
 */
export function buildAnchorIndex(secs: MdSection[]): AnchorIndex {
  return {
    entries: secs.map((s, i) => ({
      i,
      tokens: new Set(anchorTokens(s.body)),
      headingTokens: new Set(s.heading.startsWith("#") ? anchorTokens(s.heading) : []),
    })),
  };
}

export function locateSectionIndex(secs: MdSection[] | AnchorIndex, anchor: string): number | null {
  const idx = Array.isArray(secs) ? buildAnchorIndex(secs) : secs;
  const toks = anchorTokens(anchor);
  if (toks.length === 0) return null;
  const head = toks[0];
  const rest = toks.slice(1);
  const cands = idx.entries.filter((s) => s.tokens.has(head));
  if (cands.length === 0) return null;
  const byHeading = cands.filter((s) => s.headingTokens.has(head));
  const pool = byHeading.length > 0 ? byHeading : cands;
  let best = pool[0].i;
  let bestScore = -1;
  for (const s of pool) {
    const score = rest.reduce((n, t) => n + (s.tokens.has(t) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = s.i; }
  }
  return best;
}
