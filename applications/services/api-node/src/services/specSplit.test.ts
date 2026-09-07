/**
 * specSplit.test.ts — F2/PR-3: proposta e aplicação da divisão da spec (migração 093).
 *
 * O QUE ISTO PROTEGE: aplicar uma divisão SOBRESCREVE o arquivo primário do projeto — a operação
 * mais consequente da Bancada. Em prod 2026-09-05 a escrita in-place sem rede de segurança apagou
 * 7 das 14 seções de uma spec. Aqui os testes cobrem exatamente as guardas de TRANSPORTE:
 * If-Match do primário, snapshot obrigatório (G2), tetos da árvore de spec e ordem de escrita
 * (arquivos novos ANTES do primário virar índice). Nada aqui julga o agrupamento escolhido pelo
 * arquiteto — isso é decisão de LLM (lei do Jean).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  finishSplit, applySplitProposal, discardSplitProposal, collectSpecSplitsTick,
  reapOrphanSplits, specSplitEnabled, startSplitProposal, isOpenSplitStatus,
} from "./specSplit.js";
import { SPEC_TREE_MAX_FILES, SPEC_TREE_MAX_FILE_BYTES } from "../lib/specTreeHash.js";

type Call = { sql: string; params: unknown[] };
type Row = Record<string, unknown>;

const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf-8")).digest("hex");

const SPEC = "# NVX LastMile\n\n## 1. Visão\ntexto\n\n## 2. Requisitos\nFR-01\n";
const PAYLOAD = {
  plan: {
    rationale: "Separei negócio de técnico.",
    indexPurpose: "Porta de entrada.",
    files: [{ name: "objetivo.md", title: "Objetivo", purpose: "Visão.", sections: ["1. Visão"] }],
  },
  index: "# NVX LastMile\n\n| Arquivo | Conteúdo |\n|---|---|\n| objetivo.md | Visão |\n",
  files: { "objetivo.md": "# Objetivo\n\n## 1. Visão\ntexto\n", "tecnico/dados.md": "# Dados\n\nFR-01\n" },
  coverage: [{ section: "1. Visão", chars: 12, targets: ["objetivo.md"] }],
};

interface FakeOpts {
  split?: Row | null;
  primaryFile?: string | null;
  fileCount?: number;
  snapshotFails?: boolean;
  projectStatus?: string;
  /** GAP-47: a árvore de spec como ela está HOJE, para a checagem de colisão de nomes. */
  treeFiles?: Array<{ filename: string; rel_dir: string | null }>;
}

function fakeDb(opts: FakeOpts = {}) {
  const calls: Call[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM project_spec_splits WHERE id/.test(sql)) {
        return { rows: opts.split ? [opts.split] : [], rowCount: opts.split ? 1 : 0 };
      }
      if (/FROM project_spec_splits WHERE project_id/.test(sql)) {
        return { rows: opts.split ? [opts.split] : [], rowCount: opts.split ? 1 : 0 };
      }
      if (/SELECT file_path, rel_dir, filename FROM project_spec_files/.test(sql)) {
        return opts.primaryFile
          ? { rows: [{ file_path: opts.primaryFile, rel_dir: "", filename: path.basename(opts.primaryFile) }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/SELECT filename, rel_dir FROM project_spec_files/.test(sql)) {
        return { rows: [...(opts.treeFiles ?? [])], rowCount: (opts.treeFiles ?? []).length };
      }
      if (/count\(\*\)::int AS n FROM project_spec_files/.test(sql)) {
        return { rows: [{ n: opts.fileCount ?? 1 }], rowCount: 1 };
      }
      if (/SELECT content_sha256 FROM project_spec_snapshots/.test(sql)) {
        if (opts.snapshotFails) throw new Error("db down");
        return { rows: [], rowCount: 0 };
      }
      if (/FROM projects p WHERE p.id/.test(sql)) {
        return { rows: [{ name: "NVX LastMile", type: "backend_node" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as never;
  return { db, calls, sqlOf: (re: RegExp) => calls.find((c) => re.test(c.sql)) };
}

let dir = "";
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "specsplit-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

// ── flag ─────────────────────────────────────────────────────────────────────────────────────

describe("specSplitEnabled", () => {
  afterEach(() => { delete process.env.SPEC_SPLIT; });
  it("nasce OFF e liga só com SPEC_SPLIT=on", () => {
    delete process.env.SPEC_SPLIT;
    expect(specSplitEnabled()).toBe(false);
    process.env.SPEC_SPLIT = "off";
    expect(specSplitEnabled()).toBe(false);
    process.env.SPEC_SPLIT = "on";
    expect(specSplitEnabled()).toBe(true);
  });
});

// ── finishSplit: guardas de TRANSPORTE antes de persistir a proposta ─────────────────────────

describe("finishSplit", () => {
  it("persiste plano/arquivos/cobertura e a telemetria de tokens", async () => {
    const { db, sqlOf } = fakeDb();
    await finishSplit(db, "split-1", {
      ...PAYLOAD, warnings: ["um aviso"], producedChars: 900,
      usage: { input_tokens: 1200, output_tokens: 3400, model: "us.anthropic.claude-opus-5" },
    });
    const up = sqlOf(/SET status='done'/);
    expect(up).toBeDefined();
    const payload = JSON.parse(String(up!.params[1]));
    expect(Object.keys(payload.files)).toEqual(["objetivo.md", "tecnico/dados.md"]);
    expect(payload.index).toContain("| objetivo.md |");
    expect(JSON.parse(String(up!.params[2]))).toEqual(["um aviso"]);
    expect(up!.params[3]).toBe(900);
    expect(up!.params[4]).toBe(1200);
    expect(up!.params[5]).toBe(3400);
    expect(up!.params[6]).toBe("us.anthropic.claude-opus-5");
    // Guarda de status: um poll atrasado nunca ressuscita linha terminal.
    expect(up!.sql).toContain("status='running'");
  });

  it("recusa nome de arquivo que a árvore de spec não aceitaria (traversal)", async () => {
    const { db, sqlOf } = fakeDb();
    await finishSplit(db, "split-1", { ...PAYLOAD, files: { "../escapa.md": "# x\n" } });
    const fail = sqlOf(/SET status='error'/);
    expect(fail).toBeDefined();
    expect(String(fail!.params[1])).toContain("../escapa.md");
    expect(sqlOf(/SET status='done'/)).toBeUndefined();
  });

  it("recusa arquivo acima do teto de 256KB (o apply falharia no meio)", async () => {
    const { db, sqlOf } = fakeDb();
    await finishSplit(db, "split-1", {
      ...PAYLOAD, files: { "gordo.md": "x".repeat(SPEC_TREE_MAX_FILE_BYTES + 1) },
    });
    expect(String(sqlOf(/SET status='error'/)!.params[1])).toContain("256KB");
  });

  it("recusa resultado sem plano/índice/arquivos", async () => {
    const { db, sqlOf } = fakeDb();
    await finishSplit(db, "split-1", { index: "# x", files: {} });
    expect(String(sqlOf(/SET status='error'/)!.params[1])).toContain("plano");
  });

  /**
   * 🔴 GAP-47 — o divisor lê APENAS o arquivo primário. Se ele propõe um nome que já é de outro
   * arquivo da spec, aplicar substituiria aquele arquivo por uma fatia do primário. No NVX LastMile
   * isto é alcançável hoje: 12 arquivos na árvore, primário de ~54k, e `modelo-dados.md` (177k) é o
   * nome óbvio para a seção de dados — e foi o nome que uma divisão anterior já usou.
   */
  it("recusa nome que JÁ EXISTE na árvore de spec (o divisor só leu o primário)", async () => {
    const p = await primaryOnDisk();
    const { db, sqlOf } = fakeDb({
      split: { id: "split-1", project_id: "proj-1" }, primaryFile: p,
      treeFiles: [
        { filename: path.basename(p), rel_dir: "" },
        { filename: "dados.md", rel_dir: "tecnico" },
      ],
    });
    await finishSplit(db, "split-1", PAYLOAD);
    const fail = sqlOf(/SET status='error'/);
    expect(fail).toBeDefined();
    expect(String(fail!.params[1])).toContain("tecnico/dados.md");
    expect(String(fail!.params[1])).toContain("JÁ EXISTEM");
    expect(sqlOf(/SET status='done'/)).toBeUndefined();
  });

  it("o PRIMÁRIO não conta como colisão (ele vira o índice, por desenho e com snapshot)", async () => {
    const p = await primaryOnDisk();
    const { db, sqlOf } = fakeDb({
      split: { id: "split-1", project_id: "proj-1" }, primaryFile: p,
      treeFiles: [{ filename: path.basename(p), rel_dir: "" }],
    });
    await finishSplit(db, "split-1", { ...PAYLOAD, files: { ...PAYLOAD.files, "PRODUCT_SPEC.md": "# x\n" } });
    expect(sqlOf(/SET status='error'/)).toBeUndefined();
    expect(sqlOf(/SET status='done'/)).toBeDefined();
  });
});

// ── applySplitProposal: a única escrita ─────────────────────────────────────────────────────

async function primaryOnDisk(content = SPEC): Promise<string> {
  const p = path.join(dir, "PRODUCT_SPEC.md");
  await writeFile(p, content, "utf-8");
  return p;
}

function doneRow(filePath: string, content = SPEC): Row {
  return {
    id: "split-1", project_id: "proj-1", status: "done", source_path: filePath,
    source_sha: sha(content), source_chars: content.length, produced_chars: 900,
    warnings: [], error: null, input_tokens: 0, output_tokens: 0, model_used: null,
    applied_at: null, created_at: new Date(), updated_at: new Date(), payload: PAYLOAD,
  };
}

describe("applySplitProposal", () => {
  it("cria os arquivos do plano, põe o ÍNDICE no primário e guarda o snapshot do conteúdo ANTIGO", async () => {
    const p = await primaryOnDisk();
    const { db, calls, sqlOf } = fakeDb({ split: doneRow(p), primaryFile: p });
    const res = await applySplitProposal(db, "split-1", "user-1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created.sort()).toEqual(["objetivo.md", "tecnico/dados.md"]);
    expect(res.indexPath).toBe("PRODUCT_SPEC.md");

    // o primário passou a ser o índice; os temáticos existem no disco (inclusive em subpasta)
    expect(await readFile(p, "utf-8")).toContain("| objetivo.md |");
    expect(await readFile(path.join(dir, "objetivo.md"), "utf-8")).toContain("# Objetivo");
    expect(await readFile(path.join(dir, "tecnico", "dados.md"), "utf-8")).toContain("FR-01");

    // snapshot G2: guarda o que foi SUBSTITUÍDO, não o novo
    const snap = sqlOf(/INSERT INTO project_spec_snapshots/);
    expect(snap).toBeDefined();
    expect(String(snap!.params[3])).toBe(SPEC);
    expect(String(snap!.params[6])).toContain("spec-split:");

    // registro na árvore: 2 INSERTs + rel_dir da subpasta preservado
    const inserts = calls.filter((c) => /INSERT INTO project_spec_files/.test(c.sql));
    expect(inserts.length).toBe(2);
    expect(inserts.map((c) => c.params[3])).toContain("tecnico");
    expect(inserts.every((c) => /is_primary/.test(c.sql) && /false/.test(c.sql))).toBe(true);

    expect(sqlOf(/UPDATE projects SET spec_dirty_at/)).toBeDefined();
    expect(sqlOf(/SET status='applied'/)).toBeDefined();
  });

  it("ORDEM: o snapshot vem ANTES de qualquer escrita de arquivo", async () => {
    const p = await primaryOnDisk();
    const { db, calls } = fakeDb({ split: doneRow(p), primaryFile: p });
    await applySplitProposal(db, "split-1", null);
    const iSnap = calls.findIndex((c) => /INSERT INTO project_spec_snapshots/.test(c.sql));
    const iFile = calls.findIndex((c) => /INSERT INTO project_spec_files/.test(c.sql));
    expect(iSnap).toBeGreaterThanOrEqual(0);
    expect(iSnap).toBeLessThan(iFile);
  });

  it("409 SPEC_CHANGED quando a spec mudou desde a proposta — e NADA é escrito", async () => {
    const p = await primaryOnDisk("# Outra spec, editada à mão depois\n\n## 1. X\ny\n");
    const { db, calls } = fakeDb({ split: doneRow(p), primaryFile: p });
    const res = await applySplitProposal(db, "split-1", "user-1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("SPEC_CHANGED");
    expect(res.status).toBe(409);
    expect(calls.some((c) => /INSERT INTO project_spec_files/.test(c.sql))).toBe(false);
    expect(await readFile(p, "utf-8")).toContain("editada à mão");
  });

  it("snapshot indisponível ABORTA a aplicação (sem rede de segurança não se sobrescreve)", async () => {
    const p = await primaryOnDisk();
    const { db, calls } = fakeDb({ split: doneRow(p), primaryFile: p, snapshotFails: true });
    const res = await applySplitProposal(db, "split-1", "user-1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("SNAPSHOT_FAILED");
    expect(calls.some((c) => /INSERT INTO project_spec_files/.test(c.sql))).toBe(false);
    expect(await readFile(p, "utf-8")).toBe(SPEC);
  });

  it("recusa proposta que não está 'done' (idempotência do botão Aplicar)", async () => {
    const p = await primaryOnDisk();
    const row = { ...doneRow(p), status: "applied" };
    const { db } = fakeDb({ split: row, primaryFile: p });
    const res = await applySplitProposal(db, "split-1", "user-1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("NOT_APPLICABLE");
  });

  it("recusa quando a divisão passaria do teto de arquivos da árvore", async () => {
    const p = await primaryOnDisk();
    const { db } = fakeDb({ split: doneRow(p), primaryFile: p, fileCount: SPEC_TREE_MAX_FILES - 1 });
    const res = await applySplitProposal(db, "split-1", "user-1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("TOO_MANY_FILES");
  });

  /**
   * 🔴 GAP-47 — este teste travava o comportamento DEFEITUOSO. Ele afirmava que "arquivo já existente
   * na árvore é ATUALIZADO (a proposta aprovada é a fonte)", e o código fazia
   * `UPDATE project_spec_files SET content_sha256=$1, file_path=$2` + `writeFile` no arquivo alheio.
   * A premissa era falsa em dois pontos: (a) a proposta NÃO é fonte para aquele arquivo — o divisor
   * leu somente o primário, logo escreve ali uma fatia de um conteúdo que não é o daquele arquivo;
   * (b) só o primário é snapshotado (G2), então a substituição era IRRECUPERÁVEL. Medido no NVX
   * LastMile: primário de ~54k, `modelo-dados.md` de 177k na mesma árvore.
   * O contrato correto é ABORTAR: nomes que colidem são reprovados no `finishSplit`, e uma corrida
   * (arquivo nasce entre a proposta e o apply) devolve 409 sem sobrescrever nada.
   */
  it("CORRIDA no INSERT (23505) ABORTA com 409 — nada do arquivo alheio é sobrescrito", async () => {
    const p = await primaryOnDisk();
    await mkdir(path.join(dir, "tecnico"), { recursive: true });
    const alheio = path.join(dir, "objetivo.md");
    await writeFile(alheio, "# Conteúdo de OUTRO arquivo, que o divisor nunca leu\n", "utf-8");
    const calls: Call[] = [];
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (/FROM project_spec_splits WHERE id/.test(sql)) return { rows: [doneRow(p)], rowCount: 1 };
        if (/SELECT file_path, rel_dir, filename FROM project_spec_files/.test(sql)) {
          return { rows: [{ file_path: p, rel_dir: "", filename: "PRODUCT_SPEC.md" }], rowCount: 1 };
        }
        // a checagem de colisão não vê o arquivo: ele "nasce" só na hora do INSERT (a corrida)
        if (/SELECT filename, rel_dir FROM project_spec_files/.test(sql)) return { rows: [], rowCount: 0 };
        if (/count\(\*\)::int AS n/.test(sql)) return { rows: [{ n: 1 }], rowCount: 1 };
        if (/SELECT content_sha256 FROM project_spec_snapshots/.test(sql)) return { rows: [], rowCount: 0 };
        if (/INSERT INTO project_spec_files/.test(sql)) throw Object.assign(new Error("dup"), { code: "23505" });
        return { rows: [], rowCount: 1 };
      },
    } as unknown as never;
    const res = await applySplitProposal(db, "split-1", "user-1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.code).toBe("NAME_COLLISION");
    // o arquivo alheio segue intacto, e o primário NÃO virou índice
    expect(await readFile(alheio, "utf-8")).toContain("que o divisor nunca leu");
    expect(await readFile(p, "utf-8")).toBe(SPEC);
    expect(calls.some((c) => /UPDATE project_spec_files SET content_sha256=\$1, file_path/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /SET status='applied'/.test(c.sql))).toBe(false);
  });

  it("409 NAME_COLLISION ANTES de qualquer escrita quando o nome já está na árvore", async () => {
    const p = await primaryOnDisk();
    const alheio = path.join(dir, "objetivo.md");
    await writeFile(alheio, "# Outro arquivo, 177k de modelo de dados na vida real\n", "utf-8");
    const { db, calls } = fakeDb({
      split: doneRow(p), primaryFile: p,
      treeFiles: [{ filename: "PRODUCT_SPEC.md", rel_dir: "" }, { filename: "objetivo.md", rel_dir: null }],
    });
    const res = await applySplitProposal(db, "split-1", "user-1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.code).toBe("NAME_COLLISION");
    expect(res.message).toContain("objetivo.md");
    // NADA foi escrito — nem o snapshot foi pedido, porque a checagem vem antes dele
    expect(calls.some((c) => /INSERT INTO project_spec_snapshots/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /INSERT INTO project_spec_files/.test(c.sql))).toBe(false);
    expect(await readFile(alheio, "utf-8")).toContain("177k de modelo de dados");
    expect(await readFile(p, "utf-8")).toBe(SPEC);
  });
});

// ── coletor server-side (o job vive nos agents mesmo quando a api reinicia) ─────────────────

describe("collectSpecSplitsTick", () => {
  function collectorDb(rows: Array<{ id: string; agents_job_id: string }>) {
    const calls: Call[] = [];
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (/SELECT id, agents_job_id FROM project_spec_splits/.test(sql)) return { rows, rowCount: rows.length };
        return { rows: [], rowCount: 1 };
      },
    } as unknown as never;
    return { db, calls };
  }

  it("coleta o resultado de um job órfão concluído", async () => {
    const { db, calls } = collectorDb([{ id: "s1", agents_job_id: "ss-abc" }]);
    const out = await collectSpecSplitsTick(db, async () => ({ status: "done", result: { ...PAYLOAD, producedChars: 50 } }));
    expect(out).toEqual({ scanned: 1, collected: 1, lost: 0 });
    expect(calls.some((c) => /SET status='done'/.test(c.sql))).toBe(true);
  });

  it("404 do agente = resultado já descartado pelo TTL → interrupted com a causa", async () => {
    const { db, calls } = collectorDb([{ id: "s1", agents_job_id: "ss-abc" }]);
    const out = await collectSpecSplitsTick(db, async () => "not_found");
    expect(out.lost).toBe(1);
    const up = calls.find((c) => /SET status='interrupted'/.test(c.sql));
    expect(String(up!.params[1])).toContain("descartou o resultado");
  });

  it("ainda rodando: só toca o heartbeat (não conclui nem falha)", async () => {
    const { db, calls } = collectorDb([{ id: "s1", agents_job_id: "ss-abc" }]);
    const out = await collectSpecSplitsTick(db, async () => ({ status: "running" }));
    expect(out).toEqual({ scanned: 1, collected: 0, lost: 0 });
    expect(calls.some((c) => /SET updated_at=now\(\) WHERE id=\$1 AND status='running'/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /SET status='(done|error|interrupted)'/.test(c.sql))).toBe(false);
  });

  it("falha de rede no probe não derruba o tick", async () => {
    const { db } = collectorDb([{ id: "s1", agents_job_id: "ss-abc" }]);
    const out = await collectSpecSplitsTick(db, async () => { throw new Error("ECONNREFUSED"); });
    expect(out).toEqual({ scanned: 1, collected: 0, lost: 0 });
  });
});

// ── reaper / start / discard ─────────────────────────────────────────────────────────────────

describe("reapOrphanSplits", () => {
  it("só encerra quem NÃO chegou a despachar (o resto é recuperável pelo coletor)", async () => {
    const { db, sqlOf } = fakeDb();
    await reapOrphanSplits(db);
    const up = sqlOf(/UPDATE project_spec_splits SET status='interrupted'/);
    expect(up).toBeDefined();
    expect(up!.sql).toContain("agents_job_id IS NULL");
  });
});

describe("startSplitProposal", () => {
  const OLD = process.env.API_AGENTS_URL;
  afterEach(() => { if (OLD === undefined) delete process.env.API_AGENTS_URL; else process.env.API_AGENTS_URL = OLD; });

  it("503 sem serviço de agentes (não há divisão sem LLM — nunca há fallback burro)", async () => {
    delete process.env.API_AGENTS_URL;
    const { db } = fakeDb();
    const res = await startSplitProposal(db, { projectId: "p", tenantId: null, ownerUserId: "u" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("AGENTS_UNAVAILABLE");
  });

  it("409 quando já existe proposta aguardando decisão do humano", async () => {
    process.env.API_AGENTS_URL = "http://agents.local";
    const { db } = fakeDb({ split: { id: "s0", project_id: "p", status: "done", created_at: new Date(), updated_at: new Date() } });
    const res = await startSplitProposal(db, { projectId: "p", tenantId: null, ownerUserId: "u" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("SPLIT_IN_PROGRESS");
    expect(res.message).toContain("Aplique ou descarte");
  });

  it("409 quando o projeto não tem spec legível", async () => {
    process.env.API_AGENTS_URL = "http://agents.local";
    const { db } = fakeDb({ split: null, primaryFile: null });
    const res = await startSplitProposal(db, { projectId: "p", tenantId: null, ownerUserId: "u" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("NO_SPEC");
  });
});

describe("discardSplitProposal", () => {
  it("só descarta linha não-terminal (idempotente)", async () => {
    const { db, sqlOf } = fakeDb();
    await discardSplitProposal(db, randomUUID());
    const up = sqlOf(/SET status='discarded'/);
    expect(up!.sql).toContain("status IN ('pending','running','done')");
  });
});

describe("isOpenSplitStatus", () => {
  it("done ainda é 'aberta': espera decisão humana antes de outra divisão", () => {
    expect(["pending", "running", "done"].every(isOpenSplitStatus as (s: string) => boolean)).toBe(true);
    expect(["error", "interrupted", "applied", "discarded"].some(isOpenSplitStatus as (s: string) => boolean)).toBe(false);
  });
});
