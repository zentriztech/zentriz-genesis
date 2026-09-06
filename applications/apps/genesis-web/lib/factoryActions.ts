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
} as const;

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
