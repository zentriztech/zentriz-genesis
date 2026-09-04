/**
 * productLifecycle.test.ts — deriveProductLifecycle (ADR-018 / Cenário A, A2).
 * Testa a máquina de estados agregada do produto a partir dos status dos projetos.
 */
import { describe, it, expect, vi } from "vitest";
import { deriveProductLifecycle, recomputeProductLifecycle } from "./productLifecycle.js";

describe("deriveProductLifecycle", () => {
  it("sem projetos → ingesting", () => {
    expect(deriveProductLifecycle([])).toBe("ingesting");
  });

  it("todos em andamento (nenhum aceito) → running", () => {
    expect(deriveProductLifecycle(["running", "spec_submitted"])).toBe("running");
    expect(deriveProductLifecycle(["pending_conversion"])).toBe("running");
    expect(deriveProductLifecycle(["pending_cyborg", "running"])).toBe("running");
  });

  it("RFC-0003 B1: TODOS 'draft' → draft (produto na Bancada, nada na fábrica)", () => {
    expect(deriveProductLifecycle(["draft"])).toBe("draft");
    expect(deriveProductLifecycle(["draft", "draft", "draft"])).toBe("draft");
    // estreito: basta 1 fora de 'draft' para NÃO ser Bancada (já entrou na fábrica)
    expect(deriveProductLifecycle(["draft", "spec_submitted"])).toBe("running");
    expect(deriveProductLifecycle(["draft", "pending_conversion"])).toBe("running");
    // com aceitos misturados a drafts → parcial (draft conta como em andamento)
    expect(deriveProductLifecycle(["accepted", "draft"])).toBe("partially_accepted");
  });

  it("alguns aceitos + outros em andamento → partially_accepted", () => {
    expect(deriveProductLifecycle(["accepted", "running"])).toBe("partially_accepted");
    expect(deriveProductLifecycle(["accepted", "accepted", "spec_submitted"])).toBe("partially_accepted");
  });

  it("todos aceitos → accepted", () => {
    expect(deriveProductLifecycle(["accepted"])).toBe("accepted");
    expect(deriveProductLifecycle(["accepted", "accepted", "accepted"])).toBe("accepted");
  });

  it("D3: needs_spec_input (fábrica aguardando resposta humana) → stalled_waiting_human, não running", () => {
    expect(deriveProductLifecycle(["needs_spec_input"])).toBe("stalled_waiting_human");
    expect(deriveProductLifecycle(["running", "needs_spec_input", "accepted"])).toBe("stalled_waiting_human");
    expect(deriveProductLifecycle(["failed", "needs_spec_input"])).toBe("failed");
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

describe("recomputeProductLifecycle — I/O + isenção do INBOX (§4.13, migration 064)", () => {
  // Fake db: 1ª query resolve is_inbox; 2ª os status; 3ª o UPDATE. Captura todos os SQLs.
  function fakeDb(opts: { isInbox?: boolean | undefined; exists?: boolean; statuses?: string[] }) {
    const sqls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      sqls.push(sql);
      if (sql.includes("is_inbox FROM products")) {
        return { rows: opts.exists === false ? [] : [{ is_inbox: opts.isInbox ?? false }] };
      }
      if (sql.includes("status FROM projects")) {
        return { rows: (opts.statuses ?? []).map((status) => ({ status })) };
      }
      return { rows: [] }; // UPDATE
    });
    return { db: { query } as never, sqls, query };
  }

  it("produto null → null, sem tocar o banco", async () => {
    const { db, query } = fakeDb({});
    expect(await recomputeProductLifecycle(db, null)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("INBOX (is_inbox=true) → null e NUNCA grava lifecycle", async () => {
    const { db, sqls } = fakeDb({ isInbox: true, statuses: ["draft", "running"] });
    expect(await recomputeProductLifecycle(db, "inbox-id")).toBeNull();
    expect(sqls.some((s) => s.includes("UPDATE products"))).toBe(false);
    expect(sqls.some((s) => s.includes("status FROM projects"))).toBe(false); // curto-circuito
  });

  it("produto inexistente → null, sem UPDATE", async () => {
    const { db, sqls } = fakeDb({ exists: false });
    expect(await recomputeProductLifecycle(db, "ghost")).toBeNull();
    expect(sqls.some((s) => s.includes("UPDATE products"))).toBe(false);
  });

  it("produto real → deriva e grava o lifecycle agregado", async () => {
    const { db, sqls } = fakeDb({ isInbox: false, statuses: ["running", "accepted"] });
    expect(await recomputeProductLifecycle(db, "prod-id")).toBe("partially_accepted");
    expect(sqls.some((s) => s.includes("UPDATE products SET lifecycle_status"))).toBe(true);
  });
});
