/**
 * runnerDispatch.ts — dispara o pipeline (/run) de um projeto via runner_server.
 * Extraído do bloco de cascata do POST /accept (projects.ts) para ser reutilizado
 * por: (a) a cascata de ondas (accept dispara dependentes) e (b) a ingestão de
 * produto (ADR-018: dispara a ONDA 0 automaticamente após decompor).
 *
 * Resolve spec + assina token de curta duração do dono do projeto + chama o
 * runner_server. Best-effort: loga e não lança (o chamador roda em setImmediate).
 * Só dispara projetos em status elegível para /run.
 */
import type { Pool } from "pg";

const RUNNABLE_STATUSES = new Set(["draft", "spec_submitted", "pending_conversion", "stopped", "failed"]);

export interface DispatchResult {
  projectId: string;
  dispatched: boolean;
  reason?: string;
}

/** Dispara o /run de UM projeto. Retorna se disparou (ou o motivo de não). */
export async function dispatchProjectRun(pool: Pool, projectId: string): Promise<DispatchResult> {
  const runnerServiceUrl = (process.env.RUNNER_SERVICE_URL ?? "").trim();
  const apiBaseUrl = (process.env.API_BASE_URL ?? "http://localhost:3000").trim();
  if (!runnerServiceUrl) return { projectId, dispatched: false, reason: "RUNNER_SERVICE_URL não definido" };

  const target = await pool.query("SELECT id, status, created_by, tenant_id FROM projects WHERE id=$1", [projectId]);
  const tp = target.rows[0] as Record<string, unknown> | undefined;
  if (!tp) return { projectId, dispatched: false, reason: "projeto não encontrado" };
  if (!RUNNABLE_STATUSES.has(tp.status as string)) {
    return { projectId, dispatched: false, reason: `status não elegível: ${tp.status}` };
  }

  const specRes = await pool.query(
    `SELECT file_path FROM project_spec_files WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  );
  const specPath = specRes.rows[0]?.file_path as string | undefined;
  if (!specPath) return { projectId, dispatched: false, reason: "spec não encontrada" };

  const { signToken } = await import("../auth.js");
  const userRes = await pool.query(`SELECT id, email, role FROM users WHERE id = $1`, [tp.created_by]);
  const u = userRes.rows[0] as Record<string, unknown> | undefined;
  if (!u) return { projectId, dispatched: false, reason: "usuário dono não encontrado" };
  const token = signToken(
    // Token de máquina (svc:"runner"): isenta os callbacks do runner do gate H3 (RFC H1).
    { sub: u.id as string, email: u.email as string, role: u.role as string, tenantId: tp.tenant_id as string | null, svc: "runner" },
    "24h",
  );

  const uploadDir = (process.env.UPLOAD_DIR ?? "/shared/uploads").trim();
  const runnerUploadDir = (process.env.RUNNER_UPLOAD_DIR ?? "").trim();
  let runBody: Record<string, string>;
  if (runnerUploadDir && specPath.startsWith(uploadDir)) {
    runBody = { projectId, specPath: `${runnerUploadDir}${specPath.slice(uploadDir.length)}`, apiBaseUrl, token };
  } else {
    const { readFileSync } = await import("fs");
    runBody = { projectId, specContent: readFileSync(specPath).toString("base64"), apiBaseUrl, token };
  }

  const res = await fetch(`${runnerServiceUrl.replace(/\/$/, "")}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(runBody),
    signal: AbortSignal.timeout(15000),
  });
  if (res.ok || res.status === 409) {
    return { projectId, dispatched: true };
  }
  const txt = await res.text().catch(() => "");
  return { projectId, dispatched: false, reason: `runner ${res.status}: ${txt.slice(0, 160)}` };
}
