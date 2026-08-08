/**
 * productLifecycle.test.ts — deriveProductLifecycle (ADR-018 / Cenário A, A2).
 * Testa a máquina de estados agregada do produto a partir dos status dos projetos.
 */
import { describe, it, expect } from "vitest";
import { deriveProductLifecycle } from "./productLifecycle.js";

describe("deriveProductLifecycle", () => {
  it("sem projetos → ingesting", () => {
    expect(deriveProductLifecycle([])).toBe("ingesting");
  });

  it("todos em andamento (nenhum aceito) → running", () => {
    expect(deriveProductLifecycle(["running", "spec_submitted"])).toBe("running");
    expect(deriveProductLifecycle(["pending_conversion"])).toBe("running");
    expect(deriveProductLifecycle(["pending_cyborg", "running"])).toBe("running");
  });

  it("alguns aceitos + outros em andamento → partially_accepted", () => {
    expect(deriveProductLifecycle(["accepted", "running"])).toBe("partially_accepted");
    expect(deriveProductLifecycle(["accepted", "accepted", "spec_submitted"])).toBe("partially_accepted");
  });

  it("todos aceitos → accepted", () => {
    expect(deriveProductLifecycle(["accepted"])).toBe("accepted");
    expect(deriveProductLifecycle(["accepted", "accepted", "accepted"])).toBe("accepted");
  });

  it("A2: qualquer projeto blocked_cyborg → stalled_waiting_human (onda travada)", () => {
    expect(deriveProductLifecycle(["accepted", "blocked_cyborg"])).toBe("stalled_waiting_human");
    expect(deriveProductLifecycle(["running", "blocked_cyborg", "accepted"])).toBe("stalled_waiting_human");
    expect(deriveProductLifecycle(["blocked_cyborg"])).toBe("stalled_waiting_human");
  });

  it("rejeição humana (failed) tem precedência sobre tudo → failed", () => {
    expect(deriveProductLifecycle(["failed"])).toBe("failed");
    expect(deriveProductLifecycle(["accepted", "failed"])).toBe("failed");
    // failed vence até stalled — falha dura é o pior estado
    expect(deriveProductLifecycle(["failed", "blocked_cyborg", "accepted"])).toBe("failed");
  });

  it("precedência stalled > accepted-total (bloqueio esconde 'tudo aceito' incompleto)", () => {
    // 2 aceitos + 1 bloqueado: NÃO é accepted (não são todos aceitos) e há bloqueio → stalled
    expect(deriveProductLifecycle(["accepted", "accepted", "blocked_cyborg"])).toBe("stalled_waiting_human");
  });
});
