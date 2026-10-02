/**
 * llmGuard.ts — GUARDA ÚNICO de gasto de LLM (migration 131). Post-mortem 30/09/2026.
 *
 * O incidente (BRL 90.305,78 em 22 dias): `ensureConnectDeclarationsTick` reprocessou 3 projetos em
 * `blocked_cyborg` a ~1 chamada/min de Opus, com payload byte-idêntico, sem ninguém ver. Os tetos que
 * existiam (068 tenant/mês, T18 por projeto) falharam por TRÊS razões que este módulo fecha:
 *   1. Mediam o que alguém LEMBROU de debitar em `project_agent_metrics` — a chamada do loop não
 *      debitava nada (via `/invoke/raw` sem projeto). Aqui o registro acontece NO PONTO DA CHAMADA
 *      (runtime dos agents chama `/api/internal/llm-guard/record` depois de toda chamada paga).
 *   2. Só eram checados ANTES de iniciar um run. Aqui cada chamada pede licença (`preflight`).
 *   3. Eram fail-OPEN. Aqui é fail-CLOSED: sem orçamento, sem projeto conhecido, banco fora ⇒ NEGA.
 *
 * Controle em DÓLAR por projeto (Bancada + Fábrica + Deadpool). Tokens continuam anotados (ledger),
 * mas a decisão é por USD — é a unidade que o usuário entende e que aparece na fatura.
 *
 * Camadas, na ordem em que o `preflight` decide:
 *   a. CHAVE GERAL (`llm_guard_settings.kill_switch`): on ⇒ nada passa. Começa ON na migração.
 *   b. DISJUNTOR GLOBAL: gasto da plataforma na última hora / nas últimas 24 h acima do teto ⇒ nega
 *      e LIGA a chave geral (exige humano para religar). Teria parado o incidente no 1º dia.
 *   c. PAYLOAD REPETIDO: o mesmo hash de prompt pago N vezes em 6 h ⇒ nega. Assinatura exata do
 *      incidente (114.920 tokens idênticos por chamada, 7 dias seguidos).
 *   d. SEM PROJETO: teto diário pequeno para chamadas não atribuídas (probe, plataforma).
 *   e. ORÇAMENTO DO PROJETO: sem orçamento ⇒ nega · pausado ⇒ nega · custo estimado desta chamada
 *      não cabe no que resta ⇒ PAUSA o projeto e nega.
 */
import { costUsd } from "../lib/modelPricing.js";
import { PRE_FACTORY_STATUSES } from "./projectStatus.js";
import { isSesConfigured, sendEmail } from "./emailSender.js";
import { buildEstimator, fetchHistoryBuckets } from "./specEnrichment.js";

export interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

/** Passos de alerta que o usuário escolhe (a cada X% consumido). */
export const ALERT_STEP_OPTIONS = [10, 20, 30, 40, 50] as const;
/** Alertas OBRIGATÓRIOS quando restarem 30%, 20%, 10% e 0% (= 70/80/90/100% consumidos). */
export const MANDATORY_CONSUMED_PCT = [70, 80, 90, 100] as const;

// Lido sob demanda: `specs.ts` importa este módulo e `projectStatus` tem ciclo com ele no boot.
let PRE_FACTORY: Set<string> | null = null;

/** Status em que a Fábrica pode estar trabalhando — a pausa por orçamento os leva a `stopped`. */
const FACTORY_ACTIVE_STATUSES = [
  "queued", "running", "cto_charter", "pm_backlog", "dev_qa", "devops", "pending_cyborg",
];

/** Defaults dos tetos globais (sobrescritos por `llm_guard_settings`, depois por env). */
const SETTING_DEFAULTS: Record<string, string> = {
  kill_switch: "on",
  // Baseline medido antes do incidente: ~BRL 402/dia ≈ US$ 75/dia na plataforma inteira.
  global_max_usd_per_hour: "40",
  global_max_usd_per_day: "250",
  unattributed_max_usd_per_day: "5",
  repeat_max_per_6h: "4",
};

export type GuardCode =
  | "KILL_SWITCH" | "GLOBAL_HOURLY_CAP" | "GLOBAL_DAILY_CAP" | "REPEAT_PAYLOAD"
  | "UNATTRIBUTED_DAILY_CAP" | "PROJECT_NOT_FOUND" | "BUDGET_MISSING" | "BUDGET_PAUSED"
  | "BUDGET_INSUFFICIENT" | "GUARD_ERROR";

export type GuardDecision =
  | { allow: true; remainingUsd: number | null; budgetProjectId: string | null }
  | { allow: false; code: GuardCode; message: string; budgetProjectId?: string | null };

export interface PreflightInput {
  projectId?: string | null;
  purpose?: string;
  source?: string;
  model?: string | null;
  promptHash?: string | null;
  estInputTokens?: number;
  maxOutputTokens?: number;
}

export interface RecordInput extends PreflightInput {
  provider?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs?: number;
}

export interface BudgetOwner {
  ownerId: string;
  title: string;
  tenantId: string | null;
  createdBy: string | null;
  status: string;
  budgetUsd: number | null;
  alertStepPct: number | null;
  pausedAt: string | null;
  pausedReason: string | null;
}

export interface BudgetSpend {
  totalUsd: number;
  bancadaUsd: number;
  fabricaUsd: number;
  deadpoolUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
  medianCallUsd: number;
}

export interface BudgetForecast {
  doneTasks: number;
  pendingTasks: number;
  pendingCostUsd: number;
  projectTotalUsd: number;
  suggestedBudgetUsd: number;
  basis: "tasks" | "history" | "default";
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Configuração ──────────────────────────────────────────────────────────────

export async function getGuardSettings(db: Queryable): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...SETTING_DEFAULTS };
  for (const k of Object.keys(out)) {
    const env = (process.env[`LLM_GUARD_${k.toUpperCase()}`] ?? "").trim();
    if (env) out[k] = env;
  }
  // O banco vence o env: a chave geral tem de ser operável sem redeploy.
  const rows = (await db.query("SELECT key, value FROM llm_guard_settings")).rows;
  for (const r of rows) out[String(r.key)] = String(r.value);
  return out;
}

export async function setGuardSetting(db: Queryable, key: string, value: string, by: string): Promise<void> {
  await db.query(
    `INSERT INTO llm_guard_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, value, by],
  );
}

async function logEvent(db: Queryable, kind: string, projectId: string | null, detail: Record<string, unknown>): Promise<void> {
  await db.query(
    "INSERT INTO llm_guard_events (kind, project_id, detail) VALUES ($1, $2, $3::jsonb)",
    [kind, projectId, JSON.stringify(detail)],
  ).catch((e) => console.warn(`[llmGuard] evento ${kind} não gravado: ${msg(e)}`));
}

// ── Orçamento ────────────────────────────────────────────────────────────────

/** Dono do orçamento: o próprio projeto ou `budget_owner_project_id` (filhos de split). */
export async function resolveBudgetOwner(db: Queryable, projectId: string): Promise<BudgetOwner | null> {
  if (!UUID_RE.test(projectId)) return null;
  const res = await db.query(
    `SELECT o.id, o.title, o.tenant_id, o.created_by, o.status, o.budget_usd, o.budget_alert_step_pct,
            o.budget_paused_at, o.budget_paused_reason
       FROM projects p
       JOIN projects o ON o.id = COALESCE(p.budget_owner_project_id, p.id)
      WHERE p.id = $1`,
    [projectId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    ownerId: String(r.id),
    title: String(r.title ?? ""),
    tenantId: r.tenant_id ? String(r.tenant_id) : null,
    createdBy: r.created_by ? String(r.created_by) : null,
    status: String(r.status ?? ""),
    budgetUsd: r.budget_usd == null ? null : num(r.budget_usd),
    alertStepPct: r.budget_alert_step_pct == null ? null : num(r.budget_alert_step_pct),
    pausedAt: r.budget_paused_at ? String(r.budget_paused_at) : null,
    pausedReason: r.budget_paused_reason ? String(r.budget_paused_reason) : null,
  };
}

export async function getBudgetSpend(db: Queryable, ownerId: string): Promise<BudgetSpend> {
  const res = await db.query(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total,
            COALESCE(SUM(cost_usd) FILTER (WHERE phase = 'bancada'), 0) AS bancada,
            COALESCE(SUM(cost_usd) FILTER (WHERE phase = 'fabrica'), 0) AS fabrica,
            COALESCE(SUM(cost_usd) FILTER (WHERE phase = 'deadpool'), 0) AS deadpool,
            COALESCE(SUM(input_tokens), 0) AS in_tok, COALESCE(SUM(output_tokens), 0) AS out_tok,
            COALESCE(SUM(cache_read_tokens), 0) AS cr_tok, COALESCE(SUM(cache_write_tokens), 0) AS cw_tok,
            COUNT(*) AS calls
       FROM llm_call_ledger WHERE budget_project_id = $1`,
    [ownerId],
  );
  const med = await db.query(
    `SELECT COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd), 0) AS med
       FROM (SELECT cost_usd FROM llm_call_ledger WHERE budget_project_id = $1
              ORDER BY created_at DESC LIMIT 20) t`,
    [ownerId],
  );
  const r = res.rows[0] ?? {};
  return {
    totalUsd: num(r.total), bancadaUsd: num(r.bancada), fabricaUsd: num(r.fabrica), deadpoolUsd: num(r.deadpool),
    inputTokens: num(r.in_tok), outputTokens: num(r.out_tok),
    cacheReadTokens: num(r.cr_tok), cacheWriteTokens: num(r.cw_tok),
    calls: num(r.calls), medianCallUsd: num(med.rows[0]?.med),
  };
}

/**
 * Menor gasto plausível da PRÓXIMA atividade: 3 chamadas medianas do próprio projeto (uma tarefa
 * nunca é menos que isso), com piso de US$ 0,10. Abaixo disso, o saldo "não permite executar
 * nenhuma outra tarefa" (requisito do Jean) e o projeto pausa em vez de começar algo que não termina.
 */
export function minNextActivityUsd(spend: BudgetSpend): number {
  return Math.max(0.1, spend.medianCallUsd * 3);
}

/**
 * Limiares de alerta em % CONSUMIDO: múltiplos do passo escolhido + os obrigatórios (70/80/90/100).
 * Ex.: passo 30 ⇒ [30, 60, 70, 80, 90, 100].
 */
export function alertThresholds(stepPct: number | null): number[] {
  const set = new Set<number>(MANDATORY_CONSUMED_PCT);
  const step = ALERT_STEP_OPTIONS.includes(stepPct as (typeof ALERT_STEP_OPTIONS)[number]) ? (stepPct as number) : 0;
  if (step > 0) for (let p = step; p < 100; p += step) set.add(p);
  return [...set].sort((a, b) => a - b);
}

/** Previsão de quanto falta gastar para terminar as tarefas pendentes e o projeto inteiro. */
export async function computeForecast(db: Queryable, owner: BudgetOwner, spend: BudgetSpend): Promise<BudgetForecast> {
  const t = (await db.query(
    `SELECT COUNT(*) FILTER (WHERE t.status = 'DONE') AS done,
            COUNT(*) FILTER (WHERE t.status NOT IN ('DONE', 'CANCELLED')) AS pending
       FROM project_tasks t JOIN projects p ON p.id = t.project_id
      WHERE COALESCE(p.budget_owner_project_id, p.id) = $1`,
    [owner.ownerId],
  )).rows[0] ?? {};
  const done = num(t.done);
  const pending = num(t.pending);
  let pendingCost: number;
  let basis: BudgetForecast["basis"];
  if (done > 0 && spend.fabricaUsd > 0) {
    // Custo médio por tarefa concluída (inclui o overhead de CTO/PM — de propósito, conservador).
    pendingCost = (spend.fabricaUsd / done) * pending;
    basis = "tasks";
  } else {
    // Fábrica ainda não produziu tarefa: estimativa histórica por complexidade (mesma do EstimateChip).
    const cx = (await db.query("SELECT complexity_hint FROM projects WHERE id = $1", [owner.ownerId])).rows[0];
    const est = buildEstimator(await fetchHistoryBuckets(db))(cx?.complexity_hint as string | null);
    pendingCost = est.costUsd;
    basis = est.basis === "history" ? "history" : "default";
  }
  const projectTotal = spend.totalUsd + pendingCost;
  // 20% de margem: a previsão é média, e parar a 95% do caminho é o pior desfecho para o usuário.
  const suggested = Math.ceil(projectTotal * 1.2 * 100) / 100;
  return {
    doneTasks: done, pendingTasks: pending,
    pendingCostUsd: Math.round(pendingCost * 100) / 100,
    projectTotalUsd: Math.round(projectTotal * 100) / 100,
    suggestedBudgetUsd: Math.max(suggested, owner.budgetUsd ?? 0),
    basis,
  };
}

// ── Disjuntores globais ──────────────────────────────────────────────────────

async function globalSpend(db: Queryable): Promise<{ hour: number; day: number; unattributedDay: number }> {
  const r = (await db.query(
    `SELECT COALESCE(SUM(cost_usd) FILTER (WHERE created_at > now() - interval '1 hour'), 0) AS hour,
            COALESCE(SUM(cost_usd), 0) AS day,
            COALESCE(SUM(cost_usd) FILTER (WHERE budget_project_id IS NULL), 0) AS unattributed_day
       FROM llm_call_ledger WHERE created_at > now() - interval '24 hours'`,
  )).rows[0] ?? {};
  return { hour: num(r.hour), day: num(r.day), unattributedDay: num(r.unattributed_day) };
}

/** Liga a chave geral automaticamente e avisa a Zentriz. Idempotente (só avisa na transição). */
async function tripKillSwitch(db: Queryable, code: GuardCode, detail: Record<string, unknown>): Promise<void> {
  const cur = (await db.query("SELECT value FROM llm_guard_settings WHERE key = 'kill_switch'")).rows[0];
  if (String(cur?.value ?? "") === "on") return;
  await setGuardSetting(db, "kill_switch", "on", `auto:${code}`);
  await logEvent(db, "kill_switch_tripped", null, { code, ...detail });
  void notifyOps(
    `[Genesis] DISJUNTOR GLOBAL de LLM disparou (${code}) — todo LLM está bloqueado`,
    "O guard de custo ligou a chave geral automaticamente. Nenhuma chamada de LLM passa até um humano religar.",
    [["Motivo", code], ...Object.entries(detail).map(([k, v]) => [k, String(v)] as [string, string]),
      ["Como religar", "PUT /api/admin/llm-guard/settings {\"kill_switch\":\"off\"} (zentriz_admin)"]],
  );
}

// ── Preflight ────────────────────────────────────────────────────────────────

export function estimateCallUsd(model: string | null | undefined, estInputTokens: number, maxOutputTokens: number): number {
  // Saída esperada: metade do teto, limitada a 8k — o teto inteiro superestimaria toda chamada.
  const out = Math.min(Math.max(0, maxOutputTokens) / 2, 8000);
  return costUsd(model, Math.max(0, estInputTokens), out);
}

export async function preflight(db: Queryable, input: PreflightInput): Promise<GuardDecision> {
  try {
    const s = await getGuardSettings(db);
    if (s.kill_switch !== "off") {
      return { allow: false, code: "KILL_SWITCH", message: "Chave geral de LLM ligada: todo LLM do Genesis está bloqueado por um administrador." };
    }
    const g = await globalSpend(db);
    const hourCap = num(s.global_max_usd_per_hour);
    const dayCap = num(s.global_max_usd_per_day);
    if (hourCap > 0 && g.hour >= hourCap) {
      await tripKillSwitch(db, "GLOBAL_HOURLY_CAP", { gastoUltimaHoraUsd: g.hour.toFixed(2), tetoUsd: hourCap });
      return { allow: false, code: "GLOBAL_HOURLY_CAP", message: `Teto global de US$ ${hourCap}/hora atingido — LLM bloqueado.` };
    }
    if (dayCap > 0 && g.day >= dayCap) {
      await tripKillSwitch(db, "GLOBAL_DAILY_CAP", { gasto24hUsd: g.day.toFixed(2), tetoUsd: dayCap });
      return { allow: false, code: "GLOBAL_DAILY_CAP", message: `Teto global de US$ ${dayCap}/24h atingido — LLM bloqueado.` };
    }

    const repeatMax = num(s.repeat_max_per_6h);
    if (input.promptHash && repeatMax > 0) {
      const rep = (await db.query(
        `SELECT COUNT(*) AS n FROM llm_call_ledger WHERE prompt_hash = $1 AND created_at > now() - interval '6 hours'`,
        [input.promptHash],
      )).rows[0];
      if (num(rep?.n) >= repeatMax) {
        await logEvent(db, "repeat_payload_denied", input.projectId ?? null,
          { hash: input.promptHash, count: num(rep?.n), purpose: input.purpose ?? "" });
        void notifyRepeatOnce(db, input, num(rep?.n));
        return {
          allow: false, code: "REPEAT_PAYLOAD",
          message: `O mesmo pedido já foi pago ${num(rep?.n)} vezes nas últimas 6 h — repetição bloqueada (assinatura de laço).`,
        };
      }
    }

    const pid = (input.projectId ?? "").trim();
    if (!pid) {
      const cap = num(s.unattributed_max_usd_per_day);
      if (cap > 0 && g.unattributedDay >= cap) {
        return { allow: false, code: "UNATTRIBUTED_DAILY_CAP", message: `Teto diário de US$ ${cap} para chamadas sem projeto atingido.` };
      }
      return { allow: true, remainingUsd: null, budgetProjectId: null };
    }

    const owner = await resolveBudgetOwner(db, pid);
    if (!owner) return { allow: false, code: "PROJECT_NOT_FOUND", message: "Projeto não encontrado para debitar a chamada de LLM." };
    if (owner.budgetUsd == null) {
      return {
        allow: false, code: "BUDGET_MISSING", budgetProjectId: owner.ownerId,
        message: "Projeto sem orçamento de LLM definido. Defina o orçamento (US$) na página do projeto para liberar a execução.",
      };
    }
    if (owner.pausedAt) {
      return {
        allow: false, code: "BUDGET_PAUSED", budgetProjectId: owner.ownerId,
        message: `Projeto pausado por orçamento: ${owner.pausedReason ?? "orçamento esgotado"}. Aumente o orçamento para retomar.`,
      };
    }
    const spend = await getBudgetSpend(db, owner.ownerId);
    const remaining = owner.budgetUsd - spend.totalUsd;
    const est = estimateCallUsd(input.model, num(input.estInputTokens), num(input.maxOutputTokens));
    if (remaining <= 0 || est > remaining) {
      const reason = remaining <= 0
        ? `orçamento de US$ ${owner.budgetUsd.toFixed(2)} esgotado`
        : `saldo de US$ ${remaining.toFixed(2)} não cobre a próxima chamada (estimada em US$ ${est.toFixed(2)})`;
      await pauseForBudget(db, owner, reason);
      return { allow: false, code: "BUDGET_INSUFFICIENT", budgetProjectId: owner.ownerId, message: `Projeto pausado: ${reason}.` };
    }
    return { allow: true, remainingUsd: remaining, budgetProjectId: owner.ownerId };
  } catch (e) {
    // FAIL-CLOSED: a lição do incidente é que gasto sem controle é pior do que trabalho parado.
    console.error(`[llmGuard] preflight falhou — NEGANDO (fail-closed): ${msg(e)}`);
    return { allow: false, code: "GUARD_ERROR", message: "Guarda de custo indisponível — chamada negada por segurança." };
  }
}

// ── Registro ─────────────────────────────────────────────────────────────────

function phaseFor(status: string, source: string): string {
  if (source === "deadpool") return "deadpool";
  PRE_FACTORY ??= new Set<string>(PRE_FACTORY_STATUSES);
  return PRE_FACTORY.has(status) ? "bancada" : "fabrica";
}

/**
 * Registra uma chamada PAGA e aplica as consequências: alertas por limiar, pausa por saldo e
 * disjuntor global. Nunca lança — o registro de uma chamada que já aconteceu não pode falhar o
 * chamador (o dinheiro já foi gasto). Erro aqui só aparece no log e no próximo preflight.
 */
export async function recordCall(pool: Queryable, input: RecordInput): Promise<{ costUsd: number }> {
  const cost = costUsd(input.model, num(input.inputTokens), num(input.outputTokens),
    num(input.cacheReadTokens), num(input.cacheWriteTokens));
  try {
    const pid = (input.projectId ?? "").trim();
    const owner = pid ? await resolveBudgetOwner(pool, pid) : null;
    let phase = "unattributed";
    let tenantId: string | null = owner?.tenantId ?? null;
    if (owner) {
      const st = (await pool.query("SELECT status, tenant_id FROM projects WHERE id = $1", [pid])).rows[0];
      phase = phaseFor(String(st?.status ?? ""), input.source ?? "agents");
      tenantId = st?.tenant_id ? String(st.tenant_id) : tenantId;
    }
    await pool.query(
      `INSERT INTO llm_call_ledger (project_id, budget_project_id, tenant_id, phase, source, purpose, provider, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, prompt_hash, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [owner ? pid : null, owner?.ownerId ?? null, tenantId, phase, input.source ?? "agents",
        (input.purpose ?? "").slice(0, 120), input.provider ?? null, input.model ?? null,
        Math.round(num(input.inputTokens)), Math.round(num(input.outputTokens)),
        Math.round(num(input.cacheReadTokens)), Math.round(num(input.cacheWriteTokens)),
        cost, input.promptHash ?? null, input.durationMs == null ? null : Math.round(num(input.durationMs))],
    );

    // Disjuntor global avaliado também DEPOIS: a chamada que estoura o teto liga a chave na hora.
    const s = await getGuardSettings(pool);
    const g = await globalSpend(pool);
    if (num(s.global_max_usd_per_hour) > 0 && g.hour >= num(s.global_max_usd_per_hour)) {
      await tripKillSwitch(pool, "GLOBAL_HOURLY_CAP", { gastoUltimaHoraUsd: g.hour.toFixed(2), tetoUsd: s.global_max_usd_per_hour });
    } else if (num(s.global_max_usd_per_day) > 0 && g.day >= num(s.global_max_usd_per_day)) {
      await tripKillSwitch(pool, "GLOBAL_DAILY_CAP", { gasto24hUsd: g.day.toFixed(2), tetoUsd: s.global_max_usd_per_day });
    }

    if (owner && owner.budgetUsd != null) await evaluateBudget(pool, owner);
  } catch (e) {
    console.error(`[llmGuard] registro falhou (custo US$ ${cost.toFixed(4)} NÃO contabilizado): ${msg(e)}`);
  }
  return { costUsd: cost };
}

/** Alertas por limiar + pausa quando o saldo não comporta a próxima atividade. */
export async function evaluateBudget(pool: Queryable, owner: BudgetOwner): Promise<void> {
  if (owner.budgetUsd == null) return;
  const spend = await getBudgetSpend(pool, owner.ownerId);
  const budget = owner.budgetUsd;
  const pct = budget > 0 ? (spend.totalUsd / budget) * 100 : 100;
  const remaining = budget - spend.totalUsd;

  const crossed = alertThresholds(owner.alertStepPct).filter((t) => pct >= t);
  // Re-arma quando o orçamento muda: a chave inclui o valor do orçamento em centavos.
  const cents = Math.round(budget * 100);
  const fresh: number[] = [];
  for (const t of crossed) {
    const ins = await pool.query(
      `INSERT INTO ops_notifications (project_id, kind) VALUES ($1, $2) ON CONFLICT (project_id, kind) DO NOTHING RETURNING id`,
      [owner.ownerId, `budget:${cents}:pct:${t}`],
    );
    if ((ins.rowCount ?? 0) > 0) fresh.push(t);
  }

  const mustPause = !owner.pausedAt && (remaining <= 0 || remaining < minNextActivityUsd(spend));
  if (mustPause) {
    const reason = remaining <= 0
      ? `orçamento de US$ ${budget.toFixed(2)} atingido (gasto US$ ${spend.totalUsd.toFixed(2)})`
      : `saldo de US$ ${remaining.toFixed(2)} não comporta a próxima atividade (mínimo estimado US$ ${minNextActivityUsd(spend).toFixed(2)})`;
    await pauseForBudget(pool, owner, reason, spend);
    return; // o e-mail de pausa já traz consumo e previsão — não manda o de limiar junto
  }
  if (fresh.length) {
    const top = Math.max(...fresh);
    const forecast = await computeForecast(pool, owner, spend);
    await sendBudgetEmail(pool, owner, spend, forecast, {
      subject: `[Genesis] ${owner.title || "Projeto"}: ${top}% do orçamento consumido (restam US$ ${Math.max(0, remaining).toFixed(2)})`,
      lead: `O projeto atingiu ${top}% do orçamento de LLM. A execução continua até o limite — o aviso existe para você decidir com antecedência.`,
    });
  }
}

/** Pausa o projeto (e os que dividem o orçamento): nada autônomo roda até um humano aumentar o orçamento. */
export async function pauseForBudget(db: Queryable, owner: BudgetOwner, reason: string, spendIn?: BudgetSpend): Promise<void> {
  const upd = await db.query(
    `UPDATE projects SET budget_paused_at = now(), budget_paused_reason = $2, updated_at = now()
      WHERE (id = $1 OR budget_owner_project_id = $1) AND budget_paused_at IS NULL RETURNING id`,
    [owner.ownerId, reason.slice(0, 500)],
  );
  if ((upd.rowCount ?? upd.rows.length) === 0) return; // já pausado por outra chamada concorrente
  // Fábrica ativa ⇒ `stopped` + stopped_by='budget' (watchdog só relança quedas, não paradas
  // intencionais). Bancada mantém o status — o guard já nega toda chamada de LLM dela.
  await db.query(
    `UPDATE projects SET status = 'stopped', stopped_by = 'budget', updated_at = now()
      WHERE (id = $1 OR budget_owner_project_id = $1) AND status = ANY($2::text[])`,
    [owner.ownerId, FACTORY_ACTIVE_STATUSES],
  ).catch((e) => console.warn(`[llmGuard] parar fábrica do projeto ${owner.ownerId}: ${msg(e)}`));
  await logEvent(db, "budget_paused", owner.ownerId, { reason });
  {
    const spend = spendIn ?? await getBudgetSpend(db, owner.ownerId);
    const forecast = await computeForecast(db, owner, spend);
    await sendBudgetEmail(db, { ...owner, pausedAt: new Date().toISOString(), pausedReason: reason }, spend, forecast, {
      subject: `[Genesis] ${owner.title || "Projeto"} PAUSADO por orçamento — previsão para concluir: US$ ${forecast.projectTotalUsd.toFixed(2)}`,
      lead: `O projeto foi pausado: ${reason}. Nenhuma execução autônoma (Bancada, Fábrica ou Deadpool) roda até o orçamento ser aumentado.`,
    });
  }
}

/** Libera a pausa quando o orçamento novo comporta a próxima atividade. Devolve se liberou. */
export async function maybeResumeBudget(db: Queryable, ownerId: string): Promise<boolean> {
  const owner = await resolveBudgetOwner(db, ownerId);
  if (!owner || owner.budgetUsd == null || !owner.pausedAt) return false;
  const spend = await getBudgetSpend(db, owner.ownerId);
  if (owner.budgetUsd - spend.totalUsd < minNextActivityUsd(spend)) return false;
  await db.query(
    `UPDATE projects SET budget_paused_at = NULL, budget_paused_reason = NULL, updated_at = now()
      WHERE id = $1 OR budget_owner_project_id = $1`,
    [owner.ownerId],
  );
  await logEvent(db, "budget_resumed", owner.ownerId, { budgetUsd: owner.budgetUsd, spentUsd: spend.totalUsd });
  return true;
}

// ── E-mails ──────────────────────────────────────────────────────────────────

function opsRecipient(): string {
  return (process.env.OPS_NOTIFY_EMAIL ?? "jean@zentriz.com.br").trim();
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function usd(n: number): string { return `US$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function tok(n: number): string { return Math.round(n).toLocaleString("pt-BR"); }

/** Layout claro SEM branco puro (texto escuro sobre cinza-azulado — regra de contraste), tabelas, sem CSS Grid. */
export function renderBudgetEmail(title: string, lead: string, rows: Array<[string, string]>, cta?: { href: string; label: string }): string {
  const trs = rows.map(([k, v]) =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #D5DCE6;color:#4B5563;font-size:14px;width:45%">${esc(k)}</td>` +
    `<td style="padding:8px 12px;border-bottom:1px solid #D5DCE6;color:#111827;font-size:14px;font-weight:600">${esc(v)}</td></tr>`).join("");
  const btn = cta
    ? `<tr><td style="padding:20px 24px 4px"><a href="${esc(cta.href)}" style="display:inline-block;background:#1E3A5F;color:#F1F4F8;text-decoration:none;padding:12px 20px;border-radius:6px;font-size:14px;font-weight:600">${esc(cta.label)}</a></td></tr>`
    : "";
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#E4E9F0;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E4E9F0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#F1F4F8;border-radius:8px">
<tr><td style="padding:24px 24px 8px;color:#111827;font-size:20px;font-weight:700">${esc(title)}</td></tr>
<tr><td style="padding:0 24px 16px;color:#374151;font-size:15px;line-height:1.5">${esc(lead)}</td></tr>
<tr><td style="padding:0 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${trs}</table></td></tr>
${btn}
<tr><td style="padding:20px 24px 24px;color:#6B7280;font-size:12px;line-height:1.5">Zentriz Genesis — guarda de custo de LLM. Valores em dólar estimados pela tabela de preços por modelo, registrados a cada chamada.</td></tr>
</table></td></tr></table></body></html>`;
}

async function sendBudgetEmail(
  pool: Queryable, owner: BudgetOwner, spend: BudgetSpend, f: BudgetForecast,
  m: { subject: string; lead: string },
): Promise<void> {
  if (!isSesConfigured()) return;
  try {
    const u = owner.createdBy
      ? (await pool.query("SELECT email FROM users WHERE id = $1", [owner.createdBy])).rows[0]
      : null;
    const budget = owner.budgetUsd ?? 0;
    const basisLabel = f.basis === "tasks" ? "custo médio por tarefa já concluída"
      : f.basis === "history" ? "histórico de projetos de mesma complexidade" : "estimativa padrão (sem histórico)";
    const rows: Array<[string, string]> = [
      ["Orçamento", usd(budget)],
      ["Gasto até agora", `${usd(spend.totalUsd)} (${budget > 0 ? ((spend.totalUsd / budget) * 100).toFixed(1) : "100"}%)`],
      ["Saldo", usd(Math.max(0, budget - spend.totalUsd))],
      ["Bancada · Fábrica · Deadpool", `${usd(spend.bancadaUsd)} · ${usd(spend.fabricaUsd)} · ${usd(spend.deadpoolUsd)}`],
      ["Tokens (entrada · saída)", `${tok(spend.inputTokens)} · ${tok(spend.outputTokens)}`],
      ["Chamadas de LLM", tok(spend.calls)],
      ["Tarefas concluídas · pendentes", `${f.doneTasks} · ${f.pendingTasks}`],
      ["Previsão para as tarefas pendentes", usd(f.pendingCostUsd)],
      ["Previsão do projeto inteiro", usd(f.projectTotalUsd)],
      ["Orçamento sugerido para concluir", usd(f.suggestedBudgetUsd)],
      ["Base da previsão", basisLabel],
    ];
    if (owner.pausedAt) rows.unshift(["Situação", "PAUSADO — nenhuma execução autônoma até aumentar o orçamento"]);
    const base = (process.env.PORTAL_PUBLIC_URL ?? "https://genesis.zentriz.com.br").replace(/\/$/, "");
    const html = renderBudgetEmail(m.subject.replace(/^\[Genesis\]\s*/, ""), m.lead, rows,
      { href: `${base}/projects/${owner.ownerId}`, label: "Abrir o projeto e ajustar o orçamento" });
    const text = `${m.lead}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n`;
    const to = [u?.email ? String(u.email) : "", opsRecipient()].filter(Boolean);
    const [first, ...rest] = [...new Set(to)];
    if (!first) return;
    await sendEmail({ to: first, cc: rest, subject: m.subject, html, text });
  } catch (e) {
    console.warn(`[llmGuard] e-mail de orçamento do projeto ${owner.ownerId} falhou: ${msg(e)}`);
  }
}

async function notifyOps(subject: string, lead: string, rows: Array<[string, string]>): Promise<void> {
  if (!isSesConfigured()) return;
  try {
    await sendEmail({ to: opsRecipient(), subject, html: renderBudgetEmail(subject.replace(/^\[Genesis\]\s*/, ""), lead, rows),
      text: `${lead}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n` });
  } catch (e) {
    console.warn(`[llmGuard] e-mail ops falhou: ${msg(e)}`);
  }
}

/** Um aviso por hash a cada 24 h — o laço tenta a cada minuto, o e-mail não pode tentar junto. */
async function notifyRepeatOnce(db: Queryable, input: PreflightInput, count: number): Promise<void> {
  try {
    const prev = (await db.query(
      `SELECT 1 FROM llm_guard_events WHERE kind = 'repeat_payload_notified' AND detail->>'hash' = $1
         AND created_at > now() - interval '24 hours' LIMIT 1`,
      [input.promptHash],
    )).rows;
    if (prev.length) return;
    await logEvent(db, "repeat_payload_notified", input.projectId ?? null, { hash: input.promptHash });
    await notifyOps(
      "[Genesis] Laço de LLM detectado e bloqueado (payload repetido)",
      "Um chamador tentou pagar de novo exatamente o mesmo pedido de LLM. O guard bloqueou — é a assinatura do incidente de 30/09.",
      [["Projeto", input.projectId || "(sem projeto)"], ["Origem", `${input.source ?? "agents"} · ${input.purpose ?? "?"}`],
        ["Modelo", input.model ?? "?"], ["Repetições em 6 h", String(count)], ["Hash do pedido", String(input.promptHash).slice(0, 16)]],
    );
  } catch (e) {
    console.warn(`[llmGuard] aviso de repetição falhou: ${msg(e)}`);
  }
}

/** Resumo para a UI/rotas (orçamento + gasto + previsão + limiares). */
export async function budgetSummary(db: Queryable, projectId: string) {
  const owner = await resolveBudgetOwner(db, projectId);
  if (!owner) return null;
  const spend = await getBudgetSpend(db, owner.ownerId);
  const forecast = await computeForecast(db, owner, spend);
  const budget = owner.budgetUsd;
  return {
    projectId, ownerProjectId: owner.ownerId, inherited: owner.ownerId !== projectId,
    budgetUsd: budget, alertStepPct: owner.alertStepPct,
    thresholds: alertThresholds(owner.alertStepPct),
    paused: !!owner.pausedAt, pausedAt: owner.pausedAt, pausedReason: owner.pausedReason,
    spentUsd: Math.round(spend.totalUsd * 10000) / 10000,
    remainingUsd: budget == null ? null : Math.round((budget - spend.totalUsd) * 100) / 100,
    consumedPct: budget && budget > 0 ? Math.round((spend.totalUsd / budget) * 1000) / 10 : null,
    spend, forecast,
    minNextActivityUsd: minNextActivityUsd(spend),
  };
}

export interface BudgetBrief {
  ownerProjectId: string;
  inherited: boolean;
  budgetUsd: number | null;
  spentUsd: number;
  remainingUsd: number | null;
  consumedPct: number | null;
  paused: boolean;
}

/**
 * Resumo CURTO em lote para listagens (cards de /specs): orçamento, gasto e saldo do DONO de cada
 * projeto — mesmas contas do `budgetSummary`, sem previsão. UMA query para N projetos, para a
 * listagem não virar N chamadas a `/api/projects/:id/budget`.
 */
export async function budgetBriefs(db: Queryable, projectIds: string[]): Promise<Map<string, BudgetBrief>> {
  const ids = projectIds.filter((id) => UUID_RE.test(id));
  const out = new Map<string, BudgetBrief>();
  if (!ids.length) return out;
  const res = await db.query(
    `SELECT p.id, o.id AS owner_id, o.budget_usd, o.budget_paused_at,
            COALESCE((SELECT SUM(l.cost_usd) FROM llm_call_ledger l WHERE l.budget_project_id = o.id), 0) AS spent
       FROM projects p
       JOIN projects o ON o.id = COALESCE(p.budget_owner_project_id, p.id)
      WHERE p.id = ANY($1::uuid[])`,
    [ids],
  );
  for (const r of res.rows) {
    const budget = r.budget_usd == null ? null : num(r.budget_usd);
    const spent = num(r.spent);
    out.set(String(r.id), {
      ownerProjectId: String(r.owner_id),
      inherited: String(r.owner_id) !== String(r.id),
      budgetUsd: budget,
      spentUsd: Math.round(spent * 10000) / 10000,
      remainingUsd: budget == null ? null : Math.round((budget - spent) * 100) / 100,
      consumedPct: budget && budget > 0 ? Math.round((spent / budget) * 1000) / 10 : null,
      paused: !!r.budget_paused_at,
    });
  }
  return out;
}

/**
 * Gate de DISPARO (run/promote/cascata/watchdog): não deixa a Fábrica começar um run que o guard
 * vai negar na primeira chamada — sem isto o watchdog relançaria o run negado em laço (sem custo,
 * mas com ruído e e-mail). Fail-closed: erro de banco ⇒ não dispara.
 */
export async function checkProjectBudgetGate(db: Queryable, projectId: string): Promise<{ ok: true } | { ok: false; code: GuardCode; message: string }> {
  try {
    const owner = await resolveBudgetOwner(db, projectId);
    if (!owner) return { ok: false, code: "PROJECT_NOT_FOUND", message: "Projeto não encontrado." };
    if (owner.budgetUsd == null) {
      return { ok: false, code: "BUDGET_MISSING", message: "Projeto sem orçamento de LLM (US$). Defina o orçamento na página do projeto." };
    }
    if (owner.pausedAt) {
      return { ok: false, code: "BUDGET_PAUSED", message: `Projeto pausado por orçamento: ${owner.pausedReason ?? "orçamento esgotado"}. Aumente o orçamento.` };
    }
    const spend = await getBudgetSpend(db, owner.ownerId);
    const remaining = owner.budgetUsd - spend.totalUsd;
    if (remaining < minNextActivityUsd(spend)) {
      return { ok: false, code: "BUDGET_INSUFFICIENT", message: `Saldo de US$ ${remaining.toFixed(2)} não comporta a próxima atividade. Aumente o orçamento.` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, code: "GUARD_ERROR", message: `Guarda de custo indisponível: ${msg(e)}` };
  }
}
