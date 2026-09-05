/**
 * specSplit.ts — F2/PR-3: divide a spec monolítica de um projeto em vários arquivos (migration 093).
 *
 * PROBLEMA (medido em prod 2026-09-05): a spec do NVX LastMile tem 98.045 chars num único arquivo.
 * Toda revisão do CTO reemitia o documento inteiro e batia no teto de 64.000 tokens de SAÍDA do
 * Opus 5 — `stop_reason=max_tokens` voltava como `status: OK` e o modo autônomo aplicava a spec
 * mutilada (14 → 7 seções). O F1 (formato `edits`) encurta a saída; o F2 ataca o outro lado: com a
 * spec repartida por tema, cada rodada de melhoria toca UM arquivo e cabe com folga.
 *
 * LEI (Jean, 2026-09-05): estrutura, nomes e divisão de arquivos são decisão de LLM, nunca de
 * automação fixa. Quem decide é o `spec_file_splitter` no serviço agents (PASSO 1 arquiteto +
 * PASSO 2 um redator por arquivo). Aqui do lado TS só existe TRANSPORTE e as guardas de escrita:
 *
 *   • PROPÕE, nunca grava sozinho (ADR-018, igual a `product_proposals`): o resultado fica em
 *     `project_spec_splits` até o humano aplicar ou descartar na Bancada.
 *   • O job nasce PERSISTIDO (lição do `spec_chat_jobs` efêmero, migration 089): sair da tela ou
 *     um deploy no meio não jogam fora ~10 chamadas de LLM.
 *   • `source_sha` congela o arquivo primário no instante da proposta → o apply recusa (409) se a
 *     spec mudou desde então, em vez de sobrescrever trabalho novo com um plano velho.
 *   • O apply guarda SNAPSHOT (G2) do primário antes de sobrescrevê-lo. Sem snapshot, não escreve.
 *   • O ÍNDICE vai NO arquivo primário existente (preserva `is_primary` e tudo que lê a spec por
 *     ele: runner, certificado, `readPrimarySpec`); os N arquivos temáticos nascem ao lado.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { Pool } from "pg";
import { httpPost, httpGet } from "../routes/specs.js";
import { resolveWorkbenchLlm, agentsLlmFields } from "./tenantLlmConfig.js";
import { sha256Hex, SPEC_TREE_MAX_FILES, SPEC_TREE_MAX_FILE_BYTES } from "../lib/specTreeHash.js";
import { snapshotSpecFile } from "./specSnapshots.js";
import { parseSpecPath } from "../routes/specFiles.js";

type Db = Pick<Pool, "query">;

/** Deadline no DB (backstop de restart). O TTL do `_async_jobs` dos agents é 45 min. */
export const SPLIT_DEADLINE_MIN = 40;
/** Teto do poll em processo. Menor que o deadline: quem termina a linha é o timer OU o watchdog. */
const SPLIT_MAX_MS = 20 * 60 * 1000;

/**
 * Flag de ATIVAÇÃO — nasce OFF (`SPEC_SPLIT=on` liga). Dividir a spec é a operação mais
 * consequente da Bancada (reescreve o arquivo primário de um projeto), então vai a prod desligada e
 * só é ligada depois da prova ao vivo. Mesma disciplina do F1 (`SPEC_CTO_EDIT_FORMAT`).
 */
export function specSplitEnabled(): boolean {
  return (process.env.SPEC_SPLIT ?? "off").trim().toLowerCase() === "on";
}

export type SpecSplitStatus =
  | "pending" | "running" | "done" | "error" | "interrupted" | "applied" | "discarded";

export interface SpecSplitPlanFile {
  name: string;
  title?: string;
  purpose?: string;
  sections?: string[];
}
export interface SpecSplitPayload {
  plan: { rationale?: string; indexPurpose?: string; files: SpecSplitPlanFile[] };
  index: string;
  files: Record<string, string>;
  coverage: Array<{ section: string; chars?: number; targets: string[] }>;
}

export interface SpecSplitProposal {
  id: string;
  projectId: string;
  status: SpecSplitStatus;
  sourcePath: string | null;
  sourceSha: string | null;
  sourceChars: number;
  producedChars: number;
  warnings: string[];
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  modelUsed: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Só vem quando pedido explicitamente (o payload chega a centenas de kB). */
  payload: SpecSplitPayload | null;
}

const SCALAR_COLS =
  "id, project_id, status, source_path, source_sha, source_chars, produced_chars, warnings, error, " +
  "input_tokens, output_tokens, model_used, applied_at, created_at, updated_at";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v ?? new Date().toISOString());
}

function rowToProposal(r: Record<string, unknown>, payload: SpecSplitPayload | null = null): SpecSplitProposal {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    status: (r.status as SpecSplitStatus) ?? "pending",
    sourcePath: (r.source_path as string | null) ?? null,
    sourceSha: (r.source_sha as string | null) ?? null,
    sourceChars: Number(r.source_chars ?? 0),
    producedChars: Number(r.produced_chars ?? 0),
    warnings: Array.isArray(r.warnings) ? (r.warnings as string[]) : [],
    error: (r.error as string | null) ?? null,
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    modelUsed: (r.model_used as string | null) ?? null,
    appliedAt: r.applied_at ? iso(r.applied_at) : null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    payload,
  };
}

export function isTerminalSplitStatus(s: SpecSplitStatus): boolean {
  return s === "done" || s === "error" || s === "interrupted" || s === "applied" || s === "discarded";
}

/** Uma proposta ainda ESPERANDO decisão humana (bloqueia uma segunda divisão). */
export function isOpenSplitStatus(s: SpecSplitStatus): boolean {
  return s === "pending" || s === "running" || s === "done";
}

// ── leitura do arquivo primário (mesma ordem de `readPrimarySpec` do specAutonomy) ────────────

export interface PrimarySpecFile { filePath: string; relDir: string; filename: string; content: string; sha: string }

export async function readPrimarySpecFile(db: Db, projectId: string): Promise<PrimarySpecFile | null> {
  const row = (await db.query(
    "SELECT file_path, rel_dir, filename FROM project_spec_files WHERE project_id = $1 ORDER BY is_primary DESC, created_at DESC LIMIT 1",
    [projectId],
  )).rows[0] as { file_path?: string; rel_dir?: string; filename?: string } | undefined;
  if (!row?.file_path) return null;
  const buf = await readFile(row.file_path).catch(() => null);
  if (buf === null) return null;
  return {
    filePath: String(row.file_path),
    relDir: String(row.rel_dir ?? ""),
    filename: String(row.filename ?? path.basename(String(row.file_path))),
    content: buf.toString("utf-8"),
    sha: sha256Hex(buf),
  };
}

// ── consultas ────────────────────────────────────────────────────────────────────────────────

export async function getSplitProposal(
  db: Db, id: string, opts: { withPayload?: boolean } = {},
): Promise<SpecSplitProposal | null> {
  const cols = opts.withPayload ? `${SCALAR_COLS}, payload` : SCALAR_COLS;
  const r = (await db.query(`SELECT ${cols} FROM project_spec_splits WHERE id = $1`, [id]))
    .rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return rowToProposal(r, opts.withPayload ? ((r.payload as SpecSplitPayload | null) ?? null) : null);
}

export async function getLatestSplitProposal(
  db: Db, projectId: string, opts: { withPayload?: boolean } = {},
): Promise<SpecSplitProposal | null> {
  const cols = opts.withPayload ? `${SCALAR_COLS}, payload` : SCALAR_COLS;
  const r = (await db.query(
    `SELECT ${cols} FROM project_spec_splits WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  )).rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return rowToProposal(r, opts.withPayload ? ((r.payload as SpecSplitPayload | null) ?? null) : null);
}

// ── transições (todas guardadas por status: um poll atrasado nunca ressuscita linha terminal) ──

async function failSplit(db: Db, id: string, error: string): Promise<void> {
  await db.query(
    "UPDATE project_spec_splits SET status='error', error=$2, deadline_at=NULL, updated_at=now() WHERE id=$1 AND status IN ('pending','running')",
    [id, String(error).slice(0, 500)],
  ).catch((e) => console.error(`[SpecSplit] failSplit ${id}: ${msg(e)}`));
}

async function interruptSplit(db: Db, id: string, error: string): Promise<void> {
  await db.query(
    "UPDATE project_spec_splits SET status='interrupted', error=$2, deadline_at=NULL, updated_at=now() WHERE id=$1 AND status IN ('pending','running')",
    [id, String(error).slice(0, 500)],
  ).catch((e) => console.error(`[SpecSplit] interruptSplit ${id}: ${msg(e)}`));
}

interface AgentsSplitResult {
  plan?: SpecSplitPayload["plan"];
  index?: string;
  files?: Record<string, string>;
  coverage?: SpecSplitPayload["coverage"];
  warnings?: string[];
  sourceChars?: number;
  producedChars?: number;
  usage?: { input_tokens?: number; output_tokens?: number; model?: string; calls?: number };
}

/**
 * Fecha a proposta com o resultado dos agentes. Valida o TRANSPORTE (o que a api vai gravar tem de
 * caber nas guardas da árvore de spec) — nunca o mérito do agrupamento, que é decisão do arquiteto.
 */
export async function finishSplit(db: Db, id: string, result: AgentsSplitResult): Promise<void> {
  const files = result.files ?? {};
  const names = Object.keys(files);
  const plan = result.plan;
  if (!plan || !Array.isArray(plan.files) || typeof result.index !== "string" || names.length === 0) {
    await failSplit(db, id, "O divisor não devolveu plano/índice/arquivos utilizáveis.");
    return;
  }
  // As MESMAS guardas de `POST /api/projects/:id/spec-file` — se um nome não passa aqui, o apply
  // falharia no meio e deixaria a árvore pela metade.
  const bad: string[] = [];
  for (const name of names) {
    if (!parseSpecPath(name)) { bad.push(name); continue; }
    if (Buffer.byteLength(files[name] ?? "", "utf-8") > SPEC_TREE_MAX_FILE_BYTES) bad.push(`${name} (>256KB)`);
  }
  if (Buffer.byteLength(result.index, "utf-8") > SPEC_TREE_MAX_FILE_BYTES) bad.push("(índice) (>256KB)");
  if (bad.length) {
    await failSplit(db, id, `Arquivos inaceitáveis para a árvore de spec: ${bad.slice(0, 5).join(", ")}`);
    return;
  }
  const payload: SpecSplitPayload = {
    plan, index: result.index, files, coverage: Array.isArray(result.coverage) ? result.coverage : [],
  };
  const payloadJson = JSON.stringify(payload);
  if (Buffer.byteLength(payloadJson, "utf8") > 4 * 1024 * 1024) {
    await failSplit(db, id, "Proposta grande demais (>4MB) para persistir.");
    return;
  }
  const u = result.usage ?? {};
  const inTok = Math.max(0, Math.trunc(Number(u.input_tokens ?? 0)) || 0);
  const outTok = Math.max(0, Math.trunc(Number(u.output_tokens ?? 0)) || 0);
  const model = typeof u.model === "string" && u.model.trim() ? u.model.trim().slice(0, 200) : null;
  const r = await db.query(
    `UPDATE project_spec_splits
        SET status='done', payload=$2::jsonb,
            warnings = COALESCE(warnings, '[]'::jsonb) || $3::jsonb,
            produced_chars=$4, input_tokens=$5, output_tokens=$6,
            model_used=COALESCE($7, model_used), error=NULL, deadline_at=NULL, updated_at=now()
      WHERE id=$1 AND status='running'`,
    [id, payloadJson, JSON.stringify(result.warnings ?? []),
      Math.max(0, Math.trunc(Number(result.producedChars ?? 0)) || 0), inTok, outTok, model],
  );
  if (r.rowCount) {
    console.log(`[SpecSplit] ✓ ${id} DONE — ${names.length} arquivo(s) + índice, ${outTok} tokens de saída`);
  }
}

// ── início: cria a linha e dispara os agentes ────────────────────────────────────────────────

export interface StartSplitOpts {
  projectId: string;
  tenantId: string | null;
  ownerUserId: string;
  /** Modelo escolhido pelo humano no diálogo (precede o modelo do tenant). */
  modelId?: string | null;
}
export type StartSplitResult =
  | { ok: true; proposal: SpecSplitProposal }
  | { ok: false; status: number; code: string; message: string };

export async function startSplitProposal(db: Db, opts: StartSplitOpts): Promise<StartSplitResult> {
  const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim();
  if (!agentsUrl) {
    return { ok: false, status: 503, code: "AGENTS_UNAVAILABLE", message: "Serviço de agentes não configurado." };
  }
  const existing = await getLatestSplitProposal(db, opts.projectId);
  if (existing && isOpenSplitStatus(existing.status)) {
    return {
      ok: false, status: 409, code: "SPLIT_IN_PROGRESS",
      message: existing.status === "done"
        ? "Já existe uma proposta de divisão aguardando sua decisão. Aplique ou descarte antes de gerar outra."
        : "Uma divisão desta spec já está em andamento.",
    };
  }
  const primary = await readPrimarySpecFile(db, opts.projectId);
  if (!primary) {
    return { ok: false, status: 409, code: "NO_SPEC", message: "Este projeto não tem arquivo de spec legível." };
  }
  const count = (await db.query(
    "SELECT count(*)::int AS n FROM project_spec_files WHERE project_id=$1", [opts.projectId],
  )).rows[0] as { n: number };
  if (count.n >= SPEC_TREE_MAX_FILES) {
    return { ok: false, status: 413, code: "TOO_MANY_FILES", message: `Teto de ${SPEC_TREE_MAX_FILES} arquivos por spec.` };
  }

  const id = randomUUID();
  try {
    await db.query(
      `INSERT INTO project_spec_splits
         (id, project_id, tenant_id, owner_user_id, status, source_path, source_sha, source_chars, deadline_at)
       VALUES ($1,$2,$3,$4,'pending',$5,$6,$7, now() + ($8 || ' minutes')::interval)`,
      [id, opts.projectId, opts.tenantId, opts.ownerUserId, primary.filePath, primary.sha,
        primary.content.length, String(SPLIT_DEADLINE_MIN)],
    );
  } catch (e) {
    // Índice único parcial: outra aba disparou a divisão no mesmo instante.
    if ((e as { code?: string }).code === "23505") {
      return { ok: false, status: 409, code: "SPLIT_IN_PROGRESS", message: "Uma divisão desta spec já está em andamento." };
    }
    throw e;
  }
  runSplitJob(db, id, primary.content, agentsUrl, opts);
  const created = await getSplitProposal(db, id);
  return { ok: true, proposal: created ?? rowToProposal({ id, project_id: opts.projectId, status: "pending" }) };
}

/**
 * Roda a divisão em background: dispara `/invoke/spec_split/async` e faz poll até terminar.
 * Não segura a conexão HTTP do cliente (a Bancada faz poll da linha).
 */
export function runSplitJob(
  db: Db, id: string, specMd: string, agentsUrl: string, opts: StartSplitOpts,
): void {
  const base = agentsUrl.replace(/\/$/, "");
  const startedAt = Date.now();

  void db.query(
    "UPDATE project_spec_splits SET status='running', updated_at=now() WHERE id=$1 AND status='pending'", [id],
  ).catch((e) => console.error(`[SpecSplit] set running ${id}: ${msg(e)}`));

  void (async () => {
    const meta = (await db.query(
      "SELECT p.name, p.type FROM projects p WHERE p.id = $1", [opts.projectId],
    ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }))).rows[0] as
      { name?: string; type?: string } | undefined;
    const llm = await resolveWorkbenchLlm({ projectId: opts.projectId, tenantId: opts.tenantId })
      .catch(() => null);
    const body = JSON.stringify({
      spec_md: specMd,
      ...(llm ? agentsLlmFields(llm) : {}),
      ...(opts.modelId ? { model_id: opts.modelId } : {}),
      originProjectId: opts.projectId,
      project_name: meta?.name ?? "",
      project_type: meta?.type ?? "",
    });
    const startText = await httpPost(`${base}/invoke/spec_split/async`, body, 30_000);
    const agentsJobId = (JSON.parse(startText) as { jobId?: string }).jobId;
    if (!agentsJobId) throw new Error("agents /invoke/spec_split/async não retornou jobId");
    await db.query(
      "UPDATE project_spec_splits SET agents_job_id=$2, updated_at=now() WHERE id=$1 AND status='running'",
      [id, agentsJobId],
    ).catch(() => {});
    console.log(`[SpecSplit] ${id} agents_job=${agentsJobId} started (${specMd.length} chars)`);

    const timer = setInterval(() => {
      void (async () => {
        if (Date.now() - startedAt > SPLIT_MAX_MS) {
          clearInterval(timer);
          await failSplit(db, id, "Timeout: a divisão passou de 20 minutos.");
          return;
        }
        // HEARTBEAT: marca que ALGUÉM está pollando esta linha — o coletor server-side só adota
        // linhas sem heartbeat recente (órfãs de restart/deploy).
        void db.query(
          "UPDATE project_spec_splits SET updated_at=now() WHERE id=$1 AND status='running'", [id],
        ).catch(() => {});
        let pollText: string;
        try {
          pollText = await httpGet(`${base}/invoke/spec_split/status/${agentsJobId}`, 60_000);
        } catch (pollErr) {
          const m = msg(pollErr);
          if (/\b404\b/.test(m)) {
            clearInterval(timer);
            await interruptSplit(db, id, "Serviço de agentes perdeu o job (reinício). Gere a divisão de novo.");
          } else {
            console.warn(`[SpecSplit] poll ${id}: ${m}`);
          }
          return;
        }
        const poll = JSON.parse(pollText) as { status: string; result?: AgentsSplitResult; error?: string };
        if (poll.status === "done" && poll.result) {
          clearInterval(timer);
          await finishSplit(db, id, poll.result);
        } else if (poll.status === "error") {
          clearInterval(timer);
          await failSplit(db, id, poll.error ?? "O divisor de spec falhou.");
        }
      })();
    }, 8_000);
  })().catch(async (err) => {
    await failSplit(db, id, msg(err).slice(0, 300));
  });
}

// ── APLICAR: a única escrita, e só depois do humano aprovar ──────────────────────────────────

export type ApplySplitResult =
  | { ok: true; created: string[]; indexPath: string; snapshotSaved: true }
  | { ok: false; status: number; code: string; message: string };

/**
 * Materializa a proposta: o ÍNDICE sobrescreve o arquivo primário (preserva `is_primary` e todos os
 * leitores a jusante) e cada arquivo do plano nasce ao lado.
 *
 * Ordem deliberada: (1) revalida o sha do primário; (2) SNAPSHOT do primário — sem ele nada é
 * escrito; (3) cria os arquivos novos; (4) só então sobrescreve o primário com o índice. Se algo
 * falhar no passo 3, a spec original ainda está intacta no primário.
 */
export async function applySplitProposal(
  db: Db, id: string, appliedBy: string | null,
): Promise<ApplySplitResult> {
  const proposal = await getSplitProposal(db, id, { withPayload: true });
  if (!proposal) return { ok: false, status: 404, code: "NOT_FOUND", message: "Proposta não encontrada." };
  if (proposal.status !== "done" || !proposal.payload) {
    return {
      ok: false, status: 409, code: "NOT_APPLICABLE",
      message: `Proposta em '${proposal.status}' não pode ser aplicada.`,
    };
  }
  const primary = await readPrimarySpecFile(db, proposal.projectId);
  if (!primary) return { ok: false, status: 409, code: "NO_SPEC", message: "Arquivo de spec ausente." };
  if (primary.filePath !== proposal.sourcePath || primary.sha !== proposal.sourceSha) {
    return {
      ok: false, status: 409, code: "SPEC_CHANGED",
      message: "A spec mudou desde que esta divisão foi gerada. Descarte a proposta e gere outra.",
    };
  }
  const { index, files } = proposal.payload;
  const names = Object.keys(files);

  const count = (await db.query(
    "SELECT count(*)::int AS n FROM project_spec_files WHERE project_id=$1", [proposal.projectId],
  )).rows[0] as { n: number };
  if (count.n + names.length > SPEC_TREE_MAX_FILES) {
    return {
      ok: false, status: 413, code: "TOO_MANY_FILES",
      message: `A divisão passaria do teto de ${SPEC_TREE_MAX_FILES} arquivos por spec.`,
    };
  }

  // (2) Rede de segurança G2 — OBRIGATÓRIA: a spec inteira está a um writeFile de ser substituída.
  const saved = await snapshotSpecFile(db as Pool, {
    projectId: proposal.projectId, filePath: primary.filePath, content: primary.content,
    reason: `spec-split:${id.slice(0, 8)}`, createdBy: appliedBy,
  });
  if (!saved) {
    return {
      ok: false, status: 500, code: "SNAPSHOT_FAILED",
      message: "Não foi possível guardar o snapshot da spec atual — divisão abortada para não perder conteúdo.",
    };
  }

  // (3) arquivos novos ao lado do primário (mesmo `rel_dir` de base).
  const root = path.dirname(primary.filePath);
  const created: string[] = [];
  for (const name of names) {
    const parsed = parseSpecPath(name);
    if (!parsed) continue; // já filtrado no finishSplit; defensivo
    const relDir = [primary.relDir, parsed.relDir].filter(Boolean).join("/");
    const physical = path.resolve(root, parsed.relDir, parsed.filename);
    const rootAbs = path.resolve(root);
    if (physical !== rootAbs && !physical.startsWith(rootAbs + path.sep)) continue;
    const content = files[name] ?? "";
    const sha = sha256Hex(Buffer.from(content, "utf-8"));
    try {
      await db.query(
        `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256)
         VALUES ($1,$2,$3,'text/markdown',$4,false,$5)`,
        [proposal.projectId, parsed.filename, physical, relDir, sha],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        // Já existe: o conteúdo novo é o que vale (a proposta é a fonte aprovada pelo humano).
        await db.query(
          "UPDATE project_spec_files SET content_sha256=$1, file_path=$2 WHERE project_id=$3 AND rel_dir=$4 AND filename=$5",
          [sha, physical, proposal.projectId, relDir, parsed.filename],
        );
      } else {
        return { ok: false, status: 500, code: "WRITE_FAILED", message: `Falha ao registrar ${name}: ${msg(e)}` };
      }
    }
    await mkdir(path.dirname(physical), { recursive: true });
    await writeFile(physical, content, "utf-8");
    created.push(relDir ? `${relDir}/${parsed.filename}` : parsed.filename);
  }

  // (4) por último o primário vira o índice.
  await writeFile(primary.filePath, index, "utf-8");
  await db.query(
    "UPDATE project_spec_files SET content_sha256=$1 WHERE project_id=$2 AND file_path=$3",
    [sha256Hex(Buffer.from(index, "utf-8")), proposal.projectId, primary.filePath],
  );
  await db.query("UPDATE projects SET spec_dirty_at = now() WHERE id = $1", [proposal.projectId]);
  await db.query(
    "UPDATE project_spec_splits SET status='applied', applied_at=now(), applied_by=$2, updated_at=now() WHERE id=$1 AND status='done'",
    [id, appliedBy],
  );
  console.log(`[SpecSplit] ${id} APPLIED — ${created.length} arquivo(s) + índice em ${primary.filename}`);
  return {
    ok: true, created, snapshotSaved: true,
    indexPath: primary.relDir ? `${primary.relDir}/${primary.filename}` : primary.filename,
  };
}

/** Descarta a proposta (o humano não gostou da estrutura). Idempotente. */
export async function discardSplitProposal(db: Db, id: string): Promise<number> {
  const r = await db.query(
    "UPDATE project_spec_splits SET status='discarded', deadline_at=NULL, updated_at=now() WHERE id=$1 AND status IN ('pending','running','done')",
    [id],
  );
  return r.rowCount ?? 0;
}

// ── coletor server-side + reaper de boot + watchdog ──────────────────────────────────────────

/** Sem heartbeat por este tempo = ninguém está pollando esta linha (restart/deploy/tela fechada). */
const SPLIT_STALE_MS = 90_000;

export type SplitProbe = (agentsJobId: string) =>
  Promise<{ status: string; result?: AgentsSplitResult; error?: string } | "not_found">;

/**
 * Coleta divisões ÓRFÃS (mesma lição do `spec_chat_jobs`, migration 089: um deploy no meio jogava
 * fora ~19 min de LLM). O job vive nos agents mesmo quando a api reinicia — enquanto o TTL de 45 min
 * do `_async_jobs` não expirar, o resultado é recuperável. Só adota linhas sem heartbeat recente,
 * e todas as transições são guardadas por status → nunca briga com o poll em processo.
 */
export async function collectSpecSplitsTick(
  db: Db, probe: SplitProbe,
): Promise<{ scanned: number; collected: number; lost: number }> {
  let collected = 0;
  let lost = 0;
  let rows: Array<{ id: string; agents_job_id: string }> = [];
  try {
    rows = (await db.query(
      `SELECT id, agents_job_id FROM project_spec_splits
        WHERE status='running' AND agents_job_id IS NOT NULL
          AND updated_at < now() - ($1 || ' milliseconds')::interval
        ORDER BY created_at LIMIT 5`,
      [String(SPLIT_STALE_MS)],
    )).rows as Array<{ id: string; agents_job_id: string }>;
  } catch (e) {
    console.warn(`[SpecSplit][collector] varredura falhou: ${msg(e)}`);
    return { scanned: 0, collected: 0, lost: 0 };
  }
  for (const row of rows) {
    try {
      const poll = await probe(row.agents_job_id);
      if (poll === "not_found") {
        await interruptSplit(db, row.id, "O serviço de agentes já descartou o resultado (TTL). Gere a divisão de novo.");
        lost += 1;
      } else if (poll.status === "done" && poll.result) {
        await finishSplit(db, row.id, poll.result);
        collected += 1;
      } else if (poll.status === "error") {
        await failSplit(db, row.id, poll.error ?? "O divisor de spec falhou.");
        collected += 1;
      } else {
        // Ainda rodando e sem ninguém pollando: toca o heartbeat para não varrer a cada tick.
        await db.query(
          "UPDATE project_spec_splits SET updated_at=now() WHERE id=$1 AND status='running'", [row.id],
        ).catch(() => {});
      }
    } catch (e) {
      console.warn(`[SpecSplit][collector] probe ${row.id}: ${msg(e)}`);
    }
  }
  return { scanned: rows.length, collected, lost };
}

/**
 * Reaper de boot. NÃO mata quem já tem `agents_job_id`: esse job segue vivo nos agents (que não
 * reiniciam junto com a api) e o coletor acima o recupera — matá-lo aqui destruiria justamente o
 * trabalho que esta frente existe para salvar. Só encerra o caso irrecuperável: a linha morreu
 * ANTES de despachar.
 */
export async function reapOrphanSplits(db: Db): Promise<number> {
  const r = await db.query(
    "UPDATE project_spec_splits SET status='interrupted', error=COALESCE(error,'Interrompido antes do despacho (reinício da API)'), deadline_at=NULL, updated_at=now() WHERE status IN ('pending','running') AND agents_job_id IS NULL",
  ).catch((e) => { console.error(`[SpecSplit][reaper] ${msg(e)}`); return null; });
  const n = r?.rowCount ?? 0;
  if (n) console.log(`[SpecSplit][reaper] ${n} divisão(ões) sem despacho marcada(s) interrupted`);
  return n;
}

export async function expireOverdueSplits(db: Db): Promise<number> {
  const r = await db.query(
    "UPDATE project_spec_splits SET status='interrupted', error=COALESCE(error,'Deadline excedido'), deadline_at=NULL, updated_at=now() WHERE status IN ('pending','running') AND deadline_at IS NOT NULL AND deadline_at < now()",
  ).catch(() => null);
  // Purga payload de proposta antiga nunca decidida (cada uma pesa ~100 kB de JSONB).
  await db.query(
    "UPDATE project_spec_splits SET payload=NULL, updated_at=now() WHERE payload IS NOT NULL AND status <> 'done' AND created_at < now() - interval '7 days'",
  ).catch((e) => console.error(`[SpecSplit] purge payload: ${msg(e)}`));
  return r?.rowCount ?? 0;
}
