# Quiz e Avaliações

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
