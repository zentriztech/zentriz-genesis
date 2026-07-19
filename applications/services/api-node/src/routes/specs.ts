import type { FastifyInstance, FastifyRequest } from "fastify";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import AdmZip from "adm-zip";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads");
const ALLOWED_EXT = new Set([".md", ".txt", ".doc", ".docx", ".pdf"]);

// Extensões legíveis extraídas de ZIPs — código é incluído como EXEMPLO DE REFERÊNCIA
const ZIP_TEXT_EXTS  = new Set([".md", ".txt", ".yaml", ".yml", ".json"]);
const ZIP_CODE_EXTS  = new Set([".ts", ".js", ".tsx", ".jsx", ".py", ".sql", ".sh"]);
// Palavras no nome/path do arquivo que indicam "é referência/exemplo, não spec"
const REFERENCE_HINTS = ["example", "sample", "reference", "schema", "structure", "template", "demo"];
const ZIP_BINARY_SKIP = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
                                  ".zip", ".tar", ".gz", ".exe", ".bin", ".lock"]);

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

function isAllowed(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXT.has(ext) || ext === ".zip";
}

type ExtractedFile = { filename: string; buffer: Buffer; mimeType: string };

/**
 * Extrai um ZIP e produz UM ÚNICO arquivo spec.md concatenando todo o conteúdo.
 * - Arquivos de spec/docs/contrato (.md, .txt, .yaml, .json): incluídos diretamente.
 * - Arquivos de código (.ts, .js, .py, .sql, etc.): incluídos com cabeçalho
 *   "EXEMPLO DE REFERÊNCIA — não copiar literalmente".
 * - Binários e arquivos ocultos: ignorados.
 * - Não depende de paths ou estrutura de diretórios do ZIP.
 */
function extractZip(zipBuffer: Buffer, originalName: string): ExtractedFile[] {
  const zip     = new AdmZip(zipBuffer);
  const entries = zip.getEntries().filter((e) => {
    if (e.isDirectory) return false;
    const name = e.entryName;
    // Ignorar ocultos e MACOSX
    if (path.basename(name).startsWith(".")) return false;
    if (name.includes("__MACOSX") || name.includes(".DS_Store")) return false;
    const ext = path.extname(name).toLowerCase();
    // Ignorar binários explícitos
    if (ZIP_BINARY_SKIP.has(ext)) return false;
    // Aceitar texto + código
    return ZIP_TEXT_EXTS.has(ext) || ZIP_CODE_EXTS.has(ext);
  });

  if (entries.length === 0) {
    throw new Error(
      `O ZIP "${originalName}" não contém arquivos de texto legíveis (.md, .yaml, .ts, etc.). ` +
      "Verifique o conteúdo e tente novamente."
    );
  }

  // Ordenar: docs primeiro (md/txt/yaml/json), código depois
  entries.sort((a, b) => {
    const extA = path.extname(a.entryName).toLowerCase();
    const extB = path.extname(b.entryName).toLowerCase();
    const isCodeA = ZIP_CODE_EXTS.has(extA) ? 1 : 0;
    const isCodeB = ZIP_CODE_EXTS.has(extB) ? 1 : 0;
    if (isCodeA !== isCodeB) return isCodeA - isCodeB;
    return a.entryName.localeCompare(b.entryName);
  });

  // Concatenar tudo em um único spec.md
  const sections: string[] = [];
  for (const entry of entries) {
    const basename    = path.basename(entry.entryName);
    const ext         = path.extname(basename).toLowerCase();
    const entryLower  = entry.entryName.toLowerCase();
    const isCode      = ZIP_CODE_EXTS.has(ext) ||
                        REFERENCE_HINTS.some((h) => entryLower.includes(h));

    let text: string;
    try {
      text = entry.getData().toString("utf-8").trim();
    } catch {
      continue; // pular arquivos que não decodificam como UTF-8
    }
    if (!text) continue;

    if (isCode) {
      // Código/infra é contexto/exemplo — nunca instrução literal
      const lang = ext.replace(".", "") || "text";
      sections.push(
        `---\n## [EXEMPLO DE REFERÊNCIA: ${entry.entryName}]\n` +
        `> ATENÇÃO: Este arquivo é apenas uma referência de estrutura. ` +
        `NÃO copiar literalmente. Adaptar à arquitetura definida nas specs deste produto.\n\n` +
        `\`\`\`${lang}\n${text}\n\`\`\``
      );
    } else {
      sections.push(`---\n## [${entry.entryName}]\n\n${text}`);
    }
  }

  const combined = sections.join("\n\n");
  const zipBase  = path.basename(originalName, ".zip");
  return [{
    filename: `${zipBase}-spec.md`,
    buffer:   Buffer.from(combined, "utf-8"),
    mimeType: "text/markdown",
  }];
}

// ── Message envelope builder — spec from free description (leigo → spec completa) ──
function buildCTOMessage(freeText: string, title?: string): Record<string, unknown> {
  const requestId = `spec-preview-${Date.now()}`;

  // Enriched task instruction: explain that the input is free text from a non-technical user
  // and the CTO must act as a senior product consultant — inferring, completing, and enriching
  const taskInstruction = `
Você está recebendo a DESCRIÇÃO LIVRE de um produto feita por uma pessoa leiga, não-técnica.
Seu papel neste modo é diferente do spec_intake_and_normalize normal:

OBJETIVO: Gerar uma spec COMPLETA e RICA baseada na intenção do usuário, como um CTO sênior
e consultor de produto experiente faria após uma conversa de discovery.

REGRAS PARA ESTE MODO:
1. INFIRA tudo que não foi dito mas é necessário para o produto funcionar.
   Ex: se pediram "sistema de agendamento", inclua: autenticação, perfis, notificações, conflito de horários.
2. USE seu conhecimento de domínio para enriquecer — não invente features novas, mas COMPLETE as implícitas.
3. ESCOLHA a stack tecnológica mais adequada baseada no que foi descrito (mobile? web? backend? ambos?).
4. ESCREVA cada FR com critérios de aceite detalhados (DADO/QUANDO/ENTÃO).
5. INCLUA personas reais com jornadas de uso.
6. DEFINA o modelo de dados com tabelas e campos principais.
7. SEJA CONCRETO — sem "TBD" ou "UNKNOWN" em itens que você pode inferir do contexto.
8. A spec deve ser rica o suficiente para que um engenheiro possa implementar sem perguntas adicionais.

Descrição do usuário: "${freeText.replace(/"/g, '\\"')}"
`.trim();

  return {
    project_id: "spec_preview",
    agent: "CTO",
    variant: "generic",
    mode: "spec_intake_and_normalize",
    request_id: requestId,
    task_id: null,
    task: taskInstruction,
    inputs: {
      spec_raw: freeText,
      product_spec: freeText,
      title: title ?? "Produto descrito pelo usuário",
      // "enrich-from-context" tells CTO to use domain knowledge to fill gaps
      constraints: ["enrich-from-context", "use-domain-knowledge", "complete-implicit-requirements"],
      // Extra context: signal that this is a free-text input from a non-technical user
      input_type: "free_description",
      user_is_non_technical: true,
    },
    existing_artifacts: [],
    limits: { max_rounds: 1, timeout_sec: 120 },
  };
}

// ── In-memory job store for spec-preview (no DB needed — jobs are transient) ──
type JobStatus = "pending" | "running" | "done" | "error";
interface SpecJob {
  id: string;
  status: JobStatus;
  specMarkdown?: string;
  summary?: string;
  error?: string;
  createdAt: number;
}
const _specJobs = new Map<string, SpecJob>();

// Clean up jobs older than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, job] of _specJobs) {
    if (job.createdAt < cutoff) _specJobs.delete(id);
  }
}, 5 * 60_000);

function extractSpecMarkdown(data: Record<string, unknown>): string {
  const artifacts = (data.artifacts as Array<Record<string, unknown>>) ?? [];
  const artifact = artifacts.find((a) =>
    typeof a.path === "string" && (a.path.endsWith(".md") || a.path.includes("PRODUCT_SPEC") || a.path.includes("spec"))
  );
  return (artifact?.content as string | undefined)
    ?? (data.summary as string | undefined)
    ?? "# Spec gerada\n\nO CTO não retornou conteúdo válido. Tente novamente.";
}

/**
 * HTTP POST using Node.js built-in http/https modules.
 * Avoids the AbortController/AbortSignal bug in Node.js 20 where long-lived
 * fetch() connections inside Docker get aborted prematurely even with large timeouts.
 * This function has a plain socket-level timeout (600s) with no AbortController.
 */
async function httpPost(urlStr: string, body: string, timeoutMs = 720_000): Promise<string> {
  const url = new URL(urlStr);
  const httpMod = url.protocol === "https:" ? await import("https") : await import("http");

  // keepAlive agent: prevents OS from closing idle TCP connection during long LLM calls
  // Without this, the socket is torn down after ~60-120s of no traffic
  const agent = new httpMod.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 10 });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      agent,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Connection": "keep-alive",
      },
    };

    const req = httpMod.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        const code = res.statusCode ?? 0;
        if (code >= 200 && code < 300) resolve(text);
        else reject(new Error(`HTTP ${code}: ${text.slice(0, 300)}`));
      });
      res.on("error", reject);
    });

    // Socket-level timeout — fires if NO data at all for timeoutMs
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Socket timeout after ${timeoutMs / 1000}s — no response from agents`));
    });

    req.on("socket", (socket) => {
      // Enable TCP keep-alive probes every 30s to prevent idle connection teardown
      socket.setKeepAlive(true, 30_000);
      // No read timeout on the socket itself — let the request timeout handle it
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function httpGet(urlStr: string, timeoutMs = 10_000): Promise<string> {
  const url = new URL(urlStr);
  const httpMod = url.protocol === "https:" ? await import("https") : await import("http");
  return new Promise((resolve, reject) => {
    const req = httpMod.get({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers: { "Connection": "keep-alive" },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        const code = res.statusCode ?? 0;
        if (code >= 200 && code < 300) resolve(text);
        else reject(new Error(`HTTP ${code}: ${text.slice(0, 200)}`));
      });
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error("GET timeout")); });
    req.on("error", reject);
  });
}

function runSpecJob(jobId: string, message: Record<string, unknown>, agentsUrl: string): void {
  const job = _specJobs.get(jobId);
  if (!job) return;
  job.status = "running";

  const base = agentsUrl.replace(/\/$/, "");
  const startedAt = Date.now();
  const MAX_MS = 660_000; // 11 min

  // Step 1: fire async job — use setImmediate to not block
  httpPost(`${base}/invoke/cto/async`, JSON.stringify(message), 30_000)
    .then((startText) => {
      const startData = JSON.parse(startText) as { jobId: string };
      const agentsJobId = startData.jobId;
      if (!agentsJobId) throw new Error("agents /invoke/cto/async did not return a jobId");

      console.log(`[SpecPreview] job=${jobId} agents_job=${agentsJobId} started`);

      // Step 2: poll via setInterval — NOT async/await loop (avoids Promise GC)
      const timer = setInterval(() => {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        if (elapsed > MAX_MS / 1000) {
          clearInterval(timer);
          const j = _specJobs.get(jobId);
          if (j) { j.status = "error"; j.error = "Timeout: CTO demorou mais de 11 minutos."; }
          return;
        }

        httpGet(`${base}/invoke/cto/status/${agentsJobId}`, 60_000)
          .then((pollText) => {
            const pollData = JSON.parse(pollText) as {
              status: string; result?: Record<string, unknown>; error?: string; elapsed?: number;
            };
            console.log(`[SpecPreview] job=${jobId} agents=${agentsJobId} status=${pollData.status} elapsed=${elapsed}s`);
            const j = _specJobs.get(jobId);
            if (!j) { clearInterval(timer); return; }

            if (pollData.status === "done" && pollData.result) {
              clearInterval(timer);
              j.specMarkdown = extractSpecMarkdown(pollData.result);
              j.summary = (pollData.result.summary as string | undefined) ?? "";
              j.status = "done";
              console.log(`[SpecPreview] ✓ job=${jobId} DONE — ${j.specMarkdown?.length} chars`);
            } else if (pollData.status === "error") {
              clearInterval(timer);
              j.status = "error";
              j.error = pollData.error ?? "CTO job failed";
            }
          })
          .catch((pollErr) => {
            const errMsg = pollErr instanceof Error ? pollErr.message : String(pollErr);
            console.warn(`[SpecPreview] poll error job=${jobId} agents=${agentsJobId} elapsed=${elapsed}s: ${errMsg}`);
          });
      }, 8_000);

      // Keep timer reference in job so it can be cancelled if needed
      (job as unknown as Record<string, unknown>)._timer = timer;
    })
    .catch((err) => {
      const j = _specJobs.get(jobId);
      if (j) { j.status = "error"; j.error = err instanceof Error ? err.message.slice(0, 300) : String(err); }
    });
}

export async function specRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // POST /api/spec-preview — enqueue CTO job, return jobId immediately
  app.post<{ Body: { freeText: string; title?: string } }>(
    "/api/spec-preview",
    async (request, reply) => {
      const body = request.body ?? {} as { freeText?: string; title?: string };
      const freeText = (body.freeText ?? "").trim();
      if (!freeText || freeText.length < 20) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Descreva o produto com pelo menos 20 caracteres" });
      }

      const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim();
      if (!agentsUrl) {
        return reply.status(503).send({ code: "SERVICE_UNAVAILABLE", message: "Serviço de agentes não configurado" });
      }

      const jobId = `spj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const job: SpecJob = { id: jobId, status: "pending", createdAt: Date.now() };
      _specJobs.set(jobId, job);

      const message = buildCTOMessage(freeText, body.title);

      // Fire and forget — setInterval-based, no Promise to await
      runSpecJob(jobId, message, agentsUrl);

      return reply.status(202).send({ jobId, status: "pending" });
    }
  );

  // GET /api/spec-preview/:jobId — poll for job result
  app.get<{ Params: { jobId: string } }>(
    "/api/spec-preview/:jobId",
    async (request, reply) => {
      const { jobId } = request.params;
      const job = _specJobs.get(jobId);
      if (!job) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Job não encontrado ou expirado" });
      }

      if (job.status === "done") {
        return reply.send({
          jobId, status: "done",
          specMarkdown: job.specMarkdown,
          summary: job.summary,
        });
      }
      if (job.status === "error") {
        return reply.send({ jobId, status: "error", error: job.error });
      }
      // still pending or running
      const elapsed = Math.round((Date.now() - job.createdAt) / 1000);
      return reply.send({ jobId, status: job.status, elapsed });
    }
  );

  app.post("/api/specs", async (request, reply) => {
    const user = getUser(request);
    if (!user.tenantId && user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant obrigatório para enviar spec" });
    }

    let title = "Spec sem título";
    let parentProjectId: string | null = null;
    let freeDescription: string | null = null;
    let projectType: string | null = null;
    let productId: string | null = null;
    // SPEC-APPROVED: "Especificações aprovadas por humanos". Quando true, o runner roda o CTO
    // em Sub-modo C (validar, não regenerar) — sem pular Engineer/charter/PM.
    let specApproved = false;
    // DM-T2: campos de entrega (vão para extra; validados no dispatch de deploy pelo deployMatrix).
    const deliveryFields: Record<string, string> = {};
    const files: { filename: string; buffer: Buffer; mimeType: string }[] = [];
    // Em @fastify/multipart v8, req.file() retorna apenas partes do tipo FILE; campos como "title"
    // vêm em part.fields (objeto acumulado pelo busboy). Cada part retornado é MultipartFile com .fields.
    type Part = {
      fieldname: string;
      filename: string;
      mimetype: string;
      toBuffer(): Promise<Buffer>;
      fields?: Record<string, { value?: unknown } | { value?: unknown }[]>;
    };
    const req = request as unknown as { file: () => Promise<Part | undefined> };
    let part: Part | undefined;
    while ((part = await req.file()) !== undefined) {
      if (part.fields?.title !== undefined) {
        const titleField = part.fields.title;
        const v = Array.isArray(titleField) ? titleField[0] : titleField;
        const raw = v && typeof (v as { value?: string }).value === "string"
          ? (v as { value: string }).value.trim()
          : "";
        if (raw) title = raw;
      }
      if (part.fields?.parentProjectId !== undefined) {
        const ppField = part.fields.parentProjectId;
        const v = Array.isArray(ppField) ? ppField[0] : ppField;
        const raw = v && typeof (v as { value?: string }).value === "string"
          ? (v as { value: string }).value.trim()
          : "";
        if (raw) parentProjectId = raw;
      }
      if (part.fields?.freeDescription !== undefined) {
        const fdField = part.fields.freeDescription;
        const v = Array.isArray(fdField) ? fdField[0] : fdField;
        const raw = v && typeof (v as { value?: string }).value === "string"
          ? (v as { value: string }).value.trim()
          : "";
        if (raw) freeDescription = raw;
      }
      if (part.fields?.projectType !== undefined) {
        const ptField = part.fields.projectType;
        const v = Array.isArray(ptField) ? ptField[0] : ptField;
        const raw = v && typeof (v as { value?: string }).value === "string"
          ? (v as { value: string }).value.trim()
          : "";
        if (raw) {
          // T-05 fix: normalizar via type_aliases do policies.json antes de persistir
          // — evita "tipos fantasma" no banco (ex: web_app → frontend_dashboard).
          const { normalizeProjectType } = await import("../services/typePolicyNormalizer.js");
          projectType = normalizeProjectType(raw) ?? raw;
        }
      }
      if (part.fields?.productId !== undefined) {
        const pidField = part.fields.productId;
        const v = Array.isArray(pidField) ? pidField[0] : pidField;
        const raw = v && typeof (v as { value?: string }).value === "string"
          ? (v as { value: string }).value.trim()
          : "";
        if (raw) productId = raw;
      }
      // SPEC-APPROVED: checkbox "Especificações aprovadas por humanos".
      // Aceita "true"/"1"/"on" (checkbox HTML) OU reviewMode="validate-only".
      if (part.fields?.specApproved !== undefined || part.fields?.reviewMode !== undefined) {
        const saField = part.fields.specApproved ?? part.fields.reviewMode;
        const v = Array.isArray(saField) ? saField[0] : saField;
        const raw = v && typeof (v as { value?: string }).value === "string"
          ? (v as { value: string }).value.trim().toLowerCase()
          : "";
        if (["true", "1", "on", "yes", "validate-only"].includes(raw)) specApproved = true;
      }
      // FASE-4/SEC-P1: o campo `approvedBy` do cliente é IGNORADO (falsificável).
      // O aprovador é sempre o usuário autenticado (JWT), gravado abaixo.
      // DM-T2: campos de entrega opcionais (delivery_mode/runtime_target/db_mode/host_target/domain_mode).
      for (const key of ["deliveryMode", "runtimeTarget", "dbMode", "hostTarget", "domainMode"] as const) {
        if (part.fields?.[key] !== undefined) {
          const f = part.fields[key];
          const v = Array.isArray(f) ? f[0] : f;
          const raw = v && typeof (v as { value?: string }).value === "string"
            ? (v as { value: string }).value.trim() : "";
          if (raw) deliveryFields[key] = raw;
        }
      }
      if (part.filename) {
        if (!isAllowed(part.filename)) {
          return reply.status(400).send({
            code: "BAD_REQUEST",
            message: "Formatos aceitos: .md, .txt, .doc, .docx, .pdf, .zip",
          });
        }
        const buffer = await part.toBuffer();
        const ext = path.extname(part.filename).toLowerCase();
        if (ext === ".zip") {
          let extracted: ExtractedFile[];
          try {
            extracted = extractZip(buffer, part.filename);
          } catch (e) {
            return reply.status(400).send({
              code: "BAD_REQUEST",
              message: e instanceof Error ? e.message : "Erro ao extrair ZIP.",
            });
          }
          files.push(...extracted);
        } else {
          files.push({ filename: part.filename, buffer, mimeType: part.mimetype });
        }
      }
    }

    if (files.length === 0) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Envie pelo menos um arquivo" });
    }

    const client = await pool.connect();
    let projectId: string;
    try {
      const tenantId =
        user.tenantId ?? (await client.query("SELECT id FROM tenants LIMIT 1")).rows[0]?.id;
      if (!tenantId) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Nenhum tenant disponível" });
      }

      // Compute version_number: find the root project and count existing versions
      let versionNumber = 1;
      let rootParentId: string | null = parentProjectId;
      if (parentProjectId) {
        // Walk up to root if parent is itself a child
        const parentRow = await client.query(
          "SELECT parent_project_id, version_number FROM projects WHERE id = $1",
          [parentProjectId]
        );
        const parent = parentRow.rows[0];
        if (parent?.parent_project_id) {
          rootParentId = parent.parent_project_id as string;
        }
        // Count existing versions in this lineage (root + all children)
        const countRes = await client.query(
          `SELECT COUNT(*) FROM projects
           WHERE id = $1 OR parent_project_id = $1 OR
                 parent_project_id IN (SELECT id FROM projects WHERE parent_project_id = $1)`,
          [rootParentId ?? parentProjectId]
        );
        versionNumber = parseInt(countRes.rows[0].count as string, 10) + 1;
      }

      // SPEC-APPROVED: hash do conteúdo bruto das specs (SHA-256), para impedir
      // "aprovo v1, subo/edito v2". DEVE casar com o hash recomputado pelo runner
      // (_compute_spec_files_hash).
      // FASE-4/CORR-P2: ordem DETERMINÍSTICA por filename (não por ordem de inserção /
      // created_at, que não tem tiebreak e pode reordenar em inserts no mesmo microssegundo).
      // Ambos os lados ordenam por filename ASC antes de unir por "\n".
      const specHash = specApproved
        ? crypto.createHash("sha256")
            .update(
              [...files]
                .sort((a, b) => a.filename.localeCompare(b.filename))
                .map((f) => f.buffer.toString("utf-8"))
                .join("\n"),
              "utf-8",
            )
            .digest("hex")
        : null;
      const extraJson = JSON.stringify({
        ...(freeDescription ? { free_description: freeDescription } : {}),
        ...(projectType    ? { project_type: projectType }           : {}),
        // DM-T2: entrega (só grava o que veio; ausência = defaults do deployMatrix no deploy).
        ...(deliveryFields.deliveryMode ? { delivery_mode: deliveryFields.deliveryMode } : {}),
        ...(deliveryFields.runtimeTarget ? { runtime_target: deliveryFields.runtimeTarget } : {}),
        ...(deliveryFields.dbMode ? { db_mode: deliveryFields.dbMode } : {}),
        ...(deliveryFields.hostTarget ? { host_target: deliveryFields.hostTarget } : {}),
        ...(deliveryFields.domainMode ? { domain_mode: deliveryFields.domainMode } : {}),
        // SPEC-APPROVED: persistência auditável (não booleano anônimo).
        // FASE-4/SEC-P1: `approved_by` é SEMPRE derivado do usuário autenticado (JWT),
        // NUNCA do campo `approvedBy` do multipart — senão a trilha de auditoria seria
        // falsificável (qualquer um poderia gravar "aprovado por <CEO>"). O campo do
        // cliente é ignorado de propósito.
        ...(specApproved ? {
          spec_approved: true,
          approved_by: user.email ?? user.id,
          approved_at: new Date().toISOString(),
          spec_hash: specHash,
        } : {}),
      });
      const projectResult = await client.query(
        `INSERT INTO projects (tenant_id, created_by, title, spec_ref, status, parent_project_id, version_number, extra, product_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) RETURNING id`,
        [tenantId, user.id, title, files[0].filename, "spec_submitted", rootParentId, versionNumber, extraJson, productId]
      );
      projectId = projectResult.rows[0].id;
    } finally {
      client.release();
    }

    const projectDir = path.join(UPLOAD_DIR, projectId);
    await fs.mkdir(projectDir, { recursive: true });

    const saved: { filename: string; filePath: string; mimeType: string }[] = [];
    for (const f of files) {
      const safeName = `${Date.now()}-${path.basename(f.filename)}`;
      const filePath = path.join(projectDir, safeName);
      await fs.writeFile(filePath, f.buffer);
      saved.push({ filename: f.filename, filePath, mimeType: f.mimeType });
    }

    const client2 = await pool.connect();
    try {
      for (const f of saved) {
        await client2.query(
          `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type) VALUES ($1, $2, $3, $4)`,
          [projectId, f.filename, f.filePath, f.mimeType]
        );
      }
      const hasNonMd = saved.some((f) => path.extname(f.filename).toLowerCase() !== ".md");
      if (hasNonMd) {
        await client2.query("UPDATE projects SET status = $1, updated_at = now() WHERE id = $2", [
          "pending_conversion",
          projectId,
        ]);
      }
    } finally {
      client2.release();
    }

    return reply.send({
      projectId,
      status: saved.some((f) => path.extname(f.filename).toLowerCase() !== ".md")
        ? "pending_conversion"
        : "spec_submitted",
      message: "Spec(s) recebida(s). O fluxo será iniciado em seguida.",
    });
  });
}
