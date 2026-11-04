> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO AA — Correções do portal e dos testes de contrato (revisão Y, frente L2)

**Data:** 2026-11-04 · **Repositório:** `zentriz-genesis` · **Branch:** `evo/l2` (a partir de `dev` @ `bd56caf`) · **Worktree:** `.worktrees/g-l2`
**Escopo:** achados Y-03, Y-10 (portal), Y-11, Y-12, Y-15, Y-18, Y-19, Y-20 e as partes de portal dos demais. Backend (`cardService`, `cardSpecGuard`, `evolveClaim`, `routes/*`) **não foi tocado** (frente L1). Sem produção, sem push, sem deploy; Guard intocado; sem PII; páginas de login intocadas.

## 1. Resultado por achado

| Achado | Correção | Teste que prova | Estado |
|---|---|---|---|
| **Y-03a** (aba mostrava "sem arquivos", Chat desabilitado) | `CardSpecTab` lê `GET /spec-tree` e mostra `tickets/TK-NNNN/**` (pedido, só leitura), `docs/rfc/**` e `docs/adr/**`; abre o RFC do card, ou o pedido num rascunho novo. Chat habilitado sobre o RFC/ADR selecionado; no pedido (imutável) explica o que fazer | `CardDetailView.test` "rascunho NOVO…", "Chat funciona sobre o arquivo selecionado"; E2E mock; **E2E real** | Resolvido |
| **Y-03b** (sugeria `rfc/RFC-001.md`) | Sugestão `docs/rfc/RFC-NNNN-<slug>.md` (NNNN = maior do rascunho + 1) e validação no cliente (`specApi.isCardWritablePath`, espelho do `cardWritableRoots`); `spec.md`, `rfc/…`, `..`, `docs/regras.md` e `.txt` são recusados antes de chamar o servidor | `specApi.test` (cruza com os 400 reais das fixtures), "Y-03(b)…" no componente, E2E real | Resolvido |
| **Y-03c** (`generate_rfc` só abria a aba) | Botões "Gerar RFC com a IA" (`POST /evolution-plan` + poll do job, estados correndo/erro/feito, aviso de orçamento compartilhado, resumo/perguntas/avisos/problemas do RFC, abre o RFC gerado e recarrega o card) e "Novo RFC a partir do modelo" (`rfc-from-template`). A ação sugerida da situação do card ("Gerar o RFC com a IA") abre a aba e dispara o planner **uma vez** | testes de componente (progresso, 402 real, job em erro real, ação sugerida, modelo); E2E real | Resolvido |
| **Y-03d** (E2E e testes salvavam `spec.md` na raiz) | Mocks reescritos com as respostas reais de `__contract__/spec/`; o mock recusa com o 400 real qualquer caminho fora do escopo | `e2e/cards.spec.ts`, `CardDetailView.test.tsx` | Resolvido |
| **Y-03e** (rotas fora do contrato) | Teste novo `cards.contract.spec.pg.integration.test.ts` (ver §3) + 29 fixtures + validação por schema no portal | `contract.test.ts` (+38 testes) | Resolvido |
| **Y-10** (portal) | `useCardsCapabilities` devolve `loading/caps/error/retry`; falha não é cacheada (só resposta do servidor e 404). Novo `EvolveButton`: desabilitado ("Verificando…") enquanto carrega, **não** cai no diálogo legado, e na falha mostra alerta com "Tentar de novo" | `useCardsEnabled.test`, `EvolveButton.test` | Resolvido no portal. A parte de backend (`/evolve` sem `ticketId` ⇒ 409 `USE_CARDS`) é da L1; o portal já tem a mensagem |
| **Y-11** (`errorBodySchema` frouxo) | `ERROR_SCHEMAS`: um schema **estrito por código** (26 códigos + 4 preparados) com `details`, `writable`, `freeUsd/minFreeUsd`, `errors`, `guardCode`, `expectedHead/currentHead`, `from/to`, `state`… Código sem schema = falha da suíte | `contract.test` "validador de ERROS é estrito", "todo código…"; **mutação real** em §4 | Resolvido |
| **Y-12** (números e limites do relatório de a11y) | Nova medição por tela × tema × largura (7 telas × 2 temas) com alvos incluindo `a[role=button]`/`a.MuiButton-root`, foco por Tab, contraste com alfa/`opacity`/degradê, reflow e **axe-core 4.14** (§5). Números saem dos JSON, não de contagem manual | `e2e/cards.spec.ts` (14 testes) | Resolvido (limites residuais em §6) |
| **Y-15** (E2E 100% mock) | E2E contra o **api-node real** (§2) | `e2e-real/cards-real.spec.ts` | Resolvido |
| **Y-18** (`prUrl`) | `safeHttpsUrl`: só `https://` nos três componentes | `specApi.test`, `PromotePanel.test`, `CardBoardView.test`, `CardDetailView.test` | Resolvido |
| **Y-19** | `capabilitiesCache` fora do React; `authStore.logout()` o zera; sonda por **tenant** (escopo escolhido ou tenant do usuário; conta de gestão sem escopo não sonda) | `useCardsEnabled.test` (logout, dois tenants) | Resolvido |
| **Y-20** | Aviso não bloqueante quando a recarga falha (card ou jornada) com "Atualizar"; spinner na aba Estado; "Promover" desabilitado enquanto a jornada carrega; `eventReasonLabel` no histórico (`spec_write` → "especificação alterada"; `budget:…` → "orçamento — …") | `CardDetailView.test` (3), `cardErrors.test` | Resolvido |
| Preparação p/ contratos da L1 | Mensagens PT-BR de `USE_CARDS`, `INVALID_ID`, `USE_CARD_DELETE`, `CARD_PATH_COLLIDES_WITH_BASE`, `CARD_NOT_READY` (`PREPARED`, sempre vencidas pelo `userMessage`/tabela do servidor); 403 genérico de papel; bloqueador de jornada com `GLOB`/`REPO_UNAVAILABLE`/`REVALIDAT` no código marca a base como pendente e bloqueia "Promover"; schemas básicos dos 4 códigos novos | `cardErrors.test`, `PromotePanel.test` | Preparado (a fixture real chega na integração) |

Correções de acessibilidade achadas pela nova medição (fora da lista original, nas telas de cards): editor de código sem anel de foco (`outline: none`) e sem nome acessível; botão "Escolher arquivos" era um `<label>` com `<input hidden>` (**não alcançável por teclado**); botões `contained` com degradê abaixo de 4,5:1 (4,47); rótulo de campo em foco no escuro (4,29); texto de erro do quadro no claro (3,76); texto secundário sobre fundo cinza (4,17); numeração de linhas do editor (2,3); `heading-order` (h3 sem h2); foco da área "somente leitura".

## 2. E2E contra o api-node real (Y-15)

- `applications/services/api-node/scripts/e2e-real/serve.ts`: `buildApp()` **do código do worktree** (auth, rotas e SQL reais), Postgres efêmero na **55441** já migrado, agente de LLM **stub** (HTTP local) que devolve plano de RFC válido ao planner e revisão ao chat. Semeia tenant, admin, produto aceito e pai com spec em disco; liga `CARDS_BANCADA` e cadastra um slot de LLM fictício (a LEI do slot do tenant continua valendo). Token: `signToken` do próprio servidor, validado pelo middleware real. Recusa `DATABASE_URL` fora de 55432/55440/55441.
- `playwright.real.config.ts` + `e2e-real/cards-real.spec.ts` (`npm run test:e2e:real`): portal buildado (`next start`) e, **no navegador**, as chamadas `/api/**` são encaminhadas ao api-node real (o proxy do `next start` desta build aponta para o stack Docker, que não existe aqui; reconstruir só para trocar o destino não acrescentaria prova).
- Teste 1: criar card → rascunho novo mostra o pedido → **Gerar RFC com a IA** (planner real, job persistido) → RFC `docs/rfc/RFC-0001-exportar-csv.md` no editor → caminho `rfc/RFC-001.md` recusado no cliente → editar e **salvar com If-Match** → **Validar** (gate de RFC do servidor) → travado → **Reabrir** → validar → **Promover** (1 `POST /promote`, nenhum `/evolve`) → filho criado.
- Teste 2: após validar, o produto avança para a v2 → `base-stale` + "Promover" desabilitado → **Revalidar** → validar → promover.
- Resultado: **2 passaram** (12,6 s). Capturas `real-card-*.png`.

## 3. O que o novo contrato cobre

`cards.contract.spec.pg.integration.test.ts` (2 testes, Postgres real, LLM stub; `npm run contract:gen:spec` regrava, sem a variável compara). Percorre: criar card → listar (`spec-tree`, `spec-files`, `spec-file`) → recusas de escopo (`rfc/…`, raiz, `..`) → escrever RFC em `docs/rfc/` → `EXISTS` → ler/`404` → `PUT` com conflito (`CONFLICT`) e com sucesso → **chat** de arquivo (202 → `done`; resposta vazia → `error`; sem mensagem; caminho fora do escopo) → aplicar → `ready` → **travado** (chat, planner, modelo de RFC e escrita: `CARD_SPEC_LOCKED`) → reabrir → ADR → `ready` → promover → escrita no rascunho promovido (409). Segundo teste: `rfc-from-template`, `evolution-plan` (202, job `error`, job `done` com `written/warnings/questions`, `404`, `NOT_EVOLUTION`) e a árvore após o plano. Resultado: **29 fixtures** em `lib/cards/__contract__/spec/`, todas validadas por schema estrito no portal (rota nova sem schema = erro). Normalização estável (3 execuções seguidas idênticas). Estas fixtures são do backend de hoje: a L1 vai regenerá-las na integração.

## 4. Decisões e prova da mutação (Y-11)

- Pasta `__contract__/spec/` separada (índice próprio) para não colidir com o `index.json` do teste irmão que a L1 regenera.
- Portal usa `spec-tree` (sem caminho absoluto do servidor) em vez do `spec-files` legado; o legado fica no contrato porque o runner o consome.
- `PREPARED` em vez de `PORTAL_ONLY` para os códigos da L1: o teste que exige "código só do portal ≠ backend" continua valendo e a tabela do servidor sempre vence.
- Gerar RFC dispara LLM: só por clique explícito (botão da aba ou ação sugerida), e uma vez (`planBusy`).
- Mutação real (renomear `expectedHead` → `expectedHeadX` em `promote.409-base-stale.json`), antes: 111/111 passavam; agora:

```
FAIL contract.test.ts > promote.409-base-stale tem o formato que o portal espera
+ "$.expectedHead: campo ausente",
+ "$.expectedHeadX: campo desconhecido do portal (...)"
FAIL ... > o validador de ERROS é estrito por código ... (Y-11)
```
Fixture restaurada depois (`git status` limpo).

## 5. Acessibilidade medida (saída real, `img-aa/a11y-*.json` e `axe-*.json`)

Escopo: `main` (ou o diálogo). Todos os 14 testes (7 telas × claro/escuro) passam.

| Tela | Largura | Alvos (todos ≥ 24 px) | Foco visível (escopo) | Amostras de contraste | Mínimo (esc. / claro) | Rolagem horizontal |
|---|---|---|---|---|---|---|
| Card (pronto, base vencida) | 1280 | 12 | 9/9 | 48 | 5,09 / 4,55 | 0 |
| Card, aba Especificação | 1280 | 18 | 17/17 | 55 | 5,09 / 4,55 | 0 |
| Quadro (8 estados) | 1280 | 10 | 20/20 | 148 | 5,39 / 4,55 | 0 |
| Diálogo de criação | 1280 | 8 | 20/20 | 27 | 5,39 / 4,76 | 0 |
| Card | 320 | 12 | 15/15 | 48 | 5,09 / 4,55 | 0 |
| Quadro | 320 | 10 | 20/20 | 148 | 5,39 / 4,55 | 0 |
| Diálogo de criação | 320 | 8 | 20/20 | 27 | 5,39 / 4,76 | 0 |

**axe-core 4.14.0** (WCAG 2.0/2.1/2.2 A e AA + best-practice): **0 violações** nas 14 execuções (24 a 32 regras aprovadas por tela; "incompletas": `color-contrast` em texto sobre gradiente/overlay, e `aria-prohibited-attr`/`duplicate-id-aria` na aba Especificação, que o axe não consegue decidir sozinho).

Violações do axe e medições **na primeira rodada** (antes das correções): `color-contrast` serious (rótulo em foco, 4,29:1; secundário sobre cinza, 4,17:1), `aria-input-field-name` **serious** (editor sem nome), `heading-order` moderate, `aria-allowed-role` minor (label-botão do anexo); medição própria: botões `contained` 4,47:1, texto de erro 3,76:1, gutter do editor 2,28:1, editor sem anel de foco, botão de anexo fora do teclado. Todas corrigidas e reconferidas. Correção dos números da X: **62** amostras, foco **8/8** no `main`, **14** alvos (revisão Y); os números novos acima vêm do harness novo, por tela.

## 6. Limites declarados

- Foco do editor de código: Tab recua o texto (CodeMirror `indentWithTab`); saída pelo teclado é Esc e depois Tab (dito na tela). O teste de foco usa essa sequência.
- Contraste medido por fórmula própria + axe; não cobre 1.4.11 (contraste de não texto) nem `hover`; uma medição por estado. Sem leitor de tela real.
- O E2E real usa o stub de LLM: nenhuma saída de modelo real foi exercida.

## 7. Testes (antes → depois)

| Suíte | Base | Agora |
|---|---|---|
| Portal `tsc --noEmit` | 0 | 0 |
| Portal `next lint` | 0 erros, 5 avisos | 0 erros, **os mesmos 5** avisos |
| Portal `next build` | ok | ok |
| Portal vitest | 228 / 10 arquivos | **299 / 12 arquivos** |
| Playwright (mock) | 11 | **23** (9 funcionais + 14 de acessibilidade/axe) |
| Playwright real | — | **2** |
| api-node `tsc --noEmit` | 0 | 0 |
| api-node vitest, PG 55432 (completo) | 235 arquivos, 3990 passaram, 1 pulado | **236 arquivos, 3992 passaram, 1 pulado** |
| api-node vitest, PG 55441 | 231 + 4 que exigem 55432 | 232 passaram + as mesmas 4 (por porta fixa) |

Containers `l2-pg` (55441) e `l2-pg2` (55432) derrubados ao final.

## 8. Fora do escopo / dependências da integração

Y-01, Y-02, Y-04–Y-09, Y-13, Y-14, Y-16, Y-17, Y-21–Y-23 são de backend (L1). Quando entrarem: regenerar as fixtures (`npm run contract:gen` e `contract:gen:spec`), cadastrar em `ERROR_SCHEMAS` os campos extras que os códigos novos trouxerem (o teste aponta qual), e conferir o texto do bloqueador "globs não conferidos" (o portal aceita qualquer código com `GLOB`/`REPO_UNAVAILABLE`/`REVALIDAT`).

## 9. Commits (`evo/l2`)

`0e3ca9b` contrato da aba Especificação · `2c9eeb3` portal (Y-03, Y-10, Y-11, Y-18, Y-19, Y-20) · `3531b37` a11y + axe + correções · `27f374d` E2E real · (este relatório).
