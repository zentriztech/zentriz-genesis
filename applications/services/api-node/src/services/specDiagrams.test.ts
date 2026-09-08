/**
 * specDiagrams.test.ts — o veto do documento de DESENHOS da arquitetura (feature do Jean, 2026-09-08).
 *
 * O que estes testes travam é o motivo de o veto existir: o objetivo declarado é ENTENDIMENTO, e um
 * arquivo pode existir, contar 3 cercas e ainda assim não desenhar nada. Cada caso abaixo é um jeito
 * de o usuário abrir a aba Spec e NÃO ver os desenhos:
 *
 *   • cerca aberta e não fechada → o resto do arquivo vira código e nada renderiza;
 *   • primeira instrução que o mermaid não conhece → `mermaid.render()` falha e o portal cai no `<pre>`
 *     com o código cru (o `catch` do `MermaidBlock`);
 *   • menos de 3 desenhos → é o mínimo que o Jean pediu, literalmente;
 *   • 3 cercas com o MESMO desenho → cumpre o número sem cumprir o objetivo (fechamento fake).
 *
 * E o que o veto NÃO pode fazer, também travado aqui: exigir tipo de diagrama, exigir os três exemplos
 * do Jean ("modelo global, APIs, infra"), reprovar por estilo. Isso seria o código decidindo conteúdo,
 * contra a Lei de que a spec é decisão do agente.
 */
import { describe, it, expect } from "vitest";
import { assessDiagrams, mermaidBlocks, DIAGRAMS_PATH, MIN_DIAGRAMS, MERMAID_KINDS } from "./specDiagrams.js";

/** Um documento válido de referência: 3 recortes diferentes, 3 tipos diferentes. */
const BOM = [
  "# Arquitetura do NVX LastMile — desenhos",
  "",
  "Os diagramas abaixo mostram a arquitetura que a especificação decidiu.",
  "",
  "## Modelo global",
  "",
  "```mermaid",
  "flowchart LR",
  '  APP["App do motorista"] --> API["API de última milha"]',
  '  API --> DB[("Postgres")]',
  "```",
  "",
  "Fica de fora o detalhe de autenticação, que está no próximo desenho.",
  "",
  "## APIs e integrações",
  "",
  "```mermaid",
  "sequenceDiagram",
  "  participant App",
  "  participant API",
  "  App->>API: POST /entregas",
  "  API-->>App: 201 Created",
  "```",
  "",
  "Fica de fora a topologia de rede.",
  "",
  "## Infraestrutura",
  "",
  "```mermaid",
  "graph TD",
  '  ALB["ALB"] --> ECS["ECS Fargate"]',
  '  ECS --> RDS["RDS Postgres"]',
  "```",
  "",
  "Fica de fora o dimensionamento de cada nó.",
  "",
].join("\n");

function fence(code: string): string {
  return ["```mermaid", code, "```", ""].join("\n");
}
/** Documento com N desenhos DIFERENTES (o índice entra no rótulo, então nenhum repete). */
function doc(n: number, kind = "flowchart LR"): string {
  const out = ["# Arquitetura — desenhos", "", "Introdução.", ""];
  for (let i = 1; i <= n; i++) out.push(`## Recorte ${i}`, "", fence(`${kind}\n  A${i}["Nó ${i}"] --> B${i}["Outro ${i}"]`));
  return out.join("\n");
}

describe("contratos do módulo", () => {
  it("o caminho e o mínimo são os que o Jean pediu", () => {
    expect(DIAGRAMS_PATH).toBe("arquitetura-diagramas.md");
    expect(MIN_DIAGRAMS).toBe(3);
  });

  it("os tipos aceitos são os que o mermaid renderiza (flowchart, sequência, ER, C4…)", () => {
    for (const k of ["flowchart", "graph", "sequenceDiagram", "erDiagram", "C4Container", "stateDiagram-v2"]) {
      expect(MERMAID_KINDS as readonly string[]).toContain(k);
    }
  });
});

describe("mermaidBlocks — o leitor de cercas", () => {
  it("acha os blocos mermaid na ordem, com o tipo e a linha da cerca", () => {
    const { blocks, unclosedAt } = mermaidBlocks(BOM);
    expect(unclosedAt).toBeNull();
    expect(blocks.map((b) => b.kind)).toEqual(["flowchart", "sequenceDiagram", "graph"]);
    expect(blocks[0].line).toBe(7);
    expect(blocks[0].code).toContain("App do motorista");
  });

  it("bloco de OUTRA linguagem não é desenho (um exemplo de JSON no meio não conta)", () => {
    const md = `${doc(3)}\n## Exemplo de payload\n\n\`\`\`json\n{"a":1}\n\`\`\`\n`;
    expect(mermaidBlocks(md).blocks).toHaveLength(3);
  });

  it("cerca de 3 DENTRO de cerca de 4 não fecha a de fora (é como o portal lê)", () => {
    const md = ["````mermaid", "flowchart LR", "  A --> B", "```", "  B --> C", "````", ""].join("\n");
    const { blocks, unclosedAt } = mermaidBlocks(md);
    expect(unclosedAt).toBeNull();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].code).toContain("B --> C");
  });

  it("cerca aberta e nunca fechada é reportada com a linha (ela engole o resto do arquivo)", () => {
    const md = ["# Título", "", "```mermaid", "flowchart LR", "  A --> B", "", "## Outra seção", ""].join("\n");
    const { blocks, unclosedAt } = mermaidBlocks(md);
    expect(unclosedAt).toBe(3);
    expect(blocks).toHaveLength(0);
  });

  it("comentário e diretiva `%%{init}%%` não são o tipo do diagrama", () => {
    const { blocks } = mermaidBlocks(fence('%%{init: {"theme":"dark"} }%%\n%% comentário\nerDiagram\n  A ||--o{ B : tem'));
    expect(blocks[0].kind).toBe("erDiagram");
  });

  it("documento sem cerca nenhuma: zero blocos, nenhuma cerca aberta", () => {
    expect(mermaidBlocks("# Só texto\n\nnada de desenho.\n")).toEqual({ blocks: [], unclosedAt: null });
  });
});

describe("assessDiagrams — aprova o que desenha", () => {
  it("3 recortes diferentes com 3 tipos diferentes → aprovado, com contagem e tipos", () => {
    const v = assessDiagrams(BOM);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.diagrams).toBe(3);
    expect(v.kinds).toEqual(["flowchart", "sequenceDiagram", "graph"]);
    expect(v.content.endsWith("\n")).toBe(true);
  });

  it("MAIS de 3 desenhos é aprovado — o mínimo não é teto", () => {
    const v = assessDiagrams(doc(6));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.diagrams).toBe(6);
  });

  it("o veto NÃO exige tipo específico nem os três exemplos do Jean", () => {
    // Três diagramas do MESMO tipo, de recortes que não são "global/APIs/infra": aprovado. Quais
    // diagramas o produto precisa é decisão do agente — o código só recusa o que não renderiza.
    const v = assessDiagrams(doc(3, "stateDiagram-v2"));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.kinds).toEqual(["stateDiagram-v2", "stateDiagram-v2", "stateDiagram-v2"]);
  });

  it("BOM inteiro sobrevive byte a byte (só apara as pontas e garante o \\n final)", () => {
    const v = assessDiagrams(`\n\n${BOM}\n\n`);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.content).toBe(`${BOM.trim()}\n`);
  });
});

describe("assessDiagrams — recusa o que não desenha", () => {
  it("EMPTY: o agente não devolveu conteúdo", () => {
    for (const nada of ["", "   \n\n", "﻿  "]) {
      const v = assessDiagrams(nada);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe("EMPTY");
    }
  });

  it("LOOKS_LIKE_EDITS: veio bloco de edição para um arquivo que ainda não existe", () => {
    const v = assessDiagrams("<<<<<<< SEARCH\n## Antigo\n=======\n## Novo\n>>>>>>> REPLACE\n");
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("LOOKS_LIKE_EDITS");
      expect(v.message).toContain("ainda não existe");
    }
  });

  it("🔴 FENCE_UNCLOSED: cerca aberta apontada pela linha — nenhum desenho renderizaria", () => {
    const v = assessDiagrams(`${doc(3)}\n## Quarto recorte\n\n\`\`\`mermaid\nflowchart LR\n  X --> Y\n`);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("FENCE_UNCLOSED");
      expect(v.message).toMatch(/linha \d+/);
    }
  });

  it("TOO_FEW: 2 desenhos não são 3 (o mínimo é o pedido explícito)", () => {
    const v = assessDiagrams(doc(2));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("TOO_FEW");
      expect(v.message).toContain("mínimo é 3");
    }
  });

  it("TOO_FEW também quando o texto fala de arquitetura e não desenha nada", () => {
    const v = assessDiagrams("# Arquitetura\n\nA arquitetura é composta por app, API e banco.\n");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("TOO_FEW");
  });

  it("EMPTY_DIAGRAM: cerca sem desenho conta na aparência e não no entendimento", () => {
    const v = assessDiagrams(`${doc(3)}\n## Quarto recorte\n\n\`\`\`mermaid\n\n\`\`\`\n`);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("EMPTY_DIAGRAM");
  });

  it("🔴 UNKNOWN_KIND: tipo que o mermaid não conhece → o portal mostraria o código cru", () => {
    const md = `${doc(2)}\n## Terceiro recorte\n\n${fence('arquitetura\n  APP["App"] --> API["API"]')}`;
    const v = assessDiagrams(md);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("UNKNOWN_KIND");
      expect(v.message).toContain("código cru");
    }
  });

  it("UNKNOWN_KIND: desenho que começa direto nos nós, sem declarar o tipo", () => {
    const md = `${doc(2)}\n## Terceiro\n\n${fence('A["um"] --> B["dois"]')}`;
    const v = assessDiagrams(md);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("UNKNOWN_KIND");
  });

  it("🔴 DUPLICATE: 3 cercas com o mesmo desenho não são 3 diagramas (fechamento fake)", () => {
    const igual = fence('flowchart LR\n  A["App"] --> B["API"]');
    const md = ["# Arquitetura", "", "## Global", "", igual, "## APIs", "", igual, "## Infra", "", igual].join("\n");
    const v = assessDiagrams(md);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("DUPLICATE");
      expect(v.message).toContain("repete um desenho anterior");
    }
  });

  it("DUPLICATE ignora reindentação: mexer só nos espaços não cria um desenho novo", () => {
    const a = fence('flowchart LR\n  A["App"] --> B["API"]');
    const b = fence('flowchart   LR\n      A["App"]   -->   B["API"]\n');
    const md = ["# Arquitetura", "", a, b, fence("erDiagram\n  A ||--o{ B : tem")].join("\n");
    const v = assessDiagrams(md);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("DUPLICATE");
  });

  it("desenhos PARECIDOS mas diferentes passam (a assinatura é o desenho, não a semelhança)", () => {
    const md = [
      "# Arquitetura", "",
      fence('flowchart LR\n  A["App"] --> B["API"]'),
      fence('flowchart LR\n  A["App"] --> C["Fila"]'),
      fence('flowchart TD\n  A["App"] --> B["API"]'),
    ].join("\n");
    expect(assessDiagrams(md).ok).toBe(true);
  });
});
