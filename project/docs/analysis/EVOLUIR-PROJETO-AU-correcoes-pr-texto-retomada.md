> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# AU — Correções do api-node achadas na execução real 4.5b (N-6, N-8, merge sem testes, lado api-node de N-2/N-3/N-4)

Frente `evo/r2` (worktree `.worktrees/g-r2`). Origem: `EVOLUIR-PROJETO-AS-execucao-real-4-5b.md`. Escopo: só `applications/services/api-node/**` e docs; `applications/orchestrator` e `scripts/` são da `evo/r1`.

## 1. O que mudou

| Item | Correção | Onde (arquivo:linha aproximada) | Teste que falha sem a correção |
|---|---|---|---|
| **N-6** (texto do PR) | "Gates da fábrica" lista SEMPRE cinco gates: escopo, símbolos, QA, **TSK-FULL-TEST**, **baseline/P2P**, cada um passou / FALHOU / não executado, lidos de dados reais. Escopo agora compara o **diff real** de `apps/` (`git status` contra o clone) com o `files_allowed`; lockfile fora do RFC ⇒ FALHOU. FULL-TEST: `CANCELLED` ⇒ NOT_RUN; `DONE` só conta com o registro "(Claude Code): aprovada" (o aceite fecha a task como `DONE` sem executar, `projects.ts:847`). Baseline: `no_tests`/`error`/ausente ⇒ não executado, regressões ⇒ FALHOU | `services/evolutionAccept.ts` (`describeFactoryGates`, `renderGateLines`, `buildPullRequestBody`) | `evolutionAccept.test.ts`: bloco "N-6 (AU)" (5 testes) + 2 do D-13 ajustados — 7 falham sem a correção |
| **N-8** | `POST /api/projects/:id/budget/resume`: humano (admin do tenant, dono do projeto, `zentriz_admin`; svc 403), idempotente, auditado (`llm_guard_events.kind='budget_resume_manual'`). Confere a causa (só a pausa de orçamento do dono) e o saldo (mesmo critério `minNextActivityUsd`); sem saldo ⇒ 402 e nada muda; com saldo limpa a pausa, alinha cards `budget:*` e devolve `childrenToRestart` — **não religa a execução** | `services/llmGuard.ts` (`resumeBudgetPauseByHuman`), `routes/llmGuard.ts` (rota) | `budgetResume.pg.integration.test.ts` (3 testes, Postgres real) — 3 de 3 falham sem a rota |
| **Merge sem testes** | `400 CONFIRM_REQUIRED` agora traz `explanation` (o que é sem baseline / sem P2P / nenhuma regressão verificada) e a mensagem a inclui. O `confirm` é gravado ANTES do merge forçado em `extra.evolution_merge_confirmation` (quem, e-mail, quando, risco, motivo opcional `reason`) + diálogo; sem conseguir gravar ⇒ `503 AUDIT_UNAVAILABLE` e não mergeia. A trava NÃO foi removida | `routes/evolutionPlan.ts` (rota `/evolution/merge`) | `evolutionPlan.test.ts` (3 testes novos) — falham sem a correção |
| **N-3** (api-node) | `pushProjectFiles(..., { excludeForeignLockfiles })` (ligado só em `pushEvolutionToGitHub`) não publica lockfile de OUTRO gerenciador (npm+pnpm na mesma pasta: fica o rastreado no clone > `packageManager` > npm>yarn>pnpm). Dito no diálogo e no gate de escopo | `lib/evolutionScope.ts` (novo), `services/github.ts`, `services/githubPush.ts` | `evolutionScope.test.ts` (8) + `githubPush.ticketStamp.test.ts` (1) |
| **N-4** (api-node) | `no_tests` com `exit_code≠0` é dito como "executor saiu com erro" no gate de baseline e no `detail` de `blocked_no_tests`; `GET /evolution-state` expõe `factoryGates` e `merge.confirmation` | `evolutionAccept.ts`, `evolutionMerge.ts`, `evolutionPlan.ts` | `evolutionMerge.test.ts` (1), `evolutionPlan.test.ts` (1) |
| **N-2** | Sem lado no código do api-node (uid do container × FTS); documentado como pré-condição de dev no runbook §11.2 | runbook | — |

Runbook: `CARDS-BANCADA-RUNBOOK.md` (§3.1 retomada em um passo, §4.4 merge com confirmação, §10.14 consultas, tabela §11 com 402/503, §11.1 corpo do PR com cinco gates, nova §11.2 N-1..N-8). Rollout: `CARDS-BANCADA-ROLLOUT.md` nova §7.4.

## 2. Verificação

- Postgres efêmero 55440 (e 55432 para as 4 suítes de porta fixa); `npx tsc --noEmit` limpo.
- Suíte completa em 55440: 4133 passando, 26 skipped (as 4 suítes de porta fixa falham por desenho nesse banco); as de porta fixa em 55432: 55 passando em 6 arquivos (incluem reorder, role-verify, costSource, skillFeedback). Baseline informada: 4111 + 69; acréscimo líquido desta frente: 22 testes novos (8 + 1 + 5 + 3 + 3 + 1 + 1) mais 2 ajustados.
- Mutação: cada arquivo de produção revertido ao HEAD isoladamente e a suíte correspondente rodada: `evolutionAccept.ts` 7 falhas; `github.ts` 1; `evolutionPlan.ts` 4; `evolutionMerge.ts` 1; rota do `llmGuard.ts` 3 de 3. Arquivos restaurados depois.
- Portal (`genesis-web`) não foi tocado.

## 3. Riscos aceitos e limites

1. O gate de escopo por diff real depende de `apps/` ser um clone git (`git status`); fora disso cai para o resultado do checkpoint e o texto diz "diff real não conferido". Escopo vazio no RFC ⇒ não há o que comparar.
2. A exclusão de lockfile estranho só age com 2+ gerenciadores na mesma pasta; um `pnpm-lock.yaml` sozinho num repo npm sem `package-lock.json` não é provado estranho e é publicado (aparece como FALHOU no gate se estiver fora do `files_allowed`).
3. `TSK-FULL-TEST` `DONE` sem a mensagem "(Claude Code): aprovada" no diálogo é tratado como não executado (conservador): um registro de diálogo perdido rebaixa a "não executado", nunca promove a "passou".
4. A retomada de orçamento não religa o filho (`POST /run` continua explícito) por desenho: religar gasta dinheiro. O card volta a `in_factory` na hora.
5. `regressions` e `passed` da baseline são lidos do checkpoint no formato atual do runner; mudança de formato na evo/r1 rebaixa para "não executado" (fail-safe).
6. A causa de N-3 (o `/cyborg-build` gerar `pnpm-lock.yaml`), a classificação `error` do FTS (N-4/N-5), N-1 e N-2 (uid) ficam com a evo/r1 / decisão de ambiente.

Commit por caminho, sem push.
