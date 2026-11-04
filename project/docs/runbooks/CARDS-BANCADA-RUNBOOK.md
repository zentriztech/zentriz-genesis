> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Runbook — Cards da Bancada ("Evoluir projeto" por card)

**Tarefa 6.2** do [plano EVOLUIR-PROJETO-BANCADA](../plans/EVOLUIR-PROJETO-BANCADA-plano.md) · Estado: **revisado contra o código de `evo/f6` (base `8a261b4`)**, sem produção tocada · Público: operador do Genesis (`zentriz_admin`), `tenant_admin` e quem faz plantão.
Contexto de desenho: [RFC-0009](../rfc/RFC-0009-EVOLUCAO-POR-TICKET.md) e [guia do usuário](../guides/GUIA-CARDS-BANCADA.md). Fontes dos fatos: relatórios `EVOLUIR-PROJETO-Z`, `AA`, `AB`, `AC`, `AD`, `AE`, `AF`, `AG`, `AH`, `AI`, `AJ`, `AK`, `AL` (em `project/docs/analysis/`) e o código citado como `arquivo:linha` (caminhos relativos a `applications/services/api-node/src/`).

> **Regra de ouro deste runbook.** Cada sintoma segue o mesmo formato: **como detectar**, **causa**, **ação segura** e **o que NÃO fazer**. Em todo caso, leia antes (somente leitura) o card e o filho; só depois aja. Operações destrutivas em produção (`DELETE`, `UPDATE` manual, `docker compose`) exigem o OK do Jean; este documento nunca autoriza um `UPDATE` direto em `tickets`/`projects` (a máquina de estados é a única porta de escrita).

## 0. Mapa rápido

| Quero… | Vá para |
|---|---|
| Entender estados e quem muda o quê | §1 |
| A promoção falhou ou travou | §2 |
| O card está `blocked` | §3 |
| O card não sai de `Na fábrica`, sem PR ou sem merge | §4 |
| Ligar, observar ou desligar o reconciliador | §5 |
| Desligar `CARDS_BANCADA` de um tenant (rollback) | §6 |
| Fazer deploy (ordem, migrations 141–161) | §7 |
| Checklist para ligar em tenant real | §8 |
| Quem pode fazer o quê | §9 |
| Consultas SQL de diagnóstico | §10 |
| Códigos de erro e HTTP | §11 |
| Decisões D-E1..D-E10 e assunções | §12 |
| Lacunas conhecidas | §13 |

## 1. Modelo em 60 segundos

- **Card = linha de `tickets` com `card_state` não nulo.** `card_state NULL` é ticket legado, fora da máquina (`services/cardState.ts:1-3`). O `tickets.status` legado é **derivado** do `card_state` e escrito no mesmo `UPDATE` (`cardState.ts:66-73`): `draft/refining/ready → open`, `promoted/in_factory/blocked → promoted`, `delivered → delivered`, `rejected → rejected`.
- **Rascunho separado da materialização (D-E1, A').** O card nasce com um projeto `card_draft` (sem versão, sem clone). Versão `vN`, cópia da árvore, clone e branch `evolution/vN` só nascem na **promoção**, contra o HEAD corrente da linhagem (`services/cardPromote.ts:1-15`).
- **Transições válidas** (`CARD_TRANSITIONS`, `cardState.ts:83-95`): `draft→refining`; `draft|refining→ready` (só o sistema, ao validar); `ready→refining` (escrita na spec ou base vencida); `ready→promoted` (dentro do claim, exige o filho); `promoted→in_factory`; `promoted|in_factory→blocked`; `blocked→in_factory` (retomada); `promoted|in_factory|blocked→ready` (filho descartado); `in_factory→delivered` (só o sistema); `draft|refining|ready|blocked→rejected` (só humano). Qualquer outro par é `409 CARD_INVALID_TRANSITION`.
- **Auditoria:** cada transição grava uma linha em `ticket_card_events` (ator, de→para, motivo, filho, chave de idempotência). É a primeira fonte para entender "como chegou aqui" (consulta §10.3).
- **Quem move o card depois da promoção** (não é o usuário): `syncCardWithChild` (filho entrou na fábrica, morreu ou foi parado pelo Guard — `cardPromote.ts:163`), `deliverCardsOfChild` (aceite + PR mergeado ⇒ `delivered` — `cardDelivery.ts:126`) e o reconciliador (§5). O `GET /api/cards/:id/journey` e o `POST /resume` também alinham o card ao filho (efeito colateral intencional, AC §4.8).
- **A flag governa só as portas de entrada.** Para um ticket que já tem `card_state`, as transições valem sempre, com a flag ligada ou não (`cardState.ts:57-58`). Isso importa no rollback (§6).

## 2. Promoção que falha

Promover é `POST /api/cards/:id/promote` (`routes/cards.ts:503`). Pré-condições fora do lock: card `ready`, hash da spec do rascunho igual ao do carimbo e HEAD igual à base registrada (`cardPromote.ts:49-110`); o claim reavalia tudo **dentro do lock** (`evolveClaim.ts:368-400`). Em qualquer divergência o card volta a `refining` (nunca fica `ready` com carimbo inválido).

### 2.1 Filho preso em `materializing` (card `promoted`)

- **Como detectar.** Card em `Promovido` há muito tempo; `projects.status='materializing'` com `extra->'materialization'->>'lease_until'` no passado (consulta §10.4). O reconciliador, se ligado, registra `claim_expired_no_effects` (aviso) ou `claim_expired_with_effects` (crítico) — §5. `POST /promote` responde `409 MATERIALIZATION_IN_PROGRESS` enquanto o lease (600 s, `evolveClaim.ts:48`) ainda vale.
- **Causa.** A materialização é feita em passos idempotentes com lease (`spec_tree → code → ticket → card_spec → triages → dialogue → finalize`, `evolveClaim.ts:690-765`). Se a API ou o runner morrem no meio, o lease vence e o filho fica `materializing` com os passos já concluídos marcados em `extra.materialization.steps`.
- **Ação segura.**
  1. Espere o lease vencer (10 min) e confirme que o filho não avança (consulta §10.4).
  2. **Repita `POST /api/cards/:id/promote`** com o mesmo card: a repetição retoma do ponto da falha (`promoteCard` reconhece `promoted` + filho `materializing` e chama o claim de novo — `cardPromote.ts:55-67`). É idempotente: não duplica filho, task nem PR.
  3. Se havia **efeitos** (passos gravados, arquivos de spec do filho ou diretório em disco), o reconciliador **só notifica**; a retomada é sempre a repetição do pedido.
  4. Se **não havia efeito algum** e `EVOLVE_RECONCILER=on`, o reconciliador marca o filho `failed` (`claim_expired_no_effects`) e devolve o card a `ready` pela máquina (`evolveReconciler.ts:154-185`); então basta promover de novo.
- **NÃO fazer.** Não editar `projects.status` nem apagar o filho "à mão"; não promover por `/api/projects/:id/evolve` (o card é recusado com `409 USE_CARD_PROMOTE`, `routes/projects.ts:3551`); não apagar o diretório do filho no disco; não rebuildar `api`/`agents` com promoção em voo (o lease está em jogo); não repetir a promoção em laço apertado (o `FOR UPDATE` e o lease já serializam, mas só atrapalham o diagnóstico).

### 2.2 `CARD_BASE_STALE` (409)

- **Como detectar.** Resposta `409 {code:"CARD_BASE_STALE", expectedHead, currentHead, revalidate}`; o card volta a `refining`.
- **Causa.** Entre a validação e a promoção, a linhagem ganhou uma versão mais nova (outro card entregue, evolução legada, supersessão) ou a spec da base mudou (`cardPromote.ts:98-104`, `evolveClaim.ts:474`).
- **Ação segura.** `POST /api/cards/:id/revalidate`. Resultado `ok` (rebaseia), `stale` (precisa de revisão humana: razão `NEEDS_HUMAN_REVIEW` e, sem clone, bloqueador `GLOBS_UNVERIFIED`) ou `conflict` (não rebaseia; o RFC precisa ser ajustado). Depois, `POST /api/cards/:id/ready` (Validar) e promover de novo. O portal mostra isso como "Revalidar" (`CardActionsBar`).
- **NÃO fazer.** Não tentar promover de novo sem revalidar (devolve o mesmo 409); não "forçar" a base editando o carimbo `extra.card_ready` no banco; não confirmar globs sem conferir o código (AB-07 segue como decisão aberta do Jean, §13).

### 2.3 `CARD_DRAFT_CHANGED` (422, passo `card_spec`)

- **Como detectar.** O filho vai a `failed` com `extra.materialization.error.code='CARD_DRAFT_CHANGED'`; o card vai a `blocked` com `blocked_reason='materialization_failed:CARD_DRAFT_CHANGED'` (`evolveClaim.ts:862`). Resposta 422 da promoção.
- **Causa.** Algum escritor alterou a spec do rascunho **depois** do carimbo `ready` e **depois** das verificações do claim, mas antes da cópia ao filho (`evolveClaim.ts:956-958`). É defesa em profundidade: nada chega ao filho. Só ocorre com escritor que ignora a guarda (AC §2).
- **Ação segura.** O filho é descartável: `POST /api/cards/:id/resume` devolve o card a `ready` (`child_discarded`, vínculo limpo — `cardPromote.ts:281`); a promoção seguinte detectará o hash divergente e levará o card a `refining`; então Validar (`/ready`) e promover. Investigue **quem** escreveu (consulta §10.3, motivos `spec_write_after_ready` / `draft_changed_after_ready`).
- **NÃO fazer.** Não reaproveitar o filho `failed`; não editar a spec do rascunho enquanto a promoção roda; não copiar arquivos do rascunho para o filho manualmente.

### 2.4 `CARD_SPEC_LOCKED` (409)

- **Como detectar.** Ao editar o texto do card (`PATCH /api/cards/:id`) ou escrever na spec do rascunho: `409 {code:"CARD_SPEC_LOCKED", canReopen:true, reopen:"POST /api/cards/:id/reopen"}` (`routes/cards.ts:380`, `cardService.ts:778`).
- **Causa.** O card está `ready`: a spec fica **travada** para que o carimbo continue válido (Y-01).
- **Ação segura.** `POST /api/cards/:id/reopen` (autor ou administrador; §9) leva a `refining` e descarta o carimbo; edite; valide de novo.
- **NÃO fazer.** Não contornar a trava escrevendo direto em `project_spec_files`/disco (derruba o hash do carimbo e a promoção devolve o card a `refining`, `noteCardSpecWrite`); não reabrir um card já `promoted` (a spec histórica não é reaberta).

### 2.5 Outros 409 comuns na promoção

| Código | Significado e ação |
|---|---|
| `CARD_NOT_READY` (+`state`) | Card não está `ready`, carimbo sumiu ou spec mudou. Valide (`/ready`). Em `blocked`, use `/resume`. |
| `EVOLUTION_IN_FLIGHT` | Já há evolução viva na linhagem (guard histórico). Espere terminar ou resolva o filho preso (§3, §10.5). |
| `EVOLUTION_BUSY` | Outra promoção registra neste instante. Repita em segundos. |
| `MATERIALIZATION_IN_PROGRESS` | Lease vivo. Aguarde; não repita em laço. |
| `EVOLUTION_RFC_REQUIRED` / `EVOLUTION_RFC_INVALID` / `CARD_KIND_MISMATCH` / `CARD_KIND_REQUIREMENT` | O gate de RFC (invariante nos três tipos) foi reavaliado no lock e falhou; o card volta a `refining`. Corrija o RFC e valide de novo. |
| `CARD_PATH_COLLIDES_WITH_BASE` | O rascunho tem arquivo (ou número de RFC/ADR) que já existe no HEAD. Renomeie/renumere no rascunho. |
| `CARD_ATTACHMENT_CONVERSION_PENDING` | Conversão pdf/doc/docx → `.md` ainda em andamento (na validação). Aguarde e valide de novo. |
| `PARENT_SUPERSEDED` | A versão-base foi substituída. Revalide (§2.2). |
| `MATERIALIZATION_FAILED` (500) | Erro transitório (git, rede, disco); o lease é liberado. **Repita a promoção**: ela continua de onde parou. |
| `HEAD_SPEC_UNREADABLE` / `CODE_BASE_UNAVAILABLE` (422) | Falha terminal: filho `failed` e card `blocked` (`materialization_failed:<CODE>`). Resolver a causa (volume, repositório) e `/resume` → `ready` → promover. |
| `402 BUDGET_*` / `KILL_SWITCH` / `GLOBAL_*_CAP` | Guard soberano. Ver §3.1. Nunca vira `failed`. |

## 3. Card `blocked`

`blocked` exige `blocked_reason` (CHECK no banco, migration 148). O motivo é sempre um **código do sistema** (nunca texto livre). Consulta de triagem em §10.2.

| `blocked_reason` | Quem gerou | Seção |
|---|---|---|
| `budget:<CÓDIGO_DO_GUARD>` | Guard de custo parou o filho (`stopped_by='budget'`) | 3.1 |
| `child_failed` | Filho da Fábrica terminou em `failed` | 3.2 |
| `child_archived` | Filho foi arquivado sem ser por supersessão | 3.3 |
| `materialization_failed:<CODE>` | Falha terminal na promoção | 2.3 / 3.2 |
| `backfill:child_*` | Backfill ao ligar a flag (filho ausente/morto) | 6 |

### 3.1 Bloqueio por orçamento (`budget:*`)

- **Como detectar.** Card `Bloqueado`, `blocked_reason` começando por `budget:` (ex.: `budget:BUDGET_PAUSED`, `BUDGET_INSUFFICIENT`, `BUDGET_MISSING`, `KILL_SWITCH`, `CARD_BUDGET_CAP`); o filho fica `stopped` com `stopped_by='budget'` (exceto `CARD_BUDGET_CAP` com filho em status de Bancada, que o Guard não para: o filho segue com o status e só o card vira `blocked`); evento do Guard (`actor_kind='guard'`) em `ticket_card_events`. O portal mostra a ação "Aumentar o orçamento" (`cardJourney.ts:161,190`).
- **Causa.** Negativa do Guard (soberano): `cardPromote.ts:176-188`. Pela decisão do plano (§1, critério Custo), negativa do Guard ⇒ `blocked` por orçamento, **nunca `failed`**. O gancho das rotas internas do Guard (`routes/llmGuard.ts`, Y-14, throttle de 15 s por projeto e origem) alinha o card sem ninguém olhar a jornada quando o preflight nega com `BUDGET_*` **ou `CARD_BUDGET_CAP`** (AN/A2, corrigido na AO; antes o gancho ignorava o teto do card). Com `EVOLVE_RECONCILER=on` há também a varredura periódica (`syncCardsWithChildren`, `cardPromote.ts`), que agora cobre o filho vivo na Bancada com `card_cap_reached` nas últimas 24 h. **Sem o reconciliador e sem nenhuma outra chamada**, um card cujo filho nunca mais chama o Guard só é alinhado quando alguém abre a jornada. O runner reconhece `CARD_BUDGET_CAP` como negativa de orçamento (`orchestrator/guard_denial.py`): devolve a task e pausa o run na hora, sem as 10 reverificações de ~40 min.
- **Ação segura.** (a) Aumentar o orçamento do **dono** da versão (D-E10: o card usa o mesmo orçamento do dono; rota `PUT /api/projects/:id/budget` do projeto-dono) **ou, no caso de `CARD_BUDGET_CAP`, subir o `card_budget_pct`** do tenant (`PUT /api/cost-policies`; o tenant nunca pode ficar acima da política global, `TENANT_POLICY_EXCEEDS_GLOBAL`). O gate de retomada usa como folga a mediana das chamadas do dono (AN/A4), então o card só volta a `in_factory` se a próxima chamada for aceita; (b) `POST /api/cards/:id/resume`. Se o Guard ainda nega, responde `402 CARD_BUDGET_BLOCKED` e o card **continua** `blocked`. Com saldo, o card volta a `in_factory`; se o filho ainda estiver `stopped`, a resposta traz `childRestartRequired:true` e `next:"POST /api/projects/:id/run"`: **liberar a pausa não religa a execução**, é preciso reiniciar o filho.
- **NÃO fazer.** Não tentar mascarar com `UPDATE projects SET status=...`; não desligar o kill switch ou os tetos globais (`llm_guard_settings`) para "destravar" um card; não marcar o filho como `running` à mão; não criar outro card para contornar o saldo (o orçamento é compartilhado).

### 3.2 Falha da Fábrica (`child_failed`) ou da materialização

- **Como detectar.** `blocked_reason='child_failed'` (filho `failed` depois de ter entrado na fábrica) ou `materialization_failed:<CODE>` (falhou na promoção).
- **Causa.** O filho morreu. O card sai de `promoted|in_factory` para `blocked` pela máquina (`cardPromote.ts:172-175`, `evolveClaim.ts:862`). O pedido (ticket) continua válido: a execução é que morreu (RFC-0009, inv. 3).
- **Ação segura.** Entenda por que o filho falhou (diálogo do projeto, `extra.materialization.error`, logs do runner). Depois `POST /api/cards/:id/resume`: com o filho **morto** o card volta a `ready` com vínculo limpo (`back_to_ready`) e você promove de novo (a base é conferida contra o HEAD). Com o filho **vivo e na fábrica** (reiniciado), `/resume` leva a `in_factory`.
- **NÃO fazer.** Não reiniciar um filho `failed` por `UPDATE`; não promover pelo `/evolve` legado; não "resumir" repetidamente esperando outro resultado: `/resume` é idempotente e devolve `CARD_CHILD_NOT_IN_FACTORY` se o filho ainda não voltou à fábrica (reinicie-o com `POST /api/projects/:id/run`).

### 3.3 `child_archived`

- **Como detectar.** `blocked_reason='child_archived'` com o filho `archived` **sem** `extra.superseded_by`.
- **Causa.** O filho foi arquivado por fora do fluxo do card (descarte manual, limpeza). **Não** é o caso de supersessão: filho arquivado **com** `superseded_by` foi aceito e substituído por versão mais nova, e o card **não** é bloqueado por isso (A1: `isSupersededChild`, `cardState.ts:158-176`); ele entrega quando o PR (ou o do sucessor) é mergeado (§4).
- **Ação segura.** `POST /api/cards/:id/resume` ⇒ `ready` (filho descartado) ⇒ revalidar/validar se pedido ⇒ promover. Se a intenção era abandonar o pedido, **rejeite** o card (`POST /api/cards/:id/reject`; §9).
- **NÃO fazer.** Não desarquivar o filho; não rejeitar achando que isso apaga o histórico (a rejeição é definitiva e arquiva o filho vivo parado, `child_active` se estiver rodando: pare/descarte antes — `cardState.ts:138-142`).

## 4. Card pendente de merge ou de PR

`delivered` só ocorre com **filho aceito (ou superado) + PR mergeado** quando a linhagem tem repositório. Sem prova, o card permanece `in_factory` (lado seguro: nunca entrega falso). A ordem de decisão está em `verifyChildPrMerged` (`cardDelivery.ts:53-93`): (1) `push_pending`/`publish_state` `pending|failed` ⇒ não entrega; (2) `evolution_merged_at` ⇒ entrega; (3) sem repositório na linhagem ⇒ `no_repo`, entrega sem PR; (4) repositório + `evolution_pr_number` + instalação viva ⇒ consulta o PR no GitHub; (5) `direct_dev` (repo novo, push direto em `dev`) ⇒ entrega sem PR por desenho.

Primeiro passo de diagnóstico: consulta §10.6 (estado de publicação do filho) e os motivos do resultado: `push_pending`, `no_pr`, `no_installation`, `pr_not_merged`, `pr_lookup_failed`, `pr_closed_successor_not_merged`.

### 4.1 `evolution_publish_incomplete` (achado crítico do reconciliador)

- **Como detectar.** `GET /api/admin/evolve-reconciler/findings?kind=evolution_publish_incomplete&open=true` (só `zentriz_admin`; 404 com o reconciliador `off`). No portal: aviso no diálogo do projeto e botão **"Republicar"**. `detail.reason` = `publish_pending_stale` (aceite marcou `pending` e a API morreu antes de fechar) ou `pr_not_registered` (repositório da linhagem registrado, sem número de PR).
- **Causa.** Queda entre o aceite e o push (C1) ou entre o registro do repositório e a gravação do PR (C3). O detector só vale para **filho de card** (`evolution_origin='card'` e ticket com `card_state`) de tenant com `CARDS_BANCADA` ligada, depois da carência de `EVOLVE_RECONCILER_PUBLISH_GRACE_S` (900 s) (`evolveReconciler.ts:296-330`, correção N2). Em `on`, marca `evolution_push_pending=true` e `publish_state='failed'` (aparece "Republicar", a entrega fica bloqueada); em `shadow`, só registra (`action: shadow_would_mark_push_pending`).
- **Ação segura.** Dono do projeto ou `tenant_admin`: **Republicar** (`POST /api/projects/:id/evolution/republish`, `routes/evolutionPlan.ts:183`). Reaproveita o PR aberto (não abre outro) e responde 200 quando a pendência limpa, ou 502 se falhou de novo (veja o diálogo do projeto). Depois o merge do PR entrega o card.
- **NÃO fazer.** Não republicar com `GENESIS_GITHUB_PUSH=off` (repete o `skipped`); não republicar duas vezes em paralelo nem durante o push original (não há trava; risco aceito N5: o último a terminar vence); não limpar `evolution_push_pending` por SQL; `zentriz_admin` **não** republica (conta de gestão, 403 `MANAGEMENT_ACCOUNT`).

### 4.2 `card_published_without_pr` (achado crítico, só alerta)

- **Como detectar.** `findings?kind=card_published_without_pr&open=true`. Filho de card `accepted`/superado, `publish_state='done'`, **sem** PR registrado, **sem** linha própria em `project_github_repos`, com repositório **na linhagem**, depois da carência (`evolveReconciler.ts:360-390`). Entra no e-mail de operações.
- **Causa.** O push foi `skipped` (tenant sem GitHub App ou `GENESIS_GITHUB_PUSH=off`): o código da evolução nunca chegou ao repositório, e o card fica pendente em `no_pr` (AK N6b).
- **Ação segura.** Corrigir a causa-raiz **primeiro** (instalar/reautorizar o GitHub App com permissão "Pull requests: Read & write" e `GENESIS_GITHUB_PUSH=on`) e só então **Republicar** (§4.1). Se a evolução deve ser abandonada, rejeite o card. O achado some sozinho quando o PR é registrado ou o merge gravado.
- **NÃO fazer.** Não marcar o card como entregue à mão; não ligar auto-merge para "resolver"; não ignorar o alerta (o card ficaria pendente para sempre).

### 4.3 `push_pending` (o botão "Republicar" apareceu)

- **Como detectar.** `projects.extra->>'evolution_push_pending' = 'true'` no filho (consulta §10.6). Pode vir do push que falhou no aceite (`publish_state='failed'`, `evolutionAccept.ts:289`) ou do detector (§4.1).
- **Causa.** A publicação não fechou. A entrega do card está bloqueada de propósito (precedência máxima em `verifyChildPrMerged`).
- **Ação segura.** Republicar (§4.1). Se o push demorou mais que a carência (900 s) e o detector marcou durante o push, o fim do push bem-sucedido limpa `push_pending` incondicionalmente (N5, `evolutionAccept.ts:296-299`).
- **NÃO fazer.** Não clicar "Mergear agora" enquanto houver pendência (responde `409 NO_PR`); não remover a marca por SQL.

### 4.4 PR aberto, ninguém mergeou; PR fechado sem merge

- **Aberto.** O card segue `in_factory` (`pr_not_merged`): é espera humana legítima. Merge manual pelo botão **"Mergear agora"** (`POST /api/projects/:id/evolution/merge`; dono ou `tenant_admin`; `zentriz_admin` não). Travas de política (MAJOR, compatibilidade implícita, sem testes, regressões) exigem `confirm:"MERGE"`; "sem evidência de testes" e "instalação revogada" não são contornáveis.
- **Merge feito direto no GitHub.** O Genesis só percebe com `EVOLVE_RECONCILER=on` (`deliverAcceptedCards`, a cada passada, ≤ 100 candidatos); `EVOLUTION_MERGE_WATCH=on` ajuda mas **não** é o pré-requisito (N7). Em `shadow`/`off` o card fica `in_factory`.
- **Fechado sem merge e superado.** Se a versão sucessora (cadeia `superseded_by`, até 5 elos) está mergeada e sem pendência, o card entrega por `successor_merged` (N8); senão `pr_closed_successor_not_merged` (pendente).
- **NÃO fazer.** Não mergear o PR antigo (v2) depois de a v3 ser a versão corrente com auto-merge ligado (N3: o worker agora só **observa** superados, mas mantenha `EVOLUTION_AUTO_MERGE` e `EVOLUTION_AUTO_REDEPLOY` desligados no rollout); não fechar PRs "para limpar".

## 5. Reconciliador (`EVOLVE_RECONCILER`)

Job de **plataforma** (não por tenant), com lock de sessão no Postgres (`RECONCILER_LOCK_NS=7342`), uma passada a cada 5 min (`EVOLVE_RECONCILER_INTERVAL_MIN` ou chave de config; mínimo 1 min). **Detecta e notifica**; as únicas ações automáticas são: limpar claim vencido sem efeitos (Q1) e, em `on`, marcar `push_pending` (Q7), sincronizar card × filho e entregar cards cujo merge foi feito fora. Nunca apaga projeto, ticket ou arquivo. Zero LLM.

| Modo | O que faz |
|---|---|
| `off` (padrão) | Nada é lido nem escrito; a rota de achados responde 404. O worker agenda timer, mas cada passada retorna cedo (o comentário em `index.ts:148` está desatualizado: o modo é lido a cada passada, `evolveReconciler.ts:590-600`). |
| `shadow` | Detecta e grava achados (`evolve_reconciler_findings`); **não** limpa, **não** notifica, **não** entrega cards. |
| `on` | Detecta, grava, limpa Q1 sem efeitos, marca `push_pending` (Q7), executa `syncCardsWithChildren` e `deliverAcceptedCards`, e envia **um e-mail por passada** (SES, `OPS_NOTIFY_EMAIL`, padrão `jean@zentriz.com.br`). |

**Como o modo é resolvido** (`featureFlags.ts:158-163`): linha **global** de `genesis_runtime_config` (`EVOLVE_RECONCILER`: 0=off, 1=shadow, 2=on) > variável de ambiente `EVOLVE_RECONCILER` (default de plataforma) > `off`. Valor inválido ⇒ `off`. Mudar por configuração não exige reinício. **`on` sem `PROJECT_FILES_ROOT` e `UPLOAD_DIR` existentes é rebaixado para `shadow`** (e gera o achado `reconciler_disk_unverifiable`, crítico), porque a classificação "sem efeitos" lê o disco da própria API (M-15).

**Parâmetros** (env): `EVOLVE_RECONCILER_CLAIM_GRACE_S` (300), `_ORPHAN_GRACE_S` (300), `_PUBLISH_GRACE_S` (900), `_STUCK_HOURS` (72), `_INTERVAL_MIN` (5).

**Achados** (`kind`): `claim_expired_no_effects`, `claim_expired_with_effects`, `ticket_promoted_without_child`, `child_ticket_mismatch`, `evolution_in_flight_stuck`, `uniqueness_index_missing`, `reconciler_disk_unverifiable`, `card_status_divergence`, `evolution_publish_incomplete`, `card_published_without_pr`. Os identificadores são **hashes** (sha256/16 hex) — sem PII. Para achar um card pelo achado, use os filtros `projectId`/`ticketId` da rota (a rota faz o hash).

**Fluxo recomendado para ligar** (item 8 de AK §5; AI §2/N2):

1. Confirmar `PROJECT_FILES_ROOT` e `UPLOAD_DIR` montados na API.
2. Pôr em **`shadow`** e deixar rodar pelo menos algumas passadas (≥ 3 intervalos, 15 min). Ler `GET /api/admin/evolve-reconciler/findings?open=true` e a consulta §10.7.
3. **Contar os achados.** Esperado em ambiente limpo: zero de `claim_expired_*`, `evolution_publish_incomplete`, `card_published_without_pr`. Achado de `ticket_promoted_without_child`/`child_ticket_mismatch`/`evolution_in_flight_stuck` costuma ser legado: investigar caso a caso antes de ligar (não é bloqueio, mas `on` passará a notificar).
4. Só então `on`, e acompanhar o primeiro e-mail e a primeira passada (log `[reconciler]` em JSON, sem PII).
5. Em caso de ruído inesperado: voltar a `shadow` (ou `off`) por configuração; não há migration a desfazer (rollback é por flag; `145_evolve_reconciler_findings.sql`).

**`EVOLUTION_MERGE_WATCH`.** Observador do merge das evoluções (default `off`; `EVOLUTION_MERGE_WATCH_MS`, 5 min). Sozinho **não basta** para entrega (N7). Desde a AK, para filho de card sem `EVOLUTION_AUTO_MERGE`, detecta merge externo (`observeEvolutionMerge`) e, para filho **superado**, apenas **observa** (sem auto-merge nem hooks pós-merge). Para o rollout dos cards, mantenha `EVOLUTION_AUTO_MERGE` e `EVOLUTION_AUTO_REDEPLOY` **desligados** (§8).

**O que NÃO fazer.** Não ligar `on` direto em produção sem a passada `shadow`; não ligar o reconciliador esperando que ele "conserte" cards: ele não escreve card fora dos casos acima; não apagar linhas de `evolve_reconciler_findings` (o resolver é automático: `resolved_at` quando a condição some); não rodar duas passadas globais simultâneas no mesmo banco de teste (N9: cada teste com passada global precisa de banco próprio).

## 6. Rollback da flag `CARDS_BANCADA` por tenant

`CARDS_BANCADA` é flag **`configOnly`**: só vale por linha em `genesis_runtime_config` (tenant explícito > global); o ambiente é **ignorado** (`featureFlags.ts:41`, S-06). Só `zentriz_admin` altera.

**Desligar para um tenant** (preferível): `PUT /api/admin/runtime-config/CARDS_BANCADA` com `{ "value": 0, "tenantId": "<uuid>" }` (override explícito `off`, vence o global). `DELETE …/CARDS_BANCADA?tenantId=<uuid>` remove o override e **volta ao global**, o que pode **ligar** a flag se o global estiver ligado — confira antes. Desligar nunca é bloqueado (`runtimeConfig.ts:75-90`).

**O que acontece com os cards existentes** (verificado no código):

| Aspecto | Com a flag desligada |
|---|---|
| Dados | **Nada é apagado nem revertido.** `card_state`, rascunhos `card_draft`, `ticket_card_events` e specs permanecem. |
| Rotas `/api/products/:id/cards*` e `/api/cards/*` | Respondem `404 {code:"NOT_FOUND", message:"Recurso indisponível"}` (sem `userMessage`: a resposta é a de antes da feature). O token de serviço recebe o mesmo 404. |
| Portal | "Evoluir projeto" volta ao diálogo antigo; o quadro de cards some para o tenant. |
| Transições do que já está na máquina | **Continuam válidas** (consistência de dados): `syncCardWithChild`, entrega pós-aceite/merge (`deliverCardsOfChild`) e as transições do reconciliador `on` seguem atuando sobre tickets com `card_state` (`cardState.ts:57-58`, `cardDelivery.ts:1-25`). Um card `in_factory` ainda é entregue quando o PR é mergeado. |
| Detectores Q7 (`evolution_publish_incomplete`) | Passam a ignorar o tenant (filtro por flag, N2). |
| **Card `draft/refining/ready` (ainda não promovido)** | **Fica em limbo:** as rotas de card dão 404 e o `/evolve` legado com o `ticketId` dele responde `409 USE_CARD_PROMOTE` (a checagem não consulta a flag — `routes/projects.ts:3551`, `cardPromote.ts:291`) apontando para uma rota que dá 404. Ação: **não desligue com cards pré-fábrica ativos** sem antes promovê-los, rejeitá-los (a flag ligada) ou combinar com o dono; ou religue a flag para destravar. |
| `PATCH /api/tickets/:id` em card | Segue pelo roteamento de card (`legacyPatchCard`), com as mesmas travas (`CARD_SPEC_LOCKED`, `TICKET_IMMUTABLE`, `CARD_DELIVERY_IS_AUTOMATIC`). |

**Backfill ao religar.** Toda mudança de `CARDS_BANCADA` roda **numa transação** (`changeCardsFlag`, `runtimeConfig.ts:91-140`, advisory lock global): grava a linha e, para cada tenant que passa a valer ligado, roda o backfill idempotente de `card_state` e `spec_origin` (`cardsBackfill.ts`) **com o mesmo cliente**, depois confere divergências (`findCardStatusDivergences`). Qualquer divergência ou falha ⇒ **ROLLBACK de tudo** e a resposta é `409 CARD_DIVERGENCE` (lista as ocorrências) ou `500 CARDS_BACKFILL_FAILED`; a flag não muda. O backfill só toca linhas com `card_state IS NULL` e **não** altera `tickets.status` nem `updated_at`: `open→draft`, `rejected→rejected`, `delivered→delivered`, `promoted→promoted|in_factory|blocked` conforme o filho (`blocked_reason='backfill:child_*'` para filho ausente/morto). Um legado `promoted` com filho `accepted` fica `in_factory` (não `delivered`: entrega exige PR mergeado comprovado). Repetir é seguro (segunda execução = 0 alterações).

**Contract (remover legado).** Plano F2: só num deploy posterior, depois de N semanas sem leitura do `status` legado. **Não** há remoção de colunas nem migration de volta; rollback é sempre por flag.

**NÃO fazer.** Não apagar `card_state`/`card_draft` por SQL para "limpar" o rollback; não desligar a flag global esperando afetar um único tenant (use o override do tenant); não ligar a flag por variável de ambiente (é ignorada e deixaria tickets sem backfill); não desligar para "resolver" um card travado (use §2–§4).

## 7. Ordem de deploy e migrations 141–161

**Ordem (AL, "Ordem de deploy"; RFC-0009 Passo 7; CLAUDE.md do repositório):**

1. **API primeiro** (migrations rodam no boot dela — `initDb`). Só depois `genesis-web`, `runner`/`agents`/`orchestrator`, `cyborg`, `deadpool` conforme o que mudou.
2. **`agents` depois da API.** Motivo: a rota `POST /api/internal/llm-guard/advisor-gate` (C4') existe só na API nova. Com `agents` novo e API antiga o gate dá 404 e o Advisor é **negado** (`advisor_guard_unreachable`, fail-closed; o Advisor segue desligado por padrão).
3. O runner novo envia `card_id` em mais tasks e lê `evolution_origin` do `extra`; a API precisa estar nova antes (a rota `POST /tasks` valida em lote com `CARD_MISMATCH`).
4. **Janela quieta:** nenhum run em voo antes de recriar `api`/`agents` (a lição "nunca rebuildar api/agents com run em voo"); nenhuma promoção de card em `materializing` (lease).
5. Fluxo ECR canônico do repositório (`CLAUDE.md`): build com os 3 `-f`, `ecr-push.sh`, **tag de rollback** (`rollback-<svc>:pre-<feature>`) no host de produção, pull/retag, recreate (API primeiro), **conferir o digest do container** (healthy não prova código novo) e rotas novas respondendo.
6. **Produção ≠ este host.** Deploy e `docker compose` valem para `3.220.66.113`; o workstation de dev não é produção. Push e deploy só com o OK do Jean.

**Migrations (todas aditivas/expand; sem `DROP` de dado):** `141_projects_status_materializing`, `142_runtime_config_evolve_min_free_budget`, `143_ticket_attachments_kind_and_limits`, `144_ticket_events`, `145_evolve_reconciler_findings`, `147_redact_git_secrets_in_extra`, `148_cards_expand`, `149_project_spec_files_origin`, `150_project_tasks_card`, `160_attachment_conversions`, `161_cost_policies`. Os números **146 e 151–159 não existem** (a reserva da 146 foi abandonada, S-08): a lacuna é esperada, o executor lê os `.sql` em ordem lexicográfica (`db/init.ts`).

**Como o executor se comporta (`db/init.ts:39-80`):**
- **Sem transação.** Cada migration é quebrada em comandos por `;` e executada comando a comando; o registro em `schema_migrations` só é inserido **ao final**. Falha no meio deixa o esquema parcialmente aplicado e a migration **não** registrada: o boot seguinte reaplica, por isso toda migration é idempotente (`IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`).
- **Nunca ponha `;` dentro de literal ou `DO $$` em migration** (o separador ingênuo quebra o comando).
- **Timeouts por comando:** `lock_timeout` 5 s (`MIGRATION_LOCK_TIMEOUT_MS`) e `statement_timeout` 300 s (`MIGRATION_STATEMENT_TIMEOUT_MS`). Um `ALTER TABLE` atrás de transação longa **falha rápido** e a API **não sobe** (comportamento desejado: não enfileirar leituras). Veja `pg_stat_activity` e repita o deploy.
- **148** troca o CHECK `projects_status_check` (acrescenta `materializing` e `card_draft`) e cria `projects_card_draft_shape_check`; **161** cria `cost_policies` (sem política, nada muda). Índices únicos parciais de unicidade de filho nascem **no boot em TypeScript** depois da pré-checagem (`evolutionUniqueness`); se houver duplicata antiga, o índice não é criado e o reconciliador acusa `uniqueness_index_missing` (crítico).
- **Rollback de imagem.** Como as colunas novas são nulas/opcionais e nenhum leitor legado as consulta (suíte `cardsOff.regression`), voltar para a imagem anterior da API é o plano; **não** há migration de volta. [Assunção A5: não foi testada uma imagem antiga contra o esquema 161; o critério "nenhum leitor legado quebra" é o do plano, item 2.1.]

## 8. Pré-condições para ligar em tenant real

Todas as condições abaixo devem ser **verificadas** antes de ligar `CARDS_BANCADA` em um tenant (do relatório AI §5, com as correções N1–N8 da AK já aplicadas no código). Não ligue "para ver".

1. **Repositório na raiz.** O produto tem repositório registrado na **raiz** da linhagem (`project_github_repos` da raiz) e o tenant tem **GitHub App ativa** com permissão **"Pull requests: Read & write"**. Sem isso: push `skipped`, card pendente em `no_pr` e o alerta `card_published_without_pr` (§4.2).
2. **`GENESIS_GITHUB_PUSH=on`** no ambiente (padrão é `on`; `off` desliga branch/PR/repositório).
3. **`EVOLVE_RECONCILER=on`** (depois da passada `shadow`, §5). É o único caminho que percebe merge feito direto no GitHub (N7); `EVOLUTION_MERGE_WATCH` sozinho não basta.
4. **`EVOLUTION_AUTO_MERGE` e `EVOLUTION_AUTO_REDEPLOY` desligados** (evita merge/redeploy de versão superada; N3).
5. **Anexos:** `ATTACHMENTS_STRICT` ligada para o tenant (sem ela, anexo em card ⇒ `409 ATTACHMENTS_UNAVAILABLE`); `ATTACHMENT_CONVERSION` ligada se pdf/doc/docx devem virar `.md` (exige `ATTACHMENTS_STRICT`). Limites padrão: 10 arquivos, 20 MiB no total, 10 MiB por arquivo (`ATTACHMENT_MAX_*`, migration 143; calibrado=falso).
6. **Orçamento explícito** na versão corrente do serviço (D-E10: o card usa o orçamento do dono). Sem `budget_usd` ⇒ `402 BUDGET_MISSING` na criação.
7. **Produto fabricado ao menos uma vez e `accepted`** (D-E2). Sem versão aceita ⇒ `409 NO_ACCEPTED_HEAD`.
8. **Ambiente de homologação limpo ou Q7 em `shadow`:** sem evoluções legadas antigas que gerem ruído (a N2 já restringe o detector a filho de card, mas confirme o `shadow`).
9. **Disco:** `PROJECT_FILES_ROOT` e `UPLOAD_DIR` montados na API (senão `on` rebaixa para `shadow`).
10. **Papéis:** definir quem é `tenant_admin` (promove) e quem são os autores (§9).
11. **Conferência pós-uso (por card):** `delivered` ⇔ PR mergeado no GitHub; nenhuma task não herdada sem `card_id` (consulta §10.8); `executed_*` carimbado uma vez (consulta §10.9).
12. **Pendências abertas que o Jean precisa aceitar antes do rollout em tenant real** (§13): execuções C8–C11 e C13 no runner (AI §5), 4.5 com LLM real em homologação, D-E9 (serviço-alvo), D-E3 (confirmação), decisão sobre `executed_*` em tasks, AB-07 (globs).

Ordem do rollout (plano 6.3): **ZFactory primeiro**, demais tenants depois; critérios de entrada/saída e comunicação ficam sob aprovação do Jean.

## 9. Matriz de papéis

Implementação em `routes/cards.ts:55-105`. A conta de gestão (`zentriz_admin`) não tem autoria; token de serviço (`svc`, runner) **nunca** opera card (nem leitura): 403.

| Ação | `user` (autor do card) | `user` (outro autor) | `tenant_admin` | `zentriz_admin` | token `svc` |
|---|---|---|---|---|---|
| Criar, editar texto, anexar, refinar, validar (`/ready`) | Sim | Sim (o acesso ao card é por tenant; essas ações não exigem autoria, `denyMutation`) | Sim | **Não** (`MANAGEMENT_ACCOUNT_READONLY_CREATE`) | Não |
| **Promover** | Sim (só o próprio) | Não | Sim | **Não** | Não |
| Rejeitar, retomar, revalidar, reabrir, excluir (`draft`) | Sim (só o próprio) | Não (`CARD_ACTION_NOT_ALLOWED`) | Sim | Sim | Não |
| Republicar PR / Mergear agora (projeto filho) | Dono do projeto | Não | Sim | **Não** (`MANAGEMENT_ACCOUNT`) | Não |
| Ligar/desligar `CARDS_BANCADA`, `EVOLVE_RECONCILER`, ver achados | Não | Não | Não (`ADMIN_ONLY_KEY`) | Sim | Não |
| Políticas de custo (`cost_policies`) | Não | Não | Só `advisor_pct` e `card_budget_pct` do próprio tenant, `calibrated=false`, nunca acima da política global | Qualquer; único que marca `calibrated` | Não |

Observações: (a) "validar" e "refinar" não gastam orçamento por si nem materializam versão, por isso ficam no nível `user` (qualquer membro do tenant com acesso ao card; só o ciclo de operação exige autoria ou administrador); (b) um `user` que não é autor recebe `403 CARD_ACTION_NOT_ALLOWED`; (c) para reverter a abertura do ciclo ao `zentriz_admin`, basta trocar `denyOperate` por `denyMutation` nas rotas (Z §3).

## 10. Consultas SQL de diagnóstico (somente leitura)

Rode como usuário de leitura, com `SET default_transaction_read_only = on;` na sessão. No host de produção: `ssh -i ~/.ssh/zentriz_id ubuntu@3.220.66.113` e `sudo docker exec -i zentriz-genesis-postgres-1 psql -U genesis zentriz_genesis` (db `zentriz_genesis`). **Nunca** `UPDATE`/`DELETE` por aqui. Os nomes de coluna foram conferidos contra as migrations 143–150 e o código.

### 10.1 Cards por estado (por tenant)

```sql
SELECT tenant_id, card_state, count(*) AS n
  FROM tickets WHERE card_state IS NOT NULL
 GROUP BY 1, 2 ORDER BY 1, 2;
```

### 10.2 Cards bloqueados e o motivo

```sql
SELECT t.id, 'TK-' || lpad(t.number::text, 4, '0') AS code, t.tenant_id, t.change_kind,
       t.blocked_reason, t.child_project_id, p.status AS child_status, p.stopped_by, t.updated_at
  FROM tickets t LEFT JOIN projects p ON p.id = t.child_project_id
 WHERE t.card_state = 'blocked'
 ORDER BY t.updated_at DESC LIMIT 100;
```

### 10.3 Histórico de um card (auditoria)

```sql
SELECT created_at, from_state, to_state, actor_kind, reason, child_project_id, dedupe_key
  FROM ticket_card_events WHERE ticket_id = '<TICKET_UUID>' ORDER BY created_at;
```

### 10.4 Filhos presos em `materializing` (lease vencido)

```sql
SELECT p.id, p.version_number, p.parent_project_id, p.created_at,
       p.extra->'materialization'->>'lease_until' AS lease_until,
       p.extra->'materialization'->>'attempt' AS attempt,
       (SELECT array_agg(k) FROM jsonb_object_keys(COALESCE(p.extra->'materialization'->'steps','{}'::jsonb)) k) AS steps,
       (SELECT count(*) FROM project_spec_files f WHERE f.project_id = p.id) AS spec_files,
       t.id AS ticket_id, t.card_state
  FROM projects p LEFT JOIN tickets t ON t.child_project_id = p.id
 WHERE p.status = 'materializing'
   AND (p.extra->'materialization'->>'lease_until')::timestamptz < now()
 ORDER BY p.created_at;
```

### 10.5 Evolução em voo por linhagem (o que segura `EVOLUTION_IN_FLIGHT`)

```sql
SELECT id, status, version_number, parent_project_id, updated_at,
       extra->>'evolution_origin' AS origin, extra->>'ticket_id' AS ticket_id
  FROM projects
 WHERE extra->>'evolution' = 'true'
   AND status NOT IN ('accepted', 'archived', 'failed')
 ORDER BY updated_at;
```

### 10.6 Estado de publicação e merge de um filho

```sql
SELECT p.id, p.status,
       p.extra->>'evolution_publish_state' AS publish_state,
       p.extra->>'evolution_publish_mode'  AS publish_mode,
       p.extra->>'evolution_publish_at'    AS publish_at,
       p.extra->>'evolution_push_pending'  AS push_pending,
       p.extra->>'evolution_pr_number'     AS pr_number,
       p.extra->>'evolution_merged_at'     AS merged_at,
       p.extra->>'superseded_by'           AS superseded_by,
       g.repo_full_name AS own_repo, g.pushed_at
  FROM projects p LEFT JOIN project_github_repos g ON g.project_id = p.id
 WHERE p.id = '<CHILD_UUID>';
```

Cards em `in_factory` cujo filho já foi aceito (candidatos a "pendente de merge/PR"):

```sql
SELECT t.id, 'TK-' || lpad(t.number::text, 4, '0') AS code, p.id AS child, p.status,
       p.extra->>'evolution_publish_state' AS publish_state, p.extra->>'evolution_pr_number' AS pr,
       p.extra->>'evolution_push_pending' AS push_pending,
       now() - COALESCE((p.extra->>'evolution_accepted_at')::timestamptz, p.updated_at) AS idade
  FROM tickets t JOIN projects p ON p.id = t.child_project_id
 WHERE t.card_state = 'in_factory'
   AND (p.status = 'accepted' OR (p.status = 'archived' AND COALESCE(p.extra->>'superseded_by','') <> ''))
 ORDER BY idade DESC;
```

### 10.7 Achados abertos do reconciliador

```sql
SELECT kind, severity, mode, detected_at, last_seen_at, seen_count, action_taken, notified_at, detail
  FROM evolve_reconciler_findings WHERE resolved_at IS NULL
 ORDER BY (severity = 'critical') DESC, detected_at DESC;

SELECT kind, count(*) FILTER (WHERE resolved_at IS NULL) AS abertos, count(*) AS total
  FROM evolve_reconciler_findings GROUP BY kind ORDER BY 2 DESC;
```

### 10.8 Rastreabilidade: tasks do filho sem `card_id`

```sql
SELECT pt.task_id, pt.status, pt.card_id, pt.origin_spec_file
  FROM project_tasks pt
 WHERE pt.project_id = '<CHILD_UUID>' AND pt.task_id NOT LIKE 'TSK-INH-%' AND pt.card_id IS NULL;
```

### 10.9 Carimbo `executed_*` dos arquivos de spec do card

```sql
SELECT project_id, rel_dir, filename, spec_origin, executed_in_project, executed_at
  FROM project_spec_files WHERE spec_origin = 'card:TK-0001' ORDER BY project_id, rel_dir, filename;
```

(Troque `TK-0001` pelo código do card.)

### 10.10 Divergência `card_state` × `status` (Q6)

```sql
SELECT id, card_state, status
  FROM tickets
 WHERE card_state IS NOT NULL
   AND status IS DISTINCT FROM (CASE card_state
         WHEN 'draft' THEN 'open' WHEN 'refining' THEN 'open' WHEN 'ready' THEN 'open'
         WHEN 'promoted' THEN 'promoted' WHEN 'in_factory' THEN 'promoted' WHEN 'blocked' THEN 'promoted'
         WHEN 'delivered' THEN 'delivered' WHEN 'rejected' THEN 'rejected' END);
```

Divergência faz a máquina recusar com `CARD_DIVERGED` e o `PUT` da flag recusar com `CARD_DIVERGENCE`. **Não corrija por SQL**: peça apoio ao Jean.

### 10.11 Flag efetiva por tenant e modo do reconciliador

```sql
SELECT key, value, tenant_id, updated_by, updated_at
  FROM genesis_runtime_config
 WHERE key IN ('CARDS_BANCADA', 'EVOLVE_RECONCILER', 'ATTACHMENTS_STRICT', 'ATTACHMENT_CONVERSION')
 ORDER BY key, tenant_id NULLS FIRST;
```

(A linha do tenant vence a global; para `CARDS_BANCADA` o ambiente é ignorado.)

### 10.12 Anexos e conversões pendentes de um card

```sql
SELECT a.id, a.filename, a.kind, a.origin, a.derived_from_attachment_id, c.status AS conversion, c.attempts, c.error_code
  FROM ticket_attachments a LEFT JOIN attachment_conversions c ON c.attachment_id = a.id
 WHERE a.ticket_id = '<TICKET_UUID>' ORDER BY a.created_at;
```

### 10.13 Eventos do Guard sobre um filho (bloqueio de orçamento)

```sql
SELECT created_at, kind, detail FROM llm_guard_events
 WHERE project_id = '<CHILD_OR_DRAFT_UUID>' ORDER BY created_at DESC LIMIT 50;
```

## 11. Erros e códigos HTTP

Todo erro de card leva `userMessage` PT-BR da tabela única `services/cardErrors.ts` (exceto o 404 `Recurso indisponível` da flag desligada).

| HTTP | Código | Quando | Ação |
|---|---|---|---|
| 400 | `BAD_REQUEST`, `INVALID_ID`, `SERVICE_REQUIRED`, `ATTACHMENT_INVALID`, `ATTACHMENT_TOO_LARGE`, `ATTACHMENT_TOO_MANY`, `ATTACHMENT_UNREADABLE`, `CARD_PATH_OUT_OF_SCOPE` | Entrada inválida (id não canônico, tipo/limite de anexo, caminho fora do escopo do card) | Corrigir a entrada |
| 402 | `BUDGET_MISSING`, `BUDGET_PAUSED`, `BUDGET_INSUFFICIENT`, `BUDGET_FREE_BELOW_MIN`, `CARD_BUDGET_BLOCKED`, `KILL_SWITCH`, `GLOBAL_HOURLY_CAP`, `GLOBAL_DAILY_CAP`, `REPEAT_PAYLOAD`, `PROJECT_NOT_FOUND`, `GUARD_ERROR`, `TENANT_LLM_BUDGET_EXCEEDED` | Guard soberano | §3.1; nunca vira `failed` |
| 403 | `FORBIDDEN` (token de serviço), `CARD_ACTION_NOT_ALLOWED`, `MANAGEMENT_ACCOUNT_READONLY_CREATE`, `MANAGEMENT_ACCOUNT`, `ADMIN_ONLY_KEY` | Papel insuficiente | §9 |
| 404 | `NOT_FOUND` (inclui `Recurso indisponível` com flag desligada, outro tenant, id inexistente) | Sem acesso ou flag off | §6 |
| 409 (estado) | `CARD_INVALID_TRANSITION`, `CARD_DIVERGED`, `CARD_NOT_EDITABLE`, `CARD_NOT_DELETABLE`, `CARD_CHILD_NOT_IN_FACTORY`, `CARD_DELIVERY_IS_AUTOMATIC`, `TICKET_IMMUTABLE`, `NOT_PROMOTED`, `USE_CARD_PROMOTE`, `USE_CARD_DELETE`, `USE_CARDS`, `CARD_OPERATION_UNSUPPORTED`, `PRODUCT_ARCHIVED`, `NO_ACCEPTED_HEAD` | Operação fora do estado ou fora do modelo de cards | A mensagem diz a rota correta |
| 409 (spec/gate) | `CARD_SPEC_LOCKED`, `CARD_SPEC_CHANGED`, `CARD_PATH_COLLIDES_WITH_BASE`, `CARD_ATTACHMENT_CONVERSION_PENDING`, `CARD_DRAFT_UNREADABLE`, `GLOBS_UNVERIFIED`, `EVOLUTION_RFC_REQUIRED`, `EVOLUTION_RFC_INVALID`, `CARD_KIND_MISMATCH`, `CARD_KIND_REQUIREMENT`, `ATTACHMENTS_UNAVAILABLE` | Validação/spec/anexo | §2.4, §2.5 |
| 409 (promoção) | `CARD_NOT_READY`, `CARD_BASE_STALE`, `EVOLUTION_IN_FLIGHT`, `EVOLUTION_BUSY`, `MATERIALIZATION_IN_PROGRESS`, `PARENT_SUPERSEDED`, `TICKET_ALREADY_PROMOTED` | Corrida, base vencida, serviço ocupado | §2 |
| 410 | `GONE` | Arquivo do anexo não está mais no disco | Reenviar o anexo |
| 422 | `CARD_DRAFT_CHANGED`, `HEAD_SPEC_UNREADABLE`, `CODE_BASE_UNAVAILABLE`, `CARD_PATH_COLLIDES_WITH_BASE` (passo `card_spec`), `ATTACHMENT_UNREADABLE` (passo `ticket`) | **Falha terminal** da materialização: filho `failed`, card `blocked` | §2.3 / §3.2 |
| 500 | `MATERIALIZATION_FAILED`, `INTERNAL`, `CARDS_BACKFILL_FAILED` | Erro transitório; a repetição retoma | Repetir; ver log |
| 502 | (republicar) | Publicação falhou de novo | Ver diálogo do projeto |

## 12. Decisões e assunções

**Decisões do Jean (2026-11-04), tabela do plano §8:**

| Id | Decisão |
|---|---|
| **D-E1** | Cardinalidade **A'**: 1 card = 1 filho; rascunho separado da materialização; lotes de cards depois. |
| **D-E2** | "Fabricado" = **só `accepted`**. |
| **D-E3** | Ritos por tipo: gate de RFC **invariante**; o tipo só acrescenta exigências (Correção: FAIL_TO_PASS de reprodução e `compat ≤ patch`; Recurso novo: `Non-goals`). *Aguardava confirmação no plano; implementado como proposto.* |
| **D-E4** | Anexos **pdf, txt, md, doc e docx**; `txt/md` dentro da spec; `pdf/doc/docx` guardados no card, **fora** da pasta de texto da spec, com **conversão automática para `.md`** (marcada com a origem). |
| **D-E5** | Produto externo: **adiar** (tarefa 5.4 fora do escopo). |
| **D-E6** | Deadpool/Auto Care → card: **não**. O Auto Care permanece como está (tarefa 5.3 cancelada; `origin` só `manual`/`import`). |
| **D-E7** | Orçamento por card em percentual: depois de C3'/C4'. *Proposta.* C3' (`cost_policies`, migration 161) e C4' (teto do Advisor pelo Guard) foram entregues (AJ, AL); a tarefa 5.1 (percentual por **card**) não consta como entregue. |
| **D-E8** | Status do RFC-0009: **Aceito/Implementado**. |
| **D-E9** | Serviço-alvo do card e mudanças que cruzam serviços: **pendente**. (Hoje, produto com mais de um serviço exige escolher o serviço: `400 SERVICE_REQUIRED`.) |
| **D-E10** | Orçamento: **o mesmo do dono da versão, por enquanto**. |

**Assunções do orquestrador (registradas, reversíveis):**

- **A1 — `zentriz_admin` NÃO promove** (AB-03, RFC-0002 A.1): a conta de gestão não tem autoria; promover materializa uma versão do tenant com o usuário como autor e gasta o orçamento do dono. Promove só o autor ou o `tenant_admin`. Continua rejeitando, revalidando, reabrindo, retomando e excluindo. Reverter: acrescentar `zentriz_admin` a `PROMOTER_ROLES` (`routes/cards.ts:74`) e remover a exceção em `canOperateCard`.
- **A2 — `card_id` em todas as tasks não herdadas** (A3 da AF, decisão do orquestrador): com a flag ligada e ticket-card **deste** filho, toda task cujo ID não começa por `TSK-INH-` recebe o `card_id` (servidor: `routes/projects.ts` POST `/tasks`; runner: `_link_tasks_to_card`). O regex de ID do runner permanece intacto. `TSK-INH-*` ficam sem. O `card_id` explícito só vale para o filho **ativo** do card (B-3).
- **A3 — Sem política de Advisor vale a env legada:** com orçamento e **sem** linha `advisor_pct` em `cost_policies`, o teto do Advisor segue `ADVISOR_MAX_USD_PER_RUN` (padrão US$ 5, `mode:"legacy"`). **Sem orçamento** ⇒ o Advisor é negado (`advisor_denied_no_base`) com ou sem política. Fechar o legado = o gate negar quando não há política (mudança de uma linha), decisão do Jean (AL "Assunções").
- **A4 — "Executada" é derivada:** `project_tasks` não tem `executed_*`; uma task é "executada" se pertence ao filho de um card `delivered`, não é herdada e está `DONE`/`QA_PASS`. Coluna explícita é migration aditiva pequena, decisão pendente (AE §3, M4).
- **A5 — Rollback de imagem sem migration de volta:** assume-se (plano 2.1) que a imagem anterior roda contra o esquema novo porque o desenho é expand e nenhum leitor legado consulta as colunas novas; **não foi testado** contra o esquema 161.
- **A6 — Pré-requisitos da promoção:** assume-se que `promoteCard` chama `runEvolveWithClaim` direto, sem depender da flag `EVOLVE_CLAIM` (que gateia o handler legado); `EVOLUTION_PROMOTE_BANCADA` (filho de evolução promovível na Bancada) é, **na prática, obrigatória** sempre que o filho herda arquivos: o filho nasce `spec_submitted` (ou `draft` sem herança, `evolveClaim.ts:787`) e só é promovível à fábrica pelo `evoPath` (`routes/pipeline.ts:144-162`); sem a flag, `spec_submitted` recebe `409 NOT_ON_WORKBENCH`. Confirmado por leitura do código (AO).
- **A7 — Entrega sem PR só nos dois casos explícitos:** linhagem sem repositório (`no_repo`) e repositório novo com push direto em `dev` (`direct_dev`, sem revisão humana do diff, coerente com projeto novo). Qualquer outro caso exige PR mergeado.
- **A8 — Reconciliador é de plataforma, não por tenant:** o modo `shadow`/`on` vale para todos os tenants; só o detector Q7 é filtrado pela flag do tenant.
- **A9 — Tenant nunca mais permissivo que a global (decisão do orquestrador, AN/M3):** `advisor_pct` e `card_budget_pct` de tenant são recusados no PUT quando excedem a global (percentual; e `abs_cap_usd` do tenant ≤ ao da global quando esta existir), e a leitura limita ao mais restritivo mesmo se a global for baixada depois. O `ADVISOR_MAX_USD_PER_RUN=0` ("sem Advisor") do operador continua ignorado em `mode:"policy"` (não tratado).
- **A10 — RISCO ACEITO (AN/M5):** a base do teto do Advisor e do card é o `budget_usd` **corrente** do projeto-dono, não um snapshot fixado na configuração (desvio do desenho 27 §1.1/§3.1). Aceito porque o Advisor está desligado por padrão em produção e a política nasce `calibrado=false`; não se implementa snapshot nesta entrega. O PUT do orçamento também não recusa valor abaixo do piso.
- **A11 — RISCO ACEITO (AN/M6):** `cardSpentUsd` soma só o rascunho e o filho direto do card; filhos de split do filho ficam fora do teto do card (um card que se divide escapa dele). Não implementado; o orçamento do dono continua limitando o total.
- **A12 — Ordem de deploy (AN/B2):** api primeiro, depois agents. É fail-closed (gate inexistente ⇒ `advisor_guard_unreachable`). Com a api nova e agents antigo ninguém chama o gate: a política gravada **não** vale e o legado segue.
- **A13 — Fail-closed de política (AN/A1, M1):** erro ao ler `cost_policies` nega o Advisor (`advisor_denied_policy_error`), nega a chamada do card (`GUARD_ERROR`) e mantém o disjuntor no menor valor conhecido (último valor lido ou setting). Com política do Advisor e `LLM_ROLES_MODE=off` na API, o gate nega (`advisor_denied_no_base`, `reason: roles_off`): ligue o mesmo valor em api, agents e runner antes de gravar a política.

## 13. Lacunas e pendências conhecidas

1. **Runner:** cenários de caos C8–C11 e C13 não foram executados (AI §4/§5); exigidos antes de fechar a 4.6 e de ligar em tenant real.
2. **Tarefa 4.5** (3 execuções com LLM real em homologação, uma por tipo) e **0.4** (pré-checagem somente leitura em produção) não aparecem como concluídas nos relatórios lidos; confirmar antes do rollout.
3. **Baixas não tratadas:** B-1 (consulta ao GitHub a cada passada, sem backoff nem persistir `evolution_merged_at` ao descobrir o merge), B-2 (não confere base/`head_sha` do PR), B-4, B-5, B-6 e B-d ("Mergear agora" aceita superado sem avisar).
4. **Push concorrente** (Republicar durante o push original) sem trava: risco aceito (N5). `card_published_without_pr` só alerta. `direct_dev` entrega sem revisão do diff. N8 pressupõe que o snapshot do sucessor contém a versão anterior.
5. **Decisões abertas do Jean:** D-E9; D-E3 (confirmação); D-E7 (5.1, percentual por card); coluna `executed_*` em tasks; AB-07 (confirmação humana dos globs: hoje `GLOBS_UNVERIFIED` bloqueia a promoção até a revalidação); unificar `0` nos tetos globais do Guard.
6. **Contrato HTTP:** o relatório "Card entregue: N task(s) executada(s)" (M4) fica no diálogo do filho, não em `GET /api/cards/:id` (fixtures do portal congeladas).
7. **Teste de CI:** cada vitest que dispara passada global do reconciliador/entrega precisa de banco próprio; as 4 suítes de porta fixa exigem o Postgres em 55432 (N9). Playwright (AB-10) fica com o orquestrador.
8. **Comentário desatualizado** em `src/index.ts:148` ("default off = nem agenda timer"); o worker sempre agenda.
9. **Documento de navegação:** `ARCHITECTURE.md` é um modelo genérico; a seção de cards foi acrescentada pela tarefa 6.4 sem reescrevê-lo.

## 14. Referências

- Plano: [EVOLUIR-PROJETO-BANCADA-plano.md](../plans/EVOLUIR-PROJETO-BANCADA-plano.md) (fases 0'–6) · RFC: [RFC-0009](../rfc/RFC-0009-EVOLUCAO-POR-TICKET.md) · Guia: [GUIA-CARDS-BANCADA.md](../guides/GUIA-CARDS-BANCADA.md).
- Estudo C (viabilidade, decisões D-E1..D-E10) e desenho H (máquina de estados): `project/docs/analysis/EVOLUIR-PROJETO-C-…` e `-H-…`.
- Fase 3: `Z` (backend), `AA` (portal), `AB`/`AC` (reverificação e correções). Fase 4: `AD`/`AH` (runner), `AE`/`AG`/`AK` (entrega, PR, N1–N8), `AF`/`AI` (revisões). Custo: `AJ` (C3'), `AL` (C4').
