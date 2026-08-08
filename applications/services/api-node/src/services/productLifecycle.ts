/**
 * productLifecycle.ts — estado AGREGADO de um produto a partir dos status dos seus
 * projetos (ADR-018 / Cenário A, correção adversária A2).
 *
 * `deriveProductLifecycle` é uma FUNÇÃO PURA (sem I/O) — recebe a lista de status
 * dos projetos do produto e devolve o lifecycle_status agregado. `recomputeProductLifecycle`
 * é o wrapper com I/O que lê os status do banco, deriva e grava (idempotente).
 *
 * Regra central (A2): se QUALQUER projeto está `blocked_cyborg` (Cyborg devolveu
 * NEEDS_HUMAN), o produto está `stalled_waiting_human` — a onda a jusante travou e o
 * portal precisa mostrar isso. Precedência: failed > stalled > accepted-total >
 * partial > running > ingesting.
 */
import type { Pool, PoolClient } from "pg";

export type ProductLifecycle =
  | "ingesting"
  | "running"
  | "partially_accepted"
  | "stalled_waiting_human"
  | "accepted"
  | "failed";

/** Status de projeto que contam como "ainda não terminou / em andamento". */
const IN_PROGRESS = new Set<string>([
  "draft", "spec_submitted", "pending_conversion", "spec_validation_failed",
  "running", "dev_qa", "devops", "completed", "stopped", "pending_cyborg",
]);

/**
 * Deriva o estado agregado do produto a partir dos status dos seus projetos.
 * Sem projetos → 'ingesting' (produto criado, projetos ainda materializando).
 */
export function deriveProductLifecycle(projectStatuses: string[]): ProductLifecycle {
  if (projectStatuses.length === 0) return "ingesting";

  const hasFailed  = projectStatuses.some((s) => s === "failed");
  const hasBlocked = projectStatuses.some((s) => s === "blocked_cyborg");
  const accepted   = projectStatuses.filter((s) => s === "accepted").length;
  const inProgress = projectStatuses.some((s) => IN_PROGRESS.has(s));

  // Precedência: falha dura > travado por humano > tudo aceito > parcial > em andamento.
  if (hasFailed)  return "failed";
  if (hasBlocked) return "stalled_waiting_human";
  if (accepted === projectStatuses.length) return "accepted";
  if (accepted > 0 && inProgress) return "partially_accepted";
  if (inProgress) return "running";
  // Fallback defensivo (estados não mapeados como archived): trata como em andamento.
  return "running";
}

/**
 * Lê os status dos projetos do produto, deriva o lifecycle e grava se mudou.
 * Idempotente e não-crítico: em erro, apenas loga (nunca derruba o accept/reject).
 * Usa o `db` fornecido (Pool ou PoolClient da transação do chamador).
 * Retorna o novo lifecycle, ou null se o produto não existe / nada a fazer.
 */
export async function recomputeProductLifecycle(
  db: Pool | PoolClient,
  productId: string | null | undefined,
): Promise<ProductLifecycle | null> {
  if (!productId) return null;
  try {
    const res = await db.query(
      "SELECT status FROM projects WHERE product_id = $1",
      [productId],
    );
    const statuses = res.rows.map((r) => String((r as { status: unknown }).status));
    const lifecycle = deriveProductLifecycle(statuses);
    await db.query(
      "UPDATE products SET lifecycle_status = $1, updated_at = now() WHERE id = $2 AND lifecycle_status IS DISTINCT FROM $1",
      [lifecycle, productId],
    );
    return lifecycle;
  } catch (e) {
    console.error(`[PRODUCT-LIFECYCLE] Falha ao recomputar produto ${productId}:`, e);
    return null;
  }
}
