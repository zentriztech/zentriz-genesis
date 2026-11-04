> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Plano de implementação evolutivo — "Evoluir projeto" na Bancada, com cards (v2)

**v2 (revisada adversarialmente pelo Advisor/Opus: [D](../analysis/EVOLUIR-PROJETO-D-revisao-adversarial.md), aprovado com correções, 33 achados, 3 bloqueantes; v1 em `.v1.md`)** · 2026-11-03 · Estado: **plano; nada executado; aguarda o OK do Jean**. Base: [estudo C v2](../analysis/EVOLUIR-PROJETO-C-estudo-de-viabilidade.md), [A](../analysis/EVOLUIR-PROJETO-A-estado-atual-fabrica.md), [B](../analysis/EVOLUIR-PROJETO-B-estado-atual-bancada.md).

## 1. Objetivo e critérios de sucesso
Na Bancada, o usuário cria **cards** (Evolução, Correção, Recurso novo; anexos opcionais; modo de trabalho sempre branch git) de um produto **já fabricado ao menos uma vez (`accepted`)**. Cada card gera **especificações ligadas a ele**, maturadas com Chat IA e Fechamento de GAPs; a Fábrica as transforma em **TASKs novas** (sem desconsiderar as processadas), executa com qualidade a verificar, e **marca** card, tasks e specs como executados. Serve também a produtos **sem Auto Care**.

| Critério | Medida |
|---|---|
| Sem regressão | Com `CARDS_BANCADA` desligada **para o tenant**, a suíte de regressão do fluxo atual de evolução (respostas HTTP, efeitos em banco e em disco) passa sem alteração; migrações do tipo *expand* (`tickets.status` intacto; estado do card em `card_state`) |
| Rastreabilidade | 100 % das tasks de um filho têm `card_id`; 100 % dos arquivos de spec têm `spec_origin` |
| Idempotência | Repetir criação/promoção/aceite N vezes e em corrida não duplica filho, task nem PR |
| Resiliência | Matar runner/api no meio de cada etapa e retomar sem perda nem duplicação |
| Qualidade (descritiva, pré-registrada) | ≥ 3 execuções com LLM real em homologação (uma por tipo); cada uma: P2P sem regressão, FAIL_TO_PASS do card PASS, 0 violações de escopo, `TSK-FULL-TEST` PASS, aceite do Cyborg sem intervenção, custo ≤ orçamento. **Não se declara paridade** (n insuficiente, doc evolution/16 §2); LLM simulado serve só ao teste de encanamento |
| Custo | Nenhum card/filho executa sem orçamento explícito; negativa do Guard ⇒ card `blocked` por orçamento, nunca `failed` |

## 2. Princípios
1. Evoluir o **Ticket** existente (RFC-0009), sem entidade paralela. Migrações aditivas (*expand*), flag **por tenant** em `genesis_runtime_config` (override por `tenant_id`).
2. **Rascunho separado da materialização (A')**: o card nasce em `card_draft`, sem versão, sem cópia da árvore e sem clone; versão, clone e branch só na promoção, contra o HEAD corrente da linhagem.
3. **Card sempre gera spec** e fica ligado a ela; spec inicial × derivada por marcador explícito.
4. **Idempotência por construção:** claim transacional curto + passos idempotentes fora da transação; `UPDATE … WHERE status = <esperado>`; unicidade parcial no banco; reconciliador que detecta e notifica.
5. **Falhar alto**, nunca em silêncio (anexo ilegível, repositório ausente, pai não aceito, base vencida).
6. O gate de RFC é **invariante** para os 3 tipos; o tipo só **acrescenta** exigências.
7. **Leis do Suite:** LLM só por slot do tenant, Guard soberano, PR-first, aprovação humana, parecer de agente ≠ aceite; commits locais em `dev` por repositório, **push e deploy só com o OK do Jean**.

## 3. Modelo de execução do plano: Orquestrador → Advisor → Staff
| Papel | Quem | Faz |
|---|---|---|
| **Orquestrador** | Sessão principal (Sonnet) | Planeja, divide, integra, **reexecuta os testes de aceite**, mantém o estado do plano, comunica |
| **Advisor** | Opus, sob demanda | **Obrigatório** em: desenho A', tarefa 1.1 (claim/idempotência), migração 2.1 (antes de qualquer deploy de migração), revisão adversarial de cada fase |
| **Staff** | Haiku, só mecânico verificável | **Apenas** inventários (`rg/fd`), contagens e formatação de relatórios, com conferência determinística pelo Orquestrador. **Nunca** autoria (inclusive fixtures, sementes e testes), juízo, QA ou revisão |
Implementação é de subagentes Sonnet com escopo e arquivos permitidos; worktrees por frente; WIP ≤ 2; o orquestrador confere cada aceite por comando reproduzível.

## 4. Fases e tarefas
Notação: **Dep.** dependências · **[ADV]** Advisor obrigatório · **[STF]** Staff (mecânico) · Aceite verificável por comando · Esf. em semanas de execução (P50/P80, sem espera humana) · Rollback.

### Fase 0' — Decisões, fundação de testes/CI e reprodução (sem mudar comportamento)
| Id | Tarefa e subtarefas | Dep. | Aceite | Esf. |
|---|---|---|---|---|
| 0.1 | **Decisões D-E1 a D-E10** (estudo §5) e status oficial do RFC-0009 | — | registrado em `DECISIONS`/RFC | J |
| 0.2 | **CI real**: hoje roda só em `main`, sem Postgres, sem Python e sem teste de front; ligar vitest + pytest + Postgres efêmero + teste de front em `dev`/PR | — | pipeline verde reproduzível; só então "verde em CI" vale como aceite | 2–3 / 4 |
| 0.3 | **Reprodução dos defeitos** com testes que falham: (a) `/evolve` duplicado em corrida; (b) promoção do ticket sem `AND status='open'`; (c) anexo binário derrubando `load_spec_all`; (d) `spec_submitted` × `/promote`; (e) herança de 1 nível e colisão de IDs `TSK-INH-EVO-*`; (f) PATCH de ticket aceitando qualquer transição e `reopenTicketsOfChild` reabrindo `delivered`; (g) filho de evolução sem `budget_usd` ⇒ `BUDGET_MISSING`; (h) Bancada não promove filho de evolução | 0.2 | cada defeito: teste vermelho que o prova ou o refuta | 2–3 / 4 |
| 0.4 | **Pré-checagem somente leitura em produção** (autorizada): contagens de `tickets`, tamanho de `project_spec_files`, duplicatas `(parent_project_id, version_number)`, filhos vivos por pai, tickets por estado | — | relatório datado; fecha as lacunas "desconhecidas" | P |
| 0.5 | **Cenário dourado** (produto de referência `accepted` + 3 cards, um por tipo) para o teste de encanamento, com LLM simulado | 0.2 | roda ponta a ponta no estado atual | 2 / 3 |
| 0.6 | **Infra mínima de teste de front** (componente + E2E headless) | 0.2 | 1 componente e 1 E2E verdes | 2 / 3 |
| 0.7 | [ADV] **Revisão do desenho A'**, estados e idempotência | 0.1, 0.3, 0.4 | parecer registrado | P |
**Gate F0':** decisões tomadas; CI real verde; defeitos reproduzidos; pré-checagem de produção feita.

### Fase 1' — Endurecer o que já existe (valor independente da decisão sobre cards)
| Id | Tarefa e subtarefas | Dep. | Aceite | Rollback |
|---|---|---|---|---|
| 1.1 | [ADV] **Criação em duas etapas**: (1) claim transacional (`INSERT` do filho em `materializing` + `UPDATE tickets … WHERE status='open' RETURNING`; rowCount 0 ⇒ 409 idempotente com o filho existente); (2) passos idempotentes fora da transação (cópia, clone, branch, materialização), cada um marcado em `extra`; chave = `ticket_id` (sem tentativa), `Idempotency-Key` quando não há ticket | 0.3, 0.7 | teste de corrida (N simultâneas ⇒ 1 filho), crash entre passos retoma, em Postgres real | flag por tenant |
| 1.2 | **Unicidade parcial** `(parent_project_id, version_number) WHERE status NOT IN ('failed','archived')` e um filho materializado vivo por pai, **só depois** da pré-checagem 0.4 (e saneamento de duplicatas, se houver) | 0.4, 1.1 | migração idempotente; retry após `failed` continua possível | índices removíveis |
| 1.3 | **Orçamento na criação**: criar card/filho exige `budget_usd` explícito (mesma validação de `POST /api/specs`) ou compartilhamento declarado com o dono do orçamento da versão corrente (D-E10); negativa do Guard ⇒ pausa, não `failed` | 0.3-g | filho nunca nasce em `BUDGET_MISSING`; teste com o Guard | flag |
| 1.4 | **Transições de ticket validadas** (tabela de transições; PATCH recusa o inválido); `reopenTicketsOfChild` não reabre `delivered` | 0.3-f | teste exaustivo | revert |
| 1.5 | **Anexos**: allowlist e teto por card; binário **fora** da árvore de spec; o runner **falha com erro explícito** ao não ler um arquivo (fim do `try/except` que devolve `""`) | 0.3-c | png/xlsx ⇒ erro claro ou fora da árvore; spec de texto intacta | flag |
| 1.6 | **Herança transitiva de tasks** com **prefixo único por versão de origem** (sem colisão no upsert) e **resumo compacto** para CTO/PM | 0.3-e | v1→v2→v3: v3 conhece v1, sem colisão; limite de tokens respeitado | flag |
| 1.7 | **Status coerentes** `/evolve` × `/promote` e **promoção de filho de evolução na Bancada** (0.3-d, 0.3-h) | 0.3 | fluxo completo testado | revert |
| 1.8 | **Reconciliador** periódico: **detecta e notifica** (filho sem ticket, ticket promovido sem filho, `EVOLUTION_IN_FLIGHT` preso); só limpa claims `materializing` vencidos sem efeitos | 1.1 | casos de teste; log estruturado | desligar o job |
**Gate F1':** corrida/caos verdes; regressão do fluxo atual verde; revisão [ADV].

### Fase 2 — Modelo de dados do card (expand)
| Id | Tarefa e subtarefas | Dep. | Aceite |
|---|---|---|---|
| 2.1 | [ADV] **Migração expand**: `tickets.card_state` (nullable, sem tocar `status`), `origin` (`manual/deadpool_incident/import`), `external_ref`, `blocked_reason`; anexos com tipo/hash; status de projeto `card_draft`/`materializing` | F1' | migração idempotente em Postgres real; **nenhum** leitor legado quebra (testes) |
| 2.2 | `project_spec_files.spec_origin` (`initial`/`card:<TK>`), `executed_in_project`, `executed_at`; backfill (raiz da linhagem = `initial`) | 2.1 | backfill idempotente |
| 2.3 | `project_tasks.card_id` e `origin_spec_file`; runner preenche **sem alterar o regex de ID** | 2.1 | tasks novas com `card_id`; regex inalterado (teste) |
| 2.4 | **Máquina de estados** (`draft/refining/ready/promoted/in_factory/delivered/blocked/rejected`): transições idempotentes e auditadas | 2.1 | teste exaustivo |
| 2.5 | **Flag por tenant** `CARDS_BANCADA` em `genesis_runtime_config`; backfill de `card_state` **só quando a flag liga** para o tenant (`open→draft`, `promoted→in_factory/delivered` conforme o filho) | 2.4 | ligar/desligar por tenant sem perda |
| 2.6 | API de cards (CRUD, transições, listagem por produto) com aliases das rotas de tickets | 2.4 | contrato testado; rotas antigas intactas |
**Gate F2:** dados migrados sem perda; contrato estável. O *contract* (remover legado) só num deploy posterior, após N semanas sem leitura do status legado.

### Fase 3 — Bancada: UI de cards e spec do card (A')
| Id | Tarefa e subtarefas | Dep. | Aceite |
|---|---|---|---|
| 3.1 | **Quadro/lista de cards por produto** (estado, tipo, origem, specs, PR); `card_draft` fora do estado agregado do produto e de "Minhas SPECs" | F2, 0.6 | E2E; a11y |
| 3.2 | **Criar card**: tipo, texto, anexos (allowlist), modo de trabalho **fixo em branch git** (opção `copy` removida), orçamento (1.3), validações de produto fabricado e repositório/GitHub App com mensagem clara | F2 | E2E |
| 3.3 | **Spec do card (A')**: Chat IA e Fechamento de GAPs sobre `card_draft`, lendo a spec da versão corrente em modo somente leitura; **sem clonar nem versionar** antes de promover | 2.2, 3.1 | E2E: editar, validar, restaurar versão; teste: nenhum clone/versão antes da promoção |
| 3.4 | **Ritos por tipo**: gate invariante; Correção = FAIL_TO_PASS de reprodução obrigatório e `compat ≤ patch` (409 `CARD_KIND_MISMATCH`); Recurso novo = `Non-goals`; tipo chega por `extra.ticket_kind` | 3.3 | gates por tipo testados; nenhum tipo dispensa o gate |
| 3.5 | **Promover card**: claim atribui `vN` contra o **HEAD corrente**, copia a árvore, clona e cria `evolution/vN`; base vencida ⇒ revalidar o RFC (`CARD_BASE_STALE`); idempotente | 1.1, 3.3 | teste de corrida, repetição e base vencida |
| 3.6 | Página do projeto: "Evoluir projeto" leva ao quadro (com a flag do tenant); sem a flag, o diálogo antigo inalterado | 3.1 | regressão do fluxo atual verde |
**Gate F3:** jornada card → spec → promoção verde no cenário dourado.

### Fase 4 — Fábrica: cards viram TASKs e são marcados
| Id | Tarefa e subtarefas | Dep. | Aceite |
|---|---|---|---|
| 4.1 | [ADV] Runner/PM/CTO leem `ticket_kind` e `spec_origin` e distinguem spec inicial × nova nos prompts/planner | F2, 3.4 | testes de contrato/prompt por tipo |
| 4.2 | TASKs `TSK-EVO-*` com `card_id`, **sem desconsiderar** `DONE` herdadas (1.6) | 4.1 | tasks já processadas não são refeitas; novas ligadas ao card |
| 4.3 | **Marcação automática de executado**: aceite do filho + PR mergeado ⇒ `delivered`; tasks e arquivos de spec recebem `executed_*`; falha ⇒ `blocked` com motivo (inclui orçamento); humano ⇒ `rejected` | 2.4 | teste ponta a ponta; idempotente |
| 4.4 | PR por card (`TK-NNNN` no título e no commit) e verificação de merge | 3.5 | teste com repositório simulado |
| 4.5 | **Qualidade (descritiva)**: 3 execuções com LLM real em homologação (ZFactory), uma por tipo, critérios do §1; relatório sem declarar paridade | 4.1–4.4 | relatório com as execuções e os critérios binários |
| 4.6 | **Caos**: matar runner/api em cada etapa e retomar sem duplicar tasks/PR | 4.2 | retomada verde |
**Gate F4:** critérios binários verdes nas 3 execuções; caos verde; revisão [ADV].

### Fase 5 — Custo percentual, observabilidade e portas de entrada
| Id | Tarefa e subtarefas | Dep. | Aceite |
|---|---|---|---|
| 5.1 | **Orçamento por card em percentual** do orçamento do projeto — **depois** de C3'/C4' do desenho de controle de gasto (doc evolution/27) | F4, C3', C4' | percentual configurável; Guard soberano |
| 5.2 | Consultas/painéis: cards por estado, tempo por estado, custo por card, taxa de `blocked` | F4 | consultas versionadas |
| 5.3 | **Deadpool → card de Correção** (`IncidentEnvelope` → card, **com aprovação humana**, token de serviço restrito, `external_ref`); PR-first preservado | F4, D-E6 | teste de contrato |
| 5.4 | **Produto externo** (repositório + estado base, sem projeto Genesis pai) — adiável | D-E5 | decisão do Jean |

### Fase 6 — Rollout, permissões e documentação
| Id | Tarefa e subtarefas | Dep. | Aceite |
|---|---|---|---|
| 6.1 | Permissões e papéis de usuário (quem cria/promove/rejeita card), multi-tenant, notificações, auditoria, i18n PT-BR | F3 | testes de autorização |
| 6.2 | Runbook (promoção que falha, card `blocked`, reconciliador, rollback da flag por tenant) | F4 | revisado |
| 6.3 | Rollout por tenant: ZFactory → demais; critérios de entrada/saída; comunicação | 6.2 | aprovado pelo Jean |
| 6.4 | Atualizar RFC-0009, ARQUITETURA, NAVIGATION e o guia do usuário | F3 | docs coerentes |

## 5. Resiliência e idempotência (transversal)
Claim transacional curto + passos idempotentes fora da transação (o `git clone` nunca entra na transação); `UPDATE … WHERE status=<esperado>`; unicidade parcial no banco; chave de idempotência = `ticket_id`; reconciliador que detecta e notifica; chat jobs com trava por projeto; checkpoint e retomada; negativa do Guard pausa o card; logs estruturados sem PII; todos os caminhos de erro testados.

## 6. Cronograma (faixas P50/P80 do Advisor, a recalibrar após a Fase 0')
Caminho crítico ≈ **18–20 semanas (P50) / 30 (P80)**, contra 24–37 da v1. **F0' + F1' ≈ 5 semanas** já corrigem defeitos reais do fluxo atual, independentemente da decisão sobre cards. As fases 3 e 4 podem usar 2 frentes (backend/dados e UI), com worktrees e WIP ≤ 2.

## 7. Riscos
Regressão do fluxo atual (flag por tenant, expand, suíte de regressão) · corridas (claim + unicidade parcial + caos) · migração no boot derrubando a API (pré-checagem 0.4, índices parciais) · contexto inflando (resumo das herdadas) · BUDGET_MISSING (1.3) · CI inexistente para os aceites (0.2) · base vencida entre maturação e promoção (`CARD_BASE_STALE`) · front sem testes (0.6) · escopo grande (fases com gates e valor incremental).

## 8. Decisões do Jean (2026-11-04)
| Id | Decisão | Resposta |
|---|---|---|
| D-E1 | Cardinalidade | **Aceita A'**: 1 card = 1 filho, rascunho separado da materialização; lotes de cards depois |
| D-E2 | O que conta como "fabricado" | **Só `accepted`** |
| D-E4 | Anexos | Tipos permitidos **pdf, txt, md, doc e docx**; `txt/md` dentro da spec; **pdf/doc/docx guardados no card, fora da pasta de texto da spec**, com **conversão automática para `.md`** (marcado com a origem do anexo) |
| D-E6 | Deadpool/Auto Care → card | **Não**: o Auto Care é outra coisa e **permanece como está** (tarefa 5.3 cancelada) |
| D-E10 | Orçamento | **Mesmo orçamento do dono da versão, por enquanto** |
| D-E8 | Status do RFC-0009 | **Aceito/Implementado** (RFC atualizado em 2026-11-04) |
| D-E5 | Produto externo | **Adiar** (tarefa 5.4 fora do escopo atual) |
| D-E3 | Ritos por tipo | Proposta: gate invariante; o tipo acrescenta exigências (aguarda confirmação) |
| D-E7 | Orçamento por card em percentual | Depois de C3'/C4' do controle de gasto (proposta) |
| D-E9 | Serviço-alvo do card e mudanças que cruzam serviços | **Pendente** |
| — | **OK para iniciar a Fase 0'** | **Pendente** |
