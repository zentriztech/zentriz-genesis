> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO X — Fase 3: integração do portal com o contrato REAL do backend de cards

Branch `evo/k3` (worktree `.worktrees/g-k3`, a partir da `dev` em `7603a2a`). Sem produção, sem push, sem deploy; Guard e páginas de login não foram tocados; nenhum PII.

## 1. Resumo

O portal (relatório W) foi escrito contra um contrato assumido (`ASSUMIDO (K1)`). O backend (relatório V) entregou o contrato real, que difere em jornada, trava da spec, capacidades, reabertura, detalhes de erro, revalidação, retomada e anexos. Esta frente:

1. adaptou tipos, cliente, telas, mocks, fixtures e E2E do portal ao contrato real (o backend é a fonte da verdade; **`api-node` não foi alterado em código de produto**, só ganhou o teste de contrato e um script);
2. criou um **teste de contrato compartilhado**: o teste de integração do api-node percorre o ciclo inteiro pelas rotas reais em Postgres efêmero e grava 76 payloads em `applications/apps/genesis-web/lib/cards/__contract__/*.json`; os testes do portal consomem essas fixtures e um validador estrito (mais uma amarra de tipos no `tsc`) falha se os dois lados voltarem a divergir;
3. mostrou na tela do card `headline`, `detail`, `blockers`, `action`, PR (`execution.prUrl`), `spec.locked/canReopen` e `base.stale`;
4. tratou todos os códigos de erro (mensagem do servidor quando existe);
5. mediu acessibilidade (contraste, foco, alvos, 320 px) e anexou evidências e capturas.

## 2. Divergências × correção × teste × estado

| # | Divergência encontrada (portal assumido × backend real) | Correção | Teste que a prova | Estado |
|---|---|---|---|---|
| 1 | `GET /api/cards/:id/journey`: portal esperava `{cardId,state,steps[{key,label,state,at?}],nextAction}` e tratava 404 como "rota ausente", derivando a linha do tempo no cliente. Real: `{cardId,code,state,kind,phase,steps,current,next,blockers[],action,headline,detail,severity,blocked,spec,base,execution}`; `steps[].key` só tem as 6 etapas (o portal usava `blocked`/`rejected` como etapa), sem `at` | `CardJourney` real em `types.ts`; `deriveJourney` removido (a tela não inventa jornada); falha da rota vira aviso com "Tentar de novo" | `contract.test.ts` (14 fixtures `journey.*` validadas), `CardDetailView.test.tsx` (situação), E2E | corrigido |
| 2 | `specLocked` no card (assumido) e "travada só em `ready`". Real: não existe no detalhe; vem de `journey.spec.{locked,canReopen}` e **toda** fase fora de rascunho/refinando é travada (promovido, entregue…), mas só `ready` pode reabrir | `locked`/`canReopen` lidos da jornada; promovido mostra "travada… nem reaberta" sem botão | `CardDetailView.test.tsx` (pronto/promovido/trava do servidor) | corrigido |
| 3 | `capabilities` devolve só `{cardsBancada}`; portal assumia `attachments{allowedExtensions,maxFiles,maxTotalBytes}` e `budget{freeUsd,minFreeUsd}` e mostrava "Saldo livre: US$…" | tipo reduzido; diálogo de criação sem saldo/limites inventados (diz que o servidor confere); pré-requisito de saldo da promoção vem dos `blockers` da jornada | `CardCreateDialog.test.tsx`, `PromotePanel.test.tsx`, E2E | corrigido |
| 4 | "Reabrir para edição" chamava `POST /refine`; o endpoint real é `POST /reopen` (com `replayed`), e `actions.reopen` não existia no tipo | `cardsApi.reopen`; botão na barra de ações (`actions.reopen`) e na aba da spec | `CardDetailView.test.tsx` ("usa /reopen — não /refine"), E2E (`POST …/reopen`) | corrigido |
| 5 | Códigos de erro: a tabela do portal tinha 22 códigos; o backend tem **56** (`services/cardErrors.ts`). 35 códigos sem mensagem no portal (ex.: `CARD_SPEC_LOCKED` tinha, mas faltavam `CARD_PATH_OUT_OF_SCOPE`, `BUDGET_PAUSED`, `BUDGET_INSUFFICIENT`, `CARD_BUDGET_BLOCKED`, `KILL_SWITCH`, `GLOBAL_*_CAP`, `PARENT_SUPERSEDED`, `CARD_OPERATION_UNSUPPORTED`, `ATTACHMENT_TOO_LARGE/TOO_MANY`…). Textos que contradiziam o backend: `CARD_DRAFT_UNREADABLE` ("o card foi bloqueado"), `CARD_DIVERGED`, `CODE_BASE_UNAVAILABLE`, `CARD_NOT_READY` (assumia sempre "voltou a Refinando") | `cardErrorMessage`: 1) `userMessage` do corpo, 2) tabela espelho do backend (`__contract__/error-codes.json`, gravada pelo teste de contrato) + `PORTAL_ONLY` (`TENANT_INACTIVE`, do middleware de auth), 3) `message`, 4) genérico | `contract.test.ts`: todo código do backend tem mensagem idêntica no portal; código só do portal é só `TENANT_INACTIVE`; 29 respostas de erro reais mostram `userMessage` ou a tabela; PT-BR acentuado | corrigido |
| 6 | Formato de `details`/corpos de erro: `CARD_KIND_REQUIREMENT.details.missing` é **array** (`["non_goals"]`), o portal comparava com string e nunca casava; `EVOLUTION_RFC_INVALID.details` é `[{path,problems[]}]` (ignorado); `SERVICE_REQUIRED.services` é `[{projectId,title,versionNumber}]` (virava "[object Object]"); `ATTACHMENT_INVALID.errors` é `[{code,filename,message}]`; `CARD_PATH_OUT_OF_SCOPE.writable` | `errorDetail()` monta a frase extra de cada corpo real ("Falta: seção “Non-goals”", problemas do RFC, "Pastas permitidas: …", saldo livre/mínimo) | `cardErrors.test.ts`, `contract.test.ts` ("detalhes montados do corpo real") | corrigido |
| 7 | `revalidate`: portal só lia `ok` e `message`. Real: `result: ok\|stale\|conflict`, `reasons[{code,severity,message,details}]`, `rebased`, `reopened`, `base`, `checks`, `next`; `ok:false` no conflito | `RevalidateResponse`; `RevalidateResult` mostra título por veredito e a lista de motivos (conflito com `role=alert`) | `CardDetailView.test.tsx` (ok/stale/conflict reais) | corrigido |
| 8 | `resume`: portal ignorava `childRestartRequired`/`next` (filho continua `stopped` após liberar orçamento) e o 402 `CARD_BUDGET_BLOCKED` (`guardCode`) | `ResumeResponse`; aviso "reinicie a execução" com link do projeto; 402 mostra a mensagem do servidor | `CardDetailView.test.tsx` | corrigido |
| 9 | `promote`: tipo parcial. Real: 201 (criou) × 200 (`replayed`, traz `status`/`title`), `cardStatus`, `draftProjectId`, `Retry-After: 2` no 409 `MATERIALIZATION_IN_PROGRESS`/`EVOLUTION_BUSY`; `CARD_BASE_STALE` devolve `expectedHead/currentHead/revalidate`; 402 de orçamento | `PromoteResponse`; `ApiError.retryAfterSeconds` (único toque em `lib/api.ts`) e frase "Tente de novo em N s." | `contract.test.ts`, `CardDetailView.test.tsx` (4 erros reais de promoção; replayed) | corrigido |
| 10 | Anexos: portal adivinhava "pendente ou desabilitada" pelo detalhe. Real: `GET /api/cards/:id/attachments` com `conversion.state` (`not_applicable\|disabled\|queued\|pending\|running\|done\|empty\|failed`), tentativas e erro | `cardsApi.attachments`; rótulos por estado (falha mostra o motivo e que o original segue guardado) | `CardDetailView.test.tsx` (fixture `attachments.list-conversion-failed`) | corrigido (resolve a pendência declarada no relatório W) |
| 11 | `base-spec`: `content` é `string \| null` (nulo quando `truncated`); o tipo dizia `string` | tipo e tela tratam `null` | `CardDetailView.test.tsx` ("truncada") | corrigido |
| 12 | Detalhe: `events` vêm mais recente primeiro; `base` pode ter `headProjectId/headVersion` nulos; `attachments[].kind/origin/contentSha256` podem ser `null` | tipos ajustados | schemas estritos em `contract.test.ts` | corrigido |
| 13 | `blockedReason` aparecia cru (`budget:BUDGET_PAUSED`) no quadro e na tela | `blockedReasonLabel()`: "orçamento — O orçamento de IA está pausado…" | `cardErrors.test.ts`, `CardBoardView.test.tsx`, E2E | corrigido |
| 14 | Texto do diálogo de criação: "Modo de trabalho: Branch git… não há cópia do código". O promote real usa `workMode:"copy"`, herda arquivos e cria a branch `evolution/vN` | texto reescrito ("vira um projeto filho… numa branch `evolution/vN`, a partir da versão corrente") | `CardCreateDialog.test.tsx` | corrigido (texto) |
| 15 | `USE_CARD_PROMOTE` sai de `routes/projects.ts` (`/evolve`), fora do hook `userMessage` de `cards.ts`: **sem** `userMessage` | mantido assim no backend (mudança mínima: nenhum erro real); o portal cai na tabela espelho | fixture `legacy-evolve.409-use-card-promote`, `CardDetailView.test.tsx` | observação (backend inalterado) |
| 16 | `journey.action` / `headline` / `detail` / `blockers` / PR / base vencida não apareciam | `CardStatusPanel`: alerta por severidade, lista "O que impede a próxima etapa", ação sugerida (executa `ready/revalidate/reopen/resume`, leva à aba da spec em `generate_rfc/edit_rfc`, link para o projeto dono em `increase_budget`, aponta o botão em `promote`), PR e aviso de base vencida | `CardDetailView.test.tsx`, E2E | corrigido |
| 17 | Promover habilitado mesmo com bloqueio conhecido | botão desabilitado enquanto houver `blockers`; sem jornada (rota fora do ar) o servidor decide | `PromotePanel.test.tsx` | corrigido |

Backend: **nenhum erro real encontrado** nas rotas de cards; nada foi alterado em `src/` do `api-node` além do novo teste e do script `contract:gen` em `package.json`.

## 3. O que o teste de contrato gera

`applications/services/api-node/src/routes/cards.contract.pg.integration.test.ts` (5 testes, ~1 s; só roda com `PG_TEST_URL`):

- **Modo gerar:** `npm run contract:gen` (`CONTRACT_GEN=1 vitest run …`) regrava `lib/cards/__contract__/*.json`.
- **Modo comparar (suíte normal):** compara a resposta de hoje com a fixture versionada e falha com a instrução "rode `npm run contract:gen`, revise o diff e adapte o portal". Prova de deriva: alterei `journey.ready.json` à mão e o teste quebrou; revertido.
- Normalização estável por fixture: UUIDs → `00000000-0000-4000-8000-00000000000N`, datas → `2026-11-04T12:00:00.000Z`, SHA-256, caminhos `/tmp` e títulos aleatórios do seed; duas execuções seguidas dão o mesmo resultado.
- Cada fixture é `{request, status, headers?(retry-after), body}`. Total: 76 arquivos (74 respostas + `error-codes.json` + `index.json`).
- Percurso coberto: capacidades (flag on/off) → criar (json e multipart) → listar (filtros, paginação, 400) → detalhe e jornada em **todos** os estados (`draft`, `refining`, `ready`, `promoted`, `in_factory`, `blocked`, `delivered`, `rejected`) e variantes (sem RFC, RFC inválido, requisito do tipo, orçamento pausado, base vencida) → refinar → editar → validar → travar (PATCH, escritor de spec, DELETE) → reabrir (e repetir) → revalidar `ok/stale/conflict` → promover (201, 200 `replayed`, 409 base vencida, 409 não pronto, 409 em andamento com `Retry-After`, 402 pausado) → Guard para o filho (bloqueado por orçamento) → retomar (402; 200 com `childRestartRequired`; replay) → entregue (com `prUrl`) → rejeitado → excluir (204 e 409) → anexos (409 indisponível, 400 inválido, lista com conversão `disabled` e `failed`) → `/evolve` legado (`USE_CARD_PROMOTE`) → 404 (inexistente, outro tenant, flag off sem `userMessage`).

No portal:

- `lib/cards/schemas.ts`: validador mínimo próprio (o portal **não** usa `zod`; não adicionei dependência). Objetos estritos (campo novo do backend = erro). Ao final do arquivo, o `tsc --noEmit` exige que cada schema seja **mutuamente atribuível** ao tipo de `types.ts`.
- `lib/cards/contract.test.ts`: 111 testes (uma validação por fixture + cobertura de estados + tabela de erros + mutações do validador).
- `cardFixtures.ts` (usado por Vitest e E2E) agora é construído sobre as fixtures reais, não à mão; o E2E responde com os corpos reais numa máquina de estados mínima.

## 4. Acessibilidade (medida)

Medição no E2E (`e2e/cards.spec.ts`, tela do card em "pronto, base vencida"), nos temas escuro e claro; evidência em `project/docs/analysis/img-x/a11y-dark.json` e `a11y-light.json`:

| Critério | Antes (relatório W: "não medido") | Medido agora |
|---|---|---|
| Contraste do texto (63 amostras, sem desabilitados) | — | primeira medição: 7 textos abaixo de 4,5:1 no escuro (links e botões em `primary.main` ≈ 4,3:1; chip "Pronto" 4,47:1) e 10 no claro (chips verdes 2,4:1, "Rejeitar" 3,6:1, campos desabilitados 2,7:1). Depois do ajuste: **mínimo 5,09:1 (escuro) e 4,55:1 (claro); zero abaixo do limite** |
| Foco visível | por construção | anel de 2 px (`outline`) desenhado em todo `ButtonBase`/link; **9 de 9** controles do card percorridos por Tab com foco visível; campos de texto usam a borda de 2 px do MUI |
| Alvos ≥ 24 px | não medido | 15 controles, **nenhum < 24×24** (botões `small` com `min-height: 32`) |
| 320 px | quadro | quadro e tela do card em 4 estados (`ready` com base vencida, `blocked`, `delivered`, `draft`): **sem rolagem horizontal**; a ação sugerida passou para dentro do alerta para não espremer o texto |

Ajustes: `CardsA11yTheme` (ThemeProvider aninhado, **só** nas telas de cards: não altera o tema global nem o login); campos não editáveis do pedido viraram `readOnly` (antes `disabled`, com 2,7:1 e não focáveis).
Limites honestos: a medição de contraste é por cálculo no DOM (cores computadas, sobe a árvore até o fundo opaco), não por ferramenta de terceiros nem por leitor de tela; menu lateral/cabeçalho do portal ficam fora do escopo (não alterei).

Capturas (`project/docs/analysis/img-x/`): `quadro-desktop`, `quadro-320`, `card-rascunho-sem-rfc-desktop`, `card-spec-desktop`, `card-spec-travada-desktop`, `card-base-vencida-desktop`, `card-pronto-desktop`, `card-promovido-desktop`, `card-bloqueado-orcamento-desktop`, `card-retomado-reiniciar-desktop`, `card-entregue-pr-desktop`, `card-rejeitado-desktop`, `card-{ready-base-stale,blocked,delivered,draft}-320`, `card-a11y-{dark,light}-desktop`. As de `img-w/` (relatório W) ficam como histórico.

## 5. Decisões

- **Backend é a verdade; sem rota "assumida".** Removi `deriveJourney` e os campos opcionais `specLocked`, `nextAction`, `budget`, `attachments` em vez de mantê-los como fallback silencioso.
- **Tabela de erros espelhada por importação do JSON gerado** (`__contract__/error-codes.json`) em vez de copiar 56 textos à mão: o portal herda a mensagem do backend por construção e o teste garante a igualdade. O arquivo entra no bundle (≈ 9 KB).
- **Validador próprio, estrito, em vez de `zod`** (não está instalado; sem dependência nova).
- **Uma única fonte de execução das ações** (`useCardRunner`): trava de clique duplo compartilhada entre barra de ações, painel de promoção e ação sugerida da jornada; recarrega o card (e a jornada) depois de sucesso **e** de erro.
- **Promover desabilitado enquanto há `blockers`**, em vez de deixar o clique falhar. Sem jornada (rota fora do ar), o botão segue ativo e o servidor decide; os erros reais de promoção são testados nesse modo.
- **Fixtures com estado fixo por nome** (`journey.ready-base-stale` etc.), não geradas por teste do portal: quem muda o contrato é o backend, e o diff das fixtures no PR é a revisão.
- `lib/api.ts` (compartilhado) recebeu só `retryAfterSeconds` no `ApiError`; compatível com todo chamador.

## 6. Saídas reais (execuções desta sessão)

| Verificação | Base (`dev`) | Depois |
|---|---|---|
| `tsc --noEmit` portal / api-node | limpo | limpo / limpo |
| `next lint` | 0 erros, 5 avisos | 0 erros, 5 avisos (os mesmos, nenhum novo) |
| `next build` | ok | ok |
| `vitest` do portal | 97 testes / 9 arquivos | **228 testes / 10 arquivos** (+`contract.test.ts` com 111) |
| Playwright (`CHROMIUM_PATH`, `playwright-core` do `npm ci`) | 4 testes | **11 testes passaram** (login; ciclo; estados; quadro 320 px; 4 telas em 320 px; flag off; acessibilidade escuro e claro) |
| `vitest` do api-node, Postgres 55441 | — | 231 arquivos passaram; 4 falharam **só** por exigirem porta 55432 (esperado, ver abaixo); 3965 testes passaram |
| `vitest` do api-node completo, Postgres **55432** | 234 arquivos, 3985 passaram, 1 pulado | **235 arquivos, 3990 passaram, 1 pulado** (+1 arquivo, +5 testes do contrato) |

Containers `k3-pg-55441` e `k3-pg-55432` derrubados ao final.

Commits locais em `evo/k3` (arquivos explícitos, sem `node_modules`):

```
a06b27b test(cards): teste de contrato gera fixtures reais do backend para o portal (npm run contract:gen)
2c371fc feat(portal): tipos, cliente, validador e erros dos cards no contrato real do backend
8a24492 feat(portal): tela do card mostra headline, bloqueios, acao sugerida, PR e base vencida do servidor
895ecc1 feat(portal): acessibilidade medida das telas de cards (contraste, foco, alvos) e campos somente leitura legiveis
80e798f test(portal): E2E dos cards sobre as respostas reais do backend, capturas img-x e evidencia de acessibilidade
48f6c16 test(cards): tipagem do inject no teste de contrato
```
(mais o commit deste relatório)

## 7. Estado

- **Preparado e validado localmente**: contrato real consumido pelo portal, testes de contrato nos dois lados, telas e acessibilidade medida.
- **Não funcional ainda**: nada foi implantado; o portal real não foi exercitado contra o `api-node` real por HTTP (o E2E usa as **respostas reais gravadas**, não uma API viva). Os fluxos que dependem de LLM/agents (Chat IA, GAPs, planner) continuam stubs no teste de contrato.

## 8. Riscos

- As fixtures refletem o `api-node` **desta branch**; se o backend mudar sem rodar `contract:gen`, o teste de contrato do backend falha (bom). Se alguém regravar sem revisar o diff, o portal quebra nos testes dele — a revisão do diff das fixtures é o ponto de controle.
- A tabela de erros do portal só atualiza quando `contract:gen` roda; textos novos do backend sem regravação aparecem no `userMessage` do corpo (que vence a tabela).
- O ThemeProvider aninhado (`CardsA11yTheme`) cria um tema novo por montagem das telas; custo desprezível, mas é um segundo ponto de verdade visual para links/botões de cards.
- A medição de contraste não cobre estados `hover`, imagens/ícones nem texto sobre gradiente; a de foco cobre só os 9 controles do caminho de Tab (não o diálogo de criação nem o menu).
- O botão "Promover" desabilitado por `blockers` depende de a jornada estar atualizada; o servidor continua sendo a barreira final (erros reais testados).

## 9. Fora de escopo

- Qualquer alteração em produção, push, deploy, Guard, páginas de login, menu lateral/cabeçalho do portal.
- Mudar o contrato do backend (ex.: padronizar `status` entre 200/201 do promote, `userMessage` no `/evolve` legado): registrados como observações, sem erro real.
- Teste com HTTP real portal ↔ `api-node` (stack docker), leitor de tela real e ferramenta externa de contraste (axe/Lighthouse).
- Paginação além do primeiro lote de 100 cards no quadro (o portal avisa "Mostrando N de M"); filtros `origin` no quadro.
