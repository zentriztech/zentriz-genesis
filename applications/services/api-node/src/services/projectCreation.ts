/**
 * projectCreation.ts — criação de projeto a partir de spec(s), como FUNÇÃO PURA
 * reutilizável (ADR-018, correção adversária A4). Antes, toda esta lógica vivia
 * apenas dentro do handler multipart de POST /api/specs; agora a rota E o
 * product_decomposer (ingestão de produto em lote) consomem a MESMA função —
 * evita chamar a rota HTTP multipart em loop (frágil) e garante hash/extra/
 * arquivos idênticos nos dois caminhos.
 *
 * Preserva byte-a-byte as regras existentes: version_number por linhagem,
 * spec_hash SHA-256 (sort filename ASC + join "\n") p/ spec-approved, extra
 * auditável, gravação em UPLOAD_DIR + project_spec_files, pending_conversion.
 */
import type { PoolClient } from "pg";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { DEPLOY_FORMATS, type DeployFormat } from "./provision/deployTargets.js";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Preferências de deploy escolhidas JÁ no envio da spec (Item 2, pré-seleção): conexão de
 * cloud + formato + prazo (demo). São só DEFAULTS que pré-preenchem o cockpit — a validação
 * de propriedade da conexão acontece no chamador (specs.ts) e no disparo do deploy. Aqui só
 * sanitizamos o formato/prazo e o formato do id.
 */
function sanitizeDeployPrefs(f: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const connId = (f.cloudConnectionId ?? "").trim();
  if (connId && UUID_RE.test(connId)) out.deploy_connection_id = connId;
  const fmt = (f.deployFormat ?? "").trim() as DeployFormat;
  if (fmt && DEPLOY_FORMATS.includes(fmt)) out.deploy_format = fmt;
  const ttlRaw = Number((f.ttlDays ?? "").trim());
  if (Number.isFinite(ttlRaw) && ttlRaw > 0) {
    out.deploy_ttl_days = Math.min(Math.max(Math.round(ttlRaw), 1), 30);
  }
  return out;
}

export interface SpecFileInput {
  filename: string;
  buffer: Buffer;
  mimeType: string;
}

export interface CreateProjectParams {
  tenantId: string;
  createdBy: string;
  /** e-mail do aprovador (JWT) — usado só quando specApproved. Nunca vem do cliente. */
  approverEmail?: string | null;
  title: string;
  files: SpecFileInput[];
  productId?: string | null;
  parentProjectId?: string | null;
  projectType?: string | null;
  freeDescription?: string | null;
  deliveryFields?: Record<string, string>;
  specApproved?: boolean;
  isDraft?: boolean;
}

export interface CreateProjectResult {
  projectId: string;
  status: "draft" | "spec_submitted" | "pending_conversion";
}

/**
 * computeSpecFingerprint — SHA-256 do conteúdo NORMALIZADO das specs, para REUSO
 * SILENCIOSO (Feature #65). Difere do spec_hash (spec-approved), que casa byte-a-byte
 * com o disco: aqui normalizamos (lowercase + colapso de espaços) para que specs
 * "materialmente iguais" com pequenas diferenças de formatação colidam de propósito.
 * Determinístico: arquivos ordenados por filename ASC, unidos por "\n".
 */
export function computeSpecFingerprint(files: SpecFileInput[]): string {
  const normalized = [...files]
    .sort((a, b) => a.filename.localeCompare(b.filename))
    .map((f) => f.buffer.toString("utf-8").toLowerCase().replace(/\s+/g, " ").trim())
    .join("\n");
  return crypto.createHash("sha256").update(normalized, "utf-8").digest("hex");
}

/**
 * Cria UM projeto (linha em `projects` + arquivos em disco + `project_spec_files`).
 * Usa o `client` fornecido para o INSERT do projeto (permite transação pelo chamador);
 * a gravação de arquivos e o registro de spec_files usam o mesmo client.
 * NÃO faz commit/rollback — responsabilidade do chamador.
 */
export async function createProjectFromSpec(
  client: PoolClient,
  params: CreateProjectParams,
): Promise<CreateProjectResult> {
  const {
    tenantId, createdBy, approverEmail, title, files,
    productId = null, parentProjectId = null, projectType = null,
    freeDescription = null, deliveryFields = {}, specApproved = false, isDraft = false,
  } = params;

  if (!files.length) throw new Error("createProjectFromSpec: nenhum arquivo de spec.");

  // version_number por linhagem (idêntico à rota /api/specs)
  let versionNumber = 1;
  let rootParentId: string | null = parentProjectId;
  if (parentProjectId) {
    const parentRow = await client.query(
      "SELECT parent_project_id, version_number FROM projects WHERE id = $1",
      [parentProjectId],
    );
    const parent = parentRow.rows[0];
    if (parent?.parent_project_id) rootParentId = parent.parent_project_id as string;
    const countRes = await client.query(
      `SELECT COUNT(*) FROM projects
         WHERE id = $1 OR parent_project_id = $1 OR
               parent_project_id IN (SELECT id FROM projects WHERE parent_project_id = $1)`,
      [rootParentId ?? parentProjectId],
    );
    versionNumber = parseInt(countRes.rows[0].count as string, 10) + 1;
  }

  // spec_hash: SHA-256 de (specs ordenadas por filename ASC, unidas por "\n").
  // ADR-018/A3: deve ser calculado sobre EXATAMENTE o conteúdo que será gravado em
  // disco (o runner recomputa do disco). Como gravamos `f.buffer` verbatim, casar aqui.
  const specHash = specApproved
    ? crypto.createHash("sha256")
        .update(
          [...files].sort((a, b) => a.filename.localeCompare(b.filename))
            .map((f) => f.buffer.toString("utf-8")).join("\n"),
          "utf-8",
        )
        .digest("hex")
    : null;

  // REUSO SILENCIOSO (Feature #65, parte 2) — INTRA-TENANT apenas, invisível ao usuário.
  // Fingerprint da spec normalizada; se este tenant já ENTREGOU um projeto com a mesma
  // spec (accepted/completed), registramos a proveniência para reaproveitar artefatos.
  // NÃO há texto de UI nem notificação — só log interno em nível debug.
  const specFingerprint = computeSpecFingerprint(files);
  let reusedFrom: string | null = null;
  try {
    const dup = await client.query(
      `SELECT id FROM projects
         WHERE tenant_id = $1 AND spec_fingerprint = $2
           AND status IN ('accepted', 'completed')
         ORDER BY updated_at DESC LIMIT 1`,
      [tenantId, specFingerprint],
    );
    if (dup.rows[0]) {
      reusedFrom = dup.rows[0].id as string;
      // Log interno (debug) — NUNCA exposto ao usuário.
      console.debug(
        `[silent-reuse] tenant=${tenantId} fp=${specFingerprint.slice(0, 12)} ` +
        `reuses project=${reusedFrom}`,
      );
      // TODO(reuse-clone): clonar de fato os artefatos/estrutura (código gerado, grafo de
      // tasks, repo) do projeto reutilizado para pular a regeneração. Por ora registramos
      // apenas a REFERÊNCIA de proveniência em extra.reused_from; o pipeline segue normal.
      // Não afirmamos ao usuário que houve reuso — não é um stub que mente.
    }
  } catch {
    // Coluna spec_fingerprint pode não existir em bancos sem a migração 043 — reuso é
    // best-effort; a criação de projeto nunca deve falhar por causa da detecção de reuso.
  }

  const extraJson = JSON.stringify({
    ...(reusedFrom ? { reused_from: reusedFrom } : {}),
    ...(freeDescription ? { free_description: freeDescription } : {}),
    ...(projectType ? { project_type: projectType } : {}),
    ...(deliveryFields.deliveryMode ? { delivery_mode: deliveryFields.deliveryMode } : {}),
    ...(deliveryFields.runtimeTarget ? { runtime_target: deliveryFields.runtimeTarget } : {}),
    ...(deliveryFields.dbMode ? { db_mode: deliveryFields.dbMode } : {}),
    ...(deliveryFields.hostTarget ? { host_target: deliveryFields.hostTarget } : {}),
    ...(deliveryFields.domainMode ? { domain_mode: deliveryFields.domainMode } : {}),
    // Item 2 (pré-seleção no envio da spec): conexão de cloud + formato + prazo (demo).
    ...sanitizeDeployPrefs(deliveryFields),
    ...(specApproved ? {
      spec_approved: true,
      approved_by: approverEmail ?? createdBy,
      approved_at: new Date().toISOString(),
      spec_hash: specHash,
    } : {}),
  });

  const projectResult = await client.query(
    `INSERT INTO projects (tenant_id, created_by, title, spec_ref, status, parent_project_id, version_number, extra, product_id, spec_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) RETURNING id`,
    [tenantId, createdBy, title, files[0].filename, isDraft ? "draft" : "spec_submitted",
     rootParentId, versionNumber, extraJson, productId, specFingerprint],
  );
  const projectId = projectResult.rows[0].id as string;

  // gravar arquivos em disco + registrar
  const projectDir = path.join(UPLOAD_DIR, projectId);
  await fs.mkdir(projectDir, { recursive: true });
  const saved: { filename: string; filePath: string; mimeType: string }[] = [];
  for (const f of files) {
    const safeName = `${Date.now()}-${path.basename(f.filename)}`;
    const filePath = path.join(projectDir, safeName);
    await fs.writeFile(filePath, f.buffer);
    saved.push({ filename: f.filename, filePath, mimeType: f.mimeType });
  }
  for (const f of saved) {
    await client.query(
      `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type) VALUES ($1, $2, $3, $4)`,
      [projectId, f.filename, f.filePath, f.mimeType],
    );
  }

  const hasNonMd = saved.some((f) => path.extname(f.filename).toLowerCase() !== ".md");
  let status: CreateProjectResult["status"] = isDraft ? "draft" : "spec_submitted";
  if (hasNonMd && !isDraft) {
    await client.query("UPDATE projects SET status = $1, updated_at = now() WHERE id = $2",
      ["pending_conversion", projectId]);
    status = "pending_conversion";
  }

  return { projectId, status };
}
