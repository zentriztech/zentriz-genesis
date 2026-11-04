/**
 * cardJourney.ts — Fase 3 (3.5): a JORNADA do card para a UI (`GET /api/cards/:id/journey`).
 *
 * Mesma ideia (e mesma forma) da `Journey` da Bancada de specs (`promotability.ts` / `lib/factoryJourney.ts` do portal): o SERVIDOR
 * decide em que etapa o card está, o que bloqueia a PRÓXIMA etapa e qual é a ação sugerida; a tela só renderiza. Etapas:
 *   rascunho → refinando → pronto → promovido → na fábrica → entregue
 * (`rejected` é terminal fora da trilha; `blocked` marca a etapa em que o card travou).
 *
 * Só LEITURA, exceto o alinhamento idempotente card × filho que a rota faz antes (`syncCardWithChild`). Os bloqueios da próxima etapa
 * reaproveitam os MESMOS verificadores de quem decide de verdade: gate de RFC por tipo (`evaluateCardKindGate`), pré-voo de orçamento
 * (`budgetPreflight`), base vs HEAD e hash do carimbo "pronto" (`cardPromote`). Nenhum caminho paralelo de decisão.
 */
import type { Pool } from "pg";
import { evaluateCardKindGate, type CardKind } from "./evolutionGate.js";
import { budgetPreflight } from "./evolveClaim.js";
import { resolveLineageHead } from "./lineage.js";
import { childInFactory, isBudgetBlockReason } from "./cardPromote.js";
import { cardKindOf, specHashOf, type CardReadySnapshot, type CardRow } from "./cardService.js";
import { cardUserMessage } from "./cardErrors.js";
import type { CardState } from "./cardState.js";

type Json = Record<string, unknown>;

export type JourneyStageKey = "draft" | "refining" | "ready" | "promoted" | "in_factory" | "delivered";
export type JourneyStageState = "done" | "current" | "todo" | "blocked";

export const JOURNEY_STAGES: ReadonlyArray<{ key: JourneyStageKey; label: string }> = [
  { key: "draft", label: "Rascunho" },
  { key: "refining", label: "Refinando" },
  { key: "ready", label: "Pronto" },
  { key: "promoted", label: "Promovido" },
  { key: "in_factory", label: "Na fábrica" },
  { key: "delivered", label: "Entregue" },
];

export interface JourneyBlocker { code: string; message: string; userMessage: string | null; details?: unknown }
export interface JourneyAction { key: string; label: string; method: "GET" | "POST" | "PUT" | null; path: string | null; enabled: boolean }

export interface CardJourney {
  cardId: string;
  code: string;
  state: CardState | null;
  kind: CardKind;
  /** `editing` (draft/refining) · `ready` · `running` (promoted/in_factory) · `blocked` · `delivered` · `rejected`. */
  phase: "editing" | "ready" | "running" | "blocked" | "delivered" | "rejected";
  steps: Array<{ key: JourneyStageKey; label: string; state: JourneyStageState }>;
  current: JourneyStageKey | null;
  /** A próxima etapa da trilha (null no fim ou em card recusado). */
  next: JourneyStageKey | null;
  /** O que impede a PRÓXIMA etapa agora (vazio = pode avançar). */
  blockers: JourneyBlocker[];
  action: JourneyAction | null;
  /** Frase curta do estado (≤ ~60 caracteres) e detalhe. */
  headline: string;
  detail: string | null;
  severity: "success" | "info" | "warning" | "error";
  blocked: { reason: string | null; kind: "budget" | "child" | "materialization" | "other"; resumable: boolean } | null;
  spec: { locked: boolean; canReopen: boolean };
  base: { headProjectId: string | null; headVersion: number | null; currentHeadProjectId: string | null; currentHeadVersion: number | null; stale: boolean } | null;
  execution: { childProjectId: string; status: string; title: string | null; prUrl: string | null } | null;
}

const IDX: Record<string, number> = { draft: 0, refining: 1, ready: 2, promoted: 3, in_factory: 4, delivered: 5 };

function blocker(code: string, message: string, details?: unknown): JourneyBlocker {
  return { code, message, userMessage: cardUserMessage(code), ...(details !== undefined ? { details } : {}) };
}

function blockedKind(reason: string | null): "budget" | "child" | "materialization" | "other" {
  if (isBudgetBlockReason(reason)) return "budget";
  if (reason?.startsWith("materialization_failed")) return "materialization";
  if (reason?.startsWith("child_")) return "child";
  return "other";
}

export async function buildCardJourney(pool: Pool, card: CardRow): Promise<CardJourney> {
  const state = card.card_state as CardState | null;
  const kind = cardKindOf(card) as CardKind;
  const code = `TK-${String(card.number).padStart(4, "0")}`;
  const draft = card.draft_project_id
    ? (await pool.query("SELECT id, extra, budget_owner_project_id FROM projects WHERE id = $1 AND status = 'card_draft'", [card.draft_project_id])).rows[0] as
      { id: string; extra: Json | null; budget_owner_project_id: string | null } | undefined
    : undefined;
  const extra: Json = draft?.extra ?? {};
  const child = card.child_project_id
    ? (await pool.query("SELECT id, status, title, extra->>'evolution_pr_url' AS pr FROM projects WHERE id = $1", [card.child_project_id])).rows[0] as
      { id: string; status: string; title: string | null; pr: string | null } | undefined
    : undefined;
  const execution = child ? { childProjectId: child.id, status: child.status, title: child.title, prUrl: child.pr } : null;

  // Base × HEAD corrente (só enquanto o card ainda não foi promovido).
  const baseReg = (extra.card_base ?? null) as { head_project_id?: string; head_version?: number } | null;
  let head: Awaited<ReturnType<typeof resolveLineageHead>> = null;
  const rootId = String(extra.card_target_root_id ?? "");
  if (draft && rootId && (state === "draft" || state === "refining" || state === "ready")) head = await resolveLineageHead(pool, rootId);
  const base = draft && baseReg
    ? {
        headProjectId: baseReg.head_project_id ?? null, headVersion: baseReg.head_version ?? null,
        currentHeadProjectId: head?.id ?? null, currentHeadVersion: head?.version_number ?? null,
        stale: !!head && !!baseReg.head_project_id && baseReg.head_project_id !== head.id,
      }
    : null;

  // Etapa atual na trilha.
  let idx: number;
  if (state === "delivered") idx = JOURNEY_STAGES.length;
  else if (state === "blocked") idx = child && childInFactory(child.status) ? IDX.in_factory : IDX.promoted;
  else if (state === "rejected") {
    const evs = (await pool.query("SELECT to_state FROM ticket_card_events WHERE ticket_id = $1", [card.id])).rows as Array<{ to_state: string }>;
    idx = Math.max(0, ...evs.map((e) => IDX[e.to_state] ?? 0));
  } else idx = state ? (IDX[state] ?? 0) : 0;
  const steps = JOURNEY_STAGES.map((s, i) => ({
    key: s.key, label: s.label,
    state: (state === "blocked" && i === idx ? "blocked" : i < idx ? "done" : i === idx && state !== "rejected" ? "current" : state === "rejected" && i <= idx ? "done" : "todo") as JourneyStageState,
  }));
  const current = state === "delivered" || state === "rejected" || !state ? null : JOURNEY_STAGES[idx]?.key ?? null;
  const next = state === "delivered" || state === "rejected" || !state ? null : JOURNEY_STAGES[idx + 1]?.key ?? null;

  const blockers: JourneyBlocker[] = [];
  let action: JourneyAction | null = null;
  let headline = "";
  let detail: string | null = null;
  let severity: CardJourney["severity"] = "info";
  let phase: CardJourney["phase"] = "editing";
  let blockedInfo: CardJourney["blocked"] = null;
  const cardPath = `/api/cards/${card.id}`;

  if (state === "draft" || state === "refining") {
    phase = "editing";
    if (!draft) {
      blockers.push(blocker("CARD_DRAFT_UNREADABLE", "O rascunho do card não existe."));
    } else {
      const gate = await evaluateCardKindGate(pool, draft.id, extra, kind);
      if (!gate.ok) blockers.push(blocker(gate.code, gate.message, gate.details));
      // Y-13: o HEAD andou e a revalidação não conferiu os globs de files_allowed (sem clone do HEAD): um humano precisa conferir.
      const reval = (extra.card_revalidation ?? null) as { globs_unverified?: boolean } | null;
      if (reval?.globs_unverified) {
        blockers.push(blocker("GLOBS_UNVERIFIED", "Globs não conferidos: a versão corrente avançou e o escopo (files_allowed) do RFC não foi comparado com o código (sem repositório/clone). Confira o escopo e revalide o card.", { revalidate: `POST /api/cards/${card.id}/revalidate` }));
      }
      if (!head) blockers.push(blocker("NO_ACCEPTED_HEAD", "A linhagem do card não tem versão aceita."));
      else {
        if (base?.stale) blockers.push(blocker("CARD_BASE_STALE", `A versão corrente avançou para v${head.version_number}: revalide o card.`, { currentHead: head.id }));
        const denied = await budgetPreflight(pool, head.id, card.tenant_id, head.version_number);
        if (denied) blockers.push(blocker(String(denied.body.code ?? "BUDGET_INSUFFICIENT"), String(denied.body.message ?? "Orçamento indisponível.")));
      }
    }
    const codes = new Set(blockers.map((b) => b.code));
    if (blockers.length === 0) {
      action = { key: "ready", label: "Validar o card", method: "POST", path: `${cardPath}/ready`, enabled: true };
      headline = "Pronto para validar"; detail = "O RFC passou no gate; valide para travar a spec e liberar a promoção."; severity = "success";
    } else if (codes.has("EVOLUTION_RFC_REQUIRED") && draft) {
      action = { key: "generate_rfc", label: "Gerar o RFC com a IA", method: "POST", path: `/api/projects/${draft.id}/evolution-plan`, enabled: !blockers.some((b) => cardUserMessage(b.code) && (b.code.startsWith("BUDGET_") || ["KILL_SWITCH", "GUARD_ERROR"].includes(b.code))) };
      headline = "Falta o RFC do card"; detail = blockers.find((b) => b.code === "EVOLUTION_RFC_REQUIRED")?.message ?? null; severity = "warning";
    } else if (codes.has("CARD_BASE_STALE")) {
      action = { key: "revalidate", label: "Revalidar contra a versão corrente", method: "POST", path: `${cardPath}/revalidate`, enabled: true };
      headline = "A versão-base mudou"; detail = blockers.find((b) => b.code === "CARD_BASE_STALE")?.message ?? null; severity = "warning";
    } else if (codes.has("GLOBS_UNVERIFIED")) {
      action = { key: "revalidate", label: "Conferir o escopo e revalidar", method: "POST", path: `${cardPath}/revalidate`, enabled: true };
      headline = "Globs não conferidos"; detail = blockers.find((b) => b.code === "GLOBS_UNVERIFIED")?.message ?? null; severity = "warning";
    } else if ([...codes].some((c) => c.startsWith("BUDGET_") || ["KILL_SWITCH", "GUARD_ERROR", "GLOBAL_HOURLY_CAP", "GLOBAL_DAILY_CAP"].includes(c))) {
      action = { key: "increase_budget", label: "Aumentar o orçamento", method: "PUT", path: draft?.budget_owner_project_id ? `/api/projects/${draft.budget_owner_project_id}/budget` : null, enabled: !!draft?.budget_owner_project_id };
      headline = "Orçamento de IA indisponível"; detail = blockers[0]?.message ?? null; severity = "error";
    } else {
      action = { key: "edit_rfc", label: "Corrigir o RFC do card", method: "GET", path: draft ? `/api/projects/${draft.id}/spec-tree` : null, enabled: !!draft };
      headline = "O RFC precisa de ajustes"; detail = blockers[0]?.message ?? null; severity = "warning";
    }
  } else if (state === "ready") {
    phase = "ready";
    const ready = (extra.card_ready ?? null) as CardReadySnapshot | null;
    if (!ready || !draft) blockers.push(blocker("CARD_NOT_READY", "O card não tem o carimbo da validação."));
    else {
      const nowHash = await specHashOf(pool, draft.id);
      if (nowHash !== ready.draft_spec_hash) blockers.push(blocker("CARD_NOT_READY", "A spec do rascunho mudou depois da validação."));
    }
    if (head) {
      if (base?.stale || (ready && head.id !== ready.base_head_project_id)) blockers.push(blocker("CARD_BASE_STALE", `A versão corrente avançou para v${head.version_number}.`, { currentHead: head.id }));
      const denied = await budgetPreflight(pool, head.id, card.tenant_id, head.version_number);
      if (denied) blockers.push(blocker(String(denied.body.code ?? "BUDGET_INSUFFICIENT"), String(denied.body.message ?? "Orçamento indisponível.")));
    }
    if (blockers.length === 0) {
      action = { key: "promote", label: "Promover à fábrica", method: "POST", path: `${cardPath}/promote`, enabled: true };
      headline = "Pronto para promover"; detail = "A promoção cria a versão nova contra a versão corrente."; severity = "success";
    } else if (blockers.some((b) => b.code === "CARD_BASE_STALE")) {
      action = { key: "revalidate", label: "Revalidar contra a versão corrente", method: "POST", path: `${cardPath}/revalidate`, enabled: true };
      headline = "A versão-base mudou"; detail = blockers[0].message; severity = "warning";
    } else if (blockers.some((b) => b.code === "CARD_NOT_READY")) {
      action = { key: "reopen", label: "Reabrir o card para ajustar", method: "POST", path: `${cardPath}/reopen`, enabled: true };
      headline = "Valide o card de novo"; detail = blockers[0].message; severity = "warning";
    } else {
      action = { key: "increase_budget", label: "Aumentar o orçamento", method: "PUT", path: draft?.budget_owner_project_id ? `/api/projects/${draft.budget_owner_project_id}/budget` : null, enabled: !!draft?.budget_owner_project_id };
      headline = "Orçamento de IA indisponível"; detail = blockers[0].message; severity = "error";
    }
  } else if (state === "promoted") {
    phase = "running";
    if (child?.status === "materializing") {
      blockers.push(blocker("MATERIALIZATION_IN_PROGRESS", "A versão nova ainda está sendo montada (clone, árvore e RFC)."));
      action = { key: "promote", label: "Retomar a promoção", method: "POST", path: `${cardPath}/promote`, enabled: true };
      headline = "Montando a versão nova"; severity = "info";
    } else {
      blockers.push(blocker("CARD_CHILD_NOT_IN_FACTORY", `A execução ainda não entrou na fábrica (status ${child?.status ?? "desconhecido"}).`));
      headline = "Aguardando a fábrica"; severity = "info";
    }
  } else if (state === "in_factory") {
    phase = "running";
    blockers.push(blocker("CARD_CHILD_NOT_ACCEPTED", `A execução está em andamento (status ${child?.status ?? "desconhecido"}) e ainda não foi aceita.`));
    headline = "Em execução na fábrica"; severity = "info";
  } else if (state === "blocked") {
    phase = "blocked";
    const kindB = blockedKind(card.blocked_reason);
    blockedInfo = { reason: card.blocked_reason, kind: kindB, resumable: true };
    if (kindB === "budget") {
      blockers.push(blocker("CARD_BUDGET_BLOCKED", `O Guard de custo parou a execução (${card.blocked_reason}).`, { reason: card.blocked_reason }));
      action = { key: "resume", label: "Retomar o card", method: "POST", path: `${cardPath}/resume`, enabled: true };
      headline = "Bloqueado por orçamento"; detail = "Aumente o orçamento da versão e retome o card."; severity = "error";
    } else {
      blockers.push(blocker(kindB === "materialization" ? "MATERIALIZATION_FAILED" : "CARD_CHILD_NOT_IN_FACTORY", `Bloqueado: ${card.blocked_reason ?? "sem motivo registrado"}.`, { reason: card.blocked_reason }));
      action = { key: "resume", label: "Retomar o card", method: "POST", path: `${cardPath}/resume`, enabled: true };
      headline = "Card bloqueado"; detail = `Motivo: ${card.blocked_reason ?? "não registrado"}.`; severity = "error";
    }
  } else if (state === "delivered") {
    phase = "delivered"; headline = "Entregue"; severity = "success";
  } else if (state === "rejected") {
    phase = "rejected"; headline = "Card recusado"; severity = "warning";
  } else {
    headline = "Fora da Bancada de cards"; detail = "Este pedido é um ticket legado, sem estado de card.";
  }

  return {
    cardId: card.id, code, state, kind, phase, steps, current, next, blockers, action, headline, detail, severity, blocked: blockedInfo,
    spec: { locked: !(state === "draft" || state === "refining"), canReopen: state === "ready" },
    base, execution,
  };
}

