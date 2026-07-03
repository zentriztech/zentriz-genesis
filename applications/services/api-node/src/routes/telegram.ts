// Telegram Bot integration — webhook, vinculação e notificações push
import type { FastifyInstance } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { signTokenWithExpiry } from "../auth.js";
import type { FastifyRequest } from "fastify";

const BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN ?? "";
const WEBHOOK_SECRET   = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
const WEBHOOK_PATH     = process.env.TELEGRAM_WEBHOOK_PATH ?? "wh/telegram";
const BOT_NAME         = "@zgenezis_bot";
const TELEGRAM_API     = "https://api.telegram.org";

// Rate limiting em memória: chat_id → { count, resetAt }
const rateLimitMap = new Map<number, { count: number; resetAt: number }>();

// ─── helpers ─────────────────────────────────────────────────────────────────

function getUser(req: FastifyRequest): AuthUser {
  return (req as unknown as { user: AuthUser }).user;
}

async function sendMessage(chatId: number, text: string): Promise<void> {
  if (!BOT_TOKEN) return;
  const url = `${TELEGRAM_API}/bot${BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // fire-and-forget — nunca bloqueia o pipeline
  }
}

function generateCode(length = 6): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 10)).join("");
}

function checkRateLimit(chatId: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(chatId);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(chatId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

// ─── notificação push (exportada para uso no runner/pipeline) ─────────────────

export async function notifyTelegramTenant(tenantId: string, message: string): Promise<void> {
  if (!BOT_TOKEN) return;
  try {
    const result = await pool.query(
      `SELECT ut.chat_id FROM user_telegram ut
       JOIN users u ON u.id = ut.user_id
       WHERE ut.tenant_id = $1 AND ut.active = true AND u.status = 'active'`,
      [tenantId]
    );
    for (const row of result.rows) {
      sendMessage(row.chat_id, message);
    }
  } catch {
    // notificação é best-effort
  }
}

export async function notifyTelegramUser(userId: string, message: string): Promise<void> {
  if (!BOT_TOKEN) return;
  try {
    const result = await pool.query(
      `SELECT chat_id FROM user_telegram WHERE user_id = $1 AND active = true`,
      [userId]
    );
    if (result.rows[0]) sendMessage(result.rows[0].chat_id, message);
  } catch {}
}

// ─── rotas ───────────────────────────────────────────────────────────────────

export async function telegramRoutes(app: FastifyInstance) {

  // ── rotas autenticadas (portal) ────────────────────────────────────────────

  app.addHook("preHandler", async (req, reply) => {
    // webhook é público (validado pelo secret header) — resto exige JWT
    if (req.routerPath?.includes(WEBHOOK_PATH)) return;
    return authMiddleware(req, reply);
  });

  /** GET /api/telegram/status — verifica se o usuário já está vinculado */
  app.get("/api/telegram/status", async (req, reply) => {
    const caller = getUser(req);
    const result = await pool.query(
      `SELECT chat_id, username, linked_at FROM user_telegram
       WHERE user_id = $1 AND active = true`,
      [caller.id]
    );
    if (!result.rows[0]) return reply.send({ linked: false });
    const row = result.rows[0];
    return reply.send({
      linked: true,
      username: row.username,
      linkedAt: row.linked_at,
    });
  });

  /** POST /api/auth/telegram/link-code — gera código de vinculação */
  app.post("/api/auth/telegram/link-code", async (req, reply) => {
    const caller = getUser(req);

    // invalidar código anterior não usado
    await pool.query(
      `DELETE FROM telegram_link_codes WHERE user_id = $1 AND used = false`,
      [caller.id]
    );

    const code = generateCode(6);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // +10 min

    await pool.query(
      `INSERT INTO telegram_link_codes (user_id, code, expires_at)
       VALUES ($1, $2, $3)`,
      [caller.id, code, expiresAt]
    );

    return reply.send({
      code,
      expiresAt,
      instruction: `Envie a mensagem abaixo para ${BOT_NAME} no Telegram:\n\n/start ${code}`,
      botName: BOT_NAME,
    });
  });

  /** DELETE /api/auth/telegram/unlink — revoga vinculação */
  app.delete("/api/auth/telegram/unlink", async (req, reply) => {
    const caller = getUser(req);
    await pool.query(
      `UPDATE user_telegram SET active = false WHERE user_id = $1`,
      [caller.id]
    );
    return reply.status(204).send();
  });

  // ── webhook (público — validado pelo secret header) ────────────────────────

  app.post(`/api/telegram/${WEBHOOK_PATH}`, async (req, reply) => {

    // Camada 1 — autenticidade do webhook
    const secret = (req.headers as Record<string, string>)["x-telegram-bot-api-secret-token"];
    if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
      return reply.status(401).send();
    }

    const body = req.body as TelegramUpdate;
    const message = body?.message;
    if (!message?.chat?.id) {
      return reply.status(200).send();
    }

    const chatId   = message.chat.id;
    const username = message.from?.username ?? null;

    // Suporte a anexos (document) — PDF, TXT, MD
    if (message.document && !message.text) {
      const caption = (message.caption ?? "").trim();
      const typeMatch = caption.match(/^(product|project)/i);
      const fileType = typeMatch ? typeMatch[1].toLowerCase() : null;

      const userRowDoc = await resolveUser(chatId);
      if (!userRowDoc) {
        await sendMessage(chatId, `❌ Conta não vinculada. Acesse o portal Genesis → Configurações → Telegram.`);
        return reply.status(200).send();
      }

      await handleDocumentNew(chatId, userRowDoc, message.document, fileType, caption);
      return reply.status(200).send();
    }

    if (!message?.text) {
      return reply.status(200).send();
    }

    const text = message.text.trim();

    // Rate limiting
    if (!checkRateLimit(chatId)) {
      await sendMessage(chatId, "⚠️ Muitas requisições. Aguarde 1 minuto.");
      return reply.status(200).send();
    }

    // Camada 2 — resolver usuário pelo chat_id
    const userRow = await resolveUser(chatId);

    // /start <code> — vinculação (não exige usuário já vinculado)
    if (text.startsWith("/start")) {
      await handleStart(chatId, text, username);
      return reply.status(200).send();
    }

    if (!userRow) {
      await sendMessage(chatId, `❌ Conta não vinculada.\n\nAcesse o portal Genesis → Configurações → Telegram e vincule sua conta.`);
      return reply.status(200).send();
    }

    // atualizar last_seen_at
    pool.query(`UPDATE user_telegram SET last_seen_at = now() WHERE chat_id = $1`, [chatId]).catch(() => {});

    // dispatcher de comandos — try/catch garante resposta mesmo em erro interno
    const [cmd, ...args] = text.split(" ");
    const rest = args.join(" ").trim();
    try {
      switch (cmd) {
        case "/list":   await handleList(chatId, userRow); break;
        case "/status": await handleStatus(chatId, userRow, args[0]); break;
        case "/tasks":  await handleTasks(chatId, userRow, args[0]); break;
        case "/log":    await handleLog(chatId, userRow, args[0]); break;
        case "/new":    await handleNew(chatId, userRow, args[0], rest.replace(/^(product|project)\s*/i, "").trim(), text); break;
        case "/run":    await handleDestructive(chatId, userRow, "run", args[0]); break;
        case "/stop":   await handleDestructive(chatId, userRow, "stop", args[0]); break;
        case "/accept": await handleDestructive(chatId, userRow, "accept", args[0]); break;
        case "/reject": await handleDestructive(chatId, userRow, "reject", args[0]); break;
        case "/delete": await handleDelete(chatId, userRow, args[0]); break;
        case "/unlink": await handleUnlink(chatId, userRow); break;
        case "/help":   await sendMessage(chatId, HELP_TEXT); break;
        default:
          if (/^\d{4}$/.test(text)) {
            await handleConfirmation(chatId, userRow, text);
          } else {
            await sendMessage(chatId, `Comando não reconhecido. Use /help para ver os comandos disponíveis.`);
          }
      }
    } catch (err) {
      console.error(`[Telegram dispatcher] cmd=${cmd} err=`, err);
      await sendMessage(chatId, `❌ Erro interno ao processar \`${cmd}\`. Tente novamente.`).catch(() => {});
    }

    return reply.status(200).send();
  });
}

// ─── handlers de comandos ─────────────────────────────────────────────────────

async function resolveUser(chatId: number) {
  const result = await pool.query(
    `SELECT ut.user_id, ut.tenant_id, u.role, u.status, u.email, u.name
     FROM user_telegram ut JOIN users u ON u.id = ut.user_id
     WHERE ut.chat_id = $1 AND ut.active = true`,
    [chatId]
  );
  return result.rows[0] ?? null;
}

async function handleStart(chatId: number, text: string, username: string | null) {
  const parts = text.split(" ");
  const code  = parts[1]?.trim();

  if (!code) {
    await sendMessage(chatId, `Bem-vindo ao *Genesis Bot*! 🤖\n\nPara vincular sua conta, acesse o portal Genesis → Configurações → Telegram e siga as instruções.`);
    return;
  }

  const codeRow = await pool.query(
    `SELECT user_id FROM telegram_link_codes
     WHERE code = $1 AND used = false AND expires_at > now()`,
    [code]
  );

  if (!codeRow.rows[0]) {
    await sendMessage(chatId, "❌ Código inválido ou expirado. Gere um novo código no portal.");
    return;
  }

  const userId = codeRow.rows[0].user_id;

  // buscar tenant_id do usuário
  const userRow = await pool.query(
    `SELECT tenant_id FROM users WHERE id = $1`,
    [userId]
  );
  const tenantId = userRow.rows[0]?.tenant_id ?? null;

  // remover vinculação anterior se existir
  await pool.query(`DELETE FROM user_telegram WHERE user_id = $1`, [userId]);

  // criar vinculação
  await pool.query(
    `INSERT INTO user_telegram (user_id, tenant_id, chat_id, username)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (chat_id) DO UPDATE
       SET user_id = $1, tenant_id = $2, username = $4, active = true, linked_at = now()`,
    [userId, tenantId, chatId, username]
  );

  // marcar código como usado
  await pool.query(`UPDATE telegram_link_codes SET used = true WHERE code = $1`, [code]);

  await sendMessage(chatId, `✅ *Conta vinculada com sucesso!*\n\nUse /status para ver seus projetos ativos.\nUse /help para ver todos os comandos.`);
}

async function handleStatus(chatId: number, user: UserRow, projectIdPrefix?: string) {
  // Com ID: detalhe de um projeto específico — qualquer status, pipeline travado ou não
  if (projectIdPrefix) {
    const proj = await resolveProjectAny(user.tenant_id, projectIdPrefix);
    if (!proj) {
      await sendMessage(chatId, "❌ Projeto não encontrado ou sem acesso.");
      return;
    }

    const [tasksRes, dialogRes] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)                                                   AS total,
           COUNT(*) FILTER (WHERE status = 'DONE')                   AS done,
           COUNT(*) FILTER (WHERE status = 'BLOCKED')                AS blocked,
           COUNT(*) FILTER (WHERE status = 'IN_PROGRESS')            AS in_progress,
           COUNT(*) FILTER (WHERE status = 'QA_FAIL')                AS qa_fail,
           COUNT(*) FILTER (WHERE status = 'WAITING_REVIEW')         AS waiting_review,
           COUNT(*) FILTER (WHERE status = 'ASSIGNED')               AS assigned,
           COUNT(*) FILTER (WHERE status = 'PENDING_CYBORG')         AS pending_cyborg,
           COUNT(*) FILTER (WHERE status = 'CANCELLED')              AS cancelled
         FROM project_tasks WHERE project_id = $1`,
        [proj.id]
      ),
      // Busca as 2 últimas mensagens — independente do estado do pipeline
      pool.query(
        `SELECT summary_human, from_agent, event_type, created_at
         FROM project_dialogue
         WHERE project_id = $1
         ORDER BY created_at DESC LIMIT 2`,
        [proj.id]
      ),
    ]);

    const t      = tasksRes.rows[0];
    const total  = Number(t.total);
    const done   = Number(t.done);
    const pct    = total > 0 ? Math.round((done / total) * 100) : 0;
    const bar    = progressBar(pct);
    const emoji  = statusEmoji(proj.status as string);

    // Resumo de tasks por estado (só mostra os não-zero)
    const taskDetails: string[] = [];
    if (total > 0) {
      if (done > 0)                            taskDetails.push(`  ✅ DONE: ${done}`);
      if (Number(t.in_progress) > 0)           taskDetails.push(`  🔄 Em andamento: ${t.in_progress}`);
      if (Number(t.waiting_review) > 0)        taskDetails.push(`  👀 Aguardando QA: ${t.waiting_review}`);
      if (Number(t.assigned) > 0)              taskDetails.push(`  📌 Atribuídas: ${t.assigned}`);
      if (Number(t.qa_fail) > 0)               taskDetails.push(`  ⚠️ QA\\_FAIL: ${t.qa_fail}`);
      if (Number(t.blocked) > 0)               taskDetails.push(`  🚫 BLOCKED: ${t.blocked}`);
      if (Number(t.pending_cyborg) > 0)        taskDetails.push(`  🤖 Aguardando Cyborg: ${t.pending_cyborg}`);
      if (Number(t.cancelled) > 0)             taskDetails.push(`  ⭕ Canceladas: ${t.cancelled}`);
    }

    // Últimas 2 mensagens do diálogo (reverter para ordem cronológica)
    const recentMsgs = dialogRes.rows.reverse().map((d) => {
      const at = new Date(d.created_at).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        day: "2-digit", month: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
      const agent = d.from_agent ? `*${d.from_agent}*` : "_sistema_";
      return `[${at}] ${agent}: ${String(d.summary_human ?? "").slice(0, 180)}`;
    });

    // Linha de alerta se pipeline estiver travado/parado
    const alertLine = ((): string => {
      if (proj.status === "failed")            return `\n⛔ *Pipeline falhou* — verifique os logs ou reinicie com /run`;
      if (proj.status === "stopped")           return `\n🛑 *Pipeline parado manualmente*`;
      if (proj.status === "blocked")           return `\n🚫 *Pipeline BLOCKED* — intervenção necessária`;
      if (proj.status === "pending_cyborg")    return `\n🤖 *Aguardando validação do Cyborg*`;
      if (proj.status === "pending_validation") return `\n⏳ *Aguardando validação*`;
      if (proj.status === "accepted")          return `\n✅ *Projeto aceito*`;
      if (proj.status === "completed")         return `\n🏁 *Pipeline concluído* — aguardando aceite`;
      return "";
    })();

    const lines = [
      `${emoji} *${proj.title}*`,
      `Status: \`${proj.status}\`${alertLine}`,
      ``,
      total > 0
        ? `${bar} ${pct}% — ${done}/${total} tasks`
        : `_Nenhuma task gerada ainda_`,
      ...taskDetails,
      ``,
      `📌 *Últimas atividades:*`,
      ...(recentMsgs.length
        ? recentMsgs.map((m) => `_${m}_`)
        : [`_Nenhuma atividade registrada_`]),
      ``,
      `\`${proj.id}\``,
    ];

    await sendMessage(chatId, lines.join("\n"));
    return;
  }

  // Sem ID: lista resumida — TODOS os projetos (incluindo parados, falhos, etc.)
  const result = await pool.query(
    `SELECT id, title, status, updated_at
     FROM projects
     WHERE tenant_id = $1
       AND status != 'archived'
     ORDER BY updated_at DESC LIMIT 20`,
    [user.tenant_id]
  );

  if (!result.rows.length) {
    await sendMessage(chatId, "📭 Nenhum projeto encontrado.\n\nUse /new project <descrição> para criar um.");
    return;
  }

  const lines = result.rows.map((p) => {
    const emoji = statusEmoji(p.status);
    const id    = String(p.id).substring(0, 8);
    const at    = new Date(p.updated_at).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
    return `${emoji} *${p.title}*\n   \`${id}\` — \`${p.status}\` _(${at})_`;
  });

  await sendMessage(chatId, `📊 *Seus projetos*\n\n${lines.join("\n\n")}\n\n_Use /status <id> para detalhes._`);
}

async function handleTasks(chatId: number, user: UserRow, projectIdPrefix?: string) {
  if (!projectIdPrefix) {
    await sendMessage(chatId, "Uso: /tasks <ID do projeto (primeiros 8 chars)>");
    return;
  }

  const proj = await resolveProject(user.tenant_id, projectIdPrefix);
  if (!proj) {
    await sendMessage(chatId, "❌ Projeto não encontrado ou sem acesso.");
    return;
  }

  const result = await pool.query(
    `SELECT task_id, owner_role, status, requirements
     FROM project_tasks
     WHERE project_id = $1 AND status NOT IN ('DONE', 'CANCELLED')
     ORDER BY created_at ASC LIMIT 10`,
    [proj.id]
  );

  if (!result.rows.length) {
    await sendMessage(chatId, `✅ Nenhuma task pendente em *${proj.title}*.`);
    return;
  }

  const lines = result.rows.map((t) =>
    `• \`${t.task_id}\` [${t.owner_role}] — ${t.status}`
  );

  await sendMessage(chatId, `📋 *Tasks pendentes — ${proj.title}*\n\n${lines.join("\n")}`);
}

async function handleLog(chatId: number, user: UserRow, projectIdPrefix?: string) {
  if (!projectIdPrefix) {
    await sendMessage(chatId, "Uso: /log <ID do projeto (primeiros 8 chars)>");
    return;
  }

  const proj = await resolveProject(user.tenant_id, projectIdPrefix);
  if (!proj) {
    await sendMessage(chatId, "❌ Projeto não encontrado ou sem acesso.");
    return;
  }

  const result = await pool.query(
    `SELECT summary_human, from_agent, created_at
     FROM project_dialogue
     WHERE project_id = $1
     ORDER BY created_at DESC LIMIT 10`,
    [proj.id]
  );

  if (!result.rows.length) {
    await sendMessage(chatId, `Nenhuma entrada de diálogo em *${proj.title}*.`);
    return;
  }

  const lines = result.rows.reverse().map((d) => {
    const time = new Date(d.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    return `[${time}] *${d.from_agent}*: ${d.summary_human}`;
  });

  await sendMessage(chatId, `📜 *Log — ${proj.title}*\n\n${lines.join("\n")}`);
}

async function handleDestructive(chatId: number, user: UserRow, action: string, projectIdPrefix?: string) {
  if (!projectIdPrefix) {
    await sendMessage(chatId, `Uso: /${action} <ID do projeto (primeiros 8 chars)>`);
    return;
  }

  // /run usa resolveProjectAny (qualquer status com spec)
  const proj = action === "run"
    ? await resolveProjectAny(user.tenant_id, projectIdPrefix)
    : await resolveProject(user.tenant_id, projectIdPrefix);

  if (!proj) {
    await sendMessage(chatId, "❌ Projeto não encontrado ou sem acesso.");
    return;
  }

  // /run: verificar se status permite iniciar
  if (action === "run") {
    const allowed = new Set(["draft","spec_submitted","pending_conversion","cto_charter","pm_backlog","failed","stopped"]);
    if (!allowed.has(proj.status as string)) {
      await sendMessage(chatId,
        `⚠️ Projeto *${proj.title}* está em \`${proj.status}\` — não pode ser (re)iniciado.\n\n` +
        `Status permitidos: spec\\_submitted, cto\\_charter, pm\\_backlog, failed, stopped.`
      );
      return;
    }
  }

  // verificar bloqueio por tentativas
  const blocked = await isActionBlocked(chatId);
  if (blocked) {
    await sendMessage(chatId, "🔒 Muitas tentativas incorretas. Tente novamente em 1 hora.");
    return;
  }

  // invalidar pendência anterior
  await pool.query(
    `UPDATE telegram_pending_actions SET used = true WHERE chat_id = $1 AND used = false`,
    [chatId]
  );

  const code = generateCode(4);
  const expiresAt = new Date(Date.now() + 60_000);

  await pool.query(
    `INSERT INTO telegram_pending_actions (chat_id, action, project_id, code, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [chatId, action, proj.id, code, expiresAt]
  );

  const actionLabel: Record<string, string> = {
    run:    "🚀 Iniciar pipeline",
    stop:   "⛔ Interromper",
    accept: "✅ Aceitar",
    reject: "❌ Rejeitar",
    delete_project: "🗑 Remover projeto do banco (arquivos mantidos)",
    delete_product: "🗑 Remover produto e todos os projetos do banco (arquivos mantidos)",
  };

  await sendMessage(
    chatId,
    `${actionLabel[action] ?? action} *${proj.title}*\n\nConfirme digitando o código: *${code}*\n_(válido por 60 segundos)_`
  );
}

async function handleConfirmation(chatId: number, user: UserRow, code: string) {
  const pending = await pool.query(
    `SELECT id, action, project_id, attempts FROM telegram_pending_actions
     WHERE chat_id = $1 AND used = false AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [chatId]
  );

  if (!pending.rows[0]) {
    await sendMessage(chatId, "⚠️ Nenhuma ação pendente ou código expirado.");
    return;
  }

  const row = pending.rows[0];

  if (row.attempts >= 3) {
    await pool.query(`UPDATE telegram_pending_actions SET used = true WHERE id = $1`, [row.id]);
    // registrar bloqueio temporário (1h) via coluna extra ou tabela auxiliar
    await pool.query(
      `INSERT INTO telegram_pending_actions (chat_id, action, project_id, code, expires_at, used)
       VALUES ($1, 'blocked', $2, '', now() + interval '1 hour', false)`,
      [chatId, row.project_id]
    );
    await sendMessage(chatId, "🔒 3 tentativas incorretas. Acesso bloqueado por 1 hora.");
    return;
  }

  // verificar código
  const codeRow = await pool.query(
    `SELECT code FROM telegram_pending_actions WHERE id = $1`, [row.id]
  );
  if (codeRow.rows[0]?.code !== code) {
    await pool.query(
      `UPDATE telegram_pending_actions SET attempts = attempts + 1 WHERE id = $1`, [row.id]
    );
    const left = 2 - row.attempts;
    await sendMessage(chatId, `❌ Código incorreto. ${left} tentativa(s) restante(s).`);
    return;
  }

  // marcar como usado
  await pool.query(`UPDATE telegram_pending_actions SET used = true WHERE id = $1`, [row.id]);

  // executar ação via API interna com token do usuário
  const token = signTokenWithExpiry({
    sub: user.user_id,
    email: user.email,
    role: user.role,
    tenantId: user.tenant_id,
  }, "2m");

  const apiBase = `http://localhost:${process.env.PORT ?? 3000}`;
  const actionMap: Record<string, { method: string; path: string }> = {
    run:            { method: "POST",   path: `/api/projects/${row.project_id}/run` },
    stop:           { method: "POST",   path: `/api/projects/${row.project_id}/stop` },
    accept:         { method: "POST",   path: `/api/projects/${row.project_id}/accept` },
    reject:         { method: "POST",   path: `/api/projects/${row.project_id}/reject` },
    delete_project: { method: "DELETE", path: `/api/projects/${row.project_id}?keepFiles=true` },
    delete_product: { method: "DELETE", path: `/api/products/${row.project_id}` },
  };

  const endpoint = actionMap[row.action];
  if (!endpoint) {
    await sendMessage(chatId, "❌ Ação desconhecida.");
    return;
  }

  try {
    const res = await fetch(`${apiBase}${endpoint.path}`, {
      method: endpoint.method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: endpoint.method !== "DELETE" ? JSON.stringify({}) : undefined,
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      const labels: Record<string, string> = {
        run:            "🚀 Pipeline iniciado! Acompanhe pelo /status ou pelo portal.",
        stop:           "⛔ Pipeline interrompido com segurança.",
        accept:         "✅ Projeto aceito com sucesso.",
        reject:         "❌ Projeto rejeitado.",
        delete_project: `🗑 Projeto removido do banco. Arquivos em disco mantidos.`,
        delete_product: `🗑 ${(body as { message?: string }).message ?? "Produto removido do banco."}`,
      };
      await sendMessage(chatId, labels[row.action] ?? "✅ Ação executada.");
    } else {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      await sendMessage(chatId, `❌ Erro ao executar ação: ${(body as {message?: string}).message ?? res.status}`);
    }
  } catch (err) {
    await sendMessage(chatId, "❌ Erro interno ao executar ação. Tente pelo portal.");
  }
}

// ─── /delete <project:id|product:id> ─────────────────────────────────────────
// Remove somente do banco (arquivos mantidos). Solicita código de 4 dígitos.
async function handleDelete(chatId: number, user: UserRow, idPrefix?: string) {
  if (!idPrefix) {
    await sendMessage(
      chatId,
      "Uso:\n" +
      "  `/delete project:<id>` — remove projeto do banco (arquivos mantidos)\n" +
      "  `/delete product:<id>` — remove produto e todos os projetos filhos do banco\n\n" +
      "_O prefixo (8+ chars) identifica o registro._"
    );
    return;
  }

  // Detectar se é produto ou projeto pelo prefixo
  const isProduct = idPrefix.toLowerCase().startsWith("product:");
  const rawId     = idPrefix.replace(/^(product|project):/i, "").trim();

  if (!rawId) {
    await sendMessage(chatId, "❌ ID inválido. Use `product:<id>` ou `project:<id>`.");
    return;
  }

  const blocked = await isActionBlocked(chatId);
  if (blocked) {
    await sendMessage(chatId, "🔒 Muitas tentativas incorretas. Tente novamente em 1 hora.");
    return;
  }

  // Resolver o registro para mostrar o nome ao usuário
  let title = rawId.substring(0, 8);
  let resolvedId = rawId;

  if (isProduct) {
    const res = await pool.query(
      `SELECT id, name FROM products WHERE id::text LIKE $1 AND tenant_id = $2 LIMIT 1`,
      [`${rawId}%`, user.tenant_id]
    );
    if (!res.rows[0]) {
      await sendMessage(chatId, "❌ Produto não encontrado ou sem acesso.");
      return;
    }
    title      = res.rows[0].name;
    resolvedId = res.rows[0].id;
  } else {
    const proj = await resolveProjectAny(user.tenant_id, rawId);
    if (!proj) {
      await sendMessage(chatId, "❌ Projeto não encontrado ou sem acesso.");
      return;
    }
    if ((proj.status as string) === "running") {
      await sendMessage(chatId, `⚠️ Projeto *${proj.title}* está em execução. Pare primeiro com /stop.`);
      return;
    }
    title      = proj.title as string;
    resolvedId = proj.id as string;
  }

  // Invalidar pendências anteriores e criar nova
  await pool.query(
    `UPDATE telegram_pending_actions SET used = true WHERE chat_id = $1 AND used = false`,
    [chatId]
  );

  const code      = generateCode(4);
  const expiresAt = new Date(Date.now() + 60_000);
  const action    = isProduct ? "delete_product" : "delete_project";

  await pool.query(
    `INSERT INTO telegram_pending_actions (chat_id, action, project_id, code, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [chatId, action, resolvedId, code, expiresAt]
  );

  const typeLabel = isProduct ? "produto (e todos os projetos filhos)" : "projeto";
  await sendMessage(
    chatId,
    `🗑 *Remover ${typeLabel}:* ${title}\n\n` +
    `Apenas o banco de dados será limpo — arquivos em disco serão mantidos.\n\n` +
    `Digite o código para confirmar: *${code}*\n_(válido por 60 segundos)_`
  );
}

async function handleList(chatId: number, user: UserRow) {
  // Buscar produtos do tenant + projetos filhos com contagem de tasks
  const result = await pool.query(
    `SELECT
       pr.id, pr.title, pr.status, pr.product_id,
       pd.name  AS product_name,
       COUNT(pt.id)                                          AS total_tasks,
       COUNT(pt.id) FILTER (WHERE pt.status = 'DONE')       AS done_tasks
     FROM projects pr
     LEFT JOIN products pd  ON pd.id  = pr.product_id
     LEFT JOIN project_tasks pt ON pt.project_id = pr.id
     WHERE pr.tenant_id = $1
       AND pr.status NOT IN ('archived', 'draft')
     GROUP BY pr.id, pr.title, pr.status, pr.product_id, pd.name
     ORDER BY pd.name NULLS LAST, pr.updated_at DESC`,
    [user.tenant_id]
  );

  if (!result.rows.length) {
    await sendMessage(chatId, "📭 Nenhum projeto encontrado.");
    return;
  }

  // Agrupar por produto
  const groups = new Map<string, { name: string; rows: typeof result.rows }>();
  for (const row of result.rows) {
    const key  = row.product_id ?? "__standalone__";
    const name = row.product_name ?? "Projetos avulsos";
    if (!groups.has(key)) groups.set(key, { name, rows: [] });
    groups.get(key)!.rows.push(row);
  }

  const sections: string[] = [];

  for (const { name, rows } of groups.values()) {
    const lines: string[] = [`📦 *${name}*`];
    for (const p of rows) {
      const total    = Number(p.total_tasks);
      const done     = Number(p.done_tasks);
      const pct      = total > 0 ? Math.round((done / total) * 100) : 0;
      const bar      = progressBar(pct);
      const shortId  = String(p.id).substring(0, 8);
      const emoji    = statusEmoji(p.status);
      lines.push(
        `\n${emoji} *${p.title}*\n` +
        `   ${bar} ${pct}% — ${done}/${total} tasks\n` +
        `   \`${p.id}\``
      );
    }
    sections.push(lines.join("\n"));
  }

  // Telegram tem limite de 4096 chars — dividir se necessário
  const full = sections.join("\n\n");
  if (full.length <= 4000) {
    await sendMessage(chatId, full);
  } else {
    for (const section of sections) {
      await sendMessage(chatId, section);
    }
  }
}

function progressBar(pct: number): string {
  const filled = Math.round(pct / 10);
  return "▓".repeat(filled) + "░".repeat(10 - filled);
}

// ─── /new — parser e criação de produto/projeto com spec gerada ──────────────

interface ParsedProject {
  index:   number;
  title:   string;
  desc:    string;
  isBackend: boolean;   // detectado por palavras-chave
  consumesIndex?: number; // índice do projeto backend que este consome
}

function extractQuotedName(text: string): string | null {
  const m = text.match(/[""]([^""]+)[""]/);
  return m ? m[1].trim() : null;
}

function parseProductMessage(body: string): { productTitle: string; projects: ParsedProject[] } {
  const lines = body.split("\n");

  // ── Título do produto ──────────────────────────────────────────────────────
  // Prioridade: (1) texto entre aspas na primeira linha, (2) primeira linha limpa
  const firstLine = lines[0].trim();
  const productTitle =
    extractQuotedName(firstLine) ??
    (firstLine.replace(/^[#\-\*\s]+/, "").replace(/\(.*\)/, "").trim().slice(0, 80) || "Novo Produto");

  // ── Extrair blocos por número ──────────────────────────────────────────────
  // Detectar linhas de início de projeto: "1.", "1)", "2.", etc.
  // Todo o texto até o próximo número (ou fim) é a descrição desse projeto
  const blocks: { index: number; raw: string }[] = [];
  let currentIndex: number | null = null;
  let currentLines: string[] = [];

  for (const line of lines.slice(1)) {
    const headerMatch = line.trim().match(/^(\d+)[.):\-]\s*(.*)/);
    if (headerMatch) {
      if (currentIndex !== null) {
        blocks.push({ index: currentIndex, raw: currentLines.join("\n").trim() });
      }
      currentIndex = parseInt(headerMatch[1], 10);
      currentLines = [headerMatch[2]];
    } else if (currentIndex !== null) {
      currentLines.push(line);
    }
  }
  if (currentIndex !== null) {
    blocks.push({ index: currentIndex, raw: currentLines.join("\n").trim() });
  }

  // ── Montar ParsedProject para cada bloco ──────────────────────────────────
  const projects: ParsedProject[] = blocks.map(({ index, raw }) => {
    // Nome do projeto: entre aspas se houver, senão primeira linha
    const rawFirstLine = raw.split("\n")[0].trim();
    const title =
      extractQuotedName(rawFirstLine) ??
      (rawFirstLine.replace(/^[#\-\*\s"]+/, "").replace(/[":,]+$/, "").trim().slice(0, 80) || `Projeto ${index}`);

    const lower = raw.toLowerCase();
    const isBackend =
      /\bbackend\b/.test(lower) ||
      /\bapi\s+rest\b/.test(lower) ||
      /\bnode\.?js\b/.test(lower) ||
      /\bfastapi\b/.test(lower) ||
      /\bexpress\b/.test(lower) ||
      /\bfastify\b/.test(lower) ||
      /\bnestjs\b/.test(lower) ||
      (/\bpython\b/.test(lower) && !/\bfrontend\b|\bweb\b/.test(lower)) ||
      (/\b(postgres|mysql|mongo|banco|drizzle|prisma)\b/.test(lower) &&
       !/\bfrontend\b|\bmanager\b|\bweb\b|\bnext\b|\breact\b/.test(lower));

    return { index, title, desc: raw, isBackend };
  });

  // ── Detectar qual projeto consome qual backend ─────────────────────────────
  // 1. Referência explícita: "consumindo o Backend de Oficinas", "usando o backend(1)",
  //    "Trigger: Backend X", linha com "Trigger:" no final da mensagem
  const triggerLines = body.split("\n").filter((l) => /^\s*Trigger\s*[:\-]/i.test(l));

  for (const proj of projects) {
    if (proj.isBackend) continue;

    // Buscar referência pelo NOME do backend (nome entre aspas ou texto)
    const backendProjects = projects.filter((p) => p.isBackend);

    // Verificar se algum nome de backend aparece na descrição deste projeto
    for (const backend of backendProjects) {
      const backendNameLower = backend.title.toLowerCase();
      if (proj.desc.toLowerCase().includes(backendNameLower)) {
        proj.consumesIndex = backend.index;
        break;
      }
    }

    // Verificar linhas de Trigger no body
    if (!proj.consumesIndex) {
      for (const trigLine of triggerLines) {
        for (const backend of backendProjects) {
          if (trigLine.toLowerCase().includes(backend.title.toLowerCase())) {
            proj.consumesIndex = backend.index;
            break;
          }
        }
        // Trigger com número: "Trigger: (1)" ou "Trigger: projeto 1"
        const numMatch = trigLine.match(/Trigger.*?(\d+)/i);
        if (numMatch) {
          proj.consumesIndex = parseInt(numMatch[1], 10);
          break;
        }
      }
    }

    // Referência numérica na descrição: "backend(1)", "usando (1)"
    if (!proj.consumesIndex) {
      const refMatch = proj.desc.match(
        /\b(?:backend|api|usando|consome?s?|consumi(?:ndo)?|integralmente)\s*(?:o\s+)?(?:projeto\s+)?[(\[]?(\d+)[)\]]?/i
      );
      if (refMatch) proj.consumesIndex = parseInt(refMatch[1], 10);
    }

    // Heurística final: se há exatamente 1 backend, todos os frontends consomem ele
    if (!proj.consumesIndex && backendProjects.length === 1) {
      proj.consumesIndex = backendProjects[0].index;
    }
  }

  return { productTitle, projects };
}

function buildSpec(title: string, description: string, type: "product" | "project", projectIndex?: number): string {
  const header = type === "product"
    ? `# Spec — ${title}\n\n> Criado via Telegram Bot\n\n## Descrição do Produto\n\n${description}`
    : `# Spec — ${title}\n\n> Criado via Telegram Bot\n\n## Descrição\n\n${description}`;

  const sections = [
    header,
    `\n## Tipo de Projeto\n\n${detectProjectType(description)}`,
    `\n## Requisitos Funcionais\n\nExtraídos da ideia original:\n\n${description
      .split(/[;\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 3)
      .map((s) => `- ${s}`)
      .join("\n")}`,
    `\n## Observações Técnicas\n\n${detectTechHints(description)}`,
  ];

  return sections.join("\n");
}

function detectProjectType(desc: string): string {
  const lower = desc.toLowerCase();
  if (/next\.?js|react|mui|material.ui|tailwind|frontend|manager web|portal web/.test(lower)) return "frontend_webapp";
  if (/react.native|expo|mobile|android|ios/.test(lower)) return "mobile_app";
  if (/node\.?js|fastify|express|nestjs|backend|api rest/.test(lower)) return "backend_api";
  if (/fastapi|python|flask|django/.test(lower)) return "backend_api_python";
  if (/html|css|landpage|landing/.test(lower)) return "static_site";
  return "backend_api";
}

function detectTechHints(desc: string): string {
  const lower = desc.toLowerCase();
  const hints: string[] = [];
  if (/postgres|postgresql/.test(lower)) hints.push("- Banco de dados: PostgreSQL");
  if (/mysql/.test(lower))               hints.push("- Banco de dados: MySQL");
  if (/mongo/.test(lower))               hints.push("- Banco de dados: MongoDB");
  if (/auth|autenticação|login|jwt/.test(lower)) hints.push("- Autenticação: JWT");
  if (/next\.?js/.test(lower))           hints.push("- Framework frontend: Next.js");
  if (/react.native|expo/.test(lower))   hints.push("- Framework mobile: React Native + Expo");
  if (/mui|material.ui/.test(lower))     hints.push("- UI: Material UI (MUI)");
  if (/tailwind/.test(lower))            hints.push("- UI: Tailwind CSS");
  if (/node\.?js|express|fastify/.test(lower)) hints.push("- Runtime: Node.js");
  if (/python|fastapi/.test(lower))      hints.push("- Runtime: Python");
  return hints.length ? hints.join("\n") : "- Stack a definir no pipeline";
}

async function saveProjectSpec(
  client: { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  params: {
    tenantId: string; userId: string; title: string;
    specMd: string; productId: string | null;
  }
): Promise<string> {
  const fsModule   = await import("fs/promises");
  const pathModule = await import("path");
  const uploadDir  = process.env.UPLOAD_DIR ?? "/shared/uploads";
  const specRef    = `telegram-${Date.now()}-${Math.random().toString(36).slice(2, 5)}.md`;

  // T-05 fix: gravar project_type normalizado no extra desde a criação via Telegram.
  // Antes: detectProjectType() só entrava no texto da spec — o CTO tinha que redetectar.
  // Agora: normalização via policies.json + type_aliases (mobile_app → mobile_crossplatform,
  // static_site → frontend_landing, frontend_webapp → frontend_dashboard etc.).
  const rawType = detectProjectType(params.specMd);
  const { normalizeProjectType } = await import("../services/typePolicyNormalizer.js");
  const projectType = normalizeProjectType(rawType) ?? rawType;

  const projRes = await client.query(
    `INSERT INTO projects (tenant_id, created_by, title, spec_ref, status, product_id, extra)
     VALUES ($1, $2, $3, $4, 'spec_submitted', $5, $6::jsonb) RETURNING id`,
    [params.tenantId, params.userId, params.title, specRef, params.productId,
     JSON.stringify({ created_via: "telegram", project_type: projectType, project_type_raw: rawType })]
  );
  const projectId = projRes.rows[0].id as string;

  const projectDir = pathModule.join(uploadDir, projectId);
  await fsModule.mkdir(projectDir, { recursive: true });
  const filePath = pathModule.join(projectDir, specRef);
  await fsModule.writeFile(filePath, params.specMd, "utf8");

  await client.query(
    `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type)
     VALUES ($1, $2, $3, 'text/markdown')`,
    [projectId, specRef, filePath]
  );

  return projectId;
}

async function handleNew(chatId: number, user: UserRow, type: string, _spec: string, rawText: string) {
  const normalizedType = type?.toLowerCase();

  if (normalizedType !== "product" && normalizedType !== "project") {
    await sendMessage(chatId, [
      "❓ *Uso do /new:*",
      "",
      "*/new project* <descrição>",
      "_Projeto standalone — descreva na mesma linha_",
      "",
      "*/new product* <nome do produto>",
      "_1. Descrição do projeto 1_",
      "_2. Descrição do projeto 2_",
      "_N. ..._",
      "",
      "*Exemplo produto:*",
      "`/new product Sistema de Oficina`",
      "`1. Backend Node.js + Postgres + Auth`",
      "`2. Manager Web Next.js + MUI (usando backend(1))`",
    ].join("\n"));
    return;
  }

  // Extrair corpo: tudo após "/new product" ou "/new project"
  const body = rawText.replace(/^\/new\s+(product|project)\s*/i, "").trim();

  if (body.length < 10) {
    await sendMessage(chatId, "⚠️ Adicione uma descrição após o comando.");
    return;
  }

  await sendMessage(chatId, `⏳ Processando sua ideia...`);

  try {
    const client = await pool.connect();
    try {
      if (normalizedType === "project") {
        // ── Projeto standalone ──────────────────────────────────────────────
        const title  = body.split("\n")[0].replace(/^[#\-\*\s]+/, "").trim().slice(0, 80) || "Novo Projeto";
        const specMd = buildSpec(title, body, "project");
        const projectId = await saveProjectSpec(client, {
          tenantId: user.tenant_id, userId: user.user_id,
          title, specMd, productId: null,
        });

        await sendMessage(chatId, [
          `✅ *Projeto criado!*`,
          ``,
          `📌 *${title}*`,
          `\`${projectId}\``,
          ``,
          `Status: \`spec_submitted\``,
          `_Acesse o portal para revisar a spec e iniciar o pipeline._`,
          ``,
          `🔗 https://genesis.zentriz.com.br/projects`,
        ].join("\n"));

      } else {
        // ── Produto com N projetos ──────────────────────────────────────────
        const { productTitle, projects } = parseProductMessage(body);

        if (projects.length === 0) {
          await sendMessage(chatId, [
            "⚠️ Não encontrei projetos numerados na mensagem.",
            "",
            "Formato esperado:",
            "`/new product Nome do Produto`",
            "`1. Descrição do projeto 1`",
            "`2. Descrição do projeto 2`",
          ].join("\n"));
          return;
        }

        // Criar produto
        const prodRes = await client.query(
          `INSERT INTO products (tenant_id, created_by, name) VALUES ($1, $2, $3) RETURNING id`,
          [user.tenant_id, user.user_id, productTitle]
        );
        const productId = prodRes.rows[0].id as string;

        // Criar projetos em ordem, guardar mapa index → projectId
        const indexToProjectId = new Map<number, string>();
        const createdProjects: { title: string; id: string; isBackend: boolean }[] = [];

        for (const proj of projects) {
          const specMd    = buildSpec(proj.title, proj.desc, "project", proj.index);
          const projectId = await saveProjectSpec(client, {
            tenantId: user.tenant_id, userId: user.user_id,
            title: proj.title, specMd, productId,
          });
          indexToProjectId.set(proj.index, projectId);
          createdProjects.push({ title: proj.title, id: projectId, isBackend: proj.isBackend });
        }

        // Criar links (uses_backend) e triggers automáticos
        const triggersCreated: string[] = [];
        for (const proj of projects) {
          if (!proj.consumesIndex) continue;
          const frontendId = indexToProjectId.get(proj.index);
          const backendId  = indexToProjectId.get(proj.consumesIndex);
          if (!frontendId || !backendId) continue;

          // Link uses_backend
          await client.query(
            `INSERT INTO project_links (from_project_id, to_project_id, relation_type)
             VALUES ($1, $2, 'uses_backend')
             ON CONFLICT DO NOTHING`,
            [frontendId, backendId]
          ).catch(() => {});

          // Trigger: backend accepted → frontend starts
          await client.query(
            `INSERT INTO project_triggers (project_id, trigger_project_id, trigger_status)
             VALUES ($1, $2, 'accepted')
             ON CONFLICT DO NOTHING`,
            [frontendId, backendId]
          ).catch(() => {});

          const backendTitle  = projects.find((p) => p.index === proj.consumesIndex)?.title ?? `Projeto ${proj.consumesIndex}`;
          triggersCreated.push(`*${backendTitle}* aceito → inicia *${proj.title}*`);
        }

        // Montar resposta
        const projectLines = createdProjects.map((p, i) =>
          `${i + 1}. ${p.isBackend ? "🔧" : "🖥️"} *${p.title}*\n   \`${p.id}\``
        );

        const lines = [
          `✅ *Produto criado com ${createdProjects.length} projetos!*`,
          ``,
          `📦 *${productTitle}*`,
          ``,
          ...projectLines,
        ];

        if (triggersCreated.length) {
          lines.push(``, `🔗 *Triggers automáticos:*`);
          triggersCreated.forEach((t) => lines.push(`   • ${t}`));
        }

        lines.push(``, `_Acesse o portal para revisar as specs e iniciar o pipeline._`);
        lines.push(``, `🔗 https://genesis.zentriz.com.br/projects`);

        await sendMessage(chatId, lines.join("\n"));
      }

    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[Telegram /new]", err);
    await sendMessage(chatId, "❌ Erro ao criar. Verifique o formato e tente novamente.");
  }
}

async function handleDocumentNew(
  chatId: number,
  user: UserRow,
  doc: { file_id: string; file_name?: string; mime_type?: string },
  fileType: string | null,
  caption: string,
) {
  const ALLOWED_MIME = new Set([
    "text/plain", "text/markdown", "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ]);
  const mime = doc.mime_type ?? "";
  const name = doc.file_name ?? "spec";
  const ext  = name.split(".").pop()?.toLowerCase() ?? "";

  if (!ALLOWED_MIME.has(mime) && !["txt","md","pdf","doc","docx"].includes(ext)) {
    await sendMessage(chatId,
      `❌ Formato não suportado: *${name}*\n\nAceitos: PDF, TXT, MD, DOC, DOCX`
    );
    return;
  }

  if (!BOT_TOKEN) {
    await sendMessage(chatId, "❌ Bot não configurado para downloads.");
    return;
  }

  await sendMessage(chatId, `⏳ Baixando *${name}*...`);

  try {
    // 1. Obter URL de download do Telegram
    const fileRes = await fetch(
      `${TELEGRAM_API}/bot${BOT_TOKEN}/getFile?file_id=${doc.file_id}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    const fileData = await fileRes.json() as { ok: boolean; result?: { file_path?: string } };
    if (!fileData.ok || !fileData.result?.file_path) {
      await sendMessage(chatId, "❌ Não foi possível obter o arquivo do Telegram.");
      return;
    }

    // 2. Baixar o arquivo
    const downloadUrl = `${TELEGRAM_API}/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;
    const dlRes  = await fetch(downloadUrl, { signal: AbortSignal.timeout(30_000) });
    const buffer = Buffer.from(await dlRes.arrayBuffer());

    // 3. Se PDF/DOCX → converter via spec_converter
    let specMd: string;
    if (["pdf","doc","docx"].includes(ext)) {
      // Chamar spec_converter via API interna de agents
      const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim();
      if (!agentsUrl) {
        await sendMessage(chatId, "❌ Serviço de conversão não disponível. Envie um arquivo .md ou .txt.");
        return;
      }
      const form = new FormData();
      form.append("file", new Blob([buffer], { type: mime }), name);
      const convRes = await fetch(`${agentsUrl}/convert-spec`, {
        method: "POST", body: form,
        signal: AbortSignal.timeout(60_000),
      });
      if (!convRes.ok) {
        await sendMessage(chatId, "❌ Erro ao converter o arquivo. Tente com um .md ou .txt.");
        return;
      }
      const convData = await convRes.json() as { markdown?: string };
      specMd = convData.markdown ?? buffer.toString("utf8");
    } else {
      specMd = buffer.toString("utf8");
    }

    // 4. Criar projeto/produto com a spec extraída
    const normalizedType = fileType ?? "project";
    const client = await pool.connect();
    try {
      if (normalizedType === "product") {
        // Tentar parsear como produto multi-projeto
        const { productTitle, projects } = parseProductMessage(specMd);
        if (projects.length > 0) {
          // reutilizar lógica do handleNew product
          const prodRes = await client.query(
            `INSERT INTO products (tenant_id, created_by, name) VALUES ($1, $2, $3) RETURNING id`,
            [user.tenant_id, user.user_id, productTitle]
          );
          const productId = prodRes.rows[0].id as string;
          const indexToProjectId = new Map<number, string>();
          const created: { title: string; id: string }[] = [];
          for (const proj of projects) {
            const pSpecMd = buildSpec(proj.title, proj.desc, "project", proj.index);
            const pid = await saveProjectSpec(client, {
              tenantId: user.tenant_id, userId: user.user_id,
              title: proj.title, specMd: pSpecMd, productId,
            });
            indexToProjectId.set(proj.index, pid);
            created.push({ title: proj.title, id: pid });
          }
          for (const proj of projects) {
            if (!proj.consumesIndex) continue;
            const fId = indexToProjectId.get(proj.index);
            const bId = indexToProjectId.get(proj.consumesIndex);
            if (fId && bId) {
              await client.query(
                `INSERT INTO project_links (from_project_id, to_project_id, relation_type) VALUES ($1,$2,'uses_backend') ON CONFLICT DO NOTHING`,
                [fId, bId]
              ).catch(() => {});
              await client.query(
                `INSERT INTO project_triggers (project_id, trigger_project_id, trigger_status) VALUES ($1,$2,'accepted') ON CONFLICT DO NOTHING`,
                [fId, bId]
              ).catch(() => {});
            }
          }
          await sendMessage(chatId, [
            `✅ *Produto criado com ${created.length} projetos!*`,
            `📦 *${productTitle}*`,
            ...created.map((p, i) => `${i + 1}. *${p.title}*\n   \`${p.id}\``),
            ``, `_Revise as specs no portal e inicie o pipeline._`,
          ].join("\n"));
          return;
        }
      }
      // Projeto único
      const titleLine = specMd.split("\n").find((l) => l.trim()) ?? name;
      const title = titleLine.replace(/^#+\s*/, "").replace(/^[#\-\*\s]+/, "").trim().slice(0, 80) || name;
      const projectId = await saveProjectSpec(client, {
        tenantId: user.tenant_id, userId: user.user_id,
        title, specMd, productId: null,
      });
      await sendMessage(chatId, [
        `✅ *Projeto criado a partir de ${name}!*`,
        `📌 *${title}*`,
        `\`${projectId}\``,
        ``, `_Use /run ${projectId.slice(0,8)} para iniciar o pipeline._`,
      ].join("\n"));
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[Telegram document]", err);
    await sendMessage(chatId, "❌ Erro ao processar o arquivo. Tente novamente.");
  }
}

async function handleUnlink(chatId: number, user: UserRow) {
  await pool.query(`UPDATE user_telegram SET active = false WHERE chat_id = $1`, [chatId]);
  await sendMessage(chatId, "🔓 Vinculação removida. Você não receberá mais notificações neste chat.");
}

// ─── utils ───────────────────────────────────────────────────────────────────

async function resolveProject(tenantId: string, prefix: string) {
  const result = await pool.query(
    `SELECT id, title, status FROM projects
     WHERE tenant_id = $1 AND id::text LIKE $2
       AND status NOT IN ('accepted', 'failed', 'archived', 'draft')
     LIMIT 1`,
    [tenantId, `${prefix}%`]
  );
  return result.rows[0] ?? null;
}

// Sem filtro de status — usado por /status <id>
async function resolveProjectAny(tenantId: string, prefix: string) {
  const result = await pool.query(
    `SELECT id, title, status FROM projects
     WHERE tenant_id = $1 AND id::text LIKE $2
     ORDER BY updated_at DESC LIMIT 1`,
    [tenantId, `${prefix}%`]
  );
  return result.rows[0] ?? null;
}

async function isActionBlocked(chatId: number): Promise<boolean> {
  const result = await pool.query(
    `SELECT id FROM telegram_pending_actions
     WHERE chat_id = $1 AND action = 'blocked' AND used = false AND expires_at > now()
     LIMIT 1`,
    [chatId]
  );
  return result.rows.length > 0;
}

function statusEmoji(status: string): string {
  const map: Record<string, string> = {
    running:    "🔄",
    completed:  "✅",
    failed:     "❌",
    stopped:    "⛔",
    pending_cyborg:   "🤖",
    blocked_cyborg:   "⚠️",
    dev_qa:     "🔧",
    devops:     "🚀",
    pm_backlog: "📋",
    cto_charter:"📐",
  };
  return map[status] ?? "📦";
}

const HELP_TEXT = `*Genesis Bot* — Comandos disponíveis:

➕ /new product <nome> — cria produto com projetos numerados
➕ /new project <descrição> — cria projeto standalone
📎 _Envie PDF/TXT/MD com caption "product" ou "project"_

📋 /list — produtos e projetos com progresso
📊 /status — projetos (todos os status)
📊 /status <id> — detalhes completos de um projeto
🔍 /tasks <id> — tasks pendentes
📜 /log <id> — log do pipeline

⚠️ Requerem confirmação (código 4 dígitos):
🚀 /run <id> — iniciar pipeline
⛔ /stop <id> — interromper pipeline
✅ /accept <id> — aceitar projeto finalizado
❌ /reject <id> — rejeitar projeto
🗑 /delete project:<id> — remover projeto do banco (arquivos mantidos)
🗑 /delete product:<id> — remover produto e filhos do banco (arquivos mantidos)

🔗 /unlink — remover vinculação
❓ /help — exibir esta mensagem

_Use os primeiros 8 chars do ID. Para /delete use o prefixo completo (project: ou product:)._`;

// ─── tipos internos ───────────────────────────────────────────────────────────

type UserRow = {
  user_id:   string;
  tenant_id: string;
  role:      string;
  status:    string;
  email:     string;
  name:      string;
};

type TelegramUpdate = {
  message?: {
    text?: string;
    caption?: string;
    chat?: { id: number };
    from?: { username?: string };
    document?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
  };
};
