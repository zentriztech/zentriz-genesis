/**
 * specQuestions.ts — D3 (decisão do Jean, 2026-09-04): retorno HUMANO real da fábrica à Bancada.
 *
 * Fluxo:
 *  1. O CTO responde NEEDS_INFO (envelope `next_actions.questions`). O runner chama
 *     POST /api/projects/:id/questions e ENCERRA o run (checkpoint LEI 11 preservado).
 *  2. Aqui: grava `project_questions`, seta `projects.status = needs_spec_input`
 *     (`stopped_by = human_question` — o watchdog não relança), notifica o tenant IN-APP
 *     (tabela `notifications`, tipo `spec_question`) e por E-MAIL (SES; best-effort).
 *  3. O humano responde (POST /api/projects/:id/answer): a resposta vai para
 *     `project_questions.answer` e para `projects.extra.spec_answers[]` (o runner a injeta no CTO
 *     como `extra_instruction`), o status volta a `spec_submitted` e o run é redisparado — retoma do
 *     checkpoint, sem refazer o que já foi feito.
 *  4. Teto de rodadas (SPEC_QUESTION_MAX_ROUNDS, default 2): acima disso a API devolve 409 e o runner
 *     bloqueia com razão explícita (evita loop humano↔máquina — adversarial R3 #7).
 *  5. TTL (SPEC_QUESTION_TTL_HOURS, default 72): pergunta sem resposta → escalada à Zentriz
 *     (opsNotify), uma única vez por pergunta.
 *
 * Antes deste módulo, um NEEDS_INFO era "respondido" pelo Engineer (outro LLM) e o pipeline seguia —
 * a proteção "não inventar requisitos" era anulada (auditoria adversarial R2 §3.3).
 */
import type { Pool } from "pg";
import { isSesConfigured, sendEmail } from "./emailSender.js";
import { notifyFactoryBlocked } from "./opsNotify.js";

export const SPEC_QUESTION_MAX_ROUNDS = Math.max(1, parseInt(process.env.SPEC_QUESTION_MAX_ROUNDS ?? "2", 10) || 2);
export const SPEC_QUESTION_TTL_HOURS = Math.max(1, parseInt(process.env.SPEC_QUESTION_TTL_HOURS ?? "72", 10) || 72);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RaiseResult =
  | { ok: true; questionId: string; round: number }
  | { ok: false; code: "NOT_FOUND" | "INVALID" | "QUESTION_ROUNDS_EXCEEDED" | "QUESTION_ALREADY_OPEN"; round?: number; questionId?: string };

export type AnswerResult =
  | { ok: true; questionId: string; round: number }
  | { ok: false; code: "NOT_FOUND" | "INVALID" | "NO_OPEN_QUESTION" | "WRONG_STATUS"; status?: string };

function cleanQuestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const q of raw) {
    const text = typeof q === "string" ? q : (q && typeof q === "object" ? String((q as Record<string, unknown>).question ?? (q as Record<string, unknown>).text ?? "") : "");
    const t = text.trim().slice(0, 1000);
    if (t) out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A fábrica PERGUNTA: grava, para o projeto, notifica. */
export async function raiseSpecQuestions(pool: Pool, args: {
  projectId: string; stage?: string; questions: unknown; askedBy?: string; requestId?: string | null;
}): Promise<RaiseResult> {
  const questions = cleanQuestions(args.questions);
  if (!UUID_RE.test(args.projectId) || questions.length === 0) return { ok: false, code: "INVALID" };
  const stage = (args.stage ?? "spec_review").slice(0, 40);
  const proj = (await pool.query(
    "SELECT id, tenant_id, title, status FROM projects WHERE id = $1",
    [args.projectId],
  )).rows[0] as { id: string; tenant_id: string | null; title: string | null; status: string } | undefined;
  if (!proj) return { ok: false, code: "NOT_FOUND" };

  // Idempotência (adversarial D3 #E): já existe pergunta ABERTA → não cria outra nem consome rodada.
  const openRes = await pool.query(
    "SELECT id, round FROM project_questions WHERE project_id = $1 AND answered_at IS NULL ORDER BY created_at DESC LIMIT 1",
    [args.projectId],
  );
  if (openRes.rows[0]) return { ok: false, code: "QUESTION_ALREADY_OPEN", round: openRes.rows[0].round as number, questionId: openRes.rows[0].id as string };
  const roundRes = await pool.query("SELECT count(*)::int AS n FROM project_questions WHERE project_id = $1", [args.projectId]);
  const round = ((roundRes.rows[0]?.n as number) ?? 0) + 1;
  if (round > SPEC_QUESTION_MAX_ROUNDS) return { ok: false, code: "QUESTION_ROUNDS_EXCEEDED", round };

  const ins = await pool.query(
    `INSERT INTO project_questions (project_id, round, stage, questions, asked_by)
     VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
    [args.projectId, round, stage, JSON.stringify(questions), (args.askedBy ?? "cto").slice(0, 40)],
  );
  const questionId = ins.rows[0].id as string;
  await pool.query(
    "UPDATE projects SET status = 'needs_spec_input', stopped_by = 'human_question', updated_at = now() WHERE id = $1",
    [args.projectId],
  );

  // In-app (best-effort): um aviso por usuário do tenant.
  if (proj.tenant_id) {
    const title = `A fábrica tem ${questions.length} pergunta${questions.length > 1 ? "s" : ""} sobre "${proj.title ?? "seu projeto"}"`;
    const body = questions.slice(0, 3).map((q, i) => `${i + 1}. ${q}`).join("\n") + (questions.length > 3 ? `\n… (+${questions.length - 3})` : "");
    await pool.query(
      `INSERT INTO notifications (tenant_id, user_id, project_id, type, title, body)
       SELECT $1, u.id, $2, 'spec_question', $3, $4 FROM users u
        WHERE u.tenant_id = $1 AND u.role IN ('tenant_admin', 'user')`,
      [proj.tenant_id, args.projectId, title, body],
    ).catch((e) => console.warn("[spec-questions] notificação in-app falhou:", e instanceof Error ? e.message : e));
  }
  // E-mail (fire-and-forget).
  setImmediate(() => {
    notifySpecQuestionsEmail(pool, { projectId: args.projectId, tenantId: proj.tenant_id, title: proj.title, questions, round, questionId })
      .catch((e) => console.warn("[spec-questions] e-mail falhou:", e instanceof Error ? e.message : e));
  });
  return { ok: true, questionId, round };
}

export async function notifySpecQuestionsEmail(pool: Pool, a: {
  projectId: string; tenantId: string | null; title: string | null; questions: string[]; round: number; questionId: string;
}): Promise<boolean> {
  if (!a.tenantId || !isSesConfigured()) return false;
  const t = (await pool.query("SELECT name, responsible_name, responsible_email, email FROM tenants WHERE id = $1", [a.tenantId])).rows[0] as
    { name?: string; responsible_name?: string; responsible_email?: string; email?: string } | undefined;
  const to = (t?.responsible_email || t?.email || "").trim();
  if (!to) return false;
  const base = (process.env.PUBLIC_WEB_URL ?? "https://genesis.zentriz.com.br").replace(/\/$/, "");
  const link = `${base}/projects/${a.projectId}`;
  const subject = `Zentriz Genesis — a fábrica tem perguntas sobre "${a.title ?? "seu projeto"}"`;
  const items = a.questions.map((q) => `<li style="color:#e6edf5; font-size:14px; line-height:1.6; margin:0 0 8px 0;">${esc(q)}</li>`).join("");
  // Regra de ouro (§8.1): texto claro SÓ sobre fundo escuro.
  const html = `<!DOCTYPE html><html lang="pt-BR"><body style="margin:0; padding:0; background:#0b1320; font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b1320;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#0f1b2d; border-radius:12px; border:1px solid #1e3350;">
  <tr><td style="padding:22px 32px 8px 32px;"><div style="color:#17b3a3; font-size:12px; letter-spacing:1px; text-transform:uppercase; font-weight:bold;">Zentriz Genesis · Fábrica</div>
    <h1 style="color:#ffffff; font-size:20px; margin:8px 0 0 0;">A fábrica precisa de você para continuar</h1></td></tr>
  <tr><td style="padding:8px 32px 0 32px;"><p style="color:#c6d4e2; font-size:14px; line-height:1.65; margin:0;">
    ${t?.responsible_name ? `Olá, ${esc(t.responsible_name)}, ` : "Olá, "}o CTO da fábrica revisou a especificação de <b style="color:#ffffff;">${esc(a.title ?? "seu projeto")}</b>
    e encontrou ${a.questions.length} ponto${a.questions.length > 1 ? "s" : ""} que só você pode decidir (rodada ${a.round} de ${SPEC_QUESTION_MAX_ROUNDS}). O pipeline está <b style="color:#f0b866;">pausado</b> e retoma exatamente de onde parou assim que você responder.</p></td></tr>
  <tr><td style="padding:16px 32px 4px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#13253c; border-left:4px solid #17b3a3; border-radius:0 10px 10px 0;"><tr><td style="padding:16px 20px;">
    <div style="color:#17b3a3; font-size:12px; letter-spacing:1px; text-transform:uppercase; font-weight:bold; margin-bottom:10px;">Perguntas</div>
    <ol style="margin:0; padding-left:20px;">${items}</ol></td></tr></table></td></tr>
  <tr><td style="padding:20px 32px 26px 32px;" align="left">
    <a href="${link}" style="display:inline-block; background:#17b3a3; color:#062a26; font-weight:bold; font-size:14px; text-decoration:none; padding:12px 20px; border-radius:8px;">Responder na Bancada</a>
    <p style="color:#7a889b; font-size:12px; line-height:1.5; margin:14px 0 0 0;">Sem resposta em ${SPEC_QUESTION_TTL_HOURS}h a equipe Zentriz é avisada para ajudar. Link direto: <a href="${link}" style="color:#8fa6bd;">${link}</a></p></td></tr>
</table></td></tr></table></body></html>`;
  const text = `Zentriz Genesis — a fábrica tem perguntas sobre "${a.title ?? "seu projeto"}" (rodada ${a.round}/${SPEC_QUESTION_MAX_ROUNDS}).\n\n` +
    a.questions.map((q, i) => `${i + 1}. ${q}`).join("\n") + `\n\nResponda na Bancada: ${link}\nSem resposta em ${SPEC_QUESTION_TTL_HOURS}h a equipe Zentriz é avisada.`;
  const r = await sendEmail({ to, subject, html, text });
  if (r.delivered) {
    await pool.query("UPDATE project_questions SET notified_at = now() WHERE id = $1", [a.questionId]).catch(() => {});
  }
  console.log(`[spec-questions] e-mail projeto=${a.projectId} rodada=${a.round} delivered=${r.delivered}`);
  return r.delivered;
}

/** O humano RESPONDE: grava, injeta em extra.spec_answers, libera o status (o chamador redispara o run). */
export async function answerSpecQuestion(pool: Pool, args: {
  projectId: string; answer: string; userId: string | null; questionId?: string | null;
}): Promise<AnswerResult> {
  const answer = String(args.answer ?? "").trim().slice(0, 8000);
  if (!UUID_RE.test(args.projectId) || !answer) return { ok: false, code: "INVALID" };
  const proj = (await pool.query("SELECT id, status FROM projects WHERE id = $1", [args.projectId])).rows[0] as { id: string; status: string } | undefined;
  if (!proj) return { ok: false, code: "NOT_FOUND" };
  if (proj.status !== "needs_spec_input") return { ok: false, code: "WRONG_STATUS", status: proj.status };
  const q = (await pool.query(
    `SELECT id, round, stage, questions FROM project_questions
      WHERE project_id = $1 AND answered_at IS NULL ${args.questionId && UUID_RE.test(args.questionId) ? "AND id = $2" : ""}
      ORDER BY created_at DESC LIMIT 1`,
    args.questionId && UUID_RE.test(args.questionId) ? [args.projectId, args.questionId] : [args.projectId],
  )).rows[0] as { id: string; round: number; stage: string; questions: unknown } | undefined;
  if (!q) return { ok: false, code: "NO_OPEN_QUESTION" };
  const answeredBy = args.userId && UUID_RE.test(args.userId) ? args.userId : null;
  await pool.query(
    "UPDATE project_questions SET answer = $2, answered_by = $3, answered_at = now() WHERE id = $1",
    [q.id, answer, answeredBy],
  );
  const entry = { round: q.round, stage: q.stage, questions: q.questions, answer, answered_at: new Date().toISOString(), question_id: q.id };
  await pool.query(
    `UPDATE projects
        SET extra = jsonb_set(COALESCE(extra, '{}'::jsonb), '{spec_answers}',
                              COALESCE(extra->'spec_answers', '[]'::jsonb) || $2::jsonb, true),
            status = 'spec_submitted', stopped_by = NULL, updated_at = now()
      WHERE id = $1`,
    [args.projectId, JSON.stringify([entry])],
  );
  await pool.query("UPDATE notifications SET read = true WHERE project_id = $1 AND type = 'spec_question' AND read = false", [args.projectId]).catch(() => {});
  return { ok: true, questionId: q.id, round: q.round };
}

export async function listProjectQuestions(pool: Pool, projectId: string) {
  return (await pool.query(
    `SELECT id, round, stage, questions, asked_by AS "askedBy", answer, answered_by AS "answeredBy",
            answered_at AS "answeredAt", notified_at AS "notifiedAt", escalated_at AS "escalatedAt", created_at AS "createdAt"
       FROM project_questions WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId],
  )).rows;
}

/** Fila do tenant (null = zentriz_admin, tudo). Só perguntas ABERTAS de projetos em needs_spec_input. */
export async function listOpenQuestions(pool: Pool, tenantId: string | null, limit = 100) {
  const params: unknown[] = [];
  let where = "q.answered_at IS NULL AND p.status = 'needs_spec_input'";
  if (tenantId) { params.push(tenantId); where += ` AND p.tenant_id = $${params.length}`; }
  params.push(Math.min(Math.max(limit, 1), 500));
  return (await pool.query(
    `SELECT q.id, q.project_id AS "projectId", p.title AS "projectTitle", p.product_id AS "productId",
            q.round, q.stage, q.questions, q.created_at AS "createdAt", q.escalated_at AS "escalatedAt"
       FROM project_questions q JOIN projects p ON p.id = q.project_id
      WHERE ${where}
      ORDER BY q.created_at ASC
      LIMIT $${params.length}`,
    params,
  )).rows;
}

/** TTL: perguntas abertas há mais de `ttlHours` → escalada à Zentriz (uma vez por pergunta). */
export async function escalateStaleQuestions(pool: Pool, ttlHours = SPEC_QUESTION_TTL_HOURS): Promise<number> {
  const rows = (await pool.query(
    `SELECT q.id, q.project_id, q.round, q.created_at
       FROM project_questions q JOIN projects p ON p.id = q.project_id
      WHERE q.answered_at IS NULL AND q.escalated_at IS NULL AND p.status = 'needs_spec_input'
        AND q.created_at < now() - ($1 || ' hours')::interval
      ORDER BY q.created_at ASC LIMIT 50`,
    [String(ttlHours)],
  )).rows as Array<{ id: string; project_id: string; round: number; created_at: Date }>;
  let n = 0;
  for (const r of rows) {
    try {
      // `status` entra na chave de idempotência do opsNotify (`block:<status>` por projeto) — incluir a
      // rodada garante que uma 2ª pergunta sem resposta também escale (adversarial D3 #D).
      await notifyFactoryBlocked(pool, r.project_id, `needs_spec_input:round${r.round}`, {
        reason: `Pergunta da fábrica (rodada ${r.round}) sem resposta do tenant há mais de ${ttlHours}h — desde ${new Date(r.created_at).toISOString()}.`,
      });
    } catch (e) {
      console.warn("[spec-questions] escalada falhou:", e instanceof Error ? e.message : e);
    }
    await pool.query("UPDATE project_questions SET escalated_at = now() WHERE id = $1", [r.id]).catch(() => {});
    n++;
  }
  return n;
}
