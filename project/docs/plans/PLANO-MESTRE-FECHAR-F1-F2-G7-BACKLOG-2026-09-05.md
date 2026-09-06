> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Plano mestre — fechar F1 (deploy), F2 (spec por arquivo), G7 (aprendizado) e o backlog

**Data:** 2026-09-05 · **Estado:** pesquisa + adversarial concluídos · execução por ondas
**Regra de execução (Jean):** revalidar **ANTES e DEPOIS de cada tarefa**; nunca ir direto ao código;
prova ao vivo, não health 200. Se o "antes" contradiz a premissa → **PARAR e reportar**.
**Lei que governa tudo:** [§0 do plano F1/F2](EDITS-NO-CTO-E-SPEC-POR-ARQUIVO-F1-F2-2026-09-05.md) —
Genesis/Auto Care são **100% LLM**; código só transporta e veta corrupção.

---

## 1. Inventário — o que falta, com estado MEDIDO (2026-09-05)

| # | Item | Estado medido |
|---|------|---------------|
| 1 | **F1 deploy (flag OFF)** | commit `cbe67c3` em `dev`; prod em `81ada9f`; janela quieta CONFIRMADA (0 job, 0 laço, 0 task, última LLM 17:54Z) |
| 2 | **PR-3** divisão agêntica da spec | inexistente. Em prod **todo projeto tem 1 único arquivo** (`project_spec_files`: 1 linha por projeto, `rel_dir` vazio, `is_primary=t`) |
| 3 | **PR-4** Resolver GAPs por arquivo | bloqueado por `specChat.ts:732` (400) + gate de path do envelope |
| 4 | **PR-5** fila de arquivos no laço autônomo | inexistente (`spec_autonomy_runs` só conhece o primário) |
| 5 | **G7** aprendizado | `RAG_ENABLED` **AUSENTE nos 4 containers** de prod (api/agents/runner/cyborg) → extractor em modo `off`; `lessons_corpus` = **0**; `lessons_embeddings` = **0**; único produtor é o Cyborg (`zentriz_cyborg.py:1080/1114`, no accept/reject) — **a Bancada não produz lição nenhuma**; `lessons_indexer` só roda por **CLI** (sem scheduler) |
| 6 | UI de snapshots | `listSpecSnapshots`/`getSpecSnapshotContent` existem em `services/specSnapshots.ts`; **nenhuma rota** os expõe |
| 7 | Texto do check **C5** do certificado | `✅` exibindo "14 avisos sem ack" |
| 8 | Backfill D1 na imagem | script foi por `docker cp`, morreu no recreate |
| 9 | `superseded_by` das 9 versões do OrienteMe | UPDATE de dados em prod |
| 10 | `CLAUDE_MODEL=us.anthropic.claude-opus-4-8` no `.env` de prod | 403 na conta 820 → fallback `sonnet-4-6` queima 1 chamada por rodada |
| 11 | Prova ao vivo do F1+F2 | dividir a spec do LastMile (98k) e medir `output_tokens`/rodada |
| 12 | Auditoria "100% LLM" do código existente | não iniciada (candidatos já vistos: `lesson_extractor` com **fallback heurístico**, `_file_kind` por mapa de nomes, `MIN_SHRINK_RATIO`, fingerprint de findings) |

### Pesquisa nova que muda o desenho
- **O padrão de "propor → humano aprova → executar" já existe:** `POST /api/products/propose`
  (`services/productProposals.ts`) chama `/invoke/product_architect/async` no agents
  (`agents/server.py:545-616`), persiste a proposta e só depois `decomposeProduct` executa.
  → O PR-3 **copia esse padrão**, não inventa um novo.
- **O fan-out agêntico já existe:** `split_document` faz PASSO 1 (arquiteto) + PASSO 2
  (`_generate_project_files`, 1 chamada por projeto, `ThreadPoolExecutor`, `SPLITTER_FANOUT`,
  retry 1×, warnings ao humano) e o LLM já emite `files:{nome: conteúdo}` temáticos.
- **A escrita por arquivo já é segura:** `routes/specFiles.ts` grava no DISCO (`resolvePhysical`,
  containment) + linha em `project_spec_files` (`content_sha256`, `spec_dirty_at`), com If-Match,
  tetos 200 arquivos / 256 KB, `guardWrite` (svc runner → 403).

---

## 2. Adversarial — o que quebra em cada onda (e a mitigação)

### Onda 0 — deploy do F1 com a flag OFF
- **A0.1 🔴 recriar `api` derruba `agents`** (família do achado #28): `up -d api` recria dependências e
  corta chamada LLM em voo. → janela quieta já confirmada + `--no-deps` e ordem api→agents→runner→cyborg.
- **A0.2 🟡 4 imagens, não 1:** `envelope.py`/`runtime.py` vivem em `applications/orchestrator/`, copiado
  por **agents, runner e cyborg**. Deployar só a api = PR-0/PR-1 **não chegam ao ar**. `genesis-web` não mudou.
- **A0.3 🟡 o compose de prod ganha a linha nova** `SPEC_CTO_EDIT_FORMAT=${…:-whole}` pelo merge; prod
  não tem modificação local rastreada (verificado) → `merge --ff-only` é seguro.
- **A0.4 🟢 sem migration** nesta onda (091/092 já estão aplicadas).
- **Prova depois:** digest dos 4 containers == o que foi pushado; `ctoEditFormatEnabled()` → `false` no
  container da api; `validate_response_quality` aceitando artefato `edits` DENTRO do container do agents;
  prompt sem a seção "EDIÇÕES CIRÚRGICAS" (byte-idêntico ao legado); `/health` 200 e `/spec` 200.

### Onda 1 — PR-3 (divisão agêntica da spec)
- **A1.1 🔴 custo do fan-out:** mandar a spec inteira (98k ≈ 25k tokens) para cada um dos N redatores =
  N×25k de ENTRADA. Com N=8, ~200k tokens de entrada só para dividir. → o redator recebe **apenas as
  seções designadas** + o índice + o propósito do arquivo (o plano do arquiteto já diz quais são).
- **A1.2 🔴 perder a spec original:** dividir substitui o primário. → **snapshot G2 é pré-condição**
  (mesma regra do laço autônomo); o primário passa a ser o **README/índice** (mantém `is_primary=t`,
  então `readPrimarySpec` continua funcionando e nada a jusante quebra).
- **A1.3 🔴 o `spec_hash` muda → validação e triagem:** findings antigos apontam para o arquivo antigo.
  → depois de dividir, **1 revalidação** obrigatória; a triagem por fingerprint é por conteúdo do
  finding (não por path), mas o `file` fica obsoleto → o roteador LLM do PR-4 resolve.
- **A1.4 🟡 tetos do `specFiles`:** 200 arquivos / 256 KB por arquivo / nomes reservados
  (`_RESERVED_FILE_NAMES`, `_FILE_NAME_RE`). → validar o PLANO contra esses limites **antes** de gastar
  as N chamadas (é validação de shape, não decisão de conteúdo).
- **A1.5 🟡 plano inválido (seção órfã/duplicada):** → relatório de cobertura; **veto** só quando uma
  seção da origem não tem destino declarado. Nunca comparação byte a byte (censuraria o redator).
- **A1.6 🟡 timeout:** `split_document` roda em job async no agents; a divisão de 98k com N redatores
  pode passar de 10 min. → job async + poll (padrão `/invoke/product_architect/async`).
- **A1.7 🟢 idempotência:** rodar duas vezes duplicaria arquivos → `dry_run` primeiro e `apply` só com
  o plano aprovado (hash do plano + `base_spec_sha` conferidos no apply).

### Onda 2 — PR-4 (Resolver GAPs escopado) + PR-5 (fila)
- **A2.1 🔴 gate de path do envelope:** `_required_path_prefixes_for_mode` (`envelope.py:721-744`) exige
  `docs/spec/PRODUCT_SPEC.md` para CTO+`spec_intake_and_normalize` → em modo escopado o artefato tem
  outro path e o run **sempre** dá BLOCKED. → prefixo genérico `docs/spec/` quando o pedido é escopado
  (campo novo no envelope), preservando o comportamento atual quando não é.
- **A2.2 🔴 B8 — `extractSpecMarkdown` pega o 1º `.md`:** se o CTO devolver o path errado, gravaríamos o
  documento errado no arquivo alvo (perda silenciosa). → casar o path do artefato com o alvo; divergiu = rejeita.
- **A2.3 🔴 rate limit vs. teto de rodadas:** D4 (1 validação/rodada) × D3 (teto 12) = 12 validações/h,
  mas o limite é **4/h por spec**. → validar **quando a fila esvazia** e, no meio, só quando houver
  cota (o laço já trata `RATE_LIMITED` sem morrer). **Isso ajusta o D4 sem violá-lo.**
- **A2.4 🟡 custo:** 12 rodadas de Opus 5 por laço. → G5 já debita `spec_cto` em
  `project_agent_metrics`; manter o cost cap no caminho e registrar o custo por rodada em `rounds`.
- **A2.5 🟡 escrita:** hoje só `writePrimarySpec`. → `writeSpecFile(projectId, path, content)` genérico,
  com snapshot por `file_path` (já suportado pela 092) e `content_sha256` atualizado.
- **A2.6 🟡 concorrência:** índice único da migration 090 = 1 laço por projeto (mantido); a fila é
  interna ao laço.

#### 🔄 REVISÃO DE ROTA DA ONDA 2 (pesquisa de 2026-09-05, ANTES de codar o PR-4)

A pesquisa do código vivo **refutou o desenho acima em dois pontos** e barateou o resto. Registro com a
evidência, porque o desenho refutado teria causado PERDA DE DADOS:

1. **A2.1 e A2.2 estão MORTOS — o PR-4 não passa pelo CTO normalizador.** `specChat.ts:465-470` documenta
   uma revisão adversarial AO VIVO: o modo `spec_intake_and_normalize` é um **normalizador** que REGENERA
   um `PRODUCT_SPEC` completo (Metadados/Visão/FRs/DoD) e **descarta o conteúdo original do arquivo**. Foi
   exatamente por isso que o chat por-arquivo (T4.3) já usa `/invoke/raw` com prompt controlado. Mandar
   `tecnico/dados.md` pelo normalizador o transformaria numa spec inteira: liberar o prefixo de path no
   `envelope.py` só faria esse desastre passar pelo gate. → **o Resolver GAPs por arquivo usa `/invoke/raw`**
   com um system prompt de CTO-editor (resolve os GAPs preservando o resto e devolve o arquivo final).
   Consequência: **zero mudança em `envelope.py`** e `extractSpecMarkdown` (B8) sai do escopo — `/invoke/raw`
   devolve o texto puro, não um envelope com `artifacts[]`.
2. **O roteador LLM de findings é MUITO menor que o previsto: o `file` já vem do validador.**
   `ValidationFinding.file` existe (`specValidation.ts:49-60`) e o Stage B recebe a spec com marcadores
   `===== <rel_dir>/<filename> =====` (`specValidation.ts:406-410`) — ou seja, **a decisão "este GAP é
   deste arquivo" já é tomada por um LLM** em cada validação, de graça. → o PR-4 (a) normaliza a string
   reportada contra os paths reais da árvore (transporte: exato → case-insensitive → basename → sufixo) e
   (b) **só** chama um LLM para os findings que sobram sem arquivo (Stage A global com `file:""`, ou path
   obsoleto de antes da divisão), e **só quando a árvore tem 2+ arquivos** (com 1 arquivo não há decisão
   a tomar). O resultado é persistido na run de validação (migração **094**), então o laço do PR-5 reusa
   sem gastar de novo.
3. **Achado NOVO (defeito de hoje, família G5): `/invoke/raw` é gasto INVISÍVEL.** `recordCtoUsage`
   (`specChatJobs.ts:636-638`) pula `kind='file'` alegando que `call_bedrock_direct` já reporta — mas
   `/invoke/raw` (`agents/server.py:854`) **não passa `usage_project_id`**, e `_report_direct_usage`
   (`runtime.py:1853`) faz `return` sem project_id. Logo **todo o chat por-arquivo nunca foi debitado** em
   `project_agent_metrics`. O PR-4 tornaria isso o caminho PRINCIPAL. → `/invoke/raw` passa a devolver
   `usage` + `stop_reason`; a api debita (idempotente por `task_id`, como no G5) e marca `truncated`.
4. **Achado NOVO (família T1): o chat por-arquivo pode truncar em silêncio.** `buildRawFileRequest` fixa
   `max_tokens: 8000` para arquivos de até 20.000 chars (≈6k tokens só para devolver o arquivo, antes de
   qualquer acréscimo) e `call_bedrock_direct` **não expõe `stop_reason`** ao chamador. → orçamento de
   saída dimensionado pelo tamanho do arquivo (teto 20.000 para não acionar o guard de streaming em
   21.333) e `stop_reason` ponta a ponta.

#### ✅ PR-5 COMO FOI IMPLEMENTADO (migração 095, 2026-09-05)

Decisões travadas na implementação, com o porquê (as três primeiras corrigem o desenho original):

1. **O modo é DERIVADO da árvore, não de flag:** `startRound` conta `project_spec_files` a cada rodada —
   2+ arquivos → fila por arquivo; 1 arquivo → o ciclo da 090 **byte por byte** (o corpo antigo virou
   `startWholeRound`, intocado). Se o humano dividir a spec no meio do laço, a rodada seguinte já entra
   no modo certo; se a árvore voltar a 1 arquivo, o claim regrava `mode='whole'` e limpa `current_file`.
2. **`round` e `passes` são contadores DIFERENTES (A2.3 fechado):** no modo por arquivo `round` conta
   ARQUIVOS revisados (teto próprio `AUTONOMY_MAX_FILE_ROUNDS = 12`) e `passes` conta os ciclos de
   validação — **é `passes` que respeita o `maxRounds` do Jean**. Com 2 arquivos por passe, 12 arquivos
   caberiam em ~6 validações; o limite de 4 validações/h continua respeitado porque a validação só
   dispara **quando a fila esvazia**, e nunca se nada foi aplicado no passe (medir a MESMA spec queimaria
   cota). "Rodada 7/5" deixaria de fazer sentido — daí o rótulo por passe na UI e nas notas do chat.
3. **Falha de ARQUIVO ≠ falha do LAÇO:** truncamento, encolhimento, revisão idêntica, arquivo grande
   demais (`FILE_TOO_LARGE`, teto de 48k chars) ou CTO `BLOCKED` tiram **aquele** arquivo da fila com o
   motivo no log e o laço segue no próximo; **duas seguidas** param (`MAX_FILE_FAILURES = 2` — aí o
   problema é o modelo/serviço, não o arquivo). Já edição humana no arquivo, spec travada e snapshot
   indisponível param na hora: valem para a árvore inteira.
4. **Só 🔴/🟡 vão ao CTO-editor.** A `gapQueue` do `specGapScope` inclui arquivo que só tem `info`; o laço
   usa fila própria (`blockers + warnings > 0`), porque `info` não sustenta rodada e mandá-lo devolveria o
   arquivo inteiro de novo — custo sem mudar o critério de parada.
5. **GAP importante sem arquivo definido não é adivinhado:** fila vazia com `unrouted` importante →
   `stalled` dizendo exatamente isso (o roteador do PR-4 já teve sua chance, 1× por run de validação).
6. **O transporte é reusado, não reimplementado:** `dispatchGapFileJob` (`routes/specChat.ts`) é o MESMO
   caminho do botão "Resolver GAPs deste arquivo" — prompt de CTO-editor, orçamento de saída por tamanho,
   `recordRawUsage`, recusa de `truncated`, job `kind='file'` durável (089). O laço só decide *qual*
   arquivo e *quando*.
7. **Escrita por arquivo com a mesma rede de segurança:** `writeSpecFile` (ex-`writePrimarySpec`) exige o
   snapshot do conteúdo anterior **daquele** `file_path` como pré-condição (G2) — falhar aborta a escrita.

Testes: `specAutonomy.perFile.test.ts` (18) provam fila por risco, escrita cirúrgica (os outros arquivos
ficam byte a byte iguais), **uma** validação por passe, teto por passes, as 4 falhas de arquivo e as 3 de
projeto, e que a árvore de 1 arquivo continua no caminho da 090. Suíte api-node: 1411 passed | 1 skipped.

### Onda 3 — G7 (o Genesis passa a aprender)
- **A3.1 🔴 `RAG_ENABLED` ausente nos 4 containers:** ligar só no `.env` não basta — as envs do agents
  são declaradas no compose. → declarar `RAG_ENABLED=${RAG_ENABLED:-off}` nos serviços e ligar em prod
  explicitamente (mesma lição do G4, que quase desligou o `SPEC_AUTONOMY`).
- **A3.2 🔴 `live` sem indexer = corpus sem retrieval:** `lessons_indexer` só roda por CLI. → ligar
  `live` **e** rodar o indexer (loop no cyborg ou cron), senão `RAG_RETRIEVAL=semantic` não acha nada.
- **A3.3 🔴 a Bancada não tem produtor de lição:** o gancho existe só no Cyborg (accept/reject). → novo
  produtor no fim de cada rodada do CTO/validador (o que aprendeu: GAP resolvido, premissa, recusa) —
  **extração por LLM**, sem heurística.
- **A3.4 🔴 VIOLA A LEI:** `lesson_extractor.py:210` cai numa **heurística** quando o LLM falha
  ("fallback heurística"). → sem LLM, **não extrai** (loga e reporta). Nada de lição inventada por regex
  entrando no corpus que depois vira prompt.
- **A3.5 🟡 custo/embeddings:** Titan V2 (1024 dims, migration 045) por lição. Baixo, mas medir.
- **A3.6 🟡 PII em lição:** lição vira prompt de outros tenants (`learningBundle`). → escopo por tenant
  e sem trecho literal de spec de cliente.

#### ✅ ONDA 3 ENTREGUE E PROVADA EM PROD (2026-09-06) — migração 096

Dois deploys: **produtor** (main `7aaf398`, migração **096**, rollback `pre-g7-20260906`) e **consumidor**
(main `1b9b8d2`, rollback `pre-cagconsumer-20260906`). Flags finais de prod:
`RAG_ENABLED=live RAG_RETRIEVAL=semantic RAG_EMBED_PROVIDER=bedrock CAG_ENABLED=live`.

- **A3.1 ✅** as 4 variáveis (`RAG_ENABLED`, `RAG_RETRIEVAL`, `RAG_EMBED_PROVIDER`, `CAG_ENABLED`) passaram a
  ser declaradas em `agents`/`runner`/`cyborg` no `docker-compose.yml`. A premissa era pior do que o
  previsto: **sem a declaração, todo produtor/consumidor nascia `off` mesmo com o `.env` preenchido.**
- **A3.2 ✅** indexer rodando com **Titan V2** (`amazon.titan-embed-text-v2:0`, 1024 dims): **8/8**
  embeddings indexados, `lessons_index_outbox` drenado a 0. A conta 820 TEM entitlement Titan, apesar de
  `ListFoundationModels` ser negado por IAM.
- **A3.3 ✅** produtor novo: `services/specLearning.ts` + hook no fim do `specChatWorker.tick()`. Episódio =
  run de `spec_autonomy_runs` terminada → relatório **anonimizado** → `/invoke/lesson_extract/async`.
  Claim idempotente (`WHERE learning_kicked_at IS NULL` **antes** do POST) e retry limitado (3).
- **A3.4 ✅** a heurística de `lesson_extractor.py` foi **removida**: sem LLM não extrai. `_veto_leaks`
  recusa vazamento literal.
- **A3.5 ✅ medido:** 8 lições reais (Opus 4.8, `in=6236 out=1211` e `in=7580 out=1338`) + 8 embeddings.
- **A3.6 ✅** `pii_redacted=t`, rótulos "arquivo A/B", `forbidden_terms` de produto/tenant/arquivo —
  **zero** linha do corpus contém NVX/LastMile/ZFactory/`.md`.

**Achado NOVO (o lado que faltava): as lições eram escritas e lidas por NINGUÉM.** Duas causas em
`agents/runtime.py`: (1) o prefixo de CAG só era aplicado dentro de `load_system_prompt_with_skills`,
chamada **apenas pelo `runner.py`** (dev/qa/devops) — o CTO da Bancada entra por `run_agent` e ia direto ao
modelo; (2) a recuperação filtra `project_id = %s::uuid` e a Bancada manda o pseudo-projeto
`project_id="spec_chat"` (default do `run_agent` = `"default"`), que estoura `invalid input syntax for type
uuid`, o `except` engole e devolve **zero lição em silêncio**. Correções: CAG no ramo sem
`system_prompt_override` (**antes** do `calculate_token_budget`), `_cag_project_uuid()` extraindo o UUID real
do `circuit_scope`, `_cag_query_from()` dando um sinal de busca de verdade (pedido humano > validador >
spec, teto 4k) e o log `[CAG/live]` subindo de debug para **INFO** com `lessons=N`. No caminho por-arquivo
(F2), `/invoke/raw` aceita um bloco **`cag` opt-in** — o gate semântico Haiku e o planejador de evolução
não mudam de prompt nem pagam tokens.

**2 defeitos medidos na 1ª rodada em prod (corrigidos, com teste):** `TIMESTAMPTZ` do driver `pg` volta como
`Date` e `String(date)` não é SQL-parseável → a janela de validações não era lida e o material ia **sem os
GAPs de antes/depois** (helper `tsIso()`); e um `404` no kick durante a janela de recreate era **terminal**
(run já reclamada) → retry com contador em `learning_result.attempts`.

**Gate DEPOIS cumprido (4 provas ao vivo):** (1) recuperação real contra o banco de prod = 8 lições,
prefixo de 2.881 chars; (2) ranking semântico muda por query ("IP atrás de proxy" → `0.451 Declarar origem
confiável do IP`); (3) `/invoke/raw` `input_tokens` **28 → 980** com o bloco `cag` (opt-in respeitado);
(4) rodada REAL de CTO (`cto-8191eceb3441`, 70 s, artefato de 9.172 chars) com **1** linha
`[CAG/live] role=CTO … lessons=8` e o artefato reproduzindo as 3 lições recuperadas — vindas de um episódio
de **outro** projeto. Testes: 15 pytest novos (`test_cag_consumer.py`) + 29 do produtor; 487 pytest e
1442 vitest verdes.

### Onda 4 — backlog menor
- **A4.1 🔴 `CLAUDE_MODEL=opus-4-8` (403):** duas memórias divergem sobre o entitlement da conta 820
  (uma diz "só sonnet-4-6", outra diz "Claude 5 no catálogo, validado por `/invoke/raw`").
  → **medir antes de mudar**: `/invoke/raw` com `us.anthropic.claude-opus-5` no agents de prod. Só troco
  o `.env` se a medição passar; senão reporto.
- **A4.2 🔴 `superseded_by` do OrienteMe = UPDATE de dados:** → `SELECT` primeiro, backup da tabela,
  UPDATE por id explícito, confirmação do Jean antes de executar.
- **A4.3 🟡 rotas de snapshot:** expor conteúdo exige guarda de tenant/projeto (padrão `projectAccess`)
  e **nunca** listar conteúdo na listagem (só metadados + rota separada de conteúdo).
- **A4.4 🟢 C5** é texto; **A4.5 🟢 backfill D1** = mover o script para o repo e rodar por `docker exec`
  a partir da imagem (não `docker cp`).

#### ✅ ONDA 4 ENTREGUE E PROVADA EM PROD (2026-09-06) — sem migração

Dois deploys: **api + genesis-web + agents + runner + cyborg** (main `f0ce77e`) e um **fix só de api**
(main `07e3f50`). Rollback: `rollback-<svc>:pre-onda4-20260906` para os 5 serviços. Digests finais em prod:
api `4761ce3b…`, genesis-web `ef72a00b…`, agents `fb5087d2…`, runner `126f9177…`, cyborg `b991e1a1…`;
`/health` 200 `1.4.0-beta`. **Nenhuma migração nesta onda.**

- **A4.1 ✅ (medição REPROVOU a troca do `.env` — e a correção ficou melhor):** `/invoke/raw` no agents de
  prod contra a conta 820 confirmou a memória pessimista: **só `us.anthropic.claude-sonnet-4-6` responde**;
  `opus-4-8` e `opus-5` voltam 403 "not available for this account". Como a condição do plano ("só troco o
  `.env` se a medição passar") **falhou**, o `.env` **não foi tocado** — apontar para baixo esconderia o
  problema e ninguém lembraria de voltar no dia do entitlement. Em vez disso: **cache de negação por TTL**
  em `agents/runtime.py` (`CLAUDE_MODEL_DENY_TTL_SEC`, default **1800 s**, `0` desliga). O 403 não custa
  tokens, mas custava **uma das `CLAUDE_RETRY_ATTEMPTS`** — sob 429 a resiliência da rodada caía de 3 para 2.
  `is_model_unavailable_error` distingue 403 de entitlement de erro de rede/quota (senão um timeout tiraria
  o modelo bom por 30 min) e `preferred_model` faz a rodada **nascer** no fallback — o que também corrige um
  efeito colateral silencioso: o `calculate_token_budget` passa a ser calculado para o modelo REALMENTE usado
  (Opus 64k vs Haiku 8.192). **Prova ao vivo:** duas chamadas `/invoke/raw` pedindo `opus-4-8` → **200** com
  `model_used=sonnet-4-6`, e no log **um único** 403 (1ª chamada), seguido na 2ª de
  `[call_bedrock_direct] Modelo 'us.anthropic.claude-opus-4-8' está marcado como indisponível na conta —
  usando 'us.anthropic.claude-sonnet-4-6' sem tentar de novo`. 10 pytest novos (`test_model_deny_cache.py`).
- **A4.2 ⏸️ CÓDIGO PRONTO, EXECUÇÃO REPRESADA (exige OK do Jean — exigência deste plano):** o `SELECT` foi
  feito e confirma o desenho: 9 projetos OrienteMe **V5…V13**, todos `accepted`, **nenhum** com
  `parent_project_id` ou `extra.superseded_by` → `productContext.ts:168` (que filtra exatamente
  `COALESCE(p.extra->>'superseded_by','')=''`) conta 9 projetos vivos e o CTO recebe nove contextos
  concorrentes da MESMA aplicação. `src/db/link-project-lineage.ts` escreve a **mesma forma de dado** que o
  `evolutionAccept.ts` escreveria (`status=archived` + `extra.superseded_by/at/version` no antecessor;
  `extra.supersedes/lineage_version` no sucessor; `parent_project_id` **não** é tocado, porque não houve
  evolução e inventar essa aresta faria a herança do runner buscar tasks inexistentes). Guardas: DRY-RUN por
  default, cadeia de ids **explícita** na linha de comando, uuid validado, id repetido e cadeia multi-tenant
  recusadas, **backup em `projects_lineage_backup_<stamp>` antes de qualquer UPDATE** + statement de rollback
  impresso, transação única, idempotente. 4 vitest (`linkProjectLineage.test.ts`). **Nada foi alterado no
  banco de produção.**
- **A4.3 ✅** três rotas em `specFiles.ts`: `GET /spec-versions[?path=]` (**só metadados**),
  `GET /spec-versions/:snapshotId` (conteúdo, rota separada) e `POST /spec-versions/:snapshotId/restore`
  (escrita, com o conteúdo VIVO virando versão como **pré-condição** → 503 `SNAPSHOT_FAILED` se o snapshot
  falha, 409 `FILE_GONE`, `unchanged:true` idempotente). Guarda igual à do resto da família
  (`canAccessProjectRow` + `guardWrite`: `svc=runner` 403, status não-editável 409 `SPEC_LOCKED`) e o `PUT
  /spec-file` passou a gravar versão (G2 no caminho humano principal, que era o único write sem rede de
  segurança). **Prova ao vivo na spec NVX LastMile (98k chars):** listagem 200 sem `"content"` e sem
  `/shared/uploads`, outro tenant 404, sem token 401, traversal 400 `BAD_PATH`, PUT gerando versão
  `manual-file-edit`, rota de conteúdo byte a byte igual ao texto pré-PUT, restore 200 devolvendo o arquivo ao
  sha `f0f6d46c…` (e guardando `pre-restore:5ef39e00`), projeto `accepted` 409 `SPEC_LOCKED`, id não-uuid 404,
  `?path=` filtrando 2 versões. 19 vitest.
- **A4.4 ✅** o C5 do certificado deixou de mentir: `blocked` → **`null`** ("não avaliado: N aviso(s) atrás
  dos blockers"), avisos ativos sem ack → **`false`**, e `true` só com "sem avisos" / "dispensado(s) pelo
  force do zentriz_admin (auditado)" / "reconhecido(s) por ack". **Prova:** projeto `e2a1988c` (nível
  `blocked`, 6 blockers ativos) hoje reporta `C5: None — não avaliado: 14 aviso(s) atrás dos blockers`;
  antes exibia `✅` com "14 avisos sem ack" no mesmo card.
- **A4.5 ✅** `dist/db/backfill-venuxx-v2-spec-files.js` viaja **dentro da imagem** e roda por `docker exec`
  (o `docker cp` da 1ª tentativa não sobrevivia ao recreate). Dry-run em prod: "linhas com `file_path`
  relativo: **0** … nada a fazer (idempotente)"; o banco confirma **58 absolutos / 0 relativos**.

**Defeito encontrado PELA prova ao vivo (e corrigido no 2º deploy):** a listagem de versões exibia o nome do
arquivo **físico** do upload (`1785093867177-nvx-lastmile-backend.md`) em vez do nome que o humano vê na
árvore (`nvx-lastmile-backend.md`) — a rota derivava o caminho do disco. Correção: `displayPathMap()` lê
`rel_dir`/`filename` de `project_spec_files` e o caminho físico só sobra como fallback para versão de arquivo
já removido da árvore (2 testes travam os dois casos).

**Achado NOVO para o backlog:** antes do PUT da prova, `project_spec_files.content_sha256` do LastMile estava
**velho** (`8c533806…`) em relação ao arquivo em disco (`f0f6d46c…`) — algum escritor da spec não atualiza a
coluna. Isso afeta `baseSha`/If-Match (409 falso para o humano) e as checagens do certificado. O restore
corrigiu a coluna; a causa segue viva. Some-se aos GAPs abertos: `model_used` NULL no cto/async e
G1/G3/G6/G8 dos GAPs sistêmicos.

**Gate DEPOIS cumprido:** rotas 200 com guarda de tenant ✅ · C5 legível ✅ · 403 do modelo **eliminado do
caminho quente e reportado** ✅ (o entitlement em si é da conta AWS, fora do código). Testes: 1.470 vitest
(123 arquivos) + 10 pytest novos; `tsc --noEmit` limpo. Único item **não** executado: o UPDATE do A4.2.

### Onda 5 — prova ao vivo + auditoria da lei
- **A5.1 🔴 ligar `edits` sem prova = fé:** medir `_edits_applied` e `output_tokens` por rodada contra o
  baseline (≈64k truncado). Se o modelo ignorar o formato e reemitir tudo, a rodada custa igual → medir
  na 1ª rodada e reportar antes de deixar ligado.
- **A5.2 🟡 auditoria:** entrega um RELATÓRIO com os pontos onde o código julga em vez de vetar; correção
  vira plano próprio (não mexer em tudo de uma vez).

---

## 3. Ondas, gates e ordem de execução

Cada onda tem **gate ANTES** (baseline + premissa reconfirmada) e **gate DEPOIS** (prova ao vivo).
Nenhuma onda começa com a anterior sem prova.

| Onda | Entrega | Gate ANTES | Gate DEPOIS |
|------|---------|-----------|-------------|
| **0** | Deploy F1, flag OFF (4 imagens) | janela quieta, testes verdes, digests atuais anotados, rollback tags | digests conferidos, `ctoEditFormatEnabled()=false`, gate `edits` aceito no agents, prompt legado, `/health` 200 |
| **1** | PR-3: `split_spec_into_files` (arquiteto + N redatores), `/invoke/spec_split/async`, `POST /api/projects/:id/spec-split` (dry-run/apply), botão + preview na Bancada | testes verdes, snapshot G2 funcionando, teto de arquivos conhecido | dry-run real no LastMile mostrando o plano + cobertura; apply num projeto de teste; árvore com N arquivos e README primário |
| **2** | PR-4 + PR-5: resolve_gaps por arquivo, prefixo de path, B8, `writeSpecFile`, fila 1-arquivo/rodada, validação quando a fila esvazia | Onda 1 provada; findings com `file` real | rodada escopada real: só o arquivo alvo muda; `output_tokens` < 8k; laço percorre a fila |
| **3 ✅** | G7: `RAG_ENABLED` declarado nos serviços, produtor de lição na Bancada (LLM), fallback heurístico **removido**, indexer rodando, **+ consumidor CAG no `run_agent`/`/invoke/raw`** | corpus = 0 confirmado, pgvector presente | ✅ `lessons_corpus` **0→8** com lições da Bancada; `[CAG/live] lessons=8` no prompt de uma rodada real de CTO; 8/8 embeddings Titan V2 |
| **4 ✅** | Backlog: rotas de snapshot + UI, texto do C5, backfill D1 na imagem, `superseded_by` (⏸️ aguarda OK do Jean), `CLAUDE_MODEL` (medição REPROVOU a troca → cache de negação por TTL) | ✅ medições/`SELECT`s feitos antes | ✅ rotas 200 com guarda de tenant (prova no LastMile de 98k); C5 `None` em projeto `blocked`; um único 403 e as chamadas seguintes nascendo no fallback |
| **5** | Prova ao vivo F1+F2 no LastMile + relatório da auditoria da lei | tudo acima em prod | spec dividida, GAPs caindo por arquivo, custo/rodada medido; relatório entregue |

**Ordem:** 0 → 1 → 2 → 3 → 4 → 5. As ondas 3 e 4 são independentes da 1/2 e podem entrar no mesmo
deploy da onda 2 se estiverem prontas (menos janelas de recreate em prod).

## 4. Rollback (por onda)
- Tags `rollback-<svc>:pre-<onda>-20260905` para os 4 serviços + `.env.bak.pre-<onda>` +
  `docker-compose.yml.bak.pre-<onda>`.
- Toda flag nova nasce **OFF** (`whole`/`off`) → rollback lógico sem redeploy.
- Migrations novas (se houver na onda 2/3) só aditivas; nenhuma coluna removida.
