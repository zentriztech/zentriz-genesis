/**
 * skills.ts — Skill Store dinâmico do Genesis
 *
 * GET  /api/skills                   — listar skills (filtro: role, stack_key, status, hard_rule)
 * GET  /api/skills/:id               — detalhe de uma skill
 * POST /api/skills                   — criar nova skill (zentriz_admin ou tenant_admin)
 * PATCH /api/skills/:id              — atualizar status, body_md, ttl_days
 * GET  /api/skills/assemble          — montar SYSTEM_PROMPT para role+stack_key (usado pelo runner)
 * POST /api/skills/feedback          — registrar sinal de qualidade (runner/cyborg)
 * GET  /api/skills/bundles/:projectId — listar bundles de um projeto
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { createHash } from "crypto";

function getUser(r: FastifyRequest): AuthUser {
  return (r as unknown as { user: AuthUser }).user;
}

const VALID_ROLES    = ["dev","qa","pm","devops","engineer","cto","cyborg"] as const;
const VALID_STATUSES = ["draft","shadow","trusted","deprecated"] as const;
const VALID_SIGNALS  = ["qa_pass","qa_fail","cyborg_reject","bug_recurrence","human_fix","human_approve"] as const;

export async function skillsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  // ── GET /api/skills ──────────────────────────────────────────────────────────
  app.get("/api/skills", async (request, reply) => {
    const { role, stack_key, status, hard_rule, domain } = request.query as Record<string, string>;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let p = 1;

    if (role)      { conditions.push(`role = $${p++}`);      params.push(role); }
    if (stack_key) { conditions.push(`stack_key = $${p++}`); params.push(stack_key); }
    if (domain)    { conditions.push(`domain = $${p++}`);    params.push(domain); }
    if (status)    { conditions.push(`status = $${p++}`);    params.push(status); }
    if (hard_rule !== undefined) {
      conditions.push(`hard_rule = $${p++}`);
      params.push(hard_rule === "true");
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT id, slug, role, category, stack_key, domain, title, hard_rule,
              source, status, ttl_days, use_count, quality_score, last_used_at,
              created_at, updated_at
       FROM skill ${where}
       ORDER BY hard_rule DESC, quality_score DESC, use_count DESC`,
      params
    );
    return reply.send({ data: result.rows });
  });

  // ── GET /api/skills/assemble ─────────────────────────────────────────────────
  // Endpoint primário do runner: retorna SYSTEM_PROMPT montado + bundle_hash.
  // Busca hard_rules primeiro, depois trusted, depois shadow (por ordem de qualidade).
  app.get("/api/skills/assemble", async (request, reply) => {
    const { role, stack_key, project_id, task_id } = request.query as Record<string, string>;

    if (!role || !stack_key) {
      return reply.status(400).send({ error: "role e stack_key são obrigatórios" });
    }
    if (!VALID_ROLES.includes(role as typeof VALID_ROLES[number])) {
      return reply.status(400).send({ error: `role inválido: ${role}` });
    }

    // 1. Buscar hard_rules do role (sempre incluídas, independente de stack_key)
    const hardRulesResult = await pool.query(
      `SELECT id, slug, body_md, title FROM skill
       WHERE role = $1 AND hard_rule = TRUE AND status = 'trusted'
       ORDER BY slug ASC`,
      [role]
    );

    // 2. Buscar skills específicas da stack (trusted + shadow, exceto hard_rules)
    const stackSkillsResult = await pool.query(
      `SELECT id, slug, body_md, title FROM skill
       WHERE role = $1
         AND stack_key = $2
         AND hard_rule = FALSE
         AND status IN ('trusted', 'shadow')
         AND (ttl_days IS NULL OR last_used_at IS NULL
              OR last_used_at + (ttl_days || ' days')::interval > NOW())
       ORDER BY status DESC, quality_score DESC`,
      [role, stack_key]
    );

    // 3. Se sem skills de stack, tentar 'generic'
    let stackSkills = stackSkillsResult.rows;
    if (stackSkills.length === 0 && stack_key !== "generic") {
      const genericResult = await pool.query(
        `SELECT id, slug, body_md, title FROM skill
         WHERE role = $1
           AND stack_key = 'generic'
           AND hard_rule = FALSE
           AND status IN ('trusted', 'shadow')
         ORDER BY quality_score DESC`,
        [role]
      );
      stackSkills = genericResult.rows;
    }

    const allSkills = [...hardRulesResult.rows, ...stackSkills];
    const skillIds = allSkills.map((s) => s.id);
    const bundleHash = createHash("sha256")
      .update(skillIds.sort().join(","))
      .digest("hex")
      .slice(0, 16);

    // 4. Montar SYSTEM_PROMPT: hard_rules primeiro, depois stack skills
    const hardRulesSection = hardRulesResult.rows.length > 0
      ? hardRulesResult.rows.map((s) => s.body_md).join("\n\n")
      : "";
    const stackSection = stackSkills.length > 0
      ? stackSkills.map((s) => s.body_md).join("\n\n")
      : "";

    const assembledPrompt = [
      hardRulesSection ? `<!-- HARD RULES: imutáveis -->\n${hardRulesSection}` : "",
      stackSection     ? `<!-- SKILLS: ${role}/${stack_key} -->\n${stackSection}` : "",
    ].filter(Boolean).join("\n\n---\n\n");

    // 5. Gravar bundle (se project_id fornecido)
    if (project_id && skillIds.length > 0) {
      await pool.query(
        `INSERT INTO skill_bundle
           (project_id, task_id, role, stack_key, skill_ids, bundle_hash, assembled_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'runner')
         ON CONFLICT DO NOTHING`,
        [project_id, task_id || null, role, stack_key,
         `{${skillIds.map((id) => `"${id}"`).join(",")}}`, bundleHash]
      );

      // Atualizar last_used_at e use_count
      if (skillIds.length > 0) {
        await pool.query(
          `UPDATE skill
           SET use_count = use_count + 1, last_used_at = NOW()
           WHERE id = ANY($1::uuid[])`,
          [`{${skillIds.join(",")}}`]
        );
      }
    }

    return reply.send({
      data: {
        role,
        stack_key,
        bundle_hash:    bundleHash,
        skill_count:    allSkills.length,
        hard_rule_count: hardRulesResult.rows.length,
        skills:         allSkills.map((s) => ({ id: s.id, slug: s.slug, title: s.title })),
        assembled_prompt: assembledPrompt,
        has_stack_coverage: stackSkills.length > 0,
      },
    });
  });

  // ── GET /api/skills/:id ──────────────────────────────────────────────────────
  app.get("/api/skills/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await pool.query(
      `SELECT * FROM skill WHERE id = $1`,
      [id]
    );
    if (!result.rows.length) return reply.status(404).send({ error: "Skill não encontrada" });
    return reply.send({ data: result.rows[0] });
  });

  // ── POST /api/skills ─────────────────────────────────────────────────────────
  app.post("/api/skills", async (request, reply) => {
    const user = getUser(request);
    if (!["zentriz_admin", "tenant_admin"].includes(user.role)) {
      return reply.status(403).send({ error: "Apenas admins podem criar skills" });
    }

    const {
      slug, role, category = "stack", stack_key = "generic", domain,
      title, body_md, hard_rule = false, source = "human",
      origin_ref, ttl_days, status = "draft",
    } = request.body as Record<string, unknown>;

    if (!slug || !role || !title || !body_md) {
      return reply.status(400).send({ error: "slug, role, title e body_md são obrigatórios" });
    }
    if (!VALID_ROLES.includes(role as typeof VALID_ROLES[number])) {
      return reply.status(400).send({ error: `role inválido: ${role}` });
    }

    const result = await pool.query(
      `INSERT INTO skill
         (slug, role, category, stack_key, domain, title, body_md,
          hard_rule, source, origin_ref, ttl_days, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [slug, role, category, stack_key, domain || null, title, body_md,
       hard_rule, source, origin_ref || null, ttl_days || null, status,
       /^[0-9a-f-]{36}$/.test(user.id) ? user.id : null]
    );
    return reply.status(201).send({ data: result.rows[0] });
  });

  // ── PATCH /api/skills/:id ────────────────────────────────────────────────────
  app.patch("/api/skills/:id", async (request, reply) => {
    const user = getUser(request);
    if (!["zentriz_admin", "tenant_admin"].includes(user.role)) {
      return reply.status(403).send({ error: "Apenas admins podem editar skills" });
    }

    const { id } = request.params as { id: string };
    const { status, body_md, ttl_days, title, hard_rule, origin_ref } =
      request.body as Record<string, unknown>;

    if (status && !VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
      return reply.status(400).send({ error: `status inválido: ${status}` });
    }

    // Proteger hard_rules de serem desativadas por acidente via API
    if (status === "deprecated") {
      const check = await pool.query(`SELECT hard_rule FROM skill WHERE id = $1`, [id]);
      if (check.rows[0]?.hard_rule) {
        return reply.status(400).send({
          error: "hard_rule skills não podem ser deprecadas via API — editar diretamente no banco com justificativa."
        });
      }
    }

    const sets: string[] = ["updated_at = NOW()"];
    const params: unknown[] = [];
    let p = 1;

    if (status    !== undefined) { sets.push(`status = $${p++}`);     params.push(status); }
    if (body_md   !== undefined) { sets.push(`body_md = $${p++}`);    params.push(body_md); }
    if (ttl_days  !== undefined) { sets.push(`ttl_days = $${p++}`);   params.push(ttl_days); }
    if (title     !== undefined) { sets.push(`title = $${p++}`);      params.push(title); }
    if (hard_rule !== undefined) { sets.push(`hard_rule = $${p++}`);  params.push(hard_rule); }
    if (origin_ref!== undefined) { sets.push(`origin_ref = $${p++}`); params.push(origin_ref); }

    params.push(id);
    const result = await pool.query(
      `UPDATE skill SET ${sets.join(", ")} WHERE id = $${p} RETURNING *`,
      params
    );
    if (!result.rows.length) return reply.status(404).send({ error: "Skill não encontrada" });
    return reply.send({ data: result.rows[0] });
  });

  // ── POST /api/skills/feedback ────────────────────────────────────────────────
  // Registra sinal de qualidade. Chamado pelo runner ao fechar task ou pelo cyborg.
  app.post("/api/skills/feedback", async (request, reply) => {
    const { skill_id, bundle_id, task_id, project_id, signal, weight, notes } =
      request.body as Record<string, unknown>;

    if (!skill_id || !signal) {
      return reply.status(400).send({ error: "skill_id e signal são obrigatórios" });
    }
    if (!VALID_SIGNALS.includes(signal as typeof VALID_SIGNALS[number])) {
      return reply.status(400).send({ error: `signal inválido: ${signal}` });
    }

    await pool.query(
      `INSERT INTO skill_feedback
         (skill_id, bundle_id, task_id, project_id, signal, weight, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [skill_id, bundle_id || null, task_id || null, project_id || null,
       signal, weight ?? 0, notes || null]
    );

    // Atualizar quality_score com média ponderada leve (EMA de 20 amostras)
    const weightNum = typeof weight === "number" ? weight :
      signal === "qa_pass" || signal === "human_approve" ? 0.5 :
      signal === "qa_fail" || signal === "bug_recurrence" ? -0.5 :
      signal === "cyborg_reject" ? -0.3 : 0;

    await pool.query(
      `UPDATE skill
       SET quality_score = GREATEST(0, LEAST(1,
             quality_score * 0.95 + ($1::numeric * 0.05 + 0.5) * 0.05
           )),
           updated_at = NOW()
       WHERE id = $2`,
      [weightNum, skill_id]
    );

    // Auto-promover shadow→trusted se quality_score > 0.7 e use_count >= 5
    await pool.query(
      `UPDATE skill
       SET status = 'trusted', updated_at = NOW()
       WHERE id = $1
         AND status = 'shadow'
         AND quality_score >= 0.7
         AND use_count >= 5`,
      [skill_id]
    );

    // Auto-deprecar se quality_score < 0.3 e use_count >= 10
    await pool.query(
      `UPDATE skill
       SET status = 'deprecated', updated_at = NOW()
       WHERE id = $1
         AND hard_rule = FALSE
         AND status = 'trusted'
         AND quality_score < 0.3
         AND use_count >= 10`,
      [skill_id]
    );

    return reply.status(201).send({ ok: true });
  });

  // ── POST /api/skills/bundle-result ──────────────────────────────────────────
  // Runner chama ao fechar task: atualiza result_status do bundle
  app.post("/api/skills/bundle-result", async (request, reply) => {
    const { bundle_hash, project_id, task_id, result_status } =
      request.body as Record<string, string>;

    if (!bundle_hash || !result_status) {
      return reply.status(400).send({ error: "bundle_hash e result_status são obrigatórios" });
    }

    await pool.query(
      `UPDATE skill_bundle
       SET result_status = $1
       WHERE bundle_hash = $2
         AND (project_id = $3 OR $3 IS NULL)
         AND (task_id = $4 OR $4 IS NULL)`,
      [result_status, bundle_hash, project_id || null, task_id || null]
    );

    return reply.send({ ok: true });
  });

  // ── GET /api/skills/bundles/:projectId ───────────────────────────────────────
  app.get("/api/skills/bundles/:projectId", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const result = await pool.query(
      `SELECT sb.id, sb.task_id, sb.role, sb.stack_key, sb.bundle_hash,
              sb.assembled_at, sb.result_status, sb.skill_ids,
              array_agg(s.slug ORDER BY s.slug) AS skill_slugs
       FROM skill_bundle sb
       LEFT JOIN skill s ON s.id = ANY(sb.skill_ids)
       WHERE sb.project_id = $1
       GROUP BY sb.id
       ORDER BY sb.assembled_at DESC`,
      [projectId]
    );
    return reply.send({ data: result.rows });
  });
}
