/**
 * deadpool.ts — GATEWAY server-side para a API do Deadpool.
 *
 * Expõe /api/deadpool/* no backend Genesis, fazendo proxy autenticado para a API HTTP
 * do Deadpool. Mantém as credenciais do Deadpool no servidor (services/deadpoolClient.ts)
 * e aplica o RBAC do Genesis. O portal web só chama o Genesis, nunca o Deadpool direto.
 *
 * Auth/RBAC: app.addHook("preHandler", authMiddleware). As leituras do PAINEL (status, projects,
 * incidents, incidents/:id, knowledge) exigem admin (tenant_admin OU zentriz_admin) — mesmo nível
 * do painel #61 original. Só a decisão COMERCIAL de conceder/revogar licença (PUT entitlement) é
 * restrita a zentriz_admin. As rotas por PROJETO (entitlement GET, monitoring) são escopadas por
 * ownership de tenant → tenant_admin do próprio tenant.
 *
 * Rotas de leitura do painel (GET, JSON, tenant_admin | zentriz_admin):
 *   GET /api/deadpool/status          → Deadpool GET /health + GET /ready
 *   GET /api/deadpool/projects        → Deadpool GET /projects
 *   GET /api/deadpool/incidents       → Deadpool GET /incidents?view=summary
 *   GET /api/deadpool/incidents/:id   → Deadpool GET /incidents/{id}
 *   GET /api/deadpool/knowledge       → Deadpool GET /knowledge
 *
 * Degradação graciosa: se DEADPOOL_BASE_URL não estiver setada OU a chamada
 * falhar/estourar timeout, responde HTTP 200 com payload vazio (available:false).
 * Nunca 500 por Deadpool ausente. O Deadpool responde em snake_case — repassamos como veio.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { deadpoolGet, isDeadpoolConfigured } from "../services/deadpoolClient.js";
import { pool } from "../db/client.js";
import { hasEntitlement, setEntitlement } from "../services/entitlements.js";
import { registerProjectWithDeadpool, deriveSystemService } from "../services/githubPush.js";

/** UUID v1–v5 (formato canônico do Postgres) — valida params de tenantId antes de bater no banco. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

/** Exige tenant_admin ou zentriz_admin (mesmo pattern de routes/llm.ts). Retorna false se já respondeu 403. */
function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const user = getUser(request);
  if (user.role !== "tenant_admin" && user.role !== "zentriz_admin") {
    reply.status(403).send({ code: "FORBIDDEN" });
    return false;
  }
  return true;
}

/** Conceder/revogar licença é decisão comercial da Zentriz → só zentriz_admin. */
function requireZentrizAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const user = getUser(request);
  if (user.role !== "zentriz_admin") {
    reply.status(403).send({ code: "FORBIDDEN" });
    return false;
  }
  return true;
}

/** Motivo curto e seguro (sem vazar credenciais) para o payload degradado + log warn. */
function degradeReason(err: unknown): string {
  if (!isDeadpoolConfigured()) return "not_configured";
  if (err instanceof Error && err.name === "AbortError") return "timeout";
  return "unreachable";
}

export async function deadpoolRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  // ── GET /api/deadpool/status ─────────────────────────────────────────────────
  app.get("/api/deadpool/status", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    if (!isDeadpoolConfigured()) {
      return reply.send({ available: false, reason: "not_configured" });
    }
    try {
      const [health, ready] = await Promise.all([
        deadpoolGet<{ status?: string; version?: string }>("/health"),
        deadpoolGet<{ status?: string }>("/ready"),
      ]);
      // O Deadpool responde /health e /ready como OBJETOS ricos; o painel espera um resumo
      // (health: string, ready: boolean). Normalizamos AQUI — se repassássemos os objetos crus,
      // a UI renderizaria "[object Object]". healthDetail carrega o objeto bruto p/ quem quiser.
      const healthLabel =
        [health?.status, health?.version ? `v${health.version}` : undefined].filter(Boolean).join(" · ") || "ok";
      return reply.send({
        available: true,
        health: healthLabel,
        ready: ready?.status === "ready",
        healthDetail: health,
        readyDetail: ready,
      });
    } catch (err) {
      const reason = degradeReason(err);
      app.log.warn({ route: "deadpool/status", reason }, "Deadpool status indisponível (degradado)");
      return reply.send({ available: false, reason });
    }
  });

  // ── GET /api/deadpool/projects ───────────────────────────────────────────────
  app.get("/api/deadpool/projects", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const data = await deadpoolGet<{ projects?: unknown[] }>("/projects");
      return reply.send({ available: true, projects: data?.projects ?? [] });
    } catch (err) {
      app.log.warn({ route: "deadpool/projects", reason: degradeReason(err) }, "Deadpool projects indisponível (degradado)");
      return reply.send({ available: false, projects: [] });
    }
  });

  // ── GET /api/deadpool/incidents ──────────────────────────────────────────────
  app.get("/api/deadpool/incidents", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const data = await deadpoolGet<{ incidents?: unknown[] }>("/incidents?view=summary");
      return reply.send({ available: true, incidents: data?.incidents ?? [] });
    } catch (err) {
      app.log.warn({ route: "deadpool/incidents", reason: degradeReason(err) }, "Deadpool incidents indisponível (degradado)");
      return reply.send({ available: false, incidents: [] });
    }
  });

  // ── GET /api/deadpool/incidents/:id ──────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/deadpool/incidents/:id", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const id = encodeURIComponent(request.params.id);
    try {
      const data = await deadpoolGet(`/incidents/${id}`);
      return reply.send(data);
    } catch (err) {
      app.log.warn({ route: "deadpool/incidents/:id", reason: degradeReason(err) }, "Deadpool incident indisponível (degradado)");
      return reply.send({ available: false, incident: null });
    }
  });

  // ── GET /api/deadpool/knowledge ──────────────────────────────────────────────
  app.get("/api/deadpool/knowledge", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const data = await deadpoolGet<{ entries?: unknown[] }>("/knowledge");
      return reply.send({ available: true, entries: data?.entries ?? [] });
    } catch (err) {
      app.log.warn({ route: "deadpool/knowledge", reason: degradeReason(err) }, "Deadpool knowledge indisponível (degradado)");
      return reply.send({ available: false, entries: [] });
    }
  });

  // ── GET /api/deadpool/entitlement ────────────────────────────────────────────
  // Licença Deadpool do tenant do CHAMADOR. É o que a UI consulta para decidir se o
  // botão [Ativar Monitoramento Deadpool] aparece habilitado. Qualquer admin do tenant lê.
  app.get("/api/deadpool/entitlement", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const user = getUser(request);
    const entitled = await hasEntitlement(user.tenantId, "deadpool");
    return reply.send({ product: "deadpool", entitled });
  });

  // ── PUT /api/deadpool/entitlement/:tenantId ──────────────────────────────────
  // Conceder/revogar a licença Deadpool de um tenant. Decisão comercial → só zentriz_admin.
  app.put<{ Params: { tenantId: string }; Body: { enabled?: boolean } }>(
    "/api/deadpool/entitlement/:tenantId",
    async (request, reply) => {
      if (!requireZentrizAdmin(request, reply)) return;
      const user = getUser(request);
      const { tenantId } = request.params;
      // Valida o tenantId (UUID) ANTES de tocar o banco: um valor não-UUID estouraria a query
      // (Postgres uuid) como 500; devolvemos 400 explícito.
      if (!UUID_RE.test(tenantId)) {
        return reply.status(400).send({ code: "INVALID_TENANT_ID" });
      }
      // Exige `enabled` booleano EXPLÍCITO: um PUT sem corpo não pode revogar a licença por
      // omissão (enabled undefined → antes virava false silenciosamente).
      const enabled = request.body?.enabled;
      if (typeof enabled !== "boolean") {
        return reply.status(400).send({ code: "ENABLED_REQUIRED" });
      }
      try {
        await setEntitlement(tenantId, "deadpool", enabled, user.id);
        app.log.info({ tenantId, enabled, by: user.id }, "Deadpool entitlement atualizado");
        return reply.send({ ok: true, tenantId, product: "deadpool", enabled });
      } catch (err) {
        app.log.error({ err, tenantId }, "Falha ao atualizar entitlement Deadpool");
        return reply.status(500).send({ code: "ENTITLEMENT_WRITE_FAILED" });
      }
    },
  );

  // ── GET /api/deadpool/projects/:id/monitoring ────────────────────────────────
  // Estado do monitoramento de UM projeto (para renderizar o botão: ativo/inativo + último erro).
  app.get<{ Params: { id: string } }>(
    "/api/deadpool/projects/:id/monitoring",
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const user = getUser(request);
      const { id } = request.params;
      // Ownership: tenant_admin só enxerga projeto do próprio tenant; zentriz_admin vê todos.
      const projRes = await pool.query(
        "SELECT tenant_id FROM projects WHERE id = $1",
        [id],
      );
      const proj = projRes.rows[0];
      if (!proj) return reply.status(404).send({ code: "PROJECT_NOT_FOUND" });
      if (user.role !== "zentriz_admin" && proj.tenant_id !== user.tenantId) {
        return reply.status(403).send({ code: "FORBIDDEN" });
      }
      const entitled = await hasEntitlement(proj.tenant_id, "deadpool");
      const monRes = await pool.query(
        `SELECT active, system_id, service_id, activated_at, deactivated_at,
                last_registered_at, last_error
           FROM project_deadpool_monitoring WHERE project_id = $1`,
        [id],
      );
      const m = monRes.rows[0] ?? null;
      return reply.send({
        entitled,
        active: m?.active === true,
        systemId: m?.system_id ?? null,
        serviceId: m?.service_id ?? null,
        activatedAt: m?.activated_at ?? null,
        deactivatedAt: m?.deactivated_at ?? null,
        lastRegisteredAt: m?.last_registered_at ?? null,
        lastError: m?.last_error ?? null,
      });
    },
  );

  // ── POST /api/deadpool/projects/:id/activate ─────────────────────────────────
  // Botão [Ativar Monitoramento Deadpool] (feature #1). Dá ao Deadpool o vínculo runtime
  // (appUrl/healthUrl/logGroup) + monitoring:true → ele passa a monitorar logs ativamente
  // (CloudWatch) e a receber chamados reativos. Pré-condições:
  //   1. tenant tem licença Deadpool (tenant_entitlements)
  //   2. projeto aceito (status='accepted') — só código aceito é sustentável
  //   3. repo GitHub existe (project_github_repos) — Deadpool precisa clonar p/ corrigir
  //   4. tenant tem GitHub App instalado (installationId) — acesso ao repo p/ commit/deploy
  app.post<{ Params: { id: string } }>(
    "/api/deadpool/projects/:id/activate",
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const user = getUser(request);
      const { id } = request.params;

      // Carrega projeto + produto + repo + installation numa query (espelha githubPush).
      const res = await pool.query(
        `SELECT p.id, p.title, p.tenant_id, p.status,
                pr.name AS product_name, pr.system_id AS product_system_id,
                gr.repo_url,
                gi.installation_id
           FROM projects p
           LEFT JOIN products pr ON pr.id = p.product_id
           LEFT JOIN project_github_repos gr ON gr.project_id = p.id
           LEFT JOIN tenant_github_installations gi ON gi.tenant_id = p.tenant_id
          WHERE p.id = $1`,
        [id],
      );
      const row = res.rows[0];
      if (!row) return reply.status(404).send({ code: "PROJECT_NOT_FOUND" });

      // Ownership
      if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId) {
        return reply.status(403).send({ code: "FORBIDDEN" });
      }
      // Pré-condição 1: licença
      if (!(await hasEntitlement(row.tenant_id, "deadpool"))) {
        return reply.status(403).send({ code: "NO_DEADPOOL_ENTITLEMENT" });
      }
      // Pré-condição 2: aceito
      if (row.status !== "accepted") {
        return reply.status(409).send({ code: "PROJECT_NOT_ACCEPTED", status: row.status });
      }
      // Pré-condição 3: repo existe
      if (!row.repo_url) {
        return reply.status(409).send({ code: "NO_REPOSITORY" });
      }
      // Pré-condição 4: GitHub App instalado
      if (!row.installation_id) {
        return reply.status(409).send({ code: "NO_GITHUB_INSTALLATION" });
      }

      // Dados de runtime do deployment ativo (se houver): app_url/health_url/log_group.
      const depRes = await pool.query(
        `SELECT app_url, health_url, log_group, class
           FROM backend_deployments
          WHERE project_id = $1
            AND status IN ('running', 'running_degraded')
          ORDER BY created_at DESC
          LIMIT 1`,
        [id],
      );
      const dep = depRes.rows[0] ?? null;
      const awsRegion = (process.env.AWS_REGION ?? process.env.DEADPOOL_AWS_REGION ?? "").trim() || null;

      const { systemId, serviceId } = deriveSystemService({
        productSystemId: row.product_system_id as string | null,
        productName: row.product_name as string | null,
        title: row.title as string | null,
        projectId: id,
      });

      // Registra o vínculo runtime + liga o monitoramento no Deadpool.
      const result = await registerProjectWithDeadpool({
        systemId,
        serviceId,
        repoUrl: row.repo_url as string,
        installationId: row.installation_id as number,
        appUrl: dep?.app_url ?? null,
        healthUrl: dep?.health_url ?? null,
        environment: dep ? (dep.class === "demo" ? "demo" : "production") : null,
        awsRegion,
        logGroup: dep?.log_group ?? null,
        monitoring: true,
      });

      if (result.skipped) {
        // Integração desligada (DEADPOOL_BASE_URL ausente) — não persiste estado ativo.
        return reply.status(503).send({ code: "DEADPOOL_NOT_CONFIGURED" });
      }
      if (!result.ok) {
        // Persiste o erro para o painel, mas mantém active=false.
        await pool.query(
          `INSERT INTO project_deadpool_monitoring
             (project_id, active, system_id, service_id, last_error, updated_at)
           VALUES ($1, false, $2, $3, $4, now())
           ON CONFLICT (project_id) DO UPDATE
             SET system_id = EXCLUDED.system_id,
                 service_id = EXCLUDED.service_id,
                 last_error = EXCLUDED.last_error,
                 updated_at = now()`,
          [id, systemId, serviceId, result.error ?? `deadpool status ${result.status ?? "?"}`],
        );
        return reply.status(502).send({ code: "DEADPOOL_REGISTER_FAILED", status: result.status });
      }

      // O Deadpool JÁ está monitorando (registro externo OK). Se a persistência do estado no Genesis
      // falhar aqui, o painel mostraria "inativo" mentindo sobre a realidade — então tratamos a falha:
      // registramos o erro (divergência visível) e devolvemos código honesto. A reativação é
      // idempotente no Deadpool, então o operador pode simplesmente tentar de novo.
      try {
        await pool.query(
          `INSERT INTO project_deadpool_monitoring
             (project_id, active, system_id, service_id, activated_by, activated_at,
              last_registered_at, last_error, updated_at)
           VALUES ($1, true, $2, $3, $4, now(), now(), NULL, now())
           ON CONFLICT (project_id) DO UPDATE
             SET active = true,
                 system_id = EXCLUDED.system_id,
                 service_id = EXCLUDED.service_id,
                 activated_by = EXCLUDED.activated_by,
                 activated_at = now(),
                 last_registered_at = now(),
                 last_error = NULL,
                 updated_at = now()`,
          [id, systemId, serviceId, user.id],
        );
        await pool.query(
          `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human)
           VALUES ($1, 'system', 'deadpool', 'step', $2)`,
          [id, `🛡️ Monitoramento Deadpool ATIVADO para ${systemId}/${serviceId ?? "*"} — monitoramento ativo de logs${dep?.log_group ? ` (${dep.log_group})` : ""} + intake reativo de incidentes.`],
        );
      } catch (err) {
        app.log.error({ err, projectId: id }, "Deadpool registrado mas falha ao persistir estado ativo no Genesis (divergência)");
        // Best-effort: torna a divergência VISÍVEL no painel (pode falhar de novo se o banco caiu).
        try {
          await pool.query(
            `INSERT INTO project_deadpool_monitoring
               (project_id, active, system_id, service_id, last_error, updated_at)
             VALUES ($1, false, $2, $3, $4, now())
             ON CONFLICT (project_id) DO UPDATE
               SET last_error = EXCLUDED.last_error, updated_at = now()`,
            [id, systemId, serviceId, "monitoring active in Deadpool but Genesis state persist failed — retry activation"],
          );
        } catch (persistErr) {
          app.log.error({ err: persistErr, projectId: id }, "Falha também ao registrar a divergência de estado");
        }
        return reply.status(500).send({ code: "MONITORING_STATE_PERSIST_FAILED", deadpoolMonitoring: true });
      }
      app.log.info({ projectId: id, systemId, serviceId, by: user.id }, "Monitoramento Deadpool ativado");
      return reply.send({ ok: true, active: true, systemId, serviceId });
    },
  );

  // ── POST /api/deadpool/projects/:id/deactivate ───────────────────────────────
  // Desliga o monitoramento: registra monitoring:false no Deadpool e marca active=false.
  app.post<{ Params: { id: string } }>(
    "/api/deadpool/projects/:id/deactivate",
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const user = getUser(request);
      const { id } = request.params;

      const res = await pool.query(
        `SELECT p.tenant_id, p.title,
                pr.name AS product_name, pr.system_id AS product_system_id,
                gr.repo_url, gi.installation_id
           FROM projects p
           LEFT JOIN products pr ON pr.id = p.product_id
           LEFT JOIN project_github_repos gr ON gr.project_id = p.id
           LEFT JOIN tenant_github_installations gi ON gi.tenant_id = p.tenant_id
          WHERE p.id = $1`,
        [id],
      );
      const row = res.rows[0];
      if (!row) return reply.status(404).send({ code: "PROJECT_NOT_FOUND" });
      if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId) {
        return reply.status(403).send({ code: "FORBIDDEN" });
      }

      const { systemId, serviceId } = deriveSystemService({
        productSystemId: row.product_system_id as string | null,
        productName: row.product_name as string | null,
        title: row.title as string | null,
        projectId: id,
      });

      // Best-effort: se o repo/installation existir, avisa o Deadpool para parar de monitorar.
      // Mesmo que a chamada falhe, marcamos active=false localmente (fonte de verdade do painel).
      if (row.repo_url && row.installation_id) {
        await registerProjectWithDeadpool({
          systemId,
          serviceId,
          repoUrl: row.repo_url as string,
          installationId: row.installation_id as number,
          monitoring: false,
        });
      }

      const upd = await pool.query(
        `UPDATE project_deadpool_monitoring
            SET active = false, deactivated_at = now(), updated_at = now()
          WHERE project_id = $1 AND active = true`,
        [id],
      );
      // Só registra o diálogo de "DESATIVADO" se REALMENTE havia monitoramento ativo — sem isso,
      // desativar um projeto nunca monitorado postaria uma mensagem enganosa no histórico.
      const changed = (upd.rowCount ?? 0) > 0;
      if (changed) {
        await pool.query(
          `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human)
           VALUES ($1, 'system', 'deadpool', 'step', $2)`,
          [id, `🛡️ Monitoramento Deadpool DESATIVADO para ${systemId}/${serviceId ?? "*"}.`],
        );
        app.log.info({ projectId: id, by: user.id }, "Monitoramento Deadpool desativado");
      }
      return reply.send({ ok: true, active: false, changed });
    },
  );
}
