/**
 * cardErrors.ts — Fase 3 (3.5): TABELA ÚNICA dos códigos de erro dos endpoints de cards (`/api/cards/**`, `/api/products/:id/cards`)
 * e dos escritores de spec do rascunho (spec-files, Chat IA, planner…) quando o projeto é um `card_draft`.
 *
 * Cada código tem o status HTTP, a área (para o portal agrupar) e uma mensagem CURTA em PT-BR para o usuário. A API continua
 * devolvendo o `message` técnico de sempre (contrato da Fase 2 intacto) e passa a acrescentar `userMessage` — o texto da tabela — em
 * toda resposta de erro das rotas de card (hook `preSerialization` em `routes/cards.ts`). O portal usa `userMessage`; `message`
 * fica para log/diagnóstico. Um teste varre as fontes e falha se algum `code: "…"` de card não estiver aqui.
 */

export type CardErrorArea = "geral" | "estado" | "spec" | "gate" | "orcamento" | "promocao" | "anexo";

export interface CardErrorDef {
  /** Status HTTP principal (alguns códigos podem sair com outro status em casos de borda — documentado no relatório V). */
  http: number;
  area: CardErrorArea;
  /** Mensagem curta para o usuário final (PT-BR, sem jargão de implementação). */
  message: string;
}

export const CARD_ERRORS = {
  // ── gerais ────────────────────────────────────────────────────────────────────────────────
  BAD_REQUEST: { http: 400, area: "geral", message: "Não entendemos o pedido. Confira os campos e tente de novo." },
  NOT_FOUND: { http: 404, area: "geral", message: "Não encontramos este item (ou ele não está disponível para você)." },
  FORBIDDEN: { http: 403, area: "geral", message: "Esta ação não é permitida para a sua conta." },
  UNAUTHORIZED: { http: 401, area: "geral", message: "Sua sessão não identifica um usuário. Entre de novo para criar ou alterar cards." },
  INVALID_ID: { http: 400, area: "geral", message: "O identificador informado não é válido. Recarregue a página e tente de novo." },
  CARD_ACTION_NOT_ALLOWED: { http: 403, area: "geral", message: "Só o autor do card ou um administrador do tenant pode fazer isto." },
  MANAGEMENT_ACCOUNT_READONLY_CREATE: { http: 403, area: "geral", message: "Contas de gestão só consultam: peça a alguém do cliente para criar ou alterar cards." },
  INTERNAL: { http: 500, area: "geral", message: "Algo deu errado do nosso lado. Tente de novo em instantes." },
  GONE: { http: 410, area: "anexo", message: "O arquivo deste anexo não está mais disponível." },
  PRODUCT_ARCHIVED: { http: 409, area: "geral", message: "O produto está arquivado e não recebe novos cards." },
  SERVICE_REQUIRED: { http: 400, area: "geral", message: "O produto tem mais de um serviço: escolha em qual deles o card vale." },
  NO_ACCEPTED_HEAD: { http: 409, area: "geral", message: "Este serviço ainda não tem uma versão aceita para evoluir." },

  // ── estado do card (máquina) ──────────────────────────────────────────────────────────────
  CARD_INVALID_TRANSITION: { http: 409, area: "estado", message: "O card não pode ir para esse estado agora." },
  CARD_DIVERGED: { http: 409, area: "estado", message: "O estado do card está inconsistente. Peça apoio ao suporte antes de continuar." },
  CARD_NOT_EDITABLE: { http: 409, area: "estado", message: "O texto do card só pode ser editado enquanto ele é rascunho ou está em refino." },
  CARD_NOT_DELETABLE: { http: 409, area: "estado", message: "Só dá para excluir um card em rascunho. Nos demais casos, recuse o card." },
  CARD_ALREADY_DELIVERABLE: { http: 409, area: "estado", message: "O código deste card já foi integrado (PR mergeado): é uma entrega real e não pode ser recusada. O sistema vai marcá-lo como entregue." },
  CARD_MERGE_UNVERIFIED: { http: 409, area: "estado", message: "Não foi possível confirmar no GitHub que o PR deste card não foi integrado, então a recusa foi negada por segurança. Tente de novo em instantes." },
  CARD_CHILD_ACTIVE: { http: 409, area: "estado", message: "A execução do card ainda está em andamento. Pare ou descarte a execução antes de recusar o card." },
  CARD_CHILD_CHANGED: { http: 409, area: "estado", message: "A execução do card mudou durante a recusa e nada foi alterado. Tente de novo." },
  CARD_NOT_READY: { http: 409, area: "promocao", message: "O card não está pronto. Valide o card antes de promover." },
  CARD_CHILD_NOT_IN_FACTORY: { http: 409, area: "estado", message: "A execução do card ainda não voltou para a fábrica. Reinicie-a e retome o card." },
  CARD_DELIVERY_IS_AUTOMATIC: { http: 409, area: "estado", message: "A entrega é registrada sozinha quando a execução é aceita e o código é integrado." },
  TICKET_IMMUTABLE: { http: 409, area: "estado", message: "O pedido original não pode mais ser alterado depois de promovido." },
  TICKET_INVALID_TRANSITION: { http: 409, area: "estado", message: "O pedido não pode ir para esse estado agora." },
  NOT_PROMOTED: { http: 409, area: "estado", message: "O pedido ainda não foi promovido." },
  USE_CARD_PROMOTE: { http: 409, area: "promocao", message: "Este pedido é um card: promova-o pelo próprio card." },
  USE_CARD_DELETE: { http: 409, area: "estado", message: "Este projeto é o rascunho de um card: exclua ou recuse o card, não o projeto." },
  USE_CARDS: { http: 409, area: "promocao", message: "Este tenant usa cards: abra um card para pedir a evolução, em vez de evoluir direto." },

  // ── spec do card (Fase 3) ─────────────────────────────────────────────────────────────────
  CARD_SPEC_LOCKED: { http: 409, area: "spec", message: "A spec do card está travada. Reabra o card para voltar a editar." },
  CARD_PATH_OUT_OF_SCOPE: { http: 400, area: "spec", message: "O card só escreve na própria pasta e no RFC/ADR dele. A spec da versão corrente é somente leitura." },
  CARD_PATH_COLLIDES_WITH_BASE: { http: 409, area: "spec", message: "Este arquivo já existe na versão corrente e não pode ser reescrito pelo card. Use outro nome ou número." },
  GLOBS_UNVERIFIED: { http: 409, area: "gate", message: "A versão corrente avançou e o escopo do RFC não foi conferido com o código. Confira e revalide o card." },
  CARD_SPEC_CHANGED: { http: 409, area: "spec", message: "A spec mudou durante a validação. Valide o card de novo." },
  CARD_ATTACHMENT_CONVERSION_PENDING: { http: 409, area: "anexo", message: "Ainda há anexo sendo convertido em texto. Aguarde o fim da conversão e valide de novo." },
  CARD_OPERATION_UNSUPPORTED: { http: 409, area: "spec", message: "Esta operação não se aplica a um card. Use o Chat IA ou o RFC do próprio card." },
  CARD_DRAFT_UNREADABLE: { http: 409, area: "spec", message: "Não conseguimos ler a spec do rascunho do card. Tente de novo ou peça apoio." },

  // ── gate de RFC / tipo ────────────────────────────────────────────────────────────────────
  EVOLUTION_RFC_REQUIRED: { http: 409, area: "gate", message: "Falta o RFC do card, com critérios de aceite em Gherkin e os arquivos que podem mudar." },
  EVOLUTION_RFC_INVALID: { http: 409, area: "gate", message: "O RFC do card está incompleto. Corrija os pontos indicados e valide de novo." },
  CARD_KIND_MISMATCH: { http: 409, area: "gate", message: "Uma correção não pode mudar a compatibilidade da versão além de patch. Ajuste o RFC ou o tipo do card." },
  CARD_KIND_REQUIREMENT: { http: 409, area: "gate", message: "Falta algo exigido pelo tipo do card (correção: cenário de reprodução; recurso novo: não-objetivos)." },

  // ── promoção / base ───────────────────────────────────────────────────────────────────────
  CARD_BASE_STALE: { http: 409, area: "promocao", message: "A versão-base mudou desde a validação. Revalide o card e valide de novo antes de promover." },
  CARD_PREVIOUS_UNMERGED: { http: 409, area: "promocao", message: "O card anterior desta versão ainda não foi integrado (o PR dele não foi mergeado). Mergeie o PR ou recuse o card anterior antes de promover este." },
  CARD_PREVIOUS_IN_PROGRESS: { http: 409, area: "promocao", message: "Outro card desta versão ainda está em andamento. Aguarde, retome a execução dele ou recuse esse card antes de promover este." },
  EVOLUTION_IN_FLIGHT: { http: 409, area: "promocao", message: "Já existe outra evolução em andamento neste serviço. Aguarde ela terminar." },
  EVOLUTION_BUSY: { http: 409, area: "promocao", message: "O serviço está ocupado com outra promoção. Tente de novo em instantes." },
  MATERIALIZATION_IN_PROGRESS: { http: 409, area: "promocao", message: "A promoção deste card já está em andamento. Aguarde alguns instantes." },
  MATERIALIZATION_FAILED: { http: 500, area: "promocao", message: "A promoção falhou no meio do caminho. Tente promover de novo: ela continua de onde parou." },
  HEAD_SPEC_UNREADABLE: { http: 422, area: "promocao", message: "Não foi possível ler a spec da versão corrente para promover." },
  CODE_BASE_UNAVAILABLE: { http: 422, area: "promocao", message: "O código da versão corrente não está disponível para promover." },
  PARENT_SUPERSEDED: { http: 409, area: "promocao", message: "A versão-base foi substituída por outra mais nova. Revalide o card." },
  TICKET_ALREADY_PROMOTED: { http: 409, area: "promocao", message: "Este pedido já foi promovido." },

  // ── orçamento (Guard de custo; o card nunca falha por falta de saldo) ─────────────────────
  BUDGET_MISSING: { http: 402, area: "orcamento", message: "A versão corrente não tem orçamento de IA definido. Defina o orçamento antes de continuar." },
  BUDGET_PAUSED: { http: 402, area: "orcamento", message: "O orçamento de IA está pausado. Aumente o orçamento para continuar." },
  BUDGET_INSUFFICIENT: { http: 402, area: "orcamento", message: "O saldo de IA não comporta a próxima atividade. Aumente o orçamento." },
  CARD_BUDGET_CAP: { http: 402, area: "orcamento", message: "O card atingiu o teto de orçamento definido para ele. Aumente o orçamento da versão ou o percentual por card." },
  BUDGET_FREE_BELOW_MIN: { http: 402, area: "orcamento", message: "O saldo livre está abaixo do mínimo para abrir uma nova versão. Aumente o orçamento." },
  CARD_CHILD_NOT_ACCEPTED: { http: 409, area: "estado", message: "A execução do card ainda não foi aceita." },
  CARD_BUDGET_BLOCKED: { http: 402, area: "orcamento", message: "O card está bloqueado por orçamento. Aumente o orçamento da versão e retome o card." },
  KILL_SWITCH: { http: 402, area: "orcamento", message: "O uso de IA está temporariamente suspenso pela plataforma." },
  GLOBAL_HOURLY_CAP: { http: 402, area: "orcamento", message: "O limite de uso de IA da plataforma foi atingido. Tente mais tarde." },
  GLOBAL_DAILY_CAP: { http: 402, area: "orcamento", message: "O limite diário de uso de IA da plataforma foi atingido. Tente amanhã." },
  REPEAT_PAYLOAD: { http: 402, area: "orcamento", message: "Esse mesmo pedido já foi enviado várias vezes. Altere o texto antes de tentar de novo." },
  UNATTRIBUTED_DAILY_CAP: { http: 402, area: "orcamento", message: "O limite de uso de IA sem projeto foi atingido hoje." },
  PROJECT_NOT_FOUND: { http: 402, area: "orcamento", message: "Não encontramos o projeto que paga esta chamada de IA." },
  GUARD_ERROR: { http: 402, area: "orcamento", message: "O controle de custo está indisponível agora. Tente de novo em instantes." },
  TENANT_LLM_BUDGET_EXCEEDED: { http: 402, area: "orcamento", message: "O orçamento de IA do cliente foi atingido." },

  // ── anexos ────────────────────────────────────────────────────────────────────────────────
  ATTACHMENT_INVALID: { http: 400, area: "anexo", message: "Algum anexo não é aceito. Use PDF, TXT, MD, DOC ou DOCX dentro dos limites." },
  ATTACHMENT_TOO_LARGE: { http: 400, area: "anexo", message: "Um dos anexos é grande demais." },
  ATTACHMENT_TOO_MANY: { http: 400, area: "anexo", message: "Há anexos demais neste card." },
  ATTACHMENT_UNREADABLE: { http: 400, area: "anexo", message: "Não conseguimos ler um dos anexos de texto. Reenvie em UTF-8." },
  ATTACHMENTS_UNAVAILABLE: { http: 409, area: "anexo", message: "Anexos de card ainda não estão habilitados para este cliente." },
} as const satisfies Record<string, CardErrorDef>;

export type CardErrorCode = keyof typeof CARD_ERRORS;

export function isCardErrorCode(code: unknown): code is CardErrorCode {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(CARD_ERRORS, code);
}

/** Mensagem curta PT-BR do código (ou `null` se o código não é da tabela). */
export function cardUserMessage(code: unknown): string | null {
  return isCardErrorCode(code) ? CARD_ERRORS[code].message : null;
}

/**
 * Acrescenta `userMessage` ao corpo de uma resposta de erro (sem tocar nos campos existentes). Corpo sem `code` conhecido volta intacto.
 * Só age em respostas de erro (status ≥ 400) — sucesso nunca é alterado.
 */
export function withCardUserMessage<T>(statusCode: number, body: T): T {
  if (statusCode < 400 || !body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  const msg = cardUserMessage(b.code);
  if (!msg || typeof b.userMessage === "string") return body;
  return { ...b, userMessage: msg } as T;
}
