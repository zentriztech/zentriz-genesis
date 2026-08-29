# Streaming de Vídeo VOD

## 0. Metadados
- **Produto:** StreamPlay — plataforma de vídeo sob demanda com planos e controle de acesso
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Oferecer catálogo de vídeos sob demanda com transcodificação, player integrado e controle de acesso por plano de assinatura.

## 2. Personas
- Administrador — faz upload de vídeos, organiza catálogo e gerencia planos.
- Assinante — assiste vídeos do seu plano, retoma de onde parou e busca conteúdo.
- Visitante — navega no catálogo e assina um plano para acessar.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado, QUANDO informa e-mail e senha válidos, ENTÃO recebe token JWT e acessa o dashboard.

### FR-02 — Upload e transcodificação de vídeo
DADO um administrador autenticado, QUANDO faz upload de um arquivo de vídeo, ENTÃO o sistema enfileira a transcodificação e notifica quando o vídeo está disponível.

### FR-03 — Catálogo com categorias e busca
DADO um usuário autenticado, QUANDO acessa o catálogo, ENTÃO vê vídeos organizados por categoria e pode buscar por título ou tag.

### FR-04 — Player com controle de acesso por plano
DADO um assinante de plano Básico, QUANDO tenta assistir vídeo exclusivo do plano Premium, ENTÃO recebe mensagem de upgrade necessário.

### FR-05 — Continuar assistindo e histórico
DADO um assinante que pausou um vídeo no minuto 15, QUANDO volta ao catálogo, ENTÃO o vídeo exibe progresso e botão "Continuar".

### FR-06 — Assinatura e upgrade de plano
DADO um visitante, QUANDO escolhe plano Básico e confirma pagamento, ENTÃO sua conta é ativada com acesso aos vídeos do plano.

### FR-07 — Relatório de visualizações
DADO um administrador, QUANDO acessa relatórios, ENTÃO vê os vídeos mais assistidos e tempo médio de visualização.

## 4. Requisitos Não-Funcionais
- Transcodificação em até 10 minutos para vídeos de até 1 hora. Player com latência < 2s. Disponibilidade 99,5%. Vídeos servidos via CDN. PII (e-mail, histórico) nunca em logs.

## 5. Regras de Negócio
- Vídeo só disponível após transcodificação completa. Assinantes só acessam vídeos do seu plano ou inferior. Progresso salvo a cada 30 segundos. Cancelamento de plano mantém acesso até fim do período pago.

## 6. Modelo de Dados
- users(id, email, password_hash, plan_id, plan_expires_at)
- plans(id, name, price, tier)
- videos(id, title, duration, status, uploaded_by, required_plan_tier)
- categories(id, name)
- video_categories(video_id, category_id)
- watch_progress(id, user_id, video_id, seconds_watched, last_watched_at)

## 7. Stack sugerida
- Frontend: Next.js 14 com player Video.js. Backend: Fastify + PostgreSQL + fila RabbitMQ para transcodificação. Storage: S3 + CloudFront CDN. Transcodificação: FFmpeg em worker.
