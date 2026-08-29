# Plataforma EAD (LMS)

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
