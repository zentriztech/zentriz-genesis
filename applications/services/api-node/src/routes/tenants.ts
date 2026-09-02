import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { validateEmail } from "../auth.js";
import { isValidCnpj, normalizeCnpjAlnum } from "../services/cnpjLookup.js";
import { bustTenantStatus } from "../services/tenantStatusCache.js";
import { maybeNotifyTenantActivated } from "../services/tenantNotify.js";

function getUser(request: FastifyRequest): AuthUser {
  return (request as unknown as { user: AuthUser }).user;
}

const TENANT_STATUSES = ["active", "suspended", "inactive"] as const;
type TenantStatus = (typeof TENANT_STATUSES)[number];

/** Campos de contato/CNPJ/responsável/endereço aceitos em create + patch. */
type TenantExtraBody = {
  email?: string | null;
  emailConfirmed?: boolean;
  cnpj?: string | null;
  responsibleName?: string | null;
  responsibleEmail?: string | null;
  responsiblePhone?: string | null;
  addressCep?: string | null;
  addressStreet?: string | null;
  addressNumber?: string | null;
  addressComplement?: string | null;
  addressDistrict?: string | null;
  addressCity?: string | null;
  addressState?: string | null;
  /** Whitelist BYOC: autoriza o tenant a usar a infra de deploy da Zentriz pelo host. */
  byocExempt?: boolean;
};

type CreateTenantBody = { name?: string; planId?: string; status?: string } & TenantExtraBody;
type UpdateTenantBody = { name?: string; planId?: string; status?: string } & TenantExtraBody;

/** Campos textuais editáveis: chave do body (camelCase) → coluna + normalização. */
const TENANT_TEXT_FIELDS: { key: keyof TenantExtraBody; col: string; transform: (v: string) => string }[] = [
  { key: "email", col: "email", transform: (v) => v.trim().toLowerCase() },
  { key: "cnpj", col: "cnpj", transform: (v) => normalizeCnpjAlnum(v) },
  { key: "responsibleName", col: "responsible_name", transform: (v) => v.trim() },
  { key: "responsibleEmail", col: "responsible_email", transform: (v) => v.trim().toLowerCase() },
  { key: "responsiblePhone", col: "responsible_phone", transform: (v) => v.trim() },
  { key: "addressCep", col: "address_cep", transform: (v) => v.trim() },
  { key: "addressStreet", col: "address_street", transform: (v) => v.trim() },
  { key: "addressNumber", col: "address_number", transform: (v) => v.trim() },
  { key: "addressComplement", col: "address_complement", transform: (v) => v.trim() },
  { key: "addressDistrict", col: "address_district", transform: (v) => v.trim() },
  { key: "addressCity", col: "address_city", transform: (v) => v.trim() },
  { key: "addressState", col: "address_state", transform: (v) => v.trim().toUpperCase() },
];

/** Colunas extras para os SELECTs (prefixadas com o alias t). */
const TENANT_EXTRA_SELECT =
  "t.email, t.email_confirmed, t.cnpj, t.responsible_name, t.responsible_email, t.responsible_phone, " +
  "t.address_cep, t.address_street, t.address_number, t.address_complement, t.address_district, t.address_city, t.address_state, " +
  "t.byoc_exempt";

/** Colunas extras para RETURNING (sem alias). */
const TENANT_EXTRA_RETURNING =
  "email, email_confirmed, cnpj, responsible_name, responsible_email, responsible_phone, " +
  "address_cep, address_street, address_number, address_complement, address_district, address_city, address_state, " +
  "byoc_exempt";

/** Mapeia colunas extras de uma linha para o shape camelCase da API. */
function mapTenantExtra(row: Record<string, unknown>) {
  return {
    email: (row.email as string) ?? null,
    emailConfirmed: !!row.email_confirmed,
    cnpj: (row.cnpj as string) ?? null,
    responsibleName: (row.responsible_name as string) ?? null,
    responsibleEmail: (row.responsible_email as string) ?? null,
    responsiblePhone: (row.responsible_phone as string) ?? null,
    addressCep: (row.address_cep as string) ?? null,
    addressStreet: (row.address_street as string) ?? null,
    addressNumber: (row.address_number as string) ?? null,
    addressComplement: (row.address_complement as string) ?? null,
    addressDistrict: (row.address_district as string) ?? null,
    addressCity: (row.address_city as string) ?? null,
    addressState: (row.address_state as string) ?? null,
    byocExempt: !!row.byoc_exempt,
  };
}

/**
 * Coleta colunas/valores dos campos extras a partir do body. Valida e-mail e CNPJ.
 * String vazia / null → NULL (limpa o campo). Campo ausente → não tocado.
 * Retorna { cols, vals } ou { error } em caso de valor inválido.
 */
function collectTenantExtra(body: TenantExtraBody): { cols: string[]; vals: unknown[] } | { error: string } {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const f of TENANT_TEXT_FIELDS) {
    const raw = body[f.key];
    if (raw === undefined) continue;
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
      cols.push(f.col);
      vals.push(null);
      continue;
    }
    if (typeof raw !== "string") return { error: `Campo ${f.key} inválido` };
    const val = f.transform(raw);
    if ((f.key === "email" || f.key === "responsibleEmail") && !validateEmail(val)) {
      return { error: "E-mail inválido" };
    }
    if (f.key === "cnpj" && !isValidCnpj(val)) {
      return { error: "CNPJ inválido" };
    }
    cols.push(f.col);
    vals.push(val);
  }
  if (body.emailConfirmed !== undefined) {
    cols.push("email_confirmed");
    vals.push(!!body.emailConfirmed);
  }
  if (body.byocExempt !== undefined) {
    cols.push("byoc_exempt");
    vals.push(!!body.byocExempt);
  }
  return { cols, vals };
}

/** Garante que o chamador é o master Zentriz; caso contrário responde 403 e retorna false. */
function requireZentrizAdmin(request: FastifyRequest, reply: { status: (c: number) => { send: (b: unknown) => unknown } }): boolean {
  const user = getUser(request);
  if (user.role !== "zentriz_admin") {
    reply.status(403).send({ code: "FORBIDDEN", message: "Acesso restrito a Zentriz" });
    return false;
  }
  return true;
}

export async function tenantRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // Lista todos os tenants com plano e contadores de uso (só master).
  app.get("/api/tenants", async (request, reply) => {
    if (!requireZentrizAdmin(request, reply)) return;
    const result = await pool.query(
      `SELECT t.id, t.name, t.plan_id, t.status, t.created_at, ${TENANT_EXTRA_SELECT},
              p.name AS plan_name, p.slug AS plan_slug, p.max_projects, p.max_users_per_tenant,
              (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id)     AS users_count,
              (SELECT COUNT(*) FROM projects pr WHERE pr.tenant_id = t.id) AS projects_count
         FROM tenants t JOIN plans p ON t.plan_id = p.id
        ORDER BY t.name`
    );
    return reply.send(
      result.rows.map((row: Record<string, unknown>) => ({
        id: row.id,
        name: row.name,
        planId: row.plan_id,
        plan: {
          name: row.plan_name,
          slug: row.plan_slug,
          maxProjects: row.max_projects,
          maxUsersPerTenant: row.max_users_per_tenant,
        },
        status: row.status,
        ...mapTenantExtra(row),
        usersCount: Number(row.users_count),
        projectsCount: Number(row.projects_count),
        createdAt: (row.created_at as Date)?.toISOString(),
      }))
    );
  });

  app.get<{ Params: { id: string } }>("/api/tenants/:id", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "zentriz_admin" && user.tenantId !== request.params.id) {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
    }
    const result = await pool.query(
      `SELECT t.id, t.name, t.plan_id, t.status, t.created_at, ${TENANT_EXTRA_SELECT}, p.id as plan_pk, p.name as plan_name, p.slug as plan_slug, p.max_projects, p.max_users_per_tenant
       FROM tenants t JOIN plans p ON t.plan_id = p.id WHERE t.id = $1`,
      [request.params.id]
    );
    const row = result.rows[0];
    if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Tenant não encontrado" });
    return reply.send({
      id: row.id,
      name: row.name,
      planId: row.plan_id,
      plan: {
        id: row.plan_pk,
        name: row.plan_name,
        slug: row.plan_slug,
        maxProjects: row.max_projects,
        maxUsersPerTenant: row.max_users_per_tenant,
      },
      status: row.status,
      ...mapTenantExtra(row),
      createdAt: (row.created_at as Date).toISOString(),
    });
  });

  // Cria tenant (só master). Nasce 'active' por padrão (provisionamento interno).
  app.post<{ Body: CreateTenantBody }>("/api/tenants", async (request, reply) => {
    if (!requireZentrizAdmin(request, reply)) return;
    const { name, planId, status } = request.body ?? {};
    if (!name || name.trim().length < 2) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Nome do tenant deve ter ao menos 2 caracteres" });
    }
    if (!planId) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "planId é obrigatório" });
    }
    // Status inválido é rejeitado (consistente com o PATCH) em vez de virar 'active' silenciosamente.
    if (status !== undefined && !TENANT_STATUSES.includes(status as TenantStatus)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: `status deve ser um de: ${TENANT_STATUSES.join(", ")}` });
    }
    const finalStatus: TenantStatus = (status as TenantStatus | undefined) ?? "active";

    const extra = collectTenantExtra(request.body ?? {});
    if ("error" in extra) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: extra.error });
    }

    const client = await pool.connect();
    try {
      const plan = await client.query("SELECT id FROM plans WHERE id = $1", [planId]);
      if (plan.rows.length === 0) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Plano inexistente" });
      }
      const cols = ["name", "plan_id", "status", ...extra.cols];
      const vals: unknown[] = [name.trim(), planId, finalStatus, ...extra.vals];
      const placeholders = cols.map((_, idx) => `$${idx + 1}`).join(", ");
      const result = await client.query(
        `INSERT INTO tenants (${cols.join(", ")}) VALUES (${placeholders})
         RETURNING id, name, plan_id, status, created_at, ${TENANT_EXTRA_RETURNING}`,
        vals
      );
      const row = result.rows[0];
      // Onboarding: tenant nascido ativo recebe o guia de Configurações (fire-and-forget, idempotente).
      maybeNotifyTenantActivated(pool, row.id as string, finalStatus);
      return reply.status(201).send({
        id: row.id,
        name: row.name,
        planId: row.plan_id,
        status: row.status,
        ...mapTenantExtra(row),
        createdAt: (row.created_at as Date).toISOString(),
      });
    } finally {
      client.release();
    }
  });

  // Atualiza nome / plano / status do tenant (só master). Base do gerenciamento de status.
  app.patch<{ Params: { id: string }; Body: UpdateTenantBody }>("/api/tenants/:id", async (request, reply) => {
    if (!requireZentrizAdmin(request, reply)) return;
    const { name, planId, status } = request.body ?? {};

    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (name !== undefined) {
      if (name.trim().length < 2) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Nome do tenant deve ter ao menos 2 caracteres" });
      }
      sets.push(`name = $${i++}`);
      params.push(name.trim());
    }
    if (planId !== undefined) {
      const plan = await pool.query("SELECT id FROM plans WHERE id = $1", [planId]);
      if (plan.rows.length === 0) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "Plano inexistente" });
      }
      sets.push(`plan_id = $${i++}`);
      params.push(planId);
    }
    if (status !== undefined) {
      if (!TENANT_STATUSES.includes(status as TenantStatus)) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: `status deve ser um de: ${TENANT_STATUSES.join(", ")}` });
      }
      sets.push(`status = $${i++}`);
      params.push(status);
    }

    const extra = collectTenantExtra(request.body ?? {});
    if ("error" in extra) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: extra.error });
    }
    for (let k = 0; k < extra.cols.length; k++) {
      sets.push(`${extra.cols[k]} = $${i++}`);
      params.push(extra.vals[k]);
    }

    if (sets.length === 0) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Nada para atualizar" });
    }

    params.push(request.params.id);
    const result = await pool.query(
      `UPDATE tenants SET ${sets.join(", ")} WHERE id = $${i}
       RETURNING id, name, plan_id, status, created_at, ${TENANT_EXTRA_RETURNING}`,
      params
    );
    const row = result.rows[0];
    if (!row) return reply.status(404).send({ code: "NOT_FOUND", message: "Tenant não encontrado" });
    // F2/H3: mudança manual de status pelo master precisa refletir de imediato no
    // gate de suspensão (senão o cache de status seguraria o valor antigo por ~30s).
    if (status !== undefined) bustTenantStatus(request.params.id);
    // Onboarding: ativação deliberada (status=active no body) dispara o guia de
    // Configurações ao responsável (fire-and-forget, idempotente por tenant).
    maybeNotifyTenantActivated(pool, request.params.id, status);
    return reply.send({
      id: row.id,
      name: row.name,
      planId: row.plan_id,
      status: row.status,
      ...mapTenantExtra(row),
      createdAt: (row.created_at as Date).toISOString(),
    });
  });
}
