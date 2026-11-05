/**
 * cardPromote.ts — promoção do card (tarefa 2.6, desenho H §1.2/§5.4/§6) e coerência card × filho.
 *
 * `promoteCard`: o rascunho `card_draft` vira filho de evolução SÓ aqui (versão `vN` contra o HEAD corrente, cópia da árvore,
 * clone, branch `evolution/vN`, spec do card movida para o filho). O trabalho pesado é o MESMO claim em duas etapas do /evolve
 * (`evolveClaim.ts`, parâmetro `card`): advisory lock por linhagem, filho em `materializing` na mesma transação da promoção
 * `ready → promoted` (máquina de estados), passos idempotentes com lease, retomada por repetição. Este módulo acrescenta o que é do card:
 *   • precondições fora do lock: estado `ready`, hash da spec do rascunho = o do carimbo `card_ready` (senão volta a `refining`,
 *     409 CARD_NOT_READY) e HEAD = base registrada (senão volta a `refining`, 409 CARD_BASE_STALE com a instrução de revalidar);
 *   • idempotência: card já promovido ⇒ 200 `replayed` (filho vivo) ou retoma a materialização vencida;
 *   • `syncCardWithChild`: `promoted → in_factory` quando o filho entra na fábrica; filho `failed/archived` ⇒ `blocked`;
 *   • `resumeCard`: retomada de `blocked` (filho de volta à fábrica ⇒ `in_factory`; filho descartado ⇒ `ready`, vínculo limpo);
 *   • `legacyEvolveBlockedByCard`: o `/evolve` legado não promove ticket-card (409 USE_CARD_PROMOTE).
 */
import type { Pool } from "pg";
import type { AuthUser } from "../middleware/auth.js";
import { canAccessProjectRow } from "../lib/projectAccess.js";
import { resolveLineageRoot, resolveLineageHead } from "./lineage.js";
import { runEvolveWithClaim, type EvolveLog, type EvolveResult } from "./evolveClaim.js";
import { transitionCard, isSupersededChild, PR_CLOSED_UNMERGED_REASON, type CardState, type CardTransitionResult } from "./cardState.js";
import { loadCard, specHashOf, registeredBaseStale, type CardRow, type CardReadySnapshot } from "./cardService.js";
import { PRE_FACTORY_CHILD_STATUSES } from "./cardsBackfill.js";
import { verifyChildPrMerged, type DeliveryDeps } from "./cardDelivery.js";
import { ticketCode } from "./tickets.js";

type Json = Record<string, unknown>;

const DEAD_CHILD = new Set(["failed", "archived"]);

async function draftExtraOf(pool: Pool, card: CardRow): Promise<Json | null> {
  if (!card.draft_project_id) return null;
  const r = (await pool.query("SELECT extra FROM projects WHERE id = $1 AND status = 'card_draft'", [card.draft_project_id])).rows[0] as { extra: Json | null } | undefined;
  return r ? (r.extra ?? {}) : null;
}

async function cardView(pool: Pool, id: string): Promise<{ cardId: string; cardState: string | null; cardStatus: string; draftProjectId: string | null; childProjectId: string | null }> {
  const r = (await pool.query("SELECT id, card_state, status, draft_project_id, child_project_id FROM tickets WHERE id = $1", [id])).rows[0] as Json | undefined;
  return {
    cardId: id, cardState: (r?.card_state as string | null) ?? null, cardStatus: String(r?.status ?? ""),
    draftProjectId: (r?.draft_project_id as string | null) ?? null, childProjectId: (r?.child_project_id as string | null) ?? null,
  };
}

/** Volta o card a `refining` (sistema) quando a promoção descobre que o carimbo "pronto" não vale mais. Idempotente. */
async function backToRefining(pool: Pool, card: CardRow, reason: string): Promise<void> {
  await transitionCard(pool, { ticketId: card.id, to: "refining", actorKind: "system", reason }).catch(() => undefined);
}

/**
 * Regra de linhagem (rodada 4.5c, D-4): um card só é promovido sobre uma base cujo filho-de-card anterior foi ENTREGUE (PR mergeado),
 * rejeitado ou dispensado. O HEAD da linhagem é o filho de um card ainda `promoted|in_factory|blocked` cujo código NÃO está em `dev`
 * (sem prova de merge) ⇒ o novo filho herdaria código não revisado (TK-0007 herdou o build quebrado do PR do TK-0006).
 * Só vale para HEAD que é filho de CARD (ticket legado e raiz ficam intactos). Linhagem sem repositório: o aceite do filho já é a entrega
 * (prova `no_repo`). A prova de merge usa a MESMA função da entrega (`verifyChildPrMerged`: fail-closed). Devolve o 409 ou `null`.
 */
export async function previousCardUnmergedBlock(pool: Pool, headId: string, selfTicketId: string, deps: DeliveryDeps = {}): Promise<EvolveResult | null> {
  const prev = (await pool.query(
    `SELECT t.id, t.number, t.card_state, p.extra, p.version_number
       FROM tickets t JOIN projects p ON p.id = t.child_project_id
      WHERE t.child_project_id = $1 AND t.id <> $2 AND t.card_state IN ('promoted', 'in_factory', 'blocked')
      ORDER BY t.number LIMIT 1`, [headId, selfTicketId])).rows[0] as
    { id: string; number: number; card_state: string; extra: Json | null; version_number: number } | undefined;
  if (!prev) return null;
  const proof = await verifyChildPrMerged(pool, headId, deps);
  if (proof.merged) return null;
  const ex = prev.extra ?? {};
  const prNumber = typeof ex.evolution_pr_number === "number" ? ex.evolution_pr_number : null;
  const prUrl = typeof ex.evolution_pr_url === "string" ? ex.evolution_pr_url : null;
  const code = ticketCode(prev.number);
  const pr = prNumber ? `PR #${prNumber}${prUrl ? ` (${prUrl})` : ""}` : "PR ainda não publicado/registrado";
  return {
    status: 409,
    body: {
      code: "CARD_PREVIOUS_UNMERGED",
      message: `A versão-base (v${prev.version_number}) é o resultado do card ${code}, que ainda NÃO foi entregue (${pr}; motivo: ${proof.detail}). Promover agora herdaria código não mergeado.`,
      blockingCardId: prev.id, blockingCardCode: code, blockingCardState: prev.card_state,
      blockingProjectId: headId, blockingPrNumber: prNumber, blockingPrUrl: prUrl, mergeProof: proof.detail,
      action: `Mergeie o PR do ${code} em dev (ou rejeite o card ${code} e descarte o filho) e promova de novo. Esta chamada é segura de repetir.`,
    },
  };
}

/** Status do filho que contam como "ainda em andamento" na linhagem (mesmo critério de `liveChildOf` do claim do /evolve). */
const LIVE_CHILD_EXCLUDED = ["accepted", "archived", "failed"];

const IN_PROGRESS_SQL = `SELECT t.id, t.number, t.card_state, p.id AS child_id, p.status AS child_status, p.version_number
       FROM tickets t JOIN projects p ON p.id = t.child_project_id
      WHERE t.id <> $2 AND t.card_state IN ('promoted', 'in_factory', 'blocked') AND p.status <> ALL($3::text[])`;

type InProgressRow = { id: string; number: number; card_state: string; child_id: string; child_status: string; version_number: number };

function inProgressResult(prev: InProgressRow): EvolveResult {
  const code = ticketCode(prev.number);
  return {
    status: 409,
    body: {
      code: "CARD_PREVIOUS_IN_PROGRESS",
      message: `Outro card da linhagem (${code}) ainda está em andamento: a versão v${prev.version_number} dele está em '${prev.child_status}'. Só se promove um card novo quando o anterior chega a um estado final.`,
      blockingCardId: prev.id, blockingCardCode: code, blockingCardState: prev.card_state,
      blockingProjectId: prev.child_id, blockingChildStatus: prev.child_status, blockingChildVersion: prev.version_number,
      action: `Aguarde o ${code} terminar, retome a execução dele (corrija o bloqueio e religue o filho) ou recuse-o com POST /api/cards/${prev.id}/reject e promova de novo. Esta chamada é segura de repetir.`,
      rejectBlockingCard: `POST /api/cards/${prev.id}/reject`,
    },
  };
}

/**
 * Rodada 4.5d (BF): promover um card com OUTRO card da linhagem ainda em andamento (filho `blocked_cyborg`, `running`, …) devolvia o 409
 * genérico `EVOLUTION_IN_FLIGHT` do /evolve legado, sem dizer qual card segurava a linhagem. Agora, quando o filho vivo da base pertence a
 * um card (`promoted|in_factory|blocked`), a resposta é `CARD_PREVIOUS_IN_PROGRESS` com o card bloqueante, o estado do filho e a ação.
 * Filho vivo que NÃO é de card (evolução legada) mantém `EVOLUTION_IN_FLIGHT`. `null` = nada a bloquear.
 */
export async function previousCardInProgressBlock(pool: Pick<Pool, "query">, headId: string, selfTicketId: string): Promise<EvolveResult | null> {
  const prev = (await pool.query(`${IN_PROGRESS_SQL} AND p.parent_project_id = $1 ORDER BY p.created_at DESC LIMIT 1`, [headId, selfTicketId, LIVE_CHILD_EXCLUDED])).rows[0] as InProgressRow | undefined;
  return prev ? inProgressResult(prev) : null;
}

/** Mesma tradução para a corrida: o claim devolveu `EVOLUTION_IN_FLIGHT` com o `childProjectId` do filho vivo. */
async function inProgressFromChild(pool: Pick<Pool, "query">, childId: string, selfTicketId: string): Promise<EvolveResult | null> {
  const prev = (await pool.query(`${IN_PROGRESS_SQL} AND p.id = $1 LIMIT 1`, [childId, selfTicketId, LIVE_CHILD_EXCLUDED])).rows[0] as InProgressRow | undefined;
  return prev ? inProgressResult(prev) : null;
}

export const REVALIDATE_HINT = (cardId: string) => `POST /api/cards/${cardId}/revalidate`;

export async function promoteCard(pool: Pool, card: CardRow, user: AuthUser, log: EvolveLog, deps: DeliveryDeps = {}): Promise<EvolveResult> {
  const state = card.card_state;

  // Já promovido (ou adiante): repetir é seguro. Filho vivo ⇒ 200 replayed; materialização vencida ⇒ retoma.
  if (state === "promoted" || state === "in_factory" || state === "delivered" || state === "blocked") {
    const child = card.child_project_id
      ? (await pool.query("SELECT id, status, parent_project_id, version_number, title, extra FROM projects WHERE id = $1", [card.child_project_id])).rows[0] as
        { id: string; status: string; parent_project_id: string | null; version_number: number; title: string; extra: Json | null } | undefined
      : undefined;
    if (child && !DEAD_CHILD.has(child.status)) {
      if (child.status === "materializing" && child.parent_project_id) {
        const draftId = card.draft_project_id ?? "";
        const r = await runEvolveWithClaim(pool, {
          parentId: child.parent_project_id, user, ticketId: card.id, evolutionRequest: "", workMode: "copy", idempotencyKey: null, log,
          card: { draftProjectId: draftId, actorId: user.id },
        });
        return enrich(pool, card.id, r);
      }
      return {
        status: 200,
        body: {
          ...(await cardView(pool, card.id)),
          ok: true, replayed: true, childProjectId: child.id, parentProjectId: child.parent_project_id, versionNumber: child.version_number,
          status: child.status, title: child.title,
          message: "Este card já foi promovido: a repetição devolve o filho existente.",
        },
      };
    }
    return {
      status: 409,
      body: {
        code: "CARD_NOT_READY", state,
        message: state === "blocked"
          ? `O card está bloqueado (${card.blocked_reason ?? "sem motivo"}) e o filho não está vivo: use POST /api/cards/${card.id}/resume para devolvê-lo a 'ready' e promova de novo.`
          : `O card está em '${state}' e não tem filho vivo para devolver.`,
      },
    };
  }
  if (state !== "ready") {
    return { status: 409, body: { code: "CARD_NOT_READY", state, message: `Só um card em 'ready' pode ser promovido (estado atual: ${state ?? "legado"}). Rode a validação (POST /api/cards/${card.id}/ready).` } };
  }

  // Precondições FORA do lock: carimbo da maturação, spec do rascunho intacta e base ainda no HEAD.
  const extra = await draftExtraOf(pool, card);
  const ready = (extra?.card_ready ?? null) as CardReadySnapshot | null;
  if (!extra || !ready || !ready.base_head_project_id) {
    await backToRefining(pool, card, "ready_stamp_missing");
    return { status: 409, body: { code: "CARD_NOT_READY", state: "refining", message: "O card não tem o carimbo da validação (base registrada). Valide de novo.", next: `POST /api/cards/${card.id}/ready` } };
  }
  const nowHash = await specHashOf(pool, card.draft_project_id!);
  if (nowHash !== ready.draft_spec_hash) {
    await backToRefining(pool, card, "draft_changed_after_ready");
    return { status: 409, body: { code: "CARD_NOT_READY", state: "refining", message: "A spec do rascunho mudou depois da validação. Valide de novo antes de promover.", next: `POST /api/cards/${card.id}/ready` } };
  }
  const rootId = String(extra.card_target_root_id ?? "") || (await resolveLineageRoot(pool, ready.base_head_project_id))?.id || "";
  const head = rootId ? await resolveLineageHead(pool, rootId) : null;
  const baseHash = head && head.id === ready.base_head_project_id ? await specHashOf(pool, head.id) : null;
  // D-17: além do carimbo, a base registrada do rascunho (`card_base`) tem de ser o HEAD corrente (defesa em profundidade).
  const regStale = registeredBaseStale(extra, head?.id ?? null);
  if (!head || head.id !== ready.base_head_project_id || regStale || (ready.base_spec_hash && baseHash !== ready.base_spec_hash)) {
    await backToRefining(pool, card, "base_stale");
    return staleResult(card.id, regStale ?? ready.base_head_project_id, head?.id ?? null);
  }

  // A base precisa estar ENTREGUE (ou ser dispensada): o card continua `ready` (nada é revertido); basta mergear o PR anterior e repetir.
  const blocked = await previousCardUnmergedBlock(pool, head.id, card.id, deps);
  if (blocked) return blocked;
  // Outro card da linhagem em andamento (ex.: filho `blocked_cyborg`): resposta específica de card, não o 409 genérico do /evolve.
  const inProgress = await previousCardInProgressBlock(pool, head.id, card.id);
  if (inProgress) return inProgress;

  const r = await runEvolveWithClaim(pool, {
    parentId: ready.base_head_project_id, user, ticketId: card.id, evolutionRequest: "", workMode: "copy", idempotencyKey: null, log,
    card: { draftProjectId: card.draft_project_id!, actorId: user.id },
  });
  if (r.status === 409 && typeof r.body.revertToRefining === "string") {
    // Y-01: o claim reavaliou carimbo/hash/gate dentro do lock e achou o card fora do que foi validado: volta a `refining`.
    const { revertToRefining, ...body } = r.body;
    await backToRefining(pool, card, String(revertToRefining));
    return { ...r, body };
  }
  if (r.status === 409 && r.body.code === "CARD_BASE_STALE") {
    // Detectado DENTRO do lock (HEAD mudou entre a checagem e o claim): mesma resposta, mesma volta a `refining`.
    await backToRefining(pool, card, "base_stale");
    return staleResult(card.id, String(r.body.expectedHead ?? ready.base_head_project_id), (r.body.currentHead as string | undefined) ?? null);
  }
  if (r.status === 409 && r.body.code === "EVOLUTION_IN_FLIGHT" && typeof r.body.childProjectId === "string") {
    // Corrida: o filho vivo apareceu entre a checagem e o claim.
    const translated = await inProgressFromChild(pool, r.body.childProjectId, card.id);
    if (translated) return translated;
  }
  return enrich(pool, card.id, r);
}

function staleResult(cardId: string, expectedHead: string, currentHead: string | null): EvolveResult {
  return {
    status: 409,
    body: {
      code: "CARD_BASE_STALE", expectedHead, currentHead, state: "refining",
      message: "A versão-base do card foi superada por uma versão mais nova da linhagem. Revalide o card e valide de novo antes de promover.",
      revalidate: REVALIDATE_HINT(cardId),
    },
  };
}

async function enrich(pool: Pool, cardId: string, r: EvolveResult): Promise<EvolveResult> {
  if (r.status === 200 || r.status === 201) return { ...r, body: { ...r.body, ...(await cardView(pool, cardId)) } };
  return r;
}

// ── Coerência card × filho ────────────────────────────────────────────────────────────────────
/** O status do filho conta como "na fábrica" (H §4.1): fora da pré-fábrica e vivo. */
export function childInFactory(status: string): boolean {
  return !(PRE_FACTORY_CHILD_STATUSES as readonly string[]).includes(status) && !DEAD_CHILD.has(status) && status !== "card_draft";
}

/** Prefixo de `blocked_reason` quando o Guard de custo parou o filho (`stopped_by = 'budget'`). */
export const BUDGET_BLOCK_PREFIX = "budget:";
export const isBudgetBlockReason = (r: string | null | undefined): boolean => typeof r === "string" && r.startsWith(BUDGET_BLOCK_PREFIX);

/**
 * Aplica a transição que o estado REAL do filho pede (ator `system`): `promoted|blocked → in_factory` quando o filho está na
 * fábrica; `promoted|in_factory → blocked` quando o filho morreu (failed/archived). Idempotente; nunca lança por regra.
 * Esperas humanas (`blocked_cyborg`, `needs_spec_input`, `stopped`) NÃO bloqueiam o card (H §4.1) — com UMA exceção (Fase 3, 3.5):
 * filho parado PELO GUARD DE CUSTO (`stopped` + `stopped_by = 'budget'`) e orçamento ainda sem saldo ⇒ card `blocked` com
 * `blocked_reason = 'budget:<CÓDIGO_DO_GUARD>'` (ator `guard`) — nunca `failed`. Com saldo de volta (pausa liberada) o bloqueio de
 * orçamento cai: o card volta a `in_factory` e o filho segue `stopped` esperando o usuário religá-lo (liberar a pausa não religa a execução).
 */
export async function syncCardWithChild(pool: Pool, ticketId: string): Promise<CardTransitionResult | null> {
  const t = (await pool.query(
    `SELECT t.card_state, t.blocked_reason, t.child_project_id, p.status AS child_status, p.stopped_by AS child_stopped_by, p.extra AS child_extra
       FROM tickets t LEFT JOIN projects p ON p.id = t.child_project_id
      WHERE t.id = $1 AND t.card_state IS NOT NULL`, [ticketId])).rows[0] as
    { card_state: CardState; blocked_reason: string | null; child_project_id: string | null; child_status: string | null; child_stopped_by: string | null; child_extra: Record<string, unknown> | null } | undefined;
  if (!t || !t.child_status) return null;
  // A1: filho arquivado por supersessão foi ACEITO — não bloqueia o card; a entrega (merge do PR) o leva a `delivered`.
  if (isSupersededChild(t.child_status, t.child_extra)) return null;
  // PR do filho aceito fechado sem merge: o card fica `blocked` até um humano decidir (recusar, ou reabrir o PR e retomar) — a sync não o reabre.
  if (t.card_state === "blocked" && t.blocked_reason === PR_CLOSED_UNMERGED_REASON) return null;
  if (DEAD_CHILD.has(t.child_status)) {
    if (t.card_state === "promoted" || t.card_state === "in_factory") {
      return transitionCard(pool, { ticketId, to: "blocked", actorKind: "system", reason: `child_${t.child_status}`, dedupeKey: `child_${t.child_status}:${t.child_project_id ?? "none"}` });
    }
    return null;
  }
  const budgetStopped = t.child_status === "stopped" && t.child_stopped_by === "budget";
  if (budgetStopped && t.child_project_id) {
    const gate = await childBudgetGate(pool, t.child_project_id);
    if (!gate.ok && (t.card_state === "promoted" || t.card_state === "in_factory")) {
      // A-2 (AV): `dedupeKey` POR OCORRÊNCIA (filho + código + instância da pausa). A mesma parada não escreve dois eventos, mas uma
      // SEGUNDA pausa (pausa → retomada → pausa) tem outra instância e leva o card a `blocked` de novo.
      const occ = await stopOccurrence(pool, t.child_project_id, gate.code);
      return transitionCard(pool, { ticketId, to: "blocked", actorKind: "guard", reason: `${BUDGET_BLOCK_PREFIX}${gate.code}`, dedupeKey: `budget_stop:${t.child_project_id}:${gate.code}:${occ}` });
    }
    if (!gate.ok && t.card_state === "blocked" && isBudgetBlockReason(t.blocked_reason) && t.blocked_reason !== `${BUDGET_BLOCK_PREFIX}${gate.code}`) {
      return transitionCard(pool, { ticketId, to: "blocked", actorKind: "guard", reason: `${BUDGET_BLOCK_PREFIX}${gate.code}` });
    }
    if (!gate.ok) return null;
    // saldo de volta: cai no ramo "bloqueio de orçamento resolvido" abaixo.
  }
  // F5 (5.1): teto do card em % estourado com o filho ainda VIVO e não parado (ex.: Bancada, que mantém o status). O Guard
  // (`cardBudgetCheck`) é soberano: negou ⇒ `blocked` por orçamento (`budget:CARD_BUDGET_CAP`), nunca `failed`. Sem política não consulta nada novo.
  if (t.child_project_id && (t.card_state === "promoted" || t.card_state === "in_factory") && !budgetStopped) {
    const gate = await childBudgetGate(pool, t.child_project_id);
    if (!gate.ok && gate.code === "CARD_BUDGET_CAP") {
      const occ = await stopOccurrence(pool, t.child_project_id, "CARD_BUDGET_CAP");
      return transitionCard(pool, { ticketId, to: "blocked", actorKind: "guard", reason: `${BUDGET_BLOCK_PREFIX}CARD_BUDGET_CAP`, dedupeKey: `budget_stop:${t.child_project_id}:CARD_BUDGET_CAP:${occ}` });
    }
  }
  if (t.card_state === "blocked" && isBudgetBlockReason(t.blocked_reason)) {
    // Bloqueio de orçamento só cai quando o Guard libera de novo (pausa limpa e saldo para a próxima atividade).
    const gate = t.child_project_id ? await childBudgetGate(pool, t.child_project_id) : { ok: false as const, code: "PROJECT_NOT_FOUND" };
    if (gate.ok && !DEAD_CHILD.has(t.child_status)) {
      return transitionCard(pool, { ticketId, to: "in_factory", actorKind: "system", reason: "budget_released" });
    }
    return null;
  }
  if (childInFactory(t.child_status) && (t.card_state === "promoted" || t.card_state === "blocked")) {
    return transitionCard(pool, { ticketId, to: "in_factory", actorKind: "system", reason: "child_in_factory" });
  }
  return null;
}

/**
 * A-2 (AV): carimbo da OCORRÊNCIA da parada, para a chave de dedupe. Pausa do dono ⇒ `budget_paused_at` do dono (muda a cada pausa nova);
 * teto do card ⇒ instante do último `card_cap_reached` do filho; sem nenhum dos dois ⇒ `updated_at` do filho. Estável enquanto a MESMA
 * parada dura (repetir a passada não duplica evento) e diferente na parada seguinte.
 */
async function stopOccurrence(pool: Pool, childProjectId: string, code: string): Promise<string> {
  const ms = async (sql: string): Promise<string | null> => {
    const v = (await pool.query(sql, [childProjectId]).catch(() => ({ rows: [] as Array<Record<string, unknown>> }))).rows[0]?.ms;
    return v === null || v === undefined ? null : String(v);
  };
  if (code === "CARD_BUDGET_CAP") {
    const e = await ms(`SELECT (extract(epoch FROM max(created_at)) * 1000)::bigint AS ms FROM llm_guard_events WHERE project_id = $1 AND kind = 'card_cap_reached'`);
    if (e) return `cap${e}`;
  } else {
    const o = await ms(`SELECT (extract(epoch FROM o.budget_paused_at) * 1000)::bigint AS ms FROM projects p JOIN projects o ON o.id = COALESCE(p.budget_owner_project_id, p.id) WHERE p.id = $1`);
    if (o) return `pause${o}`;
  }
  return `upd${(await ms(`SELECT (extract(epoch FROM updated_at) * 1000)::bigint AS ms FROM projects WHERE id = $1`)) ?? "0"}`;
}

/** Guard de custo do filho (orçamento compartilhado: o dono é resolvido por `budget_owner_project_id`). */
async function childBudgetGate(pool: Pool, childProjectId: string): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const { checkProjectBudgetGate } = await import("./llmGuard.js");
  return checkProjectBudgetGate(pool as never, childProjectId);
}

/**
 * Reconciliador (Fase 3, 3.5): passa pelos cards com filho (`promoted|in_factory|blocked`) e aplica `syncCardWithChild` — é o que leva
 * a `blocked` (orçamento) o card cujo filho o Guard pausou, mesmo que ninguém consulte o card. Só roda com `EVOLVE_RECONCILER=on`.
 * Devolve quantas transições foram aplicadas. Nunca lança.
 * AN/A2: também é candidato o card cujo filho VIVO (Bancada: `draft`/`spec_submitted`, que o Guard não para) levou `card_cap_reached` nas últimas 24 h.
 */
export async function syncCardsWithChildren(pool: Pool, opts: { limit?: number } = {}): Promise<number> {
  let n = 0;
  try {
    // Só candidatos que PEDEM transição (um card saudável em `in_factory` não ocupa vaga): filho morto, filho parado pelo Guard,
    // bloqueio de orçamento a liberar, ou `promoted` cujo filho já entrou na fábrica.
    const rows = (await pool.query(
      `SELECT t.id FROM tickets t JOIN projects p ON p.id = t.child_project_id
        WHERE t.card_state IN ('promoted', 'in_factory', 'blocked')
          AND ( (t.card_state IN ('promoted', 'in_factory') AND p.status IN ('failed', 'archived') AND COALESCE(p.extra->>'superseded_by', '') = '')
             OR (t.card_state IN ('promoted', 'in_factory') AND p.status = 'stopped' AND p.stopped_by = 'budget')
             OR (t.card_state = 'blocked' AND t.blocked_reason LIKE 'budget:%')
             OR (t.card_state IN ('promoted', 'in_factory') AND EXISTS (
                  SELECT 1 FROM llm_guard_events e WHERE e.project_id = t.child_project_id AND e.kind = 'card_cap_reached'
                     AND e.created_at > now() - interval '24 hours'))
             OR (t.card_state = 'promoted' AND p.status <> ALL($2::text[])) )
        ORDER BY t.updated_at ASC LIMIT $1`,
      [opts.limit ?? 200, [...PRE_FACTORY_CHILD_STATUSES, "card_draft"]])).rows;
    for (const r of rows) {
      const res = await syncCardWithChild(pool, String(r.id)).catch(() => null);
      if (res && res.kind === "applied") n++;
    }
  } catch { /* detector nunca derruba a passada */ }
  return n;
}

/** Gancho fire-and-forget (início da fábrica): sincroniza o card ligado ao projeto, se houver. Nunca lança. */
export async function syncCardForChildProject(pool: Pool, childProjectId: string): Promise<void> {
  try {
    const r = await pool.query("SELECT id FROM tickets WHERE child_project_id = $1 AND card_state IS NOT NULL LIMIT 5", [childProjectId]);
    for (const row of r.rows) await syncCardWithChild(pool, String(row.id));
  } catch { /* best-effort por contrato */ }
}

export type CardResumeResult =
  | { kind: "resumed_in_factory"; childRestartRequired: boolean; childProjectId: string | null; childStatus: string | null }
  | { kind: "back_to_ready" }
  | { kind: "not_blocked"; state: CardState | null }
  | { kind: "child_not_in_factory"; childStatus: string }
  /** Bloqueio de orçamento e o Guard ainda nega: o card CONTINUA `blocked` (402 `CARD_BUDGET_BLOCKED`). */
  | { kind: "budget_still_blocked"; guardCode: string; guardMessage: string }
  | { kind: "transition_failed"; result: CardTransitionResult };

/**
 * Retomada de `blocked` (humano): filho na fábrica ⇒ `in_factory`; filho descartado/inexistente ⇒ `ready` (vínculo limpo).
 * Bloqueio de ORÇAMENTO (`blocked_reason = 'budget:*'`, Fase 3): só retoma quando o Guard libera de novo (saldo e pausa); sem saldo ⇒
 * `budget_still_blocked` e o card segue `blocked`. Com saldo, o card volta a `in_factory`; se o filho ainda está `stopped` (liberar a
 * pausa não religa a execução) a resposta traz `childRestartRequired` e o caminho para religá-lo.
 */
export async function resumeCard(pool: Pool, card: CardRow, user: AuthUser): Promise<CardResumeResult> {
  if (card.card_state !== "blocked") return { kind: "not_blocked", state: card.card_state };
  const child = card.child_project_id
    ? (await pool.query("SELECT status FROM projects WHERE id = $1", [card.child_project_id])).rows[0] as { status: string } | undefined
    : undefined;
  if (child && !DEAD_CHILD.has(child.status)) {
    if (isBudgetBlockReason(card.blocked_reason)) {
      const gate = await childBudgetGate(pool, card.child_project_id!);
      if (!gate.ok) return { kind: "budget_still_blocked", guardCode: gate.code, guardMessage: gate.message };
      const t = await transitionCard(pool, { ticketId: card.id, to: "in_factory", actorKind: "user", actorId: user.id, reason: "resume_budget" });
      return t.kind === "applied" || t.kind === "noop"
        ? { kind: "resumed_in_factory", childRestartRequired: child.status === "stopped", childProjectId: card.child_project_id, childStatus: child.status }
        : { kind: "transition_failed", result: t };
    }
    if (!childInFactory(child.status)) return { kind: "child_not_in_factory", childStatus: child.status };
    const t = await transitionCard(pool, { ticketId: card.id, to: "in_factory", actorKind: "user", actorId: user.id, reason: "resume" });
    return t.kind === "applied" || t.kind === "noop"
      ? { kind: "resumed_in_factory", childRestartRequired: false, childProjectId: card.child_project_id, childStatus: child.status }
      : { kind: "transition_failed", result: t };
  }
  const t = await transitionCard(pool, { ticketId: card.id, to: "ready", actorKind: "system", actorId: user.id, reason: "child_discarded", dedupeKey: `resume_discard:${card.child_project_id ?? "none"}` });
  return t.kind === "applied" || t.kind === "noop" ? { kind: "back_to_ready" } : { kind: "transition_failed", result: t };
}

// ── /evolve legado × card ─────────────────────────────────────────────────────────────────────
/**
 * `true` quando o ticket é um CARD (já está na máquina) que o usuário enxerga: o `/evolve` legado não o promove (contornaria base
 * e prontidão do card e divergiria `card_state` de `status`) ⇒ 409 USE_CARD_PROMOTE. Ticket inexistente/sem acesso ⇒ `null`
 * (o handler segue o caminho histórico e devolve o 404 de sempre).
 */
export async function legacyEvolveBlockedByCard(pool: Pool, user: AuthUser, ticketId: string): Promise<{ cardId: string } | null> {
  const card = await loadCard(pool, ticketId);
  if (!card || !canAccessProjectRow(user, card) || card.card_state === null || card.card_state === undefined) return null;
  return { cardId: card.id };
}
