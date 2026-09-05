> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Bancada — "Ativar modo autônomo" (CTO recursivo até fechar os GAPs) · pesquisa + adversarial + plano

> **Pedido (verbatim, 2026-09-05):** *"adicionar um [x] Ativar modo autonomo, para o CTO entrar em modo
> recursivo registrando acoes e resolver os GAPs atuais, rodar o validar, e repetir até 5 vezes o processo
> no modo autonomo se no fim da rodada ainda voltar GAPs importantes (ignorar gaps de baixo risco para
> decidir se continua em mais uma rodada)"* + refinamento: *"apenas GAPs vermelhos e amarelos, sustenta a
> necessidade de mais uma rodada no limite de 5"*.
> **Status:** pesquisa medida no código + revisão adversarial + GAPs fechados → **IMPLEMENTADO** nesta rodada.

---

## 1. O que o ciclo manual faz hoje (medido no código, não estimado)

Hoje o Jean executa **quatro** ações manuais por rodada, e nenhuma delas encadeia a próxima:

| Passo | Onde | O que acontece |
|---|---|---|
| 1. Resolver GAPs | `SpecChatPanel` → `POST /api/spec-chat {resolveGaps:true}` | `loadChatContext` (findings ATIVOS da última run) → `createSpecChatJob(kind:'resolve_gaps')` → `runChatJob` → CTO `spec_intake_and_normalize` (até 40 min) → gate H4 `judgeCtoResult` |
| 2. **Salvar rascunho** | `PATCH /api/projects/:id/spec-content` | escreve no disco + `content_sha256` + `spec_dirty_at`. **Sem este passo a validação não vê nada** — ela lê do DISCO, e o resultado do CTO fica só no editor |
| 3. Validar | `POST /api/specs/:id/validate` → `startValidation` | estágio A determinístico + estágio B adversarial; status final `passed\|failed\|superseded\|error` |
| 4. Ler o resultado | `projectFindingsState` | `counts.{active, blockersActive, …}` |

O texto que o próprio código escreve no chat depois do passo 1 é a prova de que o encadeamento é manual:
`➡️ Clique em "Salvar rascunho" para persistir e revalidar` (`spec/page.tsx:1580`).

**Consequência real:** cada rodada custa ~25–45 min de espera humana, e a rodada seguinte só começa quando o
Jean volta à tela. O modo autônomo é exatamente esse encadeamento, feito pelo servidor.

### 1.1 O que JÁ EXISTE e será reutilizado (nada de infra nova)

- **`spec_chat_jobs`** (migração 089): job durável, `deadline_at` 40 min, `finishSpecChatJob` **claim-locked**,
  turno do assistente idempotente por índice único parcial `(job_id, role)`.
- **`specChatWorker`** (tick de 20 s, guarda de reentrância): já existe um laço server-side rodando. O modo
  autônomo pega carona nele — **zero processos novos**.
- **`collectSpecChatJobsTick`**: adota job com heartbeat velho → o resultado do CTO não se perde nem se a api
  reiniciar no meio da rodada.
- **Gate H4 `judgeCtoResult`**: `BLOCKED`/`FAIL`/spec curta → `error`. O autônomo herda o gate (não aplica lixo).
- **`startValidation`** + **`projectFindingsState`**: ciclo de validação e contagem de GAPs por triagem.
- **Escrita da spec**: `PATCH /api/projects/:id/spec-content` (`projects.ts:3169`) — o autônomo espelha a MESMA
  lógica (`writeFile` → `content_sha256` → `spec_dirty_at`), incluindo o gate `SPEC_EDITABLE_STATUSES`.

### 1.2 Critério de parada — o que "GAP importante" significa em código

`countFindings` (`findingTriage.ts:175`) devolve `active`, `ignored`, `refuted`, `resolved`, **`blockersActive`**
— e **não existe `warningsActive`**. Como o Jean definiu *"apenas GAPs vermelhos e amarelos"*, a contagem que
sustenta mais uma rodada é derivada:

```
gapsImportantes = findings.filter(f => !f.triage && (f.severity === 'blocker' || f.severity === 'warning')).length
```

- `!f.triage` = **ATIVO** (ignorado pelo humano = risco aceito; refutado = falso positivo — nenhum dos dois conta).
- `info` **nunca** sustenta rodada (é o "baixo risco" do pedido).
- `gapsImportantes === 0` → **`succeeded`** mesmo que existam `info` em aberto.

---

## 2. Desenho — máquina de estados durável

Uma linha em `spec_autonomy_runs` (migração **090**) por execução; o `specChatWorker` a avança.

```
pending ──dispatch CTO──▶ cto_running ──job done──▶ applying ──writeFile+validate──▶ validating
   ▲                                                                                    │
   └────────── round+1 (se gapsImportantes > 0 e round < max_rounds) ◀──run terminal────┤
                                                                                        ▼
                          succeeded (0 vermelhos/amarelos) · exhausted (5 rodadas) ·
                          stalled (sem progresso/guarda) · failed (erro dura) · stopped (humano)
```

Cada transição grava um item em `rounds JSONB` (o *"registrando ações"* do pedido) **e** um turno de assistente
em `spec_chat_messages`, para as ações aparecerem no chat da Bancada — não num log que ninguém lê.

### 2.1 Guardas (cada uma fecha um modo de falha real já visto neste sistema)

| Guarda | Por que existe |
|---|---|
| **Edição humana** — sha do disco ≠ `base_spec_sha` enviado ao CTO → **não aplica**, vira `stalled` | Mesma lição do card "Revisão recuperada" (`genesis-spec-chat-persistencia-089`): sobrescrever edição humana em silêncio é perda de dados |
| **Encolhimento** — spec revisada < 70% dos chars da base → **não aplica** | O CTO normalizador já descartou conteúdo em prod (é a razão do modo por-arquivo usar `/invoke/raw`) |
| **Spec idêntica** — sha novo == sha base → conta como rodada SEM progresso | Gastar Opus 5 em loop para reescrever a mesma coisa |
| **Sem progresso 2× seguidas** (`gapsImportantes` não caiu) → `stalled` | Evita queimar as 5 rodadas quando o modelo não converge |
| **`SPEC_EDITABLE_STATUSES`** revalidado **a cada rodada** | A spec pode entrar em fábrica no meio do laço (S1 da Onda 0) |
| **Deadline global** (`deadline_at`, 4,5 h) | 5 × (40 min CTO + validação) ≈ 3,75 h; o teto expira a ESPERA, nunca o TRABALHO |
| **UNIQUE parcial por projeto** enquanto ativo | Dois laços no mesmo projeto = dois CTOs escrevendo o mesmo arquivo |
| **Escopo de dono/tenant** (`owner_user_id` + `canAccessProjectRow` na rota) | Classe do P0 cross-tenant de `/api/deadpool/*` |
| **Kill-switch** `SPEC_AUTONOMY=off` | Desliga sem redeploy se o laço se comportar mal em prod |

---

## 3. Revisão adversarial — GAPs e fechamento

| # | GAP | Fechamento |
|---|---|---|
| **A** | 🔴 **Rate-limit de 4 validações/h por spec** (`startValidation` → 429 `RATE_LIMITED`). Com 5 rodadas rápidas, a 5ª rodada **morreria** no rate-limit. | `RATE_LIMITED` **não** é falha: a run fica em `validating`, registra `retry` na rodada e o tick tenta de novo mais tarde (o `deadline_at` é o teto). |
| **B** | **Orçamento do tenant** pode estourar no meio (402). | `TENANT_LLM_BUDGET_EXCEEDED` → `failed` com a mensagem de orçamento (não `stalled`): é decisão financeira, tem de aparecer. |
| **C** | **Custo cego** — 5 × Opus 5 em spec de 98 KB é dinheiro real sem confirmação. | O checkbox mostra o teto de rodadas e o rótulo diz "até N rodadas"; a run registra `spec_chars` por rodada; o gasto continua contabilizado no orçamento do tenant (que é o freio duro). |
| **D** | **Validação `superseded`** (spec mudou durante a run) confundiria o contador. | `superseded`/`error` **não** contam como progresso: registra e revalida na rodada seguinte; 2× seguidas → `stalled`. |
| **E** | **`NO_GAPS` no dispatch** (o `POST /api/spec-chat` recusa Resolver GAPs sem findings ativos, 409). | Se não há GAP ATIVO ao iniciar a rodada, isso é **sucesso**, não erro → `succeeded`. |
| **F** | Rodada 1 sem validação prévia (`never_validated`) → nada a resolver. | A rota **exige** uma validação anterior com findings; sem ela responde 409 `NO_VALIDATION` orientando rodar Validar. |
| **G** | **Duplo poll** — o `specChatWorker` já coleta jobs órfãos e o autônomo também olha a linha. | O autônomo **só lê** `spec_chat_jobs` (nunca finaliza); quem finaliza é o poll em processo ou o `collectSpecChatJobsTick`. `finishSpecChatJob` é claim-locked de qualquer forma. |
| **H** | **Restart da api no meio** deixaria a run parada para sempre. | Estado 100% no Postgres + tick de 20 s: qualquer processo novo continua de onde parou. Job perdido (`lost`/`interrupted`) → a rodada é reportada e o laço decide (retry da rodada ou `stalled`). |
| **I** | **Reentrância do tick** — um tick lento sobreposto ao próximo aplicaria a spec 2×. | Guarda de reentrância global (padrão do `specChatWorker`) + `UPDATE … WHERE status = <esperado>` (claim) em toda transição. |
| **J** | **Spec sumiu do disco** (o defeito D dos `file_path` relativos, 28 projetos do Venuxx V2). | `computeCurrentSpecHash` → `null` → `failed` com mensagem explícita "spec sem arquivos legíveis" (não silêncio). |
| **K** | **Token de máquina** (`svc:"runner"`) ligando o autônomo = código de cliente reescrevendo a própria spec. | 403 na rota (mesma regra de `spec-content` e do chat) + `denyCreationForManagement` para `zentriz_admin`. |
| **L** | O laço poderia rodar **para sempre** se o CTO nunca terminar. | Teto por rodada = `deadline_at` do próprio `spec_chat_jobs` (40 min) + deadline global da run. |

---

## 4. Entregáveis

1. **Migração 090** `spec_autonomy_runs` (regra do runner: nenhum `;` em literal, comentário em linha própria, sem `DO/$`).
2. **`services/specAutonomy.ts`** — máquina de estados + guardas + log por rodada.
3. **`routes/specAutonomy.ts`** — `POST /api/spec-autonomy` · `GET /api/spec-autonomy?projectId=` · `POST /api/spec-autonomy/:id/stop`.
4. **`services/specChatWorker.ts`** — o tick de 20 s passa a avançar as runs autônomas.
5. **`routes/specChat.ts`** — expõe `dispatchResolveGapsJob` (reuso do MESMO caminho do botão manual: contexto, prompt, H4).
6. **Web** — checkbox "Ativar modo autônomo" ao lado de Resolver GAPs + painel de progresso da rodada.
7. **Testes** vitest do contador de GAPs importantes e das guardas.

## 5. Fora de escopo (deliberado)

- Rodar `/run-tests` ou promover o projeto ao fim do laço (o autônomo só mexe em SPEC).
- Editar arquivo de irmão (é a Fase 2 de `CONTEXTO-DO-PRODUTO-INTEIRO-2026-09-05.md`).
- Triagem automática de findings (ignorar/refutar é decisão humana, por desenho do RFC-0005).
