// Fixtures de teste (Vitest e E2E) construídas SOBRE as respostas reais do backend (`__contract__`), nunca à mão.
// Não é importado pelo app.
import type { CardActions, CardDetail, CardJourney, CardSummary } from "./types";
import { ApiError } from "@/lib/api";
import { body, fixture } from "./contractFixtures";

export const NO_ACTIONS: CardActions = { edit: false, refine: false, ready: false, promote: false, revalidate: false, reopen: false, reject: false, resume: false, delete: false };

/** Nomes das fixtures de detalhe/jornada por estado do card. */
export type FixtureState = "draft" | "refining" | "ready" | "promoted" | "in_factory" | "blocked" | "delivered" | "rejected";

export const detailOf = (state: FixtureState): CardDetail => body<CardDetail>(`detail.${state}`);
export const journeyOf = (name: string): CardJourney => body<CardJourney>(`journey.${name}`);

/** Detalhe real do estado pedido (padrão: rascunho), com sobrescritas. */
export function makeDetail(over: Partial<CardDetail> = {}, state: FixtureState = "draft"): CardDetail {
  return { ...detailOf(state), ...over };
}

export function makeCard(over: Partial<CardSummary> = {}): CardSummary {
  const { body: _b, attachments: _a, events: _e, base: _base, actions: _ac, ...summary } = detailOf("draft");
  void _b; void _a; void _e; void _base; void _ac;
  return { ...summary, ...over };
}

/** Jornada real (`journey.<name>`), com sobrescritas. Nomes: draft-no-rfc, draft-ready-to-validate, refining, ready, ready-base-stale, promoted, in_factory, blocked-budget, delivered, rejected… */
export function makeJourney(name: string, over: Partial<CardJourney> = {}): CardJourney {
  return { ...journeyOf(name), ...over };
}

/** `ApiError` exatamente como o cliente HTTP monta a partir de uma resposta de erro REAL (`__contract__/<name>.json`). */
export function apiErrorFrom(name: string): ApiError {
  const f = fixture<Record<string, unknown>>(name);
  const ra = f.headers?.["retry-after"] ? Number(f.headers["retry-after"]) : undefined;
  return new ApiError(String(f.body?.message ?? ""), f.status, typeof f.body?.code === "string" ? f.body.code : undefined, f.body ?? undefined, ra);
}
