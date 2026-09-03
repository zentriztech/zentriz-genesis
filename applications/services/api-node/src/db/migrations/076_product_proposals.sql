-- 076 — RFC-0004 pendencia T1.6b: propostas do Splitter NASCEM persistidas.
--
-- O job de /api/products/propose (e /api/projects/:id/decompose) vivia num Map em memoria
-- (products.ts _proposeJobs) que morre em TODO deploy/restart — a proposta some no meio do
-- poll do portal (mesmo furo que a migration 074 fechou p/ validacao de spec). Aqui a
-- proposta nasce persistida: o portal faz poll em GET /api/products/propose/:jobId (o jobId
-- E o id desta linha, UUID); o reaper de boot marca 'running'/'pending' orfao como
-- 'interrupted'; o watchdog aplica deadline_at; ingest-proposal (com proposalId) le o
-- payload autoritativo daqui e marca consumed_at na MESMA transacao do decompose.
--
-- payload guarda a proposta pronta (manifest+specs+waves+projects+warnings) so quando
-- status='done'; e limpo (NULL) no consumo e por expiracao (purge >7d). consumed_at/
-- consumed_product_id sao COLUNAS, nao status: uma proposta 'done' consumida continua 'done'
-- (idempotencia do ingest, nao um estado terminal novo no CHECK).
-- NOTA runner de migrations: sem ';' em literais, sem blocos DO/$$.

CREATE TABLE IF NOT EXISTS product_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  created_by UUID,
  origin_project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'running', 'done', 'error', 'interrupted'
  )),
  document TEXT,
  model_id TEXT,
  agents_job_id TEXT,
  payload JSONB,
  warnings JSONB NOT NULL DEFAULT '[]',
  error TEXT,
  consumed_at TIMESTAMPTZ,
  consumed_product_id UUID,
  deadline_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- listagem/scan por tenant (dono da proposta)
CREATE INDEX IF NOT EXISTS pp_by_tenant ON product_proposals (tenant_id, created_at DESC);

-- one-flight por spec de origem: 2 cliques em "Decompor" na mesma spec = 1 proposta viva.
-- (idea-mode nao tem origin_project_id -> nao entra no indice; rate-limit cobre esse lado.)
CREATE UNIQUE INDEX IF NOT EXISTS pp_one_flight_origin
  ON product_proposals (origin_project_id)
  WHERE status IN ('pending', 'running') AND origin_project_id IS NOT NULL;

-- scan barato do reaper de boot + tick de deadline (so as em voo)
CREATE INDEX IF NOT EXISTS pp_inflight ON product_proposals (status, deadline_at)
  WHERE status IN ('pending', 'running');

-- purge de payload antigo (libera JSONB grande de propostas velhas nao consumidas)
CREATE INDEX IF NOT EXISTS pp_purge ON product_proposals (created_at)
  WHERE payload IS NOT NULL;
