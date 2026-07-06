/**
 * backendResumeWorker.ts — G1-T12 (Fase C).
 *
 * Resume-no-boot: ao subir o processo, re-anexa os deployments backend que ficaram
 * em fases não-terminais (o processo pode ter morrido no meio da cadeia SDK).
 *
 * - Deployments que já passaram do build (têm imagem no ECR: ecr_repo_uri OU status
 *   além de 'pushing') → re-executa a cadeia SDK, que é idempotente (describe-before-
 *   create via ledger) e não duplica recursos.
 * - Deployments ainda em provisioning/building/pushing SEM artefato → o build acontece
 *   no host; se o host reiniciou, o watchdog (T22) os reconcilia. Aqui não re-disparamos
 *   o build (o runner é fire-and-forget do host) para não duplicar imagens.
 *
 * Executa uma vez no boot, após um pequeno atraso (deixa o DB/pool prontos).
 */

import { listResumableDeployments } from "./backendState.js";
import { runProvisionChain, orderedDrivers } from "./provisionChain.js";
import "./drivers.js"; // registra os drivers da cadeia (side-effect)

let _timer: ReturnType<typeof setTimeout> | null = null;

const SDK_PHASES = new Set(["migrating", "creating_service", "waiting_cert_dns"]);

export function startBackendResumeWorker(delayMs = 8000): void {
  if (_timer) return;
  _timer = setTimeout(() => { void resumeOnce(); }, delayMs);
}

export function stopBackendResumeWorker(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

async function resumeOnce(): Promise<void> {
  // Sem drivers registrados (estado T12) → nada a re-anexar na cadeia SDK.
  if (orderedDrivers().length === 0) return;
  let rows;
  try { rows = await listResumableDeployments(); } catch { return; }
  for (const dep of rows) {
    // Re-anexa apenas quem já tem artefato E está numa fase da cadeia SDK.
    const inSdkChain = SDK_PHASES.has(dep.status);
    const hasArtifact = !!dep.ecr_repo_uri;
    if (inSdkChain && hasArtifact) {
      // Re-executa a cadeia (idempotente). Erros marcam 'failed' + compensam internamente.
      void runProvisionChain(dep).catch(() => { /* já tratado no chain */ });
    }
  }
}
