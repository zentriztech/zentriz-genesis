# Página de Links (Link in Bio)

## 0. Metadados
- **Produto:** LinkHub — agregador de links pessoais para redes sociais (link in bio)
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Oferecer uma página pública responsiva com avatar e múltiplos links clicáveis, acessível via slug único, com painel autenticado para edição e métricas de cliques.

## 2. Personas
- Criador de conteúdo — publica links de redes sociais, loja, portfólio e produtos na bio do Instagram.
- Visitante — acessa a página pública e clica em links de interesse.

## 3. Requisitos Funcionais (FR)

### FR-01 — Criação de página com slug único
DADO um criador autenticado, QUANDO cadastra uma página com slug "maria-silva", título e upload de avatar, ENTÃO a página é criada e fica acessível em `/maria-silva`.

### FR-02 — Página pública responsiva
DADO um visitante, QUANDO acessa `/maria-silva`, ENTÃO visualiza avatar circular, título, e lista vertical de links com ícone e rótulo, otimizada para mobile.

### FR-03 — Painel de edição de links
DADO um criador autenticado no painel, QUANDO adiciona um link com rótulo "Meu canal" e URL "https://youtube.com/...", ENTÃO o link aparece na página pública e pode ser reordenado por drag-and-drop.

### FR-04 — Métrica de cliques por link
DADO um link na página pública, QUANDO um visitante clica, ENTÃO o sistema incrementa o contador de cliques e exibe a métrica no painel do criador.

### FR-05 — Personalização visual
DADO um criador no painel, QUANDO escolhe uma cor de tema (ex: azul escuro) e estilo de botão (arredondado), ENTÃO a página pública reflete a customização imediatamente.

## 4. Requisitos Não-Funcionais
- Página pública carrega em < 1 segundo. Disponibilidade 99,9%. Slug único não pode ser alterado após criação (SEO). Cliques registrados sem PII do visitante (apenas contador anônimo).

## 5. Regras de Negócio
- Slug com 3-30 caracteres alfanuméricos e hífen, único no sistema. Página inativa não aparece em busca pública. Link sem URL válida não é salvo. Avatar limitado a 2MB (JPG/PNG).

## 6. Modelo de Dados
- pages(id, user_id, slug, titulo, avatar_url, tema_cor, ativo, created_at)
- links(id, page_id, rotulo, url, icone, ordem, cliques, ativo)

## 7. Stack sugerida
- Frontend: Next.js 14 (App Router) com páginas dinâmicas `[slug]`. Backend: API Routes do Next.js. Database: PostgreSQL. Upload de avatar: S3 ou Cloudinary. Autenticação: NextAuth.
