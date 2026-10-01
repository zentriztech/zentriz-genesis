/**
 * POST-MORTEM 30/09/2026 (BRL 90.305,78) — regressão do laço infinito de `ensureConnectDeclarationsTick`.
 *
 * O SELECT de pendentes não trazia `connect_decl_result` ⇒ a contagem de tentativas lia sempre 0 ⇒
 * `releaseClaim` devolvia a run à fila em toda falha, para sempre. Estes testes pinam o comportamento
 * pelo que o tick FAZ no banco, não pelo texto do SQL.
 */
import { describe, it, expect, afterEach } from "vitest";
import { ensureConnectDeclarationsTick } from "./connectDeclaration.js";

type Call = { sql: string; params: unknown[] };

function fakeDb(pendingRow: Record<string, unknown>) {
  const calls: Call[] = [];
  const db = {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (/connect_decl_at IS NOT NULL AND connect_decl_result IS NULL\s+AND connect_decl_at </.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM spec_autonomy_runs r JOIN projects p/.test(sql)) {
        // O SELECT precisa trazer a coluna — se não trouxer, o fake devolve sem ela (como o Postgres).
        const row = { ...pendingRow };
        if (!/r\.connect_decl_result/.test(sql)) delete row.connect_decl_result;
        return { rows: [row], rowCount: 1 };
      }
      if (/SET connect_decl_at = now\(\)/.test(sql)) return { rows: [], rowCount: 1 };
      if (/SELECT 1 FROM spec_autonomy_runs/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SET connect_decl_result/.test(sql)) return { rows: [], rowCount: 1 };
      if (/SET connect_decl_at = NULL/.test(sql)) return { rows: [], rowCount: 1 };
      // Qualquer outra leitura (contexto da spec) falha ⇒ caminho "spec indisponível" (sem LLM).
      throw new Error("fake: consulta não prevista");
    },
  };
  return db;
}

const OLD_ENV = process.env.API_AGENTS_URL;
afterEach(() => { process.env.API_AGENTS_URL = OLD_ENV; });

describe("ensureConnectDeclarationsTick — o teto de tentativas VALE (incidente 30/09)", () => {
  it("na 3ª falha a run NÃO volta para a fila", async () => {
    process.env.API_AGENTS_URL = "http://agents.test";
    const db = fakeDb({
      id: "run-1", project_id: "00000000-0000-0000-0000-000000000001", tenant_id: null,
      status: "passed", project_status: "blocked_cyborg",
      connect_decl_result: { error: "DECL_NOT_JSON", attempts: 2 },
    });
    const post = async () => { throw new Error("não deveria chamar LLM"); };
    await ensureConnectDeclarationsTick(db as never, { post });
    const recorded = db.calls.find((c) => /SET connect_decl_result/.test(c.sql));
    expect(JSON.parse(String(recorded?.params[1])).attempts).toBe(3);
    expect(db.calls.some((c) => /SET connect_decl_at = NULL/.test(c.sql))).toBe(false);
  });

  it("antes do teto, devolve à fila com a contagem SOMADA (não reinicia em 1)", async () => {
    process.env.API_AGENTS_URL = "http://agents.test";
    const db = fakeDb({
      id: "run-2", project_id: "00000000-0000-0000-0000-000000000002", tenant_id: null,
      status: "passed", project_status: "spec_submitted",
      connect_decl_result: { error: "DECL_SCHEMA", attempts: 1 },
    });
    await ensureConnectDeclarationsTick(db as never, { post: async () => "{}" });
    const recorded = db.calls.find((c) => /SET connect_decl_result/.test(c.sql));
    expect(JSON.parse(String(recorded?.params[1])).attempts).toBe(2);
  });

  it("só varre projetos com orçamento de LLM vivo", async () => {
    process.env.API_AGENTS_URL = "http://agents.test";
    const db = fakeDb({ id: "r", project_id: "p", project_status: "draft", connect_decl_result: null });
    await ensureConnectDeclarationsTick(db as never, { post: async () => "{}" });
    const sel = db.calls.find((c) => /FROM spec_autonomy_runs r JOIN projects p/.test(c.sql));
    expect(sel?.sql).toMatch(/budget_usd IS NOT NULL/);
    expect(sel?.sql).toMatch(/budget_paused_at IS NULL/);
  });
});
