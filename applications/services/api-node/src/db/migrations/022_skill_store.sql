-- Migration 022: Skill Store dinâmico para agentes Dev/QA/PM/DevOps
-- Substitui SYSTEM_PROMPTs estáticos por fragmentos atômicos com cache, TTL e
-- acquisition via LLM. hard_rule=true é imune a TTL e nunca regenerado por LLM.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tabela principal: skill
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identidade
  slug             TEXT        NOT NULL,
  -- ex: "python.fastapi.asyncpg.enum-native", "react-native.no-expo"
  role             TEXT        NOT NULL,
  -- dev | qa | pm | devops | engineer | cto | cyborg
  category         TEXT        NOT NULL DEFAULT 'stack',
  -- stack | domain | pattern | antipattern | contract | hard_rule
  stack_key        TEXT        NOT NULL DEFAULT 'generic',
  -- normalizado: "python-fastapi", "nodejs-express", "react-next-tailwind", "generic"
  domain           TEXT,
  -- opcional: "fiscal-br", "ecommerce", "saas" — para busca semântica por domínio

  -- Conteúdo
  title            TEXT        NOT NULL,
  body_md          TEXT        NOT NULL,
  -- fragmento completo que será concatenado no SYSTEM_PROMPT

  -- Controle
  hard_rule        BOOLEAN     NOT NULL DEFAULT FALSE,
  -- TRUE = imune a TTL, nunca regenerado por LLM, sempre injetado antes de outros
  source           TEXT        NOT NULL DEFAULT 'seed',
  -- seed | llm_generated | bug_fix | human
  origin_ref       TEXT,
  -- commit SHA, bug ID, ADR, sessão de memória que originou esta skill
  ttl_days         INT,
  -- NULL = sem expiração. Ver valores padrão por categoria no seed abaixo.

  -- Ciclo de vida
  status           TEXT        NOT NULL DEFAULT 'trusted',
  -- draft | shadow | trusted | deprecated
  -- shadow: nova skill em quarentena — runner usa mas compara com estático offline
  -- trusted: validada por N execuções com QA pass
  -- deprecated: retirada por falhas recorrentes

  -- Métricas
  use_count        INT         NOT NULL DEFAULT 0,
  last_used_at     TIMESTAMPTZ,
  quality_score    NUMERIC(4,3) NOT NULL DEFAULT 1.000,
  -- 0..1, decai com qa_fail, cresce com qa_pass

  -- Auditoria
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       UUID        REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT skill_slug_unique UNIQUE (slug),
  CONSTRAINT skill_role_check  CHECK (role IN ('dev','qa','pm','devops','engineer','cto','cyborg')),
  CONSTRAINT skill_status_check CHECK (status IN ('draft','shadow','trusted','deprecated')),
  CONSTRAINT skill_source_check CHECK (source IN ('seed','llm_generated','bug_fix','human')),
  CONSTRAINT skill_category_check CHECK (
    category IN ('stack','domain','pattern','antipattern','contract','hard_rule')
  ),
  CONSTRAINT skill_quality_range CHECK (quality_score BETWEEN 0 AND 1)
);

-- Índices de acesso frequente
CREATE INDEX IF NOT EXISTS idx_skill_role_stack
  ON skill (role, stack_key)
  WHERE status IN ('trusted','shadow');

CREATE INDEX IF NOT EXISTS idx_skill_hard_rule
  ON skill (role)
  WHERE hard_rule = TRUE AND status = 'trusted';

CREATE INDEX IF NOT EXISTS idx_skill_ttl_cleanup
  ON skill (last_used_at, ttl_days)
  WHERE status = 'trusted' AND ttl_days IS NOT NULL;

COMMENT ON TABLE skill IS
  'Fragmentos atomicos de conhecimento para SYSTEM_PROMPTs dinamicos. hard_rule=true sao imunes a TTL.';

COMMENT ON COLUMN skill.slug IS
  'Identificador canonico unico. Ex: dev.python-fastapi.asyncpg-enum-native, dev.react-native.no-expo';

COMMENT ON COLUMN skill.body_md IS
  'Fragmento Markdown concatenado ao SYSTEM_PROMPT. Deve ser autocontido.';

COMMENT ON COLUMN skill.ttl_days IS
  'Dias de vida desde last_used_at. NULL=sem expiracao. hard_rule=NULL, domain=365, stack=180, pattern=90, llm=30.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Tabela: skill_bundle — conjunto montado para uma task específica
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_bundle (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID        REFERENCES projects(id) ON DELETE CASCADE,
  task_id          TEXT,
  -- ID da task (project_tasks.task_id — texto, não UUID)
  role             TEXT        NOT NULL,
  stack_key        TEXT        NOT NULL,
  skill_ids        UUID[]      NOT NULL DEFAULT '{}',
  bundle_hash      TEXT        NOT NULL,
  -- sha256(sorted skill_ids concatenados) — para rastrear exatamente qual bundle foi usado
  assembled_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assembled_by     TEXT        NOT NULL DEFAULT 'runner',
  -- cto | engineer | runner | cyborg
  llm_model        TEXT,
  result_status    TEXT,
  -- success | qa_failed | blocked | human_fixed — preenchido ao fechar a task

  CONSTRAINT skill_bundle_result_check CHECK (
    result_status IS NULL OR
    result_status IN ('success','qa_failed','blocked','human_fixed')
  )
);

CREATE INDEX IF NOT EXISTS idx_skill_bundle_project
  ON skill_bundle (project_id, role);

CREATE INDEX IF NOT EXISTS idx_skill_bundle_hash
  ON skill_bundle (bundle_hash);

COMMENT ON TABLE skill_bundle IS
  'Conjunto de skills usadas por task. bundle_hash reproduz o SYSTEM_PROMPT. result_status=DONE/BLOCKED.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Tabela: skill_feedback — telemetria de qualidade para promoção/expiração
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_feedback (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id         UUID        NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
  bundle_id        UUID        REFERENCES skill_bundle(id) ON DELETE SET NULL,
  task_id          TEXT,
  project_id       UUID        REFERENCES projects(id) ON DELETE CASCADE,
  signal           TEXT        NOT NULL,
  -- qa_pass | qa_fail | cyborg_reject | bug_recurrence | human_fix | human_approve
  weight           NUMERIC(4,3) NOT NULL DEFAULT 0,
  -- -1.0 (pior) a +1.0 (melhor). Acumula em skill.quality_score via job periódico.
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT skill_feedback_signal_check CHECK (
    signal IN ('qa_pass','qa_fail','cyborg_reject','bug_recurrence','human_fix','human_approve')
  ),
  CONSTRAINT skill_feedback_weight_range CHECK (weight BETWEEN -1 AND 1)
);

CREATE INDEX IF NOT EXISTS idx_skill_feedback_skill
  ON skill_feedback (skill_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_skill_feedback_project
  ON skill_feedback (project_id, created_at DESC);

COMMENT ON TABLE skill_feedback IS
  'Telemetria de qualidade por skill. quality_score < 0.4 por N amostras depreca a skill.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Seed inicial: skills hard_rule imutáveis
-- ─────────────────────────────────────────────────────────────────────────────

-- Constraints de produto (hard_rule, TTL=NULL, sempre injetadas)
INSERT INTO skill (slug, role, category, stack_key, title, body_md, hard_rule, source, ttl_days, status) VALUES

-- React Native: NUNCA usar Expo
('dev.react-native.no-expo',
 'dev', 'hard_rule', 'react-native',
 'React Native: proibido usar Expo',
 E'## REGRA ABSOLUTA — React Native sem Expo\n\n'
 E'**NUNCA** usar Expo, Expo CLI, `expo-*` packages, `@expo/*`, ou qualquer SDK Expo.\n'
 E'Usar sempre React Native CLI puro (`react-native init` / `@react-native-community`).\n'
 E'Qualquer import de `expo` é BLOCKER automático no QA.\n\n'
 E'**Stack obrigatória:** `react-native` + `@react-navigation/*` + `react-native-*` packages.\n'
 E'**Inicialização:** `npx react-native init <NomeProjeto> --template react-native-template-typescript`',
 TRUE, 'seed', NULL, 'trusted'),

-- Node.js: npm install --legacy-peer-deps (não npm ci)
('dev.nodejs.npm-install-legacy',
 'dev', 'hard_rule', 'nodejs',
 'Node.js: usar npm install --legacy-peer-deps',
 E'## REGRA — npm install sem lock file\n\n'
 E'Usar sempre `npm install --legacy-peer-deps` em vez de `npm ci`.\n'
 E'`npm ci` falha sem `package-lock.json` no container — o Genesis não garante lock file.\n'
 E'Dockerfile: `RUN npm install --legacy-peer-deps`\n'
 E'start.sh: `npm install --legacy-peer-deps`',
 TRUE, 'seed', NULL, 'trusted'),

-- Node.js: container_name obrigatório
('dev.nodejs.container-name-required',
 'dev', 'hard_rule', 'nodejs',
 'Node.js: container_name obrigatório no docker-compose',
 E'## REGRA — container_name no docker-compose\n\n'
 E'Todo service no docker-compose DEVE ter `container_name` explícito.\n'
 E'Sem container_name, nomes gerados automaticamente colidem entre projetos.\n'
 E'Padrão: `container_name: ${PROJECT_NAME}-<service>` ou nome fixo único.',
 TRUE, 'seed', NULL, 'trusted'),

-- Node.js: seed.mjs no Dockerfile
('dev.nodejs.seed-in-dockerfile',
 'dev', 'hard_rule', 'nodejs',
 'Node.js: seed.mjs e pasta seeds/ copiados no Dockerfile',
 E'## REGRA — seed.mjs no Dockerfile\n\n'
 E'O Dockerfile DEVE copiar `seed.mjs` e `seeds/` antes do CMD:\n'
 E'```dockerfile\n'
 E'COPY seed.mjs ./\n'
 E'COPY seeds/ ./seeds/\n'
 E'```\n'
 E'Sem isso, o container sobe sem dados e smoke test falha com 404/401.',
 TRUE, 'seed', NULL, 'trusted'),

-- Node.js: findMany não findAll (Drizzle)
('dev.nodejs.drizzle-findmany',
 'dev', 'hard_rule', 'nodejs',
 'Drizzle: usar db.select() — não existe findAll nem findMany',
 E'## REGRA — Drizzle ORM: API correta\n\n'
 E'Drizzle não tem `findAll()` nem `findMany()`. API correta:\n'
 E'```typescript\n'
 E'// Listar\n'
 E'const rows = await db.select().from(table).where(eq(table.id, id));\n'
 E'// Inserir\n'
 E'const [row] = await db.insert(table).values(data).returning();\n'
 E'// Atualizar\n'
 E'await db.update(table).set(data).where(eq(table.id, id));\n'
 E'```',
 TRUE, 'seed', NULL, 'trusted'),

-- Node.js: rotas registradas no app.ts
('dev.nodejs.routes-registered',
 'dev', 'hard_rule', 'nodejs',
 'Node.js: toda rota DEVE ser registrada no app.ts/server.ts',
 E'## REGRA — Registro de rotas\n\n'
 E'Toda rota criada em `src/routes/*.ts` DEVE ser importada e registrada em `src/app.ts` ou `src/server.ts`.\n'
 E'Rota não registrada = 404 silencioso em produção.\n'
 E'Checklist antes de fechar task: `grep -r "import.*routes" src/app.ts` deve incluir TODAS as rotas geradas.',
 TRUE, 'seed', NULL, 'trusted'),

-- Python/FastAPI: setuptools
('dev.python.setuptools-build-meta',
 'dev', 'hard_rule', 'python-fastapi',
 'Python: setuptools.build_meta no pyproject.toml',
 E'## REGRA — setuptools.build_meta\n\n'
 E'`pyproject.toml` DEVE ter:\n'
 E'```toml\n'
 E'[build-system]\n'
 E'requires = ["setuptools>=68", "wheel"]\n'
 E'build-backend = "setuptools.build_meta"\n'
 E'```\n'
 E'Sem isso, `pip install -e .` falha no container com `No module named setuptools`.',
 TRUE, 'seed', NULL, 'trusted'),

-- Python/FastAPI: Pydantic uppercase
('dev.python.pydantic-uppercase',
 'dev', 'hard_rule', 'python-fastapi',
 'Python: Pydantic v2 — tipos base em maiúsculo',
 E'## REGRA — Pydantic v2 tipos\n\n'
 E'Pydantic v2 exige `str`, `int`, `float` em minúsculo — não `String`, `Integer`.\n'
 E'Importar de `pydantic`, não de `pydantic.v1`.\n'
 E'`Optional[X]` → `X | None` em Python 3.10+.\n'
 E'`from pydantic import BaseModel, Field` — não `from pydantic.v1 import ...`',
 TRUE, 'seed', NULL, 'trusted'),

-- Python/FastAPI: prefixo duplicado
('dev.python.no-duplicate-prefix',
 'dev', 'hard_rule', 'python-fastapi',
 'Python/FastAPI: sem prefixo duplicado nas rotas',
 E'## REGRA — Prefixo de rota único\n\n'
 E'Se o router já tem `prefix="/api/products"`, as rotas internas NÃO repetem o prefixo:\n'
 E'```python\n'
 E'# CORRETO\n'
 E'router = APIRouter(prefix="/api/products")\n'
 E'@router.get("/")         # → /api/products/\n'
 E'@router.get("/{id}")     # → /api/products/{id}\n\n'
 E'# ERRADO — gera /api/products/api/products/\n'
 E'@router.get("/api/products/")\n'
 E'```',
 TRUE, 'seed', NULL, 'trusted'),

-- Python/FastAPI: asyncpg ENUM nativo
('dev.python.asyncpg-enum-native',
 'dev', 'hard_rule', 'python-fastapi',
 'Python: asyncpg ENUM como tipo nativo PostgreSQL',
 E'## REGRA — asyncpg + PostgreSQL ENUM\n\n'
 E'asyncpg usa ENUMs nativos do PostgreSQL — não strings Python.\n'
 E'O ENUM deve existir no banco ANTES de ser usado:\n'
 E'```sql\n'
 E'CREATE TYPE status_enum AS ENUM (''pending'', ''done'', ''failed'');\n'
 E'```\n'
 E'No modelo SQLAlchemy/Alembic, usar `postgresql.ENUM` com `create_type=False` '
 E'se o tipo já existe. Não usar `String` para campos ENUM no Postgres.',
 TRUE, 'seed', NULL, 'trusted'),

-- Python/FastAPI: python-multipart
('dev.python.python-multipart',
 'dev', 'hard_rule', 'python-fastapi',
 'Python/FastAPI: python-multipart obrigatório para uploads',
 E'## REGRA — python-multipart\n\n'
 E'FastAPI exige `python-multipart` para receber `Form()` ou `UploadFile`.\n'
 E'Adicionar em `requirements.txt`: `python-multipart>=0.0.9`\n'
 E'Sem ele, FastAPI retorna 422 silencioso em endpoints de upload/form.',
 TRUE, 'seed', NULL, 'trusted'),

-- Frontend: token em body.data.token (não access_token)
('dev.frontend.token-field',
 'dev', 'hard_rule', 'react-next',
 'Frontend: campo token em body.data.token (Genesis padrão)',
 E'## REGRA — Campo do token de auth\n\n'
 E'Backends Genesis retornam: `{ data: { token: "..." } }`\n'
 E'**NUNCA** usar `response.access_token` ou `response.token` direto.\n'
 E'Correto: `const token = body.data?.token`\n'
 E'O campo de login é `email`, não `username`.',
 TRUE, 'seed', NULL, 'trusted'),

-- Frontend: envelope { data: T }
('dev.frontend.response-envelope',
 'dev', 'hard_rule', 'react-next',
 'Frontend: todos os endpoints retornam { data: T }',
 E'## REGRA — Envelope de resposta Genesis\n\n'
 E'Todo endpoint de backend Genesis retorna `{ data: T }` ou `{ data: T[], meta: {...} }`.\n'
 E'Nunca acessar o payload direto — sempre `unwrap`:\n'
 E'```typescript\n'
 E'const result = await fetch(...).then(r => r.json());\n'
 E'const item = result.data;           // item\n'
 E'const list = result.data;           // lista\n'
 E'const total = result.meta?.total;   // paginação\n'
 E'```\n'
 E'Se usar `createApiClient`, ele já unwraps automaticamente.',
 TRUE, 'seed', NULL, 'trusted'),

-- Frontend: prefixo /api/ obrigatório
('dev.frontend.api-prefix',
 'dev', 'hard_rule', 'react-next',
 'Frontend: endpoints sempre com prefixo /api/',
 E'## REGRA — Prefixo /api/\n\n'
 E'Todos os endpoints de backend Genesis estão sob `/api/`.\n'
 E'```typescript\n'
 E'// CORRETO\n'
 E'fetch(`${BASE_URL}/api/products`)\n'
 E'fetch(`${BASE_URL}/api/auth/login`)\n\n'
 E'// ERRADO — retorna 404\n'
 E'fetch(`${BASE_URL}/products`)\n'
 E'```\n'
 E'Se usar `createApiClient`, ele adiciona `/api/` automaticamente — paths sem o prefixo.',
 TRUE, 'seed', NULL, 'trusted'),

-- QA: tsc --noEmit obrigatório
('qa.typescript.tsc-gate',
 'qa', 'hard_rule', 'typescript',
 'QA: tsc --noEmit como gate obrigatório',
 E'## REGRA — Gate TypeScript\n\n'
 E'`tsc --noEmit` DEVE passar sem erros antes de aprovar qualquer task TypeScript.\n'
 E'Erros de tipo são BLOCKER — não MAJOR.\n'
 E'Rodar na raiz do projeto com o `tsconfig.json` do projeto.',
 TRUE, 'seed', NULL, 'trusted'),

-- QA: CONTRACT LAW
('qa.frontend.contract-law',
 'qa', 'hard_rule', 'react-next',
 'QA: CONTRACT LAW — toda rota em src/lib/ deve existir no api_contract.md',
 E'## REGRA — CONTRACT LAW\n\n'
 E'Toda URL de API em `src/lib/*.ts` ou `src/api/*.ts` DEVE existir no `api_contract.md` do backend.\n'
 E'Rota não listada no contrato = BLOCKER automático.\n'
 E'Verificar: `grep -r "fetch\\|axios" src/lib/ src/api/` → comparar com `api_contract.md`.',
 TRUE, 'seed', NULL, 'trusted')

ON CONFLICT (slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Coluna bundle_hash em project_tasks (auditoria de qual skill foi usada)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS skill_bundle_id UUID REFERENCES skill_bundle(id) ON DELETE SET NULL;

ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS origin_actor TEXT DEFAULT 'runner';
-- runner | cyborg | human — quem executou esta task

COMMENT ON COLUMN project_tasks.skill_bundle_id IS
  'Bundle de skills usado para esta task. NULL = task anterior ao skill store ou não-LLM.';

COMMENT ON COLUMN project_tasks.origin_actor IS
  'Quem executou a task: runner (pipeline normal), cyborg (intervenção autônoma), human (manual).';
