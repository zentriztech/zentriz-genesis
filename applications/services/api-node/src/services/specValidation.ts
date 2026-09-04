/**
 * specValidation.ts — RFC-0004 Onda 3 (F4): operação Validar.
 *
 * Arquitetura (pós-auditoria adversarial):
 *  • A FILA É A TABELA (spec_validation_runs) — o job nasce persistido; poll na tabela;
 *    reaper no boot marca 'running' órfão como 'interrupted'; watchdog aplica deadline.
 *  • Estágio A DETERMINÍSTICO (sempre, ms): manifesto/arquétipo/tetos/readiness — nunca
 *    anulável pelo LLM (merge de findings = UNIÃO; o estágio B só ADICIONA).
 *  • Estágio B ADVERSARIAL (LLM, no agents): validadores SEM ferramentas, texto→JSON,
 *    spec delimitada com framing anti-injection; triagem Haiku + refutação Sonnet.
 *  • Veredito amarrado ao HASH-DE-INÍCIO; ao final recomputa — divergiu → 'superseded'.
 *  • Estado de validação é DERIVADO (run 'passed' para o hash ATUAL?) — projects.status
 *    NUNCA é tocado (histórico da migration 040 / rerun_requested).
 *  • Custo: checkTenantBudget ANTES de enfileirar; dedupe por hash (revalidar conteúdo
 *    idêntico = custo zero); rate-limit 4/h por spec; usage do LLM → /agent-metrics.
 *
 * Severidades de finding: 'blocker' | 'warning' | 'info'.
 * Regra do gate (checkSpecValidationGate): OFF por env (default) = passa tudo;
 * ON: run 'passed' p/ hash atual E (sem warnings OU run acked) → passa; run acked por
 * zentriz_admin (force) passa mesmo com blocker (auditado). Caso contrário, 409.
 */
import { readFile } from "fs/promises";
import type { Pool } from "pg";
import { computeSpecTreeHash, sha256Hex, SPEC_TREE_MAX_FILES, SPEC_TREE_MAX_FILE_BYTES, SPEC_TREE_MAX_TOTAL_BYTES } from "../lib/specTreeHash.js";
import { loadArchetypeCatalog, getArchetype } from "./archetypeCatalog.js";
import { checkTenantBudget, budgetExceededMessage } from "./tenantCostCap.js";
import { UUID_RE } from "../lib/tenantScope.js";
import { parseRfcMarkdown, RFC_DIR, RFC_FILENAME_RE } from "./evolutionGate.js";
import { normalizeCategory, enrichRunFindings, registerRecurrences } from "./findingTriage.js";

// Rate-limit simples por chave (in-memory por processo — suficiente como freio de custo;
// o createRateLimiter do repo é um preHandler por request, não serve p/ chave de domínio).
const _rlBuckets = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(key: string, opts: { windowMs: number; max: number }): { ok: boolean } {
  const now = Date.now();
  let b = _rlBuckets.get(key);
  if (!b || b.resetAt <= now) {
    if (_rlBuckets.size > 10_000) {
      for (const [k, v] of _rlBuckets) if (v.resetAt <= now) _rlBuckets.delete(k);
    }
    b = { count: 0, resetAt: now + opts.windowMs };
    _rlBuckets.set(key, b);
  }
  b.count += 1;
  return { ok: b.count <= opts.max };
}

export interface ValidationFinding {
  file: string;
  line: number | null;
  severity: "blocker" | "warning" | "info";
  title: string;
  rationale: string;
  source: "stage_a" | "stage_b";
  /** RFC-0005: taxonomia fechada (lentes do validador; Stage A = `structural`) — parte do fingerprint. */
  category?: string | null;
  /** RFC-0005: o que o finding aponta (FR-NN, heading, entidade; Stage A = id da regra) — parte do fingerprint. */
  anchor?: string | null;
}

/** RFC-0005: Stage A é determinístico → categoria/anchor por REGRA (título estável → id). */
function annotateStageA(f: ValidationFinding): ValidationFinding {
  const t = f.title;
  const rule =
    /excede o teto de arquivos/i.test(t) ? "too_many_files" :
    /acima do teto/i.test(t) || /excede o teto$/i.test(t) || /agregada excede/i.test(t) ? "file_too_large" :
    /sem manifesto/i.test(t) ? "no_readme" :
    /sem frontmatter/i.test(t) ? "readme_no_frontmatter" :
    /Arquétipo desconhecido/i.test(t) ? "archetype_unknown" :
    /Campos de ESTADO/i.test(t) ? "state_in_frontmatter" :
    /RFC fora do padrão/i.test(t) ? "rfc_bad_name" :
    /RFC sem critérios/i.test(t) ? "rfc_no_gherkin" :
    /files_allowed irrestrito/i.test(t) ? "rfc_unrestricted_scope" :
    /sem `## Impacto`/i.test(t) ? "rfc_no_files_allowed" :
    /só de testes\/docs/i.test(t) ? "rfc_tests_only_scope" :
    /sem Não-objetivos/i.test(t) ? "rfc_no_non_goals" :
    /sem `## Compatibilidade`/i.test(t) ? "rfc_no_compat" :
    /sem conteúdo substantivo/i.test(t) ? "empty_spec" : "stage_a_other";
  const category = /^rfc_/.test(rule) ? (/gherkin|non_goals/.test(rule) ? "no_acceptance_criteria" : "structural") : "structural";
  return { ...f, category: f.category ?? category, anchor: f.anchor ?? rule };
}

export interface ValidationRun {
  id: string;
  projectId: string | null;
  productId: string | null;
  specHash: string;
  catalogVersion: string;
  status: string;
  findings: ValidationFinding[];
  ackedBy: string | null;
  ackedRole: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** Gate env-flag (padrão H3/rota B): nasce OFF; ligar = SPEC_VALIDATION_GATE=on. */
export function specValidationGateEnabled(): boolean {
  return (process.env.SPEC_VALIDATION_GATE ?? "off").trim().toLowerCase() === "on";
}

const VALIDATION_DEADLINE_MIN = parseInt(process.env.SPEC_VALIDATION_DEADLINE_MIN ?? "20", 10);

// ── hash do estado atual (disco é a verdade) ─────────────────────────────────

export interface SpecFileRow {
  filename: string;
  file_path: string;
  rel_dir: string;
}

export async function computeCurrentSpecHash(
  db: { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  projectId: string,
): Promise<{ specHash: string; files: Array<SpecFileRow & { content: string }> } | null> {
  const rows = (await db.query(
    "SELECT filename, file_path, rel_dir FROM project_spec_files WHERE project_id = $1",
    [projectId],
  )).rows as unknown as SpecFileRow[];
  if (rows.length === 0) return null;
  const files: Array<SpecFileRow & { content: string }> = [];
  const entries: Array<{ relDir: string; filename: string; contentSha256: string }> = [];
  for (const r of rows) {
    const buf = await readFile(r.file_path).catch(() => null);
    if (buf === null) return null; // arquivo sumiu do disco — estado inválido p/ validar
    files.push({ ...r, content: buf.toString("utf-8") });
    entries.push({ relDir: r.rel_dir ?? "", filename: r.filename, contentSha256: sha256Hex(buf) });
  }
  return { specHash: computeSpecTreeHash(entries), files };
}

// ── Estágio A — determinístico, sempre, custo zero ───────────────────────────

function parseFrontmatter(content: string): Record<string, string> | null {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return null;
  const out: Record<string, string> = {};
  for (const line of content.slice(4, end).split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

export function runStageA(files: Array<SpecFileRow & { content: string }>, opts: { evolution?: boolean } = {}): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  // Evoluir E3: em EVOLUÇÃO os RFCs são exigência dura (mesmo critério do gate de promoção →
  // blocker); em produto novo com RFCs "de design" só avisam (a regra existe para evolução).
  const rfcSev: ValidationFinding["severity"] = opts.evolution ? "blocker" : "warning";
  const catalog = loadArchetypeCatalog();

  // Tetos (anti-abuso — mesmos do hash)
  if (files.length > SPEC_TREE_MAX_FILES) {
    findings.push({ file: "", line: null, severity: "blocker", title: "Spec excede o teto de arquivos",
      rationale: `${files.length} arquivos (máx ${SPEC_TREE_MAX_FILES}).`, source: "stage_a" });
  }
  let total = 0;
  for (const f of files) {
    const bytes = Buffer.byteLength(f.content, "utf-8");
    total += bytes;
    if (bytes > SPEC_TREE_MAX_FILE_BYTES) {
      findings.push({ file: `${f.rel_dir ? f.rel_dir + "/" : ""}${f.filename}`, line: null, severity: "blocker",
        title: "Arquivo excede o teto de tamanho", rationale: `${bytes} bytes (máx ${SPEC_TREE_MAX_FILE_BYTES}).`, source: "stage_a" });
    }
  }
  if (total > SPEC_TREE_MAX_TOTAL_BYTES) {
    findings.push({ file: "", line: null, severity: "blocker", title: "Spec agregada excede o teto",
      rationale: `${total} bytes (máx ${SPEC_TREE_MAX_TOTAL_BYTES}).`, source: "stage_a" });
  }

  // Manifesto (README) — AUSÊNCIA é warning, nunca blocker (leniência p/ legado — 100% das
  // specs pré-RFC não têm manifesto e continuam promovíveis com ack).
  const readme = files.find((f) => (f.rel_dir ?? "") === "" && f.filename.toLowerCase() === "readme.md");
  if (!readme) {
    findings.push({ file: "", line: null, severity: "warning", title: "Spec sem manifesto (README.md)",
      rationale: "Specs hierárquicas levam um README com frontmatter (archetype/stack/depends_on). Legado é aceito com acknowledgment.", source: "stage_a" });
  } else {
    const fm = parseFrontmatter(readme.content);
    if (!fm) {
      findings.push({ file: "README.md", line: 1, severity: "warning", title: "README sem frontmatter",
        rationale: "Manifesto sem bloco YAML — campos archetype/stack/depends_on ausentes.", source: "stage_a" });
    } else {
      const arch = (fm.archetype ?? "").trim();
      if (arch && !getArchetype(arch)) {
        findings.push({ file: "README.md", line: 1, severity: "blocker", title: `Arquétipo desconhecido: ${arch}`,
          rationale: `Fora do catálogo v${catalog.catalogVersion} — a fábrica não sabe processá-lo. Válidos: ${catalog.archetypes.map((a) => a.id).join(", ")}.`, source: "stage_a" });
      }
      // estado no arquivo é PROIBIDO (auto-referente/forjável)
      if (fm.spec_hash !== undefined || fm.status_spec !== undefined) {
        findings.push({ file: "README.md", line: 1, severity: "warning", title: "Campos de ESTADO no frontmatter",
          rationale: "spec_hash/status_spec vivem só no banco; no arquivo são ignorados e não devem existir.", source: "stage_a" });
      }
    }
  }

  // Evoluir E3: RFCs de evolução (docs/rfc/RFC-NNNN-*.md) precisam ser IMPLEMENTÁVEIS/TESTÁVEIS —
  // Gherkin nos critérios de aceite (FAIL_TO_PASS do QA) e `## Impacto`/files_allowed (escopo do gate).
  for (const f of files) {
    const rel = (f.rel_dir ?? "").replace(/^\/+|\/+$/g, "").toLowerCase();
    if (rel !== RFC_DIR) continue;
    const label = `${RFC_DIR}/${f.filename}`;
    if (!RFC_FILENAME_RE.test(f.filename)) {
      // Mesmo critério do gate: arquivo fora do padrão em docs/rfc/ é IGNORADO pela promoção
      // (cairia em EVOLUTION_RFC_REQUIRED) — por isso é blocker em evolução, não aviso.
      findings.push({ file: label, line: null, severity: rfcSev, title: "RFC fora do padrão de nome (será ignorado pela fábrica)",
        rationale: "Use `RFC-NNNN-<slug>.md` (numeração sequencial por produto). Só arquivos nesse padrão contam como RFC na promoção.", source: "stage_a" });
      continue;
    }
    const rfc = parseRfcMarkdown(label, f.content);
    if (!rfc.hasGherkin) {
      findings.push({ file: label, line: null, severity: rfcSev, title: "RFC sem critérios de aceite em Gherkin",
        rationale: "Seção `## Critérios de aceite` com ≥1 cenário em bullets Dado/Quando/Então (início da linha) e resultado observável — é o que o QA testa (FAIL_TO_PASS).", source: "stage_a" });
    }
    const unrestricted = rfc.problems.find((p) => p.startsWith("escopo irrestrito"));
    if (unrestricted) {
      findings.push({ file: label, line: null, severity: rfcSev, title: "RFC com files_allowed irrestrito",
        rationale: `${unrestricted}.`, source: "stage_a" });
    }
    if (rfc.filesAllowed.length === 0) {
      findings.push({ file: label, line: null, severity: rfcSev, title: "RFC sem `## Impacto` / files_allowed",
        rationale: "Liste os globs de arquivos que a fábrica PODE tocar; é o escopo do gate determinístico (a fábrica não expande sozinha).", source: "stage_a" });
    }
    const testsOnly = rfc.problems.find((p) => p.startsWith("files_allowed só com testes/docs"));
    if (testsOnly) {
      findings.push({ file: label, line: null, severity: rfcSev, title: "RFC com files_allowed só de testes/docs",
        rationale: `${testsOnly}.`, source: "stage_a" });
    }
    if (!rfc.hasNonGoals) {
      findings.push({ file: label, line: null, severity: "warning", title: "RFC sem Não-objetivos",
        rationale: "Declare o que está fora de escopo — evita que a fábrica 'complete' além do pedido.", source: "stage_a" });
    }
    if (!rfc.compat) {
      findings.push({ file: label, line: null, severity: "warning", title: "RFC sem `## Compatibilidade` (SemVer)",
        rationale: "Classifique PATCH/MINOR/MAJOR e `breaking`; define o fechamento do CHANGELOG no aceite.", source: "stage_a" });
    }
  }

  // Conteúdo primário vazio/trivial
  const totalText = files.map((f) => f.content).join("\n");
  if (totalText.replace(/\s+/g, "").length < 200) {
    findings.push({ file: "", line: null, severity: "blocker", title: "Spec sem conteúdo substantivo",
      rationale: "Menos de 200 caracteres úteis no agregado — nada para a fábrica construir.", source: "stage_a" });
  }
  return findings.map(annotateStageA);
}

// ── Estágio B — adversarial LLM (via agents; SEM ferramentas) ────────────────

async function httpJson(url: string, method: string, body: unknown, timeoutMs: number): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* mantém {} */ }
  return { status: res.status, data };
}

const STAGE_B_SEVERITIES = new Set(["blocker", "warning", "info"]);

/** Valida/normaliza o JSON do LLM (schema fechado — nada além disso entra). */
export function parseStageBFindings(raw: unknown): ValidationFinding[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: ValidationFinding[] = [];
  for (const item of arr.slice(0, 50)) {
    const o = (item ?? {}) as Record<string, unknown>;
    const sev = String(o.severity ?? "info").toLowerCase();
    out.push({
      file: String(o.file ?? "").slice(0, 300),
      line: Number.isFinite(Number(o.line)) ? Math.max(1, Math.trunc(Number(o.line))) : null,
      severity: (STAGE_B_SEVERITIES.has(sev) ? sev : "info") as ValidationFinding["severity"],
      title: String(o.title ?? "").slice(0, 200) || "(sem título)",
      rationale: String(o.rationale ?? "").slice(0, 1200),
      source: "stage_b",
      // RFC-0005: identidade estável vem de category (taxonomia fechada) + anchor (FR/seção/entidade).
      category: normalizeCategory(o.category),
      anchor: String(o.anchor ?? "").trim().slice(0, 160) || null,
    });
  }
  return out;
}

async function runStageB(projectId: string, specText: string): Promise<{ findings: ValidationFinding[]; error?: string }> {
  const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim();
  if (!agentsUrl) return { findings: [], error: "agents indisponível (API_AGENTS_URL ausente)" };
  const base = agentsUrl.replace(/\/$/, "");
  const start = await httpJson(`${base}/invoke/spec_validator/async`, "POST", {
    spec_text: specText.slice(0, 200_000),
    originProjectId: projectId, // débito de usage no orçamento do tenant (F6)
  }, 30_000).catch((e) => ({ status: 0, data: { error: String(e) } as Record<string, unknown> }));
  const jobId = String(start.data.jobId ?? "");
  if (start.status !== 200 || !jobId) {
    return { findings: [], error: `agents start falhou (${start.status}): ${String(start.data.error ?? "")}`.slice(0, 300) };
  }
  const deadline = Date.now() + VALIDATION_DEADLINE_MIN * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8_000));
    const poll = await httpJson(`${base}/invoke/spec_validator/status/${jobId}`, "GET", undefined, 30_000)
      .catch(() => ({ status: 0, data: {} as Record<string, unknown> }));
    // 404 = agents reiniciou e perdeu o job em memória → interrupted (NUNCA insistir 11min).
    if (poll.status === 404) return { findings: [], error: "agents reiniciou durante a validação (job perdido)" };
    if (poll.status !== 200) continue;
    const st = String(poll.data.status ?? "");
    if (st === "done") {
      const result = (poll.data.result ?? {}) as Record<string, unknown>;
      return { findings: parseStageBFindings(result.findings) };
    }
    if (st === "error") return { findings: [], error: String(poll.data.error ?? "spec_validator error").slice(0, 300) };
  }
  return { findings: [], error: "timeout do estágio adversarial" };
}

// ── ciclo de vida da run ──────────────────────────────────────────────────────

export type StartValidationResult =
  | { ok: true; runId: string; reused: boolean }
  | { ok: false; code: string; message: string; status: number };

export async function startValidation(pool: Pool, opts: {
  projectId: string;
  tenantId: string | null;
  requestedBy: string;
}): Promise<StartValidationResult> {
  const { projectId, tenantId, requestedBy } = opts;

  // custo: orçamento do tenant ANTES de enfileirar (fail-open interno do checkTenantBudget)
  if (tenantId) {
    const budget = await checkTenantBudget(pool, tenantId);
    if (!budget.ok) {
      return { ok: false, code: "TENANT_LLM_BUDGET_EXCEEDED", message: budgetExceededMessage(budget.spentUsd, budget.budgetUsd), status: 402 };
    }
  }
  // rate-limit 4/h por spec (in-memory — suficiente p/ freio de custo)
  const rl = checkRateLimit(`spec-validate:${projectId}`, { windowMs: 60 * 60_000, max: 4 });
  if (!rl.ok) {
    return { ok: false, code: "RATE_LIMITED", message: "Limite de 4 validações/hora por spec. Aguarde para revalidar.", status: 429 };
  }

  const current = await computeCurrentSpecHash(pool, projectId);
  if (!current) {
    return { ok: false, code: "SPEC_FILES_MISSING", message: "Spec sem arquivos legíveis para validar.", status: 422 };
  }

  // dedupe por hash: conteúdo idêntico já validado → devolve a run existente (custo zero)
  const dup = await pool.query(
    "SELECT id FROM spec_validation_runs WHERE project_id = $1 AND spec_hash = $2 AND status = 'passed' LIMIT 1",
    [projectId, current.specHash],
  );
  if (dup.rows[0]) return { ok: true, runId: dup.rows[0].id as string, reused: true };

  const catalogVersion = loadArchetypeCatalog().catalogVersion;
  let runId: string;
  try {
    const ins = await pool.query(
      `INSERT INTO spec_validation_runs (project_id, spec_hash, catalog_version, status, requested_by, started_at, deadline_at)
       VALUES ($1, $2, $3, 'running', $4, now(), now() + ($5 || ' minutes')::interval)
       RETURNING id`,
      // requested_by e UUID: sub nao-UUID (token estatico admin "runner-service",
      // ou o marcador "auto-validate" do tick) vira NULL — mesma licao do acked_by da Onda 3
      // (22P02 estouraria o INSERT e o .catch do tick engoliria = run nunca criada).
      [projectId, current.specHash, catalogVersion, UUID_RE.test(requestedBy) ? requestedBy : null, String(VALIDATION_DEADLINE_MIN)],
    );
    runId = ins.rows[0].id as string;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      // one-flight: já há run pendente/rodando p/ este alvo
      const running = await pool.query(
        "SELECT id FROM spec_validation_runs WHERE project_id = $1 AND status IN ('pending','running') LIMIT 1",
        [projectId],
      );
      if (running.rows[0]) return { ok: true, runId: running.rows[0].id as string, reused: true };
    }
    throw e;
  }

  // processamento assíncrono — o estado vive na TABELA (sobrevive a quem espera; o reaper
  // pega o caso de restart no meio)
  setImmediate(() => {
    processValidationRun(pool, runId, projectId, current.specHash).catch((e) =>
      console.error(`[spec-validation] run ${runId} falhou:`, e));
  });
  return { ok: true, runId, reused: false };
}

async function processValidationRun(pool: Pool, runId: string, projectId: string, startHash: string): Promise<void> {
  const current = await computeCurrentSpecHash(pool, projectId);
  const files = current?.files ?? [];
  const extraRow = (await pool.query("SELECT extra FROM projects WHERE id = $1", [projectId])).rows[0] as { extra?: Record<string, unknown> | null } | undefined;
  const isEvolution = extraRow?.extra?.evolution === true;
  const findings: ValidationFinding[] = runStageA(files, { evolution: isEvolution });

  // Estágio B só quando o A não achou blocker estrutural (economiza LLM em spec quebrada)
  const hasStageABlocker = findings.some((f) => f.severity === "blocker");
  let stageBError: string | undefined;
  if (!hasStageABlocker && files.length > 0) {
    const specText = files
      // R4 PR3: connect.yaml é machine-readable (validado por schema, não por LLM) — fora do estágio B.
      .filter((f) => !/\.ya?ml$/i.test(f.filename))
      .map((f) => `===== ${f.rel_dir ? f.rel_dir + "/" : ""}${f.filename} =====\n${f.content}`)
      .join("\n\n");
    const b = await runStageB(projectId, specText);
    findings.push(...b.findings); // UNIÃO — o LLM só ADICIONA, nunca remove o estágio A
    stageBError = b.error;
  }

  // TOCTOU: recomputa o hash ao FINAL — editou durante a validação → superseded (não é erro)
  const after = await computeCurrentSpecHash(pool, projectId);
  const finalStatus = stageBError
    ? "error"
    : after?.specHash !== startHash
      ? "superseded"
      : findings.some((f) => f.severity === "blocker") ? "failed" : "passed";

  await pool.query(
    `UPDATE spec_validation_runs
        SET status = $1, findings = $2::jsonb, finished_at = now()
      WHERE id = $3 AND status = 'running'`,
    [finalStatus, JSON.stringify(findings), runId],
  );
  // RFC-0005 (G2): supressão é PÓS-PROCESSAMENTO — findings que reincidem sobre um Refutado vivo
  // contam reincidência (a leitura já os mostra como Refutados; a run continua snapshot imutável).
  if (finalStatus === "passed" || finalStatus === "failed") {
    await registerRecurrences(pool, projectId, findings).catch((e) =>
      console.warn(`[spec-validation] run ${runId}: registerRecurrences falhou (não crítico): ${e instanceof Error ? e.message : String(e)}`));
  }
  if (stageBError) {
    console.warn(`[spec-validation] run ${runId}: estágio B falhou (${stageBError}) — run marcada 'error'.`);
  }
}

// ── reaper (boot) + deadline (watchdog) ──────────────────────────────────────

export async function reapOrphanValidationRuns(pool: Pool): Promise<void> {
  try {
    const r = await pool.query(
      `UPDATE spec_validation_runs SET status = 'interrupted', finished_at = now()
        WHERE status IN ('pending','running') AND started_at < now() - interval '15 minutes'
        RETURNING id`,
    );
    if (r.rowCount) console.log(`[spec-validation] reaper: ${r.rowCount} run(s) órfã(s) → interrupted.`);
  } catch (e) {
    console.warn("[spec-validation] reaper falhou (best-effort):", e instanceof Error ? e.message : String(e));
  }
}

/**
 * RFC-0004 D1 (Validar AUTOMÁTICO) — debounce POR DADO, nunca por timer:
 * `spec_dirty_at` é marcado em toda edição (PATCH/PUT/POST/DELETE de spec); este tick
 * (chamado pelo ciclo do watchdog) dispara a validação quando a spec ESTABILIZOU
 * (>N min sem edição), só em status pré-fábrica/editável. 10 saves = 1 job; idempotente
 * a restart (o estado é a coluna, não um setTimeout). `startValidation` já aplica
 * budget do tenant, rate-limit 4/h, dedupe por hash e one-flight — o tick herda tudo.
 * Env-gated: SPEC_VALIDATION_AUTO=on liga (default off — decisão D1: manual primeiro).
 * Após disparar, spec_dirty_at é LIMPO (senão o tick revalidaria a cada ciclo).
 */
export function specValidationAutoEnabled(): boolean {
  return (process.env.SPEC_VALIDATION_AUTO ?? "off").trim().toLowerCase() === "on";
}

const AUTO_VALIDATE_QUIET_MIN = parseInt(process.env.SPEC_VALIDATION_AUTO_QUIET_MIN ?? "2", 10);

export async function autoValidateDirtySpecs(pool: Pool): Promise<void> {
  if (!specValidationAutoEnabled()) return;
  const rows = (await pool.query(
    `SELECT id, tenant_id FROM projects
      WHERE spec_dirty_at IS NOT NULL
        AND spec_dirty_at < now() - ($1 || ' minutes')::interval
        AND status IN ('draft','spec_submitted','pending_conversion','stopped','failed','spec_validation_failed')
      ORDER BY spec_dirty_at ASC
      LIMIT 5`,
    [String(AUTO_VALIDATE_QUIET_MIN)],
  )).rows as Array<{ id: string; tenant_id: string | null }>;
  for (const p of rows) {
    // Limpa ANTES de disparar: falha de disparo não pode virar loop de retry por ciclo —
    // a próxima EDIÇÃO re-marca dirty (semântica correta: valida-se o que mudou).
    await pool.query("UPDATE projects SET spec_dirty_at = NULL WHERE id = $1", [p.id]);
    const r = await startValidation(pool, { projectId: p.id, tenantId: p.tenant_id, requestedBy: "auto-validate" })
      .catch((e) => ({ ok: false as const, code: "ERROR", message: String(e), status: 500 }));
    console.log(`[spec-validation][auto] ${p.id.slice(0, 8)}: ${r.ok ? `run ${"runId" in r ? r.runId.slice(0, 8) : ""}${"reused" in r && r.reused ? " (dedupe)" : ""}` : `${r.code}`}`);
  }
}

export async function expireOverdueValidationRuns(pool: Pool): Promise<void> {
  const r = await pool.query(
    `UPDATE spec_validation_runs SET status = 'error', finished_at = now()
      WHERE status IN ('pending','running') AND deadline_at IS NOT NULL AND deadline_at < now()
      RETURNING id`,
  );
  if (r.rowCount) console.log(`[spec-validation] deadline: ${r.rowCount} run(s) expiradas → error.`);
}

// ── gate (choke-point) ───────────────────────────────────────────────────────

export type SpecGateResult = { ok: true } | { ok: false; code: string; message: string };

/**
 * Gate de validação no CHOKE-POINT (dispatchProjectRun + /run inline do pipeline.ts).
 * OFF por env (default) → sempre passa (byte-idêntico ao legado).
 * ON → exige run 'passed' para o HASH ATUAL, com regra de ack:
 *   • findings só info → passa;
 *   • com warnings → exige acked (qualquer papel);
 *   • run 'failed' (blockers) → só passa se acked por zentriz_admin (force, auditado).
 */
export async function checkSpecValidationGate(
  db: { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  projectId: string,
): Promise<SpecGateResult> {
  if (!specValidationGateEnabled()) return { ok: true };
  const current = await computeCurrentSpecHash(db, projectId);
  if (!current) return { ok: false, code: "SPEC_FILES_MISSING", message: "Spec sem arquivos legíveis — valide antes de promover." };

  const run = (await db.query(
    `SELECT id, status, findings, acked_by, acked_role FROM spec_validation_runs
      WHERE project_id = $1 AND spec_hash = $2 AND status IN ('passed','failed')
      ORDER BY created_at DESC LIMIT 1`,
    [projectId, current.specHash],
  )).rows[0];

  if (!run) {
    // hash atual nunca validado (inclui o caso "verde ficou stale após edição")
    return { ok: false, code: "SPEC_NOT_VALIDATED",
      message: "Spec não validada (ou editada após a última validação). Rode Validar e tente de novo." };
  }
  const rawFindings = (run.findings ?? []) as ValidationFinding[];
  // RFC-0005: só findings ATIVOS contam — ignorados/refutados (triagem viva, auditada) não bloqueiam.
  const enriched = await enrichRunFindings(db, projectId, rawFindings).catch(() => null);
  const findings = enriched ? enriched.filter((f) => !f.triage) : rawFindings;
  // Sinal de ack = acked_role/acked_at — acked_by pode ser NULL legitimamente (token
  // estático admin tem sub não-UUID; a identidade crua vive no snapshot da auditoria).
  const acked = !!run.acked_role;
  const forcedByAdmin = acked && run.acked_role === "zentriz_admin";

  if (run.status === "failed") {
    if (forcedByAdmin) return { ok: true };
    const activeBlockers = findings.filter((f) => f.severity === "blocker").length;
    if (enriched && activeBlockers === 0) {
      // todos os blockers foram triados (ignorados/refutados por tenant_admin, auditado) → segue
    } else {
      return { ok: false, code: "SPEC_VALIDATION_BLOCKED",
        message: `Validação reprovou com ${activeBlockers || "findings"} blocker(s) ativo(s). Corrija a spec, triagem os blockers (tenant_admin, auditado) ou um zentriz_admin pode forçar.` };
    }
  }
  const hasWarnings = findings.some((f) => f.severity === "warning");
  if (hasWarnings && !acked) {
    return { ok: false, code: "SPEC_WARNINGS_UNACKED",
      message: "Validação passou com avisos — reconheça os findings (ack) antes de promover." };
  }
  return { ok: true };
}
