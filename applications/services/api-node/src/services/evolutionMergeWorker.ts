/**
 * evolutionMergeWorker.ts — Bloco 4 (M2): observador do merge das evoluções (D-M2).
 *
 * Contraparte ASSÍNCRONA do merge inline do aceite: no aceite a mergeabilidade pode ainda não estar
 * computada (checks pendentes → `blocked_checks`), ou o merge pode ter acontecido direto no GitHub.
 * Este tick relê as evoluções aceitas com PR aberto e ainda não mergeado e reexecuta
 * `tryAutoMergeEvolution` (SEM force — respeita a política `EVOLUTION_AUTO_MERGE`), que:
 *   • detecta o PR já mergeado no GitHub (merge externo) → grava + dispara hooks pós-merge;
 *   • conclui o auto-merge quando os checks finalmente ficam verdes;
 *   • ou apenas atualiza o estado legível (blocked_*).
 *
 * Atrás da flag própria `EVOLUTION_MERGE_WATCH` (default OFF). Fail-closed por instalação revogada é
 * garantido DENTRO de `tryAutoMergeEvolution` (blocked_permission). `actorUserId="external"` marca que
 * a conclusão veio do observador (e não do aceite humano/força manual). Best-effort: um erro em um
 * projeto nunca derruba o tick nem os demais.
 */
import { pool } from "../db/client.js";
import { tryAutoMergeEvolution } from "./evolutionMerge.js";

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

const INTERVAL_MS = Number(process.env.EVOLUTION_MERGE_WATCH_MS ?? 300_000); // 5 min
const BATCH = 20;

function watchEnabled(): boolean {
  return (process.env.EVOLUTION_MERGE_WATCH ?? "off").trim().toLowerCase() === "on";
}

/**
 * Um passo do observador: mergeia (ou reconcilia o estado de) as evoluções aceitas com PR pendente.
 * Exportado para teste. Idempotente e limitado (LIMIT) — seguro para rodar em cada tick.
 */
export async function reconcileEvolutionMerges(db: Db = pool as unknown as Db): Promise<{ scanned: number; merged: number }> {
  const res = await db.query(
    `SELECT id FROM projects
      WHERE status = 'accepted'
        AND extra->>'evolution' = 'true'
        AND extra->>'evolution_pr_number' IS NOT NULL
        AND extra->>'evolution_merged_at' IS NULL
        AND coalesce(extra->>'evolution_push_pending','') <> 'true'
      ORDER BY updated_at
      LIMIT ${BATCH}`,
  );
  const ids = (res.rows as Array<{ id: string }>).map((r) => r.id);
  let merged = 0;
  for (const id of ids) {
    try {
      const r = await tryAutoMergeEvolution(db as never, id, { actorUserId: "external" });
      if (r.state === "merged") merged++;
    } catch (e) {
      console.error(`[evolution-merge-watch] falha ao reconciliar ${id}:`, e instanceof Error ? e.message : String(e));
    }
  }
  return { scanned: ids.length, merged };
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false; // guarda contra ticks concorrentes se um tick passar de INTERVAL_MS

export function startEvolutionMergeWorker(): void {
  if (timer) return;
  if (!watchEnabled()) {
    console.info("[evolution-merge-watch] desligado (EVOLUTION_MERGE_WATCH!=on) — observador não iniciado.");
    return;
  }
  timer = setInterval(() => {
    if (running) return;
    running = true;
    reconcileEvolutionMerges()
      .then((r) => { if (r.merged > 0) console.info(`[evolution-merge-watch] ${r.merged}/${r.scanned} evolução(ões) mergeada(s) neste tick.`); })
      .catch((err) => console.error("[evolution-merge-watch]", err))
      .finally(() => { running = false; });
  }, INTERVAL_MS);
  console.info(`[evolution-merge-watch] observador iniciado (intervalo=${INTERVAL_MS / 1000}s).`);
}

export function stopEvolutionMergeWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
