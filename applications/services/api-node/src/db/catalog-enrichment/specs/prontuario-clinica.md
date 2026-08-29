# Prontuário de Clínica

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
