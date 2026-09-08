/**
 * specDiagrams.ts — o arquivo de DESENHOS da arquitetura (feature pedida pelo Jean, 2026-09-08).
 *
 * Pedido, verbatim: *"depois que fechar o modelo de arquitetura devemos criar um arquivo md com no
 * minimo 3 desenhos mermaid de arquiteturas, ex: modelo global, APIs, infra; o objetivo é que usuario
 * tenha desenhos que facilite o entendimento de como será na pratica suas aplicacoes e infra."*
 *
 * ## Por que um ARQUIVO da spec, e não uma seção
 *
 * O portal já renderiza ```mermaid como SVG na aba Spec (`spec/page.tsx`, `MermaidBlock`) — então um
 * arquivo de spec com cercas mermaid é, sem nenhum trabalho de UI, exatamente o que o Jean pediu: o
 * usuário abre a spec e VÊ os desenhos. Como arquivo próprio ele também ganha GAPs próprios na
 * validação e evolui pelas rodadas normais do laço, igual ao manifesto (é a lição do GAP-5: o que
 * decide o caminho é a EXISTÊNCIA do arquivo, não o nome dele).
 *
 * ## O que este módulo faz: SÓ O VETO
 *
 * Quais diagramas o produto precisa, o que entra em cada um e como recortá-los é decisão do agente
 * (Lei: Genesis é 100% LLM — estrutura e conteúdo de spec são do CTO, não do código). "modelo global,
 * APIs, infra" são os EXEMPLOS que o Jean deu, não um gabarito: um produto pode precisar de
 * sequência de autenticação, de máquina de estados de pedido, de topologia multi-tenant.
 *
 * O veto existe porque o objetivo declarado é ENTENDIMENTO, e há três jeitos de o arquivo nascer
 * inútil sem ninguém perceber:
 *
 *  1. **menos de 3 desenhos** — o mínimo é o pedido explícito do Jean;
 *  2. **cerca não fechada / tipo de diagrama que o mermaid não conhece** — `mermaid.render()` falha e o
 *     portal cai no `<pre>` com o código cru (o `catch` do `MermaidBlock`). O usuário recebe texto onde
 *     era desenho, e o arquivo passa a existir mentindo que o produto tem diagramas;
 *  3. **desenhos duplicados** — 3 cercas com o mesmo conteúdo satisfazem a contagem e não desenham 3
 *     coisas. É a família do fechamento fake: cumprir o número sem cumprir o objetivo.
 *
 * O que o veto NÃO faz: exigir tipo específico de diagrama, exigir os três exemplos do Jean, contar
 * nós, medir "completude" do desenho ou reprovar por estilo. Isso seria o código decidindo conteúdo.
 */

/** Um lugar só, nome estável: é o que o usuário procura e o que a fila do laço reconhece. */
export const DIAGRAMS_PATH = "arquitetura-diagramas.md";

/** O mínimo que o Jean pediu, literalmente. Não é teto: o agente pode (e deve) desenhar mais. */
export const MIN_DIAGRAMS = 3;

/**
 * Tipos de diagrama que o mermaid entende (v10/v11). A lista existe para uma única finalidade: se a
 * primeira instrução do bloco não é uma delas, o `mermaid.render()` do portal **falha** e o desenho
 * vira `<pre>`. Ela não escolhe qual diagrama usar — só recusa o que não vai desenhar.
 */
export const MERMAID_KINDS = [
  "flowchart", "graph", "sequenceDiagram", "classDiagram", "classDiagram-v2", "stateDiagram",
  "stateDiagram-v2", "erDiagram", "journey", "gantt", "pie", "quadrantChart", "requirementDiagram",
  "gitGraph", "mindmap", "timeline", "zenuml", "sankey-beta", "xychart-beta", "block-beta",
  "packet-beta", "kanban", "architecture-beta", "radar-beta", "treemap-beta",
  "C4Context", "C4Container", "C4Component", "C4Dynamic", "C4Deployment",
] as const;

export interface MermaidBlock {
  /** Corpo do diagrama, sem as cercas. */
  code: string;
  /** Tipo declarado na primeira instrução (`flowchart`, `erDiagram`, …) ou `null` se não reconhecido. */
  kind: string | null;
  /** Linha (1-indexada) da cerca de abertura — para a mensagem de veto apontar o lugar. */
  line: number;
}

/** `true` se a linha abre/fecha cerca de código, devolvendo o marcador e a linguagem declarada. */
function fenceOf(line: string): { marker: string; lang: string } | null {
  const m = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`~]*)/.exec(line);
  return m ? { marker: m[1][0].repeat(m[1].length), lang: (m[2] ?? "").toLowerCase() } : null;
}

/** A primeira instrução do diagrama, ignorando comentários e diretivas `%%{init}%%` do mermaid. */
function kindOf(code: string): string | null {
  for (const raw of code.split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("%%")) continue;
    const head = l.split(/[\s({:;]/)[0];
    const hit = MERMAID_KINDS.find((k) => k.toLowerCase() === head.toLowerCase());
    return hit ?? null;
  }
  return null;
}

/**
 * Os blocos ```mermaid do documento, na ordem. Blocos de OUTRA linguagem são ignorados (um exemplo
 * de JSON no meio do arquivo não é desenho), e uma cerca aberta e não fechada é reportada em
 * `unclosedAt` — a diferença importa: cerca aberta engole o resto do arquivo.
 */
export function mermaidBlocks(md: string): { blocks: MermaidBlock[]; unclosedAt: number | null } {
  const lines = (md ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: MermaidBlock[] = [];
  let open: { marker: string; lang: string; line: number; body: string[] } | null = null;
  for (const [i, line] of lines.entries()) {
    const f = fenceOf(line);
    if (open) {
      // Fecha só com o MESMO marcador e sem linguagem — assim uma cerca aninhada de 3 dentro de uma
      // de 4 não encerra a de fora (é como o CommonMark trata, e é como o portal vai ler).
      if (f && f.marker[0] === open.marker[0] && f.marker.length >= open.marker.length && !f.lang) {
        if (open.lang === "mermaid") {
          const code = open.body.join("\n").trim();
          blocks.push({ code, kind: kindOf(code), line: open.line });
        }
        open = null;
      } else {
        open.body.push(line);
      }
      continue;
    }
    if (f && f.marker.length >= 3) open = { marker: f.marker, lang: f.lang, line: i + 1, body: [] };
  }
  return { blocks, unclosedAt: open ? open.line : null };
}

export type DiagramsVeto =
  | { code: "EMPTY"; message: string }
  | { code: "LOOKS_LIKE_EDITS"; message: string }
  | { code: "FENCE_UNCLOSED"; message: string }
  | { code: "TOO_FEW"; message: string }
  | { code: "EMPTY_DIAGRAM"; message: string }
  | { code: "UNKNOWN_KIND"; message: string }
  | { code: "DUPLICATE"; message: string };

export type DiagramsAssessment =
  | { ok: true; content: string; diagrams: number; kinds: string[] }
  | ({ ok: false } & DiagramsVeto);

/** Assinatura para detectar desenho repetido: só o que muda o DESENHO conta (espaços não contam). */
const shape = (code: string): string => code.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Aprova (ou recusa) o conteúdo proposto para o arquivo de diagramas.
 *
 * Cada recusa é uma forma de o arquivo existir sem servir ao objetivo — nunca uma preferência de
 * estilo. A mensagem diz o que fazer, porque ela volta ao agente na rodada seguinte.
 */
export function assessDiagrams(raw: string): DiagramsAssessment {
  const content = (raw ?? "").replace(/\r\n/g, "\n").replace(/^\uFEFF/, "").trim();
  if (!content) return { ok: false, code: "EMPTY", message: "o agente não devolveu conteúdo para o arquivo de diagramas" };
  if (/^<{5,}\s*SEARCH\s*$/m.test(content)) {
    return {
      ok: false, code: "LOOKS_LIKE_EDITS",
      message: "o agente devolveu blocos de edição, mas o arquivo de diagramas ainda não existe — não há o que editar",
    };
  }
  const { blocks, unclosedAt } = mermaidBlocks(content);
  if (unclosedAt !== null) {
    return {
      ok: false, code: "FENCE_UNCLOSED",
      message: `a cerca de código aberta na linha ${unclosedAt} não foi fechada — o resto do arquivo viraria código e nenhum desenho renderiza`,
    };
  }
  if (blocks.length < MIN_DIAGRAMS) {
    return {
      ok: false, code: "TOO_FEW",
      message: `o arquivo traz ${blocks.length} diagrama(s) mermaid e o mínimo é ${MIN_DIAGRAMS} (ex.: modelo global, APIs, infraestrutura)`,
    };
  }
  const vazio = blocks.find((b) => !b.code.trim());
  if (vazio) {
    return {
      ok: false, code: "EMPTY_DIAGRAM",
      message: `o bloco mermaid da linha ${vazio.line} está vazio — cerca sem desenho conta na aparência e não no entendimento`,
    };
  }
  const desconhecido = blocks.find((b) => b.kind === null);
  if (desconhecido) {
    return {
      ok: false, code: "UNKNOWN_KIND",
      message: `o bloco mermaid da linha ${desconhecido.line} não começa com um tipo de diagrama que o mermaid entenda `
        + `(use um de: ${MERMAID_KINDS.slice(0, 8).join(", ")}, …) — do jeito que está, o portal mostraria o código cru em vez do desenho`,
    };
  }
  const vistos = new Set<string>();
  for (const b of blocks) {
    const s = shape(b.code);
    if (vistos.has(s)) {
      return {
        ok: false, code: "DUPLICATE",
        message: `o bloco mermaid da linha ${b.line} repete um desenho anterior — ${MIN_DIAGRAMS} cercas iguais não são ${MIN_DIAGRAMS} diagramas`,
      };
    }
    vistos.add(s);
  }
  return {
    ok: true, content: `${content}\n`, diagrams: blocks.length,
    kinds: blocks.map((b) => b.kind as string),
  };
}
