// Fixtures de teste (Vitest e E2E) no formato do relatório R §2. Não é importado pelo app.
import type { CardActions, CardDetail, CardSummary } from "./types";

export const NO_ACTIONS: CardActions = { edit: false, refine: false, ready: false, promote: false, revalidate: false, reject: false, resume: false, delete: false };

export function makeCard(over: Partial<CardSummary> = {}): CardSummary {
  return {
    id: "c1", code: "TK-0001", number: 1, productId: "p1", projectId: "proj-head", kind: "evolution", title: "Exportar relatório em CSV",
    state: "draft", status: "open", origin: "manual", externalRef: null, blockedReason: null, draftProjectId: "draft-1", childProjectId: null,
    executionStatus: null, executionTitle: null, prUrl: null, attachmentsCount: 0, createdAt: "2026-11-04T10:00:00Z", updatedAt: "2026-11-04T10:00:00Z",
    promotedAt: null, deliveredAt: null, ...over,
  };
}

export function makeDetail(over: Partial<CardDetail> = {}): CardDetail {
  return {
    ...makeCard(), body: "Quero exportar o relatório mensal em CSV.", attachments: [], events: [{ from: null, to: "draft", actor: "user", reason: null, childProjectId: null, at: "2026-11-04T10:00:00Z" }],
    base: { headProjectId: "proj-head", headVersion: 1, validatedAt: null },
    actions: { ...NO_ACTIONS, edit: true, refine: true, reject: true, delete: true }, ...over,
  };
}
