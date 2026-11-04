/**
 * promotability.ts — VEREDITO ÚNICO de "posso promover isto à Fábrica?".
 *
 * Motivo (achado do Jean, 2026-09-11): ele abriu a spec do VNX LastMile em `/spec` e viu
 * [Promover à Fábrica] habilitado num produto que está `running` — o clique só podia dar 409.
 * A causa não era a tela: TRÊS telas (`/products`, `/specs`, `/spec`) reimplementavam "posso
 * promover?" cada uma com os dados que tinha à mão, e as regras divergiram. O adversarial
 * (`~/relatorios/2026-09-11-devil-promover-e-normalizar-fora-da-bancada.md`) vetou consertar a
 * terceira tela do mesmo jeito: quem decide é o SERVIDOR, a tela só renderiza o motivo.
 *
 * Razões de recusa, em ORDEM — cada uma diz o PRÓXIMO passo, e elas NÃO se confundem:
 *   • `NOT_ON_WORKBENCH` — já saiu da Bancada (normalizar não destrava nada; nada a fazer aqui);
 *   • `NOT_NORMALIZED`  — falta documentação de decisão (normalizar destrava);
 *   • `CONNECT_MISSING` — falta a declaração Connect (`connect.yaml`) ou ela está sem as chaves
 *     obrigatórias (normalizar gera; "Gerar connect.yaml" também);
 *   • `NOT_VALIDATED`   — a validação do conteúdo ATUAL não passou: nunca validou, venceu, tem GAP
 *     blocker ativo ou avisos sem reconhecimento (Validar/Revalidar e Reconhecer avisos destravam).
 *
 * Achado do Jean (2026-10-16, VNX Judge): o carimbo de normalização sozinho liberava
 * [Promover produto inteiro] com 1 GAP blocker ativo e sem `connect.yaml` — o gate de validação só
 * existia no DISPATCH. Agora a prontidão (connect + validação) entra no veredito E nas rotas de
 * promote, com a mesma função (`assessProjectReadiness`): a tela e o servidor não divergem.
 *
 * `canPromote: null` = "o servidor NÃO conseguiu decidir". Nesse caso a tela mantém o botão
 * visível: erro nosso nunca tira função do usuário (regra fixada no adversarial R2/R3).
 */
import { isProductNormalized, isProjectNormalized, loadProductProjects, type Queryable } from "./productNormalizer.js";
import { assessSpecValidation, specValidationGateEnabled } from "./specValidation.js";
import { assessConnectDeclaration, type FactoryCertificate } from "./factoryCertificate.js";
import { evaluateEvolutionGate } from "./evolutionGate.js";
import { checkProjectBudgetGate } from "./llmGuard.js";
import { evolutionPromoteEnabled, isEvolutionExtra, listPromotableEvolutionChildren, EVOLUTION_PROMOTABLE_STATUSES } from "./evolutionPromote.js";

export type { Queryable };

/** Razão da recusa — `null` quando pode promover ou quando não deu para decidir. */
export type PromotionBlockReason =
  | "NOT_ON_WORKBENCH" | "NOT_NORMALIZED" | "CONNECT_MISSING" | "NOT_VALIDATED"
  // 1.7 (EVOLUTION_PROMOTE_BANCADA=on, só filho de evolução): RFC ausente/inválido e orçamento do dono.
  | "EVOLUTION_RFC" | "BUDGET_BLOCKED"
  // Fase 3 (3.3): o projeto é o RASCUNHO de um card (`card_draft`) — não é spec de produto; a promoção é do CARD (`POST /api/cards/:id/promote`).
  | "CARD_DRAFT"
  | null;

/**
 * Prontidão para a Fábrica DEPOIS da normalização: declaração Connect + validação do conteúdo atual.
 * `ok:true` libera; `ok:false` traz a razão, o código do gate e a mensagem com o próximo passo.
 */
export type FactoryReadiness =
  | { ok: true }
  | { ok: false; reason: "CONNECT_MISSING" | "NOT_VALIDATED"; code: string; message: string; projectId?: string; projectTitle?: string };

export interface Promotability {
  /** `true` pode · `false` não pode · `null` não foi possível decidir (botão continua visível). */
  canPromote: boolean | null;
  reason: PromotionBlockReason;
  /** Texto pronto para a tela — o servidor é quem sabe o motivo real. */
  message: string | null;
  /** Estado que motivou a recusa (`lifecycle_status` do produto ou `status` do projeto). */
  status: string | null;
  /** `true`/`false`/`null` no mesmo contrato de `canPromote`. */
  normalized: boolean | null;
  /** Código do gate que recusou (`SPEC_VALIDATION_BLOCKED`, `CONNECT_DECLARATION_MISSING`…) — só em recusa de prontidão. */
  code?: string | null;
  /**
   * QUAL spec travou a prontidão (no produto, a primeira que falhou). A tela precisa dele para
   * levar o usuário direto ao arquivo certo — "falta validar" sem dizer onde não é acionável.
   */
  blockingProjectId?: string | null;
  blockingProjectTitle?: string | null;
  /**
   * 1.7: `true` quando o veredito é de FILHO DE EVOLUÇÃO (a etapa "Normalizar" não se aplica: o RFC é o documento de decisão).
   * Ausente em todo veredito histórico (flag off) — o payload não muda.
   */
  evolution?: boolean;
  /** Fase 3 (3.3): só no veredito de `card_draft` — o card dono do rascunho e o estado dele. Ausente em todo veredito histórico. */
  card?: { cardId: string | null; state: string | null; promoteVia: string | null };
}

/** Único estado de produto que a Fábrica aceita promover (`routes/products.ts`). */
const PRODUCT_PROMOTABLE_LIFECYCLE = "draft";
/** Único estado de projeto que a Fábrica aceita promover (`routes/pipeline.ts`). */
const PROJECT_PROMOTABLE_STATUS = "draft";

const MSG_NOT_NORMALIZED =
  "Promover aparece depois de normalizar — a Bancada precisa escrever o RFC e o registro de decisão.";

/** A ordem que a tela mostra junto de toda recusa de prontidão. */
export const PROMOTION_STEPS = "Normalizar → Validar → Reconhecer avisos → Promover";

const CONNECT_PATH = "connect.yaml";

function connectMissingMessage(level: "absent" | "incomplete", missing: string[]): string {
  return level === "absent"
    ? `Falta a declaração Connect (connect.yaml) — rode Normalizar (gera automaticamente) ou "Gerar connect.yaml". Ordem: ${PROMOTION_STEPS}.`
    : `A declaração Connect (connect.yaml) está sem as chaves obrigatórias: ${missing.join(", ")}. Gere de novo ou complete antes de promover.`;
}

function notValidatedMessage(code: string, gateMessage: string): string {
  const next =
    code === "SPEC_WARNINGS_UNACKED" ? "Clique em Reconhecer avisos."
    : code === "SPEC_VALIDATION_BLOCKED" ? "Resolva (ou trie) os GAPs blocker e Revalide."
    : code === "SPEC_COVERAGE_INCOMPLETE" ? "Rode Validar de novo para julgar os arquivos que faltam."
    : "Clique em Validar (a spec mudou desde a última validação ou nunca foi validada).";
  return `${gateMessage.replace(/\s+$/, "")} ${next} Ordem: ${PROMOTION_STEPS}.`;
}

/**
 * Prontidão de UM projeto: `connect.yaml` na raiz com as chaves obrigatórias e, com
 * `SPEC_VALIDATION_GATE=on`, o MESMO veredito de `assessSpecValidation` que o dispatch usa.
 * Connect vem ANTES da validação de propósito: escrever o `connect.yaml` muda o hash da árvore e
 * venceria a validação — pedir Validar antes de ter o connect faria o usuário validar duas vezes.
 * Lança em erro de I/O: quem chama decide se degrada (`null` na tela) ou falha alto (promote).
 */
export async function assessProjectReadiness(db: Queryable, projectId: string): Promise<FactoryReadiness> {
  const a = await assessSpecValidation(
    db as unknown as { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
    projectId,
  );
  const connectFile = a.files.find((f) => f.filename.toLowerCase() === CONNECT_PATH && !(f.rel_dir ?? ""));
  const connect = assessConnectDeclaration(connectFile?.content ?? null);
  if (connect.level !== "connect_ready") {
    return {
      ok: false, reason: "CONNECT_MISSING", projectId,
      code: connect.level === "absent" ? "CONNECT_DECLARATION_MISSING" : "CONNECT_DECLARATION_INCOMPLETE",
      message: connectMissingMessage(connect.level, connect.missing),
    };
  }
  if (specValidationGateEnabled() && a.block) {
    return { ok: false, reason: "NOT_VALIDATED", projectId, code: a.block.code, message: notValidatedMessage(a.block.code, a.block.message) };
  }
  return { ok: true };
}

/**
 * Mesma prontidão derivada de um certificado JÁ calculado (listagens que já pagaram o I/O do selo).
 * Só os códigos de validação contam — `PROJECT_TYPE_MISSING`/template não são gate de promote.
 */
export function readinessFromCertificate(cert: FactoryCertificate | null | undefined): FactoryReadiness | null {
  if (!cert) return null;
  if (cert.connect.level !== "connect_ready") {
    return {
      ok: false, reason: "CONNECT_MISSING",
      code: cert.connect.level === "absent" ? "CONNECT_DECLARATION_MISSING" : "CONNECT_DECLARATION_INCOMPLETE",
      message: connectMissingMessage(cert.connect.level, cert.connect.missing),
    };
  }
  const code = cert.code ?? "";
  if (specValidationGateEnabled() && code.startsWith("SPEC_")) {
    return { ok: false, reason: "NOT_VALIDATED", code, message: notValidatedMessage(code, cert.message) };
  }
  return { ok: true };
}

/**
 * Prontidão do PRODUTO = AND dos projetos que a promoção vai admitir (`draft`). O primeiro que falha
 * define a razão, e a mensagem diz QUAL spec — "falta connect.yaml" sem dizer onde não é acionável.
 */
export async function assessProductReadiness(db: Queryable, productId: string): Promise<FactoryReadiness> {
  const projects = (await loadProductProjects(db, productId)).filter((p) => p.status === "draft");
  for (const p of projects) {
    const r = await assessProjectReadiness(db, p.projectId);
    if (!r.ok) return { ...r, projectTitle: p.title, message: `${p.title}: ${r.message}` };
  }
  return { ok: true };
}

function alreadyInFactory(what: string, status: string): string {
  return `${what} já saiu da Bancada (estado atual: ${status}) — não há o que promover.`;
}

/**
 * A DECISÃO em si, sem I/O — para quem já tem os fatos em mãos (o caso da listagem da Bancada,
 * que não pode pagar uma segunda leitura por linha). Ordem: estado → normalização → prontidão.
 *
 * `readiness`: `undefined` = o chamador não avalia prontidão (contrato antigo, só testes);
 * `null` = "não conferi" ⇒ `canPromote: null` (o botão fica e o /promote decide de verdade).
 */
export function decidePromotability(
  kind: "product" | "spec",
  args: { status: string | null; promotableStatus: string; normalized: boolean | null; readiness?: FactoryReadiness | null },
): Promotability {
  const { status, normalized } = args;
  const what = kind === "product" ? "Este produto" : "Esta spec";
  if (status !== args.promotableStatus) {
    return {
      canPromote: false,
      reason: "NOT_ON_WORKBENCH",
      message: alreadyInFactory(what, String(status)),
      status,
      normalized,
    };
  }
  if (normalized === null) return { canPromote: null, reason: null, message: null, status, normalized: null };
  if (!normalized) return { canPromote: false, reason: "NOT_NORMALIZED", message: MSG_NOT_NORMALIZED, status, normalized: false };
  const r = args.readiness;
  if (r === null) return { canPromote: null, reason: null, message: null, status, normalized: true };
  if (r && !r.ok) {
    return {
      canPromote: false, reason: r.reason, message: r.message, code: r.code, status, normalized: true,
      blockingProjectId: r.projectId ?? null, blockingProjectTitle: r.projectTitle ?? null,
    };
  }
  return { canPromote: true, reason: null, message: null, status, normalized: true };
}

/** Veredito de uma spec da listagem da Bancada, a partir do que a listagem já sabe. */
export function decideSpecPromotability(
  status: string | null,
  normalized: boolean | null,
  readiness?: FactoryReadiness | null,
): Promotability {
  if (status === "card_draft") return decideCardDraftPromotability({ cardId: null, state: null });
  return decidePromotability("spec", { status, promotableStatus: PROJECT_PROMOTABLE_STATUS, normalized, readiness });
}

/** Prontidão que não derruba a tela: erro de I/O vira `null` ("não conferi"). */
export async function safeReadiness(fn: () => Promise<FactoryReadiness>): Promise<FactoryReadiness | null> {
  try { return await fn(); } catch { return null; }
}

/**
 * Veredito para um PRODUTO. `promoted` admite o produto inteiro, então a pergunta de estado é o
 * `lifecycle_status` — e ela vem ANTES da normalização: num produto que já está na Fábrica,
 * normalizar não destravaria promoção nenhuma, e prometer isso na tela seria mentira.
 */
export async function evaluateProductPromotability(
  db: Queryable,
  product: {
    id: string; name: string; systemId: string | null;
    lifecycleStatus: string | null; normalizedHash: string | null;
    /**
     * `true` numa LISTAGEM que já gastou o teto de I/O: o estado de normalização vira `null`
     * ("não conferi"), nunca `false`. O estado de lifecycle continua valendo — ele é de graça.
     */
    skipNormalizedCheck?: boolean;
  },
): Promise<Promotability> {
  // 1.7 (EVOLUTION_PROMOTE_BANCADA=on): produto fora de `draft` com filho de evolução na Bancada ⇒ veredito de evolução.
  const evo = await evaluateEvolutionProductPromotability(db, { id: product.id, lifecycleStatus: product.lifecycleStatus });
  if (evo) return evo;
  const normalized = product.skipNormalizedCheck ? null : await safeProductNormalized(db, product);
  // Prontidão só quando é ela que decide (na Bancada E normalizado): é o caso raro, então o custo
  // extra de I/O da listagem fica limitado aos produtos que de fato estão a um passo do promote.
  const status = product.lifecycleStatus ?? null;
  const readiness = status === PRODUCT_PROMOTABLE_LIFECYCLE && normalized === true
    ? await safeReadiness(() => assessProductReadiness(db, product.id))
    : null;
  return decidePromotability("product", { status, promotableStatus: PRODUCT_PROMOTABLE_LIFECYCLE, normalized, readiness });
}

/** Veredito para um PROJETO (spec solta do INBOX — `POST /api/projects/:id/promote`). */
export async function evaluateProjectPromotability(
  db: Queryable,
  project: { id: string; status: string | null; hasStamp: boolean },
): Promise<Promotability> {
  if (project.status === "card_draft") return evaluateCardDraftPromotability(db, project.id);
  const normalized = await safeProjectNormalized(db, project);
  const readiness = project.status === PROJECT_PROMOTABLE_STATUS && normalized === true
    ? await safeReadiness(() => assessProjectReadiness(db, project.id))
    : null;
  return decideSpecPromotability(project.status ?? null, normalized, readiness);
}

// ── Fase 3 (3.3) — rascunho de CARD ──────────────────────────────────────────────────────────────

/**
 * Veredito do RASCUNHO de um card (`projects.status = 'card_draft'`). Ele NÃO é spec de produto: nunca "já saiu da Bancada", nunca precisa
 * de "Normalizar" nem de connect.yaml, e quem promove é o CARD (máquina de estados + hash do carimbo + base vs HEAD). `canPromote` é sempre
 * `false` aqui (a promoção do rascunho como projeto é recusada) e a mensagem diz o caminho certo conforme o estado do card.
 */
export function decideCardDraftPromotability(card: { cardId: string | null; state: string | null }): Promotability {
  const via = card.cardId ? `POST /api/cards/${card.cardId}/promote` : null;
  const message = card.state === "ready"
    ? "Este é o rascunho de um card, não uma spec de produto: o card está pronto — promova pelo próprio card."
    : card.state === "draft" || card.state === "refining"
      ? "Este é o rascunho de um card, não uma spec de produto: refine o RFC e valide o card antes de promovê-lo."
      : card.state
        ? `Este é o rascunho de um card (estado '${card.state}'): ele é histórico e não é promovido como spec de produto.`
        : "Este é o rascunho de um card, não uma spec de produto: a promoção é feita pelo card.";
  return { canPromote: false, reason: "CARD_DRAFT", message, status: "card_draft", normalized: null, card: { cardId: card.cardId, state: card.state, promoteVia: card.state === "ready" ? via : null } };
}

/** Consulta o card dono do rascunho e devolve o veredito. Falha de leitura ⇒ veredito sem o card (nunca lança). */
export async function evaluateCardDraftPromotability(db: Queryable, projectId: string): Promise<Promotability> {
  try {
    const r = (await db.query("SELECT id, card_state FROM tickets WHERE draft_project_id = $1 LIMIT 1", [projectId])).rows[0] as { id?: string; card_state?: string } | undefined;
    return decideCardDraftPromotability({ cardId: r?.id ? String(r.id) : null, state: r?.card_state ? String(r.card_state) : null });
  } catch {
    return decideCardDraftPromotability({ cardId: null, state: null });
  }
}

/**
 * Sem carimbo ⇒ `false` sem tocar o disco (caso dominante). Com carimbo, confere contra a árvore
 * de spec; falha de leitura vira `null` ("não conferi"), NUNCA `false`.
 */
async function safeProductNormalized(
  db: Queryable,
  product: { id: string; name: string; systemId: string | null; normalizedHash: string | null },
): Promise<boolean | null> {
  if (!product.normalizedHash) return false;
  try {
    const st = await isProductNormalized(db, {
      id: product.id,
      systemId: product.systemId,
      name: product.name,
      normalizedHash: product.normalizedHash,
    });
    return st.normalized;
  } catch {
    return null;
  }
}

async function safeProjectNormalized(
  db: Queryable,
  project: { id: string; hasStamp: boolean },
): Promise<boolean | null> {
  if (!project.hasStamp) return false;
  try {
    return (await isProjectNormalized(db, project.id)).normalized;
  } catch {
    return null;
  }
}

// ── 1.7 — filho de EVOLUÇÃO na Bancada (flag EVOLUTION_PROMOTE_BANCADA) ───────────────────────────

export type EvolutionReadiness =
  | { ok: true }
  | { ok: false; reason: "EVOLUTION_RFC" | "CONNECT_MISSING" | "NOT_VALIDATED" | "BUDGET_BLOCKED"; code: string; message: string; projectId: string;
      /** D-7 (AR): ação da API/UI que destrava a recusa (hoje só `CONNECT_MISSING`: gerar o connect.yaml no filho). */
      action?: { method: "POST"; path: string; label: string } };

/**
 * D-7 (AR): o filho de evolução herda a árvore da versão corrente; se ela nunca teve `connect.yaml` (produto gerado antes do
 * gate Connect), não há o que herdar. O gate NÃO é afrouxado: a recusa passa a dizer a causa e a ação exata, em vez de um
 * 409 sem contexto da jornada do card.
 */
export function connectMissingForEvolution(projectId: string, message: string): { message: string; action: { method: "POST"; path: string; label: string } } {
  const path = `/api/projects/${projectId}/connect-declaration`;
  return {
    message: `${message} Esta evolução herda a árvore da versão corrente, que não traz um connect.yaml válido (passo da jornada do card, antes de promover o filho): `
      + `gere-o neste filho — botão "Gerar connect.yaml" ou POST ${path} — e promova de novo. As evoluções seguintes herdam o arquivo.`,
    action: { method: "POST", path, label: "Gerar connect.yaml" },
  };
}

/**
 * Prontidão do filho de evolução, na ORDEM do que o usuário destrava: RFC → connect.yaml/validação → orçamento.
 * `readOnly:true` (veredito de tela) não grava o carimbo do gate de RFC; a promoção de verdade grava (como o `/run`).
 * Lança em erro de I/O: quem chama decide (tela ⇒ `null` "não conferi"; promote ⇒ falha alto).
 * Nenhum gate é enfraquecido; só a trava de NORMALIZAÇÃO não se aplica (o RFC é o documento de decisão, D-A6).
 */
export async function assessEvolutionReadiness(
  db: Queryable, projectId: string, opts: { readOnly?: boolean } = {},
): Promise<EvolutionReadiness> {
  const extra = (await db.query("SELECT extra FROM projects WHERE id = $1", [projectId])).rows[0]?.extra as Record<string, unknown> | null | undefined;
  const gate = await evaluateEvolutionGate(db as never, projectId, extra ?? null, { readOnly: opts.readOnly });
  if (!gate.ok) return { ok: false, reason: "EVOLUTION_RFC", code: gate.code, message: gate.message, projectId };
  const ready = await assessProjectReadiness(db, projectId);
  if (!ready.ok) {
    if (ready.reason === "CONNECT_MISSING") return { ok: false, reason: ready.reason, code: ready.code, projectId, ...connectMissingForEvolution(projectId, ready.message) };
    return { ok: false, reason: ready.reason, code: ready.code, message: ready.message, projectId };
  }
  const budget = await checkProjectBudgetGate(db as never, projectId);
  if (!budget.ok) return { ok: false, reason: "BUDGET_BLOCKED", code: budget.code, message: budget.message, projectId };
  return { ok: true };
}

/** Veredito de UM filho de evolução (sem I/O). `readiness: null` = "não conferi" ⇒ `canPromote: null` (o botão fica). */
export function decideEvolutionPromotability(
  args: { status: string | null; readiness?: EvolutionReadiness | null },
): Promotability {
  const { status } = args;
  if (!status || !(EVOLUTION_PROMOTABLE_STATUSES as readonly string[]).includes(status)) {
    return { canPromote: false, reason: "NOT_ON_WORKBENCH", message: alreadyInFactory("Esta evolução", String(status)), status, normalized: null, evolution: true };
  }
  const r = args.readiness;
  if (r === null || r === undefined) return { canPromote: null, reason: null, message: null, status, normalized: null, evolution: true };
  if (!r.ok) {
    return {
      canPromote: false, reason: r.reason, message: r.message, code: r.code, status, normalized: null, evolution: true,
      blockingProjectId: r.projectId, blockingProjectTitle: null,
    };
  }
  return { canPromote: true, reason: null, message: null, status, normalized: null, evolution: true };
}

/**
 * Veredito do PRODUTO quando ele já saiu de `draft` mas tem filho(s) de evolução na Bancada. `null` = não se aplica
 * (flag off, produto em `draft`, ou nenhum filho de evolução promovível) ⇒ vale o veredito histórico. O primeiro filho que falha define a razão.
 */
export async function evaluateEvolutionProductPromotability(
  db: Queryable, product: { id: string; lifecycleStatus: string | null },
): Promise<Promotability | null> {
  if (product.lifecycleStatus === PRODUCT_PROMOTABLE_LIFECYCLE) return null;
  if (!(await evolutionPromoteEnabled(db as never, { productId: product.id }))) return null;
  let kids;
  try {
    kids = await listPromotableEvolutionChildren(db as never, product.id);
  } catch {
    return null;
  }
  if (kids.length === 0) return null;
  for (const k of kids) {
    const readiness = await safeEvolutionReadiness(() => assessEvolutionReadiness(db, k.projectId, { readOnly: true }));
    const v = decideEvolutionPromotability({ status: k.status, readiness });
    if (v.canPromote !== true) {
      return { ...v, status: product.lifecycleStatus, message: v.message ? `${k.title}: ${v.message}` : v.message, blockingProjectTitle: k.title };
    }
  }
  return { canPromote: true, reason: null, message: null, status: product.lifecycleStatus, normalized: null, evolution: true };
}

export async function safeEvolutionReadiness(fn: () => Promise<EvolutionReadiness>): Promise<EvolutionReadiness | null> {
  try { return await fn(); } catch { return null; }
}

/** `true` se o projeto é filho de evolução promovível pela Bancada COM a flag ligada (decide o caminho de promoção). */
export async function isEvolutionPromotable(
  db: Queryable, project: { id: string; status: string | null; extra: Record<string, unknown> | null | undefined; tenantId?: string | null }, userTenantId?: string | null,
): Promise<boolean> {
  if (!isEvolutionExtra(project.extra)) return false;
  if (!project.status || !(EVOLUTION_PROMOTABLE_STATUSES as readonly string[]).includes(project.status)) return false;
  return evolutionPromoteEnabled(db as never, { projectId: project.id, tenantId: project.tenantId ?? null, userTenantId: userTenantId ?? null });
}
