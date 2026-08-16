-- 049_zfactory_and_email_per_role.sql
-- Zentriz Genesis — identidade Zentriz e tenant modelo.
--   1) Master admin@zentriz.com  -> jean@zentriz.com.br (role zentriz_admin, sem tenant)
--   2) Tenant "Tenant Demo"       -> "ZFactory" (tenant modelo da Zentriz)
--   3) admin@tenant.com / user@tenant.com -> jean@zentriz.com.br (por papel)
--   4) Unicidade de e-mail deixa de ser global e passa a ser POR PAPEL (email, role),
--      permitindo o mesmo e-mail jean@zentriz.com.br nos tres papeis de teste.
-- Runner (db/init.ts): split ingenuo por ';' — NENHUM literal abaixo contem ';'.
-- Statements idempotentes: os UPDATEs viram no-op apos a primeira aplicacao.

-- 1) Remove a unicidade global de e-mail (constraint inline da migration 001)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;

-- 2) Renomeia as contas da Zentriz para o e-mail unico jean@zentriz.com.br (por papel)
UPDATE users SET email = 'jean@zentriz.com.br' WHERE email = 'admin@zentriz.com' AND role = 'zentriz_admin';
UPDATE users SET email = 'jean@zentriz.com.br' WHERE email = 'admin@tenant.com' AND role = 'tenant_admin';
UPDATE users SET email = 'jean@zentriz.com.br' WHERE email = 'user@tenant.com' AND role = 'user';

-- 3) Renomeia o tenant modelo
UPDATE tenants SET name = 'ZFactory' WHERE name = 'Tenant Demo';

-- 4) Nova unicidade composta (email, role) — permite o mesmo e-mail em papeis distintos
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_role_key;
ALTER TABLE users ADD CONSTRAINT users_email_role_key UNIQUE (email, role);
