import { buildApp } from "./app.js";
import { initDb } from "./db/init.js";
import { seedIfEmpty } from "./db/seed.js";
import { startWatchdog, stopWatchdog } from "./services/watchdog.js";
import { startS3CleanupWorker, stopS3CleanupWorker } from "./services/s3CleanupWorker.js";
import { startS3ReconciliationWorker, stopS3ReconciliationWorker } from "./services/s3ReconciliationWorker.js";
import { startBackendResumeWorker, stopBackendResumeWorker } from "./services/provision/backendResumeWorker.js";
import { startBackendCleanupWorker, stopBackendCleanupWorker } from "./services/provision/backendCleanupWorker.js";

const app = await buildApp();

const port = parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";

// G1-T2: fail-closed em produção — endpoints internos (ex.: project-llm-config
// devolve a api_key de LLM do tenant) exigem token interno E JWT_SECRET reais.
// Sem eles, a autenticação ficaria fail-open / usaria secret de dev. Abortar.
if (process.env.NODE_ENV === "production") {
  const hasInternalToken = !!(process.env.GENESIS_API_TOKEN ?? process.env.GENESIS_INTERNAL_TOKEN ?? "").trim();
  if (!hasInternalToken) {
    console.error("[boot] FATAL: NODE_ENV=production sem GENESIS_API_TOKEN/GENESIS_INTERNAL_TOKEN — endpoints internos ficariam fail-open. Abortando.");
    process.exit(1);
  }
  if (!process.env.JWT_SECRET) {
    console.error("[boot] FATAL: NODE_ENV=production sem JWT_SECRET — verifyToken usaria o default de dev. Abortando.");
    process.exit(1);
  }
  // G1-T3: cifra de credenciais de cloud exige chave 64-hex real em produção.
  try {
    const { assertCryptoReady } = await import("./services/crypto.js");
    assertCryptoReady();
  } catch (e) {
    console.error("[boot] FATAL:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

try {
  await initDb();
  await seedIfEmpty();
  await app.listen({ port, host });
  console.log(`API listening on ${host}:${port}`);

  // Iniciar Watchdog de auto-recovery após a API estar pronta
  startWatchdog();
  // FT-17: cleanup TTL + watchdog órfãos de S3 static deploys
  startS3CleanupWorker();
  startS3ReconciliationWorker();
  // G1-T12: re-anexa deployments backend em fases não-terminais da cadeia SDK.
  startBackendResumeWorker();
  // G1-T22: watchdog por fase + sweep de teardown (separado do s3CleanupWorker).
  startBackendCleanupWorker();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Desligar workers graciosamente ao receber sinal de término
process.on("SIGTERM", () => { stopWatchdog(); stopS3CleanupWorker(); stopS3ReconciliationWorker(); stopBackendResumeWorker(); stopBackendCleanupWorker(); process.exit(0); });
process.on("SIGINT",  () => { stopWatchdog(); stopS3CleanupWorker(); stopS3ReconciliationWorker(); stopBackendResumeWorker(); stopBackendCleanupWorker(); process.exit(0); });
