/**
 * Backfill D1 — materializa a spec dos projetos semeados com `file_path` RELATIVO.
 *
 * PROBLEMA MEDIDO EM PROD (2026-09-05): 28 das 58 linhas de `project_spec_files` têm
 * `file_path = 'specs/<título>.md'` — path RELATIVO gravado pelo `seed-venuxx-v2.ts`, apontando
 * para um arquivo que NUNCA existiu em disco (confirmado no container da api: não há `specs/`
 * em `/shared/uploads` nem no cwd). Consequência: tudo que resolve a spec pelo disco
 * (validação adversarial, promoção, contexto do CTO, evolução) falha ou lê vazio nesses 28
 * projetos do produto "Venuxx V2". As outras 30 linhas são uploads reais e seguem o formato
 * canônico do `projectCreation.ts`: `<UPLOAD_DIR>/<projectId>/<filename>`.
 *
 * ⚠️ CORREÇÃO DE PREMISSA (medida em prod 2026-09-05, DEPOIS da 1ª versão deste script): o conteúdo
 * original NÃO está perdido. Os **28/28** projetos têm a spec semeada em
 * `/project-files/<projectId>/docs/spec_<título>.md` (366–457 bytes, cabeçalho `<!-- Created by: spec -->`,
 * escrita pelo runner no registro do projeto). Ela é curta, mas é o **artefato real**; e o que o banco
 * sabe é POBRE em comparação: `charter_summary` é literalmente o "## Objetivo" desse arquivo e
 * `backlog_summary` é um contador ("1 módulo, 2 tarefas") — usá-lo como "escopo entregue" seria ruído.
 * `content_sha256` é NULL nas 28 linhas → não há como casar por hash (isto refuta a nota antiga de
 * "backfill com conferência de content_sha256").
 *
 * O QUE ESTE SCRIPT FAZ (decisão do Jean, 2026-09-05 — materializar arquivo e corrigir o path):
 * copia a spec semeada **verbatim** para o caminho canônico e acrescenta um apêndice que declara a
 * procedência e as lacunas. Só quando não houver spec semeada em disco é que cai no esqueleto derivado
 * do inventário. Grava em `<UPLOAD_DIR>/<projectId>/<slug>.md` e corrige as três referências:
 *   • `project_spec_files.file_path`  → caminho ABSOLUTO do arquivo criado
 *   • `project_spec_files.filename`   → basename real em disco (+ `content_sha256`, `mime_type`)
 *   • `projects.spec_ref`             → só o filename (é assim que o `projectCreation.ts` grava)
 *
 * O documento gerado declara sua própria procedência e lista o que NÃO contém. Isso é
 * deliberado: o CTO e o validador adversarial vão apontar GAPs nesses projetos — e devem, porque
 * a lacuna é real. O que não podemos é fabricar requisito inexistente e passá-lo por spec.
 *
 * Uso (no container da api em PROD, com o JS compilado):
 *   node dist/db/backfill-venuxx-v2-spec-files.js            # DRY-RUN (default): não grava nada
 *   node dist/db/backfill-venuxx-v2-spec-files.js --commit   # grava arquivos + COMMIT
 *
 * Idempotente: só toca linhas cujo `file_path` NÃO é absoluto. Reexecutar depois do commit é
 * no-op. Em dry-run nenhum arquivo é criado (escrita em disco não volta atrás com ROLLBACK).
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pool } from "./client.js";

const UPLOAD_DIR = (process.env.UPLOAD_DIR ?? "/shared/uploads").trim();
const PROJECT_FILES_ROOT = (process.env.PROJECT_FILES_ROOT ?? "/project-files").trim();

interface Row {
  file_id: string;
  project_id: string;
  filename: string;
  file_path: string;
  rel_dir: string;
  title: string;
  status: string;
  charter_summary: string | null;
  backlog_summary: string | null;
  project_type: string | null;
  stack: string | null;
  product_name: string | null;
  created_at: string;
}

/** Nome de arquivo seguro derivado do título do projeto (o título já é um slug técnico). */
function slugify(title: string): string {
  const base = title
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "spec"}.md`;
}

/** Bloco de lacunas — idêntico nos dois caminhos (spec semeada ou esqueleto do inventário). */
const LACUNAS = `## Lacunas declaradas (o que este documento NÃO especifica)

- L-01 — Requisitos funcionais detalhados e critérios de aceite.
- L-02 — Contratos de API/evento (rotas, payloads, códigos de erro) e versionamento.
- L-03 — Modelo de dados e regras de persistência.
- L-04 — Requisitos não funcionais (SLO, limites, custo, retenção).
- L-05 — Segurança: autenticação, autorização, tratamento de PII.
- L-06 — Declaração Connect (\`connect.yaml\`) e matriz de compatibilidade.
- L-07 — Observabilidade: métricas, logs, alertas e runbook.

> Fechar L-01…L-07 exige a spec real da aplicação ou uma engenharia reversa do repositório —
> nenhuma das duas pode ser inferida do inventário sem inventar requisito.`;

/**
 * Localiza a spec semeada em disco: `<PROJECT_FILES_ROOT>/<projectId>/docs/spec_*.md`.
 * Preferência pelo nome que casa com o título (`spec_<slug>`); se não houver, o primeiro `spec_*.md`.
 * Devolve `null` quando não existe nada aproveitável (aí o backfill cai no esqueleto do inventário).
 */
export async function findSeededSpec(
  projectId: string,
  title: string,
): Promise<{ path: string; content: string } | null> {
  const docsDir = path.join(PROJECT_FILES_ROOT, projectId, "docs");
  let names: string[];
  try { names = await fs.readdir(docsDir); } catch { return null; }
  const cands = names.filter((n) => n.startsWith("spec_") && n.endsWith(".md"));
  if (cands.length === 0) return null;
  const preferred = `spec_${slugify(title)}`;
  const chosen = cands.find((n) => n === preferred) ?? cands.sort()[0]!;
  const full = path.join(docsDir, chosen);
  const content = await fs.readFile(full, "utf-8");
  // Arquivo vazio/whitespace não serve como spec — melhor o esqueleto declarado.
  return content.trim().length > 0 ? { path: full, content } : null;
}

/**
 * Caminho preferido: a spec semeada **verbatim** + apêndice de procedência e lacunas.
 * O conteúdo original não é editado — só ganha um rodapé que diz de onde veio e o que falta.
 */
export function buildFromSeeded(r: Row, seeded: { path: string; content: string }): string {
  const body = seeded.content.replace(/\s+$/, "");
  return `${body}

---

> **Reparo de acervo — backfill D1 (2026-09-05).** O conteúdo acima é a spec **original** deste projeto,
> gerada no registro dele e preservada sem alteração em \`${seeded.path}\`
> (${seeded.content.length} bytes). A linha correspondente em \`project_spec_files\` apontava para um
> caminho **relativo** (\`${r.file_path}\`) que nunca existiu em disco, o que fazia a validação, a
> promoção e o contexto do CTO lerem vazio. Este arquivo é a mesma spec no caminho canônico.
> Situação do projeto no Genesis: \`${r.status}\`.

${LACUNAS}
`;
}

/**
 * Fallback: spec mínima derivada do inventário, usada só quando NÃO há spec semeada em disco.
 * Declara procedência e lacunas: quem ler (humano, CTO ou validador) precisa saber que isto é um
 * ESQUELETO, não a spec de engenharia do serviço.
 */
export function buildMinimalSpec(r: Row): string {
  const tipo = r.project_type ?? "não classificado";
  const stack = r.stack ?? "não declarada";
  const produto = r.product_name ?? "—";
  const objetivo = (r.charter_summary ?? "").trim() || "Não registrado no inventário.";
  const entrega = (r.backlog_summary ?? "").trim() || "Não registrado no inventário.";
  return `# ${r.title}

> **Documento mínimo derivado do inventário** — gerado pelo backfill \`backfill-venuxx-v2-spec-files\`
> a partir dos dados do próprio Genesis (título, tipo, stack, charter e backlog do projeto).
> **Não é a especificação de engenharia do serviço**: o projeto foi registrado por inventário, sem
> spec anexada. Trate as seções abaixo como fatos verificados e o restante como LACUNA declarada.

## 0. Metadados

| Campo | Valor |
|-------|-------|
| Produto | ${produto} |
| Aplicação | ${r.title} |
| Tipo (taxonomia Genesis) | ${tipo} |
| Stack declarada | ${stack} |
| Situação no Genesis | ${r.status} |
| Origem deste documento | inventário (sem spec original anexada) |

## 1. Objetivo

${objetivo}

## 2. Volume registrado no Genesis

${entrega} — contador do backlog, **não** é descrição de escopo.

## 3. Premissas

- P-01 — A aplicação existe e está em operação/consolidada conforme a situação \`${r.status}\` registrada no Genesis.
- P-02 — A stack declarada (${stack}) é a stack real em produção.
- P-03 — Contratos de entrada/saída, dados e regras de negócio vivem no código do repositório da
  aplicação, **não** neste documento.

${LACUNAS}
`;
}

async function main(): Promise<void> {
  const commit = process.argv.includes("--commit");
  console.log(`[backfill-d1] modo = ${commit ? "COMMIT" : "DRY-RUN"} | UPLOAD_DIR = ${UPLOAD_DIR}`);

  const client = await pool.connect();
  let written = 0;
  let updated = 0;
  try {
    await client.query("BEGIN");

    const rows = (await client.query<Row>(
      `SELECT sf.id AS file_id, sf.project_id, sf.filename, sf.file_path, sf.rel_dir,
              p.title, p.status, p.charter_summary, p.backlog_summary,
              p.extra->>'project_type' AS project_type,
              p.extra->>'venuxx_stack' AS stack,
              pr.name AS product_name, sf.created_at
         FROM project_spec_files sf
         JOIN projects p  ON p.id = sf.project_id
         LEFT JOIN products pr ON pr.id = p.product_id
        WHERE sf.file_path NOT LIKE '/%'
        ORDER BY pr.name NULLS LAST, p.title`,
    )).rows;

    console.log(`[backfill-d1] linhas com file_path relativo: ${rows.length}`);
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      console.log("[backfill-d1] nada a fazer (idempotente).");
      return;
    }

    for (const r of rows) {
      const filename = slugify(r.title);
      const projectDir = path.join(UPLOAD_DIR, r.project_id);
      const filePath = path.join(projectDir, filename);
      // Preferência: preservar a spec semeada em disco; esqueleto do inventário só como último recurso.
      const seeded = await findSeededSpec(r.project_id, r.title);
      const content = seeded ? buildFromSeeded(r, seeded) : buildMinimalSpec(r);
      const origem = seeded ? `spec semeada ${seeded.content.length}B + apêndice` : "INVENTÁRIO (sem spec em disco)";
      const sha = createHash("sha256").update(content, "utf-8").digest("hex");

      // Guarda: nunca sobrescrever arquivo já existente em disco (seria destruir upload real).
      let exists = false;
      try { await fs.access(filePath); exists = true; } catch { /* não existe → ok criar */ }

      console.log(
        `  • ${r.title.padEnd(30)} ${String(r.file_path).padEnd(42)} → ${filePath}` +
        `  (${content.length} chars | ${origem}${exists ? " | ARQUIVO JÁ EXISTE → só corrige o banco" : ""})`,
      );

      if (commit) {
        let sha256 = sha;
        if (exists) {
          // Arquivo real já em disco (upload que perdeu a referência): o hash tem de ser o DELE,
          // não o do esqueleto que este script montou e não vai gravar.
          sha256 = createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
        } else {
          await fs.mkdir(projectDir, { recursive: true });
          await fs.writeFile(filePath, content, "utf-8");
          written += 1;
        }
        const res = await client.query(
          `UPDATE project_spec_files
              SET filename = $2, file_path = $3, mime_type = 'text/markdown',
                  rel_dir = '', is_primary = true, content_sha256 = $4
            WHERE id = $1 AND file_path NOT LIKE '/%'`,
          [r.file_id, filename, filePath, sha256],
        );
        updated += res.rowCount ?? 0;
        // `spec_ref` guarda só o filename (formato do projectCreation.ts) — antes era 'specs/<t>.md'.
        await client.query(`UPDATE projects SET spec_ref = $2 WHERE id = $1`, [r.project_id, filename]);
      }
    }

    if (commit) {
      await client.query("COMMIT");
      console.log(`[backfill-d1] COMMIT — arquivos criados=${written} linhas corrigidas=${updated}`);
    } else {
      await client.query("ROLLBACK");
      console.log(`[backfill-d1] DRY-RUN — nada gravado (nem disco, nem banco). Reexecute com --commit.`);
    }
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  await pool.end();
}

// `import`ável nos testes sem disparar o backfill (o teste cobre `buildMinimalSpec`/`slugify`).
if (process.argv[1] && process.argv[1].includes("backfill-venuxx-v2-spec-files")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

export { slugify };
