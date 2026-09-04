/**
 * evolutionState.ts — Bloco 4 (M0): leitura do checkpoint do runner de uma evolução.
 *
 * Extraído de `routes/evolutionPlan.ts` (GET /evolution-state) para ser reutilizado pelo gate
 * PASS_TO_PASS do merge automático (`services/evolutionMerge.ts`). O runner grava o checkpoint no
 * volume compartilhado `.runner-state/<projectId>/checkpoint.json` (read-only para a API). Sem
 * PROJECT_FILES_ROOT / sem arquivo → `null` (o chamador decide o fail-closed).
 */
export async function readEvolutionCheckpoint(projectId: string): Promise<Record<string, unknown> | null> {
  const filesRoot = (process.env.PROJECT_FILES_ROOT ?? "").trim();
  if (!filesRoot) return null;
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const p = join(filesRoot, ".runner-state", projectId, "checkpoint.json");
    let raw = await readFile(p, "utf-8");
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // O runner pode estar gravando (JSON parcial): 1 releitura curta antes de desistir.
      await new Promise((r) => setTimeout(r, 150));
      raw = await readFile(p, "utf-8");
      return JSON.parse(raw) as Record<string, unknown>;
    }
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      console.warn(`[evolution-state] checkpoint ilegível para ${projectId}:`, e instanceof Error ? e.message : String(e));
    }
    return null;
  }
}
