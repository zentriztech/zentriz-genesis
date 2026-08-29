# Clube de Assinatura Box

## 0. Metadados
- **Produto:** BoxClub — clube de assinatura mensal com curadoria e logística integrada
- **project_type:** fullstack
- **Versão:** 1.0

## 1. Visão
Gerenciar assinaturas recorrentes de boxes temáticas com ciclo de cobrança, curadoria de produtos e integração logística. Facilitar pausas, cancelamentos e gestão de envios com rastreamento.

## 2. Personas
- Assinante — escolhe plano, gerencia assinatura e acompanha entregas.
- Curador — monta boxes mensais com itens selecionados.
- Operador logístico — gera etiquetas e consolida envios.

## 3. Requisitos Funcionais (FR)

### FR-01 — Planos e assinatura
DADO um visitante, QUANDO escolhe um plano mensal, trimestral ou anual, ENTÃO é criada uma assinatura com cobrança recorrente ativa.

### FR-02 — Curadoria de box
DADO um curador autenticado, QUANDO monta um box associando produtos ao ciclo, ENTÃO o box fica disponível para geração de remessas.

### FR-03 — Pausa e reativação
DADO um assinante ativo, QUANDO solicita pausa, ENTÃO a cobrança é suspensa e nenhum envio é gerado até reativação.

### FR-04 — Cancelamento
DADO um assinante, QUANDO cancela, ENTÃO a assinatura passa a expirada ao fim do ciclo pago e não gera mais cobranças.

### FR-05 — Geração de remessa
DADO um box fechado e assinantes ativos, QUANDO inicia o ciclo, ENTÃO cria remessas com status pendente e integra com transportadora.

### FR-06 — Rastreamento
DADO uma remessa enviada, QUANDO o assinante consulta, ENTÃO exibe código de rastreio e eventos de entrega.

## 4. Requisitos Não-Funcionais
- Cobrança recorrente com 99,5% de disponibilidade; API de logística com retry em falhas transitórias. PII (endereço, CPF) restrito a serviço de assinaturas e nunca em logs.

## 5. Regras de Negócio
- Cobrança ocorre no dia de aniversário da assinatura; pausa não altera data de renovação futura.
- Box só pode ser editado até 5 dias antes do fechamento do ciclo.
- Cancelamento com direito a receber box já pago.

## 6. Modelo de Dados
- plans(id, name, billing_cycle, price)
- subscriptions(id, user_id, plan_id, status, next_billing_date)
- boxes(id, cycle_start, cycle_end, status)
- box_items(box_id, product_id, quantity)
- shipments(id, subscription_id, box_id, tracking_code, status)

## 7. Stack sugerida
- Frontend: Next.js 14 + MUI. Backend: Fastify + PostgreSQL. Worker: cron de cobrança e integração logística via API REST.
