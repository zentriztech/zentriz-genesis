/**
 * evolutionAccept.ts — Evoluir E5: ACEITE de uma evolução (projeto filho `extra.evolution=true`).
 *
 * Princípio: evolução = nova VERSÃO do MESMO serviço. No aceite:
 *  1. CHANGELOG.md: `## [Unreleased]` → `## [x.y.z] - AAAA-MM-DD` (SemVer pela compatibilidade
 *     declarada nos RFCs — `extra.evolution_compat`: major/minor/patch; base = última versão do
 *     CHANGELOG ou 1.0.0 do pai) e cópia para `apps/CHANGELOG.md` (o mesmo arquivo vai ao repo).
 *  2. Push do `apps/` do filho no repo do PRODUTO/SERVIÇO (o da RAIZ da linhagem) em `evolution/vN`
 *     + PR aberto para `dev` (E-D2: merge automático só depois de provada a permissão em prod);
 *     sem repo na linhagem → fallback: fluxo normal (cria repo — identidade já é a da raiz).
 *  3. Supersessão do pai (E-D1): `archived` + `extra.superseded_by` (o filho vira a versão corrente;
 *     `extra.supersedes` no filho). Nunca apaga nada.
 *  4. Deadpool: mesma chave (identidade pela raiz — E1), re-registro apontando o `local_path` novo.
 * Tudo best-effort e registrado em `project_dialogue` — o aceite HTTP nunca falha por isto.
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import type { Pool } from "pg";
import { resolveLineageRoot } from "./lineage.js";
import { projectRootCandidates } from "./connectManifestsDisk.js";
import { sha256Hex } from "../lib/specTreeHash.js";
import { ticketStamp, TICKET_KIND_LABEL } from "./tickets.js";
import { readEvolutionCheckpoint } from "./evolutionState.js";
import { detectForeignLockfiles, JS_LOCKFILES, listChangedFiles, pathsOutsideScope } from "../lib/evolutionScope.js";

type Db = Pick<Pool, "query">;
export type Compat = "patch" | "minor" | "major";

export function bumpSemver(base: string, compat: Compat): string {
  const m = base.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  let [maj, min, pat] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [1, 0, 0];
  if (compat === "major") { maj += 1; min = 0; pat = 0; }
  else if (compat === "minor") { min += 1; pat = 0; }
  else { pat += 1; }
  return `${maj}.${min}.${pat}`;
}

/** Última versão liberada no CHANGELOG (`## [x.y.z] - data`), ignorando Unreleased. */
export function lastReleasedVersion(changelog: string): string | null {
  for (const m of changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)) return m[1];
  return null;
}

/**
 * Fecha a seção Unreleased como versão datada (Keep a Changelog 1.1): mantém um `## [Unreleased]`
 * vazio no topo e move o conteúdo para `## [x.y.z] - AAAA-MM-DD`. Sem Unreleased com conteúdo →
 * cria a versão com um item genérico (nunca aceita sem registro).
 */
export function releaseChangelog(changelog: string | null, version: string, date: string, fallbackItem: string): string {
  const header = `## [${version}] - ${date}`;
  if (!changelog || !changelog.trim()) {
    return `# Changelog\n\nFormato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) · [SemVer](https://semver.org/lang/pt-BR/).\n\n## [Unreleased]\n\n${header}\n\n### Changed\n- ${fallbackItem}\n`;
  }
  const idx = changelog.search(/^## \[Unreleased\]/mi);
  if (idx < 0) {
    const firstVer = changelog.search(/^## \[/m);
    const block = `## [Unreleased]\n\n${header}\n\n### Changed\n- ${fallbackItem}\n\n`;
    return firstVer < 0 ? `${changelog.trimEnd()}\n\n${block}` : changelog.slice(0, firstVer) + block + changelog.slice(firstVer);
  }
  const after = changelog.slice(idx);
  const headerLineEnd = after.indexOf("\n");
  const bodyStart = idx + (headerLineEnd < 0 ? after.length : headerLineEnd + 1);
  const nextVer = changelog.slice(bodyStart).search(/^## \[/m);
  const bodyEnd = nextVer < 0 ? changelog.length : bodyStart + nextVer;
  const body = changelog.slice(bodyStart, bodyEnd).trim();
  const released = body ? `${header}\n\n${body}\n\n` : `${header}\n\n### Changed\n- ${fallbackItem}\n\n`;
  return `${changelog.slice(0, idx)}## [Unreleased]\n\n${released}${changelog.slice(bodyEnd).replace(/^\s+/, "")}`;
}

async function firstExistingDir(cands: string[]): Promise<string | null> {
  for (const c of cands) {
    try { if ((await fsp.stat(c)).isDirectory()) return c; } catch { /* next */ }
  }
  return null;
}

export interface FinalizeResult { version: string; changelogPath: string | null; appsCopy: string | null }

/** Passo 1 — versiona o CHANGELOG do filho (spec-file) e copia para apps/CHANGELOG.md. */
export async function finalizeEvolutionChangelog(db: Db, childId: string, opts: { compat: Compat; title: string; productId: string | null; date?: string; forceVersion?: string }): Promise<FinalizeResult> {
  const row = (await db.query(
    "SELECT file_path FROM project_spec_files WHERE project_id = $1 AND lower(filename) = 'changelog.md' AND coalesce(rel_dir,'') = ''",
    [childId],
  )).rows[0] as { file_path: string } | undefined;
  let existing: string | null = null;
  if (row) { try { existing = await fsp.readFile(row.file_path, "utf-8"); } catch { existing = null; } }
  const base = (existing && lastReleasedVersion(existing)) ?? "1.0.0";
  const version = opts.forceVersion ?? bumpSemver(base, opts.compat);
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const released = releaseChangelog(existing, version, date, `Evolução aceita — ${opts.title}`);
  let changelogPath: string | null = null;
  if (row) {
    await fsp.writeFile(row.file_path, released, "utf-8");
    await db.query("UPDATE project_spec_files SET content_sha256=$1 WHERE project_id=$2 AND lower(filename)='changelog.md' AND coalesce(rel_dir,'')=''", [sha256Hex(Buffer.from(released, "utf-8")), childId]);
    changelogPath = row.file_path;
  } else {
    // Sem CHANGELOG na Bancada (planner não rodou ou humano apagou): cria na raiz da spec.
    const uploadDir = (process.env.UPLOAD_DIR ?? "/shared/uploads").trim();
    const physical = path.resolve(uploadDir, childId, "CHANGELOG.md");
    await fsp.mkdir(path.dirname(physical), { recursive: true });
    await fsp.writeFile(physical, released, "utf-8");
    await db.query(
      `INSERT INTO project_spec_files (project_id, filename, file_path, mime_type, rel_dir, is_primary, content_sha256)
       VALUES ($1, 'CHANGELOG.md', $2, 'text/markdown', '', false, $3) ON CONFLICT DO NOTHING`,
      [childId, physical, sha256Hex(Buffer.from(released, "utf-8"))],
    );
    changelogPath = physical;
  }
  // Cópia para o código (vai no push): apps/CHANGELOG.md do filho.
  let appsCopy: string | null = null;
  const filesRoot = (process.env.PROJECT_FILES_ROOT ?? process.env.HOST_PROJECT_FILES_ROOT ?? "").trim();
  if (filesRoot) {
    const appsDir = await firstExistingDir(projectRootCandidates(filesRoot, childId, opts.productId).map((r) => path.join(r, "apps")));
    if (appsDir) {
      appsCopy = path.join(appsDir, "CHANGELOG.md");
      await fsp.writeFile(appsCopy, released, "utf-8");
    }
  }
  return { version, changelogPath, appsCopy };
}

/** Passo 3 — pai vira `archived` + `superseded_by`; filho registra `supersedes` + versão. */
export async function supersedeParent(db: Db, childId: string, parentId: string | null, version: string): Promise<boolean> {
  const now = new Date().toISOString();
  await db.query(
    "UPDATE projects SET extra = COALESCE(extra,'{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1",
    [childId, JSON.stringify({ supersedes: parentId, evolution_version: version, evolution_accepted_at: now })],
  );
  if (!parentId) return false;
  // Só supersede um pai ACEITO (versão corrente); pai já arquivado/superseded → no-op.
  // E2E 2026-09-04: a versão anterior passava 3 parâmetros e usava só $1/$3 → Postgres rejeitava ("could not
  // determine data type of parameter $2") e o .catch engolia → pai nunca era supersedido. Sem catch silencioso.
  const r = await db.query(
    "UPDATE projects SET status = 'archived', extra = COALESCE(extra,'{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1 AND status = 'accepted' AND coalesce(extra->>'superseded_by','') = '' RETURNING id",
    [parentId, JSON.stringify({ superseded_by: childId, superseded_at: now, superseded_version: version })],
  );
  return (r.rows as unknown[]).length > 0;
}

export function evolutionBranchName(versionNumber: number | null | undefined): string {
  return `evolution/v${Math.max(2, Number(versionNumber ?? 2) || 2)}`;
}

/** Repo GitHub da linhagem: o da RAIZ; senão o do pai. */
export async function findLineageRepo(db: Db, childId: string, parentId: string | null): Promise<{ projectId: string; repo_full_name: string; repo_url: string } | null> {
  const root = await resolveLineageRoot(db as never, childId);
  const cands = [root?.id, parentId].filter((x): x is string => Boolean(x) && x !== childId);
  for (const pid of cands) {
    const r = (await db.query("SELECT repo_full_name, repo_url FROM project_github_repos WHERE project_id = $1", [pid])).rows[0] as { repo_full_name: string; repo_url: string } | undefined;
    if (r?.repo_full_name) return { projectId: pid, repo_full_name: r.repo_full_name, repo_url: r.repo_url };
  }
  return null;
}

export type GateStatus = "passed" | "failed" | "not_run";
export interface GateOutcome { status: GateStatus; detail: string }
export interface FactoryGateOutcomes { scope: GateOutcome; symbols: GateOutcome; qa: GateOutcome; fullTest: GateOutcome; baseline: GateOutcome }

const GATE_LABEL: Record<GateStatus, string> = { passed: "passou", failed: "FALHOU", not_run: "não executado/sem evidência" };

/**
 * D-13 (AR) + N-6 (AU): resultado REAL de cada gate da fábrica, lido do que ficou registrado — nunca presumido.
 *  · escopo (RFC `files_allowed`): (a) `evolution_violations` do checkpoint ("FORA DO ESCOPO") e (b) o diff REAL de `apps/` contra o clone
 *    da linhagem, comparado ao escopo — pega o que o gate do runner não vê (lockfile gerado por build, p.ex. `pnpm-lock.yaml`, PR #5 da 4.5b);
 *    lockfile de outro gerenciador é EXCLUÍDO da publicação (não conta como violação, mas é dito). Sem checkpoint e sem diff ⇒ `not_run`.
 *  · símbolos preservados: "SÍMBOLOS REMOVIDOS" no checkpoint; sem checkpoint ⇒ `not_run`.
 *  · QA: o diálogo do projeto (`qa.review` = o QA rodou; "QA reportou QA_FAIL … não aprovada"/"QA atingiu máximo" = reprovado).
 *  · TSK-FULL-TEST: a task `CANCELLED` é NOT_RUN (D-3/AQ); `DONE` só vale como execução com o registro "TASK-FULL-TEST (Claude Code): aprovada"
 *    no diálogo — o aceite fecha a task como `DONE` mesmo sem ter executado, então o status sozinho não prova nada.
 *  · baseline/P2P: `evolution_baseline` do checkpoint (medida/sem regressão ⇒ passou; regressões ⇒ FALHOU; `error`/`no_tests`/ausente ⇒ não executado,
 *    com o motivo dito — sem baseline não há não-regressão).
 * Falha de leitura de qualquer fonte ⇒ `not_run` com o motivo. O texto do PR só afirma "passou" com evidência.
 */
export async function describeFactoryGates(db: Db, childId: string, opts: { scope?: string[] | null; appsDir?: string | null } = {}): Promise<FactoryGateOutcomes> {
  const none = (detail: string): GateOutcome => ({ status: "not_run", detail });
  let scope = none("checkpoint do runner indisponível"), symbols = scope;
  let baseline = none("sem baseline registrada (checkpoint do runner indisponível)");
  let cp: Record<string, unknown> | null = null;
  try { cp = await readEvolutionCheckpoint(childId); } catch { cp = null; }
  try {
    const v = cp?.evolution_violations;
    if (cp && v && typeof v === "object") {
      const msgs = Object.values(v as Record<string, unknown>).flatMap((x) => (Array.isArray(x) ? x.map(String) : []));
      const sc = msgs.filter((m) => /FORA DO ESCOPO/i.test(m)), sy = msgs.filter((m) => /S[ÍI]MBOLOS REMOVIDOS/i.test(m));
      scope = sc.length ? { status: "failed", detail: `${sc.length} violação(ões) registrada(s) (ex.: ${sc[0].slice(0, 120)})` } : { status: "passed", detail: "nenhuma violação registrada nas escritas do Dev" };
      symbols = sy.length ? { status: "failed", detail: `${sy.length} remoção(ões) de símbolos registrada(s) (ex.: ${sy[0].slice(0, 120)})` } : { status: "passed", detail: "nenhuma remoção registrada nas escritas do Dev" };
    }
  } catch { /* mantém not_run */ }

  // N-6: o diff REAL de apps/ contra o escopo do RFC (o que o runner não enxerga: efeitos colaterais de build).
  try {
    const rawScope = opts.scope ?? (Array.isArray(cp?.evolution_scope) ? (cp?.evolution_scope as unknown[]).map(String) : []);
    const scopeGlobs = rawScope.filter((g) => typeof g === "string" && g.trim());
    const appsDir = opts.appsDir ?? ((process.env.PROJECT_FILES_ROOT ?? "").trim() ? path.join(process.env.PROJECT_FILES_ROOT as string, childId, "apps") : null);
    const changed = appsDir ? await listChangedFiles(appsDir) : null;
    if (changed && scopeGlobs.length) {
      const foreign = new Set(await detectForeignLockfiles(appsDir as string, await listAllFilesForLockDetection(appsDir as string, changed)));
      const outside = pathsOutsideScope(changed, scopeGlobs).filter((f) => !foreign.has(f));
      const note = foreign.size ? ` Lockfile(s) de outro gerenciador de pacotes EXCLUÍDO(S) da publicação: ${[...foreign].slice(0, 3).join(", ")}.` : "";
      if (outside.length) {
        const sample = outside.slice(0, 5).join(", ");
        scope = { status: "failed", detail: `${outside.length} arquivo(s) no diff FORA do \`files_allowed\` do RFC (${sample}${outside.length > 5 ? ", …" : ""}).${note}${scope.status === "failed" ? ` ${scope.detail}.` : ""}` };
      } else if (scope.status === "failed") {
        scope = { status: "failed", detail: `${scope.detail}.${note}` };
      } else {
        scope = { status: "passed", detail: `diff real (${changed.length} arquivo(s)) dentro do \`files_allowed\` do RFC.${note}` };
      }
    } else if (scope.status === "passed") {
      scope = { status: "passed", detail: `${scope.detail} (diff real de apps/ não conferido: ${changed ? "RFC sem escopo declarado" : "apps/ não é clone git"})` };
    }
  } catch { /* o resultado do checkpoint permanece */ }

  try {
    const bl = cp?.evolution_baseline as Record<string, unknown> | null | undefined;
    if (bl && typeof bl === "object") {
      const st = String(bl.status ?? "");
      const fin = (bl.final ?? null) as Record<string, unknown> | null;
      const regs = Array.isArray(fin?.regressions) ? (fin?.regressions as unknown[]).length : 0;
      if (bl.no_tests === true || st === "no_tests") {
        // N-4: `no_tests` com exit ≠ 0 não é "produto sem testes": o runner de testes SAIU com erro sem medir nenhum (ex.: jest sem configuração de TS).
        const broken = Number(bl.exit_code ?? 0) > 0;
        baseline = none(`SEM TESTES: PASS_TO_PASS vazio, nenhuma não-regressão foi verificada${broken ? ` — atenção: o executor saiu com erro (exit ${Number(bl.exit_code)}) e 0 testes medidos; a suíte pode existir mas estar sem configuração/quebrada` : ""}`);
      }
      else if (st === "error") baseline = none(`baseline NÃO medida (${String(bl.error ?? "erro de medição").slice(0, 120)}) — sem P2P`);
      else if (!fin) baseline = none("baseline medida, mas sem resultado final da suíte para comparar (P2P não calculado)");
      else if (String(fin.status ?? "") === "error") baseline = none("baseline medida, mas a medição final falhou (P2P não calculado)");
      else if (regs > 0) baseline = { status: "failed", detail: `${regs} regressão(ões) no PASS_TO_PASS` };
      else baseline = { status: "passed", detail: `baseline medida (${Number(bl.passed ?? 0)} teste(s) passando) e 0 regressões no PASS_TO_PASS` };
    }
  } catch { /* mantém not_run */ }

  let qa = none("sem registro do QA no diálogo do projeto");
  let fullTest = none("sem registro da TSK-FULL-TEST");
  try {
    const rows = (await db.query(
      `SELECT event_type, summary_human FROM project_dialogue
        WHERE project_id = $1 AND (event_type = 'qa.review' OR summary_human ILIKE '%QA reportou QA_FAIL%' OR summary_human ILIKE '%QA atingiu m%ximo%' OR summary_human ILIKE '%TASK-FULL-TEST%')
        ORDER BY created_at ASC`,
      [childId],
    )).rows as Array<{ event_type?: string | null; summary_human?: string | null }>;
    const qaRows = rows.filter((r) => !/TASK-FULL-TEST/i.test(String(r.summary_human ?? "")));
    const unapproved = qaRows.filter((r) => /n[ãa]o aprovada|QA atingiu m[aá]ximo|BLOCKED \(BLOCKER/i.test(String(r.summary_human ?? "")));
    const ran = qaRows.some((r) => r.event_type === "qa.review");
    if (unapproved.length) qa = { status: "failed", detail: `${unapproved.length} task(s) sem aprovação do QA após os reworks` };
    else if (ran) qa = { status: "passed", detail: "QA executado, sem reprovação final registrada" };

    // TSK-FULL-TEST: o ÚLTIMO registro da execução manda (o diálogo está em ordem cronológica).
    const ftMsgs = rows.map((r) => String(r.summary_human ?? "")).filter((m) => /TASK-FULL-TEST/i.test(m));
    const verdict = [...ftMsgs].reverse().find((m) => /NÃO EXECUTADA|NOT_RUN|REPROVADA|\(Claude Code\):\s*aprovada/i.test(m));
    const taskRow = (await db.query("SELECT status FROM project_tasks WHERE project_id = $1 AND task_id = 'TSK-FULL-TEST'", [childId])).rows[0] as { status?: string } | undefined;
    const tstatus = String(taskRow?.status ?? "").toUpperCase();
    if (tstatus === "CANCELLED" || (verdict && /NÃO EXECUTADA|NOT_RUN/i.test(verdict))) fullTest = none("NOT_RUN: a TSK-FULL-TEST não executou (task CANCELLED) — a validação e2e NÃO ocorreu");
    else if (verdict && /REPROVADA/i.test(verdict)) fullTest = { status: "failed", detail: verdict.replace(/^.*?REPROVADA\s*[—-]?\s*/i, "reprovada: ").slice(0, 200) };
    else if (verdict && (tstatus === "DONE" || tstatus === "QA_PASS")) fullTest = { status: "passed", detail: "executada e aprovada (registro da execução no diálogo)" };
    else if (tstatus) fullTest = none(`task em '${tstatus}' sem registro de execução aprovada (o aceite pode tê-la fechado sem executar)`);
  } catch (e) {
    const why = `leitura do diálogo falhou (${e instanceof Error ? e.message.slice(0, 80) : "erro"})`;
    qa = none(why); fullTest = none(why);
  }
  return { scope, symbols, qa, fullTest, baseline };
}

/** Todos os caminhos candidatos a lockfile estranho: os alterados + os lockfiles já presentes na mesma pasta (para a regra de gerenciador). */
async function listAllFilesForLockDetection(appsDir: string, changed: string[]): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const dirs = new Set(changed.filter((f) => JS_LOCKFILES[path.posix.basename(f)]).map((f) => path.posix.dirname(f)));
  const out = new Set(changed);
  for (const d of dirs) {
    try { for (const e of await readdir(path.join(appsDir, d))) if (JS_LOCKFILES[e]) out.add(d === "." ? e : `${d}/${e}`); } catch { /* segue */ }
  }
  return [...out];
}

/** Linhas do corpo do PR: cada gate com o seu resultado real; nunca afirma o que não rodou. */
export function renderGateLines(g: FactoryGateOutcomes): string[] {
  const row = (name: string, o: GateOutcome) => `- ${name}: **${GATE_LABEL[o.status]}** — ${o.detail}`;
  return [
    "### Gates da fábrica (resultado registrado)",
    "",
    row("Gate de escopo (RFC `files_allowed`)", g.scope),
    row("Símbolos preservados", g.symbols),
    row("QA", g.qa),
    row("TSK-FULL-TEST (e2e)", g.fullTest),
    row("Baseline / não-regressão (P2P)", g.baseline),
    "",
    "_Escopo e símbolos cobrem as escritas do Dev e o diff real de `apps/`. \"Não executado/sem evidência\" NÃO é aprovação. Revise o diff antes do merge em `dev`._",
  ];
}

/** Corpo do PR: resumo do plano + RFCs + seção liberada do CHANGELOG. */
export async function buildPullRequestBody(db: Db, childId: string, version: string, extra: Record<string, unknown>): Promise<string> {
  const plan = (extra.evolution_plan as Record<string, unknown> | undefined) ?? {};
  const rfcs = (extra.evolution_rfcs as string[] | undefined) ?? (plan.rfcs as string[] | undefined) ?? [];
  const lines = [
    `## Evolução v${version} — gerada pelo Zentriz Genesis (Bancada → Fábrica)`,
    "",
    typeof plan.summary === "string" && plan.summary ? plan.summary : (typeof extra.evolution_request === "string" ? String(extra.evolution_request).slice(0, 1500) : ""),
    "",
    `**Compatibilidade:** ${String(extra.evolution_compat ?? "minor").toUpperCase()}`,
    // RFC-0009 (F3): quem carimba o ticket é a MÁQUINA — confiar no humano custa ~40% dos links
    // issue↔commit (BTLink, EMSE 2023). Este corpo é reusado como mensagem do merge commit
    // (evolutionMerge.ts), então o carimbo chega ao histórico de `dev` sem código novo lá.
    ticketStamp(extra) ? `**Ticket:** ${ticketStamp(extra)}${extra.ticket_kind ? ` (${TICKET_KIND_LABEL[extra.ticket_kind as keyof typeof TICKET_KIND_LABEL] ?? String(extra.ticket_kind)})` : ""}` : "",
    rfcs.length ? `\n**RFCs:**\n${rfcs.map((r) => `- \`${r}\``).join("\n")}` : "",
    "",
  ];
  const row = (await db.query(
    "SELECT file_path FROM project_spec_files WHERE project_id = $1 AND lower(filename) = 'changelog.md' AND coalesce(rel_dir,'') = ''", [childId],
  )).rows[0] as { file_path: string } | undefined;
  if (row) {
    try {
      const cl = await fsp.readFile(row.file_path, "utf-8");
      const i = cl.indexOf(`## [${version}]`);
      if (i >= 0) {
        const rest = cl.slice(i);
        const next = rest.slice(1).search(/^## \[/m);
        lines.push("### CHANGELOG", "", (next < 0 ? rest : rest.slice(0, next + 1)).trim());
      }
    } catch { /* sem changelog no corpo */ }
  }
  const scopeGlobs = Array.isArray(extra.evolution_scope) ? (extra.evolution_scope as unknown[]).map(String) : undefined;
  lines.push("", ...renderGateLines(await describeFactoryGates(db, childId, { scope: scopeGlobs })));
  return lines.filter((l) => l !== undefined).join("\n");
}

export function hasGitDir(appsDir: string): boolean {
  try { return fs.existsSync(path.join(appsDir, ".git")); } catch { return false; }
}

/**
 * Orquestra o aceite de uma evolução. Devolve `false` (sem efeito) se o projeto NÃO é evolução —
 * o chamador segue o fluxo normal (`pushProjectToGitHub`). Best-effort: nunca lança.
 */
/** CHANGELOG da Bancada do filho já tem `## [version]`? (guarda de idempotência do republicar — adversarial A). */
async function changelogHasVersion(db: Db, childId: string, version: string): Promise<boolean> {
  const row = (await db.query(
    "SELECT file_path FROM project_spec_files WHERE project_id = $1 AND lower(filename) = 'changelog.md' AND coalesce(rel_dir,'') = ''", [childId],
  )).rows[0] as { file_path: string } | undefined;
  if (!row) return false;
  try { return new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m").test(await fsp.readFile(row.file_path, "utf-8")); } catch { return false; }
}

/**
 * Orquestra o aceite de uma evolução. Devolve `false` (sem efeito) se o projeto NÃO é evolução —
 * o chamador segue o fluxo normal (`pushProjectToGitHub`). Best-effort: nunca lança.
 * `opts.republish` (H2): reexecuta SÓ push + supersessão de uma evolução já aceita cujo push falhou
 * (`extra.evolution_push_pending`); a versão do CHANGELOG é REUSADA (nunca dobra: 1.1.0 → 1.2.0).
 */
export async function runEvolutionAcceptFlow(db: Db, childId: string, opts: { republish?: boolean } = {}): Promise<boolean> {
  const row = (await db.query(
    "SELECT id, title, product_id, parent_project_id, version_number, extra FROM projects WHERE id = $1", [childId],
  )).rows[0] as { id: string; title: string; product_id: string | null; parent_project_id: string | null; version_number: number | null; extra: Record<string, unknown> | null } | undefined;
  if (!row || row.extra?.evolution !== true) return false;
  const extra = row.extra ?? {};
  const compatRaw = String(extra.evolution_compat ?? "minor").toLowerCase();
  const compat: Compat = compatRaw === "major" || compatRaw === "patch" ? compatRaw : "minor";
  const parentId = (extra.evolution_parent_id as string | undefined) ?? row.parent_project_id ?? null;
  const title = row.title.replace(/ — Evolução v\d+$/i, "");

  const log = async (msg: string) => {
    await db.query(
      "INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human) VALUES ($1, 'system', 'system', 'step', $2)",
      [childId, msg],
    ).catch(() => {});
  };

  // Guarda de idempotência (adversarial bloco 2 — A): se esta evolução JÁ tem versão fechada
  // (`extra.evolution_version`) e o CHANGELOG já contém `## [versão]`, REUSA — republicar/reprocessar
  // nunca dobra a versão (1.1.0 → 1.2.0) nem reescreve o CHANGELOG.
  let version = "?";
  const priorVersion = typeof extra.evolution_version === "string" ? extra.evolution_version : null;
  // Versão já fechada → SEMPRE reusar (o CHANGELOG é só cópia; se o humano o apagou, `patch` regeraria
  // 1.0.1 ≠ evolution_version). Se o arquivo não tiver mais a seção, recria a seção com a MESMA versão.
  if (priorVersion) {
    version = priorVersion;
    const has = await changelogHasVersion(db, childId, priorVersion);
    if (!has) {
      try { await finalizeEvolutionChangelog(db, childId, { compat, title, productId: row.product_id, forceVersion: priorVersion }); } catch { /* best-effort */ }
    }
    await log(`📦 CHANGELOG já fechado como v${version} — versão reusada (${opts.republish ? "republicação" : "reprocessamento"}).`);
  } else {
    try {
      const fin = await finalizeEvolutionChangelog(db, childId, { compat, title, productId: row.product_id });
      version = fin.version;
      await log(`📦 CHANGELOG fechado como v${version} (${compat.toUpperCase()})${fin.appsCopy ? " e copiado para apps/CHANGELOG.md" : ""}.`);
    } catch (e) {
      await log(`⚠️ Não foi possível versionar o CHANGELOG: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Push do código. A supersessão do pai SÓ acontece se o código foi publicado (ou se o tenant não
  // publica de forma alguma — sem GitHub App): pai arquivado sem código publicado = "sumiu meu
  // projeto" com a versão corrente invisível no repo. Falha real → supersessão ADIADA (flag).
  let pushOk = false;
  // Como o código chegou ao GitHub: `pr` (branch evolution/vN + PR), `direct_dev` (repo novo, push direto em `dev`, sem PR por desenho —
  // N6a) ou `skipped` (sem App / push desligado: nada publicado, o repositório da linhagem — se houver — não recebeu o código; N6b).
  let publishMode: "pr" | "direct_dev" | "skipped" = "skipped";
  try {
    const { pushEvolutionToGitHub } = await import("./githubPush.js");
    const body = await buildPullRequestBody(db, childId, version, { ...extra, evolution_compat: compat });
    const push = await pushEvolutionToGitHub(childId, { versionLabel: version, prBody: body, title });
    // N1: `fallback_new_repo` NÃO é sucesso por si — só conta se o repositório foi realmente criado e registrado (`push.ok`).
    pushOk = push.ok || push.mode === "skipped";
    publishMode = push.mode === "evolution" ? "pr" : push.mode === "fallback_new_repo" ? "direct_dev" : "skipped";
    // Bloco 3 F4: o portal mostra branch/PR — persistir o resultado do push no extra (só o que existe).
    if (push.ok && push.mode === "evolution") {
      await db.query(
        "UPDATE projects SET extra = COALESCE(extra,'{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1",
        [childId, JSON.stringify({
          evolution_branch: push.branch ?? null, evolution_repo: push.fullName ?? null,
          evolution_pr_url: push.prUrl ?? null, evolution_compare_url: push.compareUrl ?? null,
          evolution_pushed_files: push.fileCount ?? null, evolution_deleted_files: push.deleted ?? 0,
          // Bloco 4 (M0): número do PR + SHA do head empurrado — insumos do merge automático (M1).
          evolution_pr_number: push.prNumber ?? null, evolution_head_sha: push.headSha ?? null,
        })],
      ).catch(() => {});
    }
    if (!pushOk) await log(`⚠️ Publicação da evolução não concluída (${push.error ?? "erro"}). Supersessão da versão anterior ADIADA até o push ser reprocessado.`);
  } catch (e) {
    await log(`⚠️ Publicação da evolução falhou: ${e instanceof Error ? e.message : String(e)}. Supersessão da versão anterior ADIADA.`);
  }

  if (!pushOk) {
    await db.query(
      "UPDATE projects SET extra = COALESCE(extra,'{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1",
      [childId, JSON.stringify({ evolution_push_pending: true, evolution_publish_state: "failed", evolution_version: version })],
    ).catch(() => {});
    return true;
  }
  // Push ok → a pendência se resolve INCONDICIONALMENTE (N5): o `extra` lido no início pode estar velho — o reconciliador marca
  // `push_pending` quando o push passa da carência e ele ainda está em voo. O fim de um push bem-sucedido é a verdade mais nova.
  // B1: publicação concluída (PR registrado acima, quando houve) — o marcador `pending` do aceite cai AQUI, não antes.
  const wasPending = extra.evolution_push_pending === true;
  await db.query(
    "UPDATE projects SET extra = COALESCE(extra,'{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1",
    [childId, JSON.stringify({ evolution_push_pending: false, evolution_publish_state: "done", evolution_publish_mode: publishMode,
      ...(wasPending ? { evolution_republished_at: new Date().toISOString() } : {}) })],
  ).catch(() => {});

  try {
    const superseded = await supersedeParent(db, childId, parentId, version);
    await log(superseded
      ? `♻️ Versão anterior arquivada (superseded_by → esta evolução). Esta é a versão corrente v${version}.`
      : `ℹ️ Versão anterior não alterada (já arquivada/superseded ou inexistente). Esta é v${version}.`);
  } catch (e) {
    await log(`⚠️ Supersessão do pai falhou: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Bloco 4 (M1) — passo ADICIONAL e opcional: merge automático do PR evolution/vN → dev.
  // Best-effort e atrás de flag (EVOLUTION_AUTO_MERGE, default OFF): nunca derruba o aceite, que já
  // concluiu (push + supersessão). Sem flag → `skipped_flag` (nada muda; comportamento atual).
  try {
    const { tryAutoMergeEvolution } = await import("./evolutionMerge.js");
    const merge = await tryAutoMergeEvolution(db, childId);
    if (merge.state !== "skipped_flag" && merge.state !== "skipped_no_pr") {
      await log(`🔀 Merge automático: ${merge.state}${merge.detail ? ` — ${merge.detail}` : ""}.`);
    }
  } catch (e) {
    await log(`⚠️ Tentativa de merge automático falhou (aceite preservado): ${e instanceof Error ? e.message : String(e)}`);
  }
  return true;
}
