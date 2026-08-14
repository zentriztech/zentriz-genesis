/**
 * deadpoolApprovals.ts — Gate de APROVAÇÃO de promoção do Deadpool (RFC-028 / ADR-024 Fase C).
 *
 * Sob autonomia por ambiente, o Deadpool libera merge+deploy em `dev` sozinho, mas `staging`/`prod`
 * exigem um REGISTRO DE APROVAÇÃO humano emitido por este portal. O guardrail R7/R9 do Deadpool é
 * FAIL-CLOSED: sem um registro válido (decision=approved, ambiente/ação/incidente/repo casando, janela
 * não expirada) a promoção é bloqueada. Este módulo é a superfície que cria/decide esses registros.
 *
 * Auth/RBAC (app.addHook preHandler authMiddleware):
 *   - Ler/criar pedido: tenant_admin | zentriz_admin, escopado por ownership de tenant.
 *   - DECIDIR (approve/reject): staging → tenant_admin+; prod/production → só zentriz_admin
 *     (mesma lógica de "quanto mais sensível o ambiente, mais alto o papel", espelhando a licença).
 *
 * Rotas:
 *   GET  /api/deadpool/projects/:id/approvals     → lista pedidos de um projeto
 *   POST /api/deadpool/projects/:id/approvals     → cria pedido (decision=pending)
 *   GET  /api/deadpool/approvals/:approvalId      → detalha um pedido + serialização p/ o Deadpool
 *   POST /api/deadpool/approvals/:approvalId/decide → aprova/rejeita (registra decisor + papel)
 *
 * O registro serializado (campo `deadpoolRecord`) casa EXATAMENTE o shape que o guardrail do Deadpool
 * consome como `promotion_approval`: { decision, target_environment, actions[], approver_role,
 * incident_id, repo_url, expires_at_epoch }.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { pool } from "../db/client.js";
import { hasEntitlement } from "../services/entitlements.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Ambientes que exigem aprovação (espelha _APPROVAL_REQUIRED_ENVIRONMENTS do Deadpool). */
const APPROVAL_ENVIRONMENTS = new Set(["staging", "stage", "homolog", "prod", "production"]);
/** Ambientes de produção — decisão restrita a zentriz_admin. */
const PROD_ENVIRONMENTS = new Set(["prod", "production"]);
/** Ações aceitas num registro. 'promote' cobre merge+deploy. */
const VALID_ACTIONS = new Set(["merge", "deploy", "promote"]);
/**
 * TTL default de um pedido quando o operador não informa expiração (achado adversarial MEDIUM-3):
 * uma aprovação é uma autorização PERMANENTE de promoção autônoma se não expira — evitamos grants
 * eternos aplicando um teto de 7 dias. Operador que precise de janela diferente informa `expiresAt`.
 */
const DEFAULT_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const user = getUser(request);
  if (user.role !== "tenant_admin" && user.role !== "zentriz_admin") {
    reply.status(403).send({ code: "FORBIDDEN" });
    return false;
  }
  return true;
}

/** Normaliza a lista de ações do corpo/registro para um array saneado. Vazio ⇒ ['promote']. */
function normalizeActions(input: unknown): string[] {
  let items: string[];
  if (typeof input === "string") {
    items = input.split(",");
  } else if (Array.isArray(input)) {
    items = input.map((x) => String(x));
  } else {
    return ["promote"];
  }
  const cleaned = items.map((s) => s.trim().toLowerCase()).filter((s) => VALID_ACTIONS.has(s));
  return cleaned.length > 0 ? Array.from(new Set(cleaned)) : ["promote"];
}

interface ApprovalRow {
  id: string;
  project_id: string;
  tenant_id: string;
  incident_id: string | null;
  repo_url: string | null;
  target_environment: string;
  actions: string;
  decision: string;
  requested_by: string | null;
  decided_by: string | null;
  decided_by_role: string | null;
  reason: string | null;
  expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** Serializa a linha para a UI e — em `deadpoolRecord` — para o shape que o guardrail consome. */
function serializeApproval(row: ApprovalRow): Record<string, unknown> {
  const actions = normalizeActions(row.actions);
  const expiresIso = row.expires_at
    ? new Date(row.expires_at as string | Date).toISOString()
    : null;
  const expiresEpoch = row.expires_at
    ? Math.floor(new Date(row.expires_at as string | Date).getTime() / 1000)
    : null;
  return {
    id: row.id,
    projectId: row.project_id,
    tenantId: row.tenant_id,
    incidentId: row.incident_id,
    repoUrl: row.repo_url,
    targetEnvironment: row.target_environment,
    actions,
    decision: row.decision,
    requestedBy: row.requested_by,
    decidedBy: row.decided_by,
    decidedByRole: row.decided_by_role,
    reason: row.reason,
    expiresAt: expiresIso,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    // Registro consumível pelo guardrail R7/R9 do Deadpool (fail-closed). Só é "utilizável"
    // quando decision === 'approved'; os demais estados viajam para transparência da UI.
    deadpoolRecord: {
      decision: row.decision,
      target_environment: row.target_environment,
      actions,
      approver_role: row.decided_by_role,
      incident_id: row.incident_id,
      repo_url: row.repo_url,
      expires_at_epoch: expiresEpoch,
    },
  };
}

/** Registra evento no timeline do projeto (auditoria), best-effort — nunca derruba a rota. */
async function recordDialogue(
  app: FastifyInstance,
  projectId: string,
  eventType: string,
  summary: string,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human)
       VALUES ($1, $2, $3, $4, $5)`,
      [projectId, "portal", "deadpool", eventType, summary],
    );
  } catch (err) {
    app.log.warn({ err, projectId, eventType }, "Falha ao registrar dialogue de approval (ignorado)");
  }
}

export async function deadpoolApprovalsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  // ── GET /api/deadpool/projects/:id/approvals ─────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/deadpool/projects/:id/approvals",
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const user = getUser(request);
      const { id } = request.params;
      if (!UUID_RE.test(id)) return reply.status(400).send({ code: "INVALID_PROJECT_ID" });

      const projRes = await pool.query("SELECT tenant_id FROM projects WHERE id = $1", [id]);
      const proj = projRes.rows[0];
      if (!proj) return reply.status(404).send({ code: "PROJECT_NOT_FOUND" });
      if (user.role !== "zentriz_admin" && proj.tenant_id !== user.tenantId) {
        return reply.status(403).send({ code: "FORBIDDEN" });
      }
      const res = await pool.query(
        `SELECT * FROM deadpool_promotion_approvals
          WHERE project_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [id],
      );
      return reply.send({ approvals: res.rows.map((r) => serializeApproval(r as ApprovalRow)) });
    },
  );

  // ── POST /api/deadpool/projects/:id/approvals ────────────────────────────────
  // Cria um pedido de promoção (decision=pending). Exige licença Deadpool + ownership.
  app.post<{
    Params: { id: string };
    Body: {
      targetEnvironment?: string;
      actions?: unknown;
      incidentId?: string;
      repoUrl?: string;
      expiresAt?: string;
    };
  }>("/api/deadpool/projects/:id/approvals", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const user = getUser(request);
    const { id } = request.params;
    if (!UUID_RE.test(id)) return reply.status(400).send({ code: "INVALID_PROJECT_ID" });

    const body = request.body ?? {};
    const env = String(body.targetEnvironment ?? "").trim().toLowerCase();
    if (!APPROVAL_ENVIRONMENTS.has(env)) {
      return reply.status(400).send({ code: "INVALID_TARGET_ENVIRONMENT", allowed: Array.from(APPROVAL_ENVIRONMENTS) });
    }
    const actions = normalizeActions(body.actions);

    // Janela de expiração: se enviada, precisa ser data válida e FUTURA (achado adversarial LOW-1 —
    // uma janela no passado renderiza "Aprovada" na UI mas jamais autoriza, pois o guardrail fail-closed
    // a rejeita). Se ausente, aplicamos um TTL default (MEDIUM-3) — nunca criamos grant permanente.
    let expiresAt: string;
    if (body.expiresAt != null && String(body.expiresAt).trim() !== "") {
      const parsed = new Date(String(body.expiresAt));
      if (Number.isNaN(parsed.getTime())) {
        return reply.status(400).send({ code: "INVALID_EXPIRES_AT" });
      }
      if (parsed.getTime() <= Date.now()) {
        return reply.status(400).send({ code: "EXPIRES_AT_IN_PAST" });
      }
      expiresAt = parsed.toISOString();
    } else {
      expiresAt = new Date(Date.now() + DEFAULT_APPROVAL_TTL_MS).toISOString();
    }

    const projRes = await pool.query("SELECT tenant_id FROM projects WHERE id = $1", [id]);
    const proj = projRes.rows[0];
    if (!proj) return reply.status(404).send({ code: "PROJECT_NOT_FOUND" });
    if (user.role !== "zentriz_admin" && proj.tenant_id !== user.tenantId) {
      return reply.status(403).send({ code: "FORBIDDEN" });
    }
    if (!(await hasEntitlement(proj.tenant_id, "deadpool"))) {
      return reply.status(403).send({ code: "NO_DEADPOOL_ENTITLEMENT" });
    }

    const insert = await pool.query(
      `INSERT INTO deadpool_promotion_approvals
         (project_id, tenant_id, incident_id, repo_url, target_environment, actions, requested_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        proj.tenant_id,
        body.incidentId ? String(body.incidentId) : null,
        body.repoUrl ? String(body.repoUrl) : null,
        env,
        actions.join(","),
        user.id,
        expiresAt,
      ],
    );
    const row = insert.rows[0] as ApprovalRow;
    await recordDialogue(app, id, "deadpool_promotion_requested", `Pedido de promoção para '${env}' (${actions.join(", ")}) criado por ${user.email}.`);
    return reply.status(201).send({ approval: serializeApproval(row) });
  });

  // ── GET /api/deadpool/approvals/:approvalId ──────────────────────────────────
  app.get<{ Params: { approvalId: string } }>(
    "/api/deadpool/approvals/:approvalId",
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const user = getUser(request);
      const { approvalId } = request.params;
      if (!UUID_RE.test(approvalId)) return reply.status(400).send({ code: "INVALID_APPROVAL_ID" });
      const res = await pool.query("SELECT * FROM deadpool_promotion_approvals WHERE id = $1", [approvalId]);
      const row = res.rows[0] as ApprovalRow | undefined;
      if (!row) return reply.status(404).send({ code: "APPROVAL_NOT_FOUND" });
      if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId) {
        return reply.status(403).send({ code: "FORBIDDEN" });
      }
      return reply.send({ approval: serializeApproval(row) });
    },
  );

  // ── POST /api/deadpool/approvals/:approvalId/decide ──────────────────────────
  // Aprova ou rejeita. RBAC por ambiente: prod/production → só zentriz_admin.
  app.post<{ Params: { approvalId: string }; Body: { decision?: string; reason?: string } }>(
    "/api/deadpool/approvals/:approvalId/decide",
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;
      const user = getUser(request);
      const { approvalId } = request.params;
      if (!UUID_RE.test(approvalId)) return reply.status(400).send({ code: "INVALID_APPROVAL_ID" });

      const decision = String(request.body?.decision ?? "").trim().toLowerCase();
      if (decision !== "approved" && decision !== "rejected") {
        return reply.status(400).send({ code: "INVALID_DECISION", allowed: ["approved", "rejected"] });
      }
      const reason = request.body?.reason ? String(request.body.reason).slice(0, 2000) : null;

      const res = await pool.query("SELECT * FROM deadpool_promotion_approvals WHERE id = $1", [approvalId]);
      const row = res.rows[0] as ApprovalRow | undefined;
      if (!row) return reply.status(404).send({ code: "APPROVAL_NOT_FOUND" });

      // Ownership de tenant.
      if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId) {
        return reply.status(403).send({ code: "FORBIDDEN" });
      }
      // Re-checa licença na DECISÃO (achado adversarial LOW-2): a licença pode ter sido revogada
      // entre o pedido e a decisão — não cunhamos uma autorização consumível para tenant sem Deadpool.
      if (!(await hasEntitlement(row.tenant_id, "deadpool"))) {
        return reply.status(403).send({ code: "NO_DEADPOOL_ENTITLEMENT" });
      }
      // RBAC por ambiente: produção só zentriz_admin.
      if (PROD_ENVIRONMENTS.has(row.target_environment) && user.role !== "zentriz_admin") {
        return reply.status(403).send({ code: "PROD_REQUIRES_ZENTRIZ_ADMIN" });
      }
      // Só um pedido PENDENTE pode ser decidido (evita re-decidir/regravar decisor).
      if (row.decision !== "pending") {
        return reply.status(409).send({ code: "ALREADY_DECIDED", decision: row.decision });
      }

      const upd = await pool.query(
        `UPDATE deadpool_promotion_approvals
            SET decision = $1, decided_by = $2, decided_by_role = $3, reason = $4, updated_at = now()
          WHERE id = $5 AND decision = 'pending'
          RETURNING *`,
        [decision, user.id, user.role, reason, approvalId],
      );
      const updated = upd.rows[0] as ApprovalRow | undefined;
      // Corrida: outro decisor pegou entre o SELECT e o UPDATE → 0 linhas.
      if (!updated) return reply.status(409).send({ code: "ALREADY_DECIDED" });

      await recordDialogue(
        app,
        updated.project_id,
        "deadpool_promotion_decided",
        `Promoção para '${updated.target_environment}' ${decision === "approved" ? "APROVADA" : "REJEITADA"} por ${user.email} (${user.role}).`,
      );
      return reply.send({ approval: serializeApproval(updated) });
    },
  );
}
