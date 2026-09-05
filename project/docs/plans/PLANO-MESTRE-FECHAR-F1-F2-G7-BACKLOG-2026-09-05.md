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
| **3** | G7: `RAG_ENABLED` declarado nos serviços, produtor de lição na Bancada (LLM), fallback heurístico **removido**, indexer agendado | corpus = 0 confirmado, pgvector presente | `lessons_corpus` > 0 com lições da Bancada; `retrieved_lessons` aparecendo no prompt; embeddings indexados |
| **4** | Backlog: rotas de snapshot + UI, texto do C5, backfill D1 na imagem, `superseded_by` (com OK do Jean), `CLAUDE_MODEL` (só se a medição passar) | medições/`SELECT`s antes | rotas 200 com guarda de tenant; C5 legível; 403 do modelo eliminado ou reportado |
| **5** | Prova ao vivo F1+F2 no LastMile + relatório da auditoria da lei | tudo acima em prod | spec dividida, GAPs caindo por arquivo, custo/rodada medido; relatório entregue |

**Ordem:** 0 → 1 → 2 → 3 → 4 → 5. As ondas 3 e 4 são independentes da 1/2 e podem entrar no mesmo
deploy da onda 2 se estiverem prontas (menos janelas de recreate em prod).

## 4. Rollback (por onda)
- Tags `rollback-<svc>:pre-<onda>-20260905` para os 4 serviços + `.env.bak.pre-<onda>` +
  `docker-compose.yml.bak.pre-<onda>`.
- Toda flag nova nasce **OFF** (`whole`/`off`) → rollback lógico sem redeploy.
- Migrations novas (se houver na onda 2/3) só aditivas; nenhuma coluna removida.
