> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Evoluir projeto na Bancada (T) — Correções da Fase 2, lote A (S-04, S-06, S-07, S-08, S-10, S-11, S-12, S-14, S-15)

**Data:** 2026-11-04 · **Repositório:** `zentriz-genesis` · **Branch:** `evo/j1` (a partir de `dev`) · **Base:** revisão adversarial [S](EVOLUIR-PROJETO-S-revisao-adversarial-fase2-dados.md).
**Escopo:** só os achados do lote A. Não tocados, por pertencerem à outra frente (API de cards 2.6): `routes/tickets.ts`, `cardState.ts`, `evolveClaim.ts`, `routes/products.ts`, `routes/projects.ts`. Flags continuam `off`; nenhuma migration nova; sem produção, push ou deploy. Caminhos relativos a `applications/services/api-node/src/`.

## 1. Tabela achado × correção × teste × estado

| Achado | Correção | Teste | Estado |
|---|---|---|---|
| **S-04** (ALTA) | A worker thread foi trocada por **processo filho** (`services/attachmentConversionRunner.ts`, entrada `attachmentConversionChild.ts`): `/bin/sh -c 'ulimit -v …; exec node --max-old-space-size=… child'`, monitor de RSS (poll de 50 ms, SIGKILL), timeout duro (SIGKILL), teto de bytes no stdout, `env: {}`, **semáforo global** (`maxConcurrent`, padrão 2, limitado a 1–4). Limites por variável `ATTACHMENT_CONVERSION_*` (calibrado=falso). | `services/attachmentConversionRunner.isolation.test.ts` (8) + `attachmentConverters.test.ts` (23, mesmo caminho do produto) | **Corrigido**; rede real continua sendo do container (ver §3) |
| **S-10** | `drainTicketConversions` inline limitado a N=2 conversões **e** orçamento de 20 s (verificado antes de iniciar cada conversão); o restante segue `pending` para o worker. `ATTACHMENT_CONVERSION_INLINE_MAX` / `_INLINE_BUDGET_MS`. | `attachmentConversionQueue.pg.integration.test.ts` (2 novos) | **Corrigido** |
| **S-14** | `runAttachmentConversions` (`services/tickets.ts`) usa `INSERT … ON CONFLICT (derived_from_attachment_id, filename) WHERE … DO NOTHING`. Consulta de duplicatas no runbook (§4). | mesmo arquivo (6 chamadas concorrentes ⇒ 1 derivado, sem erro) | **Corrigido** |
| **S-15** | Notas no `package.json` (`//dependencias-de-conversao`): `pdfjs-dist` em `~5.5.207` fora da faixa do GHSA-hq66-cqwq-w95j, só atualizar para ≥ 6.2.108; `word-extractor` sem manutenção desde 2022-06-29. `@napi-rs/canvas` **não é mais carregado** na conversão (o filho o bloqueia e usa stubs de `DOMMatrix`/`ImageData`/`Path2D`). | PDF convertido com sucesso sem o canvas (suíte de conversão) e sob `ulimit -v` de 1 GiB | **Corrigido na conversão**; remoção física do binário **não aplicada** (ver §3) |
| **S-07** | `db/init.ts`: `SET lock_timeout`/`statement_timeout` antes dos comandos de cada migration e `RESET` ao fim. Padrões 5 000 ms e 300 000 ms (`MIGRATION_LOCK_TIMEOUT_MS`, `MIGRATION_STATEMENT_TIMEOUT_MS`; `0` desliga). Erro `55P03`/`57014` ⇒ log claro e falha da migration (versão não registrada; a api não sobe, como antes). | `db/initTimeouts.pg.integration.test.ts` (4) | **Corrigido** |
| **S-08** | Menções de reserva da 146 removidas dos relatórios O e P (numeração das novas frentes: ≥ 161). Teste de contrato. | `db/cardsExpand.migration.pg.integration.test.ts`: `projects_status_check` contém `card_draft` e `materializing`; não há arquivo `146_*` | **Corrigido** |
| **S-11** | `backfillCardState` em lotes (`CARDS_BACKFILL_BATCH_SIZE`, padrão 500), `FOR UPDATE OF t` no CTE e `AND t.status = <status lido>` no `UPDATE`. `SET LOCAL statement_timeout` (`CARDS_BACKFILL_STATEMENT_TIMEOUT_MS`, padrão 120 000 ms) por transação de tenant. O modo **global** vira job em segundo plano (`startCardsBackfillJob`), com relatório em `GET /api/admin/runtime-config/cards-backfill[/:jobId]` (só `zentriz_admin`). | `services/cardsBackfill.pg.integration.test.ts` (lotes, `SET LOCAL`, corrida, job assíncrono, 403) | **Corrigido** |
| **S-12** | No ramo sem lista de herdados, `rel_dir LIKE 'tickets/%'` ⇒ `card:legacy`. | mesmo arquivo (filho "v4 antigo") | **Corrigido**; `card:TK-NNNN` **não adotado** (ver §2) |
| **S-06** | `CARDS_BANCADA` é `configOnly` (`FlagDef.configOnly`): o env é ignorado (com aviso no log) e só `genesis_runtime_config` liga, o que sempre dispara o backfill. | `services/featureFlags.test.ts`: `envRaw='1'` e `'on'` ⇒ `{value:0, source:"default"}`; config tenant/global continua valendo; outras flags seguem aceitando env | **Corrigido** |

## 2. Decisões

1. **Processo filho, não `prlimit`.** `node:20-alpine` (v20.20.2, testada) **não traz `prlimit`** (é do util-linux), mas o `ash` do busybox tem `ulimit` embutido. Por isso o limite do SO é `ulimit -v` (RLIMIT_AS) via `sh`. Como `ulimit -v` limita endereçamento, e não RSS, o pai também mede o RSS do filho e o mata (cobre também plataformas onde RLIMIT_AS não vale, como macOS de desenvolvimento).
2. **`--disable-wasm-trap-handler`.** O WebAssembly reserva ~10 GiB de endereços e quebra sob RLIMIT_AS. Verificado que a flag existe na 20.20.2; o runner só a inclui se `process.allowedNodeEnvironmentFlags` a conhecer.
3. **Limite de endereçamento padrão de 4 096 MiB.** Medido: o filho com PDF/DOCX converte a partir de ~1 GiB (sem o canvas) e o padrão dá folga para zip de até 50 MiB e PDF de 10 MiB. RSS padrão 1 024 MiB, heap 512 MiB, stdout 4 MiB. **Todos `calibrado=falso`.**
4. **Em dev/teste** (sem `dist/`), o filho é um bundle esbuild do `.ts`, gravado em `node_modules/.cache/genesis-conversion-child/child-<hash do diretório>.mjs`. O loader do `tsx` foi descartado: ele usa threads e WebAssembly próprios e distorce o limite de endereçamento (medido: precisava de >8 GiB).
5. **Variáveis em vez de `genesis_runtime_config`** para os limites de conversão, de migration e do backfill: são limites do processo/host e valem no boot, antes de haver banco. Se o Jean quiser editar em runtime, o caminho é registrar as chaves em `routes/runtimeConfig.ts` (não feito).
6. **S-06:** escolhida a opção "só configuração" (a alternativa, backfill no boot, ainda deixaria a flag ligar sem decisão explícita). Efeito operacional: `CARDS_BANCADA=1` no compose **deixa de ligar** a flag.
7. **S-11:** o modo por tenant continua síncrono (com `statement_timeout`); só o global (todos os tenants) é assíncrono. O relatório do job fica **em memória** (últimos 20) e no log `[cardsBackfill]`; reiniciar a api perde o relatório, mas o backfill é idempotente (repetir o PUT completa o que faltou). Um lote vazio por corrida é relido uma vez (novo snapshot) antes de encerrar.
8. **S-12:** `card:TK-NNNN` não foi adotado. Só funcionaria no ramo sem lista (o ramo com lista continua `card:legacy`, contrato do relatório P), e `extra.ticket_number` só existe nos filhos criados depois do claim. Adotar em um ramo só deixaria dois vocabulários para a mesma coisa. Fica para a Fase 3.

## 3. Não resolvido ou limitado

- **Rede:** nem processo filho nem Node 20 isolam rede (`fetch` é trocado por erro e as bibliotecas não abrem sockets, mas o bloqueio real é do container, sem egress). Igual ao relatório Q.
- **S-15, remoção física do binário `@napi-rs/canvas`:** a avaliação mostrou que a extração de texto funciona sem ele (com os stubs). Remover o pacote exige regenerar o `package-lock.json` (e o `node_modules` do api-node é compartilhado por symlink nesta frente), então **não apliquei** `overrides`/`--omit=optional`. Proposta: frente própria que remova o pacote e rode `npm install` no worktree. O `npm ci` do Dockerfile e a migração para Node 22 (outras partes do S-15) também ficam fora do lote.
- **Memória do filho sob `ulimit -v` em Alpine:** testei o bundle do filho (PDF) em `node:20-alpine` em 1 536, 2 048 e 4 096 MiB e sem limite: converte nos quatro casos. **Não construí a imagem completa** do Dockerfile; o teste da OOM em Alpine foi feito só com `node -e` (lá o estouro do `Buffer` sai como `RangeError`, que o filho mapeia para `RESOURCE_LIMIT`).
- **Suítes de porta fixa 55432:** a 55432 estava ocupada pela outra frente (`i1-pg-55432`), então rodei tudo contra a minha instância na 55441. Quatro arquivos recusam outra porta por guarda própria (`costSource`, `skillFeedback`, `llm.role-verify`, `llm.reorder`) e falham **igualmente antes e depois** (ver §5). Não os rodei na 55432.
- O relatório Q (histórico) ainda descreve a worker thread; não o reescrevi.

## 4. Runbook (acrescentar ao deploy da Fase 2)

Antes de recriar a api com a 160 (S-14), no Postgres de produção, esperado **0 linhas**:

```sql
SELECT derived_from_attachment_id, filename, count(*)
  FROM ticket_attachments
 WHERE derived_from_attachment_id IS NOT NULL
 GROUP BY 1, 2 HAVING count(*) > 1;
```

Antes de recriar a api com migrations pendentes (S-07): `SELECT pid, state, xact_start, left(query, 80) FROM pg_stat_activity WHERE state = 'idle in transaction' OR xact_start < now() - interval '1 minute';` deve vir vazio. Se a migration falhar por `lock_timeout`, o log traz `[DB] Migration NNN FALHOU por lock_timeout de … ms em: <comando>`, a versão não é registrada e a reexecução converge.

Para ligar `CARDS_BANCADA` (S-06/S-11): só pelo PUT de configuração (env é ignorado). No padrão global, a resposta traz `jobId`; acompanhe em `GET /api/admin/runtime-config/cards-backfill/<jobId>`. **Continua valendo o S-01**: não ligar para tenant com tickets antes da 2.6 (fora deste lote).

## 5. Saídas reais

**Vitest completo, Postgres `pgvector/pgvector:pg16` na 55441** (comando: `PG_TEST_URL=postgres://postgres:test@localhost:55441/postgres npx vitest run`):

```
ANTES  (dev 89a67ca):  Test Files  4 failed | 219 passed (223)   Tests  3841 passed | 26 skipped (3867)
DEPOIS (evo/j1):       Test Files  4 failed | 221 passed (225)   Tests  3862 passed | 26 skipped (3888)
```

As 4 falhas são idênticas nos dois casos: `PG_TEST_URL deve apontar para localhost:55432` (guarda de porta de `costSource`, `skillFeedback`, `llm.role-verify`, `llm.reorder`). A base informada (3866 passaram, 1 pulado) vale com PG na 55432; o número de passados/pulados aqui difere dela por causa dessas 4 suítes (não investiguei a composição exata dos 26 pulados). Diferença: +21 testes e +2 arquivos novos (`attachmentConversionRunner.isolation.test.ts`, `db/initTimeouts.pg.integration.test.ts`), nenhum teste quebrou. `npx tsc --noEmit`: sem erros. Build de produção (`tsc --outDir` temporário): gerou `attachmentConversionChild.js` e a conversão de PDF rodou pelo `dist` ("DIST OK").

**S-04 — bomba e filho que aloca Buffer** (`attachmentConversionRunner.isolation.test.ts`, 8 passaram):
- filho com `Buffer.alloc(64 MiB)` em laço, RSS máx. 300 MiB: `RESOURCE_LIMIT … 300 MiB (RSS)` em < 10 s, e o RSS do processo de teste cresceu < 150 MiB;
- o mesmo laço com `ulimit -v` 1 536 MiB e sem monitor: o próprio SO derruba o filho ⇒ `RESOURCE_LIMIT … limite de memória`;
- laço infinito com timeout de 400 ms: `TIMEOUT` em < 4 s; stdout acima de 500 000 bytes: `RESOURCE_LIMIT … saída`; ambiente do filho sem chaves (só o `PWD` do próprio `sh`); semáforo com `maxConcurrent=1` e três conversões: pico de 1 ativo;
- PDF "bomba" Flate (`makePdfFlateBomb(700)`, arquivo de 713 890 bytes que infla para 700 MiB, razão ~1 000:1): com RSS máx. 400 MiB falha com `RESOURCE_LIMIT`/`TIMEOUT` e a conversão seguinte (DOCX) funciona. Com os **limites padrão**, execução manual: `ERR RESOURCE_LIMIT processo de conversão abortou por limite de memória (heap 512 MiB, endereçamento 4096 MiB)` em 1,1 s. A causa do aborto na bomba varia (heap do V8 ou `SIGTRAP`); o runner mapeia `SIGABRT/SIGSEGV/SIGBUS/SIGTRAP` e as mensagens de OOM para `RESOURCE_LIMIT`.

**S-11 — corrida** (evidência impressa pelo teste): com o código novo `{"status":"rejected","card_state":"rejected"}`; com o `cardsBackfill.ts` anterior (restaurado temporariamente para provar) `{"status":"rejected","card_state":"draft"}`, ou seja, a divergência `[rejected, draft]` reproduzida e agora eliminada.

**S-07:** `ALTER TABLE s07_probe ADD COLUMN x int` atrás de uma transação aberta: falhou em < 3 s com `Migration s07-lock FALHOU por lock_timeout de 300 ms`, a versão não foi registrada, `SHOW lock_timeout` voltou a `0` e, liberado o lock, a reexecução registrou a versão.

## 6. Commits (branch `evo/j1`)

Ver `git log --oneline dev..evo/j1`: S-04 (processo filho), S-10/S-14, S-15, S-07/S-08, S-06/S-11/S-12 e este relatório.
