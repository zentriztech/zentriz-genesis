# Portal Genesis, Multi-tenant, Planos e Telas

> Definição do portal **genesis.zentriz.com.br**: controle de usuários, planos contratados (Prata, Ouro, Diamante), modelo multi-tenant, registro de projetos e fluxo de geração pelos agentes até o provisionamento automático pelo DevOps. Inclui gestão Zentriz (admin de tenants, usuários e projetos) e todas as telas necessárias para tenants e usuários.

---

## 1. Portal web — genesis.zentriz.com.br

- **URL**: https://genesis.zentriz.com.br (produção); ambiente local conforme [TECHNICAL_REQUIREMENTS.md](TECHNICAL_REQUIREMENTS.md) (Domínio e URLs).
- **Função**: Interface única para:
  - **Usuários (por tenant)**: enviar specs ao CTO conforme plano contratado; registrar e acompanhar projetos do início à finalização; acompanhar o trabalho dos agentes (CTO, PM, Dev, QA, DevOps, Monitor) e o provisionamento automático pelo agente DevOps conforme a spec enviada.
  - **Tenants**: cadastrar e gerenciar seus usuários; gerenciar e acompanhar todos os projetos do tenant.
  - **Zentriz (operador da plataforma)**: gerenciar todos os Tenants, usuários e projetos da base; controle e provisionamento de acesso conforme planos.

---

## 2. Controle de usuários e acesso

- Acesso ao portal é **autenticado** (controle de usuários).
- O que o usuário pode fazer depende do **plano contratado** pelo tenant (Prata, Ouro, Diamante) — por exemplo, envio de specs ao CTO e limites de uso (projetos simultâneos, recursos, etc.).
- **Tenant**: cada organização/cliente é um tenant; pode cadastrar seus próprios usuários e atribuir roles/permissões dentro do tenant.
- **Zentriz**: mantém usuários administrativos globais para gerenciar tenants, usuários e projetos em toda a plataforma.

---

## 3. Planos contratados (Prata, Ouro, Diamante)

- **Prata**, **Ouro** e **Diamante** são níveis de plano que definem o que o tenant pode usar (ex.: número de specs/projetos, prioridade na fila de agentes, recursos de provisionamento).
- O envio de spec para o CTO e a geração do projeto pelos agentes devem respeitar o plano do tenant (ex.: só permitir envio se houver cota; priorizar Diamante sobre Prata na orquestração).
- Detalhamento de limites e benefícios por plano fica para especificação de produto (backlog ou documento de planos).

---

## 4. Modelo multi-tenant

- **Tenant** = organização que consome a plataforma (uma empresa, um time). Dados e projetos são isolados por tenant.
- Cada tenant:
  - Possui um **plano** (Prata, Ouro ou Diamante).
  - Pode **cadastrar usuários** próprios e gerenciar acesso ao portal e aos projetos do tenant.
  - **Registra projetos** iniciados por seus usuários; cada projeto é gerado pelos agentes a partir da spec enviada (CTO → PM → Dev/QA/DevOps/Monitor) até a finalização e **provisionamento automático** pelo agente DevOps, conforme a spec.
- **Zentriz** (operador):
  - Gerencia **todos os tenants** (CRUD, plano, status).
  - Gerencia **usuários** (incluindo usuários admin globais e, quando aplicável, visão sobre usuários dos tenants).
  - Gerencia **projetos** (visão global; suporte, auditoria, limites por plano).

---

## 5. Fluxo do projeto (do start à finalização e provisionamento)

1. **Usuário (do tenant)** envia a **spec** pelo portal (genesis.zentriz.com.br), dentro do plano contratado. O envio de spec ao CTO permite **mais de um arquivo**; os formatos aceitos são **.md (preferencial), .txt, .doc/.docx e .pdf**. Detalhes em [SPEC_SUBMISSION_AND_FORMATS.md](SPEC_SUBMISSION_AND_FORMATS.md).
2. O sistema **registra o projeto** e dispara o fluxo de agentes: **CTO** (Charter) → **PM** (backlog) → **Dev / QA / Monitor / DevOps** conforme orquestração existente ([ORCHESTRATION_GUIDE.md](ORCHESTRATION_GUIDE.md)).
3. **Tenants e usuários** podem **gerenciar e acompanhar** todo o processo no portal: status do projeto, etapas, artefatos, alertas (Monitor), até a **finalização**.
4. O **agente DevOps** (seguindo a spec e o DoD) realiza o **provisionamento automático** (Docker, Terraform, k8s conforme [TECHNICAL_REQUIREMENTS.md](TECHNICAL_REQUIREMENTS.md)); o portal deve refletir o estado “provisionado” / deploy realizado quando aplicável.
5. **Zentriz** tem visão e gestão sobre todos os projetos (e tenants/usuários) para suporte, limites e operação.

---

## 6. Telas necessárias (provisionamento aos tenants e usuários)

As telas devem cobrir **todo o gerenciamento e controle** que tenants e usuários precisam, além da gestão global pela Zentriz.

### 6.1 Para o usuário (dentro de um tenant)

- **Login / autenticação** (e recuperação de acesso quando aplicável).
- **Envio de spec** para iniciar projeto (respeitando plano Prata/Ouro/Diamante): múltiplos arquivos aceitos (.md, .txt, .doc, .pdf); ver [SPEC_SUBMISSION_AND_FORMATS.md](SPEC_SUBMISSION_AND_FORMATS.md).
- **Listagem e detalhe dos meus projetos** (status, etapas, artefatos, histórico).
- **Acompanhamento do fluxo** do projeto: CTO → PM → Dev/QA/Monitor/DevOps (timeline, logs, evidências, estado de provisionamento).
- **Notificações/alertas** relevantes ao usuário (ex.: projeto finalizado, provisionamento concluído, bloqueio).

### 6.2 Para o tenant (administrador do tenant)

- **Gestão de usuários do tenant**: cadastro, edição, desativação, roles/permissões.
- **Gestão de projetos do tenant**: listagem, filtros, status, acompanhamento global dos projetos do tenant.
- **Visão do plano** contratado (Prata/Ouro/Diamante) e uso (ex.: projetos ativos, cota).
- (Opcional) **Configurações do tenant** (ex.: nome, contato, notificações).

### 6.3 Para a Zentriz (admin da plataforma)

- **Gestão de tenants**: criar, editar, suspender, atribuir/alterar plano (Prata/Ouro/Diamante).
- **Gestão de usuários**: usuários admin globais; visão e, quando necessário, gestão de usuários dos tenants.
- **Gestão de projetos**: listagem global, filtro por tenant/usuário/status; acompanhamento, suporte e auditoria; limites e provisionamento conforme plano.
- **Controle e provisionamento** de tipos de gerenciamento e controle oferecidos aos tenants e usuários (ex.: ativar/desativar funcionalidades por plano, limites de uso).

---

## 7. Resumo

| Área | Responsável | Conteúdo |
|------|-------------|----------|
| **Portal** | genesis.zentriz.com.br | Entrada de specs, gestão e acompanhamento de projetos e agentes; controle de usuários por plano e tenant. |
| **Planos** | Prata, Ouro, Diamante | Define o que o tenant pode fazer (envio de spec ao CTO, limites, prioridade, provisionamento). |
| **Multi-tenant** | Tenant + Zentriz | Tenant cadastra usuários e gerencia projetos; Zentriz gerencia todos os tenants, usuários e projetos. |
| **Fluxo** | Agentes | Spec → CTO → PM → Dev/QA/Monitor/DevOps → finalização e **provisionamento automático** pelo DevOps conforme spec. |
| **Telas** | Portal | Login; envio de spec; projetos (listagem, detalhe, acompanhamento); gestão de usuários (tenant); gestão de tenants, usuários e projetos (Zentriz); plano e uso. |

---

*Documento criado em 2026-02-17 — Zentriz Genesis. Deve ser alinhado ao [TECHNICAL_REQUIREMENTS.md](TECHNICAL_REQUIREMENTS.md) (domínio, stack) e ao [ORCHESTRATION_GUIDE.md](ORCHESTRATION_GUIDE.md) (fluxo de agentes).*
