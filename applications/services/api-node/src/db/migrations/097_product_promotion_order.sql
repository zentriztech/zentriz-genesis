-- 097 — Promover a Fabrica = o PRODUTO TODO, na ORDEM de interdependencia, SEM iniciar.
--
-- Requisito do Jean (2026-09-06): "a fabrica recebi tudo os arquivos e todos os projetos que compoe o
-- produto (...) devemos enviar na ordem de interdependencias (...) e os projetos devem ser promovidos a
-- fabrica mas nao inciados automaticamente".
--
-- Por que um estado NOVO ('promoted') e nao 'queued': o watchdog G39 (services/watchdog.ts) DRENA
-- status='queued' chamando /run sozinho — usar 'queued' como "promovido e parado" faria a fabrica
-- comecar por conta propria, exatamente o que o requisito proibe. 'promoted' e inerte: nenhum laco
-- automatico o adota, so o /run explicito (humano ou o /start do produto) o tira de la.
--
-- A ORDEM e DECISAO (lei do 100% LLM): quem ordena e um agente arquiteto (services/promotionPlanner.ts),
-- e o codigo apenas VETA corrupcao (ciclo, id invalido, ordem incompleta, projeto sem spec). Aresta ja
-- registrada em project_triggers e FATO: entra no grafo efetivo e, se o agente nao a declarou, a
-- divergencia vira warning no plano (nao aborta — o conserto e deterministico por Kahn).
-- O plano fica gravado aqui para a UI mostrar a ordem e o /start disparar so a onda 1.
--
-- NOTA runner de migrations (db/init.ts): split ingenuo por ';' e sem suporte a DO — nenhum ';' dentro
-- de literal ou comentario inline. Idempotencia por DROP CONSTRAINT IF EXISTS + ADD e IF NOT EXISTS.

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;

ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (status IN (
  'draft', 'spec_submitted', 'pending_conversion', 'cto_charter', 'pm_backlog',
  'dev_qa', 'devops', 'running', 'queued', 'stopped', 'completed', 'failed', 'accepted',
  'archived', 'pending_cyborg', 'blocked_cyborg',
  'spec_validation_failed',
  'blocked_structural_gate',
  'blocked_backlog_empty_with_frs',
  'blocked_awaiting_expo_confirm',
  'needs_spec_input',
  'promoted'
));

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_lifecycle_status_check;

ALTER TABLE products ADD CONSTRAINT products_lifecycle_status_check CHECK (lifecycle_status IN (
  'draft','promoted','ingesting','running','partially_accepted','stalled_waiting_human','accepted','failed'
));

-- Plano de promocao: um por produto vivo. `payload` guarda a resposta crua do agente (auditoria do
-- porque da ordem) e `edges_source` diz se havia grafo real (project_triggers) ou se a ordem saiu do
-- desempate por camada decidido pelo agente.
CREATE TABLE IF NOT EXISTS product_promotions (
  id             UUID PRIMARY KEY,
  product_id     UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tenant_id      UUID,
  promoted_by    UUID,
  status         TEXT NOT NULL DEFAULT 'promoted',
  edges_source   TEXT NOT NULL DEFAULT 'agent',
  model_used     TEXT,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  notes          TEXT,
  payload        JSONB,
  started_at     TIMESTAMPTZ,
  canceled_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pprom_status_chk CHECK (status IN ('promoted','started','canceled'))
);

CREATE INDEX IF NOT EXISTS pprom_by_product ON product_promotions(product_id, created_at DESC);

-- Um plano VIVO por produto: dois planos simultaneos disputariam a ordem de disparo.
CREATE UNIQUE INDEX IF NOT EXISTS pprom_one_live ON product_promotions(product_id) WHERE status IN ('promoted','started');

-- Itens do plano: `wave` e a onda (1 = raizes, sem dependencia interna), `position` a ordem DENTRO da
-- onda, `depends_on` os predecessores declarados pelo agente (auditavel contra project_triggers).
CREATE TABLE IF NOT EXISTS product_promotion_items (
  id            UUID PRIMARY KEY,
  promotion_id  UUID NOT NULL REFERENCES product_promotions(id) ON DELETE CASCADE,
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 1,
  wave          INTEGER NOT NULL DEFAULT 1,
  layer         TEXT,
  depends_on    JSONB NOT NULL DEFAULT '[]'::jsonb,
  rationale     TEXT,
  dispatched_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pprom_item_unique ON product_promotion_items(promotion_id, project_id);

CREATE INDEX IF NOT EXISTS pprom_item_order ON product_promotion_items(promotion_id, wave, position);
