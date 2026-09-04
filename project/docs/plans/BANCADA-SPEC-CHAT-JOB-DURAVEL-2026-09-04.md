> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Bancada — job de spec-chat durável (estado sobrevive a sair da tela / restart)

**Data:** 2026-09-04 · **Status:** DESENHO v1 (aguarda revisão adversarial; NADA implementado)
**Pedido do Jean:** "quando eu saio da tela e volto o estado se perde, e eu não sei se está realmente
rodando em background ou parou. Realize análises adversariais e corrija isso."

---

## 1. Fatos medidos EM PROD (2026-09-04, projeto `e2a1988c` NVX LastMile)

| # | Fato | Evidência |
|---|------|-----------|
| F1 | Job do spec-chat vive **só em memória** do processo api | `_chatJobs = new Map()` `specChat.ts:62`; nenhuma tabela de job (só `spec_chat_messages`, `evolution_plan_jobs`) |
| F2 | Redis existe no compose mas **é órfão** p/ este caso | sem `depends_on: redis`, sem `REDIS_URL`, sem cliente redis no `package.json` |
| F3 | `jobId` do frontend fica **só no closure** | `let jobId` `page.tsx:1536-1544` (chat) e `:1608-1613` (resolveGaps) — não vai p/ state/ref/URL/storage |
| F4 | Unmount limpa só o `clearInterval` | `page.tsx:1456-1459`; sem AbortController, **sem rota de cancel** |
| F5 | **Não existe** consulta de job por `projectId` | só `GET /api/spec-chat/:jobId` `specChat.ts:628` |
| F6 | Reply do assistente é persistida **lazy dentro do GET** | `specChat.ts:639-645` → sem poll, o turno nunca é gravado |
| F7 | `spec_chat_messages` é **write-only** | só INSERT `specChat.ts:490`; zero SELECT em `api-node/src` |
| F8 | Resultado só existe em estado React | `setSpecMarkdown` `page.tsx:1580`/`:1633`; disco só por ação humana `:1797-1802` |
| F9 | Sem reaper de boot → restart da api evapora jobs | contraste: `evolution_plan_jobs` TEM reaper `evolutionPlanner.ts:528-531` |
| F10 | TTL varre job em 30 min | `setInterval` `specChat.ts:64-69` |
| F11 | Poll do spec-chat **engole 404** | `catch` só `console.warn` `page.tsx:1589-1591`/`:1645-1647` → usuário espera 18 min p/ ver "Tempo esgotado" |
| F12 | **Job órfão CONCLUIU com sucesso e o resultado ficou encalhado** | `cto-35df69b31a82` → `status:"done"`, payload **95.199 bytes**, inalcançável |
| F13 | Agents **não têm rota de cancel/abort** | `openapi.json`: só `/invoke/cto/async` + `/invoke/cto/status/{job_id}` |
| F14 | **`repair=1/2` nas DUAS rodadas com Opus 5** | refuta nota antiga "Opus/Sonnet obedeciam o path" ⇒ duração real > previsto |
| F15 | Poll do browser **derrapa 8s → 16-18s** em aba background | gaps reais nos logs da api; throttling de `setInterval` come o teto de 18 min |
| F16 | Dois CTOs Opus 5 rodando **em paralelo** no mesmo projeto | `cto-35df69b31a82` + `cto-ccded846795f`; nada impede N disparos |
| **F17** | 🔴 **`MAX_MS` (18min) < duração real (~19min): o teto DESCARTA trabalho bom** | `agent_call`: `duration_ms=1137744` (18m58s, 72.519 chars OK) e `duration_ms=1152480` (19m12s, 78.700 chars OK) vs `MAX_MS=1_080_000` `specChat.ts:403` |
| **F18** | 🔴 Repair vem de **falso positivo do detector de truncamento** | `[CTO] Validação de qualidade falhou: ["...contém truncamento — o LLM usou '...'"]`; `<thinking>` mostra o `...` dentro de **exemplo SQL** (`WHERE ...`). Dobra o tempo → causa o estouro de F17 |

**Reenquadramento por F17:** o problema **não é só "sair da tela"**. Quem **fica** na tela também
recebe "Tempo esgotado" enquanto o servidor entregou 78KB de spec correta. As duas rodadas do Jean
foram pagas em Opus 5 e jogadas fora. Isso eleva a prioridade: **o teto deve expirar a ESPERA, nunca
o TRABALHO** (late collect D2.5 deixa de ser refinamento e passa a ser o núcleo do fix).

**Cadeia de falha:** dispara → `jobId` só no closure → sai da tela → poll morre, job segue vivo →
resultado nasce inalcançável (F12) → volta à tela, zero rehidratação (F5) → redispara → segundo
Opus 5 em paralelo (F16). Custo real duplicado, trabalho jogado fora.

---

## 2. Desenho v1

### D1 — Migration `089_spec_chat_jobs.sql`
Próximo número livre confirmado (084–088 ocupadas). Espelha o precedente `082_evolution_plan_jobs.sql`.

```
spec_chat_jobs(
  id uuid PK,                    -- = jobId devolvido ao frontend
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid,
  agents_job_id text,            -- CHAVE: permite recoletar do agents após restart da api
  kind text CHECK IN ('chat','resolve_gaps','file'),
  file_path text,
  status text CHECK IN ('running','done','failed','timeout','interrupted'),
  spec_markdown text,            -- resultado
  reply text,
  error text,
  created_at, updated_at, finished_at
)
índices: (project_id, created_at DESC) · parcial (project_id) WHERE status='running'
```
⚠️ Índice parcial **NÃO-único** (Jean não pediu trava de concorrência nesta rodada).
⚠️ Sem `;` dentro de string literal — gotcha do runner de migrations (split ingênuo).

### D2 — Backend `specChat.ts`: o job deixa de morrer com a requisição
1. **INSERT** no POST (status `running`, com `agents_job_id` assim que o async responde).
2. **UPDATE** em cada transição; ao concluir gravar `spec_markdown` + `reply`.
3. **Persistir a reply no próprio job**, não lazy no GET → mata F6/F7.
4. **`GET /api/spec-chat/in-flight?projectId=&filePath=`** → job `running` mais recente OU `done`
   ainda não coletado. Base da rehidratação.
5. **Late collect (mata F12):** se `status='running'` e há `agents_job_id`, o GET/in-flight reata o
   poll ao agents — inclusive depois de restart da api. O resultado deixa de ser descartável.
6. **Reaper de boot:** `running` → `interrupted` no start (precedente `reapOrphanValidationRuns`
   `index.ts:73-75`) — dá causa ao usuário em vez de silêncio.
7. Map em memória permanece só como cache; **fonte da verdade = Postgres**. TTL de 30 min deixa de
   destruir resultado (a linha no DB sobrevive).

### D3 — Frontend `spec/page.tsx`: rehidratar em vez de esquecer
1. `jobId` para `useRef` + state (sai do closure) — mata F3.
2. **No mount com `editProjectId`:** chamar in-flight. Se `running` → restaurar o banner
   "CTO revisando a spec…" e **reatar o poll**. Se `done` não coletado → oferecer aplicar.
3. Tratar `404/NOT_FOUND/expirado` explicitamente — **copiar o padrão que já existe no mesmo arquivo**
   em `handleEvolvePlan` `page.tsx:1722-1729` (mata F11; a inconsistência é intra-arquivo).
4. **Semear `chatMessages` do histórico** (`spec_chat_messages`, hoje write-only) → o chat deixa de
   nascer vazio ao voltar. Provavelmente é a metade mais visível do "estado se perde".
5. **Poll imune a throttling (F15):** trocar contagem por nº de ticks de `setInterval` por
   *timestamp real* (`Date.now() - startedAt`), senão o teto de 18 min vira 30+ min de relógio em aba
   background — ou expira antes do previsto, conforme a direção do drift.

### D5 — Falso positivo do detector de truncamento (F18) — `orchestrator/envelope.py`
**Bug localizado:** regra 3 (`envelope.py:178-204`) varre linha a linha de `.md` e marca truncamento
se a linha termina em `...` com **≥5 palavras** antes (`envelope.py:202`). A única guarda de código é
`and "```" not in stripped` (`envelope.py:192`) — que exclui **a linha da cerca**, mas **NÃO as linhas
de dentro do bloco**. **Não há rastreio de estado de fence.**
⇒ `UPDATE refresh_tokens SET used = true WHERE ...` dentro de ```sql``` = 7 palavras + termina em `...`
→ reprovado → repair de ~19min em Opus 5 → estoura o `MAX_MS` (F17).
**Fix:** manter um `_in_fence` alternado a cada linha que começa com ` ``` ` e **pular as linhas dentro
da cerca** na regra 3. Baixo risco, alto retorno (elimina a causa do repair mais caro).
⚠️ Este fix é no **Python/agents** ⇒ exige rebuild do container `agents` ⇒ **só com zero run em voo**
(regra `feedback-nao-rebuildar-api-agents-durante-run`).

### D4 — Tetos de tempo
- Medido F14: repair aconteceu nas duas rodadas com Opus 5 ⇒ `MAX_MS` de 18 min está no limite.
  Com D2.5 (late collect) o teto **deixa de ser fatal** — expira a espera do frontend, não o trabalho.
- `runFileChatJob` **não tem `MAX_MS`** (`specChat.ts:368`, `/invoke/raw` 180s) → fica `running` até o
  TTL varrer. Adicionar teto próprio.

---

## 3. GAPs a fechar ANTES de codificar (para a revisão adversarial atacar)

| GAP | Questão aberta |
|-----|----------------|
| G1 | Multi-tenant: in-flight por `projectId` precisa filtrar por `tenant_id`/`installation_id` **fail-closed**? (precedente de vazamento cross-tenant já corrigido nesta base) |
| G2 | `denyCreationForManagement` bloqueia `zentriz_admin` (`specChat.ts:436`) — a rehidratação também deve ser bloqueada, ou só a criação? |
| G3 | Late collect: se DOIS jobs `running` no mesmo projeto (F16), qual o in-flight canônico? Mais recente? Ambos? |
| G4 | `spec_markdown` de 95 KB por job em `text` — crescimento da tabela. Precisa retenção/poda? |
| G5 | Rehidratar e "reatar poll" pode aplicar no editor uma spec que o usuário já editou à mão → **conflito de escrita**. Precisa confirmação em vez de `setSpecMarkdown` cego? |
| G6 | Semear `chatMessages` do DB: quantos turnos? Há mensagens de outros usuários do mesmo tenant (`user_id` existe) — filtrar por usuário? |
| G7 | Reaper marca `interrupted` no boot — mas o job pode estar **vivo nos agents** (agents não reiniciam junto). Marcar `interrupted` seria MENTIRA; deveria tentar late collect antes? |
| G8 | Sem trava de concorrência (escolha do Jean), a UI deve ao menos mostrar "já há job em voo"? |
| G9 | Migration 089 pode colidir com as ondas 4-5 (planejavam 085/086, já ocupadas) — confirmar que nenhuma frente aberta reivindica 089 |
| G10 | O job carrega `specMarkdown` de ENTRADA também; persistir entrada+saída dobra o volume. Precisa? |

---

# PARTE II — DESENHO v2 (pós-revisão adversarial) — **este é o desenho a implementar**

**Status:** duas revisões adversariais independentes concluídas (backend/dados e frontend/UX), com
`arquivo:linha` e medições em PROD. O v1 foi **reprovado em 5 pontos que quebrariam produção**.
O v2 abaixo incorpora as correções. Ordem obrigatória cumprida: pesquisa → adversarial → fechar
GAPs → implementar → validar.

## 4. Veredito das revisões (o que o v1 errava)

| # | Furo do v1 | Evidência | Correção no v2 |
|---|-----------|-----------|----------------|
| A0-1 | `CHECK` de status **sem `'pending'`** → *toda* POST viraria 500 (`23514`) | rota cria `status:"pending"` `specChat.ts:606`; tipo em `:47` | vocabulário ÚNICO memória↔banco: `pending·running·done·error·interrupted·lost`. Nada de `failed`/`timeout` |
| A0-2 | `project_id NOT NULL` mata o fluxo de **spec nova sem projeto** | `specChat.ts:518` aceita null; header `:14-15` documenta | `project_id UUID NULL` |
| A0-3 | in-flight por `projectId` **é vetor cross-tenant** | classe do P0 de `/api/deadpool/*` | fail-closed: `UUID_RE` → `canAccessProjectRow` (helper, 404) → **`AND owner_user_id = $user`** (mantém o invariante S3 de `specChat.ts:636`) |
| A0-4 | reaper de boot `running→interrupted` **destrói o resultado que o plano existe para salvar**; e o precedente citado é o errado | reaper roda ANTES do `listen` (`index.ts:73-83`); `evolutionPlanner` usa `/invoke/raw` **síncrono** (`evolutionPlan.ts:50`) ⇒ reaper cego é correto LÁ; `reapOrphanValidationRuns` (`specValidation.ts:443-449`) copia o padrão em cima de um job **async** ⇒ **é um bug hoje** | reaper **por `kind`**: `file` (síncrono) → `interrupted`; `chat`/`resolve_gaps` **com `agents_job_id`** → NÃO se toca no boot, o **worker** decide (probe-then-decide) |
| A0-5 | "o resultado deixa de ser descartável" é **falso** | `_async_jobs` é dict em memória `server.py:485`; TTL **45 min de `created_at`** `:488-494`; limpeza **lazy** só no dispatch (`:515`,`:607`,`:659`), nunca no `GET /status` | `deadline_at = created_at + 40 min` (nunca prometer mais do que o agente guarda) + coleta por **worker** |
| A1-4 | late collect disparado por request **não** resolve o caso que causou a F12 (o usuário não volta) | — | **worker server-side** (molde `startEvolutionMergeWorker` `evolutionMergeWorker.ts:60-79`), tick 20s. GET/in-flight passam a ser **só leitura** |
| A1-2 | late collect **não idempotente** → histórico duplicado; e a D2.3 do v1 não matava a F6 | `_persisted` é campo em memória `specChat.ts:641-645`; `spec_chat_messages` sem constraint (`041:8-15`). **Medido em prod: 22 `user` × 18 `assistant`** = 4 turnos sem resposta gravada | `job_id UUID` em `spec_chat_messages` + **índice único parcial `(job_id, role)`** |
| A1-3 | sem coluna de "coletado" → `done` velho re-oferecido para sempre; e `PATCH spec-content` **não tem guarda de sha** | `projects.ts:3171-3178` (body só `{specMarkdown,title,startNow}`) vs. `specFiles.ts:207-208` (409) | `collected_at` + in-flight só devolve `collected_at IS NULL`; `base_spec_sha` gravado no envio; **rehidratação NUNCA aplica sozinha** (card Aplicar/Descartar) |
| A1-5 | `MAX_MS` medido de `Date.now()` local → cada reattach dava 18 min novos | `specChat.ts:400`/`:415` | elapsed SEMPRE de `created_at` do banco; encerramento por `deadline_at` no worker |
| A1-6 | 404 dos agents engolido **no servidor** (F11 também é server-side) | `httpGet` rejeita em não-2xx `specs.ts:266-268`; agents 404 `server.py:530-531`; `.catch` só `warn` `specChat.ts:457-460` | 404 (ou 5 falhas seguidas) → **`lost`** terminal com causa |
| A1-8 | `user_id uuid` derruba o dono quando o `sub` não é UUID | `uuidOrNull` `specs.ts:877-881`; `UUID_RE` `specChat.ts:34`/`:488` | **`owner_user_id TEXT NOT NULL`** (igual `082:10`) |
| A1-9 | mensagem do usuário gravada **antes** do job existir (fire-and-forget) → turno órfão | `void persistMessage` `:602` antes do job em `:604-609` | job + mensagem do usuário na **mesma transação**, com `job_id` |
| A2 | `denyCreationForManagement` citado na linha errada; e barra **autoria**, não leitura | real em `specChat.ts:510`; `managementGuard.ts:9-14`; `canAccessProjectRow` já dá `true` p/ `zentriz_admin` (`projectAccess.ts:28`) | G2 fechado: **só o POST** continua 403; rehidratação (leitura) liberada |
| F0-1 | a rehidratação seria **morta pelo reset** `[editProjectId]` e travaria o chat em "CTO revisando…" para sempre | reset `page.tsx:1490-1504` bump `chatSeqRef`; `stopChatPolling` `:1456-1458` **não zera `chatSending`** | rehidratação **dentro do mesmo efeito** `[editProjectId]`, seq capturada **depois** do fetch; `stopChatPolling` passa a zerar `chatSending` |
| F0-2 | `setSpecMarkdown` cego já **clobra edição manual hoje** | `:1580`/`:1633`; editor nunca `readOnly`; PATCH sem If-Match | resultado **rehidratado** vira card "Revisão recuperada → Aplicar/Descartar"; turno **ao vivo** mantém o comportamento atual (zero regressão) |
| F1-5 | statuses novos não existem no frontend → 18 min de silêncio | tipo `:574` só `pending/running/done/error` | `interrupted`/`lost` tratados como terminais com causa (padrão `handleEvolvePlan` `:1713-1717`) |
| F1-7 | semear histórico **muda o contexto do LLM** e pode ressuscitar instrução antiga; e filtrar por `user_id` **apagaria toda resposta do CTO** (reply é gravada sem `userId`, `:644`) | `messages` vão ao servidor `:1526`/`:1540`; `slice(-12)` `specChat.ts:164` | semear **só para exibição** (`seeded:true`) e **nunca** enviar ao CTO; escopo `(project, file_path)`; últimos 40 |
| F1-9 | D3.5 do v1 consertava bug inexistente (o teto **já** é wall-clock `:1558`) | — | trocado por: poll imediato em `visibilitychange`/`focus` + deadline do servidor |
| F1-15 | `setInterval` pode vazar em remonte duplo | `:1554` sobrescreve o ref | guarda `if (chatPollRef.current) return` (padrão `SpecValidationPanel.tsx:142`) |

### GAPs G1–G10 — fechados
G1 fail-closed por projeto **+ dono** (A0-3) · G2 só criação bloqueada (A2) · G3 in-flight = mais
recente não coletado, os outros ficam recuperáveis pelo `job_id` no histórico (A1-2/A1-7) ·
G4/G10 medido em prod (**40 linhas, 144 kB**; projeção ~140 MB/ano comprimido) → **não persistir a
spec de ENTRADA** (só `base_spec_sha`) e nunca `SELECT *` no in-flight · G5 card de confirmação
(F0-2) · G6 read-only, sem `user_id` no filtro, escopo por arquivo (F1-7) · G7 probe-then-decide
(A0-4) · G8 in-flight já entrega o dado → botões desabilitados na volta · G9 **089 confirmado livre**
(última é 088 em `dev` E `main`; 085/086 e 087/088 já aterrissaram).

## 5. Desenho v2 — o que vai ser implementado

**D1 · migration `089_spec_chat_jobs.sql`**
`spec_chat_jobs`: `id UUID PK` (= jobId da rota, gerado no Node) · `project_id UUID NULL REFERENCES
projects(id) ON DELETE CASCADE` · `tenant_id UUID NULL` (relatório/retenção, **nunca** autorização) ·
`owner_user_id TEXT NOT NULL` · `agents_job_id TEXT` · `kind TEXT NOT NULL CHECK (kind IN
('chat','resolve_gaps','file'))` · `file_path TEXT` · `base_sha TEXT` · `base_spec_sha TEXT` ·
`status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','error','interrupted','lost'))` ·
`spec_markdown TEXT` · `reply TEXT` · `error TEXT` · `model_used TEXT` · `poll_errors INT NOT NULL DEFAULT 0` ·
`created_at/updated_at NOT NULL DEFAULT now()` · `started_at/finished_at/collected_at/deadline_at`.
Índices: `(project_id, created_at DESC)`; parcial **não-único** `WHERE status IN ('pending','running')`.
Mais: `ALTER TABLE spec_chat_messages ADD COLUMN IF NOT EXISTS job_id UUID` + `CREATE UNIQUE INDEX
scm_job_role ON spec_chat_messages (job_id, role) WHERE job_id IS NOT NULL`.
⚠️ comentários só em **linha própria** e zero `;` em literal (runner faz split ingênuo); sem `$$`/trigger
⇒ todo UPDATE seta `updated_at = now()` na mão.

**D2 · backend** — job nasce no banco (mesma transação da mensagem do usuário); `agents_job_id`
gravado logo após o dispatch; **`runChatJob` deixa de pollar** (fim do `_timer` por job) — quem coleta
é o `specChatWorker` (tick 20s): probe `/invoke/cto/status`, gate H4 de `specChat.ts:436-445`,
`done`→grava `spec_markdown`/`reply` + insere a resposta no histórico (idempotente pelo índice único),
404→`lost`, `>deadline_at`→`error`. `GET /:jobId` lê o **banco** (Map só como fallback). Novo
`GET /api/spec-chat/in-flight?projectId=&filePath=` (escalares + flags, sem `spec_markdown`) e
`GET /api/spec-chat/history?projectId=&filePath=`. Reaper de boot **por `kind`**.

**D3 · frontend** — rehidratação dentro do efeito `[editProjectId]`; `jobId` em ref; histórico semeado
read-only; resultado recuperado como card; `interrupted`/`lost` explícitos; poll imediato ao voltar o foco.

**D4 · tetos** — `deadline_at` = +40 min (chat) / +5 min (arquivo, hoje sem teto `specChat.ts:368`);
frontend espera até o terminal do servidor.

**D5 · ✅ FEITO** — falso positivo do detector de truncamento (F18) corrigido em `envelope.py`
(`_in_fence`) + 2 testes de regressão em `tests/test_envelope.py`. Provado ao vivo: SQL com `...`
dentro de cerca passa; truncamento em prosa continua reprovando.

## 6. Fora de escopo (documentado, NÃO implementado)
Extraír `useServerJob` e migrar os 5 polls de `page.tsx` (F1-14) · guarda de saída/rascunho local de
edição manual não salva (F0-3) · persistir aba/split/larguras/arquivo ativo (F1-4) · `If-Match` no
`PATCH spec-content` (A1-3 completo) · `BroadcastChannel` multi-aba (F2-19) · durabilidade real no
lado dos **agents** (persistir `_async_jobs`, A0-5 item d) · `checkTenantBudget`/`checkRateLimit` no
POST (A1-7c) · job do fluxo de **criação** sem `projectId` (F1-13) · chip global de job em voo (P2-17).

---

## 7. EXECUÇÃO — o que foi implementado (2026-09-04)

**D1 · migração `089_spec_chat_jobs.sql`** — tabela `spec_chat_jobs` (status inclui `pending`,
`project_id` NULLABLE, índice parcial **não-único**), `spec_chat_messages.job_id` + índice único
parcial `scm_job_role (job_id, role)` (torna a inserção da resposta idempotente). Aplicada no boot
local: `[DB] Migration applied: 089_spec_chat_jobs`. Guardas do runner: 216 testes verdes.

**D2 · backend** — `services/specChatJobs.ts` (ciclo de vida + `judgeCtoResult` compartilhado +
`collectSpecChatJobsTick`), `services/specChatWorker.ts` (tick 20 s, probe `/invoke/cto/status`,
distingue 404→`lost` de falha de rede→`poll_errors`), `routes/specChat.ts` reescrito (job nasce na
mesma transação da mensagem do usuário; `agents_job_id` gravado logo após o dispatch; heartbeat
por tick; `settleJob` grava Map+banco; `GET /:jobId` lê o banco com o Map como fallback; novos
`GET /api/spec-chat/in-flight` e `GET /api/spec-chat/history`, fail-closed em 3 camadas), reaper de
boot **por `kind`** e start/stop do worker em `index.ts`.

**D3 · frontend** (`spec/page.tsx`) — `startChatPolling` passa a ser o **único** laço de poll do
chat (as 3 cópias divergentes eram a razão de só o Evoluir tratar 404/estado terminal); `jobId` em
ref; rehidratação (`in-flight` + `history`) dentro do efeito `[editProjectId]`, com `seq` capturada
depois do fetch e guarda `chatPollRef`; histórico **`seeded`** (exibição, filtrado do payload ao
CTO); resultado recuperado oferecido em **card Aplicar/Descartar** (nunca `setSpecMarkdown` cego);
teto vindo do `deadlineAt` do servidor; tick imediato em `visibilitychange`/`focus`; `aria-live` no
spinner e no card; aviso de job em voo **fora** do gate `specMarkdown !== null` (com o gate, uma
falha no carregamento da spec esconderia todo o estado do job).

**D4 · tetos** — `CHAT_JOB_DEADLINE_MS` 40 min / `FILE_JOB_DEADLINE_MS` 6 min; o 202 devolve
`deadlineAt` → uma fonte só para o teto (o 18 min hardcoded do cliente descartava revisões de
18m58s/19m12s que o CTO havia **concluído**).

### Desvio consciente do desenho (com evidência)
O desenho pedia que `stopChatPolling` também zerasse `chatSending`. **Não foi feito**: nos três
disparadores (`handleChatSend`, `handleResolveGaps`, `handleEvolvePlan`) o `setChatSending(true)`
vem **antes** do `stopChatPolling()`, então zerar lá dentro apagaria o spinner no mesmo lote de
render. O furo real (spinner eterno) foi fechado onde ele existia: todo caminho terminal do
`startChatPolling` passa por `finish()`, que para o timer **e** zera `chatSending`.

### Validação ao vivo (local, stack completa)
1. `POST /api/spec-chat` → 202 com `deadlineAt` (+40 min); linha em `spec_chat_jobs` com
   `agents_job_id=cto-acb5c051ac1d` e a mensagem do usuário já no histórico, ligada ao job.
2. `GET /in-flight` durante a execução → `status:running`, `elapsed`, `deadlineAt`, `recovered:false`.
3. **`docker compose restart api` com o job em voo** → o reaper de boot **não** marcou `interrupted`
   (regra por `kind`: `chat` segue vivo nos agents).
4. `[SpecChatWorker] tick: 1 órfão(s) — 1 coletado(s)` → `status=done`, `spec_markdown` de
   **5.105 caracteres** salvo. É exatamente o trabalho que antes era descartado pelo TTL de 45 min.
5. `GET /in-flight` → `status:done, recovered:true` → `GET /:jobId` devolve a spec e marca coletado →
   `GET /in-flight` volta a `{job:null}` (sem re-oferta).
6. `GET /history` → os 2 turnos em ordem cronológica.
7. Fail-closed: projectId inválido → 400; projeto de outro tenant → 404 (in-flight **e** history);
   job inexistente → 404.
8. Bundle do container web contém `in-flight?projectId`, `spec-chat/history`, o card
   "Revisão recuperada", `visibilitychange` e o filtro `seeded`.

Testes: api-node **1210 passed / 1 skipped** (110 arquivos); `tsc --noEmit` limpo exceto o erro
**pré-existente** e não relacionado em `src/services/tenantLlmConfig.workbench.test.ts:20`.
genesis-web: `tsc --noEmit` limpo; `next lint` sem novo aviso (o de `page.tsx:2069` é anterior).
