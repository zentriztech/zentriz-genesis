> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Bancada — revisão adversarial EXECUTÁVEL de todas as ações (humanas e automáticas)

**Data:** 2026-09-06 · **Repo:** `zentriz-genesis` · **Branch:** `dev` → `main`
**Cobaia:** produto **NVX LastMile** (projeto `e2a1988c-bb4b-437b-a7b3-96192b837717`, spec dividida em 11 arquivos, 22 GAPs ativos)
**Ambiente de prova:** PRODUÇÃO (`3.220.66.113` / `https://genesis.zentriz.com.br`) — este host é só build.

Pedido do Jean (verbatim):

> "monte um plano adversarial para revisar, testar, e resolver GAPs e erros em todas as acoes da bancada
> acionadas por humano ou automaticas, use o projeto `NVX LastMile`, execute essa revisao adversarial até
> que cada acao obtenha sucesso no que ela propoe; modo autonomo, com email do plano e email de cada
> tarefa realizada e final;"

---

## 0. Definição de "sucesso" (o critério que este plano usa)

Uma ação **não** é aprovada por devolver `200`/`202`. Ela é aprovada quando o **efeito que ela promete**
é medido em prod, no NVX LastMile:

| Nível | O que exige |
|-------|-------------|
| **P0 — responde** | a rota devolve o contrato documentado (status + campos) |
| **P1 — efeito** | o estado mudou onde a ação diz mudar (linha no banco, byte no disco, container, chunk servido) |
| **P2 — propósito** | o efeito **resolve** o que a ação propõe (ex.: "Resolver GAPs" tem de FAZER o GAP desaparecer da próxima validação, não só editar o arquivo) |
| **P3 — hostil** | a ação recusa o caminho ruim com motivo verdadeiro (concorrência, base velha, teto, falta de LLM) e **sem** corromper nada |

Uma ação só é fechada em **P3**. Falha em qualquer nível = GAP registrado, corrigido **no código do
agente/rota** (nunca "consertando o dado à mão") e re-testado.

---

## 1. Inventário das ações (o universo a cobrir)

### 1.1 Acionadas por HUMANO (Bancada `/spec` e telas irmãs)

| # | Ação | Recurso | O que promete |
|---|------|---------|---------------|
| H1 | Criar spec (upload / colar) | `POST /api/specs` (multipart, `draft=true`) | nasce projeto em `draft`, nada inicia |
| H2 | Salvar rascunho | `PATCH /api/projects/:id/spec-content` | conteúdo persiste, sem iniciar fábrica |
| H3 | Editar arquivo | `PUT /api/projects/:id/spec-files/*` (If-Match) | grava o byte e recusa base velha (409) |
| H4 | Dividir spec | `POST …/spec-split` (agente) | N arquivos coerentes, primário = índice |
| H5 | Chat do CTO (spec inteira) | `POST /api/spec-chat` | revisão aplicável, histórico durável |
| H6 | Chat por arquivo | `POST /api/spec-chat` + `filePath` | edita UM arquivo, preserva o resto |
| H7 | Validar spec | `POST …/spec-validate` | findings ancorados por arquivo |
| H8 | Resolver GAPs (spec inteira) | `POST /api/spec-chat` `resolveGaps` | GAPs caem na validação seguinte |
| H9 | **Resolver GAPs por arquivo** | idem + `filePath` | idem, escopado (é o caminho do laço) |
| H10 | Aplicar revisão ao arquivo | `PUT …/spec-files/*` com If-Match | grava só se a base não mudou |
| H11 | Modo autônomo (liga/desliga) | `POST …/spec-autonomy` | laço roda sozinho até o critério |
| H12 | Versões da spec / restaurar | `GET/POST …/spec-versions` | snapshot restaurável, com pré-condição |
| H13 | Promover (spec / produto) | `POST …/promote` | admite INERTE (`promoted`), em ondas |
| H14 | Ver ordem e iniciar onda | `GET /promotion` + `POST /start` | dispara só a onda pendente mais baixa |
| H15 | Devolver à Bancada | `POST …/unpromote` | volta ao estado editável |
| H16 | Interromper execução | `POST …/stop` | SIGTERM→SIGKILL, sem promessa falsa |
| H17 | Apagar projeto/produto | `DELETE …` | remove com guarda por digitação |
| H18 | Certificado Factory | `GET …/certificate` | projeta os gates REAIS do dispatch |

### 1.2 Acionadas por MÁQUINA (sem humano na frente)

| # | Ação automática | Onde vive | O que promete |
|---|-----------------|-----------|---------------|
| A1 | Coleta de jobs do CTO | `specChatWorker` | nenhum resultado pago se perde |
| A2 | Expiração de zumbis | `expireZombieSpecChatJobs` | job morto não é reofertado |
| A3 | Laço autônomo por arquivo | `specAutonomy` (`per_file`) | percorre a fila e reduz GAPs |
| A4 | Roteador de GAPs (Stage A) | `finding_routes` (LLM) | todo GAP global recebe arquivo |
| A5 | Validador adversarial | `spec_validation_runs` (3 votos) | findings reprodutíveis e ancorados |
| A6 | Gate semântico | juiz LLM | reprova mudança que não resolve o GAP |
| A7 | Learning loop (G7) | `lessons_corpus` + CAG | lição entra no prompt seguinte |
| A8 | Planejador de promoção | `promotionPlanner` (097) | ordem por dependência, em ondas |
| A9 | Watchdog da fila | dispatcher | drena `queued`, ignora `promoted` |
| A10 | Breaker / fallback de modelo | `circuit_scope`, deny-cache | degrada sem travar o produto todo |

---

## 2. Ataques adversariais por ação (o que vou tentar quebrar)

Para cada ação, o teste hostil que costuma revelar o defeito real:

- **Concorrência:** duas edições sobre a mesma base (`If-Match`) → a segunda tem de dar 409, nunca sobrescrever.
- **Teto de saída:** arquivo grande + muitos GAPs → não pode descartar 100% do trabalho pago (foi o defeito A5.2).
- **Escopo:** ação de arquivo não pode tocar irmão; ação de spec não pode virar ação de produto (foi o B1).
- **Verdade do rótulo:** o que o botão diz é o que a rota faz (foi o B2/B6).
- **Tenant:** master sem escopo não pode ver/afetar produto de outro tenant (foi o B4).
- **Sem LLM:** com modelo negado/403, a ação tem de FALHAR com motivo — nunca cair em automação fixa (Lei do Jean).
- **Idempotência:** disparar duas vezes não paga dois LLMs nem duplica linha.
- **Reinício:** matar a api no meio → o resultado tem de ser recuperável (`agents_job_id`).
- **Base velha:** aplicar revisão feita sobre conteúdo que já mudou → recusa explícita.
- **Encolhimento/corrupção:** resultado que apaga seção → vetado por `assessRevisionIntegrity`.

---

## 3. Ondas de execução (ordem obrigatória: medir → atacar → corrigir → re-medir)

| Onda | Foco | Ações | Fecha quando |
|------|------|-------|--------------|
| **O1** | O caminho que estava QUEBRADO | H9, A3 | todos os 11 arquivos do NVX LastMile passam pelo CTO-editor sem truncar e os GAPs caem |
| **O2** | Escrita e concorrência | H2, H3, H10, H12 | If-Match provado nos dois sentidos + restore com pré-condição |
| **O3** | Geração de conhecimento | H7, A4, A5, A6 | todo GAP tem arquivo; findings ancorados; gate semântico com juiz real |
| **O4** | Autonomia ponta a ponta | H11, A1, A2, A7 | laço roda só, coleta sobrevive a restart, lição entra no prompt (medido) |
| **O5** | Fábrica | H13, H14, H15, H16, A8, A9 | promover ≠ iniciar; ordem respeitada; stop honesto |
| **O6** | Destrutivas e leitura | H1, H4, H17, H18 | guardas por digitação + certificado igual ao gate real |

Cada onda: **baseline medido → ataque → GAP → correção no código → re-teste → e-mail**.

---

## 4. Registro de execução

> Preenchido durante a execução. Cada item traz o **fato medido** (id/linha/log), não impressão.

### O1 — Resolver GAPs por arquivo + laço autônomo

**Baseline (antes de qualquer correção), medido em prod:**
`privacidade-lgpd.md` (47.816 chars, 9 GAPs / 5 blockers) falhou **4/4** —
jobs `548f7273` (socket 180 s), `dc0b4d6b`, `febcaa74`, `aeaefbc1`, os três últimos com
`stop_reason=max_tokens`, `in=27.481 / out=32.000`, **69.058 chars gerados e descartados**.

**GAP-1 🔴 (fechado):** o formato "devolva o arquivo completo" faz o custo de saída crescer com o
TAMANHO DO ARQUIVO, não com o tamanho da correção → nenhum teto resolve. Correção: `A5.2` —
CTO-editor entrega blocos `SEARCH/REPLACE`, aplicados pela api com veto de corrupção
(`services/specFileEdits.ts`), teto de entrada 48k→120k, `model_used` gravado também no erro.
Commit `08e2056` → `main` `db281a9`; imagem api `sha256:a3d16976…` verificada em prod.

**Efeito medido do GAP-1 (run `dd587b75`, passe 1):** o A5.2 FUNCIONOU no nível do arquivo —
**21 findings resolvidos**, entre eles os **9 de `privacidade-lgpd.md`** que antes falhavam 4/4.
Foi essa rodada boa que expôs os três GAPs seguintes.

**GAP-2 🔴 (fechado): o GAP que nenhuma ação da Bancada sabia resolver.**
O finding `no_readme` do Estágio A ("Spec sem manifesto") aponta um arquivo que **não existe**.
"Resolver GAPs por arquivo" edita arquivo existente; o CTO da spec inteira reescreve o primário —
logo o GAP sustentava rodada do laço **para sempre** e nenhuma spec dividida podia chegar a
`succeeded`. Correção `A5.3`: rodada de MANIFESTO dentro do laço (`startManifestRound` /
`applyManifestRound` em `services/specAutonomy.ts` + `dispatchManifestJob` em `routes/specChat.ts`).
O conteúdo é do AGENTE (Lei 100% LLM): o código entrega só os fatos (título, arquétipo derivado de
`extra.project_type`, árvore de arquivos, spec primária) e **veta** com 8 códigos o que o Estágio A
reprovaria na validação seguinte (`services/specManifest.ts`) — sem arquétipo no banco, o catálogo
inteiro vai como MENU em vez de o código adivinhar. Parser de frontmatter extraído para
`lib/frontmatter.ts` para que veto e validador usem **a mesma regra** (parsers divergentes trocariam
um GAP por outro). 16 testes de veto + 4 de laço.

**GAP-3 🔴 (fechado): o teto de rodadas era GLOBAL, não por passe.**
`AUTONOMY_MAX_FILE_ROUNDS = 12` contava rodadas do laço TODO enquanto a UI anunciava "até 5 passes".
Medido: `a4ad542f` **exhausted em `round=12, passes=1`** e `dd587b75` **idem** — numa spec de 11
arquivos o primeiro passe consome o orçamento inteiro e o passe 2 **nunca acontece**. Correção: o
teto passa a ser **por passe** (12 arquivos por passe) com trava absoluta nova
`AUTONOMY_MAX_TOTAL_FILE_ROUNDS = 30` para o custo do laço; a mensagem de `exhausted` diz **qual**
teto bateu.

**GAP-4 🔴 (fechado): o editor por arquivo MOVIA a contradição em vez de resolvê-la.**
Ainda em `dd587b75` passe 1, com 21 findings resolvidos, o total de GAPs importantes **subiu 20 → 24**
(validação `cedb11df` 10blk/10wrn → `a01ba932` 13blk/11wrn), com 24 findings NOVOS. O par decisivo:
`RESOLVIDO` em `api-entregas-entregadores.md` — "Conflito de status HTTP para VALIDATION_ERROR:
422 vs 400" e, na MESMA rodada, `NOVO` em `definicao-de-pronto.md` — "Status HTTP de erro de
validação divergente: 400 vs 422". Causa: `buildGapFileRequest` mandava **só o arquivo alvo + o mapa
do produto** (`loadChatContext(..., { siblingBodies: false })`), então o editor escolhia um lado do
conflito às cegas e o outro arquivo virava o divergente. Medido: **19 de 25** findings citam um `.md`
irmão no `rationale`. Correção `A5.5`: `services/specSiblingContext.ts` seleciona por **citação
literal** os irmãos que os próprios GAPs mencionam (orçamento 60k total / 20k por irmão, índice
primário por último, truncamento **com aviso** para o modelo não concluir "o irmão não define isso") e
os entrega como bloco SÓ LEITURA; a regra `DIVERGÊNCIA ENTRE ARQUIVOS` entra nos dois prompts do
CTO-editor: adote o valor do arquivo que **define** o assunto, nunca invente um terceiro, nunca
"resolva" só aqui deixando o irmão divergente. Best-effort por design (é contexto, não pré-condição)
e reversível sem deploy por `SPEC_GAP_SIBLING_CONTEXT=off`. 9 + 4 testes.

**Critério de fechamento da O1 (a re-medir em prod depois do deploy):** numa rodada nova do laço,
(a) o `no_readme` desaparece, (b) o passe 2 acontece de fato e (c) a contagem total de GAPs
importantes **CAI** — não basta resolver findings, o saldo tem de ser negativo.

**Efeito medido do deploy da O1 (`main 4601374`, api `sha256:78ab7098…`) — run `75b3cf5d`:**
o saldo passou a ser **negativo em todo passe**, que era o critério: validação `a01ba932`
(13 blk + 11 wrn = **24**) → `5fc0f9e7` (12 + 6 = **18**) → `a90aba9b` (11 + 5 = **16**).
Antes do deploy a contagem SUBIA (20 → 24) mesmo resolvendo 21 findings. Também provados ao vivo:
`passe 1/5 arquivo 7 (README.md, CRIAÇÃO)` com o arquivo de 6.573 B no disco e na árvore
(`no_readme` desapareceu), e `passe 2/5 arquivo 8` — o passe 2 acontecendo pela primeira vez.

**GAP-5 🔴 (fechado, ainda não deployado): o laço pagou uma rodada de LLM para o próprio guard recusá-la.**
No passe 2 do `75b3cf5d`, rodada 11: log `arquivo 11 (README.md, CRIAÇÃO)` e depois
`last_error = "o manifesto passou a existir durante a rodada — não sobrescrevi"`. Causa: o manifesto
criado no passe 1 ganhou **GAPs próprios** e voltou à fila como arquivo normal, mas os DOIS caminhos
do laço chaveavam pelo **NOME** (`target === MANIFEST_PATH`) — então a fila de conteúdo era desviada
para o gerador de manifesto, que corretamente se recusa a sobrescrever. Resultado: uma rodada paga e
descartada e o `README.md` **nunca corrigido** (os GAPs dele sustentariam passe após passe).
Correção: quem decide é a **EXISTÊNCIA** do arquivo, não o nome — `startFileRound` lê o arquivo antes
de escolher o caminho (`if (target === MANIFEST_PATH && !file)`), e o `apply` deixa de reinferir o
caminho: a rodada carrega o fato `manifestCreation: true` no seu próprio log (com conferência do
número da rodada, para uma rodada antiga não contaminar a atual). 3 testes novos.

**GAP-6 🟡 (fechado, ainda não deployado): o orçamento de irmãos era gasto no COMEÇO do arquivo.**
Medido no mesmo run `75b3cf5d`, que provou o A5.5: com irmãos de ~20 KB, o head-truncate deixava
**só 2 irmãos citados caberem** por rodada (`chars≈40.5k` de 60k) e em `modelo-dados.md` **8 ficaram
de fora** — e os 20k gastos eram justamente a abertura do arquivo, que raramente é onde mora a regra
em disputa. Correção `A5.6`: irmão grande vira **RESUMO DIRIGIDO** — sumário COMPLETO de cabeçalhos
(para o modelo saber o que existe) + apenas as seções que mencionam os **termos que o GAP coloca em
disputa** (`disputedTerms`: identificadores entre backticks, códigos em CAIXA_ALTA, números de 3–4
dígitos — é assim que "422 vs 400" e `VALIDATION_ERROR` aparecem). Teto por irmão 20k → 12k, teto de
seção 3k, arquivo ≤ 8k continua indo INTEIRO (recortar arquivo curto só cria risco de omitir a
regra). O aviso "não conclua que o irmão silencia" é obrigatório: sem ele o editor duplicaria a regra
no arquivo errado — trocaria divergência por duplicação normativa, o mesmo defeito com outro nome.
6 testes novos (a seção relevante no MEIO do arquivo entra; os corpos das irrelevantes não).

**Prova ao vivo do GAP-5 + A5.6 (`main ab87a8d`, api `sha256:95622d29…`, run `75b3cf5d`):**
- GAP-5: rodada **15** — log `passe 3/5 arquivo 15 (README.md)` **sem "CRIAÇÃO"** e resultado
  `` `README.md` salvo no disco (6387 → 9111 chars) ``, `applied: true`. É o MESMO arquivo que na
  rodada 11 tinha sido recusado com "o manifesto passou a existir durante a rodada".
- A5.6: `usados=[api-entregas-entregadores.md, autenticacao-sessao.md, connect-interoperabilidade.md,
  contratos-erros.md] chars=49542` — **4 irmãos citados** contra **2** antes do recorte dirigido,
  no mesmo orçamento de 60k.
- GAPs continuaram caindo: rodada 11 registrou `Validação failed: 18 → 16`.

**Custo assumido do deploy (registro honesto):** a janela estava quieta na medição (`0` jobs
`pending`/`running`), mas um tick disparou entre a medição e o `--force-recreate`: a rodada **14**
(`visao-escopo.md`) morreu com `CTO não entregou revisão: Revisão interrompida por reinício do
servidor`. O laço tratou como falha de ARQUIVO e seguiu (não parou), mas foi **uma rodada de LLM
perdida** — a regra "nunca rebuildar com run em voo" precisa de uma janela verificada por
*travamento*, não só por leitura pontual.

**GAP-7 🔴 (aberto, medido agora): a spec só CRESCE, e o crescimento mata o próprio arquivo.**
Rodada 13: `modelo-dados.md tem 126742 caracteres (teto 120000) — não cabe na janela de contexto` →
o arquivo **saiu da fila para sempre**, com os GAPs dele ativos. Ele não nasceu assim: o CTO-editor só
ACRESCENTA (na mesma sequência, `definicao-de-pronto.md` foi de 49.362 → 56.692 chars numa rodada).
Ou seja, o próprio laço empurra os arquivos maiores em direção ao teto até que fiquem
irrevisáveis — e nenhum GAP explica isso ao humano. Candidatos: dividir o arquivo (a divisão é ação
de agente, Lei 100% LLM), revisar **por seção** dentro do arquivo, ou impor orçamento de crescimento
por rodada. **Não corrigido nesta onda.**

**A5.7 (fecha a perna "revisar por seção" do GAP-7; orçamento de crescimento segue aberto).**

Descartados adversarialmente antes de codar:
- *subir o teto* — com ~7k chars de crescimento por rodada, qualquer teto é alcançado; só adia;
- *veto numérico de crescimento* — não teria pegado os +15%/rodada medidos e arrisca travar o laço
  (duas recusas seguidas → `MAX_FILE_FAILURES` → `stalled`), trocando um GAP aberto por um laço morto;
- *mandar dividir* — pede ao humano exatamente o que ele acionou o autônomo para não fazer.

O que foi feito: no formato `edits` (SEARCH/REPLACE) o modelo **não precisa ler o arquivo inteiro**,
precisa ler os trechos que vai mudar — e o `apply` já roda contra o arquivo COMPLETO no disco
(`runFileChatJob` recebe o conteúdo integral). Então o arquivo alvo acima do teto entra como **RESUMO
DIRIGIDO** (`services/specFileDigest.ts`): sumário COMPLETO de cabeçalhos + as seções que os GAPs deste
arquivo apontam, **verbatim** (byte a byte, senão o `SEARCH` não casa). O sinal de seleção são os
`disputedTerms` **mais as âncoras do validador** — a âncora é literalmente o endereço que ele achou do
problema. O recorte é só de LEITURA: nada é perdido na escrita.

Três garantias sem as quais o recorte seria pior que a recusa, cada uma travada por teste:
1. o bloco declara que é recorte e proíbe recriar seção listada no sumário e não transcrita (sem isso,
   troca-se um GAP por uma contradição interna — duplicação normativa dentro do MESMO arquivo);
2. manda o modelo **dizer** na linha final quando o GAP só puder ser resolvido numa seção ausente, em
   vez de adivinhar o conteúdo dela;
3. no formato `whole` o teto **continua valendo** e a recusa por tamanho continua correta — ali o
   modelo devolve o arquivo inteiro, e responder a um recorte produziria um arquivo MUTILADO.

Efeito colateral desejado: a régua de corte por seção passou a ser **uma só**
(`lib/markdownSections.ts`, extraída do A5.6) — duas cópias divergentes fariam o irmão e o alvo
mostrarem textos diferentes do mesmo arquivo. A rota humana também deixou de devolver 413 quando o
recorte é possível (`canDigestOversize`). 8 testes novos (7 do digest + 1 do 413 que sobrevive no
`whole`); o teste que exigia 413 em 120.001 chars foi reescrito para 202 — a mudança de comportamento
é o próprio conserto.

**Prova ao vivo do A5.7 (`main 90c3e33`, api `sha256:77b7aae6…`, run novo `f5d12be4`):**
```
[SpecChat] alvo recortado modelo-dados.md: 126742 chars > teto 120000
           → resumo dirigido de 90422 chars (27/56 seções)
[SpecAutonomy] passe 1/5 arquivo 1 (modelo-dados.md) → CTO job=276d0333 (13 GAPs)
[SpecChat] ✓ job=276d0333 DONE (edits) — 16 aplicadas, 0 descartadas,
           126742→149393 chars, model=us.anthropic.claude-opus-5
```
O arquivo que a rodada 13 tinha **descartado para sempre** voltou a ser o **primeiro** da fila, com os
13 GAPs dele. O número que importa é `0 descartadas`: todos os 16 blocos `SEARCH` casaram byte a byte
no arquivo COMPLETO do disco — é a prova de que mostrar seções verbatim (e não um head-truncate)
sustenta o formato `edits`. No mesmo passe, `definicao-de-pronto.md` (6 edits) e `visao-escopo.md`
(9 edits) também foram revisados, todos com 0 descartes.

**A janela quieta foi verificada por TERMINALIDADE, não por leitura pontual** (lição do custo do deploy
anterior): o run `75b3cf5d` encerrou-se sozinho em `stalled` — *"Dois passes seguidos sem derrubar GAP
importante"* — e só então a api foi recriada (`--no-deps`). Zero rodada perdida.

**GAP-8 🔴 (aberto, agora é o defeito dominante): a spec infla ~18% por rodada.** A mesma prova que
fechou a perna de leitura escancarou a de escrita: `modelo-dados.md` **126.742 → 149.393 chars numa
única rodada** (+22.651), `definicao-de-pronto.md` +5.174, `visao-escopo.md` +3.751. O A5.7 removeu a
*parada dura* (o arquivo volta a ser revisável a qualquer tamanho), mas não a causa: o CTO-editor
**só acrescenta** — nenhum GAP é fechado por remoção ou consolidação, e nada mede o custo dessa
inflação. Consequências já visíveis: cada rodada recorta mais (27/56 seções hoje) e o custo de token
cresce sem contrapartida em GAPs fechados. Candidatos (nesta ordem): **orçamento de crescimento por
rodada como contrato de saída** (G1 do relatório de GAPs sistêmicos), edits de **remoção/consolidação**
explicitamente permitidos e pedidos no prompt, e **divisão por agente** quando a seção passa de um
tamanho — nunca automação fixa (Lei 100% LLM).

---

## O que a validação do passe 1 revelou: 17 → 22 GAPs não era ruído

O passe 1 pós-A5.7 aplicou 31 edições em 3 arquivos com **0 descartes** e a contagem de GAPs
importantes **subiu 17 → 22** (blockers 10 → 14). O diff título-a-título entre as duas validações
(17 resolvidos, 22 novos) não mostrou "mais ou menos do mesmo": mostrou **duas causas novas, as duas
no código, as duas piores que qualquer GAP de conteúdo.**

### GAP-9 🔴→✅ Um marcador de conflito de merge foi GRAVADO na spec de produção

Novo blocker do validador: *"Marcador de conflito de merge não resolvido no meio da tabela de
convenções"*. Não era alucinação — está no disco:

```
| Relógio de prazo jurídico | ...texto ANTIGO... |
=======
| Enums | ... |
| Relógio de prazo jurídico | ...texto NOVO... |
```

Uma linha `=======` no meio de uma tabela **e a linha substituída duplicada** — e o log da rodada
dizia `16 aplicadas, 0 descartadas`. Causa em `specFileEdits.ts`: o parser trata `RE_MID` como
separador **apenas** no estado `search`; um SEGUNDO separador, já no estado `replace`, caía no
`else if (state === "replace") replace.push(line)` e ia para o arquivo como **conteúdo**. O módulo
que existe para "vetar corrupção" era a fonte da corrupção. Ocorreu **2×** (também no arquivo
monolítico original).

Correção: (a) no parser, `RE_MID` dentro de `replace` = bloco malformado → **descarta só aquele
bloco** e ressincroniza (o resto da rodada continua valendo, exatamente como no truncamento);
(b) invariante nova no aplicador — `MARKER_IN_REPLACE` recusa qualquer bloco cujo texto novo
contenha linha de marcador, com mensagem que ensina a saída (`# Título` ATX em vez de sublinhado
`=======`). 2 testes novos.

### GAP-10 🔴→✅ O validador julgava 27% da spec e reprovava os outros 73% por "ausência"

O achado mais grave da onda. `runStageB` mandava `spec_text: specText.slice(0, 200_000)`. A spec do
LastMile tem hoje **12 arquivos / 747.170 chars** — o corte cego caía **no meio do 5º arquivo**.
Quatro dos novos blockers são **fantasmas** produzidos por esse corte:

```
"Spec entregue viola o próprio gate de completude: 9 dos 12 arquivos obrigatórios estão ausentes"
"Catálogo fechado de 26 códigos ... não está presente na spec entregue"
"Inventário FR/NFR/RN declarado fonte única e fechada está ausente"
"Documento de Definição de Pronto está truncado, reprovando-se por construção"
```

`contratos-erros.md` (74.196 chars) e `definicao-de-pronto.md` (87.631) existem e estão íntegros no
disco. E o ciclo é **vicioso**: o CTO-editor "resolve" o fantasma **acrescentando** conteúdo aos
arquivos que o validador vê → mais texto passa do corte → mais fantasmas na rodada seguinte. É a
explicação mecânica de por que o critério de fechamento da O1 (a contagem TEM de cair) vinha
falhando: **o laço estava competindo contra um teto invisível do próprio código.**

Correção (`services/specValidationInput.ts`, mesma regra do A5.7 na outra ponta — *cortar é
aceitável, mentir sobre o corte não é*):
1. **inventário completo sempre** — todos os arquivos, tamanho e marca `INTEGRAL`/`SÓ SUMÁRIO`;
2. cabe integral ⇒ vai integral, priorizando os **menores** (maximiza quantos arquivos são vistos
   por inteiro; é critério de fato, não julgamento de conteúdo);
3. não cabe ⇒ vai o **sumário de cabeçalhos**, marcado como tal;
4. regra escrita no prompt: *arquivo em `SÓ SUMÁRIO` **existe** — é proibido reportá-lo como ausente,
   faltando ou truncado, e proibido concluir que uma definição não existe por não tê-la visto*;
5. o corpo sai na **ordem de leitura** original, não na ordem de tamanho.

Além disso o humano passa a **ver** o teto: um `warning` de estágio A ("Spec maior que a janela de
validação — parte foi julgada só pelo sumário") lista os arquivos que entraram só em sumário. Antes
isso era um `slice` mudo e o sintoma chegava como blocker falso. 7 testes novos.

**Consequência de método:** as duas causas só apareceram porque a prova ao vivo foi lida **finding a
finding**, não pelo total. O total dizia "piorou 17 → 22"; o diff dizia "o código corrompeu um arquivo
e o validador está cego". Contagem agregada não substitui diff.

---

## GAP-12 — o veto que proibia REMOÇÃO (e por isso a spec só podia crescer)

> Achado na PRIMEIRA rodada do laço já com o validador honesto (run `c3757985`, passe 1, rodada 1).
> É o par que faltava do GAP-10: o validador voltou a dizer a verdade, o editor tentou consertar o
> estrago — e o **código jogou o conserto no lixo**.

### O que foi medido

```
[SpecChat] job=439b9e24 DONE (edits) — 6 aplicadas, 0 descartadas, 34531→28232 chars, out=21190
rounds[0].note = "revisão recusada (seções desaparecidas): a revisão tem 6 seções contra 9 da spec
  atual — sumiram, entre outras: “contrato mínimo de rotas de negócio (substitui
  `api-entregas-entregadores.md` enquanto ausente)”, “contrato mínimo de observabilidade …”,
  “contrato mínimo de runtime e boot …”, “declaração connect mínima …”"
```

As quatro seções que o laço removeu são **exatamente as quatro que o GAP-10 fez o editor escrever** na
spec do cliente (o fantasma "arquivo ausente" que virou texto normativo). O laço encontrou o estrago
e o desfez, ancorado byte a byte, sem descartar um único bloco. `assessRevisionIntegrity` recusou a
rodada porque a contagem de `##` caiu de 9 para 6 — **in=46.907 / out=21.190 tokens pagos e jogados
fora**, e a contaminação continuou no disco.

### Causa

A guarda tem três sinais; o sinal 2 (menos `##` que a base) é uma **heurística de truncamento do
formato ARQUIVO INTEIRO** — nasceu para pegar o corte de 64k tokens que apagou 7 das 14 seções do
LastMile em 2026-09-05. Ela estava sendo aplicada também a conteúdo produzido por **edições
ancoradas**, onde não existe perda silenciosa: uma seção só desaparece por um bloco SEARCH/REPLACE
**completo**, com âncora que casou byte a byte e de forma única no arquivo do disco (bloco incompleto
é descartado antes de tocar o arquivo). Ou seja, no formato `edits` **remoção é decisão do agente**,
não corte — e vetar decisão de conteúdo viola a LEI (estrutura e conteúdo de spec são do agente; o
código só transporta fatos e veta corrupção).

**Este é o mecanismo do GAP-8.** A spec inflava ~18% por rodada não porque o agente só saiba somar,
mas porque **a única operação capaz de encolhê-la estava proibida pelo código**.

### Correção

`assessRevisionIntegrity(base, revised, truncated, { anchoredEdits })`:

- `truncated` do provedor **continua vencendo tudo** (é fato, não decisão);
- cerca ``` ímpar **continua vetada** (markdown corrompido);
- o sinal de "seções a menos" só veta quando o conteúdo veio de **arquivo inteiro**;
- remoção autorizada é **declarada**: os títulos que saíram voltam em `removedSections` e aparecem no
  log da rodada e no chat ("cortar é aceitável, mentir sobre o corte não");
- renomeação não é confundida com remoção (só conta quando a contagem líquida cai).

O fato "veio de edições ancoradas" **precisa ser persistido** (migração 098,
`spec_chat_jobs.edits_applied`): quem produz é a rota do chat e quem consome é o tick do modo
autônomo, noutro processo. "Eu pedi edições" não prova "a resposta veio em edições" — o modelo pode
reemitir o arquivo inteiro, e nesse caso o guard histórico tem de continuar valendo.

O que ainda protege a spec: teto de encolhimento em chars (30%), âncora inexistente/ambígua,
`MARKER_IN_REPLACE` (GAP-9), snapshot obrigatório antes da escrita e o versionamento com restore.
8 testes novos (5 na guarda, 1 dentro do laço, e os dois casos negativos preservados).
