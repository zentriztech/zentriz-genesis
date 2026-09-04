/**
 * governanceAudit.ts — trilha de governança (tabela governance_audit, migration 074/078).
 *
 * R4 PR5 / D4 (Jean, 2026-09-04): o flag `specApproved` ("Especificações aprovadas por humanos",
 * que liga o Sub-modo C do CTO — validar, não regenerar) é aceito de qualquer usuário do tenant e o
 * aprovador registrado é o próprio submissor. Decisão: NÃO bloquear (todo tenant nasce com 1
 * usuário), mas AUDITAR — quem setou, com que papel, em que projeto/produto, e o fato de ser
 * auto-aprovação. Sem leitura não há auditoria: ver GET /api/governance-audit (specs.ts).
 *
 * Best-effort: nunca derruba a rota que a chama (auditoria é aditiva).
 */
import type { Pool, PoolClient } from "pg";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SelfApprovalAudit = {
  actorUserId: string | null | undefined;
  actorEmail?: string | null;
  actorRole: string;
  projectId?: string | null;
  productId?: string | null;
  /** de onde veio o flag: campo multipart do /api/specs, ZIP do /api/products/ingest, body do /ingest-proposal */
  source: "specs_upload" | "products_ingest_zip" | "products_ingest_proposal";
  /** valor cru recebido (ex.: "on", "validate-only") — ajuda a reconstruir o clique */
  rawValue?: string | null;
  extra?: Record<string, unknown>;
};

function uuidOrNull(v: string | null | undefined): string | null {
  return v && UUID_RE.test(v) ? v : null;
}

/** Registra uma auto-aprovação de spec. Idempotência não é necessária (cada submissão é um evento). */
export async function recordSelfApproval(db: Pool | PoolClient, a: SelfApprovalAudit): Promise<void> {
  const snapshot = {
    selfApproved: true,
    approvedBy: a.actorEmail ?? null,
    approvedByIsSubmitter: true,
    source: a.source,
    rawValue: a.rawValue ?? null,
    actorSub: a.actorUserId ?? null,
    ...(a.extra ?? {}),
  };
  try {
    await db.query(
      `INSERT INTO governance_audit (actor_user_id, actor_role, action, project_id, product_id, snapshot)
       VALUES ($1, $2, 'spec_self_approved', $3, $4, $5::jsonb)`,
      [uuidOrNull(a.actorUserId), a.actorRole, uuidOrNull(a.projectId), uuidOrNull(a.productId), JSON.stringify(snapshot)],
    );
  } catch (e) {
    // auditoria nunca quebra o fluxo de negócio — mas fica visível no log
    console.warn("[governance-audit] falha ao registrar spec_self_approved:", e instanceof Error ? e.message : e);
  }
}
