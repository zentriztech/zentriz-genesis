/**
 * specSplit.ts — rotas da DIVISÃO da spec em arquivos (F2/PR-3, migration 093).
 *
 *   POST /api/spec-split                    → propõe a divisão (agêntica: arquiteto + N redatores)
 *   GET  /api/spec-split?projectId=         → última proposta (com `?payload=1` traz plano/arquivos)
 *   POST /api/spec-split/:id/apply          → materializa (snapshot G2 antes; índice no primário)
 *   POST /api/spec-split/:id/discard        → descarta a proposta
 *
 * Autorização (mesma regra do chat de spec e do modo autônomo):
 *   • `denyCreationForManagement` — conta de gestão não reescreve spec de cliente;
 *   • `svc:"runner"` 403 — token de máquina não divide spec (autoria humana aprova);
 *   • `canAccessProjectRow` antes de qualquer leitura de conteúdo.
 * A máquina de estados e TODAS as guardas de escrita vivem em `services/specSplit.ts`.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { denyCreationForManagement } from "../middleware/managementGuard.js";
import { canAccessProjectRow } from "../lib/projectAccess.js";
import { SPEC_EDITABLE_STATUSES } from "../services/projectStatus.js";
import {
  startSplitProposal, getSplitProposal, getLatestSplitProposal, applySplitProposal,
  discardSplitProposal, specSplitEnabled, isTerminalSplitStatus, type SpecSplitProposal,
} from "../services/specSplit.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

/** Contrato do wire. O `payload` (plano + conteúdo dos arquivos) só viaja quando pedido. */
function toWire(p: SpecSplitProposal) {
  return {
    id: p.id,
    projectId: p.projectId,
    status: p.status,
    active: !isTerminalSplitStatus(p.status),
    awaitingDecision: p.status === "done",
    sourceChars: p.sourceChars,
    producedChars: p.producedChars,
    warnings: p.warnings,
    error: p.error,
    inputTokens: p.inputTokens,
    outputTokens: p.outputTokens,
    modelUsed: p.modelUsed,
    appliedAt: p.appliedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    ...(p.payload
      ? {
          plan: p.payload.plan,
          coverage: p.payload.coverage,
          index: p.payload.index,
          files: Object.entries(p.payload.files).map(([path, content]) => ({ path, chars: content.length })),
        }
      : {}),
  };
}

async function loadProjectForUser(
  projectId: string, user: AuthUser,
): Promise<{ tenantId: string | null; status: string } | null> {
  const proj = (await pool.query(
    "SELECT tenant_id, created_by, status FROM projects WHERE id = $1", [projectId],
  )).rows[0];
  if (!proj || !canAccessProjectRow(user, proj)) return null;
  const r = proj as { tenant_id?: string | null; status?: string };
  return { tenantId: r.tenant_id ?? null, status: String(r.status ?? "") };
}

export async function specSplitRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.post<{ Body: { projectId?: string; modelId?: string } }>(
    "/api/spec-split",
    async (request, reply) => {
      const user = getUser(request);
      if (denyCreationForManagement(user, reply)) return;
      if (user.svc === "runner") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Token de serviço não divide a spec." });
      }
      if (!specSplitEnabled()) {
        return reply.status(503).send({ code: "SPLIT_DISABLED", message: "Divisão de spec desligada nesta instalação." });
      }
      const projectId = request.body?.projectId?.trim();
      if (!projectId) return reply.status(400).send({ code: "BAD_REQUEST", message: "projectId obrigatório" });
      const proj = await loadProjectForUser(projectId, user);
      if (!proj) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      // Mesma guarda de status das outras escritas de spec (S1): projeto em execução não é dividido.
      if (!SPEC_EDITABLE_STATUSES.has(proj.status)) {
        return reply.status(409).send({
          code: "SPEC_LOCKED",
          message: `Spec bloqueada para edição: projeto em '${proj.status}'.`,
        });
      }
      const res = await startSplitProposal(pool, {
        projectId, tenantId: proj.tenantId, ownerUserId: user.id,
        modelId: request.body?.modelId?.trim() || null,
      });
      if (!res.ok) return reply.status(res.status).send({ code: res.code, message: res.message });
      return reply.status(202).send({ proposal: toWire(res.proposal) });
    },
  );

  app.get<{ Querystring: { projectId?: string; payload?: string } }>(
    "/api/spec-split",
    async (request, reply) => {
      const user = getUser(request);
      const projectId = request.query?.projectId?.trim();
      if (!projectId) return reply.status(400).send({ code: "BAD_REQUEST", message: "projectId obrigatório" });
      const proj = await loadProjectForUser(projectId, user);
      if (!proj) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      const withPayload = request.query?.payload === "1";
      const p = await getLatestSplitProposal(pool, projectId, { withPayload });
      return reply.send({ proposal: p ? toWire(p) : null, enabled: specSplitEnabled() });
    },
  );

  // Conteúdo de UM arquivo proposto (preview no editor antes de aplicar).
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/spec-split/:id/file",
    async (request, reply) => {
      const user = getUser(request);
      const p = await getSplitProposal(pool, request.params.id, { withPayload: true });
      if (!p) return reply.status(404).send({ code: "NOT_FOUND", message: "Proposta não encontrada" });
      if (!(await loadProjectForUser(p.projectId, user))) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Proposta não encontrada" });
      }
      const wanted = (request.query?.path ?? "").trim();
      const content = !wanted || wanted === "(index)" ? p.payload?.index : p.payload?.files?.[wanted];
      if (typeof content !== "string") {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Arquivo não existe nesta proposta" });
      }
      return reply.send({ path: wanted || "(index)", content, chars: content.length });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/spec-split/:id/apply",
    async (request, reply) => {
      const user = getUser(request);
      if (denyCreationForManagement(user, reply)) return;
      if (user.svc === "runner") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Token de serviço não aplica divisão de spec." });
      }
      const p = await getSplitProposal(pool, request.params.id);
      if (!p) return reply.status(404).send({ code: "NOT_FOUND", message: "Proposta não encontrada" });
      const proj = await loadProjectForUser(p.projectId, user);
      if (!proj) return reply.status(404).send({ code: "NOT_FOUND", message: "Proposta não encontrada" });
      if (!SPEC_EDITABLE_STATUSES.has(proj.status)) {
        return reply.status(409).send({
          code: "SPEC_LOCKED",
          message: `Spec bloqueada para edição: projeto em '${proj.status}'.`,
        });
      }
      const res = await applySplitProposal(pool, p.id, user.id ?? null);
      if (!res.ok) return reply.status(res.status).send({ code: res.code, message: res.message });
      const after = await getSplitProposal(pool, p.id);
      return reply.send({
        ok: true, created: res.created, indexPath: res.indexPath,
        proposal: after ? toWire(after) : null,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/spec-split/:id/discard",
    async (request, reply) => {
      const user = getUser(request);
      if (user.svc === "runner") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Token de serviço não opera a divisão de spec." });
      }
      const p = await getSplitProposal(pool, request.params.id);
      if (!p) return reply.status(404).send({ code: "NOT_FOUND", message: "Proposta não encontrada" });
      if (!(await loadProjectForUser(p.projectId, user))) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Proposta não encontrada" });
      }
      const n = await discardSplitProposal(pool, p.id);
      const after = await getSplitProposal(pool, p.id);
      return reply.send({ discarded: n > 0, proposal: after ? toWire(after) : null });
    },
  );
}
