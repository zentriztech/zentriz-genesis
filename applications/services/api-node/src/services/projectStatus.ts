/**
 * projectStatus.ts — fonte ÚNICA de verdade para a partição de status de projeto
 * relevante ao modelo "todo App pertence a um Produto" (migration 064).
 *
 * Dois conjuntos disjuntos e exaustivos para o eixo INBOX:
 *  - PRE_FACTORY_STATUSES: specs/rascunhos re-alocáveis ⟺ elegíveis ao INBOX "Rascunhos".
 *  - FACTORY_OR_TERMINAL_STATUSES: App em produção/terminal — NUNCA vive no inbox.
 *
 * Decisão G1 (rodada adversarial): `cto_charter`/`pm_backlog` contam como FÁBRICA-ATIVA
 * (watchdog.ts os lista em MILESTONE_STATUSES); `spec_validation_failed` é o único
 * status não-`draft` que ainda é PRÉ-fábrica (spec reprovou validação → volta ao inbox).
 *
 * Usado por: migration 064 (backfill), detach/PATCH-null, funil de criação, graduação
 * do inbox e consumo do decompose. Manter em sincronia com o CHECK de projects_status_check
 * (migration 062).
 */

/** Pré-fábrica / re-alocáveis como rascunho ⟺ elegíveis ao INBOX. */
export const PRE_FACTORY_STATUSES = [
  "draft",
  "spec_submitted",
  "pending_conversion",
  "spec_validation_failed",
] as const;

/** Fábrica-ativa / terminal — produção, NUNCA rascunho de inbox. */
export const FACTORY_OR_TERMINAL_STATUSES = [
  "running",
  "queued",
  "cto_charter",
  "pm_backlog",
  "dev_qa",
  "devops",
  "pending_cyborg",
  "blocked_cyborg",
  "accepted",
  "completed",
  "stopped",
  "failed",
] as const;

export type PreFactoryStatus = (typeof PRE_FACTORY_STATUSES)[number];
export type FactoryOrTerminalStatus = (typeof FACTORY_OR_TERMINAL_STATUSES)[number];

const PRE_FACTORY_SET: ReadonlySet<string> = new Set(PRE_FACTORY_STATUSES);

/** true se o status é pré-fábrica (rascunho re-alocável / elegível ao inbox). */
export function isPreFactory(status: string): boolean {
  return PRE_FACTORY_SET.has(status);
}
