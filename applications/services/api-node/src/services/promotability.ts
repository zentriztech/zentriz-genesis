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
 * Duas razões possíveis de recusa, e elas NÃO se confundem:
 *   • `NOT_ON_WORKBENCH` — já saiu da Bancada (normalizar não destrava nada; nada a fazer aqui);
 *   • `NOT_NORMALIZED`  — falta documentação de decisão (normalizar destrava).
 *
 * `canPromote: null` = "o servidor NÃO conseguiu decidir". Nesse caso a tela mantém o botão
 * visível: erro nosso nunca tira função do usuário (regra fixada no adversarial R2/R3).
 */
import { isProductNormalized, isProjectNormalized, type Queryable } from "./productNormalizer.js";

export type { Queryable };

/** Razão da recusa — `null` quando pode promover ou quando não deu para decidir. */
export type PromotionBlockReason = "NOT_ON_WORKBENCH" | "NOT_NORMALIZED" | null;

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
}

/** Único estado de produto que a Fábrica aceita promover (`routes/products.ts`). */
const PRODUCT_PROMOTABLE_LIFECYCLE = "draft";
/** Único estado de projeto que a Fábrica aceita promover (`routes/pipeline.ts`). */
const PROJECT_PROMOTABLE_STATUS = "draft";

const MSG_NOT_NORMALIZED =
  "Promover aparece depois de normalizar — a Bancada precisa escrever o RFC e o registro de decisão.";

function alreadyInFactory(what: string, status: string): string {
  return `${what} já saiu da Bancada (estado atual: ${status}) — não há o que promover.`;
}

/**
 * A DECISÃO em si, sem I/O — para quem já tem os dois fatos em mãos (o caso da listagem da Bancada,
 * que não pode pagar uma segunda leitura por linha). Ordem: estado primeiro, normalização depois.
 */
export function decidePromotability(
  kind: "product" | "spec",
  args: { status: string | null; promotableStatus: string; normalized: boolean | null },
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
  return normalized
    ? { canPromote: true, reason: null, message: null, status, normalized: true }
    : { canPromote: false, reason: "NOT_NORMALIZED", message: MSG_NOT_NORMALIZED, status, normalized: false };
}

/** Veredito de uma spec da listagem da Bancada, a partir do que a listagem já sabe. */
export function decideSpecPromotability(status: string | null, normalized: boolean | null): Promotability {
  return decidePromotability("spec", { status, promotableStatus: PROJECT_PROMOTABLE_STATUS, normalized });
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
  return decidePromotability("product", {
    status: product.lifecycleStatus ?? null,
    promotableStatus: PRODUCT_PROMOTABLE_LIFECYCLE,
    normalized,
  });
}

/** Veredito para um PROJETO (spec solta do INBOX — `POST /api/projects/:id/promote`). */
export async function evaluateProjectPromotability(
  db: Queryable,
  project: { id: string; status: string | null; hasStamp: boolean },
): Promise<Promotability> {
  const normalized = await safeProjectNormalized(db, project);
  return decideSpecPromotability(project.status ?? null, normalized);
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
