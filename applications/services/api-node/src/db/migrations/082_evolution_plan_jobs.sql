-- 082 — Evoluir bloco 2 (H3): jobs do planner de RFC/ADR/CHANGELOG (Bancada › Gerar RFC) NASCEM persistidos.
-- Antes viviam num Map em memoria (evolutionPlanner.ts _jobs) que morre em todo restart — o poll do portal
-- caia em 404 no meio do planejamento. Padrao da migration 076 (product_proposals): status terminal com causa
-- ('interrupted' = reinicio do servidor, nunca "retomar" um job nao idempotente), reaper de boot, 1 job vivo
-- por projeto via indice unico parcial (idempotencia entre replicas, nao lock em memoria).
-- NOTA runner de migrations: sem ';' em literais, sem blocos DO/$$.
CREATE TABLE IF NOT EXISTS evolution_plan_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','error','interrupted')),
  request       TEXT,
  result        JSONB,
  error         TEXT,
  model_used    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS epj_by_project ON evolution_plan_jobs (project_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS epj_one_flight ON evolution_plan_jobs (project_id) WHERE status IN ('pending','running');
