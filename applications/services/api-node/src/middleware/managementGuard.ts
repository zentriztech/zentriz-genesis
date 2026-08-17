/**
 * managementGuard.ts — Genesis Admin como conta de GESTÃO pura (RFC-0002, Parte A).
 *
 * O `zentriz_admin` governa Tenants/usuários/planos/financeiro e OPERA o ciclo de vida
 * de projetos de tenants (ver, status, cancelar, limpar, DLQ, watchdog, /run, /tasks),
 * mas NUNCA cria/envia spec, produto ou projeto. Essa governança precisa viver no
 * backend — hoje os endpoints de autoria liberam explicitamente o master.
 *
 * ⚠️ Aplicar SOMENTE em endpoints de AUTORIA (POST /api/specs, /catalog/:slug/use,
 * /products*, /projects/:id/evolve, gatilho /new do Telegram). NUNCA em endpoints de
 * ciclo de vida/operação (POST /api/projects/:id/run em pipeline.ts, POST
 * /api/projects/:id/tasks) — esses são exercitados por chamadores INTERNOS com token
 * zentriz_admin (o watchdog cunha signToken({sub:"watchdog", role:"zentriz_admin"}) e
 * chama /run; o runner semeia tasks via /tasks). Um 403 cego ali mataria a promoção da
 * fila e o seed de tasks do pipeline (revisão adversarial H1 da RFC-0002).
 */
import type { FastifyReply } from "fastify";
import type { AuthUser } from "./auth.js";

export const MANAGEMENT_READONLY_CREATE = {
  code: "MANAGEMENT_ACCOUNT_READONLY_CREATE",
  message: "Conta de gestão não cria specs/projetos/produtos",
} as const;

/**
 * Barra a autoria pela conta de gestão. Se `user.role === "zentriz_admin"`, envia
 * 403 e retorna `true` — o handler DEVE `return` imediatamente. Caso contrário, `false`.
 */
export function denyCreationForManagement(user: AuthUser, reply: FastifyReply): boolean {
  if (user?.role === "zentriz_admin") {
    reply.status(403).send(MANAGEMENT_READONLY_CREATE);
    return true;
  }
  return false;
}
