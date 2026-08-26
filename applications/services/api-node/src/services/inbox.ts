/**
 * inbox.ts — casas explícitas do modelo "todo App pertence a um Produto" (migration 064).
 *
 * Duas operações centrais em runtime:
 *  - resolveInboxProductId: find-or-create idempotente do INBOX "Rascunhos" do tenant.
 *  - graduateFromInbox: ao promover uma spec do inbox, cria/reusa o produto HOMÔNIMO (solo)
 *    e move o App para lá — nenhum App em fábrica vive no inbox.
 *
 * Toda função recebe o `db` do chamador (Pool ou PoolClient da transação) para compor
 * atomicidade com a saga de /run e com PATCH/DELETE de associação. Slug de `system_id`
 * reusa o `slugify` canônico do githubPush (mesma identidade Deadpool).
 */
import type { Pool, PoolClient } from "pg";
import { slugify } from "./githubPush.js";
import { recomputeProductLifecycle } from "./productLifecycle.js";

type Db = Pool | PoolClient;

/** Erro tipado para violações de posse/estado — as rotas mapeiam `.code` para 4xx. */
export class InboxError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "InboxError";
    this.code = code;
  }
}

/** `(raw ?? '').trim() || null` — string vazia/whitespace vira null (⇒ inbox). */
export function normalizeProductId(raw: unknown): string | null {
  const v = (raw == null ? "" : String(raw)).trim();
  return v.length > 0 ? v : null;
}

/**
 * Find-or-create idempotente do INBOX do tenant. Reativa um inbox arquivado.
 * `createdBy` deve ser um user válido do tenant (products.created_by é NOT NULL).
 * Depende de `uq_products_inbox_per_tenant` (partial unique index em is_inbox).
 */
export async function resolveInboxProductId(
  db: Db,
  tenantId: string,
  createdBy: string,
): Promise<string> {
  const res = await db.query(
    `INSERT INTO products (tenant_id, created_by, name, description, status, lifecycle_status, is_inbox)
     VALUES ($1, $2, 'Rascunhos',
             'Caixa de entrada do sistema: specs ainda nao organizadas em um produto (re-alocaveis enquanto rascunho).',
             'active', 'draft', true)
     ON CONFLICT (tenant_id) WHERE is_inbox DO UPDATE SET status = 'active', updated_at = now()
     RETURNING id`,
    [tenantId, createdBy],
  );
  return String((res.rows[0] as { id: string }).id);
}

/** Garante que o produto pertence ao tenant; lança InboxError('PRODUCT_NOT_FOUND') se não. */
export async function assertProductOwnership(
  db: Db,
  productId: string,
  tenantId: string,
): Promise<{ id: string; isInbox: boolean; soloApp: boolean }> {
  const res = await db.query(
    "SELECT id, is_inbox, solo_app FROM products WHERE id = $1 AND tenant_id = $2",
    [productId, tenantId],
  );
  if (res.rows.length === 0) {
    throw new InboxError("PRODUCT_NOT_FOUND", "Produto não encontrado neste tenant.");
  }
  const row = res.rows[0] as { id: string; is_inbox: boolean; solo_app: boolean };
  return { id: String(row.id), isInbox: row.is_inbox, soloApp: row.solo_app };
}

/** system_id livre no tenant a partir do título; desambigua com sufixo do projectId. */
async function pickSystemId(
  db: Db,
  tenantId: string,
  title: string,
  projectId: string,
  extraBytes = 8,
): Promise<string> {
  const base = slugify(title) || `app-${projectId.slice(0, 8)}`;
  const taken = await db.query(
    "SELECT 1 FROM products WHERE tenant_id = $1 AND lower(system_id) = lower($2) LIMIT 1",
    [tenantId, base],
  );
  if (taken.rows.length === 0) return base;
  return `${base}-${projectId.slice(0, Math.min(extraBytes, projectId.length))}`;
}

/**
 * Cria (ou reusa, idempotente) o produto HOMÔNIMO de um App solo e move o App para ele.
 * Roda no `db`/transação do chamador. Trata 23505 em `uq_products_system_id_per_tenant`
 * re-sufixando o slug e retentando (≤3). Recomputa o lifecycle do produto ao final.
 */
export async function graduateFromInbox(
  db: Db,
  params: { projectId: string; tenantId: string; createdBy: string; title: string },
): Promise<string> {
  const { projectId, tenantId, createdBy, title } = params;

  let productId: string | null = null;
  let attempt = 0;
  // Reuso idempotente por origem: ON CONFLICT (origin_project_id) WHERE solo_app.
  // Colisão de system_id (outro projeto, mesmo slug) é OUTRA constraint → 23505 → re-sufixa.
  for (; attempt < 3 && productId === null; attempt++) {
    const systemId = await pickSystemId(db, tenantId, title, projectId, 8 + attempt * 4);
    try {
      const res = await db.query(
        `INSERT INTO products (tenant_id, created_by, name, status, lifecycle_status, is_inbox, solo_app, system_id, origin_project_id)
         VALUES ($1, $2, $3, 'active', 'running', false, true, $4, $5)
         ON CONFLICT (origin_project_id) WHERE solo_app DO UPDATE SET updated_at = now()
         RETURNING id`,
        [tenantId, createdBy, title, systemId, projectId],
      );
      productId = String((res.rows[0] as { id: string }).id);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "23505" && attempt < 2) continue; // colisão de system_id → retenta com mais bytes
      throw e;
    }
  }
  if (productId === null) {
    throw new InboxError("SYSTEM_ID_COLLISION", "Não foi possível derivar um system_id único para o App.");
  }

  await db.query(
    "UPDATE projects SET product_id = $1, updated_at = now() WHERE id = $2",
    [productId, projectId],
  );
  await recomputeProductLifecycle(db, productId);
  return productId;
}

/**
 * Reverte um App ao inbox (compensação de saga do /run). Remove o produto solo se ele
 * foi recém-criado e ficou sem projetos. `createdBy` alimenta o find-or-create do inbox.
 */
export async function demoteToInbox(
  db: Db,
  params: { projectId: string; tenantId: string; createdBy: string; soloProductId: string },
): Promise<void> {
  const inboxId = await resolveInboxProductId(db, params.tenantId, params.createdBy);
  await db.query(
    "UPDATE projects SET product_id = $1, updated_at = now() WHERE id = $2",
    [inboxId, params.projectId],
  );
  await cleanupEmptySoloProduct(db, params.soloProductId);
}

/** Hard-delete de um produto solo_app que ficou com 0 projetos (evita homônimo-fantasma). */
export async function cleanupEmptySoloProduct(db: Db, productId: string): Promise<void> {
  await db.query(
    `DELETE FROM products p
     WHERE p.id = $1 AND p.solo_app = true AND p.is_inbox = false
       AND NOT EXISTS (SELECT 1 FROM projects pr WHERE pr.product_id = p.id)`,
    [productId],
  );
}
