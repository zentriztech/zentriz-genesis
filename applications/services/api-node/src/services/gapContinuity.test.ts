import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { parsePairs, reconcileGapDelta } from "./gapContinuity.js";
import * as specs from "../routes/specs.js";
import type { ValidationFinding } from "./specValidation.js";

/** Finding mínimo — só os campos que o reconciliador mostra ao agente. */
function f(over: Partial<ValidationFinding> & { title: string }): ValidationFinding {
  return {
    file: "modelo-dados.md", line: null, severity: "blocker", rationale: "", source: "stage_b",
    category: "consistency", anchor: null, ...over,
  };
}

/**
 * Os pares REAIS medidos em prod 2026-09-07 (run `b1bc1195`, passe 1): o mesmo defeito com a âncora
 * renumerada pela edição do CTO. Nenhum deles casa por fingerprint, e o Jaccard de título deu 0.
 */
const CLOSED_REAL = [
  f({ anchor: "§6.1", severity: "warning", title: "Domínio de `audit_log.actor_role` declarado fechado por constraint e aberto no mesmo DDL" }),
  f({ anchor: "§4.2 Passo 3", file: "privacidade-lgpd.md", title: "Janela residual zero após anonimização exigida sem mecanismo em texto presente" }),
];
const OPENED_REAL = [
  f({ anchor: "§6", severity: "warning", title: "O `CREATE TABLE audit_log` de §6 declara `actor_role VARCHAR(10)` sem CHECK" }),
  f({ anchor: "PRIV-JANELA-01", file: "privacidade-lgpd.md", title: "Exige-se tolerância zero de janela residual após anonimização (403 `ACCOUNT_INACTIVE`)" }),
];

describe("parsePairs", () => {
  it("extrai pares de JSON puro", () => {
    expect(parsePairs('{"pairs":[{"a":"a1","b":"b2","why":"seção renumerada"}]}')).toEqual([
      { a: "a1", b: "b2", why: "seção renumerada" },
    ]);
  });
  it("extrai pares de dentro de cerca de código e prosa", () => {
    const t = 'Segue a análise:\n```json\n{"pairs":[{"a":"a3","b":"b1"}]}\n```\nEspero ter ajudado.';
    expect(parsePairs(t)).toEqual([{ a: "a3", b: "b1", why: "" }]);
  });
  it("devolve null quando não há JSON — sem inventar par", () => {
    expect(parsePairs("não consegui comparar")).toBeNull();
    expect(parsePairs("")).toBeNull();
  });
  it("descarta par sem `a` ou `b` utilizável", () => {
    expect(parsePairs('{"pairs":[{"a":"a1"},{"b":"b1"},{"a":"","b":"b2"},{"a":"a2","b":"b3"}]}')).toEqual([
      { a: "a2", b: "b3", why: "" },
    ]);
  });
});

describe("GAP-67 — reconciliação da diferença finding-a-finding", () => {
  const OLD_URL = process.env.API_AGENTS_URL;
  let post: MockInstance<(url: string, body: string, timeoutMs?: number) => Promise<string>>;

  beforeEach(() => {
    process.env.API_AGENTS_URL = "http://agents:8000";
    post = vi.spyOn(specs, "httpPost");
  });
  afterEach(() => {
    post.mockRestore();
    if (OLD_URL === undefined) delete process.env.API_AGENTS_URL;
    else process.env.API_AGENTS_URL = OLD_URL;
  });

  const reply = (pairs: unknown) =>
    post.mockResolvedValue(JSON.stringify({ response: JSON.stringify({ pairs }), model_used: "haiku-4-5" }));

  it("par confirmado sai das DUAS listas e vira `persisted` — o defeito continua aberto", async () => {
    reply([{ a: "a1", b: "b1", why: "mesma contradição, §6.1 virou §6" },
           { a: "a2", b: "b2", why: "mesma janela residual" }]);
    const r = await reconcileGapDelta(CLOSED_REAL, OPENED_REAL);
    expect(r.reconciled).toBe(true);
    expect(r.persisted).toHaveLength(2);
    expect(r.closed).toHaveLength(0);
    expect(r.opened).toHaveLength(0);
    expect(r.model).toBe("haiku-4-5");
  });

  it("o que NÃO foi pareado sobrevive como fechado/novo de verdade", async () => {
    reply([{ a: "a1", b: "b1" }]);
    const r = await reconcileGapDelta(CLOSED_REAL, OPENED_REAL);
    expect(r.persisted).toHaveLength(1);
    expect(r.closed.map((x) => x.anchor)).toEqual(["§4.2 Passo 3"]);
    expect(r.opened.map((x) => x.anchor)).toEqual(["PRIV-JANELA-01"]);
  });

  it("id inventado pelo modelo é descartado, não vira par", async () => {
    reply([{ a: "a9", b: "b1" }, { a: "a1", b: "b7" }]);
    const r = await reconcileGapDelta(CLOSED_REAL, OPENED_REAL);
    expect(r.reconciled).toBe(true);
    expect(r.persisted).toHaveLength(0);
    expect(r.closed).toHaveLength(2);
    expect(r.opened).toHaveLength(2);
  });

  it("o MESMO item não pode ser pareado duas vezes (senão sumiria com dois novos de uma vez)", async () => {
    reply([{ a: "a1", b: "b1" }, { a: "a1", b: "b2" }]);
    const r = await reconcileGapDelta(CLOSED_REAL, OPENED_REAL);
    expect(r.persisted).toHaveLength(1);
    expect(r.opened.map((x) => x.anchor)).toEqual(["PRIV-JANELA-01"]);
  });

  it("resposta não-JSON ⇒ `reconciled: false` com as listas CRUAS e motivo declarado", async () => {
    post.mockResolvedValue(JSON.stringify({ response: "não consegui", model_used: "haiku-4-5" }));
    const r = await reconcileGapDelta(CLOSED_REAL, OPENED_REAL);
    expect(r.reconciled).toBe(false);
    expect(r.reason).toMatch(/não era JSON/);
    expect(r.closed).toHaveLength(2);
    expect(r.opened).toHaveLength(2);
    expect(r.persisted).toHaveLength(0);
  });

  it("falha de rede NÃO inventa reconciliação — fail-closed declarado", async () => {
    post.mockRejectedValue(new Error("ETIMEDOUT"));
    const r = await reconcileGapDelta(CLOSED_REAL, OPENED_REAL);
    expect(r.reconciled).toBe(false);
    expect(r.reason).toMatch(/ETIMEDOUT/);
    expect(r.closed).toHaveLength(2);
  });

  it("sem `API_AGENTS_URL` não chama nada e devolve o diff cru", async () => {
    delete process.env.API_AGENTS_URL;
    const r = await reconcileGapDelta(CLOSED_REAL, OPENED_REAL);
    expect(r.reconciled).toBe(false);
    expect(r.reason).toMatch(/API_AGENTS_URL/);
    expect(post).not.toHaveBeenCalled();
  });

  it("um dos lados vazio é reconciliado por CONSTRUÇÃO, sem gastar LLM", async () => {
    const a = await reconcileGapDelta(CLOSED_REAL, []);
    expect(a.reconciled).toBe(true);
    expect(a.persisted).toHaveLength(0);
    expect(a.closed).toHaveLength(2);
    const b = await reconcileGapDelta([], OPENED_REAL);
    expect(b.reconciled).toBe(true);
    expect(b.opened).toHaveLength(2);
    expect(post).not.toHaveBeenCalled();
  });

  it("o prompt leva âncora e arquivo dos dois lados — é o que distingue rebatismo de defeito novo", async () => {
    reply([]);
    await reconcileGapDelta(CLOSED_REAL, OPENED_REAL);
    const body = JSON.parse(String(post.mock.calls[0][1])) as { user_message: string; prompt_override: string; temperature: number };
    expect(body.user_message).toContain("âncora=§6.1");
    expect(body.user_message).toContain("âncora=§6");
    expect(body.user_message).toContain("arquivo=privacidade-lgpd.md");
    expect(body.user_message).toContain("(A) PROBLEMAS QUE DESAPARECERAM");
    expect(body.user_message).toContain("(B) PROBLEMAS QUE APARECERAM");
    // Critério estrito e defesa contra injeção fazem parte do contrato, não do estilo.
    expect(body.prompt_override).toContain("corrigir um necessariamente corrigir o outro");
    expect(body.prompt_override).toContain("NÃO-CONFIÁVEL");
    expect(body.temperature).toBe(0);
  });

  it("modelo default vem COM versão — o apelido curto é 400 no Bedrock", async () => {
    reply([]);
    await reconcileGapDelta(CLOSED_REAL, OPENED_REAL);
    const body = JSON.parse(String(post.mock.calls[0][1])) as { model_id: string };
    expect(body.model_id).toMatch(/-v\d+:\d+$/);
  });

  it("excedente do teto é DECLARADO em `truncated`, não pareado às cegas", async () => {
    const many = Array.from({ length: 45 }, (_, i) => f({ anchor: `§${i}`, title: `defeito ${i}` }));
    reply([]);
    const r = await reconcileGapDelta(many, OPENED_REAL);
    expect(r.truncated).toBe(5);
    expect(r.reason).toMatch(/acima do teto/);
    // Ninguém foi perdido: os 45 fechados continuam nas contagens.
    expect(r.closed).toHaveLength(45);
  });
});
