# Gestão de Projetos com Gantt

## 0. Metadados
- **Produto:** ProjectGantt — plataforma de planejamento e acompanhamento de projetos com cronograma visual, dependências e marcos
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Facilitar o planejamento e controle de projetos complexos com visualização de cronograma em gráfico de Gantt, identificação de caminho crítico e acompanhamento de progresso em tempo real.

## 2. Personas
- Gerente de projeto — cria cronograma, define dependências e monitora avanço.
- Membro da equipe — atualiza percentual concluído das tarefas atribuídas.
- Stakeholder — acompanha marcos e visualiza status geral do projeto.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis de projeto
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO acessa o sistema e visualiza projetos dos quais participa conforme seu perfil (gerente, membro ou stakeholder).

### FR-02 — Criação de projeto e estrutura de tarefas
DADO um gerente de projeto, QUANDO cria um projeto informando nome, data de início e objetivo, ENTÃO pode adicionar tarefas hierárquicas com título, responsável, data de início e data de término.

### FR-03 — Definição de dependências entre tarefas
DADO uma tarefa cadastrada, QUANDO o gerente define que ela depende de outra tarefa (tipo: fim-início, início-início, fim-fim), ENTÃO o sistema ajusta automaticamente as datas no cronograma caso a predecessora atrase.

### FR-04 — Visualização em gráfico de Gantt
DADO um projeto com tarefas e dependências, QUANDO o usuário acessa a visão de Gantt, ENTÃO visualiza barras coloridas representando duração de cada tarefa, setas de dependência e linha do tempo.

### FR-05 — Identificação de caminho crítico
DADO um cronograma completo, QUANDO o sistema calcula o caminho crítico, ENTÃO destaca em vermelho as tarefas cuja folga é zero e cujo atraso impacta a data final do projeto.

### FR-06 — Atualização de percentual concluído e atraso
DADO um membro da equipe, QUANDO atualiza o percentual concluído de sua tarefa, ENTÃO o sistema recalcula datas de tarefas dependentes e alerta o gerente se houver atraso no caminho crítico.

### FR-07 — Marcos e relatórios de progresso
DADO um projeto com marcos definidos (entrega de fase, reunião de validação), QUANDO um marco é atingido, ENTÃO o sistema notifica stakeholders e gera relatório de progresso acumulado.

## 4. Requisitos Não-Funcionais
- Interface responsiva; gráfico de Gantt renderizado em até 1 segundo para projetos com até 200 tarefas.
- Colaboração em tempo real: múltiplos usuários editando o projeto com sincronização via WebSocket.
- API deve responder requisições de cálculo de caminho crítico em menos de 500ms (p95).
- Exportação de cronograma em PDF e Excel para compartilhamento externo.

## 5. Regras de Negócio
- Tarefa com dependência não pode ter data de início anterior à data de término da predecessora.
- Percentual concluído só pode ser atualizado pelo responsável atribuído à tarefa ou pelo gerente do projeto.
- Atraso no caminho crítico aciona alerta automático ao gerente e stakeholders cadastrados.
- Projeto com todos os marcos cumpridos e 100% das tarefas concluídas muda status para "Encerrado".

## 6. Modelo de Dados
- projects(id, name, description, start_date, end_date, status, owner_id)
- tasks(id, project_id, title, description, start_date, end_date, assigned_to, percent_complete, is_milestone, parent_task_id)
- task_dependencies(id, predecessor_id, successor_id, dependency_type)
- project_members(id, project_id, user_id, role)
- critical_path(id, project_id, task_id, slack_days)
- milestones(id, project_id, name, target_date, completed_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI com biblioteca de Gantt interativo (react-gantt-chart ou dhtmlx-gantt).
- Backend: Fastify + PostgreSQL com algoritmo de cálculo de caminho crítico (CPM - Critical Path Method) implementado em TypeScript.
- Colaboração em tempo real: WebSocket (Socket.io) para sincronização de edições simultâneas.
