# Sistema de Onboarding de Colaboradores

## 0. Metadados
- **Produto:** OnboardHub — plataforma de integração de novos colaboradores com trilhas personalizadas, tarefas e coleta de documentos
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Automatizar o processo de onboarding de novos colaboradores com trilhas de integração por cargo, gestão de tarefas e coleta digital de documentos, reduzindo tempo de setup e erros administrativos.

## 2. Personas
- RH — configura trilhas de onboarding por cargo e acompanha progresso de novos colaboradores.
- Gestor direto — atribui tarefas específicas ao colaborador e valida conclusões.
- Colaborador novo — recebe trilha de integração, completa tarefas e envia documentos.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO recebe token e acessa o sistema conforme perfil (RH, gestor ou colaborador).

### FR-02 — Configuração de trilha de onboarding por cargo
DADO um usuário RH autenticado, QUANDO cria trilha para cargo específico com lista de tarefas e prazos padrão, ENTÃO a trilha fica disponível para atribuição a novos colaboradores.

### FR-03 — Atribuição de trilha e criação de colaborador
DADO um novo colaborador cadastrado, QUANDO o RH atribui trilha de onboarding ao cargo dele, ENTÃO o sistema cria instância da trilha com todas as tarefas agendadas e envia e-mail de boas-vindas.

### FR-04 — Gestão de tarefas com responsáveis
DADO uma trilha ativa, QUANDO o RH ou gestor atribui tarefa com responsável (RH, gestor ou colaborador) e prazo, ENTÃO o responsável recebe notificação e a tarefa aparece em seu dashboard.

### FR-05 — Coleta de documentos e assinaturas
DADO uma tarefa de envio de documento, QUANDO o colaborador faz upload de arquivo PDF ou imagem, ENTÃO o documento é armazenado e o RH recebe notificação para validação.

### FR-06 — Acompanhamento de progresso
DADO uma trilha em andamento, QUANDO o RH ou gestor acessa painel de progresso, ENTÃO visualiza percentual de conclusão, tarefas pendentes e documentos faltantes do colaborador.

### FR-07 — Assinatura digital de documentos
DADO um documento que exige assinatura (contrato, termo de confidencialidade), QUANDO o colaborador assina digitalmente, ENTÃO o sistema registra timestamp e hash do documento assinado.

## 4. Requisitos Não-Funcionais
- API de tarefas com resposta < 400ms p95; disponibilidade 99,5%.
- Upload de documentos com até 10MB via presigned URL; armazenamento seguro (S3 com criptografia at-rest).
- Dados pessoais (CPF, RG, endereço) protegidos com LGPD; acesso restrito a perfil RH; nunca logados.
- Notificações por e-mail e push (PWA); retry automático em caso de falha de entrega.

## 5. Regras de Negócio
- Trilha de onboarding só pode ser editada se não houver instâncias ativas; alterações não afetam trilhas já iniciadas.
- Tarefa com prazo vencido dispara alerta diário ao responsável e ao gestor até conclusão.
- Documento enviado pelo colaborador fica pendente até validação manual do RH; RH pode solicitar reenvio.
- Assinatura digital gera hash SHA-256 do documento + timestamp; documento assinado não pode ser alterado.

## 6. Modelo de Dados
- journey_templates(id, job_title, description, created_by)
- task_templates(id, template_id, title, description, responsible_type, due_days, requires_document)
- employees(id, name, email, cpf, job_title, start_date, onboarding_status)
- journey_instances(id, employee_id, template_id, started_at, progress_percent, status)
- tasks(id, instance_id, task_template_id, assigned_to, due_date, status, completed_at)
- documents(id, task_id, employee_id, file_url, file_type, uploaded_at, validated_at, signature_hash)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para dashboard e formulários; PWA para notificações push.
- Backend: Fastify + PostgreSQL para trilhas e tarefas; S3 para storage de documentos com presigned URLs.
- Assinatura digital: biblioteca de hash criptográfico (SHA-256); integração com serviço de e-signature opcional (DocuSign ou similar).
- Notificações: SES para e-mail; OneSignal ou Firebase Cloud Messaging para push.
