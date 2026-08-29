# Telemedicina

## 0. Metadados
- **Produto:** TeleHealth — plataforma de teleconsultas por vídeo com prontuário eletrônico e receita digital
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Conectar pacientes e médicos por meio de teleconsultas seguras por vídeo, com registro de prontuário eletrônico, emissão de receitas e atestados digitais, e pagamento integrado, garantindo conformidade com LGPD e sigilo médico.

## 2. Personas
- Paciente — agenda consulta, participa de videochamada, visualiza receitas e baixa atestados.
- Médico — gerencia agenda, realiza teleconsulta, preenche prontuário e emite receita com assinatura digital.
- Administrador da clínica — monitora consultas realizadas, inadimplência e relatórios de atendimento.

## 3. Requisitos Funcionais (FR)

### FR-01 — Agendamento de consulta e sala de vídeo
DADO um paciente autenticado, QUANDO escolhe especialidade, médico e horário disponível, ENTÃO a consulta é agendada e, 10 minutos antes, o sistema libera link da sala de vídeo para paciente e médico.

### FR-02 — Videochamada segura por consulta
DADO uma consulta agendada no horário, QUANDO paciente e médico entram na sala, ENTÃO estabelece conexão WebRTC ponto-a-ponto criptografada, com gravação opcional (consentida) armazenada com TTL de 90 dias.

### FR-03 — Prontuário eletrônico da teleconsulta
DADO um médico durante a consulta, QUANDO preenche anamnese, exame físico virtual e CID-10, ENTÃO o prontuário é salvo vinculado ao paciente com timestamp e assinatura digital do médico (certificado ICP-Brasil).

### FR-04 — Emissão de receita e atestado digital
DADO um médico ao final da consulta, QUANDO prescreve medicamentos ou emite atestado, ENTÃO gera documento PDF assinado digitalmente (ICP-Brasil) com QR Code para validação externa e envia ao paciente por e-mail.

### FR-05 — Pagamento da consulta
DADO um paciente ao agendar, QUANDO confirma pagamento via cartão ou PIX, ENTÃO a consulta é confirmada e, após realizada, o repasse ao médico é calculado (taxa de plataforma deduzida) e agendado para D+2.

### FR-06 — Histórico de consultas e documentos
DADO um paciente autenticado, QUANDO acessa histórico, ENTÃO visualiza lista de consultas realizadas com data, médico, resumo do prontuário (consentido) e links para baixar receitas e atestados.

### FR-07 — Auditoria de acesso a dados sensíveis
DADO qualquer acesso a prontuário ou documento médico, QUANDO um usuário visualiza ou baixa, ENTÃO o sistema registra log de auditoria com timestamp, IP, user_id e documento_id para conformidade LGPD.

## 4. Requisitos Não-Funcionais
- API com p95 < 400ms; videochamada com latência < 200ms e jitter < 30ms.
- Disponibilidade 99,9% (saúde crítica). WebRTC com STUN/TURN para NAT traversal.
- LGPD: dados de saúde (CID, receitas, prontuários) criptografados em repouso (AES-256) e em trânsito (TLS 1.3).
- PII (CPF, RG médico) restrito ao contexto clínico, nunca em logs. Retenção de prontuário conforme CFM (20 anos).

## 5. Regras de Negócio
- Receita válida requer assinatura digital ICP-Brasil do médico e CRM ativo.
- Consulta não realizada (paciente ausente após 15 min) gera reembolso automático.
- Taxa de plataforma de 15% sobre o valor da consulta, deduzida no repasse ao médico.

## 6. Modelo de Dados
- professionals(id, name, crm, crm_state, specialty, certificate_serial, email, bank_account)
- patients(id, name, cpf_hash, birth_date, phone, email, created_at)
- appointments(id, professional_id, patient_id, scheduled_at, status, video_room_token, payment_status, amount)
- medical_records(id, patient_id, appointment_id, anamnesis_encrypted, diagnosis_cid10, signed_at, signature_hash)
- prescriptions(id, appointment_id, document_url, qr_code, signed_at, signature_hash)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para portal do paciente e médico; WebRTC via biblioteca SimpleWebRTC ou Twilio Video.
- Backend: Fastify + PostgreSQL para API de agendamento, prontuários e pagamentos.
- Criptografia: crypto nativo Node.js para campos sensíveis; integração com HSM/KMS para chaves ICP-Brasil.
- Worker: Node.js com Bull (Redis) para envio de lembretes, repasses e limpeza de gravações expiradas.
