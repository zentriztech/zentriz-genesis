/**
 * Rotas do GUARDA de custo de LLM (migration 131 — post-mortem 30/09/2026).
 *
 * Internas (server-to-server, `authenticateInternal`, fail-closed em prod):
 *   POST /api/internal/llm-guard/preflight — licença ANTES de toda chamada paga (agents/runner/cyborg/Deadpool)
 *   POST /api/internal/llm-guard/record    — registro DEPOIS da chamada (tokens + USD) e consequências
 * Usuário (authMiddleware + canAccessProjectRow):
 *   GET/PUT /api/projects/:id/budget — orçamento em USD, passo de alerta, gasto, previsão
 * Admin (zentriz_admin):
 *   GET/PUT /api/admin/llm-guard/settings — chave geral e tetos globais; GET .../events
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { canAccessProjectRow } from "../lib/projectAccess.js";
import { authenticateInternal } from "./internalLlm.js";
import {
  ALERT_STEP_OPTIONS, budgetSummary, getGuardSettings, maybeResumeBudget, preflight, recordCall,
  resolveBudgetOwner, setGuardSetting, evaluateBudget, type PreflightInput, type RecordInput,
} from "../services/llmGuard.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

type GuardBody = Partial<RecordInput> & { systemId?: string; serviceId?: string };

/** Token de MÁQUINA do run (`svc:"runner"`) é amarrado ao próprio projeto: debita só nele. */
function runnerProjectOf(request: FastifyRequest): string | null {
  const auth = authenticateInternal(request);
  const p = auth.ok ? (auth.payload as { svc?: string; projectId?: string } | null) : null;
  return p?.svc === "runner" && p.projectId ? String(p.projectId) : null;
}

/** Deadpool conhece systemId/serviceId, não o projeto: resolve pelo vínculo de monitoramento. */
async function resolveProjectId(body: GuardBody, forced: string | null = null): Promise<string | null> {
  if (forced) return forced;
  const pid = (body.projectId ?? "").trim();
  if (pid) return pid;
  const sys = (body.systemId ?? "").trim();
  if (!sys) return null;
  const svc = (body.serviceId ?? "").trim();
  const r = await pool.query(
    `SELECT project_id FROM project_deadpool_monitoring
      WHERE system_id = $1 AND ($2 = '' OR service_id = $2)
      ORDER BY active DESC, updated_at DESC LIMIT 1`,
    [sys, svc],
  );
  return r.rows[0]?.project_id ? String(r.rows[0].project_id) : null;
}

export async function llmGuardInternalRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: GuardBody }>("/api/internal/llm-guard/preflight", async (request, reply) => {
    if (!authenticateInternal(request).ok) return reply.status(401).send({ allow: false, code: "UNAUTHORIZED" });
    const body = request.body ?? {};
    let projectId: string | null;
    try {
      projectId = await resolveProjectId(body, runnerProjectOf(request));
    } catch (e) {
      return reply.send({ allow: false, code: "GUARD_ERROR", message: `Resolução de projeto falhou: ${String(e)}` });
    }
    // Deadpool sem projeto vinculado não tem orçamento a debitar ⇒ nega (não vira "sem projeto").
    if (body.source === "deadpool" && !projectId) {
      return reply.send({ allow: false, code: "PROJECT_NOT_FOUND", message: "Serviço monitorado sem projeto vinculado — sem orçamento para debitar." });
    }
    const input: PreflightInput = { ...body, projectId };
    const decision = await preflight(pool, input);
    if (!decision.allow) {
      request.log.warn({ projectId, purpose: body.purpose, source: body.source, code: decision.code }, "[llm-guard] chamada NEGADA");
    }
    return reply.send({ ...decision, projectId });
  });

  app.post<{ Body: GuardBody }>("/api/internal/llm-guard/record", async (request, reply) => {
    if (!authenticateInternal(request).ok) return reply.status(401).send({ code: "UNAUTHORIZED" });
    const body = request.body ?? {};
    const projectId = await resolveProjectId(body, runnerProjectOf(request)).catch(() => null);
    const out = await recordCall(pool, {
      ...body, projectId,
      inputTokens: Number(body.inputTokens ?? 0), outputTokens: Number(body.outputTokens ?? 0),
    } as RecordInput);
    return reply.send({ ok: true, ...out });
  });
}

export async function llmGuardUserRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  app.get<{ Params: { id: string } }>("/api/projects/:id/budget", async (request, reply) => {
    const user = getUser(request);
    const row = (await pool.query("SELECT id, tenant_id, created_by FROM projects WHERE id = $1", [request.params.id])).rows[0];
    if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
    if (!canAccessProjectRow(user, row)) return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
    return reply.send(await budgetSummary(pool, request.params.id));
  });

  // Definir/aumentar o orçamento. Sempre grava no DONO (filhos de split herdam). Liberar a pausa
  // NÃO religa a execução: o usuário retoma explicitamente (sem gasto surpresa).
  app.put<{ Params: { id: string }; Body: { budgetUsd?: number; alertStepPct?: number } }>(
    "/api/projects/:id/budget",
    async (request, reply) => {
      const user = getUser(request);
      if (user.svc) return reply.status(403).send({ code: "FORBIDDEN", message: "Orçamento só é definido por pessoa, não por agente." });
      const row = (await pool.query("SELECT id, tenant_id, created_by FROM projects WHERE id = $1", [request.params.id])).rows[0];
      if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      if (!canAccessProjectRow(user, row)) return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
      const budget = Number(request.body?.budgetUsd);
      const step = Number(request.body?.alertStepPct);
      if (!Number.isFinite(budget) || budget <= 0 || budget > 1_000_000) {
        return reply.status(400).send({ code: "INVALID_BUDGET", message: "Informe o orçamento em US$ (maior que zero)." });
      }
      if (!ALERT_STEP_OPTIONS.includes(step as (typeof ALERT_STEP_OPTIONS)[number])) {
        return reply.status(400).send({ code: "INVALID_ALERT_STEP", message: `Passo de alerta deve ser um de ${ALERT_STEP_OPTIONS.join(", ")}%.` });
      }
      const owner = await resolveBudgetOwner(pool, request.params.id);
      if (!owner) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      await pool.query(
        `UPDATE projects SET budget_usd = $2, budget_alert_step_pct = $3, budget_updated_at = now(), updated_at = now() WHERE id = $1`,
        [owner.ownerId, budget.toFixed(2), step],
      );
      await pool.query(
        "INSERT INTO llm_guard_events (kind, project_id, detail) VALUES ('budget_set', $1, $2::jsonb)",
        [owner.ownerId, JSON.stringify({ from: owner.budgetUsd, to: budget, step, by: user.email })],
      ).catch(() => undefined);
      const resumed = await maybeResumeBudget(pool, owner.ownerId);
      // Reduzir abaixo do gasto pausa na hora (e avisa) em vez de esperar a próxima chamada.
      const fresh = await resolveBudgetOwner(pool, owner.ownerId);
      if (fresh) await evaluateBudget(pool, fresh).catch(() => undefined);
      return reply.send({ ...(await budgetSummary(pool, request.params.id)), resumed });
    },
  );

  const requireAdmin = (request: FastifyRequest) => getUser(request)?.role === "zentriz_admin" && !getUser(request)?.svc;

  app.get("/api/admin/llm-guard/settings", async (request, reply) => {
    if (!requireAdmin(request)) return reply.status(403).send({ code: "FORBIDDEN" });
    const g = (await pool.query(
      `SELECT COALESCE(SUM(cost_usd) FILTER (WHERE created_at > now() - interval '1 hour'), 0) AS hour,
              COALESCE(SUM(cost_usd), 0) AS day, COUNT(*) AS calls
         FROM llm_call_ledger WHERE created_at > now() - interval '24 hours'`,
    )).rows[0];
    return reply.send({ settings: await getGuardSettings(pool), spend: { lastHourUsd: Number(g.hour), last24hUsd: Number(g.day), calls24h: Number(g.calls) } });
  });

  app.put<{ Body: Record<string, string | number> }>("/api/admin/llm-guard/settings", async (request, reply) => {
    if (!requireAdmin(request)) return reply.status(403).send({ code: "FORBIDDEN" });
    const allowed = new Set(["kill_switch", "global_max_usd_per_hour", "global_max_usd_per_day", "unattributed_max_usd_per_day", "repeat_max_per_6h"]);
    const by = getUser(request).email;
    for (const [k, raw] of Object.entries(request.body ?? {})) {
      if (!allowed.has(k)) return reply.status(400).send({ code: "UNKNOWN_SETTING", message: k });
      const v = String(raw).trim();
      if (k === "kill_switch" ? !["on", "off"].includes(v) : !(Number(v) >= 0)) {
        return reply.status(400).send({ code: "INVALID_VALUE", message: `${k}=${v}` });
      }
      await setGuardSetting(pool, k, v, by);
      await pool.query("INSERT INTO llm_guard_events (kind, detail) VALUES ('setting_changed', $1::jsonb)", [JSON.stringify({ key: k, value: v, by })]);
    }
    return reply.send({ settings: await getGuardSettings(pool) });
  });

  app.get("/api/admin/llm-guard/events", async (request, reply) => {
    if (!requireAdmin(request)) return reply.status(403).send({ code: "FORBIDDEN" });
    const r = await pool.query("SELECT id, created_at, kind, project_id, detail FROM llm_guard_events ORDER BY id DESC LIMIT 200");
    return reply.send({ events: r.rows });
  });
}
