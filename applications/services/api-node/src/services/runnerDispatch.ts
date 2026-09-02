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
import { checkDependencyGate } from "./dependencyGate.js";
import { checkSpecContentReady } from "./specContentGate.js";
import { claimSlotOrQueue, revertSlotClaim } from "./tenantLlmConfig.js";
import { scheduleFactoryStart } from "./opsNotify.js";
import { checkTenantBudget, budgetExceededMessage } from "./tenantCostCap.js";

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

  // RFC-0003 (G3/C3): a cascata/promoção passa pelo MESMO gate de dependência+contrato do
  // /run interativo — antes só o /run validava, e a onda-1+ podia começar sem o contrato do
  // predecessor em disco.
  const gate = await checkDependencyGate(pool, projectId);
  if (!gate.ok) {
    return { projectId, dispatched: false, reason: `${gate.block.code}: ${gate.block.message.slice(0, 160)}` };
  }

  // Cost cap mensal de LLM por TENANT (migration 068): a cascata/promoção passa pelo
  // MESMO gate do /run interativo — sem isto um tenant sobre o teto ainda gastava LLM
  // via gatilhos de accept/promote. Fail-safe: sem cap ⇒ segue; erro de infra ⇒
  // fail-open (checkTenantBudget nunca lança — ver services/tenantCostCap.ts).
  const budgetTenantId = (tp.tenant_id as string | null) ?? null;
  if (budgetTenantId) {
    const budget = await checkTenantBudget(pool, budgetTenantId);
    if (!budget.ok) {
      return {
        projectId,
        dispatched: false,
        reason: `TENANT_LLM_BUDGET_EXCEEDED: ${budgetExceededMessage(budget.spentUsd, budget.budgetUsd)}`,
      };
    }
  }

  const specRes = await pool.query(
    `SELECT file_path FROM project_spec_files WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  );
  const specPath = specRes.rows[0]?.file_path as string | undefined;
  if (!specPath) return { projectId, dispatched: false, reason: "spec não encontrada" };

  // Gate de CONTEÚDO (incidente Cabral 2026-08-29): barra spec-template/placeholder ANTES de
  // reservar slot e chamar o runner — custo ZERO de LLM. Sem isto, um template em branco roda a
  // fábrica inteira e termina em `blocked_backlog_empty_with_frs` sem tarefas.
  try {
    const { readFileSync } = await import("fs");
    const specText = readFileSync(specPath).toString("utf8");
    const contentGate = checkSpecContentReady(specText);
    if (!contentGate.ok) {
      return { projectId, dispatched: false, reason: `${contentGate.block.code}: ${contentGate.block.signals.join(",")}` };
    }
  } catch {
    // Falha ao ler o arquivo não bloqueia aqui — ausência de spec já é tratada acima e o
    // validador de intake do runner cobre o resto.
  }

  // RFC-0003 (C2): claim ATÔMICO de slot de concorrência antes de disparar (fecha o TOCTOU
  // do fan-out — promover N raízes de um produto de uma vez). Sem tenant (projeto solto),
  // não há teto por tenant → dispara direto. Guarda o status anterior p/ revert em falha.
  const tenantId = (tp.tenant_id as string | null) ?? null;
  let previousStatus: string | null = null;
  if (tenantId) {
    const claim = await claimSlotOrQueue(projectId, tenantId);
    if (claim.outcome === "queued") {
      return { projectId, dispatched: false, reason: "enfileirado — sem slot de concorrência" };
    }
    previousStatus = claim.previousStatus;
  }

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

  try {
    const res = await fetch(`${runnerServiceUrl.replace(/\/$/, "")}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(runBody),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok || res.status === 409) {
      scheduleFactoryStart(pool, projectId, { origin: "cascade" });
      return { projectId, dispatched: true };
    }
    const txt = await res.text().catch(() => "");
    // RFC-0003 (C2): dispatch falhou → libera o slot reservado no claim atômico.
    await revertSlotClaim(projectId, previousStatus);
    return { projectId, dispatched: false, reason: `runner ${res.status}: ${txt.slice(0, 160)}` };
  } catch (err) {
    await revertSlotClaim(projectId, previousStatus);
    const msg = err instanceof Error ? err.message : String(err);
    return { projectId, dispatched: false, reason: `falha ao chamar runner: ${msg.slice(0, 160)}` };
  }
}
