> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Evoluir projeto na Bancada — Fase 1', tarefa 1.8: reconciliador do /evolve

Data: 2026-11-04 · Branch `evo/f4` (worktree `/home/ubuntu/workspace/current/zentriz/.worktrees/g-f4`, a partir da `dev` em `967bd8a`) · Plano [v2](../plans/EVOLUIR-PROJETO-BANCADA-plano.md) · Especificação: [H §1.5 e §7](EVOLUIR-PROJETO-H-desenho-tecnico-advisor.md) · Claim: [I](EVOLUIR-PROJETO-I-fase1-claim-indices-orcamento.md).

Sem push, sem deploy, sem produção, sem LLM. Caminhos relativos a `applications/services/api-node/`.

## 1. Estado

| Item | Estado |
|---|---|
| Detecção Q1–Q5, tabela de achados, UPSERT idempotente, limpeza segura do Q1 | **validado** em Postgres real (15 testes novos, banco descartável) |
| Endpoint `GET /api/admin/evolve-reconciler/findings` | **validado** (401/403/403/200) |
| Worker periódico | **registrado**, mas com `EVOLVE_RECONCILER=off` (padrão) nem agenda timer; **não ligado** em nenhum ambiente |
| Notificação por e-mail (SES, `OPS_NOTIFY_EMAIL`) | **escrita, não exercitada** (sem SES nos testes; `isSesConfigured()` falso ⇒ não envia nem marca `notified_at`) |
| Funcional em produção | **não** |

## 2. Mudanças (arquivo:linha)

- `src/db/migrations/145_evolve_reconciler_findings.sql` (nova, aditiva; pula a 144, reservada à outra frente): tabela `evolve_reconciler_findings` (kind, entity_hash, project_hash, ticket_hash, severity, mode, detected_at, last_seen_at, resolved_at, action_taken, action_at, notified_at, seen_count, detail JSONB), índice único `(kind, entity_hash)`. Sem `DO`, sem `;` em literais.
- `src/services/evolveReconciler.ts` (novo): `reconcilerMode` (:30, `off|shadow|on`, ausente/desconhecido ⇒ off); `loadExpiredClaims` (:89, Q1); `cleanExpiredClaim` (:125, única ação automática); detectores Q2 `detectTicketsWithoutChild` (:162), Q3 `detectChildTicketMismatch` (:180), Q4 `detectStuckInFlight` (:216), Q5 `detectMissingIndexes` (:232); `upsertFinding` (:245); `notifyNew` (:277); `runReconcilerPass` (:309); `listFindings` (:382); `startReconcilerWorker`/`stopReconcilerWorker` (:415).
- `src/routes/evolveReconciler.ts` (novo): rota somente leitura, `zentriz_admin` sem `svc`; filtros `kind`, `projectId`, `ticketId` (viram hash no servidor e não são ecoados), `open=true|false`, `limit`.
- `src/app.ts` (+2 linhas, registro da rota) e `src/index.ts` (+import, `startReconcilerWorker(() => anomalyPool)` ao lado do worker de anomalia, `stopReconcilerWorker()` nos dois sinais). Mudança mínima, nenhum arquivo da frente g-f3 tocado (`routes/tickets.ts`, `services/tickets.ts`, `promotability.ts`, rota de promoção).
- `src/services/evolveReconciler.pg.integration.test.ts` (novo, 15 testes).

## 3. Comportamento e decisões

**Flag `EVOLVE_RECONCILER`** (só env, como `ANOMALY_ALERTS`): `off` não lê nem escreve nada e não agenda timer; `shadow` detecta e grava achados (Q1 sem efeitos grava `action_taken='shadow_would_clean'`), sem limpar e sem notificar; `on` detecta, grava, limpa o Q1 sem efeitos e notifica.

**Achados** (`kind`): `claim_expired_no_effects`, `claim_expired_with_effects`, `ticket_promoted_without_child`, `child_ticket_mismatch`, `evolution_in_flight_stuck`, `uniqueness_index_missing`.

| Q | Condição | Ação |
|---|---|---|
| 1 | `status='materializing'` e `lease_until < now() - carência` (300 s). **Sem efeitos** = `steps` vazio, nenhuma linha em `project_spec_files` do filho e nenhum diretório `UPLOAD_DIR/<filho>` ou `PROJECT_FILES_ROOT/<filho>` | sem efeitos + `on`: limpa; com efeitos: só notifica (severidade `critical`, regra `notify_only_resume_by_repeating_request`) |
| 2 | ticket `promoted` com `child_project_id` nulo, filho inexistente ou `failed` (parado há mais de 300 s) | notifica |
| 3 | (a) filho cita `extra.ticket_id` mas o ticket não aponta de volta; (b) ticket `promoted/delivered` aponta para filho de evolução sem `extra.ticket_id` | notifica |
| 4 | filho de evolução em `blocked*`, `stopped`, `needs_spec_input`, `draft`, `spec_submitted` sem atividade há mais de **72 h** (padrão de H, porque esperas humanas são legítimas) | notifica |
| 5 | algum dos 5 índices de `UNIQUENESS_INDEXES` ausente em `pg_indexes` (detalhe leva os contadores `dirty/errors` da pré-checagem do boot deste processo) | notifica, `critical` |

**Limpeza (Q1)** em `cleanExpiredClaim`: transação com `lock_timeout 5s` e `pg_advisory_xact_lock(7341, hashtext(raiz))` (o mesmo lock do claim), `UPDATE projects SET status='failed', extra.materialization += {reaped_at, reason:'claim_expired_no_effects', reaped_by:'evolve_reconciler'} WHERE id AND status='materializing' AND lease vencido AND steps='{}' AND NOT EXISTS(spec files)`; se tocou 1 linha, `UPDATE tickets SET status='open', child_project_id=NULL, promoted_at=NULL WHERE child_project_id=$filho AND status='promoted'`. As condições do `WHERE` repetem a classificação, então uma retomada concorrente (lease renovado) ou passo marcado depois da detecção vira no-op. Nunca apaga projeto, ticket ou arquivo.

**Concorrência do job:** `pg_try_advisory_lock(7341, 0)` de **sessão** em cliente dedicado (H §7); quem não obtém devolve `skipped:'locked'`. Mesmo sem o lock, a limpeza é exclusiva pelo `WHERE`.

**Achados:** `UPSERT … ON CONFLICT (kind, entity_hash)`: repetição só atualiza `last_seen_at`/`seen_count`; achado ausente numa passada recebe `resolved_at` e `action_taken='condition_cleared'` (só dos detectores que rodaram sem erro); achado resolvido que reaparece é reaberto (`detected_at` renovado, `notified_at` rearmado). Limpeza executada grava o achado já resolvido com `action_taken='cleaned_claim_expired_no_effects'`.

**Sem PII:** `entity_hash`/`project_hash`/`ticket_hash` = `hashId` (sha256, 16 hex, o mesmo do alerta de anomalia); `detail` guarda só códigos, contagens, idades e nomes de passos/índices. O log estruturado `[reconciler] {...}` usa só o hash. O teste varre a tabela inteira e não acha uuid, e-mail nem título.

**Notificação:** canal existente = e-mail SES de operações (`OPS_NOTIFY_EMAIL`, padrão do `llmAnomaly`), um e-mail por passada com até 50 achados novos, só em `on`. Não decidi canal novo. **Não** escrevi no `project_dialogue` (H cogita; deixei fora para não tocar fluxo de diálogo; ver pendências).

**Intervalo:** padrão 5 min (`EVOLVE_RECONCILER_INTERVAL_MIN` no env, senão `genesis_runtime_config.EVOLVE_RECONCILER_INTERVAL_MIN` global, mín. 1 min), primeira passada 90 s após o boot. Demais parâmetros por env: `EVOLVE_RECONCILER_CLAIM_GRACE_S` (300), `EVOLVE_RECONCILER_ORPHAN_GRACE_S` (300), `EVOLVE_RECONCILER_STUCK_HOURS` (72). A chave de intervalo **não** foi semeada em `genesis_runtime_config` nem entrou em `CONFIG_KEYS` (mesma cautela de F17 para `tenant_admin`).

## 4. Saídas reais dos testes

Ambiente: `pgvector/pgvector:pg16` em 55441 (mesma instância publicada também em 55432 porque 4 suítes têm porta fixa), migrations 1→143 antes do baseline; contêiner derrubado ao final. `integration.test.ts` só passa sem `DATABASE_URL` (com ele o `seedIfEmpty` encontra o banco já povoado e o login dá 401: comportamento preexistente, não da frente).

```
ANTES  (dev 967bd8a, 143 migrations): 203 arquivos passaram (+ 4 de porta fixa) = 207 arquivos, 3613 + 25 = 3638 passed, 1 skipped · tsc limpo
DEPOIS (evo/f4, 145):                 204 arquivos passaram (+ 4)            = 208 arquivos, 3630 + 25 = 3655 passed, 1 skipped · tsc limpo
```
(+17 = 15 do reconciliador + 2 de `migrations.test.ts` pela migration nova.) O arquivo novo também passou 15/15 contra 55432.

Evidências (stdout real):
```
[L-off]            {"findingsAntes":0,"depois":0,"filho":"materializing","ticket":"promoted"}
[L-shadow]         {"achado":"claim_expired_no_effects","acao":"shadow_would_clean","filho":"materializing","ticket":"promoted"}
[L-limpeza]        {"filho":"failed","reason":"claim_expired_no_effects","ticket":"open","achados":1,"limpezas":[3,0,0]}
[L-com-efeitos]    {"intactos":3,"achados":3,"vistas":3}
[L-ticket-sem-filho] {"motivos":["child_null","child_missing","child_failed"],"recenteIgnorado":true,"reabre":true}
[L-filho-sem-ticket] {"a":"child_cites_ticket_not_linked_back","b":"ticket_points_to_child_without_ticket_id","ok":"sem achado"}
[L-preso]          {"detectados":2,"ignorados":["recente","running"]}
[L-indices]        {"ausentes":5,"criados":5,"sujos":0}
[L-concorrencia]   {"passadas":["locked","rodou"],"limpezas":1,"diretas":1}
[L-endpoint]       {"codes":[401,403,403,200],"achadosDoProjeto":1}
```
(O `limpezas:[3,0,0]` da primeira passada conta as outras fixtures de claim criadas antes no mesmo banco descartável; para o filho do teste a limpeza ocorreu uma vez e as passadas 2 e 3 não repetiram nada.)

Cobertura: `off` (pool que lança se tocado + worker sem timer); `shadow` não limpa; `on` limpa; com efeitos (passo, linha de spec, diretório em disco) intacto; lease vigente e dentro da carência ignorados; lease renovado ou passo marcado entre detecção e limpeza ⇒ no-op; Q2 nos três motivos + recente ignorado + resolve/reabre; Q3 (a) e (b); Q4 com `running` e recente ignorados; Q5 e resolução após `ensureEvolutionUniqueness`; 3 passadas sem duplicar (`seen_count`=3, `detected_at` estável); 2 reconciliadores simultâneos ⇒ 1 limpeza; lock do job segurado por outra sessão ⇒ pula; 6 limpezas diretas em paralelo ⇒ exatamente 1; sem PII; endpoint.

**Achado dos testes:** a primeira versão do teste falhou porque o env do job foi congelado antes de `seedAcceptedProduct` trocar `process.env.UPLOAD_DIR`; o job então não enxergou o diretório do filho e limpou um claim com efeitos em disco. Não é defeito do código (ele lê o env a cada passada), mas mostra que **o reconciliador depende de `UPLOAD_DIR` e `PROJECT_FILES_ROOT` apontarem para os mesmos volumes do `/evolve`**; em produção ambos vêm do mesmo env da api, mas uma api sem o volume montado classificaria como "sem efeitos" um filho cujos arquivos existem. Ver riscos.

Flake preexistente (já relatado em I): `llm.reorder.pg.integration.test.ts` (backfill 139) falhou 2 de 3 execuções das 4 suítes de porta fixa em paralelo no mesmo banco e passou sozinho (6/6) e na outra repetição (25/25). Não toca nada desta frente.

## 5. Riscos

- **Volumes:** a classificação "sem efeitos" usa `existsSync` em `UPLOAD_DIR/<filho>` e `PROJECT_FILES_ROOT/<filho>` (H §1.5). Se a api rodar sem um dos volumes montados ou com env diferente do que o `/evolve` usou, um claim com efeitos só em disco pode ser limpo. Mitigação: ligar `on` só depois de `shadow` em produção e conferir que `claim_expired_with_effects`/`no_effects` batem com a realidade; o passo `code` sem repositório real não foi exercitado (I §5).
- **Cobertura de efeitos do passo `code` (`PROJECT_FILES_ROOT/<filho>/apps`)** só é percebida pelo diretório, não por `steps.code` quando o crash ocorre no meio do clone (por isso a checagem de disco existe).
- **Carência/lease fixos:** lease de 10 min + carência 5 min ⇒ um claim abandonado só é limpo após ~15 min.
- **Q4 em 72 h** é conservador e não calibrado; esperas humanas longas geram ruído, não ação.
- **E-mail:** um e-mail por passada pode se repetir se `sendEmail` entregar e o `UPDATE notified_at` falhar (raro, sem perda).
- **Sem `card_state`:** a reabertura só usa `tickets.status` (a coluna é da Fase 2). Q6–Q8 de H §7 (divergência `card_state`, card com filho `failed/archived`, HEAD duplo) **não** foram implementados: dependem da Fase 2 ou não foram pedidos.
- **Caminho `failTerminal`/exceção recuperável** já libera o lease sozinho; o reconciliador só cobre morte de processo.

## 6. Fora de escopo / pendências

Notificação no `project_dialogue`; painel/UI dos achados; semente e `CONFIG_KEYS` para o intervalo; Q6–Q8; ligar a flag em qualquer ambiente; botão "Retomar materialização"; deploy. Migration 144 ficou reservada à frente g-f3 (se ela usar outro número, a 145 continua válida: não há dependência entre elas).
