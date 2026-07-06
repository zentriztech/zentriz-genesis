/**
 * deployMatrix.ts — G1-T23 (Fase E). Validação de matriz de deploy + allowlist.
 *
 * Rejeita combinações impossíveis ANTES de criar row/spec (evita deployment órfão):
 *   - runtime_target='s3' para tipo backend/fullstack → inválido
 *   - fullstack ⇒ ecs_fargate (app_runner não suporta multi-serviço) → rejeita apprunner+fullstack
 *   - tipo backend fora da allowlist do provisionador container → rejeitado sincronamente
 *
 * A allowlist é o conjunto de tipos NÃO-estáticos que o provisionador de container
 * (deployBackendCloud) sabe entregar no GATE 1. Tipos estáticos (frontend_*, static_site,
 * landing_page) seguem o path S3 e não passam por aqui.
 */

export type RuntimeTarget = "s3" | "ecs_fargate" | "app_runner" | "ec2";

/** Tipos backend/fullstack suportados pelo provisionador de container no GATE 1. */
export const BACKEND_ALLOWLIST = new Set<string>([
  "backend_api",
  "backend_api_node",
  "backend_api_python",
  "backend_graphql",
  "backend_worker",
  "fullstack_saas",
  "fullstack_ecommerce",
]);

/** Alvos de compute válidos. */
const VALID_TARGETS: RuntimeTarget[] = ["s3", "ecs_fargate", "app_runner", "ec2"];

/** Alvos que suportam multi-serviço (fullstack). app_runner é single-container. */
const MULTISERVICE_TARGETS = new Set<RuntimeTarget>(["ecs_fargate", "ec2"]);

export interface MatrixDecision {
  runtimeTarget: RuntimeTarget;
  isBackend: boolean;
  isFullstack: boolean;
  /** Mensagem de erro quando a combinação é inválida (dispatcher retorna 4xx). */
  error?: string;
}

/**
 * Decide e VALIDA o runtime_target de um projeto. Fonte única consumida por
 * resolveRuntimeTarget (dispatch + deployBackendCloud) e pela spec (G1-T23).
 */
export function validateDeployMatrix(
  projectType: string | null | undefined,
  extraTarget: string | null | undefined,
): MatrixDecision {
  const pt = (projectType ?? "").toLowerCase().trim();
  const isFullstack = pt.startsWith("fullstack");
  const isBackend = pt.startsWith("backend") || isFullstack;
  const explicit = (extraTarget ?? "").toLowerCase().trim();

  // Alvo explícito inválido (typo etc.) → erro claro.
  if (explicit && !(VALID_TARGETS as string[]).includes(explicit)) {
    return {
      runtimeTarget: isBackend ? "ecs_fargate" : "s3", isBackend, isFullstack,
      error: `runtime_target '${extraTarget}' inválido. Aceitos: ${VALID_TARGETS.join(", ")}.`,
    };
  }

  if (!isBackend) {
    // Estático/web: só s3 faz sentido; alvo de container p/ web é rejeitado.
    if (explicit && explicit !== "s3") {
      return { runtimeTarget: "s3", isBackend: false, isFullstack: false,
        error: `runtime_target '${extraTarget}' inválido para projeto web/estático (use s3).` };
    }
    return { runtimeTarget: "s3", isBackend: false, isFullstack: false };
  }

  // Backend/fullstack: precisa estar na allowlist do provisionador container.
  if (pt && !BACKEND_ALLOWLIST.has(pt)) {
    return {
      runtimeTarget: "ecs_fargate", isBackend, isFullstack,
      error: `project_type '${projectType}' não é suportado pelo provisionamento de container no GATE 1. ` +
             `Suportados: ${[...BACKEND_ALLOWLIST].join(", ")}.`,
    };
  }

  // runtime_target='s3' para backend → inválido.
  if (explicit === "s3") {
    return { runtimeTarget: "ecs_fargate", isBackend, isFullstack,
      error: "runtime_target='s3' inválido para projeto backend/fullstack." };
  }

  const target: RuntimeTarget = explicit ? (explicit as RuntimeTarget) : "ecs_fargate";

  // fullstack ⇒ alvo multi-serviço (rejeita app_runner+fullstack).
  if (isFullstack && !MULTISERVICE_TARGETS.has(target)) {
    return { runtimeTarget: "ecs_fargate", isBackend, isFullstack,
      error: `runtime_target '${target}' não suporta fullstack (multi-serviço). Use ecs_fargate.` };
  }

  return { runtimeTarget: target, isBackend, isFullstack };
}
