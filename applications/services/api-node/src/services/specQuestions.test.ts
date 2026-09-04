import { describe, it, expect, vi } from "vitest";
import { raiseSpecQuestions, answerSpecQuestion, SPEC_QUESTION_MAX_ROUNDS } from "./specQuestions.js";

const PID = "11111111-1111-4111-8111-111111111111";
const TID = "22222222-2222-4222-8222-222222222222";
const QID = "33333333-3333-4333-8333-333333333333";
const UID = "44444444-4444-4444-8444-444444444444";

/** Pool fake: responde por padrão de SQL; grava todas as chamadas. */
function fakePool(handlers: Array<[RegExp, (params: unknown[]) => unknown]>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    for (const [re, h] of handlers) if (re.test(sql)) return h(params);
    return { rows: [], rowCount: 0 };
  });
  return { query, calls } as unknown as { query: typeof query; calls: typeof calls };
}

describe("specQuestions (D3)", () => {
  it("raise: grava pergunta, seta needs_spec_input + stopped_by, notifica in-app", async () => {
    const db = fakePool([
      [/SELECT id, tenant_id, title, status FROM projects/, () => ({ rows: [{ id: PID, tenant_id: TID, title: "CF", status: "running" }] })],
      [/count\(\*\)::int AS n FROM project_questions/, () => ({ rows: [{ n: 0 }] })],
      [/INSERT INTO project_questions/, () => ({ rows: [{ id: QID }] })],
    ]);
    const r = await raiseSpecQuestions(db as never, { projectId: PID, stage: "spec_review", questions: [" Qual o SLA? ", { question: "Multi-tenant?" }, ""] });
    expect(r).toEqual({ ok: true, questionId: QID, round: 1 });
    const sqls = db.calls.map((c) => c.sql);
    expect(sqls.some((s) => /status = 'needs_spec_input', stopped_by = 'human_question'/.test(s))).toBe(true);
    const ins = db.calls.find((c) => /INSERT INTO project_questions/.test(c.sql))!;
    expect(JSON.parse(ins.params[3] as string)).toEqual(["Qual o SLA?", "Multi-tenant?"]);
    expect(sqls.some((s) => /INSERT INTO notifications/.test(s) && /'spec_question'/.test(s))).toBe(true);
  });

  it("raise: pergunta já aberta → QUESTION_ALREADY_OPEN (idempotente, não consome rodada)", async () => {
    const db = fakePool([
      [/SELECT id, tenant_id, title, status FROM projects/, () => ({ rows: [{ id: PID, tenant_id: TID, title: "CF", status: "needs_spec_input" }] })],
      [/answered_at IS NULL ORDER BY created_at DESC LIMIT 1/, () => ({ rows: [{ id: QID, round: 1 }] })],
    ]);
    const r = await raiseSpecQuestions(db as never, { projectId: PID, questions: ["x?"] });
    expect(r).toMatchObject({ ok: false, code: "QUESTION_ALREADY_OPEN", round: 1, questionId: QID });
    expect(db.calls.some((c) => /INSERT INTO project_questions/.test(c.sql))).toBe(false);
  });

  it("raise: teto de rodadas → QUESTION_ROUNDS_EXCEEDED sem gravar nem mudar status", async () => {
    const db = fakePool([
      [/SELECT id, tenant_id, title, status FROM projects/, () => ({ rows: [{ id: PID, tenant_id: TID, title: "CF", status: "running" }] })],
      [/count\(\*\)::int AS n FROM project_questions/, () => ({ rows: [{ n: SPEC_QUESTION_MAX_ROUNDS }] })],
    ]);
    const r = await raiseSpecQuestions(db as never, { projectId: PID, questions: ["x?"] });
    expect(r).toMatchObject({ ok: false, code: "QUESTION_ROUNDS_EXCEEDED", round: SPEC_QUESTION_MAX_ROUNDS + 1 });
    expect(db.calls.some((c) => /INSERT INTO project_questions|needs_spec_input/.test(c.sql))).toBe(false);
  });

  it("raise: inválido (sem perguntas / id ruim) e projeto inexistente", async () => {
    const db = fakePool([[/SELECT id, tenant_id, title, status FROM projects/, () => ({ rows: [] })]]);
    expect(await raiseSpecQuestions(db as never, { projectId: "nope", questions: ["x"] })).toEqual({ ok: false, code: "INVALID" });
    expect(await raiseSpecQuestions(db as never, { projectId: PID, questions: [] })).toEqual({ ok: false, code: "INVALID" });
    expect(await raiseSpecQuestions(db as never, { projectId: PID, questions: ["x"] })).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("answer: só em needs_spec_input; grava resposta, extra.spec_answers e volta a spec_submitted", async () => {
    const db = fakePool([
      [/SELECT id, status FROM projects/, () => ({ rows: [{ id: PID, status: "needs_spec_input" }] })],
      [/FROM project_questions\s+WHERE project_id = \$1 AND answered_at IS NULL/, () => ({ rows: [{ id: QID, round: 1, stage: "spec_review", questions: ["Qual o SLA?"] }] })],
    ]);
    const r = await answerSpecQuestion(db as never, { projectId: PID, answer: "SLA 99,9%", userId: UID });
    expect(r).toEqual({ ok: true, questionId: QID, round: 1 });
    const upd = db.calls.find((c) => /UPDATE project_questions SET answer/.test(c.sql))!;
    expect(upd.params).toEqual([QID, "SLA 99,9%", UID]);
    const proj = db.calls.find((c) => /spec_answers/.test(c.sql))!;
    expect(proj.sql).toMatch(/status = 'spec_submitted', stopped_by = NULL/);
    expect(JSON.parse(proj.params[1] as string)[0]).toMatchObject({ round: 1, stage: "spec_review", answer: "SLA 99,9%", question_id: QID });
  });

  it("answer: status errado → WRONG_STATUS; sem pergunta aberta → NO_OPEN_QUESTION; vazio → INVALID", async () => {
    const wrong = fakePool([[/SELECT id, status FROM projects/, () => ({ rows: [{ id: PID, status: "running" }] })]]);
    expect(await answerSpecQuestion(wrong as never, { projectId: PID, answer: "x", userId: UID })).toEqual({ ok: false, code: "WRONG_STATUS", status: "running" });
    const none = fakePool([[/SELECT id, status FROM projects/, () => ({ rows: [{ id: PID, status: "needs_spec_input" }] })]]);
    expect(await answerSpecQuestion(none as never, { projectId: PID, answer: "x", userId: UID })).toEqual({ ok: false, code: "NO_OPEN_QUESTION" });
    expect(await answerSpecQuestion(none as never, { projectId: PID, answer: "   ", userId: UID })).toEqual({ ok: false, code: "INVALID" });
  });
});
