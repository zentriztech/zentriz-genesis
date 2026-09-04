-- 089 — Bancada: o job do chat de spec (chat / Resolver GAPs / edicao por-arquivo) NASCE PERSISTIDO.
-- Antes vivia so num Map em memoria da api (specChat.ts _chatJobs): sair da tela matava o poll, o job
-- seguia vivo nos agents e o resultado nascia INALCANCAVEL. Provado em prod 2026-09-04: um job concluiu
-- com 95199 bytes de spec revisada e o trabalho (Opus 5, ~19 min) foi jogado fora.
-- Vocabulario de status IDENTICO ao da memoria (pending/running/done/error) + interrupted (reinicio) e
-- lost (o agente ja descartou o resultado: TTL de 45 min do _async_jobs). Sem 'failed'/'timeout' para
-- nao criar dois vocabularios para o mesmo job.
-- project_id e NULLABLE de proposito: a rota aceita spec sem projeto (fluxo de criacao).
-- owner_user_id e TEXT (nao UUID) porque o sub do JWT nem sempre e UUID (token estatico/watchdog) —
-- mesmo motivo do 082_evolution_plan_jobs.
-- NOTA runner de migrations: split ingenuo por ';' — nenhum ';' em literal, comentarios so em linha
-- propria, sem blocos DO/$$ (por isso updated_at e setado na mao em todo UPDATE).
CREATE TABLE IF NOT EXISTS spec_chat_jobs (
  id             UUID PRIMARY KEY,
  project_id     UUID REFERENCES projects(id) ON DELETE CASCADE,
  tenant_id      UUID,
  owner_user_id  TEXT NOT NULL,
  agents_job_id  TEXT,
  kind           TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat','resolve_gaps','file')),
  file_path      TEXT,
  base_sha       TEXT,
  base_spec_sha  TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','error','interrupted','lost')),
  spec_markdown  TEXT,
  reply          TEXT,
  error          TEXT,
  model_used     TEXT,
  poll_errors    INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  collected_at   TIMESTAMPTZ,
  deadline_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS scj_by_project ON spec_chat_jobs (project_id, created_at DESC);

-- Indice parcial NAO-UNICO: o Jean nao pediu trava de concorrencia — este indice serve ao worker
-- (varre os jobs vivos a cada tick) e ao in-flight, nao para bloquear um segundo disparo.
CREATE INDEX IF NOT EXISTS scj_in_flight ON spec_chat_jobs (project_id, created_at DESC) WHERE status IN ('pending','running');

-- Worker: varredura global dos jobs vivos que tem resultado a coletar nos agents.
CREATE INDEX IF NOT EXISTS scj_worker_scan ON spec_chat_jobs (created_at) WHERE status IN ('pending','running');

-- job_id no historico: (a) torna a coleta IDEMPOTENTE (o worker e/ou N abas podiam inserir a mesma
-- resposta varias vezes — a marca _persisted vivia so em memoria), e (b) desambigua o transcript
-- quando dois jobs rodam em paralelo no mesmo projeto (antes as respostas se intercalavam por
-- created_at e o proximo turno mandava um dialogo contraditorio ao CTO).
ALTER TABLE spec_chat_messages ADD COLUMN IF NOT EXISTS job_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS scm_job_role ON spec_chat_messages (job_id, role) WHERE job_id IS NOT NULL;
