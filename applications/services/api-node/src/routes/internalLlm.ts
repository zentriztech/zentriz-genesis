// Endpoint interno — resolvido pelo runner_server (não exposto ao portal)
import type { FastifyInstance } from "fastify";
import { resolveProjectLlmConfig } from "../services/tenantLlmConfig.js";

export async function internalLlmRoutes(app: FastifyInstance): Promise<void> {
  // FT-13: GET /api/internal/project-llm-config/:projectId
  // Autenticado via GENESIS_INTERNAL_TOKEN (header X-Internal-Token)
  app.get<{ Params: { projectId: string } }>(
    "/api/internal/project-llm-config/:projectId",
    async (request, reply) => {
      const internalToken = process.env.GENESIS_API_TOKEN ?? process.env.GENESIS_INTERNAL_TOKEN ?? "";
      const provided = (request.headers["x-internal-token"] as string)
        || (request.headers["authorization"] as string ?? "").replace(/^Bearer\s+/i, "");
      // Aceita: token estático idêntico OU JWT válido assinado com JWT_SECRET (runner usa fresh JWT)
      let authorized = !internalToken; // sem token configurado = sem restrição
      if (!authorized && provided) {
        if (provided === internalToken) {
          authorized = true;
        } else {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const jwt = require("jsonwebtoken") as { verify: (t: string, s: string) => { role?: string } };
            const decoded = jwt.verify(provided, process.env.JWT_SECRET ?? "genesis_secret");
            authorized = decoded?.role === "zentriz_admin" || decoded?.role === "tenant_admin";
          } catch { /* token inválido */ }
        }
      }
      if (!authorized) {
        return reply.status(401).send({ code: "UNAUTHORIZED", message: "Token interno inválido" });
      }
      const { projectId } = request.params;
      if (!projectId) return reply.status(400).send({ code: "BAD_REQUEST", message: "projectId obrigatório" });

      try {
        const cfg = await resolveProjectLlmConfig(projectId);
        // Nunca retornar api_key completa — runner_server injeta via env, não via response body
        // Mas aqui sim retornamos tudo pois é chamada interna server-to-server (não browser)
        return reply.send({ ok: true, ...cfg });
      } catch (err) {
        return reply.status(500).send({ code: "INTERNAL_ERROR", message: String(err) });
      }
    }
  );

  // FT-11: POST /api/internal/genesis-bug-report — recebe bug_report do Monitor Autônomo
  app.post("/api/internal/genesis-bug-report", async (request, reply) => {
    const internalToken = process.env.GENESIS_API_TOKEN ?? process.env.GENESIS_INTERNAL_TOKEN ?? "";
    const provided = (request.headers["x-internal-token"] as string) ??
                     (request.headers["authorization"] as string ?? "").replace("Bearer ", "");
    if (internalToken && provided !== internalToken) {
      return reply.status(401).send({ code: "UNAUTHORIZED" });
    }
    const body = request.body as Record<string, unknown>;
    // Log estruturado do bug report — pode ser integrado com Telegram/Slack/email futuramente
    const report = {
      project_id:  String(body.project_id ?? ""),
      task_id:     String(body.task_id ?? ""),
      description: String(body.description ?? ""),
      evidence:    body.evidence ?? {},
      severity:    String(body.severity ?? "high"),
      reported_at: new Date().toISOString(),
    };
    // TODO FT-09: quando Telegram integrado, disparar alerta aqui
    console.error("[GENESIS_BUG_REPORT]", JSON.stringify(report));
    return reply.send({ ok: true, received: true });
  });

  // FT-13: endpoint para zentriz_admin configurar LLM global
  // POST /api/admin/zentriz-llm-config
  app.post("/api/admin/zentriz-llm-config", async (request, reply) => {
    const internalToken = process.env.GENESIS_API_TOKEN ?? process.env.GENESIS_INTERNAL_TOKEN ?? "";
    const provided = (request.headers["x-internal-token"] as string) ?? "";
    if (internalToken && provided !== internalToken) {
      return reply.status(401).send({ code: "UNAUTHORIZED" });
    }
    const body = request.body as Record<string, unknown>;
    const { pool } = await import("../db/client.js");
    await pool.query(
      `INSERT INTO zentriz_llm_config (provider, model_id, credentials, is_active, updated_at)
       VALUES ($1, $2, $3, true, now())
       ON CONFLICT ((TRUE)) DO UPDATE SET
         provider=$1, model_id=$2, credentials=$3, is_active=true, updated_at=now()`,
      [
        String(body.provider ?? "anthropic"),
        String(body.model_id ?? "us.anthropic.claude-sonnet-4-6"),
        JSON.stringify(body.credentials ?? {}),
      ]
    );
    return reply.send({ ok: true });
  });
}
