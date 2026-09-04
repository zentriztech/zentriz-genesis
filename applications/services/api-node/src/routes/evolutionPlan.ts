/**
 * evolutionPlan.ts — Evoluir E2/H2/H3: rotas da Bancada para a evolução.
 *  POST /api/projects/:id/evolution-plan            {request?} → 202 {jobId}   (job PERSISTIDO — migration 082)
 *  GET  /api/projects/:id/evolution-plan/:jobId      → {status, result?, error?}
 *  POST /api/projects/:id/evolution/republish        → reexecuta push + supersessão de uma evolução aceita cujo
 *                                                      push falhou (extra.evolution_push_pending); versão reusada.
 * Guardas: acesso ao projeto (tenant), spec editável (planner), `extra.evolution=true`, sem token de serviço,
 * 1 job vivo por filho (índice único parcial). Nada aqui promove — o humano revisa e promove.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { denyCreationForManagement } from "../middleware/managementGuard.js";
import { canAccessProjectRow, isProjectOwner } from "../lib/projectAccess.js";
import { SPEC_EDITABLE_STATUSES } from "../services/projectStatus.js";
import { httpPost } from "./specs.js";
import { createPlanJob, getPlanJob, runEvolutionPlan } from "../services/evolutionPlanner.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

type ProjRow = { id: string; tenant_id: string | null; created_by: string | null; status: string; extra: Record<string, unknown> | null };
async function loadProject(id: string): Promise<ProjRow | undefined> {
  return (await pool.query("SELECT id, tenant_id, created_by, status, extra FROM projects WHERE id = $1", [id])).rows[0] as ProjRow | undefined;
}

export async function evolutionPlanRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  app.post<{ Params: { id: string }; Body: { request?: string } }>(
    "/api/projects/:id/evolution-plan",
    { bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const user = getUser(request);
      if (denyCreationForManagement(user, reply)) return;
      if (user.svc === "runner") return reply.status(403).send({ code: "FORBIDDEN", message: "Token de serviço não planeja evolução (autoria humana)." });
      const proj = await loadProject(request.params.id);
      if (!proj || !canAccessProjectRow(user, proj)) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      if (proj.extra?.evolution !== true) return reply.status(409).send({ code: "NOT_EVOLUTION", message: "Este projeto não é uma evolução — use Evoluir no projeto aceito." });
      if (!SPEC_EDITABLE_STATUSES.has(proj.status)) return reply.status(409).send({ code: "SPEC_LOCKED", message: `Spec bloqueada: projeto em '${proj.status}'.` });
      const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim();
      if (!agentsUrl) return reply.status(503).send({ code: "AGENTS_UNAVAILABLE", message: "Serviço de agentes não configurado." });

      const requestText = typeof request.body?.request === "string" ? request.body.request.trim().slice(0, 8000) : null;
      const created = await createPlanJob(pool, proj.id, user.id, requestText);
      if (!created.ok) return reply.status(409).send({ code: "PLAN_IN_PROGRESS", message: "Já existe um planejamento em andamento para esta evolução.", jobId: created.job.id });
      const job = created.job;
      const base = agentsUrl.replace(/\/$/, "");
      void runEvolutionPlan(pool, job, requestText, (body) => httpPost(`${base}/invoke/raw`, JSON.stringify(body), 300_000))
        .catch(async (e) => {
          await pool.query("UPDATE evolution_plan_jobs SET status='error', error=$2, finished_at=now(), updated_at=now() WHERE id=$1 AND status IN ('pending','running')",
            [job.id, (e instanceof Error ? e.message : String(e)).slice(0, 300)]).catch(() => {});
        });
      return reply.status(202).send({ jobId: job.id, status: job.status });
    },
  );

  app.get<{ Params: { id: string; jobId: string } }>(
    "/api/projects/:id/evolution-plan/:jobId",
    async (request, reply) => {
      const user = getUser(request);
      if (!/^[0-9a-f-]{36}$/i.test(request.params.jobId)) return reply.status(404).send({ code: "NOT_FOUND", message: "Job não encontrado." });
      const job = await getPlanJob(pool, request.params.jobId);
      if (!job || job.projectId !== request.params.id) return reply.status(404).send({ code: "NOT_FOUND", message: "Job não encontrado." });
      if (job.ownerUserId !== user.id && user.role !== "zentriz_admin") return reply.status(404).send({ code: "NOT_FOUND", message: "Job não encontrado." });
      return reply.send({ jobId: job.id, status: job.status, result: job.result ?? null, error: job.error ?? null, createdAt: job.createdAt, finishedAt: job.finishedAt ?? null });
    },
  );

  // Bloco 3 F4 — estado da evolução para o painel do portal. Lê o checkpoint do runner (volume compartilhado
  // `.runner-state`, read-only; só campos projetados — nunca `artifacts`) + o que o aceite gravou em `extra`.
  // Sem checkpoint (runner ainda não rodou / volume ausente) → devolve só o `extra`, com `checkpoint: false`.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/evolution-state",
    async (request, reply) => {
      const user = getUser(request);
      const proj = await loadProject(request.params.id);
      if (!proj || !canAccessProjectRow(user, proj)) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      const ex = proj.extra ?? {};
      if (ex.evolution !== true) return reply.status(409).send({ code: "NOT_EVOLUTION", message: "Este projeto não é uma evolução." });
      const filesRoot = (process.env.PROJECT_FILES_ROOT ?? "").trim();
      let checkpoint: Record<string, unknown> | null = null;
      if (filesRoot) {
        try {
          const { readFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const raw = await readFile(join(filesRoot, ".runner-state", proj.id, "checkpoint.json"), "utf-8");
          checkpoint = JSON.parse(raw) as Record<string, unknown>;
        } catch { checkpoint = null; }
      }
      const pick = <T,>(k: string, fallback: T): T => (checkpoint && k in checkpoint ? (checkpoint[k] as T) : fallback);
      const violations = pick<Record<string, string[]>>("evolution_violations", {});
      return reply.send({
        projectId: proj.id,
        checkpoint: !!checkpoint,
        checkpointSavedAt: pick<string | null>("saved_at", null),
        scope: (ex.evolution_scope as string[] | undefined) ?? pick<string[]>("evolution_scope", []),
        compat: (ex.evolution_compat as string | undefined) ?? pick<string | null>("evolution_compat", null),
        rfcs: (ex.evolution_rfcs as string[] | undefined) ?? [],
        plan: (ex.evolution_plan as Record<string, unknown> | undefined) ?? null,
        request: (ex.evolution_request_original as string | undefined) ?? (ex.evolution_request as string | undefined) ?? null,
        parentId: (ex.evolution_parent_id as string | undefined) ?? null,
        touchedFiles: pick<string[]>("evolution_touched_files", []).slice(0, 500),
        violations: Object.fromEntries(Object.entries(violations).map(([k, v]) => [k, (Array.isArray(v) ? v : []).slice(-20)])),
        violationRounds: pick<Record<string, number>>("evolution_violation_rounds", {}),
        completedTasks: pick<string[]>("completed_tasks", []),
        baseline: pick<Record<string, unknown> | null>("evolution_baseline", null),
        publish: {
          pending: ex.evolution_push_pending === true,
          branch: (ex.evolution_branch as string | undefined) ?? null,
          repo: (ex.evolution_repo as string | undefined) ?? null,
          prUrl: (ex.evolution_pr_url as string | undefined) ?? null,
          compareUrl: (ex.evolution_compare_url as string | undefined) ?? null,
          version: (ex.evolution_version as string | undefined) ?? null,
          supersedes: (ex.supersedes as string | undefined) ?? null,
          acceptedAt: (ex.evolution_accepted_at as string | undefined) ?? null,
        },
      });
    },
  );

  // H7 — "Novo RFC a partir do modelo": cria docs/rfc/RFC-NNNN-<slug>.md numerado (por produto) com o template.
  app.post<{ Params: { id: string }; Body: { slug?: string; title?: string } }>(
    "/api/projects/:id/rfc-from-template",
    { bodyLimit: 16 * 1024 },
    async (request, reply) => {
      const user = getUser(request);
      if (denyCreationForManagement(user, reply)) return;
      if (user.svc === "runner") return reply.status(403).send({ code: "FORBIDDEN", message: "Token de serviço não edita spec (autoria humana)." });
      const proj = await loadProject(request.params.id);
      if (!proj || !canAccessProjectRow(user, proj)) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      if (proj.extra?.evolution !== true) return reply.status(409).send({ code: "NOT_EVOLUTION", message: "RFC de evolução só em projeto de evolução (senão fica solto, sem gate)." });
      if (!SPEC_EDITABLE_STATUSES.has(proj.status)) return reply.status(409).send({ code: "SPEC_LOCKED", message: `Spec bloqueada: projeto em '${proj.status}'.` });
      const { slugify, upsertSpecFile, nextRfcNumber } = await import("../services/evolutionPlanner.js");
      const { loadRfcTemplate, RFC_DIR } = await import("../services/evolutionGate.js");
      const template = loadRfcTemplate();
      if (!template) return reply.status(404).send({ code: "TEMPLATE_UNAVAILABLE", message: "Modelo de RFC não encontrado nesta instalação." });
      const rawTitle = typeof request.body?.title === "string" ? request.body.title.trim().slice(0, 140) : "";
      const slug = slugify(typeof request.body?.slug === "string" && request.body.slug.trim() ? request.body.slug : rawTitle || "nova-funcionalidade");
      const num = await nextRfcNumber(pool, proj.id);
      const filename = `RFC-${String(num).padStart(4, "0")}-${slug}.md`;
      const relPath = `${RFC_DIR}/${filename}`;
      const body = template.replace(/^#\s+[^\n]*\n?/, "").trimStart();
      const content = `# RFC-${String(num).padStart(4, "0")} — ${rawTitle || "<título da funcionalidade>"}\n\n> Criado a partir do modelo pela Bancada — preencha TODAS as seções; o gate exige critérios Gherkin e \`## Impacto\` com \`files_allowed\`.\n\n${body}\n`;
      try {
        const action = await upsertSpecFile(pool, proj.id, relPath, content, false);
        if (action === "skipped") return reply.status(409).send({ code: "EXISTS", message: "Já existe um RFC com esse nome." });
        await pool.query("UPDATE projects SET spec_dirty_at = now() WHERE id = $1", [proj.id]).catch(() => {});
        return reply.status(201).send({ ok: true, path: relPath, number: num });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/BAD_PATH/.test(msg)) return reply.status(400).send({ code: "BAD_PATH", message: "Nome inválido para o RFC." });
        if (/TOO_MANY_FILES/.test(msg)) return reply.status(413).send({ code: "TOO_MANY_FILES", message: "Teto de arquivos da spec atingido." });
        throw e;
      }
    },
  );

  // H2 — ação inversa visível do push falho: republicar (tenant_admin ou dono do projeto).
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/evolution/republish",
    async (request, reply) => {
      const user = getUser(request);
      if (user.svc === "runner") return reply.status(403).send({ code: "FORBIDDEN", message: "Token de serviço não republica." });
      if (user.role === "zentriz_admin") return reply.status(403).send({ code: "MANAGEMENT_ACCOUNT", message: "Conta de gestão não publica código do tenant." });
      const proj = await loadProject(request.params.id);
      if (!proj || !canAccessProjectRow(user, proj)) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
      if (user.role !== "tenant_admin" && !isProjectOwner(user, proj)) return reply.status(403).send({ code: "FORBIDDEN", message: "Só o administrador do tenant ou o dono do projeto republica." });
      if (proj.extra?.evolution !== true) return reply.status(409).send({ code: "NOT_EVOLUTION", message: "Este projeto não é uma evolução." });
      if (proj.status !== "accepted") return reply.status(409).send({ code: "NOT_ACCEPTED", message: "Só evoluções aceitas podem ser republicadas." });
      if (proj.extra?.evolution_push_pending !== true) return reply.status(409).send({ code: "NOTHING_PENDING", message: "Não há publicação pendente para esta evolução." });
      const { runEvolutionAcceptFlow } = await import("../services/evolutionAccept.js");
      // Síncrono e best-effort (push pode levar dezenas de segundos; sem fila): devolve o estado final.
      await runEvolutionAcceptFlow(pool, proj.id, { republish: true });
      const after = await loadProject(proj.id);
      const pending = after?.extra?.evolution_push_pending === true;
      return reply.status(pending ? 502 : 200).send({
        ok: !pending, pending,
        message: pending ? "A publicação falhou de novo — veja o histórico do projeto para o motivo." : "Evolução publicada; versão anterior supersedida.",
        version: after?.extra?.evolution_version ?? null,
      });
    },
  );
}
