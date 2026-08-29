/**
 * opsNotify.ts — notificações OPERACIONAIS por e-mail ao time Zentriz (Jean).
 *
 * Dois eventos:
 *   1. START  — quando um projeto é INICIADO pela Fábrica (transição p/ `running` /
 *      dispatch OK). Inclui título, produto, TENANT e QUEM iniciou (dono + origem).
 *   2. BLOCK  — quando um projeto entra em estado de bloqueio/falha real
 *      (`blocked_*`, `failed`, `spec_validation_failed`). `blocked_awaiting_expo_confirm`
 *      é espera humana (NÃO é erro) → excluído.
 *
 * Princípios (inegociáveis):
 *  - NUNCA bloqueia nem lança no pipeline: hooks chamam os wrappers fire-and-forget
 *    (`scheduleFactoryStart` / `maybeNotifyBlock`), que agendam em setImmediate e engolem erros.
 *  - IDEMPOTENTE: `ops_notifications` (UNIQUE project_id,kind) + INSERT ON CONFLICT DO NOTHING
 *    RETURNING — no máximo um e-mail por evento, à prova de corrida/cascata/re-run.
 *  - CONFIG-GATED / fail-safe: só envia se `isSesConfigured()` (fail-closed em prod sem creds)
 *    E destinatário não-vazio. Desligado ⇒ no-op silencioso (custo zero de LLM).
 *  - SEM PII EM LOG: loga só projectId/kind/delivered — nunca e-mail/nome (que só vão no corpo).
 */
import type { Pool } from "pg";
import { isSesConfigured, sendEmail } from "./emailSender.js";

/** Destinatário das notificações ops (default: Jean). */
function recipient(): string {
  return (process.env.OPS_NOTIFY_EMAIL ?? "jean@zentriz.com.br").trim();
}

/** Origem do disparo → rótulo PT-BR legível de "quem/como iniciou". */
const ORIGIN_LABELS: Record<string, string> = {
  interactive: "disparo interativo (/run)",
  cascade: "cascata de ondas",
  ingestion: "ingestão de produto (onda 0)",
  trigger: "gatilho de conclusão",
};
function originLabel(origin?: string): string {
  return (origin && ORIGIN_LABELS[origin]) || "fábrica";
}

/**
 * true se `status` é um estado de BLOQUEIO/FALHA REAL que merece alerta.
 * Exclui `blocked_awaiting_expo_confirm` (espera humana, não erro).
 */
export function isBlockStatus(status: string): boolean {
  if (status === "blocked_awaiting_expo_confirm") return false;
  return status.startsWith("blocked") || status === "failed" || status === "spec_validation_failed";
}

/**
 * true se `status` marca um projeto PRODUZIDO / entregue (100%): aceito ou concluído.
 * `delivered` também conta (deploy final). Usado pelo e-mail de fechamento de ciclo.
 */
export function isDoneStatus(status: string): boolean {
  return status === "accepted" || status === "completed" || status === "delivered";
}

interface ProjectEnrichment {
  title: string;
  status: string;
  product_name: string | null;
  tenant_name: string | null;
  user_email: string | null;
  user_name: string | null;
  user_role: string | null;
}

async function enrich(pool: Pool, projectId: string): Promise<ProjectEnrichment | null> {
  const res = await pool.query(
    `SELECT p.title, p.status,
            pr.name AS product_name,
            t.name  AS tenant_name,
            u.email AS user_email, u.name AS user_name, u.role AS user_role
       FROM projects p
       LEFT JOIN products pr ON pr.id = p.product_id
       LEFT JOIN tenants  t  ON t.id  = p.tenant_id
       LEFT JOIN users    u  ON u.id  = p.created_by
      WHERE p.id = $1`,
    [projectId],
  );
  return (res.rows[0] as ProjectEnrichment | undefined) ?? null;
}

interface DoneStats {
  tasks_total: number;
  tasks_done: number;
  duration_sec: number | null;
}

/** Estatísticas de fechamento: tarefas totais/concluídas e duração da fabricação. */
async function doneStats(pool: Pool, projectId: string): Promise<DoneStats> {
  try {
    const res = await pool.query(
      `SELECT
         (SELECT count(*) FROM project_tasks pt WHERE pt.project_id = $1)::int AS tasks_total,
         (SELECT count(*) FROM project_tasks pt WHERE pt.project_id = $1
            AND upper(pt.status) IN ('DONE','QA_PASS','ACCEPTED','COMPLETED','DELIVERED'))::int AS tasks_done,
         (SELECT extract(epoch FROM (COALESCE(finished_at, completed_at, updated_at) - started_at))::int
            FROM projects WHERE id = $1) AS duration_sec`,
      [projectId],
    );
    const r = res.rows[0] as { tasks_total?: number; tasks_done?: number; duration_sec?: number | null } | undefined;
    return {
      tasks_total: r?.tasks_total ?? 0,
      tasks_done: r?.tasks_done ?? 0,
      duration_sec: r?.duration_sec ?? null,
    };
  } catch {
    return { tasks_total: 0, tasks_done: 0, duration_sec: null };
  }
}

/**
 * Último passo humano-legível do pipeline (cyborg/system/watchdog) — usado como MOTIVO
 * do bloqueio quando o chamador não passou um `reason` explícito. Ex.: "deploy S3 bloqueado:
 * tenant sem GitHub App". Colapsa espaços e trunca. Nunca lança.
 */
async function latestBlockReason(pool: Pool, projectId: string): Promise<string | null> {
  try {
    const res = await pool.query(
      `SELECT summary_human FROM project_dialogue
        WHERE project_id = $1 AND from_agent IN ('cyborg','system','watchdog')
          AND summary_human IS NOT NULL AND btrim(summary_human) <> ''
        ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
    const s = res.rows[0]?.summary_human as string | undefined;
    if (!s) return null;
    const clean = s.replace(/[═\s]+/g, " ").trim();
    return clean ? clean.slice(0, 300) : null;
  } catch {
    return null;
  }
}

function esc(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Formata segundos em "Xh YYm" / "Ym" / "Zs". */
function fmtDuration(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "—";
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

/** Molde HTML branded escuro (contraste: fundo #0b1220, texto claro). */
function renderEmail(
  kind: "start" | "block" | "done",
  e: ProjectEnrichment,
  meta: { origin?: string; reason?: string; stats?: DoneStats },
): {
  subject: string;
  html: string;
  text: string;
} {
  const isStart = kind === "start";
  const isDone = kind === "done";
  const accent = isStart ? "#3b82f6" : isDone ? "#22c55e" : "#ef4444";
  const who = e.user_name || e.user_email || "desconhecido";
  const whoFull = e.user_email && e.user_name ? `${e.user_name} &lt;${esc(e.user_email)}&gt;` : esc(who);
  const tenant = e.tenant_name || "(sem tenant)";
  const product = e.product_name || "(sem produto)";
  const subject = isStart
    ? `[Genesis] 🏭 Fábrica iniciou um projeto — ${e.title}`
    : isDone
      ? `[Genesis] ✅ Projeto produzido (${e.status}) — ${e.title}`
      : `[Genesis] ⚠️ Projeto bloqueado (${e.status}) — ${e.title}`;
  const title = isStart
    ? "Fábrica iniciou um novo projeto"
    : isDone
      ? "Projeto produzido — 100%"
      : "Projeto bloqueado / falhou na Fábrica";
  const lead = isStart
    ? "Um novo projeto entrou em fabricação no Genesis. Detalhes abaixo."
    : isDone
      ? "Um projeto foi produzido de ponta a ponta pela Fábrica. Resumo abaixo."
      : "Um projeto entrou em estado de bloqueio/falha na Fábrica. Detalhes abaixo.";

  const rows: Array<[string, string]> = [
    ["PROJETO", esc(e.title)],
    ["TENANT", esc(tenant)],
    ["PRODUTO", esc(product)],
  ];
  if (isStart) {
    rows.push(["QUEM INICIOU", `${whoFull} · ${esc(originLabel(meta.origin))}`]);
  } else if (isDone) {
    rows.push(["STATUS", esc(e.status)]);
    rows.push(["DONO", whoFull]);
    const st = meta.stats;
    if (st) {
      rows.push(["TAREFAS", `${st.tasks_done}/${st.tasks_total} concluídas`]);
      rows.push(["DURAÇÃO", fmtDuration(st.duration_sec)]);
    }
  } else {
    rows.push(["STATUS", esc(e.status)]);
    rows.push(["DONO", whoFull]);
    if (meta.reason) rows.push(["MOTIVO", esc(meta.reason)]);
  }

  const rowsHtml = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:10px 18px;color:#93a4c3;font-size:12px;white-space:nowrap;vertical-align:top;">${k}</td>` +
        `<td style="padding:10px 18px;color:#eef2fb;font-size:14px;font-weight:bold;">${v}</td></tr>`,
    )
    .join("");

  const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0b1220;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b1220;">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0"
  style="max-width:600px;width:100%;background:#111a2e;border-radius:14px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
  <tr><td style="height:5px;background:${accent};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:26px 30px 8px 30px;">
    <div style="color:#93a4c3;font-size:12px;letter-spacing:1px;text-transform:uppercase;">Zentriz Genesis · Notificação operacional</div>
    <h1 style="color:#eef2fb;font-size:20px;margin:8px 0 0 0;line-height:1.35;">${esc(title)}</h1>
  </td></tr>
  <tr><td style="padding:12px 30px 4px 30px;color:#c3cee2;font-size:14px;line-height:1.6;">${esc(lead)}</td></tr>
  <tr><td style="padding:16px 30px 20px 30px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d1526;border-radius:10px;">
      ${rowsHtml}
    </table>
  </td></tr>
  <tr><td style="padding:6px 30px 26px 30px;border-top:1px solid #1e2b47;">
    <div style="color:#6b7a99;font-size:12px;line-height:1.6;">
      Enviado automaticamente pelo Genesis em ${esc(now)} · genesis.zentriz.com.br
    </div>
  </td></tr>
</table></td></tr></table></body></html>`;

  const textLines = rows.map(([k, v]) => `${k}: ${v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")}`);
  const text = `Zentriz Genesis — ${title}\n\n${lead}\n\n${textLines.join("\n")}\n`;
  return { subject, html, text };
}

/**
 * Núcleo idempotente: reivindica o slot (project_id,kind) e, se ganhou, envia o e-mail.
 * Nunca lança. Retorna true se ESTE chamador enviou (útil em teste).
 */
async function claimAndSend(
  pool: Pool,
  projectId: string,
  kind: string,
  build: (e: ProjectEnrichment) => { subject: string; html: string; text: string } | Promise<{ subject: string; html: string; text: string }>,
): Promise<boolean> {
  const to = recipient();
  if (!isSesConfigured() || !to) return false; // gate barato, antes de tocar o DB

  try {
    // Idempotência atômica: só quem inserir a linha (RETURNING não-vazio) envia.
    const claim = await pool.query(
      `INSERT INTO ops_notifications (project_id, kind) VALUES ($1, $2)
       ON CONFLICT (project_id, kind) DO NOTHING RETURNING id`,
      [projectId, kind],
    );
    if (claim.rowCount === 0) return false; // já notificado

    const e = await enrich(pool, projectId);
    if (!e) {
      // Projeto sumiu entre o INSERT e o enrich — não há o que enviar. Sem PII no log.
      console.warn(`[opsNotify] projeto ausente no enrich projectId=${projectId} kind=${kind}`);
      return false;
    }
    const email = await build(e);
    const res = await sendEmail({ to, subject: email.subject, html: email.html, text: email.text });
    console.info(`[opsNotify] projectId=${projectId} kind=${kind} delivered=${res.delivered}`);
    return res.delivered;
  } catch (err) {
    // Nunca propaga. Aceitamos perder no máximo este 1 e-mail (evita loop de spam).
    console.warn(`[opsNotify] falha projectId=${projectId} kind=${kind} delivered=false`);
    return false;
  }
}

/** START — e-mail de "projeto iniciado pela Fábrica" (idempotente por projeto). */
export async function notifyFactoryStart(
  pool: Pool,
  projectId: string,
  opts: { origin?: string } = {},
): Promise<void> {
  await claimAndSend(pool, projectId, "factory_start", (e) => renderEmail("start", e, { origin: opts.origin }));
}

/** BLOCK — e-mail de "projeto bloqueado/falhou" (idempotente por status distinto). */
export async function notifyFactoryBlocked(
  pool: Pool,
  projectId: string,
  status: string,
  opts: { reason?: string } = {},
): Promise<void> {
  await claimAndSend(pool, projectId, `block:${status}`, async (e) => {
    // Sem motivo explícito? Puxa o último passo humano-legível (cyborg/system) como motivo.
    const reason = opts.reason ?? (await latestBlockReason(pool, projectId)) ?? undefined;
    return renderEmail("block", e, { reason });
  });
}

/** DONE — e-mail de "projeto produzido 100%" (aceito/concluído), idempotente por projeto. */
export async function notifyFactoryDone(pool: Pool, projectId: string): Promise<void> {
  await claimAndSend(pool, projectId, "factory_done", async (e) => {
    const stats = await doneStats(pool, projectId);
    return renderEmail("done", e, { stats });
  });
}

/* ------------------------------------------------------------------ *
 * Wrappers FIRE-AND-FORGET — usados nos hooks do pipeline. Agendam em
 * setImmediate e engolem qualquer erro: NUNCA afetam a resposta/transição.
 * ------------------------------------------------------------------ */

/** Agenda o e-mail de START sem bloquear a resposta. */
export function scheduleFactoryStart(pool: Pool, projectId: string, opts: { origin?: string } = {}): void {
  setImmediate(() => {
    notifyFactoryStart(pool, projectId, opts).catch(() => {});
  });
}

/**
 * Agenda o e-mail de BLOCK sem bloquear a resposta — mas só se `status` for de
 * bloqueio/falha real (filtro `isBlockStatus`). Ponto de entrada dos hooks.
 */
export function maybeNotifyBlock(pool: Pool, projectId: string, status: string, opts: { reason?: string } = {}): void {
  if (!isBlockStatus(status)) return;
  setImmediate(() => {
    notifyFactoryBlocked(pool, projectId, status, opts).catch(() => {});
  });
}

/** Agenda o e-mail de DONE sem bloquear — via `maybeNotifyDone` (filtra por `isDoneStatus`). */
export function scheduleFactoryDone(pool: Pool, projectId: string): void {
  setImmediate(() => {
    notifyFactoryDone(pool, projectId).catch(() => {});
  });
}

/**
 * Agenda o e-mail de fechamento (produzido 100%) sem bloquear — só se `status` for
 * de conclusão real (`accepted`/`completed`/`delivered`). Ponto de entrada dos hooks.
 */
export function maybeNotifyDone(pool: Pool, projectId: string, status: string): void {
  if (!isDoneStatus(status)) return;
  scheduleFactoryDone(pool, projectId);
}
