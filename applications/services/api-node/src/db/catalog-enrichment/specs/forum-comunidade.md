# Fórum e Comunidade

## 0. Metadados
- **Produto:** ForumHub — plataforma de discussão com tópicos, respostas, votos e sistema de reputação
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Criar um espaço de discussão organizado por categorias onde membros compartilham perguntas, respondem tópicos, votam nas melhores contribuições e ganham reputação, incentivando engajamento e moderação comunitária.

## 2. Personas
- Membro iniciante — faz perguntas, lê respostas e vota em conteúdo útil.
- Membro experiente — responde tópicos, ganha reputação e distintivos por contribuições de qualidade.
- Moderador — revisa denúncias, remove conteúdo inadequado e aplica suspensões.

## 3. Requisitos Funcionais (FR)

### FR-01 — Categorias e tópicos
DADO um membro autenticado, QUANDO cria um tópico em uma categoria, ENTÃO o tópico é publicado com título, corpo em Markdown, tags e fica visível na lista ordenada por recência ou relevância.

### FR-02 — Respostas com votos
DADO um membro em um tópico, QUANDO publica uma resposta, ENTÃO ela aparece abaixo do tópico e outros membros podem votar positivo (+1 reputação ao autor) ou negativo (-1 reputação, custo de 1 ponto de reputação ao votante).

### FR-03 — Melhor resposta aceita pelo autor
DADO o autor de um tópico, QUANDO marca uma resposta como aceita, ENTÃO a resposta aparece destacada no topo, o autor da resposta ganha +15 reputação e o tópico é marcado como "resolvido".

### FR-04 — Sistema de reputação e distintivos
DADO um membro que acumula pontos de reputação, QUANDO atinge marcos (10/50/100/500 pontos ou 5 respostas aceitas), ENTÃO recebe distintivo visível no perfil e desbloqueia privilégios (editar posts de terceiros acima de 500 pontos).

### FR-05 — Moderação e denúncia
DADO um membro ao visualizar conteúdo ofensivo, QUANDO denuncia com motivo (spam, ofensa, conteúdo inapropriado), ENTÃO a denúncia entra na fila de moderação e, se aprovada pelo moderador, o post é removido e o autor recebe advertência.

### FR-06 — Busca e filtros avançados
DADO um membro na busca, QUANDO digita palavras-chave e aplica filtros (categoria, tags, respondido/não respondido, período), ENTÃO visualiza lista paginada de tópicos relevantes ordenados por score ou data.

### FR-07 — Notificações de atividade
DADO um membro autor de tópico ou resposta, QUANDO outro membro responde ou comenta, ENTÃO o autor recebe notificação por e-mail e na plataforma (badge com contador não lido).

## 4. Requisitos Não-Funcionais
- API com p95 < 500ms; busca full-text com latência < 300ms usando índice PostgreSQL ou Elasticsearch.
- Disponibilidade 99,5%. Cache de tópicos populares em Redis para reduzir carga no DB.
- LGPD: e-mail de membro visível apenas no perfil privado, nunca exposto publicamente. Denúncias com log de auditoria.

## 5. Regras de Negócio
- Voto negativo custa 1 ponto de reputação ao votante (evita abuso); voto positivo é gratuito.
- Tópico sem atividade há 6 meses é arquivado automaticamente (somente leitura, sem novas respostas).
- Moderador pode suspender membro por 7/30 dias ou permanentemente; suspensão permanente exige aprovação de admin.

## 6. Modelo de Dados
- categories(id, name, slug, description, order)
- topics(id, category_id, author_id, title, body_markdown, tags, views, status, accepted_answer_id, created_at)
- posts(id, topic_id, author_id, body_markdown, votes_count, is_accepted, created_at)
- votes(id, post_id, user_id, vote_type, created_at)
- members(id, username, email, reputation, badges_json, status, created_at)
- reports(id, post_id, reporter_id, reason, status, reviewed_by, reviewed_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para listagem de tópicos, editor Markdown e perfil de membro.
- Backend: Fastify + PostgreSQL com índice full-text (pg_trgm, tsvector) para busca.
- Cache: Redis para ranking de tópicos populares e contadores de reputação.
- Worker: Node.js com Bull (Redis) para envio de notificações e arquivamento de tópicos inativos.
