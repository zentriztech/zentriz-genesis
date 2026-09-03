/**
 * specHashBackfill.ts — RFC-0004 T1.2: tradução one-shot dos `extra.spec_hash` aprovados
 * da fórmula LEGADA para o hash canônico da árvore (specTreeHash.ts).
 *
 * Sem isto, o runner (que recomputa do disco com a fórmula NOVA no intake) veria TODOS os
 * projetos spec-approved existentes como "spec editada após aprovação" → falso
 * `spec_validation_failed`.
 *
 * Regra anti-lavagem: só traduz se o CONTEÚDO ATUAL do disco ainda bate com o hash
 * armazenado sob a fórmula VELHA. Spec editada depois da aprovação → hash velho não bate →
 * fica como está (o gate DEVE falhar para ela). Idempotente: um extra.spec_hash_v2 marca
 * a linha como traduzida; boots seguintes pulam.
 *
 * Best-effort: nunca derruba o boot (loga e segue).
 */
import { readFile } from "fs/promises";
import type { Pool } from "pg";
import { computeSpecTreeHash, legacySpecHash, sha256Hex } from "../lib/specTreeHash.js";

export async function backfillSpecApprovedHashes(pool: Pool): Promise<void> {
  try {
    const projects = await pool.query(
      `SELECT id, extra->>'spec_hash' AS stored
         FROM projects
        WHERE extra->>'spec_approved' = 'true'
          AND extra->>'spec_hash' IS NOT NULL
          AND extra->>'spec_hash_v2' IS NULL`,
    );
    if (projects.rows.length === 0) return;
    let translated = 0, skipped = 0;
    for (const p of projects.rows as Array<{ id: string; stored: string }>) {
      try {
        const files = (await pool.query(
          `SELECT filename, file_path, rel_dir FROM project_spec_files WHERE project_id = $1`,
          [p.id],
        )).rows as Array<{ filename: string; file_path: string; rel_dir: string }>;
        if (files.length === 0) { skipped++; continue; }
        const contents = await Promise.all(files.map(async (f) => ({
          ...f, buffer: await readFile(f.file_path),
        })));
        const legacy = legacySpecHash(contents.map((c) => ({ filename: c.filename, content: c.buffer.toString("utf-8") })));
        if (legacy !== p.stored) { skipped++; continue; } // editada pós-aprovação: NÃO lavar
        const fresh = computeSpecTreeHash(contents.map((c) => ({
          relDir: c.rel_dir ?? "", filename: c.filename, contentSha256: sha256Hex(c.buffer),
        })));
        await pool.query(
          `UPDATE projects
              SET extra = extra || jsonb_build_object('spec_hash', $1::text, 'spec_hash_v2', 'true'),
                  updated_at = now()
            WHERE id = $2`,
          [fresh, p.id],
        );
        translated++;
      } catch (e) {
        skipped++;
        console.warn(`[spec-hash-backfill] projeto ${p.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    console.log(`[spec-hash-backfill] ${translated} traduzido(s), ${skipped} mantido(s) (editados/ilegíveis — gate deve falhar p/ eles).`);
  } catch (e) {
    console.warn(`[spec-hash-backfill] falhou (best-effort, boot segue): ${e instanceof Error ? e.message : String(e)}`);
  }
}
