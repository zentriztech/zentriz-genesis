# Avaliação de Desempenho

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
