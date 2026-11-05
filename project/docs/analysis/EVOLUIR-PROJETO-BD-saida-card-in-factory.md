> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO-BD — Saída humana do card pendurado em `promoted`/`in_factory`

Branch `evo/v1` (base `0553379`). Origem: rodada 4.5c (TK-0006/TK-0007): filho aceito, PR fechado sem merge, `PATCH {status:"rejected"}` ⇒ 409 `TICKET_INVALID_TRANSITION`, e `CARD_PREVIOUS_UNMERGED` prendia a linhagem. Procedimento operacional: `project/docs/runbooks/CARDS-BANCADA-RUNBOOK.md` §4.5. Caminhos abaixo relativos a `applications/services/api-node/src/` (portal: `applications/apps/genesis-web/`).

## 1. O que mudou

| # | Correção | Onde |
|---|---|---|
| 1 | Aresta `promoted\|in_factory → rejected` (ator `user`; papéis iguais à recusa atual: autor, `tenant_admin`, `zentriz_admin`; `zentriz_admin` continua sem promover) | `services/cardState.ts` (`CARD_TRANSITIONS`), `services/cardReject.ts`, `routes/cards.ts` (`POST /reject`), `services/cardService.ts` (`legacyPatchCard`, `PATCH /api/tickets/:id`) |
| 1 | Filho vivo e parado ARQUIVADO por CAS com `extra.card_rejected`; CAS perdido ⇒ `child_changed` e TUDO desfeito (ticket incluído) | `cardState.ts` (`childPrecondition`, bloco `archiveChild`) |
| 1 | Prova de merge fora do lock (`verifyChildPrMerged`): PR mergeado ⇒ 409 `CARD_ALREADY_DELIVERABLE`; prova inconclusiva ⇒ 409 `CARD_MERGE_UNVERIFIED` (fail-closed); filho em execução ⇒ 409 `CARD_CHILD_ACTIVE`; card `delivered` não recusa | `cardReject.ts` (`collectRejectProof`, `rejectFailureOf`), `cardState.ts` (`rejectProof`) |
| 1 | Auditoria `ticket_card_events` com motivo default `manual_reject_in_factory`; idempotente (`noop`, 1 evento) | `cardReject.ts` |
| 2 | Detector `card_pr_closed_unmerged` no reconciliador: `in_factory` + filho `accepted` + PR `closed` sem merge ⇒ `blocked` (`pr_closed_unmerged`, ator `reconciler`) + achado crítico (e-mail em `on`); `shadow` só registra (`shadow_would_block`); cliente GitHub injetável (`runReconcilerPass(pool, env, deps)`) | `evolveReconciler.ts` (`detectCardPrClosedUnmerged`), `cardDelivery.ts` (`MergeProof.prState`) |
| 2 | A sync (jornada) não reabre card `blocked` por `pr_closed_unmerged` (evita flapping) | `cardPromote.ts` (`syncCardWithChild`) |
| 3 | Linhagem após a recusa (regra abaixo) | `cardState.ts` (`restoreSupersededPredecessor`, `markChild`, `isSupersededChild`, `acceptedLikeChildSql`), `evolutionMergeWorker.ts` |
| 4 | Portal: "Recusar card" em `promoted`/`in_factory`/`blocked`, confirmação com aviso de arquivamento, rótulos PT-BR; fixtures de contrato regeneradas (`contract:gen`) | `components/cards/CardActionsBar.tsx`, `lib/cards/cardErrors.ts`, `lib/cards/__contract__/*` |
| 5 | Runbook §4.5 + mapa, matriz de papéis, tabela de erros | `project/docs/runbooks/CARDS-BANCADA-RUNBOOK.md` |

## 2. Regra de linhagem (decisão: a menor regra segura)

Alternativa descartada: mudar `resolveLineageHead` para "reviver" arquivados por supersessão. Não basta: o claim exige a base `accepted` (`evolveClaim.ts:243`) e a base arquivada responderia `CARD_BASE_STALE` para sempre. Adotada: **desfazer a supersessão na própria transação da recusa**.

- Recusar o card cujo filho `X` estava `accepted` (nunca superado) arquiva `X` com `card_rejected` e, se `X` havia supersedido `P` (`P.extra.superseded_by = X`), `P` volta a `accepted`, perde `superseded_by/at/version` e ganha `extra.superseded_reverted` (auditoria). Se `P` já tem `card_rejected`, a busca continua no pai de `P` (até 8 elos). CAS em `P`; falha ⇒ tudo desfeito.
- Recusar o card cujo filho está `archived` por supersessão (cenário v7 sob v8) só **marca** `card_rejected` (status inalterado); `isSupersededChild`/`acceptedLikeChildSql` passam a tratar a marca como "não é mais aceito-superado" (a entrega/sync não o revive; o merge worker de observação o ignora).
- Consequência sem regra especial no HEAD: `resolveLineageHead` (inalterado), herança, `previousCardUnmergedBlock` e o claim enxergam o último filho válido. Cenário do pedido: v6 entregue, v7 (card A) aceito não mergeado, v8 (card B) sobre v7. Sem recusar ⇒ `CARD_PREVIOUS_UNMERGED` (bloqueia por B). Recusar B ⇒ base v7 (bloqueia por A). Recusar A ⇒ base v6/dev, promoção permitida; ordem inversa (A, depois B) chega ao mesmo resultado.
- Cards `ready` validados antes da recusa ficam com a base antiga ⇒ `409 CARD_BASE_STALE`, resolvido por `revalidate` + `ready` (documentado no runbook).

## 3. Testes (Postgres real) e mutação

Novos: `routes/cards.rejectInFactory.pg.integration.test.ts` (12), `services/evolveReconciler.prClosedUnmerged.pg.integration.test.ts` (3, banco descartável), portal `CardDetailView.test.tsx` (+3) e `cardErrors.test.ts` (+1). Ajustados pelo contrato novo: `cardState.test.ts`, `cardState.pg.integration.test.ts` (matriz com `rejectProof`, corrida aceita `precondition_failed`), `cardsOff.regression` (allowlist de `cardReject.ts`).

Contagens: api-node `4193 passed / 26 skipped` (baseline 4178 + 15 novos) com `PG_TEST_URL` em 55440; as 4 suítes de porta fixa (`llm.reorder`, `llm.role-verify`, `costSource`, `skillFeedback`) falham em 55440 por desenho e passam em 55432 (6 arquivos, 55 testes). `tsc --noEmit` limpo. Portal: `345 passed` (baseline 341 + 4), `tsc` limpo, `next lint` só com o aviso antigo de `GraphView.tsx`, `next build` ok.

Mutações (cada uma falha os testes novos, restauradas depois): aresta removida da tabela (10 falhas); sem `restoreSupersededPredecessor` (3, os de linhagem); sem checagem `child_deliverable` (1); sem `markChild` (1, ordem inversa); detector desligado (2); sem guarda da sync (1); `shadow` agindo (1); sem exigir prova (`merge_unverified`, 2); prova "verificada" para detalhes desconhecidos (1); portal sem o botão novo (5 falhas).

## 4. Riscos e pendências

1. **PR do GitHub não é fechado** pela recusa (decisão: ação externa/humana). O humano deve fechar o PR/branch; runbook §4.5.
2. **Prova inconclusiva nega a recusa** (`no_installation`, GitHub fora, `pr_lookup_failed`): fail-closed pode deixar o humano sem saída até restabelecer a integração. Alternativa (permitir com confirmação extra) não implementada.
3. **Janela**: a prova de merge é colhida fora do lock; um merge entre a prova e o `FOR UPDATE` pode arquivar filho recém-mergeado antes de o reconciliador marcar `delivered` (a entrega depois recusa pelo `card_rejected`/`archived`). Janela de milissegundos; mitigada, não eliminada.
4. **Efeitos colaterais da supersessão não revertidos** além do status/extra do pai (ex.: `handoffMonitoring` desativa o monitoramento do pai no aceite do filho, `postMerge/handoffMonitoring.ts:98`); recusar o filho não reativa isso.
5. **Flapping controlado**: `POST /resume` num card `blocked` por `pr_closed_unmerged` com PR ainda fechado volta a `in_factory` e o reconciliador o bloqueia na passada seguinte (um evento por ciclo, decisão humana explícita).
6. `PATCH /api/tickets/:id` para card em `promoted|in_factory` agora exige autor/admin (antes, `blocked` por esse caminho já não checava papel; mantido por não ampliar o escopo).
7. Chamadas diretas a `transitionCard(... to:"rejected")` com filho aceito sem `rejectProof` passam a falhar (`merge_unverified`): quem usar fora das rotas deve colher a prova (`collectRejectProof`).
8. Não commitado/não feito: push, deploy, GitHub e containers do dev intocados.
