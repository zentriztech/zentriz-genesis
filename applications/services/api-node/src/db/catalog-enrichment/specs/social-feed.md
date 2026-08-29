# Rede Social com Feed

## 0. Metadados
- **Produto:** ConnectHub — rede social com perfis, feed cronológico, curtidas, comentários e sistema de seguidores
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma social para usuários criarem perfil, publicarem conteúdo (texto, imagens, vídeos), interagirem via curtidas e comentários, e seguirem outros usuários para consumir feed personalizado, construindo comunidades e engajamento em torno de interesses comuns.

## 2. Personas
- Usuário criador de conteúdo — publica posts, fotos e vídeos, responde comentários e acompanha métricas de engajamento.
- Usuário consumidor — segue perfis de interesse, consome feed cronológico, curte e comenta posts.
- Moderador — monitora denúncias, remove conteúdo impróprio e aplica sanções em perfis que violam termos de uso.

## 3. Requisitos Funcionais (FR)
### FR-01 — Cadastro e autenticação de usuários
DADO um visitante no site, QUANDO preenche formulário de cadastro informando nome, e-mail único, senha e data de nascimento (mínimo 13 anos), ENTÃO o sistema registra o usuário com perfil público vazio, envia e-mail de confirmação e permite login com credenciais.

### FR-02 — Perfil de usuário e edição de dados
DADO um usuário autenticado, QUANDO acessa a página de perfil e edita foto de perfil, bio de até 160 caracteres e cidade, ENTÃO o sistema valida o upload de imagem (máximo 2MB, formatos JPG/PNG), salva as alterações e exibe no perfil público.

### FR-03 — Seguir e deixar de seguir usuários
DADO um usuário A visualizando o perfil de um usuário B, QUANDO clica em "Seguir", ENTÃO o sistema registra o relacionamento de follow, incrementa contador de seguidores de B e seguindo de A, e posts de B passam a aparecer no feed de A; "Deixar de seguir" desfaz o relacionamento.

### FR-04 — Publicação de posts com texto e mídia
DADO um usuário autenticado, QUANDO cria um post informando texto de até 500 caracteres e opcionalmente anexando até 4 imagens ou 1 vídeo (máximo 50MB), ENTÃO o sistema valida o conteúdo, processa upload de mídia, registra o post com timestamp e o exibe no perfil do autor e feed dos seguidores.

### FR-05 — Feed cronológico dos perfis seguidos
DADO um usuário autenticado, QUANDO acessa a home, ENTÃO o sistema carrega feed paginado com posts dos perfis que o usuário segue, ordenados por data de publicação decrescente (mais recentes primeiro), exibindo autor, texto, mídia, contadores de curtidas e comentários.

### FR-06 — Curtidas em posts
DADO um usuário visualizando um post no feed ou perfil, QUANDO clica no ícone de curtida, ENTÃO o sistema registra a curtida única por usuário/post, incrementa o contador de curtidas do post e notifica o autor; clicar novamente remove a curtida.

### FR-07 — Comentários em posts
DADO um usuário visualizando um post, QUANDO escreve um comentário de até 200 caracteres e envia, ENTÃO o sistema registra o comentário vinculado ao post, incrementa contador de comentários, notifica o autor do post e exibe o comentário abaixo do post ordenado por data.

## 4. Requisitos Não-Funcionais
- Feed carregado em < 500ms p95; cache de timeline com invalidação ao publicar novo post.
- Upload de imagens com resize automático para thumbnail (300px) e alta resolução (1080px); vídeos processados de forma assíncrona.
- Disponibilidade 99,9%; mídia servida via CDN.
- Dados de IP, localização e atividades sensíveis (denúncias, bloqueios) não expostos publicamente; acesso restrito a moderadores.

## 5. Regras de Negócio
- Um usuário não pode seguir a si mesmo; tentativa de auto-follow é bloqueada.
- Posts podem ser deletados pelo autor a qualquer momento; comentários e curtidas vinculados são removidos em cascata.
- Perfis privados (configurável) exigem aprovação do seguidor; posts só aparecem no feed após aceitação.
- Comentários podem ser reportados por qualquer usuário; 3 denúncias acionam revisão de moderador; conteúdo impróprio resulta em remoção e advertência ao autor.
- Curtidas e comentários em posts de perfis que o usuário não segue não geram notificação (evita spam de interação).

## 6. Modelo de Dados
- users(id, email, username, password_hash, display_name, bio, profile_picture_url, city, birthdate, is_private, created_at)
- follows(id, follower_user_id, followed_user_id, created_at)
- posts(id, author_user_id, text_content, created_at, updated_at, status)
- post_media(id, post_id, media_url, media_type, display_order)
- likes(id, post_id, user_id, created_at)
- comments(id, post_id, author_user_id, text_content, created_at)
- reports(id, content_type, content_id, reporter_user_id, reason, status, reviewed_by_user_id, reviewed_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI + Infinite scroll (react-infinite-scroll). Backend: Fastify + PostgreSQL + Redis (cache de feed e contadores). Storage: S3 + CloudFront. Processamento de vídeo: AWS MediaConvert ou FFmpeg assíncrono via SQS. Auth JWT.
