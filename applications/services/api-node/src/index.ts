import { buildApp } from "./app.js";
import { initDb } from "./db/init.js";
import { seedIfEmpty } from "./db/seed.js";
import { startWatchdog, stopWatchdog } from "./services/watchdog.js";
import { startS3CleanupWorker, stopS3CleanupWorker } from "./services/s3CleanupWorker.js";
import { startS3ReconciliationWorker, stopS3ReconciliationWorker } from "./services/s3ReconciliationWorker.js";

const app = await buildApp();

const port = parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";

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
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Desligar workers graciosamente ao receber sinal de término
process.on("SIGTERM", () => { stopWatchdog(); stopS3CleanupWorker(); stopS3ReconciliationWorker(); process.exit(0); });
process.on("SIGINT",  () => { stopWatchdog(); stopS3CleanupWorker(); stopS3ReconciliationWorker(); process.exit(0); });
