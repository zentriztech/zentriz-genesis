-- venuxx-v2-github-link.sql
-- Liga os 28 apps do produto "Venuxx V2" (tenant Venuxx em PROD) aos repositórios
-- JÁ EXISTENTES em github.com/venuxxtech (decisão do Jean: apontar para venuxxtech,
-- não criar repos novos). Escreve:
--   1) tenant_github_installations  — 1 linha (installation do App genezis-zentriz-autonomy-app no org venuxxtech)
--   2) project_github_repos         — 26 linhas (title do projeto → repo venuxxtech)
--
-- Os 2 apps sem repo no venuxxtech (infra-terraform, connect-e2e; ambos 'completed',
-- não 'accepted') ficam SEM vínculo de propósito — o Auto Care caminho A não os ativa.
-- autonomy-cli mora dentro do orquestrador → aponta para venuxx-api-orchestrator.
--
-- installation_id: passar via -v inst_id=<N>. Antes do Jean instalar o App no venuxxtech,
-- use o placeholder 129756252 (o install do genezis-factory) SÓ para o dry-run validar
-- a estrutura; o COMMIT real usa o installation_id verdadeiro do venuxxtech.
--
-- Execução (dentro do container zentriz-genesis-postgres-1 em PROD):
--   DRY-RUN (nada é gravado):
--     psql -U genesis -d zentriz_genesis -v ON_ERROR_STOP=1 -v inst_id=<N> \
--          -c 'BEGIN' -f venuxx-v2-github-link.sql -c 'ROLLBACK'
--   COMMIT (persiste):
--     psql -U genesis -d zentriz_genesis -v ON_ERROR_STOP=1 -v inst_id=<N> \
--          -c 'BEGIN' -f venuxx-v2-github-link.sql -c 'COMMIT'
--   ROLLBACK/limpeza (remove os vínculos criados por este script):
--     ver bloco comentado ao final.

\set tenant_id  '0931c5dc-46eb-474a-a54a-dad12733b4b2'
\set system_id  'venuxx-v2'

-- ── 1) tenant_github_installations (org venuxxtech) ──────────────────────────
INSERT INTO tenant_github_installations
  (tenant_id, installation_id, github_login, installation_type, repos_authorized, scope_genesis, scope_deadpool)
VALUES
  (:'tenant_id', :inst_id, 'venuxxtech', 'Organization', 'all', true, true)
ON CONFLICT (tenant_id) DO UPDATE SET
  installation_id   = EXCLUDED.installation_id,
  github_login      = EXCLUDED.github_login,
  installation_type = EXCLUDED.installation_type,
  repos_authorized  = 'all',
  scope_genesis     = true,
  scope_deadpool    = true,
  revoked_at        = NULL;

-- ── 2) project_github_repos (title do projeto → repo venuxxtech) ─────────────
-- default_branch reflete o branch real do repo (lambdas/packages/portal = main;
-- identity/tax/tms/maya = dev; orquestrador = main).
INSERT INTO project_github_repos
  (project_id, repo_name, repo_full_name, repo_url, clone_url, default_branch, pushed_at)
SELECT
  p.id,
  m.repo_name,
  'venuxxtech/' || m.repo_name,
  'https://github.com/venuxxtech/' || m.repo_name,
  'https://github.com/venuxxtech/' || m.repo_name || '.git',
  m.branch,
  now()
FROM (VALUES
  ('logistics-ingest',              'venuxx-lbd-logistics-ingest',              'main'),
  ('logistics-admin-api',           'venuxx-lbd-logistics-admin-api',           'main'),
  ('logistics-webhook',             'venuxx-lbd-logistics-webhook',             'main'),
  ('logistics-dlq-admin',           'venuxx-lbd-logistics-dlq-admin',           'main'),
  ('logistics-test-webhook-sink',   'venuxx-lbd-logistics-test-webhook-sink',   'main'),
  ('logistics-normalizer',          'venuxx-lbd-logistics-normalizer',          'main'),
  ('logistics-dlq-consumer',        'venuxx-lbd-logistics-dlq-consumer',        'main'),
  ('logistics-outbox-publisher',    'venuxx-lbd-logistics-outbox-publisher',    'main'),
  ('logistics-outbound-dispatcher', 'venuxx-lbd-logistics-outbound-dispatcher', 'main'),
  ('logistics-dsl-ai-service',      'venuxx-lbd-logistics-dsl-ai-service',      'main'),
  ('logistics-infra',               'venuxx-lbd-logistics-infra',               'main'),
  ('core',                          'venuxx-pkg-core',                          'main'),
  ('database-drizzle',              'venuxx-pkg-database-drizzle',              'main'),
  ('database-logistics',            'venuxx-pkg-database-logistics',            'main'),
  ('dynamodb',                      'venuxx-pkg-dynamodb',                      'main'),
  ('logistics-raw',                 'venuxx-pkg-logistics-raw',                 'main'),
  ('template-engine',               'venuxx-pkg-template-engine',               'main'),
  ('rabbitmq',                      'venuxx-pkg-rabbitmq',                      'main'),
  ('infrastructure',                'venuxx-pkg-infrastructure',                'main'),
  ('logistics-seed',                'venuxx-pkg-logistics-seed',                'main'),
  ('portal',                        'venuxx-logistics-portal',                  'main'),
  ('autonomy-cli',                  'venuxx-api-orchestrator',                  'main'),
  ('identity',                      'venuxx-identity',                          'dev'),
  ('tax',                           'venuxx-tax',                               'dev'),
  ('tms',                           'venuxx-tms',                               'dev'),
  ('maya',                          'venuxx-maya',                              'dev')
) AS m(title, repo_name, branch)
JOIN products pr
  ON pr.tenant_id = :'tenant_id' AND lower(pr.system_id) = :'system_id'
JOIN projects p
  ON p.tenant_id = :'tenant_id' AND p.product_id = pr.id AND p.title = m.title
ON CONFLICT (project_id) DO UPDATE SET
  repo_name      = EXCLUDED.repo_name,
  repo_full_name = EXCLUDED.repo_full_name,
  repo_url       = EXCLUDED.repo_url,
  clone_url      = EXCLUDED.clone_url,
  default_branch = EXCLUDED.default_branch,
  pushed_at      = now();

-- ── Verificação (aparece tanto no dry-run quanto no commit) ──────────────────
-- Esperado: installations_venuxx = 1 ; repos_linkados = 26 ; unmatched = 0
SELECT
  (SELECT count(*) FROM tenant_github_installations WHERE tenant_id = :'tenant_id' AND github_login = 'venuxxtech') AS installations_venuxx,
  (SELECT count(*) FROM project_github_repos gr
     JOIN projects p ON p.id = gr.project_id
     JOIN products pr ON pr.id = p.product_id
    WHERE p.tenant_id = :'tenant_id' AND lower(pr.system_id) = :'system_id') AS repos_linkados;

-- Apps do produto que ficaram SEM repo (esperado: infra-terraform, connect-e2e):
SELECT p.title AS apps_sem_repo
FROM projects p
JOIN products pr ON pr.id = p.product_id
LEFT JOIN project_github_repos gr ON gr.project_id = p.id
WHERE p.tenant_id = :'tenant_id' AND lower(pr.system_id) = :'system_id' AND gr.project_id IS NULL
ORDER BY p.title;

-- ── Limpeza/rollback manual (NÃO executa por padrão) ─────────────────────────
-- DELETE FROM project_github_repos gr
--   USING projects p, products pr
--  WHERE gr.project_id = p.id AND p.product_id = pr.id
--    AND p.tenant_id = '0931c5dc-46eb-474a-a54a-dad12733b4b2' AND lower(pr.system_id) = 'venuxx-v2';
-- DELETE FROM tenant_github_installations WHERE tenant_id = '0931c5dc-46eb-474a-a54a-dad12733b4b2';
