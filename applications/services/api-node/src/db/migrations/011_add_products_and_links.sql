-- Migration 011: Products (grupos de projetos) + Project Links (relações entre projetos)
-- Opção 3: produto como container + links diretos entre projetos com tipo de relação

-- ── Tabela products ────────────────────────────────────────────────────────────
-- Um produto agrupa projetos relacionados (backend, frontend, mobile, etc.)
-- do mesmo sistema/produto de negócio.
CREATE TABLE IF NOT EXISTS products (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by  UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);

-- ── product_id em projects ─────────────────────────────────────────────────────
-- Projetos podem pertencer a um produto (opcional — projetos standalone continuam funcionando)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES products(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_projects_product ON projects(product_id) WHERE product_id IS NOT NULL;

-- ── Tabela project_links ───────────────────────────────────────────────────────
-- Relações diretas entre projetos com tipo semântico.
-- Exemplos: frontend "uses_backend" backend; mobile "shares_auth" auth_service
CREATE TABLE IF NOT EXISTS project_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  to_project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  relation_type   TEXT NOT NULL DEFAULT 'related',
  -- relation_type values:
  --   uses_backend   — frontend/mobile que consome uma API backend
  --   shares_auth    — compartilha serviço de autenticação
  --   shares_db      — compartilha banco de dados
  --   depends_on     — dependência genérica
  --   related        — relacionado (sem semântica específica)
  --   part_of        — componente de um sistema maior
  note            TEXT,        -- observação opcional sobre a relação
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_links_no_self    CHECK (from_project_id <> to_project_id),
  CONSTRAINT project_links_unique     UNIQUE (from_project_id, to_project_id)
);

CREATE INDEX IF NOT EXISTS idx_project_links_from ON project_links(from_project_id);
CREATE INDEX IF NOT EXISTS idx_project_links_to   ON project_links(to_project_id);

COMMENT ON TABLE products       IS 'Grupos de projetos relacionados (um produto de negócio pode ter backend + frontend + mobile)';
COMMENT ON TABLE project_links  IS 'Relações semânticas diretas entre projetos (ex: frontend uses_backend api)';
COMMENT ON COLUMN project_links.relation_type IS 'uses_backend | shares_auth | shares_db | depends_on | related | part_of';
