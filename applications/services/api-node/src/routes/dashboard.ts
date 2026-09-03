/**
 * dashboard.ts — RFC-0004 Onda 5 (F5): GET /api/dashboard/summary.
 *
 * READ-MODEL QUERY-ON-READ (decisão D5): agrega direto das tabelas operacionais numa
 * requisição — sempre VERDADEIRO (≥12 caminhos escrevem estado por SQL direto e
 * mentiriam para hooks; triggers são proibidos pelo runner de migrations). Materializar
 * só se medição provar lentidão.
 *
 * Regras da auditoria adversarial incorporadas:
 *  • custo por projeto = SUM(CASE de preços) sobre project_agent_metrics em UMA query —
 *    nunca N× GET /:id/cost (que recomputa o mês do tenant 2× por chamada) e nunca
 *    pipeline_runs.estimated_cost_usd;
 *  • VIVACIDADE gateada: "agente/tarefa atual" e cronômetro só com status='running' E
 *    run aberta — runner morto não deixa "QA revisando" congelado;
 *  • mensagens importantes: severity da 075 OU heurística por event_type (fallback p/
 *    INSERTs diretos legados que nascem 'info');
 *  • escopo: padrão ?tenantId do master (resolveScopedTenantId — bug U#3/C5 já queimou);
 *    tenant vê só o seu; svc:"runner" → 403; seção admin só zentriz_admin, e a
 *    classificação de tenants separa "aguardando pagamento" (inactive COM charge) de
 *    "inativos (ação manual)" (inactive SEM charge) e "suspensos".
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { resolveScopedTenantId } from "../lib/tenantScope.js";
import { priceCaseSql } from "../lib/modelPricing.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

const IMPORTANT_SEVERITY_SQL = `
  (d.severity IN ('notice','warning','critical')
   OR d.event_type IN ('error','escalation','product_ready')
   OR d.from_agent = 'cyborg')`;

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.get<{ Querystring: { tenantId?: string } }>("/api/dashboard/summary", async (request, reply) => {
    const user = getUser(request);
    if (user.svc === "runner") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Sem caso de uso p/ token de serviço." });
    }
    const isAdmin = user.role === "zentriz_admin";
    const tenantId = resolveScopedTenantId(user, request.query);
    // tenant sem tenant no JWT (estado inválido) → lista vazia; admin sem ?tenantId → global
    if (!isAdmin && !tenantId) return reply.send({ projects: [], admin: null });

    const params: unknown[] = [];
    let tenantFilter = "";
    if (tenantId) {
      params.push(tenantId);
      tenantFilter = `AND p.tenant_id = $${params.length}`;
    }

    // UMA query agregada (LATERAL por sub-recurso; cap 100 projetos, running-first).
    const rows = (await pool.query(
      `SELECT
         p.id, p.title, p.status, p.product_id, p.tenant_id, p.started_at, p.updated_at,
         pr.name AS product_name,
         t.total AS tasks_total, t.done AS tasks_done, t.current_task,
         cost.usd AS cost_usd,
         run.started_at AS run_started_at,
         CASE WHEN p.status = 'running' AND run.started_at IS NOT NULL
              THEN EXTRACT(EPOCH FROM (now() - run.started_at))::bigint END AS running_seconds,
         CASE WHEN p.status = 'running' AND run.started_at IS NOT NULL
              THEN agent.current_agent END AS current_agent,
         msgs.items AS important_messages
       FROM projects p
       LEFT JOIN products pr ON pr.id = p.product_id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS total,
                count(*) FILTER (WHERE pt.status IN ('DONE','QA_PASS'))::int AS done,
                (SELECT pt2.task_id FROM project_tasks pt2
                   WHERE pt2.project_id = p.id AND pt2.status IN ('IN_PROGRESS','IN_REVIEW')
                   ORDER BY pt2.updated_at DESC LIMIT 1) AS current_task
           FROM project_tasks pt WHERE pt.project_id = p.id
       ) t ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(${priceCaseSql("m.")}), 0)::numeric(12,4) AS usd
           FROM project_agent_metrics m WHERE m.project_id = p.id
       ) cost ON true
       LEFT JOIN LATERAL (
         SELECT r.started_at FROM pipeline_runs r
          WHERE r.project_id = p.id AND r.finished_at IS NULL
          ORDER BY r.started_at DESC LIMIT 1
       ) run ON true
       LEFT JOIN LATERAL (
         SELECT d.from_agent AS current_agent FROM project_dialogue d
          WHERE d.project_id = p.id AND d.event_type = 'agent_working'
          ORDER BY d.created_at DESC LIMIT 1
       ) agent ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(json_agg(x.* ORDER BY x.created_at DESC), '[]'::json) AS items
           FROM (
             SELECT d.summary_human, d.from_agent, d.event_type,
                    CASE WHEN d.severity <> 'info' THEN d.severity
                         WHEN d.event_type IN ('error','escalation') THEN 'critical'
                         WHEN d.event_type = 'product_ready' THEN 'notice'
                         WHEN d.from_agent = 'cyborg' THEN 'warning'
                         ELSE 'info' END AS severity,
                    d.created_at
               FROM project_dialogue d
              WHERE d.project_id = p.id AND ${IMPORTANT_SEVERITY_SQL}
              ORDER BY d.created_at DESC LIMIT 3
           ) x
       ) msgs ON true
       WHERE p.status <> 'archived' ${tenantFilter}
       ORDER BY (p.status = 'running') DESC, p.updated_at DESC
       LIMIT 100`,
      params,
    )).rows;

    // Seção ADMIN (só master): classificação correta de tenants (auditoria F5).
    let admin: Record<string, unknown> | null = null;
    if (isAdmin) {
      const t = (await pool.query(
        `SELECT
           count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS new_30d,
           count(*) FILTER (WHERE status = 'inactive' AND EXISTS (
             SELECT 1 FROM charges c WHERE c.tenant_id = tenants.id
               AND c.kind = 'subscription' AND c.status IN ('open','overdue')
           ))::int AS awaiting_payment,
           count(*) FILTER (WHERE status = 'inactive' AND NOT EXISTS (
             SELECT 1 FROM charges c WHERE c.tenant_id = tenants.id
               AND c.kind = 'subscription' AND c.status IN ('open','overdue')
           ))::int AS inactive_manual,
           count(*) FILTER (WHERE status = 'suspended')::int AS suspended,
           count(*) FILTER (WHERE status = 'active')::int AS active
         FROM tenants`,
      )).rows[0];
      admin = t as Record<string, unknown>;
    }

    return reply.send({ projects: rows, admin, scopedTenantId: tenantId ?? null });
  });
}
