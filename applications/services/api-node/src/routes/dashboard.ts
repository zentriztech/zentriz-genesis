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
import { TtlCache } from "../lib/ttlCache.js";
import { getTenantMonthSpendUsd, resolveTenantMonthlyBudgetUsd } from "../services/tenantCostCap.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

// Cache de KPIs (Onda 5): TTL 15s por chave `kpis:<scope>:<tenantId|global>` (GAP G3 — a chave
// SEMPRE inclui o escopo+tenant, senão vazaria dados entre tenants). Query-on-read (D5): mede-se
// p95 pelo header X-Elapsed-Ms; só materializar se > 300ms.
const kpisCache = new TtlCache<unknown>({ ttlMs: 15_000, maxKeys: 2_000 });

/** Apenas para testes: zera o cache de KPIs entre casos. */
export function _clearKpisCache(): void {
  kpisCache.clear();
}

/** Statuses de projeto (fonte: CHECK projects_status_check, migration 079). */
const STATUS_ON_BENCH = ["draft", "spec_submitted", "pending_conversion", "spec_validation_failed", "needs_spec_input"];
const STATUS_IN_FACTORY = ["queued", "running", "cto_charter", "pm_backlog", "dev_qa", "devops", "pending_cyborg"];
const LEAD_TIME_MIN_SAMPLES = 3;

function sqlList(values: string[]): string {
  // Lista de literais para IN (...) — valores CONSTANTES do código (nunca entrada do usuário).
  return values.map((v) => `'${v}'`).join(", ");
}

const IMPORTANT_SEVERITY_SQL = `
  (d.severity IN ('notice','warning','critical')
   OR d.event_type IN ('error','escalation','product_ready')
   OR d.from_agent = 'cyborg')`;

/**
 * Flags de UI derivadas do servidor (GAP G13 / D-4.3 do plano Ondas 4-5): o portal NUNCA lê
 * `NEXT_PUBLIC_*` para features — lê `features` da API (aqui no `/summary`, que já é o poll
 * de 30 s do dashboard, e no `/kpis`). Lidas em tempo de request (sem rebuild para ligar).
 */
export function uiFeatures(): { dashboardKpis: boolean; specUploadDecompose: boolean } {
  const on = (name: string) => (process.env[name] ?? "off").toLowerCase() === "on";
  return { dashboardKpis: on("DASHBOARD_KPIS"), specUploadDecompose: on("SPEC_UPLOAD_DECOMPOSE") };
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.get<{ Querystring: { tenantId?: string } }>("/api/dashboard/summary", async (request, reply) => {
    const user = getUser(request);
    if (user.svc === "runner") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Sem caso de uso p/ token de serviço." });
    }
    const isAdmin = user.role === "zentriz_admin";
    const tenantId = resolveScopedTenantId(user, request.query);
    const features = uiFeatures();
    // tenant sem tenant no JWT (estado inválido) → lista vazia; admin sem ?tenantId → global
    if (!isAdmin && !tenantId) return reply.send({ projects: [], admin: null, features });

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
                   WHERE pt2.project_id = p.id AND pt2.status IN ('IN_PROGRESS','WAITING_REVIEW')
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

    return reply.send({ projects: rows, admin, scopedTenantId: tenantId ?? null, features });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /api/dashboard/kpis?scope=tenant|admin[&tenantId=] — Onda 5 (épico Spec/Bancada).
  //
  // CONTRATO DE RESPOSTA (o portal codifica contra §4 do plano; manter os NOMES dos campos).
  //   Flag OFF (DASHBOARD_KPIS != 'on'):  { enabled:false, scope, features:{dashboardKpis:false} }
  //   Sem tenant resolvível (scope=tenant): { enabled:true, scope:'tenant', tenant:null, features }
  //
  //   scope=tenant (200):
  //   {
  //     enabled: true, scope: 'tenant', tenantId: string, features: { dashboardKpis: true },
  //     kpis: {
  //       onBench, inFactory, blocked, delivered30d, deliveredPrev30d,      // T1..T4 (+delta)
  //       leadTimeMedianSec: number|null,                                   // T5 (null se < 3 amostras)
  //       failed30d, accepted30d, failureRate30d: number|null,              // T6
  //       tasksDone, tasksTotal,                                            // T7
  //       proposalsRunning, proposalsReady                                  // T8
  //     },
  //     cost: {
  //       monthUsd, budgetUsd: number|null, acceptedMtd,
  //       costPerDeliveryUsd: number|null,                                  // MTD ÷ acceptedMtd
  //       topModels: [{ model: string|null, usd: number }]                  // top 3 MTD
  //     },
  //     messages: [{ projectId, title, summaryHuman, fromAgent, eventType, severity, createdAt }] // 5
  //   }
  //
  //   scope=admin (200; só zentriz_admin):
  //   {
  //     enabled: true, scope: 'admin', features,
  //     kpis: {
  //       tenantsActive, tenantsNew30d,                                     // A1
  //       awaitingPayment, emailUnconfirmed,                                // A2
  //       tenantsSuspended, projectsBlocked,                                // A3
  //       factoryRunning, factoryQueued, proposalsInFlight,                 // A4
  //       monthUsd, topTenants: [{ tenantId, tenantName, usd }],            // A5 (top 5)
  //       approvalsPending, proposalsStuck24h, specRunsFailed24h            // A6
  //     }
  //   }
  //
  // RBAC fail-closed (GAP G1): svc:runner→403; scope=admin exige zentriz_admin (senão 403, não 404:
  // a rota é conhecida); scope=tenant usa resolveScopedTenantId (não-admin IGNORA ?tenantId).
  // Headers: X-Cache: HIT|MISS · X-Elapsed-Ms (gatilho de materialização, D5).
  // ─────────────────────────────────────────────────────────────────────────────
  app.get<{ Querystring: { scope?: string; tenantId?: string } }>("/api/dashboard/kpis", async (request, reply) => {
    const user = getUser(request);
    if (user.svc === "runner") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Sem caso de uso p/ token de serviço." });
    }
    const isAdmin = user.role === "zentriz_admin";
    // scope só pode ser 'tenant' ou 'admin' (allowlist — nunca interpolado em SQL).
    const scope = request.query.scope === "admin" ? "admin" : "tenant";
    const features = uiFeatures();

    if (scope === "admin" && !isAdmin) {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Escopo admin exige zentriz_admin." });
    }
    if (!features.dashboardKpis) {
      return reply.send({ enabled: false, scope, features });
    }

    // Resolução do tenant (fail-closed): não-admin ignora ?tenantId; admin pode escopar por UUID.
    const tenantId = scope === "tenant" ? resolveScopedTenantId(user, request.query) : null;
    if (scope === "tenant" && !tenantId) {
      // admin sem ?tenantId, ou tenant sem tenant no JWT (estado inválido) → sem dados.
      return reply.send({ enabled: true, scope: "tenant", tenant: null, features });
    }

    const cacheKey = `kpis:${scope}:${scope === "admin" ? "global" : tenantId}`;
    const started = process.hrtime.bigint();
    const elapsedMs = () => Number(process.hrtime.bigint() - started) / 1e6;

    const cached = kpisCache.get(cacheKey);
    if (cached !== undefined) {
      reply.header("X-Cache", "HIT");
      reply.header("X-Elapsed-Ms", elapsedMs().toFixed(1));
      return reply.send(cached);
    }

    const payload = scope === "admin"
      ? await buildAdminKpis(features)
      : await buildTenantKpis(tenantId as string, features);

    kpisCache.set(cacheKey, payload); // só o caminho de sucesso é cacheado (nunca erro — lança antes)
    reply.header("X-Cache", "MISS");
    reply.header("X-Elapsed-Ms", elapsedMs().toFixed(1));
    return reply.send(payload);
  });
}

/** KPIs do escopo TENANT — TODA query usa `p.tenant_id = $1` (grep-guard). */
async function buildTenantKpis(tenantId: string, features: Record<string, boolean>) {
  const params = [tenantId];

  // (1) contagens de projeto — uma query com FILTER (T1..T6 + accepted_mtd + amostras de lead time).
  const countsQ = pool.query(
    `SELECT
       count(*) FILTER (WHERE p.status IN (${sqlList(STATUS_ON_BENCH)}))::int AS on_bench,
       count(*) FILTER (WHERE p.status IN (${sqlList(STATUS_IN_FACTORY)}))::int AS in_factory,
       count(*) FILTER (WHERE p.status LIKE 'blocked_%' OR p.status IN ('failed','stopped'))::int AS blocked,
       count(*) FILTER (WHERE p.status IN ('accepted','completed')
                          AND COALESCE(p.finished_at, p.completed_at, p.updated_at) > now() - interval '30 days')::int AS delivered_30d,
       count(*) FILTER (WHERE p.status IN ('accepted','completed')
                          AND COALESCE(p.finished_at, p.completed_at, p.updated_at) <= now() - interval '30 days'
                          AND COALESCE(p.finished_at, p.completed_at, p.updated_at) >  now() - interval '60 days')::int AS delivered_prev_30d,
       count(*) FILTER (WHERE p.status = 'failed' AND p.updated_at > now() - interval '30 days')::int AS failed_30d,
       count(*) FILTER (WHERE p.status IN ('accepted','completed')
                          AND COALESCE(p.finished_at, p.completed_at, p.updated_at) >= date_trunc('month', now()))::int AS accepted_mtd,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (p.finished_at - p.started_at)))
         FILTER (WHERE p.status IN ('accepted','completed') AND p.started_at IS NOT NULL AND p.finished_at IS NOT NULL
                   AND COALESCE(p.finished_at, p.completed_at, p.updated_at) > now() - interval '30 days') AS lead_time_median_sec,
       count(*) FILTER (WHERE p.status IN ('accepted','completed') AND p.started_at IS NOT NULL AND p.finished_at IS NOT NULL
                   AND COALESCE(p.finished_at, p.completed_at, p.updated_at) > now() - interval '30 days')::int AS lead_time_samples
     FROM projects p
     WHERE p.tenant_id = $1 AND p.status <> 'archived'`,
    params,
  );

  // (2) tarefas dos projetos EM FÁBRICA (exclui TSK-DEVOPS-001/TSK-FULL-TEST/TSK-INH-% — regra projects.ts:113-119).
  const tasksQ = pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN pt.status IN ('DONE','QA_PASS') THEN 1 ELSE 0 END), 0)::int AS done,
       count(*)::int AS total
     FROM project_tasks pt
     JOIN projects p ON p.id = pt.project_id
     WHERE p.tenant_id = $1
       AND p.status IN (${sqlList(STATUS_IN_FACTORY)})
       AND pt.task_id NOT IN ('TSK-DEVOPS-001','TSK-FULL-TEST') AND pt.task_id NOT LIKE 'TSK-INH-%'`,
    params,
  );

  // (3) propostas de produto (T8): em análise / prontas p/ revisão.
  const proposalsQ = pool.query(
    `SELECT
       count(*) FILTER (WHERE status = 'running')::int AS running,
       count(*) FILTER (WHERE status = 'done' AND consumed_at IS NULL)::int AS ready
     FROM product_proposals WHERE tenant_id = $1`,
    params,
  );

  // (4) top 3 modelos por custo MTD (FinOps showback) — preço via fonte única priceCaseSql.
  const modelsQ = pool.query(
    `SELECT m.model AS model, SUM(${priceCaseSql("m.")})::numeric(12,4) AS usd
       FROM project_agent_metrics m
       JOIN projects p ON p.id = m.project_id
      WHERE p.tenant_id = $1 AND m.created_at >= date_trunc('month', now())
      GROUP BY m.model ORDER BY 2 DESC LIMIT 3`,
    params,
  );

  // (5) mensagens importantes (severity 075) — com título do projeto.
  const messagesQ = pool.query(
    `SELECT d.summary_human, d.from_agent, d.event_type, d.severity, d.created_at,
            p.id AS project_id, p.title
       FROM project_dialogue d
       JOIN projects p ON p.id = d.project_id
      WHERE p.tenant_id = $1 AND d.severity IN ('notice','warning','critical')
      ORDER BY d.created_at DESC LIMIT 5`,
    params,
  );

  const [counts, tasks, proposals, models, messages, monthUsd, budgetUsd] = await Promise.all([
    countsQ, tasksQ, proposalsQ, modelsQ, messagesQ,
    getTenantMonthSpendUsd(pool, tenantId),
    resolveTenantMonthlyBudgetUsd(pool, tenantId),
  ]);

  const c = counts.rows[0] ?? {};
  const t = tasks.rows[0] ?? {};
  const pr = proposals.rows[0] ?? {};
  const acceptedMtd = Number(c.accepted_mtd ?? 0);
  const failed30d = Number(c.failed_30d ?? 0);
  const accepted30d = Number(c.delivered_30d ?? 0); // aceitos 30d = entregues 30d (mesmo predicado)
  const failureDenom = accepted30d + failed30d;
  const leadSamples = Number(c.lead_time_samples ?? 0);

  return {
    enabled: true,
    scope: "tenant" as const,
    tenantId,
    features,
    kpis: {
      onBench: Number(c.on_bench ?? 0),
      inFactory: Number(c.in_factory ?? 0),
      blocked: Number(c.blocked ?? 0),
      delivered30d: accepted30d,
      deliveredPrev30d: Number(c.delivered_prev_30d ?? 0),
      leadTimeMedianSec: leadSamples >= LEAD_TIME_MIN_SAMPLES && c.lead_time_median_sec != null
        ? Math.round(Number(c.lead_time_median_sec))
        : null,
      failed30d,
      accepted30d,
      failureRate30d: failureDenom > 0 ? failed30d / failureDenom : null,
      tasksDone: Number(t.done ?? 0),
      tasksTotal: Number(t.total ?? 0),
      proposalsRunning: Number(pr.running ?? 0),
      proposalsReady: Number(pr.ready ?? 0),
    },
    cost: {
      monthUsd: Number(monthUsd) || 0,
      budgetUsd: budgetUsd == null ? null : Number(budgetUsd),
      acceptedMtd,
      costPerDeliveryUsd: acceptedMtd > 0 ? (Number(monthUsd) || 0) / acceptedMtd : null,
      topModels: models.rows.map((r) => ({ model: (r.model as string) ?? null, usd: Number(r.usd) || 0 })),
    },
    messages: messages.rows.map((r) => ({
      projectId: r.project_id,
      title: r.title,
      summaryHuman: r.summary_human,
      fromAgent: r.from_agent,
      eventType: r.event_type,
      severity: r.severity,
      createdAt: r.created_at,
    })),
  };
}

/** KPIs do escopo ADMIN (só leitura; não toca no financeiro — Onda 6 congelada). */
async function buildAdminKpis(features: Record<string, boolean>) {
  // A1+A2: tenants (reuso da classificação de dashboard.ts + email não confirmado).
  const tenantsQ = pool.query(
    `SELECT
       count(*) FILTER (WHERE status = 'active')::int AS active,
       count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS new_30d,
       count(*) FILTER (WHERE status = 'inactive' AND EXISTS (
         SELECT 1 FROM charges c WHERE c.tenant_id = tenants.id
           AND c.kind = 'subscription' AND c.status IN ('open','overdue')
       ))::int AS awaiting_payment,
       count(*) FILTER (WHERE email_confirmed = false)::int AS email_unconfirmed,
       count(*) FILTER (WHERE status = 'suspended')::int AS suspended
     FROM tenants`,
  );

  // A3+A4: projetos de TODOS os tenants (bloqueados + fábrica global).
  const projectsQ = pool.query(
    `SELECT
       count(*) FILTER (WHERE status LIKE 'blocked_%')::int AS blocked,
       count(*) FILTER (WHERE status = 'running')::int AS running,
       count(*) FILTER (WHERE status = 'queued')::int AS queued
     FROM projects WHERE status <> 'archived'`,
  );

  // A4+A6: propostas em voo (global) + interrompidas/erro nas últimas 24h.
  const proposalsQ = pool.query(
    `SELECT
       count(*) FILTER (WHERE status IN ('pending','running'))::int AS in_flight,
       count(*) FILTER (WHERE status IN ('interrupted','error') AND updated_at > now() - interval '24 hours')::int AS stuck_24h
     FROM product_proposals`,
  );

  // A5: custo MTD da plataforma + top 5 tenants por custo (showback, sem cobrar).
  const platformCostQ = pool.query(
    `SELECT COALESCE(SUM(${priceCaseSql("m.")}), 0)::numeric(12,4) AS usd
       FROM project_agent_metrics m
      WHERE m.created_at >= date_trunc('month', now())`,
  );
  const topTenantsQ = pool.query(
    `SELECT p.tenant_id AS tenant_id, t.name AS tenant_name, SUM(${priceCaseSql("m.")})::numeric(12,4) AS usd
       FROM project_agent_metrics m
       JOIN projects p ON p.id = m.project_id
       LEFT JOIN tenants t ON t.id = p.tenant_id
      WHERE m.created_at >= date_trunc('month', now())
      GROUP BY p.tenant_id, t.name ORDER BY 3 DESC LIMIT 5`,
  );

  // A6: aprovações pendentes do Deadpool + runs de validação com falha 24h.
  const approvalsQ = pool.query(
    `SELECT count(*) FILTER (WHERE decision = 'pending')::int AS pending FROM deadpool_promotion_approvals`,
  );
  const specRunsQ = pool.query(
    `SELECT count(*) FILTER (WHERE status IN ('error','interrupted') AND created_at > now() - interval '24 hours')::int AS failed_24h
       FROM spec_validation_runs`,
  );

  const [tenants, projects, proposals, platformCost, topTenants, approvals, specRuns] = await Promise.all([
    tenantsQ, projectsQ, proposalsQ, platformCostQ, topTenantsQ, approvalsQ, specRunsQ,
  ]);

  const tn = tenants.rows[0] ?? {};
  const pj = projects.rows[0] ?? {};
  const pp = proposals.rows[0] ?? {};

  return {
    enabled: true,
    scope: "admin" as const,
    features,
    kpis: {
      tenantsActive: Number(tn.active ?? 0),
      tenantsNew30d: Number(tn.new_30d ?? 0),
      awaitingPayment: Number(tn.awaiting_payment ?? 0),
      emailUnconfirmed: Number(tn.email_unconfirmed ?? 0),
      tenantsSuspended: Number(tn.suspended ?? 0),
      projectsBlocked: Number(pj.blocked ?? 0),
      factoryRunning: Number(pj.running ?? 0),
      factoryQueued: Number(pj.queued ?? 0),
      proposalsInFlight: Number(pp.in_flight ?? 0),
      monthUsd: Number(platformCost.rows[0]?.usd) || 0,
      topTenants: topTenants.rows.map((r) => ({
        tenantId: r.tenant_id,
        tenantName: (r.tenant_name as string) ?? null,
        usd: Number(r.usd) || 0,
      })),
      approvalsPending: Number(approvals.rows[0]?.pending ?? 0),
      proposalsStuck24h: Number(pp.stuck_24h ?? 0),
      specRunsFailed24h: Number(specRuns.rows[0]?.failed_24h ?? 0),
    },
  };
}
