> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# F1 + F2 — Matar a causa do truncamento: `edits` no CTO + spec por arquivo

**Data:** 2026-09-05 · **Estado:** pesquisa + adversarial CONCLUÍDOS · **decisões D1–D5 FECHADAS pelo Jean** → em implementação
**Contexto:** a spec do NVX LastMile tem 98.045 chars. O CTO regenera o documento INTEIRO a cada
rodada e bate nos **64.000 tokens de saída** do Opus 5. As guardas T1/T2/G2 (em prod, main `81ada9f`)
fazem o laço **parar** em vez de mutilar — mas a causa segue viva: ele para e **não avança**.
Ver [[genesis-resolver-guardas]] / `memory/genesis-guardas-truncamento-t1t2-g2g4g5-prod-2026-09-05.md`.

Escolha do Jean: **F1 + F2 no mesmo ciclo.**

---

## 0. LEI DE ARQUITETURA (Jean, 2026-09-05) — a inteligência é SEMPRE do LLM

> "Todas as atividades de elaboração e evolução das estruturas e arquivos dos produtos de specs — como
> estrutura de pastas, conteúdo e divisão de arquivos — devem ser feitas por **LLM inteligente**, nunca
> por automações fixas que não pensam."
> "O Genesis e o Auto Care são **100% LLM**, orquestradores de agentes multi-agênticos inteligentes que
> usam LLM para atuar e realizar suas tarefas de forma inteligente."

Isto é uma **lei**, não uma preferência. Consequências operacionais para este plano:

| É do LLM (decisão / elaboração) | É do código (transporte / integridade) |
|---|---|
| Que arquivos existem, seus nomes, pastas e ordem | Gravar bytes no disco (`specFiles.ts`, If-Match, containment) |
| Que conteúdo vai em cada arquivo, o texto de cada seção, o índice, as transições | Aplicar o `search/replace` **que o próprio LLM escreveu** (`edits.py`) |
| Como resolver cada GAP, o que enriquecer, o que dividir | Recusar entrega corrompida/truncada (T1/T2/G2), snapshot, telemetria |
| Para qual arquivo vai um finding | Contar tokens, orçar prompt, medir custo |

**Proibido neste plano:** heurística de código decidindo corte de spec ("dividir a cada 15 KB"),
`fallback` que divide sem LLM, roteamento de finding por regex, geração de conteúdo por template.
Se o LLM não estiver disponível, a ação **falha e reporta** — ela não é executada por um substituto
burro. Guardas de integridade continuam sendo código (elas não decidem conteúdo: elas **vetam
corrupção**), e o `edits` do F1 é transporte — o texto é 100% autoria do LLM.

---

## 1. Pesquisa — o que já existe (medido no código, com `arquivo:linha`)

### 1.1 O teto e o orçamento
- `agents/runtime.py:158-164` — `us.anthropic.claude-opus-5`: context 200.000 / **max_output 64.000**.
  Não é configurável: é limite do modelo.
- `agents/runtime.py:262-277` — o cap de ENTRADA de `spec_raw` **deriva do max_output**
  (`(max_output − 8.000) × 4 × 0,65`): Opus 5 → **145.600 chars**. A spec de 98k **entra inteira**
  hoje (não há clipping); o gargalo é 100% a SAÍDA.
- Consequência aritmética: 98k chars de PT-BR com escaping JSON ≈ 45–50k tokens = **75–78% do teto**
  só para copiar o que não mudou. Não há folga para enriquecer.

### 1.2 O formato `edits` JÁ EXISTE (e está gated para o DEV)
- **Contrato:** `envelope.py:93-104` valida `artifacts[].format:"edits"` com `edits:[{search,replace}]`
  (aditivo: `content` deixa de ser obrigatório nesse artefato).
- **Aplicador:** `orchestrator/edits.py` (110 linhas) — semântica `str_replace`: `search` casa
  **exata e unicamente**; 2º passo tolerante só a CRLF/espaço à direita; preserva EOL; `replace`
  vazio = remoção; **atômico** (devolve `(None, [erros])` com trecho de até 600 chars).
- **Materialização (DEV):** `runner.py:3887-3904` lê o arquivo do disco e aplica os edits **antes do
  gate do runner**. Gated por `EVOLUTION_DEV_EDIT_FORMAT=edits` + `evolution_scope`.
- **Prompt (DEV):** `runtime.py:504-522` injeta a seção "Formato de edição incremental" só para
  `role=DEV`, em evolução, com a flag ON. `runtime.py:458-481` eleva o cap de leitura a 50 KB/arquivo
  dentro do escopo (o modelo precisa VER o arquivo inteiro para escrever um `search` exato).
- **`server.py:335-337`** nunca grava `edits` cru em disco.

### 1.3 A spec inteira JÁ chega ao agents
- `routes/specChat.ts:381-382` → `inputs.spec_raw = specMarkdown` (e `product_spec`, dedupado em
  `runtime.py:376-395`). `runtime.py:300-312` desembrulha o envelope aninhado 2× (bug de 2026-09-05).
- Portanto **`apply_edits(spec_raw, edits)` pode rodar dentro do `run_agent`** — sem porta nova em TS,
  sem mudar o contrato api↔agents, sem mexer na UI: a api continua recebendo `artifacts[0].content`
  com a spec inteira materializada (`routes/specs.ts:190-198 extractSpecMarkdown`).

### 1.4 O que existe de "por arquivo" hoje
- `routes/specFiles.ts` — família completa: `GET spec-tree`, `GET/PUT/POST/DELETE spec-file?path=`,
  com `parseSpecPath` (profundidade ≤ 4), containment `resolvePhysical`, `guardWrite`
  (`svc:"runner"` → 403; status não editável → 409), If-Match por `baseSha` → 409, tetos
  **200 arquivos / 256 KB por arquivo**, `content_sha256` + `spec_dirty_at` na mesma transação.
- **Chat por-arquivo (T4.3)** existe, mas por um caminho **diferente**: `specChat.ts:508-548`
  `runFileChatJob` → `/invoke/raw`, `max_tokens: 8000` (`:472`), teto de **20.000 chars** de arquivo
  (`:58`), **sem envelope, sem gates, sem persona de arquiteto**.
- **"Resolver GAPs" é PROIBIDO por arquivo:** `specChat.ts:732` → 400
  `"Resolver GAPs não opera em modo por-arquivo"`.
- **Findings JÁ têm arquivo:** `specValidation.ts:49-58` (`ValidationFinding.file`, `.line`);
  stage A emite o path real (`:161-236`), stage B recebe os arquivos delimitados por
  `===== path =====` (`:406-409`) e o `file` volta do LLM (`:268-280`).
- **A validação JÁ é multi-arquivo:** `computeCurrentSpecHash` (`:114-131`) lê TODOS os arquivos e o
  hash é da árvore; `runStageA` recebe a lista. One-flight por projeto = valida a árvore inteira —
  o que é o comportamento certo para spec dividida.
- **O laço autônomo só conhece o primário:** `specAutonomy.ts:239-247 readPrimarySpec`
  (`ORDER BY is_primary DESC, created_at DESC LIMIT 1`) e `:257-275 writePrimarySpec`.
  `migration 090:35` = índice único **1 laço ativo por projeto**.
- **Não existe** ação de "dividir uma spec já existente". O `splitter`
  (`product_architect.py` + `SPLIT_PROJECT_FILES_PROMPT.md`) divide **produto → projetos** no ingest.

---

## 2. Adversarial — o que quebra se implementar o obvio

### B1 🔴 BUG REAL JÁ NO CÓDIGO: `validate_response_quality` não conhece `edits`
`envelope.py:145-162` faz `content = art.get("content", "")` e reprova
`artifact muito curto (0 chars)` quando `status=OK`. Um artefato `format:"edits"` **não tem**
`content` → **erro de qualidade → repair → BLOCKED**. E essa validação roda **dentro do `run_agent`**
(`runtime.py:1530-1534`), ANTES da materialização do runner (`runner.py:3887`).
**Conclusão: o caminho `edits` do DEV (Bloco 4 M8) está quebrado e nunca foi exercitado** — a flag
`EVOLUTION_DEV_EDIT_FORMAT` está OFF em prod, então ninguém viu.
→ Fix obrigatório antes de qualquer coisa: pular as checagens de conteúdo quando
`format=="edits"` e `content` ausente. **Corrige o DEV de graça.**

### B2 🔴 Instruções contraditórias no mesmo prompt
O `task` é montado pela **api** e manda, em `specChat.ts:350-352`:
> "4. Devolva a SPEC INTEIRA revisada como o artefato Markdown principal (não só o trecho alterado).
> IMPORTANTE: o artefato principal DEVE ter o caminho EXATO `docs/spec/PRODUCT_SPEC.md`"

Se o agents injetar "você pode mandar só os edits" por baixo, o prompt fica **auto-contraditório** e o
modelo cai no hábito (reemitir tudo) — gastando a rodada inteira para provar que a flag não funciona.
→ A decisão do formato tem de nascer na **api** (que monta a regra 4), não no agents.
→ **D1.**

### B3 🔴 `search` contra uma base que o modelo não viu inteira
`apply_edits` casa contra o `spec_raw` COMPLETO, mas o prompt pode ter entregado uma versão
**cortada** (`_clip`, `runtime.py:283-292`) quando o modelo é pequeno (Haiku: cap cai no piso de
30.000). O modelo escreveria `search` sobre 30k e aplicaríamos sobre 98k → casamento ambíguo
(recusado) ou, pior, casamento num trecho homônimo.
→ Regra técnica (não é decisão): **só ofertar `edits` quando `len(spec_raw) ≤ cap efetivo`**, isto é,
quando a spec entra INTEIRA no prompt. Senão, `whole` (e T1/T2 seguram).

### B4 🔴 Truncamento DENTRO de um edit
Se a resposta cortar no meio de `"replace": "…`, o `resilient_json_parse` fecha o JSON à força
(`envelope.py`, marca `_json_recovered_truncated`) e teríamos um `replace` **mutilado** aplicado
cirurgicamente sobre a spec — pior que hoje, porque passaria pelas guardas de tamanho.
→ Regra: **se `_truncated` (stop_reason ou json_recovered) → NÃO materializar edits**; vira repair e,
esgotado, BLOCKED. O truncado nunca virá "aplicável".

### B5 🟡 O modelo pode remover seções com um edit legítimo
Um `search` grande com `replace: ""` apaga uma seção inteira em 40 tokens de saída. As guardas T2
(`assessRevisionIntegrity`) e de encolhimento continuam rodando **sobre o conteúdo materializado** →
a rede existe e passa a ser ainda mais necessária. **Não relaxar nada de T1/T2/G2.**

### B6 🟡 Telemetria: sem medir, não sabemos se o modelo obedece
Sem contador, "ligamos edits" é fé. → emitir `_edits_applied`, `_edits_failed`,
`_edits_chars_saved` no envelope + log, e (opcional) coluna/log na api.

### B7 🔴 Dividir a spec com LLM numa única chamada tem o MESMO problema que estamos resolvendo
"Peça ao CTO para dividir a spec em N arquivos **numa resposta só**" = reemitir 98k chars → **não cabe
no teto**. A ironia é fatal: a ação que viabiliza o F2 morreria pelo bug do F1.

→ **Não** se resolve tirando o LLM da jogada (proibido pela §0). Resolve-se **quebrando a tarefa em
duas etapas agênticas**, cada uma cabendo folgada no teto de saída:

1. **Agente ARQUITETO DE SPEC** (1 chamada, entrada = índice + tamanhos + `product_map`; saída 2–4k
   tokens): decide **a estrutura** — pastas, nomes de arquivo, ordem, qual conteúdo pertence a cada
   arquivo (por âncoras de seção), o que deve virar README/índice, o que deve ser reescrito ou
   fundido. Ele **pensa**; só não copia texto.
2. **Agente REDATOR, um por arquivo** (N chamadas paralelizáveis, saída ~1/N da spec): recebe o plano
   + as seções designadas e **elabora o arquivo final** — cabeçalho, frontmatter, transições,
   consistência interna, referências cruzadas. É o LLM quem escreve cada arquivo, não um `slice()`.

Aritmética: com N=8, cada redator emite ~12k chars ≈ 6k tokens = **9% do teto**. Zero truncamento.
O código entra só como **executor/verificador**: dispara as N chamadas, grava via `specFiles.ts`,
snapshot G2 antes, e **verifica cobertura** (nenhuma seção da origem ficou órfã, nada duplicado). A
verificação **não é** round-trip byte a byte — isso proibiria o redator de melhorar o texto, o que
seria o código censurando o LLM. Divergência de volume/seção vira **relatório para revisão**, não veto
cego (veto só para perda de seção sem destino declarado no plano).
**Sem LLM disponível → a ação falha e reporta.** Não existe divisor de emergência.

### B8 🔴 `extractSpecMarkdown` não confere o path pedido
`routes/specs.ts:190-198` pega o **primeiro** artefato `.md`. Em modo escopado, se o CTO devolver
`docs/spec/PRODUCT_SPEC.md` quando pedimos `docs/spec/03-modelo-de-dados.md`, gravaríamos o
documento errado no arquivo alvo — perda de dados silenciosa.
→ Em modo escopado: **casar o path do artefato com o alvo**; divergiu → rejeita a rodada.

### B9 🟡 Rate limit da validação vs. N arquivos
`startValidation` tem 4 validações/h por spec (`specAutonomy.ts kickValidation` trata
`RATE_LIMITED` sem derrubar o laço). Validar por arquivo esgota a cota em 4 arquivos.
→ **Uma validação por RODADA** (depois de aplicar a fila de arquivos daquela rodada), não por arquivo.
→ **D4.**

### B10 🟡 Findings sem arquivo e findings com arquivo inexistente
Stage A emite `file: ""` para achados globais ("spec agregada excede o teto", "spec sem manifesto");
stage B devolve `file` gerado pelo **LLM**, que pode não casar com nenhum arquivo real.
→ Mapear por match exato na árvore; sem match → **bucket do arquivo primário/README**. → **D5.**

### B11 🟡 Um laço ativo por projeto (migration 090:35)
Iterar arquivo a arquivo dentro do teto de 5 rodadas não fecha uma spec de 14 seções.
→ Fila de arquivos com GAP ativo, **um arquivo por rodada** e teto de rodadas maior; ou N chamadas
concorrentes ao CTO por rodada (custo/concorrência). → **D3.**

### B12 🟢 O que NÃO precisa mudar
Contrato api↔agents, UI da Bancada, `spec_chat_jobs`, T1/T2/G2/G4/G5, `computeCurrentSpecHash`,
one-flight da validação, `specFiles.ts` (as rotas por arquivo já existem e são seguras).

---

## 3. Decisões FECHADAS pelo Jean (2026-09-05)

- **D1 = (a) flag na api.** `SPEC_CTO_EDIT_FORMAT` só na api: ela reescreve a regra 4 do prompt e
  manda `inputs.edit_format="edits"`. O agents fica **tolerante** (materializa quando o artefato vier
  como edits, sem flag própria) → api e agents podem ser deployados em qualquer ordem.
- **D2 = (c) agente divisor via LLM** — **revisado em 2026-09-05 pela §0**: a divisão é feita por
  **dois agentes LLM em cadeia** (ver B7): (1) **Arquiteto de Spec** decide estrutura/pastas/nomes/
  destino de cada seção (saída pequena: o plano); (2) **Redator por arquivo**, uma chamada por
  arquivo, **elabora o conteúdo final** de cada um (saída ~1/N da spec, cabe folgado). O código não
  corta texto por conta própria: ele orquestra as chamadas, grava e **verifica cobertura** (relatório;
  veto só para seção perdida sem destino no plano). *(A redação anterior desta decisão — "corte
  determinístico por âncoras em TS com round-trip byte a byte" — está REVOGADA: era automação fixa
  decidindo conteúdo.)*
- **D3 = (a) 1 arquivo por rodada**, fila por GAPs ativos, teto de rodadas maior (12).
  A **ordem** da fila é escolhida pelo LLM (o triador já classifica severidade), não por `sort()` fixo.
- **D4 = (a) 1 validação por rodada** (rate limit de 4/h; B9). *(Quando validar é orçamento, não
  conteúdo — o QUE se valida segue 100% LLM: `runStageA`/`runStageB`.)*
- **D5 = (a)** finding sem arquivo / com arquivo inexistente → **revisado pela §0**: quem decide o
  arquivo-destino é o **LLM roteador** (mesma chamada que já classifica o finding no triador — recebe
  a árvore de arquivos e devolve o destino). O bucket do primário/README fica como **último recurso
  registrado** quando o LLM não indica destino — é fila de espera, não decisão de conteúdo.

### Tabela original das opções (histórico)

| # | Decisão | Opções | Recomendação |
|---|---------|--------|--------------|
| **D1** | Onde nasce a decisão do formato `edits` (B2) | (a) **flag na api** `SPEC_CTO_EDIT_FORMAT`: a api reescreve a regra 4 e manda `edit_format:"edits"` em `inputs`; o agents materializa quando o artefato vier como edits (tolerante, sem flag própria) · (b) flag no agents (prompt contraditório) · (c) nas duas pontas | **(a)** — uma flag, prompt coerente, deploy em qualquer ordem |
| **D2** | Como dividir a spec do LastMile (B7) | (a) **split determinístico por `## ` em TS** + botão "Dividir em arquivos" com preview · (b) eu divido o LastMile à mão agora, sem código · (c) via LLM | **(a)**, e usar (b) como prova no LastMile |
| **D3** | Ritmo do Resolver GAPs escopado (B11) | (a) **1 arquivo por rodada**, fila por GAPs ativos, teto de rodadas ↑ (ex. 12) · (b) todos os arquivos com GAP na mesma rodada (N CTOs concorrentes) | **(a)** — custo previsível, snapshot por arquivo, fácil de parar |
| **D4** | Quando validar (B9) | (a) **1 validação por rodada** · (b) por arquivo | **(a)** |
| **D5** | Findings sem arquivo / com arquivo inexistente (B10) | (a) **bucket no primário/README** · (b) rodada "global" separada | **(a)** |

---

## 4. Plano de implementação (só depois das decisões)

**PR-0 (independente, corrige bug existente):** `envelope.py::validate_response_quality` ciente de
`format:"edits"` + teste. Desbloqueia o DEV e é pré-requisito do F1.

**PR-1 (F1, agents):** materialização no `run_agent` — `_resolve_envelope(message)` (mesmo unwrap de
`build_user_message`), `apply_edits(spec_raw, edits)` ANTES dos gates; guarda B4 (`_truncated` →
não materializa); guarda B3 (só quando a spec cabe inteira); feedback de repair com o trecho real
que não casou; telemetria `_edits_applied/_edits_failed/_edits_chars_saved`.

**PR-2 (F1, api):** flag `SPEC_CTO_EDIT_FORMAT` (default OFF), regra 4 reescrita quando ON,
`inputs.edit_format`, declarar a flag no `docker-compose.yml`. Nada muda com a flag OFF.

**PR-3 (F2, divisão 100% agêntica — D2 revisado):** pipeline de dois agentes + orquestração.

> 🟢 **Reuso descoberto em 2026-09-05:** o padrão exigido pela §0 **já está em produção** no
> `orchestrator/product_architect.py::split_document` — **PASSO 1** (`build_split_prompt`) é o
> arquiteto que decide o manifesto/corte, validado ANTES de gastar as chamadas caras; **PASSO 2**
> (`_generate_project_files`, `build_project_files_prompt`) é **uma chamada LLM por projeto**, com
> fan-out (`ThreadPoolExecutor`, `SPLITTER_FANOUT`), retry 1× com backoff, e o próprio LLM já emite
> `files:{nome: conteúdo}` temáticos (`specs/<pid>/<nome>`), `connect.yaml` e warnings ao humano.
> → O PR-3 **NÃO** cria pipeline novo: acrescenta `split_spec_into_files()` no MESMO módulo,
> reaproveitando `_extract_json`, `_sleep_backoff`, `_FILE_NAME_RE`/`_RESERVED_FILE_NAMES`,
> `MIN_SPEC_CONTENT_CHARS` e o padrão de warnings. Diferença: a entrada é **uma spec de projeto já
> existente** (não o master doc) e a saída são **arquivos da árvore de spec daquele projeto** (não
> projetos novos) — o grafo/manifesto do produto não é tocado.
1. **Agente ARQUITETO DE SPEC** (novo mode/persona, saída pequena): recebe o **ÍNDICE** da spec
   (headings + tamanho de cada seção), o `product_map` e a árvore atual de arquivos; devolve o
   **PLANO** em JSON — `{files:[{path,title,purpose,sections:[…],order}], readme:{…}, rationale}`.
   Ele decide pastas, nomes e agrupamento. Nunca recebe nem devolve o corpo da spec.
2. **Agente REDATOR (N chamadas, uma por arquivo do plano):** recebe o plano + as seções designadas
   (texto integral daquelas seções) + o propósito do arquivo, e **elabora o arquivo final** —
   frontmatter, título, índice local, transições, referências cruzadas aos irmãos. Saída ~1/N da spec.
   Aqui o `edits` do F1 **não** se aplica (é criação de arquivo novo, não edição).
3. **Orquestrador** `services/specSplit.ts` (código, sem decisão de conteúdo): monta o índice de
   entrada, chama o arquiteto, valida o **shape** do plano, dispara os N redatores (com limite de
   concorrência), snapshot G2 do primário ANTES, grava via as rotas de `specFiles.ts`, e emite um
   **relatório de cobertura** (seções da origem → arquivo destino; órfãs; duplicadas; delta de
   volume). Veto apenas para seção sem destino declarado no plano. Sem LLM → falha e reporta.
4. Rota `POST /api/projects/:id/spec-split` (`dry_run` = plano + relatório previsto; `apply` = executa)
   + botão e preview na Bancada, mostrando o **rationale do arquiteto** (o humano aprova a estrutura).

**PR-4 (F2, Resolver GAPs escopado):** remover o 400 de `specChat.ts:732` para `resolve_gaps` +
`filePath`; `spec_raw` = arquivo alvo; findings filtrados por arquivo (destino vindo do **LLM
roteador**, D5); irmãos como contexto; **verificação de path do artefato (B8)**; `writeSpecFile`
genérico (hoje só `writePrimarySpec`), snapshot por `file_path` (já suportado). O modo escopado usa a
**mesma persona de arquiteto/CTO** do modo atual — não é o caminho raso do `/invoke/raw` (T4.3).

**PR-5 (F2, laço):** fila de arquivos por rodada (D3), 1 validação por rodada (D4), teto de rodadas,
log em `rounds` JSONB com o arquivo de cada rodada.

## 5. Validação (obrigatória, antes e depois)
- Unit: PR-0 (edits sem content passa), `apply_edits` no caminho CTO, guardas B3/B4, split
  determinístico (round-trip: concatenar os arquivos reproduz a spec), filtro de findings por arquivo,
  rejeição por path divergente (B8).
- Ao vivo em prod, com flag OFF primeiro (prova de não-regressão: prompt byte-idêntico), depois ON
  num projeto real: medir `_edits_applied` vs. reemissões e o `output_tokens` por rodada.
- Baseline ANTES: tokens de saída por rodada do LastMile hoje (≈64k, truncado) → alvo depois: < 8k.
