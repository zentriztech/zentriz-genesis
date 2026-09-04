import { buildApp } from "./app.js";
import { initDb } from "./db/init.js";
import { seedIfEmpty } from "./db/seed.js";
import { startWatchdog, stopWatchdog } from "./services/watchdog.js";
import { startS3CleanupWorker, stopS3CleanupWorker } from "./services/s3CleanupWorker.js";
import { startS3ReconciliationWorker, stopS3ReconciliationWorker } from "./services/s3ReconciliationWorker.js";
import { startBackendResumeWorker, stopBackendResumeWorker } from "./services/provision/backendResumeWorker.js";
import { startBackendCleanupWorker, stopBackendCleanupWorker } from "./services/provision/backendCleanupWorker.js";
import { startFinanceBillingWorker, stopFinanceBillingWorker } from "./services/financeBillingWorker.js";
import { startSpecQuestionsWorker, stopSpecQuestionsWorker } from "./services/specQuestionsWorker.js";
import { startCreditReconciliationWorker, stopCreditReconciliationWorker } from "./services/creditReconciliationWorker.js";
import { startTenantStatusListener, stopTenantStatusListener } from "./services/tenantStatusCache.js";
import { startCloudDeployWorker, stopCloudDeployWorker } from "./services/cloudDeployWorker.js";

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
  // Rejeita também o valor default de dev: com ele, qualquer um forjaria tokens
  // (inclusive svc:"runner"/zentriz_admin) e furaria o gate H3 + RBAC (RFC-0002 F2).
  if (process.env.JWT_SECRET === "zentriz-genesis-dev-secret") {
    console.error("[boot] FATAL: NODE_ENV=production com JWT_SECRET igual ao default de dev — tokens forjáveis. Abortando.");
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

// Preflight NÃO-fatal do .pem do GitHub App: se GITHUB_APP_PRIVATE_KEY_FILE aponta para um
// arquivo ilegível, o push/criação de repo falha só no primeiro /accept (erro mascarado pelo
// try/catch dos callers → nenhum repo criado, causa não-óbvia). Surfacing cedo no boot, sem
// abortar (setups com App inline ou PAT legitimamente não têm arquivo).
try {
  const { checkGlobalAppKeyReadable } = await import("./services/github.js");
  const pem = checkGlobalAppKeyReadable();
  if (!pem.ok) {
    console.warn(`[boot] AVISO: GitHub App private key em '${pem.path}' ilegível (${pem.error}). Criação/push de repo falhará até corrigir; o restante da API sobe normalmente.`);
  }
} catch (e) {
  console.warn("[boot] AVISO: preflight do .pem do GitHub App falhou:", e instanceof Error ? e.message : String(e));
}

try {
  await initDb();
  await seedIfEmpty();
  // RFC-0004 T1.2: traduz extra.spec_hash aprovados p/ o hash canônico da árvore
  // (best-effort, idempotente; specs editadas pós-aprovação NÃO são lavadas).
  {
    const { backfillSpecApprovedHashes } = await import("./services/specHashBackfill.js");
    const { pool } = await import("./db/client.js");
    await backfillSpecApprovedHashes(pool);
    // RFC-0004 Onda 3: runs de validação órfãs de um deploy/restart → 'interrupted'
    // (a fila é a tabela; sem reaper, ficariam 'running' para sempre).
    const { reapOrphanValidationRuns } = await import("./services/specValidation.js");
    await reapOrphanValidationRuns(pool);
    // RFC-0004 T1.6b: propostas do Splitter órfãs de um deploy/restart → 'interrupted'
    // (mesma classe de furo — o job do propose deixou de viver num Map em memória).
    const { reapOrphanProposals } = await import("./services/productProposals.js");
    await reapOrphanProposals(pool).catch((e) => console.error("[boot] reapOrphanProposals:", e));
  }
  await app.listen({ port, host });
  console.log(`API listening on ${host}:${port}`);

  // Iniciar Watchdog de auto-recovery após a API estar pronta
  startWatchdog();
  // D3: escalada (TTL 72h) de perguntas da fábrica sem resposta do tenant.
  startSpecQuestionsWorker();
  // FT-17: cleanup TTL + watchdog órfãos de S3 static deploys
  startS3CleanupWorker();
  startS3ReconciliationWorker();
  // G1-T12: re-anexa deployments backend em fases não-terminais da cadeia SDK.
  startBackendResumeWorker();
  // G1-T22: watchdog por fase + sweep de teardown (separado do s3CleanupWorker).
  startBackendCleanupWorker();
  // RFC-0002 F2: vencimento de cobranças + suspensão por inadimplência.
  startFinanceBillingWorker();
  // Plano de Créditos F6 (decisão B): reconciliação do ledger de crédito por ciclo + alerta.
  startCreditReconciliationWorker();
  // RFC-0002 F2 / H3: invalidação cross-instância do cache de status de tenant (LISTEN/NOTIFY).
  startTenantStatusListener();
  // Item 2 (corrigido): monitor + auto-cura dos deploys na nuvem do tenant via GitHub.
  startCloudDeployWorker();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Desligar workers graciosamente ao receber sinal de término
process.on("SIGTERM", () => { stopWatchdog(); stopS3CleanupWorker(); stopS3ReconciliationWorker(); stopBackendResumeWorker(); stopBackendCleanupWorker(); stopFinanceBillingWorker(); stopCreditReconciliationWorker(); stopTenantStatusListener(); stopCloudDeployWorker(); process.exit(0); });
process.on("SIGINT",  () => { stopWatchdog(); stopS3CleanupWorker(); stopS3ReconciliationWorker(); stopBackendResumeWorker(); stopBackendCleanupWorker(); stopFinanceBillingWorker(); stopCreditReconciliationWorker(); stopTenantStatusListener(); stopCloudDeployWorker(); process.exit(0); });
