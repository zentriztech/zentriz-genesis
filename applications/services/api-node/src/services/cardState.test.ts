/**
 * Fase 2 / 2.4 — tabela pura da máquina de estados do card (sem banco). A matriz EXPECTED é escrita à mão a partir de
 * H §4.1 (não derivada de CARD_TRANSITIONS) para o teste não ser tautológico.
 */
import { describe, it, expect } from "vitest";
import {
  CARD_STATES, CARD_TRANSITIONS, allowedCardTargets, isCardState, isValidCardTransition, legacyStatusFor, type CardActorKind, type CardState,
} from "./cardState.js";

const ACTORS: CardActorKind[] = ["user", "system", "reconciler", "guard", "backfill"];

// Arestas esperadas de H §4.1: "de>para" → atores permitidos.
const EXPECTED: Record<string, CardActorKind[]> = {
  "draft>refining": ["user", "system"],
  "draft>ready": ["system"],
  "refining>ready": ["system"],
  "ready>refining": ["user", "system"],
  "ready>promoted": ["user", "system"],
  "promoted>in_factory": ["system"],
  "promoted>blocked": ["system", "guard", "reconciler"],
  "in_factory>blocked": ["system", "guard", "reconciler"],
  "blocked>in_factory": ["user", "system"],
  "promoted>ready": ["system"],
  "in_factory>ready": ["system"],
  "blocked>ready": ["system"],
  "in_factory>delivered": ["system"],
  "draft>rejected": ["user"],
  "refining>rejected": ["user"],
  "ready>rejected": ["user"],
  "blocked>rejected": ["user"],
};

describe("cardState — tabela de transições (H §4.1)", () => {
  it("os 8 estados do plano 2.4", () => {
    expect([...CARD_STATES]).toEqual(["draft", "refining", "ready", "promoted", "in_factory", "delivered", "blocked", "rejected"]);
    expect(isCardState("draft")).toBe(true);
    expect(isCardState("open")).toBe(false);
    expect(isCardState(null)).toBe(false);
  });

  it("matriz exaustiva 8×8×5 atores: válido ⇔ listado em EXPECTED para o ator", () => {
    let valid = 0, invalid = 0;
    for (const from of CARD_STATES) for (const to of CARD_STATES) for (const actor of ACTORS) {
      const want = (EXPECTED[`${from}>${to}`] ?? []).includes(actor);
      expect(isValidCardTransition(from, to, actor), `${from}>${to} por ${actor}`).toBe(want);
      want ? valid++ : invalid++;
    }
    expect(valid).toBe(Object.values(EXPECTED).reduce((n, a) => n + a.length, 0));
    expect(valid + invalid).toBe(8 * 8 * 5);
  });

  it("terminais (delivered, rejected) não têm saída; ator backfill nunca transita", () => {
    for (const t of ["delivered", "rejected"] as CardState[]) for (const a of ACTORS) expect(allowedCardTargets(t, a)).toEqual([]);
    for (const from of CARD_STATES) expect(allowedCardTargets(from, "backfill")).toEqual([]);
  });

  it("toda aresta da tabela tem destino alcançável e nenhuma repete (de, para)", () => {
    const seen = new Set<string>();
    for (const t of CARD_TRANSITIONS) for (const f of t.from) {
      const k = `${f}>${t.to}`;
      expect(seen.has(k), `duplicada ${k}`).toBe(false);
      seen.add(k);
    }
    expect([...seen].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("legacyStatusFor: draft/refining/ready→open · promoted/in_factory/blocked→promoted · delivered · rejected", () => {
    expect(CARD_STATES.map((s) => [s, legacyStatusFor(s)])).toEqual([
      ["draft", "open"], ["refining", "open"], ["ready", "open"], ["promoted", "promoted"],
      ["in_factory", "promoted"], ["delivered", "delivered"], ["blocked", "promoted"], ["rejected", "rejected"],
    ]);
  });
});
