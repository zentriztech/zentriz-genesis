/**
 * specValidation.test.ts — RFC-0004 Onda 3: estágio A, schema do B e regras do gate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runStageA, parseStageBFindings, checkSpecValidationGate, specValidationGateEnabled, autoValidateDirtySpecs, specValidationAutoEnabled, collectStageBResults, computeCurrentSpecHash, canReusePassedRun, pendingCoverage, knownFindingsForJudge, startValidation } from "./specValidation.js";
import type { Pool } from "pg";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

function file(filename: string, content: string, relDir = "") {
  return { filename, file_path: `/x/${filename}`, rel_dir: relDir, content };
}

const RICH = `## Spec real\n\n${"Requisito detalhado com critérios de aceite e modelo de dados. ".repeat(10)}`;

describe("estágio A (determinístico)", () => {
  it("spec legada SEM manifesto → warning, NUNCA blocker (leniência)", () => {
    const f = runStageA([file("spec.md", RICH)]);
    const manifesto = f.find((x) => x.title.includes("sem manifesto"));
    expect(manifesto?.severity).toBe("warning");
    expect(f.some((x) => x.severity === "blocker")).toBe(false);
  });

  it("arquétipo desconhecido no README → blocker", () => {
    const readme = file("README.md", "---\nkind: project\narchetype: inventado\n---\n\n# X");
    const f = runStageA([readme, file("01-spec.md", RICH)]);
    expect(f.find((x) => x.title.includes("Arquétipo desconhecido"))?.severity).toBe("blocker");
  });

  it("arquétipo válido → sem blocker; estado no frontmatter → warning", () => {
    const readme = file("README.md", "---\nkind: project\narchetype: backend-service\nspec_hash: abc\n---\n\n# X");
    const f = runStageA([readme, file("01-spec.md", RICH)]);
    expect(f.some((x) => x.severity === "blocker")).toBe(false);
    expect(f.find((x) => x.title.includes("ESTADO no frontmatter"))?.severity).toBe("warning");
  });

  it("spec vazia/trivial → blocker", () => {
    const f = runStageA([file("spec.md", "# oi")]);
    expect(f.find((x) => x.title.includes("sem conteúdo substantivo"))?.severity).toBe("blocker");
  });

  it("Evoluir E3: RFC vago em docs/rfc/ → blocker SÓ em evolução (produto novo: warning); nome fora do padrão idem", () => {
    const vague = file("RFC-0001-vago.md", "# RFC\n\n## Sumário\nFazer melhor.\n", "docs/rfc");
    const badName = file("rfc-1.md", "# RFC\n", "docs/rfc");
    const evo = runStageA([file("spec.md", RICH), vague, badName], { evolution: true });
    const rfcFindings = evo.filter((x) => x.file.startsWith("docs/rfc/"));
    expect(rfcFindings.length).toBeGreaterThanOrEqual(3);
    expect(rfcFindings.every((x) => x.severity === "blocker" || x.severity === "warning")).toBe(true);
    expect(rfcFindings.filter((x) => x.severity === "blocker").map((x) => x.title)).toEqual(expect.arrayContaining([
      expect.stringMatching(/Gherkin/), expect.stringMatching(/files_allowed/), expect.stringMatching(/padrão de nome/),
    ]));
    const fresh = runStageA([file("spec.md", RICH), vague, badName]);
    expect(fresh.filter((x) => x.file.startsWith("docs/rfc/")).every((x) => x.severity === "warning")).toBe(true);
    // RFC completo em evolução → sem blocker de RFC
    const good = file("RFC-0002-ok.md", "# RFC\n\n## Critérios de aceite\n- Dado x\n- Quando y\n- Então z\n\n## Impacto\n- `apps/api/src/a.ts`\n\n## Compatibilidade\nMINOR\n\n**Não-objetivos:** nada.\n", "docs/rfc");
    expect(runStageA([file("spec.md", RICH), good], { evolution: true }).filter((x) => x.file.startsWith("docs/rfc/") && x.severity === "blocker")).toEqual([]);
  });
});

describe("parseStageBFindings (schema fechado — saída de LLM nunca entra crua)", () => {
  it("normaliza severidade inválida para info e trunca campos", () => {
    const out = parseStageBFindings([
      { file: "a".repeat(500), line: "3", severity: "CRITICAL!!", title: "t".repeat(500), rationale: "r" },
    ]);
    expect(out[0].severity).toBe("info");
    expect(out[0].file.length).toBe(300);
    expect(out[0].title.length).toBe(200);
    expect(out[0].line).toBe(3);
    expect(out[0].source).toBe("stage_b");
  });
  it("não-array → []; cap de 50 itens", () => {
    expect(parseStageBFindings({ hack: true })).toEqual([]);
    expect(parseStageBFindings(Array.from({ length: 80 }, () => ({}))).length).toBe(50);
  });
});

describe("checkSpecValidationGate — regras (com db fake)", () => {
  const PROJ = "p1";
  type Row = Record<string, unknown>;
  function db(rows: { files?: Row[]; run?: Row | null }) {
    return {
      query: async (sql: string) => {
        if (sql.includes("FROM project_spec_files")) return { rows: rows.files ?? [] };
        if (sql.includes("FROM spec_validation_runs")) return { rows: rows.run ? [rows.run] : [] };
        return { rows: [] };
      },
    };
  }

  beforeEach(() => { process.env.SPEC_VALIDATION_GATE = "on"; });
  afterEach(() => { delete process.env.SPEC_VALIDATION_GATE; });

  it("env OFF (default) → sempre passa (byte-idêntico ao legado)", async () => {
    delete process.env.SPEC_VALIDATION_GATE;
    expect(specValidationGateEnabled()).toBe(false);
    const r = await checkSpecValidationGate(db({}), PROJ);
    expect(r.ok).toBe(true);
  });

  it("ON + sem arquivos → SPEC_FILES_MISSING", async () => {
    const r = await checkSpecValidationGate(db({ files: [] }), PROJ);
    expect(r).toMatchObject({ ok: false, code: "SPEC_FILES_MISSING" });
  });

  // Nota: os caminhos com arquivos reais exigem disco (computeCurrentSpecHash lê bytes) —
  // cobertos pela bateria E2E viva da onda. Aqui validamos a matriz de decisão da run
  // via os casos alcançáveis com o fake.
});

describe("autoValidateDirtySpecs — tick env-gated (RFC-0004 Onda 3, D1)", () => {
  afterEach(() => { delete process.env.SPEC_VALIDATION_AUTO; });

  // fake pool que grava as queries; SELECT de projetos sujos devolve `dirtyRows`,
  // FROM project_spec_files devolve [] (→ startValidation para em SPEC_FILES_MISSING).
  function db(dirtyRows: Array<{ id: string; tenant_id: string | null }>) {
    const queries: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("FROM projects") && sql.includes("spec_dirty_at IS NOT NULL")) return { rows: dirtyRows };
        return { rows: [] };
      },
    } as unknown as Pool;
    return { pool, queries };
  }

  it("flag off (default) → no-op, não consulta o banco", async () => {
    delete process.env.SPEC_VALIDATION_AUTO;
    expect(specValidationAutoEnabled()).toBe(false);
    const { pool, queries } = db([{ id: "p1", tenant_id: null }]);
    await autoValidateDirtySpecs(pool);
    expect(queries).toHaveLength(0);
  });

  it("flag on → limpa spec_dirty_at ANTES de disparar (não vira loop por ciclo)", async () => {
    process.env.SPEC_VALIDATION_AUTO = "on";
    expect(specValidationAutoEnabled()).toBe(true);
    const { pool, queries } = db([{ id: "proj-dirty-1", tenant_id: null }]);
    await autoValidateDirtySpecs(pool);
    // 1ª query: SELECT dos sujos; 2ª: UPDATE ... spec_dirty_at = NULL para o projeto.
    expect(queries[0].sql).toContain("spec_dirty_at IS NOT NULL");
    const clear = queries.find((q) => q.sql.includes("spec_dirty_at = NULL") && (q.params as unknown[])[0] === "proj-dirty-1");
    expect(clear).toBeTruthy();
  });

  it("flag on + nenhum sujo → só o SELECT, sem UPDATE de limpeza", async () => {
    process.env.SPEC_VALIDATION_AUTO = "on";
    const { pool, queries } = db([]);
    await autoValidateDirtySpecs(pool);
    expect(queries.some((q) => q.sql.includes("spec_dirty_at = NULL"))).toBe(false);
  });
});

/**
 * GAP-11 — o teto expira a ESPERA do estágio adversarial, nunca o RESULTADO.
 *
 * Medido em prod 2026-09-06 (NVX LastMile): a validação `16e467cf` esperou 20m40s (as reais deste
 * projeto levam ~5 min), estourou o deadline e terminou `error` com 0 findings, enquanto o job do
 * LLM seguia vivo no serviço agents. Uma leitura adversarial inteira, já paga, foi descartada.
 */
describe("GAP-11 — coleta server-side do estágio B (migração 100)", () => {
  function specOnDisk(content: string) {
    const dir = mkdtempSync(join(tmpdir(), "gap11-"));
    const p = join(dir, "README.md");
    writeFileSync(p, content, "utf-8");
    return [{ filename: "README.md", file_path: p, rel_dir: "" }];
  }

  function db(row: Record<string, unknown> | null, specFiles: Array<Record<string, unknown>> = []) {
    const queries: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("FROM spec_validation_runs") && sql.includes("ORDER BY finished_at")) {
          return { rows: row ? [row] : [] };
        }
        if (sql.includes("FROM project_spec_files")) return { rows: specFiles };
        return { rows: [] };
      },
    } as unknown as Pool;
    return { pool, queries };
  }

  const RICH_README = `---\narchetype: backend-service\n---\n\n## Escopo\n\n${"Requisito com critérios de aceite. ".repeat(20)}`;

  /** Monta uma run pendente cujo `spec_hash` casa com o que está no disco (spec NÃO mudou). */
  async function pendingRun(overrides: Record<string, unknown> = {}) {
    const files = specOnDisk(RICH_README);
    const probe = db(null, files);
    const cur = await computeCurrentSpecHash(probe.pool, "proj-1");
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      project_id: "proj-1",
      spec_hash: cur!.specHash,
      agents_job_id: "job-b-1",
      findings: [{ file: "", line: null, severity: "warning", title: "do estágio A", rationale: "", source: "stage_a" }],
      deadline_at: new Date(Date.now() - 60_000).toISOString(),
      ...overrides,
    };
    return { row, files };
  }

  it("job `done` e spec inalterada → grava o veredito, marca `stage_b_ran` e encerra a coleta", async () => {
    const { row, files } = await pendingRun();
    const { pool, queries } = db(row, files);
    const out = await collectStageBResults(pool, async () => ({
      status: "done",
      result: { findings: [{ severity: "blocker", title: "contradição achada pelo LLM", rationale: "x", file: "README.md" }] },
    }));
    expect(out).toMatchObject({ scanned: 1, collected: 1, lost: 0, givenUp: 0 });
    const upd = queries.find((q) => q.sql.includes("UPDATE spec_validation_runs") && q.sql.includes("stage_b_ran = true"));
    expect(upd).toBeTruthy();
    expect(upd!.params[0]).toBe("failed");                       // blocker do LLM → failed
    const gravadas = JSON.parse(String(upd!.params[1])) as Array<{ source: string }>;
    expect(gravadas).toHaveLength(2);                             // UNIÃO: estágio A + estágio B
    expect(gravadas.map((f) => f.source)).toEqual(["stage_a", "stage_b"]);
    expect(upd!.sql).toContain("stage_b_collected_at = now()");
    expect(upd!.sql).toContain("stage_b_collected_at IS NULL");   // claim: não sobrescreve coleta alheia
  });

  it("job `done` mas a spec MUDOU desde o início → 'superseded' (não mente sobre outro conteúdo)", async () => {
    const { row, files } = await pendingRun({ spec_hash: "hash-de-outra-spec" });
    const { pool, queries } = db(row, files);
    const out = await collectStageBResults(pool, async () => ({ status: "done", result: { findings: [] } }));
    expect(out.collected).toBe(1);
    const upd = queries.find((q) => q.sql.includes("UPDATE spec_validation_runs") && q.sql.includes("stage_b_ran = true"));
    expect(upd!.params[0]).toBe("superseded");
  });

  it("job sem blocker e spec inalterada → 'passed'", async () => {
    const { row, files } = await pendingRun();
    const { pool, queries } = db(row, files);
    await collectStageBResults(pool, async () => ({ status: "done", result: { findings: [{ severity: "info", title: "nota" }] } }));
    const upd = queries.find((q) => q.sql.includes("UPDATE spec_validation_runs") && q.sql.includes("stage_b_ran = true"));
    expect(upd!.params[0]).toBe("passed");
  });

  it("404 no agents (job sumiu do TTL) → encerra o assunto SEM inventar veredito", async () => {
    const { row, files } = await pendingRun();
    const { pool, queries } = db(row, files);
    const out = await collectStageBResults(pool, async () => "not_found");
    expect(out).toMatchObject({ collected: 0, lost: 1 });
    expect(queries.some((q) => q.sql.includes("stage_b_ran = true"))).toBe(false);
    expect(queries.some((q) => q.sql.includes("SET stage_b_collected_at = now()"))).toBe(true);
  });

  it("🔴 falha de REDE no probe não encerra o assunto (tenta no próximo tick)", async () => {
    const { row, files } = await pendingRun();
    const { pool, queries } = db(row, files);
    const out = await collectStageBResults(pool, async () => { throw new Error("ECONNREFUSED"); });
    expect(out).toMatchObject({ scanned: 1, collected: 0, lost: 0, givenUp: 0 });
    expect(queries.some((q) => q.sql.includes("stage_b_collected_at = now()"))).toBe(false);
  });

  it("job ainda rodando dentro da tolerância → segue pendente (nada é escrito)", async () => {
    const { row, files } = await pendingRun({ deadline_at: new Date(Date.now() - 60_000).toISOString() });
    const { pool, queries } = db(row, files);
    const out = await collectStageBResults(pool, async () => ({ status: "running" }));
    expect(out).toMatchObject({ collected: 0, lost: 0, givenUp: 0 });
    expect(queries.some((q) => q.sql.includes("stage_b_collected_at = now()"))).toBe(false);
  });

  it("job pendurado além do teto duro pós-deadline → desiste (o laço não espera para sempre)", async () => {
    const { row, files } = await pendingRun({ deadline_at: new Date(Date.now() - 120 * 60_000).toISOString() });
    const { pool, queries } = db(row, files);
    const out = await collectStageBResults(pool, async () => ({ status: "running" }));
    expect(out).toMatchObject({ collected: 0, givenUp: 1 });
    expect(queries.some((q) => q.sql.includes("SET stage_b_collected_at = now()"))).toBe(true);
  });

  it("🔴 GAP-18: resultado coletado depois também MARCA a cobertura (o julgamento aconteceu)", async () => {
    // Sem isto o arquivo julgado por uma run que só foi coletada no tick voltaria à fila de
    // "não julgados" e a rotação repetiria o trabalho já pago.
    const { row, files } = await pendingRun({
      stage_b_coverage: { fullShas: { "README.md": "sha-do-conteudo-julgado", "docs/x.md": "sha-x" } },
    });
    const { pool, queries } = db(row, files);
    await collectStageBResults(pool, async () => ({ status: "done", result: { findings: [] } }));
    const marcas = queries.filter((q) => q.sql.includes("UPDATE project_spec_files") && q.sql.includes("stage_b_full_sha = $4"));
    expect(marcas).toHaveLength(2);
    expect(marcas[0].params).toEqual(["proj-1", "", "README.md", "sha-do-conteudo-julgado"]);
    expect(marcas[1].params).toEqual(["proj-1", "docs", "x.md", "sha-x"]);
  });

  it("run sem cobertura (anterior à migração 101) → coleta normal, nenhuma marca inventada", async () => {
    const { row, files } = await pendingRun({ stage_b_coverage: null });
    const { pool, queries } = db(row, files);
    const out = await collectStageBResults(pool, async () => ({ status: "done", result: { findings: [] } }));
    expect(out.collected).toBe(1);
    expect(queries.some((q) => q.sql.includes("stage_b_full_sha"))).toBe(false);
  });

  it("coluna ausente (migração 100 não aplicada) não derruba o tick", async () => {
    const pool = { query: async () => { throw new Error('column "agents_job_id" does not exist'); } } as unknown as Pool;
    await expect(collectStageBResults(pool, async () => ({ status: "done" }))).resolves.toMatchObject({ scanned: 0, collected: 0 });
  });
});

/**
 * 🔴 GAP-19 — o dedupe por hash reaproveitava uma run `passed` que havia julgado 2 de 12 arquivos.
 *
 * Medido em prod 2026-09-06 (NVX LastMile, 12 arquivos / 950.965 chars): o modo autônomo pedia
 * revalidação justamente porque a cobertura estava incompleta, e recebia de volta o `id` da MESMA run
 * — cobertura congelada, laço "convergindo" sobre um pedaço da spec. Reaproveitar só é economia
 * quando não há nada novo a julgar.
 */
describe("canReusePassedRun / pendingCoverage (GAP-19)", () => {
  // A pendência é ACUMULADA (`stage_b_full_sha` × sha atual de cada arquivo), não o `outlineOnly` de
  // uma run: numa spec de 950.965 chars contra teto de 400.000, nenhuma validação isolada leva todos
  // os arquivos por inteiro — quem cobre a spec é a UNIÃO das rodadas.
  const cov = (oversized: string[] = []) => ({ full: ["a.md"], outlineOnly: ["b.md"], oversized });

  it("nada pendente (todo arquivo já julgado no conteúdo atual) → reaproveita", () => {
    expect(canReusePassedRun([], cov())).toBe(true);
  });

  it("🔴 há arquivo nunca julgado → NÃO reaproveita (a rodada nova julga arquivos diferentes)", () => {
    expect(pendingCoverage(["grande.md", "modelo-dados.md"], cov())).toEqual(["grande.md", "modelo-dados.md"]);
    expect(canReusePassedRun(["grande.md"], cov())).toBe(false);
  });

  it("o que falta é só `oversized` → reaproveita (rotação não cobre o que não cabe nem sozinho)", () => {
    expect(pendingCoverage(["monstro.md"], cov(["monstro.md"]))).toEqual([]);
    expect(canReusePassedRun(["monstro.md"], cov(["monstro.md"]))).toBe(true);
  });

  it("parte do que falta cabe → revalida, mesmo havendo um `oversized` no meio", () => {
    expect(pendingCoverage(["monstro.md", "medio.md"], cov(["monstro.md"]))).toEqual(["medio.md"]);
    expect(canReusePassedRun(["monstro.md", "medio.md"], cov(["monstro.md"]))).toBe(false);
  });

  it("cobertura ilegível (run legada, JSON estranho) não inventa `oversized`: pendência manda", () => {
    for (const raw of [null, undefined, {}, { oversized: "nao-e-array" }, "lixo", 7]) {
      expect(canReusePassedRun([], raw)).toBe(true);
      expect(canReusePassedRun(["b.md"], raw)).toBe(false);
    }
  });
});

/**
 * 🔴 GAP-39 — o juiz não sabia com que anchor ele mesmo tinha nomeado o defeito na validação anterior.
 *
 * `knownFindingsForJudge` monta a lista de continuidade que viaja no prompt do refutador. Regra dura:
 * só entra finding que o juiz DESTA rodada pode reencontrar — arquivo lido por INTEIRO (`full`). Um
 * anchor de arquivo que ele só viu em outline convidaria a repetir o item sem evidência.
 */
describe("GAP-39 — lista de continuidade de anchor para o refutador", () => {
  const cov = ["modelo-dados.md", "visao-escopo.md"];
  it("só findings ativos, com anchor, de arquivo lido por INTEIRO; ordena blocker → warning → info", () => {
    const out = knownFindingsForJudge([
      { file: "modelo-dados.md", anchor: "Convenções gerais", title: "blocos de merge", severity: "warning" },
      { file: "visao-escopo.md", anchor: "§1.5.1", title: "envelope de erro", severity: "blocker" },
      { file: "privacidade-lgpd.md", anchor: "§3.3", title: "fora da cobertura", severity: "blocker" },
      { file: "modelo-dados.md", anchor: "", title: "sem anchor → sem identidade", severity: "blocker" },
      { file: "", anchor: "no_readme", title: "finding global do estágio A", severity: "warning" },
      { file: "visao-escopo.md", anchor: "§1.4.2", title: "triado pelo humano", severity: "blocker", triage: { state: "ignored" } },
    ], cov);
    expect(out.map((f) => f.anchor)).toEqual(["§1.5.1", "Convenções gerais"]);
  });

  it("deduplica file+anchor (case-insensitive) e respeita o teto", () => {
    const dup = [
      { file: "modelo-dados.md", anchor: "Convenções gerais", title: "a", severity: "warning" },
      { file: "modelo-dados.md", anchor: "convenções GERAIS", title: "b", severity: "blocker" },
    ];
    expect(knownFindingsForJudge(dup, cov)).toHaveLength(1);
    const muitos = Array.from({ length: 50 }, (_, i) => ({ file: "modelo-dados.md", anchor: `a${i}`, title: "t", severity: "info" }));
    expect(knownFindingsForJudge(muitos, cov, 10)).toHaveLength(10);
  });

  it("nada elegível → lista vazia (o prompt do refutador volta a ser exatamente o de antes)", () => {
    expect(knownFindingsForJudge([{ file: "outro.md", anchor: "x", title: "t", severity: "blocker" }], cov)).toEqual([]);
    expect(knownFindingsForJudge([], [])).toEqual([]);
  });

  it("trunca anchor e título (o prompt não é canal de payload)", () => {
    const [f] = knownFindingsForJudge([{ file: "modelo-dados.md", anchor: "x".repeat(400), title: "y".repeat(400), severity: "info" }], cov);
    expect(f.anchor).toHaveLength(160);
    expect(f.title).toHaveLength(200);
  });
});

/**
 * 🔴 GAP-44 — o one-flight de validação é por PROJETO, não por CONTEÚDO.
 *
 * Medido em prod 2026-09-07 (NVX LastMile): a validação `a17bf391` nasceu 05:58:12. A run de autonomia
 * `fb57dec7` começou 06:00:12, reescreveu SETE arquivos entre 06:02 e 06:13:45 e, ao pedir a validação
 * que mediria o passe, recebeu de volta `a17bf391` — uma leitura que não viu um byte do que o passe
 * escreveu. Ela morreu no deadline e o passe foi debitado como "sem medição de GAPs". Mesmo no caminho
 * felizardo teria sido pior: a medição do passe seria a contagem do conteúdo ANTERIOR a ele.
 *
 * `startValidation` continua devolvendo a run em voo (ela existe e é legítima de se olhar), mas agora
 * MARCA que ela não mede o conteúdo atual — e quem registra a run como "a medição do meu passe" recusa.
 */
describe("GAP-44 — one-flight devolve run em voo; `staleReuse` diz se ela mede o conteúdo atual", () => {
  function specOnDisk(content: string) {
    const dir = mkdtempSync(join(tmpdir(), "gap44-"));
    const p = join(dir, "README.md");
    writeFileSync(p, content, "utf-8");
    return [{ filename: "README.md", file_path: p, rel_dir: "" }];
  }

  /** Pool que barra o INSERT com 23505 (one-flight) e devolve a run em voo com o hash pedido. */
  function pool(specFiles: Array<Record<string, unknown>>, inFlightHash: string | null) {
    return {
      query: async (sql: string) => {
        if (sql.includes("FROM project_spec_files")) return { rows: specFiles };
        if (sql.includes("INSERT INTO spec_validation_runs")) throw Object.assign(new Error("dup"), { code: "23505" });
        if (sql.includes("status IN ('pending','running')")) {
          return { rows: inFlightHash === null ? [] : [{ id: "vr-em-voo", spec_hash: inFlightHash }] };
        }
        return { rows: [] }; // dedupe por 'passed' não acha nada
      },
    } as unknown as Pool;
  }

  const opts = (projectId: string) => ({ projectId, tenantId: null, requestedBy: "auto-validate" });

  it("run em voo de OUTRO conteúdo → devolvida, mas marcada `staleReuse`", async () => {
    const files = specOnDisk("# NVX\n\nconteúdo NOVO escrito pelo passe.");
    const res = await startValidation(pool(files, "hash-de-antes-do-passe"), opts(randomUUID()));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.runId).toBe("vr-em-voo");
    expect(res.reused).toBe(true);
    expect(res.staleReuse).toBe(true);
  });

  it("run em voo do MESMO conteúdo → reuso legítimo, SEM a marca (nada muda para esse caso)", async () => {
    const content = "# NVX\n\nmesmo conteúdo dos dois lados.";
    const files = specOnDisk(content);
    const projectId = randomUUID();
    // O hash da árvore é o mesmo que a própria função calcula para estes arquivos.
    const cur = await computeCurrentSpecHash(
      { query: async () => ({ rows: files }) } as unknown as Pool, projectId,
    );
    const res = await startValidation(pool(files, cur!.specHash), opts(projectId));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.runId).toBe("vr-em-voo");
    expect(res.reused).toBe(true);
    expect(res.staleReuse).toBeUndefined();
  });
});
