# Sistema de Gestão para Escritório de Advocacia

## 0. Metadados
- **Produto:** LegalFlow — gestão de processos, prazos e clientes para escritórios de advocacia
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Centralizar controle de processos judiciais, prazos processuais, clientes e honorários em plataforma integrada. Reduzir perda de prazos, facilitar apuração de horas trabalhadas e manter histórico completo de cada caso.

## 2. Personas
- Advogado — registra processos, agenda audiências, lança horas trabalhadas e anexa documentos.
- Assistente jurídico — monitora prazos, prepara petições e organiza documentos do escritório.
- Sócio administrador — acompanha rentabilidade de casos, horas faturáveis e inadimplência de clientes.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de clientes
DADO um advogado autenticado, QUANDO cadastra cliente com nome, CPF ou CNPJ, endereço e dados de contato, ENTÃO o cliente fica disponível para vinculação a processos.

### FR-02 — Gestão de processos
DADO um advogado com cliente ativo, QUANDO cria processo com número CNJ, comarca, vara, tipo de ação e valor da causa, ENTÃO o processo é salvo com status "ativo" e associado ao cliente.

### FR-03 — Controle de prazos e alertas
DADO um processo ativo, QUANDO o advogado cadastra prazo processual com data limite e tipo (contestação, recurso, audiência), ENTÃO o sistema envia alertas por e-mail 7, 3 e 1 dia antes do vencimento.

### FR-04 — Registro de horas e honorários
DADO um advogado trabalhando em processo, QUANDO lança horas com descrição da atividade e data, ENTÃO as horas são acumuladas no processo e ficam disponíveis para faturamento.

### FR-05 — Gestão de documentos
DADO um processo com documentos físicos ou digitais, QUANDO o usuário faz upload de arquivo PDF com tipo (petição, sentença, acordo) e descrição, ENTÃO o documento é armazenado com versionamento e vinculado ao processo.

### FR-06 — Calendário de audiências
DADO processos com audiências agendadas, QUANDO o advogado acessa o calendário mensal, ENTÃO visualiza todas as audiências do escritório com hora, local, processo e cliente.

### FR-07 — Relatório de honorários
DADO um sócio administrador, QUANDO filtra processos por cliente e período, ENTÃO visualiza horas lançadas por advogado, valor de honorários calculado (hora × tarifa) e status de pagamento.

## 4. Requisitos Não-Funcionais
- Interface carrega lista de processos em < 700ms para escritórios com até 500 processos ativos.
- Disponibilidade de 99,5% em horário comercial.
- Dados de cliente (CPF, endereço) e documentos processuais são armazenados com criptografia (LGPD).
- Sistema envia alertas de prazo via e-mail mesmo em caso de indisponibilidade da interface web (serviço assíncrono independente).
- Suporte a até 50 usuários simultâneos.

## 5. Regras de Negócio
- Número CNJ de processo é único por tenant; duplicação retorna erro 409.
- Prazo vencido há mais de 30 dias é automaticamente marcado como "perdido" e destaca o processo com alerta vermelho.
- Processo só pode ser arquivado se não houver prazos pendentes; tentativa de arquivamento com prazos ativos retorna erro 422.
- Horas lançadas com mais de 90 dias exigem justificativa obrigatória.

## 6. Modelo de Dados
- clients(id, tenant_id, name, document, email, phone, address, created_at)
- cases(id, client_id, cnj_number, court, case_type, case_value, status, responsible_lawyer_id, opened_at, closed_at)
- deadlines(id, case_id, type, due_date, description, completed_at, status)
- timesheets(id, case_id, lawyer_id, hours, description, worked_at)
- documents(id, case_id, title, document_type, s3_key, uploaded_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI 7 + FullCalendar (calendário de audiências).
- Backend: Fastify + PostgreSQL (índices em client_id, cnj_number, due_date).
- Storage: AWS S3 para documentos processuais (retenção indefinida por obrigação legal).
- Worker: cron diário para envio de alertas de prazo via AWS SES.
