/**
 * llmRoleSlots.ts — plano de evolução v2, tarefas 2A.1 a 2A.3: os três papéis de modelo por slot
 * (Orchestrator · Advisor · Staff) na MESMA linha de `tenant_llm_configs` / `zentriz_llm_config`.
 *
 * Fonte de verdade na transição: as colunas LEGADAS (`model_id`, `model_id_fallback`) continuam
 * autoritativas enquanto houver agents antigos. As colunas novas são espelho com dupla escrita.
 * Com `LLM_ROLES_MODE=off` NADA aqui é chamado: nenhum SQL nem payload muda.
 *
 * Funções puras (sem banco): o SQL da migration 139 e `backfillRolesFromLegacy` implementam a mesma
 * regra e um teste de integração em Postgres real compara os dois.
 */
import { isSmallModel, modelFamilyOf, modelPower, servableBy } from "../services/reviewerModel.js";
import { llmRolesMode, type LlmRole } from "./llmRoles.js";

export interface RoleModels {
  orchestrator: string;
  /** NULL = sem escalada (D1b). Nunca default de plataforma. */
  advisor: string | null;
  /** NULL = usa o Orchestrator do mesmo slot, declarado no ledger (D1). */
  staff: string | null;
}

/** Fragmentos de SQL dependentes da flag. Com `off` todos são string vazia ⇒ SQL byte-idêntico. */
export function rolesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return llmRolesMode(env) !== "off";
}

const clean = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
};

/**
 * Mapeamento de backfill (espelha a migration 139).
 *  - Orchestrator := model_id
 *  - Advisor := model_id_fallback, se não vazio e diferente de model_id (igual ⇒ NULL, D1b)
 *  - Advisor := cyborg_model_id (D3) só quando o fallback é vazio/NULL, o Advisor segue NULL e
 *    o valor difere de model_id. `includeCyborg=false` na conta de gestão (defaults de coluna).
 *  - Staff := NULL
 * `origin` diz de onde veio o Advisor, para a simulação listar os casos de borda.
 */
export function backfillRolesFromLegacy(
  slot: { modelId: string; modelIdFallback?: string | null; cyborgModelId?: string | null },
  opts: { includeCyborg?: boolean } = {},
): RoleModels & { origin: "fallback" | "cyborg" | "none"; notes: string[] } {
  const includeCyborg = opts.includeCyborg ?? true;
  const principal = clean(slot.modelId) ?? "";
  const fallback = clean(slot.modelIdFallback);
  const cyborg = clean(slot.cyborgModelId);
  const notes: string[] = [];
  let advisor: string | null = null;
  let origin: "fallback" | "cyborg" | "none" = "none";

  if (fallback && fallback !== principal) {
    advisor = fallback; origin = "fallback";
  } else if (fallback && fallback === principal) {
    notes.push("fallback == principal ⇒ Advisor NULL (sem escalada, D1b)");
  } else if (!fallback) {
    notes.push("fallback NULL ⇒ Advisor NULL (sem escalada, comportamento atual)");
    if (includeCyborg && cyborg && cyborg !== principal) {
      advisor = cyborg; origin = "cyborg";
      notes.push("Advisor vem de cyborg_model_id (D3): valor carimbado pela migration 030, confirmar com o tenant");
    }
  }
  return { orchestrator: principal, advisor, staff: null, origin, notes };
}

// ── Validação das entradas de papel nas rotas de cadastro ─────────────────────────────────────────

export interface RoleValidation { errors: string[]; warnings: string[] }

/**
 * Falha ALTO em vez de corrigir em silêncio. Id desconhecido (família ou porte não reconhecidos)
 * é ACEITO com aviso: `modelPower` devolve 0 ("não sei") e isso nunca é tratado como "fraco".
 */
export function validateRoleModels(provider: string, roles: {
  orchestrator: string | null; advisor: string | null; staff: string | null;
}): RoleValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const entries: Array<[keyof typeof roles, string | null]> = [
    ["orchestrator", roles.orchestrator], ["advisor", roles.advisor], ["staff", roles.staff],
  ];
  for (const [role, id] of entries) {
    if (!id) continue;
    if (!servableBy(provider, id)) {
      errors.push(`${role}: o provider '${provider}' não serve o modelo '${id}'.`);
    }
  }
  if (roles.staff) {
    if (modelPower(roles.staff) === 3) {
      errors.push(`staff: '${roles.staff}' é de classe topo de linha (opus-like); o Staff é o papel barato e não pode ser essa classe.`);
    } else if (modelPower(roles.staff) === 0) {
      warnings.push(`staff: classe de '${roles.staff}' não reconhecida (família ${modelFamilyOf(roles.staff)}); aceito sem validar.`);
    }
  }
  if (roles.advisor) {
    if (isSmallModel(roles.advisor)) {
      errors.push(`advisor: '${roles.advisor}' é modelo de porte pequeno; o Advisor precisa ser igual ou mais capaz que o Orchestrator.`);
    } else if (modelPower(roles.advisor) === 0) {
      warnings.push(`advisor: classe de '${roles.advisor}' não reconhecida (família ${modelFamilyOf(roles.advisor)}); aceito sem validar.`);
    }
    if (roles.orchestrator && roles.advisor === roles.orchestrator) {
      warnings.push("advisor igual ao orchestrator: a escalada não muda o modelo.");
    }
  }
  return { errors, warnings };
}

export interface RolesForSave {
  orchestrator: string;
  advisor: string | null;
  /** `undefined` = o payload não trouxe o campo ⇒ preserva o valor gravado. */
  staff: string | null | undefined;
  /** Valor a gravar em `model_id_fallback` (espelho legado do Advisor). */
  legacyFallback: string | null;
}

/**
 * Deriva os três papéis (e o espelho legado) de um payload de cadastro. Aceita:
 *  - só campos legados (`model_id`, `model_id_fallback`)  ⇒ papéis derivados (igual ao backfill);
 *  - campos novos opcionais `model_orchestrator/model_advisor/model_staff`.
 * Conflito entre campo novo e legado (valores diferentes) ⇒ erro, nunca "escolhe um".
 */
export function deriveRolesForSave(
  body: Record<string, unknown>,
  legacyModelId: string,
): { ok: true; roles: RolesForSave } | { ok: false; message: string } {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const legacyFb = has("model_id_fallback") ? clean(body.model_id_fallback) : null;

  let orchestrator = legacyModelId;
  if (has("model_orchestrator")) {
    const o = clean(body.model_orchestrator);
    if (o && legacyModelId && o !== legacyModelId) {
      return { ok: false, message: `model_orchestrator ('${o}') diverge de model_id ('${legacyModelId}'); envie o mesmo valor ou apenas um dos campos.` };
    }
    if (o) orchestrator = o;
  }

  let advisor: string | null;
  let legacyFallback: string | null;
  if (has("model_advisor")) {
    advisor = clean(body.model_advisor);
    if (legacyFb && legacyFb !== advisor) {
      return { ok: false, message: `model_advisor ('${advisor ?? ""}') diverge de model_id_fallback ('${legacyFb}'); envie o mesmo valor ou apenas um dos campos.` };
    }
    legacyFallback = advisor;
  } else {
    // Só legado: o Advisor segue a regra do backfill (igual ao principal ⇒ sem escalada).
    advisor = legacyFb && legacyFb !== orchestrator ? legacyFb : null;
    legacyFallback = legacyFb;
  }

  const staff = has("model_staff") ? clean(body.model_staff) : undefined;
  return { ok: true, roles: { orchestrator, advisor, staff, legacyFallback } };
}

/**
 * `models` de um slot lido do banco. Legado AUTORITATIVO na transição: Orchestrator e Advisor saem
 * de `model_id`/`model_id_fallback` (mesma regra do backfill); Staff só existe na coluna nova.
 * `diverges` avisa quando as colunas novas já não batem com as legadas (slot salvo com a flag `off`).
 */
export function rolesFromRow(row: {
  model_id?: unknown; model_id_fallback?: unknown;
  model_orchestrator?: unknown; model_advisor?: unknown; model_staff?: unknown;
}): { models: RoleModels; diverges: boolean } {
  const legacy = backfillRolesFromLegacy(
    { modelId: String(row.model_id ?? ""), modelIdFallback: row.model_id_fallback as string | null | undefined },
    { includeCyborg: false },
  );
  const models: RoleModels = {
    orchestrator: legacy.orchestrator, advisor: legacy.advisor, staff: clean(row.model_staff),
  };
  const diverges =
    (clean(row.model_orchestrator) ?? null) !== (legacy.orchestrator || null) ||
    (clean(row.model_advisor) ?? null) !== legacy.advisor;
  return { models, diverges };
}

// ── 2A.4/2A.5: resolução por papel e contrato de transporte ──────────────────────────────────────

/** Versão do contrato aditivo `roles_contract_version` (api → agents/runner). Espelho do Python. */
export const ROLES_CONTRACT_VERSION = 1;

/** O roteamento por papel só vale com `LLM_ROLES_MODE=on`; `off` e `shadow` não mudam NADA no envelope. */
export function rolesRoutingOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return llmRolesMode(env) === "on";
}

/** Papel de modelo EXIGIDO por uma chamada do squad (doc 05 §16): só fato duro `rework_attempt >= 1`. */
export function requiredRoleFor(squadRole: string, reworkAttempt = 0): LlmRole {
  const up = (squadRole || "").toUpperCase();
  return (up === "DEV" || up === "QA") && reworkAttempt >= 1 ? "advisor" : "orchestrator";
}

export interface RoleResolution {
  llm_role: LlmRole;
  effective_role: LlmRole;
  model: string;
  /** true só se o modelo do papel substituiu o Orchestrator. */
  escalated: boolean;
  note: string;
}

/**
 * Modelo do papel exigido DENTRO de um slot (D1/D1b). Sem Orchestrator ⇒ lança (LEI dos slots: nada de
 * modelo de env/literal). Staff vazio ⇒ Orchestrator declarado; Advisor vazio ⇒ sem escalada.
 * Espelho de `orchestrator/agents/llm_roles.py::resolve_model`.
 */
export function resolveRoleModel(models: RoleModels, required: LlmRole): RoleResolution {
  const orch = clean(models.orchestrator);
  if (!orch) throw new Error("nenhum modelo Orchestrator no slot do tenant (LEI dos slots: sem modelo de env/literal)");
  if (required === "orchestrator") return { llm_role: required, effective_role: "orchestrator", model: orch, escalated: false, note: "" };
  if (required === "staff") {
    const st = clean(models.staff);
    return st
      ? { llm_role: "staff", effective_role: "staff", model: st, escalated: false, note: "" }
      : { llm_role: "staff", effective_role: "orchestrator", model: orch, escalated: false, note: "staff_empty_uses_orchestrator" };
  }
  const adv = clean(models.advisor);
  if (!adv) return { llm_role: "advisor", effective_role: "orchestrator", model: orch, escalated: false, note: "advisor_empty_no_escalation" };
  if (adv === orch) return { llm_role: "advisor", effective_role: "orchestrator", model: orch, escalated: false, note: "advisor_same_as_orchestrator" };
  return { llm_role: "advisor", effective_role: "advisor", model: adv, escalated: true, note: "" };
}
