-- 130 — reforma comercial dos planos (pedido do Jean, 2026-09-24): renomeia e reprecifica
-- os 3 planos existentes (Prata/Ouro/Diamante -> Nucleo/Portfolio/Operacao, mesmos IDs para
-- nao quebrar o FK tenants.plan_id) e adiciona o 4o plano "Fabrica" (sem preco fixo).
-- `tagline` = frase curta de posicionamento (ex.: "primeira frente"). `monthly_price_cents`
-- vira NULLABLE: NULL agora significa "sob consulta" (distinto de 0 = gratuito/a definir).
-- DECISAO EXPLICITA DO JEAN: reprecificar os planos EXISTENTES afeta a cobranca real dos
-- tenants hoje ativos no Ouro/Diamante no proximo generate-month (nao e so cosmetico).
-- NOTA runner de migrations: sem ';' em literais, sem blocos DO/$$.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS tagline TEXT;
ALTER TABLE plans ALTER COLUMN monthly_price_cents DROP NOT NULL;

UPDATE plans SET name = 'Núcleo', slug = 'nucleo', tagline = 'primeira frente', max_projects = 25, monthly_price_cents = 29900000 WHERE id = 'plan_prata';
UPDATE plans SET name = 'Portfólio', slug = 'portfolio', tagline = 'frentes em paralelo', max_projects = 50, monthly_price_cents = 49400000 WHERE id = 'plan_ouro';
UPDATE plans SET name = 'Operação', slug = 'operacao', tagline = 'engenharia inteira', max_projects = 100, monthly_price_cents = 100000000 WHERE id = 'plan_diamante';

INSERT INTO plans (id, name, slug, tagline, max_projects, max_users_per_tenant, monthly_price_cents) VALUES
  ('plan_fabrica', 'Fábrica', 'fabrica', 'mais de uma operação', 100, 500, NULL)
ON CONFLICT (id) DO NOTHING;
