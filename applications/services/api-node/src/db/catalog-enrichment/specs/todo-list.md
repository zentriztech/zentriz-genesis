# Lista de Tarefas

## 0. Metadados
- **Produto:** TaskMate — gerenciador de tarefas pessoais com autenticação
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que usuários organizem tarefas pessoais, marquem como concluídas e filtrem por status, com sincronização em tempo real.

## 2. Personas
- Usuário final — organiza tarefas diárias, marca como feitas e consulta pendências.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro e login de usuário
DADO um visitante, QUANDO preenche e-mail e senha e confirma cadastro, ENTÃO recebe e-mail de boas-vindas e pode fazer login.

### FR-02 — Criar tarefa
DADO um usuário autenticado, QUANDO digita título "Comprar leite" e pressiona Enter, ENTÃO a tarefa é criada como pendente e aparece no topo da lista.

### FR-03 — Marcar tarefa como concluída
DADO um usuário com tarefa pendente, QUANDO clica no checkbox da tarefa, ENTÃO ela é marcada como concluída e risca o texto.

### FR-04 — Editar tarefa
DADO um usuário com tarefa criada, QUANDO clica no título e altera para "Comprar leite integral", ENTÃO a alteração é salva automaticamente.

### FR-05 — Excluir tarefa
DADO um usuário com tarefa criada, QUANDO clica no botão excluir, ENTÃO a tarefa é removida permanentemente após confirmação.

### FR-06 — Filtrar por status
DADO um usuário com 10 tarefas (5 concluídas, 5 pendentes), QUANDO seleciona filtro "Concluídas", ENTÃO visualiza apenas as 5 tarefas concluídas.

### FR-07 — Sincronização em tempo real
DADO um usuário logado em dois dispositivos, QUANDO cria tarefa no celular, ENTÃO ela aparece no navegador desktop em até 2 segundos.

## 4. Requisitos Não-Funcionais
- API com latência < 300ms p95. Sincronização via WebSocket. Disponibilidade 99%. Senha com bcrypt e salting. LGPD: usuário pode exportar ou deletar dados.

## 5. Regras de Negócio
- Tarefa sem título não é criada. Tarefa concluída pode ser desmarcada. Exclusão é permanente (sem lixeira). Usuário só vê suas próprias tarefas.

## 6. Modelo de Dados
- users(id, email, password_hash, created_at)
- tasks(id, user_id, title, completed, created_at, updated_at)

## 7. Stack sugerida
- Frontend: Next.js 14 com WebSocket client. Backend: Fastify + PostgreSQL + Socket.io para sincronização em tempo real. Autenticação: JWT.
