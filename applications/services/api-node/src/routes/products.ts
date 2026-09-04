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
import { canAccessProjectRow } from "../lib/projectAccess.js";
import { denyCreationForManagement } from "../middleware/managementGuard.js";
import { extractProductZip, type ProductZipContents } from "./specs.js";
import { decomposeProduct } from "../services/productDecomposer.js";
import { ManifestError, type ProductManifest } from "../services/productManifest.js";
import { dispatchProjectRun } from "../services/runnerDispatch.js";
import { resolveInboxProductId, cleanupEmptySoloProduct } from "../services/inbox.js";
import { isPreFactory, SPEC_EDITABLE_STATUSES } from "../services/projectStatus.js";
import { emitValueEvent } from "../services/valueEvents.js";
import { runProposeJob, PROPOSAL_DEADLINE_MIN } from "../services/productProposals.js";
import { recordSelfApproval } from "../services/governanceAudit.js";

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

// RFC-0004 T1.6b: a proposta do Splitter (doc→N) NASCE persistida em `product_proposals`
// (migration 076). O runner do job, o reaper de boot e o tick de deadline vivem em
// services/productProposals.ts — aqui só criamos a linha e fazemos poll/ingest sobre ela.

export async function productRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  // ── GET /api/products ────────────────────────────────────────────────────────
  // B3 (RFC-0003): o master (zentriz_admin) escopa a listagem via ?tenantId= (seletor de
  // tenant do portal), espelhando GET /api/projects e /api/specs. Sem esse fix a conta de
  // gestão recebia sempre [] → "Meus Produtos" ficava vazio permanentemente (gap U#3/C5).
  app.get("/api/products", async (request, reply) => {
    const user = getUser(request);
    const q = (request.query ?? {}) as { tenantId?: string; includeInbox?: string };
    // tenantId inválido (não-UUID) é ignorado → evita erro de cast uuid (500).
    const scopeTenantId =
      user.role === "zentriz_admin" && q.tenantId && UUID_RE.test(q.tenantId) ? q.tenantId : null;
    // §4.15: por padrão o INBOX "Rascunhos" NÃO aparece em "Meus produtos" (é infra pré-fábrica).
    // A Bancada e o select de spec pedem ?includeInbox=1 para poder listá-lo/vinculá-lo.
    const includeInbox = q.includeInbox === "1" || q.includeInbox === "true";
    // Não-master sem tenant não possui produtos.
    if (user.role !== "zentriz_admin" && !user.tenantId) return reply.send([]);
    const client = await pool.connect();
    try {
      // §4.15 (migration 064): expõe is_inbox/solo_app (o portal renderiza o INBOX à parte
      // e distingue produtos homônimos de App solo) + oldest_project_at (para o "aging" de
      // rascunhos parados no INBOX). O INBOX é fixado no topo (is_inbox DESC). Filtros:
      //  • INBOX oculto salvo ?includeInbox=1;
      //  • homônimo solo_app SEM projetos é fantasma (App ainda não graduou) → oculto via HAVING.
      const selectFragment = `
        SELECT p.id, p.name, p.description, p.status, p.lifecycle_status, p.created_at,
               p.is_inbox, p.solo_app,
               COUNT(proj.id)::int AS project_count,
               MIN(proj.created_at) AS oldest_project_at
        FROM products p
        LEFT JOIN projects proj ON proj.product_id = p.id`;
      const tail = `
               GROUP BY p.id
               HAVING (p.solo_app = false OR COUNT(proj.id) > 0)
               ORDER BY p.is_inbox DESC, p.created_at DESC`;
      const res =
        user.role === "zentriz_admin"
          ? await client.query(
              `${selectFragment}
               WHERE ($1::uuid IS NULL OR p.tenant_id = $1) AND p.status = 'active'
                 AND (p.is_inbox = false OR $2::boolean = true)${tail}`,
              [scopeTenantId, includeInbox]
            )
          : await client.query(
              `${selectFragment}
               WHERE p.tenant_id = $1 AND p.status = 'active'
                 AND (p.is_inbox = false OR $2::boolean = true)${tail}`,
              [user.tenantId, includeInbox]
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
      // R4 PR5 / D4: auto-aprovação via ZIP (campo multipart OU product.specApproved do PRODUCT.json)
      // — auditada pelo valor EFETIVO aplicado, não bloqueada.
      if (result.specApprovedEffective && !result.idempotentReuse) {
        void recordSelfApproval(pool, {
          actorUserId: user.id, actorEmail: user.email ?? null, actorRole: user.role,
          productId: result.productId, source: "products_ingest_zip",
          rawValue: specApprovedOverride === true ? "multipart:specApproved" : "manifest:product.specApproved",
          extra: { projects: result.projects.map((p) => p.projectId) },
        });
      }
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
      const user = getUser(request);
      // RFC-0002 A.1: conta de gestão (zentriz_admin) não propõe/decompõe produto.
      if (denyCreationForManagement(user, reply)) return;
      // T1.6b: a proposta é do TENANT (linha em product_proposals.tenant_id) — sem tenant
      // não há dono para gravar/consultar (nem GET binding). Master não propõe (denyCreation).
      const tenantId = user.tenantId;
      if (!tenantId) return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant obrigatório" });
      const body = request.body ?? {};
      const document = (body.document ?? "").trim();
      if (document.length < 40) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Envie o documento do produto com pelo menos 40 caracteres." });
      }
      const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim();
      if (!agentsUrl) {
        return reply.status(503).send({ code: "SERVICE_UNAVAILABLE", message: "Serviço de agentes (Product Architect) não configurado." });
      }
      // Modo IDEIA não tem one-flight (não há origem) → rate-limit por tenant: 4 propostas/h.
      const recent = await pool.query(
        "SELECT count(*)::int AS n FROM product_proposals WHERE tenant_id=$1 AND origin_project_id IS NULL AND created_at > now() - interval '1 hour'",
        [tenantId],
      );
      if ((recent.rows[0]?.n ?? 0) >= 4) {
        return reply.status(429).send({ code: "RATE_LIMITED", message: "Muitas decomposições de ideia na última hora. Tente novamente mais tarde." });
      }
      const ins = await pool.query(
        "INSERT INTO product_proposals (tenant_id, created_by, document, model_id, status, deadline_at) VALUES ($1,$2,$3,$4,'pending', now() + ($5 || ' minutes')::interval) RETURNING id",
        [tenantId, UUID_RE.test(user.id ?? "") ? user.id : null, document, body.modelId ?? null, String(PROPOSAL_DEADLINE_MIN)],
      );
      const jobId = ins.rows[0].id as string;
      runProposeJob(pool, jobId, document, body.modelId, agentsUrl, null);
      return reply.status(202).send({ jobId, status: "pending" });
    }
  );

  // ── GET /api/products/propose/:jobId — poll da proposta (persistida) ───────────
  app.get<{ Params: { jobId: string } }>(
    "/api/products/propose/:jobId",
    async (request, reply) => {
      const user = getUser(request);
      const { jobId } = request.params;
      // jobId agora é o id (UUID) da linha. Formato legado paj-... (jobs em memória de um
      // deploy anterior) → 404: aquele job morreu no restart, o portal deve refazer.
      if (!UUID_RE.test(jobId)) return reply.status(404).send({ code: "NOT_FOUND", message: "Job não encontrado ou expirado" });
      const row = (await pool.query(
        "SELECT id, tenant_id, status, payload, warnings, error, origin_project_id, created_at FROM product_proposals WHERE id=$1",
        [jobId],
      )).rows[0];
      if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Job não encontrado ou expirado" });
      // Binding de tenant: master vê qualquer; não-master só o do próprio tenant → 404 (não
      // 403: não vaza a existência de um job de outro tenant). Fecha o IDOR do poll antigo.
      if (user.role !== "zentriz_admin" && row.tenant_id !== user.tenantId) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Job não encontrado ou expirado" });
      }
      if (row.status === "done") {
        const p = (row.payload ?? {}) as { manifest?: unknown; specs?: unknown; waves?: unknown; projects?: unknown };
        // Payload purgado (>7d) numa linha ainda 'done' → trata como expirado (o portal refaz).
        if (!p.manifest || !p.specs) {
          return reply.send({ jobId: row.id, status: "error", interrupted: true, error: "Proposta expirada. Refaça a decomposição." });
        }
        return reply.send({
          jobId: row.id, status: "done", needsHuman: true,
          manifest: p.manifest, specs: p.specs, waves: p.waves, projects: p.projects,
          warnings: row.warnings ?? [],
          // B4: eco da origem — o cliente devolve isto em /ingest-proposal para gravar o vínculo.
          originProjectId: row.origin_project_id ?? null,
        });
      }
      // 'interrupted' não existe no contrato do frontend (status desconhecido → poll infinito)
      // → mapeia para 'error' + flag interrupted:true (o portal encerra e oferece refazer).
      if (row.status === "interrupted") {
        return reply.send({ jobId: row.id, status: "error", interrupted: true, error: row.error || "A decomposição foi interrompida (reinício do serviço). Tente novamente." });
      }
      if (row.status === "error") return reply.send({ jobId: row.id, status: "error", error: row.error });
      const elapsed = Math.round((Date.now() - new Date(row.created_at).getTime()) / 1000);
      return reply.send({ jobId: row.id, status: row.status, elapsed });
    }
  );

  // ── POST /api/products/ingest-proposal — ingere a proposta APROVADA ────────────
  // Recebe {manifest, specs, specApproved} JSON (o que /propose devolveu, após revisão
  // humana) e reusa o executor determinístico (decomposeProduct) SEM exigir um ZIP:
  // monta o ProductZipContents em memória. Depois dispara a onda 0 (igual /ingest).
  app.post<{ Body: { manifest?: ProductManifest; specs?: Record<string, string>; specApproved?: boolean; dispatch?: boolean; originProjectId?: string; proposalId?: string } }>(
    "/api/products/ingest-proposal",
    async (request, reply) => {
      const user = getUser(request);
      // RFC-0002 A.1: conta de gestão (zentriz_admin) não ingere proposta de produto.
      if (denyCreationForManagement(user, reply)) return;
      // RFC-0002 A.1 (M6): sem fallback para "primeiro tenant" — exige tenant do chamador.
      const tenantId = user.tenantId;
      if (!tenantId) return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant obrigatório" });

      const body = request.body ?? {};
      let { manifest, specs } = body;
      const { specApproved, dispatch, originProjectId, proposalId } = body;

      // T1.6b: caminho AUTORITATIVO — se veio proposalId, o manifest/specs vêm da linha
      // persistida (o cliente não pode injetar um manifest divergente do que foi proposto),
      // e a origem é a que o servidor gravou. O payload do body é ignorado nesse caso.
      let authoritativeOrigin: string | null | undefined;
      if (proposalId) {
        if (!UUID_RE.test(proposalId)) {
          return reply.status(400).send({ code: "BAD_REQUEST", message: "proposalId inválido." });
        }
        const pp = (await pool.query(
          "SELECT tenant_id, status, payload, origin_project_id, consumed_product_id FROM product_proposals WHERE id=$1",
          [proposalId],
        )).rows[0];
        if (!pp || (user.role !== "zentriz_admin" && pp.tenant_id !== tenantId)) {
          return reply.status(404).send({ code: "NOT_FOUND", message: "Proposta não encontrada." });
        }
        // Já consumida (double-submit/retry): idempotente — aponta o produto já criado (o
        // payload foi purgado no consumo, então não dá para redecompor, nem é preciso).
        if (pp.consumed_product_id) {
          return reply.status(200).send({ productId: pp.consumed_product_id, idempotentReuse: true });
        }
        if (pp.status !== "done" || !pp.payload?.manifest || !pp.payload?.specs) {
          return reply.status(409).send({ code: "PROPOSAL_NOT_READY", message: "A proposta não está pronta para ingestão (ou expirou)." });
        }
        manifest = pp.payload.manifest as ProductManifest;
        specs = pp.payload.specs as Record<string, string>;
        authoritativeOrigin = pp.origin_project_id ?? null;
      }
      if (!manifest || typeof manifest !== "object" || !specs || typeof specs !== "object") {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "manifest + specs (mapa caminho→conteúdo) são obrigatórios." });
      }
      // B4: origem opcional (spec da Bancada). Valida UUID para não estourar o cast ::uuid
      // E confirma a POSSE — o vínculo de origem só vale se a spec for do mesmo tenant do
      // produto que está nascendo. Sem isso, um id de outro tenant viraria um vínculo
      // cross-tenant (vazamento de integridade). Origem inválida/alheia → simplesmente null
      // (produto avulso), nunca 4xx: a origem é um enriquecimento, não um requisito.
      let origin: string | null = null;
      // Com proposalId, a origem é a que o servidor gravou (já ligada ao tenant da proposta):
      // é autoritativa, não precisa (nem deve) ser sobrescrita pelo body.
      if (authoritativeOrigin !== undefined) {
        origin = authoritativeOrigin;
      } else if (originProjectId && UUID_RE.test(originProjectId)) {
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
        // R4 PR5 / D4: auto-aprovação ao ingerir proposta (body OU product.specApproved do manifesto
        // persistido) — auditada pelo valor EFETIVO aplicado, não bloqueada.
        if (result.specApprovedEffective && !result.idempotentReuse) {
          void recordSelfApproval(pool, {
            actorUserId: user.id, actorEmail: user.email ?? null, actorRole: user.role,
            productId: result.productId, source: "products_ingest_proposal",
            rawValue: specApproved === true ? "body:specApproved" : "manifest:product.specApproved",
            extra: { proposalId: proposalId ?? null, projects: result.projects.map((p) => p.projectId) },
          });
        }
        // T1.6b: marca a proposta consumida (audit) e purga o payload (idempotente por
        // COALESCE — reingerir a mesma proposta não reescreve consumed_at). Best-effort:
        // a idempotência do produto já vem do systemId em decomposeProduct.
        if (proposalId && UUID_RE.test(proposalId)) {
          await pool.query(
            "UPDATE product_proposals SET consumed_at=COALESCE(consumed_at, now()), consumed_product_id=$2, payload=NULL, updated_at=now() WHERE id=$1",
            [proposalId, result.productId],
          ).catch((e) => request.log.warn({ proposalId, err: e }, "[products/ingest-proposal] falha ao marcar proposta consumida"));
        }
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
        // Ownership: não-master só decompõe spec do próprio tenant (regra única em projectAccess).
        if (!canAccessProjectRow(user, proj)) {
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
        // T1.6b: cria a proposta persistida. one-flight por origem (índice parcial único
        // pp_one_flight_origin): 2 cliques em "Decompor" na mesma spec = 1 job vivo → o 2º
        // colide (23505) e reusa o job em voo em vez de disparar outra decomposição.
        let jobId: string;
        try {
          const ins = await client.query(
            "INSERT INTO product_proposals (tenant_id, created_by, origin_project_id, document, model_id, status, deadline_at) VALUES ($1,$2,$3,$4,$5,'pending', now() + ($6 || ' minutes')::interval) RETURNING id",
            [proj.tenant_id, UUID_RE.test(user.id ?? "") ? user.id : null, id, document, request.body?.modelId ?? null, String(PROPOSAL_DEADLINE_MIN)],
          );
          jobId = ins.rows[0].id as string;
        } catch (e) {
          if ((e as { code?: string }).code === "23505") {
            // já há proposta viva para esta spec → reusa (a origem já ficou pending_conversion
            // no clique anterior; não redisparamos nada).
            const existing = (await client.query(
              "SELECT id FROM product_proposals WHERE origin_project_id=$1 AND status IN ('pending','running') ORDER BY created_at DESC LIMIT 1",
              [id],
            )).rows[0];
            if (existing) {
              return reply.status(202).send({ jobId: existing.id, status: "running", originProjectId: id, reused: true });
            }
          }
          throw e;
        }
        // §4.7 (migration 064): fecha a janela entre o dispatch e o consumo — marca a origem
        // como pending_conversion (ainda pré-fábrica, ainda no INBOX). O decomposer consome a
        // spec (status='archived') dentro da transação, com guarda de status contra /run concorrente.
        await client.query(
          "UPDATE projects SET status='pending_conversion', updated_at=NOW() WHERE id=$1 AND status IN ('draft','spec_submitted')",
          [id],
        );
        runProposeJob(pool, jobId, document, request.body?.modelId, agentsUrl, id);
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
                bdep.status AS backend_deploy_status,
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
         LEFT JOIN LATERAL (
           SELECT status FROM backend_deployments b
           WHERE b.project_id = p.id AND b.status IN ('running','running_degraded')
           ORDER BY b.created_at DESC LIMIT 1
         ) bdep ON true
         WHERE p.product_id = $1
         GROUP BY p.id, d.depth, gr.repo_url, gr.repo_full_name, dep.app_url, dep.status, bdep.status
         ORDER BY COALESCE(d.depth, 0) ASC, p.created_at ASC`,
        [id]
      );
      return reply.send({ ...prod.rows[0], projects: projects.rows });
    } finally { client.release(); }
  });

  // ── GET /api/products/:id/spec-tree — redesign Bancada Onda 2 ─────────────────
  // Árvore de SPECS AGREGADA por produto: une os `project_spec_files` de TODOS os
  // projetos do produto (metadados apenas — SEM leitura de disco). Alimenta o editor
  // de "pasta do produto" (estilo VSCode) da Bancada, análogo à aba "Código" da fábrica
  // mas cobrindo o produto inteiro. O CONTEÚDO de cada arquivo é carregado sob demanda
  // pelo endpoint por-projeto já existente (GET /api/projects/:pid/spec-file), que
  // carrega as guardas de acesso/If-Match/traversal — aqui só devolvemos o índice.
  app.get<{ Params: { id: string } }>("/api/products/:id/spec-tree", async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params;
    if (!UUID_RE.test(id)) return reply.status(400).send({ code: "INVALID_PRODUCT_ID" });
    const client = await pool.connect();
    try {
      // Mesmo escopo de tenant do GET /api/products/:id: o master abre qualquer produto;
      // não-master só o do próprio tenant. 404 (não 403) para não vazar existência.
      const prod = await client.query(
        "SELECT id, name, tenant_id, is_inbox FROM products WHERE id = $1", [id],
      );
      const prow = prod.rows[0];
      if (!prow) return reply.status(404).send({ code: "NOT_FOUND" });
      if (user.role !== "zentriz_admin" && prow.tenant_id !== user.tenantId) {
        return reply.status(404).send({ code: "NOT_FOUND" });
      }
      const MAX_FILES = 2000;
      // Defesa-em-profundidade: além de filtrar por product_id, reconfirma o tenant de
      // CADA projeto (= tenant do produto). O caminho de criação já garante consistência,
      // mas isto impede vazamento de metadados (nomes/rel_dir/shas) caso algum projeto de
      // outro tenant fosse indevidamente vinculado. Os endpoints de conteúdo já re-checam.
      const rows = (await client.query(
        `SELECT psf.project_id, p.title AS project_title, p.status AS project_status,
                psf.filename, psf.rel_dir, psf.is_primary, psf.content_sha256, psf.created_at
           FROM project_spec_files psf
           JOIN projects p ON p.id = psf.project_id
          WHERE p.product_id = $1 AND p.tenant_id IS NOT DISTINCT FROM $2
          ORDER BY p.created_at ASC, psf.rel_dir, psf.filename
          LIMIT $3`,
        [id, prow.tenant_id, MAX_FILES + 1],
      )).rows as Array<Record<string, unknown>>;
      const truncated = rows.length > MAX_FILES;
      const capped = truncated ? rows.slice(0, MAX_FILES) : rows;
      // Total REAL só quando truncado (senão é o próprio comprimento) — evita "N de N".
      let totalFiles = capped.length;
      if (truncated) {
        const cnt = (await client.query(
          `SELECT count(*)::int AS n FROM project_spec_files psf
             JOIN projects p ON p.id = psf.project_id
            WHERE p.product_id = $1 AND p.tenant_id IS NOT DISTINCT FROM $2`,
          [id, prow.tenant_id],
        )).rows[0] as { n: number };
        totalFiles = cnt.n;
      }
      // Agrupa por projeto preservando a ordem do SELECT (created_at → cada projeto vira
      // uma "pasta" de topo na árvore do produto).
      const byProject = new Map<string, {
        projectId: string; title: string; status: string; editable: boolean;
        files: Array<{ path: string; ext: string; isPrimary: boolean; contentSha256: string | null; createdAt: string | null }>;
      }>();
      for (const r of capped) {
        const pid = String(r.project_id);
        let g = byProject.get(pid);
        if (!g) {
          const status = String(r.project_status);
          g = { projectId: pid, title: String(r.project_title ?? "Projeto"), status, editable: SPEC_EDITABLE_STATUSES.has(status), files: [] };
          byProject.set(pid, g);
        }
        const relDir = String(r.rel_dir ?? "");
        const filename = String(r.filename);
        const dot = filename.lastIndexOf(".");
        g.files.push({
          path: relDir ? `${relDir}/${filename}` : filename,
          ext: dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "",
          isPrimary: !!r.is_primary,
          contentSha256: (r.content_sha256 as string | null) ?? null,
          createdAt: (r.created_at as Date)?.toISOString?.() ?? null,
        });
      }
      return reply.send({
        productId: prow.id,
        productName: prow.is_inbox ? "Rascunhos (inbox)" : (prow.name ?? "Produto"),
        isInbox: !!prow.is_inbox,
        projects: Array.from(byProject.values()),
        totalFiles,
        loadedFiles: capped.length,
        truncated,
      });
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
      // Value meter MVP (spec 2026-08-20): promoção Bancada→fábrica (spec vira produto
      // em execução). Emitido só na transição atômica draft→running (idempotente por
      // construção — dupla promoção cai no 409 acima). Best-effort, nunca lança.
      void emitValueEvent(pool, {
        tenantId: (row.tenant_id as string | null) ?? null,
        eventType: "spec_promoted",
        metadata: { product_id: id, promoted_roots: rootIds.length },
      });
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
