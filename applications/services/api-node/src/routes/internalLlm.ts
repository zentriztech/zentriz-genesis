// Endpoint interno — resolvido pelo runner_server (não exposto ao portal)
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveProjectLlmConfig } from "../services/tenantLlmConfig.js";
import { verifyToken, type TokenPayload } from "../auth.js";
import { pool } from "../db/client.js";

/**
 * G1-T2: autenticação server-to-server FAIL-CLOSED e fonte única de JWT.
 *
 * Antes (fail-OPEN, corrigido): `authorized = !internalToken` liberava tudo quando
 * o token não estava configurado; e um jwt.verify inline usava o literal
 * "genesis_secret" (divergente do JWT_SECRET real de auth.ts).
 *
 * Agora: aceita (a) token estático idêntico (GENESIS_API_TOKEN/GENESIS_INTERNAL_TOKEN)
 * OU (b) JWT válido via verifyToken() (fonte ÚNICA de JWT_SECRET, mesmo que o runner
 * usa ao assinar). Em produção, NEGA quando não há token estático nem JWT válido.
 * Fora de produção, mantém uma folga (sem token configurado) para dev local.
 */
function authenticateInternal(request: FastifyRequest): { ok: true; payload: TokenPayload | null } | { ok: false } {
  const internalToken = (process.env.GENESIS_API_TOKEN ?? process.env.GENESIS_INTERNAL_TOKEN ?? "").trim();
  const provided = ((request.headers["x-internal-token"] as string)
    || (request.headers["authorization"] as string ?? "").replace(/^Bearer\s+/i, "")).trim();

  // Token estático server-to-server idêntico → autorizado (sem payload de usuário).
  if (internalToken && provided && provided === internalToken) {
    return { ok: true, payload: null };
  }
  // JWT válido assinado com o MESMO JWT_SECRET de auth.ts (o runner usa fresh JWT).
  // Aceita: admin (zentriz_admin/tenant_admin) OU token de MÁQUINA do run (svc:"runner"),
  // que é cunhado só no servidor (inforjável sem JWT_SECRET) e carrega `role` do dono do
  // projeto (pode ser "user"). T1: o svc:"runner" traz o claim `projectId` que amarra o
  // acesso ao endpoint de llm-config ao próprio projeto (checado na rota).
  if (provided) {
    const payload = verifyToken(provided);
    if (payload && (payload.role === "zentriz_admin" || payload.role === "tenant_admin" || payload.svc === "runner")) {
      return { ok: true, payload };
    }
  }
  // Fail-closed em produção. Fora de produção, sem token configurado = folga p/ dev.
  const isProd = process.env.NODE_ENV === "production";
  if (!isProd && !internalToken) {
    return { ok: true, payload: null };
  }
  return { ok: false };
}

export async function internalLlmRoutes(app: FastifyInstance): Promise<void> {
  // FT-13: GET /api/internal/project-llm-config/:projectId
  // Autenticado via token interno estático OU JWT válido (fail-closed em prod).
  app.get<{ Params: { projectId: string } }>(
    "/api/internal/project-llm-config/:projectId",
    async (request, reply) => {
      const auth = authenticateInternal(request);
      if (!auth.ok) {
        return reply.status(401).send({ code: "UNAUTHORIZED", message: "Token interno inválido" });
      }
      const { projectId } = request.params;
      if (!projectId) return reply.status(400).send({ code: "BAD_REQUEST", message: "projectId obrigatório" });

      // T1 — binding de PROJETO: um token de run (svc:"runner") carrega o claim `projectId`.
      // Ele só pode ler a config do PRÓPRIO projeto; usado p/ ler outro → 403. Assim, mesmo
      // que o token de um run vaze, o raio de explosão é UMA chave LLM (não todas as dos tenants).
      if (auth.payload && auth.payload.projectId && auth.payload.projectId !== projectId) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Token escopado a outro projeto" });
      }

      // T1 — sinal: token estático onipotente (payload null, sem escopo de projeto) lendo
      // llm-config. Após esta onda nenhum caller legítimo faz isso (runner/agents passam o
      // token escopado do run). Se aparecer no log de prod, há um caller não migrado a corrigir.
      if (!auth.payload) {
        request.log.warn(
          { projectId },
          "[internal-llm] leitura de llm-config com token ESTÁTICO não-escopado (server-to-server amplo)",
        );
      }

      // Guarda IDOR: um tenant_admin só pode ler config de projeto do PRÓPRIO tenant.
      // zentriz_admin e o token interno estático (payload null) têm acesso amplo (server-to-server).
      if (auth.payload && auth.payload.role === "tenant_admin") {
        try {
          const proj = await pool.query<{ tenant_id: string | null }>(
            "SELECT tenant_id FROM projects WHERE id = $1", [projectId],
          );
          const owner = proj.rows[0]?.tenant_id ?? null;
          if (!proj.rows[0]) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
          if (owner !== auth.payload.tenantId) {
            return reply.status(403).send({ code: "FORBIDDEN", message: "Projeto de outro tenant" });
          }
        } catch (err) {
          return reply.status(500).send({ code: "INTERNAL_ERROR", message: String(err) });
        }
      }

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
    const auth = authenticateInternal(request);
    if (!auth.ok) return reply.status(401).send({ code: "UNAUTHORIZED" });
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
    const auth = authenticateInternal(request);
    // Config global só por zentriz_admin ou token interno estático (payload null = server-to-server).
    if (!auth.ok || (auth.payload && auth.payload.role !== "zentriz_admin")) {
      return reply.status(401).send({ code: "UNAUTHORIZED" });
    }
    const body = request.body as Record<string, unknown>;
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
