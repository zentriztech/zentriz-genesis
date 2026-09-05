-- 090 — Bancada: MODO AUTONOMO do CTO (laco recursivo Resolver GAPs -> Salvar -> Validar, ate 5 rodadas).
-- Pedido do Jean (2026-09-05): o CTO entra em modo recursivo, REGISTRANDO acoes, e repete o ciclo
-- enquanto a validacao devolver GAPs vermelhos (blocker) ou amarelos (warning) ATIVOS — 'info' nunca
-- sustenta mais uma rodada (e o "baixo risco" do pedido).
-- Estado 100% no Postgres: o laco e avancado pelo tick de 20 s do specChatWorker, entao um restart da
-- api no meio de uma rodada NAO perde o laco (o job do CTO ja era duravel desde a migracao 089).
-- rounds JSONB = LOG DE ACOES por rodada (o "registrando acoes"): job do CTO, run de validacao,
-- GAPs antes/depois, se aplicou no disco, e o motivo quando nao aplicou.
-- NOTA runner de migrations: split ingenuo por ';' — nenhum ';' em literal, comentarios so em linha
-- propria, sem blocos DO/$$ (por isso updated_at e setado na mao em todo UPDATE).
CREATE TABLE IF NOT EXISTS spec_autonomy_runs (
  id                 UUID PRIMARY KEY,
  project_id         UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tenant_id          UUID,
  owner_user_id      TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cto_running','applying','validating','succeeded','exhausted','stalled','failed','stopped')),
  round              INTEGER NOT NULL DEFAULT 0,
  max_rounds         INTEGER NOT NULL DEFAULT 5,
  chat_job_id        UUID,
  validation_run_id  UUID,
  base_spec_sha      TEXT,
  gaps_initial       INTEGER,
  gaps_current       INTEGER,
  no_progress_streak INTEGER NOT NULL DEFAULT 0,
  rounds             JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_error         TEXT,
  deadline_at        TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ
);

-- UNICO parcial: um laco ativo por projeto. Dois laços no mesmo projeto = dois CTOs escrevendo o
-- MESMO arquivo de spec (perda de dados garantida) — a trava e no banco, nao na intencao do frontend.
CREATE UNIQUE INDEX IF NOT EXISTS sar_one_active_per_project ON spec_autonomy_runs (project_id) WHERE status IN ('pending','cto_running','applying','validating');

-- Varredura do worker: so as runs vivas, mais antiga primeiro (justica entre projetos).
CREATE INDEX IF NOT EXISTS sar_worker_scan ON spec_autonomy_runs (updated_at) WHERE status IN ('pending','cto_running','applying','validating');

CREATE INDEX IF NOT EXISTS sar_by_project ON spec_autonomy_runs (project_id, created_at DESC);
