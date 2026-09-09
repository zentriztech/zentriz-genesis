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
import { resolveWorkbenchLlm, agentsLlmFields } from "./tenantLlmConfig.js";
import { parseRfcMarkdown, RFC_DIR, RFC_FILENAME_RE } from "./evolutionGate.js";
import { normalizeCategory, enrichRunFindings, registerRecurrences, judgedFilesOf, unionFindingsByCoverage, projectFindingsState } from "./findingTriage.js";
import { parseFrontmatter } from "../lib/frontmatter.js";
import { cutEvidence } from "./evidenceCut.js";
import { VENDORED_CONNECT_VERSION } from "./connectSchema.js";

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
  /** `oracle` = F3: o GAP nasceu da EXECUÇÃO REAL do produto no executor isolado, não da leitura da spec. */
  source: "stage_a" | "stage_b" | "oracle";
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
    /sem declaração Connect/i.test(t) ? "no_connect_declaration" :
    /Declaração Connect sem os campos/i.test(t) ? "connect_declaration_incomplete" :
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

/**
 * 🔴 GAP-136 — o prazo era da RUN, mas o trabalho é POR LOTE.
 *
 * Medido em prod 2026-09-09 (NVX LastMile): a spec chegou a **1.158.616 chars** e o estágio B virou
 * **4 lotes** (teto de janela 400k). Cada lote é uma leitura adversarial de 5–8 min, então a run
 * inteira leva ~25 min — mas `deadline_at` nascia `started_at + 20 min`, um prazo dimensionado para
 * UMA chamada. Resultado: `expireOverdueValidationRuns` virava a run `error` **no meio do lote 4**,
 * duas validações seguidas (`89eae25b`, `8fbdfc21`) morreram assim, e a Bancada passou a mostrar
 * "Erro na validação · GAPs (0)" para uma spec com 40 achados medidos.
 *
 * Prazo existe para cortar PARALISIA, não trabalho que está progredindo. Então o prazo passou a ser
 * RENOVÁVEL por evidência de progresso: cada lote medido empurra `deadline_at` para
 * `now() + VALIDATION_DEADLINE_MIN`, sempre limitado pelo teto DURO abaixo — que continua sendo o
 * fim da história para uma run travada. Renovação é FATO: vai para o log e para a cobertura
 * (`deadlineRenewals`), porque prazo que se move sem ninguém dizer é prazo que não existe.
 */
const VALIDATION_MAX_MIN = parseInt(process.env.SPEC_VALIDATION_MAX_MIN ?? "90", 10);

/**
 * GAP-136: empurra o prazo da run por PROGRESSO MEDIDO, respeitando o teto duro contado do início.
 * Best-effort: falhar aqui só devolve o comportamento antigo (a run morre no prazo anterior).
 */
export async function renewValidationDeadline(pool: Pool, runId: string, motivo: string): Promise<boolean> {
  try {
    const r = await pool.query(
      `UPDATE spec_validation_runs
          SET deadline_at = LEAST(
                started_at + ($2 || ' minutes')::interval,
                now() + ($3 || ' minutes')::interval)
        WHERE id = $1
          AND status IN ('pending','running')
          AND deadline_at IS NOT NULL
          AND deadline_at < now() + ($3 || ' minutes')::interval
          AND started_at + ($2 || ' minutes')::interval > deadline_at
        RETURNING deadline_at`,
      [runId, String(VALIDATION_MAX_MIN), String(VALIDATION_DEADLINE_MIN)],
    );
    const novo = r.rows[0]?.deadline_at;
    if (!novo) return false;
    console.log(`[spec-validation] run ${String(runId).slice(0, 8)}: prazo RENOVADO até ${new Date(String(novo)).toISOString()} — ${motivo} (teto duro: ${VALIDATION_MAX_MIN} min desde o início).`);
    return true;
  } catch (e) {
    console.warn(`[spec-validation] run ${String(runId).slice(0, 8)}: prazo não renovado (${e instanceof Error ? e.message : String(e)}) — a run pode expirar com trabalho em curso.`);
    return false;
  }
}

// ── hash do estado atual (disco é a verdade) ─────────────────────────────────

export interface SpecFileRow {
  filename: string;
  file_path: string;
  rel_dir: string;
}

export async function computeCurrentSpecHash(
  db: { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  projectId: string,
): Promise<{ specHash: string; files: Array<SpecFileRow & { content: string; contentSha256: string }> } | null> {
  const rows = (await db.query(
    "SELECT filename, file_path, rel_dir FROM project_spec_files WHERE project_id = $1",
    [projectId],
  )).rows as unknown as SpecFileRow[];
  if (rows.length === 0) return null;
  const files: Array<SpecFileRow & { content: string; contentSha256: string }> = [];
  const entries: Array<{ relDir: string; filename: string; contentSha256: string }> = [];
  for (const r of rows) {
    const buf = await readFile(r.file_path).catch(() => null);
    if (buf === null) return null; // arquivo sumiu do disco — estado inválido p/ validar
    // GAP-18: o sha POR ARQUIVO já era calculado aqui para o hash da árvore. Devolvê-lo é o que
    // permite comparar com `stage_b_full_sha` (arquivo julgado integralmente em QUAL conteúdo).
    const contentSha256 = sha256Hex(buf);
    files.push({ ...r, content: buf.toString("utf-8"), contentSha256 });
    entries.push({ relDir: r.rel_dir ?? "", filename: r.filename, contentSha256 });
  }
  return { specHash: computeSpecTreeHash(entries), files };
}

// ── Estágio A — determinístico, sempre, custo zero ───────────────────────────

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

  // 🔴 GAP-133 — declaração Connect (`connect.yaml`) na raiz. Sem ela a fábrica constrói e emite
  // SystemPassport/ServiceManifest por HEURÍSTICA sobre o código gerado, marcados como sintéticos:
  // o produto nasce fora do Connect (tier0) sem ninguém dizer isso em lugar nenhum. Era uma pendência
  // MUDA — 0 de 58 specs em prod tinham o arquivo e nenhuma ação do produto o criava.
  // Warning, nunca blocker: mesma leniência do manifesto (todo o legado está sem ele).
  const connectRow = files.find((f) => (f.rel_dir ?? "") === "" && f.filename.toLowerCase() === "connect.yaml");
  if (!connectRow) {
    findings.push({ file: "", line: null, severity: "warning", title: "Spec sem declaração Connect (connect.yaml)",
      rationale: "É a INTENÇÃO de interoperabilidade (interfaces, eventos, dependências, ambientes, health) que a fábrica usa para emitir os manifests de forma determinística. Sem ela os manifests saem por heurística e MARCADOS como sintéticos. Gere pela ação 'Declaração Connect' da Bancada (ou deixe o laço autônomo gerar).", source: "stage_a" });
  } else {
    // Verificação TEXTUAL, declarada como tal: a API não tem parser de YAML (o schema completo só é
    // aplicado na geração). Aqui só se confere que as chaves OBRIGATÓRIAS do schema aparecem.
    const faltando = ["schemaVersion", "systemId", "serviceName", "responsibility", "interfaces"]
      .filter((k) => !new RegExp(`^${k}\\s*:`, "m").test(connectRow.content));
    if (faltando.length) {
      findings.push({ file: "connect.yaml", line: 1, severity: "warning", title: "Declaração Connect sem os campos obrigatórios",
        rationale: `Verificação textual (a API não parseia YAML): ausentes no topo do arquivo → ${faltando.join(", ")}. O schema Connect v${VENDORED_CONNECT_VERSION} exige todos; regere a declaração pela Bancada.`, source: "stage_a" });
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
/** GAP-128: teto de INGESTÃO da justificativa do juiz. Armazenamento é JSONB — o teto é anti-abuso. */
export const STAGE_B_RATIONALE_MAX = 4000;
/**
 * 🔴 GAP-129: teto de INGESTÃO da LISTA do juiz, por lote. Era 50 e o descarte era MUDO — a lista
 * chegava menor e o laço media "menos GAPs" sem ninguém ter fechado nada (o mesmo dano do GAP-127,
 * mas na camada da MEDIÇÃO). O teto continua (anti-abuso), o descarte passa a ser DECLARADO.
 */
export const STAGE_B_MAX_FINDINGS = 120;

/**
 * 🔴 GAP-50 — título AUSENTE não pode virar uma CONSTANTE.
 *
 * `title` é campo obrigatório do contrato do juiz, mas o LLM às vezes omite: medido em prod
 * 2026-09-07 (NVX LastMile, run `d42baef2`) **27 de 27 findings** vieram sem `title` e o parser
 * gravou `(sem título)` em todos — 9 deles no mesmo arquivo. Dois danos:
 *  1. a Bancada e o CTO recebem 27 GAPs indistinguíveis na lista;
 *  2. pior, o título é o degrau de desempate da identidade (`effectiveFingerprints` /
 *     `findingTitleFingerprint`): com o MESMO título constante, dois findings distintos sob o mesmo
 *     anchor colapsam num fingerprint só e um deles DESAPARECE da contagem sem ninguém corrigir nada.
 *
 * O `rationale` (que veio completo nesses 27) já contém o fato. Derivar a primeira frase dele é
 * TRANSPORTE, não julgamento: nenhuma classificação nova, nenhum texto inventado. A constante fica
 * só para o caso em que não há rationale nenhum — aí realmente não há fato para transportar.
 */
export function titleFromRationale(rationale: string): string {
  const flat = String(rationale ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  // Primeira frase: corta no ponto seguido de espaço+maiúscula (não quebra em `§7.2` nem em `v1.4`).
  const m = /^(.{20,}?[.!?])(\s+[A-ZÀ-Þ«"`(])/.exec(flat);
  const first = (m ? m[1] : flat).trim();
  return (first.length > 160 ? `${first.slice(0, 157).trimEnd()}…` : first);
}

/** Valida/normaliza o JSON do LLM (schema fechado — nada além disso entra). */
export function parseStageBFindings(raw: unknown): ValidationFinding[] {
  return parseStageBFindingsWithDrop(raw).findings;
}

/**
 * 🔴 GAP-129: mesma leitura, mas devolvendo QUANTOS achados o teto descartou. Quem chama tem de
 * declarar esse número — descarte silencioso na entrada faz a contagem de GAPs mentir para baixo.
 */
export function parseStageBFindingsWithDrop(raw: unknown): { findings: ValidationFinding[]; dropped: number } {
  const arr = Array.isArray(raw) ? raw : [];
  const dropped = Math.max(0, arr.length - STAGE_B_MAX_FINDINGS);
  const out: ValidationFinding[] = [];
  for (const item of arr.slice(0, STAGE_B_MAX_FINDINGS)) {
    const o = (item ?? {}) as Record<string, unknown>;
    const sev = String(o.severity ?? "info").toLowerCase();
    // 🔴 GAP-128: a coluna é JSONB (sem limite de banco) e este é o fato PRIMÁRIO do juiz — medido em
    // prod, 7 findings estavam exatamente em 1.200 chars (4 terminando no meio de uma palavra), isto é,
    // o teto antigo já mordia e ninguém sabia. Sobe para 4.000 e, se ainda cortar, DECLARA.
    const rationale = cutEvidence(String(o.rationale ?? ""), STAGE_B_RATIONALE_MAX);
    out.push({
      file: String(o.file ?? "").slice(0, 300),
      line: Number.isFinite(Number(o.line)) ? Math.max(1, Math.trunc(Number(o.line))) : null,
      severity: (STAGE_B_SEVERITIES.has(sev) ? sev : "info") as ValidationFinding["severity"],
      // GAP-50: título ausente cai no fato que o juiz escreveu, nunca numa constante repetida.
      title: String(o.title ?? "").trim().slice(0, 200) || titleFromRationale(rationale) || "(sem título)",
      rationale,
      source: "stage_b",
      // RFC-0005: identidade estável vem do `anchor` (FR/seção/entidade). A `category` é taxonomia
      // fechada para AGRUPAR e relatar — GAP-49 tirou-a da identidade (ela troca entre validações).
      category: normalizeCategory(o.category),
      anchor: String(o.anchor ?? "").trim().slice(0, 160) || null,
    });
  }
  return { findings: out, dropped };
}

/**
 * GAP-11 (migração 100): encerra o assunto de um job do estágio B — resultado entregue, job perdido
 * no agents, ou desistência por teto duro. Enquanto `stage_b_collected_at` for NULL e houver
 * `agents_job_id`, o coletor volta a tentar e o laço autônomo ESPERA.
 */
async function markStageBCollected(pool: Pool, runId: string): Promise<void> {
  await pool.query(
    "UPDATE spec_validation_runs SET stage_b_collected_at = now() WHERE id = $1 AND stage_b_collected_at IS NULL",
    [runId],
  ).catch((e) => console.warn(`[spec-validation] run ${runId}: stage_b_collected_at não gravado (${e instanceof Error ? e.message : String(e)}).`));
}

/**
 * 🔴 GAP-39 — CONTINUIDADE da identidade dos findings entre validações.
 *
 * A identidade de um finding é `file|source|category|anchor` (RFC-0005) e o `anchor` é texto LIVRE do
 * juiz. Como cada validação é uma conversa NOVA sobre um arquivo REESCRITO, o juiz não tinha como
 * saber que anchor ele mesmo usou antes — e reescrevia. Medido em prod (NVX LastMile, run 3cfd4cc0
 * contra a anterior): 16 GAPs "fechados" e 25 "abertos" nos MESMOS arquivos, sendo os pares o MESMO
 * defeito com o anchor reescrito ("Convenções gerais" → "Convenções gerais (bloco com marcadores
 * =======)"; "§7.2 regra 1" → "§7.2 regra 1 (SYSTEM_ACTOR_USER_ID)"; um "§5.4-bis Etapa D" virou
 * três). Efeito: a contagem de GAPs não pode cair, e "descoberta de superfície nova" — a hipótese
 * anterior — foi MEDIDA em ZERO (nenhum finding novo veio de arquivo inédito). Heurística de
 * casamento (título por Jaccard, contenção de anchor) foi testada sobre os dados reais de prod e
 * REFUTADA: 0 de 16 pares com Jaccard ≥ 0,5 e a contenção de anchor funde defeitos distintos
 * (`privacy_requests` ⊃ `privacy_requests.requester_contact`).
 *
 * Então quem decide se é o MESMO defeito é o JUIZ (Lei do Jean: julgamento é do LLM, o código só
 * transporta). Aqui o código transporta os findings ATIVOS: `file · anchor · título`, só dos
 * arquivos que ESTA validação vai ler por INTEIRO — num arquivo que entra só como sumário o juiz não
 * tem como confirmar nada, e listá-lo convidaria a reemitir sem evidência (fail-open). Findings já
 * triados (ignorados/refutados) ficam fora: pedir para reencontrá-los é pedir para reabrir decisão
 * do humano.
 */
export function knownFindingsForJudge(
  findings: Array<{ file?: string | null; anchor?: string | null; title?: string; severity?: string; triage?: unknown }>,
  fullFiles: string[],
  max = 80,
): Array<{ file: string; anchor: string; title: string; severity: string }> {
  const full = new Set(fullFiles.map((p) => p.toLowerCase()));
  const rank: Record<string, number> = { blocker: 0, warning: 1, info: 2 };
  const seen = new Set<string>();
  const out: Array<{ file: string; anchor: string; title: string; severity: string }> = [];
  for (const f of findings) {
    if (f.triage) continue;
    const anchor = String(f.anchor ?? "").trim();
    const file = String(f.file ?? "").trim();
    if (!anchor || !file || !full.has(file.toLowerCase())) continue;
    const k = `${file.toLowerCase()}|${anchor.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ file, anchor: anchor.slice(0, 160), title: String(f.title ?? "").slice(0, 200), severity: String(f.severity ?? "") });
  }
  out.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3) || a.file.localeCompare(b.file) || a.anchor.localeCompare(b.anchor));
  return out.slice(0, max);
}

/**
 * Uma leitura adversarial. `pending: true` é o único desfecho que deixa trabalho PAGO para trás (o job
 * pode estar vivo no agents) — quem chama tem de preservar `stage_b_collected_at` NULL e parar de
 * despachar lotes novos, senão o `collectStageBResults` nunca volta para buscá-lo (GAP-11).
 */
interface StageBOutcome {
  findings: ValidationFinding[]; error?: string; pending?: true;
  /** GAP-129: achados que o teto de ingestão descartou neste lote. */ dropped?: number;
  /** GAP-140: quantas vezes o prazo da run foi empurrado por PROVA DE VIDA do job deste lote. */
  renewals?: number;
}

/**
 * 🔴 GAP-140 — o prazo só era renovado por lote DESPACHADO, e o 1º lote não despacha nada depois de si.
 *
 * Medido ao vivo 2026-09-09 (run `82d02c1c`, NVX LastMile em 4 lotes): a run nasceu às 09:28 com
 * `deadline_at` 09:48 e o lote 1 seguia em leitura às 09:40 — a primeira renovação do GAP-136 só
 * aconteceria quando o lote 2 fosse despachado, isto é, DEPOIS de o lote 1 terminar. Um único lote
 * mais longo que `SPEC_VALIDATION_DEADLINE_MIN` continuava sendo morto pelo watchdog no meio de uma
 * leitura que este processo estava provando estar viva a cada 8 s (`stage_b_polled_at`).
 *
 * O fato já existia e não era usado: um poll 200 do agents diz que o job está de pé do outro lado.
 * Prazo existe para cortar PARALISIA — job vivo não é paralisia. Então prova de vida também renova,
 * com folga entre renovações (não a cada 8 s) e sempre sob o teto duro `VALIDATION_MAX_MIN`.
 */
const RENEW_ON_ALIVE_MS = 120_000;

/**
 * 🔴 GAP-141 (lado consumidor) — a triagem do validador voltava no envelope e MORRIA aqui.
 *
 * `validate_spec` devolve `{findings, triage}`; este arquivo lia só `findings`. Busca no repo inteiro:
 * nenhum consumidor de `triage`/`is_spec` fora do próprio validador (o `specSemanticGate` é OUTRO
 * caminho, no salvamento). Ou seja: o modelo podia estar dizendo "isto não é uma especificação" — o
 * que explicaria uma run com 0 achados — e ninguém, em lugar nenhum, veria.
 *
 * Aqui o veredicto é só DECLARADO (log), nunca gate: a triagem passou a julgar um DIGESTO (início +
 * títulos), então promovê-la a bloqueio criaria falso-negativo de spec grande. Declarar é o passo
 * honesto; gate exige medição própria antes.
 */
export function triageNote(raw: unknown): { line: string; suspect: boolean } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  if (!("is_spec" in t) && !("summary" in t) && !("modules" in t)) return null;
  const suspect = t.is_spec === false;
  const mods = Array.isArray(t.modules) ? t.modules.slice(0, 8).map((m) => String(m)).join(", ") : "";
  const partes = [
    `is_spec=${t.is_spec === undefined ? "?" : String(t.is_spec)}`,
    typeof t.input === "string" && t.input ? t.input : null,
    mods ? `módulos: ${mods}` : null,
    typeof t.summary === "string" && t.summary ? `"${t.summary.slice(0, 200)}"` : null,
  ].filter((p): p is string => !!p);
  return { line: partes.join(" · "), suspect };
}

/** Loga a triagem do envelope do estágio B (nunca lança — é observabilidade). */
function logTriage(runId: string, result: Record<string, unknown>): void {
  const n = triageNote(result.triage);
  if (!n) return;
  const msg = `[spec-validation] run ${runId}: triagem do validador — ${n.line}`;
  if (n.suspect) console.warn(`${msg} ⚠️ o próprio modelo NÃO reconheceu o conteúdo como especificação: leia isto antes de tratar a contagem de achados desta run como medida da spec.`);
  else console.log(msg);
}

async function runStageB(pool: Pool, runId: string, projectId: string, specText: string, knownFindings: unknown[] = []): Promise<StageBOutcome> {
  const agentsUrl = (process.env.API_AGENTS_URL ?? "").trim();
  if (!agentsUrl) return { findings: [], error: "agents indisponível (API_AGENTS_URL ausente)" };
  const base = agentsUrl.replace(/\/$/, "");
  // Mesma config de LLM da fábrica (modelo/credenciais do tenant). O refutador ainda respeita
  // SPEC_VALIDATOR_MODEL do env como override explícito (precedência no spec_validator.py).
  const llm = agentsLlmFields(await resolveWorkbenchLlm({ projectId }));
  const start = await httpJson(`${base}/invoke/spec_validator/async`, "POST", {
    // GAP-10: o corte cego `slice(0, 200_000)` vivia aqui e produzia blockers FANTASMAS de "arquivo
    // ausente". Quem monta (e declara) o recorte agora é `buildValidationInput`, no chamador.
    spec_text: specText,
    originProjectId: projectId, // débito de usage no orçamento do tenant (F6)
    // GAP-39: lista de continuidade. Vazia → o refutador é exatamente o de antes (nada no prompt).
    ...(knownFindings.length ? { known_findings: knownFindings } : {}),
    ...llm,
  }, 30_000).catch((e) => ({ status: 0, data: { error: String(e) } as Record<string, unknown> }));
  const jobId = String(start.data.jobId ?? "");
  if (start.status !== 200 || !jobId) {
    return { findings: [], error: `agents start falhou (${start.status}): ${String(start.data.error ?? "")}`.slice(0, 300) };
  }
  // GAP-11 (migração 100): o jobId vai para o BANCO antes do primeiro poll. Enquanto ele vivia só
  // nesta variável local, estourar o teto de espera custava uma leitura adversarial inteira já PAGA
  // (medido em prod: run 16e467cf, 20m40s de espera, 0 findings, resultado descartado pelo TTL em
  // memória dos agents). Prazo limita QUANTO SE ESPERA, nunca a validade do que já foi produzido.
  await pool.query("UPDATE spec_validation_runs SET agents_job_id = $2 WHERE id = $1", [runId, jobId])
    .catch((e) => console.warn(`[spec-validation] run ${runId}: agents_job_id não gravado (${e instanceof Error ? e.message : String(e)}) — resultado NÃO será recuperável se a espera estourar.`));
  const deadline = Date.now() + VALIDATION_DEADLINE_MIN * 60_000;
  // GAP-140: renovações desta espera, para o chamador somar e DECLARAR na cobertura.
  let renewals = 0;
  let ultimaRenovacao = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8_000));
    // GAP-66 (migração 104): sinal de vida ANTES do poll. É o único jeito de o coletor distinguir
    // "esperador vivo" de "esperador morto por restart da api" sem virar um segundo escritor da linha.
    // Falha aqui é irrelevante para a validação: o pior efeito é a run ser adotada pelo coletor, que
    // faz exatamente o mesmo trabalho.
    await pool.query("UPDATE spec_validation_runs SET stage_b_polled_at = now() WHERE id = $1", [runId])
      .catch(() => undefined);
    const poll = await httpJson(`${base}/invoke/spec_validator/status/${jobId}`, "GET", undefined, 30_000)
      .catch(() => ({ status: 0, data: {} as Record<string, unknown> }));
    // 404 = agents reiniciou e perdeu o job em memória → interrupted (NUNCA insistir 11min).
    if (poll.status === 404) {
      // Nada a recuperar: o job não existe mais. Quem marca `stage_b_collected_at` é o chamador, DEPOIS
      // do último lote — marcar aqui encerraria o assunto da run inteira e um lote seguinte que
      // estourasse a espera ficaria invisível ao coletor (o filtro dele é `collected_at IS NULL`).
      return { findings: [], error: "agents reiniciou durante a validação (job perdido)" };
    }
    if (poll.status !== 200) continue;
    const st = String(poll.data.status ?? "");
    if (st === "done") {
      const result = (poll.data.result ?? {}) as Record<string, unknown>;
      logTriage(runId, result); // GAP-141: o veredicto da triagem para de morrer no envelope.
      const parsed = parseStageBFindingsWithDrop(result.findings);
      if (parsed.dropped > 0) {
        // GAP-129: o juiz devolveu mais do que o teto de ingestão aceita. Isso NÃO é "menos GAP".
        console.warn(`[spec-validation] run ${runId}: o juiz devolveu ${parsed.findings.length + parsed.dropped} achados e o teto de ingestão é ${STAGE_B_MAX_FINDINGS} — ${parsed.dropped} DESCARTADO(S). A contagem desta validação está INCOMPLETA por corte de entrada.`);
      }
      return { findings: parsed.findings, dropped: parsed.dropped, ...(renewals ? { renewals } : {}) };
    }
    if (st === "error") {
      return { findings: [], error: String(poll.data.error ?? "spec_validator error").slice(0, 300), ...(renewals ? { renewals } : {}) };
    }
    // 🔴 GAP-140: o job respondeu e NÃO terminou ⇒ está de pé do outro lado. Isso é prova de vida do
    // trabalho em curso, e é o que falta para o prazo da run acompanhar um lote longo. Espaçado por
    // `RENEW_ON_ALIVE_MS` (não a cada poll) e sempre limitado pelo teto duro contado do início.
    if (Date.now() - ultimaRenovacao >= RENEW_ON_ALIVE_MS) {
      ultimaRenovacao = Date.now();
      if (await renewValidationDeadline(pool, runId, `job ${jobId.slice(0, 8)} vivo no poll (status '${st || "?"}')`)) renewals += 1;
    }
  }
  // Único caminho que deixa `stage_b_collected_at` NULL de propósito: o job pode estar VIVO no
  // agents e o `collectStageBResults` (tick do worker) volta para buscá-lo.
  console.log(`[spec-validation] run ${runId}: espera do estágio B expirou (${VALIDATION_DEADLINE_MIN} min) — job ${jobId} fica PENDENTE de coleta (GAP-11).`);
  return { findings: [], error: "timeout do estágio adversarial (resultado pendente de coleta)", pending: true, ...(renewals ? { renewals } : {}) };
}

// ── ciclo de vida da run ──────────────────────────────────────────────────────

export type StartValidationResult =
  | {
      ok: true;
      runId: string;
      reused: boolean;
      /**
       * 🔴 GAP-44: a run devolvida é uma run JÁ EM VOO (barrada pelo one-flight) que está medindo um
       * conteúdo **anterior** ao de agora. Ela é uma run legítima — só não é a medição de quem acabou
       * de escrever. Quem REGISTRA a run como "a medição do meu passe" (o laço autônomo) tem de
       * recusá-la; quem só quer olhar uma validação (o humano) pode usá-la. Ausente = mede o conteúdo
       * atual.
       */
      staleReuse?: true;
    }
  | { ok: false; code: string; message: string; status: number };

/** Os `oversized` registrados numa cobertura (arquivos que não cabem integrais nem sozinhos). */
export function oversizedOf(rawCoverage: unknown): string[] {
  const cov = (rawCoverage ?? null) as { oversized?: unknown } | null;
  return Array.isArray(cov?.oversized) ? (cov!.oversized as string[]).filter((x) => typeof x === "string") : [];
}

/**
 * GAP-18/19: o que AINDA falta ser julgado e que uma nova rodada pode julgar.
 *
 * 🔴 A pendência é ACUMULADA (`project_spec_files.stage_b_full_sha`), nunca o `outlineOnly` de UMA
 * run: numa spec grande — a do NVX LastMile tem 950.965 chars contra um teto de 400.000 — nenhuma
 * validação isolada consegue levar todos os arquivos por inteiro, então `outlineOnly` NUNCA fica vazio
 * e um laço que olhasse só para ele jamais declararia a spec coberta, por mais rodadas que rodasse.
 * O que fecha a conta é a UNIÃO das rodadas: cada uma julga um pedaço novo e a marca fica no arquivo.
 *
 * Desconta os `oversized` da última cobertura conhecida: esses não cabem nem sozinhos, então esperar
 * por eles seria esperar para sempre — quem resolve é a divisão do arquivo (ação da Bancada).
 */
export function pendingCoverage(unjudged: string[], rawCoverage: unknown): string[] {
  const over = oversizedOf(rawCoverage);
  return unjudged.filter((p) => !over.includes(p));
}

/**
 * GAP-19: a regra do dedupe por hash. Uma run `passed` só pode ser reaproveitada se não há mais nada
 * julgável a acrescentar — senão "reaproveitar" é congelar a cobertura e devolver ao laço autônomo
 * exatamente a run que o fez pedir uma validação nova.
 */
export function canReusePassedRun(unjudged: string[], rawCoverage: unknown): boolean {
  return pendingCoverage(unjudged, rawCoverage).length === 0;
}

/** Caminho como o validador o cita (`rel_dir/filename`) — a chave da cobertura. */
function specPathOf(f: { rel_dir?: string | null; filename: string }): string {
  const dir = (f.rel_dir ?? "").replace(/^\/+|\/+$/g, "");
  return dir ? `${dir}/${f.filename}` : f.filename;
}

/**
 * GAP-19: arquivos da spec que o estágio adversarial AINDA não julgou por inteiro NO CONTEÚDO ATUAL.
 *
 * Fato acumulado entre validações (é o par `stage_b_full_sha` × sha de agora): arquivo editado depois
 * do julgamento volta a contar como não julgado — "coberto quando era outro texto" não é coberto.
 * `null` = não foi possível medir (spec sem arquivos legíveis) e quem chama deve tratar como
 * desconhecido, não como coberto.
 */
export async function unjudgedSpecFiles(
  pool: Pool,
  projectId: string,
): Promise<SpecCoverageState | null> {
  const current = await computeCurrentSpecHash(pool, projectId);
  if (!current) return null;
  return unjudgedFrom(pool, projectId, current);
}

export interface SpecCoverageState { unjudged: string[]; judged: number; total: number }

/**
 * GAP-21: cobertura pendente **só** quando o projeto de fato rastreia cobertura (existe run terminal do
 * hash atual com `stage_b_coverage`). Sem isso, `stage_b_full_sha` é NULL em toda linha e "tudo pendente"
 * seria uma mentira retroativa — spec validada antes da migração 101 travaria a promoção. `null` = regra
 * legada (não sei medir; não invento).
 */
export async function trackedCoverageState(
  db: { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  projectId: string,
): Promise<SpecCoverageState | null> {
  const current = await computeCurrentSpecHash(db, projectId);
  if (!current) return null;
  const tracked = (await db.query(
    `SELECT 1 FROM spec_validation_runs
      WHERE project_id = $1 AND spec_hash = $2 AND status IN ('passed','failed') AND stage_b_coverage IS NOT NULL
      LIMIT 1`,
    [projectId, current.specHash],
  )).rows.length > 0;
  if (!tracked) return null;
  return unjudgedFrom(db, projectId, current);
}

/** Mesma conta com a spec JÁ lida do disco (evita 2ª leitura em quem acabou de calcular o hash). */
async function unjudgedFrom(
  db: { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  projectId: string,
  current: { files: Array<SpecFileRow & { contentSha256: string }> },
): Promise<SpecCoverageState> {
  const judgedShas = await loadJudgedShas(db, projectId);
  // connect.yaml e afins não vão ao estágio B (validação por schema) — não podem contar como pendência.
  const files = current.files.filter((f) => !/\.ya?ml$/i.test(f.filename));
  const unjudged = files.filter((f) => judgedShas.get(specPathOf(f)) !== f.contentSha256).map(specPathOf);
  return { unjudged, judged: files.length - unjudged.length, total: files.length };
}

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

  // dedupe por hash: conteúdo idêntico já validado → devolve a run existente (custo zero).
  //
  // 🔴 GAP-19: "já validado" só vale se a validação anterior tiver julgado a spec INTEIRA. Com o teto
  // de janela, uma run `passed` pode ter lido 2 de 12 arquivos (medido em prod no NVX LastMile) — e aí
  // reaproveitá-la não é economia, é congelar a cobertura: a rotação do `buildValidationInput` nunca
  // chegaria aos arquivos grandes, e o laço autônomo receberia de volta a MESMA run que o fez pedir
  // uma nova validação. Cobertura incompleta ⇒ vale rodar de novo, porque a rodada nova julga
  // arquivos DIFERENTES. Exceção: se o que falta são só arquivos que não cabem nem sozinhos
  // (`oversized`), rodar de novo não acrescenta nada — o dedupe volta a valer.
  const dup = await pool.query(
    `SELECT id, stage_b_coverage FROM spec_validation_runs
      WHERE project_id = $1 AND spec_hash = $2 AND status = 'passed'
      ORDER BY created_at DESC LIMIT 1`,
    [projectId, current.specHash],
  );
  if (dup.rows[0]) {
    const judged = await loadJudgedShas(pool, projectId);
    const unjudged = current.files
      .filter((f) => !/\.ya?ml$/i.test(f.filename))
      .filter((f) => judged.get(specPathOf(f)) !== f.contentSha256)
      .map(specPathOf);
    if (canReusePassedRun(unjudged, dup.rows[0].stage_b_coverage)) {
      return { ok: true, runId: dup.rows[0].id as string, reused: true };
    }
    const pend = pendingCoverage(unjudged, dup.rows[0].stage_b_coverage).length;
    console.log(`[spec-validation] ${projectId.slice(0, 8)}: run 'passed' de mesmo hash, mas ${pend} arquivo(s) da spec nunca foram julgados por inteiro neste conteúdo — validando de novo para cobrir o que faltou (GAP-19).`);
  }

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
        "SELECT id, spec_hash FROM spec_validation_runs WHERE project_id = $1 AND status IN ('pending','running') LIMIT 1",
        [projectId],
      );
      if (running.rows[0]) {
        // 🔴 GAP-44: o one-flight é por PROJETO, não por conteúdo — a run em voo pode ter começado
        // ANTES desta escrita. Medido em prod (NVX LastMile): a validação `a17bf391` nasceu 05:58, o
        // passe 0 da run de autonomia `fb57dec7` reescreveu 7 arquivos entre 06:02 e 06:13, pediu
        // validação e recebeu de volta `a17bf391` — uma leitura que não viu UM byte do que o passe
        // escreveu. O `spec_hash` é o fato que separa "validação em voo" de "medição deste conteúdo".
        const same = String(running.rows[0].spec_hash ?? "") === current.specHash;
        return same
          ? { ok: true, runId: running.rows[0].id as string, reused: true }
          : { ok: true, runId: running.rows[0].id as string, reused: true, staleReuse: true };
      }
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

/**
 * GAP-18: quais arquivos deste projeto JÁ foram julgados integralmente pelo estágio adversarial, e
 * com qual conteúdo. Coluna ausente (migração 101 não aplicada) → mapa vazio = ninguém julgado, que é
 * exatamente o comportamento legado (ordem só por tamanho).
 */
async function loadJudgedShas(
  pool: { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  projectId: string,
): Promise<Map<string, string>> {
  try {
    const rows = (await pool.query(
      "SELECT rel_dir, filename, stage_b_full_sha FROM project_spec_files WHERE project_id = $1",
      [projectId],
    )).rows as unknown as Array<{ rel_dir: string | null; filename: string; stage_b_full_sha: string | null }>;
    const out = new Map<string, string>();
    for (const r of rows) {
      if (!r.stage_b_full_sha) continue;
      const dir = (r.rel_dir ?? "").replace(/^\/+|\/+$/g, "");
      out.set(dir ? `${dir}/${r.filename}` : r.filename, r.stage_b_full_sha);
    }
    return out;
  } catch (e) {
    console.warn(`[spec-validation] ${projectId.slice(0, 8)}: stage_b_full_sha indisponível (${e instanceof Error ? e.message : String(e)}) — cobertura sem rotação nesta rodada.`);
    return new Map();
  }
}

/**
 * GAP-42: quando cada arquivo foi ESCRITO por último (o snapshot mais recente da migração 092, que é
 * tirado no caminho da escrita). Vira o FIFO da 1ª fila de promoção do `buildValidationInput`: entre os
 * arquivos que ninguém julgou no conteúdo atual, entra primeiro quem está esperando medição há mais
 * tempo. Sem isto a ordem é só por tamanho e o laço mede tudo MENOS os arquivos grandes que acabou de
 * corrigir (medido em prod: 15 findings de `privacidade-lgpd.md` idênticos antes e depois da correção).
 *
 * Falha/tabela ausente devolve mapa vazio ⇒ ordem legada por tamanho. Nunca derruba a validação.
 */
async function loadLastWrites(
  pool: { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  projectId: string,
): Promise<Map<string, string>> {
  try {
    const rows = (await pool.query(
      `SELECT f.rel_dir, f.filename, max(s.created_at) AS last_write
         FROM project_spec_files f
         JOIN project_spec_snapshots s
           ON s.project_id = f.project_id AND s.file_path = f.file_path
        WHERE f.project_id = $1
        GROUP BY f.rel_dir, f.filename`,
      [projectId],
    )).rows as unknown as Array<{ rel_dir: string | null; filename: string; last_write: Date | string | null }>;
    const out = new Map<string, string>();
    for (const r of rows) {
      if (!r.last_write) continue;
      const dir = (r.rel_dir ?? "").replace(/^\/+|\/+$/g, "");
      const iso = r.last_write instanceof Date ? r.last_write.toISOString() : String(r.last_write);
      out.set(dir ? `${dir}/${r.filename}` : r.filename, iso);
    }
    return out;
  } catch (e) {
    console.warn(`[spec-validation] ${projectId.slice(0, 8)}: histórico de escrita indisponível (${e instanceof Error ? e.message : String(e)}) — promoção só por tamanho nesta rodada.`);
    return new Map();
  }
}

/**
 * GAP-18: registra que ESTES arquivos foram julgados integralmente NESTE conteúdo. O sha é o do texto
 * que foi ao validador — se o arquivo mudar depois, ele volta a contar como não julgado (é a diferença
 * entre "coberto" e "coberto quando era outro texto").
 */
async function markFilesJudged(pool: Pool, projectId: string, fullShas: Record<string, string>): Promise<void> {
  for (const [path, sha] of Object.entries(fullShas)) {
    const i = path.lastIndexOf("/");
    const relDir = i >= 0 ? path.slice(0, i) : "";
    const filename = i >= 0 ? path.slice(i + 1) : path;
    await pool.query(
      `UPDATE project_spec_files SET stage_b_full_sha = $4, stage_b_full_at = now()
        WHERE project_id = $1 AND coalesce(rel_dir, '') = $2 AND filename = $3`,
      [projectId, relDir, filename, sha],
    ).catch((e) => console.warn(`[spec-validation] ${projectId.slice(0, 8)}: cobertura de '${path}' não gravada (${e instanceof Error ? e.message : String(e)}).`));
  }
}

/**
 * A forma de `spec_validation_runs.stage_b_coverage`. `pendingFullShas`/`notMeasured`/`batches` são de
 * C3/C7 e podem faltar (coberturas gravadas antes, e o caminho de uma chamada só, não os têm).
 */
interface StageBCoverage {
  full?: string[];
  outlineOnly?: string[];
  oversized?: string[];
  totalChars?: number;
  cap?: number;
  batches?: number;
  fullShas?: Record<string, string>;
  pendingFullShas?: Record<string, string>;
  notMeasured?: Array<{ file: string; reason: string }>;
}

/**
 * C3: um lote pendente cujo resultado o coletor recuperou passa de `nao_medido` a MEDIDO. Reescreve a
 * cobertura da run: `full`/`fullShas` ganham os arquivos do lote, `notMeasured` perde exatamente esses,
 * e `pendingFullShas` sai (não há mais nada devido). Best-effort: falhar aqui não desfaz a recuperação
 * dos findings — só deixa a coluna conservadora (dizendo que menos foi lido do que foi).
 */
async function mergeRecoveredCoverage(pool: Pool, runId: string, cov: StageBCoverage): Promise<void> {
  const pend = cov.pendingFullShas ?? {};
  const paths = Object.keys(pend);
  if (paths.length === 0) return;
  const full = [...new Set([...(cov.full ?? []), ...paths])];
  const novo: StageBCoverage = {
    ...cov,
    full,
    outlineOnly: (cov.outlineOnly ?? []).filter((p) => !paths.includes(p)),
    fullShas: { ...(cov.fullShas ?? {}), ...pend },
    notMeasured: (cov.notMeasured ?? []).filter((n) => !paths.includes(n.file)),
  };
  delete novo.pendingFullShas;
  if ((novo.notMeasured ?? []).length === 0) delete novo.notMeasured;
  await pool.query(
    "UPDATE spec_validation_runs SET stage_b_coverage = $2::jsonb WHERE id = $1",
    [runId, JSON.stringify(novo)],
  ).catch((e) => console.warn(`[spec-validation] run ${String(runId).slice(0, 8)}: cobertura do lote recuperado não regravada (${e instanceof Error ? e.message : String(e)}).`));
}

/**
 * 🔴 C2 — grava a auditoria do colapso de duplicata. `true` = está no banco.
 *
 * O chamador só encolhe a lista de findings quando isto devolve `true`: fusão sem registro é
 * indistinguível de perda silenciosa. `jsonb_set` com `coalesce` porque uma validação em que o
 * estágio B não rodou não tem `stage_b_coverage`, e o registro do C2 vale igual.
 */
async function gravaAuditoriaColapso(pool: Pool, runId: string, audit: unknown): Promise<boolean> {
  try {
    await pool.query(
      `UPDATE spec_validation_runs
          SET stage_b_coverage = jsonb_set(coalesce(stage_b_coverage, '{}'::jsonb), '{duplicateCollapse}', $2::jsonb, true)
        WHERE id = $1`,
      [runId, JSON.stringify(audit)],
    );
    return true;
  } catch (e) {
    console.warn(`[spec-validation] run ${String(runId).slice(0, 8)}: auditoria do C2 não gravada (${e instanceof Error ? e.message : String(e)}).`);
    return false;
  }
}

async function processValidationRun(pool: Pool, runId: string, projectId: string, startHash: string): Promise<void> {
  const current = await computeCurrentSpecHash(pool, projectId);
  const files = current?.files ?? [];
  const extraRow = (await pool.query("SELECT extra FROM projects WHERE id = $1", [projectId])).rows[0] as { extra?: Record<string, unknown> | null } | undefined;
  const isEvolution = extraRow?.extra?.evolution === true;
  // `let` por causa do C2: o colapso de duplicata substitui a lista inteira (nunca muta em lugar,
  // para que a lista CRUA continue sendo o valor de fallback quando o agente não responde).
  let findings: ValidationFinding[] = runStageA(files, { evolution: isEvolution });

  // Estágio B só quando o A não achou blocker estrutural (economiza LLM em spec quebrada)
  const hasStageABlocker = findings.some((f) => f.severity === "blocker");
  let stageBError: string | undefined;
  // GAP-13 (migração 099): pular o estágio adversarial é uma decisão CORRETA, mas muda a SUPERFÍCIE
  // medida — e quem compara contagens entre validações (o modo autônomo) precisa saber disso. Zero
  // findings de B não distingue "B não rodou" de "B rodou e não achou nada": o fato tem de ser dito.
  let stageBRan = false;
  /**
   * 🔴 C7 — arquivo que ENTROU num lote do estágio B e cuja leitura NÃO voltou. É o estado `nao_medido`
   * da §3 do plano: não é fechado, não é "trabalhado", e não pode virar ausência silenciosa. Vai para
   * `stage_b_coverage.notMeasured` com o motivo, e o arquivo continua pendente no acumulado.
   */
  const naoMedido: Array<{ file: string; reason: string }> = [];
  /** GAP-129: total de achados que o teto de ingestão descartou, somado nos lotes. */
  let descartados = 0;
  /** GAP-136: quantas vezes o prazo da run foi empurrado por progresso medido (0 = nenhuma). */
  let renovacoes = 0;
  if (!hasStageABlocker && files.length > 0) {
    const { partitionValidationInput } = await import("./specValidationInput.js");
    const judged = await loadJudgedShas(pool, projectId);
    const lastWrite = await loadLastWrites(pool, projectId);
    const candidates = files
      // R4 PR3: connect.yaml é machine-readable (validado por schema, não por LLM) — fora do estágio B.
      .filter((f) => !/\.ya?ml$/i.test(f.filename))
      .map((f) => {
        const path = `${f.rel_dir ? f.rel_dir + "/" : ""}${f.filename}`;
        return {
          path, content: f.content, sha: f.contentSha256,
          judged: judged.get(path) === f.contentSha256,
          pendingSince: lastWrite.get(path) ?? null,
        };
      });
    // 🔴 C3 (D4): a spec vira N LOTES que cabem INTEIROS, em vez de uma janela só que encolhia
    // conforme a spec crescia (medido: `full` 3→3→2→2 de 12 arquivos). Spec que cabe numa chamada
    // continua sendo UMA chamada — `partitionValidationInput` devolve um lote só nesse caso.
    const lotes = partitionValidationInput(candidates);
    const primeiro = lotes[0];
    const shaOf = new Map(candidates.map((c) => [c.path, c.sha]));
    const shasDe = (paths: string[]): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const p of paths) out[p] = shaOf.get(p) ?? "";
      return out;
    };
    /** União dos arquivos que ALGUM lote leva integral (o que esta validação se propõe a cobrir). */
    const planejados = [...new Set(lotes.flatMap((l) => l.full))];
    // 🔴 GAP-17/GAP-18: aqui existia um finding SINTÉTICO ("spec maior que a janela"). Ele contava
    // como GAP 🟡 ATIVO — sustentava rodada nova do modo autônomo —, nascia com `file: ""` e por isso
    // ia ao roteador LLM em TODA validação (medido em prod: uma chamada `opus-5` por rodada só para
    // apontá-lo ao arquivo primário), onde o CTO-editor não tinha como resolvê-lo: não é defeito da
    // spec, é propriedade da MEDIÇÃO. Com ele na lista, "GAPs = 0" era inalcançável por construção.
    // Fato de medição vira METADADO da run (como o `stage_b_ran` do GAP-13), não achado.
    const gravaCobertura = async (cov: Record<string, unknown>): Promise<void> => {
      await pool.query(
        "UPDATE spec_validation_runs SET stage_b_coverage = $2::jsonb WHERE id = $1",
        [runId, JSON.stringify(cov)],
      ).catch((e) => console.warn(`[spec-validation] run ${runId}: stage_b_coverage não gravada (${e instanceof Error ? e.message : String(e)}) — o laço autônomo tratará a cobertura como desconhecida.`));
    };
    const base = {
      oversized: primeiro.oversized, totalChars: primeiro.totalChars, cap: primeiro.cap,
      batches: lotes.length,
    };
    // A cobertura PLANEJADA é gravada antes de gastar LLM (como antes deste GAP): se a api morrer no
    // meio, a linha já diz o que esta run se propôs a ler. O que vale como "julgado" nunca vem daqui —
    // vem de `markFilesJudged`, que só roda com resultado na mão.
    await gravaCobertura({
      ...base, full: planejados,
      outlineOnly: candidates.map((c) => c.path).filter((p) => !planejados.includes(p)),
      fullShas: shasDe(planejados),
    });
    const foraDeTodos = candidates.map((c) => c.path).filter((p) => !planejados.includes(p));
    if (foraDeTodos.length > 0) {
      // GAP-10: o humano tem de VER que a spec passou do que cabe numa validação — antes isso era
      // um `slice` silencioso e o sintoma chegava como blocker falso de "arquivo ausente".
      console.log(`[spec-validation] ${projectId.slice(0, 8)}: spec com ${primeiro.totalChars} chars e teto de janela ${primeiro.cap} — ${lotes.length} lote(s) cobrem ${planejados.length} arquivo(s) integrais; ${foraDeTodos.length} fora de todos os lotes: ${foraDeTodos.join(", ")}`);
    } else if (lotes.length > 1) {
      console.log(`[spec-validation] ${projectId.slice(0, 8)}: spec com ${primeiro.totalChars} chars > teto de janela (${primeiro.cap}) — ${lotes.length} lote(s) de estágio B cobrem os ${planejados.length} arquivo(s) por INTEIRO nesta validação (C3).`);
    }
    // GAP-39: os GAPs hoje ATIVOS, restritos aos arquivos que o LOTE lê por INTEIRO, viajam com a spec
    // para que o juiz reutilize o anchor do defeito que reencontrar. Falha aqui não pode derrubar a
    // validação — sem a lista o comportamento é o anterior (identidade por redação).
    const ativos = await projectFindingsState(pool, projectId, { currentFiles: candidates.map((c) => c.path) })
      .then((st) => st.findings)
      .catch((e) => {
        console.warn(`[spec-validation] run ${runId}: lista de continuidade não montada (${e instanceof Error ? e.message : String(e)}) — juiz sem anchors anteriores.`);
        return [] as Awaited<ReturnType<typeof projectFindingsState>>["findings"];
      });

    const medidos: string[] = [];
    let pendente: { erro: string; shas: Record<string, string> } | null = null;
    let primeiroErro: string | undefined;
    for (const [i, lote] of lotes.entries()) {
      const rotulo = lotes.length > 1 ? ` lote ${i + 1}/${lotes.length}` : "";
      // 🔴 C7 — um lote que ficou PENDENTE de coleta interrompe o despacho: `agents_job_id` é uma
      // coluna só, e sobrescrevê-la jogaria no lixo uma leitura adversarial JÁ PAGA (é o GAP-11).
      // Os arquivos dos lotes que não foram despachados ficam `nao_medido` VISÍVEL — nunca ausência
      // silenciosa. Eles seguem pendentes no acumulado, então a validação seguinte os pega.
      if (pendente) {
        for (const p of lote.full) naoMedido.push({ file: p, reason: `lote não despachado: o${rotulo} anterior ficou pendente de coleta` });
        continue;
      }
      const known = knownFindingsForJudge(ativos, lote.full);
      if (known.length) console.log(`[spec-validation] run ${runId}:${rotulo} ${known.length} finding(s) ativo(s) enviados como continuidade de anchor (GAP-39).`);
      // 🔴 GAP-136: o esperador deste lote tem seu PRÓPRIO teto de VALIDATION_DEADLINE_MIN. Sem
      // empurrar o prazo da RUN aqui, o lote 2 em diante trabalha com prazo já gasto pelos anteriores
      // e o watchdog derruba a run no meio de uma leitura que está progredindo. O teto duro
      // (VALIDATION_MAX_MIN desde o início) é o que impede isso de virar "sem prazo".
      if (i > 0 && await renewValidationDeadline(pool, runId, `lote ${i + 1}/${lotes.length} despachado`)) renovacoes += 1;
      const b = await runStageB(pool, runId, projectId, lote.text, known);
      renovacoes += b.renewals ?? 0; // GAP-140: renovação por prova de vida conta como as outras
      if (b.error) {
        primeiroErro ??= b.error;
        // C7: a falha é do LOTE, e ela nomeia os arquivos que ficaram sem medição neste conteúdo.
        for (const p of lote.full) naoMedido.push({ file: p, reason: b.error });
        if (b.pending) pendente = { erro: b.error, shas: shasDe(lote.full) };
        console.warn(`[spec-validation] run ${runId}:${rotulo} estágio B não mediu ${lote.full.length} arquivo(s) (${b.error}).`);
        continue;
      }
      findings.push(...b.findings); // UNIÃO — o LLM só ADICIONA, nunca remove o estágio A
      descartados += b.dropped ?? 0; // GAP-129: descarte por teto de ingestão NÃO é "menos GAP"
      stageBRan = true;
      medidos.push(...lote.full);
      // Só marca cobertura quando o juiz REALMENTE devolveu. Erro/timeout deixa a marca para o coletor
      // (GAP-11): resultado pago que chega depois também cobre esses arquivos.
      await markFilesJudged(pool, projectId, shasDe(lote.full));
    }

    // 🔴 C7 — o que a run pode dizer de si: `error` só quando NENHUM lote mediu (aí a validação não
    // aconteceu) ou quando há resultado PENDENTE (aí o coletor precisa reencontrar a run, e o filtro
    // dele é o status). Lote que falhou de forma definitiva com outros medidos NÃO derruba a
    // validação — ele aparece como `notMeasured`, que é o estado honesto: nem fechado, nem trabalhado.
    stageBError = pendente ? pendente.erro : stageBRan ? undefined : primeiroErro;
    await gravaCobertura({
      ...base, full: medidos,
      outlineOnly: candidates.map((c) => c.path).filter((p) => !medidos.includes(p)),
      fullShas: shasDe(medidos),
      // Só o coletor consome: são os arquivos cujo resultado ainda pode chegar. Sem separar isto de
      // `fullShas`, uma recuperação marcaria como julgados também os arquivos de lotes que falharam.
      ...(pendente ? { pendingFullShas: pendente.shas } : {}),
      ...(naoMedido.length ? { notMeasured: naoMedido } : {}),
      // 🔴 GAP-129: achados que o juiz produziu e o teto de ingestão descartou. Fica na cobertura
      // porque é FATO DE MEDIÇÃO (como `notMeasured`): a contagem desta validação está incompleta.
      ...(descartados > 0 ? { droppedFindings: descartados, droppedCap: STAGE_B_MAX_FINDINGS } : {}),
      // 🔴 GAP-136: prazo que se move tem de aparecer. Quem lê a run depois precisa saber que ela
      // custou mais de um prazo — e quantos.
      ...(renovacoes > 0 ? { deadlineRenewals: renovacoes, deadlineMaxMin: VALIDATION_MAX_MIN } : {}),
    });
    // O assunto do estágio B só se encerra quando não há nada pendente de coleta (GAP-11).
    if (!pendente) await markStageBCollected(pool, runId);
    if (naoMedido.length > 0) {
      console.log(`[spec-validation] run ${runId}: ${naoMedido.length} arquivo(s) NÃO MEDIDOS nesta validação — ${naoMedido.map((n) => n.file).join(", ")}. Eles seguem pendentes no acumulado (não contam como julgados nem como fechados).`);
    }
  }

  // ── Estágio O (F3, item 3A): o que a EXECUÇÃO REAL do produto já provou ───────────────────────
  // Os estágios A e B leem a spec. Nenhum dos dois pode decidir uma constraint de `build`/`runtime`
  // — e na spec real do NVX LastMile as 119 constraints declaradas são exatamente destas (0 `spec`).
  // Quando a Fábrica constrói e o executor isolado RODA o produto, a falha medida volta como GAP aqui.
  // UNIÃO pura, como o estágio B: o oráculo só ADICIONA, e falhar em carregá-lo deixa tudo como antes.
  try {
    const { loadOracleFindings } = await import("./specOracle.js");
    const vivos = files.map((f) => `${f.rel_dir ? f.rel_dir + "/" : ""}${f.filename}`);
    const doOraculo = await loadOracleFindings(pool, projectId, startHash, vivos);
    if (doOraculo.length > 0) {
      findings.push(...doOraculo);
      console.log(`[spec-validation] run ${runId}: ${doOraculo.length} finding(s) da EXECUÇÃO REAL do produto (estágio O) unidos aos estágios A/B.`);
    }
  } catch (e) {
    console.warn(`[spec-validation] run ${runId}: findings do oráculo não carregados (${e instanceof Error ? e.message : String(e)}) — validação segue só com os estágios A e B.`);
  }

  // ── C2: o MESMO defeito contado 3× na MESMA validação ─────────────────────────────────────────
  // Roda sobre a UNIÃO completa (estágio A + todos os lotes do B + oráculo) porque é o único ponto
  // que vê duplicata cross-lote. Quem decide identidade é o AGENTE (`collapseDuplicateFindings`); o
  // código só transporta e veta corrupção. Falhar aqui deixa a lista CRUA — duplicata infla a
  // contagem, perder finding é pior. Ver [[genesis-diagnostico-laco-nao-fecha-cobertura-monopolizada-2026-09-08]].
  let colapso: { collapsed: unknown[]; vetoed: unknown[]; model: string | null; ran: boolean; reason?: string } | null = null;
  if (findings.length >= 2) {
    try {
      const { collapseDuplicateFindings } = await import("./gapContinuity.js");
      const llmC2 = agentsLlmFields(await resolveWorkbenchLlm({ projectId }));
      const r = await collapseDuplicateFindings(findings, { llm: llmC2 });
      colapso = { collapsed: r.collapsed, vetoed: r.vetoed, model: r.model, ran: r.ran, reason: r.reason };
      if (r.ran && r.collapsed.length > 0) {
        // 🔴 A ordem importa: a auditoria é gravada ANTES de a lista encolher. Se o registro não
        // entrar no banco, o colapso NÃO é aplicado — fusão sem prova é indistinguível de perda
        // silenciosa, que é exatamente o fechamento fake que este trabalho existe para matar.
        const auditada = await gravaAuditoriaColapso(pool, runId, colapso);
        if (auditada) {
          console.log(`[spec-validation] run ${runId}: C2 colapsou ${r.collapsed.length} duplicata(s) — ${findings.length} → ${r.findings.length} finding(s). Fusões: ${r.collapsed.map((c) => `"${c.dropped.title}" (${c.dropped.anchor ?? "sem âncora"}) → "${c.kept.title}" (${c.kept.anchor ?? "sem âncora"}): ${c.why}`).join(" | ")}`);
          findings = r.findings;
        } else {
          console.warn(`[spec-validation] run ${runId}: C2 achou ${r.collapsed.length} duplicata(s) mas a auditoria não foi gravada — colapso NÃO aplicado, a lista segue CRUA (com duplicata).`);
        }
        colapso = null; // já gravado (ou desistido) aqui; não regravar depois
      } else if (!r.ran) {
        console.warn(`[spec-validation] run ${runId}: C2 NÃO rodou (${r.reason}) — a contagem desta validação pode conter o mesmo defeito mais de uma vez.`);
      }
    } catch (e) {
      console.warn(`[spec-validation] run ${runId}: C2 indisponível (${e instanceof Error ? e.message : String(e)}) — lista de findings segue CRUA.`);
    }
  }

  // TOCTOU: recomputa o hash ao FINAL — editou durante a validação → superseded (não é erro)
  const after = await computeCurrentSpecHash(pool, projectId);
  const finalStatus = stageBError
    ? "error"
    : after?.specHash !== startHash
      ? "superseded"
      : findings.some((f) => f.severity === "blocker") ? "failed" : "passed";

  await writeValidationResult(pool, runId, finalStatus, findings, stageBRan, renovacoes);
  // Nada foi colapsado (zero duplicata, ou o agente não respondeu): o registro do C2 vale igual, é o
  // que distingue "não havia duplicata" de "ninguém procurou".
  if (colapso) await gravaAuditoriaColapso(pool, runId, colapso);
  if (!stageBRan && finalStatus === "failed") {
    // GAP-13: o log diz em voz alta o que a coluna guarda — esta contagem NÃO é comparável.
    console.log(`[spec-validation] run ${runId}: estágio B não rodou (blocker estrutural do A) — ${findings.length} finding(s) sobre superfície PARCIAL.`);
  }
  // RFC-0005 (G2): supressão é PÓS-PROCESSAMENTO — findings que reincidem sobre um Refutado vivo
  // contam reincidência (a leitura já os mostra como Refutados; a run continua snapshot imutável).
  if (finalStatus === "passed" || finalStatus === "failed") {
    await registerRecurrences(pool, projectId, findings).catch((e) =>
      console.warn(`[spec-validation] run ${runId}: registerRecurrences falhou (não crítico): ${e instanceof Error ? e.message : String(e)}`));
    await auditCrossFamily(pool, projectId, runId, findings);
  }
  if (stageBError) {
    console.warn(`[spec-validation] run ${runId}: estágio B falhou (${stageBError}) — run marcada 'error'.`);
  }
}

/**
 * 🔴 GAP-137 — a gravação do resultado era `WHERE status = 'running'` e o descarte era MUDO.
 *
 * Medido em prod 2026-09-09: a run `8fbdfc21` foi expirada pelo watchdog às 03:52:35 (GAP-136); este
 * processo seguiu vivo, terminou os 4 lotes, colapsou duplicatas e auditou 40 findings com o revisor
 * cross-family às 03:56:10 — e então o UPDATE final casou ZERO linhas, porque o status já não era
 * `running`. Quatro leituras adversariais pagas, 35 achados confirmados como presentes por uma
 * segunda família de modelo, e a linha ficou `error` com `findings = []`. A Bancada mostrou
 * "GAPs (0)", indistinguível de spec limpa. **Perder trabalho pago é ruim; perdê-lo em silêncio é
 * fechamento fake.**
 *
 * A guarda existe para não sobrescrever resultado que OUTRO escritor já gravou (o coletor do GAP-11).
 * O discriminador correto não é o status — é "ninguém gravou achado nesta linha ainda".
 * `error`/`interrupted` com lista VAZIA é exatamente a run que o watchdog derrubou e que este
 * processo, o dono legítimo, ainda pode fechar. E o `rowCount` passa a ser CONFERIDO: se a escrita
 * não pegar, o log diz quantos findings foram descartados e em que estado a linha já estava.
 *
 * Devolve `true` se o resultado desta execução ficou gravado.
 */
export async function writeValidationResult(
  pool: Pool,
  runId: string,
  finalStatus: string,
  findings: ValidationFinding[],
  stageBRan: boolean,
  renovacoes = 0,
): Promise<boolean> {
  const escrita = await pool.query(
    `UPDATE spec_validation_runs
        SET status = $1, findings = $2::jsonb, stage_b_ran = $4::boolean, finished_at = now()
      WHERE id = $3
        AND (status = 'running'
             OR (status IN ('error','interrupted')
                 AND COALESCE(jsonb_array_length(findings), 0) = 0))`,
    [finalStatus, JSON.stringify(findings), runId, stageBRan],
  );
  if (escrita.rowCount === 0) {
    const atual = (await pool.query(
      "SELECT status, COALESCE(jsonb_array_length(findings), 0) AS n FROM spec_validation_runs WHERE id = $1",
      [runId],
    ).catch(() => ({ rows: [] as Array<{ status?: string; n?: number }> }))).rows[0];
    console.warn(`[spec-validation] run ${runId}: resultado NÃO gravado — ${findings.length} finding(s) desta execução foram DESCARTADOS porque a linha já está em '${atual?.status ?? "?"}' com ${atual?.n ?? "?"} finding(s) (outro escritor fechou a run antes). Nada foi perdido em silêncio: esta é a linha que diz.`);
    return false;
  }
  if (finalStatus !== "error") {
    // GAP-136/137: a run passou do prazo, foi declarada morta e VOLTOU com resultado. Dizer isso é o
    // que liga o sintoma ("Erro na validação") à causa (prazo curto para spec em N lotes).
    console.log(`[spec-validation] run ${runId}: resultado gravado como '${finalStatus}' com ${findings.length} finding(s)${renovacoes > 0 ? ` (o prazo foi renovado ${renovacoes}× por progresso — GAP-136)` : ""}.`);
  }
  return true;
}

/**
 * REVISOR CROSS-FAMILY (2026-09-07) — mede o NOSSO juiz com um modelo de outra família.
 *
 * Por que aqui: é o único ponto onde os findings da validação já estão gravados e ainda sabemos
 * qual conteúdo foi julgado. `SPEC_CROSS_AUDIT=on` desliga/liga sem deploy, e nesta primeira
 * versão a auditoria **só registra** — nenhuma decisão do laço muda. Medir antes de gatear: liberar
 * GAP com base em número que ainda não existe seria a anistia que o Jean proibiu.
 *
 * Best-effort por desenho: a auditoria é ACESSÓRIA à validação. Se o modelo de outra família
 * estiver fora do ar, a validação Claude vale integralmente e a crítica original continua de pé.
 */
async function auditCrossFamily(
  pool: Pool, projectId: string, runId: string, findings: ValidationFinding[],
): Promise<void> {
  try {
    const { auditFindings, tally } = await import("./crossFamilyAudit.js");
    const res = await auditFindings(pool as unknown as Parameters<typeof auditFindings>[0], {
      projectId, findings, validationRunId: runId,
    });
    if (!res.ran) {
      if (res.reason && res.reason !== "SPEC_CROSS_AUDIT != on") {
        console.log(`[spec-validation] run ${runId}: auditoria cross-family não rodou — ${res.reason}.`);
      }
      return;
    }
    const t = tally(res.audits);
    // O log declara os DOIS lados do equilíbrio na mesma linha: quanto do que chamamos de
    // importante uma segunda família confirma como GRAVE, e quanto ela diz que não existe no texto.
    console.log(
      `[spec-validation] run ${runId}: auditoria cross-family (${res.model}) — ${t.total} auditado(s), ` +
      `presente=${t.presente} (grave=${t.grave} moderada=${t.moderada} cosmetica=${t.cosmetica}), ` +
      `ausente=${t.ausente} (com prova verbatim=${t.ausenteComProva}), indecidivel=${t.indecidivel}, ` +
      `pulado=${res.skipped}, falha=${res.failed}. NADA foi liberado: esta versão só MEDE.`,
    );
  } catch (e) {
    console.warn(`[spec-validation] run ${runId}: auditoria cross-family falhou (não crítico): ${e instanceof Error ? e.message : String(e)}`);
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

// ── GAP-11: coletor server-side do estágio B ─────────────────────────────────

/** Teto DURO depois do deadline: passado isto, desistimos do job e a run para de segurar o laço. */
const STAGE_B_COLLECT_GRACE_MIN = parseInt(process.env.SPEC_VALIDATION_COLLECT_GRACE_MIN ?? "15", 10);

/**
 * GAP-66 — idade do sinal de vida a partir da qual uma run `pending`/`running` é considerada ÓRFÃ.
 *
 * Pior caso LEGÍTIMO de intervalo entre dois heartbeats de `runStageB`: 8 s de espera + 30 s de
 * timeout do HTTP ≈ 38 s. O default de 120 s dá fator ~3 sobre isso, então um esperador vivo mas
 * lento nunca é confundido com um morto — e ainda assim troca ~20 min de espera morta por ~2 min.
 */
const STAGE_B_LEASE_SEC = parseInt(process.env.SPEC_VALIDATION_STAGEB_LEASE_SEC ?? "120", 10);

export type StageBProbe = (jobId: string) => Promise<
  { status: string; result?: Record<string, unknown>; error?: string } | "not_found"
>;

async function defaultStageBProbe(jobId: string): ReturnType<StageBProbe> {
  const base = (process.env.API_AGENTS_URL ?? "").trim().replace(/\/$/, "");
  if (!base) throw new Error("API_AGENTS_URL ausente");
  const r = await httpJson(`${base}/invoke/spec_validator/status/${jobId}`, "GET", undefined, 30_000);
  if (r.status === 404) return "not_found";
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  return {
    status: String(r.data.status ?? ""),
    result: (r.data.result ?? {}) as Record<string, unknown>,
    error: r.data.error === undefined || r.data.error === null ? undefined : String(r.data.error),
  };
}

/**
 * GAP-11 — o teto expira a ESPERA do estágio adversarial, nunca o RESULTADO.
 *
 * Medido em prod 2026-09-06: a validação `16e467cf` esperou 20m40s (as reais deste projeto levam
 * ~5 min), estourou o deadline e terminou `error` com 0 findings — enquanto o job do LLM seguia vivo
 * no serviço agents. Uma leitura adversarial inteira, já paga, foi para o lixo, e o laço autônomo
 * contou a rodada como "sem medição de GAPs". Mesma família do defeito do chat da Bancada.
 *
 * Molde: `collectSpecChatJobsTick` / `collectSpecSplitsTick` (probe injetável, nunca lança).
 * Só toca runs COM `agents_job_id` e ainda não coletadas.
 *
 * ## GAP-66 (2026-09-07) — run ÓRFÃ também é coletável, e o critério é heartbeat, não status
 *
 * A varredura original exigia `status IN ('error','interrupted')`, ou seja, só olhava run já MORTA.
 * Uma validação orfanada por restart da api continua `running` até `expireOverdueValidationRuns`
 * virá-la `error` **no deadline** — então o laço autônomo esperava ~20 min por um resultado que já
 * estava recuperável no instante seguinte ao restart (medido em prod: o resultado veio, 22 findings,
 * `stage_b_ran = true`; o defeito não é perda, é LATÊNCIA).
 *
 * Incluir `running` às cegas seria pior: `runStageB` tem um esperador EM PROCESSO pollando o mesmo
 * job a cada 8 s, e dois escritores na mesma linha é corrupção. O que caracteriza a órfã não é o
 * status, é o esperador estar MORTO — fato que só se conhece por sinal de vida. Daí o lease:
 * `pending`/`running` só entra quando `COALESCE(stage_b_polled_at, started_at)` está mais velho que
 * `STAGE_B_LEASE_SEC`. Vale com N réplicas, porque o critério é da LINHA, não do processo.
 */
export async function collectStageBResults(
  pool: Pool,
  probe: StageBProbe = defaultStageBProbe,
): Promise<{ scanned: number; collected: number; lost: number; givenUp: number }> {
  const out = { scanned: 0, collected: 0, lost: 0, givenUp: 0 };
  let rows: Array<{ id: string; project_id: string | null; spec_hash: string; agents_job_id: string; findings: unknown; deadline_at: string | null; stage_b_coverage: unknown; status: string }>;
  try {
    rows = (await pool.query(
      `SELECT id, project_id, spec_hash, agents_job_id, findings, deadline_at, stage_b_coverage, status
         FROM spec_validation_runs
        WHERE agents_job_id IS NOT NULL
          AND stage_b_collected_at IS NULL
          AND status IN ('error', 'interrupted', 'pending', 'running')
          -- 🔴 GAP-138: o lease vale para TODOS os status, não só para os em voo. Medido em prod
          -- 2026-09-09: às 03:52:35 o watchdog virou a run 8fbdfc21 em "error" (prazo curto,
          -- GAP-136) enquanto o esperador EM PROCESSO seguia vivo pollando o MESMO job — e o
          -- coletor, que não pedia sinal de vida para "error", entrou como SEGUNDO escritor da
          -- linha (logs "sigo aguardando" às 03:52:46, 03:53:06, 03:53:26, 03:53:46 vindos dos
          -- dois). Status é opinião do watchdog; heartbeat é fato sobre quem está trabalhando.
          AND COALESCE(stage_b_polled_at, started_at) < now() - ($1 || ' seconds')::interval
        ORDER BY finished_at ASC NULLS FIRST
        LIMIT 5`,
      [String(Math.max(30, STAGE_B_LEASE_SEC))],
    )).rows as typeof rows;
  } catch (e) {
    // Coluna ausente (migração 100 não aplicada) não pode derrubar o tick do worker.
    console.warn(`[spec-validation] coleta do estágio B falhou na varredura: ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
  out.scanned = rows.length;
  for (const r of rows) {
    const short = String(r.id).slice(0, 8);
    // GAP-66: adoção de órfã é fato operacional — o log tem de dizer que o esperador em processo
    // morreu, senão a recuperação parece mágica e ninguém liga o ponto ao restart que a causou.
    const adopted = r.status === "pending" || r.status === "running";
    if (adopted) {
      console.log(`[spec-validation] run ${short}: status '${r.status}' sem sinal de vida há mais de ${STAGE_B_LEASE_SEC}s — o esperador em processo morreu (restart da api). Adotando a coleta em vez de esperar o deadline.`);
    }
    let res: Awaited<ReturnType<StageBProbe>>;
    try {
      res = await probe(String(r.agents_job_id));
    } catch (e) {
      // Falha de rede é transitória: NÃO marca coletado — tenta no próximo tick (até o teto duro).
      console.warn(`[spec-validation] run ${short}: probe do estágio B falhou (${e instanceof Error ? e.message : String(e)}) — tentarei de novo.`);
      continue;
    }
    const overdue = r.deadline_at
      ? Date.now() > new Date(r.deadline_at).getTime() + STAGE_B_COLLECT_GRACE_MIN * 60_000
      : false;
    if (res === "not_found") {
      await markStageBCollected(pool, r.id);
      out.lost += 1;
      console.log(`[spec-validation] run ${short}: job ${r.agents_job_id} não existe mais no agents (TTL/restart) — resultado perdido, assunto encerrado.`);
      continue;
    }
    const st = String(res.status);
    if (st === "done") {
      logTriage(short, (res.result ?? {}) as Record<string, unknown>); // GAP-141: vale também no resgate.
      const recuperado = parseStageBFindingsWithDrop((res.result ?? {}).findings);
      const stageB = recuperado.findings;
      if (recuperado.dropped > 0) {
        // GAP-129: o resultado recuperado também passa pelo teto de ingestão — e o descarte é dito.
        console.warn(`[spec-validation] run ${short}: resultado recuperado tinha ${stageB.length + recuperado.dropped} achados e o teto de ingestão é ${STAGE_B_MAX_FINDINGS} — ${recuperado.dropped} DESCARTADO(S); a contagem desta validação está incompleta.`);
        await pool.query(
          `UPDATE spec_validation_runs
              SET stage_b_coverage = COALESCE(stage_b_coverage, '{}'::jsonb)
                  || jsonb_build_object('droppedFindings', $2::int, 'droppedCap', $3::int)
            WHERE id = $1`,
          [r.id, recuperado.dropped, STAGE_B_MAX_FINDINGS],
        ).catch(() => undefined);
      }
      // O estágio A já está gravado na linha — a UNIÃO se mantém (o LLM só ADICIONA).
      const existing = Array.isArray(r.findings) ? (r.findings as ValidationFinding[]) : [];
      const findings = [...existing, ...stageB];
      const after = r.project_id ? await computeCurrentSpecHash(pool, r.project_id).catch(() => null) : null;
      // A spec pode ter mudado enquanto o resultado ficou pendente: dizer 'passed'/'failed' sobre
      // outro conteúdo seria mentir. 'superseded' é honesto e o laço autônomo não compara contagem.
      const superseded = after?.specHash !== r.spec_hash;
      const status = superseded
        ? "superseded"
        : findings.some((f) => f.severity === "blocker") ? "failed" : "passed";
      await pool.query(
        `UPDATE spec_validation_runs
            SET status = $1, findings = $2::jsonb, stage_b_ran = true,
                stage_b_collected_at = now(), finished_at = now()
          WHERE id = $3 AND stage_b_collected_at IS NULL`,
        [status, JSON.stringify(findings), r.id],
      );
      if (!superseded) {
        await registerRecurrences(pool, String(r.project_id), findings).catch((e) =>
          console.warn(`[spec-validation] run ${short}: registerRecurrences falhou (não crítico): ${e instanceof Error ? e.message : String(e)}`));
        await auditCrossFamily(pool, String(r.project_id), String(r.id), findings);
      }
      // GAP-18: o resultado recuperado julgou os MESMOS arquivos que a run mandou — a cobertura conta
      // (o sha guardado é o do texto julgado, então arquivo editado no meio não é marcado como visto).
      //
      // 🔴 C3: com a spec em LOTES, o `agents_job_id` pendente é de UM lote — e só os arquivos DELE
      // podem ser marcados como julgados por este resultado. `pendingFullShas` é exatamente esse
      // recorte; sem ele, recuperar um lote marcaria como julgados também os arquivos dos lotes que
      // falharam. Cobertura antiga (uma chamada só) não tem o campo e continua caindo em `fullShas`.
      const cov = (r.stage_b_coverage ?? null) as { fullShas?: Record<string, string>; pendingFullShas?: Record<string, string> } | null;
      const devidos = cov?.pendingFullShas ?? cov?.fullShas;
      if (r.project_id && devidos && Object.keys(devidos).length > 0) {
        await markFilesJudged(pool, String(r.project_id), devidos);
        // C3: o lote recuperado passa a contar como MEDIDO na cobertura da run — é o que faz
        // `unionFindingsByCoverage` saber que estes arquivos foram olhados nesta run (GAP-20) e o que
        // tira estes arquivos de `notMeasured`. Sem isto a coluna diria que ninguém os leu.
        if (cov?.pendingFullShas) await mergeRecoveredCoverage(pool, r.id, cov as StageBCoverage);
      }
      out.collected += 1;
      // A CAUSA da recuperação muda o diagnóstico: órfã adotada aponta para restart da api;
      // "espera expirou" aponta para lentidão do agents. Dizer a errada manda o próximo a investigar
      // no lugar errado — por isso o texto segue `adopted`, não um chute.
      const causa = adopted
        ? "por adoção de órfã (o esperador em processo morreu)"
        : "após a espera em processo terminar";
      console.log(`[spec-validation] run ${short}: resultado do estágio B RECUPERADO ${causa} — ${stageB.length} finding(s) do LLM, status '${status}'${superseded ? " (a spec mudou desde o início da validação)" : ""}.`);
      continue;
    }
    if (st === "error") {
      await markStageBCollected(pool, r.id);
      out.lost += 1;
      console.log(`[spec-validation] run ${short}: job do estágio B terminou em erro no agents (${(res.error ?? "").slice(0, 200)}) — nada a recuperar.`);
      continue;
    }
    if (overdue) {
      await markStageBCollected(pool, r.id);
      out.givenUp += 1;
      console.log(`[spec-validation] run ${short}: job ${r.agents_job_id} ainda em '${st}' ${STAGE_B_COLLECT_GRACE_MIN} min após o deadline — desisto (o laço não pode esperar para sempre).`);
      continue;
    }
    console.log(`[spec-validation] run ${short}: job do estágio B ainda em '${st}' — sigo aguardando a coleta.`);
  }
  return out;
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
 * Avaliação do estado de validação da spec, **independente da env-flag** do gate.
 *
 * Existe porque o gate devolve `{ok:true}` de graça quando `SPEC_VALIDATION_GATE=off`
 * (o default em prod) — quem quer *informar* o estado (Certificado Genesis Factory) não pode
 * chamar o gate direto, senão pinta tudo de verde. Extraído para haver UMA implementação da
 * regra: `checkSpecValidationGate` passou a ser a projeção `{ok}` desta função.
 */
export interface SpecValidationAssessment {
  /** Hash do que está EM DISCO agora; `null` = nenhum arquivo legível (nada a validar). */
  specHash: string | null;
  /** Conteúdo lido no cálculo do hash (evita 2ª leitura de disco por quem também precisa do texto). */
  files: Array<SpecFileRow & { content: string }>;
  /** Run terminal do hash ATUAL (`null` = hash nunca validado). */
  run: { id: string; status: string; ackedRole: string | null } | null;
  /** Última run terminal de QUALQUER hash — distingue "nunca validou" de "verde ficou stale". */
  latestRun: { id: string; status: string; specHash: string } | null;
  /** Findings ATIVOS (triagem RFC-0005 aplicada quando possível). */
  activeFindings: ValidationFinding[];
  /** `enrichRunFindings` funcionou — sem isso, blocker triado NÃO pode ser descontado. */
  triageApplied: boolean;
  activeBlockers: number;
  activeWarnings: number;
  acked: boolean;
  forcedByAdmin: boolean;
  /**
   * GAP-21: cobertura ACUMULADA do estágio adversarial sobre o conteúdo atual.
   * `null` = projeto sem rastreio de cobertura (nenhuma run com `stage_b_coverage`) → regra legada.
   */
  coverage: SpecCoverageState | null;
  /** Quantas runs do hash atual entraram na união dos findings (1 = comportamento legado). */
  runsUnioned: number;
  /** Veredito: motivo pelo qual o gate recusaria (`null` = passaria). */
  block: { code: string; message: string } | null;
}

/** Runs do MESMO hash consideradas na união de findings do gate (GAP-21). */
const ASSESS_WINDOW_RUNS = 12;

export async function assessSpecValidation(
  db: { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  projectId: string,
): Promise<SpecValidationAssessment> {
  const empty = {
    files: [] as Array<SpecFileRow & { content: string }>,
    run: null, latestRun: null, activeFindings: [] as ValidationFinding[],
    triageApplied: false, activeBlockers: 0, activeWarnings: 0, acked: false, forcedByAdmin: false,
    coverage: null as SpecCoverageState | null, runsUnioned: 0,
  };
  const current = await computeCurrentSpecHash(db, projectId);
  if (!current) {
    return { ...empty, specHash: null,
      block: { code: "SPEC_FILES_MISSING", message: "Spec sem arquivos legíveis — valide antes de promover." } };
  }

  // Uma consulta serve aos dois usos: a run do hash atual (o gate) e a última de qualquer hash
  // (para saber se o certificado está VENCIDO ou se nunca existiu). `(spec_hash = $2) DESC` põe
  // as do hash atual na frente → o `LIMIT 1` devolve exatamente o que o WHERE antigo devolvia.
  // GAP-21: a MESMA consulta traz a janela de runs do hash atual (a união de findings) — a de índice 0
  // continua sendo exatamente a run que o `LIMIT 1` devolvia (representante do gate).
  const rows = (await db.query(
    `SELECT id, created_at, status, findings, acked_by, acked_role, spec_hash, stage_b_coverage
      FROM spec_validation_runs
      WHERE project_id = $1 AND status IN ('passed','failed')
      ORDER BY (spec_hash = $2) DESC, created_at DESC LIMIT $3`,
    [projectId, current.specHash, ASSESS_WINDOW_RUNS],
  )).rows;
  const row = rows[0];
  const latestRun = row
    ? { id: String(row.id), status: String(row.status), specHash: String(row.spec_hash) }
    : null;
  const base = { ...empty, specHash: current.specHash, files: current.files, latestRun };

  if (!row || String(row.spec_hash) !== current.specHash) {
    // hash atual nunca validado (inclui o caso "verde ficou stale após edição")
    return { ...base, block: { code: "SPEC_NOT_VALIDATED",
      message: "Spec não validada (ou editada após a última validação). Rode Validar e tente de novo." } };
  }

  // 🔴 GAP-21: com a rotação de cobertura (GAP-18) uma run julga um SUBCONJUNTO dos arquivos; contar
  // blockers só dela liberaria o gate sobre o que ninguém leu. Projeto SEM rastreio de cobertura
  // (nenhuma run com `stage_b_coverage`) mantém o caminho legado — byte-idêntico.
  const sameHash = rows.filter((r) => String(r.spec_hash) === current.specHash);
  const covTracked = sameHash.some((r) => judgedFilesOf(r.stage_b_coverage) !== null);
  const rawFindings: ValidationFinding[] = covTracked
    ? unionFindingsByCoverage(sameHash.map((r) => ({
      id: String(r.id), created_at: String(r.created_at), coverage: r.stage_b_coverage,
      findings: (Array.isArray(r.findings) ? r.findings : []) as ValidationFinding[],
    })))
    : ((row.findings ?? []) as ValidationFinding[]);
  const coverage = covTracked ? await unjudgedFrom(db, projectId, current).catch(() => null) : null;
  // RFC-0005: só findings ATIVOS contam — ignorados/refutados (triagem viva, auditada) não bloqueiam.
  const enriched = await enrichRunFindings(db, projectId, rawFindings).catch(() => null);
  const findings: ValidationFinding[] = enriched ? enriched.filter((f) => !f.triage) : rawFindings;
  // Sinal de ack = acked_role/acked_at — acked_by pode ser NULL legitimamente (token
  // estático admin tem sub não-UUID; a identidade crua vive no snapshot da auditoria).
  const acked = !!row.acked_role;
  const forcedByAdmin = acked && row.acked_role === "zentriz_admin";
  const activeBlockers = findings.filter((f) => f.severity === "blocker").length;
  const activeWarnings = findings.filter((f) => f.severity === "warning").length;
  const status = String(row.status);
  const assessed: SpecValidationAssessment = {
    ...base,
    run: { id: String(row.id), status, ackedRole: (row.acked_role as string | null) ?? null },
    activeFindings: findings, triageApplied: !!enriched,
    activeBlockers, activeWarnings, acked, forcedByAdmin,
    coverage, runsUnioned: covTracked ? sameHash.length : 1,
    block: null,
  };

  // 🔴 GAP-21 (2ª face): o VEREDITO também vinha de uma run só. Com rotação, a run mais recente pode
  // ser `passed` (julgou 2 arquivos limpos) enquanto os blockers vivem no julgamento de outro arquivo,
  // feito em outra rodada do MESMO conteúdo — e o `if (status === 'failed')` nem era avaliado. Onde há
  // cobertura rastreada, quem manda é a UNIÃO: blocker ativo bloqueia, venha da run que vier.
  if (covTracked ? activeBlockers > 0 : status === "failed") {
    // force do zentriz_admin passa NA HORA (inclusive por cima de warnings sem ack) — preservado
    // do gate original, onde este caminho era um `return { ok: true }` antes do check de warnings.
    if (forcedByAdmin) return assessed;
    if (!(enriched && activeBlockers === 0)) {
      // `enriched && activeBlockers === 0` = todos os blockers foram triados (auditado) → segue
      const uniao = covTracked && sameHash.length > 1 ? ` (união de ${sameHash.length} rodadas do mesmo conteúdo)` : "";
      return { ...assessed, block: { code: "SPEC_VALIDATION_BLOCKED",
        message: status === "failed"
          ? `Validação reprovou com ${activeBlockers || "findings"} blocker(s) ativo(s)${uniao}. Corrija a spec, triagem os blockers (tenant_admin, auditado) ou um zentriz_admin pode forçar.`
          : `A validação do conteúdo atual tem ${activeBlockers} blocker(s) ativo(s)${uniao}. Corrija a spec, triagem os blockers (tenant_admin, auditado) ou um zentriz_admin pode forçar.` } };
    }
  }
  // 🔴 GAP-21: "zero blocker" só vale sobre o que foi JULGADO. Cobertura incompleta no conteúdo atual =
  // a spec não está validada por inteiro → não promove. Vem DEPOIS dos blockers (quando há blocker, o
  // texto acionável é o dele) e ANTES do ack (não faz sentido reconhecer avisos de leitura parcial).
  // O force do zentriz_admin continua passando por cima (auditado), como no caminho de `failed`.
  if (coverage && coverage.unjudged.length > 0 && !forcedByAdmin) {
    const faltam = coverage.unjudged.slice(0, 3).join(", ") + (coverage.unjudged.length > 3 ? "…" : "");
    return { ...assessed, block: { code: "SPEC_COVERAGE_INCOMPLETE",
      message: `Validação parcial: ${coverage.judged}/${coverage.total} arquivo(s) da spec foram julgados por inteiro no conteúdo atual — faltam ${faltam}. Rode Validar novamente (cada rodada cobre os que faltaram) antes de promover.` } };
  }
  if (activeWarnings > 0 && !acked) {
    return { ...assessed, block: { code: "SPEC_WARNINGS_UNACKED",
      message: "Validação passou com avisos — reconheça os findings (ack) antes de promover." } };
  }
  return assessed;
}

/**
 * Gate de validação no CHOKE-POINT (dispatchProjectRun + /run inline do pipeline.ts).
 * OFF por env (default) → sempre passa (byte-idêntico ao legado).
 * ON → exige run 'passed' para o HASH ATUAL, com regra de ack:
 *   • findings só info → passa;
 *   • com warnings → exige acked (qualquer papel);
 *   • run 'failed' (blockers) → só passa se acked por zentriz_admin (force, auditado).
 *
 * A REGRA vive em `assessSpecValidation` (uma implementação só); aqui fica apenas a flag.
 */
export async function checkSpecValidationGate(
  db: { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  projectId: string,
): Promise<SpecGateResult> {
  if (!specValidationGateEnabled()) return { ok: true };
  const a = await assessSpecValidation(db, projectId);
  return a.block ? { ok: false, code: a.block.code, message: a.block.message } : { ok: true };
}
