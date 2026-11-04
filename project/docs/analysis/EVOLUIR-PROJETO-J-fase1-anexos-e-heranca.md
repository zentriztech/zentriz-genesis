> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO · J — Fase 1' · tarefas 1.5 (anexos) e 1.6 (herança transitiva de tasks)

Branch `evo/f2` (a partir da `dev`), worktree `g-f2`. Sem push, sem deploy, sem LLM real. Duas flags, ambas com padrão `off` e `off` byte-idêntico ao anterior: `ATTACHMENTS_STRICT` e `TASK_INHERIT_TRANSITIVE`.

## 1. Mudanças (arquivo:linha)

### 1.5 — anexos (API, `applications/services/api-node/src`)
- `db/migrations/143_ticket_attachments_kind_and_limits.sql` (última existente era a 140; renumerada para 143 no merge): colunas aditivas `kind` (`legacy|spec_text|card_only`), `origin` (`upload|converted:<id>`), `derived_from_attachment_id`; chaves `ATTACHMENT_MAX_FILES=10`, `ATTACHMENT_MAX_TOTAL_BYTES=20 MiB`, `ATTACHMENT_MAX_FILE_BYTES=10 MiB` em `genesis_runtime_config`, descrição com `calibrado=falso`. Sem `DO $$`, sem `;` em literais.
- `services/ticketAttachments.ts` (novo): `attachmentsStrict`, allowlist por extensão (`.pdf .txt .md .doc .docx`), `contentMismatch` (magic bytes: `%PDF-` nos primeiros 1024 B, OLE2 para `.doc`, ZIP + `[Content_Types].xml` + `word/` para `.docx`, UTF-8 estrito e sem NUL para `txt/md`, recusa binário conhecido disfarçado de texto), `validateAttachments` (devolve todos os problemas, com códigos estáveis), `loadAttachmentLimits` (lê `genesis_runtime_config` com override por tenant; padrão do código só como fallback), `AttachmentUnreadableError`.
- `services/attachmentConversion.ts` (novo): interface `AttachmentConverter`, registro (`registerAttachmentConverter`), `nullConverter` (único registrado), `conversionOrigin()` (`converted:<id>`).
- `services/tickets.ts`: `loadTicketAttachments(.., {extended})` (:108); `runAttachmentConversions` (:183, cria linha derivada com origem marcada se algum conversor produzir markdown; com o nulo não cria nada); `materializeTicketIntoSpecTree` (:222) em modo `on` só leva `txt/md` (e derivados) para `project_spec_files`, recusa com erro explícito `ATTACHMENT_UNREADABLE: <arquivo>` texto ilegível/ausente, e `request.md` ganha a seção "Anexos guardados no card (fora da spec)".
- `routes/tickets.ts`: validação no POST (:164) antes de abrir transação, resposta `400 ATTACHMENT_INVALID` com `errors[]`; INSERT com `kind/origin` só em `on` (:192); detalhe do pedido com `kind/contentSha256/origin/derivedFromAttachmentId` só em `on` (:249); nova listagem `GET /api/projects/:id/ticket-attachments` (:329) com os anexos do card separados da spec, com `downloadUrl` (download já existente).
- `routes/projects.ts:1,3232` (único toque fora de tickets, no handler `GET /spec-files`, não nas partes de `/evolve`/promoção): em `on`, tira da lista as linhas legadas de `tickets/*/anexos` que não sejam `txt/md`.
- `routes/runtimeConfig.ts`: as 3 chaves entram em `CONFIG_KEYS` (editáveis em `/settings/runtime-config`, com faixa).
- Harness: `testing/evolvePg.ts` e `scripts/apply-migrations-test.ts` aceitam também a porta 55441; `buildApp` registra `@fastify/multipart` (mesmos tetos de `app.ts`).

### 1.5(c) / 1.6 — runner (`applications/orchestrator/runner.py`)
- `load_spec_all` (:950), com `SpecReadError` (:923) e `_attachments_strict` (:927): em `on`, filtra por allowlist de texto com aviso (`SPEC_TEXT_EXTENSIONS`, padrão `.md,.markdown,.txt,.json,.csv,.rst,.ts,.js,.tsx,.jsx,.py,.sql,.sh`), e levanta erro explícito se o arquivo for ilegível, se estiver registrado e ausente no disco, ou se todos os arquivos registrados forem não-texto (nunca `""`). O `except SpecReadError: raise` (:1016) impede o `except Exception` genérico de engolir. No caller (:5732) o erro vira `_post_error` + projeto `failed` + `return 1`.
- 1.6: `_task_inherit_transitive` (:3949), `_inherited_task_id` (:3962), `_get_project_version` (:3966), `_inherit_parent_tasks(.., parent_version=None)` (:3979), `_task_inherit_summary_max_tokens` (:4040), `_summarize_inherited_tasks` (:4050), integração no contexto do CTO/PM (:6144).

## 2. Decisões
- **Prefixo de ID: `TSK-INH-V<n>-<ID original sem "TSK-">`** (ex.: `TSK-EVO-001` da v2 vira `TSK-INH-V2-EVO-001`). Justificativa: (i) mantém `TSK-INH-`, então as exclusões já existentes (`startswith("TSK-INH-")` no runner, `NOT LIKE 'TSK-INH-%'` em `projects.ts`/`dashboard.ts`) continuam valendo sem tocar na API; (ii) a versão de origem torna o ID único por versão, o que elimina a colisão no upsert `(project_id, task_id)`; (iii) **não foi preciso mudar o regex `TSK-[A-Z]+-\d+`** (`runner.py` ~3762-3790): IDs herdados são criados pelo runner, nunca parseados do texto do PM, e o regex, por sinal, nem casa `TSK-INH-V2-…` (teste cobre). `task_state.py` não tem regex de ID.
- **Mecanismo transitivo por indução**: o filho herda as tasks próprias do pai (com o prefixo da versão do pai) **e** repassa, com o mesmo ID, as `TSK-INH-V*` que o pai já tinha. Assim v4 contém V1, V2 e V3 sem percorrer a linhagem pela API. Herdadas legadas (`TSK-INH-<resto>` sem versão) seguem como estão (origem desconhecida, não dá para recuperar a versão).
- Sem a versão do pai (API indisponível) o rótulo cai para `VP<8 primeiros do id do pai>`: feio, mas único.
- **Resumo compacto** (`TASK_INHERIT_SUMMARY_MAX_TOKENS`, padrão **1500**, faixa 200–20000, 4 chars/token, **não calibrado**): agrupa por versão, mais nova primeiro, 140 chars por task, corta em fronteira de linha e declara "e mais N task(s) omitida(s)". Em `off` o bloco antigo (40 linhas) é usado.
- **Allowlist de texto do runner** inclui `json/csv/rst` e as extensões de código de referência do ZIP para não regredir árvores existentes; configurável por `SPEC_TEXT_EXTENSIONS`. Arquivo sem extensão é tratado como não-texto.
- Recusa de upload é do **pedido inteiro** (nada de aceitar parte), com todos os problemas na resposta.
- A conversão automática **não** foi implementada. O ponto de extensão está pronto e testado com conversor falso.

## 3. Testes (saídas reais)

Antes (base `dev`, do relatório F): pytest do orquestrador 1145 passaram + 6 xfailed + 23 falhas de ambiente; vitest 3553 passaram.

Depois:
- `pytest -q` em `applications/orchestrator`: **1177 passed, 23 failed, 2 skipped, 0 xfailed**. As 23 falhas são exatamente as de `tests/known-env-failures.txt` (comparado como conjunto; só difere o prefixo do caminho). Os 6 xfail dos defeitos (c) e (e) foram removidos e passam com as flags `on`. Novo `tests/test_attachments_inherit_f2.py`: 16 testes (png/xlsx/pdf/doc/docx fora da árvore com aviso; só-binário e ilegível e ausente ⇒ `SpecReadError`; allowlist configurável; `off` byte-idêntico; v1→v2→v3→v4 sem colisão; idempotência; só DONE/QA_PASS; legado; rótulo sem versão; regex; limite do resumo e env).
- vitest api-node com Postgres efêmero `pgvector/pgvector:pg16` na 55441 (migrações 1→141 aplicadas, container derrubado ao final): suíte completa **3551 passed, 26 skipped**, 4 arquivos de teste falharam por **ambiente** (`llm.reorder`, `llm.role-verify`, `costSource`, `skillFeedback` exigem a porta 55432 hard-coded e não foram adaptados; não tocam código desta frente). Os 2 arquivos que usam `evolvePg` (repro F0 + novo) rodaram com PG: 35 passed. Novos: `services/ticketAttachments.test.ts` (unitário) e `routes/tickets.attachments.pg.integration.test.ts` (9 cenários: `off` idêntico ao anterior; `on` recusa png/xlsx; extensão que mente; tetos vindos de `genesis_runtime_config` com override de tenant; pdf/doc/docx só no card, listáveis e baixáveis, com hash; legado; texto ilegível ⇒ erro; conversor falso ⇒ linha derivada marcada e idempotente; conversor nulo ⇒ nada). `tsc --noEmit` limpo. Os `it.fails` do vitest não incluem os defeitos (c)/(e) (lá eram testes de caracterização verdes), então não havia marcador a remover nesse lado.

## 4. Estado
- **Validado** (testes automáticos): validação/classificação, materialização, listagens, migration 143 (renumerada de 141 no merge, para não colidir com a 141 da frente 1.1), erro explícito do runner, herança transitiva e resumo.
- **Preparado, não ativo**: ambas as flags estão `off` por padrão; nada muda em produção até ligá-las. Nenhum deploy foi feito.
- **Não funcional ainda**: conversão pdf/doc/docx → .md (só o ponto de extensão).
- Não validado de ponta a ponta com o runner real e a API real juntos (sem LLM, sem stack); só fakes e Postgres efêmero.

## 5. Riscos
- `routes/projects.ts` recebeu um import na linha 1 e um bloco no handler `spec-files`: possível conflito textual trivial com g-f1 no merge.
- `ATTACHMENTS_STRICT=on` no runner faz o run falhar (projeto `failed`) quando há arquivo de spec ilegível ou ausente; é o pedido, mas quem tem árvores com arquivos órfãos no disco passará a ver a falha. Ligar com a API e o runner juntos: a flag precisa estar `on` nos dois lados para o efeito completo.
- Limites e teto do resumo são padrões conservadores, **não calibrados**.
- `.docx` é validado por assinatura ZIP + nomes de entrada, não por parse completo; um `.docx` corrompido porém bem assinado entra no card (não afeta a spec).
- Nomes de arquivo duplicados no mesmo card ainda se sobrepõem em disco (comportamento anterior, fora do escopo).

## 6. Fora de escopo / pendente
Conversão automática para `.md`; calibração dos tetos com dados reais; adaptar as 4 suítes `pg.integration` à porta 55441; UI do portal para a nova listagem e para exibir os erros `ATTACHMENT_INVALID`; ligar as flags em homologação.
