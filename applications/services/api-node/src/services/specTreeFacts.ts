/**
 * 🔴 GAP-160 (medido em prod, run `5b18a1b0`, 2026-09-09) — **o CTO-editor edita um arquivo da spec sem
 * saber que os outros existem.**
 *
 * Os três caminhos que poderiam entregar essa árvore não entregam:
 *
 *  • `productMapBlock` — sai **vazio** (`productContext.ts`: o bloco só é renderizado com `projects.length > 1`,
 *    e em prod 58/58 projetos têm UM). Medido: `mapa=0c` em 5 de 5 chamadas do laço;
 *  • `gapIndexBlock` (GAP-122) — retorna `""` para todo alvo que não é o `README.md`;
 *  • bloco de irmãos (A5.5) — traz apenas os irmãos **citados pelos GAPs** (+ o primário se sobrar
 *    orçamento). Medido no bloco REAL (zero LLM, `buildSiblingContext` sobre a spec do NVX): o bloco
 *    entregue **nomeia 2 de 13** arquivos (o primário e o `README.md`), com `seções citadas 0/0`.
 *
 * ⇒ Para o editor, a spec é o arquivo dele mais um irmão. E a família dominante dos blockers do NVX é
 * exatamente consistência **cross-arquivo** (24 de 26 no censo do GAP-156): quem não sabe que
 * `privacidade-lgpd.md` existe só tem duas saídas ao receber um GAP de LGPD — redeclarar a regra no
 * próprio arquivo (o defeito que os oráculos do GAP-22 existem para matar) ou migrar a contradição para
 * o irmão. Nas duas, a rodada é paga e a contagem sobe.
 *
 * ## O que este módulo faz (e o que NÃO faz)
 *
 * Entrega UM fato: a árvore da spec **medida agora** (nome, tamanho em bytes do disco, título H1 quando
 * legível) e, dela, **quais corpos estão neste prompt e quais não estão**. Não decide onde cada regra
 * mora, não prescreve formato, não escreve índice e não veta nada — isso é do agente (Lei: Genesis é
 * 100% LLM). O tamanho vai em **bytes** porque é o que `stat` mede; chamar de "chars" seria mentir num
 * fato que o agente pode usar para decidir o que cortar.
 *
 * ## Por que a árvore vem no TOPO — e por que ela NÃO é ponto de cache (🔴 GAP-168, medido)
 *
 * Ela vem no topo porque é o ENQUADRAMENTO ("isto é a spec; UM destes arquivos é o seu"), e isso o
 * GAP-160 mediu. O que este módulo afirmava a mais — que ela seria "o único bloco invariável entre
 * arquivos de um mesmo passe" e por isso "o primeiro candidato REAL a ponto de cache" — foi **REFUTADO
 * pela medição do GAP-167** (`prompt_census`, 87 chamadas de `api-gapfile` em 6 h de prod):
 *
 *   maior prefixo que repetiu dentro do TTL = **4.096c**, e em apenas **2 de 87 chamadas (2,3%)**;
 *   cabeça média 50.281c; 0 chamadas com a cabeça inteira repetida.
 *
 * A árvore não pode ser invariável por duas razões que são de PROJETO, não de descuido: (a) ela é
 * medida agora no disco, e o laço ESCREVE nos arquivos entre duas chamadas do mesmo passe (bytes,
 * título e sumário do irmão já editado mudam); (b) ela carrega marcas por arquivo (o alvo, o corpo
 * recortado/presente) porque são fatos sobre ESTE prompt. ⇒ Marcar ponto de cache aqui pagaria **1,25×
 * de escrita em 97,7% das chamadas** para ler 0,1× em 2,3%: é regressão, e a frente está FECHADA com
 * número. A economia de token do escritor não está no cache — está na composição medida do prompt
 * (`file_content` 59%, irmãos 13%, oráculos 11%, árvore 10%).
 */
import { open, readFile, stat } from "node:fs/promises";
import {
  splitSections, headingOutline, citedSectionRefs, buildAnchorIndex, locateSectionIndex,
} from "../lib/markdownSections.js";
import type { SpecFileRef } from "./specGapScope.js";
import { MANIFEST_PATH } from "./specManifest.js";

/** Quanto se lê da cabeça de cada arquivo para achar o H1 (frontmatter YAML cabe folgado). */
const TITLE_PROBE_BYTES = 2_048;
/** Teto do título transportado — título é rótulo, não resumo. */
const TITLE_MAX_CHARS = 90;

/**
 * 🔴 GAP-161 — orçamento dos SUMÁRIOS de cabeçalhos dos irmãos ausentes. Medido na spec do NVX
 * LastMile (1,3 MB em 14 arquivos): os sumários somam 22.665c, dos quais 18.276c são de arquivos que
 * não vão ao prompt do editor. O teto existe para spec de 60 arquivos, não para esta.
 */
export const TREE_OUTLINE_TOTAL_BUDGET = 24_000;
/** Teto de UM sumário: `autenticacao-sessao.md` tem 72 seções / 3.346c — um arquivo não come o resto. */
export const TREE_OUTLINE_FILE_BUDGET = 3_500;

export interface SpecTreeEntry {
  path: string;
  /** Bytes no disco. `null` = não foi possível medir (o arquivo entra na árvore MESMO assim). */
  bytes: number | null;
  /** Primeiro `# H1` do arquivo, quando legível. `null` = sem H1 ou ilegível. */
  title: string | null;
  isPrimary: boolean;
  isManifest: boolean;
  /**
   * 🔴 GAP-161 — sumário de cabeçalhos (Markdown apenas), pela MESMA régua do juiz (`headingOutline`).
   * `null` = não é `.md`, ilegível, ou sem cabeçalho nenhum.
   */
  outline?: string | null;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Primeiro `# título` do texto, ignorando frontmatter YAML e linhas em branco. */
export function firstHeading(head: string): string | null {
  const lines = head.split(/\r?\n/);
  let i = 0;
  if (lines[0]?.trim() === "---") {
    i = 1;
    while (i < lines.length && lines[i].trim() !== "---") i++;
    i++; // pula o fechamento
  }
  for (; i < lines.length; i++) {
    const m = /^#\s+(.+?)\s*$/.exec(lines[i]);
    if (m) return m[1].slice(0, TITLE_MAX_CHARS);
  }
  return null;
}

/**
 * Mede a árvore no disco. Best-effort POR ARQUIVO: um arquivo ilegível entra na lista sem tamanho e sem
 * título — sumir com ele seria pior que não ter o bloco, porque o agente concluiria que ele não existe
 * (a mentira exata que este GAP corrige).
 *
 * Lê só a CABEÇA de cada arquivo (`TITLE_PROBE_BYTES`): a árvore de 14 arquivos não pode custar 1,3 MB
 * de leitura por chamada de LLM.
 */
export async function loadSpecTree(files: readonly SpecFileRef[]): Promise<SpecTreeEntry[]> {
  return Promise.all(files.map(async (f) => {
    const base: SpecTreeEntry = {
      path: f.path,
      bytes: null,
      title: null,
      isPrimary: f.isPrimary === true,
      isManifest: norm(f.path) === norm(MANIFEST_PATH) || norm(f.filename) === norm(MANIFEST_PATH),
      outline: null,
    };
    const bytes = await stat(f.filePath).then((s) => s.size).catch(() => null);
    // 🔴 GAP-161: em Markdown vale ler o arquivo inteiro — o sumário de cabeçalhos é o mapa que o juiz
    // já recebe e o editor não recebia, e 1,3 MB de I/O local é ruído ao lado de uma chamada de LLM de
    // ~40k tokens. Em NÃO-Markdown (`connect.yaml`) o `headingOutline` renderiza comentários `#` como se
    // fossem seções — medido: 1.981c de ruído — então ali fica só a cabeça, como antes.
    if (norm(f.path).endsWith(".md")) {
      const raw = await readFile(f.filePath, "utf-8").catch(() => null);
      if (raw !== null) {
        const out = headingOutline(splitSections(raw));
        return { ...base, bytes, title: firstHeading(raw), outline: out.length > 0 ? out : null };
      }
    }
    let title: string | null = null;
    const fh = await open(f.filePath, "r").catch(() => null);
    if (fh) {
      try {
        const buf = Buffer.alloc(TITLE_PROBE_BYTES);
        const { bytesRead } = await fh.read(buf, 0, TITLE_PROBE_BYTES, 0);
        title = firstHeading(buf.subarray(0, bytesRead).toString("utf-8"));
      } catch { /* arquivo ilegível: a linha existe sem título, não deixa de existir */ }
      await fh.close().catch(() => {});
    }
    return { ...base, bytes, title };
  }));
}

/**
 * Corte de UM sumário. A marca é explícita porque um sumário truncado sem aviso diria ao agente que o
 * arquivo acaba ali — inventaria uma fronteira que não existe.
 */
const clip = (s: string, max: number) =>
  s.length <= max ? s : `${s.slice(0, max)}\n  [… sumário truncado por orçamento: há mais seções neste arquivo …]`;

const human = (bytes: number | null) =>
  bytes === null ? "tamanho não medido" : bytes >= 1_000 ? `${Math.round(bytes / 1_000)}k bytes` : `${bytes} bytes`;

/**
 * O bloco de FATOS da árvore.
 *
 * `bodiesPresent` são os paths cujo TEXTO está neste prompt (o alvo + os irmãos que couberam). Declarar
 * a ausência é a metade que importa: sem ela o agente lê 14 nomes e supõe ter visto 14 arquivos —
 * trocaríamos "não sabe que o irmão existe" por "acha que já leu o irmão", que é pior.
 *
 * 🔴 GAP-168 — `bodiesPartial` é o terceiro estado, e em prod ele é a REGRA: irmão só vai integral com
 * ≤8.000 chars (`SIBLING_FILE_FULL_MAX`) e os arquivos da spec medida têm 51k–106k. Sem essa distinção
 * a árvore escrevia "corpo presente neste prompt" para um resumo dirigido de ≤12k — exatamente o "acha
 * que já leu o irmão" que o parágrafo acima proíbe, e em contradição com o próprio bloco de irmãos, que
 * alguns milhares de chars depois se declara resumo. O recortado NÃO entra no sumário de seções: o
 * resumo dirigido já carrega o sumário COMPLETO do irmão, e repeti-lo seria pagar duas vezes.
 *
 * Spec de arquivo único devolve `""` (não há árvore a informar), pela mesma régua do `gapIndexBlock`.
 */
export function specTreeFactBlock(
  entries: readonly SpecTreeEntry[],
  targetPath: string,
  bodiesPresent: readonly string[] = [],
  bodiesPartial: readonly string[] = [],
): string {
  if (entries.length < 2) return "";
  const present = new Set(bodiesPresent.map(norm));
  const parcial = new Set(bodiesPartial.map(norm));
  const alvo = norm(targetPath);
  present.add(alvo); // o alvo vai inteiro por construção
  parcial.delete(alvo);
  const ausentes: string[] = [];
  const recortados: string[] = [];
  const linhas = entries.map((e) => {
    const p = norm(e.path);
    // 🔴 GAP-168: três estados, não dois. `corpo presente` só para quem veio INTEGRAL — o irmão que veio
    // como resumo dirigido é declarado RECORTE aqui também, senão a árvore contradiz o bloco de irmãos.
    const corpo = p === alvo ? ""
      : parcial.has(p) ? "RECORTE neste prompt (NÃO é o texto integral deste arquivo)"
      : present.has(p) ? "corpo presente neste prompt"
      : "";
    const marcas = [
      p === alvo ? "⟵ ESTE é o arquivo que você edita agora" : "",
      e.isManifest ? "manifesto/índice de entrada" : "",
      e.isPrimary ? "documento primário da spec" : "",
      corpo,
    ].filter(Boolean);
    if (p !== alvo && parcial.has(p)) recortados.push(e.path);
    else if (p !== alvo && !present.has(p)) ausentes.push(e.path);
    return `  • \`${e.path}\` — ${human(e.bytes)}${e.title ? ` — “${e.title}”` : ""}`
      + (marcas.length ? ` [${marcas.join("; ")}]` : "");
  });
  const out = [
    `--- ÁRVORE DA ESPECIFICAÇÃO (medida agora no disco; ${entries.length} arquivo(s)) ---`,
    "A spec é o CONJUNTO abaixo. Você edita UM arquivo; os outros existem, têm dono e continuam valendo.",
    ...linhas,
  ];
  if (recortados.length) {
    // Medido em prod: com irmãos de 51k–106k chars e teto de 8.000 para ir integral, este ramo é o caso
    // NORMAL do laço — e era exatamente ele que a árvore declarava como "corpo presente".
    out.push(
      `MEDIDO: de ${recortados.length} destes arquivos veio um RECORTE, não o texto integral`
      + ` (${recortados.join(", ")}). O que não foi transcrito CONTINUA no arquivo: trate o recorte como`
      + " endereço do que existe, não como o conteúdo completo daquele irmão.",
    );
  }
  if (ausentes.length) {
    out.push(
      `MEDIDO: o TEXTO de ${ausentes.length} destes arquivos NÃO está neste prompt`
      + ` (${ausentes.join(", ")}).`,
      "Não presuma o conteúdo deles nem afirme que algo “não está especificado” com base nesta ausência:"
      + " se a decisão depende do que um deles diz, registre a dependência em vez de redeclarar a regra aqui.",
    );
    out.push(...outlineBlock(entries, ausentes));
  }
  out.push("--- FIM DA ÁRVORE ---", "");
  return out.join("\n");
}

/**
 * 🔴 GAP-161 — o SUMÁRIO DE SEÇÕES dos irmãos cujo texto não veio.
 *
 * ## A assimetria que isto fecha (medida em prod, 2026-09-09)
 *
 * O JUIZ do estágio B recebe, de todo arquivo que não cabe integral, o inventário mais o sumário
 * COMPLETO de cabeçalhos (`buildValidationInput`: `===== path — SÓ SUMÁRIO (arquivo EXISTE, N chars)`).
 * O EDITOR, mesmo depois do GAP-160, recebia só o NOME dos irmãos. Ou seja: o auditor podia dizer
 * "isto contradiz a seção X de `privacidade-lgpd.md`" e o editor não tinha como saber que essa seção
 * existe — e a instrução do GAP-160 ("registre a dependência em vez de redeclarar a regra") pede
 * exatamente um endereço que ele não tinha. Auditor mais informado que o escritor é o defeito que a
 * medição do revisor cross-family já havia mostrado em outra camada: quem escreve não pode ser o mais
 * cego da mesa.
 *
 * Medido: os 14 sumários da spec do NVX somam 22.665c (18.276c fora do prompt do editor) — ~4,5k tokens
 * contra as ~340k tokens que UM passe custa. Se poupar uma rodada, paga sete vezes.
 *
 * Ordem de alocação: o MENOR primeiro (cabe o máximo de arquivos), empate pela ordem da árvore. É
 * transporte, não julgamento — quem escolhe o que importa é o agente, com o mapa na mão. O que não
 * couber é DECLARADO: sumário ausente não pode passar por "arquivo sem estrutura".
 */
function outlineBlock(entries: readonly SpecTreeEntry[], ausentes: readonly string[]): string[] {
  const alvos = new Set(ausentes.map(norm));
  const comSumario = entries
    .filter((e) => alvos.has(norm(e.path)) && typeof e.outline === "string" && e.outline.length > 0)
    .map((e, i) => ({ e, i, texto: clip(e.outline as string, TREE_OUTLINE_FILE_BUDGET) }))
    .sort((a, b) => a.texto.length - b.texto.length || a.i - b.i);
  if (comSumario.length === 0) return [];

  const partes: string[] = [];
  const foraDoOrcamento: string[] = [];
  let gasto = 0;
  for (const { e, texto } of comSumario) {
    if (gasto + texto.length > TREE_OUTLINE_TOTAL_BUDGET) { foraDoOrcamento.push(e.path); continue; }
    gasto += texto.length;
    partes.push(`  ┌ \`${e.path}\`\n${texto}`);
  }
  if (partes.length === 0) return [];

  const out = [
    `SUMÁRIO DE SEÇÕES dos arquivos acima cujo texto NÃO veio (${partes.length} de ${ausentes.length}) —`
    + " só os CABEÇALHOS, medidos no disco agora; o corpo de cada seção continua fora deste prompt.",
    "Use-o para APONTAR onde a regra mora (o cabeçalho é o endereço) e para não redeclarar aqui o que já"
    + " tem lugar lá. Um cabeçalho listado é prova de que a seção EXISTE; o que ele diz, você não viu.",
    ...partes,
  ];
  if (foraDoOrcamento.length) {
    out.push(
      `[${foraDoOrcamento.length} sumário(s) não couberam no orçamento desta chamada:`
      + ` ${foraDoOrcamento.join(", ")}. A estrutura desses arquivos NÃO está aqui — a ausência é de`
      + " orçamento, não de conteúdo.]",
    );
  }
  return out;
}

/**
 * 🔴 GAP-163 — **remissão morta**: o arquivo manda ler `contratos-erros.md §7.4` e o localizador do laço
 * não acha `§7.4` naquele arquivo.
 *
 * ## Por que isto é fato do CÉREBRO, e não só um defeito de redação
 *
 * O localizador é o MESMO que reserva no prompt a seção citada por um GAP (`citedSectionRefs` +
 * `locateSectionIndex`, GAP-73 no alvo e GAP-75 no irmão). Um endereço que não casa cobra duas vezes: o
 * humano (ou o agente) que segue a remissão não chega ao texto, e o revisor que cita aquele endereço
 * recebe o recorte VAZIO — o defeito fica indiscutível porque o trecho em disputa nunca aparece.
 *
 * ## O que foi medido em prod (spec do NVX LastMile, 14 arquivos, 2026-09-09)
 *
 * 933 remissões cross-arquivo resolvíveis; **6 mortas** (0,64%), concentradas em dois arquivos
 * (`definicao-de-pronto.md` → `contratos-erros.md §2.6`, `modelo-dados.md §2.7`; `modelo-dados.md` →
 * `contratos-erros.md §7.4`, `§8.6`, `§11.5`). Nenhum instrumento do laço media isso: nem o estágio A,
 * nem o juiz (que recebe os sumários e ainda assim não reclamou de nenhuma das 6).
 *
 * ## A régua é a de CORPO, e essa escolha foi medida
 *
 * Checar o endereço só contra os CABEÇALHOS do destino seria mais barato e daria **13** "mortas" — das
 * quais **7 são falso positivo** (a seção existe, o número só não está no cabeçalho: `visao-escopo.md §7`,
 * `privacidade-lgpd.md §2.3`…). 54% de falso positivo num fato que o agente vai acreditar é pior que não
 * ter o fato. Então vale o custo do índice de âncoras do destino (medido em prod: 160–300 ms para a spec
 * inteira; aqui só os arquivos REALMENTE citados pelo alvo são indexados).
 *
 * Lei 100% LLM: entrega a MEDIÇÃO e diz explicitamente que não é veredicto — reendereçar, remover a
 * remissão ou mantê-la (porque a régua é que não casa) é decisão do agente, com o sumário do destino na
 * mão (GAP-161).
 */
export interface DeadRemission {
  /** O endereço como está escrito no arquivo de origem (`§7.4`). */
  ref: string;
  /** O arquivo de destino, no path da árvore. */
  toPath: string;
}

/** Teto de remissões mortas listadas — o que passar disso é DECLARADO, não silenciado. */
export const DEAD_REMISSION_MAX = 12;

/**
 * Mede as remissões mortas QUE SAEM do arquivo alvo. Best-effort: qualquer leitura que falhe apenas
 * deixa de acusar (nunca acusa por não ter lido — um "morto" falso mandaria o agente reescrever o que
 * está certo).
 *
 * Lê o alvo do DISCO de propósito: no laço o prompt pode levar um recorte do arquivo, e a remissão que
 * ficou fora do recorte continua no arquivo.
 */
export async function deadRemissions(
  files: readonly SpecFileRef[],
  targetPath: string,
): Promise<DeadRemission[]> {
  const alvo = files.find((f) => norm(f.path) === norm(targetPath));
  if (!alvo || files.length < 2) return [];
  const texto = await readFile(alvo.filePath, "utf-8").catch(() => null);
  if (texto === null) return [];

  const porNome = new Map<string, SpecFileRef>();
  for (const f of files) {
    if (!norm(f.path).endsWith(".md")) continue;
    porNome.set(norm(f.path), f);
    porNome.set(norm(f.filename), f);
  }

  // Agrupa por DESTINO: um índice de âncoras por arquivo citado, não um por citação.
  const porDestino = new Map<string, { file: SpecFileRef; refs: string[] }>();
  for (const c of citedSectionRefs(texto)) {
    if (!c.file) continue; // citação do próprio arquivo — não é remissão
    const dest = porNome.get(norm(c.file));
    if (!dest || norm(dest.path) === norm(alvo.path)) continue;
    const acc = porDestino.get(dest.path) ?? { file: dest, refs: [] };
    if (!acc.refs.includes(c.ref)) acc.refs.push(c.ref);
    porDestino.set(dest.path, acc);
  }

  const mortas: DeadRemission[] = [];
  for (const { file, refs } of porDestino.values()) {
    const raw = await readFile(file.filePath, "utf-8").catch(() => null);
    if (raw === null) continue; // destino ilegível: não dá para afirmar que o endereço não existe
    const idx = buildAnchorIndex(splitSections(raw));
    for (const ref of refs) {
      if (locateSectionIndex(idx, ref) === null) mortas.push({ ref, toPath: file.path });
    }
  }
  return mortas;
}

/**
 * O bloco de FATOS das remissões mortas. `""` quando não há nenhuma — silêncio aqui significa "medi e
 * não achei", e é por isso que o bloco diz que a medição foi feita AGORA.
 */
export function deadRemissionFactBlock(dead: readonly DeadRemission[], targetPath: string): string {
  if (dead.length === 0) return "";
  const listadas = dead.slice(0, DEAD_REMISSION_MAX);
  const sobra = dead.length - listadas.length;
  const out = [
    `--- REMISSÕES DESTE ARQUIVO QUE NÃO CASAM NO DESTINO (${dead.length}, medidas agora no disco) ---`,
    `\`${targetPath}\` manda ler os endereços abaixo, e o localizador do laço NÃO os encontra no arquivo`
    + " de destino:",
    ...listadas.map((d) => `  • \`${d.ref}\` em \`${d.toPath}\``),
  ];
  if (sobra > 0) out.push(`  …(${sobra} remissão(ões) além do teto desta lista, também sem casar)…`);
  out.push(
    "Isto é MEDIÇÃO, não veredicto: o endereço pode ter mudado de número, a seção pode ter saído, ou a"
    + " régua é que não casa com a forma como o destino escreve o endereço. Quem decide o que fazer (ou"
    + " não fazer) é você; o sumário de seções acima é o que o destino tem hoje.",
    "Custa duas vezes: quem seguir a remissão não chega ao texto, e é o MESMO localizador que reserva no"
    + " prompt a seção citada por um GAP — endereço que não casa deixa o revisor sem o trecho em disputa.",
    "--- FIM DAS REMISSÕES ---",
    "",
  );
  return out.join("\n");
}
