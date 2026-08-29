# Gestão de Locação

## 0. Metadados
- **Produto:** RentFlow — sistema de gestão de contratos de locação imobiliária com cobrança e reajuste automático
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Automatizar a administração de contratos de aluguel, gerando cobranças mensais com reajuste indexado, registrando vistorias de entrada e saída e facilitando o repasse ao proprietário com transparência.

## 2. Personas
- Imobiliária (gestor) — cadastra imóveis, contratos, gera cobranças e acompanha inadimplência.
- Inquilino — visualiza contrato, histórico de pagamentos e segunda via de boleto.
- Proprietário — recebe repasse mensal e relatório de ocupação do imóvel.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de imóveis e proprietários
DADO um gestor autenticado, QUANDO cadastra um imóvel com endereço, tipo e valor de referência, ENTÃO o imóvel fica disponível para locação e vinculado ao proprietário informado.

### FR-02 — Criação de contrato de locação com índice de reajuste
DADO um gestor ao criar contrato, QUANDO informa inquilino, imóvel, valor inicial, data de início, prazo e índice (IGP-M/IPCA), ENTÃO o contrato é registrado com vigência calculada e reajuste agendado anualmente.

### FR-03 — Geração automática de cobrança mensal
DADO um contrato vigente, QUANDO o worker de cobrança executa no dia de vencimento, ENTÃO gera boleto ou PIX com valor do aluguel (reajustado se aplicável) e envia ao inquilino por e-mail.

### FR-04 — Vistoria de entrada e saída
DADO um contrato ao iniciar ou encerrar, QUANDO o gestor registra vistoria com checklist de itens e fotos, ENTÃO a vistoria é anexada ao contrato e serve de referência para devolução de caução.

### FR-05 — Repasse ao proprietário
DADO um pagamento confirmado pelo inquilino, QUANDO o gestor processa repasse, ENTÃO calcula taxa de administração (%), registra repasse ao proprietário e gera comprovante.

### FR-06 — Alerta de inadimplência
DADO uma cobrança vencida há mais de 5 dias, QUANDO o sistema verifica status, ENTÃO envia alerta ao inquilino e gestor por e-mail e marca contrato como "em atraso".

## 4. Requisitos Não-Funcionais
- API com p95 < 400ms; disponibilidade 99,5%. Worker de cobrança com garantia de execução (idempotência por mês/contrato).
- LGPD: CPF de inquilino e proprietário restritos ao contexto do contrato, nunca em logs.
- Documentos de vistoria (fotos) armazenados em S3 com URL assinada e expiração de 7 dias para acesso.

## 5. Regras de Negócio
- Reajuste aplicado apenas após 12 meses da última atualização, baseado na variação acumulada do índice escolhido.
- Contrato não pode ser excluído se houver cobranças pagas (apenas arquivado).
- Taxa de administração padrão de 10%, configurável por contrato.

## 6. Modelo de Dados
- properties(id, address, type, reference_value, owner_id, status)
- owners(id, name, cpf_hash, bank_account, email)
- tenants(id, name, cpf_hash, phone, email)
- contracts(id, property_id, tenant_id, start_date, end_date, monthly_rent, adjustment_index, status)
- charges(id, contract_id, due_date, amount, status, payment_date, barcode)
- inspections(id, contract_id, type, checklist_json, photos_urls, created_at)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para painel de gestão e portal do inquilino.
- Backend: Fastify + PostgreSQL para API de contratos, cobranças e repasses.
- Worker: Node.js com Bull (Redis) para geração de cobrança recorrente e alertas.
- Integração: API de boleto (Banco do Brasil/Itaú) ou PIX para geração de cobrança.
