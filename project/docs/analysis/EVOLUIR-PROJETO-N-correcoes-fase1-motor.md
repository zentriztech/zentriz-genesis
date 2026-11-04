> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Evoluir projeto na Bancada (N): correções da revisão M — motor do claim e consistência

**Data:** 2026-11-04 · **Repositório:** `zentriz-genesis`, worktree `.worktrees/g-g1`, branch `evo/g1` (a partir da `dev`, base `58aa1ce`) · **Frente:** g-g1 (a g-g2 cuida de `githubPush.ts`, `ticketAttachments.ts`, `routes/tickets.ts` exceto o `DELETE`, `runner.py` e flags por tenant). Caminhos relativos a `applications/services/api-node/src/` salvo indicação. Nada em produção, sem push, sem deploy, Guard não tocado, todas as flags continuam `off` por padrão, nenhuma migration nova.

Insumos lidos: [M](EVOLUIR-PROJETO-M-revisao-adversarial-fase1.md) (inteiro), [H](EVOLUIR-PROJETO-H-desenho-tecnico-advisor.md), [I](EVOLUIR-PROJETO-I-fase1-claim-indices-orcamento.md), [K](EVOLUIR-PROJETO-K-fase1-transicoes-e-promocao.md), [L](EVOLUIR-PROJETO-L-fase1-reconciliador.md).

## 1. Achados × correção × teste × estado

| ID | Correção | Teste (arquivo > caso) | Estado |
|---|---|---|---|
| M-04 | `services/evolveClaim.ts`: heartbeat do lease a cada `LEASE/3` (`startHeartbeat`, CAS estrito por `lease_owner` em `renewLease`); `runStep` aborta se o lease se perdeu e só grava marcador depois de `assertAlive()`; `ensureLease()` (renovação estrita) antes de `git link/reset --hard` e antes de `rmSync`+cópia; a cópia passou de `cpSync` (bloqueava o event loop e o heartbeat) para `fs.promises.cp`; `failTerminal` só marca `failed` e reabre o ticket se `lease_owner = me`, senão responde 409 `MATERIALIZATION_IN_PROGRESS` | `projects.evolve.claim.m.pg.integration.test.ts` > M-04 (5 casos): passo longo com lease vencido e repetição concorrente recebe 409; lease tomado no meio (heartbeat vê); lease tomado sem o heartbeat notar (arquivo do outro executor preservado); `failTerminal` de quem perdeu o lease não mata o filho do outro; controle (dono continua recebendo 422) | corrigido. Limite: o subprocesso `git` em si não é abortável (está em `githubPush.ts`, da g-g2); o aborto vale entre as operações |
| M-02-a | `services/lineage.ts` `nextLineageVersion` (CTE descendente da raiz, `max(version_number)` das versões vivas + 1) usado por `createProjectFromSpec` no lugar da contagem de dois níveis | `evolutionUniqueness.pg.integration.test.ts` > "M-02-a" (v1←v2←v3, `POST /api/specs` com `parentProjectId` de v3, v2, v1 dá v4, v5, v6 com 200); verificado que o teste **falha** com o código antigo (`VERSION_CONFLICT` determinístico) | corrigido |
| M-02-b | decisão: **manter os índices** (ver §2); comentário de `routes/projects.ts` reescrito (a corrida do `/evolve` legado com `off` passa a dar 409) | já coberto por "rede de segurança … flag off" (1× 201 e o resto 409) | decidido e documentado |
| M-05 | `stepCode` não engole mais exceção: erro de fs/git/rede ⇒ lança (500 `MATERIALIZATION_FAILED`, lease liberado, repetição retoma); erro de git permanente (`isPermanentGitError`) cai no `disk-copy` se existir, senão `TerminalFailure("CODE_BASE_UNAVAILABLE")`; passo `ticket`: `AttachmentUnreadableError` ⇒ `TerminalFailure("ATTACHMENT_UNREADABLE")`, outros erros ⇒ lança; `materializeTicketIntoSpecTree` ganhou `errorKind` (aditivo, `services/tickets.ts`); marcador só quando o passo concluiu | `.m.` > M-05 (transitório de disco: 500, sem marcador `code`, repetição retoma e conclui; anexo ilegível: 422 e ticket reaberto) e M-12 git (remote inalcançável: 500 sem vazar `Basic`/token; repositório inexistente sem cópia: 422 `CODE_BASE_UNAVAILABLE`; com cópia: cai em `disk-copy` e registra o erro) | corrigido |
| M-06 | `services/productLifecycle.ts`: `materializing` em `IN_PROGRESS`; o agregado exclui tentativa de evolução `failed`/`archived` com irmão vivo no mesmo `(parent, version)`; recompute no `failTerminal` e no `cleanExpiredClaim` | `.m.` > M-06 (retry aceito ⇒ `accepted`; `accepted`+`materializing` ⇒ `partially_accepted`; `failTerminal` recomputa) | corrigido (ressalva em §3) |
| M-07 | `routes/projects.ts` (legado, `TICKET_TRANSITIONS=on`): promoção com `WHERE status='open'` e evento `open→promoted` (`reason='evolve_legacy'`); CAS perdido registra `extra.ticket_promotion_conflict`; `cleanExpiredClaim` grava `promoted→open` (`claim_expired_no_effects`); `DELETE /api/tickets/:id` apaga com `WHERE id=$1 AND status='open'` e confere `rowCount` (só essa função de `routes/tickets.ts` foi tocada) | `.m.` > M-07 (3 casos, incluindo o CAS contra `rejected`); `evolveReconciler.pg.integration.test.ts` > "M-07" (evento no Q1); `routes/tickets.test.ts` > DELETE com CAS perdido ⇒ 409 | corrigido |
| M-09 | `services/evolutionUniqueness.ts`: o DDL roda numa sessão dedicada com `lock_timeout='3s'` e `statement_timeout='60s'`; estouro loga `evolution_uniqueness_lock_timeout`, soma `lockTimeouts` e o boot segue (Q5 acusa o índice ausente) | `evolutionUniqueness.pg.integration.test.ts` > "M-09" (tabela travada em `ROW EXCLUSIVE`: 4 timeouts, 12 s no total, sessão volta limpa ao pool, depois cria tudo) | corrigido |
| M-10 | `testing/evolvePg.ts` `createScratchDb`: `pool.on('error')`, `pool.end()`, espera `pg_stat_activity` zerar e `DROP DATABASE` sem `FORCE` | `evolutionUniqueness.pg.integration` 10 execuções seguidas, exit 0 e 0 ocorrências de `57P01` (§4) | corrigido |
| M-11 | `finalize` com CAS conjunto (`EXISTS` do ticket `promoted` apontando para o filho); falha ⇒ `TerminalFailure` `TICKET_REJECTED` (ou `TICKET_NOT_PROMOTED`); a retomada também confere o pedido no início (nenhum passo roda para pedido recusado); a decisão humana não é desfeita | `.m.` > M-11 (recusa no meio do passo: 422 e ticket segue `rejected`; crash+recusa+lease vencido: retomada falha logo, 0 passos) | corrigido |
| M-12 | novo `projects.evolve.claim.m.pg.integration.test.ts`: laço dos 18 pontos de crash com `PROJECT_FILES_ROOT` e `apps/` semeado (disk-copy real); git real contra remote local (`file://`, seam `remoteUrl`): fetch, `checkout -B`, `reset --hard` e retomada após edição local; passo longo/lease; `POST /api/specs` 409 `VERSION_CONFLICT` pela rota | os próprios testes (38 + 3 do M-07 neste arquivo) | corrigido |
| M-15 | reconciliador: `on` exige `PROJECT_FILES_ROOT` e `UPLOAD_DIR` existentes (`reconcilerDiskProblems`), senão rebaixa para `shadow` e grava o achado `reconciler_disk_unverifiable` (some quando corrigido); `runStep` grava `steps._started` antes do primeiro efeito em disco | `evolveReconciler.pg.integration.test.ts` > "M-15"; `.m.` > M-15 (crash antes do 1º passo: `steps` vazio; dentro do passo: `_started`); os 18 pontos de crash exigem `_started` | corrigido |
| M-21 | `respondExisting`: replay de filho finalizado há menos de 15 min recomputa o lifecycle | `.m.` > "M-21" | corrigido |
| M-22 | job do reconciliador usa o namespace de lock 7342 (`RECONCILER_LOCK_NS`) | `evolveReconciler.pg.integration.test.ts` > "M-22" (lock `(7341,0)` segurado não bloqueia o job) e o teste de concorrência existente | corrigido |
| M-23 | `resolveBudgetAnchor`: HEAD sem orçamento herda o dono do ancestral mais próximo com orçamento (≤ 8 níveis), no preflight e no claim; sem nenhum, 402 `BUDGET_MISSING` com mensagem de linhagem mista orientando o que fazer | `.m.` > M-23 (2 casos) | corrigido |

## 2. Decisões

**M-02-b — "byte-idêntico com `off`" para a corrida do `/evolve` legado.** Foram mantidos os índices parciais de unicidade, criados no boot independentemente de `EVOLVE_CLAIM`. Motivo: o que eles impedem é a gravação de duas versões vivas com o mesmo `(pai, número)` e de dois filhos de evolução vivos do mesmo pai, que é corrupção de dados, não comportamento desejado; ligar os índices a uma flag própria deixaria o defeito reproduzível por padrão. Consequência registrada: **com a flag `off`, a corrida do `/evolve` legado passa a responder 409 `EVOLUTION_IN_FLIGHT` em vez de criar versão duplicada** (1× 201 e o resto 409, teste "rede de segurança … flag off"). Fora de corrida o corpo e o `extra` continuam idênticos (`[F1-off-golden]`). O comentário de `routes/projects.ts` que dizia "nada muda" foi reescrito com essa exceção. O 409 determinístico do `POST /api/specs` (M-02-a) era o outro efeito dos índices e foi eliminado na raiz (numeração por linhagem). Rollback operacional: `DROP INDEX IF EXISTS <nome>` (lista em `UNIQUENESS_INDEXES`).

**M-05 — o que é "transitório".** Lista de erros permanentes de git (`PERMANENT_GIT_ERROR`): repositório inexistente, autenticação recusada, 401/403/404, ref inexistente, git ausente. Todo o resto (timeout, conexão, DNS, disco, banco) é transitório por padrão: a escolha segura é repetir. Erro permanente de git com cópia no disco mantém o fallback `disk-copy` histórico; sem cópia, falha terminal. Mensagens de git são redigidas (`Basic …`, `x-access-token:…`) antes de entrar em exceção ou log; o M-01 em si (token no argv) fica com a g-g2.

**M-11 — qual alternativa.** CAS conjunto no `finalize` com `TICKET_REJECTED`, mais conferência no início da retomada. Não foi recusada a transição `promoted→rejected` (isso mexeria em `routes/tickets.ts`, da g-g2).

**M-06 — fronteira da exclusão.** Só tentativas de evolução (`extra.evolution='true'`) com irmão vivo no mesmo `(pai, versão)` saem do agregado, como pedido.

## 3. Não resolvido / ressalvas

- **Subprocesso git não abortável (M-04):** o heartbeat mantém o lease e o aborto acontece entre operações, mas um `git fetch` já em curso termina. Abortá-lo exige `signal` em `gitLinkProjectFolder`/`fetchAndResetBranch` (`githubPush.ts`, g-g2).
- **Falha terminal sem retry ainda deixa o produto `failed` (M-06):** como a revisão pediu, só a tentativa superada sai do agregado. Uma tentativa `failed` sem nova tentativa continua marcando o produto `failed` até o retry ou a exclusão. Se o desejo for tratar qualquer `failed` de evolução como "tentativa" (produto continua `accepted`), é uma decisão de produto a tomar.
- **Erro desconhecido de git é tratado como transitório:** um erro permanente fora da lista repete indefinidamente (500 a cada pedido). O Q1 do reconciliador não o acusa (o filho tem passos). Calibrar a lista com dados reais.
- **Achado de rebaixamento do reconciliador não notifica por e-mail:** o rebaixamento para `shadow` torna o modo efetivo `shadow`, e a notificação só ocorre em `on`; fica no log, na tabela e em `GET /api/admin/evolve-reconciler/findings`.
- **Comportamento novo, deliberado, no claim com `EVOLVE_CLAIM=on`:** falhas transitórias do passo `ticket` (inclusive com `ATTACHMENTS_STRICT=off`) agora lançam em vez de gravar `error` no marcador; é o pedido do M-05.
- Não executado: suíte Python do orquestrador (nenhum arquivo Python tocado); GitHub real (o git foi exercitado contra remote local); produção.
- Fora do meu escopo e intocados: M-01, M-03, M-08, M-13, M-14, M-16 a M-20, M-24.

## 4. Execução real

Postgres efêmero `pgvector/pgvector:pg16` na porta 55432 (as suítes de porta fixa exigem 55432), migrations aplicadas com `scripts/apply-migrations-test.ts` até a 145, contêiner derrubado ao final.

```
ANTES (base 58aa1ce, PG 55432):
  npx vitest run → Test Files 210 passed (210) · Tests 3695 passed | 1 skipped (3696) · Errors 2
  (os 2 "Errors" são o flake 57P01 do createScratchDb, M-10)

DEPOIS (evo/g1):
  npx vitest run → Test Files 211 passed (211) · Tests 3743 passed | 1 skipped (3744) · sem Errors
  npx tsc --noEmit → exit 0

M-10: evolutionUniqueness.pg.integration, 10 execuções seguidas → exit 0 nas 10, 11/11 testes, 0 ocorrências de 57P01
Estabilidade: 3 execuções de (claim.m + claim + reconciliador) → 101/101 nas três

Mutações (o teste detecta o defeito antigo):
  heartbeat desligado → "passo mais longo que o lease" falha (leaseValid:false)
  failTerminal sem CAS de dono → "failTerminal só vale para quem é o dono" falha (esperado 409, veio 422)
  createProjectFromSpec antigo → "M-02-a" falha (409 VERSION_CONFLICT determinístico em v3)
```

Evidências dos novos testes (saída real):

```
[N-m04-heartbeat]      {"final":201,"leaseDuranteOPasso":{"leaseValid":true},"concorrente":{"status":409,"code":"MATERIALIZATION_IN_PROGRESS"}}
[N-m04-lease-perdido]  {"status":409,"filho":"materializing","dono":"intruder","passos":["_started","spec_tree"]}
[N-m04-ensureLease]    {"status":409,"arquivoDoOutroPreservado":true}
[N-m04-failTerminal-cas] {"status":409,"filho":"materializing","ticket":"promoted"}
[N-m05-transitorio]    {"status":500,"code":"MATERIALIZATION_FAILED","passos":["_started","spec_tree"]}
[N-m05-permanente]     {"status":422,"code":"ATTACHMENT_UNREADABLE","filho":"failed","ticket":"open"}
[N-m11-finalize]       {"status":422,"code":"TICKET_REJECTED","filho":"failed","ticket":"rejected"}
[N-m12-git-retomada]   {"status":200,"fonte":"git-clone","appJs":"export const v = 1;","branch":"evolution/v2"}
[N-m12-git-transitorio]{"status":500,"code":"MATERIALIZATION_FAILED","passos":["_started","spec_tree"]}
[N-m12-git-permanente] {"status":422,"code":"CODE_BASE_UNAVAILABLE"}
[N-m07-legado-cas]     {"status":201,"ticket":"rejected","eventos":0,"conflito":true}
[N-m21-replay]         {"status":200,"replayed":true,"lifecycle":"partially_accepted"}
[F1-ddl-lock-timeout]  {"ms":12025,"criados":["uq_tickets_child_live"],"erros":4,"lockTimeouts":4}
[F1-specs-profundidade-3] {"v3":{"status":200,"version":4},"v2":{"status":200,"version":5},"v1":{"status":200,"version":6}}
[F1-specs-rota-409]    {"codes":[200,409],"code":"VERSION_CONFLICT"}
```

## 5. Commits (branch `evo/g1`)

```
2e24424 test(evolve): createScratchDb sem flake 57P01 (M-10)
f3768fe fix(evolve): versao pela linhagem inteira em POST /api/specs e teto de lock no DDL dos indices (M-02-a, M-09, M-12)
0207eb0 fix(evolve): CAS no DELETE e na promocao legada, evento no reconciliador, disco verificavel e lock proprio (M-06, M-07, M-15, M-22)
bcff43c fix(evolve): heartbeat do lease, classificacao de erros, CAS de dono e de pedido no motor do claim (M-04, M-05, M-11, M-12, M-15, M-21, M-23)
(+ commits dos testes do M-07 legado e deste relatório)
```

Arquivos de produção alterados: `services/evolveClaim.ts`, `services/evolutionUniqueness.ts`, `services/lineage.ts`, `services/projectCreation.ts`, `services/productLifecycle.ts`, `services/evolveReconciler.ts`, `services/tickets.ts` (campo `errorKind`, aditivo), `routes/projects.ts` (comentário e promoção legada), `routes/tickets.ts` (somente o `DELETE`). Nenhum dos arquivos reservados à g-g2 foi editado.
