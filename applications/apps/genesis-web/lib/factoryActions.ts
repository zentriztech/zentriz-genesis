/**
 * Ações de FÁBRICA — fonte ÚNICA de rótulo, tooltip e texto de resultado.
 *
 * Motivo (revisão adversarial da Bancada, 2026-09-06): a mesma ação aparecia com quatro rótulos
 * ("Promover à Fábrica" / "Promover à fábrica" / "Promover produto inteiro" / "Promover agora") e
 * três textos de resultado divergentes em três telas — e o rótulo da Bancada NÃO dizia o escopo
 * real (promover uma spec de produto admite o produto TODO). Rótulo aqui = escopo real da rota.
 *
 * Plano: `project/docs/plans/BANCADA-REVISAO-ADVERSARIAL-PADRONIZACAO-2026-09-06.md`.
 */

/** Escopo real da admissão na fábrica — decide rótulo, tooltip e texto de confirmação. */
export type PromoteScope = "product" | "spec";

export const FACTORY_LABEL = {
  /** `POST /api/products/:id/promote` — admite TODOS os projetos do produto, em ondas. */
  promoteProduct: "Promover produto inteiro",
  /** `POST /api/projects/:id/promote` — admite só esta spec (caso do INBOX "Rascunhos"). */
  promoteSpec: "Promover esta spec",
  promoting: "Promovendo…",
  /** `GET /api/products/:id/promotion` — só lê o plano. */
  openPlan: "Ver ordem",
  /** Início SEMPRE passa por ver a ordem: o diálogo do plano é a confirmação. */
  openPlanAndStart: "Ver ordem e iniciar",
  starting: "Iniciando…",
  /** `POST /api/products/:id/unpromote`. */
  unpromote: "Devolver à Bancada",
  /** `POST /api/projects/:id/stop` — SIGTERM→SIGKILL; não existe parada graciosa. */
  stopRun: "Interromper execução",
  /** `POST /api/products/:id/normalize` — gera/atualiza os documentos de decisão e DESTRAVA o promover. */
  normalize: "Normalizar",
  normalizing: "Normalizando…",
  /** Mesma ação com a normalização já em dia — o clique refaz por cima. */
  renormalize: "Normalizar de novo",
} as const;

/** `POST /api/products/:id/start` dispara SÓ a onda pendente mais baixa — o rótulo diz qual. */
export function startWaveLabel(wave: number): string {
  return `Iniciar onda ${wave}`;
}

/** Palavra digitada na confirmação N2 (promover com GAPs abertos). */
export const PROMOTE_CONFIRM_WORD = "PROMOVER";

export const FACTORY_TOOLTIP = {
  promoteProduct:
    "Envia TODOS os projetos do produto à fábrica, na ordem de interdependência decidida pelo " +
    "arquiteto — e NÃO inicia nada.",
  promoteSpec:
    "Admite só esta spec na fábrica: ela sai da Bancada e espera o início explícito. Nada inicia agora.",
  openPlanAndStart:
    "Abre a ordem de entrada (por onda) e permite iniciar a onda pendente mais baixa.",
  unpromote:
    "Devolve o produto e seus projetos à Bancada (a spec volta a ser editável). " +
    "Recusado se a fábrica já começou.",
  normalize:
    "Gera/atualiza os documentos de decisão do produto (RFC, ADR e o índice Connect) a partir da " +
    "spec vigente — sem inventar requisito. É o que destrava a promoção à fábrica.",
  /** Escopo de UMA spec (`POST /api/projects/:id/normalize`) — o caso do rascunho no INBOX. */
  normalizeSpec:
    "Escreve o RFC e o registro de decisão desta spec (modelo Zentriz Connect), a partir do que ela " +
    "já diz — sem inventar requisito. É o que faz o botão de promover aparecer.",
} as const;

/**
 * Linha que ocupa o lugar do botão de promover enquanto a spec não está normalizada.
 *
 * Pedido do Jean (2026-09-11): *"melhor é que promover só apareça depois de normalizado"*. Botão que
 * some sem explicação é pior que botão desabilitado (revisão adversarial R2) — então o lugar dele
 * nunca fica mudo.
 */
export const PROMOTE_HIDDEN_UNTIL_NORMALIZED =
  "Promover aparece depois de normalizar.";

/**
 * Veredito de promovibilidade COMO O SERVIDOR MANDA (`services/promotability.ts`).
 *
 * Achado do Jean (2026-09-11): três telas decidiam sozinhas "posso promover?" e divergiram — em
 * `/spec` o botão aparecia habilitado num produto `running`, onde o clique só podia dar 409. Agora
 * a decisão é uma só, do servidor, e a tela apenas renderiza o motivo que ele mandou.
 */
export interface PromotionVerdict {
  /** `true` pode · `false` não pode · `null` o servidor NÃO conferiu (botão continua visível). */
  canPromote: boolean | null;
  /** `NOT_ON_WORKBENCH` (já saiu da Bancada) · `NOT_NORMALIZED` (falta doc) · `null`. */
  reason: string | null;
  message: string | null;
  normalized: boolean | null;
}

/**
 * O que a tela desenha no lugar do botão de promover.
 *
 * `show: false` só acontece quando o servidor disse `canPromote === false` — nunca por dedução da
 * tela e nunca por erro nosso: sem veredito (`null`, payload antigo, falha de rede) o botão FICA e
 * quem recusa é o `/promote`, com a mensagem certa. `normalizedFallback` atende o ambiente que
 * ainda não devolve `promotion` no payload.
 */
export function promoteGate(
  promotion: PromotionVerdict | null | undefined,
  normalizedFallback?: boolean | null,
): { show: boolean; message: string | null } {
  if (promotion && promotion.canPromote === false) {
    return { show: false, message: promotion.message ?? PROMOTE_HIDDEN_UNTIL_NORMALIZED };
  }
  if (!promotion && normalizedFallback === false) {
    return { show: false, message: PROMOTE_HIDDEN_UNTIL_NORMALIZED };
  }
  return { show: true, message: null };
}

/**
 * Normalizar só faz sentido enquanto ele DESTRAVA alguma coisa. Num produto que já saiu da Bancada
 * (`NOT_ON_WORKBENCH`) documentar continua valendo — o que não vale é prometer que isso libera o
 * promover. O rótulo muda para não mentir.
 */
export function normalizeLabel(promotion: PromotionVerdict | null | undefined, normalized: boolean | null): string {
  const done = promotion?.normalized ?? normalized;
  return done === true ? FACTORY_LABEL.renormalize : FACTORY_LABEL.normalize;
}

/** Resultado de `POST /projects/:id/normalize` (uma spec). */
export function normalizedSpecNotice(documents: number): string {
  return `Spec normalizada: ${documents} arquivo(s) de documentação gravados. Promover já aparece no card.`;
}

/**
 * Resultado de `POST /products/:id/normalize`.
 *
 * `unlocksPromote=false` para produto que já saiu da Bancada: documentar continua valendo (é o
 * único jeito de ele ter RFC/ADR), mas prometer que isso "liberou o promover" seria mentira — o
 * promover daquele produto está fechado por ESTADO, não por falta de documento.
 */
export function normalizedProductNotice(documents: number, skipped: number, unlocksPromote = true): string {
  const tail = unlocksPromote
    ? "Promover está liberado."
    : "O produto já saiu da Bancada — a documentação fica em dia, mas não há promoção a destravar.";
  const base = `Produto normalizado: ${documents} arquivo(s) de documentação gravados. ${tail}`;
  return skipped > 0
    ? `${base} ${skipped} projeto(s) ficaram de fora (spec editada após a aprovação) — veja os detalhes.`
    : base;
}

/** Rótulo do botão de promoção da Bancada — o escopo pode ser desconhecido até carregar o dono. */
export function promoteButtonLabel(scope: PromoteScope | null): string {
  if (scope === "product") return FACTORY_LABEL.promoteProduct;
  if (scope === "spec") return FACTORY_LABEL.promoteSpec;
  return "Promover à fábrica";
}

/**
 * Texto de confirmação da promoção. `siblings` é a contagem de projetos do produto ainda na
 * Bancada (só para o humano dimensionar o escopo) — a lista autoritativa é decidida no servidor.
 */
export function promoteConfirmBody(
  scope: PromoteScope | null,
  opts: { productName?: string | null; siblings?: number | null } = {},
): string {
  if (scope === "product") {
    const name = opts.productName?.trim() || "este produto";
    const n = opts.siblings ?? null;
    const count = n && n > 1 ? ` (${n} projetos na Bancada)` : "";
    return (
      `Isto admite o PRODUTO INTEIRO — ${name}${count} — na fábrica: todos os projetos entram na ` +
      "ordem de interdependência que o arquiteto decidir (custo de LLM do planejador). " +
      "Nada será iniciado: o início é um clique separado, depois de ver a ordem."
    );
  }
  return (
    "Isto admite ESTA spec na fábrica: ela sai da Bancada e fica congelada aguardando início. " +
    "Nada será iniciado agora."
  );
}

/** Resultado de `POST /products/:id/promote` — texto único (3 telas tinham cópias divergentes). */
export function promotedProductNotice(projects: number, waves: number): string {
  return (
    `Produto admitido na fábrica: ${projects} projeto(s) em ${waves} onda(s). ` +
    `Nada foi iniciado — use “${FACTORY_LABEL.openPlanAndStart}” quando quiser começar.`
  );
}

/** Resultado de `POST /projects/:id/promote` (uma spec). */
export const PROMOTED_SPEC_NOTICE =
  "Spec admitida na fábrica — ela sai da Bancada e passa a esperar o início. " +
  "Inicie na tela do projeto (botão “Iniciar”) ou pela ordem do produto em “Meus produtos”.";
