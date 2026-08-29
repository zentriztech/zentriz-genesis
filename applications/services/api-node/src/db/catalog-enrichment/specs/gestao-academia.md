# Gestão de Academia

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
