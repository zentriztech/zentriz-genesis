import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyToken } from "../auth.js";

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
