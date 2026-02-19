# Contexto — Portal Genesis Web (genesis-web)

> **Uso**: Documento de contexto do app **genesis-web** para continuidade entre sessões e onboarding. Leia junto com [docs/PLAN_PORTAL_GENESIS.md](../docs/PLAN_PORTAL_GENESIS.md) e [docs/PORTAL_TENANTS_AND_PLANS.md](../docs/PORTAL_TENANTS_AND_PLANS.md).

---

## 1. O que é o genesis-web

**genesis-web** é o **portal web** do Zentriz Genesis — a interface única para controle de tenants, planos (Prata/Ouro/Diamante), usuários e projetos.

- **URL**: genesis.zentriz.com.br (produção); local: **localhost:3001**
- **Serviço Docker**: `genesis-web` (porta 3001 no docker-compose)
- **Stack**: React + **Next.js 14+** (App Router) + TypeScript + **Material UI (MUI)** + **MobX**
- **Localização no repo**: [apps/genesis-web](../../applications/apps/genesis-web)

---

## 2. Estrutura e stack

| Aspecto | Detalhe |
|--------|---------|
| Framework | Next.js 14 (App Router) |
| UI | @mui/material, @emotion/react, @emotion/styled |
| Estado | MobX (mobx, mobx-react-lite) |
| Estrutura de pastas | `app/`, `components/`, `stores/`, `lib/`, `types/` |
| Variável de API | `NEXT_PUBLIC_API_BASE_URL` (ex.: http://localhost:3000) |

---

## 3. Roles e telas de login (discriminação por role)

Cada tela de login exige o **role** correspondente; se o usuário logar com credenciais de outro perfil, a mensagem orienta a usar a tela correta.

| Rota | Título | Role exigido | E-mail padrão | Senha padrão |
|------|--------|--------------|---------------|--------------|
| `/login` | Acesso — Usuário | `user` | user@tenant.com | #User@2026! |
| `/login/tenant` | Acesso — Admin do tenant | `tenant_admin` | admin@tenant.com | #Tenant@2026! |
| `/login/genesis` | Portal Genesis (Zentriz) | `zentriz_admin` | admin@zentriz.com | #Jean@2026! |

- **Usuário (por tenant)**: envio de spec ao CTO (múltiplos arquivos; formatos .md, .txt, .doc, .pdf; preferido .md; conversão para .md a cargo do orquestrador — ver [docs/SPEC_SUBMISSION_AND_FORMATS.md](../docs/SPEC_SUBMISSION_AND_FORMATS.md)), meus projetos (listagem/detalhe), notificações.
- **Tenant admin**: gestão de usuários do tenant, gestão de projetos do tenant, visão do plano e uso, configurações do tenant.
- **Zentriz admin**: gestão de tenants (CRUD, plano), gestão de usuários globais, gestão de projetos (visão global), controle por plano (limites, funcionalidades).

Layout principal: AppBar, drawer com navegação por role; roteamento protegido por role (middleware/HOC). Integração com API real: auth (`POST /api/auth/login`), projetos (`GET /api/projects`, etc.), upload de spec (`POST /api/specs` multipart). Erros da API exibem apenas o campo `message` (não o JSON bruto). CORS configurado com `credentials: true` na API.

---

## 4. Como rodar

```bash
# Na raiz do repo
cd apps/genesis-web
npm install
npm run dev   # http://localhost:3000 por padrão Next; pode configurar porta 3001 via -p 3001
```

**Docker** (com stack completa):

- Serviço `genesis-web` no [docker-compose.yml](../../docker-compose.yml); porta **3001**.
- Build: `docker compose build genesis-web`; subir: `docker compose up genesis-web` ou `./deploy-docker.sh`.

---

## 5. Entregas (estado atual)

- [x] App Next.js rodando localmente (porta 3001 no Docker)
- [x] Três telas de login discriminadas por role (`/login`, `/login/tenant`, `/login/genesis`) com validação pós-login
- [x] Integração com API real (auth Bearer, projetos, upload de spec multipart)
- [x] Login e layout por role (usuário, tenant admin, Zentriz)
- [x] Telas usuário: envio spec (multi-arquivo .md/.txt/.doc/.docx/.pdf), listagem/detalhe projetos (com startedAt/completedAt), notificações
- [x] Telas tenant: gestão usuários, gestão projetos, plano e uso
- [x] Telas Zentriz: gestão tenants, usuários, projetos, controle por plano
- [x] genesis-web no docker-compose; Dockerfile e .dockerignore em apps/genesis-web
- [x] deploy-docker.sh sobe todo o stack (api, genesis-web, postgres, redis, agents)
- [x] **Aceitar projeto**: botão "Aceitar projeto" na página do projeto quando status é `completed` ou `running`; chama `POST /api/projects/:id/accept` e exibe chip "Aceito" para status `accepted`. O pipeline (Monitor Loop) encerra quando o usuário aceita ou para.

---

## 6. Referências

| Documento | Uso |
|-----------|-----|
| [docs/SPEC_SUBMISSION_AND_FORMATS.md](../docs/SPEC_SUBMISSION_AND_FORMATS.md) | Envio de spec: formatos aceitos (.md, .txt, .doc, .pdf), múltiplos arquivos, conversor |
| [docs/PLAN_PORTAL_GENESIS.md](../docs/PLAN_PORTAL_GENESIS.md) | Plano de construção do portal (fases, critérios) |
| [docs/PORTAL_TENANTS_AND_PLANS.md](../docs/PORTAL_TENANTS_AND_PLANS.md) | Telas, roles, planos, multi-tenant |
| [docs/TECHNICAL_REQUIREMENTS.md](../docs/TECHNICAL_REQUIREMENTS.md) | Stack (React+Next, MUI), domínio, URLs |
| [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) | Deploy local, script deploy-docker.sh, porta genesis-web |

---

**Resumo de atividades realizadas:** Integração API (auth, projects, specs), CORS com credentials, exibição apenas da mensagem de erro da API, seed com usuários hasheados (Zentriz Admin, tenant admin, user), login por role com discriminação nas três telas. Ver [CONTEXT.md](CONTEXT.md) para estado geral do projeto.

*Documento criado em 2026-02-17 — Zentriz Genesis. Atualize quando houver mudanças no portal ou no plano.*
