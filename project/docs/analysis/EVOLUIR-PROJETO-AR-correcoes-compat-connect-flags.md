> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO — AR: correções dos defeitos D-6..D-13 (execuções reais da 4.5)

Branch `evo/q2` (base `8faa378`). Origem: relatório AP, seção 5. Escopo: api-node, portal (contrato de erros) e documentação. Não toca o orchestrator Python (frente `evo/q1`). Sem push, sem produção.

## 1. Resumo por defeito

| # | Correção | Onde | Teste (falha sem a correção) |
|---|---|---|---|
| D-6 | O planner escreve `## Compatibilidade` / `- Tipo (SemVer): X` no RFC quando o arquiteto não a trouxe (`ensureCompatSection`); Correção sem compat declarada ⇒ PATCH (`withKindDefaultCompat`); o prompt do card exige a seção e manda PATCH em Correção. Gate intacto (tipo reconhecido não é alterado; Correção MINOR continua recusada). | `services/evolutionPlanner.ts` (`ensureCompatSection`, `withKindDefaultCompat`, `buildEvolutionPlanRequest`, `applyEvolutionPlan`; contexto lê `tickets.change_kind`) | `evolutionPlanner.test.ts`: 4 testes (1 reescrito: antes afirmava o comportamento defeituoso `explicit:false`) |
| D-7 | O gate `CONNECT_MISSING` **não foi afrouxado**. O pai da execução real também não tinha `connect.yaml`, então não há o que herdar; a menor mudança segura foi tornar o passo explícito: mensagem da jornada + `action {POST /api/projects/<filho>/connect-declaration}` no 409 do promote do filho. | `services/promotability.ts` (`connectMissingForEvolution`, `assessEvolutionReadiness`), `routes/pipeline.ts` (409 devolve `action`) | `promotability.test.ts` (3), `pipeline.promote.test.ts` (1) |
| D-8 | Leitura da tabela aceita `on/true/1/off/false/0` (+`shadow` no tri) como o ambiente; escrita (`PUT`) normaliza para inteiro canônico e recusa lixo com `400 INVALID_FLAG_VALUE`; `GET .../resolved` ganha `rolloutFlags` (`value`, `source`, `ignored[]` com as linhas descartadas). Chaves planas antigas preservadas (o runner filtra por chave). | `services/featureFlags.ts` (`parseFlagConfigValue`, `normalizeFlagValueForWrite`), `routes/runtimeConfig.ts` | `featureFlags.test.ts` (2), `runtimeConfig.flags.pg.integration.test.ts` (3) |
| D-9 | `GET /api/admin/llm-guard/settings` devolve `advisor` (modo da API, modos informados por chamadores, `divergent`, gasto 24 h do ledger, avisos PT-BR); evento `roles_mode_divergence` na transição; chamadores informam `rolesMode` (opcional) em `preflight`/`advisor-gate`; teto legado **opt-in** `ADVISOR_LEGACY_CAP_USD` limita o Advisor sem política (padrão desligado). Defaults de produção inalterados. | `services/llmGuard.ts` (`noteCallerRolesMode`, `advisorStatus`, `advisorGate`), `routes/llmGuard.ts` | `advisorStatus.pg.integration.test.ts` (3) |
| D-12 | `denyMissingSubject`: token sem `sub` ⇒ `401 UNAUTHORIZED` antes de tocar o banco (em `denyMutation` e `denyOperate`). Código novo na tabela de erros de card e no espelho do portal. | `routes/cards.ts`, `services/cardErrors.ts`, `apps/genesis-web/lib/cards/__contract__/error-codes.json` | `cards.subject.pg.integration.test.ts` (2) |
| D-13 | O corpo do PR deixa de afirmar "rodaram": seção "Gates da fábrica" com **passou / FALHOU / não executado/sem evidência** para escopo, símbolos e QA, lidos do checkpoint (`evolution_violations`) e do diálogo (`qa.review`, "não aprovada"). | `services/evolutionAccept.ts` (`describeFactoryGates`, `renderGateLines`) | `evolutionAccept.test.ts` (3) |
| R-2 | Orientação operacional registrada (A14). | Runbook | n/a |

Documentação: `project/docs/guides/GUIA-CARDS-BANCADA.md` (§5 e §8: passo do `connect.yaml`), `project/docs/runbooks/CARDS-BANCADA-RUNBOOK.md` (§2.5 `CONNECT_MISSING`, nova §2.6 compatibilidade, nova §11.1 notas da AR, assunções A13b e A14).

## 2. Verificação

- Postgres efêmero (`q2-pg` 55440, `q2-pg2` 55432), `apply-migrations-test.ts`, `npx tsc --noEmit` (api-node e genesis-web): limpos.
- api-node, suíte completa (55440): 245 arquivos passam, **4102 testes passam**, 26 skip. Falhas: `src/integration.test.ts` (9, de login 401) — **pré-existentes**: reproduzidas idênticas (9 falhas) com `git stash -u` sobre a base `8faa378`; e as 4 suítes de porta fixa, que na 55440 falham por desenho e **passam na 55432** (25/25, duas execuções seguidas; uma execução intermediária falhou por estado residual do banco reutilizado).
- Portal (`apps/genesis-web`): 329/329 (baseline 329), `tsc` limpo. O espelho `error-codes.json` foi editado à mão (1 entrada, após `FORBIDDEN`) em vez de regenerado, para não tocar nas ~90 fixtures.
- **Mutação:** com as correções de código revertidas (`git stash` dos 9 arquivos de produção, testes mantidos), os 19 testes novos/alterados falham (19 falhas; as falhas incluem os efeitos comportamentais D-12 401, D-7 `action` no 409, D-6 seção ausente no RFC em disco, D-13 texto "rodaram"). Restaurado em seguida; tudo verde.

## 3. Evidência (arquivo:linha, worktree)

- D-6: `evolutionPlanner.ts` — `ensureCompatSection` e `withKindDefaultCompat` antes de `applyEvolutionPlan`; chamada no laço de RFCs (`const content = ensureCompatSection(...)`); prompt em `buildEvolutionPlanRequest` (bloco `ESCOPO DO CARD`).
- D-7: `promotability.ts` — `connectMissingForEvolution` e ramo `CONNECT_MISSING` de `assessEvolutionReadiness`; `pipeline.ts` ~222.
- D-8: `featureFlags.ts` — `parseFlagConfigValue` (usado por `parseConfigValue`); `runtimeConfig.ts` — bloco `rolloutFlags` no `GET .../resolved` e `INVALID_FLAG_VALUE` no `PUT`.
- D-9: `llmGuard.ts` — `noteCallerRolesMode`, `advisorStatus`, ramo `!p` de `advisorGate`; `routes/llmGuard.ts` — `advisor: await advisorStatus(pool)` no GET de settings.
- D-12: `cards.ts` — `denyMissingSubject` (início do arquivo, antes de `denyMutation`).
- D-13: `evolutionAccept.ts` — `describeFactoryGates`/`renderGateLines`, usados por `buildPullRequestBody`.

## 4. Riscos e limites aceitos

1. **D-7 não elimina o 409**: é explicitado. Herdar não resolve quando o pai nunca teve o arquivo; gerar automaticamente gastaria LLM (~US$ 0,07) sem pedido do usuário. Alternativa futura: gerar na promoção do card, com consentimento.
2. **D-6**: a compat agora "declarada" pelo planner conta como explícita para o merge automático, ainda que tenha nascido do default `minor` do código quando o LLM omitiu. É o que o pedido determina (sempre declarar); o teto `EVOLUTION_AUTO_MERGE_MAX_COMPAT`, `blocked_major` e o gate de tipo da Correção seguem valendo. O teste GAP-60 "(c) implícito" foi atualizado porque encodava o defeito.
3. **D-8**: `CARDS_BANCADA='on'` por SQL passa a valer, mas **sem backfill** (só o `PUT` o dispara); documentado no runbook. O espelho do portal foi editado à mão.
4. **D-9**: a detecção de divergência depende de o chamador enviar `rolesMode`; hoje os clientes Python (fora do escopo, `evo/q1`) ainda não enviam, então só o aviso por modo da API e o gasto do ledger funcionam de imediato. O teto legado só conta com a API em `shadow|on` (o ledger só distingue papéis nesses modos). Estado do rastreio de divergência é em memória (zera no reinício; o evento persiste).
5. **D-13**: escopo/símbolos cobrem só as escritas do Dev (D-1, o Cyborg fora do gate, segue aberto no orchestrator). A leitura de QA é heurística sobre o texto do diálogo (`qa.review`, "não aprovada", "QA atingiu máximo"); sem checkpoint ou diálogo o texto diz "não executado/sem evidência", nunca "passou".
6. Ficam abertos D-1..D-5, D-10, D-11 (orchestrator/produto) e a frente do runner.

## 5. Arquivos

Produção: `evolutionPlanner.ts`, `promotability.ts`, `routes/pipeline.ts`, `featureFlags.ts`, `routes/runtimeConfig.ts`, `llmGuard.ts`, `routes/llmGuard.ts`, `routes/cards.ts`, `evolutionAccept.ts`, `cardErrors.ts`, `genesis-web/lib/cards/__contract__/error-codes.json`.
Testes: `evolutionPlanner.test.ts`, `promotability.test.ts`, `pipeline.promote.test.ts`, `featureFlags.test.ts`, `evolutionAccept.test.ts`, `cardErrors.test.ts`; novos `runtimeConfig.flags.pg.integration.test.ts`, `advisorStatus.pg.integration.test.ts`, `cards.subject.pg.integration.test.ts`.
Docs: guia, runbook e este relatório.
