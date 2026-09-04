/**
 * runPostMergeHooks.ts — Bloco 4: orquestração dos hooks pós-merge de uma evolução.
 *
 * Chamado UMA vez por merge (via `recordMergedAndHooks` no `evolutionMerge.ts` e pelo observador
 * `evolutionMergeWorker.ts`). Cada hook é INDEPENDENTE, atrás da SUA flag e com SEU estado próprio em
 * `extra` (`WHERE … IS NULL` → idempotente, GAP 14); a falha de um nunca derruba o merge nem os demais.
 *
 * Os hooks concretos entram nas PRs seguintes:
 *  - M3 (Auto Care): `realignAfterMerge` + `handoffMonitoring`  (flag EVOLUTION_POST_MERGE_REALIGN)
 *  - M6 (redeploy):  `redeployAfterMerge`                        (flag EVOLUTION_AUTO_REDEPLOY)
 * Enquanto uma PR não entrou, o hook correspondente simplesmente não roda (flag OFF por default).
 */
import type { Pool } from "pg";

type Db = Pick<Pool, "query">;

function flagOn(name: string): boolean {
  return (process.env[name] ?? "off").trim().toLowerCase() === "on";
}

export interface PostMergeContext {
  /** SHA do commit de merge em `dev` (para realinhamento e deploy por SHA). */
  mergeSha?: string;
}

/**
 * Dispara os hooks pós-merge conforme as flags. Best-effort: captura a falha de cada hook em
 * separado e a registra, sem propagar (o merge já aconteceu e não pode ser desfeito por um hook).
 */
export async function runPostMergeHooks(db: Db, childId: string, ctx: PostMergeContext = {}): Promise<void> {
  // Item 3 — Auto Care: realinhar a working tree para `dev` + migrar o monitoramento ao filho.
  if (flagOn("EVOLUTION_POST_MERGE_REALIGN")) {
    try {
      const { realignAfterMerge } = await import("./realignWorkingTree.js");
      await realignAfterMerge(db, childId, ctx.mergeSha);
    } catch (e) {
      console.warn(`[postMerge] realign falhou para ${childId} (não-fatal):`, e instanceof Error ? e.message : String(e));
    }
    try {
      const { handoffMonitoring } = await import("./handoffMonitoring.js");
      await handoffMonitoring(db, childId);
    } catch (e) {
      console.warn(`[postMerge] handoff de monitoramento falhou para ${childId} (não-fatal):`, e instanceof Error ? e.message : String(e));
    }
  }

  // Item 2 — Redeploy in-place com a mesma identidade (só se havia deploy anterior na linhagem).
  if (flagOn("EVOLUTION_AUTO_REDEPLOY")) {
    try {
      const { redeployAfterMerge } = await import("./redeployAfterMerge.js");
      await redeployAfterMerge(db, childId, ctx.mergeSha);
    } catch (e) {
      console.warn(`[postMerge] redeploy falhou para ${childId} (não-fatal):`, e instanceof Error ? e.message : String(e));
    }
  }
}
