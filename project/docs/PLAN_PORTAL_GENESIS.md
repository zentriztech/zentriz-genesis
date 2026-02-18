# Plano: Portal Genesis (genesis.zentriz.com.br)

> Plano de construção do portal web de controle de tenants, planos (Prata/Ouro/Diamante), usuários e projetos. Referência: [PORTAL_TENANTS_AND_PLANS.md](PORTAL_TENANTS_AND_PLANS.md), [TECHNICAL_REQUIREMENTS.md](TECHNICAL_REQUIREMENTS.md).

---

## 1. Escopo

- **URL**: genesis.zentriz.com.br (local: localhost:3001 ou porta dedicada).
- **Stack**: React + Next.js (App Router) + TypeScript + Material UI (MUI) + MobX.
- **Nome do serviço Docker**: `genesis-web`.
- **Entregas**: aplicação web completa com todas as telas descritas em PORTAL_TENANTS_AND_PLANS.md; integração com API existente; containerização e inclusão no docker-compose.

---

## 2. Fases

### Fase 1 — Projeto base
- Criar app Next.js 14+ (App Router) em `apps/genesis-web`.
- Configurar TypeScript, ESLint, Prettier.
- Instalar e configurar: `@mui/material`, `@emotion/react`, `@emotion/styled`, `mobx`, `mobx-react-lite`.
- Estrutura de pastas: `app/`, `components/`, `stores/`, `lib/`, `types/`.
- Variável `NEXT_PUBLIC_API_BASE_URL` para a API (ex.: http://localhost:3000).

### Fase 2 — Autenticação e layout
- Tela de **login** (e recuperação de acesso placeholder).
- Store MobX para auth (user, tenant, role, token).
- Layout principal: AppBar, drawer (nav por role: usuário, tenant admin, Zentriz admin).
- Roteamento protegido por role (middleware ou HOC).

### Fase 3 — Telas usuário (por tenant)
- **Envio de spec**: formulário para enviar spec ao CTO (respeitando plano). Suporte a **mais de um arquivo**; formatos **.md (preferencial), .txt, .doc, .pdf**; quando não for .md, o orquestrador usa um **conversor** para gerar .md formatado. Ver [SPEC_SUBMISSION_AND_FORMATS.md](SPEC_SUBMISSION_AND_FORMATS.md).
- **Meus projetos**: listagem com status, filtros; link para detalhe.
- **Detalhe do projeto**: status, etapas, timeline (CTO → PM → Dev/QA/Monitor/DevOps), artefatos, estado de provisionamento.
- **Notificações**: lista/feed de alertas (projeto finalizado, provisionamento concluído, bloqueio).

### Fase 4 — Telas tenant (admin do tenant)
- **Gestão de usuários do tenant**: CRUD, edição, desativação, roles.
- **Gestão de projetos do tenant**: listagem global, filtros, status.
- **Visão do plano**: plano contratado (Prata/Ouro/Diamante) e uso (projetos ativos, cota).
- **Configurações do tenant** (opcional): nome, contato.

### Fase 5 — Telas Zentriz (admin da plataforma)
- **Gestão de tenants**: CRUD, suspender, atribuir/alterar plano.
- **Gestão de usuários**: admin globais; visão/gestão de usuários dos tenants.
- **Gestão de projetos**: listagem global, filtro por tenant/usuário/status; auditoria.
- **Controle por plano**: ativar/desativar funcionalidades por plano, limites.

### Fase 6 — Integração e dados
- Cliente HTTP para API (fetch ou axios) com base em `NEXT_PUBLIC_API_BASE_URL`.
- Tipos TypeScript alinhados a tenants, users, projects, plans.
- Mock ou endpoints reais: auth, tenants, users, projects, specs (conforme API existente ou stubs).
- Envio de spec com **mais de um arquivo**, formatos .md (preferencial), .txt, .doc, .pdf; conversor no orquestrador para .md quando necessário; referência: [SPEC_SUBMISSION_AND_FORMATS.md](SPEC_SUBMISSION_AND_FORMATS.md).

### Fase 7 — Docker e documentação
- **Dockerfile** para `genesis-web` (Node, build Next, run standalone).
- **docker-compose.yml**: adicionar serviço `genesis-web`, porta (ex.: 3001), variáveis, dependências (api).
- **deploy-docker.sh**: já sobe todos os serviços; garantir que `genesis-web` está no compose.
- Atualizar **docs/DEPLOYMENT.md** com serviço genesis-web e porta.
- Testes manuais; correções; rodar `./deploy-docker.sh` e validar.

---

## 3. Referências

| Documento | Uso |
|-----------|-----|
| [PORTAL_TENANTS_AND_PLANS.md](PORTAL_TENANTS_AND_PLANS.md) | Telas, roles, fluxo, planos. |
| [TECHNICAL_REQUIREMENTS.md](TECHNICAL_REQUIREMENTS.md) | Stack (React+Next, MUI), domínio, URLs, CQRS. |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Deploy local, script deploy-docker.sh. |
| [docker-compose.yml](../../docker-compose.yml) | Serviços existentes (api, postgres, redis, agents). |

---

## 4. Critérios de conclusão

- [x] App Next.js rodando localmente (npm run dev; Docker porta 3001).
- [x] Três telas de login discriminadas por role (`/login`, `/login/tenant`, `/login/genesis`); validação pós-login.
- [x] Login e layout por role (usuário, tenant admin, Zentriz).
- [x] Telas usuário: envio spec (multi-arquivo), listagem/detalhe projetos, notificações.
- [x] Telas tenant: gestão usuários, gestão projetos, plano e uso.
- [x] Telas Zentriz: gestão tenants, usuários, projetos, controle por plano.
- [x] genesis-web no [docker-compose.yml](../../docker-compose.yml); [Dockerfile](../../applications/apps/genesis-web/Dockerfile) e [.dockerignore](../../applications/apps/genesis-web/.dockerignore).
- [x] deploy-docker.sh sobe todo o stack (api, genesis-web, postgres, redis, agents).
- [x] Integração com API real (auth, projetos, upload de spec); usuários padrão documentados em [services/api-node/README.md](../../applications/services/api-node/README.md) e [SECRETS_AND_ENV.md](SECRETS_AND_ENV.md).

---

*Plano criado em 2026-02-17. Portal implementado em apps/genesis-web (React, Next.js, MUI, MobX). Atualizado 2026-02-17.*
