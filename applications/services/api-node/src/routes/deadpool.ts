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
import { deadpoolGet, deadpoolPost, isDeadpoolConfigured } from "../services/deadpoolClient.js";
import { pool } from "../db/client.js";
import { hasEntitlement, setEntitlement } from "../services/entitlements.js";
import { registerProjectWithDeadpool, deriveSystemService } from "../services/githubPush.js";
import { getAwsMonitoringCredentials } from "../services/cloudConnector.js";

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

// ── Configuração multi-cloud de monitoramento (M1/M2) ────────────────────────────
// Nuvens suportadas para monitoramento ativo de logs. Default = CloudWatch (retrocompat #1).
const MONITOR_PROVIDERS = ["cloudwatch", "azure", "gcp"] as const;
type MonitorProvider = (typeof MONITOR_PROVIDERS)[number];

/** Aliases aceitos no corpo do activate → chave canônica. Espelha normalize_provider do Deadpool. */
const PROVIDER_ALIASES: Record<string, MonitorProvider> = {
  "": "cloudwatch", aws: "cloudwatch", cloudwatch: "cloudwatch", "cloudwatch-logs": "cloudwatch",
  azure: "azure", "azure-monitor": "azure", "azure-log-analytics": "azure", "log-analytics": "azure",
  gcp: "gcp", "gcp-monitoring": "gcp", "gcp-cloud-logging": "gcp", google: "gcp", stackdriver: "gcp",
};

interface MonitoringActivateBody {
  monitorProvider?: string | null;
  azureWorkspaceId?: string | null;
  azureTable?: string | null;
  azureMessageColumn?: string | null;
  gcpProjectId?: string | null;
  gcpLogFilter?: string | null;
}

/** Ponteiros normalizados a persistir/propagar; provider sempre canônico. */
interface MonitoringConfig {
  provider: MonitorProvider;
  azureWorkspaceId: string | null;
  azureTable: string | null;
  azureMessageColumn: string | null;
  gcpProjectId: string | null;
  gcpLogFilter: string | null;
}

function str(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length ? s : null;
}

/**
 * Valida e normaliza o corpo do activate para uma config multi-cloud.
 * Sem corpo (ou provider ausente/cloudwatch) → CloudWatch, ponteiros nulos (comportamento #1).
 * Azure exige `azureTable`; GCP exige `gcpLogFilter` — sem eles o Deadpool não teria escopo para
 * pollar (list_monitorable_projects). Provider desconhecido é rejeitado (nunca cai mudo em CloudWatch).
 * Retorna `{ code }` em erro de validação (o handler responde 400).
 */
function parseMonitoringConfig(
  body: MonitoringActivateBody | undefined,
): MonitoringConfig | { code: string } {
  const raw = (str(body?.monitorProvider) ?? "").toLowerCase();
  const provider = PROVIDER_ALIASES[raw];
  if (provider === undefined) return { code: "UNKNOWN_MONITOR_PROVIDER" };
  const cfg: MonitoringConfig = {
    provider,
    // Ponteiros são ESCOPADOS ao provider: só sobrevive o da nuvem escolhida. Isso impede que um
    // chamador direto contrabandeie azureTable/gcpLogFilter num registro CloudWatch (violando a
    // byte-identidade do #1) e evita semear ponteiros órfãos de outra nuvem no registry do Deadpool.
    azureWorkspaceId: provider === "azure" ? str(body?.azureWorkspaceId) : null,
    azureTable: provider === "azure" ? str(body?.azureTable) : null,
    azureMessageColumn: provider === "azure" ? str(body?.azureMessageColumn) : null,
    gcpProjectId: provider === "gcp" ? str(body?.gcpProjectId) : null,
    gcpLogFilter: provider === "gcp" ? str(body?.gcpLogFilter) : null,
  };
  if (provider === "azure" && !cfg.azureTable) return { code: "AZURE_TABLE_REQUIRED" };
  if (provider === "gcp" && !cfg.gcpLogFilter) return { code: "GCP_LOG_FILTER_REQUIRED" };
  return cfg;
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

  // ── GET /api/deadpool/monitoring/flags ───────────────────────────────────────
  // Estado efetivo das flags de poll ativo por nuvem (allow_{cloudwatch,azure,gcp}_poll) +
  // monitor_enabled (gate do loop, READ-ONLY). Ligar poll ativo bate no SDK de nuvem do CLIENTE:
  // é decisão OPERACIONAL global da Zentriz (não escopada por tenant) → só zentriz_admin.
  app.get("/api/deadpool/monitoring/flags", async (request, reply) => {
    if (!requireZentrizAdmin(request, reply)) return;
    if (!isDeadpoolConfigured()) {
      return reply.send({ available: false, reason: "not_configured", monitorEnabled: false, flags: {} });
    }
    try {
      const data = await deadpoolGet<{ status?: string; monitor_enabled?: boolean; flags?: unknown }>(
        "/monitoring/flags",
      );
      return reply.send({
        available: true,
        monitorEnabled: data?.monitor_enabled === true,
        flags: data?.flags ?? {},
      });
    } catch (err) {
      const reason = degradeReason(err);
      app.log.warn({ route: "deadpool/monitoring/flags", reason }, "Deadpool flags indisponível (degradado)");
      return reply.send({ available: false, reason, monitorEnabled: false, flags: {} });
    }
  });

  // ── POST /api/deadpool/monitoring/flags ──────────────────────────────────────
  // Liga/desliga um override de poll por nuvem em runtime (sem redeploy). Corpo:
  // { flags: { allow_<cloud>_poll: true|false|null } } — null remove o override (volta ao env).
  // Valida no gateway antes de repassar (defesa em profundidade) — nunca 500 por Deadpool ausente.
  app.post<{ Body: { flags?: Record<string, unknown> } }>(
    "/api/deadpool/monitoring/flags",
    async (request, reply) => {
      if (!requireZentrizAdmin(request, reply)) return;
      const updates = request.body?.flags;
      if (typeof updates !== "object" || updates === null || Array.isArray(updates)) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "corpo deve conter objeto 'flags'" });
      }
      const MANAGED = ["allow_cloudwatch_poll", "allow_azure_poll", "allow_gcp_poll"];
      for (const [key, value] of Object.entries(updates)) {
        if (!MANAGED.includes(key)) {
          return reply.status(400).send({ code: "UNMANAGED_FLAG", message: `flag não gerenciável: ${key}` });
        }
        if (value !== null && typeof value !== "boolean") {
          return reply.status(400).send({ code: "BAD_VALUE", message: `valor de ${key} deve ser bool ou null` });
        }
      }
      if (!isDeadpoolConfigured()) {
        return reply.status(503).send({ code: "DEADPOOL_UNAVAILABLE", reason: "not_configured" });
      }
      try {
        const data = await deadpoolPost<{ status?: string; monitor_enabled?: boolean; flags?: unknown; reason?: string }>(
          "/monitoring/flags",
          { flags: updates },
        );
        if (data?.status !== "ok") {
          return reply.status(400).send({ code: "REJECTED", message: data?.reason ?? "rejeitado pelo Deadpool" });
        }
        return reply.send({
          available: true,
          monitorEnabled: data?.monitor_enabled === true,
          flags: data?.flags ?? {},
        });
      } catch (err) {
        const reason = degradeReason(err);
        app.log.warn({ route: "deadpool/monitoring/flags:POST", reason }, "Deadpool set-flags falhou (degradado)");
        return reply.status(503).send({ code: "DEADPOOL_UNAVAILABLE", reason });
      }
    },
  );

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
                last_registered_at, last_error,
                monitor_provider, azure_workspace_id, azure_table, azure_message_column,
                gcp_project_id, gcp_log_filter
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
        // Multi-cloud (M1/M2): nuvem monitorada + ponteiros (null = CloudWatch/nunca ativado).
        monitorProvider: m?.monitor_provider ?? null,
        azureWorkspaceId: m?.azure_workspace_id ?? null,
        azureTable: m?.azure_table ?? null,
        azureMessageColumn: m?.azure_message_column ?? null,
        gcpProjectId: m?.gcp_project_id ?? null,
        gcpLogFilter: m?.gcp_log_filter ?? null,
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
  app.post<{ Params: { id: string }; Body: MonitoringActivateBody }>(
    "/api/deadpool/projects/:id/activate",
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const user = getUser(request);
      const { id } = request.params;

      // Config multi-cloud (M1/M2). Sem corpo → CloudWatch (retrocompat #1). Azure/GCP exigem escopo.
      const cfg = parseMonitoringConfig(request.body);
      if ("code" in cfg) return reply.status(400).send({ code: cfg.code });

      // Carrega projeto + produto + repo + installation numa query (espelha githubPush).
      const res = await pool.query(
        `SELECT p.id, p.title, p.tenant_id, p.status,
                pr.name AS product_name, pr.system_id AS product_system_id, pr.solo_app AS product_solo_app,
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
      const isCloudwatch = cfg.provider === "cloudwatch";

      // Fork B (multi-tenant): para CloudWatch, resolvemos as credenciais AWS da CONTA do tenant e as
      // propagamos ao Deadpool, para que ele monitore a conta/região DELE — não a identidade do
      // container Zentriz (fork A). role_arn/external_id não são segredos; awsCredentialsEnc é o payload
      // CIFRADO das chaves estáticas (crypto.ts), encaminhado as-is e decriptado só em memória pelo poller.
      // Sem conexão AWS ativa → creds null → Deadpool cai na cadeia default (retrocompat fork A).
      const awsCreds = isCloudwatch ? await getAwsMonitoringCredentials(row.tenant_id as string) : null;
      // Região: a da conexão do tenant tem precedência; senão a env do host Deadpool (comportamento #1).
      const envRegion = (process.env.AWS_REGION ?? process.env.DEADPOOL_AWS_REGION ?? "").trim() || null;
      const awsRegion = awsCreds?.region ?? envRegion;

      const { systemId, serviceId } = deriveSystemService({
        productSystemId: row.product_system_id as string | null,
        productName: row.product_name as string | null,
        title: row.title as string | null,
        projectId: id,
        soloApp: (row.product_solo_app as boolean | null) ?? false,
      });

      // Registra o vínculo runtime + liga o monitoramento no Deadpool. O activate é a declaração
      // AUTORITATIVA do escopo de nuvem: enviamos SEMPRE o provider explícito (inclusive "cloudwatch")
      // e só os ponteiros da nuvem escolhida (os demais vão null). Isso permite ao Deadpool RESETAR o
      // escopo ao trocar de nuvem — ex.: voltar de Azure para CloudWatch limpa azure_table lá. Para
      // CloudWatch, logGroup/awsRegion vêm do deployment (comportamento #1); Azure/GCP não os usam.
      const result = await registerProjectWithDeadpool({
        systemId,
        serviceId,
        repoUrl: row.repo_url as string,
        installationId: row.installation_id as number,
        appUrl: dep?.app_url ?? null,
        healthUrl: dep?.health_url ?? null,
        environment: dep ? (dep.class === "demo" ? "demo" : "production") : null,
        awsRegion: isCloudwatch ? awsRegion : null,
        logGroup: isCloudwatch ? (dep?.log_group ?? null) : null,
        monitoring: true,
        // Provider SEMPRE explícito (o Deadpool trata "cloudwatch" como reset do escopo de nuvem).
        monitorProvider: cfg.provider,
        azureWorkspaceId: cfg.azureWorkspaceId,
        azureTable: cfg.azureTable,
        azureMessageColumn: cfg.azureMessageColumn,
        gcpProjectId: cfg.gcpProjectId,
        gcpLogFilter: cfg.gcpLogFilter,
        // Fork B: credenciais AWS por projeto (só CloudWatch). null quando não há conexão AWS ativa
        // ou a nuvem monitorada não é CloudWatch — o Deadpool então usa a identidade default.
        awsRoleArn: isCloudwatch ? (awsCreds?.roleArn ?? null) : null,
        awsExternalId: isCloudwatch ? (awsCreds?.externalId ?? null) : null,
        awsCredentialsEnc: isCloudwatch ? (awsCreds?.credentialsEnc ?? null) : null,
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
              last_registered_at, last_error, updated_at,
              monitor_provider, azure_workspace_id, azure_table, azure_message_column,
              gcp_project_id, gcp_log_filter)
           VALUES ($1, true, $2, $3, $4, now(), now(), NULL, now(),
                   $5, $6, $7, $8, $9, $10)
           ON CONFLICT (project_id) DO UPDATE
             SET active = true,
                 system_id = EXCLUDED.system_id,
                 service_id = EXCLUDED.service_id,
                 activated_by = EXCLUDED.activated_by,
                 activated_at = now(),
                 last_registered_at = now(),
                 last_error = NULL,
                 updated_at = now(),
                 monitor_provider = EXCLUDED.monitor_provider,
                 azure_workspace_id = EXCLUDED.azure_workspace_id,
                 azure_table = EXCLUDED.azure_table,
                 azure_message_column = EXCLUDED.azure_message_column,
                 gcp_project_id = EXCLUDED.gcp_project_id,
                 gcp_log_filter = EXCLUDED.gcp_log_filter`,
          [id, systemId, serviceId, user.id,
           cfg.provider, cfg.azureWorkspaceId, cfg.azureTable, cfg.azureMessageColumn,
           cfg.gcpProjectId, cfg.gcpLogFilter],
        );
        // Rótulo humano do escopo por nuvem (para o histórico do projeto).
        const scopeLabel =
          cfg.provider === "azure" ? ` (Azure: ${cfg.azureTable})`
          : cfg.provider === "gcp" ? ` (GCP: ${cfg.gcpLogFilter})`
          : dep?.log_group ? ` (${dep.log_group})` : "";
        await pool.query(
          `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human)
           VALUES ($1, 'system', 'deadpool', 'step', $2)`,
          [id, `🛡️ Monitoramento Deadpool ATIVADO para ${systemId}/${serviceId ?? "*"} — monitoramento ativo de logs${scopeLabel} + intake reativo de incidentes.`],
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
      app.log.info({ projectId: id, systemId, serviceId, provider: cfg.provider, by: user.id }, "Monitoramento Deadpool ativado");
      return reply.send({ ok: true, active: true, systemId, serviceId, provider: cfg.provider });
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
                pr.name AS product_name, pr.system_id AS product_system_id, pr.solo_app AS product_solo_app,
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
        soloApp: (row.product_solo_app as boolean | null) ?? false,
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
