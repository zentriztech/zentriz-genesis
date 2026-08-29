-- enrich-catalog.sql — atualiza spec_catalog.template_markdown com specs enriquecidas.
-- Aplicar com psql REAL (dollar-quoting), NUNCA pelo runner naive de migrations.
-- Gerado automaticamente. Atômico (BEGIN/COMMIT). Idempotente (UPDATE por slug).
BEGIN;
UPDATE spec_catalog SET template_markdown = $md_00$# Programa de Afiliados

## 0. Metadados
- **Produto:** AffiliateHub — gestão de afiliados, rastreio de conversões e pagamento de comissões
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que afiliados gerem links únicos de indicação, rastreiem cliques e conversões, e recebam comissões automaticamente por vendas geradas.

## 2. Personas
- Afiliado — cadastra-se, gera links, acompanha conversões e solicita saque.
- Gestor de marketing — define regras de comissão, aprova afiliados e analisa performance.
- Comprador — clica em link de afiliado e finaliza compra.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de afiliados e aprovação
DADO um visitante que deseja ser afiliado, QUANDO preenche formulário e envia, ENTÃO o cadastro fica pendente até aprovação do gestor.

### FR-02 — Geração de links únicos de indicação
DADO um afiliado aprovado, QUANDO acessa dashboard, ENTÃO pode gerar link único por produto ou campanha com código de rastreio exclusivo.

### FR-03 — Rastreio de clique e conversão
DADO um comprador que clica em link de afiliado, QUANDO finaliza compra em até 30 dias, ENTÃO a conversão é registrada e vinculada ao afiliado.

### FR-04 — Cálculo de comissão por regra
DADO uma conversão de R$ 1.000 em produto com regra de 10% de comissão, QUANDO a venda é confirmada, ENTÃO o afiliado acumula R$ 100 em saldo disponível.

### FR-05 — Painel de performance do afiliado
DADO um afiliado autenticado, QUANDO acessa dashboard, ENTÃO vê cliques, conversões, comissões acumuladas e taxa de conversão.

### FR-06 — Solicitação de repasse
DADO um afiliado com saldo de R$ 500, QUANDO solicita saque com PIX, ENTÃO o repasse é processado em até 5 dias úteis e ele recebe comprovante.

### FR-07 — Relatório de afiliados e ROI
DADO um gestor de marketing, QUANDO exporta relatório, ENTÃO vê todos os afiliados com total de vendas geradas, comissões pagas e ROI da campanha.

## 4. Requisitos Não-Funcionais
- Rastreio de clique com latência < 200ms. Atribuição de conversão em até 30 dias. Disponibilidade 99,5%. PII (CPF, chave PIX) cifrados em repouso. Repasse via integração bancária.

## 5. Regras de Negócio
- Um clique cria cookie de atribuição válido por 30 dias. Conversão só gera comissão após confirmação de pagamento. Saldo mínimo de R$ 100 para saque. Comissão varia por produto/campanha. Afiliado bloqueado perde saldo pendente.

## 6. Modelo de Dados
- affiliates(id, email, name, status, approved_at, pix_key)
- affiliate_links(id, affiliate_id, product_id, code, created_at)
- clicks(id, link_id, ip, user_agent, clicked_at, cookie_token)
- conversions(id, link_id, order_id, order_value, commission_rate, commission_amount, converted_at)
- payouts(id, affiliate_id, amount, status, requested_at, paid_at, receipt_url)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para dashboard de afiliado. Backend: Fastify + PostgreSQL. Rastreio: Redis para cache de atribuição. Pagamento: integração Stripe Connect ou API bancária para repasse.
$md_00$ WHERE slug = 'afiliados';
UPDATE spec_catalog SET template_markdown = $md_01$# Agendamento de Quadras Esportivas

## 0. Metadados
- **Produto:** CourtBook — sistema de reserva de quadras esportivas com pagamento online
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Facilitar o aluguel de quadras esportivas com reserva por horário, pagamento automatizado e gestão de mensalistas, reduzindo conflitos e inadimplência.

## 2. Personas
- Administrador do clube — cadastra quadras, define valores e acompanha ocupação.
- Cliente — reserva horários e efetua pagamento online.
- Mensalista — cliente com plano recorrente e acesso prioritário.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado, QUANDO informa e-mail e senha válidos, ENTÃO recebe token e acessa o dashboard conforme seu perfil (admin ou cliente).

### FR-02 — Cadastro de quadras e grade horária
DADO um administrador autenticado, QUANDO cadastra uma quadra com tipo (futebol, tênis, vôlei) e grade de horários de 1 hora, ENTÃO a quadra fica disponível para reservas.

### FR-03 — Reserva avulsa com prevenção de conflito
DADO um cliente autenticado, QUANDO seleciona quadra e horário disponível, ENTÃO o sistema bloqueia o slot por 10 minutos para pagamento e impede reservas simultâneas.

### FR-04 — Pagamento online
DADO uma reserva bloqueada, QUANDO o cliente confirma pagamento via Pix ou cartão, ENTÃO a reserva é confirmada e o cliente recebe QR code de acesso.

### FR-05 — Reserva recorrente para mensalistas
DADO um cliente mensalista ativo, QUANDO solicita reserva do mesmo horário por 4 semanas, ENTÃO o sistema reserva automaticamente todos os slots sem nova cobrança.

### FR-06 — Política de cancelamento
DADO uma reserva confirmada, QUANDO o cliente cancela com antecedência mínima de 3 horas, ENTÃO recebe reembolso integral; caso contrário, o valor é retido.

## 4. Requisitos Não-Funcionais
- API de reserva com resposta < 500ms p95; reserva simultânea sem race condition (locks transacionais).
- Gateway de pagamento com suporte a Pix e cartão; webhook de confirmação em até 30 segundos.
- Aplicativo mobile responsivo (PWA); disponibilidade 99,5%.
- Dados de pagamento (PAN) nunca armazenados; apenas token do gateway.

## 5. Regras de Negócio
- Reserva expira em 10 minutos se pagamento não for confirmado; slot retorna ao disponível.
- Mensalista tem prioridade na reserva de horários fixos; clientes avulsos veem apenas horários livres.
- Cancelamento fora do prazo (menos de 3h) retém 100% do valor como penalidade.
- Quadra não pode ter reservas sobrepostas; sistema usa lock pessimista na transação de reserva.

## 6. Modelo de Dados
- courts(id, name, court_type, hourly_rate, status)
- time_slots(id, court_id, day_of_week, start_time, end_time)
- customers(id, name, email, phone, is_monthly_member)
- bookings(id, customer_id, court_id, slot_date, start_time, end_time, status, payment_status, payment_id, created_at)
- payments(id, booking_id, amount, method, confirmed_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para calendário e seleção de horários; PWA com suporte offline.
- Backend: Fastify + PostgreSQL com locks transacionais; integração com gateway de pagamento (Stripe ou Asaas).
- Notificações: e-mail via SES e SMS via Twilio para confirmações e lembretes.
$md_01$ WHERE slug = 'agendamento-quadras';
UPDATE spec_catalog SET template_markdown = $md_02$# Agendamento de Serviços

## 0. Metadados
- **Produto:** BookIt — plataforma de agendamento online para prestadores de serviços e clientes
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Sistema web e mobile para prestadores de serviços (médicos, barbeiros, personal trainers, salões) configurarem agenda e serviços oferecidos, clientes agendarem horários disponíveis com prevenção de conflito, e ambos receberem lembretes automáticos, reduzindo no-show e otimizando ocupação da agenda.

## 2. Personas
- Prestador de serviço — cadastra serviços com duração e valor, configura horários de atendimento, visualiza agenda e confirma agendamentos.
- Cliente final — busca prestadores, visualiza horários disponíveis, agenda serviço e recebe lembrete.
- Recepcionista — agenda serviços em nome de clientes que ligam, gerencia cancelamentos e remarcações.

## 3. Requisitos Funcionais (FR)
### FR-01 — Autenticação e perfis de usuário
DADO um usuário cadastrado com e-mail e senha, QUANDO informa credenciais válidas, ENTÃO recebe um token de sessão e acessa funcionalidades conforme seu perfil (cliente, prestador ou recepcionista).

### FR-02 — Cadastro de prestadores e serviços oferecidos
DADO um prestador autenticado, QUANDO cadastra um serviço informando nome, descrição, duração em minutos e valor, ENTÃO o sistema registra o serviço ativo e permite vinculá-lo à agenda; prestador pode cadastrar múltiplos serviços (ex: corte, barba, hidratação).

### FR-03 — Configuração de agenda e horários de atendimento
DADO um prestador, QUANDO configura sua agenda informando dias da semana, horário de início e término, e intervalo de almoço, ENTÃO o sistema gera slots de horário disponíveis respeitando a duração de cada serviço e bloqueios de horários já agendados ou feriados.

### FR-04 — Agendamento pelo cliente com prevenção de conflito
DADO um cliente autenticado buscando um prestador, QUANDO seleciona um serviço e um horário disponível, ENTÃO o sistema valida que não há conflito (outro agendamento no mesmo horário), reserva o slot com status "confirmado", envia e-mail de confirmação ao cliente e notificação ao prestador.

### FR-05 — Lembrete automático ao cliente e prestador
DADO agendamentos confirmados, QUANDO o sistema executa job de lembretes a cada hora, ENTÃO identifica agendamentos nas próximas 24 horas, envia e-mail e SMS ao cliente com dados do serviço e prestador, e notifica o prestador da lista de atendimentos do dia seguinte.

### FR-06 — Cancelamento e remarcação de agendamento
DADO um agendamento confirmado, QUANDO o cliente ou prestador solicita cancelamento com antecedência mínima de 2 horas, ENTÃO o sistema libera o horário, atualiza status para "cancelado", registra o motivo e notifica a outra parte; remarcação cria novo agendamento e cancela o anterior.

## 4. Requisitos Não-Funcionais
- Busca de horários disponíveis retorna resultado em < 200ms; cache de agenda por 5 minutos.
- Sistema tolera até 10 agendamentos simultâneos do mesmo prestador (recepcionistas) sem conflito de slot.
- Disponibilidade 99,5%; lembretes enviados com tolerância de até 10 minutos do horário programado.
- Dados de contato de clientes visíveis apenas para o prestador do agendamento e recepcionistas do mesmo estabelecimento.

## 5. Regras de Negócio
- Um prestador não pode ter dois agendamentos sobrepostos; sistema bloqueia slots ocupados em tempo real.
- Cancelamento com menos de 2 horas de antecedência é permitido mas marcado como "falta" do cliente; 3 faltas bloqueiam novos agendamentos por 30 dias.
- Cliente pode agendar até 3 serviços futuros simultaneamente; acima disso exige confirmação manual do prestador.
- Prestador pode marcar bloqueios de agenda (férias, feriados, compromissos) que impedem novos agendamentos nos horários bloqueados.

## 6. Modelo de Dados
- users(id, email, name, phone, role, status)
- providers(id, user_id, business_name, address, category)
- services(id, provider_id, name, description, duration_minutes, price, status)
- provider_schedule(id, provider_id, day_of_week, start_time, end_time, lunch_break_start, lunch_break_end)
- bookings(id, service_id, client_user_id, provider_id, booking_date, start_time, end_time, status, notes, created_at, canceled_at)
- schedule_blocks(id, provider_id, block_start, block_end, reason)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI + FullCalendar.js (visualização de agenda). Backend: Fastify + PostgreSQL + Bull (jobs de lembrete). Notificações: integração com provedor de SMS (Twilio, Zenvia). Auth JWT.
$md_02$ WHERE slug = 'agendamento-servicos';
UPDATE spec_catalog SET template_markdown = $md_03$# Automação com Agentes de IA

## 0. Metadados
- **Produto:** AgentFlow — orquestrador de agentes autônomos com ferramentas, memória e aprovação humana
- **project_type:** backend_api
- **Versão:** 1.0

## 1. Visão
Executar fluxos de trabalho autônomos onde agentes de IA realizam tarefas complexas com acesso a ferramentas (APIs, bancos, arquivos), registram rastros de execução e solicitam aprovação humana em passos sensíveis.

## 2. Personas
- Arquiteto de automação — define agentes, ferramentas e objetivos de fluxo.
- Operador — monitora execuções, aprova passos sensíveis e analisa custos.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO recebe token e acessa painel de definição de agentes.

### FR-02 — Definição de agente com ferramentas
DADO um arquiteto autenticado, QUANDO cria agente com nome, objetivo e lista de ferramentas (ex.: http_request, sql_query), ENTÃO o sistema valida schema e registra agente como disponível.

### FR-03 — Execução de fluxo autônomo
DADO um agente configurado, QUANDO o usuário dispara execução com payload de entrada, ENTÃO o orquestrador inicia run e enfileira primeira tarefa.

### FR-04 — Chamada de ferramenta pelo agente
DADO um agente em execução, QUANDO o LLM decide invocar ferramenta com parâmetros, ENTÃO o sistema valida, executa e retorna resultado ao agente.

### FR-05 — Aprovação humana em passo sensível
DADO um agente que requer aprovação (ex.: delete, pagamento), QUANDO atinge passo marcado como sensível, ENTÃO pausa execução e notifica operador; prossegue somente após aprovação.

### FR-06 — Registro de rastros e custos
DADO uma execução finalizada, QUANDO o operador consulta histórico, ENTÃO vê lista de passos (timestamp, ferramenta, input/output, tokens, custo LLM).

### FR-07 — Gestão de memória entre runs
DADO um agente com memória habilitada, QUANDO inicia novo run do mesmo contexto, ENTÃO carrega histórico de interações anteriores para continuidade.

## 4. Requisitos Não-Funcionais
- API responde em < 500ms p95 (exceto execução LLM). Disponibilidade 99,5%. Logs auditáveis (quem aprovou, quando). PII nunca em logs. Rate limiting por tenant para evitar custo descontrolado.

## 5. Regras de Negócio
- Ferramenta só executável se agente tem permissão. Passo sem aprovação em 24h expira e falha run. Custo LLM contabilizado por tenant. Memória limitada a 100 interações por contexto.

## 6. Modelo de Dados
- agents(id, name, objective, tools, requires_approval, created_by)
- tools(id, name, schema, endpoint)
- runs(id, agent_id, status, started_at, finished_at, total_cost, created_by)
- steps(id, run_id, order, tool_name, input, output, tokens_in, tokens_out, cost, status, created_at)
- approvals(id, step_id, approved_by, approved_at, notes)
- memory(id, agent_id, context_id, interaction_history)

## 7. Stack sugerida
- Backend: Fastify + PostgreSQL + fila (BullMQ/Redis) para orquestração assíncrona. LLM: Anthropic Claude SDK com streaming. Ferramentas: HTTP client (axios), SQL connector (pg).
$md_03$ WHERE slug = 'agentes-automacao';
UPDATE spec_catalog SET template_markdown = $md_04$# Assinatura Eletrônica

## 0. Metadados
- **Produto:** SignFlow — plataforma de assinatura eletrônica de documentos com validade jurídica e trilha de auditoria
- **project_type:** backend_api
- **Versão:** 1.0

## 1. Visão
API e interface web para empresas enviarem documentos digitais para assinatura eletrônica por múltiplos signatários, com ordem de assinatura, lembretes automáticos, carimbo de tempo e trilha de auditoria imutável, substituindo papel e reconhecimento de firma.

## 2. Personas
- Sistema corporativo integrado — consome a API para enviar contratos, propostas e termos de aceite.
- Signatário — recebe link por e-mail, visualiza o documento, assina eletronicamente e recebe cópia assinada.
- Gestor de contratos — monitora status de documentos pendentes, envia lembretes e baixa trilha de auditoria para arquivamento.

## 3. Requisitos Funcionais (FR)
### FR-01 — Upload de documento e definição de signatários
DADO um usuário autenticado via API Key, QUANDO envia POST /documents com upload de PDF e lista de signatários (nome, e-mail, ordem), ENTÃO o sistema registra o documento, gera hash SHA-256 do arquivo original, envia e-mail com link único para cada signatário respeitando a ordem, e retorna o document_id.

### FR-02 — Ordem de assinatura e fila de espera
DADO signatários com ordem definida (1, 2, 3), QUANDO o signatário de ordem 1 acessa o link e assina, ENTÃO o sistema libera o link para o signatário de ordem 2 e envia e-mail de notificação; signatários de ordem posterior recebem status "aguardando assinatura anterior".

### FR-03 — Assinatura com carimbo de tempo confiável
DADO um signatário acessando o link válido, QUANDO visualiza o documento, marca a checkbox de aceite dos termos e clica em "Assinar", ENTÃO o sistema registra a assinatura com timestamp ICP-Brasil (carimbo de tempo RFC 3161), e-mail do signatário, IP de origem e user-agent, vincula ao documento e notifica o próximo signatário ou finaliza o processo.

### FR-04 — Lembretes automáticos para signatários pendentes
DADO um documento com signatários pendentes, QUANDO o sistema executa job diário de lembretes, ENTÃO identifica signatários que não assinaram há mais de 48 horas, envia e-mail de lembrete com link direto, e registra o evento na trilha de auditoria.

### FR-05 — Trilha de auditoria e documento final
DADO um documento com todas as assinaturas concluídas, QUANDO o gestor requisita GET /documents/:id/audit-trail, ENTÃO a API retorna JSON com eventos cronológicos (upload, envios, visualizações, assinaturas, lembretes) incluindo timestamps, IPs e hashes; a requisição GET /documents/:id/signed-pdf retorna o PDF original com página de assinaturas anexada e QR Code para verificação pública.

## 4. Requisitos Não-Funcionais
- Assinatura processada em < 2s; carimbo de tempo com latência < 5s para autoridade certificadora.
- Hash do documento verificável publicamente via GET /verify/:document_id sem autenticação.
- Disponibilidade 99,9%; armazenamento imutável de documentos originais e assinados por 10 anos (conformidade legal).
- Dados de signatários (e-mail, IP) protegidos por LGPD; acesso restrito ao criador do documento.

## 5. Regras de Negócio
- Um signatário só pode assinar uma vez; tentativa de re-assinatura é rejeitada.
- Link de assinatura expira em 30 dias; após expiração, criador pode reenviar gerando novo link e token.
- Documentos com ordem de assinatura não permitem salto de signatário; assinatura paralela (sem ordem) libera todos simultaneamente.
- Alteração no PDF após upload invalida o processo; hash do arquivo é verificado antes de cada assinatura.

## 6. Modelo de Dados
- documents(id, title, original_file_url, original_file_hash_sha256, status, created_by_user_id, created_at, completed_at)
- signers(id, document_id, name, email, signing_order, token, status, link_sent_at, signed_at, ip_address, user_agent)
- signatures(id, signer_id, timestamp_rfc3161, signature_hash, status)
- audit_trail(id, document_id, event_type, event_data_json, timestamp, ip_address)

## 7. Stack sugerida
- Backend: Fastify + PostgreSQL + Bull (jobs de lembrete). Carimbo de tempo: integração com autoridade certificadora ICP-Brasil (ex: Safeweb, Valid). Storage: S3 com versionamento e retenção. Auth via API Key.
$md_04$ WHERE slug = 'assinatura-eletronica';
UPDATE spec_catalog SET template_markdown = $md_05$# Sistema de Assinaturas Recorrentes

## 0. Metadados
- **Produto:** SubsHub — plataforma de gestão de assinaturas recorrentes para SaaS
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Gerenciar planos de assinatura, cobranças recorrentes e ciclo de vida de assinantes, reduzindo inadimplência e automatizando renovações. Permite upgrade, downgrade e suspensão de planos.

## 2. Personas
- Administrador — cadastra planos, define preços e acompanha receita recorrente.
- Assinante — contrata plano, atualiza cartão e consulta faturas.
- Sistema de cobrança — processa renovações automáticas e retenta falhas.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado, QUANDO informa e-mail e senha válidos, ENTÃO recebe token JWT e acessa o dashboard do seu perfil.

### FR-02 — Cadastro de planos
DADO um administrador autenticado, QUANDO cadastra um plano com nome, preço e ciclo (mensal/anual), ENTÃO o plano é persistido e fica disponível para contratação.

### FR-03 — Contratação de assinatura
DADO um assinante autenticado e um plano ativo, QUANDO seleciona o plano e informa dados de pagamento, ENTÃO a assinatura é criada com status "ativa" e a primeira cobrança é agendada.

### FR-04 — Upgrade e downgrade de plano
DADO uma assinatura ativa, QUANDO o assinante solicita mudança de plano, ENTÃO a alteração é registrada com efeito na próxima renovação e o valor é recalculado proporcionalmente.

### FR-05 — Cobrança recorrente automática
DADO uma assinatura com renovação prevista para hoje, QUANDO o worker de cobrança processa o lote, ENTÃO gera fatura, cobra o meio de pagamento e atualiza a data da próxima renovação.

### FR-06 — Retentativa em falha de cobrança
DADO uma cobrança que falhou, QUANDO passam 3 dias, ENTÃO o sistema tenta novamente até 3 vezes com intervalo de 3 dias, e se todas falharem, suspende a assinatura.

### FR-07 — Portal do assinante
DADO um assinante autenticado, QUANDO acessa o portal, ENTÃO visualiza histórico de faturas, status da assinatura, atualiza forma de pagamento e pode cancelar.

## 4. Requisitos Não-Funcionais
- API REST com tempo de resposta < 500ms p95.
- Disponibilidade de 99,5% no horário comercial.
- Dados de cartão armazenados via tokenização (PCI-DSS compliant).
- Worker de cobrança roda diariamente às 6h com retry em falha.

## 5. Regras de Negócio
- Assinatura cancelada pelo cliente entra em "cancelada" ao final do ciclo pago.
- Upgrade gera crédito proporcional do plano anterior na próxima fatura.
- Após 3 falhas de cobrança, a assinatura é suspensa e o acesso bloqueado.
- Histórico de faturas mantido por 5 anos para auditoria.

## 6. Modelo de Dados
- plans(id, name, price, cycle, active)
- subscriptions(id, user_id, plan_id, status, next_billing_date, payment_method_token)
- invoices(id, subscription_id, amount, due_date, status, attempts)
- users(id, email, password_hash, role)

## 7. Stack sugerida
- Frontend: Next.js 14 App Router + MUI 7.
- Backend: Fastify + PostgreSQL + Bull (fila de jobs).
- Pagamentos: integração Stripe ou PagSeguro.
- Worker: Node.js com Bull e cron diário.
$md_05$ WHERE slug = 'assinatura-recorrente';
UPDATE spec_catalog SET template_markdown = $md_06$# Avaliação de Desempenho

## 0. Metadados
- **Produto:** PerfEval — plataforma de avaliação de desempenho com ciclos, competências e feedback 360°
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Conduzir ciclos estruturados de avaliação de desempenho onde colaboradores realizam autoavaliação, gestores avaliam e pares contribuem com feedback 360°, gerando relatórios consolidados para decisões de RH.

## 2. Personas
- RH — cria ciclos, define competências e monitora conclusão das avaliações.
- Gestor — avalia equipe, compara autoavaliação com avaliação própria e fornece feedback.
- Colaborador — realiza autoavaliação e contribui com feedback de pares quando solicitado.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO recebe token e acessa dashboard conforme perfil (RH, gestor ou colaborador).

### FR-02 — Definição de ciclo de avaliação
DADO um usuário de RH, QUANDO cria ciclo com nome, período (início/fim) e lista de competências avaliadas, ENTÃO o sistema notifica colaboradores e gestores.

### FR-03 — Autoavaliação pelo colaborador
DADO um colaborador com ciclo ativo, QUANDO atribui notas (1-5) a cada competência e adiciona comentários, ENTÃO a autoavaliação é salva e marca etapa como concluída.

### FR-04 — Avaliação pelo gestor
DADO um gestor, QUANDO avalia colaborador de sua equipe atribuindo notas e comentários a competências, ENTÃO o sistema registra avaliação e calcula média ponderada.

### FR-05 — Feedback 360 graus
DADO um colaborador indicado para feedback 360°, QUANDO pares convidados avaliam competências de forma anônima, ENTÃO respostas são agregadas sem identificação individual.

### FR-06 — Comparação autoavaliação vs. avaliação gestor
DADO um gestor, QUANDO acessa painel de colaborador, ENTÃO vê gráfico comparativo entre autoavaliação e avaliação do gestor por competência.

### FR-07 — Relatório consolidado por colaborador
DADO um ciclo finalizado, QUANDO RH gera relatório de colaborador, ENTÃO o sistema exibe média de autoavaliação, avaliação do gestor, feedback 360° e comentários agregados.

## 4. Requisitos Não-Funcionais
- API responde em < 500ms p95; disponibilidade 99%. Dados de avaliação restritos por perfil (colaborador não vê avaliação do gestor antes do fechamento). PII (comentários nominais) nunca em logs. Feedback 360° anonimizado (mínimo 3 respondentes para exibir agregação).

## 5. Regras de Negócio
- Ciclo só fecha após 100% das avaliações concluídas ou data-limite. Nota final é média ponderada (autoavaliação 30%, gestor 50%, 360° 20%). Feedback 360° exige mínimo 3 respostas para exibir. Colaborador acessa relatório final somente após fechamento do ciclo.

## 6. Modelo de Dados
- cycles(id, name, start_date, end_date, status, created_by)
- competencies(id, cycle_id, name, description, weight)
- reviews(id, cycle_id, employee_id, reviewer_id, review_type, status, submitted_at)
- review_scores(id, review_id, competency_id, score, comment)
- feedback_360(id, cycle_id, employee_id, respondent_id, anonymous)
- employees(id, name, email, manager_id, role)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI 7 + recharts (gráficos comparativos). Backend: Fastify + PostgreSQL. Notificações: job scheduler (node-cron) para lembretes de prazo.
$md_06$ WHERE slug = 'avaliacao-desempenho';
UPDATE spec_catalog SET template_markdown = $md_07$# Plataforma de BI e Dashboards Analíticos

## 0. Metadados
- **Produto:** InsightBoard — plataforma de business intelligence com dashboards personalizáveis e conectores de dados
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Centralizar métricas de negócio em dashboards interativos com filtros temporais, comparativos e compartilhamento seguro por equipe.

## 2. Personas
- Analista de dados — cria dashboards, conecta fontes de dados e modela métricas.
- Executivo — consome dashboards prontos e exporta relatórios para decisão estratégica.
- Administrador — gerencia permissões e fontes de dados corporativas.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e controle de acesso
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO recebe token e acessa dashboards conforme permissões de leitura ou edição.

### FR-02 — Conectores de fontes de dados
DADO um analista autenticado, QUANDO configura conector para banco SQL ou API REST com credenciais, ENTÃO o sistema valida conexão e armazena credenciais criptografadas.

### FR-03 — Modelagem de métricas calculadas
DADO um dataset conectado, QUANDO o analista define métrica calculada com fórmula SQL ou agregação, ENTÃO a métrica fica disponível para uso em widgets.

### FR-04 — Criação de dashboards com widgets
DADO um analista autenticado, QUANDO adiciona widget de gráfico (linha, barra, pizza) com métrica e dimensão, ENTÃO o dashboard renderiza o gráfico com dados em tempo real.

### FR-05 — Filtros temporais e comparativos de período
DADO um dashboard com métricas temporais, QUANDO o usuário aplica filtro de período (últimos 7 dias, mês atual) ou comparativo (vs. mês anterior), ENTÃO todos os widgets atualizam automaticamente.

### FR-06 — Compartilhamento e permissões por painel
DADO um dashboard criado, QUANDO o analista compartilha com equipe ou perfil, ENTÃO os destinatários recebem acesso de leitura ou edição conforme permissão concedida.

### FR-07 — Exportação de relatórios
DADO um dashboard renderizado, QUANDO o executivo solicita exportação em PDF ou CSV, ENTÃO o sistema gera arquivo com todos os gráficos e tabelas do dashboard.

## 4. Requisitos Não-Funcionais
- Consultas analíticas com cache de 5 minutos; resposta < 2s p95 para dashboards com até 10 widgets.
- Suporte a até 10.000 linhas por widget; paginação server-side para datasets maiores.
- Credenciais de conectores armazenadas com AES-256; nunca logadas.
- Interface responsiva; disponibilidade 99,5%.

## 5. Regras de Negócio
- Métrica calculada só pode referenciar campos do dataset origem; validação de sintaxe SQL obrigatória antes de salvar.
- Dashboard compartilhado com permissão de leitura não permite edição de widgets ou filtros salvos.
- Cache de consulta é invalidado a cada 5 minutos ou quando o usuário força atualização manual.
- Exportação de dashboard maior que 20 páginas exige processamento assíncrono com notificação por e-mail.

## 6. Modelo de Dados
- data_sources(id, name, type, connection_string_encrypted, created_by)
- datasets(id, source_id, name, query_sql, refresh_interval)
- metrics(id, dataset_id, name, formula, aggregation_type)
- dashboards(id, name, owner_id, created_at)
- widgets(id, dashboard_id, metric_id, chart_type, config_json, position_x, position_y)
- dashboard_permissions(id, dashboard_id, user_id, permission_level)

## 7. Stack sugerida
- Frontend: Next.js 14 + Recharts ou Apache ECharts para visualizações; MUI para layout e controles.
- Backend: Fastify + PostgreSQL para metadados; cache de consultas com Redis; workers assíncronos para exportação.
- Conectores: bibliotecas de cliente SQL (pg, mysql2) e HTTP (axios) para integração com APIs externas.
$md_07$ WHERE slug = 'bi-dashboards';
UPDATE spec_catalog SET template_markdown = $md_08$# Blog com CMS

## 0. Metadados
- **Produto:** ContentHub — plataforma de blog com CMS para publicação e gestão de conteúdo
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que criadores de conteúdo publiquem artigos com editor rico, organizem por categorias e tags, e otimizem SEO para alcançar maior audiência. O sistema oferece moderação de comentários e sitemap automático.

## 2. Personas
- Editor de conteúdo — cria e publica artigos, gerencia rascunhos e agenda publicações.
- Moderador — revisa e aprova comentários antes de publicá-los.
- Leitor — consome artigos, deixa comentários e navega por categorias.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado como editor, QUANDO informa credenciais válidas, ENTÃO recebe token e acessa o painel de administração.

### FR-02 — Criação e edição de posts
DADO um editor autenticado, QUANDO cria um post com título único e conteúdo markdown, ENTÃO o sistema salva como rascunho e permite prévia.

### FR-03 — Publicação agendada
DADO um post em rascunho, QUANDO o editor define data/hora futura e publica, ENTÃO o post permanece oculto até o momento agendado.

### FR-04 — Categorias e tags
DADO um editor, QUANDO associa categorias e tags a um post, ENTÃO elas aparecem na página pública e permitem navegação filtrada.

### FR-05 — Comentários moderados
DADO um leitor autenticado, QUANDO envia comentário em post público, ENTÃO ele fica pendente até aprovação do moderador.

### FR-06 — SEO e sitemap
DADO um post publicado, QUANDO o sistema gera sitemap, ENTÃO inclui URL, título, descrição e data de atualização para indexação em buscadores.

### FR-07 — Listagem pública com paginação
DADO um visitante, QUANDO acessa a home, ENTÃO vê os últimos 10 posts publicados ordenados por data decrescente com paginação.

## 4. Requisitos Não-Funcionais
- API responde em < 300ms p95; disponibilidade 99,5%. Conteúdo cacheável em CDN. Markdown sanitizado contra XSS. Dados pessoais de comentaristas (email) nunca aparecem em logs.

## 5. Regras de Negócio
- Título de post único por blog. Post agendado só aparece após data/hora. Comentário reprovado não reaparece. Slug gerado automaticamente do título (normalizado, sem acentos).

## 6. Modelo de Dados
- posts(id, title, slug, content, status, scheduled_at, published_at, author_id)
- categories(id, name, slug)
- tags(id, name, slug)
- post_categories(post_id, category_id)
- post_tags(post_id, tag_id)
- comments(id, post_id, author_name, author_email, content, status, created_at)

## 7. Stack sugerida
- Frontend: Next.js 14 App Router + MUI 7 + react-markdown. Backend: Fastify + PostgreSQL + Redis (cache). Editor: MDX ou TipTap.
$md_08$ WHERE slug = 'blog-cms';
UPDATE spec_catalog SET template_markdown = $md_09$# Cardápio Digital por QR Code

## 0. Metadados
- **Produto:** MenuQR — cardápio digital para restaurantes e bares
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que clientes acessem o cardápio via QR Code na mesa, façam pedidos com adicionais e paguem sem filas, reduzindo tempo de atendimento e custos operacionais.

## 2. Personas
- Cliente — escaneia QR, escolhe pratos e envia pedido à cozinha.
- Garçom — acompanha pedidos por mesa e fecha a conta.
- Gerente — cadastra itens do cardápio e categorias.

## 3. Requisitos Funcionais (FR)

### FR-01 — Acesso ao cardápio por QR Code
DADO um cliente na mesa, QUANDO escaneia o QR Code único da mesa, ENTÃO carrega o cardápio do restaurante com fotos e preços atualizados.

### FR-02 — Montagem do pedido com adicionais
DADO um cliente visualizando um prato, QUANDO adiciona itens ao carrinho e escolhe adicionais (ex.: queijo extra, molho especial), ENTÃO o sistema calcula o total com as personalizações.

### FR-03 — Envio do pedido à cozinha
DADO um cliente com itens no carrinho, QUANDO confirma o pedido, ENTÃO ele é enviado em tempo real à cozinha com o número da mesa e o garçom recebe notificação.

### FR-04 — Acompanhamento do status do pedido
DADO um pedido confirmado, QUANDO a cozinha atualiza o status (em preparo, pronto, entregue), ENTÃO o cliente visualiza o progresso em tempo real na tela.

### FR-05 — Fechamento de conta por mesa
DADO um garçom autenticado, QUANDO fecha a conta da mesa, ENTÃO o sistema soma todos os pedidos da mesa e marca a mesa como disponível.

### FR-06 — Gestão de cardápio
DADO um gerente autenticado, QUANDO cadastra ou edita um prato com nome, descrição, preço, categoria e foto, ENTÃO ele fica visível para os clientes imediatamente.

## 4. Requisitos Não-Funcionais
- Interface responsiva para smartphones. API < 500ms p95. Disponibilidade 99%. Imagens otimizadas (WebP, max 200KB). Conexão segura (HTTPS) e dados de pagamento fora do escopo inicial.

## 5. Regras de Negócio
- Cada mesa tem QR único; pedidos vinculados à mesa até o fechamento.
- Item fora de estoque não pode ser adicionado ao carrinho.
- Mesa só pode ser reaberta após fechamento completo da conta anterior.

## 6. Modelo de Dados
- tables(id, number, qr_code, status)
- menu_items(id, name, description, price, category, image_url, available)
- menu_item_extras(id, menu_item_id, name, price)
- orders(id, table_id, status, created_at)
- order_items(id, order_id, menu_item_id, quantity, extras_json, subtotal)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI (mobile-first). Backend: Fastify + PostgreSQL. Tempo real: WebSocket ou Server-Sent Events para status de pedido.
$md_09$ WHERE slug = 'cardapio-digital';
UPDATE spec_catalog SET template_markdown = $md_10$# Cartões Corporativos

## 0. Metadados
- **Produto:** CorpCard — gestão de cartões corporativos, limites e prestação de contas
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Controlar emissão de cartões virtuais, limites por centro de custo, rastreamento de transações e prestação de contas com anexo de comprovantes.

## 2. Personas
- Gestor financeiro — emite cartões, define limites e aprova despesas.
- Colaborador — usa cartão virtual, anexa comprovantes e consulta saldo.
- Contador — extrai relatórios de despesas por centro de custo.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um colaborador cadastrado, QUANDO faz login com credenciais válidas, ENTÃO acessa dashboard com seus cartões e transações.

### FR-02 — Emissão de cartões virtuais por colaborador
DADO um gestor financeiro, QUANDO solicita emissão de cartão para colaborador com limite de R$ 2.000, ENTÃO o cartão virtual é criado e o colaborador recebe os dados por e-mail.

### FR-03 — Limites e políticas de gasto por centro de custo
DADO um cartão vinculado ao centro de custo Marketing, QUANDO a soma das transações atinge o limite mensal, ENTÃO novas compras são bloqueadas até aprovação de aumento.

### FR-04 — Registro de transações e anexo de comprovante
DADO um colaborador que usou o cartão, QUANDO a transação aparece no sistema, ENTÃO ele anexa foto do comprovante e categoriza a despesa.

### FR-05 — Aprovação de despesas
DADO um gestor financeiro, QUANDO revisa despesas pendentes, ENTÃO aprova ou rejeita com comentário, e a despesa muda de status.

### FR-06 — Relatório de despesas por centro de custo
DADO um contador, QUANDO exporta relatório do mês, ENTÃO recebe CSV com todas as transações aprovadas agrupadas por centro de custo.

### FR-07 — Bloqueio e cancelamento de cartão
DADO um gestor financeiro, QUANDO bloqueia um cartão, ENTÃO novas transações são rejeitadas e o colaborador é notificado.

## 4. Requisitos Não-Funcionais
- API de transações com latência < 300ms p95. Disponibilidade 99,9%. Comprovantes armazenados com retenção de 7 anos. PII (CPF, dados bancários) cifrados em repouso.

## 5. Regras de Negócio
- Um colaborador pode ter múltiplos cartões. Limite de cartão não pode exceder limite do centro de custo. Transação sem comprovante anexado em 7 dias gera alerta ao gestor. Cancelamento de cartão não remove histórico.

## 6. Modelo de Dados
- users(id, email, password_hash, role)
- cost_centers(id, name, monthly_limit)
- cards(id, user_id, cost_center_id, card_limit, status, card_number_encrypted)
- transactions(id, card_id, amount, merchant, transaction_date, status, receipt_url)
- approvals(id, transaction_id, approved_by, status, comment, approved_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI. Backend: Fastify + PostgreSQL. Storage: S3 para comprovantes. Criptografia: AWS KMS para dados sensíveis.
$md_10$ WHERE slug = 'cartoes-corporativos';
UPDATE spec_catalog SET template_markdown = $md_11$# Chat em Tempo Real

## 0. Metadados
- **Produto:** LiveChat — troca de mensagens em tempo real com salas, presença e histórico persistente
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que usuários criem salas de chat, troquem mensagens instantâneas com indicador de digitação e presença online, e mantenham histórico persistente. Facilitar colaboração síncrona em equipes.

## 2. Personas
- Usuário — entra em salas, envia mensagens e acompanha presença de colegas.
- Administrador de sala — cria sala e gerencia membros.

## 3. Requisitos Funcionais (FR)

### FR-01 — Criação de sala
DADO um usuário autenticado, QUANDO cria sala com nome único, ENTÃO a sala é persistida e o criador vira administrador.

### FR-02 — Ingresso em sala
DADO um usuário, QUANDO entra em sala pública ou recebe convite, ENTÃO vira membro e recebe histórico das últimas 100 mensagens.

### FR-03 — Envio de mensagem
DADO um membro conectado, QUANDO envia texto, ENTÃO a mensagem é persistida e transmitida em tempo real via WebSocket a todos os membros online.

### FR-04 — Indicador de digitação
DADO um membro digitando, QUANDO envia evento de digitação via WebSocket, ENTÃO outros membros visualizam indicador por 3 segundos.

### FR-05 — Presença online
DADO um membro conectado, QUANDO estabelece WebSocket, ENTÃO aparece como online para demais membros; ao desconectar, muda para offline.

### FR-06 — Histórico persistente
DADO um membro, QUANDO entra em sala, ENTÃO carrega mensagens anteriores paginadas com scroll infinito.

### FR-07 — Notificação push
DADO um membro offline, QUANDO recebe mensagem em sala que participa, ENTÃO recebe notificação push no dispositivo se registrado.

## 4. Requisitos Não-Funcionais
- Latência de mensagem <100ms p95; disponibilidade 99,5%. WebSocket com reconexão automática. PII (conteúdo de mensagens) nunca exposto em logs externos.

## 5. Regras de Negócio
- Sala pública visível a todos; sala privada exige convite.
- Mensagem persistida antes de broadcast via WebSocket — garante entrega mesmo se destinatário offline.
- Indicador de presença atualizado a cada 30s de heartbeat WebSocket.

## 6. Modelo de Dados
- rooms(id, name, is_public, created_by)
- memberships(room_id, user_id, joined_at, role)
- messages(id, room_id, user_id, text, created_at)
- presence(user_id, room_id, status, last_seen)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI + Socket.io client. Backend: Fastify + PostgreSQL + Socket.io (Node.js) para WebSocket. Redis para pub/sub entre instâncias do backend.
$md_11$ WHERE slug = 'chat-tempo-real';
UPDATE spec_catalog SET template_markdown = $md_12$# Clube de Assinatura Box

## 0. Metadados
- **Produto:** BoxClub — clube de assinatura mensal com curadoria e logística integrada
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Gerenciar assinaturas recorrentes de boxes temáticas com ciclo de cobrança, curadoria de produtos e integração logística. Facilitar pausas, cancelamentos e gestão de envios com rastreamento.

## 2. Personas
- Assinante — escolhe plano, gerencia assinatura e acompanha entregas.
- Curador — monta boxes mensais com itens selecionados.
- Operador logístico — gera etiquetas e consolida envios.

## 3. Requisitos Funcionais (FR)

### FR-01 — Planos e assinatura
DADO um visitante, QUANDO escolhe um plano mensal, trimestral ou anual, ENTÃO é criada uma assinatura com cobrança recorrente ativa.

### FR-02 — Curadoria de box
DADO um curador autenticado, QUANDO monta um box associando produtos ao ciclo, ENTÃO o box fica disponível para geração de remessas.

### FR-03 — Pausa e reativação
DADO um assinante ativo, QUANDO solicita pausa, ENTÃO a cobrança é suspensa e nenhum envio é gerado até reativação.

### FR-04 — Cancelamento
DADO um assinante, QUANDO cancela, ENTÃO a assinatura passa a expirada ao fim do ciclo pago e não gera mais cobranças.

### FR-05 — Geração de remessa
DADO um box fechado e assinantes ativos, QUANDO inicia o ciclo, ENTÃO cria remessas com status pendente e integra com transportadora.

### FR-06 — Rastreamento
DADO uma remessa enviada, QUANDO o assinante consulta, ENTÃO exibe código de rastreio e eventos de entrega.

## 4. Requisitos Não-Funcionais
- Cobrança recorrente com 99,5% de disponibilidade; API de logística com retry em falhas transitórias. PII (endereço, CPF) restrito a serviço de assinaturas e nunca em logs.

## 5. Regras de Negócio
- Cobrança ocorre no dia de aniversário da assinatura; pausa não altera data de renovação futura.
- Box só pode ser editado até 5 dias antes do fechamento do ciclo.
- Cancelamento com direito a receber box já pago.

## 6. Modelo de Dados
- plans(id, name, billing_cycle, price)
- subscriptions(id, user_id, plan_id, status, next_billing_date)
- boxes(id, cycle_start, cycle_end, status)
- box_items(box_id, product_id, quantity)
- shipments(id, subscription_id, box_id, tracking_code, status)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI. Backend: Fastify + PostgreSQL. Worker: cron de cobrança e integração logística via API REST.
$md_12$ WHERE slug = 'clube-assinatura-box';
UPDATE spec_catalog SET template_markdown = $md_13$# Gestão de Condomínio

## 0. Metadados
- **Produto:** CondoManager — sistema de gestão condominial com cobrança e reservas
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma para síndicos e moradores gerenciarem unidades, taxas condominiais, reservas de áreas comuns e comunicados, centralizando a administração do condomínio.

## 2. Personas
- Síndico — cadastra unidades, emite cobranças e aprova reservas.
- Morador — consulta taxas, reserva áreas comuns e lê comunicados.
- Zelador — gerencia manutenção de áreas comuns.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de unidades e moradores
DADO um síndico autenticado, QUANDO cadastra uma unidade com identificação única (bloco/número) e associa morador titular, ENTÃO a unidade é registrada e o morador recebe acesso ao portal.

### FR-02 — Cobrança de taxa condominial mensal
DADO o primeiro dia do mês, QUANDO o sistema executa job de geração de cobranças, ENTÃO uma cobrança é criada para cada unidade com valor base mais rateio de despesas, e boleto é gerado via API de pagamento.

### FR-03 — Consulta e pagamento de taxas pelo morador
DADO um morador autenticado, QUANDO acessa extrato de cobranças, ENTÃO visualiza taxas pendentes e pagas com boletos disponíveis para download, e pode pagar via PIX ou cartão.

### FR-04 — Reserva de áreas comuns
DADO um morador, QUANDO solicita reserva de área comum (salão, churrasqueira) para data/horário disponível, ENTÃO a reserva é registrada como "pendente" e o síndico recebe notificação para aprovar ou rejeitar.

### FR-05 — Aprovação e cancelamento de reservas
DADO um síndico, QUANDO visualiza reserva pendente, ENTÃO pode aprovar (bloqueando o horário) ou rejeitar com justificativa, e o morador recebe notificação da decisão.

### FR-06 — Comunicados e assembleias
DADO um síndico, QUANDO publica comunicado ou convoca assembleia, ENTÃO todos os moradores recebem notificação por e-mail e o aviso fica disponível no portal.

### FR-07 — Registro de manutenção de áreas comuns
DADO um zelador, QUANDO registra manutenção realizada em área comum, ENTÃO o registro é salvo com data, descrição e fotos, e o síndico recebe relatório mensal.

## 4. Requisitos Não-Funcionais
- Portal deve carregar em menos de 600ms p95.
- Disponibilidade de 99% para consultas e reservas.
- PII de moradores (CPF, telefone) nunca em logs.
- LGPD: consentimento para uso de dados pessoais em comunicados.

## 5. Regras de Negócio
- Unidade não pode ter cobrança duplicada para o mesmo mês.
- Área comum não pode ter reservas sobrepostas para o mesmo horário.
- Morador inadimplente há mais de 3 meses não pode reservar áreas comuns.
- Cancelamento de reserva pelo morador deve ser feito com pelo menos 48 horas de antecedência.

## 6. Modelo de Dados
- units(id, condo_id, block, number, owner_id, status)
- residents(id, name, cpf, email, phone, role)
- charges(id, unit_id, month, base_amount, extras, status, due_date)
- common_areas(id, condo_id, name, hourly_rate, max_hours)
- reservations(id, area_id, resident_id, date, start_time, end_time, status)
- notices(id, condo_id, title, content, published_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para portal síndico/morador.
- Backend: Fastify + PostgreSQL para transações.
- Jobs: cron para geração de cobranças mensais.
- Integração: API de pagamento (boleto/PIX) e envio de e-mails transacionais.
$md_13$ WHERE slug = 'condominio-gestao';
UPDATE spec_catalog SET template_markdown = $md_14$# Gestão de Contratos (CLM)

## 0. Metadados
- **Produto:** ContractHub — plataforma de gestão do ciclo de vida de contratos
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Centralizar contratos da elaboração à renovação, com fluxo de aprovação, assinatura digital, alertas de vencimento e repositório de cláusulas, reduzindo riscos contratuais e custos de gestão.

## 2. Personas
- Gestor jurídico — cadastra contratos, define cláusulas e controla vencimentos.
- Aprovador — revisa e aprova contratos em fluxo multi-etapa.
- Financeiro — acompanha obrigações financeiras e multas por descumprimento.

## 3. Requisitos Funcionais (FR)

### FR-01 — Repositório de contratos
DADO um gestor jurídico autenticado, QUANDO cadastra um contrato com partes, objeto, valor, vigência e anexa o PDF, ENTÃO ele é armazenado com status "em elaboração" e indexado para busca.

### FR-02 — Fluxo de aprovação multi-etapa
DADO um contrato em elaboração, QUANDO o gestor envia para aprovação, ENTÃO o sistema cria tarefas sequenciais para cada aprovador configurado (jurídico → financeiro → diretoria) e notifica o primeiro.

### FR-03 — Assinatura digital
DADO um contrato aprovado por todos, QUANDO as partes assinam digitalmente com certificado ICP-Brasil ou assinatura eletrônica simples, ENTÃO o contrato passa a status "vigente" e recebe timestamp com hash SHA-256.

### FR-04 — Alertas de vencimento
DADO um contrato vigente com prazo de vencimento, QUANDO faltam 90, 60 e 30 dias para o vencimento, ENTÃO o gestor responsável recebe e-mail e notificação in-app.

### FR-05 — Obrigações e marcos por contrato
DADO um contrato vigente, QUANDO o gestor cadastra obrigações (ex.: pagamento mensal, entrega de relatório), ENTÃO o sistema cria lembretes automáticos antes de cada vencimento.

### FR-06 — Renovação automática
DADO um contrato com cláusula de renovação automática, QUANDO o prazo de vencimento chega e nenhuma parte manifesta oposição, ENTÃO o sistema cria uma nova versão do contrato com nova vigência.

### FR-07 — Cláusulas reutilizáveis
DADO um gestor jurídico, QUANDO cria uma biblioteca de cláusulas (ex.: confidencialidade, rescisão, multa), ENTÃO pode inseri-las em novos contratos via templates.

## 4. Requisitos Não-Funcionais
- Armazenamento seguro de PDFs (criptografia em repouso). Disponibilidade 99,5%. Conformidade com LGPD (dados de partes físicas nunca em logs). Backup diário. API < 500ms p95. Assinatura digital com validade jurídica (ICP-Brasil ou e-CNPJ).

## 5. Regras de Negócio
- Contrato só pode ser assinado após aprovação de todos os aprovadores.
- Alerta de vencimento não é enviado se contrato já foi renovado ou rescindido.
- Obrigação não cumprida gera pendência visível no dashboard do financeiro.

## 6. Modelo de Dados
- contracts(id, title, object, value, start_date, end_date, status, auto_renew, responsible_id, pdf_url, hash)
- parties(id, contract_id, name, cnpj_cpf, role, signed_at, signature_hash)
- clauses(id, category, title, content)
- contract_clauses(id, contract_id, clause_id)
- obligations(id, contract_id, description, due_date, completed, notified)
- approvals(id, contract_id, approver_id, step_order, approved_at, status)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI. Backend: Fastify + PostgreSQL. Assinatura digital: integração com API de certificação digital (ex.: Docusign, Clicksign) ou lib de assinatura local. Storage: AWS S3 com criptografia.
$md_14$ WHERE slug = 'contratos-clm';
UPDATE spec_catalog SET template_markdown = $md_15$# Reserva de Coworking

## 0. Metadados
- **Produto:** CoworkHub — plataforma de reserva de espaços de coworking com planos flexíveis e controle de acesso
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Sistema de gestão de coworking que permite reserva avulsa ou por plano de salas privativas, estações compartilhadas e salas de reunião. Integra com catraca de controle de acesso, calcula faturamento por uso e gera relatórios de ocupação.

## 2. Personas
- Coworker avulso — reserva sala de reunião ou estação por hora via app, faz check-in presencial.
- Coworker plano mensal — acessa espaço livremente dentro de cota de horas do plano, visualiza saldo de créditos.
- Administrador do espaço — cadastra salas e capacidades, configura preços e planos, monitora ocupação em tempo real.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de espaços e capacidade
DADO um administrador autenticado, QUANDO cadastra novo espaço informando tipo (sala privativa, estação, sala de reunião), capacidade e recursos (TV, projetor, quadro), ENTÃO o espaço é publicado no catálogo de reservas com status "disponível".

### FR-02 — Reserva avulsa por hora
DADO um coworker não assinante, QUANDO seleciona espaço, data e horário (mínimo 1 hora), ENTÃO o sistema verifica disponibilidade, calcula preço pela tabela de tarifas e cria reserva com status "pendente de pagamento".

### FR-03 — Planos de acesso mensal
DADO um coworker, QUANDO contrata plano mensal (exemplo: 40 horas/mês de estação compartilhada), ENTÃO o sistema cria assinatura recorrente, concede crédito de horas do mês vigente e libera acesso ao espaço sem reserva prévia.

### FR-04 — Check-in e controle de acesso
DADO um coworker com reserva confirmada ou plano ativo, QUANDO faz check-in via QR code na catraca ou app, ENTÃO o sistema valida reserva/saldo de horas, registra entrada com timestamp e libera acesso físico via integração com catraca.

### FR-05 — Consumo de créditos de plano
DADO um coworker plano mensal que fez check-in, QUANDO faz check-out, ENTÃO o sistema calcula tempo de permanência, debita horas do saldo do plano e, se ultrapassar cota, gera cobrança avulsa de horas extras.

### FR-06 — Faturamento consolidado
DADO um coworker com reservas avulsas e/ou horas extras de plano, QUANDO chega a data de fechamento de ciclo, ENTÃO o sistema gera fatura consolidada (plano + horas extras + reservas avulsas) e envia por e-mail com link de pagamento.

### FR-07 — Painel de ocupação em tempo real
DADO um administrador visualizando dashboard, QUANDO acessa visão de ocupação, ENTÃO visualiza mapa de calor dos espaços (livre, ocupado, reservado), taxa de ocupação do dia e forecast de reservas da semana.

## 4. Requisitos Não-Funcionais
- Sistema suporta até 200 check-ins simultâneos em horário de pico (8h-9h).
- Disponibilidade de 99,7% para subsistema de controle de acesso (crítico para entrada no espaço).
- Integração com catraca responde em menos de 500ms para não bloquear acesso físico.
- PII de coworkers (CPF, dados de pagamento) armazenada cifrada (AES-256).

## 5. Regras de Negócio
- Reserva só pode ser cancelada até 2 horas antes do horário, senão cobra 50% do valor.
- Créditos de horas de plano mensal não acumulam para o próximo ciclo (use ou perca).
- Coworker plano só pode trazer convidado se tiver crédito de horas suficiente para 2 pessoas.
- Espaço ocupado fisicamente sem reserva gera alerta e cobrança retroativa por hora (penalidade).

## 6. Modelo de Dados
- spaces(id, name, type, capacity, resources, hourly_rate, status)
- plans(id, name, monthly_fee, included_hours, space_type)
- subscriptions(id, user_id, plan_id, status, current_cycle_hours_remaining, next_billing_date)
- bookings(id, user_id, space_id, start_time, end_time, status, amount)
- checkins(id, user_id, space_id, checked_in_at, checked_out_at, hours_consumed)
- invoices(id, user_id, cycle_start, cycle_end, total_amount, status)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para portal web; React Native para app mobile de check-in.
- Backend: Fastify + PostgreSQL; Redis para cache de disponibilidade em tempo real; RabbitMQ para processamento assíncrono de faturas.
- Integração: API REST de catraca de controle de acesso (protocolo proprietário); gateway de pagamento para cobranças recorrentes.
$md_15$ WHERE slug = 'coworking-reservas';
UPDATE spec_catalog SET template_markdown = $md_16$# CRM de Vendas

## 0. Metadados
- **Produto:** SalesHub — CRM para gestão de oportunidades e funil de vendas
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Gerenciar relacionamento com clientes potenciais e oportunidades de venda ao longo de um funil configurável. Centralizar contatos, atividades e histórico de negociações para aumentar taxa de conversão e produtividade do time comercial.

## 2. Personas
- Vendedor — registra contatos, qualifica leads e avança negociações pelo funil.
- Gestor comercial — configura etapas do funil, monitora pipeline e analisa conversão.
- Representante de suporte — consulta histórico de clientes para atendimento contextualizado.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado com perfil vendedor ou gestor, QUANDO informa credenciais válidas, ENTÃO recebe token JWT e acessa o dashboard com permissões do seu perfil.

### FR-02 — Cadastro de contas e contatos
DADO um vendedor autenticado, QUANDO cadastra uma conta empresa com CNPJ único e associa contatos com e-mail/telefone, ENTÃO a conta fica disponível para vinculação a oportunidades.

### FR-03 — Gestão de oportunidades no funil
DADO um vendedor com uma conta ativa, QUANDO cria uma oportunidade com valor estimado e a associa a um estágio do funil, ENTÃO a oportunidade aparece no quadro Kanban e pode ser arrastada entre estágios.

### FR-04 — Atividades e lembretes
DADO uma oportunidade aberta, QUANDO o vendedor registra uma atividade com tipo (ligação, reunião, e-mail) e agenda um lembrete, ENTÃO o sistema notifica o responsável no horário definido.

### FR-05 — Configuração de funil
DADO um gestor autenticado, QUANDO cria ou reordena estágios do funil com nome e probabilidade de fechamento, ENTÃO o funil atualizado é aplicado a todas as oportunidades novas e existentes.

### FR-06 — Relatório de conversão
DADO um gestor, QUANDO filtra oportunidades por período e vendedor, ENTÃO visualiza taxa de conversão por estágio, tempo médio de permanência e valor total do pipeline.

### FR-07 — Histórico de interações
DADO um contato com histórico, QUANDO qualquer usuário consulta o contato, ENTÃO visualiza linha do tempo cronológica com todas as atividades e mudanças de estágio das oportunidades relacionadas.

## 4. Requisitos Não-Funcionais
- API REST responde em < 500ms (p95) para operações de consulta e < 1s para relatórios agregados.
- Disponibilidade de 99,5% em horário comercial.
- Dados de contato (e-mail, telefone, CNPJ) nunca aparecem em logs nem em tokens JWT.
- Suporte a 100 usuários simultâneos e até 50.000 oportunidades ativas por tenant.

## 5. Regras de Negócio
- CNPJ de conta é único por tenant; tentativa de duplicação retorna erro 409.
- Oportunidade só pode retroceder de estágio com justificativa obrigatória registrada no histórico.
- Oportunidade marcada como "perdida" ou "ganha" sai do funil ativo mas permanece no histórico.
- Lembrete é enviado via e-mail e notificação in-app no horário agendado.

## 6. Modelo de Dados
- accounts(id, tenant_id, name, cnpj, industry, created_at)
- contacts(id, account_id, name, email, phone, role)
- deals(id, account_id, owner_id, stage_id, value, probability, status, created_at, closed_at)
- stages(id, tenant_id, name, order, win_probability)
- activities(id, deal_id, user_id, type, description, scheduled_at, completed_at)

## 7. Stack sugerida
- Frontend: Next.js 14 App Router + MUI 7 (drag-and-drop com dnd-kit).
- Backend: Fastify + PostgreSQL (índices em tenant_id, account_id, stage_id).
- Cache: Redis para contadores de pipeline e taxa de conversão.
$md_16$ WHERE slug = 'crm-vendas';
UPDATE spec_catalog SET template_markdown = $md_17$# Pipeline de Dados ETL

## 0. Metadados
- **Produto:** DataFlow ETL — orquestrador de extração, transformação e carga de dados empresariais
- **project_type:** backend_api
- **Versão:** 1.0

## 1. Visão
Conectar múltiplas fontes de dados (APIs, bancos, arquivos), aplicar transformações configuráveis, validar qualidade e carregar em data warehouse, com agendamento e reprocessamento sob demanda.

## 2. Personas
- Engenheiro de dados — configura conectores, transforma dados e monitora falhas.
- Analista de BI — consulta datasets carregados e aciona reprocessamento se detectar inconsistência.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de conectores de origem
DADO um engenheiro autenticado, QUANDO cadastra uma origem com tipo (postgres/api/s3), credenciais e query/path, ENTÃO o sistema valida conectividade e salva a configuração com status "ativo".

### FR-02 — Definição de transformações
DADO um engenheiro, QUANDO define uma transformação com expressão SQL ou Python, ENTÃO a transformação é salva e pode ser aplicada a qualquer dataset extraído.

### FR-03 — Agendamento de jobs
DADO um job configurado com origem, transformações e destino, QUANDO o engenheiro define um cron (ex: diário às 2h), ENTÃO o job é agendado e executa automaticamente, gerando uma run com status e logs.

### FR-04 — Validação de qualidade dos dados
DADO uma run em execução, QUANDO aplica regras de qualidade (ex: campo não-nulo, valor dentro de range), ENTÃO a run falha se a taxa de violação superar o limiar configurado e notifica o responsável.

### FR-05 — Reprocessamento de run falhada
DADO uma run com status "falha", QUANDO o engenheiro aciona reprocessamento, ENTÃO o job é re-executado a partir da etapa que falhou, mantendo histórico de tentativas.

### FR-06 — Monitoramento e alertas
DADO um job crítico, QUANDO uma run demora mais que o SLA configurado ou falha 3 vezes consecutivas, ENTÃO o sistema envia alerta via e-mail e Slack ao time de dados.

## 4. Requisitos Não-Funcionais
- Jobs processam até 10 milhões de linhas/hora. Disponibilidade 99,7%. Credenciais de origem cifradas em repouso (AES-256). Logs de dados sensíveis mascarados.

## 5. Regras de Negócio
- Job não inicia se há run ativa da mesma configuração. Reprocessamento só permitido em runs com status "falha" ou "parcial". Datasets carregados com timestamp de ingestão e hash de conteúdo para idempotência.

## 6. Modelo de Dados
- sources(id, tipo, config_json, credentials_encrypted, status)
- jobs(id, nome, source_id, transformations, destination_id, cron, sla_minutes)
- runs(id, job_id, started_at, finished_at, status, rows_processed, error_log)
- datasets(id, run_id, destination_table, row_count, hash, loaded_at)

## 7. Stack sugerida
- Backend: Python com FastAPI. Orquestrador: Celery + Redis. Data processing: Pandas ou PySpark. Database: PostgreSQL para metadados, S3 para staging. Monitoramento: Prometheus + Grafana.
$md_17$ WHERE slug = 'dados-etl';
UPDATE spec_catalog SET template_markdown = $md_18$# Delivery de Comida

## 0. Metadados
- **Produto:** FoodExpress — plataforma de delivery de comida conectando clientes, restaurantes e entregadores
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Conectar clientes a restaurantes, processar pedidos com pagamento online, calcular taxa de entrega e rastrear entrega em tempo real, oferecendo conveniência e rapidez.

## 2. Personas
- Cliente — busca restaurantes, monta pedido e acompanha entrega em tempo real.
- Restaurante — recebe pedidos, confirma preparo e notifica quando está pronto.
- Entregador — aceita entregas, navega até o endereço e confirma entrega.

## 3. Requisitos Funcionais (FR)

### FR-01 — Catálogo de restaurantes
DADO um cliente na plataforma, QUANDO busca por categoria (pizza, japonês) ou nome, ENTÃO visualiza restaurantes disponíveis com tempo estimado de entrega, avaliação e taxa de entrega.

### FR-02 — Montagem do pedido
DADO um cliente visualizando o cardápio de um restaurante, QUANDO adiciona itens ao carrinho com adicionais e observações, ENTÃO o sistema calcula o subtotal, taxa de entrega e total do pedido.

### FR-03 — Pagamento e finalização do pedido
DADO um cliente com carrinho preenchido, QUANDO escolhe forma de pagamento (cartão online, PIX, dinheiro na entrega) e confirma, ENTÃO o pedido é enviado ao restaurante e o pagamento é processado (se online).

### FR-04 — Confirmação e preparo pelo restaurante
DADO um restaurante recebendo um pedido, QUANDO confirma o recebimento, ENTÃO o status muda para "em preparo" e o cliente recebe notificação com tempo estimado.

### FR-05 — Atribuição de entregador
DADO um pedido com status "pronto", QUANDO o restaurante marca como pronto, ENTÃO o sistema busca entregadores disponíveis próximos e envia notificação ao primeiro disponível.

### FR-06 — Rastreamento em tempo real
DADO um pedido atribuído a um entregador, QUANDO ele está a caminho, ENTÃO o cliente visualiza a posição do entregador no mapa em tempo real (atualização a cada 10 segundos).

### FR-07 — Avaliação de restaurante e entregador
DADO um pedido entregue, QUANDO o cliente avalia com nota de 1 a 5 estrelas e comentário, ENTÃO a avaliação é registrada e impacta a média pública do restaurante e entregador.

## 4. Requisitos Não-Funcionais
- Mapa em tempo real com WebSocket. API < 500ms p95. Integração de pagamento segura (PCI-DSS). Disponibilidade 99,5%. LGPD: dados de localização do cliente nunca em logs. Cálculo de taxa de entrega por distância (API de geolocalização).

## 5. Regras de Negócio
- Taxa de entrega calculada por distância linear (ex.: R$ 2,00 + R$ 0,50/km acima de 3km).
- Restaurante só recebe pedidos quando status é "aberto" e dentro do horário de funcionamento.
- Entregador pode recusar pedido; sistema busca próximo disponível.
- Avaliação abaixo de 3 estrelas exige comentário obrigatório.

## 6. Modelo de Dados
- restaurants(id, name, category, address, lat, lng, rating, open_status, delivery_fee_base)
- menu_items(id, restaurant_id, name, description, price, available)
- orders(id, customer_id, restaurant_id, delivery_address, subtotal, delivery_fee, total, payment_method, status, created_at)
- order_items(id, order_id, menu_item_id, quantity, extras, notes, subtotal)
- deliveries(id, order_id, driver_id, pickup_at, delivered_at, status)
- ratings(id, order_id, target_type, target_id, score, comment)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI + Mapbox ou Google Maps API. Backend: Fastify + PostgreSQL. Tempo real: WebSocket (Socket.io) para status e localização. Pagamento: integração com gateway (Stripe, Mercado Pago). Geolocalização: Haversine para cálculo de distância.
$md_18$ WHERE slug = 'delivery-comida';
UPDATE spec_catalog SET template_markdown = $md_19$# Loja Dropshipping

## 0. Metadados
- **Produto:** DropShip Pro — marketplace dropshipping com repasse automatizado a fornecedores
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma de e-commerce dropshipping que permite lojistas venderem produtos sem estoque físico, integrando catálogo de fornecedores e automatizando o repasse de pedidos.

## 2. Personas
- Lojista — importa produtos de fornecedores e gerencia vendas.
- Cliente final — navega catálogo e realiza compras.
- Fornecedor — recebe pedidos repassados e atualiza rastreamento.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um lojista cadastrado, QUANDO informa e-mail e senha válidos, ENTÃO recebe token JWT e acessa o painel administrativo.

### FR-02 — Importação de produtos de fornecedores
DADO um lojista autenticado, QUANDO importa produtos via CSV ou API de fornecedor, ENTÃO os produtos são cadastrados no catálogo com margem de lucro configurada e sincronização de estoque ativa.

### FR-03 — Catálogo e checkout ao cliente final
DADO um cliente não autenticado, QUANDO navega o catálogo e adiciona produtos ao carrinho, ENTÃO pode finalizar compra informando dados de entrega e pagamento, gerando um pedido confirmado.

### FR-04 — Repasse automatizado de pedido ao fornecedor
DADO um pedido confirmado e pago, QUANDO o webhook de pagamento é recebido, ENTÃO o sistema cria automaticamente um pedido no fornecedor via API e registra o ID de fulfillment.

### FR-05 — Sincronização de estoque e rastreamento
DADO um produto com sincronização ativa, QUANDO o fornecedor atualiza estoque ou código de rastreio via webhook, ENTÃO o catálogo é atualizado e o cliente recebe notificação de envio.

### FR-06 — Gestão de margens e precificação
DADO um lojista, QUANDO define margem percentual sobre o preço de custo do fornecedor, ENTÃO o preço de venda é calculado automaticamente e ajustado em tempo real se o fornecedor alterar o preço de custo.

## 4. Requisitos Não-Funcionais
- Catálogo deve carregar em menos de 500ms p95.
- Disponibilidade de 99,5% para operações de checkout.
- PII de clientes (CPF, cartão) nunca em logs; armazenamento criptografado.
- LGPD: consentimento explícito para uso de dados pessoais e direito ao esquecimento.

## 5. Regras de Negócio
- Pedido só é repassado ao fornecedor após confirmação de pagamento.
- Produto sem estoque no fornecedor é automaticamente ocultado do catálogo.
- Margem mínima de 10% sobre preço de custo do fornecedor.
- Cada lojista pode ter múltiplos fornecedores, mas um produto pertence a apenas um fornecedor.

## 6. Modelo de Dados
- suppliers(id, name, api_key, webhook_url, status)
- products(id, supplier_id, sku, name, cost_price, margin_percent, stock, visible)
- orders(id, customer_email, total, status, payment_status, created_at)
- order_items(id, order_id, product_id, quantity, unit_price)
- fulfillments(id, order_id, supplier_order_id, tracking_code, status)

## 7. Stack sugerida
- Frontend: Next.js 14 (App Router) + MUI para painel admin; Tailwind para storefront.
- Backend: Fastify + PostgreSQL para transações; Redis para cache de estoque.
- Pagamentos: integração Stripe ou Mercado Pago.
$md_19$ WHERE slug = 'dropshipping';
UPDATE spec_catalog SET template_markdown = $md_20$# Loja E-commerce

## 0. Metadados
- **Produto:** ShopHub — plataforma de e-commerce para pequenos e médios lojistas
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que lojistas vendam produtos online com catálogo organizado, carrinho de compras, cálculo de frete e checkout integrado, enquanto compradores navegam, comparam e finalizam pedidos de forma simples e segura.

## 2. Personas
- Comprador — navega o catálogo, adiciona produtos ao carrinho e finaliza a compra.
- Lojista — cadastra produtos, gerencia estoque, atualiza preços e acompanha pedidos.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação de usuários
DADO um comprador ou lojista cadastrado, QUANDO informa e-mail e senha válidos, ENTÃO recebe token JWT e acessa sua área correspondente.

### FR-02 — Catálogo de produtos com busca e filtros
DADO um comprador no catálogo, QUANDO busca por nome ou aplica filtro de categoria, ENTÃO visualiza lista paginada de produtos correspondentes com imagem, nome, preço e disponibilidade.

### FR-03 — Carrinho de compras e cálculo de frete
DADO um comprador com produtos no carrinho, QUANDO informa CEP de entrega, ENTÃO o sistema calcula frete via API dos Correios e exibe total do pedido.

### FR-04 — Checkout e finalização de pedido
DADO um comprador no checkout, QUANDO confirma endereço e forma de pagamento, ENTÃO o pedido é registrado com status "aguardando pagamento" e o comprador recebe número de confirmação.

### FR-05 — Gestão de pedidos e status de entrega
DADO um lojista autenticado, QUANDO acessa painel de pedidos, ENTÃO visualiza lista de pedidos com status (aguardando/pago/enviado/entregue) e pode atualizar o rastreamento.

### FR-06 — Painel administrativo de produtos
DADO um lojista autenticado, QUANDO cadastra ou edita um produto, ENTÃO pode definir nome, descrição, preço, estoque, categoria e imagem.

### FR-07 — Relatório de vendas
DADO um lojista autenticado, QUANDO acessa relatórios, ENTÃO visualiza total de vendas por período, produtos mais vendidos e ticket médio.

## 4. Requisitos Não-Funcionais
- API com p95 < 500ms; disponibilidade 99,5%. Imagens de produtos via CDN.
- Dados de pagamento (cartão) nunca persistidos localmente; integração com gateway externo.
- LGPD: CPF e endereço de entrega restritos ao contexto do pedido, nunca em logs.

## 5. Regras de Negócio
- Produto com estoque zerado não pode ser adicionado ao carrinho.
- Pedido só pode ter status alterado sequencialmente (aguardando→pago→enviado→entregue).
- Frete calculado por peso total do carrinho e CEP de destino; frete grátis acima de R$ 200.

## 6. Modelo de Dados
- products(id, name, description, price, stock, category_id, image_url)
- categories(id, name, slug)
- carts(id, user_id, created_at)
- cart_items(id, cart_id, product_id, quantity)
- orders(id, user_id, total, shipping_cost, status, tracking_code, created_at)
- order_items(id, order_id, product_id, quantity, unit_price)

## 7. Stack sugerida
- Frontend: Next.js 14 App Router + MUI para catálogo e checkout responsivo.
- Backend: Fastify + PostgreSQL para API de produtos, pedidos e autenticação.
- Integração: API Correios para frete, gateway de pagamento externo (webhook para confirmação).
$md_20$ WHERE slug = 'ecommerce-loja';
UPDATE spec_catalog SET template_markdown = $md_21$# Plataforma EAD (LMS)

## 0. Metadados
- **Produto:** EduFlow — plataforma de ensino a distância para cursos online
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Oferecer cursos estruturados em módulos e aulas, com matrículas automatizadas, acompanhamento de progresso e emissão de certificados, permitindo que instituições escalem a educação online.

## 2. Personas
- Aluno — se matricula, assiste aulas e conclui cursos para obter certificados.
- Instrutor — cria cursos, organiza módulos e publica aulas em vídeo ou texto.
- Administrador — gerencia matrículas, relatórios de progresso e configurações da plataforma.

## 3. Requisitos Funcionais (FR)

### FR-01 — Catálogo de cursos
DADO um visitante na plataforma, QUANDO acessa o catálogo, ENTÃO visualiza os cursos disponíveis com título, descrição, carga horária, instrutor e número de módulos.

### FR-02 — Matrícula em curso
DADO um aluno autenticado visualizando um curso, QUANDO clica em "Matricular", ENTÃO é registrado no curso e recebe acesso ao primeiro módulo imediatamente.

### FR-03 — Navegação em módulos e aulas
DADO um aluno matriculado, QUANDO acessa um módulo, ENTÃO visualiza a lista de aulas em sequência e pode assistir somente as aulas liberadas conforme o progresso.

### FR-04 — Player de aula e marcação de conclusão
DADO um aluno assistindo uma aula em vídeo, QUANDO atinge 90% do tempo de reprodução ou clica em "Marcar como concluída", ENTÃO a aula é marcada como concluída e a próxima aula é liberada.

### FR-05 — Progresso do curso
DADO um aluno com aulas concluídas, QUANDO acessa o painel do curso, ENTÃO visualiza a porcentagem de conclusão calculada (aulas concluídas / total de aulas).

### FR-06 — Emissão de certificado
DADO um aluno que concluiu 100% das aulas de um curso, QUANDO acessa a área de certificados, ENTÃO o sistema gera um PDF com nome do aluno, curso, data de conclusão e assinatura digital do instrutor.

### FR-07 — Gestão de cursos e aulas
DADO um instrutor autenticado, QUANDO cria um curso e adiciona módulos e aulas (vídeo hospedado ou texto), ENTÃO o curso fica visível no catálogo após aprovação do administrador.

## 4. Requisitos Não-Funcionais
- Player de vídeo compatível com HLS. API < 600ms p95. Armazenamento seguro de vídeos (S3 ou similar com assinatura temporária). Certificados em PDF com marca d'água. Disponibilidade 99,5%. LGPD: dados pessoais do aluno (nome, e-mail) nunca em logs.

## 5. Regras de Negócio
- Aluno só pode acessar aula seguinte após concluir a anterior.
- Certificado só é gerado após conclusão de 100% das aulas.
- Instrutor não pode editar conteúdo de curso com alunos matriculados sem criar nova versão.

## 6. Modelo de Dados
- courses(id, title, description, instructor_id, duration_hours, published)
- modules(id, course_id, title, order)
- lessons(id, module_id, title, content_type, video_url, text_content, duration_minutes, order)
- enrollments(id, student_id, course_id, enrolled_at, completed_at)
- progress(id, enrollment_id, lesson_id, completed, completed_at)
- certificates(id, enrollment_id, issued_at, pdf_url)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI + player de vídeo (video.js ou Plyr). Backend: Fastify + PostgreSQL. Storage: AWS S3 para vídeos. PDF: biblioteca de geração server-side (PDFKit ou similar).
$md_21$ WHERE slug = 'educacao-lms';
UPDATE spec_catalog SET template_markdown = $md_22$# Plataforma de Empréstimos P2P

## 0. Metadados
- **Produto:** LendMatch — marketplace de empréstimos peer-to-peer com análise de crédito
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Conectar tomadores que precisam de crédito com investidores que oferecem capital, realizando análise de risco, montagem de lastro e repasse automatizado de parcelas. Reduz spread bancário e oferece rentabilidade acima da poupança.

## 2. Personas
- Tomador — solicita empréstimo, informa renda e recebe proposta baseada em score.
- Investidor — escolhe perfil de risco, aloca capital em múltiplos empréstimos e recebe juros mensais.
- Analista de crédito — aprova ou recusa solicitações com base em score e documentação.

## 3. Requisitos Funcionais (FR)

### FR-01 — Solicitação de empréstimo com análise de crédito
DADO um tomador autenticado, QUANDO solicita empréstimo informando valor, prazo e documentos, ENTÃO o sistema calcula score de crédito e retorna taxa de juros sugerida.

### FR-02 — Aprovação e publicação de proposta
DADO uma solicitação com score acima do mínimo, QUANDO o analista aprova, ENTÃO a proposta é publicada no marketplace com prazo para captação de lastro.

### FR-03 — Oferta de investidores e montagem de lastro
DADO uma proposta publicada, QUANDO investidores alocam valores parciais, ENTÃO o sistema registra participação de cada um até completar 100% do valor solicitado.

### FR-04 — Geração de contrato e liberação de recursos
DADO lastro completo dentro do prazo, QUANDO o tomador aceita, ENTÃO contrato digital é gerado, recursos são transferidos ao tomador e cronograma de parcelas é criado.

### FR-05 — Cobrança de parcelas e repasse aos investidores
DADO uma parcela com vencimento hoje, QUANDO o worker de cobrança processa, ENTÃO debita o tomador, calcula juros proporcionais de cada investidor e credita suas contas.

### FR-06 — Inadimplência e cobrança
DADO uma parcela vencida há mais de 15 dias, QUANDO o tomador não paga, ENTÃO o sistema marca como inadimplente, notifica investidores e aciona cobrança externa.

### FR-07 — Dashboard de carteira do investidor
DADO um investidor autenticado, QUANDO acessa o dashboard, ENTÃO visualiza empréstimos ativos, parcelas recebidas, saldo disponível e rentabilidade acumulada.

## 4. Requisitos Não-Funcionais
- Transações financeiras em ledger dupla-entrada append-only.
- Cálculo de juros com precisão de 4 casas decimais.
- Dados de CPF/RG armazenados criptografados (LGPD).
- Disponibilidade de 99,9% em horário comercial.

## 5. Regras de Negócio
- Score mínimo de 600 para aprovação de empréstimo.
- Taxa de juros varia de 1,5% a 4% ao mês conforme score.
- Investidor pode alocar no mínimo R$ 100 por empréstimo.
- Repasse aos investidores em D+1 após recebimento da parcela.
- Inadimplência acima de 60 dias aciona baixa contábil e cobrança judicial.

## 6. Modelo de Dados
- borrowers(id, name, cpf, score, monthly_income)
- investors(id, name, cpf, balance, risk_profile)
- loans(id, borrower_id, amount, rate, term, status)
- loan_participations(id, loan_id, investor_id, invested_amount, share_pct)
- installments(id, loan_id, due_date, amount, status, paid_at)
- ledger_entries(id, account_id, type, amount, timestamp)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI 7.
- Backend: Fastify + PostgreSQL com transações ACID.
- Worker: Bull para cobrança diária e repasse.
- Integração bancária: API Pix e boleto.
$md_22$ WHERE slug = 'emprestimo-p2p';
UPDATE spec_catalog SET template_markdown = $md_23$# Sistema de Gestão para Escritório de Advocacia

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
$md_23$ WHERE slug = 'escritorio-advocacia';
UPDATE spec_catalog SET template_markdown = $md_24$# Estoque e PDV

## 0. Metadados
- **Produto:** StockPOS — controle de estoque e ponto de venda para pequeno e médio varejo
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Sistema integrado de estoque e vendas para varejistas que precisam de controle em tempo real de saldo, movimentações e ruptura, eliminando descontrole manual e perda de vendas por falta de produtos.

## 2. Personas
- Dono da loja — cadastra produtos, monitora giro de estoque e relatórios de vendas.
- Operador de caixa — registra vendas no PDV com baixa automática de estoque.
- Repositor — consulta saldo e recebe alertas de ruptura para reposição de gôndola.

## 3. Requisitos Funcionais (FR)
### FR-01 — Autenticação e perfis de acesso
DADO um usuário cadastrado com e-mail e senha, QUANDO informa credenciais válidas, ENTÃO recebe um token de sessão e acessa funcionalidades conforme seu perfil (dono, caixa ou repositor).

### FR-02 — Cadastro de produtos e saldo inicial
DADO um dono de loja autenticado, QUANDO cadastra um produto informando código de barras, nome, preço de custo e venda, ENTÃO o sistema registra o produto com saldo inicial zero e permite posterior entrada de estoque.

### FR-03 — Entrada e saída manual de estoque
DADO um produto cadastrado, QUANDO o dono registra uma entrada informando quantidade e fornecedor, ENTÃO o saldo é incrementado e o custo médio recalculado; saídas por perda ou devolução decrementam o saldo.

### FR-04 — Venda no PDV com baixa automática de estoque
DADO um operador de caixa autenticado, QUANDO finaliza uma venda informando produtos e quantidades via código de barras, ENTÃO o sistema calcula o total, registra a venda, baixa o estoque automaticamente e emite comprovante.

### FR-05 — Alerta de ruptura e estoque mínimo
DADO produtos cadastrados com estoque mínimo definido, QUANDO o saldo de um produto atinge ou fica abaixo do mínimo, ENTÃO o sistema exibe alerta no painel e notifica o dono e repositor.

### FR-06 — Relatório de giro de estoque e produtos parados
DADO um período selecionado pelo dono, QUANDO solicita o relatório de giro, ENTÃO o sistema calcula a rotatividade por produto (vendas/estoque médio) e destaca produtos com giro zero (parados há mais de 30 dias).

## 4. Requisitos Não-Funcionais
- PDV deve responder em < 200ms para finalização de venda; operação offline com fila de sincronização quando rede cair.
- Disponibilidade 99,5%; backup diário de transações.
- Dados de custo e margem visíveis apenas para perfil dono.

## 5. Regras de Negócio
- Código de barras é único por tenant; produto sem código pode ser vendido por busca manual.
- Venda com estoque insuficiente é bloqueada; sistema sugere venda parcial.
- Custo médio do produto recalculado a cada entrada pelo método FIFO.
- Cancelamento de venda exige senha de supervisor e recompõe o estoque.

## 6. Modelo de Dados
- products(id, barcode, name, cost_price, sell_price, stock_qty, min_stock_qty)
- stock_movements(id, product_id, movement_type, qty, cost_price, timestamp, user_id, notes)
- sales(id, total_amount, payment_method, completed_at, cashier_user_id, status)
- sale_items(id, sale_id, product_id, qty, unit_price, subtotal)

## 7. Stack sugerida
- Frontend: React + Electron (PDV desktop offline). Backend: Fastify + PostgreSQL. Auth JWT.
$md_24$ WHERE slug = 'estoque-pdv';
UPDATE spec_catalog SET template_markdown = $md_25$# Sistema de Venda e Validação de Ingressos

## 0. Metadados
- **Produto:** TicketGate — plataforma de venda de ingressos com check-in via QR Code
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Vender ingressos para eventos físicos por lotes com preços diferenciados e validar entrada via leitura de QR Code na portaria. Reduzir fraude, facilitar acesso de participantes e fornecer relatórios de vendas e presença em tempo real.

## 2. Personas
- Organizador de evento — cadastra eventos, define lotes de ingressos e acompanha vendas.
- Comprador — adquire ingressos, recebe QR Code por e-mail e apresenta na entrada.
- Porteiro — valida QR Code no app mobile e registra check-in no evento.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de eventos
DADO um organizador autenticado, QUANDO cria evento com nome, data, local, capacidade máxima e descrição, ENTÃO o evento fica disponível para configuração de lotes de ingresso.

### FR-02 — Criação de lotes de ingressos
DADO um evento cadastrado, QUANDO o organizador cria lote com nome (ex: 1º lote, VIP), quantidade disponível, preço e data limite de venda, ENTÃO o lote fica disponível para compra enquanto houver estoque e estiver dentro do prazo.

### FR-03 — Compra de ingresso
DADO um comprador no site do evento com lote disponível, QUANDO preenche dados (nome, e-mail, CPF) e conclui pagamento simulado, ENTÃO recebe ingresso com QR Code único por e-mail e o estoque do lote é decrementado.

### FR-04 — Geração de QR Code
DADO um ingresso vendido, QUANDO o sistema gera o ingresso, ENTÃO cria QR Code contendo hash SHA-256(ticket_id + secret) não reversível e único por ingresso.

### FR-05 — Check-in na entrada
DADO um porteiro com app mobile, QUANDO escaneia QR Code de ingresso, ENTÃO o sistema valida o hash, verifica se o ingresso não foi usado e registra check-in com timestamp; tentativa de reutilização do mesmo QR Code retorna erro "já utilizado".

### FR-06 — Relatório de vendas
DADO um organizador, QUANDO acessa painel do evento, ENTÃO visualiza total de ingressos vendidos por lote, receita acumulada, taxa de ocupação (vendidos / capacidade) e gráfico de vendas ao longo do tempo.

### FR-07 — Relatório de presença
DADO um evento em andamento ou finalizado, QUANDO o organizador consulta presença, ENTÃO visualiza total de check-ins realizados, lista de participantes presentes com horário de entrada e taxa de comparecimento (check-ins / ingressos vendidos).

## 4. Requisitos Não-Funcionais
- Validação de QR Code responde em < 300ms mesmo com conectividade 3G.
- Disponibilidade de 99,9% durante período de vendas e horário do evento.
- Sistema suporta pico de 500 compras simultâneas por evento.
- Dados pessoais (CPF, e-mail) são criptografados em repouso e nunca aparecem em logs (LGPD).
- QR Code não contém dados pessoais em texto claro, apenas hash validável.

## 5. Regras de Negócio
- Lote esgota quando quantidade vendida iguala quantidade disponível; compras acima do estoque retornam erro 409.
- Ingresso só pode ser usado uma única vez; segunda leitura do QR Code retorna "ingresso já utilizado" com timestamp do primeiro check-in.
- Cancelamento de ingresso é permitido até 48 horas antes do evento; após isso, ingresso é não reembolsável.
- Evento com capacidade esgotada não permite venda de novos lotes mesmo que estoque de lote anterior não tenha sido totalmente vendido.

## 6. Modelo de Dados
- events(id, organizer_id, title, description, venue, capacity, event_date, created_at)
- ticket_batches(id, event_id, name, quantity, price, sale_start, sale_end)
- tickets(id, batch_id, buyer_name, buyer_email, buyer_document, qr_code_hash, status, purchased_at)
- checkins(id, ticket_id, checked_in_by, checked_in_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI 7 (site de vendas) + React Native (app mobile de check-in).
- Backend: Fastify + PostgreSQL (índices em event_id, qr_code_hash).
- QR Code: biblioteca qrcode (Node) para geração de PNG; crypto nativo para hash SHA-256.
- E-mail: AWS SES para envio de ingresso com QR Code anexado em PDF.
$md_25$ WHERE slug = 'eventos-ingressos';
UPDATE spec_catalog SET template_markdown = $md_26$# Eventos e Networking

## 0. Metadados
- **Produto:** NetEvent — plataforma de eventos corporativos com networking
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma para organização de eventos corporativos com inscrição online, agenda personalizada, credenciamento digital e ferramentas de networking entre participantes, potencializando conexões profissionais.

## 2. Personas
- Organizador de evento — cria evento, gerencia sessões e credenciamento.
- Participante — inscreve-se, monta agenda e conecta-se com outros participantes.
- Palestrante — gerencia sua sessão e interage com participantes.

## 3. Requisitos Funcionais (FR)

### FR-01 — Criação de evento e sessões
DADO um organizador autenticado, QUANDO cria evento informando data, local e descrição e adiciona sessões com título, palestrante e horário, ENTÃO o evento é publicado e fica disponível para inscrições.

### FR-02 — Inscrição e pagamento de ingresso
DADO um usuário, QUANDO visualiza evento público e seleciona tipo de ingresso (gratuito ou pago), ENTÃO preenche dados pessoais, efetua pagamento via gateway e recebe confirmação com QR code de credenciamento.

### FR-03 — Credenciamento digital
DADO um participante inscrito, QUANDO apresenta QR code no dia do evento, ENTÃO o organizador valida via app, marca presença e libera acesso ao recinto.

### FR-04 — Agenda pessoal do participante
DADO um participante credenciado, QUANDO navega grade de programação, ENTÃO pode adicionar sessões à sua agenda pessoal e recebe lembrete 10 minutos antes de cada uma.

### FR-05 — Perfil público e busca de participantes
DADO um participante, QUANDO preenche perfil com foto, bio e interesses, ENTÃO seu perfil fica disponível para busca de outros participantes por cargo, empresa ou interesse.

### FR-06 — Solicitação de conexão entre participantes
DADO um participante, QUANDO visualiza perfil de outro participante, ENTÃO pode enviar solicitação de conexão com mensagem personalizada, e o destinatário pode aceitar ou recusar.

### FR-07 — Mensagens entre participantes conectados
DADO dois participantes conectados, QUANDO um envia mensagem, ENTÃO o outro recebe notificação em tempo real e pode responder via chat do evento.

## 4. Requisitos Não-Funcionais
- Grade de programação carrega em menos de 500ms p95.
- Disponibilidade de 99,5% durante período de inscrições.
- Chat em tempo real com latência inferior a 200ms.
- PII de participantes (CPF, telefone) nunca em logs; LGPD com consentimento explícito para networking.

## 5. Regras de Negócio
- Inscrição só é confirmada após pagamento aprovado (para ingressos pagos).
- Participante só pode adicionar à agenda sessões do evento em que está inscrito.
- Credenciamento só é válido no dia do evento e uma única vez por participante.
- Mensagens só podem ser enviadas entre participantes que aceitaram conexão mutuamente.

## 6. Modelo de Dados
- events(id, name, description, date, location, status)
- sessions(id, event_id, title, speaker, start_time, end_time, room)
- attendees(id, event_id, user_id, ticket_type, payment_status, checked_in_at)
- user_profiles(id, name, photo_url, bio, company, position, interests)
- connections(id, requester_id, recipient_id, status, created_at)
- messages(id, connection_id, sender_id, content, created_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para portal organizador/participante; React Native para app de credenciamento.
- Backend: Fastify + PostgreSQL para dados relacionais; WebSocket (Socket.io) para chat em tempo real.
- Integração: Stripe para pagamento de ingressos; Twilio para notificações SMS.
- Storage: S3 para fotos de perfil e materiais do evento.
$md_26$ WHERE slug = 'eventos-networking';
UPDATE spec_catalog SET template_markdown = $md_27$# E-commerce de Farmácia com Delivery

## 0. Metadados
- **Produto:** FarmaExpress — venda online de medicamentos com validação de receita e entrega controlada
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir compra online de medicamentos com controle de receita médica obrigatória, integração com sistemas de entrega e histórico de compras para facilitar recompra. Garante conformidade com legislação sanitária e agiliza acesso a medicamentos.

## 2. Personas
- Cliente — busca medicamentos, faz pedido e acompanha entrega.
- Farmacêutico — valida receitas enviadas e aprova dispensação de controlados.
- Operador logístico — coleta pedidos, empacota e entrega no endereço do cliente.

## 3. Requisitos Funcionais (FR)

### FR-01 — Catálogo com classificação de receita
DADO um visitante, QUANDO navega o catálogo, ENTÃO visualiza medicamentos separados em "venda livre", "receita simples" e "receita controlada", com indicação clara da exigência.

### FR-02 — Upload e validação de receita
DADO um cliente autenticado com item de receita no carrinho, QUANDO faz upload de foto ou PDF da receita, ENTÃO o sistema extrai dados (CRM, data, medicamentos) e encaminha ao farmacêutico para validação.

### FR-03 — Aprovação pelo farmacêutico
DADO uma receita pendente, QUANDO o farmacêutico revisa, ENTÃO pode aprovar (liberando o pedido), solicitar nova foto ou recusar com justificativa.

### FR-04 — Carrinho e finalização de pedido
DADO um cliente com carrinho válido e receitas aprovadas (se aplicável), QUANDO informa endereço de entrega e forma de pagamento, ENTÃO o pedido é criado com status "aguardando separação".

### FR-05 — Rastreamento de entrega
DADO um pedido com status "em rota", QUANDO o cliente acessa o rastreamento, ENTÃO visualiza localização em tempo real do entregador e previsão de chegada.

### FR-06 — Histórico de compras e recompra rápida
DADO um cliente autenticado, QUANDO acessa o histórico, ENTÃO visualiza pedidos anteriores e pode adicionar itens recorrentes ao carrinho com um clique.

### FR-07 — Notificação de status do pedido
DADO um pedido criado, QUANDO muda de status (separado, saiu para entrega, entregue), ENTÃO o cliente recebe notificação por e-mail e SMS.

## 4. Requisitos Não-Funcionais
- Receitas armazenadas criptografadas por 5 anos (exigência Anvisa).
- Dados pessoais e de saúde (PII) nunca em logs nem cache.
- Disponibilidade de 99,5% em horário comercial.
- Integração com APIs de entrega (iFood, Loggi) com fallback manual.

## 5. Regras de Negócio
- Medicamentos controlados só liberam após aprovação de farmacêutico habilitado.
- Receita simples válida por 30 dias, controlada por 30 dias (B1/B2) ou 60 dias (C1/C2).
- Cliente menor de 18 anos não pode comprar medicamentos de receita controlada.
- Prazo de entrega padrão: 2h para capital, 24h para interior.

## 6. Modelo de Dados
- products(id, name, category, requires_prescription, controlled_substance, price)
- prescriptions(id, customer_id, image_url, crm, issue_date, status, reviewed_by, reviewed_at)
- prescription_items(id, prescription_id, product_id)
- orders(id, customer_id, delivery_address, payment_method, status, total)
- order_items(id, order_id, product_id, quantity, price)
- deliveries(id, order_id, driver_id, status, estimated_arrival, delivered_at)
- customers(id, email, cpf, phone, birth_date)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI 7 + mapa de rastreamento (Mapbox).
- Backend: Fastify + PostgreSQL + AWS S3 (receitas).
- Pagamentos: integração Stripe ou PagSeguro.
- Logística: integração iFood ou API própria de entregadores.
$md_27$ WHERE slug = 'farmacia-delivery';
UPDATE spec_catalog SET template_markdown = $md_28$# Finanças Pessoais

## 0. Metadados
- **Produto:** MyFinance — controle de receitas, despesas e metas orçamentárias pessoais
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que pessoas físicas registrem receitas e despesas, categorizem transações e acompanhem metas orçamentárias mensais com relatórios visuais. Aumentar consciência financeira e reduzir gastos não planejados.

## 2. Personas
- Usuário final — registra lançamentos diários e consulta saldo.
- Gestor doméstico — define metas por categoria e analisa relatórios.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação
DADO um usuário cadastrado, QUANDO informa e-mail e senha válidos, ENTÃO recebe token JWT e acessa o dashboard.

### FR-02 — Registro de transação
DADO um usuário autenticado, QUANDO lança receita ou despesa com valor, data e categoria, ENTÃO a transação é persistida e o saldo da conta é atualizado.

### FR-03 — Categorias customizáveis
DADO um usuário, QUANDO cria categoria personalizada, ENTÃO ela fica disponível para classificação de transações futuras.

### FR-04 — Contas múltiplas
DADO um usuário com múltiplas contas bancárias, QUANDO registra transação, ENTÃO informa a conta de origem e o saldo dessa conta reflete a operação.

### FR-05 — Metas orçamentárias
DADO um usuário, QUANDO define limite mensal por categoria, ENTÃO o sistema alerta ao atingir 80% e bloqueia novos lançamentos ao estourar.

### FR-06 — Relatório mensal
DADO um usuário, QUANDO acessa relatórios, ENTÃO visualiza gráfico de pizza por categoria e evolução de saldo ao longo do mês.

## 4. Requisitos Não-Funcionais
- API < 300ms p95; disponibilidade 99%. PII (CPF, saldo) criptografado em repouso e nunca exposto em logs.

## 5. Regras de Negócio
- Saldo negativo permitido; transação não pode ter valor zero.
- Meta não retroage — só vale para mês corrente.
- Exclusão de transação recalcula saldo da conta.

## 6. Modelo de Dados
- accounts(id, user_id, name, balance)
- categories(id, user_id, name, type)
- transactions(id, account_id, category_id, amount, description, date, type)
- budgets(id, user_id, category_id, month_year, limit_amount, spent_amount)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI + Chart.js. Backend: Fastify + PostgreSQL com trigger de atualização de saldo.
$md_28$ WHERE slug = 'financeiro-pessoal';
UPDATE spec_catalog SET template_markdown = $md_29$# Carteira Digital

## 0. Metadados
- **Produto:** WalletPay — carteira digital com transferências P2P e ledger auditável
- **project_type:** backend_api
- **Versão:** 1.0

## 1. Visão
Sistema de carteira digital que permite depósitos, transferências instantâneas entre usuários e consulta de extrato, com ledger de dupla entrada e trilha de auditoria completa.

## 2. Personas
- Usuário titular — realiza depósitos, transferências e consulta saldo.
- Auditor interno — revisa lançamentos para conformidade contábil.

## 3. Requisitos Funcionais (FR)

### FR-01 — Criação de conta e autenticação
DADO um novo usuário com CPF válido, QUANDO se cadastra com e-mail e senha, ENTÃO uma conta é criada com saldo zero e ele recebe token de acesso.

### FR-02 — Depósito via boleto ou PIX
DADO um usuário autenticado, QUANDO gera um boleto ou chave PIX, ENTÃO após confirmação de pagamento via webhook o saldo é creditado e dois lançamentos são registrados no ledger (débito conta-origem, crédito conta-usuário).

### FR-03 — Transferência entre usuários com idempotência
DADO um usuário com saldo suficiente, QUANDO solicita transferência para outro usuário informando idempotency-key única, ENTÃO o saldo é debitado da origem e creditado no destino em transação atômica, e chamadas duplicadas com mesma key retornam o resultado original.

### FR-04 — Consulta de extrato paginado
DADO um usuário autenticado, QUANDO solicita extrato com filtros de data, ENTÃO recebe lista paginada de lançamentos (débitos e créditos) ordenados por data decrescente.

### FR-05 — Ledger de dupla entrada e auditoria
DADO qualquer operação financeira (depósito, transferência, estorno), QUANDO é executada, ENTÃO são criados dois lançamentos no ledger (débito e crédito) com hash criptográfico vinculando-os à operação original, garantindo rastreabilidade.

### FR-06 — Bloqueio de conta por suspeita de fraude
DADO um usuário, QUANDO o sistema detecta padrão de transações suspeitas, ENTÃO a conta é bloqueada automaticamente e novas transferências são rejeitadas até análise manual.

## 4. Requisitos Não-Funcionais
- Transferências executadas em menos de 300ms p95.
- Disponibilidade de 99,9% para operações críticas.
- PII (CPF, dados bancários) restrito a serviço de identidade, nunca em logs.
- LGPD: dados pessoais anonimizados após 5 anos de inatividade.
- Ledger imutável com auditoria por hash criptográfico.

## 5. Regras de Negócio
- Saldo nunca negativo; transferência é rejeitada se saldo insuficiente.
- Transferências são atômicas: ou ambos os lançamentos são persistidos ou nenhum.
- Idempotência garantida por 24 horas para evitar duplicação em retry de cliente.
- Cada lançamento no ledger possui exatamente uma contraparte (débito ↔ crédito).

## 6. Modelo de Dados
- accounts(id, user_id, balance, status, created_at)
- ledger_entries(id, account_id, operation_id, type, amount, balance_after, hash, created_at)
- transfers(id, from_account_id, to_account_id, amount, idempotency_key, status, created_at)
- operations(id, type, idempotency_key, status, metadata, created_at)

## 7. Stack sugerida
- Backend: Fastify + PostgreSQL com transações ACID e row-level locking.
- Cache: Redis para idempotency-keys (TTL 24h).
- Integração: webhook handlers para confirmação de pagamento (boleto/PIX).
$md_29$ WHERE slug = 'fintech-wallet';
UPDATE spec_catalog SET template_markdown = $md_30$# Fórum e Comunidade

## 0. Metadados
- **Produto:** ForumHub — plataforma de discussão com tópicos, respostas, votos e sistema de reputação
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Criar um espaço de discussão organizado por categorias onde membros compartilham perguntas, respondem tópicos, votam nas melhores contribuições e ganham reputação, incentivando engajamento e moderação comunitária.

## 2. Personas
- Membro iniciante — faz perguntas, lê respostas e vota em conteúdo útil.
- Membro experiente — responde tópicos, ganha reputação e distintivos por contribuições de qualidade.
- Moderador — revisa denúncias, remove conteúdo inadequado e aplica suspensões.

## 3. Requisitos Funcionais (FR)

### FR-01 — Categorias e tópicos
DADO um membro autenticado, QUANDO cria um tópico em uma categoria, ENTÃO o tópico é publicado com título, corpo em Markdown, tags e fica visível na lista ordenada por recência ou relevância.

### FR-02 — Respostas com votos
DADO um membro em um tópico, QUANDO publica uma resposta, ENTÃO ela aparece abaixo do tópico e outros membros podem votar positivo (+1 reputação ao autor) ou negativo (-1 reputação, custo de 1 ponto de reputação ao votante).

### FR-03 — Melhor resposta aceita pelo autor
DADO o autor de um tópico, QUANDO marca uma resposta como aceita, ENTÃO a resposta aparece destacada no topo, o autor da resposta ganha +15 reputação e o tópico é marcado como "resolvido".

### FR-04 — Sistema de reputação e distintivos
DADO um membro que acumula pontos de reputação, QUANDO atinge marcos (10/50/100/500 pontos ou 5 respostas aceitas), ENTÃO recebe distintivo visível no perfil e desbloqueia privilégios (editar posts de terceiros acima de 500 pontos).

### FR-05 — Moderação e denúncia
DADO um membro ao visualizar conteúdo ofensivo, QUANDO denuncia com motivo (spam, ofensa, conteúdo inapropriado), ENTÃO a denúncia entra na fila de moderação e, se aprovada pelo moderador, o post é removido e o autor recebe advertência.

### FR-06 — Busca e filtros avançados
DADO um membro na busca, QUANDO digita palavras-chave e aplica filtros (categoria, tags, respondido/não respondido, período), ENTÃO visualiza lista paginada de tópicos relevantes ordenados por score ou data.

### FR-07 — Notificações de atividade
DADO um membro autor de tópico ou resposta, QUANDO outro membro responde ou comenta, ENTÃO o autor recebe notificação por e-mail e na plataforma (badge com contador não lido).

## 4. Requisitos Não-Funcionais
- API com p95 < 500ms; busca full-text com latência < 300ms usando índice PostgreSQL ou Elasticsearch.
- Disponibilidade 99,5%. Cache de tópicos populares em Redis para reduzir carga no DB.
- LGPD: e-mail de membro visível apenas no perfil privado, nunca exposto publicamente. Denúncias com log de auditoria.

## 5. Regras de Negócio
- Voto negativo custa 1 ponto de reputação ao votante (evita abuso); voto positivo é gratuito.
- Tópico sem atividade há 6 meses é arquivado automaticamente (somente leitura, sem novas respostas).
- Moderador pode suspender membro por 7/30 dias ou permanentemente; suspensão permanente exige aprovação de admin.

## 6. Modelo de Dados
- categories(id, name, slug, description, order)
- topics(id, category_id, author_id, title, body_markdown, tags, views, status, accepted_answer_id, created_at)
- posts(id, topic_id, author_id, body_markdown, votes_count, is_accepted, created_at)
- votes(id, post_id, user_id, vote_type, created_at)
- members(id, username, email, reputation, badges_json, status, created_at)
- reports(id, post_id, reporter_id, reason, status, reviewed_by, reviewed_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para listagem de tópicos, editor Markdown e perfil de membro.
- Backend: Fastify + PostgreSQL com índice full-text (pg_trgm, tsvector) para busca.
- Cache: Redis para ranking de tópicos populares e contadores de reputação.
- Worker: Node.js com Bull (Redis) para envio de notificações e arquivamento de tópicos inativos.
$md_30$ WHERE slug = 'forum-comunidade';
UPDATE spec_catalog SET template_markdown = $md_31$# Plataforma de Aprendizado Gamificado

## 0. Metadados
- **Produto:** LearnQuest — plataforma de educação com gamificação e trilhas de aprendizado
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Engajar alunos em trilhas de aprendizado estruturadas com mecânicas de jogos: pontos, níveis, conquistas e ranking. Aumentar retenção e conclusão de cursos através de feedback imediato e recompensas progressivas.

## 2. Personas
- Aluno — completa lições, ganha pontos e desbloqueia conquistas ao progredir nas trilhas.
- Instrutor — cria trilhas, define pré-requisitos e acompanha desempenho da turma.
- Administrador — configura regras de pontuação e gerencia conteúdo.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro e autenticação
DADO um novo usuário com e-mail válido, QUANDO completa o cadastro e confirma o e-mail, ENTÃO recebe perfil de aluno com nível 1 e 0 pontos.

### FR-02 — Trilhas e pré-requisitos
DADO um instrutor autenticado, QUANDO cria uma trilha com lições ordenadas e define pré-requisitos entre lições, ENTÃO alunos só visualizam lições desbloqueadas após concluir as anteriores.

### FR-03 — Conclusão de lição e pontuação
DADO um aluno com lição desbloqueada, QUANDO completa todos os exercícios da lição com aproveitamento mínimo de 70%, ENTÃO ganha pontos de experiência, a próxima lição é desbloqueada e o progresso é salvo.

### FR-04 — Sistema de níveis
DADO um aluno com pontos acumulados, QUANDO a pontuação atinge o limiar do próximo nível, ENTÃO o sistema promove o aluno, exibe notificação de "subiu de nível" e desbloqueia recompensas visuais (avatar, badge).

### FR-05 — Conquistas
DADO um aluno ativo, QUANDO atinge marco específico (ex: 7 dias consecutivos estudando, 10 lições completadas, primeira trilha concluída), ENTÃO o sistema concede conquista permanente com título e ícone visível no perfil.

### FR-06 — Ranking e sequência diária
DADO um aluno, QUANDO acessa o dashboard, ENTÃO visualiza ranking semanal dos top 10 alunos por pontos, sua posição atual e contador de dias consecutivos de estudo (streak).

### FR-07 — Relatório do instrutor
DADO um instrutor, QUANDO acessa trilha que criou, ENTÃO visualiza taxa de conclusão por lição, tempo médio de conclusão e alunos que abandonaram em cada etapa.

## 4. Requisitos Não-Funcionais
- Interface responsiva carrega lições em < 800ms.
- Disponibilidade de 99,9% para suportar picos de acesso em horário escolar.
- Dados de progresso do aluno (respostas, tentativas) são privados e não compartilhados no ranking.
- Sistema suporta até 10.000 alunos ativos simultâneos.

## 5. Regras de Negócio
- Pontuação de lição é concedida apenas na primeira conclusão com aproveitamento ≥ 70%; refazer lição não gera pontos extras.
- Streak é quebrado se aluno não completar ao menos 1 lição em 24 horas desde última atividade.
- Conquistas são permanentes e não podem ser removidas ou perdidas.
- Ranking é recalculado a cada conclusão de lição; empates são desempatados por timestamp de última atividade.

## 6. Modelo de Dados
- users(id, email, role, level, total_points, streak_days, last_activity_at)
- tracks(id, title, description, instructor_id, created_at)
- lessons(id, track_id, title, order, prerequisite_lesson_id, min_score, points_reward)
- user_progress(user_id, lesson_id, score, completed_at)
- achievements(id, title, description, icon, rule)
- user_achievements(user_id, achievement_id, unlocked_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + React 19 + Framer Motion (animações de conquista).
- Backend: Fastify + PostgreSQL (índices em user_id, track_id, completed_at).
- Cache: Redis para ranking em tempo real e cálculo de streak.
$md_31$ WHERE slug = 'gamificacao-aprendizado';
UPDATE spec_catalog SET template_markdown = $md_32$# Gestão de Academia

## 0. Metadados
- **Produto:** FitManager — sistema completo de gestão para academias de ginástica
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Gerenciar matrícula, planos, cobrança recorrente, controle de acesso na catraca e fichas de treino personalizadas, com indicadores de frequência e evasão.

## 2. Personas
- Aluno — acessa sua ficha de treino e histórico de frequência.
- Recepcionista — matricula novos alunos e libera acesso à catraca.
- Gestor — acompanha inadimplência, evasão e receita recorrente.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de planos e matrícula
DADO um recepcionista autenticado, QUANDO cadastra um aluno com CPF único e seleciona um plano mensal, ENTÃO a matrícula é criada com status "ativa" e a primeira cobrança é agendada para D+30.

### FR-02 — Controle de acesso na catraca
DADO um aluno com matrícula ativa, QUANDO apresenta o QR code ou CPF na catraca, ENTÃO o sistema valida a situação financeira e, se regular, registra o check-in com timestamp.

### FR-03 — Fichas de treino personalizadas
DADO um instrutor autenticado, QUANDO cria uma ficha de treino para um aluno com exercícios, séries e repetições, ENTÃO o aluno visualiza a ficha no app e pode marcar exercícios como concluídos.

### FR-04 — Cobrança recorrente automatizada
DADO uma matrícula ativa, QUANDO chega o dia de vencimento, ENTÃO o sistema gera uma cobrança via gateway de pagamento e atualiza o status da matrícula para "inadimplente" se recusada após 3 tentativas.

### FR-05 — Relatório de frequência e evasão
DADO um gestor, QUANDO acessa o painel de métricas, ENTÃO visualiza taxa de frequência média nos últimos 30 dias e lista de alunos sem check-in há mais de 15 dias (risco de evasão).

## 4. Requisitos Não-Funcionais
- Catraca responde em < 500ms. Disponibilidade 99,5%. CPF e dados de pagamento nunca em logs. LGPD: aluno pode solicitar exclusão dos dados.

## 5. Regras de Negócio
- CPF único por academia (multi-tenant). Aluno inadimplente bloqueia catraca mas mantém acesso à ficha de treino. Plano suspenso após 60 dias sem pagamento.

## 6. Modelo de Dados
- members(id, tenant_id, cpf, nome, email, status, plano_id)
- plans(id, tenant_id, nome, valor_mensal, periodicidade)
- workouts(id, member_id, instrutor_id, exercicios_json, validade)
- checkins(id, member_id, timestamp, origem)
- charges(id, member_id, valor, vencimento, status)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para painel web. Backend: Fastify + PostgreSQL. Integração com gateway de pagamento (Stripe/Iugu). API REST para catraca IoT.
$md_32$ WHERE slug = 'gestao-academia';
UPDATE spec_catalog SET template_markdown = $md_33$# Gestão de Armazém WMS

## 0. Metadados
- **Produto:** WarehousePro — sistema de gerenciamento de armazém (WMS) com controle de estoque, endereçamento e separação de pedidos
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Otimizar operações de armazém com rastreabilidade completa de mercadorias, endereçamento inteligente e picking eficiente, reduzindo erros de separação e tempo de expedição.

## 2. Personas
- Operador de recebimento — confere entrada de mercadorias e registra localização.
- Separador (picker) — coleta itens de pedidos usando coletor de código de barras.
- Gestor de armazém — monitora ocupação, inventário e produtividade da equipe.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis operacionais
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO acessa o sistema com permissões do seu perfil (operador, separador ou gestor).

### FR-02 — Recebimento e conferência de mercadoria
DADO um operador de recebimento, QUANDO escaneia código de barras da nota fiscal e dos itens, ENTÃO o sistema valida quantidade esperada versus recebida e registra divergências.

### FR-03 — Endereçamento de itens no armazém
DADO mercadoria conferida, QUANDO o operador escaneia a posição de armazenamento (corredor, prateleira, nível), ENTÃO o sistema registra localização do item e atualiza mapa de ocupação.

### FR-04 — Geração de lista de separação (picking list)
DADO um pedido confirmado, QUANDO o sistema gera a lista de picking, ENTÃO agrupa itens por proximidade de localização para otimizar rota do separador.

### FR-05 — Separação de pedido com confirmação por código de barras
DADO um separador com lista de picking, QUANDO escaneia o item e a quantidade coletada, ENTÃO o sistema valida contra a lista e marca item como separado.

### FR-06 — Expedição e baixa de estoque
DADO um pedido totalmente separado, QUANDO o operador confirma expedição, ENTÃO o sistema dá baixa no estoque das posições correspondentes e gera documento de saída.

### FR-07 — Inventário rotativo e auditoria de estoque
DADO um gestor, QUANDO agenda inventário de uma área, ENTÃO o sistema gera lista de contagem por posição e compara resultado com estoque registrado, apontando divergências.

## 4. Requisitos Não-Funcionais
- Sistema deve responder escaneamento de código de barras em menos de 300ms para não atrasar operação.
- Disponibilidade de 99,8% em horário de operação do armazém.
- Suporte a até 50 coletores simultâneos escaneando itens.
- Integrações via API REST com sistemas de pedidos (ERP) para receber picking lists automaticamente.

## 5. Regras de Negócio
- Item só pode ser alocado em posição vazia ou que já contenha o mesmo SKU.
- Separação FIFO obrigatória para itens com validade; sistema prioriza posições com data de entrada mais antiga.
- Divergência de inventário acima de 5% aciona alerta ao gestor e recontagem obrigatória.
- Pedido parcialmente separado não pode ser expedido; sistema bloqueia até 100% coletado.

## 6. Modelo de Dados
- items(id, sku, description, barcode, unit, requires_expiry)
- locations(id, aisle, shelf, level, capacity, occupied_by_sku, quantity)
- receipts(id, supplier_invoice, receipt_date, status)
- receipt_items(id, receipt_id, item_id, expected_qty, received_qty, discrepancy)
- picking_orders(id, external_order_id, status, assigned_to, created_at)
- picking_items(id, picking_order_id, item_id, quantity, location_id, picked_qty, picked_at)
- shipments(id, picking_order_id, shipped_at, document_number)
- inventory_audits(id, location_id, scheduled_date, counted_qty, system_qty, audited_by)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI adaptado para coletores móveis (touch-first) e dashboard web para gestão.
- Backend: Fastify + PostgreSQL com otimização de rotas de picking via algoritmo de menor distância.
- Integração: API REST para receber pedidos de ERP externo; webhook para notificar expedição.
$md_33$ WHERE slug = 'gestao-armazem-wms';
UPDATE spec_catalog SET template_markdown = $md_34$# Gestão de Doações ONG

## 0. Metadados
- **Produto:** DonorHub — plataforma de gestão de doadores, campanhas e prestação de contas para ONGs
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Facilitar a captação de recursos para ONGs por meio de campanhas organizadas, doações únicas ou recorrentes, emissão automática de recibos e prestação de contas transparente por projeto, fortalecendo a confiança dos doadores.

## 2. Personas
- Doador — cadastra-se, escolhe campanha, faz doação única ou recorrente e recebe recibo.
- Gestor de ONG — cria campanhas, acompanha arrecadação em tempo real e publica prestação de contas.
- Contador da ONG — exporta relatórios de doações por período para contabilidade fiscal.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de doadores e campanhas
DADO um gestor autenticado, QUANDO cria uma campanha com título, meta financeira, prazo e descrição, ENTÃO a campanha fica ativa e visível no portal público com barra de progresso.

### FR-02 — Doação única e recorrente
DADO um doador no portal, QUANDO escolhe campanha e valor, ENTÃO pode optar por doação única ou recorrente (mensal) via cartão ou PIX, e recebe confirmação por e-mail.

### FR-03 — Emissão de recibo e comprovante de doação
DADO uma doação confirmada, QUANDO o pagamento é processado, ENTÃO o sistema gera recibo em PDF com dados da ONG, doador, valor e finalidade, enviando por e-mail e disponibilizando para download.

### FR-04 — Prestação de contas por campanha
DADO uma campanha encerrada ou em andamento, QUANDO o gestor publica prestação de contas, ENTÃO anexa comprovantes de despesas (fotos/PDFs), descreve aplicação dos recursos e notifica doadores por e-mail.

### FR-05 — Dashboard de arrecadação
DADO um gestor autenticado, QUANDO acessa dashboard, ENTÃO visualiza total arrecadado por campanha, quantidade de doadores ativos, ticket médio e gráfico de doações por mês.

### FR-06 — Renovação automática de doação recorrente
DADO um doador com doação recorrente ativa, QUANDO chega a data de cobrança mensal, ENTÃO o sistema processa cobrança no cartão cadastrado, envia confirmação e atualiza total da campanha.

## 4. Requisitos Não-Funcionais
- API com p95 < 500ms; disponibilidade 99,5%. Portal público responsivo para acesso mobile.
- LGPD: CPF de doador restrito ao recibo e relatórios internos, nunca exposto publicamente.
- Dados de cartão nunca persistidos (tokenização via gateway de pagamento).
- Worker de cobrança recorrente com retry e notificação de falha ao doador.

## 5. Regras de Negócio
- Campanha só pode ser excluída se não houver doações associadas (senão apenas arquivada).
- Doação recorrente cancelável a qualquer momento pelo doador; últimas 3 cobranças ficam visíveis no histórico.
- Recibo válido fiscalmente deve conter CNPJ da ONG, data, valor e finalidade da doação.

## 6. Modelo de Dados
- donors(id, name, cpf_hash, email, phone, created_at)
- campaigns(id, title, description, goal_amount, deadline, status, total_raised)
- donations(id, donor_id, campaign_id, amount, type, status, payment_method, receipt_url, created_at)
- recurring_donations(id, donor_id, campaign_id, amount, card_token, status, next_charge_date)
- accountability_reports(id, campaign_id, description, expenses_json, attachments_urls, published_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para portal público e painel administrativo.
- Backend: Fastify + PostgreSQL para API de campanhas, doações e recibos.
- Worker: Node.js com Bull (Redis) para cobrança recorrente e envio de e-mails.
- Integração: gateway de pagamento (Stripe/PagSeguro) para cartão e PIX; geração de PDF via Puppeteer.
$md_34$ WHERE slug = 'gestao-doacoes';
UPDATE spec_catalog SET template_markdown = $md_35$# Gestão de Documentos (DMS)

## 0. Metadados
- **Produto:** DocVault — sistema de gestão documental com versionamento, busca full-text e controle de permissões
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma de gestão de documentos empresariais que centraliza armazenamento, versiona alterações, indexa conteúdo para busca e controla acesso granular por pasta e documento. Substitui compartilhamentos de rede e elimina risco de perda de documentos críticos.

## 2. Personas
- Colaborador — faz upload de documentos, organiza em pastas, compartilha com equipe.
- Gestor de equipe — cria pastas departamentais, define permissões de leitura/escrita por usuário ou grupo.
- Auditor — consulta histórico de versões, identifica quem alterou documentos regulatórios.

## 3. Requisitos Funcionais (FR)

### FR-01 — Upload e organização em pastas
DADO um colaborador autenticado com permissão de escrita, QUANDO faz upload de arquivo para pasta e informa título e tags, ENTÃO o sistema armazena o documento, extrai metadados (tamanho, tipo MIME) e indexa conteúdo para busca.

### FR-02 — Versionamento automático de documento
DADO um documento já publicado, QUANDO um usuário com permissão faz upload de nova versão do mesmo arquivo, ENTÃO o sistema cria versão incremental (v2, v3...), preserva versões anteriores e marca a mais recente como ativa.

### FR-03 — Busca full-text por conteúdo e metadados
DADO um colaborador autenticado, QUANDO digita termo de busca, ENTÃO o sistema retorna documentos que contenham o termo no conteúdo (OCR para PDFs) ou metadados (título, tags, autor), respeitando permissões do usuário.

### FR-04 — Controle de permissões granular
DADO um gestor com permissão de administrador de pasta, QUANDO configura permissões de pasta ou documento individual, ENTÃO define por usuário ou grupo se pode visualizar, baixar, editar ou excluir, e as regras são aplicadas imediatamente.

### FR-05 — Histórico de versões e rollback
DADO um auditor visualizando documento, QUANDO acessa histórico de versões, ENTÃO visualiza lista de todas as versões com data, autor e tamanho, podendo baixar versão anterior ou promovê-la a versão ativa (rollback).

### FR-06 — Compartilhamento externo temporário
DADO um colaborador proprietário de documento, QUANDO gera link de compartilhamento externo informando prazo de validade, ENTÃO o sistema cria token de acesso público com expiração e permite download sem autenticação até a data limite.

## 4. Requisitos Não-Funcionais
- Busca full-text retorna resultados em menos de 1 segundo para índice de até 100.000 documentos.
- Disponibilidade de 99,8% para subsistema de upload e download.
- Documentos armazenados cifrados em repouso (AES-256) em storage S3 com versionamento nativo.
- PII em documentos (contratos, RH) nunca exposta em logs de auditoria, apenas hash do documento.
- Sistema suporta upload de arquivos até 100MB por documento.

## 5. Regras de Negócio
- Apenas proprietário ou administrador de pasta pode excluir documento (exclusão lógica, versões preservadas por 90 dias).
- Versões antigas ocupam storage mas não contam para limite de espaço do tenant (cobrado apenas versão ativa).
- Documento sem acesso por 2 anos é automaticamente arquivado (cold storage S3 Glacier).
- Busca só retorna documentos para os quais usuário tem ao menos permissão de leitura.

## 6. Modelo de Dados
- folders(id, parent_folder_id, name, owner_id, created_at)
- documents(id, folder_id, title, filename, storage_key, current_version, uploaded_by_id, tags)
- document_versions(id, document_id, version_number, storage_key, size_bytes, uploaded_by_id, uploaded_at)
- permissions(id, resource_type, resource_id, user_id, permission_type)
- external_shares(id, document_id, token, expires_at, created_by_id)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para interface de navegação e upload; drag-and-drop de pastas.
- Backend: Fastify + PostgreSQL para metadados; S3 para storage de documentos; Elasticsearch para busca full-text.
- Integração: Tika para extração de conteúdo de PDFs; Lambda para processamento assíncrono de OCR.
$md_35$ WHERE slug = 'gestao-documentos';
UPDATE spec_catalog SET template_markdown = $md_36$# Gestão Escolar

## 0. Metadados
- **Produto:** EduManage — sistema de gestão acadêmica para escolas de ensino básico
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Digitalizar a gestão acadêmica com controle de matrículas, turmas, notas e frequência, facilitando o acompanhamento pedagógico e a comunicação com responsáveis.

## 2. Personas
- Secretaria escolar — cadastra alunos, professores e organiza turmas.
- Professor — lança notas e frequência da sua disciplina.
- Responsável — acompanha boletim, frequência e recebe comunicados do filho.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis de acesso
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO acessa o sistema com permissões do seu perfil (secretaria, professor ou responsável).

### FR-02 — Cadastro de alunos e responsáveis
DADO um funcionário da secretaria, QUANDO preenche nome, CPF, data de nascimento e dados do responsável, ENTÃO o aluno é registrado com matrícula única e o responsável recebe credenciais de acesso.

### FR-03 — Criação de turmas e alocação de professores
DADO a secretaria, QUANDO cria uma turma informando ano letivo, série e disciplinas, ENTÃO pode atribuir um professor a cada disciplina.

### FR-04 — Matrícula de aluno em turma
DADO um aluno cadastrado, QUANDO a secretaria o matricula em uma turma, ENTÃO o aluno passa a constar na lista de presença e no diário de notas daquela turma.

### FR-05 — Lançamento de frequência pelo professor
DADO um professor autenticado, QUANDO marca presença ou falta de um aluno em uma aula, ENTÃO o registro é salvo com data e disciplina, atualizando o percentual de frequência do aluno.

### FR-06 — Lançamento de notas e cálculo de média
DADO um professor, QUANDO lança notas de avaliações (prova, trabalho), ENTÃO o sistema calcula a média ponderada da disciplina e indica se o aluno está aprovado ou em recuperação.

### FR-07 — Boletim e comunicados ao responsável
DADO um responsável autenticado, QUANDO acessa o painel do aluno, ENTÃO visualiza boletim atualizado, percentual de frequência e comunicados enviados pela escola.

## 4. Requisitos Não-Funcionais
- Sistema deve suportar carga de 500 usuários simultâneos (pico em início de semestre).
- API com resposta inferior a 600ms (p95).
- LGPD: CPF e dados pessoais de menores protegidos; acesso auditado e restrito por perfil.
- Backup diário automatizado dos dados acadêmicos.

## 5. Regras de Negócio
- Matrícula é única por aluno e não pode ser reutilizada.
- Aluno com frequência inferior a 75% é reprovado automaticamente, independente da nota.
- Professor só pode lançar notas e frequência das turmas e disciplinas atribuídas a ele.
- Ano letivo fecha em dezembro; após fechamento, notas e frequências ficam somente leitura.

## 6. Modelo de Dados
- students(id, enrollment_number, name, cpf, birthdate, guardian_id)
- guardians(id, name, email, phone)
- teachers(id, name, email, subject)
- classes(id, name, grade_level, school_year)
- class_enrollments(id, student_id, class_id, enrollment_date)
- class_subjects(id, class_id, subject_id, teacher_id)
- attendance(id, student_id, class_subject_id, date, present)
- grades(id, student_id, class_subject_id, assessment_type, score, weight)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para interface responsiva com calendário de frequência e visualização de boletim.
- Backend: Fastify + PostgreSQL com cálculo automático de médias e triggers para auditoria.
- Relatórios: geração de PDF de boletim e declarações via biblioteca html-pdf-node.
$md_36$ WHERE slug = 'gestao-escolar';
UPDATE spec_catalog SET template_markdown = $md_37$# Gestão de Fazenda

## 0. Metadados
- **Produto:** AgroSafe — gestão completa de propriedades rurais e ciclo produtivo
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma para produtores rurais controlarem talhões, safras, aplicação de insumos e custos de produção, substituindo planilhas por rastreabilidade digital e reduzindo perdas por descontrole de estoque e aplicação inadequada.

## 2. Personas
- Produtor rural — cadastra talhões, planeja safras e acompanha custos e produtividade.
- Engenheiro agrônomo — registra aplicações de defensivos e fertilizantes, emite recomendações técnicas.
- Operador de máquinas — consulta prescrições de aplicação e registra execução no campo.

## 3. Requisitos Funcionais (FR)
### FR-01 — Autenticação e controle de acesso por perfil
DADO um usuário cadastrado com e-mail e senha, QUANDO informa credenciais válidas, ENTÃO recebe um token de sessão e acessa funcionalidades conforme seu perfil (produtor, agrônomo ou operador).

### FR-02 — Cadastro de talhões e culturas
DADO um produtor autenticado, QUANDO cadastra um talhão informando área em hectares, coordenadas GPS e cultura plantada, ENTÃO o sistema registra o talhão com status "ativo" e permite vincular safras futuras.

### FR-03 — Planejamento de safra
DADO um produtor, QUANDO cria um planejamento de safra vinculando talhões, data de plantio e variedade de semente, ENTÃO o sistema calcula a data estimada de colheita e inicia o ciclo produtivo.

### FR-04 — Registro de aplicação de insumos
DADO um operador no campo, QUANDO registra uma aplicação informando insumo, quantidade, dose por hectare e talhão, ENTÃO o sistema deduz do estoque, registra a operação com timestamp e vincula ao ciclo da safra.

### FR-05 — Controle de estoque de insumos
DADO um estoque de insumos cadastrados, QUANDO ocorre entrada por compra ou saída por aplicação, ENTÃO o saldo é atualizado e alertas são emitidos ao produtor quando o nível atingir o ponto de reposição.

### FR-06 — Cálculo de custo e produtividade por talhão
DADO uma safra encerrada, QUANDO o sistema consolida todos os insumos aplicados e a produção colhida, ENTÃO calcula o custo total por hectare e a produtividade em sacas/hectare, exibindo no painel comparativo.

### FR-07 — Rastreabilidade e auditoria de operações
DADO qualquer operação registrada no sistema, QUANDO o usuário consulta o histórico de um talhão ou safra, ENTÃO visualiza a linha do tempo completa com datas, responsáveis e insumos aplicados, gerando relatório para certificação.

## 4. Requisitos Não-Funcionais
- Aplicativo mobile funcionar offline no campo e sincronizar quando houver rede.
- Resposta de API < 500ms p95; disponibilidade 99%.
- Dados de produtividade e custos restritos ao proprietário da fazenda.

## 5. Regras de Negócio
- Um talhão só pode receber uma safra ativa por vez; safras encerradas liberam o talhão para novo plantio.
- Aplicação de defensivos exige receituário agronômico válido vinculado ao registro.
- Estoque negativo de insumos é bloqueado; aplicação sem saldo é rejeitada.
- Produtividade calculada apenas após registro de colheita com peso aferido.

## 6. Modelo de Dados
- farms(id, name, owner_id, total_area_ha)
- fields(id, farm_id, name, area_ha, gps_coords, status)
- crops(id, name, variety, avg_cycle_days)
- seasons(id, field_id, crop_id, planted_at, estimated_harvest_at, actual_harvest_at, yield_kg, status)
- inputs(id, name, type, unit, stock_qty, reorder_point)
- applications(id, season_id, input_id, qty, dose_per_ha, applied_at, applied_by_user_id)
- input_movements(id, input_id, movement_type, qty, timestamp)

## 7. Stack sugerida
- Frontend: Next.js 14 + React Native (mobile offline). Backend: Fastify + PostgreSQL + PostGIS (coords). Auth JWT.
$md_37$ WHERE slug = 'gestao-fazenda';
UPDATE spec_catalog SET template_markdown = $md_38$# Gestão de Frota

## 0. Metadados
- **Produto:** FleetOps — gestão de frota para transportadoras
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Controlar veículos, motoristas e manutenção, reduzindo paradas não planejadas e custo por quilômetro rodado. O sistema centraliza abastecimento, ordens de serviço e alertas de vencimento de documentos.

## 2. Personas
- Gestor de frota — cadastra veículos, acompanha custos e planeja manutenção preventiva.
- Motorista — registra abastecimentos e quilometragem no campo.
- Mecânico — recebe e executa ordens de manutenção.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO recebe token e acessa dashboard conforme perfil (gestor, motorista ou mecânico).

### FR-02 — Cadastro de veículos
DADO um gestor autenticado, QUANDO cadastra veículo com placa única, modelo, ano e quilometragem inicial, ENTÃO o veículo é persistido como "disponível".

### FR-03 — Registro de abastecimento
DADO um motorista, QUANDO registra litros, valor pago e leitura do hodômetro, ENTÃO o sistema calcula consumo médio (km/L) e atualiza quilometragem do veículo.

### FR-04 — Ordens de manutenção
DADO um gestor, QUANDO abre ordem de serviço para veículo com descrição e tipo (preventiva ou corretiva), ENTÃO o veículo passa a status "em manutenção" até conclusão.

### FR-05 — Alertas de vencimento de documentos
DADO um veículo com CRLV ou seguro a vencer em 30 dias, QUANDO o sistema executa job diário, ENTÃO envia notificação ao gestor de frota.

### FR-06 — Relatório de custos por veículo
DADO um gestor, QUANDO consulta relatório mensal, ENTÃO vê total gasto por veículo (combustível + manutenção) e custo por km rodado.

### FR-07 — Gestão de motoristas
DADO um gestor, QUANDO cadastra motorista com CNH e data de validade, ENTÃO o sistema alerta 60 dias antes do vencimento da habilitação.

## 4. Requisitos Não-Funcionais
- API responde em < 400ms p95; disponibilidade 99,5%. Dados pessoais (CNH, CPF) nunca em logs. Backup diário automático. Mobile-friendly para motoristas em campo.

## 5. Regras de Negócio
- Placa única por tenant. Veículo em manutenção não recebe nova viagem. Consumo médio recalculado a cada abastecimento. Alerta de documento dispara apenas uma vez até renovação.

## 6. Modelo de Dados
- vehicles(id, plate, model, year, status, odometer, tenant_id)
- drivers(id, name, cnh, cnh_expiry, tenant_id)
- fuel_logs(id, vehicle_id, driver_id, liters, amount, odometer, date)
- maintenance_orders(id, vehicle_id, type, description, status, opened_at, closed_at, cost)
- documents(id, vehicle_id, type, number, expiry_date)

## 7. Stack sugerida
- Frontend: Next.js 14 App Router + MUI 7 (responsivo). Backend: Fastify + PostgreSQL. Job scheduler: node-cron para alertas. Relatórios: exportação CSV.
$md_38$ WHERE slug = 'gestao-frota';
UPDATE spec_catalog SET template_markdown = $md_39$# Gestão de Locação

## 0. Metadados
- **Produto:** RentFlow — sistema de gestão de contratos de locação imobiliária com cobrança e reajuste automático
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Automatizar a administração de contratos de aluguel, gerando cobranças mensais com reajuste indexado, registrando vistorias de entrada e saída e facilitando o repasse ao proprietário com transparência.

## 2. Personas
- Imobiliária (gestor) — cadastra imóveis, contratos, gera cobranças e acompanha inadimplência.
- Inquilino — visualiza contrato, histórico de pagamentos e segunda via de boleto.
- Proprietário — recebe repasse mensal e relatório de ocupação do imóvel.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de imóveis e proprietários
DADO um gestor autenticado, QUANDO cadastra um imóvel com endereço, tipo e valor de referência, ENTÃO o imóvel fica disponível para locação e vinculado ao proprietário informado.

### FR-02 — Criação de contrato de locação com índice de reajuste
DADO um gestor ao criar contrato, QUANDO informa inquilino, imóvel, valor inicial, data de início, prazo e índice (IGP-M/IPCA), ENTÃO o contrato é registrado com vigência calculada e reajuste agendado anualmente.

### FR-03 — Geração automática de cobrança mensal
DADO um contrato vigente, QUANDO o worker de cobrança executa no dia de vencimento, ENTÃO gera boleto ou PIX com valor do aluguel (reajustado se aplicável) e envia ao inquilino por e-mail.

### FR-04 — Vistoria de entrada e saída
DADO um contrato ao iniciar ou encerrar, QUANDO o gestor registra vistoria com checklist de itens e fotos, ENTÃO a vistoria é anexada ao contrato e serve de referência para devolução de caução.

### FR-05 — Repasse ao proprietário
DADO um pagamento confirmado pelo inquilino, QUANDO o gestor processa repasse, ENTÃO calcula taxa de administração (%), registra repasse ao proprietário e gera comprovante.

### FR-06 — Alerta de inadimplência
DADO uma cobrança vencida há mais de 5 dias, QUANDO o sistema verifica status, ENTÃO envia alerta ao inquilino e gestor por e-mail e marca contrato como "em atraso".

## 4. Requisitos Não-Funcionais
- API com p95 < 400ms; disponibilidade 99,5%. Worker de cobrança com garantia de execução (idempotência por mês/contrato).
- LGPD: CPF de inquilino e proprietário restritos ao contexto do contrato, nunca em logs.
- Documentos de vistoria (fotos) armazenados em S3 com URL assinada e expiração de 7 dias para acesso.

## 5. Regras de Negócio
- Reajuste aplicado apenas após 12 meses da última atualização, baseado na variação acumulada do índice escolhido.
- Contrato não pode ser excluído se houver cobranças pagas (apenas arquivado).
- Taxa de administração padrão de 10%, configurável por contrato.

## 6. Modelo de Dados
- properties(id, address, type, reference_value, owner_id, status)
- owners(id, name, cpf_hash, bank_account, email)
- tenants(id, name, cpf_hash, phone, email)
- contracts(id, property_id, tenant_id, start_date, end_date, monthly_rent, adjustment_index, status)
- charges(id, contract_id, due_date, amount, status, payment_date, barcode)
- inspections(id, contract_id, type, checklist_json, photos_urls, created_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para painel de gestão e portal do inquilino.
- Backend: Fastify + PostgreSQL para API de contratos, cobranças e repasses.
- Worker: Node.js com Bull (Redis) para geração de cobrança recorrente e alertas.
- Integração: API de boleto (Banco do Brasil/Itaú) ou PIX para geração de cobrança.
$md_39$ WHERE slug = 'gestao-locacao';
UPDATE spec_catalog SET template_markdown = $md_40$# Plataforma de Gestão de Redes Sociais

## 0. Metadados
- **Produto:** SocialHub — agendamento e análise de desempenho multicanal para redes sociais
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Centralizar criação, agendamento e publicação de conteúdo em múltiplas redes sociais, com análise de métricas de alcance e engajamento. Reduz tempo de gestão e melhora consistência da presença digital.

## 2. Personas
- Social media manager — agenda posts, monitora métricas e ajusta estratégia de conteúdo.
- Designer de conteúdo — cria artes e textos para os posts.
- Cliente final — aprova previamente os posts antes da publicação.

## 3. Requisitos Funcionais (FR)

### FR-01 — Conexão de contas de redes sociais
DADO um usuário autenticado, QUANDO autoriza conexão via OAuth com Instagram, Facebook, LinkedIn ou Twitter, ENTÃO o sistema armazena token de acesso e exibe a conta como conectada.

### FR-02 — Criação e agendamento de post
DADO uma conta conectada, QUANDO o usuário cria post com texto, imagem e seleciona data/hora futura, ENTÃO o post é salvo com status "agendado" e aparece no calendário.

### FR-03 — Pré-visualização multicanal
DADO um post criado, QUANDO o usuário solicita pré-visualização, ENTÃO o sistema renderiza como ficará em cada rede social conectada (formato de imagem, limite de caracteres).

### FR-04 — Publicação automática na data agendada
DADO um post com status "agendado" e data/hora atual >= agendamento, QUANDO o worker de publicação roda, ENTÃO publica via API de cada rede e atualiza status para "publicado".

### FR-05 — Coleta de métricas de desempenho
DADO posts publicados, QUANDO o worker de métricas sincroniza (a cada 6h), ENTÃO busca impressões, curtidas, comentários e compartilhamentos de cada rede e persiste no histórico.

### FR-06 — Dashboard analítico com filtros
DADO um usuário autenticado, QUANDO acessa o dashboard, ENTÃO visualiza gráficos de engajamento por rede, melhor horário de publicação e comparação entre períodos.

### FR-07 — Fluxo de aprovação de posts
DADO um post criado em conta com aprovação habilitada, QUANDO o criador submete para aprovação, ENTÃO o cliente recebe notificação, revisa e pode aprovar ou solicitar ajustes.

## 4. Requisitos Não-Funcionais
- Sincronização de métricas < 10min após publicação.
- Suporte a 50 contas conectadas por workspace.
- Disponibilidade de 99% para agendamento e 95% para publicação (dependência de APIs externas).
- Retry em falha de publicação com 3 tentativas em 15min.

## 5. Regras de Negócio
- Post agendado para menos de 10 minutos no futuro é rejeitado.
- Falha em publicação gera alerta imediato ao social media manager.
- Imagem acima de 5MB é redimensionada antes do upload.
- Histórico de métricas mantido por 12 meses.

## 6. Modelo de Dados
- workspaces(id, name, plan)
- social_accounts(id, workspace_id, platform, username, access_token, refresh_token)
- posts(id, workspace_id, content, media_url, scheduled_for, status, approval_required)
- post_publications(id, post_id, account_id, published_at, external_id, status)
- metrics(id, publication_id, impressions, likes, comments, shares, collected_at)
- users(id, workspace_id, email, role)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI 7 + recharts.
- Backend: Fastify + PostgreSQL.
- Workers: Bull para publicação e coleta de métricas.
- Integração: APIs oficiais Instagram Graph, Facebook Graph, LinkedIn Share, Twitter v2.
$md_40$ WHERE slug = 'gestao-redes-sociais';
UPDATE spec_catalog SET template_markdown = $md_41$# Protocolo de Processos

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
$md_41$ WHERE slug = 'gov-protocolo';
UPDATE spec_catalog SET template_markdown = $md_42$# Helpdesk de Tickets

## 0. Metadados
- **Produto:** SupportHub — plataforma de atendimento e resolução de chamados com controle de SLA
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Centralizar e agilizar o atendimento de suporte técnico com filas organizadas, histórico completo e monitoramento de SLA, reduzindo tempo de resolução e aumentando a satisfação do cliente.

## 2. Personas
- Atendente — visualiza tickets da sua fila, responde chamados e muda status.
- Cliente — abre tickets, acompanha status e avalia o atendimento.
- Gestor de suporte — monitora SLA, distribui filas e analisa indicadores.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis de acesso
DADO um usuário cadastrado, QUANDO informa e-mail e senha válidos, ENTÃO recebe token JWT e acessa o dashboard do seu perfil (cliente, atendente ou gestor).

### FR-02 — Abertura de ticket pelo cliente
DADO um cliente autenticado, QUANDO preenche título, descrição, categoria e prioridade, ENTÃO o ticket é criado com status "novo" e número de protocolo único.

### FR-03 — Atribuição de tickets a filas e atendentes
DADO um ticket novo, QUANDO um gestor atribui a uma fila, ENTÃO atendentes daquela fila visualizam o ticket e podem assumir o atendimento.

### FR-04 — Histórico de mensagens no ticket
DADO um ticket em atendimento, QUANDO o atendente ou cliente envia uma mensagem, ENTÃO ela é registrada com timestamp e autor, visível para ambas as partes.

### FR-05 — Controle de SLA e alertas
DADO um ticket com prioridade e SLA definidos, QUANDO o prazo está próximo de expirar (80%), ENTÃO o gestor e o atendente responsável recebem alerta visual e por e-mail.

### FR-06 — Resolução e avaliação de ticket
DADO um ticket resolvido pelo atendente, QUANDO o cliente confirma a resolução, ENTÃO o ticket é fechado e o cliente pode avaliar o atendimento com nota de 1 a 5.

### FR-07 — Indicadores de desempenho
DADO um gestor autenticado, QUANDO acessa o dashboard de indicadores, ENTÃO visualiza tempo médio de primeira resposta, tempo médio de resolução, tickets dentro e fora do SLA e avaliação média do período.

## 4. Requisitos Não-Funcionais
- API deve responder em menos de 500ms (p95) sob carga de 100 tickets simultâneos.
- Disponibilidade de 99,5% em horário comercial.
- PII (e-mail, telefone do cliente) nunca em logs; dados anonimizados em relatórios.
- Notificações por e-mail devem ser enviadas em até 2 minutos após o evento.

## 5. Regras de Negócio
- Ticket sem categoria é automaticamente classificado como "Geral".
- SLA começa a contar a partir da abertura do ticket e pausa quando aguarda resposta do cliente.
- Atendente só pode assumir tickets da sua fila; gestor pode reatribuir tickets entre filas.
- Cliente não pode reabrir ticket fechado há mais de 30 dias.

## 6. Modelo de Dados
- users(id, email, name, role)
- tickets(id, protocol, subject, category, priority, status, sla_deadline, created_at, assigned_to, customer_id)
- ticket_messages(id, ticket_id, author_id, message, created_at)
- queues(id, name, department)
- queue_assignments(queue_id, agent_id)
- ticket_ratings(id, ticket_id, rating, comment)

## 7. Stack sugerida
- Frontend: Next.js 14 App Router + MUI para dashboard responsivo e notificações em tempo real.
- Backend: Fastify + PostgreSQL para API REST com suporte a filtros avançados e agregações de SLA.
- Notificações: Amazon SES para e-mails e WebSocket para alertas em tempo real.
$md_42$ WHERE slug = 'helpdesk-tickets';
UPDATE spec_catalog SET template_markdown = $md_43$# Geração de Imagens com IA

## 0. Metadados
- **Produto:** ArtGen — geração e edição de imagens a partir de prompts com controle de créditos
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que usuários criem imagens a partir de descrições textuais, explorem variações, editem por máscara e gerenciem créditos de uso.

## 2. Personas
- Designer — gera imagens para projetos, explora variações e exporta resultados.
- Usuário casual — cria imagens por hobby, testa prompts e compartilha na galeria.
- Administrador — gerencia planos de créditos e monitora uso.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e créditos iniciais
DADO um novo usuário cadastrado, QUANDO confirma e-mail e faz login, ENTÃO recebe 50 créditos gratuitos.

### FR-02 — Geração de imagem por prompt com parâmetros
DADO um usuário com créditos disponíveis, QUANDO envia prompt "gato astronauta" com estilo "realista" e resolução "1024x1024", ENTÃO a imagem é gerada em até 30 segundos e consome 10 créditos.

### FR-03 — Galeria de resultados por usuário
DADO um usuário autenticado, QUANDO acessa a galeria, ENTÃO vê todas as imagens geradas com data, prompt e opção de baixar ou excluir.

### FR-04 — Variações de imagem existente
DADO um usuário com uma imagem gerada, QUANDO solicita 4 variações, ENTÃO o sistema cria novas versões consumindo 2 créditos por variação.

### FR-05 — Edição por máscara (inpainting)
DADO um usuário com imagem gerada, QUANDO desenha máscara e envia novo prompt "adicionar óculos de sol", ENTÃO a área marcada é regenerada mantendo o restante.

### FR-06 — Compra de créditos
DADO um usuário sem créditos, QUANDO escolhe pacote de 500 créditos e confirma pagamento, ENTÃO o saldo é atualizado e ele recebe recibo por e-mail.

### FR-07 — Histórico de uso e saldo
DADO um usuário autenticado, QUANDO acessa "Meu saldo", ENTÃO vê créditos disponíveis e histórico de gerações com custo de cada uma.

## 4. Requisitos Não-Funcionais
- Geração em até 30 segundos para resolução padrão. API de inferência com fila para gerenciar picos. Disponibilidade 99%. Imagens armazenadas por 90 dias. PII (e-mail, pagamento) nunca em logs.

## 5. Regras de Negócio
- Créditos não expiram. Usuário sem créditos só pode visualizar galeria. Resolução maior consome mais créditos (512x512=5, 1024x1024=10, 2048x2048=20). Máximo 10 gerações simultâneas por usuário.

## 6. Modelo de Dados
- users(id, email, password_hash, credits_balance)
- generations(id, user_id, prompt, style, resolution, image_url, credits_used, created_at)
- credit_transactions(id, user_id, amount, type, description, created_at)
- payment_orders(id, user_id, credits_purchased, amount_paid, status, paid_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + Canvas API para máscara. Backend: Fastify + PostgreSQL + fila RabbitMQ para inferência. IA: Stable Diffusion via Replicate ou Amazon Bedrock. Storage: S3 para imagens.
$md_43$ WHERE slug = 'ia-geracao-imagens';
UPDATE spec_catalog SET template_markdown = $md_44$# Portal Imobiliário

## 0. Metadados
- **Produto:** ImobiFinder — portal de anúncios imobiliários conectando compradores, locatários e corretores
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma web e mobile para corretores publicarem imóveis com fotos e detalhes, interessados buscarem por filtros avançados e agendarem visitas, reduzindo tempo de venda e aumentando alcance de anúncios.

## 2. Personas
- Corretor imobiliário — cadastra imóveis, publica anúncios, recebe leads e agenda visitas.
- Comprador/locatário — busca imóveis por bairro, preço e características, favorita anúncios e solicita contato.
- Administrador da imobiliária — aprova anúncios, monitora performance de corretores e gerencia planos de destaque.

## 3. Requisitos Funcionais (FR)
### FR-01 — Autenticação e perfis de usuário
DADO um usuário cadastrado com e-mail e senha, QUANDO informa credenciais válidas, ENTÃO recebe um token de sessão e acessa funcionalidades conforme seu perfil (comprador, corretor ou administrador).

### FR-02 — Cadastro de imóveis com fotos e características
DADO um corretor autenticado, QUANDO cadastra um imóvel informando tipo (casa, apartamento, terreno), endereço, valor, área útil, quartos, vagas e upload de até 20 fotos, ENTÃO o sistema registra o imóvel com status "rascunho" e permite publicação após aprovação do administrador.

### FR-03 — Busca de imóveis por filtros
DADO um comprador no portal, QUANDO informa filtros de tipo de negócio (venda ou locação), faixa de preço, bairro, número de quartos e área mínima, ENTÃO o sistema retorna lista paginada de imóveis que atendem aos critérios, ordenados por relevância e data de publicação.

### FR-04 — Galeria de fotos e tour virtual
DADO um imóvel publicado com fotos, QUANDO o comprador visualiza o anúncio, ENTÃO o sistema exibe galeria responsiva com navegação por thumbnails, zoom e indicador de foto principal; se houver tour virtual 360°, exibe player embarcado.

### FR-05 — Solicitação de contato e agendamento de visita
DADO um comprador interessado em um imóvel, QUANDO clica em "Agendar visita" e preenche nome, telefone, e-mail e horário preferencial, ENTÃO o sistema registra o lead, notifica o corretor responsável por e-mail e WhatsApp, e o corretor recebe o pedido no painel de agendamentos.

### FR-06 — Painel do corretor com leads e visitas
DADO um corretor autenticado, QUANDO acessa o painel de controle, ENTÃO visualiza lista de leads recebidos (novos, em negociação, visitados, convertidos), imóveis publicados, estatísticas de visualizações e funil de conversão.

## 4. Requisitos Não-Funcionais
- Busca de imóveis retorna resultados em < 300ms; cache de filtros comuns.
- Upload de fotos suporta até 5MB por imagem; resize automático para thumbnail e alta resolução.
- Disponibilidade 99,5%; imagens servidas via CDN.
- Dados de contato de leads visíveis apenas para o corretor responsável e administrador.

## 5. Regras de Negócio
- Um imóvel só pode ser publicado após aprovação do administrador; imóveis reprovados retornam a "rascunho" com motivo.
- Endereço completo do imóvel só é exibido para usuários autenticados; busca pública mostra apenas bairro.
- Leads duplicados (mesmo e-mail para o mesmo imóvel em < 7 dias) são agrupados e não notificam novamente.
- Imóveis sem fotos não podem ser publicados; mínimo 3 fotos obrigatório.

## 6. Modelo de Dados
- users(id, email, name, phone, role, status)
- properties(id, owner_user_id, type, transaction_type, price, address, neighborhood, area_sqm, bedrooms, bathrooms, parking_spots, description, status, published_at)
- property_media(id, property_id, file_url, media_type, display_order, is_primary)
- leads(id, property_id, inquirer_name, inquirer_email, inquirer_phone, message, preferred_visit_time, status, created_at)
- favorites(id, user_id, property_id, created_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI + Leaflet (mapas). Backend: Fastify + PostgreSQL + PostGIS (busca geográfica) + Redis (cache). Auth JWT. Storage: S3 + CloudFront.
$md_44$ WHERE slug = 'imob-anuncios';
UPDATE spec_catalog SET template_markdown = $md_45$# Telemetria IoT

## 0. Metadados
- **Produto:** IoTMonitor — plataforma de telemetria para dispositivos IoT com dashboards e alertas em tempo real
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma de ingestão e visualização de telemetria de sensores IoT, suportando milhares de dispositivos simultâneos. Armazena séries temporais de métricas, dispara alertas por violação de limiar e exibe dashboards customizáveis em tempo real.

## 2. Personas
- Técnico de campo — instala sensores, registra dispositivos na plataforma e acompanha saúde dos equipamentos.
- Operador — monitora dashboards de métricas agregadas, responde a alertas de threshold.
- Gestor — analisa histórico de telemetria, identifica padrões e planeja manutenções preventivas.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de dispositivo IoT
DADO um técnico autenticado, QUANDO registra novo dispositivo informando identificador único, tipo de sensor e localização, ENTÃO o sistema gera token de autenticação MQTT e persiste o dispositivo com status "inativo".

### FR-02 — Ingestão de leituras via MQTT
DADO um dispositivo cadastrado, QUANDO publica leitura em tópico MQTT informando timestamp, métrica e valor, ENTÃO o sistema valida token, persiste leitura em série temporal e atualiza status do dispositivo para "ativo".

### FR-03 — Série temporal por métrica
DADO um operador visualizando dashboard, QUANDO seleciona dispositivo e métrica (temperatura, umidade, pressão), ENTÃO o sistema retorna série temporal das últimas 24 horas com granularidade de 1 minuto.

### FR-04 — Configuração de alertas por limiar
DADO um operador autenticado, QUANDO cria regra de alerta informando métrica, operador de comparação (>, <, =) e valor de limiar, ENTÃO a regra é ativada e passa a avaliar leituras em tempo real.

### FR-05 — Disparo de alerta em tempo real
DADO uma leitura recém-ingerida, QUANDO o valor viola regra de alerta ativa, ENTÃO o sistema cria evento de alerta, envia notificação push para operadores e registra no histórico de alertas do dispositivo.

### FR-06 — Dashboard customizável
DADO um gestor autenticado, QUANDO cria dashboard informando widgets (gráfico de linha, gauge, mapa de calor) e métricas, ENTÃO o dashboard é salvo e atualiza automaticamente com dados em tempo real via WebSocket.

### FR-07 — Detecção de dispositivo offline
DADO um dispositivo ativo, QUANDO passa 10 minutos sem enviar leitura, ENTÃO o sistema muda status para "offline" e dispara alerta de conectividade para técnico responsável.

## 4. Requisitos Não-Funcionais
- Ingestão suporta até 10.000 leituras por segundo com latência máxima de 500ms.
- Disponibilidade de 99,9% para subsistema de ingestão.
- Retenção de séries temporais por 90 dias com granularidade de 1 minuto; agregação diária para histórico de 2 anos.
- Dashboard atualiza em tempo real com latência máxima de 2 segundos (WebSocket).

## 5. Regras de Negócio
- Token MQTT de dispositivo expira após 1 ano; renovação automática 30 dias antes do vencimento.
- Leituras com timestamp futuro ou anterior a 1 hora são rejeitadas (proteção contra clock skew).
- Alerta só dispara uma vez até que métrica retorne a faixa normal (evita spam).
- Dispositivo sem leitura por 30 dias é automaticamente marcado como "desativado".

## 6. Modelo de Dados
- devices(id, device_id, type, location_lat, location_lng, mqtt_token, status, last_seen_at)
- readings(device_id, metric, value, timestamp) — tabela de série temporal (TimescaleDB/InfluxDB)
- alert_rules(id, metric, operator, threshold, device_id, active)
- alerts(id, rule_id, device_id, triggered_at, value, acknowledged_at)
- dashboards(id, user_id, name, layout_config)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para portal; Recharts para gráficos; WebSocket para updates em tempo real.
- Backend: Fastify + TimescaleDB para séries temporais; Redis para cache de dispositivos ativos; Mosquitto MQTT broker.
- Infraestrutura: SQS para fila de ingestão assíncrona; Lambda para avaliação de regras de alerta.
$md_45$ WHERE slug = 'iot-telemetria';
UPDATE spec_catalog SET template_markdown = $md_46$# Portal de Licitações

## 0. Metadados
- **Produto:** LicitaBR — portal de licitações públicas para órgãos governamentais
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Publicar editais de licitação, habilitar fornecedores, receber propostas lacradas e divulgar resultados com total transparência e trilha de auditoria, atendendo a Lei 8.666/93 e 14.133/21.

## 2. Personas
- Gestor público — publica editais, habilita fornecedores e homologa vencedores.
- Fornecedor — cadastra-se, habilita-se em editais e envia propostas lacradas.
- Cidadão — consulta editais publicados e resultados homologados.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro e habilitação de fornecedores
DADO um fornecedor com CNPJ válido, QUANDO preenche o formulário de cadastro com documentação fiscal em dia, ENTÃO é habilitado para participar de licitações após validação pelo gestor.

### FR-02 — Publicação de editais
DADO um gestor público autenticado, QUANDO publica um edital com objeto, valor estimado, prazo de entrega de propostas e critério de julgamento (menor preço, técnica e preço), ENTÃO ele fica visível publicamente e notifica fornecedores habilitados.

### FR-03 — Envio de proposta lacrada
DADO um fornecedor habilitado visualizando um edital, QUANDO envia uma proposta com valor e prazo antes do término do prazo, ENTÃO ela é criptografada e armazenada como lacrada até a data de abertura.

### FR-04 — Abertura de propostas
DADO um edital com prazo de entrega de propostas encerrado, QUANDO o gestor inicia a abertura, ENTÃO todas as propostas são descriptografadas, ordenadas por critério (menor preço) e registradas em ata pública.

### FR-05 — Homologação e publicação do resultado
DADO um edital com propostas abertas, QUANDO o gestor homologa o vencedor e publica a ata, ENTÃO todos os fornecedores participantes recebem notificação e a ata fica disponível publicamente com nome do vencedor e valor.

### FR-06 — Consulta pública de editais e resultados
DADO um cidadão, QUANDO acessa o portal, ENTÃO visualiza todos os editais publicados e resultados homologados com filtros por órgão, data e objeto.

## 4. Requisitos Não-Funcionais
- Criptografia de propostas com chave assimétrica (RSA 2048). Trilha de auditoria completa (log imutável de todas as ações com timestamp e IP). Disponibilidade 99,8%. Conformidade com LGPD e Lei de Acesso à Informação. Backup diário de propostas e atas.

## 5. Regras de Negócio
- Proposta só pode ser enviada antes do prazo de encerramento.
- Fornecedor não pode alterar proposta após envio.
- Abertura só ocorre após prazo encerrado.
- Vencedor é o de menor preço (se critério for menor preço) entre habilitados.

## 6. Modelo de Dados
- tenders(id, object, estimated_value, submission_deadline, opening_date, judgment_criteria, published_by, status)
- suppliers(id, cnpj, company_name, legal_rep, tax_docs_valid, approved)
- proposals(id, tender_id, supplier_id, encrypted_data, submitted_at, opened_at, value, delivery_days)
- awards(id, tender_id, supplier_id, awarded_value, published_at)
- audit_log(id, entity_type, entity_id, action, user_id, ip, timestamp)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI. Backend: Fastify + PostgreSQL. Criptografia: biblioteca Node.js crypto com RSA. Auditoria: tabela append-only com trigger de bloqueio de UPDATE/DELETE.
$md_46$ WHERE slug = 'licitacoes';
UPDATE spec_catalog SET template_markdown = $md_47$# Página de Links (Link in Bio)

## 0. Metadados
- **Produto:** LinkHub — agregador de links pessoais para redes sociais (link in bio)
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Oferecer uma página pública responsiva com avatar e múltiplos links clicáveis, acessível via slug único, com painel autenticado para edição e métricas de cliques.

## 2. Personas
- Criador de conteúdo — publica links de redes sociais, loja, portfólio e produtos na bio do Instagram.
- Visitante — acessa a página pública e clica em links de interesse.

## 3. Requisitos Funcionais (FR)

### FR-01 — Criação de página com slug único
DADO um criador autenticado, QUANDO cadastra uma página com slug "maria-silva", título e upload de avatar, ENTÃO a página é criada e fica acessível em `/maria-silva`.

### FR-02 — Página pública responsiva
DADO um visitante, QUANDO acessa `/maria-silva`, ENTÃO visualiza avatar circular, título, e lista vertical de links com ícone e rótulo, otimizada para mobile.

### FR-03 — Painel de edição de links
DADO um criador autenticado no painel, QUANDO adiciona um link com rótulo "Meu canal" e URL "https://youtube.com/...", ENTÃO o link aparece na página pública e pode ser reordenado por drag-and-drop.

### FR-04 — Métrica de cliques por link
DADO um link na página pública, QUANDO um visitante clica, ENTÃO o sistema incrementa o contador de cliques e exibe a métrica no painel do criador.

### FR-05 — Personalização visual
DADO um criador no painel, QUANDO escolhe uma cor de tema (ex: azul escuro) e estilo de botão (arredondado), ENTÃO a página pública reflete a customização imediatamente.

## 4. Requisitos Não-Funcionais
- Página pública carrega em < 1 segundo. Disponibilidade 99,9%. Slug único não pode ser alterado após criação (SEO). Cliques registrados sem PII do visitante (apenas contador anônimo).

## 5. Regras de Negócio
- Slug com 3-30 caracteres alfanuméricos e hífen, único no sistema. Página inativa não aparece em busca pública. Link sem URL válida não é salvo. Avatar limitado a 2MB (JPG/PNG).

## 6. Modelo de Dados
- pages(id, user_id, slug, titulo, avatar_url, tema_cor, ativo, created_at)
- links(id, page_id, rotulo, url, icone, ordem, cliques, ativo)

## 7. Stack sugerida
- Frontend: Next.js 14 (App Router) com páginas dinâmicas `[slug]`. Backend: API Routes do Next.js. Database: PostgreSQL. Upload de avatar: S3 ou Cloudinary. Autenticação: NextAuth.
$md_47$ WHERE slug = 'link-in-bio';
UPDATE spec_catalog SET template_markdown = $md_48$# Sistema de Rastreamento de Entregas

## 0. Metadados
- **Produto:** TrackFlow — plataforma de rastreamento de entregas com ingestão de eventos e notificações automatizadas
- **project_type:** backend_api
- **Versão:** 1.0

## 1. Visão
Centralizar rastreamento de entregas de múltiplas transportadoras com linha do tempo de eventos, página pública de consulta e notificações em tempo real aos clientes.

## 2. Personas
- Operador logístico — integra eventos de status de transportadoras via API.
- Lojista — acompanha entregas de pedidos da loja e recebe alertas de problemas.
- Cliente final — consulta status de sua entrega em página pública sem login.

## 3. Requisitos Funcionais (FR)

### FR-01 — Ingestão de eventos via API
DADO uma transportadora integrada, QUANDO envia evento de status (postado, em trânsito, entregue) com código de rastreio e timestamp via POST, ENTÃO o sistema persiste o evento e atualiza status do envio em até 5 segundos.

### FR-02 — Linha do tempo de rastreio
DADO um envio com múltiplos eventos registrados, QUANDO o operador consulta GET /shipments/:code/timeline, ENTÃO retorna lista cronológica de eventos com localização e descrição.

### FR-03 — Página pública de rastreio
DADO um código de rastreio válido, QUANDO o cliente final acessa GET /track/:code sem autenticação, ENTÃO carrega página HTML com status atual e linha do tempo completa.

### FR-04 — Notificação ao cliente em cada evento
DADO um envio com e-mail ou telefone de destinatário, QUANDO um novo evento é registrado, ENTÃO o sistema envia notificação via e-mail ou SMS em até 2 minutos.

### FR-05 — Alerta de atraso ou exceção
DADO um envio com prazo de entrega definido, QUANDO o prazo é ultrapassado sem evento de entrega, ENTÃO o sistema dispara alerta ao lojista com sugestão de ação.

### FR-06 — API de webhooks para lojistas
DADO um lojista cadastrado com URL de webhook, QUANDO um evento é registrado para envio de sua loja, ENTÃO o sistema envia POST ao webhook com payload JSON do evento.

## 4. Requisitos Não-Funcionais
- API de ingestão com throughput de 1.000 eventos/segundo; latência < 200ms p95.
- Fila de notificações com retry exponencial (3 tentativas, backoff de 1/2/5 minutos); DLQ para falhas permanentes.
- Página pública com cache de 1 minuto; disponibilidade 99,9%.
- Dados de contato do cliente (e-mail, telefone) nunca expostos na API pública; apenas em webhooks autenticados.

## 5. Regras de Negócio
- Evento duplicado (mesmo código de rastreio + timestamp + status) é descartado via chave de idempotência.
- Notificação por SMS só é enviada para eventos críticos (saiu para entrega, entregue, exceção); demais eventos só por e-mail.
- Webhook com 3 falhas consecutivas é desabilitado e lojista recebe alerta; pode reativar manualmente.
- Prazo de entrega é calculado a partir do primeiro evento "postado" + SLA da transportadora (configurável).

## 6. Modelo de Dados
- shipments(id, tracking_code, carrier_id, store_id, recipient_email, recipient_phone, expected_delivery_date, current_status, created_at)
- tracking_events(id, shipment_id, event_type, description, location, timestamp, idempotency_key)
- carriers(id, name, api_integration_type, sla_days)
- stores(id, name, webhook_url, webhook_secret)
- notification_queue(id, shipment_id, event_id, channel, recipient, status, retry_count, next_retry_at)

## 7. Stack sugerida
- Backend: Fastify + PostgreSQL para persistência; SQS ou RabbitMQ para fila de notificações.
- Workers assíncronos: Node.js ou Python para processamento de notificações e webhooks.
- Notificações: integração com SES (e-mail) e Twilio (SMS).
- Cache: Redis para página pública de rastreio e debounce de webhooks.
$md_48$ WHERE slug = 'logistica-rastreio';
UPDATE spec_catalog SET template_markdown = $md_49$# Newsletter e Campanhas

## 0. Metadados
- **Produto:** MailFlow — gerenciamento de listas, editor de campanhas e envio em massa com métricas
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Criar e gerenciar listas de contatos com opt-in, compor campanhas de e-mail com editor visual, agendar envios em massa e acompanhar métricas de abertura e clique. Aumentar engajamento com segmentação.

## 2. Personas
- Profissional de marketing — cria campanhas e analisa resultados.
- Assinante — recebe e-mails segmentados e gerencia preferências.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de lista e opt-in
DADO um visitante, QUANDO confirma assinatura via e-mail, ENTÃO é adicionado à lista com status ativo e timestamp de confirmação.

### FR-02 — Segmentação
DADO um usuário com múltiplas listas, QUANDO cria campanha, ENTÃO seleciona lista ou segmento por tag e data de inscrição.

### FR-03 — Editor de campanha
DADO um usuário autenticado, QUANDO compõe e-mail com editor visual, ENTÃO salva HTML renderizado e permite preview em desktop e mobile.

### FR-04 — Agendamento e envio
DADO uma campanha pronta, QUANDO agenda para data futura, ENTÃO o worker envia em massa respeitando throttling de 500 e-mails/minuto.

### FR-05 — Rastreamento de abertura
DADO um e-mail entregue, QUANDO o assinante abre, ENTÃO registra evento de abertura com timestamp e user-agent.

### FR-06 — Rastreamento de clique
DADO um link em campanha, QUANDO o assinante clica, ENTÃO redireciona e registra evento de clique associado ao link.

### FR-07 — Descadastramento
DADO um assinante, QUANDO clica em "cancelar inscrição", ENTÃO remove da lista e não recebe mais campanhas futuras.

## 4. Requisitos Não-Funcionais
- Envio de 100k e-mails em até 4h; taxa de entrega >95%. PII (e-mail) restrito e não compartilhado. API de envio com retry e DLQ para falhas.

## 5. Regras de Negócio
- Campanha só enviada para contatos com opt-in confirmado; link de descadastramento obrigatório em todo e-mail.
- Abertura detectada por pixel 1x1; clique por redirecionamento via servidor.
- Assinante que cancela pode reinscrever-se a qualquer momento.

## 6. Modelo de Dados
- lists(id, name, description)
- subscribers(id, list_id, email, status, confirmed_at)
- campaigns(id, list_id, subject, html_body, scheduled_at, sent_at, status)
- events(id, campaign_id, subscriber_id, event_type, created_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI + editor de e-mail (react-email-editor). Backend: Fastify + PostgreSQL + RabbitMQ. Worker: Node.js com Nodemailer ou API de envio (SES, SendGrid).
$md_49$ WHERE slug = 'marketing-newsletter';
UPDATE spec_catalog SET template_markdown = $md_50$# Marketplace Multivendedor

## 0. Metadados
- **Produto:** MultiMarket — plataforma de marketplace multivendedor com split de pagamento e comissão
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Marketplace que conecta múltiplos vendedores independentes a compradores, centralizando catálogo, carrinho e pagamento. Calcula e distribui comissão da plataforma automaticamente, gerando repasses aos vendedores conforme política configurável.

## 2. Personas
- Vendedor — cadastra sua loja virtual, produtos e preços; acompanha vendas e recebe repasses.
- Comprador — navega catálogo agregado, compra de múltiplos vendedores em único pedido.
- Administrador da plataforma — define taxas de comissão, aprova novos vendedores, monitora transações.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro e aprovação de vendedor
DADO um usuário não autenticado, QUANDO preenche formulário de solicitação de loja informando CNPJ, dados bancários e documentos, ENTÃO a solicitação entra em fila de análise com status "pendente".

### FR-02 — Gestão de catálogo por vendedor
DADO um vendedor aprovado, QUANDO cadastra um produto informando título, descrição, preço, estoque e categoria, ENTÃO o produto é publicado no catálogo agregado da plataforma com identificação da loja de origem.

### FR-03 — Carrinho multivendedor
DADO um comprador navegando o catálogo, QUANDO adiciona produtos de diferentes vendedores ao carrinho, ENTÃO o sistema agrupa itens por vendedor e exibe subtotal de cada loja mais frete unificado.

### FR-04 — Pedido com split de pagamento
DADO um comprador finalizando compra com carrinho de múltiplos vendedores, QUANDO efetua pagamento via gateway, ENTÃO o sistema registra um pedido-pai e cria um subpedido por vendedor, calculando comissão da plataforma sobre cada subtotal.

### FR-05 — Repasse ao vendedor
DADO um subpedido confirmado como entregue, QUANDO completa o prazo de garantia configurado (exemplo: 7 dias), ENTÃO o sistema calcula valor líquido (subtotal menos comissão) e gera crédito de repasse na conta do vendedor.

### FR-06 — Painel de repasses
DADO um vendedor autenticado, QUANDO acessa painel financeiro, ENTÃO visualiza histórico de vendas, comissões retidas, saldo disponível para saque e histórico de transferências bancárias realizadas.

## 4. Requisitos Não-Funcionais
- Catálogo agregado suporta até 100.000 produtos ativos com busca full-text em menos de 300ms.
- Disponibilidade de 99,9% para fluxo de checkout.
- PII de vendedores (CNPJ, dados bancários) armazenada cifrada (AES-256) e nunca exposta em logs.
- Conformidade PCI-DSS para processamento de pagamentos (gateway terceirizado).

## 5. Regras de Negócio
- Taxa de comissão é percentual configurável por categoria de produto (padrão 12%).
- Repasse só ocorre após confirmação de entrega e fim do prazo de garantia.
- Vendedor precisa saldo mínimo de R$ 50 para solicitar saque.
- Produto com estoque zero é automaticamente ocultado do catálogo.

## 6. Modelo de Dados
- sellers(id, name, cnpj, bank_account_encrypted, status, commission_rate)
- stores(id, seller_id, store_name, slug, logo_url)
- products(id, store_id, title, price, stock, category, active)
- orders(id, buyer_id, total, status, created_at)
- order_items(id, order_id, product_id, seller_id, quantity, subtotal, commission)
- payouts(id, seller_id, amount, status, paid_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para marketplace público e painel de vendedor.
- Backend: Fastify + PostgreSQL; Redis para cache de catálogo; RabbitMQ para processamento assíncrono de repasses.
- Integração: gateway de pagamento (Stripe/Asaas); webhook de confirmação de entrega.
$md_50$ WHERE slug = 'marketplace-multi';
UPDATE spec_catalog SET template_markdown = $md_51$# Emissor de Notas Fiscais Eletrônicas

## 0. Metadados
- **Produto:** FiscalAPI — emissor de NF-e para micro e pequenas empresas
- **project_type:** backend_api
- **Versão:** 1.0

## 1. Visão
Emitir, armazenar e consultar notas fiscais eletrônicas de forma simples e auditável. Facilitar emissão de NF-e para prestadores de serviço e pequenos comércios que precisam de solução leve sem ERP completo.

## 2. Personas
- Contador — cadastra emitentes e emite notas fiscais para clientes.
- Empresário — consulta notas emitidas e extrai relatórios fiscais.
- Auditor interno — valida histórico de emissões e status de cada documento.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de emitente
DADO um contador com credenciais válidas, QUANDO cadastra emitente com CNPJ, razão social, inscrição estadual e regime tributário, ENTÃO o emitente fica habilitado para emissão de notas.

### FR-02 — Cadastro de produtos e serviços
DADO um emitente cadastrado, QUANDO registra produto ou serviço com descrição, NCM, CFOP e alíquotas de ICMS/PIS/COFINS, ENTÃO o item fica disponível para inclusão em notas.

### FR-03 — Emissão de nota fiscal
DADO um emitente ativo com produtos cadastrados, QUANDO cria nota com destinatário (CPF ou CNPJ), itens, valores e impostos calculados, ENTÃO a nota é salva com status "rascunho" e número sequencial único.

### FR-04 — Confirmação e armazenamento
DADO uma nota em rascunho válida, QUANDO o usuário confirma a emissão, ENTÃO a nota recebe status "emitida", chave de acesso é gerada (44 dígitos) e documento XML é armazenado no S3.

### FR-05 — Consulta de notas
DADO um usuário autenticado, QUANDO busca notas por período, emitente ou destinatário, ENTÃO retorna lista paginada com número, data, valor e status de cada nota.

### FR-06 — Cancelamento de nota
DADO uma nota emitida há menos de 24 horas, QUANDO o contador solicita cancelamento com justificativa obrigatória, ENTÃO a nota recebe status "cancelada" e o evento é registrado no histórico.

### FR-07 — Download de XML e DANFE
DADO uma nota emitida ou cancelada, QUANDO o usuário solicita download, ENTÃO o sistema retorna arquivo XML assinado e PDF do DANFE (representação gráfica).

## 4. Requisitos Não-Funcionais
- API REST responde em < 600ms para emissão de nota (excluindo chamada a provedor fiscal externo).
- Disponibilidade de 99,7% em dias úteis.
- Chaves de acesso e XMLs são armazenados com criptografia em repouso (S3 SSE).
- Dados fiscais (CNPJ, inscrição estadual) nunca aparecem em logs de aplicação.
- Sistema suporta até 1.000 notas emitidas por dia por tenant.

## 5. Regras de Negócio
- Número sequencial de nota é único por emitente e não pode ter gaps; cancelamento não libera o número.
- Nota em rascunho pode ser editada livremente; nota emitida é imutável (apenas cancelamento permitido).
- Cancelamento após 24 horas da emissão retorna erro 422 (fora do prazo legal).
- Destinatário com CPF/CNPJ inválido impede confirmação da nota.

## 6. Modelo de Dados
- issuers(id, tenant_id, cnpj, trade_name, state_registration, tax_regime)
- products(id, issuer_id, description, ncm, cfop, icms_rate, pis_rate, cofins_rate)
- invoices(id, issuer_id, number, series, access_key, recipient_document, total_amount, status, issued_at, xml_s3_key)
- invoice_items(id, invoice_id, product_id, quantity, unit_price, total_price)
- invoice_events(id, invoice_id, event_type, reason, created_at)

## 7. Stack sugerida
- Backend: Fastify + TypeScript + PostgreSQL (índices compostos em issuer_id + number).
- Storage: AWS S3 para XMLs e DANFEs (ciclo de vida 7 anos conforme legislação).
- Validação: biblioteca brasileira de validação de documentos fiscais (CNPJ, NCM, chave de acesso).
$md_51$ WHERE slug = 'nfe-emissor';
UPDATE spec_catalog SET template_markdown = $md_52$# Notas em Markdown

## 0. Metadados
- **Produto:** NoteFlow — aplicação de notas pessoais com edição em Markdown
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que usuários criem, editem e organizem notas com sintaxe Markdown, busca eficiente por conteúdo e etiquetas, e sincronização entre dispositivos, oferecendo produtividade e controle total dos dados.

## 2. Personas
- Estudante — cria notas de aula com formatação rica e organiza por matéria.
- Desenvolvedor — salva snippets de código e documenta projetos.
- Profissional — organiza tarefas e ideias com etiquetas e busca rápida.

## 3. Requisitos Funcionais (FR)

### FR-01 — Criar e editar nota
DADO um usuário autenticado, QUANDO cria uma nota com título e conteúdo em Markdown, ENTÃO ela é salva automaticamente a cada 3 segundos e fica disponível na lista de notas.

### FR-02 — Preview de Markdown em tempo real
DADO um usuário editando uma nota, QUANDO alterna para o modo "Preview", ENTÃO o conteúdo é renderizado como HTML com suporte a títulos, listas, código, links e imagens.

### FR-03 — Etiquetas e organização
DADO um usuário criando uma nota, QUANDO adiciona etiquetas (ex.: #trabalho, #pessoal), ENTÃO pode filtrar todas as notas por etiqueta na barra lateral.

### FR-04 — Busca por conteúdo
DADO um usuário com múltiplas notas, QUANDO digita um termo na busca, ENTÃO o sistema retorna notas que contêm o termo no título ou corpo, destacando o trecho correspondente.

### FR-05 — Excluir nota
DADO um usuário visualizando uma nota, QUANDO clica em "Excluir" e confirma, ENTÃO a nota é movida para a lixeira por 30 dias antes da exclusão definitiva.

### FR-06 — Sincronização entre dispositivos
DADO um usuário logado em dois dispositivos, QUANDO cria ou edita uma nota em um dispositivo, ENTÃO a alteração é sincronizada em tempo real (via WebSocket) no outro dispositivo.

## 4. Requisitos Não-Funcionais
- Editor responsivo com syntax highlighting para código. Busca full-text com índice otimizado. API < 300ms p95. Sincronização via WebSocket. Backup diário. Disponibilidade 99%. LGPD: conteúdo das notas criptografado em repouso.

## 5. Regras de Negócio
- Nota sem título recebe nome automático "Nota sem título - [data]".
- Etiquetas são case-insensitive (ex.: #Trabalho = #trabalho).
- Nota na lixeira é excluída definitivamente após 30 dias automaticamente.

## 6. Modelo de Dados
- notes(id, user_id, title, content_markdown, created_at, updated_at, deleted_at)
- tags(id, name)
- note_tags(id, note_id, tag_id)
- sync_log(id, note_id, user_id, action, synced_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + editor Markdown (react-markdown + CodeMirror). Backend: Fastify + PostgreSQL com extensão pg_trgm para busca full-text. Sincronização: WebSocket (Socket.io ou nativo). Criptografia: AES-256 para conteúdo.
$md_52$ WHERE slug = 'notas-markdown';
UPDATE spec_catalog SET template_markdown = $md_53$# Oficina Mecânica

## 0. Metadados
- **Produto:** AutoService — sistema de gestão para oficinas mecânicas com ordens de serviço, orçamentos e histórico de veículos
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Automatizar o fluxo de atendimento de oficinas mecânicas, desde a entrada do veículo até a entrega, com controle de orçamentos, aprovação pelo cliente e histórico completo de manutenções.

## 2. Personas
- Recepcionista — cadastra cliente, veículo e abre ordem de serviço.
- Mecânico — registra diagnóstico, peças e mão de obra necessárias.
- Cliente — recebe orçamento, aprova serviços e consulta histórico do veículo.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis de acesso
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO acessa o sistema com permissões do seu perfil (recepcionista, mecânico ou cliente).

### FR-02 — Cadastro de clientes e veículos
DADO um recepcionista, QUANDO cadastra cliente informando CPF ou CNPJ e dados de contato, ENTÃO pode vincular um ou mais veículos com placa, modelo, ano e chassi.

### FR-03 — Abertura de ordem de serviço
DADO um veículo cadastrado, QUANDO o recepcionista cria uma ordem de serviço informando quilometragem e problema relatado, ENTÃO a OS recebe número único e status "aguardando diagnóstico".

### FR-04 — Diagnóstico e composição de orçamento
DADO um mecânico responsável pela OS, QUANDO registra diagnóstico e adiciona peças (código, quantidade, preço) e serviços de mão de obra (descrição, horas, valor/hora), ENTÃO o sistema calcula total do orçamento e envia para aprovação do cliente.

### FR-05 — Aprovação de orçamento pelo cliente
DADO um orçamento enviado, QUANDO o cliente visualiza via link ou portal e aprova, ENTÃO a OS muda para status "em execução" e o mecânico pode iniciar o serviço.

### FR-06 — Execução e conclusão do serviço
DADO uma OS aprovada, QUANDO o mecânico finaliza os serviços e atualiza status para "concluída", ENTÃO o sistema registra data de conclusão e libera a OS para faturamento.

### FR-07 — Histórico de serviços por veículo
DADO um cliente ou recepcionista, QUANDO consulta um veículo pela placa, ENTÃO visualiza todas as ordens de serviço anteriores com data, serviços realizados, peças trocadas e quilometragem.

## 4. Requisitos Não-Funcionais
- API deve responder consultas de histórico em menos de 400ms (p95).
- Sistema suporta 30 oficinas simultâneas em modelo multi-tenant.
- Orçamento em PDF gerado automaticamente e enviado por e-mail ou WhatsApp.
- Dados de pagamento (cartão, PIX) protegidos conforme PCI-DSS; LGPD aplicada a CPF e dados pessoais.

## 5. Regras de Negócio
- Placa de veículo é única por tenant; não pode haver duplicatas na mesma oficina.
- OS só pode avançar para execução após aprovação explícita do cliente.
- Peças com estoque insuficiente geram alerta ao recepcionista no momento da composição do orçamento.
- Cliente pode reprovar orçamento; OS retorna para status "orçamento reprovado" e aguarda nova proposta.

## 6. Modelo de Dados
- customers(id, name, cpf_cnpj, email, phone)
- vehicles(id, customer_id, license_plate, brand, model, year, chassis)
- work_orders(id, vehicle_id, opened_by, opened_at, mileage, reported_issue, status, approved_at, completed_at)
- work_order_parts(id, work_order_id, part_code, description, quantity, unit_price)
- work_order_labor(id, work_order_id, service_description, hours, hourly_rate)
- service_history(id, vehicle_id, work_order_id, service_date, total_amount)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para interface responsiva com painel de ordens de serviço e portal do cliente.
- Backend: Fastify + PostgreSQL com geração de PDF de orçamento via html-pdf-node.
- Notificações: Amazon SES para e-mails e integração com API do WhatsApp para envio de orçamentos.
$md_53$ WHERE slug = 'oficina-mecanica';
UPDATE spec_catalog SET template_markdown = $md_54$# Sistema de Onboarding de Colaboradores

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
$md_54$ WHERE slug = 'onboarding-colaborador';
UPDATE spec_catalog SET template_markdown = $md_55$# Agregador Open Finance

## 0. Metadados
- **Produto:** FinanceHub — agregador de contas bancárias via Open Finance para visão consolidada
- **project_type:** backend_api
- **Versão:** 1.0

## 1. Visão
Consolidar saldos, transações e investimentos de múltiplas instituições financeiras em uma única interface, permitindo que usuários gerenciem suas finanças de forma centralizada e obtenham insights sobre gastos por categoria.

## 2. Personas
- Usuário final — conecta suas contas bancárias e visualiza saldo consolidado e histórico de transações.
- Analista financeiro — categoriza lançamentos automaticamente e gera relatórios de gastos por período.

## 3. Requisitos Funcionais (FR)

### FR-01 — Consentimento e conexão de contas via Open Finance
DADO um usuário autenticado, QUANDO inicia fluxo de consentimento com uma instituição financeira, ENTÃO é redirecionado para autorização OAuth2 e, ao aprovar, recebe token de acesso armazenado com validade e escopo.

### FR-02 — Sincronização periódica de saldos e transações
DADO uma conta conectada com consentimento válido, QUANDO o worker de sincronização executa, ENTÃO busca saldos atualizados e novas transações via API Open Finance e persiste com timestamp de sync.

### FR-03 — Categorização automática de lançamentos
DADO uma nova transação sincronizada, QUANDO o sistema analisa descrição e merchant, ENTÃO aplica regra de categorização (alimentação, transporte, saúde, etc.) e marca confiança (alta/média/baixa).

### FR-04 — Visão consolidada por conta e categoria
DADO um usuário autenticado, QUANDO acessa dashboard financeiro, ENTÃO visualiza saldo total consolidado, lista de contas conectadas com saldo individual e gráfico de gastos por categoria no período selecionado.

### FR-05 — Renovação de consentimento expirado
DADO uma conexão com consentimento próximo ao vencimento (30 dias), QUANDO o sistema detecta, ENTÃO envia alerta ao usuário via e-mail e oferece renovação com um clique.

### FR-06 — Histórico de transações com busca e filtro
DADO um usuário no histórico, QUANDO busca por palavra-chave ou filtra por categoria e período, ENTÃO visualiza lista paginada de transações correspondentes com data, valor, merchant e categoria.

## 4. Requisitos Não-Funcionais
- API com p95 < 600ms; disponibilidade 99,9% (dados financeiros críticos).
- Dados sensíveis (saldos, CPF, tokens OAuth) criptografados em repouso (AES-256) e em trânsito (TLS 1.3).
- LGPD: PII e dados financeiros nunca em logs; consentimento explícito e revogável a qualquer momento.
- Worker de sincronização com retry exponencial e circuit breaker para falhas de API externa.

## 5. Regras de Negócio
- Consentimento com validade máxima de 12 meses; renovação obrigatória.
- Transação não categorizada automaticamente pode ser recategorizada manualmente pelo usuário.
- Saldo consolidado exclui contas desconectadas ou com sync falho há mais de 7 dias.

## 6. Modelo de Dados
- connections(id, user_id, institution_name, consent_token_encrypted, consent_expires_at, status, last_sync_at)
- accounts(id, connection_id, account_number_hash, account_type, balance, currency, updated_at)
- transactions(id, account_id, transaction_id_external, date, amount, description, merchant, category_id, confidence, created_at)
- categories(id, name, icon, parent_category_id)

## 7. Stack sugerida
- Backend: Fastify + PostgreSQL com Drizzle ORM para API REST e persistência.
- Worker: Node.js com Bull (Redis) para sincronização agendada e retry.
- Segurança: crypto nativo Node.js para criptografia de tokens; rate limiting e IP whitelist para API Open Finance.
$md_55$ WHERE slug = 'open-finance-agregador';
UPDATE spec_catalog SET template_markdown = $md_56$# Ouvidoria ao Cidadão

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
$md_56$ WHERE slug = 'ouvidoria';
UPDATE spec_catalog SET template_markdown = $md_57$# Cobranças Pix

## 0. Metadados
- **Produto:** PixBill — emissão e conciliação automática de cobranças Pix para e-commerce e serviços
- **project_type:** backend_api
- **Versão:** 1.0

## 1. Visão
API de cobrança via Pix que gera QR Code dinâmico, monitora pagamentos em tempo real via webhook e concilia automaticamente, reduzindo inadimplência e tempo de confirmação de pagamento para segundos.

## 2. Personas
- Sistema e-commerce integrado — consome a API para gerar cobranças ao finalizar pedido.
- Cliente final — escaneia QR Code no app bancário e efetua pagamento Pix.
- Financeiro da empresa — consulta cobranças pagas, vencidas e aguardando pagamento para conciliação contábil.

## 3. Requisitos Funcionais (FR)
### FR-01 — Criação de cobrança com valor e vencimento
DADO um sistema integrado autenticado via API Key, QUANDO envia requisição POST /charges informando valor, vencimento e identificador de pedido, ENTÃO a API registra a cobrança com status "pending" e retorna o txid gerado.

### FR-02 — Geração de payload e QR Code Pix
DADO uma cobrança criada com status "pending", QUANDO o sistema integrado requisita GET /charges/:id/qrcode, ENTÃO a API consulta o provedor Pix (ex: Banco do Brasil API Pix), gera o payload Pix Copia e Cola e o QR Code codificado em base64, retornando ambos.

### FR-03 — Webhook de confirmação de pagamento
DADO o provedor Pix configurado com URL de webhook do PixBill, QUANDO um cliente efetua o pagamento no app bancário, ENTÃO o provedor notifica o PixBill via POST /webhooks/pix, o sistema valida a assinatura, localiza a cobrança pelo txid, atualiza status para "paid" e timestamp de pagamento, e notifica o sistema integrado via webhook cadastrado.

### FR-04 — Conciliação e transição de status
DADO cobranças com status "pending", QUANDO o sistema executa job de conciliação a cada 5 minutos, ENTÃO consulta o provedor Pix para confirmar pagamentos ainda não notificados, atualiza cobranças pagas e marca como "expired" aquelas cujo vencimento passou sem pagamento.

### FR-05 — Consulta de cobranças e histórico
DADO um sistema integrado autenticado, QUANDO requisita GET /charges com filtros de status, período e identificador externo, ENTÃO a API retorna lista paginada de cobranças com status, valor, datas de criação, vencimento e pagamento.

## 4. Requisitos Não-Funcionais
- Webhook de pagamento processado em < 1s; retry com backoff exponencial em caso de falha.
- Idempotência garantida por txid; requisições duplicadas retornam a mesma cobrança.
- API Key com rate limit de 100 req/min por cliente; disponibilidade 99,9%.
- Logs de webhook nunca expõem chaves ou payloads completos de provedor (apenas txid e status).

## 5. Regras de Negócio
- Uma cobrança só pode ser paga uma vez; tentativa de pagamento duplicado é rejeitada pelo provedor.
- Cobranças expiradas não aceitam pagamento; cliente deve solicitar nova cobrança.
- Valor mínimo R$0,01; valor máximo definido pelo limite do provedor Pix (ex: R$10.000,00 por transação).
- Conciliação automática tem precedência sobre webhook; sistema tolera atraso de notificação.

## 6. Modelo de Dados
- charges(id, txid, external_id, amount_cents, due_date, status, qrcode_payload, qrcode_image_base64, paid_at, created_at)
- payments(id, charge_id, txid, amount_cents, payer_document, paid_at, provider_raw_data_json)
- webhooks_log(id, charge_id, event_type, payload_json, signature, processed_at, status)

## 7. Stack sugerida
- Backend: Fastify + PostgreSQL + Bull (job de conciliação). Integração: SDK do provedor Pix (BB, PagSeguro, Asaas). Auth via API Key com bcrypt.
$md_57$ WHERE slug = 'pix-cobranca';
UPDATE spec_catalog SET template_markdown = $md_58$# Hospedagem de Podcast

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
$md_58$ WHERE slug = 'podcast-hosting';
UPDATE spec_catalog SET template_markdown = $md_59$# Site Institucional

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
$md_59$ WHERE slug = 'portfolio-institucional';
UPDATE spec_catalog SET template_markdown = $md_60$# Quadro Kanban para Gestão de Tarefas

## 0. Metadados
- **Produto:** TaskBoard — ferramenta de produtividade com quadros Kanban colaborativos
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Organizar trabalho em quadros visuais com colunas configuráveis e cartões arrastáveis. Facilitar colaboração de equipes distribuídas com atribuição de tarefas, prazos e comentários em tempo real.

## 2. Personas
- Membro da equipe — cria cartões, move tarefas entre colunas e comenta progresso.
- Líder de projeto — configura quadros, define colunas e acompanha distribuição de trabalho.
- Observador — visualiza progresso sem editar (stakeholder, cliente).

## 3. Requisitos Funcionais (FR)

### FR-01 — Criação de quadros e colunas
DADO um líder de projeto autenticado, QUANDO cria quadro com nome e define colunas personalizadas (ex: Backlog, Em andamento, Revisão, Concluído), ENTÃO o quadro fica disponível para a equipe convidada.

### FR-02 — Criação de cartões
DADO um membro com acesso ao quadro, QUANDO cria cartão com título, descrição, etiqueta de prioridade e responsável, ENTÃO o cartão aparece na primeira coluna e fica visível para todos os membros.

### FR-03 — Arrastar cartões entre colunas
DADO um cartão em qualquer coluna, QUANDO o usuário arrasta o cartão para outra coluna, ENTÃO a mudança é salva imediatamente e refletida em tempo real para todos os usuários conectados.

### FR-04 — Atribuição e prazos
DADO um cartão existente, QUANDO o usuário atribui responsável e define data de vencimento, ENTÃO o cartão exibe avatar do responsável e destaca em vermelho cartões vencidos.

### FR-05 — Etiquetas e filtros
DADO um líder de projeto, QUANDO cria etiquetas personalizadas com cores (bug, feature, urgente), ENTÃO membros podem aplicar etiquetas aos cartões e filtrar visualização do quadro por etiqueta ou responsável.

### FR-06 — Comentários e menções
DADO um cartão aberto, QUANDO usuário adiciona comentário com menção a outro membro (@nome), ENTÃO o membro mencionado recebe notificação e o comentário aparece na linha do tempo do cartão.

### FR-07 — Histórico de movimentações
DADO um cartão com histórico, QUANDO qualquer usuário abre o cartão, ENTÃO visualiza log completo de mudanças de coluna, alterações de responsável e comentários com timestamps.

## 4. Requisitos Não-Funcionais
- Interface reflete mudanças de outros usuários em < 2 segundos (WebSocket ou polling curto).
- Disponibilidade de 99,5%.
- Suporte a até 50 usuários simultâneos por quadro e até 1.000 cartões por quadro.
- Dados de cartão (descrição, comentários) são privados ao workspace; acesso externo exige convite explícito.

## 5. Regras de Negócio
- Usuário só pode arrastar cartões em quadros onde tem permissão de edição; observadores têm acesso somente leitura.
- Cartão só pode estar em uma coluna por vez; mudança de coluna registra timestamp no histórico.
- Etiquetas são globais ao quadro; deletar etiqueta remove associação de todos os cartões mas não deleta os cartões.
- Comentário pode ser editado por 15 minutos após criação; após isso é imutável.

## 6. Modelo de Dados
- boards(id, workspace_id, title, created_by, created_at)
- columns(id, board_id, title, position)
- cards(id, column_id, title, description, assigned_to, due_date, created_by, created_at)
- labels(id, board_id, name, color)
- card_labels(card_id, label_id)
- comments(id, card_id, user_id, content, created_at, edited_at)
- card_history(id, card_id, event_type, from_value, to_value, changed_by, changed_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + React 19 + dnd-kit (drag-and-drop).
- Backend: Fastify + PostgreSQL (índices em board_id, column_id, assigned_to).
- Real-time: WebSocket (Socket.io) para sincronização de movimentações.
- Cache: Redis para estado do quadro em memória e reduzir latência.
$md_60$ WHERE slug = 'produtividade-kanban';
UPDATE spec_catalog SET template_markdown = $md_61$# Programa de Fidelidade

## 0. Metadados
- **Produto:** LoyaltyHub — plataforma de fidelização com pontos e recompensas
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Sistema de programa de fidelidade que permite empresas recompensarem clientes com pontos por compras, e clientes resgatarem recompensas de catálogo, incentivando recorrência.

## 2. Personas
- Gestor de marketing — configura regras de pontos e catálogo de recompensas.
- Cliente membro — acumula pontos e resgata recompensas.
- Atendente — valida resgates presenciais.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de membro e autenticação
DADO um novo cliente com CPF válido, QUANDO se cadastra no programa de fidelidade, ENTÃO uma conta é criada com saldo zero de pontos no nível Bronze e ele recebe credenciais de acesso.

### FR-02 — Acúmulo de pontos por compra
DADO um membro, QUANDO finaliza compra em loja integrada, ENTÃO pontos são creditados automaticamente conforme regra configurada (ex: 1 ponto por R$ 10 gastos) e o saldo é atualizado.

### FR-03 — Níveis de fidelidade progressivos
DADO um membro, QUANDO atinge pontuação acumulada de 1000 pontos, ENTÃO é promovido ao nível Prata com benefícios adicionais (multiplicador 1.5x em acúmulo), e notificado da promoção.

### FR-04 — Catálogo de recompensas
DADO um gestor de marketing, QUANDO cadastra recompensa no catálogo com foto, descrição e custo em pontos, ENTÃO a recompensa fica disponível para resgate por membros com saldo suficiente.

### FR-05 — Resgate de recompensas
DADO um membro com saldo suficiente, QUANDO solicita resgate de recompensa, ENTÃO os pontos são debitados, um voucher é gerado com código único e prazo de validade, e o membro recebe confirmação por e-mail.

### FR-06 — Validação de voucher pelo atendente
DADO um atendente em loja física, QUANDO valida código de voucher via aplicativo, ENTÃO o voucher é marcado como utilizado se válido e não expirado, ou rejeitado com mensagem de erro caso contrário.

### FR-07 — Extrato de pontos e histórico de resgates
DADO um membro autenticado, QUANDO acessa extrato, ENTÃO visualiza histórico de acúmulos e resgates com datas, descrições e saldo atual.

## 4. Requisitos Não-Funcionais
- Acúmulo de pontos processado em menos de 500ms p95.
- Disponibilidade de 99,5% para operações de resgate.
- PII (CPF, telefone) nunca em logs; LGPD com consentimento explícito.
- Catálogo de recompensas com cache para imagens (CDN).

## 5. Regras de Negócio
- Pontos expiram após 12 meses sem movimentação na conta.
- Resgate só é permitido se saldo de pontos for suficiente no momento da solicitação.
- Promoção de nível é irreversível (não há rebaixamento).
- Voucher não pode ser validado após expiração ou se já foi utilizado.

## 6. Modelo de Dados
- members(id, cpf, name, email, points_balance, tier, last_activity)
- point_transactions(id, member_id, type, amount, description, created_at)
- rewards(id, name, description, cost_points, image_url, active)
- redemptions(id, member_id, reward_id, voucher_code, status, expires_at, redeemed_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para portal do membro; React Native para app de atendente.
- Backend: Fastify + PostgreSQL para transações de pontos.
- Jobs: cron para expiração de pontos e vouchers.
- CDN: S3 + CloudFront para imagens de recompensas.
$md_61$ WHERE slug = 'programa-fidelidade';
UPDATE spec_catalog SET template_markdown = $md_62$# Gestão de Projetos com Gantt

## 0. Metadados
- **Produto:** ProjectGantt — plataforma de planejamento e acompanhamento de projetos com cronograma visual, dependências e marcos
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Facilitar o planejamento e controle de projetos complexos com visualização de cronograma em gráfico de Gantt, identificação de caminho crítico e acompanhamento de progresso em tempo real.

## 2. Personas
- Gerente de projeto — cria cronograma, define dependências e monitora avanço.
- Membro da equipe — atualiza percentual concluído das tarefas atribuídas.
- Stakeholder — acompanha marcos e visualiza status geral do projeto.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis de projeto
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO acessa o sistema e visualiza projetos dos quais participa conforme seu perfil (gerente, membro ou stakeholder).

### FR-02 — Criação de projeto e estrutura de tarefas
DADO um gerente de projeto, QUANDO cria um projeto informando nome, data de início e objetivo, ENTÃO pode adicionar tarefas hierárquicas com título, responsável, data de início e data de término.

### FR-03 — Definição de dependências entre tarefas
DADO uma tarefa cadastrada, QUANDO o gerente define que ela depende de outra tarefa (tipo: fim-início, início-início, fim-fim), ENTÃO o sistema ajusta automaticamente as datas no cronograma caso a predecessora atrase.

### FR-04 — Visualização em gráfico de Gantt
DADO um projeto com tarefas e dependências, QUANDO o usuário acessa a visão de Gantt, ENTÃO visualiza barras coloridas representando duração de cada tarefa, setas de dependência e linha do tempo.

### FR-05 — Identificação de caminho crítico
DADO um cronograma completo, QUANDO o sistema calcula o caminho crítico, ENTÃO destaca em vermelho as tarefas cuja folga é zero e cujo atraso impacta a data final do projeto.

### FR-06 — Atualização de percentual concluído e atraso
DADO um membro da equipe, QUANDO atualiza o percentual concluído de sua tarefa, ENTÃO o sistema recalcula datas de tarefas dependentes e alerta o gerente se houver atraso no caminho crítico.

### FR-07 — Marcos e relatórios de progresso
DADO um projeto com marcos definidos (entrega de fase, reunião de validação), QUANDO um marco é atingido, ENTÃO o sistema notifica stakeholders e gera relatório de progresso acumulado.

## 4. Requisitos Não-Funcionais
- Interface responsiva; gráfico de Gantt renderizado em até 1 segundo para projetos com até 200 tarefas.
- Colaboração em tempo real: múltiplos usuários editando o projeto com sincronização via WebSocket.
- API deve responder requisições de cálculo de caminho crítico em menos de 500ms (p95).
- Exportação de cronograma em PDF e Excel para compartilhamento externo.

## 5. Regras de Negócio
- Tarefa com dependência não pode ter data de início anterior à data de término da predecessora.
- Percentual concluído só pode ser atualizado pelo responsável atribuído à tarefa ou pelo gerente do projeto.
- Atraso no caminho crítico aciona alerta automático ao gerente e stakeholders cadastrados.
- Projeto com todos os marcos cumpridos e 100% das tarefas concluídas muda status para "Encerrado".

## 6. Modelo de Dados
- projects(id, name, description, start_date, end_date, status, owner_id)
- tasks(id, project_id, title, description, start_date, end_date, assigned_to, percent_complete, is_milestone, parent_task_id)
- task_dependencies(id, predecessor_id, successor_id, dependency_type)
- project_members(id, project_id, user_id, role)
- critical_path(id, project_id, task_id, slack_days)
- milestones(id, project_id, name, target_date, completed_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI com biblioteca de Gantt interativo (react-gantt-chart ou dhtmlx-gantt).
- Backend: Fastify + PostgreSQL com algoritmo de cálculo de caminho crítico (CPM - Critical Path Method) implementado em TypeScript.
- Colaboração em tempo real: WebSocket (Socket.io) para sincronização de edições simultâneas.
$md_62$ WHERE slug = 'projetos-gantt';
UPDATE spec_catalog SET template_markdown = $md_63$# Prontuário de Clínica

## 0. Metadados
- **Produto:** HealthRecord — prontuário eletrônico seguro com histórico clínico e controle de acesso
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Registrar e consultar histórico clínico completo de pacientes com segurança, auditoria e controle granular de acesso por profissional. Facilitar continuidade do cuidado e reduzir erros por falta de informação.

## 2. Personas
- Médico — registra evoluções, prescreve e anexa exames.
- Enfermeiro — consulta histórico e registra sinais vitais.
- Administrador da clínica — gerencia permissões e auditoria de acessos.

## 3. Requisitos Funcionais (FR)

### FR-01 — Ficha do paciente
DADO um administrador, QUANDO cadastra paciente com CPF único, nome, data de nascimento e alergias, ENTÃO cria ficha acessível por profissionais autorizados.

### FR-02 — Registro de evolução
DADO um médico autenticado com permissão ao paciente, QUANDO registra evolução clínica com queixa, exame físico e conduta, ENTÃO persiste com timestamp e identificação do profissional.

### FR-03 — Anexo de exames
DADO um profissional, QUANDO anexa PDF ou imagem de exame ao prontuário, ENTÃO armazena criptografado com referência ao atendimento.

### FR-04 — Controle de acesso
DADO um administrador, QUANDO vincula profissional a paciente, ENTÃO este profissional acessa o prontuário completo; demais profissionais não visualizam.

### FR-05 — Auditoria de acessos
DADO qualquer acesso ao prontuário, QUANDO profissional visualiza ou edita, ENTÃO registra log imutável com data, hora, usuário e ação.

### FR-06 — Histórico cronológico
DADO um profissional autorizado, QUANDO acessa prontuário, ENTÃO visualiza linha do tempo de evoluções e exames ordenados por data.

## 4. Requisitos Não-Funcionais
- Disponibilidade 99,9%; dados de saúde criptografados em repouso (AES-256) e em trânsito (TLS 1.3). Conformidade com LGPD: dados sensíveis de saúde restritos, log de auditoria imutável por 5 anos, direito de portabilidade e exclusão.

## 5. Regras de Negócio
- CPF único por clínica; paciente pode ter múltiplos atendimentos.
- Evolução não pode ser editada após 24h da criação — apenas adendo permitido.
- Profissional sem vínculo ao paciente não acessa nenhum dado.
- Exclusão de paciente arquiva dados por prazo legal (5 anos) antes de remoção definitiva.

## 6. Modelo de Dados
- patients(id, cpf, name, birth_date, allergies)
- professionals(id, name, crm, specialty)
- patient_access(patient_id, professional_id, granted_at)
- encounters(id, patient_id, professional_id, date, chief_complaint, physical_exam, plan)
- attachments(id, encounter_id, file_path, uploaded_at)
- audit_log(id, patient_id, professional_id, action, accessed_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI com autenticação forte. Backend: Fastify + PostgreSQL com row-level security. Storage criptografado (S3 com SSE-KMS ou equivalente).
$md_63$ WHERE slug = 'prontuario-clinica';
UPDATE spec_catalog SET template_markdown = $md_64$# Quiz e Avaliações

## 0. Metadados
- **Produto:** QuizMaster — plataforma de avaliações online com correção automática e relatórios de desempenho
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Facilitar a criação de avaliações personalizadas com banco de questões, aplicar provas com tempo limite e fornecer correção automática e relatórios de desempenho para educadores e alunos.

## 2. Personas
- Professor — cria banco de questões, monta provas e acompanha desempenho da turma.
- Aluno — realiza avaliações dentro do prazo e consulta notas e feedback.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO recebe token e acessa dashboard de professor ou aluno conforme perfil.

### FR-02 — Banco de questões por assunto
DADO um professor autenticado, QUANDO cadastra questão com enunciado, alternativas e resposta correta vinculada a assunto, ENTÃO ela fica disponível para montagem de provas.

### FR-03 — Montagem de prova com tempo limite
DADO um professor, QUANDO seleciona questões do banco e define duração em minutos, ENTÃO o sistema cria prova e gera código de acesso para alunos.

### FR-04 — Realização de prova pelo aluno
DADO um aluno com código válido, QUANDO inicia prova, ENTÃO o cronômetro começa e as questões aparecem em ordem; ao expirar o tempo, respostas são enviadas automaticamente.

### FR-05 — Correção automática e nota final
DADO um aluno que finalizou prova, QUANDO o sistema compara respostas com gabarito, ENTÃO calcula nota (% acertos) e registra tentativa.

### FR-06 — Relatório de desempenho por aluno
DADO um professor, QUANDO consulta relatório de prova, ENTÃO vê lista de alunos com nota, tempo gasto e questões erradas.

### FR-07 — Histórico de tentativas
DADO um aluno, QUANDO acessa histórico, ENTÃO vê lista de provas realizadas com nota e data, podendo revisar gabarito.

## 4. Requisitos Não-Funcionais
- API responde em < 400ms p95; disponibilidade 99%. Respostas criptografadas em trânsito. Dados pessoais (nome, email) nunca em logs. Timeout de prova preciso (±2s).

## 5. Regras de Negócio
- Questão com alternativa correta única. Aluno não pode refazer prova após expiração. Nota arredondada para uma casa decimal. Código de prova expira em 7 dias ou após limite de tentativas.

## 6. Modelo de Dados
- questions(id, subject, statement, correct_option, created_by)
- question_options(id, question_id, label, text)
- quizzes(id, title, duration_minutes, access_code, expires_at, created_by)
- quiz_questions(quiz_id, question_id, order)
- attempts(id, quiz_id, student_id, score, started_at, finished_at)
- answers(attempt_id, question_id, selected_option)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI 7 + countdown timer. Backend: Fastify + PostgreSQL. Websocket opcional para sincronia de tempo real.
$md_64$ WHERE slug = 'quiz-avaliacao';
UPDATE spec_catalog SET template_markdown = $md_65$# Chatbot Corporativo com RAG

## 0. Metadados
- **Produto:** DocuBot — assistente inteligente com recuperação aumentada para base de conhecimento empresarial
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Responder perguntas de colaboradores sobre políticas, processos e documentação técnica usando busca semântica em base vetorial, com citação de fontes. Reduz carga de suporte e melhora acesso ao conhecimento organizacional.

## 2. Personas
- Administrador — faz upload de documentos, monitora qualidade das respostas e ajusta parâmetros.
- Colaborador — faz perguntas em linguagem natural e recebe respostas contextualizadas.
- Analista de qualidade — revisa respostas marcadas como insatisfatórias e enriquece a base.

## 3. Requisitos Funcionais (FR)

### FR-01 — Ingestão e processamento de documentos
DADO um administrador autenticado, QUANDO faz upload de PDF ou DOCX, ENTÃO o sistema extrai texto, divide em chunks de 512 tokens com overlap de 50 e armazena metadados.

### FR-02 — Geração e indexação de embeddings
DADO chunks processados, QUANDO o worker de indexação roda, ENTÃO gera embeddings vetoriais via modelo de embedding e persiste em banco vetorial com índice HNSW.

### FR-03 — Busca semântica e recuperação de contexto
DADO uma pergunta do colaborador, QUANDO o sistema processa a query, ENTÃO gera embedding da pergunta, busca top-5 chunks mais similares e monta contexto para o LLM.

### FR-04 — Geração de resposta com citação de fontes
DADO contexto recuperado, QUANDO o LLM gera resposta, ENTÃO a resposta inclui trechos relevantes e referências aos documentos originais com número da página.

### FR-05 — Histórico de conversas por usuário
DADO um colaborador autenticado, QUANDO acessa o histórico, ENTÃO visualiza suas últimas 50 conversas com timestamps e pode retomar qualquer uma delas.

### FR-06 — Feedback de qualidade e marcação de respostas
DADO uma resposta gerada, QUANDO o colaborador marca como inadequada, ENTÃO o sistema registra feedback e prioriza revisão pelo analista de qualidade.

### FR-07 — Dashboard de métricas de uso
DADO um administrador, QUANDO acessa o dashboard, ENTÃO visualiza total de perguntas, taxa de satisfação, documentos mais consultados e tempo médio de resposta.

## 4. Requisitos Não-Funcionais
- Busca semântica < 300ms p95, geração de resposta < 3s p95.
- Suporte a 100 usuários simultâneos.
- Base vetorial escalável até 100 mil chunks.
- Dados de conversas privados por usuário (sem acesso cruzado).

## 5. Regras de Negócio
- Chunks com menos de 50 tokens são descartados (ruído).
- Respostas nunca devem inventar informação fora do contexto recuperado.
- Documentos marcados como confidenciais só são indexados para grupos autorizados.
- Feedback negativo em 3 respostas do mesmo documento aciona revisão manual.

## 6. Modelo de Dados
- documents(id, filename, upload_date, status, metadata)
- chunks(id, document_id, text, page_number, token_count)
- embeddings(id, chunk_id, vector, indexed_at)
- conversations(id, user_id, created_at)
- messages(id, conversation_id, role, content, chunks_used, feedback)
- users(id, email, name, department)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI 7 + markdown rendering.
- Backend: FastAPI + PostgreSQL + pgvector.
- LLM: Claude 3.5 Sonnet via Bedrock.
- Embeddings: Cohere Embed v3 ou Voyage AI.
- Worker: Python com Celery para ingestão assíncrona.
$md_65$ WHERE slug = 'rag-chatbot';
UPDATE spec_catalog SET template_markdown = $md_66$# Rastreabilidade Agrícola

## 0. Metadados
- **Produto:** AgroTrace — rastreabilidade de lotes agrícolas da origem ao ponto de venda
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma de rastreabilidade que registra toda a cadeia produtiva de um lote agrícola, desde o plantio até a venda final, garantindo transparência e conformidade com normas de segurança alimentar. Permite que consumidores consultem a origem e histórico de produtos por código do lote.

## 2. Personas
- Produtor rural — cadastra lotes de produção, registra eventos de manejo e colheita.
- Distribuidor — registra eventos da cadeia de custódia (transporte, armazenamento).
- Consumidor final — consulta origem e histórico do produto pelo código impresso na embalagem.
- Auditor de qualidade — verifica conformidade e rastreabilidade completa dos lotes.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de lote de produção
DADO um produtor autenticado, QUANDO cadastra um novo lote informando propriedade de origem, área plantada, cultura e data de plantio, ENTÃO o sistema gera um código único de rastreabilidade e persiste o lote com status "em cultivo".

### FR-02 — Registro de eventos de manejo
DADO um lote em cultivo, QUANDO o produtor registra um evento de manejo (irrigação, adubação, aplicação fitossanitária) com data, tipo e produtos utilizados, ENTÃO o evento é associado ao histórico do lote com timestamp imutável.

### FR-03 — Registro de colheita
DADO um lote em cultivo, QUANDO o produtor registra a colheita informando quantidade colhida, data e responsável, ENTÃO o lote muda para status "colhido" e a quantidade é registrada.

### FR-04 — Cadeia de custódia
DADO um lote colhido, QUANDO um ator da cadeia (transportadora, armazém, distribuidor) registra posse do lote informando data de recebimento e localização, ENTÃO um evento de custódia é adicionado ao histórico com geolocalização e assinatura digital.

### FR-05 — Registro de venda ao varejo
DADO um lote em posse de distribuidor, QUANDO registra venda a um estabelecimento varejista informando quantidade e data, ENTÃO o sistema fecha a cadeia de custódia e marca o lote como "no varejo".

### FR-06 — Consulta pública por código
DADO um consumidor com código de rastreabilidade impresso na embalagem, QUANDO acessa a plataforma e informa o código, ENTÃO visualiza linha do tempo completa do lote (origem, eventos de manejo, cadeia de custódia, certificações).

### FR-07 — Alertas de não conformidade
DADO um lote com eventos registrados, QUANDO o sistema detecta violação de janela de carência de agrotóxico ou falha na cadeia de frio, ENTÃO gera alerta para o responsável e auditor, bloqueando a venda até regularização.

## 4. Requisitos Não-Funcionais
- API responde em menos de 500ms (p95) para consultas públicas.
- Disponibilidade de 99,7% para módulo de consulta pública.
- Eventos de rastreabilidade são imutáveis (append-only) com hash criptográfico de integridade.
- PII de produtores (CPF, endereço) nunca exposta em consultas públicas, apenas nome e município.
- Sistema suporta até 10.000 consultas públicas simultâneas (Black Friday agrícola).

## 5. Regras de Negócio
- Código de lote é único por tenant e imutável após geração.
- Eventos de cadeia de custódia exigem assinatura digital do responsável (chave privada).
- Lote só pode avançar na cadeia após fechamento de custódia pela etapa anterior.
- Consulta pública só exibe lotes que completaram ao menos uma venda ao varejo.

## 6. Modelo de Dados
- lots(id, code, producer_id, crop, area_ha, planting_date, status, harvest_quantity)
- events(id, lot_id, event_type, event_date, description, actor_id, signature_hash)
- custody_chain(id, lot_id, actor_id, received_at, location_lat, location_lng, signature_hash)
- actors(id, name, type, document, contact)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para portal de gestão; landing page pública para consultas.
- Backend: Fastify + PostgreSQL com trigger de imutabilidade em events; Redis para cache de consultas públicas.
- Integração: webhook para sistemas de ERP agrícola; API REST para distribuidores.
$md_66$ WHERE slug = 'rastreabilidade-agro';
UPDATE spec_catalog SET template_markdown = $md_67$# Reservas de Hotel

## 0. Metadados
- **Produto:** HotelBook — sistema de reservas de hotel com motor de disponibilidade e gestão de tarifas dinâmicas
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma de gestão hoteleira que controla disponibilidade de quartos em tempo real, aplica tarifas dinâmicas por período e canal de venda, processa reservas com check-in/check-out e integra com sistemas de pagamento e PMS legados.

## 2. Personas
- Hóspede — busca disponibilidade por datas, reserva quarto online, realiza check-in antecipado via web.
- Recepcionista — visualiza mapa de ocupação, faz check-in/check-out presencial, altera reservas.
- Gerente de receita — configura tarifas dinâmicas por período, monitora taxa de ocupação e RevPAR.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de quartos e tipos
DADO um gerente autenticado, QUANDO cadastra quarto informando número, tipo (standard, superior, suíte), capacidade e comodidades (ar-condicionado, vista mar), ENTÃO o quarto é adicionado ao inventário com status "disponível para reserva".

### FR-02 — Motor de disponibilidade por período
DADO um hóspede buscando reserva, QUANDO informa datas de check-in e check-out, ENTÃO o sistema consulta disponibilidade de quartos livres em TODOS os dias do período e retorna apenas tipos com unidades disponíveis ininterruptamente.

### FR-03 — Tarifas dinâmicas por período e canal
DADO um gerente configurando tarifário, QUANDO define tarifa base, regras de desconto (antecedência, grupo) e markup por canal (site próprio, OTA), ENTÃO o sistema aplica cálculo dinâmico no momento da busca e exibe preço final ao hóspede.

### FR-04 — Reserva com pagamento online
DADO um hóspede selecionando quarto e datas, QUANDO preenche dados pessoais e efetua pagamento via gateway, ENTÃO o sistema bloqueia o quarto no período, cria reserva com status "confirmada" e envia voucher por e-mail.

### FR-05 — Check-in antecipado e atribuição de quarto
DADO uma reserva confirmada, QUANDO o hóspede faz check-in online 24 horas antes ou na recepção, ENTÃO o sistema atribui número de quarto específico (se não atribuído), muda status para "hospedado" e gera chave de acesso (física ou digital).

### FR-06 — Check-out e faturamento final
DADO um hóspede hospedado, QUANDO recepcionista processa check-out informando consumo de frigobar e extras, ENTÃO o sistema calcula total (diárias + extras), gera nota fiscal, processa pagamento pendente e libera o quarto com status "sujo" para governança.

### FR-07 — Política de cancelamento configurável
DADO uma reserva confirmada, QUANDO hóspede solicita cancelamento, ENTÃO o sistema avalia política (prazo de cancelamento gratuito, penalidade por atraso), calcula reembolso devido, processa estorno e libera o quarto para novas reservas.

## 4. Requisitos Não-Funcionais
- Motor de disponibilidade responde em menos de 500ms para consulta de período de até 30 dias.
- Disponibilidade de 99,9% para subsistema de reservas (crítico para vendas 24/7).
- Overbooking controlado: sistema permite até 5% de sobrevenda configurável para mitigar no-shows.
- PII de hóspedes (CPF, dados de cartão) armazenada cifrada (AES-256) e em conformidade com PCI-DSS.

## 5. Regras de Negócio
- Check-in padrão 14h, check-out 12h; early check-in ou late check-out sujeito a disponibilidade e cobrança extra.
- Cancelamento gratuito até 48 horas antes do check-in; após, cobra 1 diária de multa.
- Quarto "sujo" após check-out não entra em disponibilidade até que governança mude status para "limpo".
- No-show (não comparecer sem cancelar) resulta em cobrança integral da primeira diária.

## 6. Modelo de Dados
- rooms(id, room_number, room_type, capacity, amenities, status)
- room_types(id, name, base_rate, max_occupancy)
- rates(id, room_type_id, start_date, end_date, rate, channel)
- reservations(id, guest_id, room_id, check_in_date, check_out_date, status, total_amount, cancellation_policy)
- guests(id, name, email, document, phone)
- invoices(id, reservation_id, room_charges, extras, total, paid_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para site de reservas público; painel interno para recepção.
- Backend: Fastify + PostgreSQL com bloqueio pessimista para evitar double-booking; Redis para cache de disponibilidade; RabbitMQ para processamento assíncrono de faturas.
- Integração: gateway de pagamento (Stripe/Adyen); API de PMS legado (SOAP/REST) para sincronização de reservas.
$md_67$ WHERE slug = 'reservas-hotel';
UPDATE spec_catalog SET template_markdown = $md_68$# Reservas de Restaurante

## 0. Metadados
- **Produto:** TableBook — sistema de reservas de mesas com controle de capacidade e notificações automáticas
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Gerenciar reservas de mesas respeitando capacidade, horários disponíveis e regras de overbooking, com confirmação automática, lembretes via email/SMS e painel administrativo para o restaurante.

## 2. Personas
- Gerente do restaurante — configura mesas, horários e política de cancelamento.
- Cliente — realiza reserva online, recebe confirmação e pode cancelar até prazo-limite.
- Atendente — consulta reservas do dia e confirma chegada de clientes.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO recebe token e acessa painel conforme perfil (gerente, atendente ou cliente).

### FR-02 — Configuração de mesas e horários
DADO um gerente autenticado, QUANDO cadastra mesas com capacidade e define horários de funcionamento (ex.: jantar 18h-23h, slots de 30min), ENTÃO o sistema gera grade de disponibilidade.

### FR-03 — Reserva pelo cliente com confirmação
DADO um cliente, QUANDO seleciona data, horário e número de pessoas disponível, ENTÃO o sistema reserva mesa provisória e envia email de confirmação com código.

### FR-04 — Controle de capacidade e overbooking
DADO um horário com todas as mesas ocupadas, QUANDO gerente habilita overbooking (10%), ENTÃO o sistema permite 1 reserva extra em horário cheio, sinalizando como "sob confirmação".

### FR-05 — Lembrete automático
DADO uma reserva confirmada, QUANDO faltam 24h para o horário, ENTÃO o sistema envia email/SMS de lembrete ao cliente.

### FR-06 — Cancelamento pelo cliente
DADO um cliente com reserva ativa, QUANDO cancela até 2h antes do horário, ENTÃO mesa é liberada e cliente recebe confirmação de cancelamento.

### FR-07 — Painel de chegadas do dia
DADO um atendente, QUANDO acessa painel de chegadas, ENTÃO vê lista de reservas do dia ordenadas por horário, com status (confirmada, check-in, no-show).

## 4. Requisitos Não-Funcionais
- API responde em < 300ms p95; disponibilidade 99,5%. Grade de horários atualizada em tempo real. Dados pessoais (telefone, email) nunca em logs. Notificações entregues em < 5min após gatilho.

## 5. Regras de Negócio
- Reserva sem check-in em 15min após horário marca como no-show. Cliente com 3 no-shows consecutivos bloqueado por 30 dias. Cancelamento após prazo-limite não libera mesa. Overbooking limitado a 10% da capacidade por horário.

## 6. Modelo de Dados
- tables(id, restaurant_id, number, capacity)
- time_slots(id, restaurant_id, day_of_week, start_time, end_time, slot_duration)
- reservations(id, table_id, customer_id, reservation_date, slot_time, party_size, status, created_at)
- customers(id, name, email, phone, no_show_count)
- restaurants(id, name, overbooking_enabled, overbooking_limit_pct, cancellation_deadline_hours)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI 7 + date-picker. Backend: Fastify + PostgreSQL. Notificações: integração com Twilio (SMS) e SendGrid (email). Job scheduler: node-cron para lembretes.
$md_68$ WHERE slug = 'reservas-restaurante';
UPDATE spec_catalog SET template_markdown = $md_69$# Controle de Ponto Eletrônico

## 0. Metadados
- **Produto:** ClockIn — sistema de registro de ponto e apuração de jornada para RH
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Registrar entradas e saídas de colaboradores, calcular banco de horas com base em escala configurada, apurar horas extras e faltas, e gerar espelho de ponto exportável para folha de pagamento.

## 2. Personas
- Colaborador — registra ponto e consulta seu saldo de horas.
- Gestor de RH — configura escalas, aprova ajustes e exporta espelho de ponto.
- Auditor — consulta histórico imutável de marcações para conformidade com legislação trabalhista.

## 3. Requisitos Funcionais (FR)

### FR-01 — Marcação de ponto por colaborador
DADO um colaborador autenticado, QUANDO clica em "Registrar ponto", ENTÃO o sistema registra timestamp, IP e geolocalização (se habilitada), e exibe a marcação confirmada.

### FR-02 — Configuração de escalas e jornada
DADO um gestor de RH, QUANDO cadastra uma escala com dias da semana, horário de entrada/saída e intervalo, ENTÃO a escala é associada a colaboradores e usada como base para cálculo de desvios.

### FR-03 — Apuração de horas extras e faltas
DADO um colaborador com escala de 8h/dia (seg-sex), QUANDO o sistema apura o mês fechado, ENTÃO calcula horas extras (acima de 8h/dia), faltas (ausência sem marcação) e saldo de banco de horas.

### FR-04 — Ajuste manual de marcação
DADO um colaborador que esqueceu de marcar ponto, QUANDO o gestor de RH cadastra um ajuste com justificativa, ENTÃO a marcação é inserida com flag "ajuste manual" e aguarda aprovação de segundo nível.

### FR-05 — Espelho de ponto exportável
DADO um gestor de RH, QUANDO solicita espelho de ponto de um colaborador para um período, ENTÃO o sistema gera PDF com todas as marcações, ajustes, totalizadores (horas trabalhadas, extras, faltas) e assinatura digital.

## 4. Requisitos Não-Funcionais
- Marcação de ponto com latência < 300ms. Disponibilidade 99,9%. Histórico de marcações imutável (append-only log). Dados de geolocalização retidos por 1 ano (LGPD). Espelho de ponto assinado digitalmente (conformidade NR-1).

## 5. Regras de Negócio
- Marcação duplicada em intervalo < 1 minuto é rejeitada. Ajuste manual exige aprovação de gestor diferente do solicitante. Banco de horas acumula até 100h; excedente converte em pagamento. Falta não justificada desconta dia de trabalho.

## 6. Modelo de Dados
- employees(id, matricula, nome, departamento, escala_id, saldo_horas, status)
- schedules(id, nome, dias_semana, entrada, saida, intervalo_min)
- punches(id, employee_id, timestamp, tipo, ip, lat, lng, ajuste, aprovado_por)
- apuracao_mensal(id, employee_id, mes_ref, horas_trabalhadas, horas_extras, faltas, saldo_final)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para painel web. Backend: Fastify + PostgreSQL com trigger de append-only em punches. Geração de PDF: Puppeteer. Assinatura digital: ICP-Brasil ou equivalente.
$md_69$ WHERE slug = 'rh-ponto';
UPDATE spec_catalog SET template_markdown = $md_70$# Recrutamento e Seleção

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
$md_70$ WHERE slug = 'rh-recrutamento';
UPDATE spec_catalog SET template_markdown = $md_71$# Roteirização de Entregas

## 0. Metadados
- **Produto:** RouteOptimizer — sistema de otimização de rotas de entrega para logística urbana
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Planejar rotas de entrega respeitando janelas de tempo, capacidade de veículo e prioridade, otimizando distância e tempo, com acompanhamento em tempo real do motorista.

## 2. Personas
- Planejador logístico — cadastra paradas e gera rotas otimizadas.
- Motorista — recebe rota no app e atualiza status das entregas.
- Gestor de operações — monitora cumprimento de SLA e desempenho de frota.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de paradas com endereço e janela
DADO um planejador autenticado, QUANDO cadastra uma parada com endereço, janela de entrega (ex: 14h-16h) e peso, ENTÃO o sistema geocodifica o endereço e valida a janela contra o horário operacional.

### FR-02 — Alocação de veículos com capacidade
DADO um planejador, QUANDO seleciona um conjunto de paradas e um veículo com capacidade de 500kg, ENTÃO o sistema aloca apenas paradas cujo peso somado não exceda a capacidade.

### FR-03 — Otimização de sequência de paradas
DADO uma rota com N paradas alocadas, QUANDO o planejador aciona "Otimizar", ENTÃO o sistema calcula a sequência que minimiza distância total, respeitando janelas de tempo e prioridades.

### FR-04 — Acompanhamento do motorista em rota
DADO um motorista com rota iniciada, QUANDO atualiza o status de uma parada para "entregue" ou "falhada", ENTÃO o sistema registra timestamp e localização GPS, e notifica o planejador se houver atraso em relação ao SLA.

### FR-05 — Alertas de desvio de rota
DADO uma rota em execução, QUANDO o motorista se desvia mais de 500m da sequência planejada, ENTÃO o sistema envia alerta ao gestor e sugere recalcular a rota restante.

## 4. Requisitos Não-Funcionais
- Otimização de rota com até 100 paradas em < 5 segundos. Disponibilidade 99,5%. Dados de localização do motorista retidos por 90 dias (LGPD). API de mapas com fallback (Google Maps → OpenStreetMap).

## 5. Regras de Negócio
- Parada com janela de tempo tem prioridade sobre paradas sem restrição. Veículo só pode iniciar rota se todas as paradas tiverem geocodificação válida. Entrega falhada permite até 2 reenvios automáticos na mesma rota.

## 6. Modelo de Dados
- stops(id, endereco, lat, lng, janela_inicio, janela_fim, peso, prioridade, status)
- vehicles(id, placa, capacidade_kg, tipo, status)
- routes(id, vehicle_id, planejador_id, distancia_total_km, tempo_estimado_min, status)
- route_stops(id, route_id, stop_id, sequencia, eta, status, timestamp_entrega, lat_entrega, lng_entrega)

## 7. Stack sugerida
- Frontend: Next.js 14 + Mapbox GL JS para visualização de mapas. Backend: Fastify + PostgreSQL com PostGIS. Motor de otimização: OR-Tools (Google) ou OSRM. App mobile: React Native para motorista.
$md_71$ WHERE slug = 'roteirizacao-entregas';
UPDATE spec_catalog SET template_markdown = $md_72$# Roteiros de Viagem

## 0. Metadados
- **Produto:** TripPlanner — plataforma de criação de roteiros de viagem personalizados
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que viajantes montem roteiros personalizados por dia, descobrindo atrações, reservando atividades e compartilhando o itinerário com acompanhantes, otimizando a experiência de planejamento.

## 2. Personas
- Viajante — busca destinos, monta roteiro por dia e reserva passeios.
- Agência de turismo — cadastra destinos, atrações e pacotes de atividades.
- Acompanhante — recebe roteiro compartilhado e acompanha a viagem.

## 3. Requisitos Funcionais (FR)

### FR-01 — Catálogo de destinos e atrações
DADO um viajante na plataforma, QUANDO busca um destino (ex.: Paris), ENTÃO visualiza atrações turísticas com descrição, horário de funcionamento, preço médio e avaliações.

### FR-02 — Criação de roteiro por dia
DADO um viajante criando um roteiro, QUANDO adiciona uma atração ao dia 1, ENTÃO ela é inserida na ordem escolhida com horário sugerido baseado na duração média de visita.

### FR-03 — Reserva de atividades
DADO um viajante visualizando uma atração, QUANDO seleciona "Reservar passeio guiado", ENTÃO escolhe data, horário e quantidade de pessoas, e o sistema valida disponibilidade e processa pagamento.

### FR-04 — Estimativa de tempo e deslocamento
DADO um roteiro com múltiplas atrações no mesmo dia, QUANDO o viajante salva o roteiro, ENTÃO o sistema calcula tempo de deslocamento entre atrações (via API de mapas) e alerta se o dia está sobrecarregado.

### FR-05 — Compartilhamento do roteiro
DADO um viajante com roteiro criado, QUANDO compartilha via link público ou e-mail, ENTÃO acompanhantes podem visualizar o itinerário completo (somente leitura) e comentar em cada dia.

### FR-06 — Acompanhamento durante a viagem
DADO um viajante com roteiro ativo, QUANDO marca uma atração como "visitada", ENTÃO ela é destacada como concluída e o próximo item do dia é destacado.

## 4. Requisitos Não-Funcionais
- Integração com API de mapas (Google Maps, Mapbox) para deslocamento. API < 600ms p95. Disponibilidade 99%. Pagamento seguro (PCI-DSS) para reservas. Armazenamento de imagens de atrações otimizado (CDN). Compartilhamento com link único (UUID) e expiração configurável.

## 5. Regras de Negócio
- Atração só pode ser adicionada uma vez por dia no mesmo roteiro.
- Reserva de atividade exige pagamento adiantado; cancelamento até 48h antes com reembolso de 80%.
- Roteiro compartilhado expira após 90 dias de inatividade (sem edições).
- Tempo de deslocamento considera tráfego médio do horário configurado.

## 6. Modelo de Dados
- destinations(id, name, country, description, cover_image_url)
- attractions(id, destination_id, name, description, category, duration_avg_minutes, price_avg, lat, lng, rating)
- itineraries(id, user_id, destination_id, start_date, end_date, shared_link, shared_at, expires_at)
- itinerary_days(id, itinerary_id, day_number, date)
- itinerary_items(id, itinerary_day_id, attraction_id, order, start_time, visited)
- bookings(id, itinerary_item_id, user_id, activity_name, scheduled_at, guests, amount, payment_status)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI + Mapbox ou Google Maps API. Backend: Fastify + PostgreSQL. Pagamento: integração com gateway (Stripe). API de deslocamento: Google Directions API. CDN: Cloudflare ou CloudFront para imagens.
$md_72$ WHERE slug = 'roteiros-turismo';
UPDATE spec_catalog SET template_markdown = $md_73$# Sistema de Gestão para Salão de Beleza

## 0. Metadados
- **Produto:** BeautyBook — plataforma de agendamento e gestão financeira para salões de beleza com controle de comissões
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Automatizar agendamento de serviços de beleza, gestão de profissionais e cálculo de comissões, reduzindo conflitos de horário e erros financeiros.

## 2. Personas
- Administrador do salão — cadastra profissionais, serviços e acompanha faturamento.
- Profissional — visualiza sua agenda, confirma atendimentos e acompanha comissões.
- Cliente — agenda serviços online e mantém histórico de atendimentos.

## 3. Requisitos Funcionais (FR)

### FR-01 — Autenticação e perfis
DADO um usuário cadastrado, QUANDO informa credenciais válidas, ENTÃO recebe token e acessa o sistema conforme perfil (admin, profissional ou cliente).

### FR-02 — Cadastro de profissionais e serviços
DADO um administrador autenticado, QUANDO cadastra profissional com nome, especialidades e percentual de comissão, ENTÃO o profissional fica disponível para agendamentos nos serviços que domina.

### FR-03 — Agenda com duração e prevenção de conflito
DADO um cliente autenticado, QUANDO seleciona serviço, profissional e horário disponível, ENTÃO o sistema bloqueia o slot pela duração do serviço (30, 60, 90 minutos) e impede reservas sobrepostas.

### FR-04 — Confirmação de atendimento e cálculo de comissão
DADO um agendamento realizado, QUANDO o profissional marca como concluído e informa valor cobrado, ENTÃO o sistema calcula comissão do profissional (percentual sobre valor) e registra no relatório financeiro.

### FR-05 — Ficha e histórico do cliente
DADO um cliente com atendimentos anteriores, QUANDO o profissional acessa ficha dele, ENTÃO visualiza histórico de serviços, preferências e observações registradas.

### FR-06 — Controle financeiro e relatórios
DADO agendamentos concluídos no período, QUANDO o administrador acessa relatório financeiro, ENTÃO visualiza faturamento total, comissões por profissional e serviços mais rentáveis.

## 4. Requisitos Não-Funcionais
- API de agendamento com resposta < 500ms p95; locks transacionais para prevenção de double-booking.
- Interface responsiva para mobile (clientes) e desktop (profissionais/admin); disponibilidade 99,5%.
- Dados de contato do cliente (e-mail, telefone) protegidos; histórico de serviços acessível apenas pelo profissional que atendeu ou admin.
- Notificações por SMS ou WhatsApp para confirmação de agendamento 24h antes.

## 5. Regras de Negócio
- Agendamento só pode ser confirmado por cliente cadastrado; não-clientes podem consultar horários disponíveis mas não agendar.
- Cancelamento com menos de 3 horas de antecedência gera penalidade (cliente fica bloqueado para novos agendamentos por 7 dias).
- Comissão é calculada apenas sobre serviços marcados como concluídos; agendamentos cancelados não geram comissão.
- Profissional não pode ter dois agendamentos simultâneos; sistema valida sobreposição de horários antes de confirmar reserva.

## 6. Modelo de Dados
- professionals(id, name, phone, commission_rate, status)
- services(id, name, description, duration_minutes, base_price)
- professional_services(professional_id, service_id)
- customers(id, name, email, phone, registered_at)
- bookings(id, customer_id, professional_id, service_id, booking_date, start_time, end_time, status, amount_charged, completed_at)
- commissions(id, booking_id, professional_id, commission_amount, paid_at)
- customer_notes(id, customer_id, professional_id, note, created_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para calendário e gestão; PWA para acesso mobile de clientes.
- Backend: Fastify + PostgreSQL com locks transacionais para agendamento; Redis para cache de horários disponíveis.
- Notificações: integração com Twilio para SMS ou API oficial do WhatsApp Business para lembretes de agendamento.
$md_73$ WHERE slug = 'salao-beleza';
UPDATE spec_catalog SET template_markdown = $md_74$# Agendamento de Consultas

## 0. Metadados
- **Produto:** MediSchedule — plataforma de agendamento médico online
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Sistema de agendamento de consultas que conecta pacientes e profissionais de saúde, permitindo reserva de horários, cancelamento e lembretes automáticos, reduzindo faltas e otimizando a agenda.

## 2. Personas
- Profissional de saúde — configura agenda e disponibilidade.
- Paciente — busca especialistas, agenda e cancela consultas.
- Secretária de clínica — gerencia agenda de múltiplos profissionais.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de profissionais e especialidades
DADO um profissional de saúde com CRM válido, QUANDO se cadastra informando especialidade e horários de atendimento, ENTÃO seu perfil é criado e fica disponível para busca de pacientes.

### FR-02 — Busca de profissionais por especialidade e localização
DADO um paciente, QUANDO busca profissionais filtrando por especialidade e cidade, ENTÃO recebe lista ordenada por avaliação com foto, nome e horários disponíveis.

### FR-03 — Visualização de agenda com horários disponíveis
DADO um paciente visualizando perfil de profissional, QUANDO consulta agenda, ENTÃO vê slots de 30 minutos disponíveis para os próximos 30 dias, excluindo horários já reservados ou bloqueados.

### FR-04 — Agendamento de consulta com bloqueio de conflito
DADO um paciente autenticado, QUANDO seleciona horário disponível e confirma, ENTÃO a consulta é registrada e o slot é bloqueado atomicamente para evitar dupla reserva, e o paciente recebe confirmação por e-mail.

### FR-05 — Cancelamento de consulta pelo paciente
DADO um paciente com consulta agendada, QUANDO solicita cancelamento com pelo menos 24 horas de antecedência, ENTÃO a consulta é cancelada, o slot é liberado e ambos recebem notificação.

### FR-06 — Lembrete automático antes da consulta
DADO uma consulta agendada, QUANDO faltam 24 horas para o horário, ENTÃO o sistema envia lembrete por e-mail e SMS ao paciente com dados da consulta e link para cancelamento.

### FR-07 — Bloqueio de horários pelo profissional
DADO um profissional, QUANDO bloqueia período de férias ou indisponibilidade, ENTÃO os slots desse período ficam ocultos para novos agendamentos e consultas já marcadas são mantidas.

## 4. Requisitos Não-Funcionais
- Busca de profissionais retorna resultados em menos de 400ms p95.
- Disponibilidade de 99,5% para agendamentos.
- PII de pacientes (CPF, telefone, histórico) nunca em logs; armazenamento criptografado conforme LGPD.
- Lembretes enviados com pelo menos 99% de taxa de entrega.

## 5. Regras de Negócio
- Slot só pode ser reservado se disponível no momento da confirmação (check atômico).
- Cancelamento com menos de 24h de antecedência notifica o profissional mas não libera o slot.
- Paciente não pode ter mais de 3 consultas ativas simultaneamente para evitar abuso.
- Profissional pode configurar duração de consulta (30, 45 ou 60 minutos).

## 6. Modelo de Dados
- professionals(id, name, crm, specialty, city, rating, photo_url)
- availability_rules(id, professional_id, day_of_week, start_time, end_time)
- time_slots(id, professional_id, date, start_time, end_time, status)
- appointments(id, professional_id, patient_id, slot_id, status, created_at)
- patients(id, name, cpf, email, phone)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para portal paciente/profissional.
- Backend: Fastify + PostgreSQL com row-level locking para agendamentos concorrentes.
- Jobs: cron para geração de slots e envio de lembretes.
- Integração: Twilio para SMS e serviço de e-mail transacional.
$md_74$ WHERE slug = 'saude-agendamento';
UPDATE spec_catalog SET template_markdown = $md_75$# Rede Social com Feed

## 0. Metadados
- **Produto:** ConnectHub — rede social com perfis, feed cronológico, curtidas, comentários e sistema de seguidores
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma social para usuários criarem perfil, publicarem conteúdo (texto, imagens, vídeos), interagirem via curtidas e comentários, e seguirem outros usuários para consumir feed personalizado, construindo comunidades e engajamento em torno de interesses comuns.

## 2. Personas
- Usuário criador de conteúdo — publica posts, fotos e vídeos, responde comentários e acompanha métricas de engajamento.
- Usuário consumidor — segue perfis de interesse, consome feed cronológico, curte e comenta posts.
- Moderador — monitora denúncias, remove conteúdo impróprio e aplica sanções em perfis que violam termos de uso.

## 3. Requisitos Funcionais (FR)
### FR-01 — Cadastro e autenticação de usuários
DADO um visitante no site, QUANDO preenche formulário de cadastro informando nome, e-mail único, senha e data de nascimento (mínimo 13 anos), ENTÃO o sistema registra o usuário com perfil público vazio, envia e-mail de confirmação e permite login com credenciais.

### FR-02 — Perfil de usuário e edição de dados
DADO um usuário autenticado, QUANDO acessa a página de perfil e edita foto de perfil, bio de até 160 caracteres e cidade, ENTÃO o sistema valida o upload de imagem (máximo 2MB, formatos JPG/PNG), salva as alterações e exibe no perfil público.

### FR-03 — Seguir e deixar de seguir usuários
DADO um usuário A visualizando o perfil de um usuário B, QUANDO clica em "Seguir", ENTÃO o sistema registra o relacionamento de follow, incrementa contador de seguidores de B e seguindo de A, e posts de B passam a aparecer no feed de A; "Deixar de seguir" desfaz o relacionamento.

### FR-04 — Publicação de posts com texto e mídia
DADO um usuário autenticado, QUANDO cria um post informando texto de até 500 caracteres e opcionalmente anexando até 4 imagens ou 1 vídeo (máximo 50MB), ENTÃO o sistema valida o conteúdo, processa upload de mídia, registra o post com timestamp e o exibe no perfil do autor e feed dos seguidores.

### FR-05 — Feed cronológico dos perfis seguidos
DADO um usuário autenticado, QUANDO acessa a home, ENTÃO o sistema carrega feed paginado com posts dos perfis que o usuário segue, ordenados por data de publicação decrescente (mais recentes primeiro), exibindo autor, texto, mídia, contadores de curtidas e comentários.

### FR-06 — Curtidas em posts
DADO um usuário visualizando um post no feed ou perfil, QUANDO clica no ícone de curtida, ENTÃO o sistema registra a curtida única por usuário/post, incrementa o contador de curtidas do post e notifica o autor; clicar novamente remove a curtida.

### FR-07 — Comentários em posts
DADO um usuário visualizando um post, QUANDO escreve um comentário de até 200 caracteres e envia, ENTÃO o sistema registra o comentário vinculado ao post, incrementa contador de comentários, notifica o autor do post e exibe o comentário abaixo do post ordenado por data.

## 4. Requisitos Não-Funcionais
- Feed carregado em < 500ms p95; cache de timeline com invalidação ao publicar novo post.
- Upload de imagens com resize automático para thumbnail (300px) e alta resolução (1080px); vídeos processados de forma assíncrona.
- Disponibilidade 99,9%; mídia servida via CDN.
- Dados de IP, localização e atividades sensíveis (denúncias, bloqueios) não expostos publicamente; acesso restrito a moderadores.

## 5. Regras de Negócio
- Um usuário não pode seguir a si mesmo; tentativa de auto-follow é bloqueada.
- Posts podem ser deletados pelo autor a qualquer momento; comentários e curtidas vinculados são removidos em cascata.
- Perfis privados (configurável) exigem aprovação do seguidor; posts só aparecem no feed após aceitação.
- Comentários podem ser reportados por qualquer usuário; 3 denúncias acionam revisão de moderador; conteúdo impróprio resulta em remoção e advertência ao autor.
- Curtidas e comentários em posts de perfis que o usuário não segue não geram notificação (evita spam de interação).

## 6. Modelo de Dados
- users(id, email, username, password_hash, display_name, bio, profile_picture_url, city, birthdate, is_private, created_at)
- follows(id, follower_user_id, followed_user_id, created_at)
- posts(id, author_user_id, text_content, created_at, updated_at, status)
- post_media(id, post_id, media_url, media_type, display_order)
- likes(id, post_id, user_id, created_at)
- comments(id, post_id, author_user_id, text_content, created_at)
- reports(id, content_type, content_id, reporter_user_id, reason, status, reviewed_by_user_id, reviewed_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI + Infinite scroll (react-infinite-scroll). Backend: Fastify + PostgreSQL + Redis (cache de feed e contadores). Storage: S3 + CloudFront. Processamento de vídeo: AWS MediaConvert ou FFmpeg assíncrono via SQS. Auth JWT.
$md_75$ WHERE slug = 'social-feed';
UPDATE spec_catalog SET template_markdown = $md_76$# Streaming de Vídeo VOD

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
$md_76$ WHERE slug = 'streaming-video';
UPDATE spec_catalog SET template_markdown = $md_77$# Telemedicina

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
$md_77$ WHERE slug = 'telemedicina';
UPDATE spec_catalog SET template_markdown = $md_78$# Lista de Tarefas

## 0. Metadados
- **Produto:** TaskMate — gerenciador de tarefas pessoais com autenticação
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Permitir que usuários organizem tarefas pessoais, marquem como concluídas e filtrem por status, com sincronização em tempo real.

## 2. Personas
- Usuário final — organiza tarefas diárias, marca como feitas e consulta pendências.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro e login de usuário
DADO um visitante, QUANDO preenche e-mail e senha e confirma cadastro, ENTÃO recebe e-mail de boas-vindas e pode fazer login.

### FR-02 — Criar tarefa
DADO um usuário autenticado, QUANDO digita título "Comprar leite" e pressiona Enter, ENTÃO a tarefa é criada como pendente e aparece no topo da lista.

### FR-03 — Marcar tarefa como concluída
DADO um usuário com tarefa pendente, QUANDO clica no checkbox da tarefa, ENTÃO ela é marcada como concluída e risca o texto.

### FR-04 — Editar tarefa
DADO um usuário com tarefa criada, QUANDO clica no título e altera para "Comprar leite integral", ENTÃO a alteração é salva automaticamente.

### FR-05 — Excluir tarefa
DADO um usuário com tarefa criada, QUANDO clica no botão excluir, ENTÃO a tarefa é removida permanentemente após confirmação.

### FR-06 — Filtrar por status
DADO um usuário com 10 tarefas (5 concluídas, 5 pendentes), QUANDO seleciona filtro "Concluídas", ENTÃO visualiza apenas as 5 tarefas concluídas.

### FR-07 — Sincronização em tempo real
DADO um usuário logado em dois dispositivos, QUANDO cria tarefa no celular, ENTÃO ela aparece no navegador desktop em até 2 segundos.

## 4. Requisitos Não-Funcionais
- API com latência < 300ms p95. Sincronização via WebSocket. Disponibilidade 99%. Senha com bcrypt e salting. LGPD: usuário pode exportar ou deletar dados.

## 5. Regras de Negócio
- Tarefa sem título não é criada. Tarefa concluída pode ser desmarcada. Exclusão é permanente (sem lixeira). Usuário só vê suas próprias tarefas.

## 6. Modelo de Dados
- users(id, email, password_hash, created_at)
- tasks(id, user_id, title, completed, created_at, updated_at)

## 7. Stack sugerida
- Frontend: Next.js 14 com WebSocket client. Backend: Fastify + PostgreSQL + Socket.io para sincronização em tempo real. Autenticação: JWT.
$md_78$ WHERE slug = 'todo-list';
UPDATE spec_catalog SET template_markdown = $md_79$# Transcrição e Resumo de Áudio

## 0. Metadados
- **Produto:** VoiceScribe — transcrição automática, diarização e extração de itens de ação de reuniões
- **project_type:** backend_api
- **Versão:** 1.0

## 1. Visão
Receber uploads de áudio (reuniões, entrevistas), transcrever com diarização por locutor, gerar resumo executivo e extrair itens de ação com responsáveis. Reduzir tempo de documentação pós-reunião.

## 2. Personas
- Participante de reunião — envia áudio e recebe transcrição completa.
- Gestor — consulta resumo e itens de ação atribuídos.

## 3. Requisitos Funcionais (FR)

### FR-01 — Upload e fila
DADO um usuário autenticado, QUANDO faz upload de arquivo de áudio até 2GB, ENTÃO o sistema cria registro em fila e inicia transcrição assíncrona.

### FR-02 — Transcrição com diarização
DADO um áudio em fila, QUANDO o worker processa, ENTÃO gera transcrição com timestamp e identificação de locutores distintos.

### FR-03 — Resumo executivo
DADO uma transcrição completa, QUANDO invoca LLM, ENTÃO gera resumo de 3 parágrafos com decisões principais.

### FR-04 — Extração de itens de ação
DADO uma transcrição, QUANDO processa com LLM, ENTÃO identifica tarefas com responsável e prazo mencionados.

### FR-05 — Busca no texto
DADO um usuário com transcrições, QUANDO pesquisa termo, ENTÃO retorna trechos de transcrições que contêm a palavra com contexto.

### FR-06 — Notificação de conclusão
DADO um áudio em processamento, QUANDO finaliza transcrição, ENTÃO envia e-mail ao usuário com link para visualização.

## 4. Requisitos Não-Funcionais
- Transcrição de áudio de 1h em até 5min; disponibilidade 99,5%. Áudio armazenado criptografado; transcrições de reuniões confidenciais com controle de acesso.

## 5. Regras de Negócio
- Áudio em formato não suportado gera erro antes de entrar em fila.
- Diarização limitada a 10 locutores distintos.
- Resumo e itens de ação só gerados após transcrição completa.

## 6. Modelo de Dados
- recordings(id, user_id, filename, duration_seconds, status, created_at)
- transcripts(id, recording_id, speaker_id, start_time, end_time, text)
- summaries(id, recording_id, summary_text)
- action_items(id, recording_id, task, assignee, due_date)

## 7. Stack sugerida
- Backend: Fastify + PostgreSQL + RabbitMQ. Worker Python com Whisper ou API de transcrição (AWS Transcribe, Google Speech-to-Text). LLM para resumo e extração (Claude via Bedrock).
$md_79$ WHERE slug = 'transcricao-audio';
UPDATE spec_catalog SET template_markdown = $md_80$# Encurtador de URLs com Análise de Acessos

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
$md_80$ WHERE slug = 'url-shortener';
COMMIT;
