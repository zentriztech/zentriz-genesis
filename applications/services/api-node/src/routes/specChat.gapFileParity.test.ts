/**
 * 🔴 GAP-156 — PARIDADE DE FATOS entre o botão humano e o laço autônomo.
 *
 * `buildGapFileRequest` tem dois chamadores e a lista de parâmetros é POSICIONAL e longa (15 posições).
 * O laço passava 15 argumentos; o botão "Resolver GAPs por arquivo" parava no 7º (`digested`). Resultado
 * medido em prod (2026-09-09, api `55675cdb`, job `b8009d2e`, `modelo-dados.md`): o censo do prompt saiu
 * SEM o campo `oracles` — enquanto o registro tinha 114 decisões vigentes e aquele arquivo é dono de 17
 * contratos e citante de 52, ou seja **22.726 chars de "quem é a fonte única" que nunca chegaram ao CTO**.
 *
 * Por que isso é grave e não cosmético: contradição entre arquivos é a família DOMINANTE dos blockers do
 * NVX (24 de 26) e o registro de oráculos existe exatamente para ela. Sem o bloco, o agente só pode
 * redeclarar a regra ou empurrar a contradição para o irmão — e o clique humano é o caminho que o Jean
 * usa. Pior: o comentário de `gapOracleBlock` já descrevia este caminho ("o botão humano aproveita as
 * decisões existentes"), então o código AFIRMAVA um comportamento inexistente (família do GAP-128).
 *
 * O teste é de FONTE de propósito. O defeito não estava no construtor (que funciona) nem no bloco (que
 * é montado certo): estava no CALL SITE que esqueceu de passá-lo. Um teste unitário do construtor
 * continuaria verde com o defeito em produção — quem tem de ser pinado é o despacho.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "specChat.ts"), "utf8");

/** Recorte do despacho do BOTÃO HUMANO: de `if (gapsPerFile) {` até o `} else if (filePath) {`. */
function humanDispatchSource(): string {
  const start = SRC.indexOf("if (gapsPerFile) {");
  expect(start, "o ramo `if (gapsPerFile)` do POST /api/spec-chat desapareceu — este teste ficou cego").toBeGreaterThan(0);
  const end = SRC.indexOf("} else if (filePath) {", start);
  expect(end, "o ramo seguinte (`else if (filePath)`) desapareceu — recorte indefinido").toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("🔴 GAP-156 — o botão humano recebe os MESMOS fatos persistidos que o laço", () => {
  it("o despacho humano monta o bloco de ORÁCULOS (quem é a fonte única de cada contrato)", () => {
    expect(
      humanDispatchSource(),
      "Resolver GAPs por arquivo voltou a despachar sem `gapOracleBlock`: o CTO julga contradição sem"
      + " saber quem é o dono do contrato — foi o defeito medido em prod (22.726 chars ausentes).",
    ).toContain("gapOracleBlock(");
  });

  it("o despacho humano monta os FATOS DO ÍNDICE (a árvore atual e o que o README não cita)", () => {
    expect(
      humanDispatchSource(),
      "o botão humano voltou a despachar sem `gapIndexBlock` — no manifesto isso é editar o índice sem"
      + " ver a árvore que ele deveria indexar (GAP-122).",
    ).toContain("gapIndexBlock(");
  });

  it("NÃO inventa estado de laço: `fileChars`/`budget` ficam ausentes na chamada humana", () => {
    // GAP-25/GAP-28: o botão humano não passa por `consolidationVeto`. Anunciar critério NUMÉRICO de
    // descarte ali seria prometer um veto que ninguém vai aplicar — o bloco tem de sair qualitativo.
    const src = humanDispatchSource();
    const chamada = src.slice(src.indexOf("gapOracleBlock("));
    const args = chamada.slice(chamada.indexOf("(") + 1, chamada.indexOf(")"));
    expect(
      args.split(",").length,
      `gapOracleBlock recebeu ${args.split(",").length} argumentos no botão humano (esperado 2:`
      + " projeto e arquivo). Passar `fileChars`/`budget` aqui faria o bloco prometer um descarte"
      + " numérico que este caminho não executa.",
    ).toBe(2);
  });

  it("o laço continua passando a lista COMPLETA (o outro lado da paridade)", () => {
    // Se o laço perder o bloco, a paridade "iguala por baixo" e o teste acima seguiria verde.
    const laco = SRC.slice(SRC.indexOf("...buildGapFileRequest("));
    expect(laco.slice(0, 600)).toContain("oracles");
    expect(laco.slice(0, 600)).toContain("attemptHistoryBlock");
  });

  it("os vazios do despacho humano são DECLARADOS como estado do laço, não silenciosos", () => {
    // A regra do GAP-128 vale para o código também: cortar é legítimo, cortar sem dizer não é. Sem esta
    // âncora, um `"", "", "", "", ""` sem explicação viraria "alguém esqueceu" na próxima leitura.
    expect(humanDispatchSource()).toContain("ESTADO DO LAÇO");
  });
});
