// Tipos e rótulos dos cards da Bancada (plano EVOLUIR-PROJETO, Fase 3). O contrato é o do BACKEND REAL
// (`api-node`: routes/cards.ts, services/cardJourney.ts, cardErrors.ts…), provado pelas fixtures de
// `__contract__/*.json` (geradas pelo teste de contrato do api-node: `npm run contract:gen`) e validadas por
// `schemas.ts`. Nada aqui é "assumido": se o backend mudar, o teste de contrato do portal quebra.

export const CARD_STATES = ["draft", "refining", "ready", "promoted", "in_factory", "delivered", "blocked", "rejected"] as const;
export type CardState = (typeof CARD_STATES)[number];
export const CARD_KINDS = ["evolution", "fix", "feature"] as const;
export type CardKind = (typeof CARD_KINDS)[number];

export const STATE_LABEL: Record<CardState, string> = {
  draft: "Rascunho", refining: "Refinando", ready: "Pronto", promoted: "Promovido",
  in_factory: "Na fábrica", delivered: "Entregue", blocked: "Bloqueado", rejected: "Rejeitado",
};

/** Próxima ação sugerida por estado (texto, não só cor). */
export const NEXT_ACTION: Record<CardState, string> = {
  draft: "Escrever o pedido e iniciar o refinamento",
  refining: "Refinar a especificação e validar",
  ready: "Promover à fábrica",
  promoted: "Aguardar a fábrica iniciar",
  in_factory: "Acompanhar o projeto filho",
  delivered: "Concluído",
  blocked: "Resolver o bloqueio e retomar",
  rejected: "Nenhuma (card rejeitado)",
};

export const KIND_LABEL: Record<CardKind, string> = { evolution: "Evolução", fix: "Correção", feature: "Recurso novo" };
export const KIND_DESCRIPTION: Record<CardKind, string> = {
  evolution: "Muda ou amplia algo que o produto já faz. Segue o rito atual de evolução (RFC e gate de compatibilidade).",
  fix: "Corrige um defeito. Exige cenário de reprodução (FAIL_TO_PASS) e compatibilidade no máximo patch.",
  feature: "Acrescenta uma capacidade nova. Exige a seção \"Non-goals\" (não-objetivos) na especificação.",
};
export const KIND_RITE: Record<CardKind, string> = {
  evolution: "Rito atual: a especificação do card precisa de RFC válido e passar no gate de compatibilidade.",
  fix: "Rito da Correção: além do RFC, a especificação precisa de um cenário de reprodução (FAIL_TO_PASS) e a compatibilidade não pode passar de patch.",
  feature: "Rito do Recurso novo: além do RFC, a especificação precisa declarar os não-objetivos (seção \"Non-goals\").",
};

export const ORIGIN_LABEL: Record<string, string> = { manual: "Manual", import: "Importado", deadpool_incident: "Incidente" };

export interface CardSummary {
  id: string;
  code: string;                 // TK-NNNN
  number: number;
  productId: string;
  projectId: string | null;
  kind: CardKind;
  title: string;
  state: CardState;
  status: string;
  origin: string;
  externalRef: string | null;
  blockedReason: string | null;
  draftProjectId: string | null;
  childProjectId: string | null;
  executionStatus: string | null;
  executionTitle: string | null;
  prUrl: string | null;
  attachmentsCount: number;
  createdAt: string;
  updatedAt: string;
  promotedAt: string | null;
  deliveredAt: string | null;
}

export interface CardListResponse { items: CardSummary[]; total: number; limit: number; offset: number }

export interface CardAttachment {
  id: string; filename: string; mimeType: string; sizeBytes: number; downloadUrl: string;
  /** Presentes com ATTACHMENTS_STRICT. `origin: "converted"` = derivado automático .md. */
  kind?: string | null; origin?: string | null; contentSha256?: string | null; derivedFromAttachmentId?: string | null;
}

export interface CardEvent {
  from: CardState | null; to: CardState; actor: string; reason: string | null; childProjectId: string | null; at: string;
}

export interface CardActions {
  edit: boolean; refine: boolean; ready: boolean; promote: boolean; revalidate: boolean; reopen: boolean; reject: boolean; resume: boolean; delete: boolean;
}

export interface CardDetail extends CardSummary {
  body: string;
  attachments: CardAttachment[];
  /** Mais recente primeiro (o backend ordena por data decrescente, no máximo 50). */
  events: CardEvent[];
  /** `null` quando o card não tem rascunho. `validatedAt` só existe depois de "Validar". */
  base: { headProjectId: string | null; headVersion: number | null; validatedAt: string | null } | null;
  actions: CardActions;
}

export interface BaseSpecFile {
  path: string; relDir: string; filename: string; isPrimary: boolean; sizeBytes: number; contentSha256: string;
  /** `null` quando o arquivo passou do teto de leitura (`truncated: true`). */
  content: string | null; truncated: boolean;
}
export interface BaseSpec {
  readOnly: true; headProjectId: string; headVersion: number; title: string; specHash: string | null;
  baseHeadProjectId: string | null; stale: boolean; files: BaseSpecFile[];
}

/** `GET /api/products/:id/cards/capabilities` devolve SÓ a flag (limites de anexo e saldo são conferidos pelo servidor). */
export interface CardCapabilities { cardsBancada: boolean }

export type JourneyStageKey = "draft" | "refining" | "ready" | "promoted" | "in_factory" | "delivered";
export type JourneyStageState = "done" | "current" | "todo" | "blocked";
export type JourneyPhase = "editing" | "ready" | "running" | "blocked" | "delivered" | "rejected";
export type JourneySeverity = "success" | "info" | "warning" | "error";
export interface JourneyStep { key: JourneyStageKey; label: string; state: JourneyStageState }
export interface JourneyBlocker { code: string; message: string; userMessage: string | null; details?: unknown }
export interface JourneyAction { key: string; label: string; method: "GET" | "POST" | "PUT" | null; path: string | null; enabled: boolean }
/** `GET /api/cards/:id/journey`: o SERVIDOR decide etapa, bloqueios, ação sugerida e trava; a tela só renderiza. */
export interface CardJourney {
  cardId: string; code: string; state: CardState | null; kind: CardKind; phase: JourneyPhase;
  steps: JourneyStep[]; current: JourneyStageKey | null; next: JourneyStageKey | null;
  blockers: JourneyBlocker[]; action: JourneyAction | null;
  headline: string; detail: string | null; severity: JourneySeverity;
  blocked: { reason: string | null; kind: "budget" | "child" | "materialization" | "other"; resumable: boolean } | null;
  spec: { locked: boolean; canReopen: boolean };
  base: { headProjectId: string | null; headVersion: number | null; currentHeadProjectId: string | null; currentHeadVersion: number | null; stale: boolean } | null;
  execution: { childProjectId: string; status: string; title: string | null; prUrl: string | null } | null;
}

export type ConversionState = "not_applicable" | "disabled" | "queued" | "pending" | "running" | "done" | "empty" | "failed";
/** `GET /api/cards/:id/attachments`: anexos com o estado da conversão pdf/doc/docx → md. */
export interface CardAttachmentItem {
  id: string; filename: string; mimeType: string; sizeBytes: number;
  kind: string | null; origin: string | null; derivedFromAttachmentId: string | null; contentSha256: string | null; downloadUrl: string; createdAt: string;
  conversion: { state: ConversionState; attempts: number; errorCode: string | null; errorMessage: string | null; warnings: unknown[]; derivedAttachmentId: string | null; updatedAt: string | null };
}
export interface CardAttachmentsResponse { items: CardAttachmentItem[]; strict: boolean; conversionEnabled: boolean; summary: Record<string, number> }

export type RevalidateVerdict = "ok" | "stale" | "conflict";
export interface RevalidateReason { code: string; severity: "conflict" | "warning" | "info"; message: string; details?: Record<string, unknown> }
/** `POST /api/cards/:id/revalidate`. `ok:false` só no `conflict`; `next` é uma instrução em texto para humanos. */
export interface RevalidateResponse {
  ok: boolean; result: RevalidateVerdict; reasons: RevalidateReason[]; rebased: boolean; reopened: boolean; card: CardSummary;
  base: { headProjectId: string; headVersion: number; previousHeadProjectId: string | null };
  checks: { globs: unknown[]; repo: unknown; specDiff: unknown };
  next: string | null; message: string;
}

export interface CardActionResponse { ok: boolean; replayed: boolean; card: CardSummary; message?: string }
export interface ReadyResponse extends CardActionResponse { gate?: { rfcs: number; scope: string[]; compat: string; kind: string } }
export interface ResumeResponse { ok: boolean; replayed?: boolean; card: CardSummary; childRestartRequired?: boolean; next?: string; message?: string }
/** `POST /api/cards/:id/promote`: 201 (criou) ou 200 (`replayed`/`resumed`). Os campos do filho vêm do /evolve. */
export interface PromoteResponse {
  ok: boolean; childProjectId: string; versionNumber: number; cardId: string; cardState: CardState; cardStatus: string; draftProjectId: string | null;
  parentProjectId?: string | null; title?: string; status?: string; message?: string; replayed?: boolean; resumed?: boolean;
}

export const DEFAULT_ATTACHMENT_EXTENSIONS = ["pdf", "txt", "md", "doc", "docx"];
