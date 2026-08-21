/**
 * cloudDeployWorker.ts — Item 2 (corrigido). Monitor + auto-cura dos deploys via GitHub.
 *
 * "Genesis empurra e monitora ... a responsabilidade é nossa até o github retornar OK."
 * Tick periódico que reenvia pendentes, acompanha runs e faz teardown de demos vencidas.
 * Toda a lógica (idempotente/bounded) vive em provision/cloudDeploy.reconcileCloudDeployments.
 */
import { reconcileCloudDeployments } from "./provision/cloudDeploy.js";

let timer: ReturnType<typeof setInterval> | null = null;
let running = false; // guarda contra ticks concorrentes se um reconcile passar de INTERVAL_MS
const INTERVAL_MS = Number(process.env.CLOUD_DEPLOY_POLL_MS ?? 30_000); // 30s

export function startCloudDeployWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    // Se o tick anterior ainda está rodando (reconcile > INTERVAL_MS), pula este — evita dois
    // reconciles concorrentes disparando/tearing o mesmo deploy.
    if (running) return;
    running = true;
    reconcileCloudDeployments()
      .catch((err) => console.error("[cloud-deploy]", err))
      .finally(() => { running = false; });
  }, INTERVAL_MS);
  console.info(`[cloud-deploy] worker iniciado (intervalo=${INTERVAL_MS / 1000}s)`);
}

export function stopCloudDeployWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
