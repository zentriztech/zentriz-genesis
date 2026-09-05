/**
 * specSnapshots.ts — rede de segurança da spec (GAP sistêmico G2, migração 092).
 *
 * Medido em prod 2026-09-05: `project_spec_files` guarda UMA versão viva por projeto e NÃO havia
 * nenhuma tabela de versão. O modo autônomo reescreve o arquivo no disco a cada rodada
 * (`writeFile` in-place); depois de 5 rodadas, 7 das 14 seções da spec do NVX LastMile tinham
 * desaparecido, e só foi possível recuperar porque existia um backup MANUAL feito à mão antes.
 *
 * Contrato: guardamos o conteúdo **ANTERIOR** (o que está sendo substituído), nunca o novo. Assim
 * a última linha da tabela é sempre "o estado ao qual eu posso voltar".
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { sha256Hex } from "../lib/specTreeHash.js";

type Db = Pick<Pool, "query">;

/** Quantas versões anteriores mantemos por (projeto, arquivo). Specs chegam a ~100 kB cada. */
export const SPEC_SNAPSHOT_KEEP = 10;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface SnapshotInput {
  projectId: string;
  filePath: string;
  /** Conteúdo ANTERIOR (o que será sobrescrito). Vazio/nulo → nada a guardar. */
  content: string | null | undefined;
  /** Por que estamos sobrescrevendo: `autonomy:round-3`, `manual-patch`, `evolution`… */
  reason: string;
  /** Quem disparou a escrita (user id, ou o id da run autônoma). */
  createdBy?: string | null;
}

/**
 * Grava o snapshot e poda o histórico. Devolve `true` se há uma versão anterior recuperável
 * (snapshot novo gravado OU o último snapshot já é idêntico ao conteúdo atual — nada a fazer).
 *
 * NÃO lança: o chamador decide se a falha é fatal. No caminho autônomo é (sem rede não se
 * sobrescreve nada); no PATCH manual é best-effort (o humano tem o conteúdo no editor).
 */
export async function snapshotSpecFile(db: Db, input: SnapshotInput): Promise<boolean> {
  const content = input.content ?? "";
  if (!content.trim()) return true; // nada a perder — não existe conteúdo anterior
  const sha = sha256Hex(Buffer.from(content, "utf-8"));
  try {
    const last = (await db.query(
      "SELECT content_sha256 FROM project_spec_snapshots WHERE project_id = $1 AND file_path = $2 ORDER BY created_at DESC LIMIT 1",
      [input.projectId, input.filePath],
    )).rows[0] as { content_sha256?: string } | undefined;
    // Idempotente: duas escritas seguidas a partir da MESMA base não geram duas cópias iguais.
    if (last?.content_sha256 === sha) return true;

    await db.query(
      `INSERT INTO project_spec_snapshots (id, project_id, file_path, content, content_sha256, chars, reason, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), input.projectId, input.filePath, content, sha, content.length,
        input.reason.slice(0, 200), input.createdBy ?? null],
    );
    // Poda: mantém as N mais recentes deste arquivo. Sem isto, 5 rodadas × 100 kB × N projetos
    // engordam o dump do Postgres sem limite.
    await db.query(
      `DELETE FROM project_spec_snapshots
        WHERE project_id = $1 AND file_path = $2
          AND id NOT IN (
            SELECT id FROM project_spec_snapshots
             WHERE project_id = $1 AND file_path = $2
             ORDER BY created_at DESC LIMIT $3
          )`,
      [input.projectId, input.filePath, SPEC_SNAPSHOT_KEEP],
    );
    return true;
  } catch (e) {
    console.warn(`[SpecSnapshots] falhou project=${input.projectId} file=${input.filePath}: ${msg(e)}`);
    return false;
  }
}

export interface SpecSnapshot {
  id: string;
  filePath: string;
  contentSha256: string;
  chars: number;
  reason: string;
  createdBy: string | null;
  createdAt: string;
}

/** Lista de versões recuperáveis (SEM o `content`: são até 10 × ~100 kB por arquivo). */
export async function listSpecSnapshots(
  db: Db, projectId: string, filePath?: string | null,
): Promise<SpecSnapshot[]> {
  try {
    const rows = (await db.query(
      `SELECT id, file_path, content_sha256, chars, reason, created_by, created_at
         FROM project_spec_snapshots
        WHERE project_id = $1 AND ($2::text IS NULL OR file_path = $2)
        ORDER BY created_at DESC LIMIT 50`,
      [projectId, filePath ?? null],
    )).rows as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      filePath: String(r.file_path),
      contentSha256: String(r.content_sha256),
      chars: Number(r.chars ?? 0),
      reason: String(r.reason ?? ""),
      createdBy: (r.created_by as string | null) ?? null,
      createdAt: new Date(String(r.created_at)).toISOString(),
    }));
  } catch (e) {
    console.warn(`[SpecSnapshots] listSpecSnapshots falhou: ${msg(e)}`);
    return [];
  }
}

/** Conteúdo de um snapshot (para o humano comparar/restaurar). */
export async function getSpecSnapshotContent(
  db: Db, projectId: string, snapshotId: string,
): Promise<{ filePath: string; content: string } | null> {
  const r = (await db.query(
    "SELECT file_path, content FROM project_spec_snapshots WHERE id = $1 AND project_id = $2",
    [snapshotId, projectId],
  )).rows[0] as { file_path?: string; content?: string } | undefined;
  if (!r?.file_path || typeof r.content !== "string") return null;
  return { filePath: String(r.file_path), content: r.content };
}
