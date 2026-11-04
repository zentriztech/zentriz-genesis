// Tipos e rótulos dos cards da Bancada (plano EVOLUIR-PROJETO, Fase 3). Contrato real: relatório R
// (project/docs/analysis/EVOLUIR-PROJETO-R-fase2-api-de-cards.md §2). Campos marcados "ASSUMIDO"
// ainda não existem no api-node (frente K1) e são tratados como opcionais pelo portal.

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
  kind?: string; origin?: string; contentSha256?: string; derivedFromAttachmentId?: string | null;
}

export interface CardEvent {
  from: CardState | null; to: CardState; actor: string; reason: string | null; childProjectId: string | null; at: string;
}

export interface CardActions {
  edit: boolean; refine: boolean; ready: boolean; promote: boolean; revalidate: boolean; reject: boolean; resume: boolean; delete: boolean;
}

export interface CardDetail extends CardSummary {
  body: string;
  attachments: CardAttachment[];
  events: CardEvent[];
  base: { headProjectId: string; headVersion: number; validatedAt: string | null } | null;
  actions: CardActions;
  /** ASSUMIDO (K1): trava da spec (`CARD_SPEC_LOCKED`). Ausente ⇒ o portal deriva de `state === "ready"`. */
  specLocked?: boolean;
}

export interface BaseSpecFile {
  path: string; relDir: string; filename: string; isPrimary: boolean; sizeBytes: number; contentSha256: string; content: string; truncated: boolean;
}
export interface BaseSpec {
  readOnly: true; headProjectId: string; headVersion: number; title: string; specHash: string | null;
  baseHeadProjectId: string | null; stale: boolean; files: BaseSpecFile[];
}

/** ASSUMIDO (K1): `GET /api/products/:id/cards/capabilities` pode trazer limites de anexo e saldo. */
export interface CardCapabilities {
  cardsBancada: boolean;
  attachments?: { allowedExtensions: string[]; maxFiles?: number; maxTotalBytes?: number; maxFileBytes?: number };
  budget?: { freeUsd: number | null; minFreeUsd: number | null };
}

/** ASSUMIDO (K1): `GET /api/cards/:id/journey`. */
export interface JourneyStep { key: string; label: string; state: "done" | "current" | "todo" | "blocked"; at?: string | null }
export interface CardJourney { cardId: string; state: CardState; steps: JourneyStep[]; nextAction?: { code?: string; label: string } | null }

export const DEFAULT_ATTACHMENT_EXTENSIONS = ["pdf", "txt", "md", "doc", "docx"];
