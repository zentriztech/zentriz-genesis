/**
 * productProposals.revert.test.ts — RFC-0004 T1.6b (revisão adversarial Wave B).
 *
 * Cobre o fix escopado de revertTerminatedOrigins (MEDIUM-1/MEDIUM-2):
 *   • MEDIUM-2: uma proposta que erra/interrompe EM VOO devolve a origem à Bancada AGORA
 *     (via RETURNING origin_project_id), sem esperar o próximo boot.
 *   • MEDIUM-1: o revert é ESCOPADO por id — nunca uma varredura cega que rebaixaria specs
 *     em pending_conversion do fluxo clássico (projectCreation) que só tiveram uma proposta
 *     terminal no passado.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// specs.js traz httpPost/httpGet — não exercidos aqui (só o revert), mas o import precisa existir.
vi.mock("../routes/specs.js", () => ({ httpPost: async () => "{}", httpGet: async () => "{}" }));

type Call = { sql: string; params: unknown[] };
let calls: Call[] = [];
let handler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number } = () => ({ rows: [] });

const pool = {
  query: async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return handler(sql, params);
  },
} as unknown as import("pg").Pool;

beforeEach(() => {
  calls = [];
  handler = () => ({ rows: [] });
});

describe("revertTerminatedOrigins — escopo por id", () => {
  it("lista vazia → nenhuma query (não varre a tabela inteira)", async () => {
    const { revertTerminatedOrigins } = await import("./productProposals.js");
    await revertTerminatedOrigins(pool, []);
    expect(calls).toHaveLength(0);
  });

  it("com ids → UPDATE escopado por ANY($1) + guarda pending_conversion + NOT EXISTS viva/consumida", async () => {
    const { revertTerminatedOrigins } = await import("./productProposals.js");
    await revertTerminatedOrigins(pool, ["a1", "a1", "b2"]); // dedupe embutido
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.sql).toContain("UPDATE projects");
    expect(c.sql).toContain("= ANY($1::uuid[])");
    expect(c.sql).toContain("p.status='pending_conversion'");
    expect(c.sql).toContain("NOT EXISTS");
    // ids únicos, sem falsy
    expect(c.params[0]).toEqual(["a1", "b2"]);
    // NUNCA um EXISTS "qualquer proposta" (o bug antigo que rebaixava o fluxo clássico)
    expect(c.sql).not.toMatch(/EXISTS\s*\(\s*SELECT 1 FROM product_proposals pp WHERE pp\.origin_project_id = p\.id\s*\)/);
  });

  it("ignora ids falsy (null/vazio)", async () => {
    const { revertTerminatedOrigins } = await import("./productProposals.js");
    await revertTerminatedOrigins(pool, [null as unknown as string, "", "c3"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].params[0]).toEqual(["c3"]);
  });
});
