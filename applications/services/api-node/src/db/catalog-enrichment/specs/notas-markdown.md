# Notas em Markdown

## 0. Metadados
- **Produto:** NoteFlow — aplicação de notas pessoais com edição em Markdown
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que usuários criem, editem e organizem notas com sintaxe Markdown, busca eficiente por conteúdo e etiquetas, e sincronização entre dispositivos, oferecendo produtividade e controle total dos dados.

## 2. Personas
- Estudante — cria notas de aula com formatação rica e organiza por matéria.
- Desenvolvedor — salva snippets de código e documenta projetos.
- Profissional — organiza tarefas e ideias com etiquetas e busca rápida.

## 3. Requisitos Funcionais (FR)

### FR-01 — Criar e editar nota
DADO um usuário autenticado, QUANDO cria uma nota com título e conteúdo em Markdown, ENTÃO ela é salva automaticamente a cada 3 segundos e fica disponível na lista de notas.

### FR-02 — Preview de Markdown em tempo real
DADO um usuário editando uma nota, QUANDO alterna para o modo "Preview", ENTÃO o conteúdo é renderizado como HTML com suporte a títulos, listas, código, links e imagens.

### FR-03 — Etiquetas e organização
DADO um usuário criando uma nota, QUANDO adiciona etiquetas (ex.: #trabalho, #pessoal), ENTÃO pode filtrar todas as notas por etiqueta na barra lateral.

### FR-04 — Busca por conteúdo
DADO um usuário com múltiplas notas, QUANDO digita um termo na busca, ENTÃO o sistema retorna notas que contêm o termo no título ou corpo, destacando o trecho correspondente.

### FR-05 — Excluir nota
DADO um usuário visualizando uma nota, QUANDO clica em "Excluir" e confirma, ENTÃO a nota é movida para a lixeira por 30 dias antes da exclusão definitiva.

### FR-06 — Sincronização entre dispositivos
DADO um usuário logado em dois dispositivos, QUANDO cria ou edita uma nota em um dispositivo, ENTÃO a alteração é sincronizada em tempo real (via WebSocket) no outro dispositivo.

## 4. Requisitos Não-Funcionais
- Editor responsivo com syntax highlighting para código. Busca full-text com índice otimizado. API < 300ms p95. Sincronização via WebSocket. Backup diário. Disponibilidade 99%. LGPD: conteúdo das notas criptografado em repouso.

## 5. Regras de Negócio
- Nota sem título recebe nome automático "Nota sem título - [data]".
- Etiquetas são case-insensitive (ex.: #Trabalho = #trabalho).
- Nota na lixeira é excluída definitivamente após 30 dias automaticamente.

## 6. Modelo de Dados
- notes(id, user_id, title, content_markdown, created_at, updated_at, deleted_at)
- tags(id, name)
- note_tags(id, note_id, tag_id)
- sync_log(id, note_id, user_id, action, synced_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + editor Markdown (react-markdown + CodeMirror). Backend: Fastify + PostgreSQL com extensão pg_trgm para busca full-text. Sincronização: WebSocket (Socket.io ou nativo). Criptografia: AES-256 para conteúdo.
