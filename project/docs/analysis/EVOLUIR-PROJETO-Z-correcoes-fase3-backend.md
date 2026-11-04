> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO Z — Correções do backend após a revisão adversarial da Fase 3 (frente g-l1)

**Data:** 2026-11-04 · **Repositório:** `zentriz-genesis` · **Branch:** `evo/l1` (a partir da `dev`, sobre o commit `bd56caf` da revisão Y) · **Escopo:** só `applications/services/api-node`. O portal e o teste de contrato dos erros e das rotas de spec são da frente g-l2. Sem produção, sem push, sem deploy; o Guard (`llmGuard.ts`) não foi tocado; nenhuma migration nova.

## 1. Resultado

| Item | Antes (dev) | Depois (`evo/l1`) |
|---|---|---|
| `vitest run` completo (PG efêmero na 55432) | 235 arquivos · 3990 passaram · 1 pulado | **236 arquivos · 4013 passaram · 1 pulado** |
| `tsc --noEmit` | limpo | limpo |
| Suíte de contrato (`cards.contract.pg…`) | verde | verde, **fixtures não regravadas** |
| Testes novos | — | 23 em `src/routes/cards.fase3.correcoes.pg.integration.test.ts` (+23 no total; 0 removidos) |

Commits locais (`evo/l1`): `5cd18b9` (ids canônicos, rascunho fora de DELETE/stop/PATCH, USE_CARDS, chaves de contexto), `709b9ca` (ready atômico, colisões com o HEAD, papéis, anexos, revalidação, Guard→card), `58ac742` (testes). Este relatório vai em commit próprio.

## 2. Tabela achado × correção × teste × estado

| ID | Correção | Teste | Estado |
|---|---|---|---|
| **Y-01** (bloqueante) | `markCardReady` (`services/cardService.ts`) lê a spec do rascunho **uma vez** (`computeCurrentSpecHash` devolve o conteúdo); o gate (`evaluateCardKindGate` agora aceita `files` pré-lidos) e o hash do carimbo usam esse mesmo conteúdo. Carimbo + `refining→ready` + parada dos laços autônomos (Y-23) na **mesma transação**, com `SELECT … FOR UPDATE` do ticket; antes de gravar a spec e os anexos são relidos e, se o hash diferir, desiste (`CARD_SPEC_CHANGED`, 409). Depois do COMMIT há uma conferência final: escrita concorrente que terminou depois derruba o card a `refining` (motivo `spec_changed_during_validate`). `noteCardSpecWrite` (chamado pelos escritores depois de gravar) também derruba `ready→refining` e descarta o carimbo (`spec_write_after_ready`). Na promoção (`evolveClaim.verifyCardStampUnderLock`) o claim reavalia, dentro do lock, carimbo, hash, anexos, gate por tipo e colisões; se falhar o card volta a `refining`. | `Y-01 (P4): 50× ready concorrente com o DELETE do RFC` (3 execuções seguidas, 150 corridas, invariante: `ready` ⇒ RFC existe e carimbo = hash atual); dois testes determinísticos com ganchos (`cardReadyTestHooks`) que reproduzem a janela exata da sonda P4 (entre gate/hash e carimbo; entre COMMIT e conferência final); escritor atrasado; carimbo forjado sobre árvore sem RFC (10×) ⇒ 409 `EVOLUTION_RFC_REQUIRED`, nenhum filho | **Resolvido** (ver risco residual em §5) |
| **Y-02** | Recusa de qualquer arquivo do rascunho cujo `(rel_dir, filename)` (sem diferenciar caixa) já exista no HEAD: na ESCRITA (`cardSpecWriteBlock`, 409 `CARD_PATH_COLLIDES_WITH_BASE`), no `ready`, no claim da promoção e, como defesa final, no passo `card_spec` (`TerminalFailure CARD_PATH_COLLIDES_WITH_BASE`) | `Y-02 (P6)`: escrita 409, ready 409, promoção 201 com ADR novo, **árvore do FILHO** com `ADR-001` e `RFC-0004` byte a byte iguais ao HEAD e `spec_origin` só nos arquivos do card; `Y-02` claim com carimbo regravado ⇒ 409, sem filho | **Resolvido** |
| **Y-03** | Portal (g-l2) | — | Fora do escopo |
| **Y-04** | `lib/uuid.ts` (`toCanonicalUuid`, `isCanonicalUuid`); `loadCardDraftInfo` normaliza o id, consulta `WHERE id = $1::uuid` e devolve sempre o id lido do banco; hook `INVALID_ID` (400) para `:id` de `/api/projects/…` e `projectId` do corpo/query em `projects`, `specFiles`, `specChat`, `specAutonomy`, `evolutionPlan`, `pipeline`, `specSplit`, `connectDeclaration` (registrado depois do `authMiddleware`); `loadCard`/`loadBaseSpecForDraft` idem | `Y-04 (P1)`: 3 formas não canônicas × 8 escritores = 24 respostas 400; maiúsculas ⇒ mesma trava 409; guarda chamada com texto cru resolve a linha; árvore intacta, 0 chamadas ao agente, card segue `ready` | **Resolvido** (inventário em §6; limite: campos de formulário multipart não passam pelo hook, mas as guardas já canonicalizam) |
| **Y-05** | `DELETE /api/projects/:id` (os dois modos) ⇒ 409 `USE_CARD_DELETE` apontando `DELETE /api/cards/:id`. Também `POST /stop` e `PATCH /api/projects/:id` com `status` em `card_draft` ⇒ 409 (`CARD_OPERATION_UNSUPPORTED`), pois eram as outras portas que mudavam o status fora da máquina | `Y-05 (P2)`: 8 estados do card × (DELETE legado, DELETE guardado, stop, PATCH) = 32 respostas 409; projeto segue `card_draft` e vinculado; `DELETE /api/cards/:id` em `draft` continua 204 | **Resolvido** |
| **Y-06** | Matriz em §3. `denyOperate` em promover, rejeitar, retomar, revalidar, reabrir e excluir | `Y-06`: user de outro autor negado nos 6; autor user opera o próprio; tenant_admin de outro autor promove (201); zentriz_admin rejeita; conta de gestão não cria | **Resolvido** (decisão sua, reversível) |
| **Y-07** | `cardAttachmentsSnapshot`: `ready` recusa conversão `queued/pending/running` (409 `CARD_ATTACHMENT_CONVERSION_PENDING`, lista `pending`); o carimbo ganha `attachments_hash` (id, sha, estado da conversão, derivado) conferido na promoção; `syncCardAfterConversion` (chamado pela fila quando uma conversão termina fora da drenagem inline) rematerializa o derivado no rascunho e, se `ready`, devolve a `refining` (`attachment_converted`) | `Y-07` (2 testes): pending/running ⇒ 409; `empty` ⇒ 200 com `attachments_hash`; mudança depois ⇒ promoção 409 e `refining`; conversão tardia ⇒ `reopened`, carimbo caído, derivado na árvore do rascunho | **Resolvido** |
| **Y-08** | Planner: `existingRfcs`/`existingAdrs` e os pisos de numeração (`nextRfcSeq`, `nextAdrSeq`, `nextRfcNumber`) somam a árvore do HEAD à do rascunho; `applyEvolutionPlan` não grava arquivo que colide com o HEAD (devolve `skipped` com aviso) | `Y-08`: `existingAdrs` traz o `ADR-001` do HEAD, `nextAdrSeq ≥ 2`, `nextRfcSeq ≥ 6`; piso forçado a 1 ⇒ `skipped` e HEAD intacto | **Resolvido** |
| **Y-09** | `CARD_BASE_CONTEXT_CHARS` e `CARD_BASE_SPEC_MAX_BYTES` com `adminOnly: true`; faixa do contexto cai para 1 000–200 000 (padrão 14 000 sem a chave). Override antigo de 400 000 gravado por tenant passa a ser ignorado (fora da faixa ⇒ volta ao padrão) | `Y-09`: tenant_admin 403 `ADMIN_ONLY_KEY` nas duas chaves; zentriz_admin 400 `OUT_OF_RANGE` acima de 200 000 e 200 em 200 000; 400 000 legado ignorado | **Resolvido** (o teto padrão de 60 000 sugerido ficou como 14 000 sem a chave e 200 000 máximo para o admin) |
| **Y-10** (backend) | `/evolve` sem `ticketId` com `CARDS_BANCADA` ligada ⇒ 409 `USE_CARDS` | `Y-10`: tenant com a flag 409; tenant sem a flag segue o caminho histórico (200/201) | **Resolvido** (a parte do portal é da g-l2) |
| **Y-13** | Sem clone e HEAD que andou: veredito `stale`, razão `NEEDS_HUMAN_REVIEW` (warning) acrescentada quando ainda não existe, e o bloqueador `GLOBS_UNVERIFIED` na jornada (persistido em `extra.card_revalidation`), limpo quando a revalidação seguinte dá `ok`. Com repositório, `listRepoTree(..., { ref })` lê `git ls-tree -r --name-only <evolution_head_sha>` (ref só se for SHA hexadecimal; falha ⇒ cópia de trabalho, `source` informa) | `Y-13` (2 testes): stale + razões + bloqueador + ação `revalidate` + limpeza; repositório git real em `/tmp` (árvore do commit ≠ cópia de trabalho; `--output=…` e SHA inexistente caem na cópia) | **Resolvido** (ver §4: `needsHumanReview` não virou campo novo da resposta) |
| **Y-14** | `routes/llmGuard.ts` (rotas internas do Guard, ponto onde o pipeline fala com ele) agenda `syncCardForChildProject` (throttle de 15 s por projeto) depois de preflight negado por orçamento e depois de `record`; `llmGuard.ts` intacto. O GET da jornada continua alinhando o card (efeito colateral documentado abaixo) | `Y-14`: card `in_factory`, Guard para o filho, preflight negado `BUDGET_PAUSED` ⇒ card `blocked` com `budget:BUDGET_PAUSED` e ator `guard`, sem ninguém consultar a jornada | **Resolvido** |
| **Y-15** (parte api-node) | As sondas P1, P2, P4, P5 e P6 viraram testes (acima). O E2E contra a api real é da g-l2 | — | Parcial por escopo |
| **Y-16** | UUID canônico nos parâmetros: `productGuard`, `loadCard`, `attachmentId` ⇒ 404 limpo, sem mensagem do Postgres | `Y-16`: 5 URLs malformadas ⇒ 404, corpo sem `22P02`/`uuid` | **Resolvido** |
| **Y-17** | Pré-checagem do `runEvolveWithClaim` e o `claim` mapeiam `ticket.status ≠ open` do **card** para 409 `CARD_NOT_READY` com o estado real | `Y-17 (P5)`: 6 rodadas promote × reject, só `CARD_NOT_READY` (6×), nunca `TICKET_ALREADY_PROMOTED` | **Resolvido** |
| **Y-21** | Token de serviço (`svc`) recebe 403 em toda rota de card (leitura e mutação). Não há leitor de `/api/cards` no runner, no orquestrador nem nos agentes (`rg` em `applications/` sem o portal) | `Y-21`: 9 rotas ⇒ 403, card intacto | **Resolvido** |
| **Y-22** | Lista de arquivos do bloco com teto (`CARD_BASE_FILE_LIST_MAX_CHARS` = 4 000 e no máximo ¼ do orçamento), com marca de omitidos; cabeçalho de cada arquivo entra na conta do orçamento | `Y-22`: 400 arquivos, orçamento 6 000 ⇒ linha da lista ≤ 4 200 e bloco ≤ 6 600 | **Resolvido** |
| **Y-23** | Na transação do `ready`, runs de `spec_autonomy_runs` do rascunho em `pending/cto_running/applying/validating` vão a `stalled` | `Y-01 … laço autônomo` | **Resolvido** (a rodada já em voo não é abortada; ver §5) |
| Y-11, Y-12, Y-18, Y-19, Y-20 | Portal / E2E | — | Fora do escopo (g-l2) |

## 3. Decisões

**Matriz de papéis (Y-06, decisão sua, reversível).** Implementada em `routes/cards.ts`:

| Ação | Quem pode |
|---|---|
| Criar, editar texto, anexar, refinar, validar (`ready`) | `user` ou acima. Conta de gestão (`zentriz_admin`) e token de serviço **não** criam nem editam (regra anterior mantida) |
| Promover, rejeitar, retomar, revalidar, reabrir, excluir (`draft`) | `tenant_admin`, `zentriz_admin` ou o **autor** do card (`tickets.created_by`) |
| Qualquer rota de card com token de serviço (`svc`) | Ninguém (403), nem leitura (Y-21) |

Escolhas minhas dentro da sua matriz, para você rever: `ready` e `refine` ficaram no nível "user ou acima" (validar não gasta orçamento nem materializa versão); `delete` entrou no grupo de operação (autor ou administrador); `zentriz_admin` passou a poder operar o ciclo (antes a conta de gestão era recusada em tudo, o que contradizia a matriz pedida). Para reverter, basta trocar `denyOperate` por `denyMutation` nas rotas. O código novo é `CARD_ACTION_NOT_ALLOWED` (403).

**Janela residual aceita no Y-01.** Os escritores de spec não seguram nenhum lock durante a escrita, então não é possível excluir por completo uma escrita que passou pela guarda antes do `ready`. Em vez de serializar os 12 escritores, o desenho garante a invariante por três camadas: leitura única + releitura sob lock do ticket; conferência pós-COMMIT; `noteCardSpecWrite` derrubando `ready` quando o escritor atrasado termina; e, no pior caso, a promoção reavalia tudo dentro do lock e recusa.

**Ganchos de teste.** `cardReadyTestHooks` (`afterSnapshot`, `afterCommit`) existe só para reproduzir a janela da sonda P4 de forma determinística; ficam vazios em produção.

## 4. Mudanças de contrato (para a g-l2 e para o portal)

Nenhuma fixture foi regravada: a suíte de contrato continua verde com as fixtures atuais, porque as respostas cobertas por elas não mudaram.

1. **Novos códigos de erro** (tabela `cardErrors.ts`, `userMessage` incluso): `INVALID_ID` (400), `CARD_ACTION_NOT_ALLOWED` (403), `USE_CARD_DELETE` (409), `USE_CARDS` (409), `CARD_PATH_COLLIDES_WITH_BASE` (409), `CARD_SPEC_CHANGED` (409), `CARD_ATTACHMENT_CONVERSION_PENDING` (409) e `GLOBS_UNVERIFIED` (bloqueador da jornada). **Ação pendente na integração:** rodar `npm run contract:gen` para regravar `__contract__/error-codes.json` (o teste só regrava esse arquivo no modo `CONTRACT_GEN=1`); não fiz isso para não colidir com a g-l2 em arquivos do portal.
2. **`POST /api/cards/:id/ready`** ganha respostas 409: `CARD_ATTACHMENT_CONVERSION_PENDING` (`pending: [{id, filename, state}]`), `CARD_PATH_COLLIDES_WITH_BASE` (`paths: string[]`) e `CARD_SPEC_CHANGED`. O 200 pode agora ser seguido de um card em `refining` se uma escrita tardia chegar (o portal já relê o card).
3. **`POST /api/cards/:id/promote`** pode responder 409 `EVOLUTION_RFC_REQUIRED`/`EVOLUTION_RFC_INVALID`/`CARD_KIND_*` (gate reavaliado no lock), `CARD_PATH_COLLIDES_WITH_BASE` ou `CARD_NOT_READY` com `state` real (inclusive `rejected`). Em todos o card volta a `refining`.
4. **`GET /api/cards/:id/journey`** pode trazer o bloqueador `GLOBS_UNVERIFIED` (ação `revalidate`). `revalidate` não ganhou campo novo: `needsHumanReview` é expresso pela razão `NEEDS_HUMAN_REVIEW` (warning) já existente no contrato.
5. **Papéis e runner:** 403 `CARD_ACTION_NOT_ALLOWED` para `user` que não é autor; `zentriz_admin` agora pode promover, rejeitar, retomar, revalidar e reabrir; token de serviço recebe 403 também nas leituras.
6. **Projetos:** `DELETE /api/projects/:id`, `POST /stop` e `PATCH` com `status` em rascunho de card ⇒ 409; id de projeto não canônico ⇒ 400 `INVALID_ID`; `/evolve` sem `ticketId` ⇒ 409 `USE_CARDS` quando a flag está ligada (o portal deve tratar `USE_CARDS` e não depender só de `capabilities`).
7. **Carimbo do rascunho** (`extra.card_ready.attachments_hash`) e `extra.card_revalidation` são internos; não aparecem nas respostas.
8. **Efeito colateral do GET da jornada (Y-14):** `GET /api/cards/:id/journey` e `POST /resume` seguem chamando `syncCardWithChild` (idempotente; pode levar `promoted→in_factory` ou `→blocked`). Agora o bloqueio por orçamento também acontece sem ninguém olhar, pelo gancho das rotas internas do Guard; a leitura da jornada deixou de ser a única porta, mas continua escrevendo. Recomendação: ligar o reconciliador (`EVOLVE_RECONCILER=on`) junto com a flag.

Testes existentes ajustados (comportamento novo e intencional): em `cards.pg…` os cards B e D/E passaram a usar `RFC-0002` e `RFC-0003`, porque o HEAD já tem o `RFC-0001` do card A e o card não reescreve mais arquivo herdado (esse é o ponto do Y-02/Y-08), e o teste ganhou a asserção do 409; em `cards.fase3…` a rodada autônoma que chega depois do `ready` agora encontra o laço já encerrado pelo próprio `ready` (Y-23), então a mensagem aceita é essa ou a da trava.

## 5. Não resolvido ou parcial, e por quê

- **Y-03, Y-11, Y-12, Y-15 (E2E), Y-18, Y-19, Y-20 e a parte portal do Y-10:** pertencem à frente g-l2.
- **Y-04, campos multipart:** o hook de `INVALID_ID` olha `:id`, `projectId` do corpo JSON e da query; um `projectId` em campo de formulário multipart não passa por ele. A proteção real (guardas canonicalizando e consultando por `::uuid`) vale para qualquer origem, e `resolveCardTarget` já exigia UUID canônico.
- **Y-01, janela de escritor atrasado:** descrita em §3. Os escritores do Chat IA e do modo autônomo gravam a spec sem chamar `noteCardSpecWrite`; para eles o que protege é o hash do carimbo conferido na promoção (como na sonda P1, que a revisão já confirmou segura nesse ponto).
- **Y-23, rodada em voo:** o `ready` encerra o laço (`stalled`) mas não aborta a chamada de LLM que já estava em andamento; se ela terminar e gravar, o hash do carimbo cai e a promoção devolve o card a `refining`. Não há efeito sobre o filho.
- **Y-09, teto de 60 000 caracteres:** em vez de um teto intermediário, o padrão sem chave é 14 000 e o máximo configurável é 200 000, só por `zentriz_admin`.
- **Não verificado:** o ramo `git ls-tree` com clone de produção (testado com repositório real em `/tmp`); o alinhamento do card pelo gancho do Guard com carga real de chamadas.

## 6. Inventário dos escritores de spec do rascunho (Y-04)

`rg` por `INSERT/UPDATE/DELETE project_spec_files` e `writeFile/unlink/rename` em `src/` (fora de testes e migrations), com o estado de cada um para `card_draft`:

| Escritor | Guarda |
|---|---|
| `routes/specFiles.ts` PUT/POST/DELETE spec-file e `spec-versions/:id/restore` | `cardWriteBlocked` (trava, escopo, colisão com HEAD) + `touchDirty→noteCardSpecWrite` + hook `INVALID_ID` |
| `routes/projects.ts` PATCH `spec-content` | `cardSpecWriteBlock` + `noteCardSpecWrite` + hook |
| `routes/specChat.ts` (Chat IA e Resolver GAPs) | `cardSpecWriteBlock` + `cardBudgetBlock` + hook |
| `services/specAutonomy.ts` (rodadas) | `specEditable` e `cardDraftWriteDenied` a cada rodada (usam a guarda canonicalizada) |
| `routes/evolutionPlan.ts` / `services/evolutionPlanner.ts` | `cardSpecWriteBlock` na rota; `upsertCardAware` (colisão com HEAD) na gravação |
| `services/cardService.ts` (criar, editar texto) e `services/tickets.ts` (materialização) | Escritores do próprio card (dentro da máquina) |
| `services/evolveClaim.ts` (`card_spec`), `evolutionAccept.ts` | Escrevem no filho, não no rascunho |
| `routes/projects.ts` (herança `/evolve`), `telegram.ts`, `projectCreation.ts`, `cardsBackfill.ts` | Criam/inserem em projetos novos ou fazem backfill; não escrevem no rascunho vivo |
| `routes/specSplit.ts`, `connectDeclaration.ts` | `cardDraftUnsupportedBlock` (409) |

## 7. Saídas reais

```
# antes (dev, base da frente)
PG_TEST_URL=postgres://postgres:test@localhost:55432/postgres npx vitest run
  Test Files  235 passed (235) · Tests  3990 passed | 1 skipped (3991)

# depois (evo/l1, HEAD 58ac742 + este relatório)
  Test Files  236 passed (236) · Tests  4013 passed | 1 skipped (4014) · 36,8 s
npx tsc --noEmit  → sem saída (0 erros)

# evidências das sondas (testes novos, 23/23 verdes)
[Z-P1] {"semHifens":[400×8],"entreChaves":[400×8],"hifensDeslocados":[400×8]}
[Z-P2] {"draft":"409/409/409/409", … , "delivered":"409/409/409/409"}      (DELETE legado/guardado/stop/PATCH)
[Z-P4-corrida] {"delete=200 ready=409 estado=refining":16,"delete=200 ready=200 estado=refining":8,"delete=409 ready=200 estado=ready":26}
[Z-P4-corrida] {"…":17,"…":6,"…":27}   [Z-P4-corrida] {"…":15,"…":11,"…":24}   (3 execuções; invariante nunca violada)
[Z-P5] {"CARD_NOT_READY":6}
[Z-P6] {"escrita":409,"ready":409,"promocao":201,"adrFilhoIntacto":true}
```

A coluna do meio do P4 (`ready=200 estado=refining`) mostra a correção funcionando: o `ready` respondeu 200, o DELETE do RFC chegou depois e o card voltou a `refining` sem carimbo. Na revisão Y o mesmo cenário terminava com `ready` e a promoção criando um filho sem RFC.

Ambiente: Postgres efêmero `pgvector/pgvector:pg16` na porta 55432 (container `l1-pg`, derrubado ao final); migrations aplicadas até a 160.
