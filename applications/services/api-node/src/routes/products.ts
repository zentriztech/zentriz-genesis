/**
 * products.ts — CRUD de Produtos (grupos de projetos) + links entre projetos + gatilhos.
 *
 * GET    /api/products                           — listar produtos do tenant
 * POST   /api/products                           — criar produto
 * GET    /api/products/:id                       — detalhe + projetos do produto
 * PATCH  /api/products/:id                       — atualizar nome/descrição
 * DELETE /api/products/:id                       — sem projetos: apaga de verdade; com projetos: arquiva (soft)
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
import { readFile } from "node:fs/promises";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { denyCreationForManagement } from "../middleware/managementGuard.js";
import { extractProductZip, httpPost, httpGet, type ProductZipContents } from "./specs.js";
import { decomposeProduct } from "../services/productDecomposer.js";
import { buildProductSketch, parseManifest, ManifestError, type ProductManifest } from "../services/productManifest.js";
import { dispatchProjectRun } from "../services/runnerDispatch.js";
import { resolveInboxProductId, cleanupEmptySoloProduct } from "../services/inbox.js";
import { isPreFactory } from "../services/projectStatus.js";

function getUser(r: FastifyRequest): AuthUser {
  return (r as unknown as { user: AuthUser }).user;
}

/**
 * "rascunhos" (case/acento/trim-insensível) é o nome RESERVADO do INBOX do sistema
 * (migration 064). Bloqueia POST/PATCH de produto comum que tente usá-lo (§4.14).
 */
function isReservedInboxName(name: string): boolean {
  const norm = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
  return norm === "rascunhos";
}

// UUID v-agnóstico (mesmo formato usado em projects.ts/specs.ts) — valida o ?tenantId do
// master antes de usá-lo num cast ::uuid (não-UUID → 500 no Postgres), e valida params :id.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// B4: uma spec da Bancada (pré-fábrica) pode ser decomposta. Espelha SPEC_LISTING_STATUSES.
const SPEC_DECOMPOSABLE_STATUSES = new Set(["draft", "spec_submitted", "pending_conversion"]);

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
  /** B4: spec da Bancada de origem (quando o job veio de /api/projects/:id/decompose). */
  originProjectId?: string | null;
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
  // B3 (RFC-0003): o master (zentriz_admin) escopa a listagem via ?tenantId= (seletor de
  // tenant do portal), espelhando GET /api/projects e /api/specs. Sem esse fix a conta de
  // gestão recebia sempre [] → "Meus Produtos" ficava vazio permanentemente (gap U#3/C5).
  app.get("/api/products", async (request, reply) => {
    const user = getUser(request);
    const q = (request.query ?? {}) as { tenantId?: string };
    // tenantId inválido (não-UUID) é ignorado → evita erro de cast uuid (500).
    const scopeTenantId =
      user.role === "zentriz_admin" && q.tenantId && UUID_RE.test(q.tenantId) ? q.tenantId : null;
    // Não-master sem tenant não possui produtos.
    if (user.role !== "zentriz_admin" && !user.tenantId) return reply.send([]);
    const client = await pool.connect();
    try {
      const selectFragment = `
        SELECT p.id, p.name, p.description, p.status, p.lifecycle_status, p.created_at,
               COUNT(proj.id)::int AS project_count
        FROM products p
        LEFT JOIN projects proj ON proj.product_id = p.id`;
      const res =
        user.role === "zentriz_admin"
          ? await client.query(
              `${selectFragment}
               WHERE ($1::uuid IS NULL OR p.tenant_id = $1) AND p.status = 'active'
               GROUP BY p.id ORDER BY p.created_at DESC`,
              [scopeTenantId]
            )
          : await client.query(
              `${selectFragment}
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
    // §4.14 (migration 064): "Rascunhos" é reservado ao INBOX do sistema.
    if (isReservedInboxName(name)) {
      return reply.status(409).send({
        code: "RESERVED_PRODUCT_NAME",
        message: '"Rascunhos" é um nome reservado do sistema (INBOX).',
      });
    }
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
    // Caminho ZIP legado: por padrão dispara a onda 0 (dispatch=true). B1 permite opt-out
    // explícito (dispatch=false → salva só na Bancada) para o mesmo endpoint.
    let dispatchZip = true;
    let part: Part | undefined;
    const parseBoolField = (f: { value?: unknown } | { value?: unknown }[] | undefined): boolean | undefined => {
      if (f === undefined) return undefined;
      const v = Array.isArray(f) ? f[0] : f;
      const raw = v && typeof (v as { value?: string }).value === "string" ? (v as { value: string }).value.trim().toLowerCase() : "";
      if (["true", "1", "on", "yes"].includes(raw)) return true;
      if (["false", "0", "off", "no"].includes(raw)) return false;
      return undefined;
    };
    while ((part = await req.file())) {
      if (parseBoolField(part.fields?.specApproved) === true) specApprovedOverride = true;
      { const d = parseBoolField(part.fields?.dispatch); if (d !== undefined) dispatchZip = d; }
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
        dispatch: dispatchZip,
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
          // B4: eco da origem — o cliente devolve isto em /ingest-proposal para gravar o vínculo.
          originProjectId: job.originProjectId ?? null,
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
  app.post<{ Body: { manifest?: ProductManifest; specs?: Record<string, string>; specApproved?: boolean; dispatch?: boolean; originProjectId?: string } }>(
    "/api/products/ingest-proposal",
    async (request, reply) => {
      const user = getUser(request);
      // RFC-0002 A.1: conta de gestão (zentriz_admin) não ingere proposta de produto.
      if (denyCreationForManagement(user, reply)) return;
      // RFC-0002 A.1 (M6): sem fallback para "primeiro tenant" — exige tenant do chamador.
      const tenantId = user.tenantId;
      if (!tenantId) return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant obrigatório" });

      const { manifest, specs, specApproved, dispatch, originProjectId } = request.body ?? {};
      if (!manifest || typeof manifest !== "object" || !specs || typeof specs !== "object") {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "manifest + specs (mapa caminho→conteúdo) são obrigatórios." });
      }
      // B4: origem opcional (spec da Bancada). Valida UUID para não estourar o cast ::uuid
      // E confirma a POSSE — o vínculo de origem só vale se a spec for do mesmo tenant do
      // produto que está nascendo. Sem isso, um id de outro tenant viraria um vínculo
      // cross-tenant (vazamento de integridade). Origem inválida/alheia → simplesmente null
      // (produto avulso), nunca 4xx: a origem é um enriquecimento, não um requisito.
      let origin: string | null = null;
      if (originProjectId && UUID_RE.test(originProjectId)) {
        const owned = await pool.query(
          "SELECT 1 FROM projects WHERE id = $1 AND tenant_id = $2 LIMIT 1",
          [originProjectId, tenantId],
        );
        if (owned.rowCount) origin = originProjectId;
        else request.log.warn({ originProjectId, tenantId }, "[products/ingest-proposal] originProjectId de outro tenant ou inexistente — vínculo de origem descartado");
      }

      // Monta o ProductZipContents em memória a partir da proposta (sem ZIP real).
      const contents: ProductZipContents = {
        manifestText: JSON.stringify(manifest),
        files: new Map(Object.entries(specs).map(([k, v]) => [k.replace(/^\.\//, ""), String(v)])),
      };

      try {
        // RFC-0003 B1: aprovar uma decomposição do Splitter SALVA os N projetos como
        // rascunhos na Bancada (produto 'draft') SEM rodar a fábrica — mata o proposal
        // efêmero de 30 min. Só quando o cliente pede explicitamente `dispatch:true`
        // (atalho express "salvar e iniciar") a onda 0 é disparada.
        const result = await decomposeProduct(pool, {
          tenantId,
          createdBy: user.id,
          approverEmail: user.email ?? null,
          zip: contents,
          specApprovedOverride: specApproved === true ? true : undefined,
          dispatch: dispatch === true,
          originProjectId: origin,
        });
        if (result.idempotentReuse) {
          request.log.info({ productId: result.productId }, "[products/ingest-proposal] no-op idempotente");
          return reply.status(200).send(result);
        }
        // Dispara a ONDA 0 só no modo express (dispatched vazio na Bancada → no-op).
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

  // ── POST /api/projects/:id/decompose — RFC-0003 B4: decompor uma spec já salva ──
  // Decompõe uma spec que JÁ está na Bancada (linha de projects pré-fábrica) em uma
  // proposta de produto multi-projeto, reusando o Product Architect (mesmo job async de
  // /propose). Preserva: (1) ownership — o produto herdará o tenant da spec no ingest;
  // (2) multi-md — concatena TODOS os .md da spec; (3) vínculo de origem — o job carrega
  // originProjectId, gravado em products.origin_project_id no /ingest-proposal (evita
  // produto órfão, gap U#4/C7).
  app.post<{ Params: { id: string }; Body: { modelId?: string } }>(
    "/api/projects/:id/decompose",
    async (request, reply) => {
      const user = getUser(request);
      // Decompor é AUTORIA (gera specs/produto) → conta de gestão (master) vetada, igual /propose.
      if (denyCreationForManagement(user, reply)) return;
      const { id } = request.params;
      if (!UUID_RE.test(id)) return reply.status(400).send({ code: "INVALID_PROJECT_ID" });
      const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim();
      if (!agentsUrl) {
        return reply.status(503).send({ code: "SERVICE_UNAVAILABLE", message: "Serviço de agentes (Product Architect) não configurado." });
      }
      const client = await pool.connect();
      try {
        const proj = (await client.query(
          `SELECT p.id, p.tenant_id, p.created_by, p.title, p.status, p.product_id,
                  pr.is_inbox AS product_is_inbox
             FROM projects p
             LEFT JOIN products pr ON pr.id = p.product_id
            WHERE p.id = $1`, [id],
        )).rows[0];
        if (!proj) return reply.status(404).send({ code: "NOT_FOUND", message: "Spec não encontrada" });
        // Ownership: não-master só decompõe spec do próprio tenant (ou que criou).
        if (proj.tenant_id !== user.tenantId && proj.created_by !== user.id) {
          return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão sobre esta spec" });
        }
        // §4.7 (migration 064): pós-064 toda spec tem product_id (ao menos o INBOX). Só barra
        // re-decomposição se já pertence a um produto REAL (não-inbox) — evita duplicata/órfão.
        if (proj.product_id && !proj.product_is_inbox) {
          return reply.status(409).send({ code: "ALREADY_IN_PRODUCT", message: "Spec já pertence a um produto." });
        }
        // Só specs pré-fábrica podem ser decompostas.
        if (!SPEC_DECOMPOSABLE_STATUSES.has(proj.status)) {
          return reply.status(409).send({ code: "NOT_A_SPEC", message: `Só specs na Bancada podem ser decompostas (estado atual: ${proj.status}).` });
        }
        // multi-md: concatena TODOS os .md da spec (ordem de criação), tolerando arquivo sumido.
        const files = (await client.query(
          "SELECT filename, file_path FROM project_spec_files WHERE project_id = $1 AND LOWER(filename) LIKE '%.md' ORDER BY created_at ASC", [id],
        )).rows as Array<{ filename: string; file_path: string }>;
        if (files.length === 0) {
          return reply.status(422).send({ code: "NO_SPEC_FILES", message: "Spec sem arquivos markdown para decompor." });
        }
        const parts: string[] = [];
        for (const f of files) {
          try {
            const content = await readFile(f.file_path, "utf-8");
            if (content.trim()) parts.push(files.length > 1 ? `# ${f.filename}\n\n${content}` : content);
          } catch {
            request.log.warn({ file: f.file_path }, "[projects/decompose] arquivo de spec ausente no disco — ignorado");
          }
        }
        const document = parts.join("\n\n---\n\n").trim();
        if (document.length < 40) {
          return reply.status(422).send({ code: "SPEC_TOO_SHORT", message: "Conteúdo da spec insuficiente para decompor (mín. 40 caracteres legíveis)." });
        }
        // §4.7 (migration 064): fecha a janela entre o dispatch e o consumo — marca a origem
        // como pending_conversion (ainda pré-fábrica, ainda no INBOX). O decomposer consome a
        // spec (status='archived') dentro da transação, com guarda de status contra /run concorrente.
        await client.query(
          "UPDATE projects SET status='pending_conversion', updated_at=NOW() WHERE id=$1 AND status IN ('draft','spec_submitted')",
          [id],
        );
        const jobId = `paj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        _proposeJobs.set(jobId, { id: jobId, status: "pending", createdAt: Date.now(), originProjectId: id });
        runProposeJob(jobId, document, request.body?.modelId, agentsUrl);
        return reply.status(202).send({ jobId, status: "pending", originProjectId: id });
      } finally { client.release(); }
    },
  );

  // ── GET /api/products/:id ────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/products/:id", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    // B3 (RFC-0003): valida UUID (evita 500 no cast) e autoriza por papel — o master
    // abre qualquer produto; não-master só o do próprio tenant.
    if (!UUID_RE.test(id)) return reply.status(400).send({ code: "INVALID_PRODUCT_ID" });
    const client = await pool.connect();
    try {
      const prod = await client.query("SELECT * FROM products WHERE id = $1", [id]);
      if (!prod.rows[0]) return reply.status(404).send({ code: "NOT_FOUND" });
      if (user.role !== "zentriz_admin" && prod.rows[0].tenant_id !== user.tenantId) {
        return reply.status(404).send({ code: "NOT_FOUND" });
      }

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

  // ── POST /api/products/:id/promote — RFC-0003 B2: promover produto da Bancada ──
  // Promove um produto 'draft' (Bancada) para a fábrica. DISPATCH-ONLY sobre as RAÍZES
  // (projetos sem predecessores dentro do produto) — NUNCA re-decompõe (fecha o gap G1:
  // os projetos já existem como rascunhos). As ondas seguintes disparam pela cascata de
  // accept, cada uma passando pelo gate de dependência/contrato (Task 3, G3/C3). A
  // promoção INDIVIDUAL de um projeto é o /run existente: um projeto-filho 'draft' com
  // dependências não-aceitas é barrado pelo mesmo gate (DEPENDENCY_NOT_READY).
  app.post<{ Params: { id: string } }>("/api/products/:id/promote", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    if (!UUID_RE.test(id)) return reply.status(400).send({ code: "INVALID_PRODUCT_ID" });
    const client = await pool.connect();
    try {
      const prod = await client.query(
        "SELECT id, tenant_id, lifecycle_status, is_inbox FROM products WHERE id = $1", [id],
      );
      const row = prod.rows[0];
      if (!row) return reply.status(404).send({ code: "NOT_FOUND" });
      // §4.12 (migration 064): o INBOX "Rascunhos" não é promovível em bloco — cada spec
      // gradua individualmente ao rodar (/run) ou ao ser movida para um produto.
      if (row.is_inbox) {
        return reply.status(409).send({
          code: "INBOX_NOT_PROMOTABLE",
          message: "O INBOX (Rascunhos) não pode ser promovido em bloco. Promova cada spec individualmente.",
        });
      }
      // C6: o master (zentriz_admin) PODE promover qualquer produto — promover é operação,
      // não autoria (não passa por denyCreationForManagement). Não-master: só o próprio tenant.
      if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId) {
        return reply.status(404).send({ code: "NOT_FOUND" });
      }
      // Só promove da Bancada. Já em fábrica/terminal → 409 informativo (idempotente-safe).
      if (row.lifecycle_status !== "draft") {
        return reply.status(409).send({
          code: "NOT_ON_WORKBENCH",
          message: `Produto não está na Bancada (estado atual: ${row.lifecycle_status}).`,
          lifecycleStatus: row.lifecycle_status,
        });
      }
      // Raízes AINDA em rascunho (mesma definição de raiz do GET :id — predecessores só
      // contam DENTRO do produto).
      const roots = await client.query(
        `SELECT p.id FROM projects p
         WHERE p.product_id = $1 AND p.status = 'draft'
           AND NOT EXISTS (
             SELECT 1 FROM project_triggers pt
             WHERE pt.project_id = p.id
               AND pt.trigger_project_id IN (SELECT id FROM projects WHERE product_id = $1)
           )`,
        [id],
      );
      const rootIds = roots.rows.map((r) => r.id as string);
      if (rootIds.length === 0) {
        return reply.status(409).send({
          code: "NO_PROMOTABLE_ROOTS",
          message: "Nenhuma raiz em rascunho para promover (produto sem projetos ou já em andamento).",
        });
      }
      // Transição atômica draft→running: guarda contra dupla promoção concorrente
      // (rowCount 0 ⇒ outra requisição já promoveu entre o SELECT e o UPDATE).
      const upd = await client.query(
        "UPDATE products SET lifecycle_status = 'running', updated_at = now() WHERE id = $1 AND lifecycle_status = 'draft'",
        [id],
      );
      if (upd.rowCount === 0) {
        return reply.status(409).send({ code: "ALREADY_PROMOTED", message: "Produto já promovido por outra requisição." });
      }
      // Dispara as raízes (dispatch-only). Gate de dependência + claim atômico de slot
      // são aplicados por dispatchProjectRun (Task 3). Best-effort em background.
      setImmediate(async () => {
        for (const pid of rootIds) {
          try {
            const r = await dispatchProjectRun(pool, pid);
            request.log.info({ projectId: pid, dispatched: r.dispatched, reason: r.reason }, "[products/promote] disparo de raiz");
          } catch (e) {
            request.log.error({ projectId: pid, err: e }, "[products/promote] falha ao disparar raiz");
          }
        }
      });
      return reply.status(202).send({ productId: id, promoted: rootIds, lifecycleStatus: "running" });
    } finally { client.release(); }
  });

  // ── DELETE /api/products/:id ─────────────────────────────────────────────────
  // Exclusão de produto com DOIS regimes (apagar de verdade é arriscado demais quando há
  // projetos, então só é permitido no caso vazio):
  //   • SEM projetos  → HARD DELETE real (remove a linha; nada de valor se perde).
  //   • COM projetos  → SOFT DELETE: apenas marca status='archived' (some do portal, pois o
  //                     LIST filtra status='active'). Produto + projetos + histórico ficam no
  //                     banco, reversível via PATCH status='active'. NUNCA apaga de verdade.
  // Guardas de segurança (o portal reforça, mas o servidor é a autoridade):
  //   • confirmId deve reescrever EXATAMENTE o id do produto (anti-engano);
  //   • quando há projetos, acknowledge=true é OBRIGATÓRIO (a caixa "sei o que faço");
  //   • bloqueia se algum filho estiver em execução (running).
  app.delete<{ Params: { id: string }; Body: { confirmId?: string; acknowledge?: boolean } }>(
    "/api/products/:id",
    async (request, reply) => {
      const user = getUser(request);
      const { id } = request.params;
      if (!UUID_RE.test(id)) return reply.status(400).send({ code: "INVALID_PRODUCT_ID" });
      const { confirmId, acknowledge } = (request.body ?? {}) as { confirmId?: string; acknowledge?: boolean };
      const client = await pool.connect();
      try {
        const prod = await client.query(
          "SELECT id, name, tenant_id, status, is_inbox FROM products WHERE id = $1",
          [id]
        );
        const row = prod.rows[0];
        if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Produto não encontrado" });
        if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId) {
          return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
        }
        // §4.10 (migration 064): o INBOX é estrutural do tenant — nunca some (hard nem soft).
        if (row.is_inbox) {
          return reply.status(409).send({
            code: "INBOX_PROTECTED",
            message: "O INBOX (Rascunhos) é do sistema e não pode ser excluído nem arquivado.",
          });
        }

        // Confirmação obrigatória: o cliente deve reescrever o id exato (guarda anti-engano).
        if (confirmId !== id) {
          return reply.status(400).send({
            code: "CONFIRM_MISMATCH",
            message: "Confirmação inválida: reescreva o ID exato do produto para excluir.",
          });
        }

        // Bloquear se algum filho estiver rodando (vale para hard e soft).
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

        const countRes = await client.query("SELECT COUNT(*) AS n FROM projects WHERE product_id = $1", [id]);
        const projectCount = Number(countRes.rows[0]?.n ?? 0);

        // CASO 1 — sem projetos: exclusão REAL. CASCADE cuida de eventuais filhas.
        if (projectCount === 0) {
          await client.query("DELETE FROM products WHERE id = $1", [id]);
          return reply.send({
            ok: true,
            mode: "deleted",
            productId: id,
            projectsDeleted: 0,
            message: "Produto sem projetos removido definitivamente do banco.",
          });
        }

        // CASO 2 — com projetos: apagar de verdade é arriscado → exige reconhecimento e ARQUIVA.
        if (acknowledge !== true) {
          return reply.status(400).send({
            code: "ACK_REQUIRED",
            message: `Este produto tem ${projectCount} projeto(s). Marque a confirmação de que entende o que está fazendo — o produto será ocultado (arquivado), não apagado.`,
            projectCount,
          });
        }
        if (row.status === "archived") {
          return reply.send({
            ok: true,
            mode: "already_archived",
            productId: id,
            projectCount,
            message: "Produto já estava arquivado (oculto no portal).",
          });
        }
        await client.query("UPDATE products SET status = 'archived', updated_at = NOW() WHERE id = $1", [id]);
        return reply.send({
          ok: true,
          mode: "archived",
          productId: id,
          projectCount,
          message: `Produto com ${projectCount} projeto(s) ocultado do portal (arquivado). Nada foi apagado do banco — reversível.`,
        });
      } finally {
        client.release();
      }
    }
  );

  // ── PATCH /api/products/:id ──────────────────────────────────────────────────
  app.patch<{ Params: { id: string } }>("/api/products/:id", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    const { name, description, status } = request.body as Record<string, string>;
    if (!UUID_RE.test(id)) return reply.status(400).send({ code: "INVALID_PRODUCT_ID" });
    const client = await pool.connect();
    try {
      // B3 (RFC-0003): autoriza por papel (mesmo padrão do DELETE) em vez de fixar
      // tenant_id = user.tenantId (que dava 404 para o master, cujo tenantId é null).
      const owner = (await client.query("SELECT tenant_id, is_inbox FROM products WHERE id = $1", [id])).rows[0];
      if (!owner) return reply.status(404).send({ code: "NOT_FOUND" });
      if (user.role !== "zentriz_admin" && owner.tenant_id !== user.tenantId) {
        return reply.status(403).send({ code: "FORBIDDEN" });
      }
      // §4.10 (migration 064): no INBOX só a descrição é editável — nome e status são fixos.
      if (owner.is_inbox && (name !== undefined || status !== undefined)) {
        return reply.status(409).send({
          code: "INBOX_PROTECTED",
          message: "O INBOX (Rascunhos) tem nome e status fixos; apenas a descrição pode ser editada.",
        });
      }
      // §4.14: bloquear renomear um produto comum para o nome reservado do INBOX.
      if (!owner.is_inbox && name !== undefined && isReservedInboxName(name)) {
        return reply.status(409).send({
          code: "RESERVED_PRODUCT_NAME",
          message: '"Rascunhos" é um nome reservado do sistema (INBOX).',
        });
      }
      const res = await client.query(
        `UPDATE products SET
           name        = COALESCE($1, name),
           description = COALESCE($2, description),
           status      = COALESCE($3, status),
           updated_at  = NOW()
         WHERE id = $4 RETURNING *`,
        [name?.trim() ?? null, description?.trim() ?? null, status ?? null, id]
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
      if (!UUID_RE.test(productId) || !UUID_RE.test(projectId)) {
        return reply.status(400).send({ code: "INVALID_ID" });
      }
      const client = await pool.connect();
      try {
        // B3 (RFC-0003): autoriza por papel; escopa o UPDATE ao tenant do PRODUTO
        // (garante coerência produto↔projeto e funciona para o master, cujo tenantId é null).
        const prod = await client.query("SELECT id, tenant_id FROM products WHERE id=$1", [productId]);
        if (!prod.rows[0]) return reply.status(404).send({ code: "NOT_FOUND", message: "Produto não encontrado" });
        if (user.role !== "zentriz_admin" && prod.rows[0].tenant_id !== user.tenantId) {
          return reply.status(403).send({ code: "FORBIDDEN" });
        }
        await client.query(
          "UPDATE projects SET product_id=$1, updated_at=NOW() WHERE id=$2 AND tenant_id=$3",
          [productId, projectId, prod.rows[0].tenant_id]
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
      if (!UUID_RE.test(projectId)) return reply.status(400).send({ code: "INVALID_ID" });
      const client = await pool.connect();
      try {
        // B3 (RFC-0003): autoriza por papel; idempotente (projeto ausente → ok).
        const proj = (await client.query(
          "SELECT tenant_id, created_by, status, product_id FROM projects WHERE id=$1",
          [projectId],
        )).rows[0];
        if (!proj) return reply.send({ ok: true });
        if (user.role !== "zentriz_admin" && proj.tenant_id !== user.tenantId) {
          return reply.status(403).send({ code: "FORBIDDEN" });
        }
        // §4.9 (migration 064): "tirar do produto" = mover ao INBOX, SÓ se ainda for rascunho.
        // App em fábrica/terminal nunca volta ao inbox.
        if (!isPreFactory(String(proj.status))) {
          return reply.status(409).send({
            code: "APP_RUNNING_CANNOT_INBOX",
            message: "App em fábrica/terminal não pode voltar ao INBOX. Mova-o para outro produto.",
          });
        }
        const previousProductId = (proj.product_id as string | null) ?? null;
        await client.query("BEGIN");
        try {
          const inboxId = await resolveInboxProductId(
            client, String(proj.tenant_id), String(proj.created_by),
          );
          await client.query(
            "UPDATE projects SET product_id=$1, updated_at=NOW() WHERE id=$2",
            [inboxId, projectId],
          );
          if (previousProductId && previousProductId !== inboxId) {
            await cleanupEmptySoloProduct(client, previousProductId);
          }
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        }
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
        const proj = (await client.query(
          "SELECT id, tenant_id, created_by, status, product_id FROM projects WHERE id=$1",
          [id],
        )).rows[0];
        if (!proj) return reply.status(404).send({ code: "NOT_FOUND", message: "Projeto não encontrado" });
        if (user.role !== "zentriz_admin" && proj.tenant_id !== user.tenantId) {
          return reply.status(403).send({ code: "FORBIDDEN" });
        }
        const tenantId = String(proj.tenant_id);
        const previousProductId = (proj.product_id as string | null) ?? null;

        // §4.8 (migration 064): resolve o produto ALVO e se é uma operação de "inbox".
        //  • productId presente e NÃO-inbox → mover livremente (inclui App em fábrica).
        //  • productId ausente/null OU alvo é o INBOX → "mover ao inbox", SÓ se rascunho.
        let targetProductId: string;
        let movingToInbox: boolean;
        if (productId) {
          const prod = (await client.query(
            "SELECT id, is_inbox FROM products WHERE id=$1 AND tenant_id=$2",
            [productId, proj.tenant_id],
          )).rows[0];
          if (!prod) return reply.status(404).send({ code: "NOT_FOUND", message: "Produto não encontrado" });
          movingToInbox = prod.is_inbox === true;
          targetProductId = String(prod.id);
        } else {
          movingToInbox = true;
          targetProductId = ""; // resolvido abaixo (inbox) dentro da transação
        }

        if (movingToInbox && !isPreFactory(String(proj.status))) {
          return reply.status(409).send({
            code: "APP_RUNNING_CANNOT_INBOX",
            message: "App em fábrica/terminal não pode voltar ao INBOX. Mova-o para outro produto.",
          });
        }

        await client.query("BEGIN");
        try {
          if (!productId) {
            targetProductId = await resolveInboxProductId(client, tenantId, String(proj.created_by));
          }
          await client.query(
            "UPDATE projects SET product_id=$1, updated_at=NOW() WHERE id=$2",
            [targetProductId, id],
          );
          // Se o produto de origem era solo_app e ficou vazio, remove o homônimo-fantasma.
          if (previousProductId && previousProductId !== targetProductId) {
            await cleanupEmptySoloProduct(client, previousProductId);
          }
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        }
        return reply.send({ ok: true, productId: targetProductId });
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
