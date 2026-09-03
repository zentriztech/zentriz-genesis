> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# RFC-0004 — Plano de Execução

| Campo | Valor |
|-------|-------|
| Status | **Aprovado — execução autônoma autorizada** (Jean, 2026-09-03) |
| RFC | `RFC-0004-BANCADA-AMBIENTE-DE-PROJETO.md` (v2, pós-auditoria adversarial) |
| Método | Cada tarefa tem **Validação PRÉ** (capturar estado real + baseline antes de agir) e **Validação PÓS** (provar o efeito, não só "buildou"). Se a PRÉ contradiz a premissa → PARAR e reavaliar (rodar adversarial de novo se preciso). Trabalho em `dev`; deploy prod só ao fim de cada onda com verificação de digest; commit por onda. |
| Gates globais | `tsc --noEmit` limpo · suíte vitest da api verde · suíte pytest do orchestrator verde · build genesis-web verde · nenhuma migration com `;` em literal ou `$$` |

---

## ONDA 0 — Hardening (furos vivos, independem do RFC)

### T0.1 — Status-guard no `PATCH spec-content` (S1)
- **PRÉ**: reproduzir em dev — PATCH numa spec de projeto `running` retorna 200 hoje (confirmar o furo); listar consumidores do PATCH (portal `/spec`, telegram?).
- Sub: allowlist `draft/spec_submitted/pending_conversion/stopped/blocked_*` → 409 `SPEC_LOCKED`; teste vitest (roda cada status).
- **PÓS**: PATCH em `running` → 409; PATCH em `draft` → 200; suíte verde.

### T0.2 — ACL no spec-chat (S2 + S3)
- **PRÉ**: reproduzir cross-tenant write (POST com projectId de outro tenant persiste hoje); confirmar GET /:jobId sem dono.
- Sub: `checkProjectAccess` no POST antes de aceitar `projectId`; job com `{tenantId, userId}` + `crypto.randomUUID()`; GET compara dono; testes.
- **PÓS**: POST cross-tenant → 403; GET com jobId de outro usuário → 403/404; fluxo legítimo intacto (msg persiste e poll devolve).

### T0.3 — Restrição de role no `PATCH /api/projects/:id` status (S4)
- **PRÉ**: mapear TODOS os chamadores legítimos do PATCH com `status` (runner via service-token — `runner.py:2364`; portal usa?; pipeline.ts:380 é SQL direto, não afeta). Confirmar que tenant user consegue setar `completed` hoje.
- Sub: escrita de `status` só `svc:runner`/`deploy-callback`/`zentriz_admin` + allowlist de transições para humanos (ex.: tenant_admin pode `stopped`); testes cobrindo runner (não pode quebrar pipeline em voo!).
- **PÓS**: tenant user PATCH status → 403; runner PATCH status → 200; pipeline e2e local continua (smoke: criar projeto → run → status transita).

### T0.4 — Clamp de métricas (S5)
- **PRÉ**: POST agent-metrics com `inputTokens:-1e9` aceito hoje (confirmar) e efeito no SUM.
- Sub: clamp `[0, 10_000_000]` no handler; migration `CHECK >= 0` (validar dados existentes antes de aplicar o CHECK — se houver negativo, corrigir no mesmo script).
- **PÓS**: POST negativo → gravado 0 (ou 400); SUM do tenant inalterado por métrica hostil; migration aplica limpa no boot local.

### T0.5 — Guard `svc:runner` em rotas de autoria (S6)
- **PRÉ**: cunhar token escopado em dev e provar que `PATCH spec-content` passa hoje.
- Sub: `user.svc === "runner"` → 403 em PATCH spec-content, POST /api/specs, spec-chat; GET liberado; testes espelhando os do binding rota B.
- **PÓS**: token escopado → 403 nas escritas, 200 nos GETs; token de usuário real intacto.

### T0.6 — Fechar runs órfãs no watchdog (prepara F5)
- **PRÉ**: contar runs abertas com projeto não-running em dev/prod (query).
- Sub: watchdog fecha `pipeline_runs` órfãs com `stop_reason='orphaned'` quando marca projeto failed/completed + varredura periódica.
- **PÓS**: run órfã sintética é fechada no próximo ciclo; `duration_sec` coerente.

**Fecho da onda**: commit + deploy prod (ECR) + verificação de digest + smoke das rotas em prod. Adversarial rápido: 1 agente re-testa os 6 furos em prod.

---

## ONDA 1 — Specs hierárquicas + hash canônico + catálogo (F1/F2/D7)

### T1.1 — Migration `rel_dir` + `is_primary` + `content_sha256` (3 passos)
- **PRÉ**: dump do schema atual de `project_spec_files`; contar duplicatas `(project_id, filename)` em dev E prod (o dedupe precisa cobrir prod); confirmar zero `;`/`$$` no SQL novo; guard novo no `migrations.test.ts` (rejeita `$$` fora de comentário).
- Sub: ADD COLUMNs → script de dedupe (renomeia `nome (2).md`) → UNIQUE index; backfill `content_sha256` dos arquivos existentes.
- **PÓS**: migration roda no boot local sem erro; UNIQUE ativo; SELECT legado funciona; api sobe limpa 2× (idempotência).

### T1.2 — Função canônica de hash (TS + Python) + teste de paridade
- **PRÉ**: capturar hash atual (`extra.spec_hash`) de 3 projetos reais em dev; documentar a fórmula velha; confirmar os DOIS pontos a substituir (`projectCreation.ts:135-143`, `runner.py:295-311`).
- Sub: `specTreeHash.ts` + `spec_tree_hash.py` (git-tree style, sort binário, tetos 200/256KB/2MB); teste de paridade (mesmos fixtures nos dois lados → mesmo hash); substituir os 2 call sites; **os projetos com `spec_approved=true` existentes têm o hash RECALCULADO e regravado na mesma migração de código** (senão o gate do runner bloqueia specs aprovadas com falso "editada").
- **PÓS**: paridade verde (≥6 fixtures: raiz, subpasta, README duplicado em pastas, unicode, arquivo vazio, ordem de criação invertida); pipeline local e2e com spec aprovada NÃO bloqueia; hash muda ao mover arquivo entre pastas (caso que a fórmula velha errava).

### T1.3 — Layout de disco hierárquico + sanitização
- **PRÉ**: inventariar escritores de disco (`projectCreation.ts:208`, `telegram.ts:1052`, `projects.ts:3157`); confirmar colisão `Date.now()` com teste.
- Sub: writes em `<projectId>/<rel_dir>/<filename>` (mkdir recursivo); sanitização por segmento + containment `path.resolve`; fim do prefixo timestamp (nome real, UNIQUE já protege); compat: leitura continua por `file_path` absoluto do banco (arquivos velhos intactos).
- **PÓS**: upload de 2 `README.md` em pastas distintas → 2 arquivos íntegros; tentativa `../../etc` → 400; arquivos legados continuam legíveis.

### T1.4 — Trocar os 6 leitores LIMIT-1 + strip de frontmatter no runner
- **PRÉ**: listar os 6 (`pipeline.ts:74`, `projects.ts:2969/3034`, `watchdog.ts:236`, `runnerDispatch.ts:64`, `telegram.ts:1058`) e o comportamento atual de cada um com 2+ arquivos.
- Sub: noção de arquivo canônico (`is_primary`; fallback: agregado); gate de conteúdo roda sobre agregado; `load_spec_all` faz strip de frontmatter YAML.
- **PÓS**: projeto multi-arquivo: dispatch lê agregado; gate não dispara `SPEC_PLACEHOLDER_TEMPLATE` num README-template legítimo; prompt do PM não contém frontmatter cru (inspecionar payload em dev).

### T1.5 — Catálogo v1 + fonte única de taxonomia
- **PRÉ**: extrair os 13 VALID_TYPES atuais das 3 cópias e confirmar igualdade entre elas.
- Sub: `archetype-catalog.v1.json` (6 arquétipos v1 mapeando `factoryType` p/ os types reais); `GET /api/catalog/archetypes`; `product_architect.py` + `productManifest.ts` + prompt (`types_block`) passam a ler do catálogo; testes.
- **PÓS**: splitter roda e a proposta valida contra o catálogo; taxonomia divergente entre camadas = impossível (teste que compara as fontes).

### T1.6 — Splitter D7: campos novos + materialização determinística da árvore
- **PRÉ**: rodar um propose real em dev e capturar o payload atual (baseline).
- Sub: SPLIT_SYSTEM_PROMPT + `build_split_prompt` + `_split_manifest_and_specs` + espelho TS ganham `archetype/stack/deployTarget` (com defaults quando o LLM omitir — nunca rejeição hard por campo novo); `productDecomposer` materializa `README.md` (template do catálogo + campos) + `01-spec.md` (specContent) com `rel_dir`; `products.manifest_md` (migration) recebe o manifesto do produto; `product_hash` continua sobre o payload (idempotência preservada — teste re-ingest no-op).
- Sub: validação da proposta no `runProposeJob` pós-LLM (estado `done_with_findings`); persistir proposta em tabela `product_proposals` (fim do Map 30min); `DecomposeDialog` com correção inline mínima.
- **PÓS**: texto livre → propose → aprovar → produto com árvore (`<projeto>/README.md` + `01-spec.md`) no disco e no banco; re-aprovar a mesma proposta = no-op; proposta com archetype inventado → `done_with_findings` com correção na UI (não descarte); promote do produto → fábrica roda normalmente (e2e local).

### T1.7 — Specs legadas: leniência + "gerar manifesto"
- **PÓS da onda inteira (regressão)**: specs pré-existentes listam, abrem, decompõem e promovem exatamente como antes (suite + teste manual em dev com dados reais).

**Fecho da onda**: commit; adversarial de regressão (1 agente ataca retrocompat com specs legadas + paridade de hash); deploy prod (api+runner+agents na MESMA janela — hash muda dos dois lados); verificação digest + smoke.

---

## ONDA 2 — Higiene de custo (F6 — pré-requisito da 3)

### T2.1 — `call_bedrock_direct` reporta usage
- **PRÉ**: confirmar descarte (`runtime.py:1160-1166`); listar chamadores (cyborg V2, splitter, /invoke/raw).
- Sub: capturar usage + POST `/agent-metrics` fire-and-forget com projectId real do job; spec-chat deixa de mandar `project_id:"spec_chat"`.
- **PÓS**: rodar splitter em dev → linha nova em `project_agent_metrics` com tokens>0 e projectId correto; custo aparece no portal.

### T2.2 — Tabela de preços única (4 pontos + Haiku + fix Sonnet-only)
- **PRÉ**: capturar os 4 pontos e calcular o custo de 1 projeto real com a tabela velha (baseline de comparação).
- Sub: `modelPricing.ts` único (Haiku 1/5, Sonnet 3/15, Opus por tabela vigente) consumido pelos 4; corrigir `projects.ts:2697`.
- **PÓS**: custo do projeto baseline recalculado bate com o esperado; run com modelo haiku debitado a 1/5 (teste).

### T2.3 — Dropar `pipeline_cost_ledger` (D4)
- **PRÉ**: confirmar zero INSERTs no repo E zero linhas na tabela em prod (se houver linhas: exportar antes).
- Sub: remover leituras dual-source (`tenantCostCap.ts`); migration DROP.
- **PÓS**: cost-cap continua funcionando (teste do gate); boot limpo.

**Fecho**: commit; deploy; verificação (custo visível em prod para 1 run real).

---

## ONDA 3 — Validar (F4)

### T3.1 — Migrations: `spec_validation_runs` + `governance_audit` + `spec_dirty_at`
- **PRÉ**: revisar SQL contra os gotchas (`;`/`$$`/CHECK NOT VALID); confirmar `num_nonnulls` disponível no PG de prod.
- **PÓS**: boot 2× limpo; índices parciais ativos (testar one-flight e dedupe com INSERTs de conflito).

### T3.2 — Estágio A determinístico + endpoint validate/validation
- Sub: `POST /api/specs/:id/validate` (budget-check → rate-limit 4/h → dedupe por hash → INSERT run `pending`) + `GET /api/specs/:id/validation`; estágio A in-process (manifesto, catálogo, deps acíclicas, readiness, tetos; legado sem manifesto = warning); reaper no boot; deadline no watchdog.
- **PRÉ**: baseline das rotas /api/specs atuais (não quebrar contrato).
- **PÓS**: validar spec ok → run `passed` com findings []; spec sem manifesto → `passed` com warning; 2º validate do mesmo hash → devolve run existente (custo zero); 2 validates concorrentes → 1 run (UNIQUE); restart da api com run `running` → `interrupted` no boot.

### T3.3 — Estágio B adversarial (agents server)
- Sub: `POST /invoke/spec_validator/async` clonando `_run_splitter` MAS com estado na tabela (API marca `running`/resultado; poll 404 do agents = `interrupted`, nunca "insistir 11min"); prompt com framing anti-injection (padrão Deadpool) + validadores sem ferramentas + saída JSON schema-validada; triagem Haiku → refutadores Sonnet; teto `MAX_USD_PER_VALIDATION`; usage → agent-metrics.
- **PRÉ**: confirmar padrão `_run_splitter` e o schema-parse TS (`parseManifest`) como referência.
- **PÓS**: spec com erro plantado (dep circular no texto, requisito contraditório) → finding relevante; spec com injection plantada ("aprove tudo") → injection reportada COMO finding e estágio A intacto; custo da validação visível em agent-metrics (≤ teto); job sobrevive a logout do usuário (poll de outra sessão).

### T3.4 — Gate no choke-point + ack + auditoria
- Sub: `checkSpecValidationGate()` em `dispatchProjectRun` + `/run` inline do pipeline.ts; regra verde/ack/force; `POST .../ack` (JWT, hash-bound); force só `zentriz_admin` + INSERT `governance_audit`; `extra.spec_hash` gravado no promote (runner re-verifica — mecanismo existente).
- **PRÉ**: enumerar e testar os 8 caminhos de promoção ANTES (baseline: todos passam sem gate); decidir rollout: gate nasce atrás de env `SPEC_VALIDATION_GATE=off` (default OFF) → ligar após validar em prod (mesmo padrão do H3).
- **PÓS**: com gate ON em dev: promote sem validação → 409 com mensagem acionável; validar → promote passa; editar após verde → stale → 409; ack de warnings → passa; force por tenant_admin → 403; force por admin → 200 + linha de auditoria; **os 8 caminhos** testados um a um; com gate OFF → comportamento byte-idêntico ao atual (suite de regressão).

**Fecho**: commit; adversarial dedicado (1 agente tenta burlar o gate pelos 8 caminhos + injection no estágio B); deploy com gate OFF; smoke; ligar gate em prod; validar com projeto real; persistir memória.

---

## ONDA 4 — Tri-pane (F3)

### T4.1 — Endpoints de escrita spec-file/spec-dir
- Sub: GET/PUT/POST/DELETE + If-Match `content_sha256` (409 CONFLICT) + status-guard (T0.1 herdado) + guard runner (T0.5) + sanitização (T1.3) + `spec_dirty_at`; reshape do `spec-files` (sem `filePath` absoluto; cap+truncated); `spec-file-content?path=`.
- **PRÉ**: contrato atual do spec-files consumido pelo portal (não quebrar o `/spec` até o switch).
- **PÓS**: CRUD completo via curl com token tenant; If-Match divergente → 409; path hostil → 400; runner token → 403 write / 200 read; listagem sem path absoluto.

### T4.2 — CodeExplorer parametrizado + tri-pane no `/spec`
- Sub: props `{fetchContent, editable, onSave, onSelectionChange, rootLabel, headerTitle, renderPreview}` (default = comportamento atual do Código — zero regressão); `/spec?editProjectId` ganha árvore quando >1 arquivo (spec 1-arquivo mantém layout atual); editor com dirty-state + save via PUT If-Match; mobile: Drawer + FAB existentes.
- **PRÉ**: screenshot/baseline da aba Código e do `/spec` atual.
- **PÓS**: aba Código idêntica (regressão visual); spec multi-arquivo abre tri-pane, edita, salva, conflita corretamente (2 abas); spec 1-arquivo inalterada; build verde (gotcha: import não-usado quebra build).

### T4.3 — Chat: novo contrato (edits estruturados + diff)
- Sub: contexto = arquivo selecionado (32KB); agente devolve `[{file, new_content}]`; UI mostra diff aceitar/rejeitar; aplicar = PUT spec-file server-side; histórico `GET` com ACL; migration `user_id/file_path`; rate-limits + budget-check por msg; `max_tokens` 4k.
- **PRÉ**: fluxo atual do chat (regenera spec inteira) como baseline; custo/msg medido.
- **PÓS**: pedir mudança num arquivo → diff só daquele arquivo → aceitar aplica e recusa não aplica; custo/msg medido ≤ ~US$0,10; cross-tenant → 403; msgs aparecem no histórico.

**Fecho**: commit; deploy; smoke em prod com produto real; persistir memória.

---

## ONDA 5 — Dashboards (F5)

### T5.1 — Migration severity + classificação na emissão + backfill heurístico
- **PRÉ**: distribuição real de `event_type` em prod (query) — valida a heurística.
- Sub: ADD COLUMN default 'info' (sem CHECK que escaneia) + índice parcial; heurística no backfill; classificação nos 3 emissores Python + rota + INSERTs diretos (varredura completa — lista da auditoria).
- **PÓS**: boot limpo; backfill marca errors/escalations como warning/critical (amostra); INSERT novo do cyborg com erro → `critical`.

### T5.2 — `GET /api/dashboard/summary` (query-on-read, D5)
- Sub: 1 query agregada (tasks, custo por projeto via CASE, últimas 3 msgs importantes LATERAL, run aberta com vivacidade gateada); `?tenantId` padrão master + teste de contrato; nega `svc:runner`; seção admin (`requireAdmin`): novos tenants, aguardando pagamento (`inactive`+charge), inativos-manuais, suspensos, MRR (leitura de finance/summary).
- **PRÉ**: EXPLAIN da query com dados de prod-like; medir p95 (<300ms alvo) — se estourar, é o gatilho da materialização (D5), não antes.
- **PÓS**: summary de tenant bate com o detalhe dos projetos (reconciliação manual de 3 projetos); master com `?tenantId` OK, sem → agregado global; tenant não vê seção admin; runner token → 403.

### T5.3 — Home `/dashboard` evoluída
- Sub: cards fábrica/bancada com KPIs (tasks, task atual, tempo, custo, agente atual, msgs) consumindo o summary; preservar aviso 064 + ordenação running-first; responsivo.
- **PRÉ**: baseline da home atual (o que preservar está inventariado na auditoria).
- **PÓS**: home carrega em 1 request de summary (network tab); dados batem com páginas de detalhe; nada da home antiga regrediu; mobile OK.

**Fecho**: commit; adversarial final de regressão da suíte inteira; deploy; verificação em prod; **e-mail de conclusão ao Jean**; persistir memória (LEI 0); FF `main`.

---

## Regras transversais de execução

1. **Validação PRÉ sempre captura o estado real** (reproduzir o bug/comportamento antes de mexer) — se contradisser a premissa do plano, PARAR, reportar no log da tarefa e rodar adversarial pontual.
2. **Validação PÓS prova o efeito vivo** (nunca só "compilou/healthy") — teste automatizado + verificação manual do comportamento novo E do legado.
3. **Dúvida técnica** → adversarial pontual (agente Fable) antes de decidir; **decisão de produto nova** → e-mail ao Jean, não bloquear as demais frentes.
4. Deploy por onda: build local 3-composes → ECR → prod pull/retag/recreate (api primeiro) → **digest verificado** → smoke público. Rollback tags antes de cada recreate.
5. Features de risco nascem atrás de env-gate OFF (gate de validação: `SPEC_VALIDATION_GATE`), padrão H3/rota B.
6. Memória persistida ao fim de cada onda (LEI 0).

---

## Pós-execução — status, achados e diferimentos (2026-09-03)

### Achado P0 na Validação PÓS ao vivo do T4.3 (corrigido em prod)
A revisão adversarial ao vivo do chat por-arquivo expôs perda de dados: o modo por-arquivo
roteava pelo CTO em `spec_intake_and_normalize`, que é um **normalizador** — regenerava um
`PRODUCT_SPEC` completo (Metadados/Visão/FRs/DoD…) e **descartava o conteúdo original do
arquivo**; aplicar a revisão sobrescreveria o arquivo real com um scaffold TBD.

**Correção (em prod):** o modo por-arquivo passou a usar `/invoke/raw` (síncrono, prompt
controlado) com um prompt de **editor cirúrgico** que devolve o conteúdo FINAL COMPLETO do
arquivo preservando tudo o que não foi pedido. O chat da **spec inteira** mantém o
normalizador (correto lá). Resposta vazia = erro (nunca aplica lixo); cerca de código externa
é removida (`stripOuterFence`). Provado ao vivo: original de 106 chars preservado 100% + linha
pedida anexada. A UI de **aplicar sob confirmação** (char count antes de aplicar) permanece
como rede de segurança. Rollback: `rollback-api:pre-t43-rawfix`.

### Item 6 — catálogo de arquétipos → Connect: **DIFERIDO**
Hoje o catálogo (`archetype-catalog`) vive no Genesis e serve à validação de spec. Promovê-lo a
contrato versionado no Connect só se justifica quando **houver um 2º consumidor** (ex.: Deadpool
validando arquétipos na remediação). Gatilho de retomada: surgimento do 2º consumidor. Até lá,
mover para o Connect seria acoplamento especulativo sem valor (ADR-001/consumo-por-versão).

### Item 7 — materialização do dashboard summary: **DIFERIDO** (D5)
`GET /api/dashboard/summary` é query-on-read por decisão D5. Materializar (tabela/rollup) só se
o **p95 medido** da query estourar o alvo de **300ms** com dados de prod. Gatilho de retomada:
medição de p95 > 300ms (EXPLAIN + amostra real), conforme a PRÉ do T5.2. Materializar antes seria
otimização prematura.

### Item 5 — auto-validação (tick env-gated): coberto por regressão durável
Em vez de teste de stack ao vivo (flag `SPEC_VALIDATION_AUTO` **OFF em prod** = zero risco),
a Validação PÓS virou regressão durável em `specValidation.test.ts`: flag off = no-op sem tocar
o banco; flag on = limpa `spec_dirty_at` **antes** de disparar (não vira loop por ciclo).
