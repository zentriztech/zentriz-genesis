# Hospedagem de Podcast

## 0. Metadados
- **Produto:** PodHost — plataforma de hospedagem e distribuição de podcasts
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Hospedar episódios de podcast com feed RSS automatizado, player embarcável e métricas de audiência para produtores de conteúdo.

## 2. Personas
- Produtor de podcast — faz upload de episódios e acompanha estatísticas de audiência.
- Ouvinte — consome episódios via player público ou agregadores RSS.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e gestão de programas
DADO um produtor cadastrado, QUANDO informa credenciais válidas, ENTÃO recebe token e acessa o painel de seus programas.

### FR-02 — Upload de episódio
DADO um produtor autenticado, QUANDO faz upload de áudio MP3 com título e descrição, ENTÃO o episódio é armazenado e publicado no feed RSS em até 2 minutos.

### FR-03 — Geração de feed RSS
DADO um programa com episódios publicados, QUANDO um agregador solicita o feed RSS, ENTÃO retorna XML compatível com Apple Podcasts e Spotify.

### FR-04 — Player público
DADO um episódio publicado, QUANDO um visitante acessa a URL pública do programa, ENTÃO carrega player web com lista de episódios e controles de reprodução.

### FR-05 — Métricas de audiência
DADO episódios com downloads e reproduções, QUANDO o produtor acessa estatísticas, ENTÃO exibe gráficos de downloads por episódio e retenção média nos últimos 30 dias.

### FR-06 — Transcrição automática
DADO um episódio recém-publicado, QUANDO o sistema processa o áudio, ENTÃO gera transcrição em texto e a disponibiliza no player e no RSS como conteúdo alternativo.

## 4. Requisitos Não-Funcionais
- Upload de áudio com até 500MB em menos de 5 minutos via CDN.
- Feed RSS com cache de 15 minutos; 99,9% de disponibilidade.
- Player responsivo com suporte a iOS Safari e Chrome Android.
- Dados de contato do produtor (e-mail) protegidos; nunca expostos no feed público.

## 5. Regras de Negócio
- Episódio não pode ser publicado sem título, descrição mínima de 50 caracteres e arquivo de áudio válido.
- Feed RSS segue padrão RSS 2.0 com namespace iTunes.
- Downloads contam apenas uma vez por IP/episódio a cada 24 horas (anti-bot).
- Transcrição só é gerada para episódios com até 2 horas de duração.

## 6. Modelo de Dados
- shows(id, user_id, title, description, cover_url, rss_url)
- episodes(id, show_id, title, description, audio_url, duration_seconds, published_at)
- plays(id, episode_id, ip_hash, user_agent, played_at, source)
- transcriptions(id, episode_id, text, language, created_at)

## 7. Stack sugerida
- Frontend: Next.js 14 com player customizado (Howler.js ou HTML5 Audio).
- Backend: Fastify + PostgreSQL para metadados; S3 ou CloudFront para áudio e CDN.
- Transcrição: integração com Whisper API ou serviço gerenciado de speech-to-text.
