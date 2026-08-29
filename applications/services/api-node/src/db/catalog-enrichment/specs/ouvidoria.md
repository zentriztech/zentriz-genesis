# Ouvidoria ao Cidadão

## 0. Metadados
- **Produto:** CidadãoEscuta — plataforma de ouvidoria pública com protocolo e tramitação de manifestações
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Oferecer canal transparente para o cidadão registrar reclamações, denúncias, sugestões e elogios, garantindo resposta dentro do prazo legal e rastreabilidade completa da tramitação.

## 2. Personas
- Cidadão — registra manifestação e acompanha status pelo protocolo.
- Atendente da ouvidoria — analisa manifestação e encaminha ao setor responsável.
- Gestor de setor — recebe demandas, elabora resposta e devolve à ouvidoria.

## 3. Requisitos Funcionais (FR)

### FR-01 — Registro de manifestação sem cadastro prévio
DADO um cidadão, QUANDO preenche tipo de manifestação (reclamação, denúncia, sugestão, elogio), descrição e dados de contato opcionais, ENTÃO o sistema gera protocolo único e envia confirmação por e-mail se informado.

### FR-02 — Acompanhamento pelo protocolo
DADO um cidadão com número de protocolo, QUANDO consulta no portal, ENTÃO visualiza status atual (em análise, encaminhada, respondida), histórico de tramitação e prazo para resposta.

### FR-03 — Triagem e encaminhamento ao setor responsável
DADO um atendente autenticado, QUANDO analisa uma manifestação, ENTÃO pode categorizá-la e encaminhá-la ao setor competente com prazo de resposta definido conforme tipo.

### FR-04 — Elaboração de resposta pelo setor
DADO um gestor de setor, QUANDO recebe manifestação encaminhada, ENTÃO pode redigir resposta fundamentada e devolver à ouvidoria para envio ao cidadão.

### FR-05 — Resposta ao cidadão dentro do prazo legal
DADO uma manifestação respondida, QUANDO o atendente aprova a resposta, ENTÃO o sistema envia a resposta ao cidadão por e-mail e atualiza o status do protocolo para "concluída".

### FR-06 — Alertas de prazo próximo do vencimento
DADO uma manifestação com prazo de resposta definido, QUANDO faltam 3 dias úteis para o vencimento, ENTÃO atendente e gestor do setor recebem alerta por e-mail e notificação no sistema.

### FR-07 — Relatórios de gestão e transparência
DADO um gestor da ouvidoria, QUANDO acessa o painel de indicadores, ENTÃO visualiza total de manifestações por tipo, tempo médio de resposta, percentual dentro do prazo e setores com maior demanda.

## 4. Requisitos Não-Funcionais
- Disponibilidade 24/7 com tolerância a falhas; uptime de 99,7%.
- API com resposta em até 700ms (p95) sob carga de 200 manifestações/hora.
- LGPD: dados pessoais do cidadão protegidos; manifestações anônimas permitidas.
- Trilha de auditoria completa: cada alteração de status registrada com usuário, data e hora.
- Acessibilidade WCAG 2.1 AA no portal público.

## 5. Regras de Negócio
- Prazo de resposta: denúncia e reclamação = 15 dias úteis; sugestão e elogio = 30 dias corridos.
- Manifestação anônima é aceita mas não recebe resposta por e-mail.
- Gestor de setor não pode encerrar manifestação; apenas a ouvidoria encerra após aprovar a resposta.
- Protocolo permanece público por 5 anos para transparência e auditoria.

## 6. Modelo de Dados
- manifestations(id, protocol, type, subject, description, contact_email, status, response_deadline, created_at)
- manifestation_flow(id, manifestation_id, from_user_id, to_user_id, to_department_id, action, notes, created_at)
- departments(id, name, responsible_user_id)
- responses(id, manifestation_id, response_text, approved_by, approved_at)
- users(id, email, name, role, department_id)

## 7. Stack sugerida
- Frontend: Next.js 14 App Router + MUI para portal público acessível e dashboard interno de tramitação.
- Backend: Fastify + PostgreSQL com triggers de auditoria e scheduler de alertas de prazo (node-cron).
- Notificações: Amazon SES para e-mails ao cidadão e alertas internos.
