/**
 * 🔴 GAP-121 — o laço pedia CRESCIMENTO com margem ZERO, e o mesmo arquivo era descartado passe a passe.
 *
 * MEDIDO em prod (run `3660bcf2`, NVX LastMile): `announcedBudget` 2.000 → 1.095 → 216 → **0** e zero
 * pelas rodadas 4 a 12; **9 das 24 rodadas não escreveram nada**, sempre nos mesmos 4–5 arquivos que
 * redeclaram contrato de oráculo. GAPs 47 → 48.
 *
 * Estes testes cobrem os limites que impedem que a cura vire um novo defeito: nunca pedir remoção onde
 * não há redeclaração, nunca pedir remoção quando a errata CABE, e nunca repetir o pedido num arquivo
 * que já respondeu sem liberar nada (o gatilho é auto-alimentado — sem a guarda, o arquivo ficaria
 * preso em consolidação para sempre e os GAPs dele nunca voltariam a ser pedidos).
 */
import { describe, it, expect } from "vitest";
import {
  CONSOLIDATION_ONLY_FLOOR, consolidationOnlyReason, consolidationOnlyExhausted,
  consolidationOnlyEnabled,
} from "./specAutonomy.js";

function R(over: Record<string, unknown>) {
  return { round: 1, pass: 0, filePath: "docs/definicao-de-pronto.md", ...over } as never;
}
const run = (rounds: unknown[], passes = 0) => ({ rounds, passes } as never);

describe("consolidationOnlyReason (GAP-121)", () => {
  it("sem redeclaração NÃO pede consolidação — pedir só remoção seria pedir o vazio", () => {
    expect(consolidationOnlyReason(0, 0, null)).toBeNull();
    expect(consolidationOnlyReason(0, 0, 5_000)).toBeNull();
  });

  it("margem zero com redeclaração ⇒ rodada de remoção, com o número no motivo", () => {
    const reason = consolidationOnlyReason(60, 0, null);
    expect(reason).toContain("0 chars");
    expect(reason).toContain(String(CONSOLIDATION_ONLY_FLOOR));
  });

  it("margem no piso ainda é remoção; um char acima do piso já é rodada normal", () => {
    expect(consolidationOnlyReason(3, CONSOLIDATION_ONLY_FLOOR, null)).not.toBeNull();
    expect(consolidationOnlyReason(3, CONSOLIDATION_ONLY_FLOOR + 1, null)).toBeNull();
  });

  it("com margem, só o FATO da recusa anterior maior que a margem justifica remoção", () => {
    // 2.547 foi o delta real que o agente entregou no passe 0 da run medida.
    expect(consolidationOnlyReason(4, 1_000, 2_547)).toContain("+2547");
    // A tentativa anterior CABE hoje ⇒ nada a prever: a rodada normal acontece.
    expect(consolidationOnlyReason(4, 3_000, 2_547)).toBeNull();
    expect(consolidationOnlyReason(4, 3_000, null)).toBeNull();
  });

  it("margem corrompida (NaN/−) não vira `NaN chars` no prompt nem cancela a remoção", () => {
    expect(consolidationOnlyReason(2, Number.NaN, null)).toContain("0 chars");
    expect(consolidationOnlyReason(2, -900, null)).toContain("0 chars");
  });
});

describe("consolidationOnlyEnabled (GAP-121, kill-switch)", () => {
  it("ligado por padrão; `off` volta ao pedido combinado sem deploy", () => {
    const antes = process.env.SPEC_CONSOLIDATION_ONLY;
    try {
      delete process.env.SPEC_CONSOLIDATION_ONLY;
      expect(consolidationOnlyEnabled()).toBe(true);
      process.env.SPEC_CONSOLIDATION_ONLY = " OFF ";
      expect(consolidationOnlyEnabled()).toBe(false);
      process.env.SPEC_CONSOLIDATION_ONLY = "on";
      expect(consolidationOnlyEnabled()).toBe(true);
    } finally {
      if (antes === undefined) delete process.env.SPEC_CONSOLIDATION_ONLY;
      else process.env.SPEC_CONSOLIDATION_ONLY = antes;
    }
  });
});

describe("consolidationOnlyExhausted (GAP-121)", () => {
  const alvo = "docs/definicao-de-pronto.md";

  it("consolidação que ENCOLHEU não esgota nada — foi exatamente o que se pediu", () => {
    expect(consolidationOnlyExhausted(
      run([R({ consolidationOnly: true, applied: true, deltaChars: -4_200 })]), alvo,
    )).toBe(false);
  });

  it("consolidação aplicada SEM encolher, ou vetada, esgota a tentativa deste passe", () => {
    expect(consolidationOnlyExhausted(
      run([R({ consolidationOnly: true, applied: true, deltaChars: 0 })]), alvo,
    )).toBe(true);
    expect(consolidationOnlyExhausted(
      run([R({ consolidationOnly: true, applied: false })]), alvo,
    )).toBe(true);
  });

  it("rodada EM VOO (sem `applied`) não é fracasso: é o pedido que está sendo respondido", () => {
    expect(consolidationOnlyExhausted(
      run([R({ consolidationOnly: true })]), alvo,
    )).toBe(false);
  });

  it("o esgotamento é POR ARQUIVO e POR PASSE — o passe seguinte tem fatos novos", () => {
    const falhou = R({ consolidationOnly: true, applied: false });
    expect(consolidationOnlyExhausted(run([falhou], 0), "docs/visao-escopo.md")).toBe(false);
    expect(consolidationOnlyExhausted(run([falhou], 1), alvo)).toBe(false);
  });

  it("rodada NORMAL descartada não conta como consolidação tentada", () => {
    expect(consolidationOnlyExhausted(
      run([R({ applied: false, rejectedDelta: 2_547 })]), alvo,
    )).toBe(false);
  });

  it("`rounds` corrompido devolve `false` em vez de derrubar o despacho", () => {
    expect(consolidationOnlyExhausted({ rounds: null, passes: 0 } as never, alvo)).toBe(false);
  });
});
