# Plataforma de Aprendizado Gamificado

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
