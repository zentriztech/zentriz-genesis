# Emissor de Notas Fiscais Eletrônicas

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
