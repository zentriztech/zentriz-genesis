# Gestão de Contratos (CLM)

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
