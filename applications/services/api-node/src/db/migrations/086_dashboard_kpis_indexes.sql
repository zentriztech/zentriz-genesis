-- 086 — Onda 5 (epico Spec/Bancada): indices para agregacoes do dashboard de KPIs (query-on-read, D5).
-- Fecha o GAP G5 (custo de query): FILTER/percentile_cont por tenant e o top-5 admin sobre
-- project_agent_metrics varriam sem indice. Tabelas pequenas hoje (23 projetos em prod) — sem
-- CONCURRENTLY (o runner roda em transacao no boot; medir o tempo do boot no POS).
-- NOTA runner de migrations: sem ';' em literais, sem blocos DO/$$.
CREATE INDEX IF NOT EXISTS idx_agent_metrics_created ON project_agent_metrics (created_at);
CREATE INDEX IF NOT EXISTS idx_projects_tenant_status ON projects (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_projects_tenant_finished ON projects (tenant_id, finished_at)
  WHERE finished_at IS NOT NULL;
