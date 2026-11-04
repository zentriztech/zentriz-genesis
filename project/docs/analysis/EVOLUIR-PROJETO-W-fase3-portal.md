> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Evoluir projeto na Bancada (W) — Fase 3: portal (tarefas 3.1, 3.2, 3.3 UI, 3.4 UI, 3.5 UI, 3.6)

**Data:** 2026-11-04 · **Repositório:** `zentriz-genesis` · **Branch:** `evo/k2` (a partir da `dev`, base `4530ffc`) · **Worktree:** `.worktrees/g-k2` · **Papel:** executor do portal. Sem produção, sem push, sem deploy, sem PII; o `api-node` não foi tocado; páginas de login intocadas.
**Entradas:** plano v2 (Fase 3), estudo C, relatório R (contrato de rotas e códigos), código real da Bancada.
**Estado:** **preparado e validado** (testes de componente, E2E com API simulada, `tsc`, `next lint`, `next build`). **Não funcional em produção**: nada implantado, `CARDS_BANCADA` desligada em todo lugar e os endpoints novos do K1 ainda não foram conferidos contra o backend real.

## 1. Commits (locais, em `evo/k2`)

| Commit | Conteúdo |
|---|---|
| `74edea3` | `lib/cards/*` (tipos, cliente, tabela única `cardErrors`, hook da flag); `ApiError` ganha `body` (aditivo) |
| `fc13ecf` | `components/cards/*`, rotas `/products/[id]/cards` e `/cards/[id]`, testes de componente |
| `2ce57bd` | 3.6: "Evoluir" leva ao quadro com a flag; atalho em Meus produtos |
| `9ea130d` | correção: aviso de base vencida e "Revalidar" persistem depois que o card volta a Refinando |
| `b03e97c` | E2E Playwright e capturas de tela |
| (este relatório) | documentação |

## 2. Mapa de telas

| Rota / ponto | Arquivo | O que é |
|---|---|---|
| `/products/[id]/cards` | `app/(dashboard)/products/[id]/cards/page.tsx` → `components/cards/CardBoardView.tsx` | **3.1** Quadro: 8 colunas por estado (Rascunho, Refinando, Pronto, Promovido, Na fábrica, Entregue, Bloqueado, Rejeitado), filtro por tipo (select nativo) e por estado (chips `aria-pressed`), cartão `CardTile` (TK-NNNN, tipo, origem, link da spec do card, projeto filho, PR, bloqueio em texto, próxima ação). Estados: carregando, vazio (com CTA), erro (com "Tentar de novo"), flag off (aviso), mais de 100 cards (aviso). |
| Botão "Novo card" | `CardCreateDialog.tsx` | **3.2** Tipo (3 radios com descrição), título opcional, descrição (≤ 20 000), anexos (tipos e teto exibidos; recusa local de extensão/teto), **modo "Branch git" fixo** (texto, sem seletor), orçamento (saldo livre e mínimo; aviso se abaixo), erros do backend traduzidos. Clique duplo não duplica (ref). |
| `/cards/[id]?tab=` | `app/(dashboard)/cards/[id]/page.tsx` → `CardDetailView.tsx` | **3.3/3.4/3.5** Cabeçalho (estado, tipo), barra de ações (`CardActionsBar`), painel de promoção (`PromotePanel`), abas **Pedido**, **Especificação do card**, **Versões**, **Estado e linha do tempo**. |
| Aba Pedido | `CardRequestTab.tsx` | Edita tipo/título/texto (`PATCH`), caixa do **rito por tipo**, anexos com estado de conversão (guardado, convertido, texto). |
| Aba Especificação | `CardSpecTab.tsx` | Lado a lado: **"Spec atual do produto · somente leitura"** (borda tracejada, selo cinza com cadeado, `GET base-spec`) × **"Especificação do card"** (borda sólida, selo "Spec deste card", editor `SpecCodeEditor`, salvar com `baseSha`, novo arquivo). Chat IA (`/api/spec-chat`) e GAPs (`SpecValidationPanel` da Bancada) sobre o **rascunho**. Travada ⇒ aviso + **"Reabrir para edição"**. |
| Aba Versões | `SpecVersionsPanel` (reuso integral) sobre o `draftProjectId` | Snapshots, ver e restaurar. |
| Aba Estado | `CardJourneyTab.tsx` | Etapas (`GET journey` ou derivadas dos eventos) + histórico + motivo do bloqueio. |
| Página do projeto | `app/(dashboard)/projects/[id]/page.tsx` | **3.6** `useCardsEnabled(productId)`; botão "Evoluir": com flag ⇒ `router.push(/products/:id/cards)`; sem flag ⇒ `setEvolveOpen(true)` exatamente como antes. Diálogo e demais handlers **não foram alterados**. |
| Meus produtos | `app/(dashboard)/products/page.tsx` | Ação "Cards de evolução" no menu do card do produto (só com a flag; a flag é consultada uma vez usando o 1º produto como sonda). |

## 3. Contrato com o backend

### 3.1 Usado como está no relatório R §2 (real)
`GET /api/products/:id/cards/capabilities` (**é o indicador da flag**: `{cardsBancada}`; erro/404 ⇒ falso), `GET/POST /api/products/:id/cards` (multipart: `kind`, `title`, `body`, `files`), `GET/PATCH/DELETE /api/cards/:id`, `POST .../refine|ready|reject|resume|revalidate|promote`, `GET .../base-spec`, download de anexos; a visibilidade dos botões vem de `actions{}`. Códigos de erro: todos os da tabela de R mapeados em `lib/cards/cardErrors.ts`. Para a edição da spec do rascunho reaproveitei as rotas da Bancada (`spec-files`, `spec-file?path=` com `baseSha`, `spec-versions`, `/api/spec-chat`, validação/GAPs) apontando para `draftProjectId`.

### 3.2 ASSUMIDO / mockado (a conferir na integração com o K1)
| Item | O que o portal assume | Se não existir |
|---|---|---|
| `GET /api/cards/:id/journey` | `{cardId, state, steps:[{key,label,state:'done'\|'current'\|'todo'\|'blocked',at?}], nextAction?:{code?,label}}` | 404/501 ⇒ o portal **deriva** as etapas dos `events` do card (rotulado "calculada a partir dos eventos") |
| `specLocked: boolean` no `GET /api/cards/:id` | trava `CARD_SPEC_LOCKED` | ausente ⇒ travado quando `state === "ready"` |
| Código `CARD_SPEC_LOCKED` (409) nos escritores de spec | mensagem "use Reabrir para edição" | cai na mensagem do servidor |
| "Reabrir para edição" | `POST /api/cards/:id/refine` (já existe em R: `ready → refining`) | — |
| `capabilities.attachments` | `{allowedExtensions[], maxFiles?, maxTotalBytes?}` | usa pdf/txt/md/doc/docx e diz que "o teto é conferido pelo servidor" |
| `capabilities.budget` | `{freeUsd, minFreeUsd}` (saldo livre e mínimo exigido) | texto genérico "saldo conferido pelo servidor"; valores reais aparecem no erro 402 `BUDGET_FREE_BELOW_MIN` |
| Chat/GAPs lendo a spec-base | o portal chama `/api/spec-chat` com `projectId = draftProjectId`; a leitura "rascunho ∪ HEAD somente leitura" é do K1 | o painel somente leitura da spec-base funciona independente (`base-spec`) |
| Códigos de repositório/GitHub App na criação | desconhecidos; o portal usa `CODE_BASE_UNAVAILABLE` (R) e, para qualquer código fora da tabela, **a mensagem do backend** | — |
| `revalidate` a partir de `refining` | assumido aceito (R só descreve `ready → refining`) | o erro volta traduzido |

## 4. Decisões

1. **Flag** = resposta de `capabilities` por produto (cache por sessão); sem flag, a única mudança observável na página do projeto é uma consulta `GET` extra a `capabilities`.
2. **Tabela única de erros** em `lib/cards/cardErrors.ts` (função de mensagem recebe `status`, corpo e mensagem do servidor). Para isso `ApiError` ganhou o campo opcional `body` (aditivo; nenhum chamador existente muda).
3. **Spec inicial × spec do card** diferenciadas por borda (tracejada × sólida), ícone e **texto** do selo, não só por cor.
4. **Idempotência de clique** por `useRef` + botão desabilitado, além da idempotência do servidor (`replayed`/`resumed`).
5. Base vencida: o servidor devolve o card a Refinando; o portal recarrega, mantém o aviso com "Revalidar" e orienta validar de novo antes de promover.
6. Alertas informativos estáticos usam `role="note"` (o `Alert` do MUI é `role="alert"` por padrão e anunciaria tudo).
7. Filtro por tipo com `select` nativo (melhor em celular e leitores de tela).
8. Chat IA próprio e enxuto (envia, consulta, oferece "Aplicar no editor" sem salvar), em vez de embutir as 4 800 linhas de `spec/page.tsx`; reaproveitei `SpecCodeEditor`, `SpecValidationPanel` e `SpecVersionsPanel` sem alterá-los.

## 5. Testes e saídas reais (worktree `g-k2`, `npm ci` dentro de `applications/apps/genesis-web`)

```
npx tsc --noEmit                      -> EXIT 0
npx vitest run                        -> Test Files 9 passed (9) · Tests 97 passed (97)
npx next lint                         -> 0 erros; só 5 avisos react-hooks/exhaustive-deps pré-existentes (projects/[id]:614, spec:3497, finance, users, GraphView); nenhum em arquivo novo
npx next build                        -> "✓ Compiled successfully"; rotas novas: ƒ /cards/[id], ƒ /products/[id]/cards
CHROMIUM_PATH=~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome npx playwright test
                                      -> 4 passed (login + 3 de cards)
```
O build imprime "Failed to patch lockfile ... reading 'os'" (aviso do Next sobre swc; não altera arquivos e não impede o build; também ocorre fora desta mudança). O `next start` avisa que `output: standalone` prefere `node .next/standalone/server.js`; o E2E funciona assim mesmo.

Cobertura de componente (Vitest + RTL + jsdom): `cardErrors.test.ts` (6: tradução, `CARD_KIND_REQUIREMENT` por campo, orçamento, anexos, desconhecido, ortografia), `useCardsEnabled.test.tsx` (4: flag on/off/falha/cache/sem produto), `CardBoardView.test.tsx` (7: colunas e contagens, bloqueio em texto, filtros, vazio, erro com retry, flag off, aviso de paginação), `CardCreateDialog.test.tsx` (8: 3 tipos e branch fixo sem seletor, validação, envio, clique duplo, anexos/teto, orçamento, erros do backend), `PromotePanel.test.tsx` (12: pré-requisitos, clique duplo, ligação com o filho/PR, base vencida + revalidar, 402/409, `CARD_NOT_READY`), `CardDetailView.test.tsx` (14: abas, ritos por tipo, anexos, spec inicial × card sem clone/promoção ao abrir, salvar com `baseSha`, travado + reabrir, `specLocked` do backend, `CARD_SPEC_LOCKED`, erros de rito ao validar, versões, journey derivada e do servidor, bloqueado, erro de carga).

E2E (`e2e/cards.spec.ts`, build real do portal + API simulada em memória por `page.route("**/api/**")`): (1) criar card (Correção) → tela do card → quadro → abrir → refinar → aba da spec (selos inicial × card) → validar (travado) → **promover ⇒ `CARD_BASE_STALE` ⇒ Revalidar ⇒ validar ⇒ promover** ⇒ ligação com o projeto filho, confirmando 2 `POST promote` e nenhuma chamada `/evolve`; (2) quadro em **320 px** sem rolagem horizontal; (3) flag off no quadro.

## 6. Capturas (geradas pelo Chromium headless nos E2E)
- `project/docs/analysis/img-w/quadro-desktop.png`, `quadro-320.png`
- `project/docs/analysis/img-w/card-spec-desktop.png` (spec inicial × spec do card)
- `project/docs/analysis/img-w/card-base-vencida-desktop.png`

## 7. Checklist de acessibilidade
| Item | Estado |
|---|---|
| Rótulos/papéis: colunas são `section` com `h2`; abas com `aria-controls`; grupo de filtros com `aria-label`; chips `aria-pressed`; lista de pré-requisitos nomeada; `role=status/alert` só para mensagens dinâmicas | **verificado por testes** |
| Informação não depende só de cor (tipo = ícone+texto; bloqueio = ícone+"Bloqueado: motivo"; pré-requisitos = "Atendido/Pendente/Conferido ao promover"; spec inicial × card = borda + selo em texto) | **verificado por testes/captura** |
| 320 px sem rolagem horizontal no quadro | **verificado (E2E)**; tela do card em 320 px **não medida** |
| Foco visível nos links do título do cartão e botões (MUI) | por construção, **não medido** |
| Contraste (tema escuro do portal; selo cinza claro com texto escuro; borda tracejada) | inspeção visual das capturas; **sem medição por ferramenta** |
| Leitor de tela real (NVDA/VoiceOver) e ordem de tabulação completa | **não executado** |
| Alvos de toque ≥ 24 px (chips `size=small`, botões `small`) | **não medido** |

## 8. Riscos e limites
- **Contrato assumido** (§3.2) pode divergir do K1: journey, `specLocked`, `capabilities.attachments/budget`, código de GitHub App. Conferir na integração; todos têm fallback.
- **Chat IA/GAPs** funcionam hoje como na Bancada sobre o rascunho; a leitura da spec-base pelo Chat (R §6) depende do K1. Sem isso o assistente não vê a spec atual do produto.
- A spec-base pode vir truncada (teto do servidor); o portal avisa.
- **Sem a trava no backend**, o portal bloqueia a edição no `ready`, mas escritores diretos de spec continuam possíveis até o K1.
- Conversão automática de pdf/doc/docx: o rótulo "pendente ou desabilitada" não distingue as duas situações (não há campo de estado da conversão no contrato).
- A sonda da flag em Meus produtos usa o primeiro produto da lista (a flag é por tenant; em visão de admin multi-tenant pode não refletir todos).
- A tela da página do projeto (3 360 linhas) **não tem teste de componente** para o desvio do botão "Evoluir"; a regressão com a flag off foi garantida por construção (mesmo `setEvolveOpen(true)`) e revisão do diff, não por teste automatizado.
- `Meus produtos` e a página do projeto não foram exercitados em E2E.

## 9. Fora de escopo / não feito
Backend (K1), Auto Care, importação (`origin=import`), cards em lote, permissões por papel (6.1), documentação de usuário (6.4), `stopped_by=budget`, deploy, i18n além do PT-BR existente, medição automatizada de acessibilidade, teste da página do projeto.

## 10. Estado
- **Preparado:** UI completa das 6 tarefas.
- **Validado:** `tsc`, `lint`, `build`, 97 testes de unidade/componente, 4 E2E (3 novos) contra API simulada.
- **Funcional:** **não** (nada implantado; backend real não exercitado; endpoints assumidos pendentes de conferência).
