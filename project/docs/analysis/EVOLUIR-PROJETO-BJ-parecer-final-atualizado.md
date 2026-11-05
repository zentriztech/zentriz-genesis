> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO BJ — Parecer final ATUALIZADO do Advisor (programa "Evoluir projeto na Bancada com cards")

Data: 2026-11-05 · Papel: Advisor (revisor adversarial independente) · Base lida: worktree limpo `~/workspace/current/zentriz/.worktrees/g-fin2` em `dev@175a4b8` (removido ao final) · Escopo: Genesis apenas (Deadpool/Auto Care fora) · Modo: somente leitura no código; este relatório é o único arquivo gravado (sem commit) · Substitui, para efeito de decisão, o [AV](EVOLUIR-PROJETO-AV-parecer-final-programa.md) (NÃO PRONTO).

> **Vereditos**
>
> - **(A) Promover o CÓDIGO a produção com `CARDS_BANCADA` desligada em todos os tenants: PRONTO COM CONDIÇÕES.** O esquema 141–162 é aditivo e seguro para a imagem antiga enquanto não houver card; o roteiro BE é sólido. As condições são: decidir os comportamentos que mudam o legado com a flag desligada (lista A), fazer o teste de rollback e o backup, e corrigir ou aceitar uma regressão nova do Guard (achado A-N2).
> - **(B) Ligar `CARDS_BANCADA` na ZFactory: NÃO PRONTO** pela régua do próprio plano. O gate F4 não fecha: nenhuma das 10 execuções reais passou em todos os critérios binários, e só uma (TK-0010) rodou sobre o código corrigido. Há também dois fatos novos. A configuração de produção (Host B remoto, com a ponte `/cyborg-engineer` funcional) **não é a que foi testada**. E o Cyborg executa build do produto **dentro do control plane**, com `docker.sock` e token admin, se o Host B falhar. A lista B mostra o caminho até "pronto com condições". Ele é curto, mas depende de três decisões do Jean e de duas correções pequenas de código.

---

## 1. Método e limites

- Três frentes de verificação em paralelo: (i) estado dos achados do AV; (ii) migrations, rollback e regressão do legado; (iii) docs × código, orçamento e segurança. Cada frente foi obrigada a citar `arquivo:linha`. Conferi pessoalmente os achados bloqueantes e altos, marcados **[conferido]**: o aceite do Cyborg e o fallback (`cyborg_v3.py`), a cunhagem de token (FTS/`executor_bridge`), os wrappers do Cyborg, o compose do `cyborg`, `denyForeignTenant` e o `_a4_rule_applies`.
- Git conferido: `origin/dev = 3d2a381`, só 1 commit atrás de `dev` (o próprio relatório BI). `bce3f50`, de onde saíram as imagens de produção, **já está no GitHub** (`git branch -r --contains bce3f50` → `origin/dev`). `origin/main` continua em `09653d5`. Dois runs do CI `ci-evolution` deram **success**: `41949524798` (`3ff2f7b`) e `41956719873` (`3d2a381`, que inclui BG/BH).
- **Não feito:** nenhum teste reexecutado nesta revisão (os resultados de suíte citados vêm do CI e dos relatórios), nada em produção, nenhum LLM, nenhum push. Não verifiquei a versão do FTS no Host B (sem acesso, BL-3) nem as permissões reais em produção além do que o BE mediu.

## 2. Critérios §1 do plano

| # | Critério (medida do plano) | Estado | Evidência (código, não relatório) |
|---|---|---|---|
| 1 | **Sem regressão** com a flag desligada (HTTP + banco + disco) | **Parcial** | Melhorou desde o AV. A-4 agora só vale para filho de card em QA sem veredito (`runner.py:5053`, padrão `card` em `:713-718`), P2P (`:775-781`, legado exige `EVOLUTION_P2P_REQUIRED_LEGACY=1`), teto de contexto (`:5274,5587`) e flags 5xx (`:1115-1117`). **Continuam globais:** FULL-TEST não executada ⇒ `CANCELLED` (`runner.py:3483-3518`, chamado em `:6106` sem condição); `CYBORG_TREE_GATE=on` removendo lockfile gerado também em greenfield (`cyborg_v3.py:2565`, `:2528-2548`); teto horário por tenant `auto` = 50 % do global (`llmGuard.ts:61-63,446-458`); 404 do Guard para run disparado por `zentriz_admin` em projeto de outro tenant (A-N2); índices únicos no boot (`index.ts:92`). **Não existe** suíte de regressão do legado de ponta a ponta nem o cenário dourado (0.5). Há testes parciais (`cardsOff.regression.pg…:33-105`, `evolve.claim.pg…:540-610`, `test_av_a1_a4_correcoes.py:71-175`), e os PG viram `skip` sem `PG_TEST_URL` |
| 2 | **Rastreabilidade** (100 % `card_id`; 100 % `spec_origin`) | **Parcial** (inalterado) | `card_id` nas tasks não herdadas foi provado ao vivo em 10/10 execuções (BI §4 #9). `TSK-INH-*` ficam sem `card_id` por decisão do runbook, não registrada no plano. `spec_origin` segue NULL em vários escritores (AV M-6), sem mudança |
| 3 | **Idempotência** | **Atendido** | Lado API sem mudança desde o AV. A-2 foi corrigido: chave com id do filho e com ocorrência (`cardPromote.ts:267,278,292,315-328`) e detector `detectCardChildStalled` (`evolveReconciler.ts:398-415`). Resíduo: o **mesmo** filho falhar duas vezes repete a chave, e só o detector pega |
| 4 | **Resiliência** (matar runner/api em cada etapa) | **Parcial** | Agora há testes C8–C13 (`orchestrator/tests/test_av_a3_runner_chaos.py:128-309`). Mas o "kill" é uma exceção contra uma API falsa em memória (`:21-25`): nenhum processo é morto e nada roda contra Postgres. O caos do runner não foi provado de ponta a ponta |
| 5 | **Qualidade — gate F4** (≥ 3 reais, uma por tipo, todos os binários) | **Não atendido** | §3. **0 de 10** execuções com todos os binários em PASS. Sobre o código atual, **n = 1** (TK-0010, Correção): FULL-TEST **reprovada**, baseline **não medida**, merge com `confirm:"MERGE"`. Evolução e Recurso novo: **0** execuções no código atual |
| 6 | **Custo** (nenhum card sem orçamento explícito; Guard ⇒ `blocked`) | **Parcial** | Pausa ⇒ `blocked` corrigido (A-2). Três pontos abertos: (a) **card nasce com `budget_usd=0`** (201; o teste em `evolveClaim.ts:114-122` é `IS NOT NULL`) e só para no refino/`/ready` com `402 BUDGET_PAUSED`. Visível, mas o ROLLOUT C10 promete 402 na criação; (b) as sessões `claude` do FTS (TSK-FULL-TEST de até 3600 s) **não passam pelo ledger** (não há chamada ao Guard em `full-test-server.py`; BI §5 lista 19 chamadas e nenhuma é FULL-TEST), então "custo ≤ orçamento" é medido **por baixo**; (c) M-2 continua aberto: uma estimativa pausa a linhagem antes do teto do card (`llmGuard.ts:474-491`) |
| T-1 | Segurança | **Parcial, com bloqueante para (B)** | §4 B-N1 e A-N1. Autorização por tenant nas rotas de card continua correta. M-5 e M-12 foram corrigidos (`routes/llmGuard.ts:73-90`; `auth.ts:70-73`); M-13 continua aberto (`internalLlm.ts:26,41-44`) |
| T-2 | Migrations 141–162 | **Atendido com condições** | §5 |
| T-3 | Coerência docs × código | **Parcial** | §6: 5 de 7 conferem; 2 divergências novas e documentos desatualizados (push/CI, Z1) |

## 3. Gate F4: o que as 5 rodadas reais provaram de fato

**n efetivo.** Foram 10 execuções de card em 5 rodadas, todas no **mesmo produto** (`SPEC-02-content-svc`), no mesmo tenant (`e2e`), no ambiente **dev** (não a ZFactory em homologação), com o mesmo modelo, com FTS co-locado e com o mesmo operador. Contam como uma série de casos, não como amostra. Só uma execução (TK-0010) rodou sobre o código vigente (pós-BG/BH). As outras nove validaram versões anteriores do código, que foram corrigidas justamente por causa delas.

| Rodada | Cards (tipo) | Chegou a `delivered` | Todos os binários do §1 | Principal motivo |
|---|---|---|---|---|
| 4.5 (AP) | TK-0001/2/3 (um por tipo) | 3 | 0 | QA falhou 9/9; FULL-TEST `DONE` sem executar; escopo violado (TK-0001); `confirm` nos 3 |
| 4.5b (AS) | TK-0004 (Correção) | 1 | 0 | Baseline `no_tests`; `pnpm-lock.yaml` +5.486 no PR; FULL-TEST não executada |
| 4.5c (BA) | TK-0005/6/7 | 1 (TK-0005) | 0 | TK-0006 **aceito pelo Cyborg com o build do produto quebrado** (TS2554); TK-0007 com escopo violado; kill switch |
| 4.5d (BF) | TK-0008/9 | 0 | 0 | `needs_human` correto (D-12 ERESOLVE, D-13 auditoria do produto inteiro) |
| 4.5e (BI) | TK-0010 (Correção) | 1 | **0** | FULL-TEST `REJECTED`; baseline `error`; Cyborg por fallback só-auditoria (D-18); `confirm:"MERGE"` |

O que está **provado ao vivo**:
- encanamento (estados, `delivered` ⇔ merge, evento único, `TK-NNNN`, `card_id`);
- gate de build fail-closed para o `nest build` (BF);
- gate de escopo por diff real (`blocked_scope` em BA);
- auditoria escopada ao delta no caminho feliz (BI);
- fallback `--legacy-peer-deps` (BI);
- FULL-TEST executada de verdade, sem `DONE` falso;
- custo de US$ 3,6–8,4 por card.

O que **não** está provado:
- **baseline/P2P medidos pelo sistema**: 0 de 10;
- **FULL-TEST PASS**: 0 de 10;
- **merge sem `confirm`**: 0 de 6 entregas;
- Evolução e Recurso novo no código atual;
- uma rodada de correção do Cyborg que **aceita** código bom;
- o ramo `PRE_EXISTING`;
- o caminho do engenheiro (`/cyborg-engineer`);
- `CARD_BASE_STALE`.

**Honestidade da conclusão do BI.** A prosa do BI é honesta: ela declara as ressalvas D-18, D-19 e D-11 logo na primeira linha. Já a tabela do BI §4 **troca os critérios do plano**. "TSK-FULL-TEST **PASS**" virou "executado de verdade" (a task foi reprovada). "Baseline **PASS**" virou "erro explícito; não medida". "Fechado neste caso" (§8) só vale para a régua nova. Pela régua do plano, o TK-0010 tem **dois FAIL** (FULL-TEST e P2P medido pelo sistema) e **uma intervenção** (`confirm`). A medição independente (0 regressões em 3 execuções, F2P real) mostra que o **código entregue estava certo**. Ela não mostra que o **sistema** sabe distinguir certo de errado sem o humano. Declarar F4 cumprido seria fabricar o check.

## 4. Achados novos (por severidade)

### Bloqueantes (para B)

**B-N1 — Se o Host B falhar, o Cyborg roda o build do produto no control plane, com `docker.sock` e token admin** [conferido]. `cyborg_v3.py:528-560`: o `/cyborg-build` é despachado ao executor. Se a resposta não é 200 ou a chamada levanta exceção (Host B fora, `ingest` falho, timeout de 360 s), o código cai em "FTS indisponível — build local": `npm install --legacy-peer-deps` (executa `postinstall`), `npx tsc` e `npm run build`, com `env={**os.environ}`, **dentro do container `cyborg`**. Esse container tem `env_file: .env`, `GENESIS_API_TOKEN` admin, `/project-files` de todos os tenants e **`/var/run/docker.sock` montado** (`docker-compose.yml:280-305`), ou seja, root no host de produção. O comportamento já existia (está em `bce3f50:cyborg_v3.py:524`), mas o programa passa a levar **conteúdo escrito por usuário de tenant** (texto e anexos do card → LLM → código e dependências) até esse caminho. A decisão "Host B para clientes" (BE §4.1) fica **fail-open** justamente quando o Host B cai. Correção pequena (meu trabalho): com `executor_is_remote()` verdadeiro, **proibir** o fallback local (`build_rc=-1` ⇒ não aceitável, `needs_human` "executor indisponível"), com teste.

**B-N2 — O gate F4 não foi cumprido** (critério 5; §3). Cenário: ligar com P2P nunca medido pelo sistema e com FULL-TEST sempre reprovada no produto de teste. Todo card cairia em `confirm:"MERGE"`, e o filtro de qualidade passaria a ser o hábito do operador (D-19). O plano diz que esta decisão cabe ao gate e não ao operador. A única saída honesta é: **(i)** repetir o F4 em produto com suíte executável; **ou (ii)** uma decisão escrita do Jean que redefina a onda 1 da ZFactory como continuação da homologação, com regras operacionais duras (lista B, item J1).

### Altas

**A-N1 — A configuração de produção não é a que foi testada: a ponte `/cyborg-engineer` funciona com o Host B e nunca foi exercitada em card** [conferido]. No dev o FTS é co-locado e não tem `GENESIS_API_TOKEN`, por isso `_mint_scoped_token` falha (`full-test-server.py:223-230`) e dá 502 (D-18). Em produção (`UNTRUSTED_EXECUTOR_URL` remoto, BE §1.5), quem cunha o token de projeto e o injeta como `genesis_token` é o control plane (`executor_bridge.py:174-188`; FTS `_resolve_scoped_token`, `:251-258`), então a ponte **vai rodar**. Nesse caminho:
- (a) a sessão `claude --dangerously-skip-permissions` recebe o briefing genérico ("publicar no S3", wrappers `zentriz-github-push`, que faz push **direto em `dev`**, e `zentriz-accept`) sem a instrução de escopo ao delta do D-13 (`cyborg_v3.py:1151-1210`);
- (b) o `DELIVERED` é aceito pelo texto da última linha (`:2788-2799`), sem gate de build nem de escopo além do gate de árvore;
- (c) no Host B as edições ficam na cópia remota e **não voltam** ao control plane. O push falha para filho ainda não publicado, porque `github-clone-token` exige uma linha do próprio filho em `project_github_repos`, criada só na publicação (`projects.ts:1315-1325`; `githubPush.ts:710`). Mesmo assim a sessão pode chamar `zentriz-accept`.

Isso é inferência a confirmar, mas tem base no código. O cenário provável é este: o engenheiro "entrega", o watcher aceita (`zentriz_cyborg.py:1074-1086`) e o PR sai com o código do Dev, aquele que reprovou na FULL-TEST, sem a correção do engenheiro. É o D-19 sem nem a auditoria das 5 análises. Correção (meu trabalho, pequena): em filho de card (`_audit_delta_active`), **não** chamar `spawn_engineer` e ir direto ao caminho de auditoria e rodadas com gates (o que foi testado). A alternativa é provar a ponte numa rodada real com o Host B, antes de ligar.

**A-N2 — Regressão com a flag desligada: run disparado por `zentriz_admin` em projeto de outro tenant fica sem LLM** [conferido]. `pipeline.ts:727-739` assina o token do runner com o `tenantId` **do usuário**. `denyForeignTenant` (`routes/llmGuard.ts:73-86`) passou a exigir que o tenant do token seja igual ao tenant do projeto e, se não for, responde 404 em preflight, advisor-gate e record. Cenário: o Jean, como `zentriz_admin`, dispara ou retoma `/run` de um projeto da Venuxx. Todo LLM é negado, sem teste e sem env para desligar. Correção: cunhar o token com o `tenant_id` do **projeto** (ou isentar `role=zentriz_admin` sem claim), com teste.

**A-N3 — Comportamentos globais ainda fora da flag** (critério 1; decisão Z4 em aberto). (a) `CYBORG_TREE_GATE=on` apaga ou restaura lockfile **também em greenfield/legado** (`cyborg_v3.py:2528-2548,2565`). O Cyborg adiciona uma dependência, o lockfile volta ao antigo e o `npm ci` do deploy quebra. (b) O teto horário por tenant `auto` = 50 % do global (`llmGuard.ts:61-63,446-458`) nega um tenant legado que passe de metade do teto, e mesmo assim não impede que um tenant ligue o kill switch global: a checagem é `gasto >= teto`, sem estimativa nem chamadas em voo (`:406-408,799-802`). (c) FULL-TEST não executada ⇒ `CANCELLED` em todo projeto (`runner.py:6106`). (d) Com a API inalcançável na partida, o `_is_card_child` devolve `None`, `unknown_as=True` liga o fail-closed, e um run legado vai a `failed` com "Spec ilegível" (`runner.py:744-762,1113-1117,6209-6216`). Isso pode acontecer na janela do próprio recreate da API. Há env para (a), (b) e (d); (c) não tem.

**A-N4 — D-19 confirmado no código: o aceite do Cyborg ignora `type_check_rc` e a FULL-TEST, e aceita `build_rc=-1`** [conferido]. `evaluate_audit_acceptance` (`cyborg_v3.py:2599-2628`) recusa `build_rc ∉ {0,-1}`, mas no caminho "ideal" **aceita `-1`** ("build não rodou"). Nunca olha `type_check_rc` e não compara erros de tipo do filho com os do pai. O resultado da TSK-FULL-TEST também não entra, embora seja ela que leva o projeto ao Cyborg. A régua "não aprovar o que quebra o build do delta" vale hoje para o `build` do código de produção (provado em BF), mas **não** vale para: (i) erro de tipo novo fora do `tsconfig.build` (specs); (ii) build não executado (`-1`, por exemplo o fallback local que levanta exceção, `:633-635`); (iii) regressão de testes. Ao aceitar, a linhagem já é atualizada (pai `archived`, filho HEAD) antes de qualquer humano. A trava real fica só no merge (`blocked_no_evidence`/`confirm:"MERGE"`; `evolutionPlan.ts:268-298`).

### Médias

- **M-N1 — Executor sem bloqueio real de Docker** (D-15 ressalvado). Os *shims* de `docker`/`podman` ficam no PATH, num diretório gravável, e só no `/run-full-test` (`full-test-server.py:842-874,2030`). O próprio código admite que caminho absoluto e socket passam (`:842-843`). `/run-tests` e `/cyborg-*` não têm nem os shims. "Docker bloqueado" no BI significa "a tentativa ingênua foi interceptada", não isolamento. No Host B o risco depende da presença de Docker lá (a verificar).
- **M-N2 — Isolamento do Host B incompleto.** O `_assert_untrusted_host_has_no_secrets` (`:2241-2263`) olha só o env, e o `_fts_admin_token` lê `/opt/zentriz-genesis/.env` do disco como fallback (`:212-219`). O `/ingest-project` não limpa o alvo nem apaga ao fim, e todos os tenants ficam sob o mesmo usuário e a mesma raiz (`:1304-1305`). Um job lê o código de outro tenant (R-12 do BE). O `/run-full-test` não confina `project_path` (`:1915`).
- **M-N3 — Guarda B-2 não vale em produção.** O unit chama o Python direto (`genesis-full-test.service.template:33`), então a recusa `FTS_HOST_ROLE=production` sem `FTS_ISOLATED_EXECUTOR=1`, que vive em `start-fts.sh:36-37`, nunca roda. Além disso, `FTS_HOST_ROLE` tem padrão `development` (fail-open). Com o FTS co-locado parado, o impacto atual é nulo. Ele passa a existir se alguém reativar o unit.
- **M-N4 — Token `svc:"runner"` com papel `zentriz_admin` cunha tokens de qualquer tenant.** Os tokens de run copiam o papel do dono (`pipeline.ts:728-737`; `runnerDispatch.ts:129-135`). `/api/internal/cyborg-token` só checa `role !== "zentriz_admin"` (`internalLlm.ts:169`), e `POST /api/admin/zentriz-llm-config` também aceita (`:239`). Um vazamento do token de 24 h de um run da conta de gestão vira acesso cross-tenant. Correção: exigir `!payload.svc` nas duas rotas.
- **M-N5 — Custo do FTS fora do ledger** (critério 6b): a FULL-TEST roda na conta do slot e não é debitada no `budget_usd` nem no teto do card.
- **Persistem do AV:** M-2 (estimativa pausa a linhagem), M-13 (`===` e modo dev aberto), M-3 parcial (gate de árvore ignora `build/out/target/venv` e é fail-open em `cyborg_v3.py:2590-2591`; o push de produto novo não filtra `.env`), L-4, L-5.

### Baixas

- **L-N1** Rollback **com cards criados** não é seguro sem limpeza. A imagem antiga não tem `notHiddenProjectSql` (cerca de 30 leitores) nem as guardas Y-05: `card_draft` aparece em listagens e no contexto dos agentes, vira `draft` executável por PATCH, e o card é promovido por fora pelo `/evolve` antigo, que copia todos os anexos. Isso é "alta" se ocorrer, mas só se aplica depois de ligar (B).
- **L-N2** Depois do rollback, os índices de boot transformam o duplo clique no `/evolve` antigo em 500 (23505), e o vazamento de token em `extra` volta (`redactSecrets` não existe em `bce3f50`; a 147 não roda de novo).
- **L-N3** 141/148: `DROP`+`ADD CONSTRAINT` sem transação deixa uma janela sem CHECK se o `ADD` estourar o `lock_timeout` (falha segura).
- **L-N4** D-20 (rótulo `blocked_regressions` para ausência de medição; CHANGELOG contando como diff do RFC; truncamento) e CHANGELOG escrito pelo próprio sistema contra o Non-goal do card.

## 5. D-18 e D-19: gravidade e tratamento

| | Gravidade | Corrigir ANTES de ligar (B) | Pode ficar como risco aceito |
|---|---|---|---|
| **D-18** (ponte do engenheiro 502 no dev) | **Alta**, mas não do jeito que o BI descreve. No dev é ambiental. Em produção, com o Host B, a ponte **funciona**, e o problema passa a ser A-N1: caminho não testado, `DELIVERED` aceito pelo texto e edições que não voltam | Em filho de card, desviar o `spawn_engineer` para o caminho de auditoria e rodadas (o testado), **ou** provar a ponte com o Host B atualizado numa rodada real | Configurar `GENESIS_API_TOKEN` no FTS do dev **não** é necessário para produção. Fazer isso só para "fechar o D-18" apenas colocaria o token admin no processo que executa código não confiável no dev |
| **D-19** (aceite não depende de FULL-TEST/tsc) | **Alta** (A-N4) | (1) em filho de card, `build_rc=-1` **não** aceita; (2) `type_check_rc` comparado com o pai: erro de tipo **novo** no delta ⇒ não aceita (cumpre "não aprovar o que quebra o build do delta" sem punir dívida antiga, como os 14 erros pré-existentes do TK-0010); (3) B-N1 | FULL-TEST reprovada por **infraestrutura** de teste (produto sem jest config ou sem Mongo) seguir para aceite, com `factoryHealth: failed` e merge travado em `confirm:"MERGE"`, **desde que** valha a regra operacional "confirm só depois de medição independente registrada" (a mesma usada no BI) e que o Jean aceite por escrito. Rebaixar todo aceite com FULL-TEST reprovada para `needs_human` tornaria todo card do SPEC-02 inviável. A raiz é D-11 (baseline nunca medida) |

**O aceite do Cyborg sem sessão do engenheiro, com FULL-TEST reprovada e com erros de tsc pré-existentes, é seguro?** Hoje é **parcialmente** seguro. O que impede código quebrado de chegar a `dev` é a trava de merge (`confirm:"MERGE"` com auditoria gravada antes, `503 AUDIT_UNAVAILABLE`), não o aceite. No TK-0010 o código estava certo, mas o sistema não sabia disso: quem sabia era a medição independente do operador. Com as correções (1) a (3) acima, o aceite passa a respeitar a régua "não quebrar o build do delta", e a FULL-TEST reprovada por infraestrutura fica como risco aceito e explícito.

## 6. Coerência docs × código (7 afirmações amostradas)

| # | Afirmação | Resultado |
|---|---|---|
| 1 | P2: `SELECT version FROM schema_migrations WHERE version >= '141'` (ROLLOUT:64) | Confere (`db/init.ts:12,101`) |
| 2 | 12 migrations 141–162, sem 146 e sem 151–159; produção com 141 linhas ⇒ 153 (RUNBOOK:280; BE:558) | Confere |
| 3 | C5: sem `EVOLUTION_PROMOTE_BANCADA` ⇒ `409 NOT_ON_WORKBENCH` (ROLLOUT:80) | Confere (`pipeline.ts:144-163`) |
| 4 | C10: sem orçamento ⇒ `402 BUDGET_MISSING` **na criação** (ROLLOUT:86) | **Diverge**: com `budget_usd=0` o card nasce (201) e para no refino com `402 BUDGET_PAUSED` (`evolveClaim.ts:114-122`; `llmGuard.ts:479-484`). Para os 14 da ZFactory (todos v1/raiz) o `PUT` na raiz funciona; numa linhagem, o dono é o primeiro projeto com `budget_usd` não nulo a partir do HEAD |
| 5 | C12/passo 9: `baseline.status = ok`; `blocked_no_tests`/`no_evidence`/`regressions`/`scope` (ROLLOUT:88,115,117) | Confere (`evolutionMerge.ts:43-46,246-272`) |
| 6 | `budget/resume`: svc 403, sem saldo 402, repetir é no-op (RUNBOOK:132) | Confere, com duas ressalvas: projeto sem orçamento dá **409** `BUDGET_MISSING` (`routes/llmGuard.ts:226`) e não 402 como no RUNBOOK:494; o L-4 continua (`resumed` duplo) |
| 7 | Deploy api → agents por causa do `advisor-gate` (ROLLOUT:194) | Confere (`routes/llmGuard.ts:142`; `agents/llm_guard.py:294-296`) |

As divergências (a) a (f) do AV §5 foram corrigidas. **Novas:**
- ROLLOUT §10.3 item 1 (:339) ainda manda "push de dev (183 commits)", mas o push e o CI já aconteceram.
- ROLLOUT Z1 (:311) diz "Aberto", mas o A-1 está **corrigido** no código (`runner.py:3524-3560`; teste `test_av_a1_a4_correcoes.py:17-40`).
- §7.3 × §7.4 se contradizem.
- O cabeçalho do plano (`plano.md:5`) ainda diz "nada executado".
- O BE (§0 e §1.9) e o pedido deste parecer afirmam que o código de produção "não está no GitHub", o que **não vale mais** para `bce3f50`. Continua valendo que a árvore `/opt/zentriz-genesis` e `origin/main` estão em `09653d5`, e o compose é BUILD-based.
- O BE §3.2 aponta a ambiguidade da ordem de rollback (api primeiro × api por último). A ordem segura é a do BE (inversa do deploy, api por último), e ela deve ser a única escrita.

## 7. Migrations 141–162, ordem de deploy e rollback

- **Migrations:** todas são aditivas e idempotentes; não há NOT NULL sem DEFAULT; os CHECKs novos são superconjuntos dos antigos; as tabelas de produção são pequenas (BE §1.2). A única irreversível é a 147, que redige segredos e não tem leitor que dependa deles. O executor sem transação é aceitável com essas propriedades. Os 6 índices únicos de `ensureEvolutionUniqueness` (boot, sem flag) **ficam** após o rollback (L-N2).
- **Ordem** api → agents → [Host B] → runner → cyborg → web: compatível com a flag desligada. A janela de risco é o recreate da API: um run que comece ou retome nesse momento pode ir a `failed` (A-N3 d). Mitigação: janela quieta (0 runs, já medido) ou `EFFECTIVE_FLAGS_FAIL_CLOSED=off` no runner até estabilizar.
- **Rollback por imagem:** seguro **sem cards criados**, pela análise estática. **Não testado** (BL-6). Como produção roda `bce3f50` e o diff é de 165 commits, o teste é barato e obrigatório antes de deploy: subir `rollback-api:pre-evo-20261103` contra um Postgres restaurado do dump novo com as 12 migrations, e bater em `/health` e nas rotas legadas. Depois de ligar (B), rollback exige antes arquivar os `card_draft` (L-N1).

## 8. Orçamento × Guard × cards

- Os 14 `accepted` da ZFactory são todos v1/raiz (BE §1.4), então o `PUT /api/projects/<ROOT>/budget` no próprio projeto define o dono **e** despausa, via `maybeResumeBudget` (`routes/llmGuard.ts:208`; `llmGuard.ts:877-889`). Isso só acontece se `budget − gasto histórico ≥ max(0,10; 3 × mediana)`; abaixo disso o valor é gravado mas a pausa continua. O `PUT` recusa ≤ 0.
- Com `budget_usd=0` e pausado, um card **nasce** e fica em `draft`/`refining` com `402 BUDGET_PAUSED`. A promoção é negada (`evolveClaim.ts:290`). Não executa nada e fica visível, mas o runbook promete outra coisa (§6 #4).
- O teto do card é `card_budget_pct × budget_usd` **vivo** (A10/M5: muda se o orçamento mudar), limitado por `abs_cap_usd` (`costPolicies.ts:286-290`). Com um único card por vez e o teto horário do tenant (`auto` = 50 % do global), a exposição por hora fica limitada. A FULL-TEST fica fora do ledger (M-N5).
- O fluxo legado com budget 0 tem a mesma semântica de `bce3f50`, mais o teto por tenant (A-N3 b). Os 14 projetos já estão pausados, então a promoção do código não muda nada para eles.

## 9. Listas objetivas

### (A) Para promover o CÓDIGO a produção com `CARDS_BANCADA` desligada

**Decisão do Jean**
1. OK explícito para o deploy (roteiro BE §2), em janela quieta.
2. Decidir os globais de A-N3, valores **no `.env` de produção antes do recreate**:
   - `CYBORG_TREE_GATE` (recomendo `off` até ser condicionado a card);
   - `tenant_max_usd_per_hour` (recomendo valor explícito, não `auto`, conhecendo o pico atual);
   - `EFFECTIVE_FLAGS_FAIL_CLOSED` (recomendo `off` na promoção, `card` depois);
   - FULL-TEST não executada ⇒ `CANCELLED` (aceitar como melhoria ou pedir condicionamento).
3. Confirmar se o FTS co-locado parado é intencional (R-9: deploys S3/backend dos produtos sem listener).
4. Infra (pré-existente, independe do código, mas de severidade **alta**): restringir o SSH 22 hoje aberto a `0.0.0.0/0`; `chmod 600` no PEM (hoje 644); apagar as ~25 cópias `.env.bak*`; rotina de backup do banco.

**Meu trabalho**
5. Corrigir **A-N2** (token do runner com o tenant do projeto) com teste, **ou** registrar o risco aceito e a contorna operacional (não disparar `/run` como `zentriz_admin` em projeto de outro tenant).
6. **Teste de rollback** (BL-6) em ambiente efêmero com o dump novo.
7. Dump novo no dia (BL-7); tags `rollback-<svc>:pre-bancada-AAAAMMDD`; conferência de digest em cada serviço; reconciliador em `shadow` por ≥ 3 passadas.
8. Atualizar os docs desatualizados (§6: ROLLOUT §10.3 item 1, Z1, §7.3/§7.4, ordem de rollback única, C10, 409 × 402, cabeçalho do plano).

**Risco aceito (registrar)**
9. A 147 é irreversível (só redige segredos); os índices de boot ficam após o rollback (corrida no `/evolve` antigo vira 500); `bce3f50` sem `redactSecrets` no rollback.
10. Suíte de regressão do legado ponta a ponta inexistente (M-7): o risco é coberto pelas envs da lista acima, pelo rollback testado e por 24 h de observação.
11. Fallback local do Cyborg (B-N1) **para projetos legados**: comportamento pré-existente, sem conteúdo de card com a flag desligada. Mesmo assim, recomendo aplicar a correção já nesta promoção, porque é pequena.

**Veredito (A): PRONTO COM CONDIÇÕES** (itens 1, 2, 5 e 6 são condição; os demais são higiene obrigatória do roteiro).

### (B) Para LIGAR `CARDS_BANCADA` na ZFactory

**Decisão do Jean**
- J1. **Gate F4:** ou (i) repetir as 3 execuções (Evolução, Correção, Recurso novo) em produto com suíte executável e baseline `ok`; ou (ii) uma decisão escrita que redefina a onda 1 como **homologação em produção**, com estas regras:
  - um card por vez;
  - `confirm:"MERGE"` só depois de medição independente registrada no ticket;
  - critério de saída da onda 1 = os binários do plano, não "delivered".
- J2. Aceite escrito do risco residual D-19: FULL-TEST reprovada por infraestrutura chega a PR, com merge travado.
- J3. Orçamento do produto de fumaça (`PUT` na raiz, acima do gasto histórico + margem) e `card_budget_pct`.
- J4. Produto de fumaça com serviço único **e suíte executável** (C12; candidatos do BE §1.4, nenhum medido). Sem isso, D-11 repete e todo merge vira `confirm`.
- J5. Abertura temporária de SSH ao Host B (BL-3); verificação da permissão de PR do app 3609618 (BL-4).
- J6. Pendências do plano: D-E9, D-E3, AB-07, M5/A10 e Z3 (N-7/`NOT_RUN`).

**Meu trabalho** (condição; cada item com teste que falha sem a correção)
- W1. **B-N1:** sem fallback local de build quando o executor é remoto (fail-closed `needs_human`).
- W2. **A-N1:** filho de card não chama `spawn_engineer` (caminho de auditoria e rodadas com gates), ou uma rodada real que prove a ponte com o Host B.
- W3. **A-N4/D-19:** em filho de card, `build_rc=-1` não aceita; erro de `tsc` **novo** em relação ao pai não aceita.
- W4. Atualizar o FTS do Host B para a versão de `dev` (BE §4.2 R1) e fazer o canário R2. Conferir que não existe `/opt/zentriz-genesis/.env` no Host B (M-N2) e que o Docker está ausente ou inacessível lá (M-N1).
- W5. M-N4 (`!payload.svc` em `cyborg-token` e `zentriz-llm-config`).
- W6. Depois de W1–W5: **uma rodada real no dev com o executor remoto simulado**, ou o primeiro card da ZFactory tratado como rodada 4.5f, com relatório pela régua do plano (sem trocar os critérios).

**Risco aceito (registrar com dono e prazo)**
- R1. Conteúdo de card só da Zentriz executado no Host B, com egress aberto e sem limpeza entre jobs (R-12 do BE, M-N2). Aceitável na onda 1 da ZFactory; **bloqueante** para clientes.
- R2. A-5 estrutural (vários tenants somando até o teto global) e M-2 (estimativa pausa a linhagem): aceitáveis com um tenant e um card por vez.
- R3. Caos do runner provado só com API falsa (critério 4) e `spec_origin` incompleto (critério 2).
- R4. FULL-TEST fora do ledger (M-N5): acompanhar pelo gasto do slot.

**Veredito (B): NÃO PRONTO.** Passa a **PRONTO COM CONDIÇÕES** quando: W1–W5 estiverem feitos e testados; J1 decidido (a variante (ii) aceitável só com as regras escritas); J2–J5 resolvidos; e o código promovido pela lista A. Para qualquer tenant de **cliente**, valem também os itens K1 a K10 do ROLLOUT §10.2: B-2/R1 resolvido, A-5 estrutural e F4 cumprido pela régua original. Nenhum desses itens pode virar risco aceito.

## 10. Resumo dos bloqueantes e altas

| Id | Sev. | Onde | Afeta |
|---|---|---|---|
| B-N1 | Bloqueante | `cyborg_v3.py:528-560` + `docker-compose.yml:280-305` | B (e A como higiene) |
| B-N2 | Bloqueante | Gate F4: 0/10 binários; n = 1 no código atual | B |
| A-N1 | Alta | `cyborg_v3.py:1151-1240,2676,2788-2799`; `executor_bridge.py:174-188` | B |
| A-N2 | Alta | `pipeline.ts:727-739` × `routes/llmGuard.ts:73-86` | A |
| A-N3 | Alta | `cyborg_v3.py:2565`; `llmGuard.ts:61-63,446-458`; `runner.py:6106,744-762` | A |
| A-N4 | Alta | `cyborg_v3.py:2599-2628` | B |
| Infra | Alta (pré-existente) | SSH `0.0.0.0/0`, PEM 644, `.env.bak*`, sem backup (BE R-7, R-10, R-11) | A e B |
