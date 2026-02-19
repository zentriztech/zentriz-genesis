# Plano: Engineer, Novo Fluxo e Dinâmica de Equipe

> **Propósito**: Diretrizes e plano de aplicação para introduzir o ator **Engineer**, novo fluxo CTO ↔ Engineer → PM(s), comunicação contínua entre agentes (simulando equipe humana), logs em linguagem humana e exibição dinâmica no Genesis-Web.  
> **Referências**: [ACTORS_AND_RESPONSIBILITIES.md](ACTORS_AND_RESPONSIBILITIES.md), [ORCHESTRATION_GUIDE.md](ORCHESTRATION_GUIDE.md), [applications/agents/engineer/skills.md](../../applications/agents/engineer/skills.md).

---

## 1. Visão geral das mudanças

| Área | Situação atual | Objetivo |
|------|----------------|----------|
| Atores | CTO, PM, Dev, QA, DevOps, Monitor | **+ Engineer** (Staff Engineer / Software Architect Full-Stack), no mesmo nível que CTO |
| Fluxo inicial | CTO recebe spec → Charter → contrata PM(s) | CTO recebe spec → **fala com Engineer** → usa retorno para falar com PM(s) |
| Decisões | CTO define squads (Backend, Web, Mobile) | **Engineer** analisa spec e define **quais equipes/squads** (ex.: web básica, web avançada, backend API); CTO foca produto |
| Coordenação PMs | PMs reportam ao CTO | PMs **conversam entre si via CTO** (ex.: dependências; Web precisa de lista de URLs/endpoints da API) |
| Comunicação | Eventos e estados (task.assigned, qa.failed, etc.) | Agentes **vivos**, comunicação **contínua**; bloqueios repassados em cadeia (ex.: Web → PM → CTO → Engineer → solução → PM responsável → Dev) |
| Logs | Eventos técnicos (JSON, eventos) | **Log em linguagem humana** (LLM resume diálogos); histórico + tempo real para o usuário |
| Especialização | SYSTEM_PROMPT por agente | **+ skills.md por agente** (skills necessárias para atuar como especialista) |
| Genesis-Web status | Stepper linear (Spec → CTO → PM → Dev/QA → DevOps → Concluído) | **Diálogo dinâmico**: agentes com **nome, personalidade, avatar** (android, chip, processador, cores diversas); timeline de conversas em tempo real |

---

## 2. Novo ator: Engineer

### 2.1 Papel e posicionamento

- **Engineer** é **Staff Engineer / Software Architect Full-Stack**, com as competências descritas em [applications/agents/engineer/skills.md](../../applications/agents/engineer/skills.md) (Analista, Arquiteto, Desenvolvedor, Engenheiro Full Cycle + soft skills).
- **CTO** e **Engineer** estão no **mesmo nível**: CTO toma decisões de **produto** (escopo, prioridade, comunicação com SPEC); Engineer toma decisões **técnicas** (arquitetura, squads, tipos de equipe, dependências técnicas).
- Engineer **não** contrata PMs nem atribui tarefas; ele **analisa a spec** e devolve ao CTO uma **proposta técnica** (quais equipes/squads existentes do projeto são necessárias e como se relacionam).

### 2.2 Responsabilidades do Engineer

- Receber a **spec** (ou resumo) do CTO.
- **Analisar** requisitos e definir:
  - Quais **squads/equipes** o projeto precisa (ex.: equipe web básica para sites estáticos/landing pages; equipe web avançada para app web com API, auth, gestão; equipe backend para APIs).
  - Dependências entre equipes (ex.: Web SaaS depende de Backend API; necessidade de contrato de API: URLs, endpoints).
  - Recomendações técnicas (estilos arquiteturais, APIs, cloud, segurança) alinhadas ao [skills.md](../../applications/agents/engineer/skills.md).
- Entregar ao CTO um **artefato estruturado** (ex.: `ENGINEER_STACK_PROPOSAL.md` ou JSON) que o CTO usa para:
  - Contratar os PM(s) corretos (por squad/equipe).
  - Informar aos PMs dependências e contratos (ex.: “PM Web: obter lista de endpoints do PM Backend via CTO”).

### 2.3 Artefatos a criar

| Artefato | Descrição |
|----------|-----------|
| `applications/agents/engineer/SYSTEM_PROMPT.md` | Prompt do agente Engineer (papel, objetivo, regras, entradas/saídas, referência a skills.md). |
| Manter `applications/agents/engineer/skills.md` | Já existe; referenciado pelo SYSTEM_PROMPT. |
| Contrato de saída do Engineer | Ex.: `engineer_stack_proposal` (lista de squads/equipes, dependências, contratos de API sugeridos). |

### 2.4 Fluxo CTO ↔ Engineer

1. CTO recebe spec do SPEC (ou do portal).
2. CTO envia para o **Engineer**: spec (ou resumo) + contexto (constraints, cloud, etc.).
3. Engineer analisa e devolve: proposta de squads/equipes + dependências + recomendações técnicas.
4. CTO usa essa proposta para:
   - Gerar/atualizar Project Charter (visão produto + visão técnica).
   - Contratar PM(s) por squad/equipe definida pelo Engineer.
   - Delegar a cada PM com contexto de dependências (ex.: “PM Web: dependência do PM Backend; obter endpoints via mim”).

---

## 3. Novo fluxo de orquestração (alto nível)

### 3.1 Fase inicial (especificação → equipes)

```text
SPEC → CTO (spec)
       CTO → Engineer (spec/contexto)
       Engineer → CTO (proposta: squads, equipes, dependências)
       CTO → Charter + contrata PM(s) com base na proposta
       CTO → PM(s) (escopo + dependências; ex.: “PM Web precisa de endpoints do PM Backend; coordenar via mim”)
```

### 3.2 PMs conversam via CTO

- PMs **não** se comunicam diretamente entre si no modelo atual; a comunicação é **via CTO**.
- **Exemplo**: Projeto Web (SaaS) depende de Backend API. PM Web precisa da lista de URLs e endpoints para consumir.
  - PM Web pede ao **CTO**: “Preciso dos endpoints e URLs da API do Backend”.
  - CTO pergunta ao **PM Backend** (ou ao Monitor/Dev Backend): “Forneça lista de URLs e endpoints para o time Web”.
  - CTO repassa ao PM Web (e/ou ao Engineer se houver decisão técnica).
- CTO atua como **ponte** para dependências entre projetos/equipes.

### 3.3 Bloqueios e comunicação contínua (agentes “vivos”)

- Quando um **recurso falha** e a **responsabilidade é de outra equipe**, o problema deve ser **repassado como bloqueio** até a equipe responsável.
- **Exemplo**: Equipe Web consome um endpoint que falha.
  1. (Web) Dev/Monitor detecta falha → informa ao **PM Web**.
  2. **PM Web** informa ao **CTO** (bloqueio: endpoint X falhou).
  3. **CTO** informa ao **Engineer** (ou ao PM Backend, conforme caso).
  4. **Engineer** analisa e devolve **solução/recomendação** ao CTO (ex.: correção no Backend, contrato de API, retry).
  5. **CTO** fala com o **PM da equipe responsável** (ex.: PM Backend).
  6. **PM Backend** informa ao **Dev** (e/ou Monitor) para realizar a correção.
  7. Dev realiza e o fluxo segue (QA, etc.).
- Todos os agentes devem ser tratados como **vivos**, com **comunicação contínua** (simulando uma equipe humana), não apenas eventos pontuais.

### 3.4 Eventos e estado

- Estender o [ORCHESTRATOR_BLUEPRINT](ORCHESTRATOR_BLUEPRINT.md) com:
  - Eventos de **diálogo** (ex.: `cto.engineer.request`, `engineer.cto.response`, `pm.cto.dependency_request`, `block.reported`, `block.resolved`).
  - Estado de **bloqueio** por task/equipe (quem reportou, quem é responsável, status da solução).
- Manter compatibilidade com a [TASK_STATE_MACHINE](TASK_STATE_MACHINE.md) (ex.: BLOCKED quando há bloqueio cross-team).

---

## 4. Logs em linguagem humana e formato para o usuário

### 4.1 Objetivo

- **Toda a comunicação** entre agentes deve ser **logada** de forma que o **usuário** (SPEC ou operador) possa:
  - Entender **o que** os agentes estão fazendo e **o que** disseram.
  - Ver **histórico** e **diálogo em tempo real**.
- Usar **LLM** para produzir um **texto humano**: breve, compreensível, em linguagem natural (não apenas JSON ou eventos crus).

### 4.2 Modelo de log sugerido

- **Evento técnico** (ex.: CTO chamou Engineer com spec_ref X) → **versão “humana”** gerada por LLM, ex.:
  - “O CTO enviou a especificação do projeto ao Engineer para definir as equipes técnicas necessárias.”
- Cada mensagem entre agentes pode ter:
  - **Payload técnico** (request_id, from_agent, to_agent, payload, timestamp).
  - **summary_human** (texto curto gerado por LLM descrevendo a ação/fala em linguagem natural).
- **Formato persistido** (ex.: JSONL ou tabela):
  - `timestamp`, `from_agent`, `to_agent`, `event_type`, `payload_ref`, `summary_human`, `project_id`, `request_id`.
- **API** para o Genesis-Web:
  - `GET /api/projects/:id/dialogue` ou `GET /api/projects/:id/timeline`: lista ordenada de entradas com `summary_human` para exibição.
  - Opcional: **SSE ou WebSocket** para **tempo real** (novas entradas à medida que os agentes “conversam”).

### 4.3 Pipeline de geração do texto humano

1. Após cada interação entre agentes (ex.: CTO → Engineer, Engineer → CTO, PM → CTO), o orquestrador chama um **serviço de resumo** (LLM) com:
   - from_agent, to_agent, payload resumido (sem tokens sensíveis em excesso).
2. LLM retorna uma frase ou parágrafo curto em português.
3. Orquestrador persiste no **log de diálogo** do projeto.

---

## 5. skills.md por agente

### 5.1 Objetivo

- Hoje existe **skills.md** apenas para o **Engineer** ([applications/agents/engineer/skills.md](../../applications/agents/engineer/skills.md)).
- **Estender** o conceito: um arquivo **skills.md** (ou equivalente) para **cada agente**, descrevendo as **skills necessárias** para que ele atue como especialista e para melhorar o entendimento de **como** ele deve pensar e atuar.

### 5.2 Onde criar

| Agente | Arquivo sugerido | Conteúdo (resumo) |
|--------|------------------|-------------------|
| CTO | `applications/agents/cto/skills.md` | Produto, visão de negócio, priorização, comunicação com SPEC e PMs, decisão de escopo. |
| Engineer | Já existe | Staff Engineer, arquitetura, squads, dependências técnicas. |
| PM (por squad) | `applications/agents/pm/backend/skills.md` (e web, mobile) | Backlog, FR/NFR, gestão de equipe virtual, DoD, coordenação com CTO e Monitor. |
| Dev (por skill) | ex. `applications/agents/dev/backend/nodejs/skills.md` | Clean code, testes, stack específica (Node, React, etc.). |
| QA (por skill) | ex. `applications/agents/qa/backend/nodejs/skills.md` | Testes, automação, critérios de aceite, relatório de bugs. |
| DevOps (por cloud) | ex. `applications/agents/devops/docker/skills.md` | IaC, CI/CD, containers, observabilidade. |
| Monitor | ex. `applications/agents/monitor/backend/skills.md` | Acompanhamento de progresso, detecção de bloqueios, orquestração Dev–QA–DevOps. |

- Cada **SYSTEM_PROMPT.md** do agente deve **referenciar** o seu `skills.md` (ex.: “Suas competências estão em [skills.md](skills.md).”).

### 5.3 Conteúdo típico de um skills.md

- **Persona** (1–2 frases).
- **Competências técnicas e de processo** (bullets).
- **Comportamento esperado** (como pensar, como se comunicar, com quem).
- **Referências** (DoD, contratos, outros docs).

---

## 6. Genesis-Web: tela de acompanhamento dinâmica

### 6.1 Situação atual

- Tela de detalhe do projeto ([projects/[id]](../../applications/apps/genesis-web/app/(dashboard)/projects/[id]/page.tsx)): **Stepper linear** (Spec enviada → CTO (Charter) → PM (Backlog) → Dev/QA/Monitor → DevOps → Concluído) e status simples.
- Não reflete a **dinâmica real** (vários agentes conversando, bloqueios, dependências).

### 6.2 Objetivo

- Usar os **logs de diálogo** (com `summary_human`) para exibir na tela de acompanhamento do projeto:
  - **Timeline** ou **feed** de mensagens em **linguagem humana**, em **tempo real** (ou quasi real-time via polling/SSE).
  - **Agentes com identidade**: nome, personalidade (curta descrição), **avatar único** (imagem: android, chip, processador, etc., em **cores diversas**).

### 6.3 Especificação de agentes (identidade visual)

- Cada agente (CTO, Engineer, PM Backend, PM Web, PM Mobile, Dev, QA, DevOps, Monitor) deve ter:
  - **id** (ex.: `cto`, `engineer`, `pm`, `pm_web`, `dev`, `dev_backend_nodejs`, …).
  - **nome** (ex.: “Alex CTO”, “Eng. Sam”, “PM Backend”, …).
  - **personalidade** (uma linha para exibição, ex.: “Foco em produto e priorização.”).
  - **avatar**: URL de imagem ou identificador de asset (android, chip, processador, ícone) e **cor** predominante (para borda, badge, etc.).
- Configuração pode ficar em JSON no front (ex.: `lib/agentProfiles.ts`) ou vinda da API (ex.: `GET /api/agents/profiles`).

### 6.4 UI sugerida para a tela de status do projeto

- **Seção 1 – Resumo**: Mantém ou adapta o Stepper/status atual (spec, charter, backlog, dev, devops, concluído) como visão de alto nível.
- **Seção 2 – Diálogo da equipe**:
  - Título: “Diálogo da equipe” ou “O que está acontecendo”.
  - Lista (ou timeline) de itens, cada um com:
    - **Avatar** + **nome** do agente (e opcionalmente cor).
    - **Texto** = `summary_human` do log.
    - **Timestamp**.
  - Ordenação: mais recente no topo ou no final, conforme UX.
  - Atualização: polling (ex.: a cada 5–10 s) ou **SSE/WebSocket** para novos eventos.
- **Seção 3** (opcional): Bloqueios ativos (lista de bloqueios reportados e responsável).

### 6.5 API necessária no backend

- **Log de diálogo**:
  - `POST /api/projects/:id/dialogue` (ou interno apenas pelo orquestrador): inserir entrada com `summary_human`, from_agent, to_agent, timestamp.
  - `GET /api/projects/:id/dialogue` ou `GET /api/projects/:id/timeline`: listar entradas para o projeto (paginação se necessário).
- **Tempo real** (opcional): SSE em `GET /api/projects/:id/dialogue/stream` ou WebSocket por projeto.

---

## 7. Checklist de implementação (plano de aplicação)

### Fase 1: Engineer e fluxo CTO ↔ Engineer

- [x] Criar `applications/agents/engineer/SYSTEM_PROMPT.md` (referenciando [skills.md](../../applications/agents/engineer/skills.md)).
- [x] Definir contrato de saída do Engineer (ex.: `engineer_stack_proposal` com squads, equipes, dependências).
- [x] Implementar agente Engineer no orquestrador (módulo Python + endpoint HTTP se aplicável).
- [x] Alterar fluxo do runner (ou serviço equivalente): CTO recebe spec → chama Engineer → usa resposta para Charter e contratação de PM(s).
- [x] Atualizar [ACTORS_AND_RESPONSIBILITIES.md](ACTORS_AND_RESPONSIBILITIES.md): adicionar Engineer, hierarquia CTO ↔ Engineer, tabela de comunicação.
- [x] Atualizar [ORCHESTRATION_GUIDE.md](ORCHESTRATION_GUIDE.md) e [AGENTS_CAPABILITIES.md](AGENTS_CAPABILITIES.md).
- [x] Atualizar diagramas (Mermaid) em ACTORS e ARCHITECTURE com Engineer.

### Fase 2: PMs via CTO e bloqueios cross-team

- [x] Documentar regra: PMs conversam via CTO (ex.: pedido de endpoints/URLs do Backend para o Web).
- [x] Implementar fluxo de bloqueio: origem (ex.: PM Web) → CTO → Engineer ou PM responsável → solução → repasse ao Dev.
- [x] Estender ORCHESTRATOR_BLUEPRINT com eventos de diálogo e bloqueio (`block.reported`, `block.resolved`, etc.).
- [x] Atualizar TASK_STATE_MACHINE se necessário (BLOCKED por dependência cross-team).

### Fase 3: Log em linguagem humana

- [x] Definir esquema de armazenamento do log de diálogo (tabela ou JSONL: timestamp, from_agent, to_agent, summary_human, project_id, request_id).
- [x] Implementar serviço de resumo: templates em português por evento; opcional `SUMMARY_LLM_URL` para LLM externo (entrada = from, to, payload; saída = summary_human).
- [x] Integrar no orquestrador: após cada interação relevante (Engineer↔CTO, CTO→PM, PM→CTO), gerar summary e persistir via POST /api/projects/:id/dialogue quando API_BASE_URL e PROJECT_ID estão definidos.
- [x] Expor API: `GET /api/projects/:id/dialogue` (e opcionalmente stream para tempo real).

### Fase 4: skills.md por agente

- [x] Criar `skills.md` para CTO, PM (backend/web/mobile), Dev (por skill), QA (por skill), DevOps (por tipo), Monitor (por squad).
- [x] Atualizar cada `SYSTEM_PROMPT.md` para referenciar o `skills.md` correspondente.

### Fase 5: Genesis-Web – diálogo e avatares

- [x] Definir perfis de agentes (id, nome, personalidade, avatar, cor) em front ou API.
- [x] Criar componente de “item de diálogo” (avatar + nome + texto + timestamp).
- [x] Na tela de detalhe do projeto, adicionar seção “Diálogo da equipe” consumindo `GET /api/projects/:id/dialogue`.
- [x] Implementar atualização periódica (polling) ou SSE/WebSocket para tempo real.
- [x] (Opcional) Ajustar Stepper/status para refletir estados que incluam “Engineer” e bloqueios.

### Fase 6: Documentação e testes

- [x] Atualizar [NAVIGATION.md](NAVIGATION.md) e índices com link para este plano.
- [x] Revisar [DEVOPS_SELECTION.md](DEVOPS_SELECTION.md) e outros docs se o Engineer influenciar escolha de squads (contexto Engineer + PM; seleção DevOps permanece com o PM).
- [x] Testes de integração: módulo de diálogo e resumos em português ([orchestrator/tests/test_runner_dialogue.py](../../applications/orchestrator/tests/test_runner_dialogue.py)); fluxo completo CTO → Engineer → CTO → PM(s) pode ser validado com mocks em testes futuros.

---

## 8. Referências

| Documento | Uso |
|-----------|-----|
| [ACTORS_AND_RESPONSIBILITIES.md](ACTORS_AND_RESPONSIBILITIES.md) | Atualizar com Engineer e nova hierarquia. |
| [ORCHESTRATION_GUIDE.md](ORCHESTRATION_GUIDE.md) | Incluir passo CTO ↔ Engineer e PMs via CTO. |
| [ORCHESTRATOR_BLUEPRINT.md](ORCHESTRATOR_BLUEPRINT.md) | Novos eventos e regras de bloqueio. |
| [AGENTS_CAPABILITIES.md](AGENTS_CAPABILITIES.md) | Adicionar seção Engineer. |
| [applications/agents/engineer/skills.md](../../applications/agents/engineer/skills.md) | Base do perfil do Engineer. |
| [TASK_STATE_MACHINE.md](TASK_STATE_MACHINE.md) | BLOCKED e dependências cross-team. |
| Genesis-Web [projects/[id]/page.tsx](../../applications/apps/genesis-web/app/(dashboard)/projects/[id]/page.tsx) | Tela a evoluir para diálogo + avatares. |

---

*Documento criado como plano de aplicação das diretrizes: Engineer, novo fluxo, comunicação contínua, logs em linguagem humana, skills por agente e Genesis-Web dinâmico.*
