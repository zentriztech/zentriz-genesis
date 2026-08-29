# Gestão Escolar

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
