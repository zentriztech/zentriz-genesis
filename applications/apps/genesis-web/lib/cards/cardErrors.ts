// Tabela ÚNICA de mensagens de erro dos cards (PT-BR). Espelha a `cardErrors` do relatório R §2 /
// frente K1. Código desconhecido ⇒ usa a mensagem do servidor; sem mensagem ⇒ texto genérico.
import { ApiError } from "@/lib/api";

type Ctx = { status: number; body?: Record<string, unknown>; serverMessage?: string };
type Entry = string | ((c: Ctx) => string);

const brl = (v: unknown) => (typeof v === "number" ? `US$ ${v.toFixed(2)}` : "valor não informado");

export const CARD_ERRORS: Record<string, Entry> = {
  NOT_FOUND: "Recurso indisponível ou não encontrado.",
  FORBIDDEN: "Você não tem permissão para esta ação.",
  MANAGEMENT_ACCOUNT_READONLY_CREATE: "Contas de gestão são somente leitura: use uma conta do tenant para criar ou alterar cards.",
  BAD_REQUEST: ({ serverMessage }) => serverMessage ?? "Pedido inválido. Confira os campos informados.",
  ATTACHMENT_INVALID: ({ body, serverMessage }) => {
    const errs = Array.isArray(body?.errors) ? (body!.errors as unknown[]).map((e) => (typeof e === "string" ? e : (e as { message?: string })?.message ?? "")).filter(Boolean) : [];
    return `Anexo recusado${errs.length ? `: ${errs.join("; ")}` : serverMessage ? `: ${serverMessage}` : ". Use pdf, txt, md, doc ou docx dentro do tamanho permitido."}`;
  },
  ATTACHMENT_UNREADABLE: "Não foi possível ler um dos anexos. Reenvie o arquivo ou remova-o.",
  ATTACHMENTS_UNAVAILABLE: "Anexos ainda não estão habilitados para este tenant. Crie o card sem anexos ou peça a habilitação ao administrador.",
  SERVICE_REQUIRED: ({ body }) => {
    const s = Array.isArray(body?.services) ? ` (${(body!.services as unknown[]).join(", ")})` : "";
    return `Este produto tem mais de um serviço${s}. Informe o serviço-alvo do card.`;
  },
  BUDGET_MISSING: "O produto não tem orçamento definido. Defina o orçamento da versão corrente antes de criar o card.",
  BUDGET_FREE_BELOW_MIN: ({ body }) => `Saldo livre insuficiente: ${brl(body?.freeUsd)} livres, mínimo exigido ${brl(body?.minFreeUsd)}. O card continua como está; aumente o orçamento da versão e tente de novo.`,
  CARD_INVALID_TRANSITION: ({ body }) => `Essa mudança de estado não é permitida agora${body?.from ? ` (de “${body.from}” para “${body.to}”)` : ""}. Atualize a tela e confira o estado do card.`,
  CARD_DIVERGED: "O card foi alterado por outra pessoa ou processo. Atualize a tela antes de continuar.",
  CARD_NOT_EDITABLE: "O texto só pode ser editado em rascunho ou refinamento.",
  CARD_NOT_DELETABLE: "Só é possível excluir cards em rascunho.",
  CARD_NOT_READY: "A especificação mudou depois da validação. O card voltou a “Refinando”: valide de novo antes de promover.",
  CARD_BASE_STALE: "A versão do produto mudou depois que este card foi validado (base vencida). Revalide o card contra a versão atual antes de promover.",
  CARD_CHILD_NOT_IN_FACTORY: "O projeto filho ainda não está na fábrica. Aguarde ou retome o card.",
  CARD_DRAFT_UNREADABLE: "O rascunho da especificação não pôde ser lido. O card foi bloqueado; use “Retomar” ou fale com o suporte.",
  NO_ACCEPTED_HEAD: "O produto ainda não foi fabricado e aceito. Cards só ficam disponíveis depois da primeira versão aceita.",
  PRODUCT_ARCHIVED: "O produto está arquivado e não aceita novos cards.",
  EVOLUTION_RFC_REQUIRED: "A especificação do card precisa de um RFC antes de ficar pronta.",
  EVOLUTION_RFC_INVALID: "O RFC da especificação está vago ou incompleto. Complete-o e valide de novo.",
  CARD_KIND_MISMATCH: "Uma Correção não pode alterar a compatibilidade além de patch. Mude o tipo do card para Evolução ou reduza o escopo.",
  CARD_KIND_REQUIREMENT: ({ body }) => {
    const missing = (body?.details as { missing?: string } | undefined)?.missing ?? (body?.missing as string | undefined);
    if (missing === "repro_scenario") return "A Correção exige um cenário de reprodução (FAIL_TO_PASS) nos critérios de aceite da especificação.";
    if (missing === "non_goals") return "O Recurso novo exige a seção “Non-goals” (não-objetivos) na especificação.";
    return "A especificação não cumpre a exigência do tipo do card.";
  },
  EVOLUTION_IN_FLIGHT: "Já existe uma evolução em andamento para este produto. Aguarde a conclusão para promover outro card.",
  MATERIALIZATION_IN_PROGRESS: "A promoção já está em andamento. Aguarde alguns instantes e atualize a tela.",
  EVOLUTION_BUSY: "A linhagem do produto está ocupada. Tente novamente em instantes.",
  MATERIALIZATION_FAILED: "A promoção falhou por um erro temporário. Tente de novo: ela retoma de onde parou.",
  HEAD_SPEC_UNREADABLE: "Não foi possível ler a especificação da versão atual do produto.",
  CODE_BASE_UNAVAILABLE: "Não foi possível acessar o repositório do produto. Confira a instalação do GitHub App e o repositório.",
  CARD_SPEC_LOCKED: "A especificação está travada porque o card está pronto. Use “Reabrir para edição” para alterá-la.",
  CARD_DELIVERY_IS_AUTOMATIC: "A entrega é marcada automaticamente quando o PR é integrado; não há ação manual.",
  TICKET_IMMUTABLE: "O texto do pedido não pode mais ser alterado depois de promovido.",
  USE_CARD_PROMOTE: "Este pedido já é um card. Promova-o pela tela do card (quadro de cards do produto).",
  TENANT_INACTIVE: "O tenant está suspenso. Fale com o administrador.",
};

const FALLBACK = "Não foi possível concluir a ação. Tente novamente.";

/** Mensagem PT-BR para qualquer erro vindo da API de cards. */
export function cardErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const entry = err.code ? CARD_ERRORS[err.code] : undefined;
    const ctx: Ctx = { status: err.status, body: err.body, serverMessage: err.message || undefined };
    if (entry) return typeof entry === "function" ? entry(ctx) : entry;
    if (err.status === 402) return err.message || "Orçamento insuficiente para esta ação.";
    if (err.status === 401) return "Sessão expirada. Entre novamente.";
    return err.message || FALLBACK;
  }
  if (err instanceof Error && err.message) return err.message;
  return FALLBACK;
}

export function cardErrorCode(err: unknown): string | undefined {
  return err instanceof ApiError ? err.code : undefined;
}
