# Recrutamento e Seleção

## 0. Metadados
- **Produto:** TalentFlow — gestão de vagas, candidatos e pipeline de contratação
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Gerenciar vagas, receber candidaturas, acompanhar candidatos por etapas de seleção e reduzir tempo de contratação com automação e feedback estruturado.

## 2. Personas
- Recrutador — publica vagas, triagem de currículos e agenda entrevistas.
- Gestor de área — avalia candidatos em etapa final e aprova contratação.
- Candidato — se candidata, acompanha status e recebe feedback.

## 3. Requisitos Funcionais (FR)

### FR-01 — Publicação de vagas
DADO um recrutador autenticado, QUANDO cria vaga com título, descrição e requisitos, ENTÃO a vaga é publicada e disponível para candidaturas.

### FR-02 — Cadastro de candidatos e upload de currículo
DADO um candidato que acessa vaga publicada, QUANDO preenche dados e faz upload de currículo em PDF, ENTÃO a candidatura é registrada no sistema.

### FR-03 — Triagem e movimentação no pipeline
DADO um recrutador que revisa candidaturas, QUANDO move candidato de "Triagem" para "Entrevista RH", ENTÃO o candidato recebe e-mail com novo status.

### FR-04 — Agendamento de entrevista
DADO um recrutador com candidato em "Entrevista RH", QUANDO escolhe data e horário disponíveis, ENTÃO o candidato recebe convite de calendário e link de videoconferência.

### FR-05 — Feedback estruturado por etapa
DADO um gestor de área que entrevistou candidato, QUANDO preenche formulário de avaliação com nota de 1 a 5 e comentário, ENTÃO o feedback fica registrado no histórico do candidato.

### FR-06 — Aprovação e rejeição com notificação
DADO um recrutador que decide não avançar com candidato, QUANDO marca como "Reprovado" e adiciona motivo, ENTÃO o candidato recebe e-mail educado com feedback.

### FR-07 — Relatório de tempo de contratação
DADO um recrutador que acessa relatórios, QUANDO filtra por período, ENTÃO vê tempo médio entre publicação de vaga e contratação, e gargalos por etapa.

## 4. Requisitos Não-Funcionais
- Upload de currículo até 5 MB. Busca de candidatos em < 500ms. Disponibilidade 99,5%. PII (CPF, endereço) nunca em logs. LGPD: candidato pode solicitar exclusão de dados após 2 anos.

## 5. Regras de Negócio
- Vaga só aceita candidaturas enquanto status "Aberta". Candidato só pode se candidatar uma vez por vaga. Movimentação de etapa gera log de auditoria. Feedback obrigatório para rejeição. Tempo de contratação medido da publicação até "Contratado".

## 6. Modelo de Dados
- jobs(id, title, description, requirements, status, created_at, closed_at)
- candidates(id, name, email, phone, resume_url, created_at)
- applications(id, job_id, candidate_id, stage, applied_at, last_moved_at)
- stages(id, name, order)
- feedbacks(id, application_id, evaluator_id, score, comment, created_at)
- interviews(id, application_id, scheduled_at, meeting_link, status)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para recrutador e gestor; portal de candidato simplificado. Backend: Fastify + PostgreSQL. E-mail: integração SMTP para notificações. Storage: S3 para currículos. Calendário: integração Google Calendar ou Calendly.
