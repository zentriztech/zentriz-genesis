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

/**
 * RFC-0004 (S1/Onda 4): estados em que a SPEC é EDITÁVEL — pré-fábrica ou parados/
 * bloqueados (onde editar é a remediação). Fora daqui, escrever spec muta o arquivo que
 * o runner está lendo → 409 SPEC_LOCKED. Fonte única p/ PATCH spec-content e endpoints
 * de árvore (spec-file).
 */
export const SPEC_EDITABLE_STATUSES = new Set([
  "draft", "spec_submitted", "pending_conversion", "stopped", "failed",
  "spec_validation_failed", "blocked_cyborg", "blocked_structural_gate",
  "blocked_backlog_empty_with_frs", "blocked_awaiting_expo_confirm",
  // D3: enquanto a fábrica espera resposta, editar a spec é uma remediação legítima.
  "needs_spec_input",
  // Fase 2 (2.1): rascunho de card — a spec do card é editada enquanto o card está em draft/refining/ready
  // (a trava por estado do card é aplicada pelos escritores de spec na Fase 3).
  "card_draft",
]);

/**
 * Fase 2 (2.1, desenho H §5.2/F14): status que NÃO existem para os leitores de "projetos do produto/tenant".
 * `card_draft` é o rascunho de um card (sem versão, sem pai, sem árvore herdada): não é spec viva do produto, não é
 * versão, não entra em contagens, listagens de projetos, agregado do produto nem em "Minhas SPECs". Todo leitor que
 * filtra por EXCLUSÃO de status (`<> 'archived'`) ou não filtra tem de aplicar este conjunto
 * (ver `NOT_HIDDEN_PROJECT_SQL`). Leitores por LISTA DE PERMISSÃO (`status IN (...)`) já o excluem por construção.
 */
export const HIDDEN_FROM_PRODUCT_STATUSES = ["card_draft"] as const;

/**
 * Fragmento SQL canônico (sem parâmetros) que exclui os status ocultos. Uso: `WHERE ... AND ${notHiddenProjectSql("p")}`.
 * Valores fixos e confiáveis (constantes acima), por isso interpolação segura.
 */
export function notHiddenProjectSql(alias = "p"): string {
  const list = HIDDEN_FROM_PRODUCT_STATUSES.map((s) => `'${s}'`).join(", ");
  return `${alias ? `${alias}.` : ""}status NOT IN (${list})`;
}

/** Fábrica-ativa / terminal — produção, NUNCA rascunho de inbox. */
export const FACTORY_OR_TERMINAL_STATUSES = [
  "running",
  "queued",
  // Migração 097 — `promoted`: já ENTREGUE à fábrica (com ordem de interdependência gravada),
  // só não iniciado. Não é rascunho de inbox: mover para o INBOX quebraria o plano do produto.
  // A saída legítima é `POST /api/products/:id/unpromote`, que devolve tudo a `draft`.
  "promoted",
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
  // D3: espera humana no MEIO da fábrica (nunca rascunho de inbox).
  "needs_spec_input",
] as const;

export type PreFactoryStatus = (typeof PRE_FACTORY_STATUSES)[number];
export type FactoryOrTerminalStatus = (typeof FACTORY_OR_TERMINAL_STATUSES)[number];

const PRE_FACTORY_SET: ReadonlySet<string> = new Set(PRE_FACTORY_STATUSES);

/** true se o status é pré-fábrica (rascunho re-alocável / elegível ao inbox). */
export function isPreFactory(status: string): boolean {
  return PRE_FACTORY_SET.has(status);
}
