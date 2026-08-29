# Encurtador de URLs com Análise de Acessos

## 0. Metadados
- **Produto:** ShortLink — encurtador de URLs com rastreamento de cliques e análise de tráfego
- **project_type:** backend_api
- **Versão:** 1.0

## 1. Visão
Gerar URLs curtas para links longos, redirecionar usuários e coletar métricas de acesso por origem, dispositivo e localização. Simplifica compartilhamento e fornece insights de campanhas de marketing.

## 2. Personas
- Usuário anônimo — encurta URL sem cadastro e compartilha o link curto.
- Usuário cadastrado — gerencia seus links, personaliza códigos e visualiza estatísticas detalhadas.
- Administrador — monitora uso da plataforma e remove links abusivos.

## 3. Requisitos Funcionais (FR)

### FR-01 — Criação de link curto
DADO uma URL longa válida, QUANDO o usuário submete pela API ou interface, ENTÃO o sistema gera código curto alfanumérico único de 6 caracteres e retorna a URL encurtada.

### FR-02 — Personalização de código curto (usuário cadastrado)
DADO um usuário autenticado, QUANDO encurta URL e informa slug customizado disponível, ENTÃO o sistema aceita o slug no lugar do código aleatório.

### FR-03 — Redirecionamento HTTP 301
DADO um código curto existente, QUANDO alguém acessa a URL encurtada, ENTÃO o sistema retorna HTTP 301 para a URL original e registra o acesso.

### FR-04 — Registro de métricas de acesso
DADO um redirecionamento realizado, QUANDO o sistema processa, ENTÃO extrai IP, user-agent, referer e timestamp, gera hash do IP (LGPD) e persiste no log de acessos.

### FR-05 — Dashboard de estatísticas por link
DADO um usuário autenticado, QUANDO acessa estatísticas de um link seu, ENTÃO visualiza total de cliques, gráfico temporal, origem (referrer), país e dispositivo (mobile/desktop).

### FR-06 — Expiração de links
DADO um usuário autenticado, QUANDO cria link com data de expiração, ENTÃO após a data o link retorna HTTP 410 Gone em vez de redirecionar.

### FR-07 — Listagem e exclusão de links
DADO um usuário autenticado, QUANDO acessa a lista de seus links, ENTÃO visualiza todos os criados e pode excluir qualquer um, invalidando o código curto.

## 4. Requisitos Não-Funcionais
- Redirecionamento com latência < 100ms p95 (cache Redis).
- Suporte a 10 mil redirecionamentos/segundo.
- Disponibilidade de 99,9%.
- IPs armazenados como hash SHA-256 (não reversível, conformidade LGPD).

## 5. Regras de Negócio
- Código curto colide? Gera novo aleatoriamente até 3 tentativas.
- Links para phishing/malware detectados são bloqueados (integração VirusTotal).
- Usuários anônimos: máximo 10 links/dia por IP.
- Usuários cadastrados: ilimitados, mas links expiram após 1 ano sem acesso.

## 6. Modelo de Dados
- links(id, code, original_url, user_id, created_at, expires_at, active)
- hits(id, link_id, ip_hash, user_agent, referer, country_code, accessed_at)
- users(id, email, password_hash, created_at)

## 7. Stack sugerida
- Backend: Fastify + PostgreSQL + Redis (cache de códigos).
- Worker: agregação diária de hits para dashboard.
- Geolocalização: MaxMind GeoIP2.
- Opcional: Next.js para interface web de criação/dashboard.
