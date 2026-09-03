/**
 * specTreeHash.ts — RFC-0004 (F1/F4): hash canônico da ÁRVORE de spec.
 *
 * Substitui a fórmula legada (concat dos conteúdos ordenados por filename, join "\n"),
 * que a auditoria adversarial provou MENTIR em 3 cenários:
 *   1. mover arquivo entre pastas não mudava o hash (nem filename nem rel_dir entravam);
 *   2. o join("\n") é ambíguo — mover a última linha de a.md para o topo de b.md
 *      produz a MESMA concatenação;
 *   3. o desempate de ordenação divergia entre API (localeCompare) e runner (codepoint).
 *
 * Fórmula canônica (estilo git-tree, determinística byte a byte):
 *   linha  = relDir + "\0" + filename + "\0" + sha256hex(bytes do arquivo) + "\n"
 *   linhas ordenadas por comparação BINÁRIA (codepoint — nunca localeCompare)
 *   spec_hash = sha256hex(concat(linhas))
 *
 * O ESPELHO Python vive em applications/orchestrator/spec_tree_hash.py — os dois lados
 * têm teste de paridade com os MESMOS fixtures (specTreeHash.test.ts / test_spec_tree_hash.py).
 * Qualquer mudança aqui DEVE mudar lá junto, e vice-versa.
 *
 * Estado (status de validação) NUNCA vive dentro dos arquivos (seria auto-referente e
 * forjável) — por isso o hash é sobre os bytes crus, sem normalização de frontmatter.
 */
import crypto from "crypto";

/** Tetos anti-abuso (RFC-0004 §6.1): recusa specs fora do envelope. */
export const SPEC_TREE_MAX_FILES = 200;
export const SPEC_TREE_MAX_FILE_BYTES = 256 * 1024;
export const SPEC_TREE_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export interface SpecTreeEntry {
  relDir: string;      // '' = raiz
  filename: string;
  /** sha256 hex do conteúdo do arquivo (content_sha256 da tabela, ou computado na hora). */
  contentSha256: string;
}

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Comparação binária por code unit (equivale a codepoint p/ os charsets sanitizados). */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class SpecTreeLimitError extends Error {
  constructor(message: string) { super(message); this.name = "SpecTreeLimitError"; }
}

/**
 * Hash canônico da árvore. `entries` já traz o sha por arquivo — quem tem os bytes
 * usa `hashSpecTreeFromBuffers`. Lança SpecTreeLimitError acima dos tetos.
 */
export function computeSpecTreeHash(entries: SpecTreeEntry[]): string {
  if (entries.length > SPEC_TREE_MAX_FILES) {
    throw new SpecTreeLimitError(`spec excede ${SPEC_TREE_MAX_FILES} arquivos (${entries.length})`);
  }
  const lines = entries
    .map((e) => `${e.relDir}\0${e.filename}\0${e.contentSha256}\n`)
    .sort(byteCompare);
  return sha256Hex(lines.join(""));
}

/** Conveniência para o caminho de criação (buffers em mãos). Aplica tetos de tamanho. */
export function hashSpecTreeFromBuffers(
  files: Array<{ relDir?: string; filename: string; buffer: Buffer }>,
): { specHash: string; perFile: Array<{ relDir: string; filename: string; contentSha256: string }> } {
  let total = 0;
  const perFile = files.map((f) => {
    if (f.buffer.length > SPEC_TREE_MAX_FILE_BYTES) {
      throw new SpecTreeLimitError(`arquivo ${f.filename} excede ${SPEC_TREE_MAX_FILE_BYTES} bytes`);
    }
    total += f.buffer.length;
    return { relDir: f.relDir ?? "", filename: f.filename, contentSha256: sha256Hex(f.buffer) };
  });
  if (total > SPEC_TREE_MAX_TOTAL_BYTES) {
    throw new SpecTreeLimitError(`spec agregada excede ${SPEC_TREE_MAX_TOTAL_BYTES} bytes`);
  }
  return { specHash: computeSpecTreeHash(perFile), perFile };
}

/**
 * Fórmula LEGADA (só para o backfill de migração — comparar o hash armazenado com o
 * estado atual do disco ANTES de traduzir para a fórmula nova; specs editadas após a
 * aprovação NÃO são "lavadas"). Não usar em código novo.
 */
export function legacySpecHash(files: Array<{ filename: string; content: string }>): string {
  const joined = [...files]
    .sort((a, b) => a.filename.localeCompare(b.filename))
    .map((f) => f.content)
    .join("\n");
  return sha256Hex(Buffer.from(joined, "utf-8"));
}
