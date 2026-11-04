> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Evoluir projeto na Bancada (H) — desenho técnico do Advisor para as tarefas 1.1, 1.2, 1.7, 1.8, 2.1 e 2.4

**Data:** 2026-11-04 · **Papel:** Advisor (decisões de arquitetura) · **Base de código:** `dev` em `bce3f50` (o worktree `evo/e1` só acrescenta testes e o helper `src/testing/evolvePg.ts`; nenhum código de produto mudou: `git diff --stat dev..evo/e1` = 4 arquivos de teste/doc) · **Modo:** só leitura, nada executado, nenhum serviço tocado.
**Insumos:** plano [v2](../plans/EVOLUIR-PROJETO-BANCADA-plano.md), estudos [A](EVOLUIR-PROJETO-A-estado-atual-fabrica.md), [B](EVOLUIR-PROJETO-B-estado-atual-bancada.md), [C](EVOLUIR-PROJETO-C-estudo-de-viabilidade.md), [D](EVOLUIR-PROJETO-D-revisao-adversarial.md), [E](EVOLUIR-PROJETO-E-fase0-precheck-producao.md) e F (`.worktrees/g-e1/project/docs/analysis/EVOLUIR-PROJETO-F-fase0-reproducao.md`).
**Convenção:** caminhos relativos a `applications/services/api-node/src/` salvo indicação; `[não verificado]` = não confirmado por leitura nem execução; `[inferido]` = deduzido da leitura, sem execução.

---

## 0. Fatos do código que condicionam o desenho (lidos agora)

| # | Fato | Evidência | Consequência |
|---|---|---|---|
| F1 | O runner de migrations **não usa transação** por arquivo: divide por `;` e executa cada instrução; uma falha lança exceção e o boot da api para | `db/init.ts:23-45`, `:64-74`; chamado em `index.ts:67` | Um `CREATE UNIQUE INDEX` que falhe num `.sql` derruba a subida (crash-loop). Índices de unicidade **não** vão em `.sql`: vão num passo de boot em TypeScript com pré-checagem e `catch` (padrão dos reapers em `index.ts:76-100`) |
| F2 | `projects.version_number` é `INTEGER NOT NULL DEFAULT 1` | `db/migrations/009_add_project_versioning.sql:6` | "Rascunho sem versão" não pode ser `NULL` sem uma mudança de contrato; usar sentinela `0` (§5.1) |
| F3 | O `CHECK projects_status_check` enumera os status; o último está na 097 | `db/migrations/097_product_promotion_order.sql` (DROP/ADD) | `materializing` e `card_draft` exigem DROP/ADD do CHECK (superconjunto; seguro) |
| F4 | O `/evolve` segura **uma conexão** do pool do início ao fim, inclusive durante o `git clone` | `routes/projects.ts:3400` (connect) → `:3703` (release); clone em `:3605` | O claim tem de liberar a conexão antes dos passos lentos |
| F5 | Ninguém escreve `budget_owner_project_id` em TypeScript nem em Python (só a migration 131 cria a coluna e o Guard a lê) | `rg budget_owner_project_id applications/` → só `131_llm_guard_project_budget.sql:19,30`, `services/llmGuard.ts`, `services/connectDeclaration.ts:858` | O `/evolve`/card será o **primeiro** escritor; `resolveBudgetOwner` resolve **um único nível** (`COALESCE(p.budget_owner_project_id, p.id)`, `services/llmGuard.ts:171-180`), então o filho deve apontar para o dono **terminal** |
| F6 | O chat da Bancada debita o `projectId` do job no Guard | `routes/specChat.ts:1632` (`guard_project_id: job.projectId`) | Fecha a lacuna de D §7 para o caminho `/invoke/raw`: o rascunho do card **precisa** de dono de orçamento. O caminho CTO assíncrono (`:1840`) `[não verificado]` |
| F7 | `pauseForBudget` pausa o dono **e todos que dividem o orçamento**, e põe `stopped` quem está em fábrica ativa | `services/llmGuard.ts:564-576`, `FACTORY_ACTIVE_STATUSES` em `:47-49` | Compartilhar o orçamento do dono da versão significa que um card que esgota o saldo **pausa também a versão em produção** (Bancada, Fábrica e Deadpool, texto do e-mail em `:584`) — risco que exige decisão (§9) |
| F8 | Existe um segundo escritor de `(parent_project_id, version_number)`: `createProjectFromSpec` com `parentProjectId`, numerando por **contagem** da árvore e pendurando no avô | `services/projectCreation.ts:115-132`, `:215-218`; entrada em `routes/specs.ts:626-632, 920` | O índice de versão afeta também `POST /api/specs`; tratar `23505` ali como 409 |
| F9 | A regra de "versão corrente do serviço" (HEAD) já existe, mas inline: aceita e sem `superseded_by`; senão a mais nova aceita | `routes/projects.ts:1072-1077` | Extrair para `services/lineage.ts` como `resolveLineageHead` e usar no claim |
| F10 | A supersessão do pai é **adiada** quando o push falha (`evolution_push_pending`) | `services/evolutionAccept.ts:281-288`; `supersedeParent` `:122-137` | Há janela (possivelmente longa) com filho `accepted` e pai ainda `accepted` sem `superseded_by`; o guard atual (`projects.ts:3444-3467`) deixa evoluir o pai de novo ⇒ dois `vN` "aceitáveis". O HEAD tem de considerar o filho aceito |
| F11 | `gitLinkProjectFolder` e `checkoutNewBranch` são reexecutáveis (`git init` em repo existente, `remote remove/add`, `fetch --depth=1` + `checkout -B` + `reset --hard origin/dev`) | `services/githubPush.ts:263-273`, `:285-306`, `:308-360` | O passo de código é idempotente **enquanto o filho estiver `materializing`** (o `reset --hard` destruiria trabalho depois) |
| F12 | `materializeTicketIntoSpecTree` faz upsert por `(project_id, rel_dir, filename)`; `inheritTriages` usa `NOT EXISTS` | `services/tickets.ts:190-212`; `services/findingTriage.ts:~1045-1052` | Ambos são idempotentes; o `INSERT` de `project_spec_files` do `/evolve` (`projects.ts:3566-3570`) **não** é (sem `ON CONFLICT`) |
| F13 | "Minhas SPECs", `/run` e `/promote` usam **lista de permissão** de status | `routes/specs.ts:39` + `:485-507`; `routes/pipeline.ts:63-72`; `services/promotability.ts:67, 169` | `card_draft`/`materializing` ficam fora deles **por construção** |
| F14 | Vários leitores usam **lista de negação** (`status <> 'archived'`) ou nenhum filtro | `routes/projects.ts:151, 181, 211`; `routes/dashboard.ts:142, 284, 409`; `services/productNormalizer.ts:200`; `services/productContext.ts:167`; `services/productLifecycle.ts:93`; `routes/products.ts:1563, 1696`; `services/productDecomposer.ts:96`; `services/productTraceability.ts:263` | Estes 14 pontos verão `card_draft`/`materializing` e precisam de filtro explícito (inventário [STF] em 2.1) |
| F15 | `deriveProductLifecycle` cai no fallback `running` para status não mapeados | `services/productLifecycle.ts:27-33, 63-69` | `card_draft` misturado a `accepted` viraria `running`. Observação lateral `[inferido]`: `['archived','accepted']` (v1 superada + v2 aceita) também cai em `running` hoje, porque a consulta de `:92-95` não exclui `archived` |
| F16 | O leitor de configuração por tenant já existe: `readRuntimeNumber(db, key, tenantId, {min,max})`, override do tenant vence o global | `services/runtimeTunables.ts:20-48`; uso em `routes/specChat.ts:2644-2647` (tenant do recurso primeiro) | A flag é um número `0/1` lido por esse helper; nenhum leitor novo |
| F17 | `PUT /api/admin/runtime-config/:key` aceita `tenant_admin` gravando o override do **próprio** tenant, para qualquer chave de `CONFIG_KEYS` | `routes/runtimeConfig.ts:23-44`, `:139-170` | Se `CARDS_BANCADA` entrar em `CONFIG_KEYS` sem restrição, o cliente liga o rollout sozinho (§9) |
| F18 | O planner de RFC exige `extra.evolution === true` e usa `extra.evolution_parent_id ?? parent_project_id` para o charter e o mapa do repositório (fallback no `apps/` do pai) | `services/evolutionPlanner.ts:115-121`, `:148-159` | O rascunho do card reusa o planner apontando `evolution_parent_id` para o HEAD; só a leitura dos **arquivos** de spec precisa de fallback para o HEAD |
| F19 | O DELETE de projeto recusa só `running`; arquivar/apagar reabre os tickets | `routes/projects.ts:3011, 3033-3034, 3048-3050` | Apagar um filho `materializing` no meio da cópia deixaria disco órfão: recusar `materializing` com claim vigente |
| F20 | Precedente de advisory lock transacional: `pg_advisory_xact_lock(hashtext($1))` | `services/credit-ledger.ts:71`; `services/tenantLlmConfig.ts:867` | Reusar o padrão, com espaço de chave separado |

---

## 1. Algoritmo do claim (tarefas 1.1 e 3.5)

### 1.1 Decisão de granularidade do lock: **advisory lock transacional por linhagem (raiz)**

- **Chave:** `pg_advisory_xact_lock(<NS_EVOLVE>, hashtext(<root_id>::text))`, forma de **dois inteiros** (`NS_EVOLVE` = constante, ex.: `7341`). A forma de dois argumentos ocupa um espaço de chaves distinto da forma de um argumento usada em `credit-ledger.ts:71` e `tenantLlmConfig.ts:867`, então não há colisão com os locks por tenant. Colisão de `hashtext` entre duas raízes só causa serialização extra, nunca erro.
- **Por que linhagem e não pai:** o HEAD é propriedade da **linhagem** (muda quando qualquer membro é aceito, F9/F10). Com lock por pai, dois cards (ou um `/evolve` legado e um card) que calculem HEADs diferentes durante a janela de F10 não se serializariam. A raiz é imutável (a cadeia `parent_project_id` só é escrita na criação), então pode ser resolvida **antes** do `BEGIN` com `resolveLineageRoot` (`services/lineage.ts:22-37`).
- **Por que não `SELECT … FOR UPDATE` no pai:** o pai pode estar `archived`/superado e o HEAD ser outro projeto; travar a linha errada não serializa nada.
- **Rede de segurança:** os índices parciais do §3 (o lock reduz a corrida a zero no caminho feliz; o índice garante a invariante mesmo que um escritor esqueça o lock, F8, ou que o aceite concorrente mude o HEAD, F10).
- **Espera:** `SET LOCAL lock_timeout = '5s'` e `SET LOCAL statement_timeout = '15s'` dentro da transação; estouro ⇒ 409 `EVOLUTION_BUSY` com `Retry-After: 2`. `[não verificado em execução]`: que `lock_timeout` interrompe espera de advisory lock; se o teste mostrar que não, trocar por laço de `pg_try_advisory_xact_lock` com teto de 5 s.

### 1.2 Transação curta (claim)

Entrada: `parentId` (legado) **ou** `draftProjectId` (card); `ticketId` opcional; `Idempotency-Key` opcional (só sem ticket).

```text
-- Fora da transação (leituras estáveis, sem efeito):
root   := resolveLineageRoot(parentOrBase)                 -- lineage.ts:22
owner  := resolveBudgetOwner(headCandidate).ownerId        -- llmGuard.ts:171 (terminal, F5)
budget := checkProjectBudgetGate(owner)                    -- llmGuard.ts:775; ver §6
reqSha := sha256(parentId | requestText | workMode)        -- só para Idempotency-Key

BEGIN;                                                     -- READ COMMITTED (padrão)
SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '15s';
SELECT pg_advisory_xact_lock(7341, hashtext($root::text));

-- (a) Idempotência: já existe tentativa viva para esta chave?
--     ticket:  SELECT id, status, extra FROM projects
--              WHERE (extra->>'ticket_id') = $ticket AND status NOT IN ('failed','archived');
--     chave:   SELECT ... WHERE tenant_id = $tenant AND (extra->>'evolve_idempotency_key') = $key
--              AND status NOT IN ('failed','archived');
--     encontrado ⇒ ROLLBACK e responder conforme §2 (200/409/resume).

-- (b) Ticket (se houver), travado:
SELECT * FROM tickets WHERE id = $ticket FOR UPDATE;
--     status <> 'open' ⇒ ROLLBACK; 409 TICKET_ALREADY_PROMOTED {childProjectId} (contrato atual, projects.ts:3428-3434)
--     card: card_state <> 'ready' ⇒ ROLLBACK; 409 CARD_NOT_READY

-- (c) HEAD corrente, sob o lock:
head := resolveLineageHead(root)
--   = a de maior version_number entre status='accepted' e COALESCE(extra->>'superseded_by','')=''
--     QUE NÃO TENHA filho 'accepted' (fecha a janela de F10); senão 409 NO_ACCEPTED_HEAD.
--   legado: parentId <> head.id ⇒ 409 PARENT_SUPERSEDED {currentProjectId: head.id} (código atual, projects.ts:3462-3466)
--   card:   card_ready.base_head_project_id <> head.id ⇒ 409 CARD_BASE_STALE (§5.4)

-- (d) Guard "um filho vivo por serviço" (mesma semântica de projects.ts:3444-3457):
SELECT id, status, version_number FROM projects
 WHERE parent_project_id = head.id AND status NOT IN ('accepted','archived','failed')
 ORDER BY created_at DESC LIMIT 1;
--   encontrado ⇒ ROLLBACK; 409 EVOLUTION_IN_FLIGHT {childProjectId}  (inclui 'materializing')

-- (e) Versão contra o HEAD (compatível com projects.ts:3469):
v := head.version_number + 1

-- (f) INSERT do filho em 'materializing':
INSERT INTO projects (tenant_id, created_by, title, status, product_id, parent_project_id,
                      version_number, budget_owner_project_id, extra, complexity_hint, updated_at)
VALUES ($tenant, $user, $title_vN, 'materializing', $product, head.id, v, $owner,
        $extra || jsonb_build_object('materialization', jsonb_build_object(
            'claim_id', $claimUuid, 'lease_owner', $claimUuid,
            'lease_until', now() + interval '10 minutes', 'attempt', 1,
            'head_project_id', head.id, 'steps', '{}'::jsonb)),
        $cx, now())
RETURNING id;
--   23505 (índice do §3) ⇒ ROLLBACK; reler (a)/(d) e responder 409 (corrida perdida)

-- (g) CAS do ticket (defesa em profundidade; com o FOR UPDATE de (b) não falha):
UPDATE tickets
   SET status = 'promoted', child_project_id = $child, promoted_at = now(), updated_at = now()
       [, card_state = 'promoted']                         -- só se card_state IS NOT NULL
 WHERE id = $ticket AND status = 'open' [AND card_state = 'ready']
RETURNING id;
--   rowCount 0 ⇒ ROLLBACK; 409 TICKET_ALREADY_PROMOTED

-- (h) Auditoria do card (se houver): INSERT INTO ticket_card_events (... 'ready' → 'promoted' ...)
COMMIT;
client.release();      -- F4: a conexão é devolvida ANTES dos passos lentos
```

O `UPDATE tickets` deixa de ser o último passo (hoje `projects.ts:3660-3663`, sem `AND status='open'`): ele entra **no claim**, junto do `INSERT`. Isso fecha os dois cenários de F (b): "dupla" (3 filhos para 1 ticket) e "perdida" (PATCH `rejected` atropelado). O PATCH da 1.4 passa a ser `UPDATE … WHERE id=$1 AND status=$esperado`; ele espera o `FOR UPDATE` do claim e, depois do commit, encontra `promoted` ⇒ 409.

### 1.3 Passos fora da transação (idempotentes, marcados em `extra.materialization.steps`)

Cada passo começa por **renovar o lease** com CAS e termina gravando o marcador. Nenhum passo roda se o CAS falhar (outro executor assumiu, ou o filho saiu de `materializing`).

```sql
-- renovar/assumir (executor $me):
UPDATE projects
   SET extra = jsonb_set(jsonb_set(extra, '{materialization,lease_until}', to_jsonb(now() + interval '10 minutes')),
                         '{materialization,lease_owner}', to_jsonb($me::text)),
       updated_at = now()
 WHERE id = $child AND status = 'materializing'
   AND (extra->'materialization'->>'lease_owner' = $me
        OR (extra->'materialization'->>'lease_until')::timestamptz < now())
RETURNING extra->'materialization'->'steps' AS steps;
-- 0 linhas ⇒ parar (409 MATERIALIZATION_IN_PROGRESS para quem chamou)
```

| Passo | O que faz | Idempotência | Marcador |
|---|---|---|---|
| S1 `spec_tree` | Copia os arquivos do HEAD (legado: do pai = HEAD) para `UPLOAD_DIR/<child>/…`; no card, copia também os arquivos do rascunho (pedido, RFCs do card, `.md` convertidos), **o card vence** colisão de caminho e o caminho sobreposto sai de `evolution_inherited_spec` (vira delta para o gate) | Escrita em arquivo temporário + `rename`; `INSERT … ON CONFLICT (project_id, rel_dir, filename) DO UPDATE` (mesmo padrão de `services/tickets.ts:190-195`; hoje `projects.ts:3566-3570` não tem `ON CONFLICT`) | `{spec_tree:{files:n, inherited_spec:[{path,sha}], at}}` |
| S2 `code` | `gitLinkProjectFolder` + `checkoutNewBranch('evolution/vN')`; fallback de cópia de `apps/` (`projects.ts:3585-3642`). No card, **repositório obrigatório** (modo branch fixo, D-E4/3.2): sem repo/App ⇒ falha terminal `REPO_REQUIRED` | Reexecutável (F11). Fallback: apagar `apps/` do filho e copiar de novo (seguro só em `materializing`) | `{code:{source:'git-clone'|'disk-copy'|'none', dev_sha, error, at}}` (`dev_sha` = `aligned.head`, `githubPush.ts:301-302`) |
| S3 `ticket` | `materializeTicketIntoSpecTree` (`services/tickets.ts:166-220`) | Upsert (F12) | `{ticket:{files:[…], error}}` |
| S4 `triages` | `inheritTriages(head, child)` (`projects.ts:3672-3678`) | `NOT EXISTS` (F12) | `{triages:{n}}` |
| S5 `dialogue` | Mensagem no diálogo (`projects.ts:3681-3685`) | Pelo marcador (pior caso após crash: mensagem duplicada, cosmética) | `{dialogue:true}` |
| S6 `finalize` | Transação: `UPDATE projects SET status = <status final da 1.7>, extra = extra || {evolution_source…, evolution_inherited_files, evolution_inherited_spec}, extra.materialization.finalized_at = now() WHERE id=$child AND status='materializing' AND extra->'materialization'->>'claim_id'=$claim RETURNING`; `recomputeProductLifecycle(product)` (corrige F §4.1) | CAS por status + `claim_id` | `finalized_at` |

A requisição HTTP continua **síncrona** (claim → S1…S6 → 201), como hoje. O lease de 10 minutos cobre o pior caso: cada comando git tem `timeout: 60_000` (`githubPush.ts:266, 291, 334`) e há no máximo ~8 comandos em S2.

### 1.4 Pontos de falha e retomada

| Crash em | Estado deixado | Retomada | Reconciliador (§7) |
|---|---|---|---|
| C0: antes do `COMMIT` do claim | nada (rollback) | nova requisição recomeça do zero | — |
| C1: após o claim, antes de S1 | filho `materializing`, `steps={}`, ticket `promoted` | repetir a requisição (mesmo `ticketId`/`Idempotency-Key` ou `POST /api/cards/:id/promote`) encontra o filho em (a); lease vencido ⇒ assume e roda S1…S6; lease vigente ⇒ 409 `MATERIALIZATION_IN_PROGRESS` | lease vencido + **sem efeitos** ⇒ limpa (§7, Q1) |
| C2: no meio de S1 | arquivos parciais em disco e/ou linhas parciais | S1 reexecuta inteiro (upsert/`rename`) | com efeitos ⇒ só notifica |
| C3: no meio de S2 (clone) | `.git` parcial | S2 reexecuta; se `git` falhar por estado corrompido, apaga `apps/` e refaz | notifica |
| C4: entre S2 e o marcador | código pronto, marcador ausente | S2 reexecuta (F11) | notifica |
| C5: em S3/S4/S5 | parcial | reexecuta (upsert, `NOT EXISTS`, marcador) | notifica |
| C6: no `finalize` | transação desfeita ou confirmada | desfeita ⇒ reexecuta; confirmada ⇒ nada a fazer | — |
| C7: após o `finalize`, antes da resposta HTTP | filho pronto | repetição ⇒ §2 (409 legado com `childProjectId`; 200 nos caminhos novos) | — |
| Falha **terminal** (ex.: `REPO_REQUIRED`, HEAD sem arquivos legíveis) | — | transação: filho `failed` + `extra.materialization.error`; ticket `promoted → open` (`WHERE child_project_id=$child AND status='promoted'`); card `promoted → blocked` (`blocked_reason='materialization:<código>'`) | — |

Regras associadas: o DELETE (`projects.ts:3011`) passa a recusar `materializing` com lease vigente (409 `MATERIALIZING`); com lease vencido, o DELETE é a limpeza manual. O `/run` já recusa `materializing` (lista de permissão, F13). O watchdog não o adota (`services/watchdog.ts:71`, só marcos de fábrica).

### 1.5 Detectar e curar claims vencidos

- **Vencido:** `status='materializing' AND (extra->'materialization'->>'lease_until')::timestamptz < now() - interval '5 minutes'` (carência além do lease).
- **Sem efeitos:** `steps = '{}'` **e** nenhuma linha em `project_spec_files` do filho **e** `UPLOAD_DIR/<child>` e `PROJECT_FILES_ROOT/<child>` inexistentes (o reconciliador roda dentro da api, que monta os dois volumes).
- **Cura (única ação automática):** numa transação com o lock da linhagem, `UPDATE projects SET status='failed', extra = extra || {materialization:{…, reaped_at, reason:'claim_expired_no_effects'}} WHERE id=$child AND status='materializing' AND <vencido>`, e `UPDATE tickets SET status='open', child_project_id=NULL, promoted_at=NULL[, card_state='ready'] WHERE child_project_id=$child AND status='promoted'`. `failed` sai dos dois índices do §3, então o retry fica livre.
- **Com efeitos:** só notifica; a retomada é humana (repetir a promoção ou o botão "Retomar materialização", que chama o mesmo executor).

---

## 2. Chaves de idempotência e respostas HTTP

| Caminho | Chave | Onde a unicidade vive |
|---|---|---|
| `/evolve` com `ticketId` (legado e card) | `ticket_id` (sem número de tentativa; D-A1) | `tickets.status` (CAS) + índice parcial único `projects ((extra->>'ticket_id')) WHERE … NOT IN ('failed','archived')` + `uq_tickets_child_live` (§3) |
| `/evolve` sem ticket | header `Idempotency-Key` (opcional; UUID do cliente) + `extra.evolve_request_sha` | índice parcial único `projects (tenant_id, (extra->>'evolve_idempotency_key'))` em filhos vivos |
| `POST /api/cards/:id/promote` (3.5) | `ticket_id` do card | idem ao primeiro |
| Sem ticket e sem chave | nenhuma (contrato atual) | o guard de (d) e o índice "um vivo por pai" já tornam a repetição um 409 com `childProjectId` |

| Situação | Legado `/evolve` (flag off, contrato preservado) | Caminhos novos (card, `Idempotency-Key`) |
|---|---|---|
| Primeira execução concluída | 201 (corpo atual, `projects.ts:3689-3701`) | 201 |
| Repetição após sucesso, mesmo ticket | 409 `TICKET_ALREADY_PROMOTED` + `childProjectId` (como hoje, `:3428-3434`) | 200 `{childProjectId, replayed:true}` |
| Repetição após sucesso, mesma `Idempotency-Key` e mesmo `reqSha` | 200 `{childProjectId, replayed:true}` | 200 |
| Mesma `Idempotency-Key`, corpo diferente | 422 `IDEMPOTENCY_KEY_REUSED` | 422 |
| Corrida: outro claim vigente (`materializing`, lease válido) | 409 `EVOLUTION_IN_FLIGHT` + `childProjectId` (código já conhecido pela UI) | 409 `MATERIALIZATION_IN_PROGRESS` + `childProjectId` + `Retry-After` |
| Repetição com o claim vencido (crash) | assume e retoma; 200 `{childProjectId, resumed:true}` | idem |
| Corrida perdida no índice (`23505`) | 409 `EVOLUTION_IN_FLIGHT` (relido) | 409 `MATERIALIZATION_IN_PROGRESS` |
| Ticket recusado/entregue antes do claim | 409 `TICKET_ALREADY_PROMOTED` com o status | 409 `CARD_NOT_READY` / `CARD_REJECTED` |
| HEAD mudou | 409 `PARENT_SUPERSEDED` + `currentProjectId` | 409 `CARD_BASE_STALE` (§5.4) |
| Lock não obtido em 5 s | 409 `EVOLUTION_BUSY` + `Retry-After` | idem |
| Guard nega o orçamento | §6 (422 `BUDGET_REQUIRED` ou 409 `CARD_BUDGET_BLOCKED`) | idem |

Decisão deliberada: os índices de chave **excluem** `failed/archived`. Depois de uma falha terminal, a mesma chave cria nova tentativa (em vez de devolver a falha para sempre). É um desvio consciente da semântica "mesma chave ⇒ mesma resposta"; registrar no contrato da rota.

---

## 3. Unicidade parcial (tarefa 1.2)

### 3.1 DDL exato

```sql
-- (U1) uma versão viva por (pai, número). Falhas e arquivados guardam o número sem bloquear o retry (D-B2).
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_parent_version_live
  ON projects (parent_project_id, version_number)
  WHERE parent_project_id IS NOT NULL
    AND status NOT IN ('failed', 'archived');

-- (U2) um filho de EVOLUÇÃO vivo (não terminal) por pai — mesma semântica do guard de projects.ts:3446.
--      Restrito a extra.evolution='true' para não mudar POST /api/specs com parentProjectId (F8).
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_one_live_evolution_child
  ON projects (parent_project_id)
  WHERE parent_project_id IS NOT NULL
    AND (extra->>'evolution') = 'true'
    AND status NOT IN ('accepted', 'archived', 'failed');

-- (U3) um filho vivo por ticket (chave de idempotência).
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_ticket_live
  ON projects ((extra->>'ticket_id'))
  WHERE (extra->>'ticket_id') IS NOT NULL
    AND status NOT IN ('failed', 'archived');

-- (U4) Idempotency-Key do /evolve sem ticket.
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_evolve_idem_live
  ON projects (tenant_id, (extra->>'evolve_idempotency_key'))
  WHERE (extra->>'evolve_idempotency_key') IS NOT NULL
    AND status NOT IN ('failed', 'archived');

-- (U5) D-L1: ticket aponta para no máximo um filho vivo (o inverso de U3).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_child_live
  ON tickets (child_project_id)
  WHERE child_project_id IS NOT NULL AND status IN ('promoted', 'delivered');
```

Predicados só usam expressões imutáveis (`->>`, comparação de texto), aceitas em índice parcial.

### 3.2 Interação com os status novos

| Status | U1 | U2 | Observação |
|---|---|---|---|
| `materializing` | **entra** | **entra** | a corrida perde no `INSERT` mesmo sem lock |
| `card_draft` | não entra (`parent_project_id IS NULL`, §5.1) | não entra | N rascunhos por serviço, como manda A' |
| `accepted` | entra | não entra | um aceito `vN` impede outro `vN` do mesmo pai (janela F10) |
| `failed`/`archived` | não entra | não entra | retry e arquivamento livres (E: 1 `archived` com número em prod) |

### 3.3 Ordem de criação, sem derrubar a subida

1. **Migration `.sql` 141** (tarefa 1.1): só `ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check` + `ADD CONSTRAINT … CHECK (status IN (<lista da 097>, 'materializing'))`. Superconjunto: nenhum dado existente viola, código antigo continua válido.
2. **Passo de boot em TypeScript** `ensureEvolutionUniqueness(pool)`, chamado em `index.ts` logo após `initDb()` (`:67`), com `.catch` que só loga, como os reapers de `:76-100`. Para cada índice: (a) se já existe em `pg_indexes`, segue; (b) roda a **pré-checagem** do predicado (`SELECT parent_project_id, version_number, count(*) … GROUP BY … HAVING count(*) > 1`, e equivalentes); (c) se limpo, `CREATE UNIQUE INDEX IF NOT EXISTS` **sem** `CONCURRENTLY` (tabelas pequenas: prod tem 62 projetos e 0 tickets, E; o lock `SHARE` dura milissegundos; e `CONCURRENTLY` deixaria índice `INVALID` em falha, que o `IF NOT EXISTS` mascararia); (d) se sujo, **não cria**, loga `ERROR` estruturado e registra achado do reconciliador (`kind='uniqueness_dirty'`). A api sobe; o claim continua protegido pelo advisory lock.
3. **Produção:** E mediu zero duplicatas e zero pais com dois filhos vivos ⇒ os índices nascem no primeiro boot. Repetir a consulta de E no dia do deploy (runbook 6.2).
4. **Bancos de dev/teste:** podem estar sujos (`[não verificado]`, os E2E locais podem ter criado duplicatas); por isso o passo de boot e não o `.sql`.
5. **`POST /api/specs` com `parentProjectId`** (F8): mapear `23505` de U1 para 409 `VERSION_CONFLICT` em `createProjectFromSpec`. Hoje essa corrida gera duplicata silenciosa; passa a ser recusada (mudança de comportamento só em corrida).
6. **Rollback:** `DROP INDEX IF EXISTS …` (índices são removíveis). O código antigo convive com os índices; uma corrida nele vira 500 em vez de duplicata, aceitável durante um rollback.

Os testes `it.fails` de F (a) "N simultâneas ⇒ 1 filho" e "nunca dois filhos com o mesmo `(parent, version)`" passam a falhar como "esperado falhar, passou" e viram testes normais.

---

## 4. Máquina de estados do card (`tickets.card_state`, tarefas 2.1 e 2.4)

### 4.1 Estados e transições válidas

Estados (plano 2.4): `draft`, `refining`, `ready`, `promoted`, `in_factory`, `delivered`, `blocked`, `rejected`. `NULL` = ticket legado, fora da máquina.

| De → Para | Quem dispara | Pré-condição (verificada no `WHERE`) | Efeito em `tickets.status` |
|---|---|---|---|
| `∅ → draft` | humano (`POST /api/products/:id/cards`) ou backfill ao ligar a flag (`open→draft`) | flag do tenant ligada | `open` |
| `draft → refining` | sistema, na 1ª escrita na spec do rascunho (chat, GAPs, edição, planner de RFC) | `card_state='draft'` | `open` |
| `draft/refining → ready` | sistema, ao fim de "Validar" com veredito OK: gate de RFC invariante + exigências do tipo (3.4) + orçamento (§6) + base registrada (§5.4) | spec do rascunho = `card_ready.draft_spec_hash` | `open` |
| `ready → refining` | sistema: qualquer escrita na spec do rascunho, ou `CARD_BASE_STALE` detectado | `card_state='ready'` | `open` |
| `ready → promoted` | humano (`POST /api/cards/:id/promote`) — **dentro do claim** (§1.2 g) | `card_state='ready' AND status='open'` | `promoted` |
| `promoted → in_factory` | sistema, quando o filho entra em status de fábrica (`/run` aceito) | filho fora de `draft/spec_submitted/materializing` | `promoted` |
| `promoted/in_factory → blocked` | sistema: falha terminal da materialização; Guard nega (§6); filho `failed`; `stopped` com `stopped_by='budget'` | `blocked_reason` obrigatório | `promoted` |
| `blocked → in_factory` | humano retoma (`/run`) e o filho volta à fábrica | filho vivo | `promoted` |
| `blocked/promoted → ready` | sistema, quando o filho é descartado (DELETE ou arquivamento) via `reopenTicketsOfChild` | `card_state IN ('promoted','blocked','in_factory')` | `open` |
| `in_factory → delivered` | sistema (4.3): filho `accepted` + PR mergeado | ambos comprovados | `delivered` |
| `draft/refining/ready/blocked → rejected` | humano | — | `rejected` |
| `delivered`, `rejected` | terminais | nenhuma saída (o pedido novo vira card novo) | — |

`in_factory → blocked` para `blocked_cyborg`/`needs_spec_input` **não** é automático: esses são esperas humanas legítimas (D-M7); o card mostra o estado derivado do filho e continua `in_factory`.

### 4.2 Função única de transição (idempotente e auditada)

```sql
UPDATE tickets
   SET card_state = $to, status = $legacyStatusFor($to),
       blocked_reason = CASE WHEN $to = 'blocked' THEN $reason ELSE NULL END,
       updated_at = now()
 WHERE id = $id AND card_state = ANY($allowedFrom) [AND status = $expectedLegacy]
RETURNING card_state;
```
- `rowCount=1` ⇒ grava o evento; `rowCount=0` e `card_state` atual = `$to` ⇒ **no-op idempotente** (200, sem evento novo); senão ⇒ 409 `CARD_INVALID_TRANSITION {from, to}`.
- Auditoria (migration 2.1):
```sql
CREATE TABLE IF NOT EXISTS ticket_card_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  from_state TEXT, to_state TEXT NOT NULL,
  actor_kind TEXT NOT NULL,              -- user | system | reconciler | guard | backfill
  actor_id UUID, reason TEXT, child_project_id UUID,
  dedupe_key TEXT,                       -- ex.: claim_id, run_id, request id
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tce_ticket ON ticket_card_events (ticket_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tce_dedupe ON ticket_card_events (ticket_id, to_state, dedupe_key) WHERE dedupe_key IS NOT NULL;
```
  Sem PII: `actor_id` é UUID; `reason` só com códigos e textos do sistema.

### 4.3 Migração *expand* (2.1)

```sql
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS card_state TEXT;
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_card_state_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_card_state_check CHECK (card_state IS NULL OR card_state IN
  ('draft','refining','ready','promoted','in_factory','delivered','blocked','rejected'));
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS blocked_reason TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_origin_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_origin_check CHECK (origin IN ('manual','deadpool_incident','import'));
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS external_ref TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS draft_project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
-- + CHECK de projects com 'card_draft' (DROP/ADD, superconjunto da 141)
-- + ticket_card_events (acima)
```
Índice `uq_tickets_draft ON tickets (draft_project_id) WHERE draft_project_id IS NOT NULL` vai no passo de boot (§3.3), não no `.sql`. `draft_project_id` é proposta minha além do plano (o plano lista `card_state`, `origin`, `external_ref`, `blocked_reason`); sem ela o vínculo card→rascunho ficaria só em JSON.

### 4.4 Coexistência `tickets.status` × `card_state`

| Fase | Fonte de verdade | Regra |
|---|---|---|
| F1' (antes de 2.1) | `status` | transições da 1.4 sobre os 4 valores |
| F2 com flag **off** no tenant | `status`; `card_state` é `NULL` | nenhum caminho escreve `card_state` |
| Flag **on** no tenant | `card_state` para os subestados; `status` é **derivado e escrito no mesmo `UPDATE`** (§4.2): `draft/refining/ready → open`, `promoted/in_factory/blocked → promoted`, `delivered → delivered`, `rejected → rejected` | os leitores antigos continuam corretos por construção |
| Flag desligada depois de ligada | ambos | quem escreve status também escreve `card_state` **sempre que ele não for `NULL`** (a flag governa as portas de entrada, não a consistência dos dados) |
| *Contract* (deploy posterior) | `card_state` | `status` vira derivado/removido após N semanas sem leitor legado |

Comportamento dos 6 pontos que comparam com `open`, com a flag ligada:

| Ponto | Comportamento |
|---|---|
| `routes/projects.ts:3428` (`/evolve` exige `open`) | continua; se `card_state IS NOT NULL` e a flag do tenant está ligada ⇒ 409 `USE_CARD_PROMOTE` (não deixa contornar base e prontidão do card) |
| `routes/tickets.ts:247` (edição só em `open`) | continua válido (`draft/refining/ready` ⇒ `open`); editar em `ready` dispara `ready → refining` |
| `routes/tickets.ts:291` (exclusão só em `open`) | continua; ao excluir, arquiva também o rascunho (`draft_project_id`) |
| `routes/tickets.ts:165` (`INSERT … 'open'`) | caminho legado; o card nasce pela rota nova com `card_state='draft'` e `status='open'` |
| `services/tickets.ts:241` (`reopenTicketsOfChild`) | passa a `WHERE child_project_id=$1 AND status='promoted'` (corrige D-A3: nunca reabre `delivered`) e, se `card_state IS NOT NULL`, `card_state='ready'` |
| portal `projects/[id]/page.tsx:983` (`?status=open`) | inalterado: lista os cards em `draft/refining/ready` como pedidos abertos |

PATCH legado (`routes/tickets.ts:234-282`) com `card_state` não nulo: `status='rejected'` ⇒ transição `→ rejected` pela função única; `status='delivered'` ⇒ 409 `CARD_DELIVERY_IS_AUTOMATIC` (a 4.3 marca); `status='open'` ⇒ só via descarte do filho (409 caso contrário).

---

## 5. `card_draft` (tarefas 2.1, 3.3 e 3.5)

### 5.1 Como o rascunho existe sem versão e sem árvore herdada

Uma linha em `projects` com:
- `status='card_draft'`, **`parent_project_id = NULL`**, **`version_number = 0`** (sentinela; F2 impede `NULL` sem mudar o contrato; um `CHECK (status <> 'card_draft' OR version_number = 0)` documenta a regra), `product_id` = produto do card, `tenant_id` = tenant do produto.
- `budget_owner_project_id` = dono terminal do HEAD (§6).
- `extra = {card: true, ticket_id, ticket_number, ticket_kind, evolution: true, evolution_parent_id: <HEAD>, card_target_root_id: <raiz>, card_base: {…}}`. `evolution: true` e `evolution_parent_id` fazem o planner de RFC funcionar sem mudança de contrato (F18).
- Arquivos: só `tickets/TK-NNNN/request.md`, os RFCs do card em `docs/rfc/` e os anexos convertidos para `.md`. Nenhuma cópia do HEAD, nenhum `apps/`, nenhum clone.

Por que `parent_project_id = NULL`: tira o rascunho, **por construção**, do guard `EVOLUTION_IN_FLIGHT` (`projects.ts:3446`), de `/versions` (`:1059-1069`), da contagem de `createProjectFromSpec` (`projectCreation.ts:125-130`), de `resolveLineageRoot` e dos índices U1/U2. O vínculo com o serviço fica em `tickets.project_id` (já existe, `128_tickets.sql:19`) e em `extra.card_target_root_id`.

Por que a promoção **insere um filho novo** (em vez de converter o rascunho): mantém um único caminho de claim para legado e card (INSERT em `materializing`, como o plano 1.1 descreve); uma falha terminal marca só o filho `failed`, sem tocar o rascunho; o rascunho preserva o histórico do Chat, das validações e das triagens do card. O custo é ter duas linhas por card; o rascunho fica `card_draft` para sempre, travado pela máquina de estados a partir de `promoted`.

### 5.2 O que muda no código (leitura da spec da versão corrente em modo somente leitura)

| Arquivo | Mudança |
|---|---|
| `services/projectStatus.ts` | `card_draft` em `SPEC_EDITABLE_STATUSES` (`:32-38`), fora de `PRE_FACTORY_STATUSES` (`:19-24`) e de `FACTORY_OR_TERMINAL_STATUSES` (`:41-60`). Novo `HIDDEN_FROM_PRODUCT_STATUSES = ['card_draft']` para os leitores de F14. `materializing` fora de todos, exceto do novo conjunto "em andamento" do lifecycle |
| Escritores de spec (`routes/projects.ts:3300-3301`, `routes/evolutionPlan.ts:41, 142`, `routes/specSplit.ts:89`) | além do status, se `extra.card === true`, exigir `card_state IN ('draft','refining','ready')` (409 `CARD_SPEC_LOCKED`); a 1ª escrita faz `draft → refining`, escrita em `ready` faz `ready → refining` |
| `routes/specChat.ts` `loadChatContext` (`:206-319`) | se o projeto é `card_draft`: `current` = arquivos do rascunho (editáveis) **mais** os do HEAD (`extra.evolution_parent_id`) como bloco "BASE SOMENTE LEITURA", com rótulo explícito e o mesmo orçamento de irmãos (`SIBLINGS_BUDGET`); `findings` do próprio rascunho. A aplicação das edições do chat continua restrita aos arquivos do rascunho: um `filePath` do HEAD ⇒ 409 `BASE_READ_ONLY` |
| `services/evolutionPlanner.ts` `buildEvolutionPlanContext` (`:115-186`) | se `card_draft`: `files` = rascunho ∪ HEAD (HEAD só leitura) para `specMarkdown` (`:132-137`), `existingRfcs`/`existingAdrs` e os pisos de numeração (`:162-184`); charter e mapa do repo já caem no pai/HEAD (`:148-159`) |
| `services/projectCreation.ts` | nenhuma mudança funcional para o rascunho (ele não é criado por aqui); só o mapeamento de `23505` (§3.3 item 5) |
| `services/promotability.ts` | o rascunho **não** usa `decidePromotability` de spec (`:163-176`); ganha veredito próprio `decideCardPromotability` com razões `CARD_NOT_READY`, `CARD_RFC_INVALID`, `CARD_KIND_MISMATCH`, `CARD_BUDGET_BLOCKED`, `CARD_BASE_STALE`, `EVOLUTION_IN_FLIGHT` (D-A6) |
| `services/productLifecycle.ts` | a consulta de `:92-95` passa a excluir `card_draft`; `materializing` entra em `IN_PROGRESS` (`:27-33`) |
| "Minhas SPECs" (`routes/specs.ts:39, 485-507`) | nada a fazer: lista de permissão (F13). Teste de contrato para garantir |
| Os 14 leitores de F14 | filtro `status <> ALL(HIDDEN_FROM_PRODUCT_STATUSES)`; inventário fechado por `rg` [STF] e conferido pelo Orquestrador |

### 5.3 O guard `EVOLUTION_IN_FLIGHT` com cards

Continua igual na semântica ("um filho vivo por serviço"), agora calculado contra o **HEAD** dentro do claim (§1.2 d) e garantido por U2. `card_draft` não conta (parent nulo); `materializing` conta. Consequência para A': N cards podem ficar `ready` ao mesmo tempo, mas só um é promovido por vez; os demais recebem 409 `EVOLUTION_IN_FLIGHT` com o filho em voo e ficam `ready`. Quando o filho em voo é aceito, o HEAD muda e os outros cards ficam com base vencida (§5.4).

### 5.4 `CARD_BASE_STALE`

- **Snapshot da base**, gravado no rascunho quando o card chega a `ready`: `extra.card_ready = {draft_spec_hash, base_head_project_id, base_head_version, base_spec_hash, at}`, com `computeCurrentSpecHash` (`services/specValidation.ts:167-188`) para o rascunho e para o HEAD.
- **Detecção na promoção:** fora do lock, recomputa `draft_spec_hash` (diferente ⇒ 409 `CARD_NOT_READY`, e `ready → refining`); dentro do lock, `resolveLineageHead(root).id <> base_head_project_id` ⇒ 409 `CARD_BASE_STALE {expectedHead, currentHead}`. Como uma versão `accepted` não é editável (`accepted` fora de `SPEC_EDITABLE_STATUSES`), o id do HEAD é o sinal principal; `base_spec_hash` é conferido também (custo pequeno) para pegar escrita fora das regras.
- **O que revalidar ("Rebasear card"):** regravar `extra.evolution_parent_id` e `card_base` para o novo HEAD; `ready → refining`; rodar de novo Validar e o gate de RFC, com `files_allowed` conferido contra o mapa do repositório do **novo** HEAD (D-B1 c); exigir revisão humana do RFC (o carimbo anterior vale como invalidado). Nada é reescrito automaticamente no RFC.
- **Repositório:** o `dev_sha` só é conhecido na materialização (S2). Ele é registrado; a divergência entre o mapa usado no RFC e o `dev` do clone fica a cargo do gate de escopo do Dev (`orchestrator/runner.py:504-556`, citado em D-A8). Tornar isso bloqueante é decisão aberta (§9).

---

## 6. Orçamento do filho e do rascunho (tarefa 1.3)

- **Herança (D-E10):** rascunho e filho gravam `budget_owner_project_id = (SELECT COALESCE(h.budget_owner_project_id, h.id) FROM projects h WHERE h.id = <HEAD>)`, isto é, o dono **terminal**, porque `resolveBudgetOwner` só sobe um nível (F5). `budget_usd` do filho fica `NULL` (o saldo é o do dono; `getBudgetSpend` soma por `budget_project_id = dono`, `services/llmGuard.ts:196-207`). Um dono `archived` (versão superada) continua dono: o Guard não confere o status do dono (`:171-193`) `[inferido]`. A coluna tem `ON DELETE SET NULL` (`131:19`): se o dono for apagado, o filho volta a `BUDGET_MISSING` (fail-closed).
- **`PUT /api/projects/:id/budget` a partir do filho** já altera o dono (`routes/llmGuard.ts:115-119`) e retoma a pausa (`:125`), sem mudança.
- **Pré-checagem antes do claim:** `checkProjectBudgetGate(<HEAD>)` (`services/llmGuard.ts:775-795`).
  - dono sem `budget_usd` ⇒ 422 `BUDGET_REQUIRED` (mesma mensagem e código de `routes/specs.ts:816-819`), filho não nasce;
  - `BUDGET_PAUSED`/`BUDGET_INSUFFICIENT` ⇒ card: 409 `CARD_BUDGET_BLOCKED` e `ready → blocked` (`blocked_reason='budget:<código>'`); legado: 409 com o mesmo código do Guard.
- **Negativa durante a vida do card:**
  - no chat/planner do rascunho: o Guard nega a chamada; o card **não** muda de estado (o chat já mostra o erro), apenas registra `blocked_reason` informativo;
  - na fábrica: `pauseForBudget` põe o filho `stopped` + `stopped_by='budget'` (`services/llmGuard.ts:572-576`), nunca `failed`; o card vai a `blocked` com `budget:BUDGET_INSUFFICIENT`; `maybeResumeBudget` (`:590-603`) libera, e o próximo `/run` faz `blocked → in_factory`.
- **Teste de aceite:** filho de evolução com dono de US$ 50 ⇒ `preflight` do filho `allow:true` (inverte o `it.fails` de F (g)); dono esgotado ⇒ card `blocked`, filho nunca `failed`.

---

## 7. Reconciliador (tarefa 1.8)

Worker na api (padrão de `index.ts:76-100`), a cada 5 min, com `pg_try_advisory_lock(7341, 0)` para rodar em uma só instância. **Detecta e notifica**; a única ação é Q1 sem efeitos.

| Id | Achado | Consulta (essência) | Ação |
|---|---|---|---|
| Q1 | Claim vencido | `status='materializing' AND (extra->'materialization'->>'lease_until')::timestamptz < now() - interval '5 minutes'` | sem efeitos (§1.5) ⇒ limpa; com efeitos ⇒ notifica |
| Q2 | Ticket promovido sem filho | `t.status='promoted' AND (t.child_project_id IS NULL OR NOT EXISTS (SELECT 1 FROM projects p WHERE p.id=t.child_project_id))` | notifica |
| Q3 | Filho órfão de ticket (efeito de F (b)) | `p.extra ? 'ticket_id' AND p.status NOT IN ('failed','archived') AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.id=(p.extra->>'ticket_id')::uuid AND t.child_project_id=p.id)` | notifica |
| Q4 | `EVOLUTION_IN_FLIGHT` preso | filho de evolução vivo com `updated_at < now() - interval '3 days'` e status em `blocked_cyborg, stopped, needs_spec_input, blocked_*, draft, spec_submitted` | notifica (D-M7: esperas humanas são legítimas) |
| Q5 | Unicidade violada | as pré-checagens de U1/U2/U3 | notifica (deve dar zero com os índices) |
| Q6 | Divergência `card_state` × `status` | `card_state IS NOT NULL AND status <> legacy(card_state)` | notifica |
| Q7 | Card `promoted/in_factory` com filho `failed/archived`, ou `delivered` com filho não aceito | join `tickets`×`projects` | notifica |
| Q8 | HEAD duplo na linhagem (dois `accepted` sem `superseded_by`, janela F10) | por raiz | notifica (supersessão adiada) |

Persistência e deduplicação:
```sql
CREATE TABLE IF NOT EXISTS evolution_reconciler_findings (
  kind TEXT NOT NULL, subject_id UUID NOT NULL, detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ,
  PRIMARY KEY (kind, subject_id)
);
```
Log estruturado `[reconciler] {"kind","subject","age_s"}` (só ids, sem PII); notificação no diálogo do projeto (`project_dialogue`) e uma linha por achado novo no canal operacional existente (`OPS_NOTIFY_EMAIL`, `services/llmGuard.ts:606`) `[não verificado]` se convém e-mail ou só painel. Achado que some numa varredura recebe `resolved_at`.

---

## 8. Flag por tenant `CARDS_BANCADA` (tarefa 2.5)

- **Leitura:** `readRuntimeNumber(pool, 'CARDS_BANCADA', <tenant do produto>, {min:0, max:1}) === 1` (F16), com o **tenant do recurso** primeiro e o do usuário como reserva (padrão de `routes/specChat.ts:2644-2647`; o `zentriz_admin` não tem `tenantId`). Valor ausente, inválido ou erro de banco ⇒ `null` ⇒ **desligada** (o helper já devolve `null`, `runtimeTunables.ts:30-47`).
- **Semente** (migration, padrão da 133): `INSERT INTO genesis_runtime_config (key, value, description) SELECT 'CARDS_BANCADA','0','…' WHERE NOT EXISTS (… tenant_id IS NULL)`. Ligar para um tenant = linha com `tenant_id`.
- **Edição:** entrada em `CONFIG_KEYS` (`routes/runtimeConfig.ts:23-44`) com `min:0, max:1`. Hoje isso permitiria ao `tenant_admin` ligar a própria flag (F17). Recomendo um campo novo `adminOnly: true` em `CONFIG_KEYS`, que o PUT/DELETE respeitem (decisão no §9).
- **O runner não é afetado:** ele só importa chaves de uma lista fechada (`orchestrator/runner_server.py:601-607`).
- **Leitura pelo portal:** endpoint não administrativo `GET /api/products/:id/cards/capabilities` → `{cardsBancada: boolean}` (o `/api/admin/runtime-config/resolved` é administrativo).
- **O que a flag governa:** só as **portas de entrada** (rotas de card, quadro na Bancada, botão "Evoluir projeto" levando ao quadro). Consistência de dados (dual-write de `card_state`, filtros de `card_draft`, índices) vale sempre.

---

## 9. Riscos e o que NÃO fazer

**Não fazer:**
1. `CREATE UNIQUE INDEX` em `.sql` (F1: derruba o boot); `CREATE INDEX CONCURRENTLY` com `IF NOT EXISTS` (mascara índice `INVALID`).
2. Pôr `git clone`, cópia de árvore ou chamada de rede dentro da transação do claim; segurar o `PoolClient` durante os passos (F4).
3. Usar `evolve:<ticket>:<attempt>` como chave (anula a idempotência, D-A1).
4. Reexecutar S2 fora de `materializing` (o `reset --hard` destrói trabalho, F11).
5. Deixar o reconciliador descartar filho, reabrir card ou "curar" `EVOLUTION_IN_FLIGHT` (D-M7).
6. Backfill de `tickets.status` (`open→draft`) ou qualquer escrita em `status` que fuja dos 4 valores (D-B3).
7. Dar `parent_project_id` ou `version_number > 0` ao `card_draft` (entraria no guard, em `/versions`, nos índices e na contagem de F8).
8. Gravar `budget_owner_project_id = HEAD.id` sem resolver o dono terminal (F5).
9. Marcar o card `failed` por orçamento ou por falha de materialização (é `blocked` com motivo).
10. Usar o `/evolve` legado para promover um card com a flag ligada (contorna base e prontidão: 409 `USE_CARD_PROMOTE`).

**Riscos que exigem decisão do Jean:**
- **R1 — Orçamento compartilhado pausa a produção (F7).** Com D-E10, um card que esgota o saldo pausa também a versão corrente e o Deadpool dela. Opções: (a) aceitar; (b) exigir saldo mínimo livre antes de promover; (c) dono próprio por card (contraria D-E10 "por enquanto"). Recomendo (b) já na 1.3, com o mínimo de `minNextActivityUsd`.
- **R2 — Quem liga `CARDS_BANCADA` (F17).** Recomendo `adminOnly` (só `zentriz_admin`).
- **R3 — Repositório que andou entre RFC e promoção** (§5.4): só registrar o `dev_sha` ou bloquear quando o `dev` mudou nos caminhos de `files_allowed`.
- **R4 — Status final do filho na 1.7** (abaixo): manter `spec_submitted` (compatível com o `/run` de hoje) e ensinar o `/promote`, ou passar a `draft`.
- **R5 — Retry com a mesma `Idempotency-Key` após `failed`** cria nova tentativa (§2).
- **R6 — Ticket legado `open` quando a flag liga:** vira `card_state='draft'` sem rascunho; o rascunho é criado na primeira abertura na Bancada. Prod tem 0 tickets (E), então o risco é só de contrato.

**Riscos técnicos residuais:** a janela F10 continua existindo para o legado com a flag desligada (fechada pelo HEAD com "sem filho aceito" e por U1); o branch remoto `evolution/vN` de uma tentativa `failed` pode colidir no retry com o mesmo número `[não verificado]` (o push só ocorre no aceite, `evolutionAccept.ts:259-261`, mas não conferi se o runner empurra antes); `lock_timeout` sobre advisory lock `[não verificado em execução]`.

---

## 10. Tarefa 1.7 — status coerentes `/evolve` × `/promote` e promoção na Bancada

Desenho (sem mudar o caminho da flag desligada além do necessário):
1. `finalize` (S6) mantém o status final de hoje (`spec_submitted` quando herdou arquivos, `projects.ts:3574-3576`), porque o `/run` legado o aceita (`routes/pipeline.ts:63-72`). (Decisão R4.)
2. `POST /api/projects/:id/promote` (`routes/pipeline.ts:124-145`) aceita `spec_submitted` **se** `extra.evolution === true`; o `UPDATE … AND status = ANY($ok)` passa a conferir `rowCount` (D-L6, hoje `:219-221`): 0 ⇒ 409 idempotente.
3. `evaluateProjectPromotability` (`services/promotability.ts:233`) ganha o ramo de evolução: status aceitos `{draft, spec_submitted}`; **Normalizar não se aplica** (o RFC é o documento de decisão, D-A6); prontidão = `evaluateEvolutionGate` + `checkSpecValidationGate` + `checkProjectBudgetGate`.
4. Portal: para filho de evolução, o botão chama `POST /api/projects/:id/promote`, nunca `POST /api/products/:id/promote` (`apps/genesis-web/app/(dashboard)/spec/page.tsx:3528-3535`), porque o produto de um serviço já aceito nunca está em `draft` (`routes/products.ts:1333-1340`).
5. O `/evolve` chama `recomputeProductLifecycle` no `finalize` (F §4.1).
Aceite: os `it.fails` de F (d) e (h) viram normais.

---

## 11. Ordem de implementação, dependências e testes de aceite

| Ordem | Tarefa | Depende de | Entregáveis | Testes de aceite (Postgres real, helpers de F: `raceN`, `queryGate`, `seedAcceptedProduct`, `seedTicket`) |
|---|---|---|---|---|
| 1 | **1.1a** migration 141 (CHECK + `materializing`); `resolveLineageHead` em `lineage.ts`; executor `materializeEvolution` (S1–S6) | F0' | — | unidade de `resolveLineageHead` (linhagens v1→v2→v3, push pendente F10) |
| 2 | **1.1b** claim no `/evolve` (legado), lease, mapeamento de 409/200 | 1 | — | **corrida:** `raceN(8)` com e sem barreira ⇒ exatamente 1 filho, as demais 409 `EVOLUTION_IN_FLIGHT`; **ticket dupla/perdida** (F b, b') ⇒ 1 filho, PATCH vence ou perde com 409, nunca filho para pedido recusado; **crash** injetado (exceção forçada) após o claim e após cada S1…S6 ⇒ repetição retoma e termina com 1 filho e arquivos íntegros; **repetição** após sucesso ⇒ 409 legado com `childProjectId`; `Idempotency-Key` ⇒ 200 `replayed`; chave com corpo diferente ⇒ 422 |
| 3 | **1.2** `ensureEvolutionUniqueness` no boot (U1–U5) + `23505` em `POST /api/specs` | 2 | — | banco sujo (duplicata semeada) ⇒ api sobe, índice ausente, achado `uniqueness_dirty`; banco limpo ⇒ índices criados; reexecução no-op; retry após `failed` e após `archived` funciona; `INSERT` direto de duplicata ⇒ `23505` |
| 4 | **1.3** orçamento (dono terminal, pré-checagem) | 2 | — | F (g) invertido; dono sem orçamento ⇒ 422 sem filho; dono esgotado ⇒ 409, filho não nasce |
| 5 | **1.4** transições de ticket + `reopenTicketsOfChild` guardado | 2 | — | matriz exaustiva de F (f) |
| 6 | **1.7** status coerentes | 2 | — | F (d), (h) invertidos; `/promote` repetido ⇒ idempotente |
| 7 | **1.8** reconciliador | 2, 3 | — | um caso por Q1…Q8; Q1 sem efeitos limpa e reabre o ticket; com efeitos só notifica; segunda instância não roda (try-lock) |
| 8 | **2.1** migration expand (`card_state`, `origin`, `external_ref`, `blocked_reason`, `draft_project_id`, `ticket_card_events`, CHECK com `card_draft`) + `uq_tickets_draft` no boot + filtros dos 14 leitores de F14 | F1' | — | migration idempotente (aplicar duas vezes); suíte de regressão do fluxo atual inalterada; teste de contrato por conjunto de status (`projectStatus.ts`) e por leitor de F14 com um `card_draft` semeado |
| 9 | **2.4** função única de transição + auditoria | 8 | — | todas as transições válidas e inválidas (tabela §4.1), repetição ⇒ no-op sem evento duplicado, dual-write consistente |
| 10 | **2.5** flag (`CONFIG_KEYS`, semente, capabilities, backfill ao ligar) | 9 | — | flag off ⇒ regressão verde e rotas de card 404/403; on/off/on por tenant sem perda; outro tenant não afetado |
| 11 | **3.3/3.5** rascunho, leitura da base, promoção do card | 9, 10, 1.1 | — | nenhum clone/versão antes da promoção (disco e banco); N cards `ready` ⇒ 1 promovido, demais 409; HEAD muda ⇒ `CARD_BASE_STALE`; rebase + revalidação ⇒ promove |

Cada `it.fails`/`xfail` de F é removido quando a tarefa correspondente o faz passar. Regressão com a flag desligada: a suíte atual do `/evolve` (`routes/projects.evolve-ticket.test.ts`) e as reproduções de F rodam nos dois estados da flag.

---

## 12. Lacunas deste desenho

- Nada foi executado; afirmações sobre `lock_timeout` em advisory lock, idempotência do push remoto `evolution/vN` no retry e o caminho CTO assíncrono do chat (`specChat.ts:~1840`) ficam `[não verificado]`.
- Não li o lado Python além de `runner_server.py:571-607` e `agents/llm_guard.py:209-262`; leitores Python de `projects.status` que usem lista de negação não foram inventariados.
- O inventário de F14 saiu de `rg` por padrões (`status <> 'archived'`, `NOT IN (`, `FROM projects WHERE product_id`); pode haver leitores com outro formato. A tarefa 2.1 deve fechá-lo com teste de contrato.
- A observação de F15 sobre `['archived','accepted']` ⇒ `running` é inferida e merece teste próprio.
- O formato do canal de notificação do reconciliador (e-mail × painel) não foi decidido.
