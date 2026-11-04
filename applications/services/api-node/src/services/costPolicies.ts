/**
 * costPolicies.ts — C3' (desenho 27, §3.4): políticas de custo de LLM versionadas (migration 161).
 *
 * Fonte única de percentuais/pisos/tetos que o Guard (`llmGuard.ts`) lê A CADA chamada (sem cache: alterar a linha muda
 * a chamada seguinte). Sem linha na tabela, o Guard se comporta exatamente como antes. Nenhum valor em dólar é fixo no código.
 *
 * Chaves suportadas:
 *  - `advisor_pct`      percentual (1–100) do ORÇAMENTO TOTAL do projeto-dono reservado ao Advisor (escopo global ou tenant).
 *                       Nesta etapa só é EXPOSTO pelo Guard; a aplicação do teto é a C4'.
 *  - `breaker_hour_usd` / `breaker_day_usd`  disjuntor global da plataforma (valor em US$ > 0; 0 é recusado). Só escopo global.
 *                       Quando existe linha, vence o valor de `llm_guard_settings`/env.
 * Todo valor nasce `calibrado=false`: só um zentriz_admin marca calibrado.
 */
import type { Queryable } from "./llmGuard.js";

export const POLICY_KEYS = ["advisor_pct", "breaker_hour_usd", "breaker_day_usd"] as const;
export type PolicyKey = (typeof POLICY_KEYS)[number];
export const ADVISOR_BASE = "project_total_budget";

export interface CostPolicy {
  id: number;
  scopeType: "global" | "tenant";
  scopeId: string;
  key: string;
  pct: number | null;
  base: string | null;
  floorUsd: number | null;
  absCapUsd: number | null;
  valueUsd: number | null;
  calibrated: boolean;
  calibratedAt: string | null;
  source: string;
  version: number;
  author: string;
  updatedAt: string;
}

export interface PolicyInput {
  scopeType?: unknown; scopeId?: unknown; key?: unknown;
  pct?: unknown; floorUsd?: unknown; absCapUsd?: unknown; valueUsd?: unknown;
  calibrated?: unknown; source?: unknown;
}

export interface ValidPolicy {
  scopeType: "global" | "tenant"; scopeId: string; key: PolicyKey;
  pct: number | null; base: string | null; floorUsd: number | null; absCapUsd: number | null; valueUsd: number | null;
  calibrated: boolean; source: string;
}

export type Validation = { ok: true; value: ValidPolicy } | { ok: false; code: string; message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isNil = (v: unknown) => v === undefined || v === null || v === "";

/** Número positivo finito ou erro. `0` e negativos são recusados (piso/teto/disjuntor não podem ser desligados por engano). */
function positive(v: unknown, field: string): { ok: true; n: number | null } | { ok: false; code: string; message: string } {
  if (isNil(v)) return { ok: true, n: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) {
    return { ok: false, code: "INVALID_VALUE", message: `${field} deve ser um valor em US$ maior que zero (0 é recusado).` };
  }
  return { ok: true, n };
}

export function validatePolicy(input: PolicyInput): Validation {
  const key = String(input.key ?? "") as PolicyKey;
  if (!(POLICY_KEYS as readonly string[]).includes(key)) {
    return { ok: false, code: "UNKNOWN_POLICY", message: `Política desconhecida: ${key}. Válidas: ${POLICY_KEYS.join(", ")}.` };
  }
  const scopeRaw = String(input.scopeType ?? "global");
  if (scopeRaw !== "global" && scopeRaw !== "tenant") {
    return { ok: false, code: "INVALID_SCOPE", message: "scopeType deve ser global ou tenant." };
  }
  const scopeType: "global" | "tenant" = scopeRaw;
  let scopeId = "";
  if (scopeType === "tenant") {
    scopeId = String(input.scopeId ?? "").trim().toLowerCase();
    if (!UUID_RE.test(scopeId)) return { ok: false, code: "INVALID_SCOPE", message: "scopeId do tenant deve ser um UUID." };
  } else if (!isNil(input.scopeId)) {
    return { ok: false, code: "INVALID_SCOPE", message: "Escopo global não aceita scopeId." };
  }
  const floor = positive(input.floorUsd, "floorUsd");
  if (!floor.ok) return floor;
  const cap = positive(input.absCapUsd, "absCapUsd");
  if (!cap.ok) return cap;
  const val = positive(input.valueUsd, "valueUsd");
  if (!val.ok) return val;
  if (floor.n != null && cap.n != null && floor.n > cap.n) {
    return { ok: false, code: "INVALID_VALUE", message: "O piso não pode ser maior que o teto absoluto." };
  }
  const source = String(input.source ?? "manual").trim().slice(0, 200) || "manual";
  const calibrated = input.calibrated === true;

  if (key === "advisor_pct") {
    const pct = Number(input.pct);
    if (isNil(input.pct) || !Number.isFinite(pct) || pct < 1 || pct > 100) {
      return { ok: false, code: "INVALID_PCT", message: "O percentual do Advisor deve estar entre 1 e 100." };
    }
    if (!isNil(input.valueUsd)) return { ok: false, code: "INVALID_VALUE", message: "advisor_pct não usa valueUsd." };
    return { ok: true, value: {
      scopeType, scopeId, key, pct: Math.round(pct * 100) / 100, base: ADVISOR_BASE,
      floorUsd: floor.n, absCapUsd: cap.n, valueUsd: null, calibrated, source,
    } };
  }
  // disjuntor global
  if (scopeType !== "global") {
    return { ok: false, code: "INVALID_SCOPE", message: `${key} é do disjuntor da plataforma: só escopo global.` };
  }
  if (val.n == null) {
    return { ok: false, code: "INVALID_VALUE", message: `${key} exige valueUsd em US$ maior que zero (0 é recusado).` };
  }
  if (!isNil(input.pct)) return { ok: false, code: "INVALID_VALUE", message: `${key} não usa pct.` };
  return { ok: true, value: {
    scopeType, scopeId, key, pct: null, base: null, floorUsd: floor.n, absCapUsd: cap.n, valueUsd: val.n, calibrated, source,
  } };
}

function toPolicy(r: Record<string, unknown>): CostPolicy {
  const n = (v: unknown) => (v == null ? null : Number(v));
  return {
    id: Number(r.id), scopeType: r.scope_type as "global" | "tenant", scopeId: String(r.scope_id), key: String(r.policy_key),
    pct: n(r.pct), base: r.base == null ? null : String(r.base), floorUsd: n(r.floor_usd), absCapUsd: n(r.abs_cap_usd),
    valueUsd: n(r.value_usd), calibrated: !!r.calibrated, calibratedAt: r.calibrated_at ? new Date(String(r.calibrated_at)).toISOString() : null,
    source: String(r.source), version: Number(r.version), author: String(r.author),
    updatedAt: new Date(String(r.updated_at)).toISOString(),
  };
}

export async function listPolicies(db: Queryable, filter: { scopeType?: string; scopeId?: string } = {}): Promise<CostPolicy[]> {
  const r = await db.query(
    `SELECT * FROM cost_policies WHERE ($1::text IS NULL OR scope_type = $1) AND ($2::text IS NULL OR scope_id = $2)
      ORDER BY policy_key, scope_type, scope_id`,
    [filter.scopeType ?? null, filter.scopeId ?? null],
  );
  return r.rows.map(toPolicy);
}

export async function getPolicy(db: Queryable, scopeType: string, scopeId: string, key: string): Promise<CostPolicy | null> {
  const r = await db.query("SELECT * FROM cost_policies WHERE scope_type = $1 AND scope_id = $2 AND policy_key = $3", [scopeType, scopeId, key]);
  return r.rows[0] ? toPolicy(r.rows[0]) : null;
}

/**
 * Cria/atualiza a política em UMA instrução (linha + histórico atômicos). A versão é monotônica por (escopo, chave), mesmo
 * após exclusão e recriação. `calibrated=true` só é aceito de quem a rota autorizou (`allowCalibrated`).
 */
export async function upsertPolicy(db: Queryable, v: ValidPolicy, author: string, allowCalibrated: boolean): Promise<CostPolicy> {
  const calibrated = allowCalibrated && v.calibrated;
  const r = await db.query(
    `WITH up AS (
       INSERT INTO cost_policies (scope_type, scope_id, policy_key, pct, base, floor_usd, abs_cap_usd, value_usd,
                                  calibrated, calibrated_at, source, version, author)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $9::boolean THEN now() END, $10,
               COALESCE((SELECT MAX(version) FROM cost_policy_history WHERE scope_type = $1 AND scope_id = $2 AND policy_key = $3), 0) + 1, $11)
       ON CONFLICT (scope_type, scope_id, policy_key) DO UPDATE SET
         pct = EXCLUDED.pct, base = EXCLUDED.base, floor_usd = EXCLUDED.floor_usd, abs_cap_usd = EXCLUDED.abs_cap_usd,
         value_usd = EXCLUDED.value_usd, calibrated = EXCLUDED.calibrated, calibrated_at = EXCLUDED.calibrated_at,
         source = EXCLUDED.source, author = EXCLUDED.author, version = cost_policies.version + 1, updated_at = now()
       RETURNING *, (xmax = 0) AS was_inserted
     ), hist AS (
       INSERT INTO cost_policy_history (policy_id, scope_type, scope_id, policy_key, version, action, before_state, after_state, author)
       SELECT up.id, up.scope_type, up.scope_id, up.policy_key, up.version,
              CASE WHEN up.was_inserted THEN 'create' ELSE 'update' END,
              (SELECT h.after_state FROM cost_policy_history h
                WHERE h.scope_type = up.scope_type AND h.scope_id = up.scope_id AND h.policy_key = up.policy_key
                ORDER BY h.version DESC, h.id DESC LIMIT 1),
              to_jsonb(up) - 'was_inserted', $11
         FROM up
     )
     SELECT * FROM up`,
    [v.scopeType, v.scopeId, v.key, v.pct, v.base, v.floorUsd, v.absCapUsd, v.valueUsd, calibrated, v.source, author],
  );
  return toPolicy(r.rows[0]);
}

export async function deletePolicy(db: Queryable, scopeType: string, scopeId: string, key: string, author: string): Promise<boolean> {
  const r = await db.query(
    `WITH del AS (
       DELETE FROM cost_policies WHERE scope_type = $1 AND scope_id = $2 AND policy_key = $3 RETURNING *
     ), hist AS (
       INSERT INTO cost_policy_history (policy_id, scope_type, scope_id, policy_key, version, action, before_state, after_state, author)
       SELECT id, scope_type, scope_id, policy_key, version + 1, 'delete', to_jsonb(del), NULL, $4 FROM del
     )
     SELECT id FROM del`,
    [scopeType, scopeId, key, author],
  );
  return r.rows.length > 0;
}

export async function policyHistory(db: Queryable, scopeType: string, scopeId: string, key: string) {
  const r = await db.query(
    `SELECT version, action, before_state, after_state, author, created_at FROM cost_policy_history
      WHERE scope_type = $1 AND scope_id = $2 AND policy_key = $3 ORDER BY version DESC, id DESC LIMIT 200`,
    [scopeType, scopeId, key],
  );
  return r.rows;
}

/**
 * Política efetiva para um tenant: a linha do tenant vence a global. `null` se não houver nenhuma OU se a leitura falhar
 * (tabela ausente etc.) — nesse caso o Guard segue como antes (a leitura de política nunca derruba nem endurece a chamada).
 */
export async function getEffectivePolicy(db: Queryable, key: PolicyKey, tenantId: string | null): Promise<CostPolicy | null> {
  try {
    const r = await db.query(
      `SELECT * FROM cost_policies
        WHERE policy_key = $1 AND (scope_type = 'global' OR (scope_type = 'tenant' AND scope_id = COALESCE($2::text, '-')))
        ORDER BY (scope_type = 'tenant') DESC LIMIT 1`,
      [key, tenantId],
    );
    return r.rows[0] ? toPolicy(r.rows[0]) : null;
  } catch {
    return null;
  }
}

export interface AdvisorPolicyView {
  pct: number; base: string; baseUsd: number; capUsd: number;
  floorUsd: number | null; absCapUsd: number | null; calibrated: boolean; version: number;
  scopeType: "global" | "tenant";
}

/** Exposição do Advisor: X % do orçamento total do dono, limitado pelo teto absoluto quando houver. Sem política ⇒ `null`. */
export async function advisorPolicyView(db: Queryable, tenantId: string | null, budgetUsd: number | null): Promise<AdvisorPolicyView | null> {
  if (budgetUsd == null || !(budgetUsd > 0)) return null;
  const p = await getEffectivePolicy(db, "advisor_pct", tenantId);
  if (!p || p.pct == null) return null;
  let cap = budgetUsd * (p.pct / 100);
  if (p.absCapUsd != null) cap = Math.min(cap, p.absCapUsd);
  return {
    pct: p.pct, base: p.base ?? ADVISOR_BASE, baseUsd: budgetUsd, capUsd: Math.round(cap * 10000) / 10000,
    floorUsd: p.floorUsd, absCapUsd: p.absCapUsd, calibrated: p.calibrated, version: p.version, scopeType: p.scopeType,
  };
}

/** Disjuntor: valores em vigor vindos da política global (se existirem). */
export async function breakerOverrides(db: Queryable): Promise<{ hour: number | null; day: number | null }> {
  try {
    const r = await db.query(
      `SELECT policy_key, value_usd FROM cost_policies WHERE scope_type = 'global' AND policy_key IN ('breaker_hour_usd', 'breaker_day_usd')`,
    );
    const out: { hour: number | null; day: number | null } = { hour: null, day: null };
    for (const row of r.rows ?? []) {
      const n = Number(row.value_usd);
      if (!(n > 0)) continue;
      if (row.policy_key === "breaker_hour_usd") out.hour = n;
      if (row.policy_key === "breaker_day_usd") out.day = n;
    }
    return out;
  } catch {
    return { hour: null, day: null };
  }
}
