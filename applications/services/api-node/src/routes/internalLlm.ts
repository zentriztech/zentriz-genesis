// Endpoint interno — resolvido pelo runner_server (não exposto ao portal)
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveProjectLlmConfig } from "../services/tenantLlmConfig.js";
import { verifyToken, signTokenWithExpiry, type TokenPayload } from "../auth.js";
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

  // Lei 8 (Fase 2 — sandbox por-job do FTS): POST /api/internal/cyborg-token
  //
  // O executor NÃO-CONFIÁVEL (`claude --dangerously-skip-permissions` no host/FTS)
  // NUNCA pode receber o token onipotente `GENESIS_API_TOKEN` (autentica como
  // zentriz_admin → acesso a TODOS os tenants/projetos = intrusão na Jóia da Coroa).
  // Este endpoint cunha um token de PROJETO curto (svc:"runner" + `projectId`), a
  // partir do dono/tenant do projeto, para o FTS injetar SÓ ele no env do subprocesso.
  //
  // - `sub = created_by` + `tenantId = project.tenant_id` cobrem os DOIS caminhos de
  //   `canAccessProjectRow`: match por tenant (projeto de tenant) OU por dono (projeto
  //   "solto", tenant_id null). Assim o Cyborg mantém acesso às rotas do PRÓPRIO projeto
  //   (dialogue/accept/reject/cyborg-log/deploy-ephemeral/github-repo — todas por
  //   checkProjectAccess), sem jamais receber poder de admin global.
  // - role zentriz_admin é REBAIXADA para "tenant_admin": o acesso do Cyborg não depende
  //   de role===zentriz_admin (usa match tenant/dono), então rebaixar não quebra nada e
  //   garante que um token vazado não abra rotas admin-only.
  // - Auth: mesmo `authenticateInternal` (o FTS chama com seu GENESIS_API_TOKEN, que
  //   vive SÓ no processo FTS confiável — nunca no env do claude).
  app.post<{ Body: { projectId?: string } }>(
    "/api/internal/cyborg-token",
    async (request, reply) => {
      const auth = authenticateInternal(request);
      if (!auth.ok) {
        return reply.status(401).send({ code: "UNAUTHORIZED", message: "Token interno inválido" });
      }
      // Lei 8 (rota B) — P0: só o CHAMADOR CONFIÁVEL cunha tokens de projeto.
      // O único caller legítimo é o FTS co-locado, que usa o GENESIS_API_TOKEN estático
      // (→ auth.payload === null). O executor NÃO-CONFIÁVEL recebe um token svc:"runner"
      // no env do `claude`; se ele pudesse cunhar, chamaria {projectId:<qualquer>} e viraria
      // tenant_admin de OUTRO tenant (escalada cross-tenant) além de renovar o próprio token
      // indefinidamente (bypass do TTL 6h). Portanto: aceita SÓ token estático (payload null)
      // ou zentriz_admin; rejeita svc:"runner"/tenant_admin com 403.
      if (auth.payload && auth.payload.role !== "zentriz_admin") {
        request.log.warn(
          { svc: auth.payload.svc, role: auth.payload.role, projectId: auth.payload.projectId },
          "[internal-llm] tentativa de cunhar cyborg-token por caller não-confiável (negado)",
        );
        return reply.status(403).send({
          code: "FORBIDDEN",
          message: "Apenas o control plane confiável pode cunhar tokens de projeto.",
        });
      }
      const projectId = (request.body?.projectId ?? "").trim();
      if (!projectId) return reply.status(400).send({ code: "BAD_REQUEST", message: "projectId obrigatório" });

      try {
        const r = await pool.query<{
          tenant_id: string | null; created_by: string | null;
          owner_email: string | null; owner_role: string | null;
        }>(
          `SELECT p.tenant_id, p.created_by, u.email AS owner_email, u.role AS owner_role
             FROM projects p LEFT JOIN users u ON u.id = p.created_by
            WHERE p.id = $1`,
          [projectId],
        );
        const proj = r.rows[0];
        if (!proj) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });

        // Rebaixa admin → tenant_admin (o Cyborg nunca precisa de poder global).
        const rawRole = (proj.owner_role ?? "tenant_admin").trim() || "tenant_admin";
        const role = rawRole === "zentriz_admin" ? "tenant_admin" : rawRole;
        const scoped: TokenPayload = {
          sub: proj.created_by ?? `cyborg:${projectId}`,
          email: proj.owner_email ?? "cyborg@genesis.local",
          role,
          tenantId: proj.tenant_id,
          svc: "runner",
          projectId,
        };
        // 6h: cobre uma sessão longa do Cyborg (até 60min) + reworks/retries do job.
        const token = signTokenWithExpiry(scoped, "6h");
        return reply.send({ ok: true, token, projectId, tenantId: proj.tenant_id, role });
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
