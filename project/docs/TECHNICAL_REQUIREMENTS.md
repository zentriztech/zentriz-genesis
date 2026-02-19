# Requisitos Técnicos, Infraestrutura e Linguagens — Zentriz Genesis

> Definições para a **plataforma** (agentes, orquestrador, APIs, infra) e para o **produto de exemplo** (Voucher MVP). Ambiente local via Docker; cloud via Terraform e Kubernetes.

---

## 1. Ambiente local e namespace

- **Provisionamento local**: Toda a stack roda **localmente em Docker**.
- **Namespace**: Todos os recursos (containers, redes, volumes) devem usar o namespace **`zentriz-genesis`** para isolamento e identificação.
- **Objetivo**: Desenvolvimento e testes sem depender de cloud; mesma topologia que em staging/prod (containers/orquestração).

---

## 2. Infraestrutura como código (IaC)

Toda a infra deste projeto é definida por:

| Ferramenta | Uso |
|------------|-----|
| **Terraform** | Definição de infraestrutura (redes, bancos, filas, clusters, serviços gerenciados). Fonte única para estado desejado. |
| **Docker** | Build de imagens e execução local (namespace `zentriz-genesis`). Compose ou equivalente para orquestração local. |
| **Kubernetes (k8s)** | Orquestração de containers em ambientes de deploy (staging/prod). Manifests ou Helm gerenciados; Terraform pode provisionar o cluster (EKS, AKS, GKE). |

- **Local**: Docker (e Docker Compose ou similar) sob namespace `zentriz-genesis`.
- **Cloud (ex.: AWS)**: Terraform provisiona VPC, RDS, ElastiCache, Amazon MQ (ou equivalente RabbitMQ), DocumentDB/MongoDB, EKS (k8s), etc.; aplicações rodam em containers no k8s.

---

## 3. Domínio e URLs

O projeto opera sob o **domínio raiz zentriz.com.br**, hospedado na **AWS**. Toda URL pública (portal, APIs, webhooks, etc.) deve usar esse domínio e um **subdomínio** (ou path) próprio.

### 3.1 Regra geral

- **Domínio raiz**: `zentriz.com.br`
- **Subdomínio do Genesis**: `genesis.zentriz.com.br` — agrupa todos os serviços do projeto Zentriz Genesis.
- Serviços expostos por URL: usar `genesis.zentriz.com.br` como host e definir **paths** ou subdomínios adicionais conforme a tabela abaixo.

### 3.2 URLs de referência (produção / staging)

| URL | Uso |
|-----|-----|
| **https://genesis.zentriz.com.br** | **Portal web** — controle de usuários por plano (Prata, Ouro, Diamante); multi-tenant; envio de specs ao CTO; registro e acompanhamento de projetos do start à finalização e provisionamento automático pelo DevOps; gestão Zentriz (tenants, usuários, projetos). Detalhes: [PORTAL_TENANTS_AND_PLANS.md](PORTAL_TENANTS_AND_PLANS.md). |
| **https://genesis.zentriz.com.br/api** | API principal (BFF / gateway) — chamadas de leitura e comando vindas do portal e de integrações. |
| **https://genesis.zentriz.com.br/api/...** | Demais endpoints (ex.: `/api/v1/specs`, `/api/v1/agents`, `/api/health`). |
| *(outros subdomínios sob `genesis.*` ou paths podem ser definidos conforme necessidade)* | Ex.: webhooks, APIs de agentes/LLM, documentação (ex.: `genesis.zentriz.com.br/docs`). |

### 3.3 Ambiente local

- Em **desenvolvimento local** (Docker), usar `localhost` com portas distintas ou um host local (ex.: `genesis.zentriz.local` via `/etc/hosts` ou similar) que espelhe a estrutura de paths (ex.: `http://localhost:3000` para o portal, `http://localhost:3000/api` para a API).
- Variáveis de ambiente (ex.: `NEXT_PUBLIC_API_BASE_URL`, `API_BASE_URL`) devem apontar para a URL correta por ambiente (local, staging, prod).

### 3.4 DNS e certificados (AWS)

- O domínio **zentriz.com.br** está na AWS; subdomínios como **genesis.zentriz.com.br** devem ser configurados no **Route 53** (ou no DNS que aponta para a AWS).
- Certificados **TLS/HTTPS** para `*.zentriz.com.br` ou `genesis.zentriz.com.br` via **ACM** (AWS Certificate Manager); ALB/CloudFront usam o certificado para terminação SSL.

---

## 4. Arquitetura: CQRS

- O sistema adota **CQRS** (Command Query Responsibility Segregation):
  - **Command side**: escrita de dados; validação e persistência em fonte de verdade; publicação de eventos para atualização de leituras e integrações.
  - **Query side**: leituras otimizadas (caches, read models); pode usar Redis, views materializadas ou réplicas de leitura.
- **Benefícios**: Escala de leitura independente da escrita; clareza entre comandos e consultas; suporte a event sourcing e múltiplos read models quando necessário.

---

## 5. Linguagens e responsabilidades

| Área | Linguagem / runtime | Uso |
|------|--------------------|-----|
| **API de chamada simples** | **Node.js** (TypeScript) | APIs leves, gateway, BFF, orquestração de chamadas. |
| **APIs pesadas, Agents, LLM** | **Python** | Processamento pesado, agentes de IA, integração com LLMs, pipelines de dados. Provisionado em **containers**. |
| **Web (front-end)** | **React + Next.js** (TypeScript) | Aplicação web; SSR/SSG quando fizer sentido. |
| **Orquestrador / handlers** | Node.js (leve) ou Python (pesado) | Conforme tipo de task; ambos em containers. |
| **Scripts / IaC** | Shell, Node ou Python; Terraform (HCL) | Automação; infra como código. |

**Resumo**: Node para APIs simples e BFF; Python para APIs pesadas, agentes e LLM; tudo containerizado (Docker/k8s).

---

## 6. Stack por módulo

### 6.1 Backend (APIs)

- **Node.js (TypeScript)**: APIs de chamada simples, BFF, gateway. Ex.: Fastify ou NestJS. Containers.
- **Persistência Postgres (Node)**: ORM **Drizzle** para acesso a PostgreSQL (schema, migrations, queries). Fonte de verdade transacional conforme seção 7.
- **Python**: APIs pesadas, agentes (CTO, PM, Dev, QA, DevOps, Monitor), integração LLM, jobs. Ex.: FastAPI. Containers.
- **Testes**: Vitest/Jest (Node); pytest (Python). Cobertura e qualidade conforme [PERFORMANCE_METRICS.md](PERFORMANCE_METRICS.md).

### 6.2 Web

- **Stack**: **React + Next.js** (TypeScript).
- **State**: Conforme necessidade (React Query, Zustand, ou equivalente).
- **Deploy**: Containers (Next em Node) ou estático (export estático); em k8s ou S3/CloudFront conforme ambiente.

### 6.3 Mobile (futuro)

- **Stack**: React Native (sem Expo), TypeScript.
- **Futuro**: Kotlin (Android), Swift (iOS).

---

## 7. Armazenamento e mensageria

| Componente | Uso | Local (Docker) | AWS (exemplo) |
|------------|-----|----------------|----------------|
| **PostgreSQL** | Fonte de verdade **transacional e de domínio** (agregados, entidades, consistência forte). Acesso via **Drizzle** (ORM) no Node.js. | Container Postgres no namespace `zentriz-genesis`. | **RDS (Postgres)**. |
| **MongoDB** | **Entrada de dados** (ingestão), event log, dados semi-estruturados ou de alto volume de escrita. | Container MongoDB no namespace `zentriz-genesis`. | **DocumentDB** (compatível MongoDB) ou MongoDB Atlas. |
| **Redis** | **Caches**, read models, sessões, rate limit. | Container Redis no namespace `zentriz-genesis`. | **ElastiCache (Redis)**. |
| **RabbitMQ** | **Filas** (comandos assíncronos, eventos, workers). | Container RabbitMQ no namespace `zentriz-genesis`. | **Amazon MQ (RabbitMQ)** ou RabbitMQ em k8s. |

### 7.1 Orientação: Postgres vs MongoDB como “fonte de verdade”

- **PostgreSQL (RDS)** como **fonte de verdade para domínio/transações**:
  - Dados que exigem **ACID**, integridade referencial e consistência forte (ex.: vouchers, usuários, saldos, aprovações).
  - Modelo relacional estável; reporting e auditoria simples.
- **MongoDB** como **entrada de dados e event store**:
  - Ingestão de dados brutos ou semi-estruturados; event log para CQRS; dados que mudam de forma ou têm alto volume de escrita.
  - Não substitui o Postgres para o núcleo transacional; complementa com flexibilidade e escala de escrita.
- **Recomendação**: Manter **Postgres como fonte de verdade transacional/domínio** e **MongoDB para entrada de dados, event log e cenários de alto volume/schema flexível**. Assim você tem consistência onde importa (Postgres) e flexibilidade/performance onde importa (MongoDB).

---

## 8. Infraestrutura AWS (quando for para cloud)

Quando o deploy for na AWS, a infra deve incluir (tudo definido em **Terraform**; runtime em **containers no k8s** quando aplicável):

| Categoria | Serviços / recursos |
|-----------|----------------------|
| **Compute / orquestração** | EKS (Kubernetes); Lambda (se houver funções serverless pontuais). |
| **Banco de dados** | RDS (PostgreSQL) — fonte de verdade; DocumentDB ou MongoDB Atlas (entrada de dados / event log). |
| **Cache** | ElastiCache (Redis). |
| **Filas** | Amazon MQ (RabbitMQ) ou RabbitMQ em EKS. |
| **Rede** | VPC, subnets (públicas/privadas), security groups, ALB/NLB. |
| **API / tráfego** | ALB, API Gateway (se usado); CloudFront para estáticos. |
| **Armazenamento** | S3 (artefatos, backups, objetos). |
| **Observabilidade** | CloudWatch (logs, métricas, alarmes); X-Ray se necessário. |
| **Segurança** | IAM, Secrets Manager (ou Parameter Store), KMS. |

- **Ambientes**: dev (local Docker), staging, prod (AWS com Terraform + k8s).
- **CI/CD**: lint → test → build → push de imagens → deploy no k8s (ou equivalente); pipelines em GitHub Actions ou ferramenta equivalente.

---

## 9. Ordem de desenvolvimento dos agentes

Para começar a implementar o projeto, a ordem recomendada é a seguinte (fundação de infra primeiro; orquestrador por último):

| # | Agente | Descrição |
|---|--------|------------|
| **0** | **Variáveis de Ambiente (.env)** | Definir todas as variáveis de ambiente iniciais; template em [.env.example](../.env.example), lista em [SECRETS_AND_ENV.md](SECRETS_AND_ENV.md). |
| **1** | **devops::docker** | Base: Docker (namespace `zentriz-genesis`), Terraform e Kubernetes em qualquer infra (AWS, GCP, Azure). Sem isso não há ambiente para rodar nem fazer deploy. Ver [agents/devops/docker/](../agents/devops/docker/). |
| 2 | dev::backend::nodejs | API (ex.: Node/TypeScript); consome a base Docker/k8s. |
| 3 | qa::backend::nodejs | Testes e validação do backend Node. |
| 4 | pm::backend::nodejs | Backlog e planejamento da squad Backend. |
| 5 | monitor::backend::nodejs | Acompanhamento, health e alertas da squad Backend. |
| 6 | cto | Orquestrador (spec → Charter → PM → backlogs); implementar por último. |

Detalhes e justificativas: [context/DEVELOPMENT_CONTEXT.md](../context/DEVELOPMENT_CONTEXT.md) (seção “Podemos começar a desenvolver?”).

---

## 10. Requisitos técnicos gerais (DoD e NFR)

- **Performance (API)**: p95 &lt; 500 ms; p99 &lt; 1 s; 50+ req/s por endpoint ([PERFORMANCE_METRICS.md](PERFORMANCE_METRICS.md)).
- **Segurança**: validação de input, rate limit; sem secrets em código; LGPD (não logar dados sensíveis).
- **Observabilidade**: logs estruturados, `request_id` em toda request.
- **Testes**: cobertura unitária &gt; 80%; cada FR com teste; smoke tests pós-deploy.
- **Qualidade**: lint 0 erros, typecheck 0 erros, build PASS.

---

## 11. Ferramentas (ambiente de desenvolvimento)

| Finalidade | Ferramenta |
|------------|------------|
| Versionamento | Git |
| Backend Node | Node.js 20+, npm/yarn/pnpm, TypeScript |
| Backend Python | Python 3.x, pip/poetry, mypy, ruff |
| Web | Node.js (build), React, Next.js, TypeScript |
| Containers / local | **Docker**, Docker Compose (namespace `zentriz-genesis`) |
| IaC | **Terraform** (HCL); Kubernetes (kubectl, Helm se aplicável) |
| Testes | Jest/Vitest (Node), pytest (Python) |
| Lint/format | ESLint, Prettier (JS/TS); Ruff, Black (Python) |
| CI/CD | GitHub Actions ou equivalente |

---

## 12. O que instalar para começar

- **Git**
- **Node.js** (v20+)
- **Python** (3.x)
- **Docker** (e Docker Compose) — obrigatório para rodar a stack local no namespace **zentriz-genesis**
- **Terraform** (CLI) — para provisionar infra quando for usar cloud
- **kubectl** (e acesso a um cluster k8s) — quando for deploy em Kubernetes
- **Editor/IDE** (ex.: VS Code / Cursor)
- (Quando for deploy AWS) **AWS CLI** e credenciais configuradas
- **Variáveis de ambiente**: copiar [.env.example](../.env.example) para `.env` e preencher `CLAUDE_API_KEY` (API Anthropic para os agentes acessarem o LLM). O arquivo `.env` **não** é commitado (está no .gitignore). Ver [docs/SECRETS_AND_ENV.md](SECRETS_AND_ENV.md).

---

## 13. Secrets e variáveis de ambiente

- **Local**: Segredos (ex.: chave da Claude API) ficam em **`.env`** na raiz do projeto. O `.env` está no [.gitignore](../.gitignore) e **nunca** deve ser commitado.
- **Template**: Use [.env.example](../.env.example) como referência; copie para `.env` e preencha os valores.
- **Lista completa**: Todas as variáveis de ambiente iniciais (LLM, infra, API, runtime dos agentes) estão documentadas em [SECRETS_AND_ENV.md](SECRETS_AND_ENV.md).
- **Variável para o LLM**: `CLAUDE_API_KEY` — usada pelos agentes para chamadas à API Anthropic (Claude).
- **Em cloud**: usar gerenciador de segredos do provedor (AWS Secrets Manager, Parameter Store, etc.) e injetar como variáveis de ambiente no runtime (ex.: k8s Secrets, Lambda env).

---

*Documento criado em 2026-02-17 — Atualizado em 2026-02-17 — Zentriz Genesis. Inclui: domínio zentriz.com.br (genesis.zentriz.com.br), ambiente local Docker (namespace zentriz-genesis), IaC (Terraform, Docker, k8s), CQRS, React+Next, Node/Python, Postgres/MongoDB/Redis/RabbitMQ, infra AWS.*
