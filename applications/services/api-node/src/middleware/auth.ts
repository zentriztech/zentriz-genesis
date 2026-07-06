import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyToken, decodeDeployCallbackToken, type DeployCallbackPayload } from "../auth.js";

export type AuthUser = {
  id: string;
  email: string;
  role: string;
  tenantId: string | null;
};

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
  (request as FastifyRequest & { user: AuthUser }).user = {
    id: payload.sub,
    email: payload.email,
    role: payload.role,
    tenantId: payload.tenantId ?? null,
  };
}
