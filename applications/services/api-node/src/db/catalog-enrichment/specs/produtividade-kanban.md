# Quadro Kanban para Gestão de Tarefas

## 0. Metadados
- **Produto:** TaskBoard — ferramenta de produtividade com quadros Kanban colaborativos
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Organizar trabalho em quadros visuais com colunas configuráveis e cartões arrastáveis. Facilitar colaboração de equipes distribuídas com atribuição de tarefas, prazos e comentários em tempo real.

## 2. Personas
- Membro da equipe — cria cartões, move tarefas entre colunas e comenta progresso.
- Líder de projeto — configura quadros, define colunas e acompanha distribuição de trabalho.
- Observador — visualiza progresso sem editar (stakeholder, cliente).

## 3. Requisitos Funcionais (FR)

### FR-01 — Criação de quadros e colunas
DADO um líder de projeto autenticado, QUANDO cria quadro com nome e define colunas personalizadas (ex: Backlog, Em andamento, Revisão, Concluído), ENTÃO o quadro fica disponível para a equipe convidada.

### FR-02 — Criação de cartões
DADO um membro com acesso ao quadro, QUANDO cria cartão com título, descrição, etiqueta de prioridade e responsável, ENTÃO o cartão aparece na primeira coluna e fica visível para todos os membros.

### FR-03 — Arrastar cartões entre colunas
DADO um cartão em qualquer coluna, QUANDO o usuário arrasta o cartão para outra coluna, ENTÃO a mudança é salva imediatamente e refletida em tempo real para todos os usuários conectados.

### FR-04 — Atribuição e prazos
DADO um cartão existente, QUANDO o usuário atribui responsável e define data de vencimento, ENTÃO o cartão exibe avatar do responsável e destaca em vermelho cartões vencidos.

### FR-05 — Etiquetas e filtros
DADO um líder de projeto, QUANDO cria etiquetas personalizadas com cores (bug, feature, urgente), ENTÃO membros podem aplicar etiquetas aos cartões e filtrar visualização do quadro por etiqueta ou responsável.

### FR-06 — Comentários e menções
DADO um cartão aberto, QUANDO usuário adiciona comentário com menção a outro membro (@nome), ENTÃO o membro mencionado recebe notificação e o comentário aparece na linha do tempo do cartão.

### FR-07 — Histórico de movimentações
DADO um cartão com histórico, QUANDO qualquer usuário abre o cartão, ENTÃO visualiza log completo de mudanças de coluna, alterações de responsável e comentários com timestamps.

## 4. Requisitos Não-Funcionais
- Interface reflete mudanças de outros usuários em < 2 segundos (WebSocket ou polling curto).
- Disponibilidade de 99,5%.
- Suporte a até 50 usuários simultâneos por quadro e até 1.000 cartões por quadro.
- Dados de cartão (descrição, comentários) são privados ao workspace; acesso externo exige convite explícito.

## 5. Regras de Negócio
- Usuário só pode arrastar cartões em quadros onde tem permissão de edição; observadores têm acesso somente leitura.
- Cartão só pode estar em uma coluna por vez; mudança de coluna registra timestamp no histórico.
- Etiquetas são globais ao quadro; deletar etiqueta remove associação de todos os cartões mas não deleta os cartões.
- Comentário pode ser editado por 15 minutos após criação; após isso é imutável.

## 6. Modelo de Dados
- boards(id, workspace_id, title, created_by, created_at)
- columns(id, board_id, title, position)
- cards(id, column_id, title, description, assigned_to, due_date, created_by, created_at)
- labels(id, board_id, name, color)
- card_labels(card_id, label_id)
- comments(id, card_id, user_id, content, created_at, edited_at)
- card_history(id, card_id, event_type, from_value, to_value, changed_by, changed_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + React 19 + dnd-kit (drag-and-drop).
- Backend: Fastify + PostgreSQL (índices em board_id, column_id, assigned_to).
- Real-time: WebSocket (Socket.io) para sincronização de movimentações.
- Cache: Redis para estado do quadro em memória e reduzir latência.
