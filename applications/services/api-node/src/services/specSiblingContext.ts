/**
 * A5.5 (2026-09-06) — o irmão CITADO pelo GAP vai como contexto só-leitura.
 *
 * ## O que foi medido (NVX LastMile, prod, run `dd587b75` passe 1)
 *
 * O "Resolver GAPs por arquivo" funcionou no nível do ARQUIVO (21 findings resolvidos, entre eles os
 * 9 de `privacidade-lgpd.md` que antes falhavam 4/4) e **falhou no nível da SPEC**: a contagem de GAPs
 * importantes subiu de 20 → 24, com 24 findings NOVOS. O par mais claro:
 *
 *  • RESOLVIDO em `api-entregas-entregadores.md`: "Conflito de status HTTP para VALIDATION_ERROR: 422 vs 400";
 *  • NOVO em `definicao-de-pronto.md`: "Status HTTP de erro de validação divergente: 400 vs 422".
 *
 * Ou seja: o CTO-editor **escolheu um valor** para resolver o conflito dentro do arquivo que estava
 * editando; como não via o irmão, a contradição não foi resolvida — foi MOVIDA. Cada rodada paga LLM
 * para empurrar o mesmo conflito de arquivo em arquivo, e o laço nunca converge.
 *
 * ## O que este módulo faz
 *
 * Seleciona, por CITAÇÃO LITERAL, os arquivos irmãos que os próprios GAPs mencionam (medido: 19 de 25
 * findings citam um `.md` no `rationale`) e os entrega como bloco SÓ LEITURA, mais o índice primário
 * quando sobra orçamento. A seleção é determinística — é transporte de fato ("o GAP cita este
 * arquivo"), não julgamento: o que fazer com a divergência continua sendo decisão do agente.
 *
 * ## A5.6 — por que o recorte deixou de ser head-truncate
 *
 * A primeira versão mandava os primeiros 20k chars de cada irmão. Medido no run `75b3cf5d` (a rodada
 * que PROVOU o A5.5 em prod): com arquivos de ~20k, **só 2 irmãos citados cabiam** e em
 * `modelo-dados.md` **8 ficaram de fora** — e os 20k gastos eram justamente o começo do arquivo, que
 * raramente é onde mora a regra em disputa. Agora o irmão grande vira RESUMO DIRIGIDO: sumário
 * COMPLETO de cabeçalhos (para o modelo saber o que existe) + só as seções que mencionam os termos que
 * o GAP coloca em disputa. Mesmo orçamento, mais irmãos e sinal melhor.
 */
import { readFile } from "node:fs/promises";
import {
  splitSections, clipSection, headingOutline, buildAnchorIndex, locateSectionIndex, sectionWindow,
  citedSectionRefs, sectionSubtree,
} from "../lib/markdownSections.js";
import type { ValidationFinding } from "./specValidation.js";

/** Orçamento total do bloco de irmãos. ~21k tokens: cabe com o arquivo (≤120k chars) na janela. */
export const SIBLING_TOTAL_BUDGET = 60_000;
/** Teto por irmão, para um arquivo gigante não comer o orçamento dos outros citados. */
export const SIBLING_FILE_BUDGET = 12_000;
/** Abaixo disto o irmão vai INTEIRO — recortar um arquivo pequeno só cria risco de omitir a regra. */
export const SIBLING_FILE_FULL_MAX = 8_000;
/** Teto de uma seção dentro do resumo, para uma seção quilométrica não virar o resumo todo. */
export const SIBLING_SECTION_BUDGET = 3_000;
/**
 * 🔴 GAP-75 — teto de UMA janela de seção citada do irmão (paridade com o GAP-74 no lado do alvo).
 * Menor que o teto de seção: a janela existe para a seção que não caberia inteira, e uma janela grande
 * recriaria o problema que ela resolve.
 */
export const SIBLING_WINDOW_BUDGET = 2_000;

export interface SiblingRef {
  path: string;
  filename: string;
  filePath: string;
  isPrimary: boolean;
}

export interface SiblingContext {
  /** Bloco pronto para o prompt (vazio quando não há irmão citado nem orçamento). */
  block: string;
  /** Paths efetivamente incluídos, em ordem — vai para o log da rodada. */
  used: string[];
  /** Paths citados que NÃO couberam no orçamento (o modelo é avisado no bloco). */
  omitted: string[];
  /** 🔴 GAP-75 — seções de irmão citadas pelos GAPs que chegaram (`arquivo.md §3.3`), inteiras ou em janela. */
  citedUsed: string[];
  /** Citadas que NÃO foram transcritas (não couberam ou não foram localizadas) — declaradas no bloco. */
  citedDropped: string[];
  /** Citadas que não caberiam inteiras e vieram RECORTADAS (subconjunto de `citedUsed`). */
  citedWindowed: string[];
}

/** Texto onde procurar citações: título + motivo + âncora de cada GAP. */
function findingsText(findings: ValidationFinding[]): string {
  return findings
    .map((f) => `${f.title}\n${f.rationale ?? ""}\n${(f as { anchor?: string | null }).anchor ?? ""}`)
    .join("\n")
    .toLowerCase();
}

/**
 * Quantas vezes os GAPs citam este irmão. Conta pelo `path` E pelo `filename` porque o validador
 * escreve das duas formas (`tecnico/modelo-dados.md` e `modelo-dados.md`).
 */
function citations(text: string, ref: SiblingRef): number {
  const needles = new Set([ref.path.toLowerCase(), ref.filename.toLowerCase()]);
  let n = 0;
  for (const needle of needles) {
    if (!needle) continue;
    let i = text.indexOf(needle);
    while (i !== -1) { n += 1; i = text.indexOf(needle, i + needle.length); }
  }
  return n;
}

/**
 * A5.6 — TERMOS EM DISPUTA extraídos do próprio GAP.
 *
 * O head-truncate do A5.5 gastava 20k chars nas PRIMEIRAS linhas do irmão, que raramente são onde a
 * regra contestada mora — e com isso só 2 irmãos citados caíam no orçamento (medido em prod:
 * `modelo-dados.md` deixou 8 de fora). Estes termos são o que o GAP literalmente coloca em disputa:
 * identificadores entre backticks, códigos em CAIXA_ALTA e números de 3–4 dígitos (é assim que
 * "422 vs 400" e "VALIDATION_ERROR" aparecem). Servem para escolher QUAIS seções do irmão mostrar.
 */
export function disputedTerms(findings: ValidationFinding[]): string[] {
  const text = findings
    .map((f) => `${f.title}\n${f.rationale ?? ""}`)
    .join("\n");
  const terms = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]{2,60})`/g)) terms.add(m[1].toLowerCase());
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)) terms.add(m[0].toLowerCase());
  for (const m of text.matchAll(/\b\d{3,4}\b/g)) terms.add(m[0]);
  return [...terms];
}

/**
 * A5.7/GAP-7: o recorte por seção vive em `lib/markdownSections.ts` porque o arquivo ALVO passou a
 * precisar exatamente do mesmo comportamento. Duas réguas diferentes fariam o modelo montar um
 * `SEARCH` que não casa no arquivo.
 */
const sections = splitSections;
const clip = clipSection;

interface SiblingExcerpt {
  text: string;
  /** Refs citadas deste irmão que foram transcritas (inteiras ou em janela). */
  usedRefs: string[];
  /** Refs citadas que não foram transcritas — declaradas no próprio bloco. */
  droppedRefs: string[];
  /** Refs transcritas em JANELA (subconjunto de `usedRefs`). */
  windowedRefs: string[];
}

/**
 * 🔴 GAP-75 — as seções deste irmão que os GAPs citam NOMEANDO o arquivo, reservadas ANTES da
 * relevância. Mesma ordem do lado do alvo (GAP-72/73): a MENOR primeiro, para caber o máximo de
 * citações acionáveis; empate pela ordem do arquivo (determinístico).
 */
function citedPicks(
  secs: ReturnType<typeof sections>,
  cited: string[],
): { picks: Array<{ i: number; refs: string[]; body: string; subtree: string }>; unlocatable: string[] } {
  const index = buildAnchorIndex(secs);
  const byIndex = new Map<number, string[]>();
  const unlocatable: string[] = [];
  for (const ref of cited) {
    const i = locateSectionIndex(index, ref);
    if (i === null) { unlocatable.push(ref); continue; }
    const cur = byIndex.get(i);
    if (cur) { if (!cur.includes(ref)) cur.push(ref); continue; }
    byIndex.set(i, [ref]);
  }
  // 🔴 GAP-79 — a citação `§1.3` endereça a SUBÁRVORE do cabeçalho, não o preâmbulo dele: em
  // `visao-escopo.md` o corpo próprio da §1.3 é 415 de 21.839 chars. Mostrar o toco ao lado do alvo faria
  // o modelo concluir que o irmão "não define" o que ele de fato define — a duplicação normativa que o
  // GAP-75 existe para evitar. A subárvore só entra quando cabe no teto de seção; acima disso fica o
  // corpo próprio (nunca pior que antes) e a janela é aberta sobre a subárvore.
  const picks = [...byIndex.entries()]
    .map(([i, refs]) => {
      const sub = sectionSubtree(secs, i);
      const fits = sub.children > 0 && sub.body.length <= SIBLING_SECTION_BUDGET;
      return { i, refs, body: fits ? sub.body : clip(secs[i].body, SIBLING_SECTION_BUDGET), subtree: sub.body };
    })
    .sort((a, b) => a.body.length - b.body.length || a.i - b.i);
  return { picks, unlocatable };
}

/**
 * Recorte de UM irmão. Arquivo pequeno vai inteiro; grande vira RESUMO DIRIGIDO: o sumário completo
 * de cabeçalhos (para o modelo saber o que existe), as seções que os GAPs CITAM deste irmão
 * (🔴 GAP-75, reservadas) e, com o que sobrar, as seções que mencionam os termos em disputa.
 *
 * O aviso é obrigatório nos casos de corte: sem ele o modelo concluiria "o irmão não define isso" e
 * escreveria a regra de novo no arquivo errado — trocaria uma divergência por uma duplicação
 * normativa, que é o mesmo defeito com outro nome.
 */
function excerpt(path: string, content: string, terms: string[], cited: string[]): SiblingExcerpt {
  if (content.length <= SIBLING_FILE_FULL_MAX) {
    return { text: content, usedRefs: [...cited], droppedRefs: [], windowedRefs: [] };
  }

  const secs = sections(content);
  const outline = headingOutline(secs);
  let spent = outline.length;
  const chosenIdx = new Set<number>();
  const chosen: Array<{ i: number; body: string }> = [];
  const usedRefs: string[] = [];
  const windowedRefs: string[] = [];

  // 🔴 GAP-75 — reserva das seções CITADAS antes da relevância. Medido em prod: as citadas ausentes
  // tinham 127, 1.069, 2.061, 2.854 e 3.214 chars com o bloco em 49k de 60k — cabiam de sobra. Era
  // ORDEM, não orçamento, exatamente como no lado do alvo (GAP-72/73).
  const { picks, unlocatable } = citedPicks(secs, cited);
  const droppedRefs: string[] = [...unlocatable];
  for (const p of picks) {
    if (spent + p.body.length <= SIBLING_FILE_BUDGET) {
      spent += p.body.length;
      chosenIdx.add(p.i);
      chosen.push({ i: p.i, body: p.body });
      usedRefs.push(...p.refs);
      continue;
    }
    // Paridade com o GAP-74: seção citada grande demais vem RECORTADA em vez de não vir.
    const room = Math.min(SIBLING_WINDOW_BUDGET, SIBLING_FILE_BUDGET - spent);
    const win = room > 0 ? sectionWindow(p.subtree, [...terms, ...p.refs], room) : null;
    if (win === null) { droppedRefs.push(...p.refs); continue; }
    spent += win.length;
    chosenIdx.add(p.i);
    chosen.push({ i: p.i, body: win });
    usedRefs.push(...p.refs);
    windowedRefs.push(...p.refs);
  }

  const scored = secs
    .map((s, i) => {
      const hay = s.body.toLowerCase();
      let hits = 0;
      for (const t of terms) if (t && hay.includes(t)) hits += 1;
      return { i, s, hits };
    })
    .filter((x) => x.hits > 0 && !chosenIdx.has(x.i))
    .sort((a, b) => b.hits - a.hits || a.i - b.i);
  for (const x of scored) {
    const body = clip(x.s.body, SIBLING_SECTION_BUDGET);
    if (spent + body.length > SIBLING_FILE_BUDGET) continue;
    spent += body.length;
    chosenIdx.add(x.i);
    chosen.push({ i: x.i, body });
  }

  if (chosen.length > 0) {
    // Ordem de LEITURA (i crescente) depois de escolher: o arquivo continua fazendo sentido de cima
    // para baixo, o que importa quando as seções se referenciam entre si.
    const parts = chosen.sort((a, b) => a.i - b.i).map((x) => x.body);
    return {
      text: [
        `[RESUMO DIRIGIDO de \`${path}\` (${content.length} chars) — abaixo, o SUMÁRIO COMPLETO de seções e,`,
        "em seguida, as seções que os GAPs citam deste arquivo e as que mencionam o que eles disputam. Uma",
        "regra pode existir numa seção NÃO transcrita: o sumário diz o que existe, então",
        "não conclua que o irmão silencia sobre um assunto listado ali.]",
        ...(windowedRefs.length > 0
          ? [`[JANELA: ${windowedRefs.join(", ")} não caberia(m) inteira(s) e vem/vêm RECORTADA(S) — cada`,
             " `[… trecho omitido da mesma seção …]` marca texto que EXISTE no irmão e não está aqui.]"]
          : []),
        ...(droppedRefs.length > 0
          ? [`[ATENÇÃO: ${droppedRefs.join(", ")} — citada(s) pelos GAPs neste irmão — NÃO foi/foram`,
             " transcrita(s) neste recorte. Para esses GAPs, DECLARE na linha final que o trecho do irmão",
             " não veio; não afirme o que ele diz nem o que ele deixa de dizer.]"]
          : []),
        "",
        "SUMÁRIO DE SEÇÕES:",
        outline,
        "",
        "SEÇÕES RELEVANTES:",
        parts.join("\n\n"),
      ].join("\n"),
      usedRefs,
      droppedRefs,
      windowedRefs,
    };
  }

  // Nenhuma seção citada nem termo casou (ou nada caberia): volta ao head-truncate, que ao menos
  // preserva o começo. As citadas viram declaração — o modelo não pode ler ausência como inexistência.
  return {
    text: `${content.slice(0, SIBLING_FILE_BUDGET)}\n\n[… \`${path}\` truncado aqui (${content.length} chars no total) — a ausência de um trecho neste recorte NÃO significa que ele não exista no arquivo …]`,
    usedRefs: [],
    droppedRefs: [...new Set([...droppedRefs, ...picks.flatMap((p) => p.refs)])],
    windowedRefs: [],
  };
}

/**
 * 🔴 GAP-75 — os endereços de seção que os GAPs citam NOMEANDO este irmão.
 *
 * Complemento exato do `citedRefs` do lado do alvo (GAP-73), pela MESMA régua (`citedSectionRefs`): lá
 * a citação com nome de outro arquivo é descartada; aqui é justamente ela que interessa. Medido em
 * prod: 14 de 20 GAPs são cross-file, e 7 das 14 seções citadas nunca chegavam ao prompt.
 */
function siblingCitedRefs(findings: ValidationFinding[], ref: SiblingRef): string[] {
  const names = new Set([ref.path.toLowerCase(), ref.filename.toLowerCase()].filter(Boolean));
  const out = new Set<string>();
  for (const f of findings) {
    for (const text of [String(f.title ?? ""), String(f.rationale ?? "")]) {
      for (const c of citedSectionRefs(text)) if (c.file && names.has(c.file)) out.add(c.ref);
    }
  }
  return [...out];
}

/**
 * Monta o bloco de irmãos citados pelos GAPs deste arquivo.
 *
 * Ordem: mais citado primeiro (é o que o GAP realmente discute); o índice primário entra por último e
 * só se sobrar orçamento (ele situa, não normatiza). O arquivo alvo NUNCA entra — ele já vai inteiro
 * como conteúdo a editar.
 */
export async function buildSiblingContext(
  files: SiblingRef[],
  targetPath: string,
  findings: ValidationFinding[],
  opts: { totalBudget?: number } = {},
): Promise<SiblingContext> {
  const budget = opts.totalBudget ?? SIBLING_TOTAL_BUDGET;
  const text = findingsText(findings);
  const others = files.filter((f) => f.path !== targetPath);
  const cited = others
    .map((f) => ({ ref: f, n: citations(text, f) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.ref.path.localeCompare(b.ref.path))
    .map((x) => x.ref);
  const primary = others.find((f) => f.isPrimary);
  const queue = primary && !cited.includes(primary) ? [...cited, primary] : cited;

  const terms = disputedTerms(findings);
  const parts: string[] = [];
  const used: string[] = [];
  const omitted: string[] = [];
  const citedUsed: string[] = [];
  const citedDropped: string[] = [];
  const citedWindowed: string[] = [];
  let spent = 0;
  for (const ref of queue) {
    const raw = await readFile(ref.filePath, "utf-8").catch(() => null);
    if (raw === null) continue;
    const refsHere = siblingCitedRefs(findings, ref);
    const ex = excerpt(ref.path, raw, terms, refsHere);
    const body = ex.text;
    if (spent + body.length > budget) {
      omitted.push(ref.path);
      // O irmão inteiro ficou fora: as seções que os GAPs citam dele também não vieram, e isso tem de
      // aparecer na medição — senão o log conta como coberta uma citação que nunca chegou.
      citedDropped.push(...refsHere.map((r) => `${ref.path} ${r}`));
      continue;
    }
    spent += body.length;
    used.push(ref.path);
    citedUsed.push(...ex.usedRefs.map((r) => `${ref.path} ${r}`));
    citedDropped.push(...ex.droppedRefs.map((r) => `${ref.path} ${r}`));
    citedWindowed.push(...ex.windowedRefs.map((r) => `${ref.path} ${r}`));
    parts.push(`─── IRMÃO SÓ LEITURA: \`${ref.path}\`${ref.isPrimary ? " (índice da spec)" : ""} ───\n${body}`);
  }
  if (parts.length === 0) return { block: "", used, omitted, citedUsed, citedDropped, citedWindowed };
  const warn = omitted.length
    ? `\n[… ${omitted.length} outro(s) arquivo(s) citado(s) não couberam nesta rodada: ${omitted.join(", ")} …]`
    : "";
  return { block: `${parts.join("\n\n")}${warn}`, used, omitted, citedUsed, citedDropped, citedWindowed };
}
