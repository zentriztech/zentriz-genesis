> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Plano de implementação evolutivo — "Evoluir projeto" na Bancada, com cards

**v1 (antes da revisão adversarial)** · 2026-11-03 · Estado: **plano; nada executado; aguarda o OK do Jean**. Base: [estudo C](../analysis/EVOLUIR-PROJETO-C-estudo-de-viabilidade.md), [A](../analysis/EVOLUIR-PROJETO-A-estado-atual-fabrica.md), [B](../analysis/EVOLUIR-PROJETO-B-estado-atual-bancada.md).

## 1. Objetivo e critério de sucesso
Na Bancada, o usuário cria **cards** (Evolução, Correção, Recurso novo; anexos opcionais; modo de trabalho sempre branch git) de um produto **já fabricado ao menos uma vez**. Cada card gera **especificações ligadas a ele**, maturadas com Chat IA e Fechamento de GAPs; a Fábrica as transforma em **TASKs novas** (sem desconsiderar as processadas), executa com a **mesma qualidade da 1ª versão**, e **marca** card, tasks e specs como executados. Serve também a produtos **sem Auto Care**.

| Critério | Medida |
|---|---|
| Funcional | Card dos 3 tipos percorre `draft → … → delivered` no cenário dourado (CI com LLM simulado) |
| Rastreabilidade | 100 % das tasks de um filho têm `card_id`; 100 % dos arquivos de spec têm `spec_origin` |
| Qualidade | QA na 1ª tentativa, rework, gates e testes herdados (PASS_TO_PASS) **não piores** que o baseline da v1 do produto de referência (margem a pré-registrar) |
| Idempotência | Repetir criação/promoção/aceite N vezes não duplica filho, task nem PR (testes de corrida) |
| Resiliência | Matar runner/api no meio de cada etapa e retomar sem perda (teste de caos) |
| Sem regressão | Com `CARDS_BANCADA=off` o fluxo atual é byte-idêntico |

## 2. Princípios
1. **Evoluir o Ticket existente (RFC-0009), não criar entidade paralela.** Migrações aditivas, atrás de flag `CARDS_BANCADA` (`off|on`, padrão `off`).
2. **Card sempre gera spec** e fica ligado a ela; a spec inicial é distinguida por marcador **explícito**.
3. **Idempotência por construção:** transição de estado = `UPDATE … WHERE status = <esperado>`; chaves de idempotência por promoção; unicidade no banco; reconciliador cura órfãos.
4. **Falhar alto, nunca em silêncio** (anexo ilegível, repositório ausente, pai não aceito).
5. **Medir paridade antes de abrir:** cenário dourado e métricas.
6. **Leis do Suite:** LLM só por slot do tenant, Guard soberano, PR-first, aprovação humana, parecer de agente ≠ aceite.
7. **Execução:** commits locais em `dev`, por repositório; push/deploy só com o OK do Jean; subagentes com escopo e arquivos permitidos.

## 3. Modelo de execução do plano: Orquestrador → Advisor → Staff
| Papel | Quem | Faz |
|---|---|---|
| **Orquestrador** | Sessão principal (Sonnet) | Planeja, divide, integra, **reexecuta os testes de aceite**, mantém o estado do plano, comunica |
| **Advisor** | Modelo mais forte (Opus), sob demanda | Decisões de arquitetura (modelo de dados, máquina de estados, idempotência), **revisão adversarial** de cada fase, análise de corridas e de falhas |
| **Staff** | Modelo barato (Haiku), só tarefas mecânicas e validáveis | Inventários, geração de fixtures e dados de teste, checagens de consistência, formatação de relatórios |
Regras: o Staff **nunca** faz autoria de código de produção, juiz, QA nem revisão; implementação é do Orquestrador/subagentes de implementação (Sonnet); o Advisor entra nos pontos marcados **[ADV]**; o orquestrador confere cada aceite por comando reproduzível. WIP ≤ 2 frentes; worktrees por frente quando mexerem nos mesmos arquivos.

## 4. Fases e tarefas
Notação: **Dep.** dependências · **[ADV]** ponto de revisão do Advisor · **[STF]** tarefa para Staff · Aceite = verificável por comando · Esf. P ≤ 1 sem, M 2–4 sem, G > 1 mês (estimativas, a recalibrar) · Rollback = flag ou migração aditiva.

### Fase 0 — Decisões, reprodução e fundação de testes (sem mudar comportamento)
| Id | Tarefa e subtarefas | Dep. | Aceite | Esf. |
|---|---|---|---|---|
| 0.1 | **Decisões D-E1 a D-E8** (estudo §5) e status oficial do RFC-0009 | — | decisões em `DECISIONS`/RFC atualizado | J |
| 0.2 | **Reproduzir os defeitos citados** com testes que falham: (a) `/evolve` duplicado em corrida; (b) promoção do ticket sem `AND status='open'`; (c) anexo binário derrubando `load_spec_all`; (d) incompatibilidade `spec_submitted` × `/promote`; (e) herança de tasks de 1 nível | — | testes vermelhos que provam cada defeito (ou o refutam) | M |
| 0.3 | **Cenário dourado:** produto de referência com 1 versão `accepted` + 3 cards (um de cada tipo), LLM simulado determinístico; scripts de semente [STF] | 0.2 | cenário roda ponta a ponta no estado atual (baseline da v1 do fluxo) | M |
| 0.4 | **Baseline de qualidade** da v1 e das evoluções existentes (QA 1ª tentativa, rework, gates, PASS_TO_PASS) a partir de dados de dev/prod somente leitura | 0.3 | baseline datado com `nao_medido` onde faltar | P |
| 0.5 | **Infra mínima de teste de front** (componentes + um E2E com navegador headless) | — | um teste de componente e um E2E verdes em CI | M |
| 0.6 | [ADV] **Revisão do desenho** (estados, idempotência, corridas) | 0.1, 0.2 | parecer registrado | P |
**Gate F0:** decisões tomadas; defeitos reproduzidos; cenário dourado e baseline existem.

### Fase 1 — Endurecer o que já existe (valor imediato, baixo risco)
| Id | Tarefa e subtarefas | Dep. | Aceite | Rollback |
|---|---|---|---|---|
| 1.1 | **`/evolve` transacional e idempotente:** transação única; `UNIQUE (parent_project_id, version_number)`; índice parcial "um filho vivo por serviço"; **chave de idempotência** `evolve:<ticket>:<attempt>`; resposta idempotente em repetição | 0.2 | teste de corrida (N requisições simultâneas ⇒ 1 filho) em Postgres real; migração aditiva | flag; índices removíveis |
| 1.2 | **Promoção do ticket atômica:** `UPDATE … WHERE status='open' RETURNING`; erro 409 coerente | 0.2 | teste de corrida | revert |
| 1.3 | **Anexos:** allowlist, teto por card, binário **fora** da árvore de spec; runner **falha com erro explícito** ao não ler um arquivo (fim do `try/except` que devolve `""`) | 0.2 | teste com png/xlsx ⇒ erro claro ou arquivo fora da árvore; spec de texto intacta | flag |
| 1.4 | **Herança transitiva de tasks** (`TSK-INH-*` de todas as versões) com **resumo compacto** para o CTO/PM | 0.2 | teste v1→v2→v3: v3 conhece as tasks de v1; limite de tokens respeitado | flag |
| 1.5 | **Status coerentes** entre `/evolve` e `/promote` (resolver 0.2-d) | 0.2 | teste do fluxo completo | revert |
| 1.6 | **Reconciliador** (job periódico, idempotente): filho sem ticket, ticket promovido sem filho, `EVOLUTION_IN_FLIGHT` preso | 1.1 | cura nos casos de teste; log estruturado | desligar o job |
**Gate F1:** testes de corrida/caos verdes; cenário dourado ainda verde.

### Fase 2 — Modelo de dados do card
| Id | Tarefa e subtarefas | Dep. | Aceite |
|---|---|---|---|
| 2.1 | [ADV] **Migração aditiva**: `tickets` ganha `origin` (`manual`/`deadpool_incident`/`import`), `external_ref`, estado ampliado (`draft/refining/ready/promoted/in_factory/delivered/blocked/rejected`), `blocked_reason`, `attempt`; tabela de anexos com tipo/hash | F1 | migração idempotente em Postgres real; backfill dos tickets existentes (`open→draft`, `promoted→promoted`, `delivered` mantém) sem perda |
| 2.2 | `project_spec_files.spec_origin` (`initial`/`card:<TK>`), `executed_in_project`, `executed_at`; **backfill** (raiz da linhagem = `initial`) | 2.1 | backfill idempotente; consulta mostra inicial × derivada |
| 2.3 | `project_tasks.card_id` e `origin_spec_file`; runner preenche (1:1 via projeto filho) **sem alterar o regex de ID** | 2.1 | tasks novas têm `card_id`; regex inalterado (teste) |
| 2.4 | **Máquina de estados** no serviço: transições idempotentes (`WHERE status=<esperado>`), trilha de auditoria, tabela de transições testada | 2.1 | teste exaustivo de transições válidas/inválidas e repetição |
| 2.5 | API de cards (CRUD + transições + listagem por produto), compatível com as rotas de tickets (aliases) | 2.4 | contrato testado; rotas antigas intactas com a flag `off` |
**Gate F2:** dados migrados sem perda; contrato de API estável.

### Fase 3 — Bancada: UI de cards e spec do card
| Id | Tarefa e subtarefas | Dep. | Aceite |
|---|---|---|---|
| 3.1 | **Quadro/lista de cards por produto** na Bancada (estado, tipo, origem, ligação com specs e PR) | F2, 0.5 | E2E: lista e filtros; a11y (rótulos, foco, contraste) |
| 3.2 | **Criar card:** tipo, texto, anexos (opcional, com allowlist), "modo de trabalho" **fixo em branch git** (opção `copy` removida), validação de produto fabricado | F2 | E2E; mensagem clara quando não há repositório/GitHub App ou produto não fabricado |
| 3.3 | **Spec do card:** abre a spec (filho em `draft`, **sem clonar código nem criar branch** — materialização preguiçosa), com Chat IA, Fechamento de GAPs, snapshots; spec marcada `card:<TK>` | 2.2, 3.1 | E2E: editar, validar, restaurar versão; nenhum clone antes de promover (teste) |
| 3.4 | **Ritos por tipo** na UI e nos gates (Correção "RFC-lite", Recurso novo completo, Evolução atual) | 3.3 | gates por tipo testados; o que cada tipo dispensa está explícito |
| 3.5 | **Promover card:** materializa branch `evolution/vN` e dispara a Fábrica; idempotente (repetir não duplica) | 1.1, 3.3 | teste de corrida/repetição |
| 3.6 | Página do projeto: botão "Evoluir projeto" passa a levar à Bancada de cards (com a flag), mantendo o diálogo antigo sem a flag | 3.1 | com flag `off` nada muda |
**Gate F3:** jornada card→spec→promoção funciona no cenário dourado (LLM simulado).

### Fase 4 — Fábrica: cards viram TASKs e são marcados
| Id | Tarefa e subtarefas | Dep. | Aceite |
|---|---|---|---|
| 4.1 | Runner/PM/CTO leem `change_kind` e `spec_origin`; distinguem spec inicial × nova nos prompts e no planner [ADV] | F2, 3.4 | testes de prompt/contrato; golden por tipo |
| 4.2 | Geração de TASKs `TSK-EVO-*` com `card_id`; **nunca desconsidera** `DONE` herdadas (usa 1.4) | 4.1, 1.4 | teste: tasks já processadas não são refeitas; novas ligadas ao card |
| 4.3 | **Marcação automática de executado:** no aceite do filho + PR mergeado ⇒ `delivered`; tasks e arquivos de spec recebem `executed_*`; falha ⇒ `blocked` com motivo; humano ⇒ `rejected` | 2.4 | teste ponta a ponta no cenário dourado; idempotente |
| 4.4 | PR por card (`TK-NNNN` no título e no commit); verificação de merge | 3.5 | teste com repositório simulado |
| 4.5 | **Paridade de qualidade:** rodar o cenário dourado e comparar com o baseline (0.4) | 4.1–4.4 | relatório com margem pré-registrada; sem declarar "paridade" sem n suficiente |
| 4.6 | **Resiliência:** testes de caos (matar runner/api em cada etapa) e retomada por checkpoint | 4.2 | retomada sem duplicar tasks/PR |
**Gate F4:** paridade medida; caos verde; revisão [ADV].

### Fase 5 — Custo, observabilidade e portas de entrada
| Id | Tarefa e subtarefas | Dep. | Aceite |
|---|---|---|---|
| 5.1 | **Orçamento por card** (percentual do orçamento do projeto-filho; Guard soberano); alerta em 80 % | F4 | teste: card sem orçamento não executa; negativa do Guard pausa o card, não falha |
| 5.2 | Painéis/consultas: cards por estado, tempo em cada estado, custo por card, taxa de `blocked` | F4 | consultas versionadas |
| 5.3 | **Deadpool → card de Correção** (`IncidentEnvelope` → card, **com aprovação humana**, token de serviço restrito, `external_ref`) | F4, D-E6 | teste de contrato; PR-first preservado |
| 5.4 | **Produto externo** (repositório + estado base, sem projeto Genesis pai) — adiável | D-E5 | decisão do Jean |

### Fase 6 — Rollout e documentação
| Id | Tarefa e subtarefas | Dep. | Aceite |
|---|---|---|---|
| 6.1 | Runbook (falha de promoção, card `blocked`, reconciliador, rollback de flag) | F4 | revisado |
| 6.2 | Rollout: tenant interno (ZFactory) → demais; critérios de entrada/saída; comunicação | 6.1 | plano aprovado pelo Jean |
| 6.3 | Atualizar RFC-0009, ARQUITETURA, NAVIGATION e o guia do usuário | F3 | docs coerentes |

## 5. Resiliência e idempotência (transversal)
Criação, promoção, aceite e marcação são **idempotentes e atômicos** (transação + `UPDATE … WHERE`); chaves de idempotência por card e tentativa; unicidade no banco; reconciliador periódico; chat jobs com trava por projeto; runner com checkpoint e retomada; erros de orçamento do Guard pausam o card (não o marcam como falho); logs estruturados sem PII; todos os caminhos de erro testados.

## 6. Cronograma indicativo (a recalibrar após a Fase 0)
F0 ≈ 3–4 sem · F1 ≈ 3–5 · F2 ≈ 3–4 · F3 ≈ 5–8 · F4 ≈ 5–8 · F5 ≈ 3–5 · F6 ≈ 2–3. Sequencial ≈ 24–37 semanas; com 2 frentes (dados/backend e UI), menos. Faixas P50/P80 virão da revisão adversarial.

## 7. Riscos e mitigações
Regressão do fluxo atual (flag, migração aditiva, byte-idêntico com `off`) · corridas (unicidade, transação, testes de caos) · contexto inflando (resumo das herdadas) · custo sem teto (orçamento por card, Guard) · front sem testes (0.5) · paridade não provada (4.5) · escopo grande (fases com gates e valor incremental: a Fase 1 já corrige defeitos reais).

## 8. Decisões pendentes do Jean
D-E1 cardinalidade (A: 1 card = 1 filho; B depois) · D-E2 `completed` conta? · D-E3 ritos por tipo · D-E4 anexos · D-E5 produto externo · D-E6 Deadpool → card · D-E7 orçamento por card · D-E8 status do RFC-0009 · **OK para iniciar a Fase 0**.
