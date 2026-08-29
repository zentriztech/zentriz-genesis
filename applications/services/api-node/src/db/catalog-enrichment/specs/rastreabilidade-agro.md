# Rastreabilidade Agrícola

## 0. Metadados
- **Produto:** AgroTrace — rastreabilidade de lotes agrícolas da origem ao ponto de venda
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Plataforma de rastreabilidade que registra toda a cadeia produtiva de um lote agrícola, desde o plantio até a venda final, garantindo transparência e conformidade com normas de segurança alimentar. Permite que consumidores consultem a origem e histórico de produtos por código do lote.

## 2. Personas
- Produtor rural — cadastra lotes de produção, registra eventos de manejo e colheita.
- Distribuidor — registra eventos da cadeia de custódia (transporte, armazenamento).
- Consumidor final — consulta origem e histórico do produto pelo código impresso na embalagem.
- Auditor de qualidade — verifica conformidade e rastreabilidade completa dos lotes.

## 3. Requisitos Funcionais (FR)

### FR-01 — Cadastro de lote de produção
DADO um produtor autenticado, QUANDO cadastra um novo lote informando propriedade de origem, área plantada, cultura e data de plantio, ENTÃO o sistema gera um código único de rastreabilidade e persiste o lote com status "em cultivo".

### FR-02 — Registro de eventos de manejo
DADO um lote em cultivo, QUANDO o produtor registra um evento de manejo (irrigação, adubação, aplicação fitossanitária) com data, tipo e produtos utilizados, ENTÃO o evento é associado ao histórico do lote com timestamp imutável.

### FR-03 — Registro de colheita
DADO um lote em cultivo, QUANDO o produtor registra a colheita informando quantidade colhida, data e responsável, ENTÃO o lote muda para status "colhido" e a quantidade é registrada.

### FR-04 — Cadeia de custódia
DADO um lote colhido, QUANDO um ator da cadeia (transportadora, armazém, distribuidor) registra posse do lote informando data de recebimento e localização, ENTÃO um evento de custódia é adicionado ao histórico com geolocalização e assinatura digital.

### FR-05 — Registro de venda ao varejo
DADO um lote em posse de distribuidor, QUANDO registra venda a um estabelecimento varejista informando quantidade e data, ENTÃO o sistema fecha a cadeia de custódia e marca o lote como "no varejo".

### FR-06 — Consulta pública por código
DADO um consumidor com código de rastreabilidade impresso na embalagem, QUANDO acessa a plataforma e informa o código, ENTÃO visualiza linha do tempo completa do lote (origem, eventos de manejo, cadeia de custódia, certificações).

### FR-07 — Alertas de não conformidade
DADO um lote com eventos registrados, QUANDO o sistema detecta violação de janela de carência de agrotóxico ou falha na cadeia de frio, ENTÃO gera alerta para o responsável e auditor, bloqueando a venda até regularização.

## 4. Requisitos Não-Funcionais
- API responde em menos de 500ms (p95) para consultas públicas.
- Disponibilidade de 99,7% para módulo de consulta pública.
- Eventos de rastreabilidade são imutáveis (append-only) com hash criptográfico de integridade.
- PII de produtores (CPF, endereço) nunca exposta em consultas públicas, apenas nome e município.
- Sistema suporta até 10.000 consultas públicas simultâneas (Black Friday agrícola).

## 5. Regras de Negócio
- Código de lote é único por tenant e imutável após geração.
- Eventos de cadeia de custódia exigem assinatura digital do responsável (chave privada).
- Lote só pode avançar na cadeia após fechamento de custódia pela etapa anterior.
- Consulta pública só exibe lotes que completaram ao menos uma venda ao varejo.

## 6. Modelo de Dados
- lots(id, code, producer_id, crop, area_ha, planting_date, status, harvest_quantity)
- events(id, lot_id, event_type, event_date, description, actor_id, signature_hash)
- custody_chain(id, lot_id, actor_id, received_at, location_lat, location_lng, signature_hash)
- actors(id, name, type, document, contact)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI para portal de gestão; landing page pública para consultas.
- Backend: Fastify + PostgreSQL com trigger de imutabilidade em events; Redis para cache de consultas públicas.
- Integração: webhook para sistemas de ERP agrícola; API REST para distribuidores.
