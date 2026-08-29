# Site Institucional

## 0. Metadados
- **Produto:** InstitucionalPro — site institucional moderno com captação de leads
- **project_type:** landing
- **Versão:** 1.0

## 1. Visão
Apresentar a empresa ao público com páginas estáticas otimizadas, formulário de contato integrado e SEO robusto, gerando leads qualificados.

## 2. Personas
- Visitante — busca informações sobre a empresa e seus serviços.
- Administrador de marketing — edita conteúdo das páginas e acompanha leads recebidos.

## 3. Requisitos Funcionais (FR)

### FR-01 — Estrutura de páginas institucionais
DADO um visitante no site, QUANDO acessa a home, ENTÃO visualiza banner, missão e chamada para ação, com navegação clara para Sobre e Serviços.

### FR-02 — Página Sobre
DADO um visitante, QUANDO acessa "Sobre", ENTÃO visualiza história da empresa, valores e equipe com fotos e descrições.

### FR-03 — Página de Serviços
DADO um visitante, QUANDO acessa "Serviços", ENTÃO visualiza lista de serviços com ícone, título e descrição breve de cada um.

### FR-04 — Formulário de contato com e-mail
DADO um visitante interessado, QUANDO preenche nome, e-mail, assunto e mensagem e clica em Enviar, ENTÃO o lead é salvo no banco e um e-mail é enviado ao responsável comercial.

### FR-05 — Otimização SEO
DADO qualquer página, QUANDO carrega, ENTÃO possui meta tags OpenGraph, JSON-LD e sitemap.xml gerado automaticamente.

### FR-06 — Conteúdo editável via painel
DADO um administrador autenticado, QUANDO edita o texto de uma seção, ENTÃO a mudança é salva e refletida na página pública imediatamente.

## 4. Requisitos Não-Funcionais
- Desempenho: Lighthouse Score ≥ 90 em todas as páginas. Disponibilidade 99,9%. Dados de contato (e-mail, telefone) nunca em logs públicos.

## 5. Regras de Negócio
- Formulário exige e-mail válido e mensagem com mínimo 10 caracteres. Lead duplicado (mesmo e-mail em 24h) não reenvia notificação.

## 6. Modelo de Dados
- pages(id, slug, titulo, conteudo_json, seo_meta)
- leads(id, nome, email, assunto, mensagem, origem_url, created_at)

## 7. Stack sugerida
- Frontend: Next.js 14 (App Router) com páginas estáticas geradas. Backend leve: API Routes para formulário e envio de e-mail (Nodemailer ou SES).
