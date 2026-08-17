import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyToken, decodeDeployCallbackToken, type DeployCallbackPayload } from "../auth.js";
import { getTenantStatus } from "../services/tenantStatusCache.js";

export type AuthUser = {
  id: string;
  email: string;
  role: string;
  tenantId: string | null;
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
  };
  (request as FastifyRequest & { user: AuthUser }).user = user;

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
