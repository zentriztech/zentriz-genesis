import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyToken, decodeDeployCallbackToken, type DeployCallbackPayload } from "../auth.js";
import { getTenantStatus } from "../services/tenantStatusCache.js";

export type AuthUser = {
  id: string;
  email: string;
  role: string;
  tenantId: string | null;
  /** Identidade de serviço do token (ex.: "runner" p/ token de máquina do pipeline). */
  svc?: string;
  /** Claim de PROJETO do token escopado (svc:"runner" cunhado por /cyborg-token). */
  projectId?: string;
};

// H3 (RFC-0002 Parte B / F2): kill-switch de emergência do recheck de suspensão.
// "gated e deployado isoladamente" (RFC B.4) — se algo der errado em produção,
// H3_TENANT_STATUS_GATE=off desliga o gate sem redeploy. Ligado por padrão.
const H3_GATE_ENABLED = (process.env.H3_TENANT_STATUS_GATE ?? "on").toLowerCase() !== "off";

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return reply.status(401).send({ code: "UNAUTHORIZED", message: "Token ausente" });
  }
  const token = authHeader.slice(7);

  // G1-T19: token de callback escopado (deploy-callback). É SEM privilégio de usuário:
  // stash o claim para a rota de callback de backend fazer a checagem de binding
  // (deploymentId/projectId). Marca um `user` powerless para não vazar como admin.
  const cb = decodeDeployCallbackToken(token);
  if (cb) {
    (request as FastifyRequest & { deployCallback: DeployCallbackPayload }).deployCallback = cb;
    (request as FastifyRequest & { user: AuthUser }).user = {
      id: "deploy-callback", email: "", role: "deploy-callback", tenantId: null,
    };
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    return reply.status(401).send({ code: "UNAUTHORIZED", message: "Token inválido" });
  }
  const user: AuthUser = {
    id: payload.sub,
    email: payload.email,
    role: payload.role,
    tenantId: payload.tenantId ?? null,
    svc: payload.svc,
    projectId: payload.projectId,
  };
  (request as FastifyRequest & { user: AuthUser }).user = user;

  // Lei 8 (rota B / Fase 3) — BINDING DE PROJETO no token do executor não-confiável.
  // O token svc:"runner" cunhado por /api/internal/cyborg-token carrega o claim `projectId`
  // e é injetado no env do `claude --dangerously-skip-permissions` (código do cliente). Sem
  // esta guarda, o claim é decorativo: `canAccessProjectRow` decide só por tenant, então o
  // token vale para QUALQUER projeto do mesmo tenant (auditoria adversarial P1-2). Aqui o
  // amarramos ao próprio projeto: um token de run só opera rotas `/api/projects/<seu-id>/*`.
  // Só age quando há projectId no token — não afeta login, tokens de usuário real, nem o
  // token de run ESCOPADO NO TENANT (svc:runner SEM projectId) que o orquestrador usa nos
  // callbacks (/run,/tasks,/accept,/deploy,…).
  //
  // MUST-MATCH (não só anti-mismatch): a superfície legítima do token de projeto é
  // exclusivamente `/api/projects/:id/*` (github-repo, github-clone-token, accept, dialogue,
  // deploy/ephemeral). Exigir um id de projeto na rota que BATA com o claim fecha, de uma vez,
  // qualquer rota sem `:id`/`:projectId` (sub-recursos como /api/deployments/:deploymentId,
  // /api/deadpool/approvals/:approvalId, learning/plans/reports) — que o executor não-confiável
  // poderia alcançar de outra forma. Nenhuma chamada legítima do runner fica sem `:id`.
  if (payload.svc === "runner" && payload.projectId) {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const routeProjectId = (typeof params.id === "string" && params.id)
      || (typeof params.projectId === "string" && params.projectId)
      || "";
    if (routeProjectId !== payload.projectId) {
      return reply.status(403).send({
        code: "PROJECT_SCOPE_MISMATCH",
        message: "Token de projeto só opera rotas do próprio projeto.",
      });
    }
  }

  // H3 (F2): recheck de suspensão no meio da sessão. O login já barra tenants
  // não-ativos na entrada; aqui fechamos a janela de um token ainda válido cujo
  // tenant foi suspenso/inativado depois (inadimplência).
  //
  // Isenções (todas ANTES do lookup de status):
  //  • master (zentriz_admin, tenantId null) — nunca é bloqueado;
  //  • token de máquina do runner (svc: "runner", cunhado só no servidor ao
  //    despachar o pipeline) — RFC H1 inegociável: os callbacks do orquestrador
  //    (/run, /tasks, /dialogue, /accept, /deploy, PATCH project, …) usam um token
  //    ESCOPADO NO TENANT e JAMAIS podem ser derrubados por inadimplência, senão um
  //    pipeline em voo quebra. Isentamos pela IDENTIDADE do token (svc), não por
  //    caminho — assim um usuário real suspenso é barrado em TODAS as rotas
  //    (inclusive /run e /tasks) e não há bypass via querystring.
  if (H3_GATE_ENABLED && user.tenantId && user.role !== "zentriz_admin" && payload.svc !== "runner") {
    // status === null → falha de lookup (fail-open, não bloqueia).
    // status !== 'active' (inclui '__missing__') → bloqueia.
    const status = await getTenantStatus(user.tenantId);
    if (status !== null && status !== "active") {
      return reply.status(403).send({
        code: "TENANT_INACTIVE",
        message: "Tenant inativo ou suspenso. Acesso indisponível até a regularização.",
      });
    }
  }
}
