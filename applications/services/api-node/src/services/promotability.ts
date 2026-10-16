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

export type { Queryable };

/** Razão da recusa — `null` quando pode promover ou quando não deu para decidir. */
export type PromotionBlockReason = "NOT_ON_WORKBENCH" | "NOT_NORMALIZED" | "CONNECT_MISSING" | "NOT_VALIDATED" | null;

/**
 * Prontidão para a Fábrica DEPOIS da normalização: declaração Connect + validação do conteúdo atual.
 * `ok:true` libera; `ok:false` traz a razão, o código do gate e a mensagem com o próximo passo.
 */
export type FactoryReadiness =
  | { ok: true }
  | { ok: false; reason: "CONNECT_MISSING" | "NOT_VALIDATED"; code: string; message: string; projectId?: string };

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
    if (!r.ok) return { ...r, message: `${p.title}: ${r.message}` };
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
  if (r && !r.ok) return { canPromote: false, reason: r.reason, message: r.message, code: r.code, status, normalized: true };
  return { canPromote: true, reason: null, message: null, status, normalized: true };
}

/** Veredito de uma spec da listagem da Bancada, a partir do que a listagem já sabe. */
export function decideSpecPromotability(
  status: string | null,
  normalized: boolean | null,
  readiness?: FactoryReadiness | null,
): Promotability {
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
  const normalized = await safeProjectNormalized(db, project);
  const readiness = project.status === PROJECT_PROMOTABLE_STATUS && normalized === true
    ? await safeReadiness(() => assessProjectReadiness(db, project.id))
    : null;
  return decideSpecPromotability(project.status ?? null, normalized, readiness);
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
