> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Evoluir projeto na Bancada — Fase 0', tarefa 0.3: reprodução dos defeitos

Data: 2026-11-04 · Branch `evo/e1` (a partir de `dev`) · Plano: [EVOLUIR-PROJETO-BANCADA-plano.md](../plans/EVOLUIR-PROJETO-BANCADA-plano.md) (v2) · Estudos [A](EVOLUIR-PROJETO-A-estado-atual-fabrica.md), [B](EVOLUIR-PROJETO-B-estado-atual-bancada.md), [C](EVOLUIR-PROJETO-C-estudo-de-viabilidade.md), [D](EVOLUIR-PROJETO-D-revisao-adversarial.md), [E](EVOLUIR-PROJETO-E-fase0-precheck-producao.md).

**Nenhuma mudança de comportamento de produto.** Só testes e helpers de teste. Sem produção, sem push, sem LLM real, `docker-compose*` e migrations intactos.

## 1. Como ler

Cada teste afirma o comportamento **correto/desejado**.

- `it.fails(...)` (vitest) ou `xfail(strict=True)` (pytest) = **defeito provado**: a asserção correta falha hoje. Quando a tarefa 1.x corrigir, o marcador estrito faz o teste falhar ("esperado falhar, passou") e deve ser removido.
- Teste normal = **refutado** (já correto) ou controle/caracterização do estado atual.
- Os cenários rodam uma vez em `beforeAll` (erro de preparação deixa a suíte vermelha, nunca "esperado-falha"); as linhas `EVIDÊNCIA` abaixo são a saída real do stdout.
- Postgres real efêmero (`pgvector/pgvector:pg16`, porta 55432, todas as migrations aplicadas pelo mesmo `initDb` do produto), rotas reais via `app.inject`. O contêiner foi derrubado ao final.

## 2. Resultado por defeito

| Id | Defeito (arquivo:linha do estudo) | Resultado | Onde está o teste |
|---|---|---|---|
| (a) | `/evolve` duplicado em corrida (`routes/projects.ts` ~3446 `SELECT` do guard → ~3485 `INSERT`) | **PROVADO** | `projects.evolve.repro.pg.integration.test.ts` (a) |
| (b) | Promoção do ticket sem `AND status='open'` (`projects.ts` ~3661; `services/tickets.ts` ~241; `routes/tickets.ts` ~278) | **PROVADO** (dupla e perdida) | idem (b), (b') |
| (c) | Anexo binário derruba `load_spec_all` (`runner.py` ~951-965) | **PROVADO** (png, xlsx, pdf, e arquivo único) | `orchestrator/tests/test_evolve_repro_f0.py` (c) + cadeia da API em (c) do vitest |
| (d) | Filho do `/evolve` em `spec_submitted` × `/promote` exige `draft` (`pipeline.ts` ~141) | **PROVADO** para pai com spec; **refutado** para pai sem arquivos (nasce `draft`) | (d) |
| (e) | Herança de 1 nível e colisão `TSK-INH-EVO-001` (`runner.py` ~3894-3926; `projects.ts` ~540) | **PROVADO** (um nível e ID sem versão de origem); upsert caracterizado | `test_evolve_repro_f0.py` (e) + (e) do vitest |
| (f) | PATCH de ticket aceita qualquer transição; `reopenTicketsOfChild` reabre `delivered` | **PROVADO** (4 transições inválidas aceitas + `delivered` reaberto); **refutado** `open→delivered` sem filho e `rejected` preservado | (f) |
| (g) | Filho sem `budget_usd` ⇒ `BUDGET_MISSING` (`llmGuard.ts` ~405) | **PROVADO** (filho não herda o orçamento do pai) | (g) |
| (h) | Bancada não promove filho de evolução | **PROVADO** (produto e projeto) | (d), (h) |

## 3. Saída real (evidências)

### (a) N=4 requisições simultâneas, barreira no `SELECT` do guard `EVOLUTION_IN_FLIGHT`
```
[0.3-a] EVIDÊNCIA {"N":4,"respostas":[201,201,201,201],"filhos":[{"v":2,"status":"spec_submitted"} ×4]}
```
Quatro filhos com o **mesmo** `version_number=2`. A barreira (`queryGate`) torna determinístico o intercalamento; para verificar que a corrida acontece sem ela, rodei `Promise.all` puro (experimento descartável, não está na suíte), em Postgres real:

| N simultâneas | Respostas | Filhos criados |
|---|---|---|
| 2 | 201, 409 | 1 |
| 4 | 201, 201, 409, 409 | 2 |
| 8 | 4× 201, 4× 409 | 4 |
| 8 | 8× 201 | 8 |
| 8 | 8× 201 | 8 |

Ou seja, a corrida é real mesmo sem barreira, a partir de 4 requisições. Dois cliques ainda tendem a ser contidos pelo guard; a janela cresce com a concorrência. Testes: `N requisições simultâneas ⇒ exatamente 1 filho` e `nunca dois filhos com o mesmo (parent_project_id, version_number)` (ambos `it.fails`).

### (b) Dupla e perdida
```
[0.3-b/dupla]   {"N":3,"respostas":[201,201,201],"filhos":3,"ticket":{"status":"promoted","child":"d6674663"},"filhosOrfaos":2}
[0.3-b/perdida] {"patchRejeitar":200,"evolve":201,"ticketFinal":"promoted","filhos":1}
```
- **Dupla:** o mesmo ticket gera 3 filhos; o ticket aponta para um só (o último `UPDATE` vence) e 2 filhos ficam órfãos.
- **Perdida:** o `/evolve` é retido imediatamente antes do `UPDATE tickets SET status='promoted'`; o humano recusa o pedido (PATCH `rejected`, 200); ao liberar, a promoção atropela a recusa (`rejected` → `promoted`) e responde 201. O pedido recusado ganhou um filho. Com `AND status='open'` e `rowCount 0 ⇒ 409` isso não ocorre.

### (c) Anexo binário
Cadeia da API (Postgres real): o anexo do ticket chega à lista que o runner concatena, sem filtro por tipo:
```
[0.3-c/api] {"evolve":201,"arquivos":["/spec-evolution-v2.md [text/markdown]","tickets/TK-0001/request.md [text/markdown]","tickets/TK-0001/anexos/print.png [image/png]"]}
```
Runner (pytest, `--runxfail` para ver a falha real):
```
AssertionError: load_spec_all devolveu '' (fallback silencioso para o arquivo primário)
```
para `print.png`, `planilha.xlsx` e `manual.pdf` (os três comprovadamente não-UTF-8 no pré-teste), e também com um único arquivo binário na lista. O teste de caracterização (verde) mostra o mecanismo: `UnicodeDecodeError` engolido por `except Exception`, só um `WARNING` no log, retorno `""`; o caller (`runner.py` ~5558) cai em `load_spec(spec_path)` e `TEXTO-EXTRA` (o resto da árvore) desaparece. O controle (árvore só de texto) concatena tudo. A asserção desejada é "erro explícito **ou** spec de texto intacta; nunca `""` silencioso" — compatível com a ressalva D-M5(c) de que abortar o run por causa de um anexo seria negação de serviço.

### (d) Status do filho × `/promote`
```
[0.3-d] {"paiComArquivos":{"status":"spec_submitted","promote":{"statusCode":409,"code":"NOT_ON_WORKBENCH"}},
         "paiSemArquivos":{"status":"draft","promote":{"statusCode":400,"code":"BAD_REQUEST"}}}
```
Verificado de verdade: a incompatibilidade existe no caso normal (pai com spec ⇒ `inherited > 0` ⇒ `UPDATE … 'spec_submitted'`, `projects.ts` ~3575-3577), e o `/promote` recusa com 409 `NOT_ON_WORKBENCH`. Refutação parcial: se o pai não tem arquivos, o filho fica `draft` e o `/promote` não o recusa por status (cai no gate de spec ausente, 400).

### (h) Bancada × filho de evolução
```
[0.3-h] {"extraEvolution":true,"lifecycleAposEvolve":"accepted","lifecycleAposRecompute":"partially_accepted",
         "promoteProduto":{"statusCode":409,"code":"NOT_ON_WORKBENCH","lifecycleStatus":"partially_accepted"},
         "vereditoTela":{"canPromote":false,"reason":"NOT_ON_WORKBENCH","message":"Este produto já saiu da Bancada (estado atual: partially_accepted) — não há o que promover."}}
```
Para um filho com `extra.evolution=true`, a Bancada responde que o produto "já saiu da Bancada" e o `POST /api/products/:id/promote` devolve 409. Duas causas somadas: o filho nasce `spec_submitted` (d) e o produto com um pai `accepted` nunca está em `draft` (`products.ts` ~1333). O botão do portal (`spec/page.tsx` ~3528-3535) chama exatamente esta rota para produtos reais.

### (g) Orçamento
```
[0.3-g] {"filho":{"budget_usd":null,"budget_owner_project_id":null},
         "preflightPai":{"allow":true,"remainingUsd":50,...},
         "preflightFilho":{"allow":false,"code":"BUDGET_MISSING","message":"Projeto sem orçamento de LLM definido..."}}
```
O pai (US$ 50) é liberado pelo Guard; o filho, criado pelo `/evolve`, não herda nem compartilha o orçamento e é negado. O teste desligou a chave geral (`kill_switch`) só no banco efêmero e a restaurou ao final.

### (f) Transições de ticket
```
PATCH: promoted→open 200 (open) · delivered→open 200 (open) · delivered→rejected 200 (rejected) · rejected→delivered 200 (delivered)
       rejected→open 200 · open→rejected 200 · open→delivered 409 NOT_PROMOTED
reopenTicketsOfChild: delivered→"open" · rejected→"rejected" · promoted→"open"
```
Quatro transições inválidas aceitas; `reopenTicketsOfChild` reabre `delivered` (D-A3). Refutado: `open→delivered` sem filho já é recusado, `rejected` é preservado e `promoted` volta a `open` (desejado).

### (e) Herança e colisão
- Vitest/Postgres: duas escritas de `TSK-INH-EVO-001` com origens distintas ⇒ **1 linha**, a segunda sobrescreve os requisitos da primeira (o upsert é por desenho; o defeito está no gerador do ID).
- Pytest (fake com o mesmo upsert): `v3` herdando de `v2` perde o trabalho da `v1` (`tasks herdadas: ['TSK-INH-EVO-001']`, sem "CRUD de entregas"); `v4` perde uma das duas `TSK-EVO-001` (`origem v2` some). Caracterização: duas versões-pai com `TSK-EVO-001` geram o **mesmo** ID herdado.

## 4. Defeitos adicionais encontrados

1. **Lifecycle do produto fica desatualizado após o `/evolve`.** `lifecycleAposEvolve: "accepted"` com um filho `spec_submitted` existente; só um `recomputeProductLifecycle` posterior leva a `partially_accepted`. O `/evolve` não recalcula. Afeta o que a Bancada e o portal mostram do produto logo após criar a evolução. Não coberto por teste de falha próprio (apenas registrado na evidência de (h)).
2. **`/evolve` não é transacional.** Não só a corrida: a sequência `INSERT` do filho → cópia de arquivos → clone → `UPDATE tickets` não tem `BEGIN`; qualquer exceção intermediária deixa filho (e arquivos em disco) sem ticket promovido. Confirmado indiretamente pelos filhos órfãos de (b); a falha injetada no meio **não** foi testada.
3. **Recusa concorrente deixa filho vivo para pedido recusado** ((b'): `filhos: 1`, ticket `promoted`). Consequência de (b), mas com efeito próprio: um filho executável (e que consome orçamento) nasce de um pedido que o humano já havia recusado.
4. **Estado inicial do Guard em banco novo é `kill_switch=on`** (migration semeia a chave geral ligada; o banco vence o env). Não é defeito de produto; é armadilha de teste, tratada no helper do cenário (g) e que as fases seguintes precisam repetir para qualquer teste que passe pelo Guard.
5. Não verificado: após `PATCH promoted→open` o ticket mantém `child_project_id` (inconsistência `open` + filho vinculado)? A suíte só afirma o status; não li a coluna.

## 5. Suítes antes e depois

| Suíte | Antes (`dev`, base) | Depois (`evo/e1`) |
|---|---|---|
| vitest api-node (com `PG_TEST_URL`) | 3527 passaram, 1 skip (201 arquivos) | **3553 passaram**, 1 skip (202 arquivos): +26 (os `it.fails` contam como passados) |
| `tsc --noEmit` api-node | limpo | limpo |
| pytest `applications/orchestrator/tests` | 1141 passaram, 23 falhas de ambiente conhecidas, 3 skip | **1145 passaram**, 23 falhas (as mesmas), 3 skip, **6 xfailed** |
| pytest raiz (`pytest` completo) | 1148 passaram, 31 falhas (23 do orquestrador + 8 em `tests/`: e2e cto/engineer/pm e `test_connect_contracts`), 15 skip | **1152 passaram**, 31 falhas (as mesmas), 15 skip, **6 xfailed** |

Sem `PG_TEST_URL` os blocos `describePg` são `skip` (o arquivo novo não quebra quem roda sem Postgres).

Os 6 `xfailed` são os defeitos (c) e (e) em Python (os 4 testes normais novos passam). As falhas de ambiente são as mesmas antes e depois (nenhuma nova). O vitest do arquivo novo foi repetido 3 vezes seguidas (26/26, sem flakiness) e, sem `PG_TEST_URL`, fica 26 skip.

## 6. Helpers reutilizáveis (Fases 1'–3)

- `applications/services/api-node/src/testing/evolvePg.ts`
  - `describePg`, `openPg`, `pgHolder`, `dbClientMock()`, `authMock()`, `testUser`: ligam as rotas reais a um Postgres efêmero (modelo do `llm.reorder`), recusam URL fora de `localhost:55432`.
  - `seedAcceptedProduct(pool, {budgetUsd, specContent, extraFiles})`: tenant, usuário, produto `accepted`, pai `accepted` com spec em disco; `cleanup()` restaura `UPLOAD_DIR`/`PROJECT_FILES_ROOT`.
  - `seedTicket(pool, seed, {kind, status, childProjectId, attachments})`: pedido do produto (contador real), com anexos opcionais.
  - `buildApp([...rotas])`: cliente HTTP de teste (`app.inject`).
  - `raceN(n, fn)` e `queryGate(pool, regex, {mode: "barrier" | "hold-before"})`: gerador de corridas determinísticas (barreira após o `SELECT` do guard; ou reter uma requisição antes de um `UPDATE` para intercalar outra escrita).
  - `childrenOf`, `ticketRow`: consultas de verificação.
- `applications/orchestrator/tests/test_evolve_repro_f0.py`: `make_png_bytes/make_xlsx_bytes/make_pdf_bytes`, `FakeSpecApi` (lista de `spec-files` em disco) e `FakeTaskStore` (GET/POST de tasks com o mesmo upsert da API).

Armadilha do `queryGate`: o `pool.query` do `pg` chama `pool.connect(callback)` por dentro; o helper deixa a forma com callback passar sem interceptar (sem isso o PATCH pelo pool travava).

## 7. Como reexecutar
```bash
docker run --rm -d --name g01-pg-test -e POSTGRES_PASSWORD=test -p 55432:5432 pgvector/pgvector:pg16
cd applications/services/api-node
DATABASE_URL=postgres://postgres:test@localhost:55432/postgres npx tsx scripts/apply-migrations-test.ts
PG_TEST_URL=postgres://postgres:test@localhost:55432/postgres npx vitest run src/routes/projects.evolve.repro.pg.integration.test.ts
python -m pytest applications/orchestrator/tests/test_evolve_repro_f0.py -rxX      # --runxfail mostra a falha real
docker rm -f g01-pg-test
```
Ao corrigir cada defeito (tarefas 1.1–1.7), trocar o `it.fails`/`xfail` correspondente por teste normal: o marcador estrito falha sozinho quando o defeito some.
