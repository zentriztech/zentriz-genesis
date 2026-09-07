import { describe, it, expect, vi } from "vitest";

/** Captura o que o SES receberia — o e-mail é onde a declaração de corte (GAP-63) tem de aparecer. */
const enviados: Array<{ html: string; text?: string }> = [];
vi.mock("./emailSender.js", () => ({
  isSesConfigured: () => true,
  sendEmail: async (m: { html: string; text?: string }) => { enviados.push(m); return { delivered: true }; },
}));

import {
  raiseSpecQuestions, answerSpecQuestion, notifySpecQuestionsEmail, cutDeclaration,
  SPEC_QUESTION_MAX_ROUNDS, QUESTION_MAX_LEN, QUESTIONS_PER_ROUND_CAP,
} from "./specQuestions.js";

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
    expect(r).toEqual({ ok: true, questionId: QID, round: 1, accepted: 2, dropped: 0, truncated: 0 });
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

  // ── GAP-63: o corte (12 por rodada / 1.000 chars) precisa ser DECLARADO ────────────────
  it("raise: corta em 12 perguntas e em 1.000 chars, e DECLARA o corte na notificação", async () => {
    const db = fakePool([
      [/SELECT id, tenant_id, title, status FROM projects/, () => ({ rows: [{ id: PID, tenant_id: TID, title: "CF", status: "running" }] })],
      [/count\(\*\)::int AS n FROM project_questions/, () => ({ rows: [{ n: 0 }] })],
      [/INSERT INTO project_questions/, () => ({ rows: [{ id: QID }] })],
    ]);
    const qs = Array.from({ length: 15 }, (_v, i) => `Pergunta ${i}?`);
    qs[0] = "L".repeat(1500) + "?";
    const r = await raiseSpecQuestions(db as never, { projectId: PID, questions: qs });
    expect(r).toMatchObject({ ok: true, accepted: QUESTIONS_PER_ROUND_CAP, dropped: 3, truncated: 1 });

    // o banco recebe só as 12, cada uma no máximo com QUESTION_MAX_LEN chars
    const ins = db.calls.find((c) => /INSERT INTO project_questions/.test(c.sql))!;
    const gravadas = JSON.parse(ins.params[3] as string) as string[];
    expect(gravadas).toHaveLength(QUESTIONS_PER_ROUND_CAP);
    expect(gravadas[0]).toHaveLength(QUESTION_MAX_LEN);

    // …e o humano é AVISADO do que ficou de fora (era silencioso antes do GAP-63)
    const notif = db.calls.find((c) => /INSERT INTO notifications/.test(c.sql))!;
    const corpo = notif.params[3] as string;
    expect(corpo).toContain("15 perguntas");
    expect(corpo).toContain("3 ficaram para a próxima");
    expect(corpo).toContain("1.000 caracteres");
  });

  it("raise: nada cortado → nenhuma declaração de corte no corpo da notificação", async () => {
    const db = fakePool([
      [/SELECT id, tenant_id, title, status FROM projects/, () => ({ rows: [{ id: PID, tenant_id: TID, title: "CF", status: "running" }] })],
      [/count\(\*\)::int AS n FROM project_questions/, () => ({ rows: [{ n: 0 }] })],
      [/INSERT INTO project_questions/, () => ({ rows: [{ id: QID }] })],
    ]);
    const r = await raiseSpecQuestions(db as never, { projectId: PID, questions: ["Qual o SLA?", "Multi-tenant?"] });
    expect(r).toMatchObject({ ok: true, accepted: 2, dropped: 0, truncated: 0 });
    const notif = db.calls.find((c) => /INSERT INTO notifications/.test(c.sql))!;
    expect(notif.params[3] as string).not.toContain("⚠️");
  });

  it("cutDeclaration: só fala quando houve corte; pluraliza os dois eixos", () => {
    expect(cutDeclaration(0, 0)).toBeNull();
    const um = cutDeclaration(0, 1)!;
    expect(um).toContain("1 pergunta passava");
    expect(um).toContain("teve o enunciado cortado");
    const varias = cutDeclaration(0, 3)!;
    expect(varias).toContain("3 perguntas passavam");
    expect(varias).toContain("tiveram o enunciado cortado");
    // o total anunciado é o que o CTO realmente perguntou (cortadas + as que entraram)
    expect(cutDeclaration(5, 0)!).toContain(`${5 + QUESTIONS_PER_ROUND_CAP} perguntas`);
  });

  it("e-mail: a declaração de corte aparece no HTML e no texto, sobre fundo escuro", async () => {
    const db = fakePool([
      [/FROM tenants WHERE id/, () => ({ rows: [{ name: "T", responsible_email: "dono@exemplo.com" }] })],
    ]);
    enviados.length = 0;
    const ok = await notifySpecQuestionsEmail(db as never, {
      projectId: PID, tenantId: TID, title: "CF", questions: ["Qual o SLA?"], round: 1, questionId: QID,
      cutNote: "⚠️ O CTO fez 15 perguntas: as 12 primeiras entraram nesta rodada e 3 ficaram para a próxima.",
    });
    expect(ok).toBe(true);
    expect(enviados).toHaveLength(1);
    expect(enviados[0].html).toContain("3 ficaram para a próxima");
    // regra de ouro §8.1: texto claro (âmbar) só sobre o card escuro
    expect(enviados[0].html).toMatch(/color:#f0b866[^"]*"[^>]*>⚠️ O CTO fez 15 perguntas/);
    expect(enviados[0].text).toContain("3 ficaram para a próxima");
  });
});
