> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Templates de e-mail transacional (Zentriz Genesis)

Modelos HTML **dark, responsivos** (tabelas `<table>`, sem CSS Grid) para a comunicação transacional com clientes (tenants). Nasceram do onboarding da Venuxx e foram generalizados em templates parametrizados para **os futuros clientes**.

## Templates

| Arquivo | Momento | Placeholders |
|---------|---------|--------------|
| `tenant-created.html` | Tenant criado (aguardando ativação) | `{{GREETING_NAME}}` `{{TENANT_NAME}}` `{{PLAN_NAME}}` `{{RESPONSIBLE_NAME}}` `{{PLATFORM_URL}}` |
| `tenant-activated.html` | Tenant ativado (acesso liberado) | `{{GREETING_NAME}}` `{{TENANT_NAME}}` `{{PLAN_NAME}}` `{{PLATFORM_URL}}` |
| `invoice-covered-by-credits.html` | Fatura do mês abatida integralmente por créditos de cortesia | `{{GREETING_NAME}}` `{{TENANT_NAME}}` `{{PLAN_NAME}}` `{{PLAN_PRICE}}` `{{CREDIT_APPLIED}}` `{{TOTAL_DUE}}` `{{CREDIT_MONTHS}}` `{{PLATFORM_URL}}` |

## Regra de valores — nunca chutar

Os **valores dos planos são a única fonte canônica** e vêm de `GET /api/plans` (público), exibidos em `https://genesis.zentriz.com.br/tenant/signup`. `monthlyPriceCents / 100` = mensalidade em reais.

Valores em **2026-08-26** (reconferir antes de cada envio — podem mudar):

| Plano | max_projects | max_users | Mensalidade |
|-------|-------------|-----------|-------------|
| Prata | 10 | 5 | R$ 23.000,00 |
| Ouro | 20 | 10 | R$ 38.000,00 |
| Diamante | 50 | 25 | R$ 77.000,00 |

> `{{PLAN_PRICE}}` e `{{CREDIT_APPLIED}}` no template de fatura DEVEM refletir esses valores (ex.: Diamante ⇒ `R$ 77.000,00` e `− R$ 77.000,00`, `{{TOTAL_DUE}} = R$ 0,00`). `{{CREDIT_MONTHS}}` = meses de cortesia concedidos (ex.: 6).

## Como renderizar e enviar

Não há motor de template no `brand-mail`. Renderizar substituindo os `{{PLACEHOLDER}}` (script `sed`/Node) num arquivo temporário e enviar:

```bash
brand-mail --zentriz \
  --to <email-do-responsavel> \
  --reply-to jean@zentriz.com.br \
  --subject "Ambiente <TENANT> criado no Zentriz Genesis" \
  --html /tmp/render.html
```

Contraste (regra de ouro): estes templates usam **texto claro sobre fundo escuro**. Nunca colar bloco de texto claro em card claro.

## Concessão de créditos — restrição dura (decisão do Jean, 2026-08-26)

A **concessão** de créditos **NÃO é feita por API**. Quando o Jean conceder créditos a uma empresa, o lançamento é **injetado manualmente** (SQL controlado), para manter o controle. Hoje não existe ledger de créditos: o abatimento é modelado por `tenants.billing_exempt=true` (isenção binária). O template de fatura acima descreve a cortesia de forma **narrativa** — só reflete a realidade quando um sistema de créditos auditável existir (ver `project/docs/plans/PLANO_VENUXX_V2_ONBOARDING_GENESIS_2026-08-26.md` §3.2/§13).
