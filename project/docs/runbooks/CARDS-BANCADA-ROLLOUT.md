> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Plano de rollout por tenant — Cards da Bancada

**Tarefa 6.3** do [plano EVOLUIR-PROJETO-BANCADA](../plans/EVOLUIR-PROJETO-BANCADA-plano.md) (Fase 6: "Rollout por tenant: ZFactory → demais; critérios de entrada/saída; comunicação") · Estado: **rascunho para aprovação do Jean** (o aceite do plano é "aprovado pelo Jean"; nada aqui foi executado em produção) · Público: `zentriz_admin` (operador) e quem faz plantão.

Complementa o [runbook operacional](CARDS-BANCADA-RUNBOOK.md) (o que fazer quando algo quebra) e o [guia do usuário](../guides/GUIA-CARDS-BANCADA.md). Este documento responde outra pergunta: **quando e em que condições ligar, observar e desligar**. Fontes: relatórios `EVOLUIR-PROJETO-AI`, `AK`, `AN`, `AO`, `AP`, `AQ`, `AR` (em `project/docs/analysis/`), o runbook e o guia. Caminhos de código aparecem como `arquivo:linha` relativos a `applications/services/api-node/src/` (API) ou `applications/orchestrator/` (runner/agents), conforme citado nas fontes. Afirmação sem fonte está marcada como **assunção** (§9).

> **Regra de ouro.** Ligar `CARDS_BANCADA` para um tenant é uma ação de produção com efeito em dinheiro (LLM) e em repositório do cliente (PR). Só com o OK explícito do Jean, tenant por tenant, com todas as pré-condições da §2 **verificadas** (não "lembradas"). Este documento nunca autoriza ligar "para ver".

## 0. Mapa rápido

| Quero… | Vá para |
|---|---|
| Saber a ordem dos tenants | §1 |
| Saber o que provar antes de ligar | §2 |
| O passo a passo de ligar | §3 |
| O que olhar depois de ligar | §4 |
| Quando e como desligar | §5 |
| O que dizer ao tenant | §6 |
| Por que cada pré-condição existe | §7 |
| O que ainda não está provado | §8, §9 |

## 1. Ordem do rollout

| Onda | Quem | Objetivo | Só avança quando |
|---|---|---|---|
| **0 — Plataforma** | Global (nenhum tenant ligado) | Deploy das imagens, migrations 141–162, `EVOLVE_RECONCILER=shadow` | Itens P1–P8 da §2.1 verdes; nenhum card visível a ninguém |
| **1 — ZFactory** | Tenant da Zentriz (conta própria, `byoc_exempt`) | Provar o fluxo de ponta a ponta com LLM e GitHub reais, sob custo controlado, antes de qualquer cliente. É também o ambiente de homologação do plano (tarefa 4.5, `EVOLUIR-PROJETO-BANCADA-plano.md:93`) | Critérios de saída da onda 1 (§1.1) cumpridos e o Jean aprova a onda 2 |
| **2 — Demais tenants, um de cada vez** | Tenants de cliente, na ordem que o Jean definir | Ampliar sem misturar causas: um tenant novo por vez, observado antes do próximo | Critérios de saída da onda (§1.2) e OK do Jean por tenant |

**Por que ZFactory primeiro.** (a) É conta da Zentriz: o custo de LLM é nosso mesmo (`tenants.byoc_exempt`, `services/tenantLlmConfig.ts:30`), então um erro de calibração de orçamento não vira fatura de cliente. (b) A 4.5 já mostrou que o fluxo real gasta US$ 5–8 por card e expõe defeitos de qualidade (§7), que precisam ser vistos em conta própria. (c) O repositório afetado é nosso: o PR contaminado do TK-0001 na 4.5 (AP §6, R-1) ficou em repositório de teste, não de cliente.

**Fora de ordem e fora do escopo.** Tenant sem repositório na raiz do produto, produto fabricado fora do Genesis (D-E5, adiado) e produto com mais de um serviço sem decisão D-E9 (`400 SERVICE_REQUIRED`) **não entram** em nenhuma onda enquanto a pendência existir (runbook §12, §13).

### 1.1 Critérios de saída da onda 1 (ZFactory) — propostos

Os números abaixo são **assunções** (A-R1), a validar pelo Jean:

1. Os três tipos de card (Evolução, Correção, Recurso novo) percorreram o caminho real até `delivered` com **QA devolvendo veredito de verdade** e `TSK-FULL-TEST` **executado** (não `NOT_RUN`), sem violação de escopo (§7, L1 a L4). É o que a execução 4.5b deve comprovar (§7.3).
2. Pelo menos 5 cards `delivered` no tenant, com `delivered` ⇔ PR mergeado conferido em cada um (§4.3), e zero PR mergeado com especificação de teste reduzida sem justificativa.
3. Zero `GLOBAL_HOURLY_CAP`/kill switch disparado por card (§7, L6) durante 7 dias corridos.
4. Zero achado crítico novo do reconciliador causado por card (§4.4) e taxa de `blocked` (`blocked.rate`, §4.1) explicada, caso a caso.
5. Custo médio por card dentro do teto por card (`card_budget_pct`) em todos os cards, com a distribuição registrada (a amostra da 4.5 foi n=3, AP §6 R-5).

### 1.2 Critérios de saída de cada tenant de cliente — propostos (A-R1)

Mesma lista, com janela de 7 dias e mínimo de 3 cards `delivered`, mais: o `tenant_admin` do cliente confirmou por escrito que entendeu o fluxo e o custo (§6). Só então se liga o próximo tenant.

## 2. Critérios de ENTRADA

Cada critério tem **como verificar** (somente leitura) e a **fonte**. Se qualquer um falhar, **não ligue**. Convenções dos comandos:

- `$API` = URL da API do ambiente; `$ADM` = token de `zentriz_admin` (só ele liga flags e mexe no Guard); `$TENANT` = uuid do tenant; `$PRODUCT` = uuid do produto; `$ROOT` = projeto raiz (dono do orçamento) da linhagem.
- SQL: sessão de leitura (`SET default_transaction_read_only = on;`), como no runbook §10. Em produção o banco é o do runbook §10 (host de produção, container do Postgres); **o workstation de dev não é produção** (runbook §7 item 6).
- "Variável de ambiente da API": `docker exec <container-da-api> printenv NOME` no host em questão. Não imprima segredos (`printenv` só dos nomes de flag abaixo).

### 2.1 Pré-condições da plataforma (uma vez, antes da onda 1)

| # | Critério | Como verificar | Fonte |
|---|---|---|---|
| P1 | API, agents e runner nas imagens com as correções AK, AO, AQ e AR (ordem de deploy: **api → agents**; runner depois da API) | Digest do container conferido (healthy não prova código novo); rotas novas respondem (`GET $API/api/admin/runtime-config/resolved` traz a chave `rolloutFlags`; `GET $API/api/admin/llm-guard/settings` traz `advisor`) | runbook §7 itens 1–5; AR §1 (D-8, D-9) |
| P2 | Migrations 141–162 aplicadas (a 146 e as 151–159 não existem; é esperado) | `SELECT name FROM schema_migrations WHERE name >= '141' ORDER BY name;` (nome exato da coluna: conferir no esquema, **assunção**) | runbook §7; AO (162) |
| P3 | Servidor de testes do host (`full-test-server`) **no ar** e acessível pelo container do runner. Sem ele a baseline P2P não é medida e **toda evolução reprova o `TSK-FULL-TEST` por desenho** | No host: `ss -ltn \| grep 7878`; no container do runner: `curl -s -m 5 "$FULL_TEST_SERVER_URL/health"` (devolve o healthcheck; `scripts/full-test-server.py:701`). `FTS_AUTH_TOKEN` igual no servidor e no runner (o servidor recusa tudo sem ele) | AP D-4; AQ §4 (`docker-compose.yml:251-252`, `executor_bridge.py:48-53`, `full-test-server.py:707`) |
| P4 | `EVOLVE_RECONCILER=shadow` global, **≥ 3 passadas (15 min)**, achados contados (§2.3 C9) | Runbook §5, fluxo "Fluxo recomendado para ligar", e consulta §10.7 | runbook §5; AK §5 item 8; AI N2 |
| P5 | `EVOLUTION_AUTO_MERGE` e `EVOLUTION_AUTO_REDEPLOY` **desligados** (não definidos ou `off`) | `printenv EVOLUTION_AUTO_MERGE EVOLUTION_AUTO_REDEPLOY` na API; ambos vazios/off | AI §5 item 3 (N3); runbook §4.4, §8 item 4; AP §1 item 4 |
| P6 | `PROJECT_FILES_ROOT` e `UPLOAD_DIR` montados na API (senão `EVOLVE_RECONCILER=on` é rebaixado para `shadow` e gera `reconciler_disk_unverifiable`) | Consulta §10.7 do runbook: nenhum achado `reconciler_disk_unverifiable` aberto | runbook §5, §8 item 9 |
| P7 | Guard: kill switch `off`; tetos globais conhecidos (hoje US$ 12/h e US$ 30/dia na dev) e **compatíveis com a vazão de card** (§7 L6) | `GET $API/api/admin/llm-guard/settings` → `settings` e `spend.lastHourUsd` | AP §1 item 7, §4.2; runbook A14 |
| P8 | `LLM_ROLES_MODE` com o **mesmo valor** em API, agents e runner. "Advisor desligado" só vale com `off` nos três | `printenv LLM_ROLES_MODE` em cada serviço; `GET /api/admin/llm-guard/settings` → `advisor.divergent` deve ser `false` e `advisor.warnings` vazio | AR D-9; runbook A13/A13b; AP D-9 |

### 2.2 Pré-condições por tenant

| # | Critério | Como verificar | Fonte |
|---|---|---|---|
| C1 | **Repositório registrado na raiz do produto** (`project_github_repos` da **raiz** da linhagem) | `SELECT project_id, repo_full_name, default_branch FROM project_github_repos WHERE project_id = '$ROOT';` deve devolver 1 linha | AI §5 item 1; AP §1 item 1; runbook §8 item 1 |
| C2 | **GitHub App ativa** na organização do repositório, não revogada | `SELECT * FROM tenant_github_installations WHERE tenant_id = '$TENANT' AND revoked_at IS NULL;` deve devolver a instalação (consulta equivalente à da AP §1 item 1; nomes de coluna conforme a AP) | AP §1 item 1; runbook §8 item 1 |
| C3 | **Permissão "Pull requests: Read & write"** da GitHub App. **Não é consultável sem escrever** (a API da instalação não expõe permissões) | Conferir **na tela de instalação do GitHub** (organização → Settings → GitHub Apps) e registrar a captura no ticket do rollout. A prova real é o primeiro PR criado (§4.3) | AP §1 item 2 |
| C4 | `GENESIS_GITHUB_PUSH=on` | `printenv GENESIS_GITHUB_PUSH` na API (o padrão é `on`; `off` desliga branch, PR e repositório) | AP §1 item 3; runbook §8 item 2 |
| C5 | `EVOLUTION_PROMOTE_BANCADA=1` **para o tenant** (valor inteiro). Sem ela o filho do card não é promovível à fábrica (`409 NOT_ON_WORKBENCH`) | `GET $API/api/admin/runtime-config/resolved` → `rolloutFlags.EVOLUTION_PROMOTE_BANCADA` com `value` 1 e `source` do tenant | AP §1 desvio 2; runbook A6; AO M9 (`routes/pipeline.ts:144-162`) |
| C6 | `CARDS_BANCADA` será gravada com **valor INTEIRO** (`1`), via `PUT`. `'on'` gravado por SQL era **ignorado em silêncio** (`services/featureFlags.ts:65-72`); desde a AR a leitura aceita sinônimos, mas **só o `PUT` dispara o backfill** | Depois de ligar (§3): `rolloutFlags.CARDS_BANCADA.ignored` vazio e `GET $API/api/products/$PRODUCT/cards/capabilities` → `cardsBancada: true` | AP §1 desvio 1; AR D-8; runbook §11.1 |
| C7 | **Slot de LLM do tenant verificado** (LLM só pelo slot do tenant; nada de `.env`) | `GET $API/api/tenant/llm-config?tenantId=$TENANT` lista os slots e o status de verificação por papel; re-teste com `POST $API/api/tenant/llm-config/<prioridade>/test?tenantId=$TENANT` (`routes/llm.ts:510-513`). Todos os papéis usados na fábrica com status verificado | `routes/llm.ts:294,510`; `services/tenantLlmConfig.ts` (`verify_<papel>_status`); memória de projeto "LEI: LLM só por slot do tenant" |
| C8 | **Conta da Zentriz ⇒ `byoc_exempt`**; conta de cliente ⇒ **não** isenta (o cliente paga a própria fatura) | `SELECT id, name, byoc_exempt FROM tenants WHERE id = '$TENANT';`. ZFactory: `true`. Cliente: `false`, com slot com credencial própria (`hasOwnCredentials`, `services/tenantLlmConfig.ts:128-135`). Só `zentriz_admin` escreve `byoc_exempt` (`routes/tenants.ts`, `PATCH /api/tenants/:id`) | `services/tenantLlmConfig.ts:30,125-135` |
| C9 | **Reconciliador contado em `shadow`**: nenhum achado `claim_expired_*`, `evolution_publish_incomplete` ou `card_published_without_pr`; legados (`ticket_promoted_without_child`, `child_ticket_mismatch`, `evolution_in_flight_stuck`) explicados | Consulta §10.7 do runbook e `GET $API/api/admin/evolve-reconciler/findings?open=true`. Na 4.5 havia 2 `warning` legados (`evolution_in_flight_stuck`), nenhum crítico | AP §1 item 5; runbook §5 |
| C10 | **Orçamento do projeto-dono definido** (D-E10: o card usa o orçamento do dono). Sem orçamento ⇒ `402 BUDGET_MISSING` na criação do card | `GET $API/api/projects/$ROOT/budget` devolve `budgetUsd` > 0, gasto e previsão. Definir: `PUT $API/api/projects/$ROOT/budget {budgetUsd, alertStepPct}` | AP §1 desvio 3; runbook §8 item 6 |
| C11 | **`card_budget_pct` definido** (política `cost_policies`; `calibrated=false` quando gravado pelo tenant) e **Guard conferido**: kill switch `off`, tetos globais, e o teto por card (`budgetUsd × pct`) **cabe** em um card real (a 4.5 usou 34 % de US$ 30 = US$ 10,20; os cards custaram US$ 4,92 a 8,37) | `GET $API/api/cost-policies` (política do tenant e a global; o tenant nunca fica acima da global, `TENANT_POLICY_EXCEEDS_GLOBAL`); `GET $API/api/admin/llm-guard/settings` | AP §1 desvio 3, §4.1; AO M3; runbook §3.1, A9 |
| C12 | **Servidor de testes e baseline medindo para este produto**: uma execução de `/run-tests` na linha de base devolve resultado (não `Connection refused`, não `status="error"`) | Depois do primeiro card promovido (§4.2), `GET $API/api/projects/<filho>/evolution-state` → `baseline.status` diferente de `error`. Antes de ligar: P3 verde. Atenção: a suíte do **produto** pode ter testes já falhando (na 4.5, 12 em SPEC-02, AP D-5); registre o número como linha de base | AP D-4, D-5; AQ §4 (`runner.py:638-660`, `:699`) |
| C13 | **QA devolvendo envelope válido** (não `refusal`, não vazio) e `TSK-FULL-TEST` não marcado como feito sem executar | Com um card de teste (§3 passo 6): as chamadas `QA:validate_task` do ledger do filho têm `output_tokens > 0` e a task `TSK-FULL-TEST` termina `DONE` com relatório de execução, ou `CANCELLED` com `QA_REPORT_TSK-FULL-TEST.md` "Veredito: NOT_RUN". Qualquer QA com `output_tokens = 0` ⇒ pare | AQ §2, §3 (`runtime.py:421,2968`; `runner.py:3363,3404,4844`) |
| C14 | Papéis definidos: quem é `tenant_admin` (promove, mergeia) e quem são os autores. `zentriz_admin` **não** cria, não promove e não mergeia card | Lista de usuários do tenant; matriz do runbook §9 | runbook §9, A1; AP §1 item 4 (identidades) |
| C15 | Produto fabricado ao menos uma vez e **`accepted`** (D-E2) | `SELECT id, status, version_number FROM projects WHERE id = '$ROOT' OR parent_project_id = '$ROOT'...` ou, mais simples, tentar criar o card de teste: sem versão aceita ⇒ `409 NO_ACCEPTED_HEAD` | runbook §8 item 7 |
| C16 | Anexos: `ATTACHMENTS_STRICT` ligada (sem ela, anexo em card ⇒ `409 ATTACHMENTS_UNAVAILABLE`); `ATTACHMENT_CONVERSION` ligada se pdf/doc/docx devem virar `.md` | Consulta §10.11 do runbook | runbook §8 item 5 |
| C17 | Nenhum run em voo no tenant e janela quieta de deploy | `SELECT id, status FROM projects WHERE tenant_id = '$TENANT' AND status IN ('running','materializing');` vazio | AP §1 item 6; runbook §7 item 4 |
| C18 | `TASK_INHERIT_TRANSITIVE` decidida (recomendada ligada para o tenant; senão cada versão perde as tasks `TSK-INH-BE-*` herdadas) | `rolloutFlags.TASK_INHERIT_TRANSITIVE` (`PUT ... {"value":1,"tenantId":"$TENANT"}`; inteiro, nunca `"on"`). **Decisão do Jean**, não pré-condição dura | AP D-10; AQ §6 |

### 2.3 Itens que bloqueiam clientes mesmo com tudo acima verde

Não são pré-condições verificáveis por comando, mas **bloqueiam a onda 2** (o runbook §8 item 12 e §13 já os lista):

1. Cenários de caos C8–C11 e C13 do runner não executados (AI §4/§5).
2. Decisões abertas do Jean: D-E9 (serviço-alvo), D-E3 (confirmação), coluna `executed_*` em tasks, AB-07 (globs), M5 (base do orçamento fixada ou viva; assunção A10).
3. 4.5b (§7.3) e a revisão das correções AQ/AR (nenhum relatório de re-verificação independente das correções AQ e AR foi lido nesta redação).
4. Dívida de qualidade conhecida (AP D-5, D-11; AQ §8): ver §8.

## 3. Checklist de ligar (por tenant)

Modo **DO-CONFIRM**: faça a ação, depois confirme com o comando. Parar na primeira falha.

1. [ ] OK do Jean para **este tenant** registrado (data e quem).
2. [ ] P1–P8 (§2.1) verdes **no dia**.
3. [ ] C1–C4, C7–C11, C14–C17 (§2.2) verdes; guardar a saída dos comandos no ticket do rollout.
4. [ ] `EVOLUTION_PROMOTE_BANCADA=1` para o tenant: `PUT $API/api/admin/runtime-config/EVOLUTION_PROMOTE_BANCADA` com `{"value":1,"tenantId":"$TENANT"}`. Confirmar em `rolloutFlags`.
5. [ ] `CARDS_BANCADA=1` para o tenant, **só pelo `PUT`** (dispara o backfill transacional e a checagem de divergência): `PUT $API/api/admin/runtime-config/CARDS_BANCADA` com `{"value":1,"tenantId":"$TENANT"}`. Respostas: `409 CARD_DIVERGENCE` (lista divergências; nada mudou) ou `500 CARDS_BACKFILL_FAILED` ⇒ **pare**, não corrija por SQL (runbook §6, §10.10). Confirmar `cards/capabilities` → `cardsBancada: true` e `rolloutFlags.CARDS_BANCADA.ignored` vazio.
6. [ ] **Card de fumaça** com o `tenant_admin` do próprio tenant (não com `zentriz_admin`), tipo **Correção** de uma linha, no produto de menor risco: criar, gerar RFC, validar, promover. Para esta rodada, **um card por hora** (§7 L6).
7. [ ] No filho: `connect.yaml` presente (senão `409 CONNECT_MISSING` com `action`; gerar e promover de novo, ~US$ 0,07; AR D-7); `evolution-state.baseline.status` ≠ `error` (C12); QA com `output_tokens > 0` (C13).
8. [ ] No PR: título e commits com `TK-NNNN`; corpo com a seção "Gates da fábrica" sem "FALHOU" nem "não executado/sem evidência" (AR D-13); diff **só** dos arquivos de `files_allowed` do RFC e nenhuma `*.spec.*` encolhida (§7 L4).
9. [ ] Mergear o PR (humano; `tenant_admin`). Se o botão exigir `confirm:"MERGE"`, **pare e investigue**: sem baseline o merge cai em `blocked_regressions` e confirmar sem medir é o risco R-3 da AP.
10. [ ] Card `delivered` e `delivered` ⇔ PR mergeado (§4.3).
11. [ ] Só então `EVOLVE_RECONCILER=on` (se ainda estava em `shadow` e a plataforma decidiu ligar), seguindo o fluxo do runbook §5. É global, não por tenant (runbook A8): a decisão é da plataforma, não do tenant da vez.
12. [ ] Comunicar o tenant (§6) e abrir a janela de observação (§4).

## 4. Observação

Frequência proposta (A-R2): a cada card nos 3 primeiros; depois diária nos 7 dias da janela; depois semanal.

### 4.1 Métricas de card

`GET $API/api/products/$PRODUCT/cards/metrics[?since=<ISO8601>&limit=<n>]` (`routes/cards.ts:214`; mesma autorização e flag do quadro; 400 para `since`/`limit` inválidos). Campos (`services/cardMetrics.ts:24-35`):

| Campo | Para que serve no rollout | Sinal de alerta (A-R2) |
|---|---|---|
| `byState` | Quantos cards em cada estado | `blocked` ou `in_factory` crescendo sem `delivered` |
| `timeInState` | Tempo médio por estado | `in_factory` muito acima de ~20–25 min de fábrica + espera humana de merge (a 4.5 mediu 14,5–17 min de fábrica, AP §2) |
| `cost.totalUsd`, `avgUsdPerCard`, `items[]` | Custo real por card | Card acima de `card_budget_pct` do dono; média subindo entre janelas |
| `blocked.rate`, `reasons[]` (`budget`/`other`) | Taxa e causas de bloqueio | `rate` alta com `reasons.kind="other"` (falha da fábrica) |

Cuidado de leitura: `timeInState` conta estados terminais (`delivered`/`rejected`) até `now()`; a média desses cresce sem limite e **não** é sinal de problema (AN B4).

### 4.2 Guard

- `GET $API/api/admin/llm-guard/settings` → `settings` (kill switch e tetos), `spend.lastHourUsd`/`last24hUsd`/`calls24h` e `advisor` (modo da API, `callerRolesModes`, `divergent`, `spend24hUsd`, `warnings`).
- Eventos: `GET $API/api/admin/llm-guard/events` ou a consulta §10.13 do runbook. Atentar a `kill_switch_tripped`, `card_cap_reached`, `GLOBAL_HOURLY_CAP`, `GLOBAL_DAILY_CAP`, `CARD_BUDGET_CAP`, `advisor_denied_*` e `roles_mode_divergence`.
- Teto horário: antes de **promover** o próximo card, conferir `spend.lastHourUsd` (runbook A14 b).

### 4.3 Conferência por card (todo card entregue)

1. `delivered` ⇔ PR mergeado no GitHub (consulta §10.6; evento `accepted_genesis_merge` ou equivalente em `ticket_card_events`, consulta §10.3).
2. Nenhuma task não herdada sem `card_id` (consulta §10.8).
3. `executed_*` carimbado uma vez (consulta §10.9).
4. **Diff do PR**: só os arquivos de `files_allowed`; nenhuma especificação de teste reduzida; nenhum arquivo de produção alterado fora do RFC (o gate do Cyborg foi corrigido na AQ, mas **não foi visto numa execução real**; §7.3).
5. Corpo do PR: "Gates da fábrica" sem "FALHOU" nem "sem evidência".
6. Custo do card (ledger) contra o teto.

### 4.4 Reconciliador

Em `shadow` ou `on`: `GET $API/api/admin/evolve-reconciler/findings?open=true` e a consulta §10.7. Esperado em ambiente limpo: zero de `claim_expired_*`, `evolution_publish_incomplete` e `card_published_without_pr`. `card_published_without_pr` significa que o código **nunca chegou** ao repositório (push `skipped`): é falha de pré-condição C2/C3/C4, não de card (runbook §4.2). Em `on`, o e-mail por passada vai a `OPS_NOTIFY_EMAIL` (padrão `jean@zentriz.com.br`).

## 5. Critérios de SAÍDA e rollback

### 5.1 Quando desligar o tenant (gatilhos) — propostos (A-R3)

Desligar `CARDS_BANCADA` do tenant (§5.2) quando ocorrer **qualquer** um:

1. PR de card **mergeado com regressão ou escopo violado** que chegou a branch de produção do cliente.
2. `kill_switch_tripped` ou `GLOBAL_*_CAP` causado por cards do tenant, **duas vezes** na janela.
3. Achado crítico `evolution_publish_incomplete` ou `card_published_without_pr` repetido sem causa corrigível em 24 h (pré-condição C2–C4 quebrada).
4. `delivered` falso (card entregue sem PR mergeado) ou qualquer violação da invariante `delivered` ⇔ merge.
5. QA voltando a devolver `output_tokens = 0` / `refusal`, ou `TSK-FULL-TEST` marcado `DONE` sem execução (regressão dos defeitos D-2/D-3 da AP).
6. Divergência `card_state` × `status` (consulta §10.10) ou `CARD_DIVERGED` recorrente.
7. Pedido do tenant.

Use antes a ação **menor**, quando bastar: pausar a promoção de novos cards (orientar o tenant a não promover), baixar `card_budget_pct`, ou ligar o kill switch (global; só se for emergência de custo, runbook §3.1).

### 5.2 Como desligar (por tenant)

`PUT $API/api/admin/runtime-config/CARDS_BANCADA` com `{"value":0,"tenantId":"$TENANT"}` (override explícito `off`, vence o global). **Não** use `DELETE` (volta ao global e pode ligar). Desligar nunca é bloqueado. Rollback é sempre por flag; não há migration de volta (runbook §6, §7).

### 5.3 O que acontece com os cards existentes

Detalhe completo no runbook §6. Resumo operacional para a decisão de desligar:

| Estado do card | Efeito ao desligar | Ação do operador |
|---|---|---|
| `promoted` / `in_factory` / `blocked` (filho já existe) | **Continua na máquina**: `syncCardWithChild`, entrega pós-merge (`deliverCardsOfChild`) e reconciliador `on` seguem atuando; o card `in_factory` ainda é entregue quando o PR é mergeado. As rotas de card, porém, dão 404 | Deixar o filho terminar, ou rejeitar/descartar antes de desligar |
| `delivered` / `rejected` | Sem efeito (dados mantidos) | Nada |
| **`draft` / `refining` / `ready` (não promovidos) — LIMBO** | Rotas `/api/cards/*` dão 404 **e** o `/evolve` legado com o `ticketId` responde `409 USE_CARD_PROMOTE` (a checagem não consulta a flag: `routes/projects.ts:3551`, `services/cardPromote.ts:291`; linhas conforme runbook §6, com deriva menor apontada na AN B6). O trabalho de refino fica preso e invisível | **Antes de desligar:** listar (consulta §10.1) e, com o tenant, promover ou rejeitar cada um. Se já desligou e há cards no limbo, **religar a flag** destrava (backfill idempotente) |

Também ao desligar: a tela volta ao diálogo antigo "Evoluir projeto"; os detectores Q7 passam a ignorar o tenant; nada é apagado nem revertido (runbook §6).

### 5.4 Rollback de código (imagem)

Voltar a imagem anterior da API é o plano; **não há migration de volta** (as colunas novas são nulas/opcionais e nenhum leitor legado as consulta). **Assunção A5 do runbook:** a imagem antiga contra o esquema 162 **não foi testada**. Ordem de deploy e de rollback: **api primeiro, agents depois** (a rota `advisor-gate` só existe na API nova; com agents novo e API antiga o Advisor é negado, fail-closed; com API nova e agents antigo ninguém chama o gate e a política gravada não vale). Tag de rollback `rollback-<svc>:pre-<feature>` no host antes do recreate; conferir o digest; nada de rebuildar `api`/`agents` com run ou promoção em voo (runbook §7).

Migrations **141–162** são aditivas (expand). Atenção às duas que tocam o caminho quente: a **148** troca o CHECK `projects_status_check` e a **162** cria `idx_llm_ledger_project` com `CREATE INDEX` simples (não `CONCURRENTLY`), que bloqueia escritas no ledger durante a construção (AO, "Assunções e riscos aceitos"). Rode o deploy em janela quieta.

## 6. Comunicação ao tenant

Quem envia: o Jean (ou quem ele delegar); e-mail institucional pelo canal oficial, com layout e acentuação conforme as regras de e-mail da Zentriz. **Não enviar sem o OK do Jean.**

| Momento | Conteúdo mínimo |
|---|---|
| **Antes de ligar** (≥ 2 dias úteis) | O que muda (quadro de cards no lugar do diálogo "Evoluir projeto"); quem cria/promove (autor ou `tenant_admin`; a conta de gestão da Zentriz só consulta); **custo**: cada card consome o orçamento de IA do dono da versão, com teto opcional por card; PR no GitHub deles (permissão "Pull requests" exigida); janela e contato de plantão; link para o [guia](../guides/GUIA-CARDS-BANCADA.md) |
| **No dia de ligar** | Confirmação de que está ligado; como pedir ajuda (código `TK-NNNN` + mensagem exibida, guia §8) |
| **Durante a janela** | Aviso proativo se houver card bloqueado por orçamento (orientação: aumentar orçamento ou o percentual por card e **Retomar**) ou PR pendente |
| **Ao desligar** | Motivo; o que acontece com cards em andamento (§5.3); cards pré-fábrica: promover ou rejeitar antes; quando volta |
| **Fim da janela** | Resumo: cards entregues, custo médio, bloqueios e causas (de §4.1) |

Pontos que **devem** ser ditos com franqueza, porque a 4.5 mostrou limites reais: a qualidade de entrega ainda está em validação (n=3 na 4.5, sem paridade declarada, AP resumo e R-5); o cliente deve **revisar o diff do PR** antes de mergear; o Genesis não mergeia sozinho (auto-merge desligado).

## 7. Lições das execuções reais (4.5 e 4.5b)

### 7.1 O que a 4.5 mostrou (relatório AP) e o estado da correção (AQ, AR)

Execução real: tenant `e2e`, produto SPEC-02, 3 cards (Evolução, Correção, Recurso novo) até `delivered`, US$ 20,46 (AP resumo). O fluxo de estados e a rastreabilidade funcionaram; a **qualidade** não passou (AP resumo, §3). Cada lição abaixo mapeia o defeito, a correção e a pré-condição que o previne.

| # | Lição (defeito) | Evidência | Correção | Pré-condição que previne | Verificado em execução real? |
|---|---|---|---|---|---|
| **L1** | **QA nunca devolveu JSON**: 9 de 9 revisões `QA_FAIL` "Resposta sem JSON (ResponseEnvelope)". Causa-raiz: não o parser, e sim `stop_reason="refusal"` do Sonnet 5.5 provocado pela instrução universal "responda primeiro com seu raciocínio dentro de tags `<thinking>`" (QA 100 % e Dev ~43 % de respostas vazias; `output_tokens=0`) | AP D-2; AQ §2 (reproduzido ao vivo; `envelope.py:444`, `runtime.py`) | `agents/runtime.py:421` (instrução sem `<thinking>` por padrão); `:2968` recusa vira erro próprio; `runner.py:3404,4844` QA sem veredito não é revisão feita: `BLOCKED` após `MAX_QA_NO_VERDICT` | **C13** (QA com `output_tokens > 0` num card de fumaça) e **C7** (slot do tenant verificado por papel) | **Não** (só na reprodução da AQ; a 4.5b deve provar) |
| **L2** | **`TSK-FULL-TEST` ficava `DONE` sem executar nada** ("Execute manualmente o Claude Code Agent…", `runner.py:5750`); o aceite do projeto fechava a task (`api-node/src/routes/projects.ts:847-855`) | AP D-3; AQ §3 | Runner: `CANCELLED` + `QA_REPORT_TSK-FULL-TEST.md` "NOT_RUN" (`runner.py:3363`). **Resta no api-node:** impedir que o aceite/qualquer fluxo promova `CANCELLED` a `DONE` (frente `evo/q2`/api-node, AQ §8 item 1); D-13/AR faz o PR parar de afirmar "rodaram" (`evolutionAccept.ts`, `describeFactoryGates`) | **P3** (servidor de testes no ar: com ele o full-test executa) e **C13**; §4.3 item 5 (corpo do PR) | **Não** |
| **L3** | **Baseline sem servidor de testes**: `/run-tests` com `Connection refused`; "não-regressão desativada nesta run"; merge só com `confirm:"MERGE"` sem evidência (risco R-3) | AP D-4, R-3; AQ §4: nada escuta em `:7878` no dev; `full-test-server.py` é processo de **host** (unit systemd só em prod, `scripts/genesis-full-test.service.template`) | Código passou a **reprovar alto** (`runner.py:699`, `_evo_p2p_unmeasured_reason`; opt-out `EVOLUTION_P2P_REQUIRED=0`); a causa é de **ambiente** e a subida do servidor é manual | **P3** e **C12**; passo 9 do checklist (se pedir `confirm:"MERGE"`, pare) | **Não** |
| **L4** | **Cyborg fora do escopo**: no TK-0001 o PR #1 tocou 8 arquivos (esperado: `src/health/*.ts`), reduziu 4 specs de teste (−304/−96/−85/−26 linhas) e alterou 1 arquivo de produção; foi mergeado em `dev`. O gate de escopo só via as escritas do Dev | AP D-1, R-1, §3; AQ §5 | `cyborg_v3.py:1202,1221,1738` (mesmo gate do Dev, **antes de gravar**) e `runner.py:516,558` (regra "testes existentes não encolhem"). **Limites:** `evolution-state.violations` não enxerga o Cyborg (volume não montado; evidência fica em `docs/cyborg/scope_violations.json`); API de escopo indisponível ⇒ falha aberta com `logger.error` (AQ §5, §8 item 3) | §4.3 item 4 (conferir o diff do PR, **não** confiar só no painel); passo 8 do checklist | **Não** (teste de integração com a fixture do PR #1, mas sem execução real) |
| **L5** | **Flag `'on'` ignorada em silêncio**: `CARDS_BANCADA` gravada como `"on"` ⇒ `capabilities:false`, rotas 404, só `console.warn` | AP D-8, §1 desvio 1 (`services/featureFlags.ts:65-72`) | AR: leitura aceita sinônimos; `PUT` normaliza para inteiro e recusa lixo (`400 INVALID_FLAG_VALUE`); `GET .../resolved` ganhou `rolloutFlags` com `ignored[]`. **Sem backfill** quando gravada por SQL | **C6** (inteiro, via `PUT`) e passo 5 do checklist; confirmação por `rolloutFlags` | **Não** (testes de integração da AR) |
| **L6** | **Teto horário do Guard × custo de um card**: um card gasta US$ 5–8 em ~16 min contra o teto global de US$ 12/h; dois cards na mesma hora estouram `GLOBAL_HOURLY_CAP` e **ligam o kill switch para todo o Genesis**. Na 4.5 foi contornado com esperas manuais de ~48 e ~36 min | AP §2, R-2, §4.2; runbook A14 | **Nenhuma mudança de código** (dimensionamento). Orientação operacional A14: escalonar promoções, conferir `spend.lastHourUsd`, subir o teto de forma registrada em homologação | **P7**, **C11** e passo 6 do checklist (um card por hora); §4.2 | **Sim** (contornado na 4.5), sem solução estrutural |
| **L7** | **Advisor gastando em `shadow`**: US$ 3,84 (18,8 % do custo, 38 chamadas) com o Advisor dado como "desligado" (API `LLM_ROLES_MODE=on`, runner `shadow`) | AP D-9, §4.2 | AR: `advisorStatus` e evento `roles_mode_divergence`; teto legado opt-in `ADVISOR_LEGACY_CAP_USD` (padrão desligado). **Limite:** os clientes Python ainda não enviam `rolesMode`, então só o modo da API e o gasto do ledger aparecem (AR §4 item 4) | **P8** e o campo `advisor.divergent`/`spend24hUsd` do §4.2 | **Não** |

Outras lições, menores, com tratamento já descrito: o planner não gravava a compatibilidade em forma que o gate leia (D-6, corrigido na AR: seção `## Compatibilidade`; evita `blocked_compat_implicit`); o filho exigiu `connect.yaml` fora do fluxo (D-7: o gate não foi afrouxado, a ação ficou explícita; checklist passo 7); token sem `sub` dava 500 (D-12: agora 401; C14 usa o `tenant_admin`); `TASK_INHERIT_TRANSITIVE` desligada perdia tasks (D-10: C18). O Cyborg custou 54 % do TK-0001 (AP §4.2): card com muitas rodadas de correção custa bem mais que o típico (runbook A14 d).

### 7.2 Resíduos conhecidos que a pré-condição **não** elimina

D-5 (a suíte do produto base tinha 12 testes já falhando; é do produto gerado, não do Genesis); D-11 (divergência RFC×código não é detectada se o QA estiver inoperante: depende de L1 estar de fato corrigido); R-1 (o `dev` do repositório alvo da 4.5 ficou contaminado pelo PR #1 e **não foi limpo** nesta documentação: recomendação da AP é reverter 5 arquivos para `5e58abf`, decisão do Jean).

### 7.3 Execução 4.5b — **pendente da 4.5b**

O relatório da 4.5b (`EVOLUIR-PROJETO-AS-execucao-real-4-5b.md`) **não existia** em `project/docs/analysis/` no worktree desta tarefa nem em `zentriz-autonomy-suite/zentriz-genesis/project/docs/analysis/` quando este documento foi escrito (verificado). A coluna "Verificado em execução real?" da §7.1 só pode virar "Sim" quando a 4.5b comprovar, com os critérios binários do plano, que L1 a L5 e L7 deixaram de ocorrer. **Ação:** ao chegar o relatório AS, atualizar a §7.1 (coluna e correções), a §1.1 e a §8, e só então pedir o OK da onda 1.

## 8. Lacunas

1. **4.5b não incorporada** (§7.3). Sem ela, as correções AQ e AR estão provadas por testes (mutação: 16 de 19 e 19 de 19 testes novos falham sem a correção, AQ §7, AR §2), **não** por execução real com LLM e GitHub.
2. **Sem re-verificação independente** das correções AQ e AR nos relatórios lidos (a AI revisou a Fase 4, a AN o Guard; não há relatório equivalente para AQ/AR).
3. **Servidor de testes do host** (P3): a subida é processo manual no dev; em produção existe unit systemd (`scripts/genesis-full-test.service.template`), mas **não foi verificado** aqui se está instalado e ativo no host de produção (3.220.66.113 conforme runbook §10). Sem ele, toda evolução reprova o `TSK-FULL-TEST` (AQ §4).
4. **API de escopo do Cyborg** é fail-open (AQ §5) e `evolution-state.violations` não enxerga o Cyborg: a defesa efetiva é a conferência do diff (§4.3 item 4).
5. **Caos C8–C11 e C13** do runner (AI §4/§5) e demais pendências do runbook §13.
6. **Decisões do Jean pendentes**: D-E9, D-E3, `executed_*` em tasks, AB-07, M5/A10; e a aprovação deste plano.
7. **Permissão de PR da GitHub App** é verificável só na tela do GitHub ou no primeiro PR (C3).
8. **ZFactory como tenant**: o repositório de documentos lido **não registra o uuid** do tenant ZFactory nem a lista de produtos candidatos ao piloto; a 4.5 rodou no tenant `e2e` (AP). Preencher na execução da onda 1.
9. **Baixas não tratadas** (runbook §13 item 3: B-1, B-2, B-4..B-6, B-d; AN B3 `author` com e-mail em respostas do Guard).
10. **`CREATE INDEX` da 162** sem `CONCURRENTLY` (§5.4).

## 9. Assunções explícitas

| Id | Assunção | Reversível por |
|---|---|---|
| **A-R1** | Os números dos critérios de saída (5 cards na onda 1, 7 dias, 3 cards por cliente, um tenant de cada vez) são **propostas** deste documento; a fonte só define a ordem ZFactory → demais (plano 6.3). | O Jean ajusta antes da aprovação |
| **A-R2** | Frequência e limiares de alerta da §4 são propostas; as fontes não definem SLO para cards. | Idem |
| **A-R3** | Os gatilhos de desligamento da §5.1 são derivados dos defeitos das fontes, não de uma política existente. | Idem |
| **A-R4** | Nomes de colunas/tabelas em SQL não citados no runbook (`schema_migrations`, `tenant_github_installations`, `tenants.byoc_exempt`) vêm da AP e do código citado; conferir no esquema antes de rodar. | Conferência prévia |
| **A-R5** | O endpoint de eventos do Guard (`GET /api/admin/llm-guard/events`) vem do cabeçalho de `routes/llmGuard.ts:11` ("GET .../events"); o caminho exato foi lido do comentário, não de um teste de rota. | Usar a consulta §10.13 do runbook |
| **A-R6** | A ZFactory é tratada como tenant `byoc_exempt` por ser conta da Zentriz (`services/tenantLlmConfig.ts:30,125`); a coluna não foi consultada em produção. | Consulta C8 |
| **A-R7** | `EVOLVE_RECONCILER=on` é decisão **de plataforma** (global, runbook A8), tomada uma vez, e não por tenant. Se o Jean preferir `shadow` durante toda a onda 1, o card só é entregue por merge via Genesis ou quando o reconciliador/merge-watch observar (N7: `EVOLUTION_MERGE_WATCH` sozinho não basta para merge feito no GitHub). | Decisão do Jean |

## 10. Referências

- Plano: [EVOLUIR-PROJETO-BANCADA-plano.md](../plans/EVOLUIR-PROJETO-BANCADA-plano.md) (Fase 6, tarefa 6.3 linha 110; 4.5 linha 93) · Runbook: [CARDS-BANCADA-RUNBOOK.md](CARDS-BANCADA-RUNBOOK.md) · Guia: [GUIA-CARDS-BANCADA.md](../guides/GUIA-CARDS-BANCADA.md) · RFC: [RFC-0009](../rfc/RFC-0009-EVOLUCAO-POR-TICKET.md).
- Relatórios (em `project/docs/analysis/`): `EVOLUIR-PROJETO-AI-reverificacao-fase4.md` (N1–N9, 4.5 condicionada), `AK-correcoes-n1-n8-fase4.md`, `AN-revisao-guard-fase5-6.md`, `AO-correcoes-an-guard.md`, `AP-execucoes-reais-4-5.md`, `AQ-correcoes-qa-escopo-baseline.md`, `AR-correcoes-compat-connect-flags.md`. Pendente: `AS-execucao-real-4-5b.md`.
