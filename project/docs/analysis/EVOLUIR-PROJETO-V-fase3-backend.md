> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Evoluir projeto na Bancada (V) — Fase 3: backend dos cards (tarefas 3.3 e 3.5)

**Data:** 2026-11-04 · **Repositório:** `zentriz-genesis` · **Branch:** `evo/k1` (a partir da `dev`, sobre `4530ffc`) · **Worktree:** `.worktrees/g-k1` · **Papel:** executor. Sem produção, sem push, sem deploy, Guard (`llmGuard.ts`) intocado, sem PII, sem LLM real (agents sempre stub).
**Antecedentes:** [R](EVOLUIR-PROJETO-R-fase2-api-de-cards.md) (API de cards; pendências que esta fase fecha), [P](EVOLUIR-PROJETO-P-fase2-dados-do-card.md), [S](EVOLUIR-PROJETO-S-revisao-adversarial-fase2-dados.md), [T](EVOLUIR-PROJETO-T-correcoes-fase2-lote-a.md), [U](EVOLUIR-PROJETO-U-correcoes-fase2-lote-b.md), [H](EVOLUIR-PROJETO-H-desenho-tecnico-advisor.md) §4–§6.
**Convenção:** caminhos relativos a `applications/services/api-node/src/`. **Estado:** preparado e validado em Postgres efêmero; **não funcional em produção** (nada implantado; `CARDS_BANCADA` segue desligada em todo lugar). Só api-node e testes; as telas são da frente g-k2 (portal não foi tocado).

## 1. Commits (locais, em `evo/k1`)

| Commit | Conteúdo |
|---|---|
| `eafd8f9` | Serviços: `services/cardSpecGuard.ts` (trava, escopo, contexto somente leitura), `cardRevalidate.ts`, `cardJourney.ts`, `cardAttachments.ts`, `cardErrors.ts`; `cardService.ts` (`spec_locked`, `reopenCard`, `revalidateCard` ok\|stale\|conflict, `loadBaseSpecForDraft`), `cardPromote.ts` (bloqueio por orçamento, `resume`, `syncCardsWithChildren`), `evolveReconciler.ts` |
| `96baf35` | `routes/cards.ts` (reopen, journey, attachments, revalidate novo, resume por orçamento, `userMessage`), chave `CARD_BASE_CONTEXT_CHARS` em `routes/runtimeConfig.ts` |
| `6797bda` | Escritores de spec respeitando trava/escopo e lendo a base: `specFiles.ts`, `projects.ts` (spec-content), `evolutionPlan.ts`, `specSplit.ts`, `connectDeclaration.ts`, `specChat.ts`, `specAutonomy.ts`, `specValidation.ts`, `evolutionPlanner.ts`, `promotability.ts`, `pipeline.ts` |
| `f0d65b0` | Ajuste dos testes da Fase 2 (PATCH em `ready` agora trava; guarda estática de arquivos de card) |
| `1a125ae` | Correções achadas pelos testes (ver §4, itens 9 e 10) |
| `ddebc9c` + commit seguinte | Testes novos e este relatório |

## 2. Contrato

Todas as rotas abaixo exigem autenticação e `CARDS_BANCADA` do tenant (flag off ⇒ `404 {code:"NOT_FOUND", message:"Recurso indisponível"}`, byte a byte como antes, **sem** `userMessage`). Mutações: `zentriz_admin` ⇒ 403, token de serviço ⇒ 403. Em **toda** resposta de erro das rotas de card o corpo ganha `userMessage` (tabela do §3); o `message` técnico de sempre continua.

### 2.1 Rotas novas ou alteradas

| Rota | Entrada | Saída |
|---|---|---|
| `POST /api/cards/:id/reopen` | — | `200 {ok, replayed, card, message}`. `ready → refining` pela máquina (ator `user`, motivo `user_reopen`, evento em `ticket_card_events`), apaga o carimbo `extra.card_ready` do rascunho. Já em `refining` ⇒ `replayed:true`. Outros estados ⇒ `409 CARD_INVALID_TRANSITION` |
| `POST /api/cards/:id/revalidate` | — | `200 {ok, result: "ok"\|"stale"\|"conflict", reasons[], rebased, reopened, card, base{headProjectId, headVersion, previousHeadProjectId}, checks{globs[], repo, specDiff}, next, message}`. `ok = result !== "conflict"`. Estados fora de draft/refining/ready ⇒ `409 CARD_INVALID_TRANSITION`; sem HEAD ⇒ `409 NO_ACCEPTED_HEAD` |
| `GET /api/cards/:id/journey` | — | `200` jornada (§2.3) |
| `GET /api/cards/:id/attachments` | — | `200 {items[], strict, conversionEnabled, summary}`; cada item traz `conversion.state` (§2.4) |
| `POST /api/cards/:id/resume` | — | além do contrato da Fase 2: bloqueio de **orçamento** ainda negado ⇒ `402 {code:"CARD_BUDGET_BLOCKED", guardCode, cardState:"blocked"}`; com saldo ⇒ `200 {ok, card, childRestartRequired?, next?}` (`next: POST /api/projects/:filho/run` quando o filho segue `stopped`) |
| `GET /api/cards/:id` | — | `actions.reopen` (true em `ready`); `actions.edit` só em draft/refining |
| `PATCH /api/cards/:id` e `PATCH /api/tickets/:id` (card) | — | em `ready` ⇒ `409 CARD_SPEC_LOCKED {state, canReopen, cardId, reopen}` (antes: reabria sozinho) |

**Revalidação** (`ok|stale|conflict`), motivos (`reasons[].code`, com `severity` conflict\|warning\|info):

| `result` | Quando | Efeito |
|---|---|---|
| `ok` | a base registrada **é** o HEAD e nada nele contradiz o card | nada muda (o card continua `ready` se estava) |
| `stale` | o HEAD andou (`BASE_MOVED`) ou a spec do mesmo HEAD mudou (`BASE_SPEC_CHANGED`), sem conflito | rebaseia (`card_base`, `evolution_parent_id`, dono do orçamento compartilhado), apaga `card_ready`, `ready → refining` |
| `conflict` | `GLOB_NO_LONGER_MATCHES` (glob de `files_allowed` que casava na árvore `apps/` da base anterior e não casa mais no HEAD novo) ou `RFC_REFERENCES_REMOVED_SPEC` (o RFC/pedido cita, por caminho, arquivo de spec removido do HEAD) | **não** rebaseia; apaga `card_ready`; `ready → refining`; o humano ajusta o RFC e revalida |

Avisos que não mudam o resultado: `GLOB_UNMATCHED` (glob que nunca casou — recurso novo cria a pasta; globs `tests/`, `docs/`, `*.md`, `*.test.*` ficam fora, o gate do runner já os libera), `RFC_REFERENCES_CHANGED_SPEC`, `NEEDS_HUMAN_REVIEW` (spec-base mudou), `REPO_UNAVAILABLE` (sem clone em `PROJECT_FILES_ROOT`: os globs **não** foram conferidos — dito na cara), `NO_RFC`. A matemática dos globs é um port de `_glob_to_regex` do runner (com ou sem prefixo `apps/`).

### 2.2 Trava, escopo e contexto dos escritores do rascunho (`card_draft`)

Todo escritor de spec que recebe um `projectId` passa por `services/cardSpecGuard.ts` quando o projeto é `card_draft` (projeto comum: nenhuma consulta nova nas rotas de arquivo; `knownStatus`):

| Escritor | Trava `CARD_SPEC_LOCKED` | Escopo `CARD_PATH_OUT_OF_SCOPE` | Outros |
|---|---|---|---|
| editor de árvore `PUT/POST/DELETE /api/projects/:id/spec-file`, `…/spec-versions/:id/restore` | 409 | 400 | 1ª escrita ⇒ `draft → refining` |
| `PATCH /api/projects/:id/spec-content` | 409 | 400 | `startNow` ⇒ `409 CARD_OPERATION_UNSUPPORTED` |
| Chat IA (`POST /api/spec-chat`, arquivo, spec inteira e Resolver GAPs) | 409 | 400 (`filePath`) | negativa do Guard ⇒ `402` com o código do Guard + `cardId`/`cardState` (o card não muda) |
| modo autônomo / fechamento de GAPs (`POST /api/spec-autonomy` e cada rodada) | 409 no início e **a cada rodada** (`stalled`) | rodada fora do escopo é pulada (`fora do escopo do card`) | rodadas de manifesto e de diagramas desligadas para rascunho |
| planner de RFC (`POST /api/projects/:id/evolution-plan`), `rfc-from-template` | 409 | só `docs/rfc/**` e `docs/adr/**` | plano **não** grava `CHANGELOG.md` nem `connect.yaml` (aviso); orçamento verificado antes |
| `spec-split`, `connect-declaration` | — | — | `409 CARD_OPERATION_UNSUPPORTED` |

- **Escopo gravável:** `tickets/TK-NNNN/**` (do próprio card), `docs/rfc/**`, `docs/adr/**`. Qualquer outra coisa (README, CHANGELOG, connect.yaml, `apps/`, `docs/…`, pasta de outro card) é recusada; a promoção copia para o filho tudo que o rascunho tem fora da pasta do ticket (passo `card_spec`), então isso é o que impede o rascunho de sobrescrever a árvore herdada.
- **Trava:** vale em `ready` e nos estados seguintes (o rascunho vira histórico: `canReopen:false`). Só `reopen` destrava. A promoção continua protegida também pelo hash do carimbo.
- **Contexto somente leitura (A'):** `buildCardBaseContextBlock` reaproveita o helper de `GET /api/cards/:id/base-spec` (`loadBaseSpecForDraft` → `loadBaseSpec`) e entrega a spec da versão corrente (HEAD) rotulada **SOMENTE LEITURA**, com a regra "escreva só em tickets/TK-NNNN/, docs/rfc/, docs/adr/", no prompt do Chat IA (spec inteira e por arquivo), do Resolver GAPs por arquivo (`dispatchGapFileJob`, inclusive o laço autônomo), do planner de RFC (spec vigente = a do HEAD; pedido = texto do card) e do juiz da validação (Estágio B; Estágio A deixa de acusar README/connect do rascunho). Teto do bloco: `CARD_BASE_CONTEXT_CHARS` (config; 14 000 sem a chave, calibrado=falso). Para projeto que não é rascunho o bloco é `""`: prompts byte a byte como antes (teste).
- **Orçamento:** o rascunho aponta `budget_owner_project_id` para o dono da versão corrente (e a revalidação `stale` o acompanha); o Chat/planner consultam o Guard (`checkProjectBudgetGate`) antes de gastar.

### 2.3 Jornada (`GET /api/cards/:id/journey`)

Mesma forma da `Journey` da Bancada de specs (`steps`, `current`, `action`, `headline`, `detail`, `severity`) mais o que o card precisa:

```
{ cardId, code, state, kind, phase: editing|ready|running|blocked|delivered|rejected,
  steps: [{key,label,state: done|current|todo|blocked}] // draft→refining→ready→promoted→in_factory→delivered
         ("Rascunho","Refinando","Pronto","Promovido","Na fábrica","Entregue"),
  current, next, blockers: [{code,message,userMessage,details?}],      // o que impede a PRÓXIMA etapa
  action: {key,label,method,path,enabled} | null,                      // próxima ação sugerida
  headline, detail, severity, blocked: {reason,kind: budget|child|materialization|other,resumable} | null,
  spec: {locked, canReopen}, base: {headProjectId, headVersion, currentHeadProjectId, currentHeadVersion, stale} | null,
  execution: {childProjectId,status,title,prUrl} | null }
```

Bloqueios reaproveitam quem decide de verdade: gate de RFC por tipo (`evaluateCardKindGate`), pré-voo de orçamento (`budgetPreflight`), base × HEAD e hash do carimbo. Ações: `generate_rfc` (planner), `edit_rfc`, `ready` (Validar), `promote`, `revalidate`, `reopen`, `increase_budget` (`PUT /api/projects/:dono/budget`), `resume`. A rota alinha antes o card ao filho (`syncCardWithChild`, idempotente). O rascunho no veredito de specs (`promotability.ts`) devolve `reason:"CARD_DRAFT"` + `card{cardId,state,promoteVia}` (nunca "já saiu da Bancada"/"normalizar"); `POST /api/projects/:draft/promote` ⇒ `409 USE_CARD_PROMOTE`.

### 2.4 Anexos (`GET /api/cards/:id/attachments`)

Estado da conversão por anexo original: `not_applicable` (txt/md, derivados), `disabled` (pdf/doc/docx com `ATTACHMENT_CONVERSION` off), `queued` (ligada, sem linha na fila), `pending`, `running`, `done` (traz `derivedAttachmentId`), `empty` (sem camada de texto), `failed` (traz `errorCode`/`errorMessage`/`attempts`; o original segue guardado). Allowlist pdf/txt/md/doc/docx e tetos são os da tarefa 1.5/Q (inalterados).

### 2.5 Bloqueio por orçamento

O Guard (`pauseForBudget`, **não tocado**) pausa o dono e põe o filho em execução em `stopped` + `stopped_by='budget'`. O card reage em três pontos, todos por `syncCardWithChild`: leitura da jornada, `resume` e o reconciliador (`EVOLVE_RECONCILER=on`, `syncCardsWithChildren`, só candidatos que pedem transição):

- `promoted|in_factory → blocked`, ator `guard`, `blocked_reason = "budget:<CÓDIGO_DO_GUARD>"` (ex.: `budget:BUDGET_PAUSED`) — **nunca** `failed`; o filho não é alterado;
- `resume` com o Guard ainda negando ⇒ `402 CARD_BUDGET_BLOCKED` (o card segue `blocked`); com saldo ⇒ `blocked → in_factory`, e se o filho segue `stopped` a resposta traz `childRestartRequired` + `next` (liberar a pausa não religa a execução, regra do `PUT /budget`);
- saldo de volta sem `resume`: o próximo alinhamento (jornada/reconciliador) devolve `in_factory` (`budget_released`) e **não** volta a bloquear (filho parado com saldo = espera humana, H §4.1).

## 3. Tabela única de erros (`services/cardErrors.ts`)

`GET`/`POST`… de card respondem `{code, message, userMessage, …}`. Os corpos de recusa dos escritores de spec (`CARD_SPEC_LOCKED`, `CARD_PATH_OUT_OF_SCOPE`, `CARD_OPERATION_UNSUPPORTED`, Guard) também trazem `userMessage`. Um teste (`cardErrors.test.ts`) varre as fontes de card e falha se algum `code: "…"` não estiver na tabela, e confere tamanho/idioma das mensagens.

| Código | HTTP | Área | Mensagem ao usuário (PT-BR) |
|---|---|---|---|
| `BAD_REQUEST` | 400 | geral | Não entendemos o pedido. Confira os campos e tente de novo. |
| `NOT_FOUND` | 404 | geral | Não encontramos este item (ou ele não está disponível para você). |
| `FORBIDDEN` | 403 | geral | Esta ação não é permitida para a sua conta. |
| `MANAGEMENT_ACCOUNT_READONLY_CREATE` | 403 | geral | Contas de gestão só consultam: peça a alguém do cliente para criar ou alterar cards. |
| `INTERNAL` | 500 | geral | Algo deu errado do nosso lado. Tente de novo em instantes. |
| `GONE` | 410 | anexo | O arquivo deste anexo não está mais disponível. |
| `PRODUCT_ARCHIVED` | 409 | geral | O produto está arquivado e não recebe novos cards. |
| `SERVICE_REQUIRED` | 400 | geral | O produto tem mais de um serviço: escolha em qual deles o card vale. |
| `NO_ACCEPTED_HEAD` | 409 | geral | Este serviço ainda não tem uma versão aceita para evoluir. |
| `CARD_INVALID_TRANSITION` | 409 | estado | O card não pode ir para esse estado agora. |
| `CARD_DIVERGED` | 409 | estado | O estado do card está inconsistente. Peça apoio ao suporte antes de continuar. |
| `CARD_NOT_EDITABLE` | 409 | estado | O texto do card só pode ser editado enquanto ele é rascunho ou está em refino. |
| `CARD_NOT_DELETABLE` | 409 | estado | Só dá para excluir um card em rascunho. Nos demais casos, recuse o card. |
| `CARD_NOT_READY` | 409 | promocao | O card não está pronto. Valide o card antes de promover. |
| `CARD_CHILD_NOT_IN_FACTORY` | 409 | estado | A execução do card ainda não voltou para a fábrica. Reinicie-a e retome o card. |
| `CARD_DELIVERY_IS_AUTOMATIC` | 409 | estado | A entrega é registrada sozinha quando a execução é aceita e o código é integrado. |
| `TICKET_IMMUTABLE` | 409 | estado | O pedido original não pode mais ser alterado depois de promovido. |
| `TICKET_INVALID_TRANSITION` | 409 | estado | O pedido não pode ir para esse estado agora. |
| `NOT_PROMOTED` | 409 | estado | O pedido ainda não foi promovido. |
| `USE_CARD_PROMOTE` | 409 | promocao | Este pedido é um card: promova-o pelo próprio card. |
| `CARD_SPEC_LOCKED` | 409 | spec | A spec do card está travada. Reabra o card para voltar a editar. |
| `CARD_PATH_OUT_OF_SCOPE` | 400 | spec | O card só escreve na própria pasta e no RFC/ADR dele. A spec da versão corrente é somente leitura. |
| `CARD_OPERATION_UNSUPPORTED` | 409 | spec | Esta operação não se aplica a um card. Use o Chat IA ou o RFC do próprio card. |
| `CARD_DRAFT_UNREADABLE` | 409 | spec | Não conseguimos ler a spec do rascunho do card. Tente de novo ou peça apoio. |
| `EVOLUTION_RFC_REQUIRED` | 409 | gate | Falta o RFC do card, com critérios de aceite em Gherkin e os arquivos que podem mudar. |
| `EVOLUTION_RFC_INVALID` | 409 | gate | O RFC do card está incompleto. Corrija os pontos indicados e valide de novo. |
| `CARD_KIND_MISMATCH` | 409 | gate | Uma correção não pode mudar a compatibilidade da versão além de patch. Ajuste o RFC ou o tipo do card. |
| `CARD_KIND_REQUIREMENT` | 409 | gate | Falta algo exigido pelo tipo do card (correção: cenário de reprodução; recurso novo: não-objetivos). |
| `CARD_BASE_STALE` | 409 | promocao | A versão-base mudou desde a validação. Revalide o card e valide de novo antes de promover. |
| `EVOLUTION_IN_FLIGHT` | 409 | promocao | Já existe outra evolução em andamento neste serviço. Aguarde ela terminar. |
| `EVOLUTION_BUSY` | 409 | promocao | O serviço está ocupado com outra promoção. Tente de novo em instantes. |
| `MATERIALIZATION_IN_PROGRESS` | 409 | promocao | A promoção deste card já está em andamento. Aguarde alguns instantes. |
| `MATERIALIZATION_FAILED` | 500 | promocao | A promoção falhou no meio do caminho. Tente promover de novo: ela continua de onde parou. |
| `HEAD_SPEC_UNREADABLE` | 422 | promocao | Não foi possível ler a spec da versão corrente para promover. |
| `CODE_BASE_UNAVAILABLE` | 422 | promocao | O código da versão corrente não está disponível para promover. |
| `PARENT_SUPERSEDED` | 409 | promocao | A versão-base foi substituída por outra mais nova. Revalide o card. |
| `TICKET_ALREADY_PROMOTED` | 409 | promocao | Este pedido já foi promovido. |
| `BUDGET_MISSING` | 402 | orcamento | A versão corrente não tem orçamento de IA definido. Defina o orçamento antes de continuar. |
| `BUDGET_PAUSED` | 402 | orcamento | O orçamento de IA está pausado. Aumente o orçamento para continuar. |
| `BUDGET_INSUFFICIENT` | 402 | orcamento | O saldo de IA não comporta a próxima atividade. Aumente o orçamento. |
| `BUDGET_FREE_BELOW_MIN` | 402 | orcamento | O saldo livre está abaixo do mínimo para abrir uma nova versão. Aumente o orçamento. |
| `CARD_CHILD_NOT_ACCEPTED` | 409 | estado | A execução do card ainda não foi aceita. |
| `CARD_BUDGET_BLOCKED` | 402 | orcamento | O card está bloqueado por orçamento. Aumente o orçamento da versão e retome o card. |
| `KILL_SWITCH` | 402 | orcamento | O uso de IA está temporariamente suspenso pela plataforma. |
| `GLOBAL_HOURLY_CAP` | 402 | orcamento | O limite de uso de IA da plataforma foi atingido. Tente mais tarde. |
| `GLOBAL_DAILY_CAP` | 402 | orcamento | O limite diário de uso de IA da plataforma foi atingido. Tente amanhã. |
| `REPEAT_PAYLOAD` | 402 | orcamento | Esse mesmo pedido já foi enviado várias vezes. Altere o texto antes de tentar de novo. |
| `UNATTRIBUTED_DAILY_CAP` | 402 | orcamento | O limite de uso de IA sem projeto foi atingido hoje. |
| `PROJECT_NOT_FOUND` | 402 | orcamento | Não encontramos o projeto que paga esta chamada de IA. |
| `GUARD_ERROR` | 402 | orcamento | O controle de custo está indisponível agora. Tente de novo em instantes. |
| `TENANT_LLM_BUDGET_EXCEEDED` | 402 | orcamento | O orçamento de IA do cliente foi atingido. |
| `ATTACHMENT_INVALID` | 400 | anexo | Algum anexo não é aceito. Use PDF, TXT, MD, DOC ou DOCX dentro dos limites. |
| `ATTACHMENT_TOO_LARGE` | 400 | anexo | Um dos anexos é grande demais. |
| `ATTACHMENT_TOO_MANY` | 400 | anexo | Há anexos demais neste card. |
| `ATTACHMENT_UNREADABLE` | 400 | anexo | Não conseguimos ler um dos anexos de texto. Reenvie em UTF-8. |
| `ATTACHMENTS_UNAVAILABLE` | 409 | anexo | Anexos de card ainda não estão habilitados para este cliente. |

Notas: `CARD_BASE_STALE`/`MATERIALIZATION_*`/`EVOLUTION_*` vêm do claim (Fase 1/2) e mantêm os campos extras (`expectedHead`, `currentHead`, `revalidate`…). `BUDGET_*`/`KILL_SWITCH`/`*_CAP`… são os códigos do Guard, repassados.

## 4. Decisões e desvios

1. **Reabrir deixou de ser implícito.** Na 2.6 o `PATCH` de texto em `ready` voltava a `refining` sozinho (H §4.4). Agora é `409 CARD_SPEC_LOCKED` até o `reopen` explícito; o teste da 2.6 que cobria o comportamento antigo foi atualizado (commit `f0d65b0`). A trava vale também depois de `ready` (promoted…rejected) como "histórico", com `canReopen:false`.
2. **Revalidar mudou de contrato.** Antes sempre rebaseava e invalidava o carimbo; agora `ok` não mexe no card, `stale` rebaseia, `conflict` não rebaseia. O campo `ok:true` da 2.6 continua `true` em `ok` e `stale`; `conflict` devolve `ok:false` com HTTP 200 (a chamada funcionou; o veredito é negativo).
3. **`ready → blocked` por orçamento continua inexistente** (decisão da 2.6). O bloqueio de orçamento é só do filho em execução (`promoted|in_factory → blocked`, ator `guard`). Antes disso (maturação) a negativa é `402` sem tocar o card.
4. **Detecção por leitura, não por empurrão.** O Guard está proibido de ser tocado, então não há gancho "ao pausar": o card vira `blocked` na próxima leitura da jornada, no `resume` ou na passada do reconciliador (só em `on`). Com tudo isso inativo, o card pode aparecer `in_factory` até alguém olhar.
5. **`resume` por orçamento não religa o filho** (só destrava o card e diz como religar), por coerência com o `PUT /budget` ("liberar a pausa não religa a execução") e porque o disparo do runner é do `pipeline.ts`.
6. **Escopo gravável fixo** (`tickets/TK-NNNN/**`, `docs/rfc/**`, `docs/adr/**`): o enunciado diz "pasta do card, RFC e Gherkin do card"; o Gherkin vive dentro do RFC. CHANGELOG/connect.yaml propostos pelo planner são **descartados com aviso** (não há onde guardá-los sem copiá-los por cima da árvore herdada na promoção); o fechamento do CHANGELOG segue sendo do aceite da versão.
7. **Validação do rascunho:** Estágio A deixa de acusar README/connect.yaml (são da versão corrente) e continua exigindo o RFC como blocker; o Estágio B recebe a spec corrente como prefixo rotulado de contexto. O texto do prefixo **não** foi exercitado contra LLM real (só o prompt dos demais caminhos é provado por teste).
8. **Arquivos não alterados de propósito:** `specGapScope.ts` e `gapContinuity.ts` operam sobre os arquivos do próprio rascunho (os GAPs só nascem neles) e a escrita é contida pela barreira (`cardDraftWriteDenied`/guarda das rotas); a leitura da base entra pelos construtores de prompt, não por eles.
9. **Achado pelos testes (corrigido):** `syncCardsWithChildren` ordenava por `updated_at` e cortava em 200 sobre *todo* card ativo — cards saudáveis ocupavam as vagas. Agora só entram candidatos que pedem transição.
10. **Achado pelos testes (corrigido):** o `resume` fazia o alinhamento antes de decidir e, quando o próprio alinhamento liberava o bloqueio, devolvia `replayed:true` sem o aviso de religar o filho; agora devolve `childRestartRequired`/`next`.
11. **Upload:** não existe rota de anexar arquivo a card já criado (anexos entram na criação ou pelo PATCH de texto, que regrava a pasta); o PATCH é o escritor "upload" coberto pela trava.
12. **Config nova** `CARD_BASE_CONTEXT_CHARS` (registrada em `CONFIG_KEYS`; calibrado=falso). Sem migration.

## 5. Testes e saídas reais

Postgres efêmero `pgvector/pgvector:pg16`: **55432** (suíte completa, `DATABASE_URL` indefinida) e **55440** (suítes novas), migrations por `scripts/apply-migrations-test.ts`; ambos derrubados ao final.

```
BASELINE (dev 4530ffc, PG 55432):  Test Files 230 passed (230) · Tests 3938 passed | 1 skipped (3939)
DEPOIS   (evo/k1, mesma instrução): Test Files 234 passed (234) · Tests 3983 passed | 1 skipped (3984)   (+4 arquivos, +45 testes, 0 falhas)
tsc --noEmit: EXIT 0
Suítes novas (55440), 3 execuções seguidas: Test Files 4 passed · Tests 45 passed  (sem intermitência)
```

| Suíte | Cobre |
|---|---|
| `routes/cards.fase3.pg.integration.test.ts` (21, Postgres real, agents stub) | **trava** em 12 escritores (editor PUT/POST/DELETE, spec-content, Chat arquivo/inteiro/Resolver GAPs, autônomo, planner, rfc-from-template, PATCH do card e legado) sem nenhuma chamada a agents e sem byte escrito; promovido = histórico; **reopen** (evento, carimbo, repetição, promover exige validar de novo); 1ª escrita ⇒ refining; **escopo** (8 caminhos recusados, 4 aceitos, árvore do pai idêntica, nada de README/CHANGELOG/connect/apps); **Chat lê a base** (prompt com a spec do HEAD, marca SOMENTE LEITURA, regra de escopo; chat não escreve; projeto comum sem o bloco); **GAPs** (`dispatchGapFileJob`); **orçamento** (402 do dono, card intocado); **planner** (RFC+ADR gravados, sem CHANGELOG/connect, gate do tipo passa); **laço autônomo** (aplica em `request.md`, pula arquivo fora do escopo, `stalled` quando o card vai a ready no meio, `CARD_SPEC_LOCKED` ao iniciar); **revalidação** ok/stale/conflict/sem clone; **bloqueio por orçamento** (blocked `budget:BUDGET_PAUSED`, 402 sem saldo, in_factory com saldo, repetição, reconciliador shadow×on); **jornada** em todos os estados; **anexos** (disabled/queued/pending/failed); **flag off** byte a byte e flag off depois de existir rascunho |
| `services/cardSpecGuard.test.ts` (15) | escopo, corpo da trava, porta única com banco simulado (zero consulta em projeto comum), veredito do `card_draft`, Estágio A |
| `services/cardRevalidate.test.ts` (11) | núcleo puro ok/stale/conflict, glob do runner, árvore do repositório |
| `services/cardErrors.test.ts` (3) | tabela única cobre todo `code` das fontes |

Evidências `[F3-…]` impressas (execução completa):

```
[F3-trava-todos-os-escritores] {"editor PUT":409,"editor POST":409,"editor DELETE":409,"spec-content PATCH":409,"Chat IA (arquivo)":409,"Chat IA (spec inteira)":409,"Resolver GAPs":409,"modo autônomo":409,"planner de RFC":409,"RFC a partir do modelo":409,"PATCH do card":409,"PATCH legado de ticket":409}
[F3-reopen] {"eventos":["draft:user:null","ready:system:validated","refining:user:user_reopen"]}
[F3-escopo] {"recusados":{"README.md":400,"CHANGELOG.md":400,"connect.yaml":400,"docs/regras.md":400,"docs/arquitetura/diagramas.md":400,"apps/api/src/x.ts":400,"tickets/TK-0002/request.md":400,"spec.md":400},"arvore":["docs/adr/ADR-001-formato.md","docs/rfc/RFC-0001-exportar-csv.md","tickets/TK-0001/notas.md","tickets/TK-0001/request.md","tickets/TK-0001/anexos/regra.md"]}
[F3-orcamento-chat] {"status":402,"code":"BUDGET_PAUSED"}
[F3-planner] {"gravou":["docs/rfc/RFC-0001-exportar-csv.md","docs/adr/ADR-001-formato-csv.md"],"avisos":1}
[F3-autonomo] {"aplicou":"request.md","pulou":"docs/arquitetura/visao.md","travou":"stalled"}
[F3-revalidar-stale] {"result":"stale","motivos":["BASE_MOVED","NEEDS_HUMAN_REVIEW"]}
[F3-revalidar-conflict] {"motivos":["GLOB_NO_LONGER_MATCHES","RFC_REFERENCES_REMOVED_SPEC"],"depoisDeCorrigir":"stale"}
[F3-orcamento-bloqueio] {"eventos":["draft:user:null","ready:system:validated","promoted:user:null","in_factory:system:child_in_factory","blocked:guard:budget:BUDGET_PAUSED","in_factory:system:budget_released"]}
[F3-anexos] {"resumo":{"failed":1,"not_applicable":1}}
```

## 6. Riscos

- **Estágio B com prefixo de contexto sem prova com LLM real:** o juiz pode, em tese, gerar achado sobre texto do prefixo apesar do rótulo; a barreira de escrita impede que o laço o "corrija" fora do escopo, mas o GAP ficaria sem como fechar. Validar numa execução real antes de ligar a flag.
- **Contradição semântica RFC × base nova não é verificada** (só caminhos, globs e mudança da spec); `NEEDS_HUMAN_REVIEW` pede revisão. Globs só são conferidos com clone em `PROJECT_FILES_ROOT`.
- **Bloqueio por orçamento sem empurrão** (§4.4): depende de leitura da jornada, `resume` ou reconciliador `on` (hoje default `off`).
- **Escopo gravável fixo:** se o RFC/Gherkin do card passar a viver noutra pasta, a lista de `cardSpecGuard.ts` precisa acompanhar.
- **Uma consulta a mais** (`projects` ⨝ `tickets` por `draft_project_id`) no contexto do Chat/GAPs de projeto comum quando o status não é conhecido (`loadChatContext`, `dispatchGapFileJob`); sem efeito visível, índice de boot `uq_tickets_draft` a cobre onde existir.
- **Pré-requisitos da Fase 2 seguem valendo:** `ATTACHMENTS_STRICT` ligada para anexos; migrations 148–150 e 160 não aplicadas em produção; leitores Python de `projects.status`/`card_draft` sem inventário.
- **`pipeline.ts`** ganhou o `409 USE_CARD_PROMOTE` para `card_draft`; qualquer outro leitor do status `card_draft` fora do api-node (Python) continua fora de inventário.

## 7. Fora de escopo (próximas tarefas)

Telas do quadro/diálogo/jornada (g-k2); 3.4 ritos por tipo além do gate já existente; 4.x (PR por card, `in_factory → delivered` com PR mergeado, preenchimento de `card_id` pelo runner); religar automaticamente o filho parado por orçamento; Staff/papéis de modelo; importação (`origin = import`); Auto Care; verificação semântica LLM do RFC contra a base nova; empurrão do Guard ao card (exigiria tocar `llmGuard.ts`).
