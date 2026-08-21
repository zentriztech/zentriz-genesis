-- Migration 060: Item 3 (Canva OAuth) — estados efêmeros do fluxo Authorization Code + PKCE.
-- Entre o /authorize e o /callback guardamos o code_verifier (PKCE), o alvo (tenant/label/ator)
-- e o redirect_uri EXATO usado, tudo indexado por um 'state' aleatório e de uso único. O callback
-- valida o state, troca o code por tokens e apaga a linha. Linhas expiram (limpeza best-effort).
--
-- Idempotente (IF NOT EXISTS). Nenhum ';' dentro de literal de string (guard do runner).

CREATE TABLE IF NOT EXISTS canva_oauth_states (
  state           TEXT PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code_verifier   TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  label           TEXT,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_canva_oauth_states_expiry
  ON canva_oauth_states (expires_at);
