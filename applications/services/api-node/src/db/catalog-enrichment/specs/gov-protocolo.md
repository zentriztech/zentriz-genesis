# Protocolo de Processos

## 0. Metadados
- **Produto:** GovProtocolo — sistema de protocolo e tramitação de processos administrativos
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Sistema de gestão de processos administrativos para órgãos públicos, gerando número único de protocolo, controlando tramitação entre setores e permitindo consulta pública de andamento. Garante rastreabilidade e conformidade com Lei de Acesso à Informação.

## 2. Personas
- Cidadão — abre processo via formulário web, consulta andamento pelo número de protocolo.
- Servidor público — recebe processos em sua caixa setorial, adiciona despachos, tramita para outros setores.
- Gestor de departamento — acompanha volume de processos, tempo médio de resposta e gargalos.

## 3. Requisitos Funcionais (FR)

### FR-01 — Abertura de processo com número único
DADO um cidadão autenticado ou anônimo, QUANDO preenche formulário de abertura informando assunto, tipo de solicitação e anexos, ENTÃO o sistema gera número único de protocolo no formato ANO/SEQUENCIAL e persiste o processo com status "protocolado".

### FR-02 — Atribuição automática a setor competente
DADO um processo recém-protocolado, QUANDO o sistema identifica o tipo de solicitação, ENTÃO encaminha automaticamente para caixa de entrada do setor competente conforme matriz de competências cadastrada.

### FR-03 — Tramitação entre setores
DADO um servidor com processo em sua caixa, QUANDO adiciona despacho e seleciona setor de destino, ENTÃO o processo sai de sua caixa, entra na caixa do setor destino e registra evento de tramitação com timestamp e responsável.

### FR-04 — Anexo de documentos e despachos
DADO um servidor analisando processo, QUANDO anexa parecer técnico, documento complementar ou imagem, ENTÃO o arquivo é armazenado com versionamento e associado ao histórico do processo.

### FR-05 — Consulta pública por protocolo
DADO um cidadão com número de protocolo, QUANDO acessa portal de consulta e informa o número, ENTÃO visualiza linha do tempo do processo (data de abertura, setores pelos quais tramitou, status atual), respeitando sigilo de despachos internos.

### FR-06 — Notificação de movimentação
DADO um processo que mudou de status ou recebeu despacho, QUANDO o sistema registra a movimentação, ENTÃO envia e-mail ao cidadão requerente informando atualização e prazo previsto de resposta.

### FR-07 — Relatório de produtividade setorial
DADO um gestor autenticado, QUANDO acessa painel gerencial, ENTÃO visualiza métricas por setor (processos abertos, em análise, concluídos, tempo médio de permanência, gargalos acima do prazo legal).

## 4. Requisitos Não-Funcionais
- Sistema suporta até 500 protocolos simultâneos em horário de pico (8h-9h).
- Disponibilidade de 99,5% em horário comercial (6h-20h dias úteis).
- Trilha de auditoria imutável de todas as tramitações e acessos a processos.
- Despachos sigilosos nunca expostos em consulta pública, apenas para servidores autorizados.
- Conformidade com LGPD: dados pessoais do requerente anonimizados após 5 anos da conclusão.

## 5. Regras de Negócio
- Número de protocolo é único, sequencial por ano e imutável.
- Processo só pode tramitar se estiver na caixa do servidor que tenta movê-lo.
- Processo com prazo legal vencido gera alerta automático para gestor e ouvidoria.
- Anexos são imutáveis após upload; correção exige nova versão com justificativa.

## 6. Modelo de Dados
- processes(id, protocol_number, subject, type, requester_name, requester_email, status, opened_at)
- movements(id, process_id, from_department_id, to_department_id, moved_by_user_id, moved_at)
- attachments(id, process_id, filename, storage_key, uploaded_by_user_id, version, uploaded_at)
- departments(id, name, competence_types, email)
- dispatches(id, process_id, user_id, content, is_confidential, created_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para portal do cidadão e painel interno de servidores.
- Backend: Fastify + PostgreSQL com trigger de auditoria; storage S3 para anexos.
- Integração: API de autenticação gov.br (OAuth2); webhook de notificação por e-mail.
