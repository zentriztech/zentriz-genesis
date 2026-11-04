> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# AN — Revisão adversarial independente: Guard de custo (C3'/C4') e Fases 5/6 (dev `e869152`)

**Escopo revisado:** commits `c6c7bcd` (C3'), `8a261b4` (C4'), `80fd11e` (5.1/5.2), `b8773f9` (6.2/6.4), mesclados em `e869152`. Leitura no worktree limpo `~/workspace/current/zentriz/.worktrees/g-chk9`. `b66d214` (AK) fora do escopo.
**Referência:** `zentriz-autonomy-suite/evolution/27-desenho-controle-de-gasto.md` §1, §3, §4 (aceites), §5.
**Método:** leitura do código (não dos relatórios AJ/AL/AM), com rastreio de chamadores e de flags. **Testes não executados**: os achados abaixo são determinísticos pela leitura (try/catch, predicados SQL, prefixos de código), e os testes existentes não cobrem os caminhos apontados (§9). Nada foi alterado no código.

## Veredito: **APROVADO COM CORREÇÕES**

Não há bloqueante: com as políticas ausentes (estado de produção hoje), o fluxo legado fica preservado e nenhum caminho novo libera gasto que antes era negado. Há **4 achados de severidade alta**. Eles precisam ser corrigidos **antes de gravar a primeira linha `advisor_pct`/`card_budget_pct` em produção** e antes de declarar 5.1 "funcional".

---

## Alta

### A1 — Fail-open na leitura de `cost_policies` (contraria o §5 do desenho e os relatórios AL/AM)
- **Onde:** `services/costPolicies.ts:218-229`. `getEffectivePolicy` captura **qualquer** erro e devolve `null`. Os consumidores tratam `null` como "sem política":
  - `llmGuard.ts:498,506` (`advisorGate`): `if (!p) return { allow: true, mode: "legacy" }`. Um erro na leitura da política faz o teto % ceder ao teto legado em memória/env (`ADVISOR_MAX_USD_PER_RUN`, padrão US$ 5 por processo, que zera no restart). O §5 do desenho proíbe isso ("estado do teto só em memória").
  - `llmGuard.ts:562-563` (`cardBudgetCheck`): `if (!p) return { applies: false }`. **O teto do card é ignorado** naquela chamada.
  - `breakerOverrides` (`costPolicies.ts:284`): numa falha, o disjuntor volta para `llm_guard_settings`. Se a política tinha **baixado** o disjuntor, ele sobe em silêncio.
- **Cenário:** com a política gravada, um erro transitório (conexão reciclada, `statement_timeout`, lock) ou a tabela ausente após um rollback da 161 → o Advisor ou o card passam sem o teto configurado. Nenhum evento é gravado.
- **Contra o desenho:** "fail-open no gasto" está no §5. O AJ diz "volta ao comportamento anterior". Isso só é aceitável quando a linha **não existe**. Quando a leitura **falha**, não se sabe se a linha existe. O AL ("falha de leitura nega o Advisor") e o AM ("erro de leitura lança ⇒ GUARD_ERROR") afirmam o contrário do código.
- **Por que os testes passam:** `advisorGate.pg.integration.test.ts:150-152` quebra o banco **inteiro**, e o que cai no `catch` é o `resolveBudgetOwner`. `cardBudget.f5.pg.integration.test.ts:177` quebra só `FROM tickets`. Nenhum teste quebra apenas `cost_policies`.
- **Correção:** separar "sem linha" (`null`) de "erro" (lançar). No Advisor e no card, o erro deve negar (o `catch` externo já faz isso). No disjuntor, o erro deve aplicar o **menor** entre a política (se conhecida) e o setting. Vale como teste: um `Queryable` que rejeita só `/cost_policies/` precisa resultar em negativa.

### A2 — `CARD_BUDGET_CAP` não aciona a sincronização do card nem é reconhecido pelo runner (o card não vira `blocked` sozinho)
- **Onde:**
  - `routes/llmGuard.ts:90`: `if (String(decision.code).startsWith("BUDGET")) scheduleCardSync(...)`. O código `CARD_BUDGET_CAP` começa por `CARD` e **não** dispara o gancho Y-14.
  - `services/cardPromote.ts:231-235`: os candidatos do reconciliador só incluem filho `stopped`+`stopped_by='budget'`. Um filho **vivo** em Bancada (`draft`/`spec_submitted`, fora de `FACTORY_ACTIVE_STATUSES`, `llmGuard.ts:49`, e que portanto o preflight **não** para) nunca é candidato. Também não é candidato o filho `in_factory` que não foi parado.
  - `orchestrator/guard_denial.py:26-32`: `CARD_BUDGET_CAP` não está em `BUDGET_CODES` nem em `GUARD_CODES`. O runner trata a negativa como `DENIED` genérica e faz até 10 reverificações com backoff (30 s até 300 s, cerca de 40 min) antes de parar. Como o teto não se resolve com o tempo, a espera é inútil, e a mensagem ao usuário não traz o código.
- **Cenário:** um card promovido com filho em Bancada estoura o teto. Toda chamada é negada (402 `CARD_BUDGET_CAP`), mas o card continua `promoted`/`in_factory` até alguém abrir a jornada (`routes/cards.ts:504,534`). Sem `EVOLVE_RECONCILER=on`, nem o caso da fábrica (filho parado) é alinhado automaticamente.
- **Por que os testes passam:** `cardBudget.f5…test.ts:132,148` chamam `syncCardWithChild` **diretamente**. O teste "Bancada" usa filho `running` (`:146`), status que **é** de fábrica, e não um status real de Bancada.
- **Contradição na doc:** o runbook (`CARDS-BANCADA-RUNBOOK.md:104`) diz que "o gancho das rotas internas do Guard alinha o card sem ninguém olhar a jornada". Para `CARD_BUDGET_CAP`, isso é falso.
- **Correção:** incluir `CARD_BUDGET_CAP` no gancho (`startsWith("BUDGET") || code === "CARD_BUDGET_CAP"`) e em `BUDGET_CODES` do runner. Ampliar o predicado do reconciliador (ou acrescentar um passe por `card_cap_reached` recente). Testar via `app.inject` na rota de preflight, com filho em `spec_submitted`.

### A3 — Rotas internas do Guard aceitam JWT de `tenant_admin` sem amarrar o tenant (IDOR entre tenants; a nova rota amplia o vetor)
- **Onde:** `routes/internalLlm.ts:37` aceita `payload.role === "tenant_admin"` como autenticação interna. O nginx publica `/api` inteiro (`project/infra/aws/user_data.sh.tpl:262`), então `/api/internal/*` é alcançável pela internet com o JWT do portal. A rota de `project-llm-config` restringe o tenant (`internalLlm.ts:81`). As rotas do Guard (`routes/llmGuard.ts:64-115`) **não** restringem: `resolveProjectId` usa o `projectId` do corpo (`runnerProjectOf` só amarra `svc:"runner"`).
- **Cenários (tenant_admin do tenant A contra um projeto do tenant B):**
  1. **Novo (C4'):** `POST /api/internal/llm-guard/advisor-gate` com `projectId` de B devolve `baseUsd`, `capUsd`, `spentUsd`, `pct` e `policyAuthor` (**e-mail**, PII) e grava eventos `advisor_*` no projeto de B.
  2. **Novo efeito (F5):** `POST /preflight` com `projectId` = filho de card de B e `estInputTokens` inflado leva a `cardBudgetCheck` negativo e a `UPDATE projects SET status='stopped', stopped_by='budget'` (`llmGuard.ts:436-443`): o filho de B é parado.
  3. Vetor **pré-existente** pela mesma causa: `pauseForBudget` por estimativa inflada (`llmGuard.ts:426-431`) e `/record` com custo fictício. Por exemplo, um `llm_role:"advisor"` falso esgota o teto do Advisor de B.
- **Correção:** nas rotas do Guard, quando `auth.payload?.role === "tenant_admin"`, exigir `projects.tenant_id = payload.tenantId` (mesma regra de `internalLlm.ts:81`), ou aceitar ali só o token estático e `svc:"runner"`. A causa raiz é anterior a esta entrega, mas a C4' acrescentou uma rota que vaza dado financeiro e PII, e a F5 acrescentou um efeito destrutivo. Por isso a severidade é alta.

### A4 — Janela em que o card fica sem saída: o preflight nega, o gate de retomada libera
- **Onde:** `llmGuard.ts:436` (preflight, com `est` da chamada) × `llmGuard.ts:929` (`checkProjectBudgetGate` → `cardBudgetCheck(db, projectId)` com **estimativa 0**).
- **Cenário:** com `cap − est < gasto ≤ cap`, o preflight nega toda chamada, mas o gate responde `ok`. Consequências: `syncCardWithChild` (`cardPromote.ts:193-198`) **não** bloqueia; um card `blocked` cai em `budget_released` (`:200-204`); `resume` libera; o filho é religado e volta a ser negado na primeira chamada. Isso vira um laço de retomadas sem sinal no quadro. O ramo análogo do orçamento do dono evita esse problema com `minNextActivityUsd` (`llmGuard.ts:926`).
- **Correção:** usar no gate o mesmo critério de "próxima atividade" (por exemplo, `minNextActivityUsd` ou a mediana do ledger do card) em vez de 0.

## Média

- **M1 — Gasto do Advisor depende de o `LLM_ROLES_MODE` da API estar ligado** (`llmGuard.ts:613-614`; `advisorSpentUsd`, `:466`). Com a API em `off` e o `agents` em `on`, o ledger grava `llm_role=NULL`, `advisorSpentUsd` fica em 0 para sempre e o teto % **nunca** é atingido (fail-open silencioso). O plano de rollout (doc 26, l. 67) pede o mesmo valor nos três processos, mas o gate não se defende. **Correção (1 linha):** em `advisorGate`, se houver política e `llmRolesMode()==="off"`, negar com `advisor_denied_no_base`/`reason: roles_off`.
- **M2 — Supercontagem do gasto do Advisor:** quando a escalada é negada, o plano devolve `llm_role=advisor, effective_role=orchestrator` (`llm_roles.py`, `plan_attempt`; `llm_guard.py:128`), e esse custo, executado pelo Orchestrator, entra em `advisorSpentUsd` (`llm_role='advisor'`). O teto do Advisor é consumido por chamadas que não são dele, e depois de atingido continua crescendo. Avaliar `effective_role='advisor'` (o desenho fala em `llm_role`, mas a intenção é o gasto do Advisor).
- **M3 — Escopo tenant **substitui** o global, sem teto de plataforma** (`costPolicies.ts:223`, `routes/costPolicies.ts:30`). Um `tenant_admin` grava `advisor_pct=100` e anula o global conservador do operador. O §1.4 pede "o mais restritivo vence". Ou o global vira teto máximo do tenant, ou a decisão fica registrada pelo Jean. O `ADVISOR_MAX_USD_PER_RUN=0` ("sem Advisor") do operador também é ignorado em `mode:"policy"` (`llm_roles.py:424`).
- **M4 — Disjuntor por política só vale no preflight:** o pós-registro (`llmGuard.ts:649-653`) ainda usa `llm_guard_settings`. Se a política **subir** o teto (por exemplo, 80/h com setting 40/h), o `record` liga o `KILL_SWITCH` aos 40 e derruba a plataforma toda. Se a política **baixar**, o disparo só acontece na chamada seguinte.
- **M5 — Base do Advisor e do card é o `budget_usd` vivo**, não fixada na configuração (§1.1: "base explícita, persistida e fixada na hora da configuração"; §3.1: "snapshot"). O snapshot gravado é o da política (versão/autor), não o da base. O piso na gravação só é checado se o chamador mandar `baseBudgetUsd` (`routes/costPolicies.ts:77-84`), e o PUT do orçamento do projeto não recusa orçamento abaixo do piso (§3.1). Está registrado como assunção no AL, mas é desvio do desenho e precisa de decisão do Jean.
- **M6 — Desvio do teto do card por split:** `cardSpentUsd` soma só o rascunho e o filho direto (`llmGuard.ts:569`). Filhos de split do filho não entram (assunção do AM). Um card que se divide escapa do teto.
- **M7 — Desempenho:** não há índice em `llm_call_ledger(project_id)` (só `budget_project_id`, `tenant_id`, `llm_role`, migrations 131/135/140). Por isso `cardSpentUsd` (em **todo** preflight de card com política) e as métricas (`cardMetrics.ts:75`, `LEFT JOIN … ON l.project_id IN (draft, child)`, laço aninhado por card) varrem o ledger. Além disso, `cardBudgetCheck` consulta `tickets` em **todo** preflight, mesmo sem política e de projeto que não é card (`llmGuard.ts:556`), antes de saber se há política. São de +1 a +3 consultas por chamada. **Correção:** ler a política antes (cache por chamada) e criar `idx_llm_ledger_project (project_id)` numa migration expand.
- **M8 — Docs desatualizadas sobre o orçamento por card:** o guia (`GUIA-CARDS-BANCADA.md:136`) diz "não há orçamento próprio por card", e o guia e a RFC-0009 (tabela "Orçamento") não mencionam `card_budget_pct`/`CARD_BUDGET_CAP`. A seção 8 do guia orienta "Retomar" após aumentar o orçamento, mas com `CARD_BUDGET_CAP` o caminho também pode ser subir o percentual. O runbook (`:258`) diz que o tenant_admin grava "só `advisor_pct`", mas o código também permite `card_budget_pct` (`routes/costPolicies.ts:30`).
- **M9 — A6 do runbook (`:456`) deixa sem verificação algo que o código responde:** o filho do card nasce em `spec_submitted`/`draft` (`evolveClaim.ts:787`) e só é promovível à fábrica pelo `evoPath`, que depende de `EVOLUTION_PROMOTE_BANCADA` (`routes/pipeline.ts:144-162`). Sem a flag, `spec_submitted` recebe `409 NOT_ON_WORKBENCH`. Na prática, a flag é **pré-requisito** sempre que o filho herda arquivos. O runbook deve declarar isso.

## Baixa

- **B1 — Corrida entre réplicas e entre runs** no gate do Advisor: o `inflight` é por processo **e por `_adv_scope`** (`llm_roles.py:413`), não por dono. Dois runs do mesmo dono no mesmo processo não veem a reserva um do outro. O desenho adia para a C2'. Documentado.
- **B2 — Ordem de deploy:** api→agents está correta e é fail-closed (404 → `advisor_guard_unreachable`), conferido em `llm_guard.py:297-304`. O inverso (api nova com agents antigo) ninguém chama o gate: a política gravada **não** vale e o legado segue. O runbook deveria dizer isso.
- **B3 — PII:** `author` (e-mail) sai em `GET /api/cost-policies` para qualquer usuário (políticas globais escritas por zentriz_admin), na resposta do `preflight` (`advisorPolicy.author`, entregue a agents/Deadpool) e no `detail` dos eventos `advisor_*`. Basta id ou papel.
- **B4 — Métricas:** `timeInState` conta estados terminais (`delivered`/`rejected`) até `now()` (`cardMetrics.ts:62`), e a média desses estados cresce sem limite. Isolamento por tenant e autorização (`productGuard`) estão corretos. Todos os cards do produto são carregados antes do `limit` (sem paginação SQL), o que é aceitável no volume atual.
- **B5 — `GET /api/cost-policies/history`** responde 400 com `code: "FORBIDDEN"` para zentriz_admin sem `key` (`routes/costPolicies.ts:63`).
- **B6 — Linhas citadas no runbook com pequena deriva:** `routes/projects.ts:3551` (o código `USE_CARD_PROMOTE` está em `:3554`); `cardPromote.ts:291` (a função está em `:299`).

## Pontos conferidos e corretos

- **Autorização de escrita** (`routes/costPolicies.ts:25-34,70`): `svc` negado; `tenant_admin` só no próprio tenant e só nas chaves `advisor_pct`/`card_budget_pct`; `calibrated` só por zentriz_admin (`upsertPolicy` com `allowCalibrated`, `costPolicies.ts:172-173`). Leitura isolada (`visibleScope`). Não há escrita cross-tenant.
- **`BUDGET_MISSING` intacto** (`llmGuard.ts:412-416`). Sem orçamento, o Advisor é negado com evento (§1.2).
- **Advisor negado não derruba a task:** as quatro notas estão em `ESCALATION_DENIED_NOTES`, o `runtime.py:2712` segue no Orchestrator, e o Guard inalcançável é fail-closed só para o Advisor.
- **Card:** não há dupla contagem rascunho/filho (`ANY` e `IN` são conjuntos). O ticket é localizado pelo UUID do projeto (não há card de outro tenant). A negativa não pausa o dono e o card vai a `blocked` (`budget:CARD_BUDGET_CAP`), nunca `failed`, **quando** a sincronização roda (ver A2). Subir o percentual libera pelo ramo `budget_released`.
- **Migration 161:** idempotente (`IF NOT EXISTS`), sem `BEGIN`/`DO $$`, sem `;` em literal nem comentário inline; compatível com o divisor por `;` de `db/init.ts:45-62`.
- **Fluxo legado sem política:** `advisorPolicy` ausente, disjuntor do setting, `cardBudgetCheck` → `applies:false`. A única mudança observável é o custo das consultas extras (M7) e um novo ponto fail-closed se `tickets` falhar (aceitável).
- **Docs, 5 afirmações conferidas:** (1) comentário desatualizado em `src/index.ts:148` ("nem agenda timer") contra `evolveReconciler.ts:599-600` ("sempre agenda"): **correto no runbook**. (2) Modo do reconciliador em `featureFlags.ts:158-163`: **correto**. (3) `USE_CARD_PROMOTE` sem consultar a flag (`cardPromote.ts:299-303`): **correto**. (4) Ordem de deploy api→agents (`:213`): **correto**. (5) "gancho Y-14 alinha o card" (`:104`): **incorreto para `CARD_BUDGET_CAP`** (A2). Também: `:258` está incompleto (M8) e A6 tem resposta no código (M9).

## Testes que passam por natureza (§9)

| Teste | Por que não prova o que declara |
|---|---|
| `advisorGate…test.ts:150` "falha de leitura nega" | Quebra o banco inteiro; o que nega é o `resolveBudgetOwner`, não a leitura da política (A1). |
| `cardBudget.f5…test.ts:177` "fail-closed" | Quebra só `FROM tickets`; uma falha em `cost_policies` é fail-open (A1). |
| `cardBudget.f5…test.ts:132,148` "card vira blocked" | Chama `syncCardWithChild` direto; o gatilho automático (gancho/reconciliador) não é exercitado (A2). |
| `cardBudget.f5…test.ts:142-149` "Bancada" | Usa filho `running` (status de fábrica), não `spec_submitted` (A2). |
| Testes do gate com `LLM_ROLES_MODE=on` forçado (`advisorGate…test.ts:105-106`) | Não cobrem API `off` com agents `on` (M1). |

## Correções mínimas antes de gravar a primeira política em produção

1. A1: separar "sem linha" de "erro" em `getEffectivePolicy` e testar a falha isolada em `cost_policies`.
2. A2: `CARD_BUDGET_CAP` no gancho de rota, em `BUDGET_CODES` do runner e no predicado do reconciliador; testar via rota com filho em Bancada.
3. A3: amarrar `tenant_admin` ao tenant do projeto nas rotas `/api/internal/llm-guard/*`.
4. A4: gate de retomada do card com a estimativa da próxima atividade.
5. M1: o gate nega quando a API está com `LLM_ROLES_MODE=off` e existe política.
6. Atualizar o runbook (`:104`, `:258`, A6), o guia (`:136`, §8) e a RFC-0009 (tabela "Orçamento").

**Decisões do Jean pendentes:** M3 (o tenant pode exceder o global?) e M5 (base fixada vs. orçamento vivo; recusa do orçamento abaixo do piso).
