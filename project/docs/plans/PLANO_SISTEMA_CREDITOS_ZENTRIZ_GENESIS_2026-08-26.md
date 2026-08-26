> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Plano de Implementação — Sistema de Créditos (Zentriz Genesis) — VERSÃO FINAL

> Control plane financeiro do Genesis. Ledger de crédito de cortesia **append-only (com enforcement real, não só convenção), auditável e balanceado**, integrado ao subsistema financeiro real (charges/payments/invoices/finance_audit). Substitui a isenção binária `billing_exempt` por **saldo que decresce por ciclo**. Concessão é **injeção manual server-side, sem API** (restrição dura mantida). Moeda em **centavos inteiros (BRL)**.
>
> **Mudanças relativas ao rascunho** (correções da banca): (1) o consumo passa a ser acoplado à **EXISTÊNCIA** da cobrança de assinatura, não à sua criação — cobrindo charge de onboarding e criação manual; (2) o preço do plano **não é hardcodado** — o grant é dimensionado pelo valor VIVO em prod; (3) append-only e dupla-entrada ganham **enforcement por trigger** (aplicado via psql, canal fora do runner); (4) **todo** writer que mexe em `tenant_credit` (grant/consume/reversal) toma o mesmo advisory lock; (5) reversal fica totalmente especificado e idempotente; (6) rollback pós-F4 **religa `billing_exempt`** no mesmo passo; (7) a união TS de `audit()` é estendida; (8) reativação de suspenso é tratada por caminho explícito.

---

## 1. Objetivo e princípio

### 1.1 Problema atual
Hoje uma cortesia é modelada por `tenants.billing_exempt = true` (`061_tenant_billing_exempt.sql:13-15`): flag booleana de **efeito duplo** — exclui o tenant da geração de cobrança (`finance.ts:573`, `AND t.billing_exempt = false`) **e** impede suspensão por inadimplência (`financeBillingWorker.ts:45`). É isenção **binária e infinita**: sem saldo, não decrementa, não expira, sem rastro contábil de "quanto de cortesia foi consumido". O caso Venuxx (Diamante × 6 ciclos) hoje está assim, com flip manual de carência D+180 (memória `plano-venuxx`), sem nenhum lançamento financeiro.

### 1.2 Solução
Um **ledger de crédito de dupla entrada**, append-only, do qual o **saldo é derivado** (nunca campo mutável solto). A cada ciclo o crédito **abate a cobrança** de assinatura pelo pipeline de pagamentos já existente (`payments` → `recalcChargeStatus` → `maybeActivateTenant`), de modo que:
- a cobrança do ciclo é **gerada** normalmente e **quitada por crédito** (vira `paid`), produzindo trilha contábil real (charge + payment + invoice possível), ao contrário de `billing_exempt` que não gera nada;
- quando **o saldo acaba**, a cobrança seguinte simplesmente **não é abatida** (ou é abatida parcialmente) e volta ao fluxo normal: `open` → `overdue` (worker passo 1) → suspensão (worker passo 2).

> **Correção de linguagem (nit ops-migration):** o consumo **não é um processo em background**. Ele é **acoplado à existência da cobrança de assinatura da competência** e disparado no mesmo evento em que `generate-month` roda — e `generate-month` é um **POST manual de `zentriz_admin`** (`finance.ts:556`); **não há scheduler** que o invoque (o único worker automático, `financeBillingWorker`, só faz overdue/suspend). A cobertura de N ciclos **pressupõe** que `generate-month` seja executado 1× por competência. Cobrança mensal verdadeiramente automática é um gap pré-existente, fora do escopo deste plano (registrado em §11).

### 1.3 Por que ledger de dupla entrada
- **Imutabilidade e reconstrução**: saldo é `SUM()` sobre lançamentos append-only — padrão de `finance_audit` (`054:82-93`) e `pipeline_cost_ledger` (`027:5-23`). Nenhum estado é sobrescrito.
- **Balanceamento**: cada movimento gera pernas cujo `SUM(debit) = SUM(credit)`, permitindo **reconciliação** e cruzamento com `payments`.
- **Moeda**: centavos inteiros `INTEGER` com `CHECK`, travado em BRL (`054:5,35`, `056:18`).

### 1.4 Por que concessão manual-only (sem API) — restrição dura mantida
**Conceder crédito é criar valor a favor do cliente** — o oposto de `charges` (valores a receber). Um endpoint de concessão, mesmo restrito a `zentriz_admin`, seria o único ponto capaz de "imprimir dinheiro" a favor de um tenant — superfície de risco desnecessária. Como o Genesis já injeta estado sensível server-side por migration/SQL, a concessão vive **fora da API**: script SQL controlado pelo Jean via `psql` no prod. O sistema expõe **apenas leitura de saldo** e executa o **consumo acoplado ao ciclo**. Reforço técnico: em prod o `JWT_SECRET` de dev é rejeitado no boot (`index.ts:33`), então **não dá para forjar token `zentriz_admin`** — a injeção **tem** que ser server-side.

---

## 2. Modelo de dados

### 2.1 Numeração da migration
Última: `064_products_inbox_and_product_id_notnull.sql` (carregadas por ordenação lexicográfica `NNN_`, 3 dígitos — `init.ts:56-58`). **Próxima: `065_`**:
- `065_credit_ledger.sql` — DDL do ledger + extensão dos CHECKs de `payments.method` e `finance_audit.entity_type` + view de saldo. **Sem trigger** (o runner não os cria — §2.2).
- **Bundle de triggers `065b_credit_ledger_guards.sql`** — append-only + zero-sum, aplicado **via psql fora do runner** (§2.5). Passo **obrigatório** pós-065.
- Concessão Venuxx: **sempre via `psql`** (§3), **nunca** como migration (usa CTE/transação que o runner parte).

### 2.2 Restrições do runner (obrigatórias)
O runner **não é parser SQL** (`init.ts:28-41`): remove linhas cujo `trim()` começa com `--`, faz **split ingênuo por `;`**, executa statement a statement **sem transação agrupadora**. Portanto, no `.sql` que passa pelo runner (o `065_`):
- **Nunca** `;` dentro de string literal, dollar-quoting `$$…$$`, `CREATE FUNCTION/TRIGGER`, `DO $$` — seriam partidos no meio (classe de bug da 048).
- Comentários **inline** não são removidos → todo comentário em **linha própria** com `--`; aspas simples **balanceadas** por statement (`migrations.test.ts:38-49`).
- Tudo idempotente: `CREATE TABLE IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` antes de `ADD CONSTRAINT`, `ON CONFLICT DO NOTHING`.
- **Triggers/functions vivem no `065b` aplicado por psql** (§2.5), porque o runner não consegue emiti-los.

### 2.3 Duas tabelas: transações + pernas (dupla entrada)
`credit_ledger_transactions` (o movimento e sua chave de idempotência) separada de `credit_ledger_entries` (as pernas). A **idempotência é por transação** (`debit`+`credit` compartilham a chave); saldo derivado das pernas.

**Contas (`account`):**
| Conta | Papel |
|-------|-------|
| `tenant_credit` | saldo de cortesia **disponível**. `balance = Σcredit − Σdebit` nesta conta. |
| `courtesy_offset` | contrapartida da **concessão** (a Zentriz doa). |
| `billing_consumption` | contrapartida do **consumo** (crédito consumido vira abatimento). |

**Movimentos e pernas (todos zero-sum):**
| `entry_type` | Perna 1 | Perna 2 | Efeito em `tenant_credit` |
|--------------|---------|---------|-----------------|
| `grant` | `tenant_credit` **credit** | `courtesy_offset` **debit** | +amount |
| `consume` | `tenant_credit` **debit** | `billing_consumption` **credit** | −amount |
| `reversal` de um `grant` | `tenant_credit` **debit** | `courtesy_offset` **credit** | −amount |
| `reversal` de um `consume` | `tenant_credit` **credit** | `billing_consumption` **debit** | +amount |

> **Reversal totalmente especificado** (corrige minor/idempotency-concurrency): as duas pernas de um `reversal` são exatamente o **espelho** das pernas da transação estornada (a mesma `amount_cents`, direções invertidas). Isto mantém o zero-sum e torna o reversal um estorno contábil verdadeiro (não um "débito solto").

### 2.4 `amount_cents` do header — denormalizado, não-autoritativo (corrige minor)
`credit_ledger_transactions.amount_cents` é **explicitamente denormalizado**: existe só para leitura/extrato (§6) e conveniência de auditoria. **A fonte de verdade é sempre a soma das pernas** (`credit_ledger_entries`). Duas defesas:
1. o trigger de zero-sum (§2.5) garante que as pernas batem entre si;
2. a reconciliação (§7) inclui asserção `transaction.amount_cents == SUM(amount_cents de um lado das pernas)` — pega header divergente das pernas.

### 2.5 DDL — `065_credit_ledger.sql` (passa pelo runner)

```sql
-- 065_credit_ledger.sql
-- Sistema de creditos de cortesia: ledger de dupla entrada, append-only.
-- Convencao: dinheiro sempre em centavos inteiros (INTEGER), BRL; FKs ON DELETE RESTRICT/SET NULL
-- para preservar historico financeiro (mesma politica de 054). Idempotente + forward-only.
-- SEM trigger/function aqui: o runner faz split ingenuo por ';' e nao suporta dollar-quoting.
-- Os guards de append-only e zero-sum vivem em 065b, aplicado via psql (ver secao 2.5 do plano).

CREATE TABLE IF NOT EXISTS credit_ledger_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('grant','consume','reversal')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  competence_month TEXT CHECK (competence_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  charge_id UUID REFERENCES charges(id) ON DELETE SET NULL,
  reverses_transaction_id UUID REFERENCES credit_ledger_transactions(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  ref TEXT,
  memo TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES credit_ledger_transactions(id) ON DELETE RESTRICT,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  account TEXT NOT NULL CHECK (account IN ('tenant_credit','courtesy_offset','billing_consumption')),
  direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotencia global do movimento.
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_tx_idempotency
  ON credit_ledger_transactions (idempotency_key);

-- Um unico consumo por tenant/competencia (espelha uq_charges_subscription_competence 054:55-57).
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_tx_consume_competence
  ON credit_ledger_transactions (tenant_id, competence_month)
  WHERE entry_type = 'consume' AND competence_month IS NOT NULL;

-- Um unico reversal por transacao estornada (bloqueia double-reversal).
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_tx_reversal_target
  ON credit_ledger_transactions (reverses_transaction_id)
  WHERE entry_type = 'reversal';

CREATE INDEX IF NOT EXISTS idx_credit_tx_tenant
  ON credit_ledger_transactions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_entries_tenant_account
  ON credit_ledger_entries (tenant_id, account, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_entries_tx
  ON credit_ledger_entries (transaction_id);

-- Saldo DERIVADO (nunca campo mutavel). balance_cents >= 0 e invariante de aplicacao+trigger+reconciliacao.
CREATE OR REPLACE VIEW tenant_credit_balance AS
SELECT tenant_id,
       COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_cents ELSE -amount_cents END), 0)::int AS balance_cents
FROM credit_ledger_entries
WHERE account = 'tenant_credit'
GROUP BY tenant_id;

-- Extensao do CHECK de payments.method. Reconstrucao lista TODOS os valores previos (054:66) + 'credit'.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('pix','boleto','card','transfer','cash','manual','credit'));

-- Extensao do CHECK de finance_audit.entity_type (054:85 + 055 'tenant') + 'credit_ledger'.
ALTER TABLE finance_audit DROP CONSTRAINT IF EXISTS finance_audit_entity_type_check;
ALTER TABLE finance_audit ADD CONSTRAINT finance_audit_entity_type_check
  CHECK (entity_type IN ('charge','payment','bank_account','invoice','tenant','credit_ledger'));

COMMENT ON TABLE credit_ledger_transactions IS 'Creditos de cortesia (dupla entrada, append-only enforced por trigger 065b). Concessao/reversal = injecao manual server-side; consumo = acoplado ao ciclo. Saldo derivado da view tenant_credit_balance. amount_cents do header e denormalizado; fonte de verdade sao as pernas.';
```

### 2.6 Guards por trigger — `065b_credit_ledger_guards.sql` (aplicado por psql, fora do runner)

> **Corrige o major "append-only não é enforced" e o major "zero-sum nunca enforced em write time".** O runner não consegue criar triggers/functions (split ingênuo por `;`, sem dollar-quoting). Mas o **mesmo canal psql** que aplica a concessão (§3) aplica estes guards. É passo **obrigatório** do rollout (§10) e é **asserido por teste de integração**.

```sql
-- 065b_credit_ledger_guards.sql  — APLICAR VIA psql (NAO pelo runner). Idempotente.

-- (1) Append-only: bloqueia qualquer UPDATE/DELETE nas tabelas do ledger.
CREATE OR REPLACE FUNCTION credit_ledger_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'credit ledger is append-only: % on % rejected', TG_OP, TG_TABLE_NAME;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_credit_tx_append_only ON credit_ledger_transactions;
CREATE TRIGGER trg_credit_tx_append_only
  BEFORE UPDATE OR DELETE ON credit_ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_append_only();

DROP TRIGGER IF EXISTS trg_credit_entries_append_only ON credit_ledger_entries;
CREATE TRIGGER trg_credit_entries_append_only
  BEFORE UPDATE OR DELETE ON credit_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_append_only();

-- (2) Zero-sum por transacao, validado no COMMIT (CONSTRAINT TRIGGER DEFERRED):
--     permite inserir as duas pernas na mesma tx e checa o balanceamento so no commit.
CREATE OR REPLACE FUNCTION credit_ledger_zero_sum() RETURNS trigger AS $fn$
DECLARE net INTEGER;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents ELSE -amount_cents END),0)
    INTO net FROM credit_ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF net <> 0 THEN
    RAISE EXCEPTION 'credit ledger transaction % is unbalanced (net=%)', NEW.transaction_id, net;
  END IF;
  RETURN NULL;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_credit_entries_zero_sum ON credit_ledger_entries;
CREATE CONSTRAINT TRIGGER trg_credit_entries_zero_sum
  AFTER INSERT ON credit_ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_zero_sum();
```

> **Decisão para o Jean (não bloqueante, ver §11):** o trigger fecha o buraco contra `UPDATE`/`DELETE` acidental ou ad-hoc, **inclusive do owner** (o trigger dispara independentemente de privilégio). O único jeito de contorná-lo é um `ALTER TABLE … DISABLE TRIGGER` deliberado — barra muito mais alta que um `DELETE` distraído. O **hardening completo** (recomendado, mas fora do escopo mínimo) é rodar migrations por um role owner e a API por um role **não-owner** com apenas `INSERT`/`SELECT` nas tabelas do ledger; aí `REVOKE UPDATE,DELETE` passa a ser efetivo e nem `DISABLE TRIGGER` é possível pela conexão da API. Recomendo (b) trigger agora + (a) separação de roles como próxima onda.

### 2.7 Justificativa das colunas (resumo)
`tenant_id ON DELETE RESTRICT` (preserva histórico, `054:33`); `amount_cents INTEGER CHECK > 0` (bruto; teto `MAX_CENTS=2_000_000_000` de `finance.ts:38` vale igual); `competence_month` regex `YYYY-MM` (mesma de `charges`), `NULL` para `grant`; `charge_id ON DELETE SET NULL`; `reverses_transaction_id` (estorno rastreável); `idempotency_key NOT NULL UNIQUE`; `ref`/`memo` sem PII (plano/ID/motivo + marcador de operador — §3.3); `created_by` (actor da concessão manual; `NULL` no consumo automático). `credit_ledger_entries` é imutável por design (guardado pelo trigger).

---

## 3. Concessão (injeção manual, sem API)

### 3.1 Por que não há rota
Ver §1.4. Mantemos server-side de propósito.

### 3.2 Dimensionamento do grant — **valor VIVO, não hardcodado** (corrige BLOCKER)

> **Correção do blocker:** o rascunho afirmava "Diamante = 7.700.000 confirmado por `050:8`", mas **`050_plan_monthly_price.sql:13` semeia diamante em `99900` (R$ 999)** — a própria fonte citada prova o contrário. Hardcodar `46.200.000` correria o risco de **over-grant massivo**: se o preço vivo for `99900`, esse valor cobriria ~462 ciclos (~38 anos), jamais "acabando" como pretendido; e, como o plano remove `billing_exempt`, a Venuxx passaria a receber charge (abatida) todo mês por décadas.

**Regra dura:** o grant é `N_ciclos × preço_VIVO`, onde `preço_VIVO` é lido em prod **imediatamente antes** de conceder, e `N_ciclos` é a decisão comercial explícita (Venuxx = 6). O rollout **falha** se o preço divergir do premissado sem decisão do Jean.

```sql
-- PASSO 0 (obrigatorio, antes de conceder): ler o preco vivo do plano da Venuxx em PROD.
SELECT t.id AS tenant_id, p.name AS plan_name, p.monthly_price_cents
FROM tenants t JOIN plans p ON p.id = t.plan_id
WHERE t.id = '0931c5dc-46eb-474a-a54a-dad12733b4b2';
-- Anotar monthly_price_cents observado (ex.: 99900 OU 7700000). grant_cents = 6 * observado.
```

### 3.3 SQL de concessão (parametrizado pelo valor observado; via psql, com lock e atribuição de operador)

> **Corrige:** (a) major idempotency-concurrency — o grant agora toma o **mesmo advisory lock** do consumo; (b) minor security — grava **atribuição de operador** (o §2.7 prometia `created_by`, o rascunho gravava `NULL`).

```sql
-- Aplicar via psql no PROD (transacao agrupada; NAO pelo runner). Idempotente.
-- Substituir :grant_cents pelo 6 * monthly_price_cents observado no PASSO 0.
-- Substituir :operator pelo identificador de quem executa (ex.: 'jean@zentriz.com.br').
BEGIN;

-- Serializa qualquer calculo/gravacao de saldo deste tenant (mesma chave do consume, secao 4/7).
SELECT pg_advisory_xact_lock(hashtext('0931c5dc-46eb-474a-a54a-dad12733b4b2'));

WITH tx AS (
  INSERT INTO credit_ledger_transactions
    (tenant_id, entry_type, amount_cents, competence_month, idempotency_key, ref, memo, created_by)
  VALUES
    ('0931c5dc-46eb-474a-a54a-dad12733b4b2', 'grant', :grant_cents, NULL,
     'grant:venuxx:courtesy-6cycles-v1',
     'plan_diamante|operator=:operator|via=psql-prod',
     'Cortesia 6 ciclos (Diamante, preco vivo verificado) - migra billing_exempt para saldo de credito',
     NULL)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id, tenant_id, amount_cents
)
INSERT INTO credit_ledger_entries (transaction_id, tenant_id, account, direction, amount_cents)
SELECT id, tenant_id, 'tenant_credit',   'credit', amount_cents FROM tx
UNION ALL
SELECT id, tenant_id, 'courtesy_offset', 'debit',  amount_cents FROM tx;

-- Auditoria com atribuicao de operador (idempotente).
INSERT INTO finance_audit (entity_type, entity_id, action, actor_user_id, detail)
SELECT 'credit_ledger', t.id, 'grant', NULL,
       jsonb_build_object('amount_cents', :grant_cents, 'reason', 'courtesy', 'cycles', 6,
                          'plan', 'plan_diamante', 'operator', ':operator', 'granted_via', 'psql-prod')
FROM credit_ledger_transactions t
WHERE t.idempotency_key = 'grant:venuxx:courtesy-6cycles-v1'
  AND NOT EXISTS (SELECT 1 FROM finance_audit a
                  WHERE a.entity_type='credit_ledger' AND a.entity_id=t.id AND a.action='grant');

-- Desliga a isencao binaria: agora o ciclo GERA cobranca, abatida por credito ate zerar.
UPDATE tenants SET billing_exempt = false
WHERE id = '0931c5dc-46eb-474a-a54a-dad12733b4b2';

COMMIT;
```

**Verificação pós-injeção:**
```sql
SELECT balance_cents FROM tenant_credit_balance WHERE tenant_id = '0931c5dc-46eb-474a-a54a-dad12733b4b2';
-- esperado: exatamente 6 * monthly_price_cents observado no PASSO 0.
```

### 3.4 Estorno (reversal) — manual server-side, idempotente e sob lock
Mesma política e mesmos cuidados do grant:

```sql
-- Estorno de UMA transacao (grant OU consume). Idempotente e append-only (nao deleta o original).
BEGIN;
SELECT pg_advisory_xact_lock(hashtext(:tenant_id));
WITH orig AS (
  SELECT id, tenant_id, entry_type, amount_cents FROM credit_ledger_transactions
  WHERE id = :target_tx_id
), rev AS (
  INSERT INTO credit_ledger_transactions
    (tenant_id, entry_type, amount_cents, reverses_transaction_id, idempotency_key, ref, memo, created_by)
  SELECT tenant_id, 'reversal', amount_cents, id,
         'reversal:' || id::text,               -- chave deterministica derivada do original
         'operator=:operator|via=psql-prod', 'Estorno manual', NULL
  FROM orig
  ON CONFLICT (idempotency_key) DO NOTHING       -- rerun = no-op
  RETURNING id, tenant_id, amount_cents, reverses_transaction_id
)
-- Pernas = ESPELHO exato das pernas da transacao estornada (mantem zero-sum e nunca deixa saldo negativo
-- porque estornar um grant so reduz o que o proprio grant adicionou; guard de saldo abaixo).
INSERT INTO credit_ledger_entries (transaction_id, tenant_id, account, direction, amount_cents)
SELECT rev.id, e.tenant_id, e.account,
       CASE WHEN e.direction='credit' THEN 'debit' ELSE 'credit' END,
       e.amount_cents
FROM rev JOIN credit_ledger_entries e ON e.transaction_id = rev.reverses_transaction_id;

-- Guard de saldo: aborta se o estorno deixaria tenant_credit negativo.
DO $guard$ BEGIN
  IF (SELECT balance_cents FROM tenant_credit_balance WHERE tenant_id = :tenant_id) < 0 THEN
    RAISE EXCEPTION 'reversal would drive tenant_credit negative for %', :tenant_id;
  END IF;
END $guard$;
COMMIT;
```

> **Corrige** os minors/major sobre reversal: chave determinística `reversal:{id}` + `ON CONFLICT DO NOTHING` (rerun não duplica); `uq_credit_tx_reversal_target` bloqueia double-reversal; pernas espelhadas garantem zero-sum; advisory lock + guard de saldo impedem overdraft na corrida `consume × reversal`.

---

## 4. Consumo por ciclo — acoplado à **EXISTÊNCIA** da cobrança (corrige BLOCKER)

> **Correção do blocker finance-integration:** o rascunho abatia dentro do `if (inserted)` — só quando o `INSERT ... ON CONFLICT DO NOTHING RETURNING` cria a charge. Mas charges de assinatura nascem em **3 lugares** e 2 não passam por aí: **onboarding no signup** (`signup.ts:262-269`) e **POST manual** (`finance.ts:531-538`). Cenário Venuxx: já existe a charge de onboarding `open` da competência de cadastro; ao aplicar F4, o `generate-month` bate no `ON CONFLICT` → `skipped` → crédito nunca abate → charge `open→overdue→suspende` apesar do saldo. **Solução: o consumo deixa de depender do `RETURNING` do INSERT e passa a operar sobre a EXISTÊNCIA de uma charge de assinatura não-quitada da competência.**

### 4.1 Onde
Passo de **consumo** roda **logo após** o loop de geração de `generate-month` (`finance.ts:556-613`), na **mesma requisição** (mesma competência). É uma **passagem independente** que:
1. seleciona **toda** charge de assinatura da competência em status **`open` / `overdue` / `partially_paid`** (não importa quem a criou: geração, onboarding ou manual), com `tenant` de saldo `> 0`;
2. para cada uma, dentro de sua própria tx com advisory lock, abate por crédito.

Como a seleção é por **charge existente** (não pelo filtro `active/inactive` de elegibilidade de geração), **inclui tenants `suspended`** — o que habilita a reativação (§4.4). Não há dependência do `RETURNING`.

### 4.2 Consulta de elegibilidade do consumo
```sql
-- Charges de assinatura da competencia ainda com saldo devedor, de tenants com credito.
SELECT c.id AS charge_id, c.tenant_id, c.amount_cents,
       COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.charge_id = c.id), 0) AS paid_cents,
       b.balance_cents
FROM charges c
JOIN tenant_credit_balance b ON b.tenant_id = c.tenant_id
WHERE c.kind = 'subscription'
  AND c.competence_month = $1                 -- competencia sendo processada
  AND c.status IN ('open','partially_paid','overdue')
  AND b.balance_cents > 0;
```

### 4.3 Ordem de operações (por charge, tx própria com lock)
1. `BEGIN`.
2. `SELECT pg_advisory_xact_lock(hashtext(tenant_id))` — **mesma chave** de grant/reversal (§3): serializa todo cálculo/gravação de saldo do tenant.
3. Re-ler saldo **dentro da tx** (`balance = Σcredit − Σdebit` em `tenant_credit`) e o `paid_cents` atual da charge; `outstanding = amount_cents − paid_cents`.
4. `applied = min(balance, outstanding)`. Se `applied > 0`:
   - `INSERT credit_ledger_transactions (entry_type='consume', amount_cents=applied, competence_month, charge_id, idempotency_key='consume:{tenant}:{competence}') ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`.
   - Se retornou `txId`: inserir as **duas pernas** (`tenant_credit` debit / `billing_consumption` credit, ambas `applied`) — o CONSTRAINT TRIGGER valida zero-sum no commit.
   - `INSERT payments (charge_id, tenant_id, amount_cents=applied, method='credit', external_id='credit:{tenant}:{competence}') ON CONFLICT (method, external_id) DO NOTHING` — `uq_payments_method_external` (`054:78-80`) garante um pagamento-crédito por ciclo.
   - `await recalcChargeStatus(client, chargeId)` (`finance.ts:165-199`): `applied>=outstanding`→`paid`; `0<applied<outstanding`→`partially_paid`.
   - **Se ficou `paid` e `kind='subscription'`**: `await maybeActivateTenant(client, tenantId, null)` **dentro da tx** (`finance.ts:208-226` faz `UPDATE tenants` + `audit`), e **coletar** o tenant para bustar cache depois.
   - `await audit(client, 'credit_ledger', txId, 'consume', null, { competence, applied, chargeId })`.
5. `COMMIT`. **Após** o commit, para cada tenant coletado, `bustTenantStatus()` (mesmo padrão de `finance.ts:748-755` / `financeBillingWorker.ts:68-69` — invalida cache só depois do commit).

### 4.4 Reativação de tenant `suspended` (corrige major finance-integration)
> O rascunho afirmava que gerar o ciclo reativaria o suspenso via `maybeActivateTenant`. **Falso pelo caminho antigo:** a elegibilidade de `generate-month` é `status='active' OR (status='inactive' AND NOT EXISTS charge de assinatura)` (`finance.ts:566-580`) — **`suspended` nunca é selecionado**, então nenhuma charge nova nasce e o consumo nunca rodava.

Com o consumo desacoplado (§4.1, seleção por **charge existente**), a **charge overdue** que causou a suspensão **é abatida**: `recalcChargeStatus`→`paid` e, não havendo mais charge de assinatura `overdue`, `maybeActivateTenant` (`finance.ts:220-224`) volta o tenant a `active`. É o único caminho que efetivamente reativa; o teste de §9 valida-o com a charge overdue preexistente.

### 4.5 Esboço (novo passo, após o loop de geração; `t.monthly_price_cents` e `audit()` corrigidos)
```js
// Passo de CONSUMO — roda apos o loop de geracao de generate-month, sobre charges EXISTENTES.
// Corrige o minor: NAO le inserted.amount_cents (o RETURNING so traz id); usa c.amount_cents da charge.
const activatedTenants = new Set();
const eligible = await pool.query(ELIGIBLE_CONSUME_SQL, [competence]); // secao 4.2
for (const row of eligible.rows) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [row.tenant_id]);
    const bal = await client.query(
      `SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount_cents ELSE -amount_cents END),0)::int AS b
         FROM credit_ledger_entries WHERE account='tenant_credit' AND tenant_id=$1`, [row.tenant_id]);
    const paid = await client.query(
      `SELECT COALESCE(SUM(amount_cents),0)::int AS p FROM payments WHERE charge_id=$1`, [row.charge_id]);
    const outstanding = row.amount_cents - paid.rows[0].p;
    const applied = Math.min(bal.rows[0].b, outstanding);
    if (applied > 0) {
      const tx = await client.query(
        `INSERT INTO credit_ledger_transactions
           (tenant_id, entry_type, amount_cents, competence_month, charge_id, idempotency_key, memo, created_by)
         VALUES ($1,'consume',$2,$3,$4,$5,'Abatimento automatico de credito no ciclo',NULL)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [row.tenant_id, applied, competence, row.charge_id, `consume:${row.tenant_id}:${competence}`]);
      if (tx.rows[0]) {
        const txId = tx.rows[0].id;
        await client.query(
          `INSERT INTO credit_ledger_entries (transaction_id, tenant_id, account, direction, amount_cents)
           VALUES ($1,$2,'tenant_credit','debit',$3),($1,$2,'billing_consumption','credit',$3)`,
          [txId, row.tenant_id, applied]);
        await client.query(
          `INSERT INTO payments (charge_id, tenant_id, amount_cents, method, external_id, reference, created_by)
           VALUES ($1,$2,$3,'credit',$4,'credit-auto',NULL)
           ON CONFLICT (method, external_id) DO NOTHING`,
          [row.charge_id, row.tenant_id, applied, `credit:${row.tenant_id}:${competence}`]);
        const rc = await recalcChargeStatus(client, row.charge_id);
        if (rc.status === 'paid') {
          const act = await maybeActivateTenant(client, row.tenant_id, null); // UPDATE tenants dentro da tx
          if (act) activatedTenants.add(row.tenant_id);
        }
        await audit(client, 'credit_ledger', txId, 'consume', null,
                    { competence, applied, chargeId: row.charge_id });
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
for (const tId of activatedTenants) bustTenantStatus(tId); // apos COMMIT (padrao finance.ts:748-755)
```

> **Ajuste de tipo (corrige major/nit ops):** `audit()` hoje tem união `"charge"|"payment"|"bank_account"|"invoice"|"tenant"` (`finance.ts:145`); chamar com `'credit_ledger'` é `TS2345` e o build `tsc && cp` **falha** (bloqueia `ecr-push.sh` e todo o rollout). **F2 inclui, explicitamente, estender essa união para `'credit_ledger'`** (e qualquer type equivalente). Rodar `npm run typecheck` local antes do build ECR.

### 4.6 Saldo esgotado / parcial
Sem `applied` (`balance = 0`) a charge não é tocada e segue o fluxo padrão: passo 1 do worker → `overdue` (`financeBillingWorker.ts:31-38`); passo 2 → suspensão após `FINANCE_SUSPEND_GRACE_DAYS` (`:42-56`). Com saldo parcial, `partially_paid`: a parte não coberta é o valor a receber.

---

## 5. Convivência e migração de `billing_exempt`

| Mecanismo | Semântica | Casos |
|-----------|-----------|-------|
| `billing_exempt = true` | **Isenção permanente e infinita**, interna. Nunca gera cobrança, nunca suspende, **sem trilha contábil**. | Tenants **internos** da Zentriz (ex.: ZFactory `beca944e-…`, seed `061:17-18`). |
| Saldo de crédito | **Cortesia finita** que **decresce por ciclo**, gera cobrança + pagamento (trilha real) e **acaba**. | Cortesias comerciais a clientes (ex.: **Venuxx**). |

**Regra de exclusão mútua (invariante):** um tenant com saldo de crédito **não** deve estar `billing_exempt=true` — senão nenhuma charge nasce por geração e o crédito nunca é consumido (e note: charges de onboarding/manuais ainda existiriam, mas a geração recorrente pararia). A migração da Venuxx (§3.3) faz **grant + `billing_exempt=false`**. ZFactory permanece `billing_exempt=true`. Não migro automaticamente todos os isentos: `billing_exempt` continua "regra por ID forte", decidida caso a caso; a migração é **por tenant, manual**, junto com a concessão.

---

## 6. Consulta de saldo (somente leitura)

1. **`GET /api/finance/tenants/:tenantId/credit`** — `zentriz_admin` (todo o módulo é dele: `finance.ts:13`, `requireAdmin` `:31-33`). Saldo + extrato (últimas transações).
   ```js
   app.get('/api/finance/tenants/:tenantId/credit', async (req, reply) => {
     if (!requireAdmin(req.user)) return reply.status(403).send(FORBIDDEN);
     const { tenantId } = req.params;
     const bal = await pool.query('SELECT balance_cents FROM tenant_credit_balance WHERE tenant_id=$1', [tenantId]);
     const ledger = await pool.query(
       `SELECT id, entry_type, amount_cents, competence_month, charge_id, memo, created_at
          FROM credit_ledger_transactions WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`, [tenantId]);
     return reply.send({ tenantId, balanceCents: bal.rows[0]?.balance_cents ?? 0, entries: ledger.rows });
   });
   ```
2. **`GET /api/me/credit`** — self-service (**DECIDIDO: implementar, §11**). O papel `tenant_admin` **existe** (`signup.ts:236`, `users.ts:26`); a rota **exige** `role === 'tenant_admin' || role === 'zentriz_admin'` e retorna **403** para `role='user'` (saldo de cortesia é dado comercial sensível). `tenant_id` vem **só do JWT** (`req.user.tenant_id`), **jamais** de query/param (sem IDOR). Retorna **apenas** `balanceCents` (sem extrato).
   **Exibir só para crédito positivo (decisão C do Jean):** se `balance_cents > 0`, retorna `{ hasCredit: true, balanceCents }`; se `0`/inexistente, retorna `{ hasCredit: false }` **sem valor** — o portal só mostra o cartão de crédito para quem tem saldo. Não vaza "R$ 0,00" nem existência de conta zerada.
   ```js
   app.get('/api/me/credit', async (req, reply) => {
     const role = req.user.role;
     if (role !== 'tenant_admin' && role !== 'zentriz_admin') return reply.status(403).send(FORBIDDEN);
     const r = await pool.query('SELECT balance_cents FROM tenant_credit_balance WHERE tenant_id=$1', [req.user.tenant_id]);
     const balance = r.rows[0]?.balance_cents ?? 0;
     if (balance > 0) return reply.send({ hasCredit: true, balanceCents: balance });
     return reply.send({ hasCredit: false });   // saldo 0/negativo/inexistente: nao expoe valor
   });
   ```

Nenhuma rota escreve. **Não existe rota que crie `grant`/`consume`/`reversal`** (§1.4).

---

## 7. Segurança e invariantes

- **Append-only — enforced (não só convenção):** trigger `trg_*_append_only` (§2.6) rejeita `UPDATE`/`DELETE` nas duas tabelas, inclusive do owner. Correções são novos `reversal`. Residual (`DISABLE TRIGGER` deliberado) e hardening por role em §11.
- **Zero-sum — enforced no commit:** `CONSTRAINT TRIGGER trg_credit_entries_zero_sum` (DEFERRED) aborta o commit de qualquer transação cujas pernas não somem zero (single-leg ou débito≠crédito). Substitui a defesa "só reconciliação depois do fato".
- **Saldo nunca negativo:** (a) consumo usa `applied = min(balance, outstanding)`; (b) grant/consume/**reversal** e qualquer débito manual tomam `pg_advisory_xact_lock(hashtext(tenant_id))` **na mesma chave** e re-leem o saldo na tx; (c) o reversal tem guard explícito que aborta se deixaria `tenant_credit < 0` (§3.4). A reconciliação (abaixo) é **invariante com alerta**, não checagem ad-hoc.
- **`method='credit'` só nasce no consumo interno (invariante dura, corrige minor security):** `'credit'` **NUNCA** entra no array de aplicação `PAYMENT_METHODS` (`finance.ts:53`) usado por `POST /api/finance/payments` (`:696,706`). Só o passo de consumo de §4 emite `payment method='credit'`. Comentário no código + **teste** garantindo que `POST /api/finance/payments` com `method='credit'` → **400**. (Sem isso, um admin quitaria charges "de graça" via API, quebrando `consumido==pago_credito`.)
- **Concorrência:** advisory lock por tenant (única barreira de serialização de saldo, cobrindo consume/grant/reversal); `uq_credit_tx_consume_competence` (um consumo por ciclo); `uq_payments_method_external` (um pagamento-crédito por ciclo); `ON CONFLICT` da charge (`054:55-57`). Sobre `hashtext` (int4) colidir entre tenants distintos (nit): correção-neutra (só perde paralelismo entre colidentes), aceitável; se quiser, usar `pg_advisory_xact_lock(hashtext('credit'), hashtext(tenant_id))`.
- **Auditoria com operador:** `finance_audit` (`entity_type='credit_ledger'`) via `audit()`; na concessão manual, `detail.operator` + `granted_via='psql-prod'` (§3.3) — corrige a cegueira de ator do rascunho.
- **PII fora de logs:** `memo`/`ref`/`detail` usam plano/ID/motivo/operador, **nunca** nome/e-mail-de-cliente/documento.

**Reconciliação — invariante agendada e com alerta (não consulta ad-hoc; corrige major):** worker próprio (ou job cron do host, decisão em §11) roda estas queries a cada ciclo; **qualquer linha retornada dispara alerta** e há **teste** que injeta violação e exige detecção. Enquanto não houver o worker, a mesma bateria roda no checklist de rollout (§10) e após cada F4.
```sql
-- (1) zero-sum por transacao (redundante com o trigger; guarda contra trigger desabilitado).
SELECT transaction_id FROM credit_ledger_entries
GROUP BY transaction_id
HAVING SUM(CASE WHEN direction='credit' THEN amount_cents ELSE -amount_cents END) <> 0;   -- 0 linhas
-- (2) saldo nunca negativo.
SELECT tenant_id FROM tenant_credit_balance WHERE balance_cents < 0;                        -- 0 linhas
-- (3) header denormalizado casa com as pernas (corrige minor amount_cents).
SELECT t.id FROM credit_ledger_transactions t
JOIN (SELECT transaction_id, SUM(amount_cents) FILTER (WHERE direction='credit') AS one_side
      FROM credit_ledger_entries GROUP BY transaction_id) s ON s.transaction_id = t.id
WHERE t.amount_cents <> s.one_side;                                                         -- 0 linhas
-- (4) consumo casado com pagamentos-credito.
SELECT c.tenant_id,
       SUM(c.amount_cents) FILTER (WHERE c.entry_type='consume') AS consumido,
       (SELECT COALESCE(SUM(p.amount_cents),0) FROM payments p
         WHERE p.method='credit' AND p.tenant_id=c.tenant_id) AS pago_credito
FROM credit_ledger_transactions c GROUP BY c.tenant_id;   -- consumido == pago_credito
```

---

## 8. Fases de implementação

| Fase | Entrega | Depende de |
|------|---------|------------|
| **F0** | `065_credit_ledger.sql` (DDL + view + ALTERs de CHECK). `migrations.test.ts` verde. | — |
| **F0b** | `065b_credit_ledger_guards.sql` (triggers append-only + zero-sum), aplicado **via psql**; teste de integração assere que `UPDATE`/`DELETE` e insert desbalanceado são rejeitados. | F0 |
| **F1** | Serviço `credit-ledger.ts` (`getBalance`, `consumeEligibleCharges(client, competence)`, helpers). SQL isolado (hexagonal). **Estender união de `audit()` para `'credit_ledger'`.** | F0 |
| **F2** | Integrar **passo de consumo** por existência em `generate-month` (§4). `bustTenantStatus` pós-commit. Blindar `PAYMENT_METHODS` contra `'credit'` + teste 400. | F1 |
| **F3** | Rotas de **leitura** (§6): admin + `/api/me/credit` (self-service, **só saldo positivo** — decisão C). | F0 |
| **F4** | Migração Venuxx: **ler preço vivo (PASSO 0)** → grant `6 × preço` + `billing_exempt=false` (§3). | F0, F0b, F2 em prod |
| **F5** | Testes (§9). | F1–F4 |
| **F6** | Reconciliação como invariante agendada + alerta (§7) — **worker Node dentro da API** (decisão B, padrão `financeBillingWorker`). | F1 |
| **F7** | Rollout dev→prod (§10). | tudo |

F4 **depende** de F2 **e F0b** em prod: só desligar `billing_exempt` **depois** que o abatimento por existência e os guards existam, senão a Venuxx recebe cobrança sem abatimento e é suspensa.

---

## 9. Testes

`migrations.test.ts` **deve passar para o 065** (aspas balanceadas por statement pós-split, `:38-49`). O bloco de invariantes de CHECK (`:52-79`) deve asserir que `payments_method_check` contém `'credit'` **e todos** os valores prévios (`'pix'…'manual'`), e `finance_audit_entity_type_check` contém `'tenant'` **e** `'credit_ledger'` (evita o gap G5 da 040, que derrubou `'queued'`).

**Guards (F0b):**
- `UPDATE`/`DELETE` em `credit_ledger_transactions`/`entries` → exceção (append-only).
- Inserir transação **single-leg** ou pernas com `debit≠credit` → commit rejeitado (zero-sum).

**Unit (serviço):** `getBalance` correto; tenant sem lançamento → 0; toda transação criada tem `SUM(credit)=SUM(debit)`.

**Integração (Postgres):**
- **Grant → saldo**: aplica §3.3 com `:grant_cents = 6 × preço`; `tenant_credit_balance` = esse valor.
- **Consumo por existência (blocker)**: charge de assinatura **preexistente** `open` (simulando onboarding, criada fora do `generate-month`) → após o passo de consumo, charge `paid`, 1 `consume`, 1 payment `credit`, saldo decrementado. **Cobre o cenário Venuxx.**
- **Consumo do ciclo gerado**: charge criada pelo `generate-month` também é abatida.
- **N ciclos**: após N competências, saldo `0`, N charges `paid`.
- **Saldo esgotado**: ciclo N+1 → charge `open` (não abatida), sem `consume`.
- **Saldo parcial**: saldo < preço → `partially_paid`, saldo `0`.
- **Saldo nunca negativo**: consulta (2) da §7 = 0 linhas.
- **Idempotência por ciclo**: rodar consumo **duas vezes** na mesma competência → 1 consume, 1 payment.
- **Idempotência de grant e de reversal**: reexecutar SQL → sem duplicação; double-reversal bloqueado por `uq_credit_tx_reversal_target`.
- **Concorrência consume × reversal**: sob advisory lock, soma dos débitos ≤ créditos; saldo nunca < 0.
- **Reativação (major)**: tenant **`suspended`** com charge de assinatura **overdue** + saldo → passo de consumo abate a overdue → `maybeActivateTenant` volta a `active`; `bustTenantStatus` pós-commit.
- **`method='credit'` bloqueado na API**: `POST /api/finance/payments` com `method='credit'` → **400**.
- **billing_exempt vs crédito**: tenant `billing_exempt=true` não gera charge recorrente (não consome) — confirma exclusão mútua (§5).
- **Reconciliação (4)**: `consumido == pago_credito`.

---

## 10. Rollout dev→prod (manual, ECR→SSH)

Prod é a **EC2 `3.220.66.113`** (`/opt/zentriz-genesis`, branch `main`), **≠** este workstation. Migrations **auto-aplicam no boot da API** (`init.ts`, `index.ts:49`).

1. **DEV**: criar `065_credit_ledger.sql` + `065b_...guards.sql`; código F1–F3 (incl. **união de `audit()`** e bloqueio de `PAYMENT_METHODS`); **`npm run typecheck`** (garante que o build `tsc` não quebra por `TS2345`); `docker compose -f docker-compose.yml -f docker-compose.override.linux.yml -f docker-compose.override.foundry.yml build api genesis-web`; subir local, rodar `migrations.test.ts` + integração (§9), aplicar `065b` via psql local, validar `generate-month`.
2. **Commit** em `dev` (só quando o Jean pedir; **nunca** `git add -A`). Merge para `main`.
3. **Push ECR**: `bash project/infra/aws/ecr-push.sh 820198199720 us-east-1 api genesis-web` (build padrão, guard recusa bundle web com `localhost`).
4. **PROD via SSH** (`ssh -i ~/.ssh/zentriz_id ubuntu@3.220.66.113`): rollback-tag da imagem atual (`sudo docker tag <ID> rollback-api:pre-credits`), login ECR pela **instance role** (sem `--profile`), `pull`+`retag`+`docker compose up -d --no-build --force-recreate api` (**API primeiro** — a migration 065 roda no boot), depois `genesis-web`.
5. **Aplicar `065b` via psql em prod** (`zentriz-genesis-postgres-1`, db `zentriz_genesis`): triggers append-only + zero-sum. **Passo obrigatório** — o runner não os cria.
6. **Verificar deploy** (`healthy` não prova código novo): `docker inspect` digest == digest buildado; `curl https://genesis.zentriz.com.br/health`; `SELECT version FROM schema_migrations WHERE version='065_credit_ledger'`; confirmar triggers: `\d+ credit_ledger_transactions` mostra `trg_*_append_only`.
7. **F4 (Venuxx)**: só **após** F2+F0b no ar — **PASSO 0**: `SELECT p.monthly_price_cents …` (§3.2); calcular `grant = 6 × observado`; **abortar/consultar Jean se divergir do premissado**; aplicar §3.3 com `:grant_cents`/`:operator`; verificar `tenant_credit_balance` = `6 × observado` e `billing_exempt=false`. Checar se há charge de assinatura aberta da competência corrente e, se sim, rodar o passo de consumo (ou `generate-month` da competência) para abatê-la.
8. **Reconciliação** (§7): consultas (1)–(4) → 0 linhas / `consumido==pago_credito`.

**Rollback (corrige major ops — acoplado, não alternativas soltas):**
- **Após F4, o rollback de código é uma única sequência obrigatória, nesta ordem:**
  1. **`UPDATE tenants SET billing_exempt=true WHERE id='0931c5dc-…'`** — **PRIMEIRO**, religa a cortesia binária conhecida (senão o código antigo, sem lógica de crédito, geraria charge sem abatimento → overdue → **suspende a Venuxx**);
  2. `sudo docker tag rollback-api:pre-credits zentriz-genesis-api:latest && docker compose up -d --no-build --force-recreate api`;
  3. registrar `reversal` do grant se a cortesia for encerrada (§3.4).
- **Migration `065`/`065b` são forward-only e aditivas**: reverter código **não** exige derrubá-las. **Não** reverter os ALTERs de CHECK (só adicionam valores; inofensivos). Não `DROP TABLE` de tabela viva.

---

## 11. Riscos e assunções

**Riscos:**
- **Reconstrução de CHECK derruba valor** (gap G5, 040 removeu `'queued'`) → mitigado por `migrations.test.ts` listando **todos** os valores.
- **Trigger de append-only pode ser desabilitado pelo owner** (`DISABLE TRIGGER`) → residual aceito; hardening por separação de roles é a próxima onda (decisão abaixo). A reconciliação (1) re-checa zero-sum como rede.
- **Split ingênuo do runner**: um `;`/aspas ímpares no `065` derruba a API em crash-loop no boot (bug 048) → comentários em linha própria, sem CTE/dollar-quote no `065`; triggers isolados no `065b` via psql; `migrations.test.ts` antes.
- **Semântica de `payments.method='credit'`**: infla `payments` com valores que não são caixa real → reconciliável contra `billing_consumption`; relatórios de caixa devem filtrar `method<>'credit'`; **API bloqueia `'credit'`**.
- **F4 antes de F2/F0b**: Venuxx cobrada sem abatimento → suspensão indevida → dependência explícita (§8/§10).
- **`generate-month` não roda numa competência** → não há charge nem consumo naquele mês (consumo depende do disparo manual do admin). Cobertura de N ciclos pressupõe execução mensal.

**✅ DECIDIDO PELO JEAN (2026-08-26):**
- **A — Preço/N ciclos:** usar o **valor real/vivo dos planos** — o grant é `N × monthly_price_cents lido no PASSO 0` em prod (§3.2). Nunca hardcodar. Hardening por separação de roles (owner p/ migrations × não-owner p/ API) fica para a **próxima onda** (triggers `065b` cobrem o risco imediato).
- **B — Reconciliação:** **worker Node dentro do processo da API** (mesmo padrão de `financeBillingWorker`), roda a bateria de invariantes por ciclo e **alerta** em qualquer linha retornada. Sem cron no host.
- **C — `/api/me/credit`:** **implementar** self-service, mas **exibir o saldo apenas para quem tem crédito positivo** (`balance_cents > 0`); saldo `0`/inexistente → não expõe valor (§6.2 ajustada). Role `tenant_admin`/`zentriz_admin`; `tenant_id` só do JWT.

**Assunções / decisões remanescentes:**
- **DECISÃO (append-only hardening):** adotar agora os **triggers `065b`** (pragmático, enforced inclusive contra owner acidental). Para blindagem contra ato deliberado, migrar para **API sob role não-owner** com só `INSERT`/`SELECT` no ledger e migrations sob role owner (próxima onda). Confirmar se autoriza essa segunda etapa.
- **DECISÃO (preço/N ciclos):** o grant é `6 × monthly_price_cents VIVO` (PASSO 0). **`050:13` semeia `99900` (R$ 999)**; o valor R$ 77.000 (7.700.000) só existiria como edição manual em prod não verificada nesta cadeia. **O rollout lê o valor vivo e falha se divergir do premissado** — o Jean decide o `N_ciclos` e confirma o preço observado antes de conceder.
- **DECISÃO (reconciliação):** dono e cadência do job de reconciliação/alerta (§7/F6) — worker Node no processo da API vs. cron no host. Enquanto não existir, a bateria roda no rollout e pós-F4.
- **`/api/me/credit`** só é implementada se expor saldo a `tenant_admin` for desejado (papel existe); senão, saldo só por `zentriz_admin`.
- **Consumo aplicado no passo de §4** (existência da charge da competência); **não** duplicado no worker. Abatimento retroativo de competências antigas é **manual** (rodar o passo/`generate-month` da competência-alvo), não automático.
- **Estorno (`reversal`)** é manual server-side, sem API (mesma política da concessão).
- `pg_advisory_xact_lock`/`hashtext`/`gen_random_uuid` disponíveis (Postgres padrão) — são.

---

## 12. Checklist de execução

```
□ Confirmar branch dev no repo genesis: git -C <path> branch --show-current
□ 065_credit_ledger.sql (DDL §2.5): tables+entries; UNIQUE (idempotency, consume-competence, reversal-target);
   indexes; VIEW tenant_credit_balance; ALTER payments_method_check (todos + 'credit');
   ALTER finance_audit_entity_type_check (todos + 'credit_ledger'); comentarios em linha propria; sem ';' em CTE/string
□ 065b_credit_ledger_guards.sql (triggers append-only + zero-sum) — aplicar via psql, NAO pelo runner
□ npm test -- migrations.test.ts  (aspas por statement + invariantes de CHECK com TODOS os valores)
□ F1: services/credit-ledger.ts (getBalance / consumeEligibleCharges) — SQL isolado (hexagonal)
□ F1: ESTENDER uniao de audit() para 'credit_ledger' (finance.ts:145) + npm run typecheck
□ F2: passo de CONSUMO por EXISTENCIA da charge em generate-month (§4.1-4.5) + bustTenantStatus pos-commit
□ F2: blindar PAYMENT_METHODS (finance.ts:53) contra 'credit' + teste POST /payments method='credit' => 400
□ F3: GET /api/finance/tenants/:id/credit (requireAdmin/403) + /api/me/credit (role tenant_admin/zentriz_admin; SO exibe se balance>0, senao {hasCredit:false})
□ F5: testes §9 — guards (append-only+zero-sum), consumo por existencia (blocker), reativacao suspenso,
   idempotencia grant/consume/reversal, esgotado, parcial, saldo>=0, concorrencia consume×reversal
□ Subir stack local com os 3 -f; aplicar 065b via psql local; validar generate-month + consumo
□ Commit em dev (SEM git add -A) — so quando o Jean pedir; merge main
□ ecr-push.sh (api genesis-web) — build padrao, guard localhost
□ PROD: rollback-tag → login instance-role → pull/retag → up -d --no-build --force-recreate api (PRIMEIRO) → genesis-web
□ PROD: aplicar 065b via psql (triggers) — OBRIGATORIO
□ Verificar: digest == buildado; schema_migrations 065; triggers presentes (\d+); /health 200
□ F4 (SO apos F2+F0b no ar): PASSO 0 (ler monthly_price_cents vivo) → grant = 6 * observado + billing_exempt=false;
   abortar se preco divergir do premissado sem decisao do Jean
□ Verificar: tenant_credit_balance Venuxx = 6*observado; billing_exempt=false
□ Reconciliacao §7: (1)(2)(3)=0 linhas; (4) consumido==pago_credito
□ Persistir memoria (LEI 0): migracao 065/065b, preco observado, grant real, IDs, estado deploy
```

---

### Arquivos-âncora (referência de implementação)
- `applications/services/api-node/src/db/migrations/065_credit_ledger.sql` (novo) — DDL + view + ALTERs.
- `applications/services/api-node/src/db/migrations/065b_credit_ledger_guards.sql` (novo, **via psql**) — triggers append-only + zero-sum.
- `applications/services/api-node/src/db/migrations.test.ts` — invariantes (deve cobrir 065; asserts de CHECK com todos os valores).
- `applications/services/api-node/src/routes/finance.ts` — `generate-month` (`:556-613`) + **novo passo de consumo por existência**; `recalcChargeStatus` (`:165-199`); `maybeActivateTenant` (`:208-226`, chamado dentro da tx); `audit` (`:144-157`, **estender união para `'credit_ledger'`**); `requireAdmin`/`FORBIDDEN` (`:31-34`); `PAYMENT_METHODS` (`:53`, **bloquear `'credit'`**); `PAYABLE_STATUSES`/`MAX_CENTS` (`:38-48`); novas rotas de leitura.
- `applications/services/api-node/src/routes/signup.ts` — charge de onboarding (`:262-269`): **coberta** pelo consumo por existência (não requer alteração).
- `applications/services/api-node/src/workers/financeBillingWorker.ts` — overdue/suspensão (`:31-56`); **não alterado**.
- `applications/services/api-node/src/services/credit-ledger.ts` (novo) — serviço de ledger (hexagonal).
- `applications/services/api-node/src/db/init.ts` — runner (restrições de formato) e auto-migração no boot.

---

## 13. Validação adversarial — o que foi atacado e resolvido

> Por lente, os achados da banca (2 blockers, 8 majors, 8 minors, 3 nits) e como esta versão resolve cada um no corpo.

### Lente `finance-integration`
- **[BLOCKER] Consumo acoplado à criação da charge, não à existência** → **RESOLVIDO** (§4.1–4.5): o consumo virou **passo independente por existência** que seleciona charges de assinatura `open/partially_paid/overdue` da competência (cobrindo onboarding `signup.ts:262-269` e POST manual `finance.ts:531-538`), sem depender do `RETURNING` do INSERT. Teste dedicado (§9) reproduz o cenário Venuxx.
- **[MAJOR] Reativação de `suspended` não funcionava** (query de elegibilidade exclui suspended) → **RESOLVIDO** (§4.4): seleção por charge existente inclui suspensos; abater a overdue → `maybeActivateTenant`. Teste explícito.
- **[MAJOR] Preço Diamante = 46.200.000 hardcodado, `050:13`=99900** → **RESOLVIDO** (§3.2, tratado também como blocker `ops`): PASSO 0 lê o valor vivo; grant = `6 × preço`; rollout aborta se divergir.
- **[MINOR] `inserted.amount_cents` não existe no RETURNING** → **RESOLVIDO** (§4.5): usa `c.amount_cents`/`t.monthly_price_cents`; não lê do RETURNING.
- **[MINOR] `audit()` type + `maybeActivateTenant` fora do `recalc`** → **RESOLVIDO** (§4.5): união estendida; `maybeActivateTenant` chamado explicitamente antes do COMMIT; `bustTenantStatus` depois.

### Lente `ledger-correctness`
- **[MAJOR] Append-only só por convenção; owner ignora REVOKE** → **RESOLVIDO** (§2.6/§7): trigger `BEFORE UPDATE OR DELETE` aplicado por psql, efetivo inclusive contra owner; residual (`DISABLE TRIGGER`) e hardening por role viram **decisão** para o Jean (§11).
- **[MAJOR] Zero-sum nunca enforced em write time** → **RESOLVIDO** (§2.6): `CONSTRAINT TRIGGER` DEFERRED valida `SUM(debit)=SUM(credit)` por transação no commit; teste rejeita insert desbalanceado/single-leg.
- **[MAJOR] Never-negative só no consume; grants/reversals sem lock** → **RESOLVIDO** (§3.3/§3.4/§7): todo writer toma o **mesmo advisory lock** e re-lê saldo; reversal tem guard explícito; reconciliação (2) vira invariante com alerta.
- **[MINOR] `amount_cents` do header pode divergir das pernas** → **RESOLVIDO** (§2.4): documentado como denormalizado/não-autoritativo + reconciliação (3).
- **[MINOR] `reversal` subespecificado** → **RESOLVIDO** (§2.3/§3.4): pernas espelhadas, chave `reversal:{id}` idempotente, `uq_credit_tx_reversal_target` contra double-reversal.

### Lente `security-manual-only`
- **[MINOR] Concessão sem atribuição de operador** → **RESOLVIDO** (§3.3): `ref`/`memo` + `finance_audit.detail.operator`/`granted_via`; §2.7 alinhado.
- **[MINOR] `'credit'` não blindado contra POST /payments** → **RESOLVIDO** (§7/F2): invariante dura — `'credit'` nunca em `PAYMENT_METHODS`; teste 400.
- **[MINOR] `/api/me/credit` sem checagem de role** → **RESOLVIDO** (§6.2): exige `tenant_admin`/`zentriz_admin`, `tenant_id` só do JWT, 403 para `user`.
- **[NIT] Union de `audit()` sem `'credit_ledger'`** → **RESOLVIDO** (§4.5/F1/checklist): união estendida + coberto pelo teste de CHECK.

### Lente `idempotency-concurrency`
- **[MAJOR] Reversal debita `tenant_credit` sem lock → overdraft irrecuperável** → **RESOLVIDO** (§3.4/§7): reversal sob a mesma chave de lock + guard de saldo; teste de concorrência `consume × reversal`.
- **[MINOR] Reversal sem chave idempotente/ON CONFLICT** → **RESOLVIDO** (§3.4): `reversal:{reverses_transaction_id}` + `ON CONFLICT DO NOTHING` + índice único.
- **[NIT] Colisão de `hashtext` serializa tenants distintos** → **ACEITO** (§7): correção-neutra; opção de chave dupla `(hashtext('credit'), hashtext(tenant_id))` documentada.

### Lente `ops-migration-rollback`
- **[BLOCKER] Preço Diamante hardcodado (`050`=99900) → over-grant ~462 ciclos** → **RESOLVIDO** (§3.2/§10 passo 7/§11): valor vivo + falha se divergir. (Mesmo eixo do major `finance-integration`.)
- **[MAJOR] `audit()` TS union não compila → build/rollout bloqueado** → **RESOLVIDO** (§4.5/F1/§10): união estendida + `npm run typecheck` antes do build ECR.
- **[MAJOR] Rollback de imagem pós-F4 deixa Venuxx `billing_exempt=false` → suspensão** → **RESOLVIDO** (§10): rollback vira **sequência única obrigatória** com `billing_exempt=true` **primeiro**.
- **[MINOR] `inserted.amount_cents` inexistente → NaN** → **RESOLVIDO** (§4.5): usa valor da charge/loop.
- **[NIT] "Consumo automático" enganoso (generate-month é manual)** → **RESOLVIDO** (§1.2): linguagem ajustada para "acoplado à geração da cobrança (disparo manual do admin)"; gap de scheduler registrado como pré-existente.

**Blockers irresolúveis a partir do código:** nenhum. O único ponto sem confirmação possível pela árvore (**preço vivo do Diamante em prod**) foi convertido em **procedimento de verificação obrigatória (PASSO 0) + decisão explícita do Jean**, em vez de premissa hardcodada.