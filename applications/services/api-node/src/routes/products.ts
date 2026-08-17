/**
 * products.ts — CRUD de Produtos (grupos de projetos) + links entre projetos + gatilhos.
 *
 * GET    /api/products                           — listar produtos do tenant
 * POST   /api/products                           — criar produto
 * GET    /api/products/:id                       — detalhe + projetos do produto
 * PATCH  /api/products/:id                       — atualizar nome/descrição
 * DELETE /api/products/:id                       — arquivar produto
 *
 * POST   /api/products/:id/projects/:projectId   — adicionar projeto ao produto
 * DELETE /api/products/:id/projects/:projectId   — remover projeto do produto
 *
 * PATCH  /api/projects/:id/product               — associar projeto a produto (pós-criação)
 *
 * GET    /api/projects/:id/triggers              — listar gatilhos de um projeto
 * POST   /api/projects/:id/triggers              — criar gatilho (trigger_project_id + trigger_status)
 * DELETE /api/projects/:id/triggers/:triggerId   — remover gatilho
 *
 * GET    /api/projects/:id/links                 — listar links de um projeto
 * POST   /api/projects/:id/links                 — criar link entre projetos
 * DELETE /api/projects/:id/links/:linkId         — remover link
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { denyCreationForManagement } from "../middleware/managementGuard.js";
import { extractProductZip, httpPost, httpGet, type ProductZipContents } from "./specs.js";
import { decomposeProduct } from "../services/productDecomposer.js";
import { buildProductSketch, parseManifest, ManifestError, type ProductManifest } from "../services/productManifest.js";
import { dispatchProjectRun } from "../services/runnerDispatch.js";

function getUser(r: FastifyRequest): AuthUser {
  return (r as unknown as { user: AuthUser }).user;
}

const RELATION_TYPES = ["uses_backend","shares_auth","shares_db","depends_on","related","part_of"] as const;
type RelationType = typeof RELATION_TYPES[number];

const RELATION_LABELS: Record<RelationType, string> = {
  uses_backend: "Consome backend",
  shares_auth:  "Compartilha autenticação",
  shares_db:    "Compartilha banco de dados",
  depends_on:   "Depende de",
  related:      "Relacionado",
  part_of:      "Componente de",
};

// ── D-1: in-memory job store para /api/products/propose (transiente, sem DB) ────
type ProposeStatus = "pending" | "running" | "done" | "error";
interface ProposeJob {
  id: string;
  status: ProposeStatus;
  manifest?: ProductManifest;
  specs?: Record<string, string>;
  waves?: string[][];
  projects?: Array<{ id: string; type: string; wave: number; dependsOn: string[] }>;
  warnings?: string[];
  error?: string;
  createdAt: number;
}
const _proposeJobs = new Map<string, ProposeJob>();

// Limpa jobs com mais de 30 minutos.
setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, job] of _proposeJobs) if (job.createdAt < cutoff) _proposeJobs.delete(id);
}, 5 * 60_000);

/**
 * Roda a proposta do splitter em background: chama o Product Architect no serviço agents
 * (job async + poll), e ao concluir valida o grafo no lado TS (buildProductSketch reusa os
 * MESMOS gates: DAG/tipos/spec presente) e computa as ondas. Não persiste nada — só a proposta.
 */
function runProposeJob(jobId: string, document: string, modelId: string | undefined, agentsUrl: string): void {
  const job = _proposeJobs.get(jobId);
  if (!job) return;
  job.status = "running";
  const base = agentsUrl.replace(/\/$/, "");
  const startedAt = Date.now();
  const MAX_MS = 660_000; // 11 min

  const payload = JSON.stringify({ document, ...(modelId ? { model_id: modelId } : {}) });
  httpPost(`${base}/invoke/product_architect/async`, payload, 30_000)
    .then((startText) => {
      const agentsJobId = (JSON.parse(startText) as { jobId?: string }).jobId;
      if (!agentsJobId) throw new Error("agents /invoke/product_architect/async não retornou jobId");
      console.log(`[Propose] job=${jobId} agents_job=${agentsJobId} started`);

      const timer = setInterval(() => {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        if (elapsed > MAX_MS / 1000) {
          clearInterval(timer);
          const j = _proposeJobs.get(jobId);
          if (j) { j.status = "error"; j.error = "Timeout: Product Architect demorou mais de 11 minutos."; }
          return;
        }
        httpGet(`${base}/invoke/product_architect/status/${agentsJobId}`, 60_000)
          .then((pollText) => {
            const poll = JSON.parse(pollText) as {
              status: string;
              result?: { manifest?: ProductManifest; specs?: Record<string, string>; warnings?: string[] };
              error?: string;
            };
            const j = _proposeJobs.get(jobId);
            if (!j) { clearInterval(timer); return; }
            if (poll.status === "done" && poll.result?.manifest && poll.result?.specs) {
              clearInterval(timer);
              try {
                const manifest = poll.result.manifest;
                const specs = poll.result.specs;
                // Valida o grafo no lado TS e computa as ondas (double-check dos gates).
                const parsed = parseManifest(JSON.stringify(manifest));
                const sketch = buildProductSketch(parsed, Object.keys(specs));
                j.manifest = manifest;
                j.specs = specs;
                j.waves = sketch.waves;
                j.projects = sketch.projects.map((p) => ({ id: p.id, type: p.type, wave: p.wave, dependsOn: p.dependsOn }));
                j.warnings = poll.result.warnings ?? [];
                j.status = "done";
                console.log(`[Propose] ✓ job=${jobId} DONE — ${sketch.projects.length} projetos, ${sketch.waves.length} ondas`);
              } catch (e) {
                j.status = "error";
                j.error = e instanceof ManifestError ? `[${e.code}] ${e.message}` : (e instanceof Error ? e.message : String(e));
              }
            } else if (poll.status === "error") {
              clearInterval(timer);
              j.status = "error";
              j.error = poll.error ?? "Product Architect falhou";
            }
          })
          .catch((pollErr) => {
            console.warn(`[Propose] poll error job=${jobId}: ${pollErr instanceof Error ? pollErr.message : String(pollErr)}`);
          });
      }, 8_000);
    })
    .catch((err) => {
      const j = _proposeJobs.get(jobId);
      if (j) { j.status = "error"; j.error = err instanceof Error ? err.message.slice(0, 300) : String(err); }
    });
}

export async function productRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  // ── GET /api/products ────────────────────────────────────────────────────────
  app.get("/api/products", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId) return reply.send([]);
    const client = await pool.connect();
    try {
      const res = await client.query(
        `SELECT p.id, p.name, p.description, p.status, p.lifecycle_status, p.created_at,
                COUNT(proj.id)::int AS project_count
         FROM products p
         LEFT JOIN projects proj ON proj.product_id = p.id
         WHERE p.tenant_id = $1 AND p.status = 'active'
         GROUP BY p.id ORDER BY p.created_at DESC`,
        [user.tenantId]
      );
      return reply.send(res.rows);
    } finally { client.release(); }
  });

  // ── POST /api/products ───────────────────────────────────────────────────────
  app.post("/api/products", async (request, reply) => {
    const user = getUser(request);
    // RFC-0002 A.1: conta de gestão (zentriz_admin) não cria produto.
    if (denyCreationForManagement(user, reply)) return;
    if (!user.tenantId) return reply.status(403).send({ code: "FORBIDDEN" });
    const { name, description } = request.body as Record<string, string>;
    if (!name?.trim()) return reply.status(400).send({ code: "BAD_REQUEST", message: "name obrigatório" });
    const client = await pool.connect();
    try {
      const res = await client.query(
        `INSERT INTO products (tenant_id, created_by, name, description)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [user.tenantId, user.id, name.trim(), description?.trim() ?? null]
      );
      return reply.status(201).send(res.rows[0]);
    } finally { client.release(); }
  });

  // ── POST /api/products/ingest ──────────────────────────────────────────────────
  // ADR-018 / Cenário A: ingere UM ZIP com PRODUCT.json + N specs → cria produto +
  // N projetos + arestas do grafo (project_triggers), numa transação. Retorna os
  // projectIds da onda 0 (`dispatched`) para o chamador acionar POST /run (reusa o
  // /run endurecido em vez de duplicar rate-limit/gates). Ondas seguintes disparam
  // pela cascata de accept existente.
  app.post("/api/products/ingest", async (request, reply) => {
    const user = getUser(request);
    // RFC-0002 A.1: conta de gestão não ingere produto; sem fallback "primeiro tenant" (M6).
    if (denyCreationForManagement(user, reply)) return;
    const tenantId = user.tenantId;
    if (!tenantId) return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant obrigatório" });

    // multipart: pega a parte-arquivo .zip e o campo opcional specApproved
    type Part = {
      filename?: string; mimetype?: string;
      toBuffer(): Promise<Buffer>;
      fields?: Record<string, { value?: unknown } | { value?: unknown }[]>;
    };
    const req = request as unknown as { file: () => Promise<Part | undefined> };
    let zipBuffer: Buffer | null = null;
    let specApprovedOverride: boolean | undefined;
    let part: Part | undefined;
    while ((part = await req.file())) {
      if (part.fields?.specApproved !== undefined) {
        const f = part.fields.specApproved;
        const v = Array.isArray(f) ? f[0] : f;
        const raw = v && typeof (v as { value?: string }).value === "string" ? (v as { value: string }).value.trim().toLowerCase() : "";
        if (["true", "1", "on", "yes"].includes(raw)) specApprovedOverride = true;
      }
      if (part.filename && part.filename.toLowerCase().endsWith(".zip")) {
        zipBuffer = await part.toBuffer();
      } else if (part.filename) {
        await part.toBuffer(); // drena partes não-zip
      }
    }
    if (!zipBuffer) return reply.status(400).send({ code: "BAD_REQUEST", message: "Envie um arquivo .zip do produto (com PRODUCT.json na raiz)." });

    const contents = extractProductZip(zipBuffer);
    if (!contents) {
      return reply.status(400).send({
        code: "NO_PRODUCT_MANIFEST",
        message: "ZIP sem PRODUCT.json na raiz. Para um único projeto, use POST /api/specs. Para um produto multi-projeto, inclua PRODUCT.json (ver ADR-018).",
      });
    }

    try {
      const result = await decomposeProduct(pool, {
        tenantId,
        createdBy: user.id,
        approverEmail: user.email ?? null,
        zip: contents,
        specApprovedOverride,
      });
      // Reingestão idempotente (mesmo produto já existe): no-op, 200, sem disparar nada.
      if (result.idempotentReuse) {
        request.log.info({ productId: result.productId }, "[products/ingest] no-op idempotente (produto já ingerido)");
        return reply.status(200).send(result);
      }
      // Dispara a ONDA 0 automaticamente (projetos sem predecessor). As ondas
      // seguintes disparam pela cascata de accept existente. Best-effort em background.
      setImmediate(async () => {
        for (const pid of result.dispatched) {
          try {
            const r = await dispatchProjectRun(pool, pid);
            request.log.info({ projectId: pid, dispatched: r.dispatched, reason: r.reason }, "[products/ingest] disparo onda 0");
          } catch (e) {
            request.log.error({ projectId: pid, err: e }, "[products/ingest] falha ao disparar onda 0");
          }
        }
      });
      return reply.status(201).send(result);
    } catch (e) {
      if (e instanceof ManifestError) {
        return reply.status(422).send({ code: e.code, message: e.message, details: e.details });
      }
      request.log.error({ err: e }, "[products/ingest] falha na decomposição");
      return reply.status(500).send({ code: "INGEST_FAILED", message: e instanceof Error ? e.message : "Erro na ingestão do produto" });
    }
  });

  // ── D-1: SPLITTER doc→N — POST /api/products/propose (async) ───────────────────
  // ADR-018 / Cenário A (submodo SPLITTER): recebe UM documento em prosa, chama o
  // Product Architect (serviço agents) e devolve uma PROPOSTA (manifest + specs geradas +
  // ondas do grafo). NÃO executa nada — o humano revisa e depois aprova via /ingest-proposal.
  // Job-based (igual spec-preview): a decomposição é um LLM call longo → não segura a conexão.
  app.post<{ Body: { document?: string; modelId?: string } }>(
    "/api/products/propose",
    async (request, reply) => {
      // RFC-0002 A.1: conta de gestão (zentriz_admin) não propõe/decompõe produto.
      if (denyCreationForManagement(getUser(request), reply)) return;
      const body = request.body ?? {};
      const document = (body.document ?? "").trim();
      if (document.length < 40) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Envie o documento do produto com pelo menos 40 caracteres." });
      }
      const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim();
      if (!agentsUrl) {
        return reply.status(503).send({ code: "SERVICE_UNAVAILABLE", message: "Serviço de agentes (Product Architect) não configurado." });
      }
      const jobId = `paj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      _proposeJobs.set(jobId, { id: jobId, status: "pending", createdAt: Date.now() });
      runProposeJob(jobId, document, body.modelId, agentsUrl);
      return reply.status(202).send({ jobId, status: "pending" });
    }
  );

  // ── GET /api/products/propose/:jobId — poll da proposta ────────────────────────
  app.get<{ Params: { jobId: string } }>(
    "/api/products/propose/:jobId",
    async (request, reply) => {
      const job = _proposeJobs.get(request.params.jobId);
      if (!job) return reply.status(404).send({ code: "NOT_FOUND", message: "Job não encontrado ou expirado" });
      if (job.status === "done") {
        return reply.send({
          jobId: job.id, status: "done", needsHuman: true,
          manifest: job.manifest, specs: job.specs, waves: job.waves, projects: job.projects, warnings: job.warnings,
        });
      }
      if (job.status === "error") return reply.send({ jobId: job.id, status: "error", error: job.error });
      const elapsed = Math.round((Date.now() - job.createdAt) / 1000);
      return reply.send({ jobId: job.id, status: job.status, elapsed });
    }
  );

  // ── POST /api/products/ingest-proposal — ingere a proposta APROVADA ────────────
  // Recebe {manifest, specs, specApproved} JSON (o que /propose devolveu, após revisão
  // humana) e reusa o executor determinístico (decomposeProduct) SEM exigir um ZIP:
  // monta o ProductZipContents em memória. Depois dispara a onda 0 (igual /ingest).
  app.post<{ Body: { manifest?: ProductManifest; specs?: Record<string, string>; specApproved?: boolean } }>(
    "/api/products/ingest-proposal",
    async (request, reply) => {
      const user = getUser(request);
      // RFC-0002 A.1: conta de gestão (zentriz_admin) não ingere proposta de produto.
      if (denyCreationForManagement(user, reply)) return;
      // RFC-0002 A.1 (M6): sem fallback para "primeiro tenant" — exige tenant do chamador.
      const tenantId = user.tenantId;
      if (!tenantId) return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant obrigatório" });

      const { manifest, specs, specApproved } = request.body ?? {};
      if (!manifest || typeof manifest !== "object" || !specs || typeof specs !== "object") {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "manifest + specs (mapa caminho→conteúdo) são obrigatórios." });
      }

      // Monta o ProductZipContents em memória a partir da proposta (sem ZIP real).
      const contents: ProductZipContents = {
        manifestText: JSON.stringify(manifest),
        files: new Map(Object.entries(specs).map(([k, v]) => [k.replace(/^\.\//, ""), String(v)])),
      };

      try {
        const result = await decomposeProduct(pool, {
          tenantId,
          createdBy: user.id,
          approverEmail: user.email ?? null,
          zip: contents,
          specApprovedOverride: specApproved === true ? true : undefined,
        });
        if (result.idempotentReuse) {
          request.log.info({ productId: result.productId }, "[products/ingest-proposal] no-op idempotente");
          return reply.status(200).send(result);
        }
        // Dispara a ONDA 0 (mesma cascata do /ingest). Best-effort em background.
        setImmediate(async () => {
          for (const pid of result.dispatched) {
            try {
              const r = await dispatchProjectRun(pool, pid);
              request.log.info({ projectId: pid, dispatched: r.dispatched, reason: r.reason }, "[products/ingest-proposal] disparo onda 0");
            } catch (e) {
              request.log.error({ projectId: pid, err: e }, "[products/ingest-proposal] falha ao disparar onda 0");
            }
          }
        });
        return reply.status(201).send(result);
      } catch (e) {
        if (e instanceof ManifestError) {
          return reply.status(422).send({ code: e.code, message: e.message, details: e.details });
        }
        request.log.error({ err: e }, "[products/ingest-proposal] falha na decomposição");
        return reply.status(500).send({ code: "INGEST_FAILED", message: e instanceof Error ? e.message : "Erro na ingestão da proposta" });
      }
    }
  );

  // ── GET /api/products/:id ────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/products/:id", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const prod = await client.query(
        "SELECT * FROM products WHERE id = $1 AND tenant_id = $2",
        [id, user.tenantId ?? ""]
      );
      if (!prod.rows[0]) return reply.status(404).send({ code: "NOT_FOUND" });

      // Ordenação topológica: projetos raiz (sem predecessores) primeiro,
      // depois seus dependentes em ordem de profundidade no grafo de triggers.
      // Dentro do mesmo nível (depth), ordena por created_at para estabilidade.
      const projects = await client.query(
        `WITH RECURSIVE topo AS (
           -- Nível 0: projetos sem predecessores dentro do produto
           SELECT p.id, 0 AS depth
           FROM projects p
           WHERE p.product_id = $1
             AND NOT EXISTS (
               SELECT 1 FROM project_triggers pt
               WHERE pt.project_id = p.id
                 AND pt.trigger_project_id IN (
                   SELECT id FROM projects WHERE product_id = $1
                 )
             )
           UNION ALL
           -- Nível N: projetos cujos predecessores já foram visitados
           SELECT p.id, t.depth + 1
           FROM projects p
           JOIN project_triggers pt ON pt.project_id = p.id
           JOIN topo t ON t.id = pt.trigger_project_id
           WHERE p.product_id = $1
         ),
         depths AS (
           -- Para projetos com múltiplos predecessores, usar a profundidade máxima
           SELECT id, MAX(depth) AS depth FROM topo GROUP BY id
         )
         SELECT p.id, p.title, p.status, p.version_number,
                p.extra->>'project_type' AS project_type,
                p.complexity_hint, p.started_at, p.completed_at, p.updated_at, p.created_at,
                COALESCE(d.depth, 0) AS execution_order,
                gr.repo_url, gr.repo_full_name, dep.app_url AS deploy_url, dep.status AS deploy_status,
                COALESCE(
                  json_agg(
                    json_build_object(
                      'id', pt.id,
                      'triggerProjectId', pt.trigger_project_id,
                      'triggerStatus', pt.trigger_status
                    ) ORDER BY pt.created_at
                  ) FILTER (WHERE pt.id IS NOT NULL),
                  '[]'::json
                ) AS triggers
         FROM projects p
         LEFT JOIN depths d ON d.id = p.id
         LEFT JOIN project_triggers pt ON pt.project_id = p.id
         LEFT JOIN project_github_repos gr ON gr.project_id = p.id
         LEFT JOIN LATERAL (
           SELECT app_url, status FROM ephemeral_deployments e
           WHERE e.project_id = p.id AND e.status IN ('provisioning','running','running_degraded')
           ORDER BY e.created_at DESC LIMIT 1
         ) dep ON true
         WHERE p.product_id = $1
         GROUP BY p.id, d.depth, gr.repo_url, gr.repo_full_name, dep.app_url, dep.status
         ORDER BY COALESCE(d.depth, 0) ASC, p.created_at ASC`,
        [id]
      );
      return reply.send({ ...prod.rows[0], projects: projects.rows });
    } finally { client.release(); }
  });

  // ── DELETE /api/products/:id ─────────────────────────────────────────────────
  // Remove produto e todos os projetos filhos do banco. Arquivos em disco mantidos.
  // Bloqueia se algum projeto filho estiver em execução (running).
  app.delete<{ Params: { id: string } }>("/api/products/:id", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const prod = await client.query(
        "SELECT id, name, tenant_id FROM products WHERE id = $1",
        [id]
      );
      const row = prod.rows[0];
      if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Produto não encontrado" });
      if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
      }

      // Bloquear se algum filho estiver rodando
      const running = await client.query(
        "SELECT id, title FROM projects WHERE product_id = $1 AND status = 'running'",
        [id]
      );
      if (running.rows.length > 0) {
        return reply.status(409).send({
          code: "CONFLICT",
          message: `Pare o pipeline antes de excluir. Projetos em execução: ${running.rows.map((r) => r.title).join(", ")}`,
        });
      }

      // Contar projetos filhos antes de remover
      const countRes = await client.query("SELECT COUNT(*) AS n FROM projects WHERE product_id = $1", [id]);
      const projectCount = Number(countRes.rows[0]?.n ?? 0);

      // ON DELETE CASCADE remove projetos e todas as tabelas filhas (tasks, diálogos, etc.)
      await client.query("DELETE FROM products WHERE id = $1", [id]);

      return reply.send({
        ok: true,
        productId: id,
        projectsDeleted: projectCount,
        message: `Produto e ${projectCount} projeto(s) removidos do banco. Arquivos em disco mantidos.`,
      });
    } finally {
      client.release();
    }
  });

  // ── PATCH /api/products/:id ──────────────────────────────────────────────────
  app.patch<{ Params: { id: string } }>("/api/products/:id", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const { name, description, status } = request.body as Record<string, string>;
    const client = await pool.connect();
    try {
      const res = await client.query(
        `UPDATE products SET
           name        = COALESCE($1, name),
           description = COALESCE($2, description),
           status      = COALESCE($3, status),
           updated_at  = NOW()
         WHERE id = $4 AND tenant_id = $5 RETURNING *`,
        [name?.trim() ?? null, description?.trim() ?? null, status ?? null, id, user.tenantId ?? ""]
      );
      if (!res.rows[0]) return reply.status(404).send({ code: "NOT_FOUND" });
      return reply.send(res.rows[0]);
    } finally { client.release(); }
  });

  // ── POST /api/products/:id/projects/:projectId ───────────────────────────────
  app.post<{ Params: { id: string; projectId: string } }>(
    "/api/products/:id/projects/:projectId",
    async (request, reply) => {
      const user = getUser(request);
      const { id: productId, projectId } = request.params;
      const client = await pool.connect();
      try {
        // verify product belongs to tenant
        const prod = await client.query("SELECT id FROM products WHERE id=$1 AND tenant_id=$2", [productId, user.tenantId ?? ""]);
        if (!prod.rows[0]) return reply.status(404).send({ code: "NOT_FOUND", message: "Produto não encontrado" });
        await client.query(
          "UPDATE projects SET product_id=$1, updated_at=NOW() WHERE id=$2 AND tenant_id=$3",
          [productId, projectId, user.tenantId ?? ""]
        );
        return reply.send({ ok: true });
      } finally { client.release(); }
    }
  );

  // ── DELETE /api/products/:id/projects/:projectId ─────────────────────────────
  app.delete<{ Params: { id: string; projectId: string } }>(
    "/api/products/:id/projects/:projectId",
    async (request, reply) => {
      const user = getUser(request);
      const { projectId } = request.params;
      const client = await pool.connect();
      try {
        await client.query(
          "UPDATE projects SET product_id=NULL, updated_at=NOW() WHERE id=$1 AND tenant_id=$2",
          [projectId, user.tenantId ?? ""]
        );
        return reply.send({ ok: true });
      } finally { client.release(); }
    }
  );

  // ── GET /api/projects/:id/links ───────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/projects/:id/links", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const res = await client.query(
        `SELECT pl.id, pl.relation_type, pl.note, pl.created_at,
                pl.from_project_id, pl.to_project_id,
                pf.title AS from_title, pf.status AS from_status,
                pf.extra->>'project_type' AS from_project_type,
                pt.title AS to_title,   pt.status AS to_status,
                pt.extra->>'project_type' AS to_project_type
         FROM project_links pl
         JOIN projects pf ON pf.id = pl.from_project_id
         JOIN projects pt ON pt.id = pl.to_project_id
         WHERE (pl.from_project_id = $1 OR pl.to_project_id = $1)
           AND (pf.tenant_id = $2 OR pt.tenant_id = $2)
         ORDER BY pl.created_at DESC`,
        [id, user.tenantId ?? ""]
      );
      return reply.send(res.rows.map(r => ({
        ...r,
        relation_label: RELATION_LABELS[r.relation_type as RelationType] ?? r.relation_type,
        direction: r.from_project_id === id ? "outgoing" : "incoming",
      })));
    } finally { client.release(); }
  });

  // ── POST /api/projects/:id/links ──────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/projects/:id/links", async (request, reply) => {
    const user = getUser(request);
    const { id: fromId } = request.params;
    const { to_project_id, relation_type = "related", note } = request.body as Record<string, string>;
    if (!to_project_id) return reply.status(400).send({ code: "BAD_REQUEST", message: "to_project_id obrigatório" });
    if (!RELATION_TYPES.includes(relation_type as RelationType)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: `relation_type inválido. Permitidos: ${RELATION_TYPES.join(", ")}` });
    }
    const client = await pool.connect();
    try {
      const res = await client.query(
        `INSERT INTO project_links (from_project_id, to_project_id, relation_type, note)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (from_project_id, to_project_id) DO UPDATE
           SET relation_type=$3, note=$4
         RETURNING *`,
        [fromId, to_project_id, relation_type, note?.trim() ?? null]
      );
      return reply.status(201).send(res.rows[0]);
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (msg.includes("project_links_no_self")) return reply.status(400).send({ code: "BAD_REQUEST", message: "Não é possível linkar um projeto a si mesmo" });
      throw e;
    } finally { client.release(); }
  });

  // ── DELETE /api/projects/:id/links/:linkId ────────────────────────────────────
  app.delete<{ Params: { id: string; linkId: string } }>(
    "/api/projects/:id/links/:linkId",
    async (request, reply) => {
      const { linkId } = request.params;
      const client = await pool.connect();
      try {
        await client.query("DELETE FROM project_links WHERE id=$1", [linkId]);
        return reply.send({ ok: true });
      } finally { client.release(); }
    }
  );

  // ── PATCH /api/projects/:id/product — associar projeto a produto pós-criação ─
  app.patch<{ Params: { id: string }; Body: { productId: string | null } }>(
    "/api/projects/:id/product",
    async (request, reply) => {
      const user = getUser(request);
      const { id } = request.params;
      const { productId } = request.body ?? {};
      const client = await pool.connect();
      try {
        const proj = (await client.query("SELECT id, tenant_id FROM projects WHERE id=$1", [id])).rows[0];
        if (!proj) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
        if (user.role !== "zentriz_admin" && proj.tenant_id !== user.tenantId) {
          return reply.status(403).send({ code: "FORBIDDEN" });
        }
        if (productId) {
          const prod = (await client.query("SELECT id FROM products WHERE id=$1 AND tenant_id=$2", [productId, user.tenantId ?? ""])).rows[0];
          if (!prod) return reply.status(404).send({ code: "NOT_FOUND", message: "Produto não encontrado" });
        }
        await client.query("UPDATE projects SET product_id=$1, updated_at=NOW() WHERE id=$2", [productId ?? null, id]);
        return reply.send({ ok: true, productId: productId ?? null });
      } finally { client.release(); }
    }
  );

  // ── GET /api/projects/:id/triggers ───────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/projects/:id/triggers", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const client = await pool.connect();
    try {
      const proj = (await client.query("SELECT id, tenant_id FROM projects WHERE id=$1", [id])).rows[0];
      if (!proj) return reply.status(404).send({ code: "NOT_FOUND" });
      if (user.role !== "zentriz_admin" && proj.tenant_id !== user.tenantId) {
        return reply.status(403).send({ code: "FORBIDDEN" });
      }
      const res = await client.query(
        `SELECT pt.id, pt.trigger_project_id, pt.trigger_status, pt.created_at,
                p.title AS trigger_project_title, p.status AS trigger_project_status
         FROM project_triggers pt
         JOIN projects p ON p.id = pt.trigger_project_id
         WHERE pt.project_id = $1 ORDER BY pt.created_at`,
        [id]
      );
      return reply.send(res.rows);
    } finally { client.release(); }
  });

  // ── POST /api/projects/:id/triggers ──────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: { triggerProjectId: string; triggerStatus: string } }>(
    "/api/projects/:id/triggers",
    async (request, reply) => {
      const user = getUser(request);
      const { id } = request.params;
      const { triggerProjectId, triggerStatus = "accepted" } = request.body ?? {};
      if (!triggerProjectId) return reply.status(400).send({ code: "BAD_REQUEST", message: "triggerProjectId obrigatório" });
      const validStatuses = ["accepted", "completed", "done"];
      if (!validStatuses.includes(triggerStatus)) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: `triggerStatus deve ser: ${validStatuses.join(", ")}` });
      }
      const client = await pool.connect();
      try {
        const proj = (await client.query("SELECT id, tenant_id FROM projects WHERE id=$1", [id])).rows[0];
        if (!proj) return reply.status(404).send({ code: "NOT_FOUND" });
        if (user.role !== "zentriz_admin" && proj.tenant_id !== user.tenantId) {
          return reply.status(403).send({ code: "FORBIDDEN" });
        }
        const trigProj = (await client.query("SELECT id FROM projects WHERE id=$1", [triggerProjectId])).rows[0];
        if (!trigProj) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto gatilho não encontrado" });
        const res = await client.query(
          `INSERT INTO project_triggers (project_id, trigger_project_id, trigger_status)
           VALUES ($1, $2, $3)
           ON CONFLICT (project_id, trigger_project_id) DO UPDATE SET trigger_status=$3
           RETURNING *`,
          [id, triggerProjectId, triggerStatus]
        );
        return reply.status(201).send(res.rows[0]);
      } catch (e) {
        const msg = (e as Error).message ?? "";
        if (msg.includes("project_triggers_no_self")) return reply.status(400).send({ code: "BAD_REQUEST", message: "Projeto não pode ter gatilho em si mesmo" });
        throw e;
      } finally { client.release(); }
    }
  );

  // ── DELETE /api/projects/:id/triggers/:triggerId ──────────────────────────────
  app.delete<{ Params: { id: string; triggerId: string } }>(
    "/api/projects/:id/triggers/:triggerId",
    async (request, reply) => {
      const { triggerId } = request.params;
      const client = await pool.connect();
      try {
        await client.query("DELETE FROM project_triggers WHERE id=$1", [triggerId]);
        return reply.send({ ok: true });
      } finally { client.release(); }
    }
  );
}
