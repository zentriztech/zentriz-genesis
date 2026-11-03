/**
 * rolesLogic.ts — lógica PURA (sem React/MUI) da UI de 3 papéis do slot de LLM (plano v2, tarefa 2A.10).
 *
 * Isolada de propósito: o portal não tem infraestrutura de teste de componente, então tudo o que
 * decide payload, estado e mensagem fica aqui e é coberto por `rolesLogic.test.ts`.
 *
 * Regra de ouro: com `roles_mode` ausente/`off` NADA daqui altera o payload nem a tela.
 */

export type RolesMode = "off" | "shadow" | "on";
export type RoleKey = "orchestrator" | "advisor" | "staff";
export const ROLE_KEYS: readonly RoleKey[] = ["orchestrator", "advisor", "staff"];

/** Valor ausente/desconhecido ⇒ `off` (fail-safe: nunca liga a UI nova por engano). */
export function parseRolesMode(v: unknown): RolesMode {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s === "shadow" || s === "on" ? s : "off";
}

/** Decisão do Jean (2026-11-03): a UI dos 3 papéis só aparece com `on` (em `shadow` o portal fica como o atual). */
export const rolesUiEnabled = (mode: RolesMode): boolean => mode === "on";

export interface RoleModelsState { orchestrator: string; advisor: string; staff: string }

/** Veredicto de um papel — igual no GET (`status/at/error`) e no PUT/test (`status/tested/ok/error`). */
export interface RoleVerifyIn {
  status?: string | null;
  tested?: boolean;
  error?: string | null;
  note?: string;
  latency_ms?: number;
}
export type RoleVerifyMap = Partial<Record<RoleKey, RoleVerifyIn | null>>;

export interface SlotRolesIn {
  model_id: string | null;
  model_id_fallback: string | null;
  models?: { orchestrator?: string | null; advisor?: string | null; staff?: string | null };
}

/** Estado inicial dos selects: `models` do servidor quando existe; senão deriva dos campos legados. */
export function initialRoles(slot: SlotRolesIn | null | undefined): RoleModelsState {
  if (!slot) return { orchestrator: "", advisor: "", staff: "" };
  const m = slot.models;
  if (m) {
    return { orchestrator: m.orchestrator ?? slot.model_id ?? "", advisor: m.advisor ?? "", staff: m.staff ?? "" };
  }
  const principal = slot.model_id ?? "";
  const fb = slot.model_id_fallback ?? "";
  return { orchestrator: principal, advisor: fb && fb !== principal ? fb : "", staff: "" };
}

/**
 * Campos de papel acrescentados ao PUT. `off` ⇒ `{}` (payload idêntico ao atual).
 * Dupla escrita: os legados (`model_id`/`model_id_fallback`) continuam sendo enviados pelo chamador
 * com os MESMOS valores (Orchestrator → model_id, Advisor → model_id_fallback), senão o backend
 * recusa a divergência. Vazio é `null` explícito: Advisor vazio = sem escalada; Staff vazio = usa o
 * Orchestrator do slot.
 */
export function rolesPayloadFields(mode: RolesMode, r: RoleModelsState): Record<string, string | null> {
  if (!rolesUiEnabled(mode)) return {};
  return {
    model_orchestrator: r.orchestrator || null,
    model_advisor: r.advisor || null,
    model_staff: r.staff || null,
  };
}

/** Valor do `model_id_fallback` legado a enviar: com a UI nova é o Advisor; senão, o select antigo. */
export function legacyFallbackValue(mode: RolesMode, r: RoleModelsState, legacyFallback: string): string | null {
  return rolesUiEnabled(mode) ? (r.advisor || null) : (legacyFallback || null);
}

// ── Estado do probe por papel ─────────────────────────────────────────────────────────────────────

export type RoleStatusKind = "ok" | "denied" | "error" | "timeout" | "untested" | "empty";
export type RoleStatusTone = "success" | "error" | "warning" | "neutral";

export interface RoleStatusView {
  kind: RoleStatusKind;
  /** Texto SEMPRE presente (nunca só cor/ícone). */
  label: string;
  tone: RoleStatusTone;
  /** Dica completa (tooltip/descrição acessível). */
  detail: string;
}

/** `filled` = o papel tem modelo. Papel vazio não é testado — e isso não é um defeito. */
export function roleStatusView(
  role: RoleKey, filled: boolean, v: RoleVerifyIn | null | undefined,
): RoleStatusView {
  if (!filled) {
    const detail = role === "advisor" ? "Sem Advisor: não há escalada (registrado)."
      : role === "staff" ? "Sem Staff: as tarefas repetitivas usam o Orchestrator do slot."
      : "Defina o Orchestrator.";
    return { kind: "empty", label: "Não configurado", tone: "neutral", detail };
  }
  const st = v?.status ?? null;
  switch (st) {
    case "ok":
      return { kind: "ok", label: "Testado e funcionando", tone: "success",
        detail: v?.latency_ms ? `Respondeu em ${v.latency_ms} ms.` : "Respondeu ao teste." };
    case "denied":
      return { kind: "denied", label: "Acesso negado ao modelo", tone: "error",
        detail: v?.error || "A conta/credencial não pode usar este modelo. Corrija o cadastro." };
    case "timeout":
      return { kind: "timeout", label: "Tempo esgotado no teste", tone: "warning",
        detail: v?.error || "O teste excedeu o prazo. Tente testar novamente." };
    case "error":
      return { kind: "error", label: "Falhou no teste", tone: "error",
        detail: v?.error || "Falha que não prova negação (rede, cota ou resposta vazia)." };
    default:
      return { kind: "untested", label: "Não testado", tone: "neutral",
        detail: v?.note || "Ainda sem veredicto para este papel. Use ▶ para testar." };
  }
}

/** Papel só será usado em runtime se tiver modelo E probe ok (contrato `isRoleEligible`, 2A.9). */
export const roleBlocksUse = (s: RoleStatusView): boolean =>
  s.kind === "denied" || s.kind === "error" || s.kind === "timeout";

// ── Erros 400 do backend ──────────────────────────────────────────────────────────────────────────

/**
 * O backend devolve 400 com mensagens como
 *   "advisor: '…' é modelo de porte pequeno; …"  (várias podem vir juntas, separadas por espaço)
 *   "model_advisor ('x') diverge de model_id_fallback ('y'); …"
 * Aqui separamos o que pertence a cada campo; o resto vira mensagem geral.
 */
export function parseRoleErrors(message: string): { byRole: Partial<Record<RoleKey, string>>; general: string } {
  const byRole: Partial<Record<RoleKey, string>> = {};
  const msg = String(message ?? "").trim();
  if (!msg) return { byRole, general: "" };
  const re = /(?:^|\s)(orchestrator|advisor|staff): /g;
  const marks: Array<{ role: RoleKey; start: number; textStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(msg)) !== null) {
    const start = m.index + (m[0].startsWith(" ") ? 1 : 0);
    marks.push({ role: m[1] as RoleKey, start, textStart: m.index + m[0].length });
  }
  if (marks.length) {
    marks.forEach((mk, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].start : msg.length;
      const text = msg.slice(mk.textStart, end).trim();
      byRole[mk.role] = byRole[mk.role] ? `${byRole[mk.role]} ${text}` : text;
    });
    return { byRole, general: "" };
  }
  const div = /^model_(orchestrator|advisor) \(/.exec(msg);
  if (div) return { byRole: { [div[1]]: msg } as Partial<Record<RoleKey, string>>, general: "" };
  return { byRole, general: msg };
}

/** Avisos (`warnings`) devolvidos no salvar: sempre array de strings não vazias. */
export function normalizeWarnings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}

/** Resumo textual do teste por papel (para o aviso após salvar/testar). Sem credenciais. */
export function summarizeRoleVerify(map: RoleVerifyMap | null | undefined, models: RoleModelsState): string[] {
  const out: string[] = [];
  const NAME: Record<RoleKey, string> = { orchestrator: "Orchestrator", advisor: "Advisor", staff: "Staff" };
  for (const role of ROLE_KEYS) {
    if (!models[role]) continue;
    const view = roleStatusView(role, true, map?.[role] ?? null);
    out.push(`${NAME[role]}: ${view.label}`);
  }
  return out;
}
