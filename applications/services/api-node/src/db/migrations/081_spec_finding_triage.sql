-- 081 — RFC-0005: controle de GAPs por finding (Ativos | Ignorados | Resolvidos | Refutados).
-- Uma linha por decisão humana VIVA sobre um finding identificado por fingerprint determinístico
-- (file|source|category|anchor). "Resolvido" NÃO é coluna: é derivado comparando runs.
-- Histórico preservado por revoked_at (nunca DELETE). Regra do runner: nenhum ';' em string literal.
CREATE TABLE IF NOT EXISTS spec_finding_triage (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint       TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('ignored','refuted')),
  reason_code       TEXT NOT NULL CHECK (reason_code IN ('accepted_risk','out_of_scope','will_fix_later','by_design','mitigated','duplicate','false_positive')),
  reason            TEXT NOT NULL DEFAULT '',
  severity_at       TEXT NOT NULL,
  finding_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
  spec_hash_at      TEXT NOT NULL DEFAULT '',
  actor_user_id     UUID,
  actor_role        TEXT NOT NULL,
  expires_at        TIMESTAMPTZ,
  inherited_from    UUID,
  recurrence_count  INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at        TIMESTAMPTZ,
  revoked_by        UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_finding_triage_live ON spec_finding_triage (project_id, fingerprint) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_finding_triage_project ON spec_finding_triage (project_id, created_at DESC);
