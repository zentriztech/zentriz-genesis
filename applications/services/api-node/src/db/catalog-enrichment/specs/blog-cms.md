# Blog com CMS

## 0. Metadados
- **Produto:** ContentHub — plataforma de blog com CMS para publicação e gestão de conteúdo
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que criadores de conteúdo publiquem artigos com editor rico, organizem por categorias e tags, e otimizem SEO para alcançar maior audiência. O sistema oferece moderação de comentários e sitemap automático.

## 2. Personas
- Editor de conteúdo — cria e publica artigos, gerencia rascunhos e agenda publicações.
- Moderador — revisa e aprova comentários antes de publicá-los.
- Leitor — consome artigos, deixa comentários e navega por categorias.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado como editor, QUANDO informa credenciais válidas, ENTÃO recebe token e acessa o painel de administração.

### FR-02 — Criação e edição de posts
DADO um editor autenticado, QUANDO cria um post com título único e conteúdo markdown, ENTÃO o sistema salva como rascunho e permite prévia.

### FR-03 — Publicação agendada
DADO um post em rascunho, QUANDO o editor define data/hora futura e publica, ENTÃO o post permanece oculto até o momento agendado.

### FR-04 — Categorias e tags
DADO um editor, QUANDO associa categorias e tags a um post, ENTÃO elas aparecem na página pública e permitem navegação filtrada.

### FR-05 — Comentários moderados
DADO um leitor autenticado, QUANDO envia comentário em post público, ENTÃO ele fica pendente até aprovação do moderador.

### FR-06 — SEO e sitemap
DADO um post publicado, QUANDO o sistema gera sitemap, ENTÃO inclui URL, título, descrição e data de atualização para indexação em buscadores.

### FR-07 — Listagem pública com paginação
DADO um visitante, QUANDO acessa a home, ENTÃO vê os últimos 10 posts publicados ordenados por data decrescente com paginação.

## 4. Requisitos Não-Funcionais
- API responde em < 300ms p95; disponibilidade 99,5%. Conteúdo cacheável em CDN. Markdown sanitizado contra XSS. Dados pessoais de comentaristas (email) nunca aparecem em logs.

## 5. Regras de Negócio
- Título de post único por blog. Post agendado só aparece após data/hora. Comentário reprovado não reaparece. Slug gerado automaticamente do título (normalizado, sem acentos).

## 6. Modelo de Dados
- posts(id, title, slug, content, status, scheduled_at, published_at, author_id)
- categories(id, name, slug)
- tags(id, name, slug)
- post_categories(post_id, category_id)
- post_tags(post_id, tag_id)
- comments(id, post_id, author_name, author_email, content, status, created_at)

## 7. Stack sugerida
- Frontend: Next.js 14 App Router + MUI 7 + react-markdown. Backend: Fastify + PostgreSQL + Redis (cache). Editor: MDX ou TipTap.
