/**
 * specLearning.test.ts — G7/A3.3: a Bancada aprende (migração 096).
 *
 * O QUE ISTO PROTEGE (e por quê):
 *   1. **Claim idempotente** — duas réplicas da api no mesmo tick, ou um restart, não podem gerar
 *      duas extrações do mesmo episódio: cada extração é uma chamada de LLM paga.
 *   2. **Anonimização do material** — o `lessons_corpus` é GLOBAL: a lição de um cliente vira prompt
 *      do outro. Nome de produto/tenant/arquivo não pode sair daqui, e os termos identificáveis têm
 *      de chegar ao extrator como `forbidden_terms` (o veto literal do lado Python).
 *   3. **Conteúdo real do material** — sem "o que o validador apontou" e "o que cada rodada mudou"
 *      o modelo só veria contadores e devolveria banalidade. Este é o valor do G7.
 *   4. **Nunca derrubar o worker** — aprender é acessório; falha de agents/banco não pode parar a
 *      coleta de jobs nem o laço autônomo.
 *
 * Nada aqui julga o CONTEÚDO da lição: quem decide o que é lição é o modelo (⚖️ LEI 100% LLM).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildLearningMaterial, forbiddenTermsFor, fileLabels, loadEpisodeFindings,
  collectBancadaLessonsTick, LEARNING_MATERIAL_MAX_CHARS,
} from "./specLearning.js";

type Call = { sql: string; params: unknown[] };
type Row = Record<string, unknown>;

const PROJECT = "11111111-2222-3333-4444-555555555555";

function roundLog(over: Record<string, unknown> = {}) {
  return {
    round: 1, startedAt: "2026-09-05T10:00:00Z", finishedAt: "2026-09-05T10:12:00Z",
    filePath: "tecnico/dados.md", pass: 1, chatJobId: "cj-1", validationRunId: "vr-1",
    gapsBefore: 6, gapsAfter: 3, blockers: 2, warnings: 4, applied: true, specChars: 41_000,
    note: null, ...over,
  } as never;
}

function episodeRun(over: Record<string, unknown> = {}) {
  return {
    id: "run-1", status: "succeeded", mode: "per_file", round: 2, passes: 1, maxRounds: 5,
    gapsInitial: 6, gapsCurrent: 1, rounds: [roundLog()], lastError: null,
    createdAt: "2026-09-05T10:00:00Z", finishedAt: "2026-09-05T10:40:00Z", ...over,
  } as never;
}

const FINDING = {
  severity: "blocker", title: "Contrato do webhook sem idempotência",
  rationale: "A spec descreve o webhook de status mas não define chave de deduplicação.",
  file: "tecnico/dados.md", category: "integracao",
};

interface FakeOpts {
  pending?: Row[];
  polling?: Row[];
  claimRowCount?: number;
  identityFails?: boolean;
  validations?: Row[];
  validationsBefore?: Row[];
  validationsAfter?: Row[];
  scanThrows?: Error;
}

function fakeDb(opts: FakeOpts = {}) {
  const calls: Call[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/learning_kicked_at IS NULL AND finished_at IS NOT NULL/.test(sql)) {
        if (opts.scanThrows) throw opts.scanThrows;
        return { rows: opts.pending ?? [], rowCount: (opts.pending ?? []).length };
      }
      if (/SET learning_kicked_at = now\(\)/.test(sql)) {
        return { rows: [], rowCount: opts.claimRowCount ?? 1 };
      }
      if (/learning_job_id IS NOT NULL AND learning_result IS NULL/.test(sql)) {
        return { rows: opts.polling ?? [], rowCount: (opts.polling ?? []).length };
      }
      if (/FROM projects p/.test(sql)) {
        if (opts.identityFails) throw new Error("db down");
        return { rows: [{ title: "NVX LastMile", tenant_name: "Acme Logística" }], rowCount: 1 };
      }
      if (/FROM project_spec_files/.test(sql)) {
        return {
          rows: [
            { filename: "PRODUCT_SPEC.md", rel_dir: "", file_path: "/shared/uploads/a.md", is_primary: true },
            { filename: "dados.md", rel_dir: "tecnico", file_path: "/shared/uploads/b.md", is_primary: false },
          ],
          rowCount: 2,
        };
      }
      if (/FROM spec_validation_runs/.test(sql)) {
        // GAP-55: são DUAS leituras distintas — a validação que originou o laço (`created_at <=`)
        // e a última concluída DENTRO dele (`created_at >`). Um fake que devolve a mesma linha para
        // as duas esconderia justamente o defeito medido em prod.
        const isAfter = /created_at > \$2/.test(sql);
        const rows = isAfter ? (opts.validationsAfter ?? []) : (opts.validationsBefore ?? opts.validations ?? []);
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 1 };
    },
  } as never;
  return { db, calls, find: (re: RegExp) => calls.filter((c) => re.test(c.sql)) };
}

function transport(over: Partial<{ post: unknown; get: unknown }> = {}) {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const gets: string[] = [];
  return {
    posts, gets,
    post: (over.post as never) ?? (async (url: string, body: string) => {
      posts.push({ url, body: JSON.parse(body) as Record<string, unknown> });
      return JSON.stringify({ jobId: "le-abc123", status: "running" });
    }),
    get: (over.get as never) ?? (async (url: string) => {
      gets.push(url);
      return JSON.stringify({ status: "done", result: { mode: "live", extracted: 2, persisted: 2, slugs: ["spec.a", "spec.b"] } });
    }),
  };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  process.env.API_AGENTS_URL = "http://agents:8000";
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.API_AGENTS_URL; });

// ── material: o valor do G7 ───────────────────────────────────────────────────

describe("buildLearningMaterial", () => {
  it("leva o resultado, o progresso, os GAPs de antes/depois e o que cada rodada fez", () => {
    const md = buildLearningMaterial({
      run: episodeRun(),
      gapsBefore: [FINDING],
      gapsAfter: [{ ...FINDING, severity: "warning", title: "Métrica de SLA sem fórmula" }],
      filePaths: ["PRODUCT_SPEC.md", "tecnico/dados.md"],
    });
    expect(md).toContain("**succeeded**");
    expect(md).toContain("6 no início → 1 no fim");
    expect(md).toContain("Contrato do webhook sem idempotência");
    expect(md).toContain("chave de deduplicação");
    expect(md).toContain("Métrica de SLA sem fórmula");
    expect(md).toContain("rodada 1");
    expect(md).toContain("GAPs 6 → 3");
    expect(md).toContain("revisão aplicada");
    // a pergunta é o que orienta o modelo a generalizar em vez de resumir o episódio
    expect(md).toContain("ENGENHARIA DE ESPECIFICAÇÃO");
  });

  it("NUNCA cita nome de arquivo real — usa rótulos anônimos (o corpus é global)", () => {
    const md = buildLearningMaterial({
      run: episodeRun(),
      gapsBefore: [FINDING],
      gapsAfter: [],
      filePaths: ["PRODUCT_SPEC.md", "tecnico/dados.md"],
    });
    expect(md).not.toContain("dados.md");
    expect(md).not.toContain("PRODUCT_SPEC");
    expect(md).toMatch(/arquivo [AB]/);
  });

  it("registra o motivo do encerramento (é o que ensina sobre o limite do laço)", () => {
    const md = buildLearningMaterial({
      run: episodeRun({ status: "stalled", lastError: "revisão INCOMPLETA: resposta truncada em max_tokens" }),
      gapsBefore: [], gapsAfter: [], filePaths: [],
    });
    expect(md).toContain("**stalled**");
    expect(md).toContain("truncada em max_tokens");
  });

  it("diz explicitamente quando todos os GAPs foram resolvidos (o episódio de sucesso ensina tanto quanto o de falha)", () => {
    const md = buildLearningMaterial({
      run: episodeRun(), gapsBefore: [FINDING], gapsAfter: [], afterMeasured: true, filePaths: [],
    });
    expect(md).toContain("nenhum — todos foram resolvidos");
  });

  it("🔴 GAP-56: sem validação DEPOIS do laço não declara sucesso — declara NÃO MEDIDO", () => {
    // Medido em prod 2026-09-07: runs `stopped` com 41 → 41 GAPs (nada resolvido) e ZERO validações
    // dentro do laço recebiam a frase "todos foram resolvidos". A lição é global: isso ensinaria a
    // outros produtos que um laço que não mediu nada teve sucesso.
    const md = buildLearningMaterial({
      run: episodeRun({ status: "stopped", gapsInitial: 41, gapsCurrent: 41 }),
      gapsBefore: [FINDING], gapsAfter: [], afterMeasured: false, filePaths: [],
    });
    expect(md).toContain("NÃO MEDIDOS");
    expect(md).not.toContain("todos foram resolvidos");
    expect(md).toContain("Não trate as revisões deste episódio como bem-sucedidas");
  });

  it("🔴 GAP-56: fail-closed — quem não informa a medição não ganha o crédito por ela", () => {
    const md = buildLearningMaterial({ run: episodeRun(), gapsBefore: [FINDING], gapsAfter: [], filePaths: [] });
    expect(md).not.toContain("todos foram resolvidos");
    expect(md).toContain("NÃO MEDIDOS");
  });

  it("🔴 GAP-58: nome real de arquivo em TEXTO LIVRE (`note`) também é rotulado", () => {
    // Frase real de prod: "`modelo-dados.md` salvo no disco (183918 → 191852 chars)".
    const md = buildLearningMaterial({
      run: episodeRun({
        rounds: [roundLog({ filePath: "tecnico/dados.md", note: "`dados.md` salvo no disco (183918 → 191852 chars)." })],
      }),
      gapsBefore: [], gapsAfter: [], afterMeasured: true, filePaths: ["PRODUCT_SPEC.md", "tecnico/dados.md"],
    });
    expect(md).not.toContain("dados.md");
    expect(md).toContain("salvo no disco");
    expect(md).toMatch(/arquivo [AB]/);
  });

  it("🔴 GAP-58: nome real de arquivo no motivo do encerramento também é rotulado", () => {
    // Frase real de prod: "último: `nvx-lastmile-backend.md` — CTO não entregou revisão".
    const md = buildLearningMaterial({
      run: episodeRun({
        status: "stalled",
        lastError: "2 arquivos seguidos sem revisão aplicável (último: `nvx-lastmile-backend.md` — CTO não entregou revisão)",
      }),
      gapsBefore: [], gapsAfter: [], afterMeasured: true,
      filePaths: ["nvx-lastmile-backend.md", "tecnico/dados.md"],
    });
    expect(md).not.toContain("nvx-lastmile-backend");
    expect(md).not.toContain("lastmile");
    expect(md).toContain("sem revisão aplicável");
  });

  it("respeita o teto de chars", () => {
    const rounds = Array.from({ length: 400 }, (_, i) => roundLog({ round: i + 1, note: "x".repeat(200) }));
    const md = buildLearningMaterial({ run: episodeRun({ rounds }), gapsBefore: [], gapsAfter: [], filePaths: [] });
    expect(md.length).toBeLessThanOrEqual(LEARNING_MATERIAL_MAX_CHARS + 40);
    expect(md).toContain("truncado");
  });
});

describe("fileLabels / forbiddenTermsFor", () => {
  it("rotula cada arquivo uma vez, de forma estável", () => {
    const l = fileLabels(["a.md", "b/c.md", "a.md"]);
    expect(l.get("a.md")).toBe("arquivo A");
    expect(l.get("b/c.md")).toBe("arquivo B");
    expect(l.size).toBe(2);
  });

  it("veta título do projeto, tenant, palavras deles e nomes de arquivo", () => {
    const t = forbiddenTermsFor({
      projectTitle: "NVX LastMile", tenantName: "Acme Logística", projectId: PROJECT,
      filePaths: ["PRODUCT_SPEC.md", "tecnico/dados-nvx.md"],
    });
    expect(t).toContain("NVX LastMile");
    expect(t).toContain("LastMile");
    expect(t).toContain("Acme Logística");
    expect(t).toContain("dados-nvx.md");
    expect(t).toContain("dados-nvx");
    expect(t).toContain("11111111");
  });

  it("não veta palavras genéricas — vetaria TODA lição útil (o veto é literal)", () => {
    const t = forbiddenTermsFor({ projectTitle: "Portal Backend", filePaths: ["PRODUCT_SPEC.md"] });
    expect(t).not.toContain("Portal");
    expect(t).not.toContain("Backend");
    expect(t).not.toContain("PRODUCT_SPEC");
    expect(t).not.toContain("PRODUCT_SPEC.md");
  });

  it("ignora termos curtos (3 chars vetariam qualquer texto)", () => {
    const t = forbiddenTermsFor({ projectTitle: "ERP", tenantName: "X Y" });
    expect(t.every((x) => x.length >= 4)).toBe(true);
  });
});

// ── leitura dos GAPs do episódio ──────────────────────────────────────────────

describe("loadEpisodeFindings", () => {
  it("pega a validação que ORIGINOU o laço e a última DENTRO dele, e descarta `info`", async () => {
    const { db } = fakeDb({
      validationsBefore: [{ findings: [FINDING, { ...FINDING, severity: "info", title: "nota" }], created_at: "2026-09-05T09:58:00Z" }],
      validationsAfter: [{ findings: [{ ...FINDING, severity: "warning" }], created_at: "2026-09-05T10:30:00Z" }],
    });
    const out = await loadEpisodeFindings(db, PROJECT, "2026-09-05T10:00:00Z", "2026-09-05T10:40:00Z");
    expect(out.before).toHaveLength(1);
    expect(out.before[0]?.title).toBe(FINDING.title);
    expect(out.after).toHaveLength(1);
    expect(out.after[0]?.severity).toBe("warning");
    expect(out.afterMeasured).toBe(true);
  });

  it("🔴 GAP-55: a janela é da RUN — validação ANTERIOR ao laço não pode virar o 'depois'", async () => {
    // Medido em prod 2026-09-07: a janela era do PROJETO com `- 12 horas` e `ASC LIMIT 12`; no NVX
    // havia 30 validações nela contra 1 dentro do laço, então o "depois" era a 12ª mais antiga —
    // de 06/09 22:30, ANTERIOR ao início do laço (07/09 07:22). O relatório ensinava "19 → 15"
    // enquanto a run registrava 41 → 41.
    const { db, find } = fakeDb({
      validationsBefore: [{ findings: [FINDING], created_at: "2026-09-06T22:30:00Z" }],
      validationsAfter: [],
    });
    const out = await loadEpisodeFindings(db, PROJECT, "2026-09-07T07:22:00Z", "2026-09-07T07:42:00Z");
    expect(out.after).toEqual([]);
    expect(out.afterMeasured).toBe(false);
    // e nenhuma das duas leituras pode abrir janela retroativa de horas
    for (const c of find(/FROM spec_validation_runs/)) {
      expect(c.sql).not.toContain("12 hours");
      expect(c.sql).toContain("ORDER BY created_at DESC LIMIT 1");
    }
  });

  it("aceita findings vindos como texto JSON (driver sem parse)", async () => {
    const { db } = fakeDb({ validationsBefore: [{ findings: JSON.stringify([FINDING]), created_at: "x" }] });
    const out = await loadEpisodeFindings(db, PROJECT, "2026-09-05T10:00:00Z", null);
    expect(out.before).toHaveLength(1);
    expect(out.after).toEqual([]);
  });

  it("sem validação na janela devolve vazio (sem lançar)", async () => {
    const { db } = fakeDb({ validations: [] });
    await expect(loadEpisodeFindings(db, PROJECT, "x", null)).resolves.toEqual({
      before: [], after: [], afterMeasured: false,
    });
  });
});

// ── o tick ────────────────────────────────────────────────────────────────────

describe("collectBancadaLessonsTick", () => {
  const pendingRow = (over: Row = {}): Row => ({
    id: "run-1", project_id: PROJECT, tenant_id: "t1", status: "succeeded", mode: "per_file",
    round: 2, passes: 1, max_rounds: 5, gaps_initial: 6, gaps_current: 1,
    rounds: [roundLog()], last_error: null,
    created_at: "2026-09-05T10:00:00Z", finished_at: "2026-09-05T10:40:00Z",
    learning_job_id: null, learning_kicked_at: null, ...over,
  });

  it("reclama a run ANTES de chamar o agents e guarda o jobId", async () => {
    const { db, calls, find } = fakeDb({ pending: [pendingRow()] });
    const tp = transport();
    const out = await collectBancadaLessonsTick(db, tp);
    expect(out.kicked).toBe(1);
    const claimIdx = calls.findIndex((c) => /SET learning_kicked_at = now\(\)/.test(c.sql));
    expect(claimIdx).toBeGreaterThanOrEqual(0);
    // claim aconteceu antes do POST (o POST é o que custa modelo)
    expect(tp.posts).toHaveLength(1);
    expect(tp.posts[0]?.url).toContain("/invoke/lesson_extract/async");
    expect(find(/SET learning_job_id = \$2/)[0]?.params[1]).toBe("le-abc123");
  });

  it("claim perdido para outra réplica NÃO dispara segunda extração", async () => {
    const { db } = fakeDb({ pending: [pendingRow()], claimRowCount: 0 });
    const tp = transport();
    const out = await collectBancadaLessonsTick(db, tp);
    expect(out.kicked).toBe(0);
    expect(tp.posts).toEqual([]);
  });

  it("envia kind=spec, stack_key=generic e os forbidden_terms do projeto", async () => {
    const { db } = fakeDb({ pending: [pendingRow()], validations: [{ findings: [FINDING], created_at: "x" }] });
    const tp = transport();
    await collectBancadaLessonsTick(db, tp);
    const body = tp.posts[0]!.body;
    expect(body.kind).toBe("spec");
    // `generic` é o que o retrieval sempre vê (filtro `stack_key = atual OR 'generic'`): com uma
    // stack específica a lição nunca reapareceria nos outros projetos — o ponto do G7.
    expect(body.stack_key).toBe("generic");
    expect(body.project_id).toBe(PROJECT);
    expect(body.forbidden_terms).toContain("NVX LastMile");
    expect(body.forbidden_terms).toContain("Acme Logística");
    expect(String(body.material)).toContain("Contrato do webhook sem idempotência");
    expect(String(body.material)).not.toContain("NVX LastMile");
  });

  it("run sem rodadas é reclamada com motivo e não gasta modelo", async () => {
    const { db, find } = fakeDb({ pending: [pendingRow({ rounds: [], status: "failed" })] });
    const tp = transport();
    const out = await collectBancadaLessonsTick(db, tp);
    expect(out.skipped).toBe(1);
    expect(tp.posts).toEqual([]);
    const rec = find(/SET learning_result = \$2::jsonb/)[0];
    expect(String(rec?.params[1])).toContain("sem rodadas");
  });

  it("falha do agents fica registrada em learning_result (não repete para sempre)", async () => {
    const { db, find } = fakeDb({ pending: [pendingRow()] });
    const tp = transport({ post: async () => { throw new Error("connect ECONNREFUSED agents:8000"); } });
    const out = await collectBancadaLessonsTick(db, tp);
    expect(out.kicked).toBe(0);
    expect(String(find(/SET learning_result = \$2::jsonb/)[0]?.params[1])).toContain("ECONNREFUSED");
  });

  it("falha transitória DEVOLVE a run à fila (o 404 da janela de deploy não pode perder o episódio)", async () => {
    // MEDIDO em prod 2026-09-06: o primeiro tick caiu no intervalo em que o agents ainda rodava a
    // imagem antiga → 404. Sem retry o episódio ficaria reclamado e nunca mais seria aprendido.
    const { db, find } = fakeDb({ pending: [pendingRow()] });
    const tp = transport({ post: async () => { throw new Error("HTTP 404: Not Found"); } });
    await collectBancadaLessonsTick(db, tp);
    expect(String(find(/SET learning_result = \$2::jsonb/)[0]?.params[1])).toContain('"attempts":1');
    expect(find(/SET learning_kicked_at = NULL/)).toHaveLength(1);
  });

  it("🔴 GAP-57: kick que dá certo no retry LIMPA o erro anterior — senão a fase 2 nunca faz poll", async () => {
    // Medido em prod 2026-09-07: a run 013ca0e5 ficou com
    // `{"error":"connect ECONNREFUSED …","attempts":1}` para sempre, enquanto o agents havia
    // persistido 4 lições às 07:43:29 para o job disparado no retry. A fase 2 seleciona
    // `learning_result IS NULL`, então o episódio nunca era coletado e a telemetria do G7 mentia —
    // no sentido pessimista, fazendo parecer que a Bancada não aprende.
    const { db, find } = fakeDb({ pending: [pendingRow({ learning_result: { error: "connect ECONNREFUSED", attempts: 1 } })] });
    const tp = transport();
    const out = await collectBancadaLessonsTick(db, tp);
    expect(out.kicked).toBe(1);
    const save = find(/SET learning_job_id = \$2/)[0];
    expect(save?.params[1]).toBe("le-abc123");
    expect(save?.sql).toContain("learning_result = NULL");
  });

  it("🔴 GAP-57: jobId que não persiste é registrado (episódio não fica invisível)", async () => {
    const calls: Call[] = [];
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (/learning_kicked_at IS NULL AND finished_at IS NOT NULL/.test(sql)) return { rows: [pendingRow()], rowCount: 1 };
        if (/SET learning_kicked_at = now\(\)/.test(sql)) return { rows: [], rowCount: 1 };
        if (/SET learning_job_id = \$2/.test(sql)) throw new Error("deadlock detected");
        if (/FROM projects p/.test(sql)) return { rows: [{ title: "P", tenant_name: "T" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
    } as never;
    await collectBancadaLessonsTick(db, transport());
    const rec = calls.filter((c) => /SET learning_result = \$2::jsonb/.test(c.sql))[0];
    expect(String(rec?.params[1])).toContain("jobId não persistido");
  });

  it("depois de MAX_KICK_ATTEMPTS a run para de voltar à fila", async () => {
    const { db, find } = fakeDb({ pending: [pendingRow({ learning_result: { error: "x", attempts: 2 } })] });
    const tp = transport({ post: async () => { throw new Error("HTTP 404: Not Found"); } });
    await collectBancadaLessonsTick(db, tp);
    expect(String(find(/SET learning_result = \$2::jsonb/)[0]?.params[1])).toContain('"attempts":3');
    expect(find(/SET learning_kicked_at = NULL/)).toEqual([]);
  });

  it("timestamps vindos como Date viram ISO — o Postgres recusa o toString() do JS", async () => {
    // MEDIDO em prod: `invalid input syntax for type timestamp with time zone:
    // "Sat Sep 05 2026 12:15:39 GMT+0000 (Coordinated Universal Time)"` — a janela de validações
    // não era lida e o material ia SEM os GAPs de antes/depois (o valor da lição).
    const { db, calls } = fakeDb({
      pending: [pendingRow({
        created_at: new Date("2026-09-05T12:00:00Z"), finished_at: new Date("2026-09-05T12:40:00Z"),
      })],
      validations: [{ findings: [FINDING], created_at: "2026-09-05T12:05:00Z" }],
    });
    const tp = transport();
    await collectBancadaLessonsTick(db, tp);
    // GAP-55: são duas leituras — o início do laço vai nas duas, o fim só na do "depois".
    const [antes, depois] = calls.filter((c) => /FROM spec_validation_runs/.test(c.sql));
    expect(antes?.params[1]).toBe("2026-09-05T12:00:00.000Z");
    expect(depois?.params[1]).toBe("2026-09-05T12:00:00.000Z");
    expect(depois?.params[2]).toBe("2026-09-05T12:40:00.000Z");
    expect(String(tp.posts[0]?.body.material)).toContain("Contrato do webhook sem idempotência");
  });

  it("identidade indisponível aborta o kick — melhor não extrair do que contaminar o corpus", async () => {
    const { db, find } = fakeDb({ pending: [pendingRow()], identityFails: true });
    const tp = transport();
    const out = await collectBancadaLessonsTick(db, tp);
    expect(tp.posts).toEqual([]);
    expect(out.kicked).toBe(0);
    expect(String(find(/SET learning_result = \$2::jsonb/)[0]?.params[1])).toContain("db down");
  });

  it("sem API_AGENTS_URL não faz nada (nem varre)", async () => {
    delete process.env.API_AGENTS_URL;
    const { db, calls } = fakeDb({ pending: [pendingRow()] });
    const out = await collectBancadaLessonsTick(db, transport());
    expect(out).toEqual({ scanned: 0, kicked: 0, skipped: 0, polled: 0, finished: 0 });
    expect(calls).toEqual([]);
  });

  it("migração 096 ausente → silêncio (banco atrás do código, sem ruído a cada 20 s)", async () => {
    const { db } = fakeDb({ scanThrows: new Error('column "learning_kicked_at" does not exist') });
    const out = await collectBancadaLessonsTick(db, transport());
    expect(out.kicked).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("poll guarda a telemetria do episódio concluído", async () => {
    const { db, find } = fakeDb({
      polling: [{ id: "run-1", learning_job_id: "le-abc123", learning_kicked_at: new Date().toISOString() }],
    });
    const tp = transport();
    const out = await collectBancadaLessonsTick(db, tp);
    expect(out.polled).toBe(1);
    expect(out.finished).toBe(1);
    expect(tp.gets[0]).toContain("/invoke/lesson_extract/status/le-abc123");
    const rec = String(find(/SET learning_result = \$2::jsonb/)[0]?.params[1]);
    expect(rec).toContain('"persisted":2');
    expect(rec).toContain("le-abc123");
  });

  it("job ainda rodando não fecha o registro (tenta de novo no próximo tick)", async () => {
    const { db, find } = fakeDb({
      polling: [{ id: "run-1", learning_job_id: "le-abc", learning_kicked_at: new Date().toISOString() }],
    });
    const tp = transport({ get: async () => JSON.stringify({ status: "running" }) });
    const out = await collectBancadaLessonsTick(db, tp);
    expect(out.finished).toBe(0);
    expect(find(/SET learning_result = \$2::jsonb/)).toEqual([]);
  });

  it("404 do agents (TTL do job) fecha com causa honesta em vez de pollar para sempre", async () => {
    const { db, find } = fakeDb({
      polling: [{ id: "run-1", learning_job_id: "le-abc", learning_kicked_at: new Date().toISOString() }],
    });
    const tp = transport({ get: async () => { throw new Error("agents respondeu 404"); } });
    const out = await collectBancadaLessonsTick(db, tp);
    expect(out.finished).toBe(1);
    expect(String(find(/SET learning_result = \$2::jsonb/)[0]?.params[1])).toContain("TTL");
  });

  it("desiste do poll depois do teto de minutos", async () => {
    const old = new Date(Date.now() - 40 * 60_000).toISOString();
    const { db, find } = fakeDb({ polling: [{ id: "run-1", learning_job_id: "le-abc", learning_kicked_at: old }] });
    const tp = transport();
    const out = await collectBancadaLessonsTick(db, tp);
    expect(out.polled).toBe(0);
    expect(tp.gets).toEqual([]);
    expect(String(find(/SET learning_result = \$2::jsonb/)[0]?.params[1])).toContain("sem resposta do agents");
  });

  it("erro do job é propagado como erro do episódio", async () => {
    const { db, find } = fakeDb({
      polling: [{ id: "run-1", learning_job_id: "le-abc", learning_kicked_at: new Date().toISOString() }],
    });
    const tp = transport({ get: async () => JSON.stringify({ status: "error", error: "modelo negou acesso (403)" }) });
    const out = await collectBancadaLessonsTick(db, tp);
    expect(out.finished).toBe(1);
    expect(String(find(/SET learning_result = \$2::jsonb/)[0]?.params[1])).toContain("403");
  });

  it("nunca lança — aprender não pode derrubar o worker da Bancada", async () => {
    const { db } = fakeDb({ pending: [pendingRow()] });
    const tp = transport({ post: async () => "isto não é JSON" });
    await expect(collectBancadaLessonsTick(db, tp)).resolves.toBeTruthy();
  });
});
