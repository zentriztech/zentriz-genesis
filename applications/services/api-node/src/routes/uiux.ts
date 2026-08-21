/**
 * uiux.ts — Item 3: conexões a Ferramentas UI/UX (Figma/Canva) por tenant, multi-slot.
 * Espelha o padrão de cloud.ts (slots + credenciais AES-256-GCM + escopo por tenant).
 *
 * GET    /api/tenant/uiux-connections            — listar slots ativos
 * POST   /api/tenant/uiux-connections            — adicionar slot
 * PUT    /api/tenant/uiux-connections/:id         — editar slot
 * DELETE /api/tenant/uiux-connections/:id         — remover slot (soft) + recompactar
 * POST   /api/tenant/uiux-connections/reorder     — trocar posições
 * POST   /api/tenant/uiux-connections/:id/test    — validar credenciais
 * GET    /api/tenant/uiux-connections/:id/projects — listar projetos da conta (proxy)
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client.js";
import { authMiddleware, type AuthUser } from "../middleware/auth.js";
import { encryptCredentials, decryptCredentials } from "../services/crypto.js";
import { resolveScopedTenantId } from "../lib/tenantScope.js";
import {
  listProjectsForConnection,
  UIUX_REQUIRED_KEY,
  isCanvaOAuthConfigured,
  canvaRedirectUri,
  buildCanvaAuthorizeUrl,
  generatePkcePair,
  generateOAuthState,
  type UiuxProvider,
  type UiuxCredentials,
} from "../services/uiuxExtract.js";
import { ensureFreshUiuxCreds } from "../services/uiuxAuth.js";

function getUser(req: FastifyRequest): AuthUser {
  return (req as unknown as { user: AuthUser }).user;
}

const MAX_SLOTS = 6;

const ALLOWED_KEYS: Record<UiuxProvider, string[]> = {
  figma: ["accessToken", "teamId"],
  canva: ["accessToken", "refreshToken"],
};

const REQUIRED_KEYS: Record<UiuxProvider, string[]> = {
  figma: ["accessToken"],
  canva: ["accessToken"],
};

function isProvider(p: unknown): p is UiuxProvider {
  return p === "figma" || p === "canva";
}

function sanitize(provider: UiuxProvider, raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ALLOWED_KEYS[provider]) {
    if (typeof raw[key] === "string" && raw[key].trim()) out[key] = raw[key].trim();
  }
  return out;
}

function formatRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label ?? null,
    accountRef: row.account_ref ?? null,
    slotIndex: Number(row.slot_index ?? 0),
    status: row.status,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

async function recompactSlots(
  client: { query: (sql: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  tenantId: string,
) {
  const rows = await client.query(
    `SELECT id FROM tenant_uiux_connections
     WHERE tenant_id = $1 AND status = 'active'
     ORDER BY slot_index ASC, created_at ASC`,
    [tenantId],
  );
  for (let i = 0; i < rows.rows.length; i++) {
    await client.query(`UPDATE tenant_uiux_connections SET slot_index = $1 WHERE id = $2`, [i, rows.rows[i].id]);
  }
}

function decryptCreds(row: Record<string, unknown>): UiuxCredentials {
  return JSON.parse(
    decryptCredentials({
      encrypted: row.encrypted_credentials as string,
      iv: row.encryption_iv as string,
      tag: row.encryption_tag as string,
    }),
  ) as UiuxCredentials;
}

export async function uiuxRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authMiddleware);

  // ── GET listar ──────────────────────────────────────────────────────────────
  app.get("/api/tenant/uiux-connections", async (request, reply) => {
    const user = getUser(request);
    const scopedTenantId = resolveScopedTenantId(user, request.query);
    if (!scopedTenantId) return reply.send([]);
    const res = await pool.query(
      `SELECT id, provider, label, account_ref, slot_index, status, created_at
       FROM tenant_uiux_connections
       WHERE tenant_id = $1 AND status = 'active'
       ORDER BY slot_index ASC`,
      [scopedTenantId],
    );
    return reply.send(res.rows.map(formatRow));
  });

  // ── POST adicionar ────────────────────────────────────────────────────────────
  app.post<{ Body: { provider: UiuxProvider; credentials: Record<string, string>; label?: string; accountRef?: string } }>(
    "/api/tenant/uiux-connections",
    async (request, reply) => {
      const user = getUser(request);
      if (user.role !== "tenant_admin" && user.role !== "zentriz_admin") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Requer role tenant_admin" });
      }
      const tenantId = resolveScopedTenantId(user, request.query, request.body);
      if (!tenantId) return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant obrigatório" });

      const { provider, credentials, label, accountRef } = request.body ?? {};
      if (!isProvider(provider)) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: "provider deve ser figma ou canva" });
      }
      const sanitized = sanitize(provider, credentials ?? {});
      const missing = REQUIRED_KEYS[provider].filter((k) => !sanitized[k]);
      if (missing.length) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: `Campos obrigatórios: ${missing.join(", ")}` });
      }

      const countRes = await pool.query(
        "SELECT COUNT(*) FROM tenant_uiux_connections WHERE tenant_id = $1 AND status = 'active'",
        [tenantId],
      );
      if (Number(countRes.rows[0].count) >= MAX_SLOTS) {
        return reply.status(400).send({ code: "BAD_REQUEST", message: `Máximo de ${MAX_SLOTS} conexões atingido` });
      }

      const maxRes = await pool.query(
        "SELECT COALESCE(MAX(slot_index), -1) AS max FROM tenant_uiux_connections WHERE tenant_id = $1 AND status = 'active'",
        [tenantId],
      );
      const nextSlot = Number(maxRes.rows[0].max) + 1;

      // account_ref: teamId (figma) para listagem de projetos.
      const accRef = (accountRef ?? sanitized.teamId ?? "").trim() || null;
      const { encrypted, iv, tag } = encryptCredentials(JSON.stringify(sanitized));

      const ins = await pool.query(
        `INSERT INTO tenant_uiux_connections
           (tenant_id, provider, label, account_ref, slot_index,
            encrypted_credentials, encryption_iv, encryption_tag, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')
         RETURNING id, slot_index`,
        [tenantId, provider, label ?? null, accRef, nextSlot, encrypted, iv, tag],
      );
      return reply.status(201).send({
        ok: true,
        id: ins.rows[0].id,
        slotIndex: ins.rows[0].slot_index,
        message: "Conexão salva com segurança",
      });
    },
  );

  // ── PUT editar ──────────────────────────────────────────────────────────────
  app.put<{
    Params: { id: string };
    Body: { provider?: UiuxProvider; credentials?: Record<string, string>; label?: string; accountRef?: string };
  }>("/api/tenant/uiux-connections/:id", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "tenant_admin" && user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Requer role tenant_admin" });
    }
    const scopedTenantId = resolveScopedTenantId(user, request.query, request.body);
    if (!scopedTenantId) return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant obrigatório" });
    const { id } = request.params;
    const { provider, credentials, label, accountRef } = request.body ?? {};
    if (provider !== undefined && !isProvider(provider)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "provider deve ser figma ou canva" });
    }

    const existing = await pool.query(
      "SELECT * FROM tenant_uiux_connections WHERE id = $1 AND tenant_id = $2",
      [id, scopedTenantId],
    );
    if (!existing.rows.length) return reply.status(404).send({ code: "NOT_FOUND" });

    const row = existing.rows[0] as Record<string, unknown>;
    const prov = (provider ?? row.provider) as UiuxProvider;
    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [];
    let p = 1;

    if (label !== undefined) { sets.push(`label = $${p++}`); params.push(label); }
    if (accountRef !== undefined) { sets.push(`account_ref = $${p++}`); params.push(accountRef || null); }
    if (provider) { sets.push(`provider = $${p++}`); params.push(provider); }

    if (credentials && Object.keys(credentials).length > 0) {
      let existingCreds: Record<string, string> = {};
      try {
        existingCreds = decryptCreds(row) as unknown as Record<string, string>;
      } catch { /* usa vazio */ }
      const merged = { ...existingCreds, ...sanitize(prov, credentials) };
      const { encrypted, iv, tag } = encryptCredentials(JSON.stringify(merged));
      sets.push(`encrypted_credentials = $${p++}`); params.push(encrypted);
      sets.push(`encryption_iv = $${p++}`); params.push(iv);
      sets.push(`encryption_tag = $${p++}`); params.push(tag);
    }

    params.push(id);
    await pool.query(`UPDATE tenant_uiux_connections SET ${sets.join(", ")} WHERE id = $${p}`, params);
    return reply.send({ ok: true });
  });

  // ── DELETE ────────────────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>("/api/tenant/uiux-connections/:id", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "tenant_admin" && user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Requer role tenant_admin" });
    }
    const scopedTenantId = resolveScopedTenantId(user, request.query);
    if (!scopedTenantId) return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant obrigatório" });
    const { id } = request.params;
    const client = await pool.connect();
    try {
      await client.query(
        "UPDATE tenant_uiux_connections SET status='revoked', updated_at=now() WHERE id=$1 AND tenant_id=$2",
        [id, scopedTenantId],
      );
      await recompactSlots(client as Parameters<typeof recompactSlots>[0], scopedTenantId);
      return reply.send({ ok: true });
    } finally {
      client.release();
    }
  });

  // ── POST reorder ────────────────────────────────────────────────────────────
  app.post<{ Body: { idA: string; idB: string } }>(
    "/api/tenant/uiux-connections/reorder",
    async (request, reply) => {
      const user = getUser(request);
      if (user.role !== "tenant_admin" && user.role !== "zentriz_admin") {
        return reply.status(403).send({ code: "FORBIDDEN", message: "Requer role tenant_admin" });
      }
      const scopedTenantId = resolveScopedTenantId(user, request.query, request.body);
      if (!scopedTenantId) return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant obrigatório" });
      const { idA, idB } = request.body ?? {};
      const client = await pool.connect();
      try {
        const rows = await client.query(
          "SELECT id, slot_index FROM tenant_uiux_connections WHERE id = ANY($1) AND tenant_id = $2",
          [[idA, idB], scopedTenantId],
        );
        if (rows.rows.length !== 2) return reply.status(400).send({ code: "BAD_REQUEST", message: "IDs inválidos" });
        const [r1, r2] = rows.rows as { id: string; slot_index: number }[];
        await client.query("UPDATE tenant_uiux_connections SET slot_index = 99 WHERE id = $1", [r1.id]);
        await client.query("UPDATE tenant_uiux_connections SET slot_index = $1 WHERE id = $2", [r1.slot_index, r2.id]);
        await client.query("UPDATE tenant_uiux_connections SET slot_index = $1 WHERE id = $2", [r2.slot_index, r1.id]);
        return reply.send({ ok: true });
      } finally {
        client.release();
      }
    },
  );

  // ── POST test ─────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/tenant/uiux-connections/:id/test", async (request, reply) => {
    const user = getUser(request);
    // Ação de gestão (tela admin-only) → consistente com POST/PUT/DELETE/reorder/authorize.
    if (user.role !== "tenant_admin" && user.role !== "zentriz_admin") {
      return reply.status(403).send({ ok: false, message: "Requer role tenant_admin" });
    }
    const scopedTenantId = resolveScopedTenantId(user, request.query);
    if (!scopedTenantId) return reply.status(400).send({ ok: false, message: "Sem tenant" });
    const { id } = request.params;
    const res = await pool.query(
      "SELECT id, provider, encrypted_credentials, encryption_iv, encryption_tag FROM tenant_uiux_connections WHERE id=$1 AND tenant_id=$2 AND status='active'",
      [id, scopedTenantId],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (!row) return reply.send({ ok: false, message: "Conexão não encontrada" });
    const prov = row.provider as UiuxProvider;
    try {
      // Para Canva, renova o token se necessário (e persiste) → reporta a saúde REAL, não só a
      // presença do campo (um token expirado/revogado não deve aparecer como "ok").
      const creds = await ensureFreshUiuxCreds(row);
      const ok = Boolean(creds[UIUX_REQUIRED_KEY[prov]]);
      return reply.send({ ok, provider: prov, message: ok ? "Credenciais válidas" : "Credenciais incompletas" });
    } catch {
      return reply.send({ ok: false, provider: prov, message: "Falha ao validar credenciais (token pode ter expirado)" });
    }
  });

  // ── GET config do OAuth do Canva (a UI decide entre OAuth 1-clique x token manual) ──
  app.get("/api/tenant/uiux-connections/canva/config", async (_request, reply) => {
    return reply.send({ configured: isCanvaOAuthConfigured() && Boolean(canvaRedirectUri()) });
  });

  // ── GET authorize (inicia OAuth2+PKCE do Canva; devolve a URL de autorização) ─────
  app.get("/api/tenant/uiux-connections/canva/authorize", async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "tenant_admin" && user.role !== "zentriz_admin") {
      return reply.status(403).send({ code: "FORBIDDEN", message: "Requer role tenant_admin" });
    }
    const tenantId = resolveScopedTenantId(user, request.query);
    if (!tenantId) return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant obrigatório" });

    const redirectUri = canvaRedirectUri();
    if (!isCanvaOAuthConfigured() || !redirectUri) {
      return reply.status(501).send({
        code: "CANVA_OAUTH_NOT_CONFIGURED",
        message: "App OAuth do Canva não configurado. Configure CANVA_CLIENT_ID/SECRET e CANVA_REDIRECT_URI.",
      });
    }

    const label = typeof (request.query as Record<string, unknown>)?.label === "string"
      ? String((request.query as Record<string, string>).label).slice(0, 120)
      : null;

    const { verifier, challenge } = generatePkcePair();
    const state = generateOAuthState();

    // Limpeza best-effort de estados vencidos + grava o novo (uso único, 10 min).
    await pool.query("DELETE FROM canva_oauth_states WHERE expires_at < now()");
    await pool.query(
      `INSERT INTO canva_oauth_states (state, tenant_id, code_verifier, redirect_uri, label, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + INTERVAL '10 minutes')`,
      [state, tenantId, verifier, redirectUri, label, user.id ?? null],
    );

    const authorizeUrl = buildCanvaAuthorizeUrl({ state, codeChallenge: challenge, redirectUri });
    return reply.send({ authorizeUrl });
  });

  // ── GET projetos da conta (proxy Figma/Canva) ───────────────────────────────
  app.get<{ Params: { id: string } }>("/api/tenant/uiux-connections/:id/projects", async (request, reply) => {
    const user = getUser(request);
    const scopedTenantId = resolveScopedTenantId(user, request.query);
    if (!scopedTenantId) return reply.status(403).send({ code: "FORBIDDEN", message: "Tenant obrigatório" });
    const { id } = request.params;
    const res = await pool.query(
      "SELECT id, provider, account_ref, encrypted_credentials, encryption_iv, encryption_tag FROM tenant_uiux_connections WHERE id=$1 AND tenant_id=$2 AND status='active'",
      [id, scopedTenantId],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (!row) return reply.status(404).send({ code: "NOT_FOUND" });
    try {
      // Canva: renova o access token (e persiste) antes de listar, se necessário.
      const creds = await ensureFreshUiuxCreds(row);
      const projects = await listProjectsForConnection(
        row.provider as UiuxProvider,
        creds,
        (row.account_ref as string | null) ?? null,
      );
      // Array puro (convenção de listagem; o form de spec consome direto).
      return reply.send(projects);
    } catch (err) {
      return reply.status(502).send({ code: "UPSTREAM_ERROR", message: err instanceof Error ? err.message : "Falha ao listar projetos" });
    }
  });
}
