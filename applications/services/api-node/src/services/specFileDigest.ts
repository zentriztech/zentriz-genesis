/**
 * A5.7 / GAP-7 (2026-09-06) — o arquivo GRANDE deixa de ser irrevisável.
 *
 * ## O que foi medido (NVX LastMile, prod, run `75b3cf5d`, rodada 13)
 *
 * ```
 * modelo-dados.md tem 126742 caracteres (teto 120000) — não cabe na janela de contexto desta rodada.
 * ```
 *
 * O arquivo **saiu da fila com os GAPs dele ativos** — e não nasceu grande: o CTO-editor só
 * ACRESCENTA (na mesma sequência, `definicao-de-pronto.md` foi de 49.362 → 56.692 chars em UMA
 * rodada). Ou seja, o próprio laço empurra os arquivos maiores contra o teto até torná-los
 * irrevisáveis, e duas recusas seguidas ainda param o laço inteiro (`MAX_FILE_FAILURES`).
 *
 * Subir o teto não resolve: com ~7k chars de crescimento por rodada, qualquer teto é alcançado. E a
 * mensagem "divida este arquivo" pede ao humano exatamente o que ele acionou o autônomo para não
 * fazer.
 *
 * ## O que este módulo faz
 *
 * No formato `edits` (blocos SEARCH/REPLACE), o modelo **não precisa ler o arquivo inteiro** — precisa
 * ler os trechos que vai mudar. Então o arquivo alvo entra como RESUMO DIRIGIDO: sumário COMPLETO de
 * cabeçalhos (o modelo sabe o que existe) + as seções que os GAPs deste arquivo apontam, VERBATIM.
 * Cada trecho mostrado é byte a byte igual ao arquivo, que é o que permite montar um `SEARCH` válido;
 * o `apply` continua rodando contra o arquivo COMPLETO no disco (`runFileChatJob` recebe o conteúdo
 * integral), então o recorte é só de LEITURA — nada é perdido na escrita.
 *
 * A seleção é determinística e é transporte de FATO ("o GAP aponta esta seção"): o que fazer com ela
 * continua sendo decisão do agente (Lei 100% LLM).
 *
 * ## Por que NÃO no formato `whole`
 *
 * Lá o modelo devolve o arquivo inteiro. Mostrar um recorte e pedir o arquivo completo produziria um
 * arquivo MUTILADO — perda de dados. Com `SPEC_GAP_FILE_EDIT_FORMAT=whole` o teto volta a valer e a
 * recusa por tamanho continua sendo o comportamento correto.
 */
import {
  splitSections, clipSection, headingOutline, scoreSections, buildAnchorIndex, locateSectionIndex,
  sectionWindow, citedSectionRefs, sectionSubtree,
} from "../lib/markdownSections.js";
import { disputedTerms } from "./specSiblingContext.js";
import type { ValidationFinding } from "./specValidation.js";

/** Teto de UMA seção no resumo do alvo — generoso: é a seção que o modelo vai EDITAR. */
export const TARGET_SECTION_BUDGET = 24_000;
/** Fração do teto de entrada que o resumo pode ocupar; o resto é prompt, GAPs e irmãos. */
export const TARGET_DIGEST_FRACTION = 0.75;
/**
 * 🔴 GAP-74 — teto de UMA janela. Menor que o teto de seção de propósito: a janela existe justamente
 * para a seção que não caberia inteira, e uma janela grande recriaria o problema que ela resolve
 * (uma seção só consumindo o orçamento das outras endereçadas).
 */
export const TARGET_WINDOW_BUDGET = 6_000;

export interface FileDigest {
  /** Texto a mandar no lugar do conteúdo integral. */
  text: string;
  /** `false` = o arquivo caiu inteiro (nada foi recortado). */
  digested: boolean;
  /** Seções transcritas / total de seções do arquivo — vai para o log da rodada. */
  used: number;
  total: number;
  /** 🔴 GAP-72 — quantas das seções transcritas são as ENDEREÇADAS pelas âncoras dos GAPs. */
  anchored: number;
  /** Âncoras dos GAPs desta rodada que o código conseguiu endereçar a uma seção. */
  anchorsLocated: number;
  /** Âncoras endereçadas cuja seção NÃO caberia no orçamento — declaradas, nunca omitidas em silêncio. */
  anchorsDropped: string[];
  /** Âncoras que o código não endereçou a nenhuma seção (IDs cunhados pelo juiz, p.ex.). */
  anchorsUnlocatable: string[];
  /** 🔴 GAP-73 — seções que o TEXTO do GAP cita como a OUTRA ponta da contradição e que entraram. */
  cited: number;
  /** Quantas dessas seções citadas o código conseguiu endereçar (antes do orçamento). */
  citedLocated: number;
  /** Citadas que não caberiam — declaradas ao modelo, nunca omitidas em silêncio. */
  citedDropped: string[];
  /** 🔴 GAP-74 — quantas seções entraram como JANELA (trecho verbatim em torno dos termos em disputa). */
  windowed: number;
  /** Âncoras cuja seção não caberia inteira e entrou como janela (não estão em `anchorsDropped`). */
  anchorsWindowed: string[];
  /** Citadas cuja seção não caberia inteira e entrou como janela (não estão em `citedDropped`). */
  citedWindowed: string[];
}

/**
 * Termos que apontam as seções relevantes: o que os GAPs colocam em disputa (identificadores,
 * códigos, números) MAIS as âncoras que o validador atribuiu — a âncora é literalmente o endereço
 * que ele achou do problema, então é o sinal mais forte que existe.
 */
function targetTerms(findings: ValidationFinding[]): string[] {
  const terms = new Set(disputedTerms(findings));
  for (const f of findings) {
    const anchor = (f as { anchor?: string | null }).anchor;
    if (!anchor) continue;
    const clean = anchor.trim().toLowerCase().replace(/^#+\s*/, "");
    if (clean.length >= 3) terms.add(clean);
  }
  return [...terms];
}

function severityRank(sev: unknown): number {
  const s = String(sev ?? "").toLowerCase();
  if (s === "blocker") return 0;
  if (s === "warning") return 1;
  return 2;
}

interface AnchoredSection {
  i: number;
  /** Corpo já recortado pelo teto de seção — é o custo real no orçamento. */
  body: string;
  anchors: string[];
  /** Peso do GAP mais grave que aponta esta seção. */
  rank: number;
  /** 🔴 GAP-79 — subárvore completa, base da JANELA quando a seção não couber. */
  subtree: string;
}

/**
 * 🔴 GAP-79 — o trecho que uma âncora endereça é a SUBÁRVORE do cabeçalho (ver
 * `gapPersistence.untouchedAnchors`). Quem MEDE o intocado e quem MOSTRA o trecho têm de usar a mesma
 * régua, senão o laço volta a acusar por um recorte que nunca mostrou — é literalmente o GAP-72.
 *
 * A subárvore só entra quando cabe no teto de UMA seção; acima disso fica o corpo próprio (comportamento
 * anterior, nunca pior que hoje) e a subárvore vai para a tentativa de JANELA do GAP-74, que é um recorte
 * melhor que um `clipSection` cego de 24k. Devolve os dois para o chamador escolher.
 */
function anchoredBody(secs: ReturnType<typeof splitSections>, i: number): { body: string; subtree: string } {
  const sub = sectionSubtree(secs, i);
  const fits = sub.children > 0 && sub.body.length <= TARGET_SECTION_BUDGET;
  return { body: fits ? sub.body : clipSection(secs[i].body, TARGET_SECTION_BUDGET), subtree: sub.body };
}

/**
 * 🔴 GAP-72 — as seções que os GAPs desta rodada ENDEREÇAM, pela mesma régua que mede se o trecho foi
 * tocado (`locateSectionIndex`). Uma seção pode ser apontada por vários GAPs: entra uma vez, com o peso
 * do mais grave.
 */
function anchoredSections(secs: ReturnType<typeof splitSections>, findings: ValidationFinding[]): {
  picks: AnchoredSection[];
  unlocatable: string[];
} {
  const index = buildAnchorIndex(secs);
  const byIndex = new Map<number, AnchoredSection>();
  const unlocatable: string[] = [];
  const seen = new Set<string>();
  for (const f of findings) {
    const anchor = String((f as { anchor?: string | null }).anchor ?? "").trim();
    if (!anchor || seen.has(anchor)) continue;
    seen.add(anchor);
    const i = locateSectionIndex(index, anchor);
    if (i === null) { unlocatable.push(anchor); continue; }
    const rank = severityRank((f as { severity?: unknown }).severity);
    const cur = byIndex.get(i);
    if (cur) { cur.anchors.push(anchor); cur.rank = Math.min(cur.rank, rank); continue; }
    const { body, subtree } = anchoredBody(secs, i);
    byIndex.set(i, { i, body, anchors: [anchor], rank, subtree });
  }
  return { picks: [...byIndex.values()], unlocatable };
}

/** Nome do arquivo alvo sem diretório, minúsculo — é como o juiz cita irmãos no texto do GAP. */
function targetBase(filePath: string): string {
  const p = String(filePath ?? "").trim().toLowerCase();
  return p.slice(p.lastIndexOf("/") + 1);
}

/**
 * 🔴 GAP-73 — os endereços que o GAP cita ALÉM da própria âncora.
 *
 * Puramente mecânico: extrai `§x.y` do título e do `rationale` (`citedSectionRefs`, régua compartilhada
 * com o lado do irmão). Citação precedida de um nome de arquivo DIFERENTE do alvo é descartada —
 * `contratos-erros.md §2.3` aponta a seção 2.3 DO IRMÃO, e trazer a §2.3 do alvo mostraria o trecho
 * errado (pior que não mostrar nada); quem cuida dessa é o GAP-75, em `specSiblingContext`.
 * Auto-referência pelo nome (`modelo-dados.md §8.1` dentro de `modelo-dados.md`) continua valendo.
 */
function citedRefs(f: ValidationFinding, targetBase: string): string[] {
  const out: string[] = [];
  for (const text of [String(f.title ?? ""), String(f.rationale ?? "")]) {
    for (const c of citedSectionRefs(text)) {
      if (c.file !== null && c.file !== targetBase) continue;
      out.push(c.ref);
    }
  }
  return out;
}

interface CitedSection {
  i: number;
  body: string;
  /** Os endereços citados que caem nesta seção — é o que vai na declaração ao modelo. */
  refs: string[];
  /** Peso do GAP mais grave que a cita. */
  rank: number;
  /** 🔴 GAP-79 — subárvore completa, base da JANELA quando a seção não couber. */
  subtree: string;
}

/**
 * 🔴 GAP-73 — as seções que o texto dos GAPs cita como a OUTRA PONTA da contradição.
 *
 * `skip` recebe TODAS as seções já endereçadas por âncora (inclusive as que não couberam), para uma
 * seção nunca ser reservada duas vezes nem declarada em duas listas.
 */
function citedSections(
  secs: ReturnType<typeof splitSections>,
  findings: ValidationFinding[],
  targetBase: string,
  skip: Set<number>,
): CitedSection[] {
  const index = buildAnchorIndex(secs);
  const byIndex = new Map<number, CitedSection>();
  for (const f of findings) {
    const rank = severityRank((f as { severity?: unknown }).severity);
    for (const ref of citedRefs(f, targetBase)) {
      const i = locateSectionIndex(index, ref);
      if (i === null || skip.has(i)) continue;
      const cur = byIndex.get(i);
      if (cur) {
        if (!cur.refs.includes(ref)) cur.refs.push(ref);
        cur.rank = Math.min(cur.rank, rank);
        continue;
      }
      const { body, subtree } = anchoredBody(secs, i);
      byIndex.set(i, { i, body, refs: [ref], rank, subtree });
    }
  }
  return [...byIndex.values()];
}

/**
 * Recorta o arquivo ALVO quando ele não cabe no teto de entrada. Abaixo do teto nada muda —
 * recortar um arquivo que cabe só criaria risco de o modelo não ver o trecho que precisa mudar.
 *
 * ## 🔴 GAP-72 — a ordem de seleção mandava o CTO corrigir o que ele não estava vendo
 *
 * MEDIDO em prod (run `95ba8636`, `modelo-dados.md`, 215.168 chars / 57 seções, 11 GAPs ancorados):
 * a seleção era só `scoreSections` — número de termos distintos que a seção menciona. Isso premia
 * seção GRANDE e GENÉRICA: `## Convenções gerais` (31.012 chars, 71 hits) sozinha comeu 34% do
 * orçamento, e 5 seções consumiram 89.789 dos 90.000. Resultado: **8 das 11 seções endereçadas pelos
 * GAPs nunca entraram no prompt** — e são exatamente as **8 âncoras que ficaram byte-a-byte intocadas**
 * na rodada (correlação 11/11 com a medição do GAP-71). O CTO não estava se recusando a corrigir: não
 * tinha o texto. E o orçamento nunca foi o limite — as 8 seções somam **35.413 chars**, cabem folgadas
 * nos 90.000; o defeito era de ORDEM.
 *
 * Agora as seções ENDEREÇADAS pelas âncoras são reservadas ANTES do preenchimento por relevância, e o
 * que não couber é DECLARADO ao modelo (nome da âncora) em vez de desaparecer. Continua sendo transporte
 * de fato — "o juiz disse que o defeito está neste endereço" —, não julgamento de conteúdo.
 *
 * ## 🔴 GAP-73 — a âncora chegava, a OUTRA PONTA da contradição não
 *
 * MEDIDO em prod na rodada seguinte ao deploy do GAP-72 (run `32992636`, mesmo arquivo): âncoras
 * 11/11 no prompt, 26 edições aplicadas, spec −3.007 chars — e as MESMAS 12 constatações voltaram na
 * validação seguinte, anchor por anchor. A razão está no texto do juiz: o defeito de `§5.2` é o
 * literal *"Sim, quando `expires_at < NOW()`"* que mora em **§8.1**; o de `§11.3 etapa C` mora em
 * `§3`, `§3.2`, `§3.4`. Reprodução com o arquivo real: das **25 seções citadas nos `rationale`, 8
 * estavam FORA** do recorte — e as ausentes são 1.389 / 758 / 1.897 / 2.198 / 3.014 chars, ou seja
 * cabiam de sobra. Sem enxergar o literal, a única saída que resta ao agente é **inventar uma regra
 * de substituição textual global** (`PURGA-RT-01.1`, `ETAPA-C-01`) — errata com outro nome, que o
 * juiz relê e reabre. Por isso as seções CITADAS entram como segunda reserva, antes da relevância.
 *
 * ## 🔴 GAP-74 — a seção que não cabe INTEIRA passa a vir como JANELA
 *
 * MEDIDO em prod na rodada seguinte ao GAP-73 (run `a33a0d29`, `modelo-dados.md`): `ancoradas 9/9`,
 * `citadas 3/4`, **10 edições aplicadas / 0 recusadas** — e **4 dos 10 trechos endereçados ficaram
 * byte-a-byte idênticos**, com o arquivo CRESCENDO 2.039 chars. O diff por seção mostra 5 seções
 * alteradas, **todas por acréscimo**. E o `footprint` completo (âncora + citadas) dos 4 GAPs que não
 * fecharam é `§6+§7.4`, `§8.6`, `§7.4+§8.4`, `§1.3+§9`: **duas delas dependem de `§7.4`, a única seção
 * grande demais (16.399 chars) para caber no orçamento** — recusada nas duas medições. Ou seja: o
 * agente escrevia em OUTRO lugar porque o lugar certo nunca chegava.
 *
 * Hipótese **REFUTADA no caminho**: "o medidor de intocado mente porque olha só a âncora" — nesta
 * rodada o footprint COMPLETO das 4 também não mudou, então a medida por âncora não mentiu.
 *
 * Fix: antes do preenchimento por relevância, toda seção recusada por orçamento (ancorada ou citada)
 * tenta entrar como `sectionWindow` — blocos VERBATIM em torno dos termos em disputa, saltos marcados,
 * teto próprio (`TARGET_WINDOW_BUDGET`). Só sai como "não veio" o que nem em janela cabe.
 */
export function buildFileDigest(
  filePath: string,
  content: string,
  findings: ValidationFinding[],
  cap: number,
): FileDigest {
  const secs = splitSections(content);
  if (content.length <= cap) {
    return {
      text: content, digested: false, used: secs.length, total: secs.length,
      anchored: 0, anchorsLocated: 0, anchorsDropped: [], anchorsUnlocatable: [],
      cited: 0, citedLocated: 0, citedDropped: [],
      windowed: 0, anchorsWindowed: [], citedWindowed: [],
    };
  }

  const budget = Math.floor(cap * TARGET_DIGEST_FRACTION);
  const terms = targetTerms(findings);
  const outline = headingOutline(secs);
  let spent = outline.length;
  const chosenIdx = new Set<number>();
  const chosen: Array<{ i: number; body: string }> = [];

  // 1) COBERTURA GARANTIDA: as seções que os GAPs endereçam. Blocker antes de warning; dentro do mesmo
  //    peso, a MENOR primeiro (cabem mais GAPs acionáveis na rodada); empate pela ordem do arquivo.
  const { picks, unlocatable } = anchoredSections(secs, findings);
  picks.sort((a, b) => a.rank - b.rank || a.body.length - b.body.length || a.i - b.i);
  const anchorOverflow: AnchoredSection[] = [];
  for (const p of picks) {
    if (spent + p.body.length > budget) { anchorOverflow.push(p); continue; }
    spent += p.body.length;
    chosenIdx.add(p.i);
    chosen.push({ i: p.i, body: p.body });
  }
  const anchored = chosen.length;

  // 2) 🔴 GAP-73 — a OUTRA PONTA da contradição: as seções que o texto do GAP cita. Vêm ANTES da
  //    relevância porque foram apontadas pelo juiz, não estimadas por contagem de termos. Mesma ordem
  //    do passo 1 (blocker antes de warning, menor primeiro, empate pela ordem do arquivo).
  const citedPicks = citedSections(secs, findings, targetBase(filePath), new Set(picks.map((p) => p.i)));
  citedPicks.sort((a, b) => a.rank - b.rank || a.body.length - b.body.length || a.i - b.i);
  const citedOverflow: CitedSection[] = [];
  for (const p of citedPicks) {
    if (spent + p.body.length > budget) { citedOverflow.push(p); continue; }
    spent += p.body.length;
    chosenIdx.add(p.i);
    chosen.push({ i: p.i, body: p.body });
  }
  const cited = chosen.length - anchored;

  // 3) 🔴 GAP-74 — a seção que NÃO CABE inteira entra como JANELA em vez de não vir.
  //    Medido em prod: `§7.4` (16.399 chars) foi recusada por orçamento e é citada por 2 dos 4 GAPs cuja
  //    seção ficou byte-a-byte intocada — aqueles GAPs não tinham como fechar. A janela é o trecho
  //    VERBATIM em torno dos termos em disputa, com os saltos marcados: dá ao modelo um `SEARCH` válido
  //    sem gastar a seção inteira. Continua transporte de fato — quem escolhe o que mudar é o agente.
  const dropped: string[] = [];
  const citedDropped: string[] = [];
  const anchorsWindowed: string[] = [];
  const citedWindowed: string[] = [];
  let windowed = 0;
  // 🔴 GAP-79: a janela é aberta sobre a SUBÁRVORE. Quando o cabeçalho é um toco (415 chars de uma
  // subárvore de 21.839, medido em `visao-escopo.md §1.3`), janelar só o corpo próprio devolveria um
  // trecho sem nada editável — o pior dos mundos, igual ao que o GAP-74 corrigiu.
  const tryWindow = (i: number, subtree: string, labels: string[], extra: string[], into: string[], out: string[]): void => {
    const room = Math.min(TARGET_WINDOW_BUDGET, budget - spent);
    const win = room > 0 ? sectionWindow(subtree, [...terms, ...extra], room) : null;
    if (win === null) { out.push(...labels); return; }
    spent += win.length;
    chosenIdx.add(i);
    chosen.push({ i, body: win });
    windowed += 1;
    into.push(...labels);
  };
  for (const p of anchorOverflow) tryWindow(p.i, p.subtree, p.anchors, p.anchors, anchorsWindowed, dropped);
  for (const p of citedOverflow) tryWindow(p.i, p.subtree, p.refs, p.refs, citedWindowed, citedDropped);

  // 4) O que sobrou do orçamento vai para o contexto por relevância (comportamento anterior).
  for (const x of scoreSections(secs, terms)) {
    if (chosenIdx.has(x.i)) continue;
    const body = clipSection(x.section.body, TARGET_SECTION_BUDGET);
    if (spent + body.length > budget) continue;
    spent += body.length;
    chosenIdx.add(x.i);
    chosen.push({ i: x.i, body });
  }

  if (chosen.length === 0) {
    // Nenhuma seção casou (ou nenhuma cabe): mostrar o começo ainda permite edições válidas, porque o
    // que aparece é VERBATIM. O aviso é obrigatório — sem ele o modelo trata o corte como fim do
    // arquivo e reescreve no lugar errado.
    return {
      text: [
        `[RECORTE de \`${filePath}\` — o arquivo tem ${content.length} chars e não cabe inteiro nesta rodada.`,
        "Abaixo, o SUMÁRIO COMPLETO de seções e, em seguida, o INÍCIO do arquivo. Nenhuma seção casou com",
        "o que os GAPs apontam, então mostro o começo. Só edite trechos que você está VENDO aqui.]",
        "",
        "SUMÁRIO DE SEÇÕES:",
        outline,
        "",
        "TRECHO (verbatim, do início do arquivo):",
        content.slice(0, budget),
        "",
        `[… corte por orçamento em ${budget} de ${content.length} chars — o que não aparece CONTINUA existindo no arquivo …]`,
      ].join("\n"),
      digested: true,
      used: 0,
      total: secs.length,
      anchored: 0,
      anchorsLocated: picks.length,
      anchorsDropped: dropped,
      anchorsUnlocatable: unlocatable,
      cited: 0,
      citedLocated: citedPicks.length,
      citedDropped,
      windowed,
      anchorsWindowed,
      citedWindowed,
    };
  }

  // Ordem de LEITURA depois de escolher: o arquivo continua fazendo sentido de cima para baixo, o que
  // importa quando uma seção referencia a outra.
  const parts = chosen.sort((a, b) => a.i - b.i).map((x) => x.body);

  return {
    text: [
      `[RESUMO DIRIGIDO de \`${filePath}\` — o arquivo tem ${content.length} chars e NÃO cabe inteiro nesta`,
      `rodada. Abaixo, o SUMÁRIO COMPLETO de seções e, VERBATIM, as ${parts.length} seção(ões) selecionadas —`,
      `${anchored} delas é/são a(s) seção(ões) que os GAPs desta rodada ENDEREÇAM e ${cited} é/são`,
      "seção(ões) que o TEXTO dos GAPs cita como a outra ponta da contradição. REGRAS desta rodada:",
      "  • cada bloco SEARCH deve copiar texto que você está VENDO aqui — é byte a byte igual ao arquivo;",
      "  • NÃO recrie uma seção que aparece no sumário e não foi transcrita: ela EXISTE no arquivo e",
      "    duplicá-la troca um GAP por uma contradição interna;",
      "  • se um GAP só puder ser resolvido numa seção que não está aqui, diga isso na linha final em vez",
      "    de adivinhar o conteúdo dela.]",
      // 🔴 GAP-74: a janela é verbatim mas PARCIAL. Sem esta regra o modelo trata os saltos como se a
      // seção terminasse ali e reescreve a seção "completa" — trocando o GAP por perda de conteúdo.
      ...(windowed > 0
        ? [`[JANELA: ${windowed} seção(ões) não caberia(m) inteira(s) e vieram RECORTADAS — os pedaços que`,
           ` você vê são verbatim, e cada \`[… trecho omitido da mesma seção …]\` marca texto que EXISTE no`,
           " arquivo e não está aqui. Edite só o que está visível; NÃO reescreva a seção inteira nem trate o",
           ` marcador como fim da seção.${
             [...anchorsWindowed, ...citedWindowed].length > 0
               ? ` Vieram em janela: ${[...anchorsWindowed, ...citedWindowed].join(", ")}.`
               : ""
           }]`]
        : []),
      // 🔴 GAP-72: âncora cuja seção não caberia sai DECLARADA. Sem esta linha o modelo lê a ausência
      // como "o trecho não existe" e responde com errata — a patologia do GAP-71 causada pelo recorte.
      ...(dropped.length > 0
        ? [`[ATENÇÃO: a(s) seção(ões) endereçada(s) por ${dropped.join(", ")} NÃO caberam no orçamento desta`,
           " rodada. Para esses GAPs, DECLARE na linha final que o trecho não veio — não improvise o conteúdo",
           " e não anule o trecho por errata.]"]
        : []),
      // 🔴 GAP-73: a seção citada como a outra ponta da contradição é onde mora o literal a matar. Sem
      // esta linha o modelo só tem uma saída: inventar uma regra de substituição textual global — que é
      // errata com outro nome e não fecha GAP nenhum (medido em prod: `PURGA-RT-01.1`, `ETAPA-C-01`).
      ...(citedDropped.length > 0
        ? [`[ATENÇÃO: ${citedDropped.join(", ")} — citada(s) pelos GAPs como a outra ponta da contradição —`,
           " NÃO caberam nesta rodada. DECLARE na linha final que faltou o trecho; NÃO crie regra de",
           " substituição textual global ('toda redação que diga X, leia-se Y') para contornar a ausência.]"]
        : []),
      "",
      "SUMÁRIO DE SEÇÕES:",
      outline,
      "",
      "SEÇÕES APONTADAS PELOS GAPs (verbatim):",
      parts.join("\n\n"),
    ].join("\n"),
    digested: true,
    used: parts.length,
    total: secs.length,
    anchored,
    anchorsLocated: picks.length,
    anchorsDropped: dropped,
    anchorsUnlocatable: unlocatable,
    cited,
    citedLocated: citedPicks.length,
    citedDropped,
    windowed,
    anchorsWindowed,
    citedWindowed,
  };
}
