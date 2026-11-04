import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { BACKEND_ERRORS, PORTAL_ONLY, cardErrorMessage, tableMessage } from "./cardErrors";
import { CONTRACT_DIR, SPEC_CONTRACT_DIR, fixture, fixtureNames, specFixture, specFixtureNames } from "./contractFixtures";
import { ERROR_SCHEMAS, ERROR_SCHEMAS_PREPARED, errorSchemaFor, schemaForFixture, schemaForSpecFixture, validate } from "./schemas";

// Contrato PORTAL × BACKEND: as fixtures são as respostas reais do api-node (teste de contrato do backend:
// `npm run contract:gen` em applications/services/api-node). Aqui o portal prova que entende cada uma delas.

const names = fixtureNames();

describe("fixtures reais do backend", () => {
  it("o índice gerado pelo backend lista exatamente os arquivos presentes", () => {
    const index = JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, "index.json"), "utf-8")) as string[];
    expect(index).toEqual(names);
    expect(names.length).toBeGreaterThanOrEqual(60);
  });

  it.each(names)("%s tem o formato que o portal espera", (name) => {
    const f = fixture(name);
    const schema = schemaForFixture(name, f.status, f.body as { code?: unknown } | null);
    if (!schema) { expect(f.body === null || f.body === undefined || f.status === 204).toBe(true); return; }
    expect(validate(schema, f.body)).toEqual([]);
  });

  it("cobre o ciclo inteiro: um detalhe e uma jornada por estado do card", () => {
    for (const st of ["draft", "refining", "ready", "promoted", "in_factory", "blocked", "delivered", "rejected"]) expect(names, st).toContain(`detail.${st}`);
    for (const j of ["draft-no-rfc", "refining", "ready", "ready-base-stale", "promoted", "in_factory", "blocked-budget", "delivered", "rejected"]) expect(names, j).toContain(`journey.${j}`);
  });

  it("a jornada concorda com o detalhe: estado, ações e trava da spec", () => {
    for (const st of ["draft", "refining", "ready", "promoted", "in_factory", "blocked", "delivered", "rejected"]) {
      const d = fixture<{ state: string; actions: Record<string, boolean> }>(`detail.${st}`).body;
      expect(d.state).toBe(st);
    }
    const ready = fixture<{ actions: { reopen: boolean; edit: boolean } }>("detail.ready").body;
    const jr = fixture<{ spec: { locked: boolean; canReopen: boolean } }>("journey.ready").body;
    expect(ready.actions.reopen).toBe(jr.spec.canReopen);
    expect(ready.actions.edit).toBe(!jr.spec.locked);
  });
});

describe("códigos de erro: tabela do backend × mensagens do portal", () => {
  const table = JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, "error-codes.json"), "utf-8")) as Record<string, { http: number; area: string; message: string }>;

  it("o portal tem mensagem PT-BR para TODO código do backend, idêntica à tabela dele", () => {
    const codes = Object.keys(table);
    expect(codes.length).toBeGreaterThanOrEqual(55);
    for (const code of codes) expect(tableMessage(code), code).toBe(table[code].message);
    expect(Object.keys(BACKEND_ERRORS).sort()).toEqual(codes.sort());
  });

  it("todo código só do portal é conhecido e justificado (não existe código órfão)", () => {
    for (const code of Object.keys(PORTAL_ONLY)) expect(table[code], `${code} existe no backend: remova de PORTAL_ONLY`).toBeUndefined();
    expect(Object.keys(PORTAL_ONLY)).toEqual(["TENANT_INACTIVE"]);
  });

  it("as mensagens são PT-BR acentuadas e curtas", () => {
    for (const [code, m] of [...Object.entries(table).map(([c, v]) => [c, v.message] as const), ...Object.entries(PORTAL_ONLY)]) {
      expect(m, code).not.toMatch(/\b(nao|voce|especificacao|promocao|orcamento|versao)\b/i);
      expect(m.length, code).toBeLessThan(200);
      expect(m, code).toMatch(/[.!?]$/);
    }
  });

  const errorFixtures = names.filter((n) => fixture(n).status >= 400);
  it.each(errorFixtures)("%s: o portal mostra a mensagem do servidor (userMessage) ou a da tabela", (name) => {
    const f = fixture<Record<string, unknown>>(name);
    const b = f.body;
    const retry = f.headers?.["retry-after"] ? Number(f.headers["retry-after"]) : undefined;
    const err = new ApiError(String(b.message), f.status, String(b.code), b, retry);
    const msg = cardErrorMessage(err);
    expect(msg.length).toBeGreaterThan(10);
    if (typeof b.userMessage === "string") {
      expect(msg.startsWith(b.userMessage) || b.code === "BAD_REQUEST", `${name}: ${msg}`).toBe(true);
      expect(b.userMessage, name).toBe(table[String(b.code)]?.message);
    } else {
      // sem userMessage (flag off, /evolve legado): cai na tabela local ou na mensagem do servidor
      expect(msg, name).toBe(tableMessage(String(b.code)) ?? String(b.message));
    }
  });

  it("detalhes montados do corpo real: tipo exigido, RFC inválido, saldo, anexos e Retry-After", () => {
    const mk = (n: string) => { const f = fixture<Record<string, unknown>>(n); return new ApiError(String(f.body.message), f.status, String(f.body.code), f.body, f.headers?.["retry-after"] ? Number(f.headers["retry-after"]) : undefined); };
    expect(cardErrorMessage(mk("ready.409-kind-requirement"))).toMatch(/Falta: seção “Non-goals”/);
    expect(cardErrorMessage(mk("ready.409-kind-requirement-fix"))).toMatch(/Falta: cenário de reprodução \(FAIL_TO_PASS\)/);
    expect(cardErrorMessage(mk("ready.409-rfc-invalid"))).toMatch(/docs\/rfc\/RFC-0001-exportar-csv\.md: escopo irrestrito/);
    expect(cardErrorMessage(mk("ready.402-budget-free-below-min"))).toMatch(/Saldo livre: US\$ 3\.00; mínimo exigido: US\$ 5\.00/);
    expect(cardErrorMessage(mk("create.400-attachment-invalid"))).toMatch(/virus\.exe|\.exe/);
    expect(cardErrorMessage(mk("promote.409-materialization-in-progress"))).toMatch(/Tente de novo em 2 s\./);
    expect(cardErrorMessage(mk("spec-write.400-path-out-of-scope"))).toMatch(/Pastas permitidas: tickets\/TK-\d+\/\*\*, docs\/rfc\/\*\*, docs\/adr\/\*\*\./);
    expect(cardErrorMessage(mk("create.400-bad-request"))).toMatch(/Descreva o que o card pede/);
  });

  it("o validador de ERROS é estrito por código: renomear, tirar ou acrescentar um campo do erro quebra a suíte (Y-11)", () => {
    const f = fixture<Record<string, unknown>>("promote.409-base-stale");
    const sch = schemaForFixture("promote.409-base-stale", f.status, f.body)!;
    expect(validate(sch, f.body)).toEqual([]);
    // mutação do relatório Y: renomear `expectedHead` no corpo do erro
    const { expectedHead, ...rest } = f.body;
    expect(validate(sch, { ...rest, expectedHeadX: expectedHead }).join("\n")).toMatch(/expectedHead: campo ausente[\s\S]*expectedHeadX: campo desconhecido/);
    // campos que o portal lê, um por código
    const cases: Array<[string, string]> = [
      ["ready.402-budget-free-below-min", "freeUsd"], ["ready.409-kind-requirement", "details"], ["ready.409-rfc-invalid", "details"], ["spec-write.400-path-out-of-scope", "writable"],
      ["create.400-attachment-invalid", "errors"], ["resume.402-budget-still-blocked", "guardCode"], ["ready.409-invalid-transition", "from"], ["promote.409-not-ready", "state"],
    ];
    for (const [name, field] of cases) {
      const g = fixture<Record<string, unknown>>(name);
      const s = schemaForFixture(name, g.status, g.body)!;
      const { [field]: gone, ...semCampo } = g.body;
      expect(gone, `${name}.${field}`).toBeDefined();
      expect(validate(s, semCampo)[0], `${name}: sem ${field}`).toMatch(new RegExp(`${field}: campo ausente`));
      expect(validate(s, { ...g.body, campoNovo: 1 })[0], name).toMatch(/campo desconhecido/);
    }
    // código sem schema estrito = erro (não passa mais por um schema frouxo)
    expect(validate(schemaForFixture("x.409", 409, { code: "CODIGO_NOVO" })!, { code: "CODIGO_NOVO", message: "m" })[0]).toMatch(/sem schema estrito/);
  });

  it("todo código de erro das fixtures tem schema estrito, e os códigos preparados para o backend novo estão cadastrados", () => {
    const codes = new Set<string>();
    for (const n of names) { const f = fixture<{ code?: string }>(n); if (f.status >= 400) codes.add(String(f.body.code)); }
    for (const n of specFixtureNames()) { const f = specFixture<{ code?: string }>(n); if (f.status >= 400) codes.add(String(f.body.code)); }
    for (const c of codes) expect(errorSchemaFor(c), c).not.toBeNull();
    for (const c of ERROR_SCHEMAS_PREPARED) expect(ERROR_SCHEMAS[c], c).toBeDefined();
  });

  it("o validador é estrito: campo novo ou tipo trocado no backend quebra o teste", () => {
    const j = fixture<Record<string, unknown>>("journey.ready").body;
    const s = schemaForFixture("journey.ready", 200)!;
    expect(validate(s, { ...j, novoCampo: 1 })[0]).toMatch(/campo desconhecido/);
    expect(validate(s, { ...j, specLocked: true })[0]).toMatch(/specLocked/);
    const { headline: _h, ...semHeadline } = j;
    void _h;
    expect(validate(s, semHeadline)[0]).toMatch(/headline: campo ausente/);
    expect(validate(s, { ...j, steps: [{ key: "draft", label: "x", state: "feito" }] })[0]).toMatch(/steps\[0\]\.state/);
  });
});

// ── Rotas de spec do rascunho, chat e planner (Y-03): fixtures reais do backend em `__contract__/spec/` ──────────────────────────
describe("fixtures reais das rotas de spec, chat e planner de RFC", () => {
  const spec = specFixtureNames();

  it("o índice gerado pelo backend lista exatamente os arquivos presentes", () => {
    const index = JSON.parse(fs.readFileSync(path.join(SPEC_CONTRACT_DIR, "index.json"), "utf-8")) as string[];
    expect(index).toEqual(spec);
    expect(spec.length).toBeGreaterThanOrEqual(25);
  });

  it.each(spec)("%s tem o formato que o portal espera", (name) => {
    const f = specFixture<{ code?: string }>(name);
    const schema = schemaForSpecFixture(name, f.status, f.body)!;
    expect(validate(schema, f.body), name).toEqual([]);
  });

  it("cobre a jornada da aba: listar, escopo, RFC em docs/rfc, conflito, chat, planner, modelo e travas", () => {
    for (const n of ["spec-tree.draft", "spec-files.draft", "spec-file.get-request", "spec-file.post-201", "spec-file.post-400-fora-do-escopo", "spec-file.put-409-conflict", "spec-file.put-200",
      "spec-chat.post-202", "spec-chat.get-done", "spec-chat.get-error", "spec-chat.post-409-locked", "evolution-plan.post-202", "evolution-plan.get-done", "evolution-plan.get-error",
      "rfc-from-template.201", "evolution-plan.post-409-locked", "spec-file.post-409-locked"]) expect(spec, n).toContain(n);
  });

  it("o rascunho novo só tem o pedido em tickets/TK-NNNN/ e o escopo recusa a raiz e rfc/ (o que a tela antiga sugeria)", () => {
    const tree = specFixture<{ files: Array<{ path: string }> }>("spec-tree.draft").body;
    expect(tree.files.map((x) => x.path)).toEqual(["tickets/TK-0001/request.md"]);
    for (const n of ["spec-file.post-400-fora-do-escopo", "spec-file.post-400-raiz"]) {
      const e = specFixture<{ code: string; writable: string[] }>(n);
      expect(e.status).toBe(400);
      expect(e.body.code).toBe("CARD_PATH_OUT_OF_SCOPE");
      expect(e.body.writable).toEqual(["tickets/TK-0001/**", "docs/rfc/**", "docs/adr/**"]);
    }
  });
});
