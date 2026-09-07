/**
 * 🔴 GAP-74 — a régua da JANELA de seção.
 *
 * Medido em prod (`modelo-dados.md`, runs `32992636` e `a33a0d29`): `§7.4` tem 16.399 chars, nunca cabe
 * no orçamento de 90.000 já gasto pelas outras seções endereçadas, e é citada por 2 dos 4 GAPs cuja
 * seção ficou byte-a-byte INTOCADA em duas rodadas seguidas. Recusar a seção inteira era o pior dos
 * mundos: o agente sabia que faltava texto e não tinha o texto — então escrevia em outro lugar.
 *
 * A propriedade que cada teste trava é a mesma de todo este módulo: o que aparece é VERBATIM (senão o
 * `SEARCH` do CTO-editor não casa no arquivo) e o que falta é MARCADO (senão o modelo lê a ausência
 * como inexistência e recria a seção).
 */
import { describe, it, expect } from "vitest";
import { sectionWindow, WINDOW_GAP_MARK } from "./markdownSections.js";

/** Muitas linhas curtas — é a forma real de uma seção grande de spec, e janela precisa de linhas. */
const manyLines = (tag: string, n: number): string =>
  Array.from({ length: n }, (_, k) => `${tag} linha ${k}: ${"detalhe ".repeat(6)}`).join("\n");

const SECAO = [
  "### 7.4 Retenção e expurgo",
  manyLines("antes", 40),
  "O DELETE de `refresh_tokens` roda no expurgo trimestral.",
  manyLines("depois", 40),
].join("\n");

describe("sectionWindow (GAP-74)", () => {
  it("traz o cabeçalho e a linha do termo VERBATIM, sem o resto da seção", () => {
    const w = sectionWindow(SECAO, ["refresh_tokens"], 2_000);
    expect(w).not.toBeNull();
    expect(w).toContain("### 7.4 Retenção e expurgo");
    expect(w).toContain("O DELETE de `refresh_tokens` roda no expurgo trimestral.");
    // Se a seção inteira viesse, a janela não teria resolvido nada — o defeito era ela não caber.
    expect(w).not.toContain("antes linha 0:");
    expect(w).not.toContain("depois linha 39:");
    expect((w as string).length).toBeLessThan(2_000);
  });

  it("mantém contexto em volta e MARCA cada salto (ausência marcada não é ausência silenciosa)", () => {
    const w = sectionWindow(SECAO, ["refresh_tokens"], 2_000) as string;
    expect(w).toContain("antes linha 39:");
    expect(w).toContain("depois linha 0:");
    expect(w).toContain(WINDOW_GAP_MARK);
    // Cada linha que não é marcador tem de existir tal e qual no original.
    for (const line of w.split("\n")) {
      if (line === WINDOW_GAP_MARK) continue;
      expect(SECAO).toContain(line);
    }
  });

  it("nenhum termo casa → null (recorte que não mostra o trecho em disputa não vale a pena)", () => {
    expect(sectionWindow(SECAO, ["courier_id"], 2_000)).toBeNull();
  });

  it("termo curto demais é ignorado (substring de 1-2 chars casaria qualquer linha)", () => {
    expect(sectionWindow(SECAO, ["de"], 2_000)).toBeNull();
  });

  it("orçamento que só dá para o cabeçalho → null em vez de janela sem texto editável", () => {
    expect(sectionWindow(SECAO, ["refresh_tokens"], 40)).toBeNull();
  });

  it("linha longa no meio é PULADA, não interrompe a janela (a linha do GAP pode vir depois)", () => {
    const comTabela = [
      "### 7.4 Retenção",
      `| tabela | ${"muito longa ".repeat(200)}| refresh_tokens |`,
      "linha curta de contexto",
      "A regra de `refresh_tokens` é esta.",
    ].join("\n");
    const w = sectionWindow(comTabela, ["refresh_tokens"], 600) as string;
    expect(w).not.toBeNull();
    expect(w).toContain("A regra de `refresh_tokens` é esta.");
    expect(w).not.toContain("muito longa muito longa");
    expect(w).toContain(WINDOW_GAP_MARK);
  });

  it("seção sem cabeçalho (preâmbulo) também janela", () => {
    const preambulo = [manyLines("topo", 30), "menção a `refresh_tokens` aqui.", manyLines("fim", 30)].join("\n");
    const w = sectionWindow(preambulo, ["refresh_tokens"], 1_000) as string;
    expect(w).toContain("menção a `refresh_tokens` aqui.");
    expect(w.startsWith(WINDOW_GAP_MARK)).toBe(true);
  });
});
