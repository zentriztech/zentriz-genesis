# Plataforma de Gestão de Redes Sociais

## 0. Metadados
- **Produto:** SocialHub — agendamento e análise de desempenho multicanal para redes sociais
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Centralizar criação, agendamento e publicação de conteúdo em múltiplas redes sociais, com análise de métricas de alcance e engajamento. Reduz tempo de gestão e melhora consistência da presença digital.

## 2. Personas
- Social media manager — agenda posts, monitora métricas e ajusta estratégia de conteúdo.
- Designer de conteúdo — cria artes e textos para os posts.
- Cliente final — aprova previamente os posts antes da publicação.

## 3. Requisitos Funcionais (FR)

### FR-01 — Conexão de contas de redes sociais
DADO um usuário autenticado, QUANDO autoriza conexão via OAuth com Instagram, Facebook, LinkedIn ou Twitter, ENTÃO o sistema armazena token de acesso e exibe a conta como conectada.

### FR-02 — Criação e agendamento de post
DADO uma conta conectada, QUANDO o usuário cria post com texto, imagem e seleciona data/hora futura, ENTÃO o post é salvo com status "agendado" e aparece no calendário.

### FR-03 — Pré-visualização multicanal
DADO um post criado, QUANDO o usuário solicita pré-visualização, ENTÃO o sistema renderiza como ficará em cada rede social conectada (formato de imagem, limite de caracteres).

### FR-04 — Publicação automática na data agendada
DADO um post com status "agendado" e data/hora atual >= agendamento, QUANDO o worker de publicação roda, ENTÃO publica via API de cada rede e atualiza status para "publicado".

### FR-05 — Coleta de métricas de desempenho
DADO posts publicados, QUANDO o worker de métricas sincroniza (a cada 6h), ENTÃO busca impressões, curtidas, comentários e compartilhamentos de cada rede e persiste no histórico.

### FR-06 — Dashboard analítico com filtros
DADO um usuário autenticado, QUANDO acessa o dashboard, ENTÃO visualiza gráficos de engajamento por rede, melhor horário de publicação e comparação entre períodos.

### FR-07 — Fluxo de aprovação de posts
DADO um post criado em conta com aprovação habilitada, QUANDO o criador submete para aprovação, ENTÃO o cliente recebe notificação, revisa e pode aprovar ou solicitar ajustes.

## 4. Requisitos Não-Funcionais
- Sincronização de métricas < 10min após publicação.
- Suporte a 50 contas conectadas por workspace.
- Disponibilidade de 99% para agendamento e 95% para publicação (dependência de APIs externas).
- Retry em falha de publicação com 3 tentativas em 15min.

## 5. Regras de Negócio
- Post agendado para menos de 10 minutos no futuro é rejeitado.
- Falha em publicação gera alerta imediato ao social media manager.
- Imagem acima de 5MB é redimensionada antes do upload.
- Histórico de métricas mantido por 12 meses.

## 6. Modelo de Dados
- workspaces(id, name, plan)
- social_accounts(id, workspace_id, platform, username, access_token, refresh_token)
- posts(id, workspace_id, content, media_url, scheduled_for, status, approval_required)
- post_publications(id, post_id, account_id, published_at, external_id, status)
- metrics(id, publication_id, impressions, likes, comments, shares, collected_at)
- users(id, workspace_id, email, role)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI 7 + recharts.
- Backend: Fastify + PostgreSQL.
- Workers: Bull para publicação e coleta de métricas.
- Integração: APIs oficiais Instagram Graph, Facebook Graph, LinkedIn Share, Twitter v2.
