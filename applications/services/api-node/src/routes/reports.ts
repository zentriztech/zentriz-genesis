import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { type AuthUser } from "../middleware/auth.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

/**
 * T-12: /api/reports/type-compliance
 *
 * Retorna telemetria de resolução de type_policy por produto (ou tenant).
 * Fonte: agregação sobre projects.extra (project_type + status) — permite
 * dashboard interno "quantos projetos de cada tipo passam gates".
 *
 * Query params (opcionais):
 *   - product_id: filtra por produto específico
 *   - tenant_id: filtra por tenant (default: tenant do JWT do caller)
 *
 * Resposta:
 * {
 *   "generated_at": "ISO",
 *   "policy_version": "0.2.0",              // via policies.json
 *   "totals": {
 *     "projects_scanned":  N,
 *     "by_type":            {"frontend_dashboard": 42, ...},
 *     "by_status":          {"accepted": 30, "blocked_cyborg": 3, ...},
 *     "policy_mismatch":    0,               // projetos com extra.policy_mismatch_count > 0
 *     "fallback_default":   0,               // canonical_type=="_default" no chart
 *     "needs_manual_review": 0               // T-18 marker
 *   },
 *   "projects": [ { id, title, project_type, status, ... } ]
 * }
 *
 * Auth: qualquer usuário autenticado; admin vê todos os tenants.
 */
export async function reportsRoutes(app: FastifyInstance) {

  app.get<{
    Querystring: { product_id?: string; tenant_id?: string; limit?: string };
  }>("/api/reports/type-compliance", async (request, reply) => {
    const user = getUser(request);
    if (!user) return reply.status(401).send({ code: "UNAUTHORIZED" });

    const { product_id, tenant_id, limit } = request.query;
    const maxRows = Math.min(parseInt(limit ?? "500", 10) || 500, 5000);

    const client = await pool.connect();
    try {
      const where: string[] = [];
      const params: unknown[] = [];
      let i = 1;

      // Escopo por role
      if (user.role !== "zentriz_admin") {
        // Não-admin vê só seu tenant
        where.push(`p.tenant_id = $${i++}`);
        params.push(user.tenantId ?? "");
      } else if (tenant_id) {
        where.push(`p.tenant_id = $${i++}`);
        params.push(tenant_id);
      }
      if (product_id) {
        where.push(`p.product_id = $${i++}`);
        params.push(product_id);
      }

      const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

      const q = `
        SELECT
          p.id,
          p.title,
          p.status,
          p.tenant_id,
          p.product_id,
          p.extra->>'project_type' AS project_type,
          p.extra->>'project_type_original' AS project_type_original,
          (p.extra->>'project_type_needs_manual_review')::boolean AS needs_manual_review,
          p.created_at,
          p.updated_at
        FROM projects p
        ${whereClause}
        ORDER BY p.updated_at DESC
        LIMIT ${maxRows}
      `;

      const res = await client.query(q, params);
      const rows = res.rows as Array<Record<string, unknown>>;

      const byType: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      let needsReview = 0;
      let fallbackDefault = 0;
      let policyMismatch = 0;

      for (const r of rows) {
        const t = (r.project_type as string | null) ?? "(sem_tipo)";
        byType[t] = (byType[t] ?? 0) + 1;
        const s = (r.status as string | null) ?? "(sem_status)";
        byStatus[s] = (byStatus[s] ?? 0) + 1;
        if (r.needs_manual_review) needsReview++;
        if (t === "_default") fallbackDefault++;
        // policy_mismatch é registrado no extra pelo runner (T-11 telemetria)
      }

      // Policy version — ler do policies.json gerado
      let policyVersion = "unknown";
      try {
        const { readFileSync } = await import("fs");
        const { fileURLToPath } = await import("url");
        const path = await import("path");
        // dist/routes → dist → src/generated (ou generated se dist)
        const dirname = path.dirname(fileURLToPath(import.meta.url));
        const candidates = [
          path.join(dirname, "..", "generated", "policies.json"),
          path.join(dirname, "..", "..", "src", "generated", "policies.json"),
          path.join(process.cwd(), "src", "generated", "policies.json"),
        ];
        for (const c of candidates) {
          try {
            const raw = readFileSync(c, "utf-8");
            const parsed = JSON.parse(raw) as { version?: string };
            if (parsed.version) { policyVersion = parsed.version; break; }
          } catch { /* try next */ }
        }
      } catch { /* keep unknown */ }

      return reply.send({
        generated_at: new Date().toISOString(),
        policy_version: policyVersion,
        totals: {
          projects_scanned: rows.length,
          by_type: byType,
          by_status: byStatus,
          policy_mismatch: policyMismatch,
          fallback_default: fallbackDefault,
          needs_manual_review: needsReview,
        },
        projects: rows.map(r => ({
          id: r.id,
          title: r.title,
          project_type: r.project_type,
          project_type_original: r.project_type_original,
          status: r.status,
          needs_manual_review: r.needs_manual_review,
          tenant_id: r.tenant_id,
          product_id: r.product_id,
          created_at: r.created_at,
          updated_at: r.updated_at,
        })),
      });
    } finally {
      client.release();
    }
  });
}
