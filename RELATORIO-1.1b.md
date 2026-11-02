> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Relatório 1.1b — Teste de integração em Postgres real (efêmero)

Data: 2026-11-02 · Branch `worktree-agent-ac7702b9b8f08ddaa` · Sem push.

## Ambiente
- Container `evo-pg-test`, imagem `pgvector/pgvector:pg16` (a mesma do `docker-compose.yml` do Genesis, linha 115; já estava local e foi atualizada por pull), porta 55432. Banco de dev (`zentriz-genesis-postgres-1`) e produção **não foram tocados**; os scripts recusam qualquer URL fora de `localhost:55432`.
- pgvector era necessário? As 134 migrations passaram sem erro de extensão na imagem pgvector (a `postgres:16` simples não foi testada).

## Migrations
Script novo `applications/services/api-node/scripts/apply-migrations-test.ts`: chama o próprio `initDb()` de `src/db/init.ts` (mesmo split ingênuo por `;`, remoção de linhas `--`), apontando `DATABASE_URL` ao efêmero. Resultado: **134/134 aplicadas, exit 0, zero erros ou avisos** (`schema_migrations` = 134). Segunda execução: `[DB] All migrations up to date`.

## Testes
`src/services/skillFeedback.pg.integration.test.ts` (condicionado a `PG_TEST_URL`; sem a variável, os 12 testes ficam `skipped` e a suíte padrão segue com 26 passando).

```
  RUN  v2.1.9 /home/ubuntu/workspace/current/zentriz/zentriz-autonomy-suite/zentriz-genesis/.claude/worktrees/agent-ac7702b9b8f08ddaa/applications/services/api-node
  ✓ skillFeedback — Postgres real (efêmero) > idempotência: o mesmo sinal 2x não conta duas vezes
  ✓ skillFeedback — Postgres real (efêmero) > concorrência: 8 requisições simultâneas com a mesma chave contam uma vez só
  ✓ skillFeedback — Postgres real (efêmero) > concorrência: sinais distintos simultâneos na mesma skill serializam (FOR UPDATE) sem perder update
  ✓ skillFeedback — Postgres real (efêmero) > shadow→trusted exige >=5 evidências fortes E score >=0,7
  ✓ skillFeedback — Postgres real (efêmero) > human_approve (sinal forte) também conta para trusted; oracle_fail não promove
  ✓ skillFeedback — Postgres real (efêmero) > trusted→deprecated exige >=10 evidências fortes E score <0,3; hard_rule nunca deprecia
  ✓ skillFeedback — Postgres real (efêmero) > qa_pass/qa_fail nunca mudam status nem use_count (só o score informativo)
  ✓ skillFeedback — Postgres real (efêmero) > modo shadow grava com chave 'shadow|' mas não altera skill
  ✓ skillFeedback — Postgres real (efêmero) > hit_count de lição é idempotente (por projeto+lição+sinal), com fan-out real de bundles e injeções
  ✓ skillFeedback — Postgres real (efêmero) > CHECK de sinais (DROP+ADD da 134): aceita os 9 sinais e rejeita desconhecido
  ✓ skillFeedback — Postgres real (efêmero) > índice único parcial: chave NULL repetida é permitida (linhas legadas), chave igual é barrada
  ✓ skillFeedback — Postgres real (efêmero) > a migration 134 pode ser reexecutada (mesmo split ingênuo do runner) sem erro e sem perder dados
  Test Files  1 passed (1)
       Tests  12 passed (12)
    Start at  20:40:43
    Duration  857ms (transform 56ms, setup 0ms, collect 70ms, tests 568ms, environment 0ms, prepare 46ms)
```

Cobertura: idempotência por chave; concorrência (8 requisições com a mesma chave → 1 contada; 6 sinais distintos simultâneos na mesma skill serializam via `FOR UPDATE` sem perder update); shadow→trusted (4 evidências com score alto não transita, a 5ª transita; 5 evidências com score <0,7 não transita; 10 passos chega a ≥0,7 e transita; `human_approve` também conta; `oracle_fail` não promove); trusted→deprecated (9 evidências com score <0,3 não depreca, a 10ª depreca; `hard_rule` nunca depreca); `qa_pass`/`qa_fail` ×30 nunca mudam status nem `use_count`; modo shadow grava `shadow|…` sem alterar a skill; `hit_count` idempotente (2 bundles de rework → 1 skill, retry, outra task, projeto inteiro, 6 concorrentes → +1 por projeto, sinal negativo e shadow não contam); CHECK da 134 (9 sinais aceitos, `bogus` rejeitado, 1 única constraint); índice único parcial (NULL repetido permitido, chave igual barrada); migration 134 reexecutada 2× com o split do runner, sem erro, sem perder dados, e o motor segue idempotente.

**Teste de mutação (sanidade):** com `MIN_STRONG_FOR_TRUST` trocado temporariamente de 5 para 3, 1 teste falhou (shadow→trusted); revertido com `git checkout`. Os testes detectam regressão.

## Bugs encontrados
Nenhum no SQL da 134 nem no motor (`skillFeedback.ts`). Nenhuma correção de produto foi necessária; não há commit de fix.

## Não coberto
- Rotas HTTP (`/api/skills/feedback`, `skills.ts`) e o gancho do runner (`recordProjectOutcome` via `projects.ts`): testados apenas com pool simulado; aqui só o motor + SQL via `pgFeedbackStore`/`withTransaction`.
- Banco com dados legados reais (linhas antigas de `skill_feedback` com `idempotency_key` NULL entram só em teste sintético) e volume/performance.
- Migration aplicada sobre banco já em uso (locks do `ALTER`/`CREATE INDEX` sem `CONCURRENTLY` em tabela grande); aqui o banco estava vazio.
- Comportamento de `lesson_injection` alimentada pelo runtime real (CAG); os registros foram semeados no teste.
- Imagem `postgres:16` sem pgvector e `postgres:16-alpine` (usada em outro serviço do compose, linha 398) não foram exercitadas.
- Cópia da réplica do split em `init.ts` no teste da reexecução (`runMigration` não é exportada): se o runner mudar, o teste precisa acompanhar.

## Como rodar
```
docker run --rm -d --name evo-pg-test -e POSTGRES_PASSWORD=test -p 55432:5432 pgvector/pgvector:pg16
cd applications/services/api-node
DATABASE_URL=postgres://postgres:test@localhost:55432/postgres npx tsx scripts/apply-migrations-test.ts
PG_TEST_URL=postgres://postgres:test@localhost:55432/postgres npx vitest run src/services/skillFeedback.pg.integration.test.ts
docker rm -f evo-pg-test
```
