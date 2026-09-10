/**
 * opsAgent.test.ts — o laço ReAct do agente interno de operações.
 *
 * Três teses estão travadas aqui, e todas nasceram da revisão adversarial do plano (2026-09-10):
 *
 * 1. **Sem slot na conta de gestão, o agente FALHA — não cai no `.env`.** Era exatamente o caminho
 *    silencioso que a LEI dos slots veio matar; a diferença é que aqui o pagador declarado existe,
 *    e por isso ele tem de estar declarado de fato, numa linha de banco.
 * 2. **Cada candidato viaja com a credencial DELE.** Levar só o `model_id` da contingência sobre a
 *    credencial da primária é o defeito do "Grupo C", que já custou um deploy.
 * 3. **A recusa da guarda não derruba o laço**: ela vira resultado do passo, o modelo reformula, e
 *    o operador vê no trace o que foi tentado.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  slots: [] as Record<string, unknown>[],
  inserts: [] as { sql: string; params: unknown[] }[],
  selects: [] as string[],
}));

vi.mock("../db/client.js", () => {
  const query = async (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM zentriz_llm_config")) return { rows: db.slots };
    if (sql.includes("INSERT INTO ops_agent_runs")) {
      db.inserts.push({ sql, params: params ?? [] });
      return { rows: [] };
    }
    db.selects.push(sql);
    if (sql.startsWith("BEGIN") || sql.startsWith("SET ") || sql.startsWith("ROLLBACK")) return { rows: [] };
    if (sql.includes("FROM pg_class")) {
      return { rows: [
        { tabela: "projects", linhas_estimadas: 12 },
        { tabela: "tenant_llm_configs", linhas_estimadas: 4 },
        { tabela: "tenant_llm_configs_bak_pre_foundry_20260909", linhas_estimadas: 4 },
        { tabela: "zentriz_llm_config", linhas_estimadas: 1 },
      ] };
    }
    return { rows: [{ tenants: 7 }] };
  };
  return {
    pool: {
      query,
      connect: async () => ({ query, release: () => {} }),
    },
  };
});

import { ask, extrairJson, MAX_PASSOS, traceParaAuditoria, MAX_TRACE_BYTES } from "./opsAgent.js";

const SLOT_FOUNDRY = {
  id: "s0", priority: 0, provider: "foundry", model_id: "claude-opus-5",
  model_id_fallback: null, label: "principal", is_active: true,
  credentials: { foundry_api_key: "CHAVE_DA_GESTAO" },
};
const SLOT_BEDROCK = {
  id: "s1", priority: 1, provider: "bedrock", model_id: "us.anthropic.claude-opus-4-6-v1",
  model_id_fallback: null, label: "contingência", is_active: true,
  credentials: { aws_access_key_id: "AKIA_GESTAO", aws_secret_access_key: "SEGREDO", aws_region: "us-east-1" },
};

/** Fila de respostas do LLM; cada chamada consome uma. */
let respostas: string[] = [];
let corposEnviados: Record<string, unknown>[] = [];

beforeEach(() => {
  db.slots = [SLOT_FOUNDRY]; db.inserts = []; db.selects = [];
  respostas = []; corposEnviados = [];
  process.env.API_AGENTS_URL = "http://agents:8000";
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    corposEnviados.push(JSON.parse(init.body));
    const texto = respostas.shift() ?? '{"thought":"fim","final":"acabou"}';
    return { ok: true, json: async () => ({ response: texto, model_used: "claude-opus-5",
                                            usage: { input_tokens: 100, output_tokens: 20 } }) };
  });
});

describe("extrairJson", () => {
  it("aceita JSON cru, em cerca de código e com prosa em volta", () => {
    expect(extrairJson('{"final":"a"}')).toEqual({ final: "a" });
    expect(extrairJson('```json\n{"final":"b"}\n```')).toEqual({ final: "b" });
    expect(extrairJson('Claro! {"final":"c"} espero ter ajudado')).toEqual({ final: "c" });
  });
  it("devolve null quando não há objeto", () => {
    expect(extrairJson("não sei responder")).toBeNull();
  });
});

describe("ask — LLM da conta de gestão", () => {
  it("sem slot configurado FALHA ALTO, sem cair no env da Zentriz", async () => {
    db.slots = [];
    const r = await ask({ question: "quantos tenants?" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("PLATFORM_LLM_NOT_CONFIGURED");
    expect(corposEnviados).toHaveLength(0);   // nenhuma chamada de LLM aconteceu
  });

  it("slot sem credencial PRÓPRIA não conta como configurado", async () => {
    db.slots = [{ ...SLOT_FOUNDRY, credentials: {} }];
    const r = await ask({ question: "quantos tenants?" });
    expect(r.code).toBe("PLATFORM_LLM_NOT_CONFIGURED");
  });

  it("manda a credencial da gestão e a fila inteira, cada candidato com a DELE", async () => {
    db.slots = [SLOT_FOUNDRY, SLOT_BEDROCK];
    respostas = ['{"thought":"ok","final":"7 tenants"}'];
    const r = await ask({ question: "quantos tenants?" });
    expect(r.ok).toBe(true);
    const corpo = corposEnviados[0];
    expect((corpo.llm_config as Record<string, string>).foundry_api_key).toBe("CHAVE_DA_GESTAO");
    const candidatos = corpo.llm_candidates as Record<string, string>[];
    expect(candidatos).toHaveLength(2);
    // A contingência leva a credencial DELA — não a chave do Foundry com o modelo do Bedrock.
    expect(candidatos[1].provider).toBe("bedrock");
    expect(candidatos[1].aws_access_key_id).toBe("AKIA_GESTAO");
    expect(candidatos[1].foundry_api_key).toBeUndefined();
  });

  it("executa ferramenta, devolve o resultado ao modelo e conclui", async () => {
    respostas = [
      '{"thought":"vou contar","action":{"tool":"platform_summary","input":{}}}',
      '{"thought":"tenho o dado","final":"São 7 tenants."}',
    ];
    const r = await ask({ question: "quantos tenants?" });
    expect(r.ok).toBe(true);
    expect(r.answer).toBe("São 7 tenants.");
    expect(r.steps.map((s) => s.tool)).toEqual(["platform_summary"]);
    // O resultado da ferramenta volta no prompt do passo seguinte — é isso que faz o laço andar.
    expect(String(corposEnviados[1].user_message)).toContain("Passo 1 resultado");
  });

  it("a recusa da guarda vira passo do trace e o laço continua", async () => {
    respostas = [
      '{"thought":"vou ver as chaves","action":{"tool":"sql_select","input":{"sql":"SELECT credentials FROM tenant_llm_configs"}}}',
      '{"thought":"não posso","final":"Não tenho acesso a credenciais."}',
    ];
    const r = await ask({ question: "quais as chaves do tenant X?" });
    expect(r.ok).toBe(true);
    expect(r.steps[0].ok).toBe(false);
    expect((r.steps[0].result as { refused: boolean }).refused).toBe(true);
    // O motivo volta ao modelo: ele reformula em vez de repetir a mesma consulta.
    expect(String(corposEnviados[1].user_message)).toContain("tenant_llm_configs");
  });

  it("resposta fora do formato não queima o laço em silêncio — pede reformulação", async () => {
    respostas = ["desculpe, não entendi", '{"thought":"agora sim","final":"pronto"}'];
    const r = await ask({ question: "x" });
    expect(r.ok).toBe(true);
    expect(r.steps[0].tool).toBe("(formato)");
  });

  it("não passa do teto de passos e diz que não concluiu", async () => {
    respostas = Array.from({ length: MAX_PASSOS + 2 },
      () => '{"thought":"mais um","action":{"tool":"platform_summary","input":{}}}');
    const r = await ask({ question: "x" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("AGENT_INCOMPLETE");
    expect(r.steps.length).toBeLessThanOrEqual(MAX_PASSOS);
  });

  it("audita TODA execução — inclusive a que falhou por falta de slot", async () => {
    db.slots = [];
    await ask({ question: "pergunta auditada", userEmail: "jean@zentriz.com.br" });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].params).toContain("pergunta auditada");
  });

  it("toda leitura roda em transação somente-leitura que termina em ROLLBACK", async () => {
    respostas = [
      '{"thought":"conta","action":{"tool":"sql_select","input":{"sql":"SELECT id FROM tenants"}}}',
      '{"thought":"fim","final":"ok"}',
    ];
    await ask({ question: "x" });
    // Tem de ser `SET TRANSACTION READ ONLY`: medido nesta base, `SET LOCAL
    // default_transaction_read_only = on` NÃO tranca a transação já aberta (o INSERT passou).
    expect(db.selects.some((s) => s.includes("SET TRANSACTION READ ONLY"))).toBe(true);
    expect(db.selects.some((s) => s.includes("default_transaction_read_only"))).toBe(false);
    expect(db.selects.some((s) => s.startsWith("ROLLBACK"))).toBe(true);
  });

  it("trace gigante vira JSON VÁLIDO reduzido — cortar a string matava a auditoria em silêncio", () => {
    const passos = Array.from({ length: 6 }, (_, i) => ({
      step: i + 1, tool: "sql_select", input: { sql: "SELECT 1" }, ok: true,
      result: { rows: [{ texto: "z".repeat(60_000) }] },
    }));
    const gravado = traceParaAuditoria(passos);
    expect(gravado.length).toBeLessThan(MAX_TRACE_BYTES);
    const obj = JSON.parse(gravado);           // se cortasse a string, isto lançaria
    expect(obj.reduzido).toBe(true);
    expect(obj.passos).toHaveLength(6);
  });

  it("o catálogo não anuncia as tabelas que a guarda recusa", async () => {
    respostas = [
      '{"thought":"ver o mapa","action":{"tool":"list_tables","input":{}}}',
      '{"thought":"fim","final":"ok"}',
    ];
    const r = await ask({ question: "quais tabelas existem?" });
    const linhas = (r.steps[0].result as { rows: { tabela: string }[] }).rows;
    const nomes = linhas.map((l) => l.tabela);
    expect(nomes).toContain("projects");
    expect(nomes).not.toContain("tenant_llm_configs");
    expect(nomes).not.toContain("zentriz_llm_config");
    // O backup com sufixo também some — a denylist casa por substring, e o catálogo usa a MESMA.
    expect(nomes).not.toContain("tenant_llm_configs_bak_pre_foundry_20260909");
  });
});
