/**
 * uiuxOAuth.ts — callback PÚBLICO do OAuth2 do Canva (Authorization Code + PKCE).
 *
 * É registrado como um plugin SEPARADO de uiuxRoutes: NÃO herda o preHandler de auth,
 * porque o browser volta do Canva sem o Bearer do portal. A segurança vem do `state`:
 * aleatório, de uso único e com TTL curto (tabela canva_oauth_states, migration 060).
 *
 * GET /api/tenant/uiux-connections/canva/callback?code=…&state=…  (ou ?error=…)
 *   1. valida + consome (uso único, atômico) a linha de state;
 *   2. troca o code (+ code_verifier PKCE) por tokens;
 *   3. resolve account_ref (best-effort) e cria a conexão cifrada;
 *   4. redireciona o browser de volta ao portal com ?canva=connected|error.
 *
 * Nunca vaza detalhe de erro na URL (só um slug curto) nem loga tokens/secret.
 */

import type { FastifyInstance } from "fastify";
import { pool } from "../db/client.js";
import {
  exchangeCanvaCode,
  fetchCanvaAccountRef,
  canvaPostAuthUrl,
  isCanvaOAuthConfigured,
} from "../services/uiuxExtract.js";
import { credsFromCanvaToken, createUiuxConnection } from "../services/uiuxAuth.js";

/** Anexa ?canva=<status> à URL de retorno preservando querystring existente. */
function postAuthRedirect(status: "connected" | "error", reason?: string): string {
  const base = canvaPostAuthUrl();
  const sep = base.includes("?") ? "&" : "?";
  const q = new URLSearchParams({ canva: status });
  if (status === "error" && reason) q.set("reason", reason);
  return `${base}${sep}${q.toString()}`;
}

export async function uiuxOAuthRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { code?: string; state?: string; error?: string; error_description?: string };
  }>("/api/tenant/uiux-connections/canva/callback", async (request, reply) => {
    const { code, state, error } = request.query ?? {};

    // Usuário negou o consent (ou o Canva devolveu erro): volta sinalizando erro.
    if (error) return reply.redirect(postAuthRedirect("error", "denied"));
    if (!code || !state) return reply.redirect(postAuthRedirect("error", "missing_params"));
    if (!isCanvaOAuthConfigured()) return reply.redirect(postAuthRedirect("error", "not_configured"));

    // Consome o state de forma ATÔMICA (uso único): DELETE ... RETURNING garante que
    // dois callbacks concorrentes com o mesmo state não passem ambos.
    const claim = await pool.query(
      `DELETE FROM canva_oauth_states
        WHERE state = $1
       RETURNING tenant_id, code_verifier, redirect_uri, label, expires_at`,
      [state],
    );
    const st = claim.rows[0] as
      | { tenant_id: string; code_verifier: string; redirect_uri: string; label: string | null; expires_at: Date }
      | undefined;

    if (!st) return reply.redirect(postAuthRedirect("error", "invalid_state"));
    if (new Date(st.expires_at).getTime() < Date.now()) {
      return reply.redirect(postAuthRedirect("error", "expired_state"));
    }

    try {
      // redirect_uri DEVE ser o mesmo enviado no /authorize (guardado no state).
      const tok = await exchangeCanvaCode(code, st.code_verifier, st.redirect_uri);
      const creds = credsFromCanvaToken(tok);
      const accountRef = await fetchCanvaAccountRef(tok.access_token);
      await createUiuxConnection({
        tenantId: st.tenant_id,
        provider: "canva",
        creds,
        label: st.label,
        accountRef,
      });
      return reply.redirect(postAuthRedirect("connected"));
    } catch (err) {
      const errCode = (err as { code?: string })?.code;
      const reason = errCode === "SLOT_LIMIT" ? "slot_limit" : "exchange_failed";
      request.log.warn({ err: err instanceof Error ? err.message : String(err) }, "canva oauth callback failed");
      return reply.redirect(postAuthRedirect("error", reason));
    }
  });
}
