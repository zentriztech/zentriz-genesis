/**
 * Rotas de políticas de custo de LLM (C3', migration 161).
 *   GET    /api/cost-policies          — políticas visíveis (zentriz_admin: todas; demais: globais + do próprio tenant)
 *   GET    /api/cost-policies/history  — trilha de versões (mesma visibilidade)
 *   PUT    /api/cost-policies          — cria/atualiza (gera nova versão + histórico + evento de auditoria)
 *   DELETE /api/cost-policies          — remove (a remoção também fica no histórico)
 * `advisor_pct` aceita `baseBudgetUsd` (C4'): recusa a gravação se `pct % × base` ficar abaixo do piso calculado (lib/advisorFloor.ts).
 * Escrita: SOMENTE pessoa. Token de serviço (`user.svc`: runner/agents) é negado, como o PUT de orçamento.
 *   zentriz_admin: qualquer escopo/chave e pode marcar `calibrated`. tenant_admin: só `advisor_pct`/`card_budget_pct` do PRÓPRIO tenant, sempre `calibrated=false`.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { advisorFloorViolation } from "../lib/advisorFloor.js";
import {
  deletePolicy, listPolicies, policyHistory, upsertPolicy, validatePolicy, type PolicyInput,
} from "../services/costPolicies.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

type Target = { scopeType?: string; scopeId?: string; key?: string };

/** Devolve `null` se autorizado; senão já responde 403. */
function denyWrite(request: FastifyRequest, reply: FastifyReply, t: { scopeType: string; scopeId: string; key: string }) {
  const user = getUser(request);
  if (user.svc) return reply.status(403).send({ code: "FORBIDDEN", message: "Política de custo só é alterada por pessoa, não por agente." });
  if (user.role === "zentriz_admin") return null;
  if (user.role === "tenant_admin" && user.tenantId && t.scopeType === "tenant" && t.scopeId === user.tenantId.toLowerCase() && (t.key === "advisor_pct" || t.key === "card_budget_pct")) {
    return null;
  }
  return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão para esta política." });
}

export async function costPolicyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  const visibleScope = (user: AuthUser, q: Target) => {
    if (user.role === "zentriz_admin") return { ok: true as const, scopeType: q.scopeType, scopeId: q.scopeId };
    // não-admin: apenas o próprio tenant (ou global)
    if (q.scopeType === "global") return { ok: true as const, scopeType: "global", scopeId: "" };
    if (q.scopeType === "tenant" && user.tenantId && (q.scopeId ?? "").toLowerCase() === user.tenantId.toLowerCase()) {
      return { ok: true as const, scopeType: "tenant", scopeId: user.tenantId.toLowerCase() };
    }
    if (!q.scopeType && user.tenantId) return { ok: true as const, scopeType: "tenant", scopeId: user.tenantId.toLowerCase() };
    return { ok: false as const };
  };

  app.get<{ Querystring: Target }>("/api/cost-policies", async (request, reply) => {
    const user = getUser(request);
    const v = visibleScope(user, request.query ?? {});
    if (!v.ok) return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
    const rows = await listPolicies(pool, { scopeType: v.scopeType, scopeId: v.scopeId });
    // não-admin sem filtro explícito: inclui também as globais
    if (user.role !== "zentriz_admin" && !request.query?.scopeType) rows.push(...await listPolicies(pool, { scopeType: "global", scopeId: "" }));
    return reply.send({ policies: rows });
  });

  app.get<{ Querystring: Target }>("/api/cost-policies/history", async (request, reply) => {
    const user = getUser(request);
    const q = request.query ?? {};
    const scopeType = q.scopeType ?? "global";
    const scopeId = scopeType === "global" ? "" : (q.scopeId ?? "").toLowerCase();
    const v = visibleScope(user, { scopeType, scopeId });
    if (!v.ok || !q.key) return reply.status(user.role === "zentriz_admin" ? 400 : 403).send({ code: "FORBIDDEN", message: "Sem permissão ou chave ausente" });
    return reply.send({ history: await policyHistory(pool, scopeType, scopeId, q.key) });
  });

  app.put<{ Body: PolicyInput }>("/api/cost-policies", async (request, reply) => {
    const user = getUser(request);
    if (user.svc) return reply.status(403).send({ code: "FORBIDDEN", message: "Política de custo só é alterada por pessoa, não por agente." });
    const parsed = validatePolicy(request.body ?? {});
    if (!parsed.ok) return reply.status(400).send({ code: parsed.code, message: parsed.message });
    const v = parsed.value;
    const denied = denyWrite(request, reply, { scopeType: v.scopeType, scopeId: v.scopeId, key: v.key });
    if (denied) return denied;
    // C4': piso do Advisor. Com `baseBudgetUsd` (orçamento-base de referência) recusa pct × base abaixo do piso calculado.
    const baseRef = (request.body as { baseBudgetUsd?: unknown } | undefined)?.baseBudgetUsd;
    if (v.key === "advisor_pct" && baseRef != null && baseRef !== "") {
      const base = Number(baseRef);
      const why = Number.isFinite(base) && base > 0
        ? advisorFloorViolation(v.pct as number, base, v.floorUsd)
        : "baseBudgetUsd deve ser um valor em US$ maior que zero.";
      if (why) return reply.status(400).send({ code: "ADVISOR_BELOW_FLOOR", message: why });
    }
    const saved = await upsertPolicy(pool, v, user.email, user.role === "zentriz_admin");
    await pool.query(
      "INSERT INTO llm_guard_events (kind, detail) VALUES ('cost_policy_changed', $1::jsonb)",
      [JSON.stringify({ key: v.key, scopeType: v.scopeType, scopeId: v.scopeId, version: saved.version, by: user.email })],
    ).catch(() => undefined);
    return reply.send({ policy: saved });
  });

  app.delete<{ Querystring: Target }>("/api/cost-policies", async (request, reply) => {
    const user = getUser(request);
    const q = request.query ?? {};
    const scopeType = q.scopeType ?? "global";
    const scopeId = scopeType === "global" ? "" : (q.scopeId ?? "").toLowerCase();
    const denied = denyWrite(request, reply, { scopeType, scopeId, key: q.key ?? "" });
    if (denied) return denied;
    const ok = await deletePolicy(pool, scopeType, scopeId, q.key ?? "", user.email);
    if (!ok) return reply.status(404).send({ code: "NOT_FOUND", message: "Política não encontrada" });
    await pool.query(
      "INSERT INTO llm_guard_events (kind, detail) VALUES ('cost_policy_deleted', $1::jsonb)",
      [JSON.stringify({ key: q.key, scopeType, scopeId, by: user.email })],
    ).catch(() => undefined);
    return reply.send({ ok: true });
  });
}
