/**
 * factoryCertificate.test.ts — Certificado Genesis Factory (PR1 + PR4 de coerência).
 *
 * O que estes testes protegem:
 *  • **A1 (teatro de certificado)** — `certified`/`certified_with_acks` ⇒ os gates de SPEC do
 *    choke-point (`checkSpecValidationGate` com a flag ON + `checkSpecContentReady` no arquivo
 *    primário, exatamente como `runnerDispatch.ts:76-99`) **não** recusam; e cada `blocked` de
 *    C1–C5 sai com o MESMO código que o gate devolveria. É o teste que impede o selo de virar
 *    uma segunda implementação (o defeito do `readiness` de hoje);
 *  • **A2** — a flag `SPEC_VALIDATION_GATE` NÃO muda o veredito do certificado (ela só muda
 *    `gateEnforced`): com o gate OFF em prod, o selo continua dizendo a verdade;
 *  • **A5** — o selo é amarrado ao `spec_hash` do DISCO: editar o arquivo vence o certificado
 *    (`stale`) sem ninguém tocar em nada;
 *  • **A4** — nunca há dispatch de validação: a matriz de queries do duplo de banco é fechada
 *    (qualquer SQL não previsto explode o teste);
 *  • **A10/D2b** — `connect.yaml` é selo SEPARADO: não influencia `level`.
 *
 * Os caminhos exigem disco real (`computeCurrentSpecHash` lê bytes) → tmpdir por caso.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computeFactoryCertificate, computeFactoryCertificates, aggregateProductCertificate,
  assessConnectDeclaration, factoryCertificateEnabled,
  type FactoryCertificate, type FactoryCertificateLevel,
} from "./factoryCertificate.js";
import { checkSpecValidationGate, type ValidationFinding } from "./specValidation.js";
import { checkSpecContentReady } from "./specContentGate.js";
import { findingFingerprint } from "./findingTriage.js";

const PROJ = "11111111-1111-1111-1111-111111111111";
const RUN = "99999999-9999-9999-9999-999999999999";

const SPEC_REAL = [
  "# Produto TMS", "", "**Produto:** Venuxx TMS", "", "## Objetivo", "Roteirizar entregas.", "",
  "### FR-01 — Criar rota", "DADO um pedido confirmado", "QUANDO o operador aciona roteirizar",
  "ENTÃO o sistema devolve a rota otimizada", "",
].join("\n");

const SPEC_TEMPLATE = [
  "# GUIA-TEMPLATE de especificação", "", "**Produto:** [nome do produto]", "",
  "### FR-01 — [título do requisito]", "DADO [pré-condição],", "QUANDO [ação]", "ENTÃO [resultado]", "",
].join("\n");

const CONNECT_OK = [
  "schemaVersion: 1.3.0", "systemId: venuxx-tms", "serviceName: tms-api",
  "responsibility: Roteirização e despacho de entregas do TMS.", "interfaces:",
  "  - name: routes-http", "    type: http", "",
].join("\n");

interface Fixture {
  dir: string;
  specPath: string;
  /** Estado do banco que os testes ajustam por caso. */
  db: {
    projectType: string | null;
    files: Array<{ filename: string; rel_dir: string; file_path: string; is_primary: boolean }>;
    /** Runs terminais, mais nova primeiro. */
    runs: Array<{ id: string; status: string; spec_hash: string | null; acked_role: string | null; findings: ValidationFinding[] }>;
    triages: Array<Record<string, unknown>>;
    /** SQLs vistos — usado para provar que nada além do previsto é consultado. */
    seen: string[];
  };
}

let fx: Fixture;

/**
 * Duplo de banco com matriz FECHADA: consulta não prevista lança. Isso é o que garante que o
 * certificado não dispara validação nem escreve (A4) — um `INSERT INTO spec_validation_runs`
 * apareceria aqui como erro, não como silêncio.
 */
function db() {
  return {
    query: async (q: string, p: unknown[] = []) => {
      const sql = q.replace(/\s+/g, " ").trim();
      fx.db.seen.push(sql);
      if (sql.startsWith("SELECT filename, file_path, rel_dir FROM project_spec_files")) {
        return { rows: fx.db.files.map(({ filename, rel_dir, file_path }) => ({ filename, rel_dir, file_path })) };
      }
      if (sql.startsWith("SELECT file_path FROM project_spec_files")) {
        const ordered = fx.db.files.slice().sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
        return { rows: ordered.length ? [{ file_path: ordered[0].file_path }] : [] };
      }
      if (sql.includes("FROM spec_validation_runs")) {
        const hash = p[1] as string;
        const ordered = fx.db.runs.slice().sort((a, b) => Number(b.spec_hash === hash) - Number(a.spec_hash === hash));
        return { rows: ordered.length ? [ordered[0]] : [] };
      }
      if (sql.includes("FROM spec_finding_triage")) return { rows: fx.db.triages };
      if (sql.startsWith("SELECT extra->>'project_type'")) return { rows: [{ project_type: fx.db.projectType }] };
      throw new Error(`consulta não prevista no duplo: ${sql.slice(0, 80)}`);
    },
  };
}

/** Replica os gates de SPEC do choke-point (`runnerDispatch.ts:76-99`), com o gate LIGADO. */
async function dispatchSpecRefusal(): Promise<string | null> {
  const prev = process.env.SPEC_VALIDATION_GATE;
  process.env.SPEC_VALIDATION_GATE = "on";
  try {
    const vGate = await checkSpecValidationGate(db(), PROJ);
    if (!vGate.ok) return vGate.code;
    const specRows = (await db().query(
      "SELECT file_path FROM project_spec_files WHERE project_id = $1 ORDER BY is_primary DESC, created_at DESC LIMIT 1",
      [PROJ],
    )).rows as Array<Record<string, unknown>>;
    const specPath = specRows[0]?.file_path as string | undefined;
    if (!specPath) return "spec não encontrada";
    const { readFileSync } = await import("fs");
    const text = readFileSync(specPath).toString("utf8");
    const contentGate = checkSpecContentReady(text);
    return contentGate.ok ? null : contentGate.block.code;
  } finally {
    if (prev === undefined) delete process.env.SPEC_VALIDATION_GATE; else process.env.SPEC_VALIDATION_GATE = prev;
  }
}

/** Hash atual do disco (o certificado o devolve; usamos para semear a run "do hash atual"). */
async function currentHash(): Promise<string> {
  const cert = await computeFactoryCertificate(db(), PROJ);
  if (!cert.specHash) throw new Error("fixture sem hash");
  return cert.specHash;
}

beforeEach(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "factory-cert-"));
  const specPath = path.join(dir, "tms.md");
  await writeFile(specPath, SPEC_REAL);
  fx = {
    dir, specPath,
    db: {
      projectType: "backend_api_python",
      files: [{ filename: "tms.md", rel_dir: "", file_path: specPath, is_primary: true }],
      runs: [], triages: [], seen: [],
    },
  };
});

afterEach(async () => {
  await rm(fx.dir, { recursive: true, force: true });
  delete process.env.SPEC_VALIDATION_GATE;
  delete process.env.FACTORY_CERTIFICATE;
});

describe("computeFactoryCertificate — níveis", () => {
  it("sem run nenhuma → `unknown`, e NÃO dispara validação (A4)", async () => {
    const cert = await computeFactoryCertificate(db(), PROJ);
    expect(cert.level).toBe("unknown");
    expect(cert.code).toBe("SPEC_NOT_VALIDATED");
    expect(cert.checks.find((c) => c.id === "C1")!.ok).toBe(true);
    expect(cert.checks.find((c) => c.id === "C2")!.ok).toBe(true);
    // C4/C5 são INDETERMINADOS, não reprovados: não há veredito para o conteúdo atual.
    expect(cert.checks.find((c) => c.id === "C4")!.ok).toBeNull();
    expect(fx.db.seen.some((s) => /INSERT|UPDATE|DELETE/i.test(s))).toBe(false);
  });

  it("run passed sem findings para o hash atual → `certified`", async () => {
    const hash = await currentHash();
    fx.db.runs = [{ id: RUN, status: "passed", spec_hash: hash, acked_role: null, findings: [] }];
    const cert = await computeFactoryCertificate(db(), PROJ);
    expect(cert.level).toBe("certified");
    expect(cert.code).toBeNull();
    expect(cert.caveats).toEqual([]);
    expect(cert.checks.filter((c) => c.ok === true)).toHaveLength(6);
  });

  it("editar a spec vence o certificado sem ninguém tocar em nada → `stale` (A5)", async () => {
    const hash = await currentHash();
    fx.db.runs = [{ id: RUN, status: "passed", spec_hash: hash, acked_role: null, findings: [] }];
    expect((await computeFactoryCertificate(db(), PROJ)).level).toBe("certified");
    await writeFile(fx.specPath, `${SPEC_REAL}\n## Novo requisito\ntexto\n`);
    const cert = await computeFactoryCertificate(db(), PROJ);
    expect(cert.level).toBe("stale");
    expect(cert.specHash).not.toBe(hash);
    expect(cert.checks.find((c) => c.id === "C3")!.detail).toContain("editada");
  });

  it("warnings sem ack → `blocked` com o código do gate; com ack → `certified_with_acks`", async () => {
    const hash = await currentHash();
    const warn: ValidationFinding = { file: "tms.md", line: null, severity: "warning", title: "sem métricas", rationale: "", source: "stage_b" };
    fx.db.runs = [{ id: RUN, status: "passed", spec_hash: hash, acked_role: null, findings: [warn] }];
    const blocked = await computeFactoryCertificate(db(), PROJ);
    expect(blocked).toMatchObject({ level: "blocked", code: "SPEC_WARNINGS_UNACKED" });
    expect(blocked.checks.find((c) => c.id === "C5")!.ok).toBe(false);

    fx.db.runs[0].acked_role = "tenant_admin";
    const acked = await computeFactoryCertificate(db(), PROJ);
    expect(acked.level).toBe("certified_with_acks");
    expect(acked.caveats.join(" ")).toContain("reconhecido");
    expect(acked.activeWarnings).toBe(1);
  });

  it("run failed com blocker ativo → `blocked`; blocker TRIADO → `certified_with_acks`", async () => {
    const hash = await currentHash();
    const blocker: ValidationFinding = {
      file: "tms.md", line: null, severity: "blocker", title: "contrato de auth ausente",
      rationale: "", source: "stage_b", category: "contract", anchor: "FR-01",
    };
    fx.db.runs = [{ id: RUN, status: "failed", spec_hash: hash, acked_role: null, findings: [blocker] }];
    const blocked = await computeFactoryCertificate(db(), PROJ);
    expect(blocked).toMatchObject({ level: "blocked", code: "SPEC_VALIDATION_BLOCKED", activeBlockers: 1 });

    // RFC-0005: triagem viva (auditada) desconta o blocker → passa COM ressalva, nunca limpo.
    fx.db.triages = [{
      id: "t1", project_id: PROJ, fingerprint: findingFingerprint(blocker), state: "refuted",
      reason_code: "false_positive", reason: "o contrato vive no connect.yaml", severity_at: "blocker",
      finding_snapshot: {}, spec_hash_at: hash, actor_user_id: "u1", actor_role: "tenant_admin",
      expires_at: null, inherited_from: null, recurrence_count: 0, created_at: new Date().toISOString(),
    }];
    const triaged = await computeFactoryCertificate(db(), PROJ);
    expect(triaged.level).toBe("certified_with_acks");
    expect(triaged.activeBlockers).toBe(0);
    expect(triaged.caveats.join(" ")).toContain("triados");
  });

  it("force de zentriz_admin em run failed → `certified_with_acks` com a ressalva explícita", async () => {
    const hash = await currentHash();
    fx.db.runs = [{
      id: RUN, status: "failed", spec_hash: hash, acked_role: "zentriz_admin",
      findings: [{ file: "tms.md", line: null, severity: "blocker", title: "x", rationale: "", source: "stage_b" }],
    }];
    const cert = await computeFactoryCertificate(db(), PROJ);
    expect(cert.level).toBe("certified_with_acks");
    expect(cert.caveats.join(" ")).toContain("zentriz_admin");
  });

  it("template em branco → `blocked` por conteúdo, antes de olhar validação (C2)", async () => {
    await writeFile(fx.specPath, SPEC_TEMPLATE);
    const cert = await computeFactoryCertificate(db(), PROJ);
    expect(cert).toMatchObject({ level: "blocked", code: "SPEC_PLACEHOLDER_TEMPLATE" });
    expect(cert.checks.find((c) => c.id === "C2")!.detail).toContain("sentinela_guia_template");
  });

  it("spec ausente do disco → `blocked` SPEC_FILES_MISSING (os 28 paths relativos do D1)", async () => {
    fx.db.files = [{ filename: "sumiu.md", rel_dir: "", file_path: path.join(fx.dir, "nao-existe.md"), is_primary: true }];
    const cert = await computeFactoryCertificate(db(), PROJ);
    expect(cert).toMatchObject({ level: "blocked", code: "SPEC_FILES_MISSING", specHash: null });
  });

  it("sem project_type → `blocked` (C7, mais estrito que o gate — nunca falsa promessa)", async () => {
    const hash = await currentHash();
    fx.db.runs = [{ id: RUN, status: "passed", spec_hash: hash, acked_role: null, findings: [] }];
    fx.db.projectType = "  ";
    const cert = await computeFactoryCertificate(db(), PROJ);
    expect(cert).toMatchObject({ level: "blocked", code: "PROJECT_TYPE_MISSING" });
    // O dispatch NÃO recusa por isso — a assimetria é consciente e está documentada no serviço.
    expect(await dispatchSpecRefusal()).toBeNull();
  });
});

describe("A2 — a flag do gate não muda o veredito, só `gateEnforced`", () => {
  it("gate OFF (default de prod) → mesmo nível, gateEnforced=false", async () => {
    const hash = await currentHash();
    fx.db.runs = [{
      id: RUN, status: "failed", spec_hash: hash, acked_role: null,
      findings: [{ file: "tms.md", line: null, severity: "blocker", title: "x", rationale: "", source: "stage_b" }],
    }];
    delete process.env.SPEC_VALIDATION_GATE;
    const off = await computeFactoryCertificate(db(), PROJ);
    process.env.SPEC_VALIDATION_GATE = "on";
    const on = await computeFactoryCertificate(db(), PROJ);
    expect(off.level).toBe("blocked");
    expect(off.level).toBe(on.level);
    expect(off.code).toBe(on.code);
    expect(off.gateEnforced).toBe(false);
    expect(on.gateEnforced).toBe(true);
    // …enquanto o GATE, com a flag OFF, libera a promoção — é o que o chip precisa avisar.
    delete process.env.SPEC_VALIDATION_GATE;
    expect((await checkSpecValidationGate(db(), PROJ)).ok).toBe(true);
  });
});

describe("A1 — coerência selo ↔ gates de spec do dispatch", () => {
  const matrix: Array<{ nome: string; arranjo: (hash: string) => void; espera: string | null }> = [
    { nome: "certificado limpo", arranjo: (h) => { fx.db.runs = [{ id: RUN, status: "passed", spec_hash: h, acked_role: null, findings: [] }]; }, espera: null },
    { nome: "com ack de warning", arranjo: (h) => { fx.db.runs = [{ id: RUN, status: "passed", spec_hash: h, acked_role: "tenant_admin", findings: [{ file: "tms.md", line: null, severity: "warning", title: "w", rationale: "", source: "stage_b" }] }]; }, espera: null },
    { nome: "force do admin", arranjo: (h) => { fx.db.runs = [{ id: RUN, status: "failed", spec_hash: h, acked_role: "zentriz_admin", findings: [{ file: "tms.md", line: null, severity: "blocker", title: "b", rationale: "", source: "stage_b" }] }]; }, espera: null },
    { nome: "blocker ativo", arranjo: (h) => { fx.db.runs = [{ id: RUN, status: "failed", spec_hash: h, acked_role: null, findings: [{ file: "tms.md", line: null, severity: "blocker", title: "b", rationale: "", source: "stage_b" }] }]; }, espera: "SPEC_VALIDATION_BLOCKED" },
    { nome: "warning sem ack", arranjo: (h) => { fx.db.runs = [{ id: RUN, status: "passed", spec_hash: h, acked_role: null, findings: [{ file: "tms.md", line: null, severity: "warning", title: "w", rationale: "", source: "stage_b" }] }]; }, espera: "SPEC_WARNINGS_UNACKED" },
    { nome: "hash não validado", arranjo: () => { fx.db.runs = []; }, espera: "SPEC_NOT_VALIDATED" },
  ];

  for (const caso of matrix) {
    it(`${caso.nome}: certificado e gate contam a MESMA história`, async () => {
      caso.arranjo(await currentHash());
      const cert = await computeFactoryCertificate(db(), PROJ);
      const refusal = await dispatchSpecRefusal();
      expect(refusal).toBe(caso.espera);
      if (refusal === null) {
        // A garantia que o chip promete: certificado ⇒ a fábrica não recusa por motivo de spec.
        expect(["certified", "certified_with_acks"]).toContain(cert.level);
      } else {
        expect(cert.level).not.toBe("certified");
        expect(cert.level).not.toBe("certified_with_acks");
        expect(cert.code).toBe(refusal);
      }
    });
  }

  it("template em branco: os dois recusam pelo mesmo código", async () => {
    await writeFile(fx.specPath, SPEC_TEMPLATE);
    fx.db.runs = [{ id: RUN, status: "passed", spec_hash: await currentHash(), acked_role: null, findings: [] }];
    const cert = await computeFactoryCertificate(db(), PROJ);
    expect(cert.code).toBe("SPEC_PLACEHOLDER_TEMPLATE");
    expect(await dispatchSpecRefusal()).toBe("SPEC_PLACEHOLDER_TEMPLATE");
  });
});

describe("D2b — selo Connect é SEPARADO", () => {
  it("connect.yaml completo → connect_ready, sem alterar o nível", async () => {
    const connectPath = path.join(fx.dir, "connect.yaml");
    await writeFile(connectPath, CONNECT_OK);
    fx.db.files.push({ filename: "connect.yaml", rel_dir: "", file_path: connectPath, is_primary: false });
    fx.db.runs = [{ id: RUN, status: "passed", spec_hash: await currentHash(), acked_role: null, findings: [] }];
    const cert = await computeFactoryCertificate(db(), PROJ);
    expect(cert.connect).toEqual({ level: "connect_ready", missing: [] });
    expect(cert.level).toBe("certified");
  });

  it("sem connect.yaml → absent, e o projeto CONTINUA certificável (A10: acervo pré-R4)", async () => {
    fx.db.runs = [{ id: RUN, status: "passed", spec_hash: await currentHash(), acked_role: null, findings: [] }];
    const cert = await computeFactoryCertificate(db(), PROJ);
    expect(cert.connect.level).toBe("absent");
    expect(cert.level).toBe("certified");
  });

  it("chaves obrigatórias faltando → incomplete, nomeando o que falta", () => {
    expect(assessConnectDeclaration("systemId: tms\ninterfaces:\n  - name: a\n    type: http\n")).toEqual({
      level: "incomplete", missing: ["schemaVersion", "serviceName", "responsibility"],
    });
  });
});

describe("A6 — agregado do produto é AND com n/m", () => {
  const cert = (level: FactoryCertificateLevel, connect: "connect_ready" | "absent" = "absent"): FactoryCertificate => ({
    level, code: null, message: "", specHash: "h", checks: [], caveats: [],
    connect: { level: connect, missing: [] }, gateEnforced: false, activeBlockers: 0, activeWarnings: 0,
  });

  it("20 certificados + 2 blocked NÃO viram 'quase pronto' — o produto fica `blocked`", () => {
    const certs = [...Array.from({ length: 20 }, () => cert("certified")), cert("blocked"), cert("blocked")];
    const agg = aggregateProductCertificate(certs);
    expect(agg.level).toBe("blocked");
    expect(agg.message).toContain("20/22 projetos certificados");
    expect(agg.blocked).toBe(2);
  });

  it("todos certificados, um com ressalva → `certified_with_acks`", () => {
    const agg = aggregateProductCertificate([cert("certified"), cert("certified_with_acks", "connect_ready")]);
    expect(agg.level).toBe("certified_with_acks");
    expect(agg).toMatchObject({ certified: 2, total: 2, withCaveats: 1, connectReady: 1 });
  });

  it("vencido pesa mais que nunca-validado; produto vazio é `unknown`", () => {
    expect(aggregateProductCertificate([cert("certified"), cert("stale"), cert("unknown")]).level).toBe("stale");
    expect(aggregateProductCertificate([cert("certified"), cert("unknown")]).level).toBe("unknown");
    expect(aggregateProductCertificate([])).toMatchObject({ level: "unknown", total: 0, certified: 0 });
  });

  it("todos limpos → `certified`", () => {
    expect(aggregateProductCertificate([cert("certified"), cert("certified")]).level).toBe("certified");
  });
});

describe("lote", () => {
  it("um projeto que explode não apaga o selo dos outros", async () => {
    const real = db();
    const flaky = {
      query: async (q: string, p: unknown[] = []) => {
        if ((p[0] as string) === "quebrado") throw new Error("boom");
        return real.query(q, p);
      },
    };
    fx.db.runs = [{ id: RUN, status: "passed", spec_hash: await currentHash(), acked_role: null, findings: [] }];
    const out = await computeFactoryCertificates(flaky, [PROJ, "quebrado"]);
    expect(out.get(PROJ)!.level).toBe("certified");
    expect(out.has("quebrado")).toBe(false);
  });
});

describe("flag de exibição", () => {
  it("nasce OFF e liga com FACTORY_CERTIFICATE=on", () => {
    expect(factoryCertificateEnabled()).toBe(false);
    process.env.FACTORY_CERTIFICATE = "on";
    expect(factoryCertificateEnabled()).toBe(true);
  });
});
