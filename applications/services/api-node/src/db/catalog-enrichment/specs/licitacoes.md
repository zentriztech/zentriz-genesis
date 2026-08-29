# Portal de Licitações

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
