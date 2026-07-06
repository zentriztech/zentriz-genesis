/**
 * buildPlanForProject.ts — DM-T8b (borda). Ponte projeto → IR do plano (DM-T3).
 *
 * Lê o snapshot local do projeto (apps/) + o `extra` da spec (delivery_mode/db_mode/
 * domain) e compõe a IR via os módulos já prontos: resolveTopology (T24) +
 * planServiceSchemas (T26) + validateDeployMatrix (matriz) + buildProvisionPlan (T3).
 *
 * É a mesma IR que os drivers SDK consomem — o kit source_only reflete a infra real.
 */

import { join } from "node:path";
import { pool } from "../../db/client.js";
import { resolveTopology } from "./tenantProvisioner.js";
import { planServiceSchemas } from "./multiSchema.js";
import { validateDeployMatrix } from "./deployMatrix.js";
import { buildProvisionPlan, type ProvisionPlanIR, type DbMode } from "./provisionPlanIR.js";

const PROJECT_FILES_ROOT = () => (process.env.PROJECT_FILES_ROOT ?? "/project-files").trim();

export interface BuildPlanForProjectResult {
  ok: boolean;
  plan?: ProvisionPlanIR;
  code?: string;
  message?: string;
}

/** Mapeia db_mode livre da spec → DbMode do IR (auto quando ausente/desconhecido). */
function normalizeDbMode(raw: string | null | undefined): DbMode {
  const v = (raw ?? "").toLowerCase().trim();
  if (v === "rds" || v === "sidecar" || v === "none" || v === "external") return v;
  return "auto";
}

/**
 * Constrói a IR de um projeto para geração do kit source_only.
 * Não toca AWS; lê apps/ local + extra. Erros retornam code/message (nunca throw silencioso).
 */
export async function buildPlanForProject(projectId: string): Promise<BuildPlanForProjectResult> {
  const row = (await pool.query(
    "SELECT extra FROM projects WHERE id=$1", [projectId],
  )).rows[0];
  if (!row) return { ok: false, code: "NOT_FOUND", message: "Projeto não encontrado." };

  const extra = (row.extra as Record<string, unknown> | null) ?? {};
  const projectType = (extra.project_type as string | undefined) ?? null;
  const extraTarget = (extra.runtime_target as string | undefined) ?? null;
  const extraMode = (extra.delivery_mode as string | undefined) ?? null;
  const dbMode = normalizeDbMode(extra.db_mode as string | undefined);
  const domainMode = ((extra.domain_mode as string | undefined) === "custom") ? "custom" : "zentriz_subdomain";
  const customHostname = extra.custom_hostname as string | undefined;

  const decision = validateDeployMatrix(projectType, extraTarget, extraMode);
  // Nota: para source_only aceitamos QUALQUER tipo (web também gera kit — compose do
  // estático/SSR, sem DB). Só rejeitamos se a matriz apontar erro estrutural.
  if (decision.error && decision.deliveryMode !== "source_only") {
    return { ok: false, code: "INVALID_MATRIX", message: decision.error };
  }

  // Topologia a partir do snapshot local apps/.
  const appsDir = join(PROJECT_FILES_ROOT(), projectId, "apps");
  let topology;
  try {
    topology = await resolveTopology(appsDir, projectId);
  } catch (err) {
    return { ok: false, code: "TOPOLOGY_ERROR", message: err instanceof Error ? err.message : String(err) };
  }

  // Databases por serviço api (multi-schema). Conn é placeholder — no kit os segredos são
  // do cliente; só precisamos dos NOMES de database aqui.
  const schemas = planServiceSchemas(
    projectId, topology.services,
    { host: "db", port: 5432, user: "genesis", password: "${DB_PASSWORD}" },
  );
  const serviceDatabases: Record<string, string> = {};
  for (const s of schemas) serviceDatabases[s.serviceName] = s.databaseName;

  const plan = buildProvisionPlan({
    projectId,
    topology,
    deliveryMode: decision.deliveryMode,
    runtimeTarget: decision.runtimeTarget,
    dbMode,
    serviceDatabases,
    domainMode,
    customHostname,
  });
  return { ok: true, plan };
}
