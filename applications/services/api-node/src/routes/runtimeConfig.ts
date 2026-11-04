/**
 * runtimeConfig.ts — Configuração dinâmica do runtime Genesis
 *
 * GET  /api/admin/runtime-config          — listar todas as chaves (global + tenant override)
 * PUT  /api/admin/runtime-config/:key     — criar ou atualizar valor de uma chave
 * DELETE /api/admin/runtime-config/:key   — remover override de tenant (restaura global)
 * GET  /api/admin/runtime-config/resolved — valores resolvidos (merge global + tenant)
 *
 * Acesso: zentriz_admin vê e edita tudo (global + qualquer tenant).
 *         tenant_admin vê os defaults globais + seus overrides; só edita seus overrides.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { resolveScopedTenantId } from "../lib/tenantScope.js";
import { FLAG_DEFS, FLAG_NAMES, isRolloutFlagKey, resolveFlag } from "../services/featureFlags.js";
import { backfillCardState, backfillSpecOrigin, getCardsBackfillJob, listCardsBackfillJobs, type CardsBackfillOutcome } from "../services/cardsBackfill.js";
import { findCardStatusDivergences, type CardDivergence } from "../services/cardState.js";
import { MULTIPART_MAX_FILES, MULTIPART_MAX_FILE_BYTES, MULTIPART_MAX_TOTAL_BYTES } from "../services/ticketAttachments.js";

function getUser(r: FastifyRequest): AuthUser {
  return (r as unknown as { user: AuthUser }).user;
}

// Chaves permitidas e seus metadados de exibição
// `adminOnly`: só zentriz_admin grava/remove (flags de rollout — M-03/R2). tenant_admin enxerga, mas não altera.
const CONFIG_KEYS: Record<string, { label: string; group: string; unit: string; min: number; max: number; adminOnly?: boolean }> = {
  AGENT_TIMEOUT_ENGINEER: { label: "Timeout Engineer",  group: "timeouts", unit: "s", min: 60,  max: 3600 },
  AGENT_TIMEOUT_CTO:      { label: "Timeout CTO",       group: "timeouts", unit: "s", min: 60,  max: 3600 },
  AGENT_TIMEOUT_PM:       { label: "Timeout PM",        group: "timeouts", unit: "s", min: 60,  max: 3600 },
  AGENT_TIMEOUT_DEV:      { label: "Timeout Dev",       group: "timeouts", unit: "s", min: 60,  max: 3600 },
  AGENT_TIMEOUT_QA:       { label: "Timeout QA",        group: "timeouts", unit: "s", min: 60,  max: 3600 },
  AGENT_TIMEOUT_MONITOR:  { label: "Timeout Monitor",   group: "timeouts", unit: "s", min: 60,  max: 3600 },
  AGENT_TIMEOUT_DEVOPS:   { label: "Timeout DevOps",    group: "timeouts", unit: "s", min: 60,  max: 3600 },
  REQUEST_TIMEOUT:        { label: "Timeout HTTP base", group: "timeouts", unit: "s", min: 60,  max: 3600 },
  MAX_QA_REWORK:          { label: "Máx. ciclos QA",    group: "limits",   unit: "",  min: 1,   max: 10   },
  CLAUDE_MAX_TOKENS:      { label: "Max tokens (padrão)",   group: "tokens", unit: "tk", min: 1000, max: 64000 },
  CLAUDE_MAX_TOKENS_DEV:  { label: "Max tokens Dev",        group: "tokens", unit: "tk", min: 1000, max: 64000 },
  CLAUDE_MAX_TOKENS_PM:   { label: "Max tokens PM",         group: "tokens", unit: "tk", min: 1000, max: 64000 },
  CLAUDE_MAX_TOKENS_ENGINEER:   { label: "Max tokens Engineer",   group: "tokens", unit: "tk", min: 1000, max: 64000 },
  CLAUDE_MAX_TOKENS_QA:         { label: "Max tokens QA",         group: "tokens", unit: "tk", min: 1000, max: 64000 },
  // spec_intake re-emite a PRODUCT_SPEC inteira no output — specs grandes exigem teto alto.
  // Cap baixo trunca o JSON (BLOCKED). Default 64000 (teto do modelo).
  CLAUDE_MAX_TOKENS_SPEC_INTAKE: { label: "Max tokens Spec Intake (CTO)", group: "tokens", unit: "tk", min: 1000, max: 64000 },
  // Chat livre da Bancada por arquivo: o modelo devolve o arquivo INTEIRO, então o teto precisa
  // cobrir a cópia + o que a edição acrescenta. Lido pela api (specChat.ts) a cada pedido — sem deploy.
  // Faixa = SPEC_CHAT_MAX_TOKENS_BOUNDS (piso histórico da fórmula, teto seguro do SDK).
  SPEC_CHAT_MAX_TOKENS:   { label: "Max tokens Chat da Bancada (arquivo)", group: "tokens", unit: "tk", min: 8000, max: 32000 },
  // Tarefa 1.5 (anexos do card): tetos por card, valendo só com ATTACHMENTS_STRICT=on. calibrado=falso.
  // M-17: as faixas param no teto do multipart de app.ts (acima disso o upload é cortado antes da validação).
  ATTACHMENT_MAX_FILES:       { label: "Anexos: máx. arquivos por card", group: "limits", unit: "", min: 1, max: MULTIPART_MAX_FILES },
  ATTACHMENT_MAX_TOTAL_BYTES: { label: "Anexos: máx. bytes somados por card", group: "limits", unit: "B", min: 1024, max: MULTIPART_MAX_TOTAL_BYTES },
  ATTACHMENT_MAX_FILE_BYTES:  { label: "Anexos: máx. bytes por arquivo", group: "limits", unit: "B", min: 1024, max: MULTIPART_MAX_FILE_BYTES },
  // Fase 2 (2.6): paginação da lista de cards e teto de bytes da spec-base devolvida ao portal. calibrado=falso (padrões no código só valem sem a chave).
  CARDS_LIST_PAGE_DEFAULT:    { label: "Cards: itens por página (padrão)", group: "limits", unit: "", min: 1, max: 1000 },
  CARDS_LIST_PAGE_MAX:        { label: "Cards: itens por página (máximo)", group: "limits", unit: "", min: 1, max: 1000 },
  CARD_BASE_SPEC_MAX_BYTES:   { label: "Cards: teto de bytes da spec-base (somente leitura)", group: "limits", unit: "B", min: 1024, max: 50000000 },
  // M-03 — flags de rollout da Fase 1' (services/featureFlags.ts). Precedência: tenant explícito > global > env (default) > off.
  // adminOnly: ligar/desligar rollout é decisão da plataforma, nunca do tenant_admin.
  ...Object.fromEntries(FLAG_NAMES.map((k) => [k, {
    label: FLAG_DEFS[k].label, group: "flags", unit: "", min: 0, max: FLAG_DEFS[k].kind === "tri" ? 2 : 1, adminOnly: true,
  }])),
};

type TxClient = { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>; release(): void };

/** Máximo de divergências listadas no corpo do 409 `CARD_DIVERGENCE`. */
const CARD_DIVERGENCE_LIST_LIMIT = 20;

export type CardsFlagChange<R> =
  | { kind: "ok"; result: R; cardsBackfill: CardsBackfillOutcome[] }
  | { kind: "skipped"; result: R }
  | { kind: "divergence"; divergences: Array<CardDivergence & { tenantId: string }> }
  | { kind: "failed"; tenantId: string; error: string };

/**
 * Fase 2 (2.5 + trava S-01 do lote B): TODA mudança de `CARDS_BANCADA` (PUT e DELETE) roda NUMA transação:
 *   1) grava/remove a linha da flag (`mutate`);
 *   2) para cada tenant em que a flag passa a valer ligada, roda o backfill idempotente (`card_state`, `spec_origin`) com o MESMO cliente
 *      (a flag ainda não confirmada é visível a ele);
 *   3) confere `findCardStatusDivergences` (card_state × status) dos tenants alvo — tenant explícito: sempre; padrão global: só os tenants
 *      que passaram de desligado a ligado. Qualquer divergência ⇒ ROLLBACK de tudo (flag + backfill): o tenant fica exatamente como estava
 *      e a resposta é 409 `CARD_DIVERGENCE` com as ocorrências. Falha do backfill também desfaz tudo (`failed`).
 * Desligar a flag nunca é bloqueado. Outras chaves não passam por aqui.
 * Serializado por `pg_advisory_xact_lock` para duas mudanças simultâneas da flag não se intercalarem.
 */
export async function changeCardsFlag<R>(
  tenantId: string | null,
  mutate: (c: TxClient) => Promise<{ proceed: boolean; result: R }>,
): Promise<CardsFlagChange<R>> {
  const client = (await pool.connect()) as unknown as TxClient;
  try {
    // Decisão de integração (lote A + lote B): a trava S-01 (backfill + conferência de divergências + ROLLBACK) exige a
    // mesma transação, então o backfill roda aqui de forma síncrona, inclusive no padrão GLOBAL. O job assíncrono do
    // lote A (S-11) segue disponível em `startCardsBackfillJob` para instalações com muitos tenants (ligar tenant a tenant).
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('CARDS_BANCADA'))");
    const tenants: string[] = tenantId
      ? [tenantId]
      : (await client.query("SELECT id FROM tenants")).rows.map((r) => String(r.id));
    const wasOn = new Map<string, boolean>();
    for (const t of tenants) wasOn.set(t, (await resolveFlag(client, "CARDS_BANCADA", t)).value >= 1);
    const m = await mutate(client);
    if (!m.proceed) { await client.query("ROLLBACK"); return { kind: "skipped", result: m.result }; }
    const outcomes: CardsBackfillOutcome[] = [];
    const divergences: Array<CardDivergence & { tenantId: string }> = [];
    for (const t of tenants) {
      if ((await resolveFlag(client, "CARDS_BANCADA", t)).value < 1) continue;
      try {
        await client.query("SAVEPOINT cards_flag_tenant");
        const cardState = await backfillCardState(client, t);
        const specOrigin = await backfillSpecOrigin(client, t);
        await client.query("RELEASE SAVEPOINT cards_flag_tenant");
        outcomes.push({ tenantId: t, cardState, specOrigin });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        return { kind: "failed", tenantId: t, error: e instanceof Error ? e.message : String(e) };
      }
      if (tenantId !== null || !wasOn.get(t)) {
        for (const d of await findCardStatusDivergences(client, { tenantId: t, limit: CARD_DIVERGENCE_LIST_LIMIT })) divergences.push({ ...d, tenantId: t });
      }
    }
    if (divergences.length > 0) {
      await client.query("ROLLBACK");
      return { kind: "divergence", divergences: divergences.slice(0, CARD_DIVERGENCE_LIST_LIMIT) };
    }
    await client.query("COMMIT");
    return { kind: "ok", result: m.result, cardsBackfill: outcomes };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

function cardsRefusal(r: Extract<CardsFlagChange<unknown>, { kind: "divergence" | "failed" }>) {
  if (r.kind === "divergence") {
    return {
      status: 409,
      body: {
        code: "CARD_DIVERGENCE",
        message: "CARDS_BANCADA não foi alterada: há tickets com card_state diferente do status legado. Corrija as divergências e repita.",
        divergences: r.divergences,
      },
    };
  }
  return { status: 500, body: { code: "CARDS_BACKFILL_FAILED", message: `CARDS_BANCADA não foi alterada: o backfill falhou (${r.error}).`, tenantId: r.tenantId } };
}

export async function runtimeConfigRoutes(app: FastifyInstance): Promise<void> {
  // Todas as rotas exigem autenticação JWT (Bearer) — inclusive o runner usa Bearer
  app.addHook("preHandler", authMiddleware);

  // ── GET /api/admin/runtime-config/cards-backfill[/:jobId] ─────────────────
  // Relatório do backfill assíncrono disparado pelo padrão GLOBAL de CARDS_BANCADA (S-11). Só zentriz_admin.
  app.get<{ Params: { jobId?: string } }>("/api/admin/runtime-config/cards-backfill/:jobId?", async (request, reply) => {
    if (getUser(request).role !== "zentriz_admin") return reply.status(403).send({ code: "FORBIDDEN", message: "Somente administrador da plataforma" });
    const { jobId } = request.params;
    if (!jobId) return reply.send({ jobs: listCardsBackfillJobs() });
    const job = getCardsBackfillJob(jobId);
    return job ? reply.send(job) : reply.status(404).send({ code: "NOT_FOUND", message: "Job de backfill não encontrado (só os 20 mais recentes, em memória)" });
  });

  // ── GET /api/admin/runtime-config/resolved ─────────────────────────────────
  // Valores efetivos: global sobrescrito pelo override do tenant.
  // Acessível por zentriz_admin, tenant_admin e zentriz_admin com token de runner.
  app.get("/api/admin/runtime-config/resolved", async (request, reply) => {
    const user     = getUser(request);
    const tenantId = user.role === "zentriz_admin" ? null : user.tenantId ?? null;

    const result = await pool.query(
      `SELECT key, value, tenant_id
       FROM genesis_runtime_config
       WHERE tenant_id IS NULL OR tenant_id = $1
       ORDER BY tenant_id NULLS FIRST`,
      [tenantId]
    );

    const resolved: Record<string, string> = {};
    for (const row of result.rows) {
      resolved[row.key] = row.value;
    }
    return reply.send(resolved);
  });

  // ── GET /api/admin/runtime-config ─────────────────────────────────────────
  // Lista todas as chaves com metadados, valor global e override do tenant
  app.get("/api/admin/runtime-config", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "zentriz_admin" && user.role !== "tenant_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
    }

    // Master: com ?tenantId= (seletor do portal) mostra global + overrides do tenant;
    // sem seleção, só os defaults globais. tenant_admin: sempre o próprio tenant.
    const tenantId = resolveScopedTenantId(user, request.query);

    const result = await pool.query(
      `SELECT key, value, description, tenant_id, updated_at, updated_by
       FROM genesis_runtime_config
       WHERE tenant_id IS NULL OR tenant_id = $1
       ORDER BY key`,
      [tenantId]
    );

    // Organizar por chave: { global, tenantOverride }
    const byKey: Record<string, { global?: string; override?: string; updatedAt?: string; updatedBy?: string; description?: string }> = {};
    for (const row of result.rows) {
      if (!byKey[row.key]) byKey[row.key] = {};
      if (row.tenant_id === null) {
        byKey[row.key].global      = row.value;
        byKey[row.key].description = row.description;
      } else {
        byKey[row.key].override  = row.value;
        byKey[row.key].updatedAt = row.updated_at;
        byKey[row.key].updatedBy = row.updated_by;
      }
    }

    // Montar lista enriquecida com metadados
    const configs = Object.entries(CONFIG_KEYS).map(([key, meta]) => {
      const data = byKey[key] ?? {};
      return {
        key,
        label:       meta.label,
        group:       meta.group,
        unit:        meta.unit,
        min:         meta.min,
        max:         meta.max,
        adminOnly:   !!meta.adminOnly,
        globalValue: data.global ?? null,
        tenantValue: data.override ?? null,
        effectiveValue: data.override ?? data.global ?? null,
        description: data.description ?? null,
        hasOverride: !!data.override,
        updatedAt:   data.updatedAt ?? null,
      };
    });

    return reply.send(configs);
  });

  // ── PUT /api/admin/runtime-config/:key ─────────────────────────────────────
  // Cria ou atualiza valor. zentriz_admin pode definir global (sem tenant_id)
  // ou para um tenant específico. tenant_admin só pode definir seu próprio override.
  app.put<{ Params: { key: string }; Body: { value: string | number; tenantId?: string } }>(
    "/api/admin/runtime-config/:key",
    async (request, reply) => {
      const user     = getUser(request);
      const { key }  = request.params;
      const { value } = request.body ?? {};

      if (user.role !== "zentriz_admin" && user.role !== "tenant_admin") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
      }

      if (!CONFIG_KEYS[key]) {
        return reply.status(400).send({ code: "INVALID_KEY", message: `Chave '${key}' não é configurável` });
      }

      const meta = CONFIG_KEYS[key];
      if (meta.adminOnly && user.role !== "zentriz_admin") {
        return reply.status(403).send({ code: "ADMIN_ONLY_KEY", message: `A chave '${key}' só pode ser alterada pelo administrador da plataforma` });
      }
      const numVal = Number(value);
      if (isNaN(numVal) || numVal < meta.min || numVal > meta.max) {
        return reply.status(400).send({
          code: "OUT_OF_RANGE",
          message: `Valor deve ser entre ${meta.min} e ${meta.max} ${meta.unit}`,
        });
      }

      // Determinar target_tenant_id via helper compartilhado:
      // zentriz_admin → body.tenantId se UUID-válido (senão null = global);
      // tenant_admin → sempre o próprio JWT (body.tenantId ignorado).
      const targetTenantId = resolveScopedTenantId(user, request.body);

      // Espelha a guarda do DELETE: tenant_admin nunca pode gravar o default global.
      if (user.role === "tenant_admin" && targetTenantId === null) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "tenant_admin não pode alterar configuração global" });
      }

      const upsert = async (db: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null }> }) => {
        if (targetTenantId === null) {
          // Linha GLOBAL: `UNIQUE (key, tenant_id)` não conflita com NULL, então ON CONFLICT duplicaria a linha a cada PUT (131_llm_guard…).
          // Atualiza TODAS as linhas globais da chave (converge duplicatas antigas) e só insere se não houver nenhuma.
          const up = await db.query(
            `UPDATE genesis_runtime_config SET value = $2, updated_by = $3, updated_at = NOW() WHERE key = $1 AND tenant_id IS NULL`,
            [key, String(numVal), user.id],
          );
          if ((up.rowCount ?? 0) > 0) return;
          await db.query(
            `INSERT INTO genesis_runtime_config (key, value, tenant_id, updated_by, updated_at) VALUES ($1, $2, NULL, $3, NOW())`,
            [key, String(numVal), user.id],
          );
          return;
        }
        await db.query(
          `INSERT INTO genesis_runtime_config (key, value, tenant_id, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (key, tenant_id) DO UPDATE
             SET value = $2, updated_by = $4, updated_at = NOW()`,
          [key, String(numVal), targetTenantId, user.id],
        );
      };
      let cardsBackfill: CardsBackfillOutcome[] | undefined;
      if (key === "CARDS_BANCADA") {
        // Trava S-01: backfill + conferência de divergência na mesma transação da gravação (reverte se houver divergência).
        const ch = await changeCardsFlag<null>(targetTenantId, async (c) => { await upsert(c); return { proceed: true, result: null }; });
        if (ch.kind === "divergence" || ch.kind === "failed") {
          const ref = cardsRefusal(ch);
          return reply.status(ref.status).send(ref.body);
        }
        if (ch.kind === "ok") cardsBackfill = ch.cardsBackfill;
      } else {
        await upsert(pool);
      }
      return reply.send({
        ok:       true,
        key,
        value:    String(numVal),
        tenantId: targetTenantId,
        global:   targetTenantId === null,
        ...(cardsBackfill ? { cardsBackfill } : {}),
      });
    }
  );

  // ── DELETE /api/admin/runtime-config/:key ──────────────────────────────────
  // Remove override do tenant (restaura valor global).
  // zentriz_admin pode remover global se fornecer tenantId=null explicitamente.
  app.delete<{ Params: { key: string }; Querystring: { tenantId?: string } }>(
    "/api/admin/runtime-config/:key",
    async (request, reply) => {
      const user    = getUser(request);
      const { key } = request.params;

      if (user.role !== "zentriz_admin" && user.role !== "tenant_admin") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Sem permissão" });
      }

      // M-03/R2: flags de rollout só o zentriz_admin remove (remover o override do tenant também muda a flag efetiva).
      if (isRolloutFlagKey(key) && user.role !== "zentriz_admin") {
        return reply.status(403).send({ code: "ADMIN_ONLY_KEY", message: `A chave '${key}' só pode ser alterada pelo administrador da plataforma` });
      }

      // zentriz_admin → ?tenantId= se UUID-válido (senão null = global);
      // tenant_admin → sempre o próprio JWT (query ignorada).
      const targetTenantId = resolveScopedTenantId(user, request.query);

      // Nunca deixar deletar os defaults globais via tenant_admin
      if (user.role === "tenant_admin" && targetTenantId === null) {
        return reply.status(403).send({ code: "FORBIDDEN", message: "tenant_admin não pode remover configuração global" });
      }

      const del = (db: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null }> }) => db.query(
        `DELETE FROM genesis_runtime_config WHERE key = $1 AND tenant_id IS NOT DISTINCT FROM $2`,
        [key, targetTenantId],
      );
      let cardsBackfill: CardsBackfillOutcome[] | undefined;
      if (key === "CARDS_BANCADA") {
        // Remover o override também pode ligar a flag (volta ao global/env): mesma trava do PUT (S-01).
        const ch = await changeCardsFlag<number>(targetTenantId, async (c) => {
          const n = (await del(c)).rowCount ?? 0;
          return { proceed: n > 0, result: n };
        });
        if (ch.kind === "skipped") return reply.status(404).send({ code: "NOT_FOUND", message: "Configuração não encontrada" });
        if (ch.kind === "divergence" || ch.kind === "failed") {
          const ref = cardsRefusal(ch);
          return reply.status(ref.status).send(ref.body);
        }
        if (ch.kind === "ok") cardsBackfill = ch.cardsBackfill;
      } else {
        const result = await del(pool);
        if (result.rowCount === 0) {
          return reply.status(404).send({ code: "NOT_FOUND", message: "Configuração não encontrada" });
        }
      }
      return reply.send({ ok: true, key, restored: "global", ...(cardsBackfill ? { cardsBackfill } : {}) });
    }
  );
}
