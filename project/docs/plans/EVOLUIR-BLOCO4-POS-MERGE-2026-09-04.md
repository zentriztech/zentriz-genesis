> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Evoluir — Bloco 4: pós-merge (merge automático, redeploy com a mesma identidade, Auto Care em `dev`, Dev em modo diff) — plano v1, 2026-09-04

| Campo | Valor |
|---|---|
| Status | **v1 — pesquisa (§1) + fatos do código (§2) + desenho (§3) + adversarial do próprio desenho (§4, 19 GAPs) + plano ordenado (§5). NADA implementado, NADA commitado, NADA deployado.** |
| Base | Fases 1+2 + blocos 2 e 3 do Evoluir em `dev` (até `1a94d9a`); planos `EVOLUIR-BLOCO2-ENDURECIMENTO-2026-09-04.md` e `EVOLUIR-BLOCO3-FABRICA-DELTA-2026-09-04.md` |
| Fora | blue/green real por nuvem (adiado, §3.2 D-B2); `unified diff` puro no Dev (adiado, §3.4); merge queue / GitHub auto-merge nativo (§1.1) |
| Flags | **todas OFF por default** (§5.4). Ligar é decisão do Jean, uma por vez, com PÓS ao vivo (§5.6) |
| Repos tocados | `zentriz-genesis` (api-node, genesis-web, orchestrator); `zentriz-deadpool-auto-care` (1 PR separado, item 3) |

---

## 0. Resumo executivo (o que muda para o cliente)

Hoje, ao aceitar uma evolução `vN`, o Genesis: gera o CHANGELOG SemVer, faz push do branch `evolution/vN` no repo da RAIZ da linhagem, abre PR para `dev` (ou devolve compare URL se a GitHub App não tem `pull_requests`), arquiva o pai e registra o filho no Deadpool com a mesma chave. **Para aí.** O PR fica aberto; `dev` continua com o código do pai; um deploy do filho deploya `dev` (= código do pai); o Deadpool segue com `local_path` do filho em `evolution/vN`.

O bloco 4 fecha o ciclo em quatro itens, cada um atrás de flag:

1. **Merge automático** do PR `evolution/vN → dev` (squash, gated: PR aberto pela App, `mergeable`+`clean`, PASS_TO_PASS sem regressão, compat explícito ≤ `minor`; `major` sempre humano) + **observador de merge** (detecta merge manual e dispara os hooks pós-merge).
2. **Redeploy com a mesma identidade**: o filho herda as preferências de deploy do pai, o deploy usa o branch certo (`evolution/vN` antes do merge, `dev` depois), grava `git_sha`, encadeia com o deploy do pai (`supersedes_deployment_id`) e ganha **rollback por SHA**. Recomendação: **substituição in-place** (é o que a nomeação por `repoName` já faz na nuvem) com rollback determinístico; blue/green real adiado.
3. **Auto Care pós-merge**: realinhar a working tree do filho para `dev` (só se limpa), reenviar o registro ao Deadpool com `branch: "dev"` (campo novo no registry), migrar `project_deadpool_monitoring` do pai para o filho sem tocar no histórico (que é chaveado por `service_name`/`incident_id`, não por projeto).
4. **Dev em modo diff**: **adiar o `unified diff`**; fazer, em duas fases, um formato **`edits` (search/replace, semântica `str_replace`)** opcional com fallback para arquivo completo, aplicado no runner em Python puro (o runner não tem `git`), precedido de uma fase de **medição** que prova (ou refuta) o ganho.

---

## 1. Pesquisa (2026-09-04) — grounding e o que muda

### 1.1 GitHub — merge, mergeability, permissões, políticas de automerge

| Fonte | Fato relevante | Aplicação no desenho |
|---|---|---|
| [REST · Pulls · Merge a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#merge-a-pull-request) | `PUT /repos/{owner}/{repo}/pulls/{n}/merge` com `commit_title`, `commit_message`, **`sha`** ("SHA that pull request head must match to allow merge") e `merge_method` ∈ `merge\|squash\|rebase`. **200** ok · **405** "merge cannot be performed" (protegido/não mergeável/método desabilitado) · **409** "sha was provided and pull request head did not match" · **422** validação | passar sempre `sha` = head que o Genesis empurrou → proteção contra push humano entre o push e o merge (GAP 2); mapear 405/409/422 para estados legíveis |
| [REST · Get a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#get-a-pull-request) | `mergeable` **`null`** = GitHub iniciou job em background para computar; re-consultar. `mergeable_state` (REST) / `MergeStateStatus` (GraphQL): `clean`, `dirty` (conflito), `blocked` (proteção não satisfeita), `behind`, `unstable` (checks não obrigatórios falhando), `has_hooks`, `draft`, `unknown` ([GraphQL enums](https://docs.github.com/en/graphql/reference/enums#mergestatestatus)) | poll com backoff enquanto `null` (máx. 5 tentativas); só mergear em `clean` (opção para aceitar `has_hooks`); `dirty`→`blocked_conflict`, `blocked`→`blocked_protection`, `behind`→ tentar `update-branch` UMA vez (GAP 5) |
| [REST · Update a pull request branch](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#update-a-pull-request-branch) | `PUT .../pulls/{n}/update-branch` com `expected_head_sha` | única ação corretiva automática permitida (estado `behind`); se ainda não ficar `clean`, humano |
| [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps?apiVersion=2022-11-28) | criar/obter/mergear PR → **`Pull requests: read & write`**; refs/trees/branches → **`Contents: write`**; status combinado → `Commit statuses: read`; check runs → `Checks: read`; proteção de branch → `Administration: read` | a App `genezis-factory` hoje tem `contents`/`administration` (comentário em `github.ts:676`) → **AÇÃO DO JEAN** (§5.5) |
| [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) | alterar permissões da App **não vale até o dono de cada instalação aprovar**; até lá o token continua com o conjunto antigo. 403 "Resource not accessible by integration" traz o header **`X-Accepted-GitHub-Permissions`** com o que falta | fallback obrigatório (PR fica aberto + aviso no painel); logar o header para diagnóstico; tenants com App própria (`tenant_github_installations.app_id`) precisam aprovar eles mesmos (GAP 1) |
| [About merge methods](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/about-merge-methods-on-github) | squash: 1 commit, histórico linear; perde SHAs individuais; **reusar o head branch depois de squash reapresenta os commits em novo PR (conflitos)**. Rebase: reescreve SHAs e perde verificação de assinatura. Merge: preserva tudo mas pode ser vetado por "linear history" | **squash recomendado** (§3.1 D-M1): os commits de `evolution/vN` são lotes mecânicos de 80 blobs (`github.ts:472`), sem valor histórico; cada evolução usa branch NOVO (`vN+1`) criado de `dev` → a armadilha de reuso não se aplica; fallback `merge` se o repo desabilitar squash (405) |
| [Automatically merging a PR (nativo)](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request) | exige "Allow auto-merge" no repo **e** proteção de branch com checks/reviews obrigatórios na base; habilitado por PR via UI/GraphQL; desativa sozinho se alguém sem write empurra no head | **não usar**: os repos gerados não têm proteção em `dev` nem checks obrigatórios (o CI gerado é `lint/test/build`, sem status obrigatório); o gate do Genesis é PASS_TO_PASS no checkpoint, não um check do GitHub. Fica como v2 se o tenant configurar proteção |
| [Renovate · Automerge](https://docs.renovatebot.com/key-concepts/automerge/) | política madura: só com **testes passando**; sem testes exige opt-in explícito (`ignoreTests`) e é "strongly" desaconselhado; **nunca automerge de major**; proteção/reviews obrigatórios bloqueiam; `platformAutomerge` delega ao GitHub | espelhado 1:1: `EVOLUTION_AUTO_MERGE_ALLOW_NO_TESTS=off`, `EVOLUTION_AUTO_MERGE_MAX_COMPAT=minor` (major nunca), estados `blocked_*` legíveis com ação inversa manual |

### 1.2 Deploy de evoluções — blue/green × in-place

| Fonte | Fato | Aplicação |
|---|---|---|
| [AWS · Blue/Green Deployments on AWS (whitepaper)](https://docs.aws.amazon.com/whitepapers/latest/blue-green-deployments/welcome.html) | dois ambientes idênticos, troca de tráfego (Route 53 weighted, swap de target group ELB, task set ECS, alias Lambda, origem S3/CloudFront); rollback = trocar de volta; **a camada de dados deve ser desacoplada (schema compatível para trás)**; janelas de DNS TTL | o BYOC do Genesis **não gerencia DNS nem duplica recursos** (nome do recurso = `repoName`, `deployTargets.ts:246/276/299/328/451`) e são **12 templates** (4 formatos × 3 nuvens). Blue/green real = duplicar recursos e trocar tráfego em cada um → custo alto, dobra a conta do tenant e exige DNS. **Recomendação: in-place com rollback por SHA** (§3.2 D-B2); ECS `update-service --force-new-deployment` já faz rolling com `minimumHealthyPercent`; Lambda alias e S3+CloudFront ficam como v2 por formato |

### 1.3 Geração de código por patch (Aider, OpenAI, Anthropic, git)

| Fonte | Fato | Aplicação |
|---|---|---|
| [Aider · Edit formats](https://aider.chat/docs/more/edit-formats.html) | `whole` é "slow and costly" (devolve o arquivo inteiro); `diff` = blocos SEARCH/REPLACE com marcadores estilo conflito git (formato default para a família Claude); `udiff` foi criado para o "lazy coding" do GPT-4 Turbo; `diff-fenced` para Gemini; `editor-*` no modo architect | o Dev do Genesis é `whole` puro (`SYSTEM_PROMPT.md:419-431`). O formato que melhor casa com Claude é **SEARCH/REPLACE**, não `udiff` |
| [Aider · Unified diffs](https://aider.chat/docs/unified-diffs.html) | Aider **removeu os números de linha** dos hunks (`@@ -2,4 +3,5 @@`) porque o modelo erra contagem; aplica com casamento flexível (normaliza espaços, quebra hunks, amplia contexto); **desligar o casamento flexível multiplica erros por 9×**; 20%→61% em refactors com GPT-4 Turbo | `git apply` estrito falharia com frequência inaceitável em diffs de LLM; se um dia for `udiff`, precisa de aplicador tolerante próprio (não `git apply`). Reforça a escolha por search/replace |
| [OpenAI · GPT-4.1 prompting guide (apply_patch V4A)](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide) | formato sem números de linha, 3 linhas de contexto, `@@` para desambiguar por classe/função; SEARCH/REPLACE e pseudo-XML "had high success rates"; **JSON "performed particularly poorly"** por causa do escaping | o envelope do Dev é **JSON** (`envelope.py`) com `content` dentro de string → um diff dentro de string JSON herda exatamente o problema apontado. Mitigação: `edits[{search,replace}]` são strings curtas (o `resilient_json_parse` já extrai valores string longos, `envelope.py:424-478`); v2 possível: bloco `<edits>` fora do JSON |
| [Anthropic · Text editor tool (`str_replace_based_edit_tool`)](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/text-editor-tool) | `str_replace`: `old_str` **"must match exactly, including whitespace and indentation"** e ser único; `insert` por linha; `view` com `max_characters` | semântica nativa dos modelos Claude → o formato `edits` do §3.4 adota exatamente essa regra (match exato e único; ambíguo = erro) |
| [git apply](https://git-scm.com/docs/git-apply) | atômico por default (qualquer hunk falha → nada é aplicado); `--3way` exige blobs no repo e deixa marcadores de conflito; `--check` valida sem aplicar; `--reject` deixa `.rej`; `--recount` ignora contagens do header | o runner **não tem git** (`Dockerfile.runner:6-22`); a API tem (`api-node/Dockerfile:20`). Usar `git apply` obrigaria mover a aplicação de artefatos para a API ou instalar git no runner. Não compensa para a v1 |

---

## 2. Fatos do código (verificados em 2026-09-04, branch `dev`)

Caminhos relativos a `applications/services/api-node/src/` salvo indicação. `D/` = `zentriz-deadpool-auto-care/src/zentriz_deadpool/`.

### 2.1 GitHub App e PR (item 1)
- Autenticação: `@octokit/auth-app` + `@octokit/rest` (`services/github.ts:1-2`). `getOctokitForInstallation()` (privada, `:174-204`) resolve **(1) App do tenant** (`tenant_github_installations.app_id/private_key_encrypted`, `:108-128`), **(2) App global** (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY_FILE|GITHUB_APP_PRIVATE_KEY`, `:131-148`), **(3) PAT `GITHUB_TOKEN`** (`:201`). **Sem cache de token** — cada função exportada cria `createAppAuth` e pede um installation token novo (~1 h de vida, `:210`). `getInstallationTokenForClone(installationId, {repositoryNames, permissions, requireScoped})` (`:234-275`) permite token reduzido e `requireScoped` recusa PAT (fail-closed, `:266-271`).
- `openPullRequest(installationId, {owner, repo, head, base, title, body})` (`:679-700`): lista PR aberto `head=owner:head`, senão `pulls.create`; **qualquer erro** → `{ok:false, error, compareUrl}`; hint de permissão quando `status===403 || /not accessible by integration/`. Nunca lança. **Não existe** `pulls.get`, `pulls.merge`, `mergeable`, `update-branch` nem leitura de proteção de branch em todo o `src/` (grep vazio).
- Comentário em `:676`: a App "hoje só tem `contents`/`administration`".
- `pushEvolutionToGitHub(projectId, {versionLabel, prBody, title})` (`services/githubPush.ts:572-684`): branch `evolution/vN` criado **de `dev`** (`createBranchIfNotExists(..., "dev")`, `:624`), PR **`base: "dev"`** (`:639`); `project_github_repos` do filho aponta o **mesmo repo** da raiz (`:631-636`); registra no Deadpool (`:645-660`). Retorno `EvolutionPushResult` (`:553-563`) **descarta o `number` do PR** — só `prUrl`/`compareUrl`. O SHA do último commit empurrado é conhecido por `pushProjectFiles` (retorna `{sha}`, `github.ts:459`) mas **não é propagado** ao resultado.
- `runEvolutionAcceptFlow(db, childId, {republish})` (`services/evolutionAccept.ts:207-298`): versão SemVer (idempotente) → push → grava `evolution_branch/_repo/_pr_url/_compare_url/_pushed_files/_deleted_files` (`:259-268`) → se push falhou, `evolution_push_pending` (`:274-280`) → `supersedeParent` (`:121-136`: filho `supersedes/evolution_version/evolution_accepted_at`; pai `status='archived'`, `superseded_by/_at/_version`, só se `status='accepted'` e ainda não supersedido). Chamado em `setImmediate` pelo `POST /accept` (`routes/projects.ts:788-796`). Republicação: `POST /api/projects/:id/evolution/republish` (`routes/evolutionPlan.ts:171-194`).
- **Compat**: `evaluateEvolutionGate` grava `evolution_compat` = máximo dos RFCs (`services/evolutionGate.ts:170-175, 197-202`), onde `parseRfcMarkdown` devolve **`null`** quando a seção "Compatibilidade" não casa nenhum padrão (`:124-126`). O aceite normaliza `null → "minor"` (`evolutionAccept.ts:213-214`). O planner grava `evolution_compat` a partir do JSON do LLM com default `minor` (`evolutionPlanner.ts:249-252, 437-448`). **Ou seja: `minor` pode ser um default silencioso, não uma declaração.**
- PASS_TO_PASS (bloco 3): o runner grava `evolution_baseline` no checkpoint (`runner.py:4895`) e, no `TSK-FULL-TEST`, `evolution_baseline.final = {passed, failed, status, regressions[:50], measured_at}` (`:4368-4369`); regressão → `TSK-FULL-TEST=QA_FAIL` (`:4377`). A API lê o checkpoint em `/project-files/.runner-state/<id>/checkpoint.json` (`routes/evolutionPlan.ts:82-100`) e expõe `baseline` em `GET /api/projects/:id/evolution-state` (`:118`). O portal mostra tudo em `components/EvolutionPanel.tsx` (193 linhas; `publish` em `:32`, `:182-189`).
- Flags existentes: kill-switch `(?? "on") === "off"` (`GENESIS_GITHUB_PUSH`, `EVOLUTION_SYNC_DELETES`) e opt-in `(?? "off") === "on"` (`SPEC_VALIDATION_GATE`). Nenhuma `EVOLUTION_*` no compose.
- Testes: `evolutionAccept.test.ts` mocka `./githubPush.js` e o DB por regex de SQL; **nenhum teste mocka `@octokit/*`** — `openPullRequest`/`pushProjectFiles` não têm teste unitário.

### 2.2 Cloud Deploy BYOC (item 2)
- Tabela real: **`cloud_deployments`** (`db/migrations/059_cloud_deployments.sql:8-41`): `project_id`, `tenant_id`, `connection_id → tenant_cloud_connections`, `provider`, `deploy_format ∈ container|static|vm|serverless`, **`branch DEFAULT 'dev'`**, `repo_full_name`, `workflow_file`, `status ∈ pending|dispatching|running|deployed|failed|expired|tearing_down|torn_down`, `run_id`, `run_id_floor`, `attempts`, `last_error`, `expires_at` (NULL = permanente), `consented_teardown`, `torn_down_at`. **Sem `sha`, sem UNIQUE além da PK, sem referência a linhagem.** Outras tabelas (`ephemeral_deployments`, `backend_deployments`) são o caminho na conta Zentriz (legado/demo), fora deste bloco.
- `loadRepoCtx(projectId)` (`services/provision/cloudDeploy.ts:56-76`): `project_github_repos ⋈ tenant_github_installations`; **`deployBranch: "dev"` hard-coded** (`:73`). `startCloudDeploy` (`:88-130`) exige `connectionId` explícito (`routes/projects.ts:1351-1352`), insere `cloud_deployments` e dispara `runDeployAttempt` (eager) + worker `cloudDeployWorker.ts` (30 s, claim atômico `WHERE status='pending'`, `cloudDeploy.ts:154-162`). Workflow commitado em `main` e em `dev` e disparado com `ref: deployBranch` (`:177-195`); `actions/checkout@v4` sem `ref` (`deployTargets.ts:228,255,287,321,347,366`) → faz checkout do ref do dispatch. `run-name` carimba `genesis_deploy_id` (`deployTargets.ts:151-159`) para correlação.
- Identidade na nuvem = **nome do repo** (`deployTargets.ts:246` ECS service, `:276` bucket S3, `:299` Lambda, `:328` tag EC2, `:451` Cloud Run). `systemId/serviceId` **não participam** do deploy.
- **Consequência hoje para o filho aceito**: passa o gate `accepted` (`projects.ts:1346`), `loadRepoCtx` encontra o repo da raiz, cria linha própria em `cloud_deployments` e **deploya `dev`** — o código do pai enquanto o PR não for mergeado. Na nuvem sobrescreve os mesmos recursos (mesmo `repoName`) → in-place por acidente, mas: histórico fragmentado por `project_id`, sem SHA, e as preferências `extra.delivery_mode/deploy_connection_id/deploy_format/deploy_ttl_days` **não são herdadas** (o `extra` do filho nasce só com chaves `evolution_*`, `routes/projects.ts:3264-3272`).
- Teardown por expiração (`teardownExpired`, `cloudDeploy.ts:337-376`) age sobre a linha expirada do **projeto**; como os recursos têm nome por repo, um deploy `demo` do pai expirando **derrubaria os recursos do filho** (GAP 11).
- Sem health-check pós-deploy (`deployed` = `conclusion === "success"` do run, `:293-300`), sem rollback (grep vazio). O worker reporta em `project_dialogue` (`recordDialogue`, `:321-329`), nunca em `extra.cloud_*`.
- `extra` é sempre mesclado inline com `COALESCE(extra,'{}'::jsonb) || $n::jsonb`; **não existe helper** `mergeProjectExtra` (12 ocorrências).
- Migrations: última **commitada** `083_governance_audit_gap_actions.sql`; **`084_cloud_slots_partial_unique.sql` existe UNTRACKED** na árvore (outra frente, junto com `stallEscalation.ts`). **Próxima livre: `085`** — coordenar (se a 084 não for commitada antes, renumerar). Regra do runner: **nenhum `;` em literal SQL**, sem `DO $$` (`082:6`).

### 2.3 Deadpool / Auto Care (item 3)
- `registerProjectWithDeadpool(args)` vive em `services/githubPush.ts:145-207` (não em `deadpool*.ts`): `POST ${DEADPOOL_BASE_URL}/projects`, payload `{systemId, serviceId, repoUrl, installationId}` + opcionais (`localPath`, `appUrl`, `healthUrl`, `environment`, `awsRegion`, `logGroup`, `monitoring`, `monitorProvider`, `azure*`, `gcp*`, `awsRoleArn`, `awsExternalId`, `awsCredentialsEnc`, `connectManifests`, `connectVersion`). **Não existe campo `branch`.** `localPath = PROJECT_FILES_ROOT/<projectId>/apps`. Mesma chave do pai garantida por `identityInputsFor` (raiz da linhagem, `services/lineage.ts:43-47`) + `deriveSystemService` (`githubPush.ts:114-136`, slug — não hash). Chamadas: push inicial (`:499-505`), aceite de evolução (`:655-660`), ativar (`routes/deadpool.ts:556-592`), desativar (`:677-744`, é o único "desregistro" e é soft `monitoring=false`).
- Branch implícito no working tree: aceite normal → `gitLinkProjectFolder(branch:"dev")` (`githubPush.ts:475`); evolução → `gitLinkProjectFolder(dev)` + `checkoutNewBranch("evolution/vN")` (`routes/projects.ts:3350-3352`; `githubPush.ts:255-265` = `git checkout -B`). Logo o `local_path` do filho fica em **`evolution/vN`** e assim permanece após o merge.
- Registry do Deadpool: JSON em `<DEADPOOL_STATE_DIR>/registry/projects.json` (`D/storage/project_registry.py:24-27`), chave `inst/sys/svc` (`:55-64`), **MERGE preserva-None** em `register_project` (`:116-230`), campos sem `branch`/`active`/`registered_at`. HTTP só `GET/POST /projects` (`D/app/http_server.py:218-221, 257, 274-276`); **sem DELETE/PATCH**. `local_path` é usado só na remediação (`D/app/service.py:503-507`) e como allowlist do `/diagnose` (`http_server.py:54-60`); o poller não o usa. **Não faz `git fetch/checkout`** no `local_path` (`prepare_base_branch` só em clone próprio, `D/runtime/propose_executor.py:487-488`); cria `deadpool/<incident>` a partir do HEAD que estiver checkado (`D/scm/github_adapter.py:170-187`) e abre PR draft com **`base_branch="main"` default** (`propose_executor.py:252, 442`; `service.py:531-542` não passa base).
- Histórico/lições: `incidents/<id>.json`, `history.jsonl` (`incident_id, service_name, category`), `kb/entries.jsonl` (`dedupe_key = service_name:category`) — **independentes do registry**, sem FK; remover/alterar a entrada do registry não apaga nada (`D/storage/json_store.py:43-91`, `tools/knowledge_base.py:17`).
- Genesis: `project_deadpool_monitoring(project_id PK, active, system_id, service_id, activated_by/at, deactivated_at, last_registered_at, last_error)` (`046:24-36`) alimenta o filtro fail-closed por tenant (`routes/deadpool.ts:166-199`).
- Compose (dev): o serviço `deadpool` **não monta** `zentriz-genesis_uploads:/shared/uploads` (só `/data` e Connect, `docker-compose.yml:305-310`) → `Path(local_path).is_dir()` é falso dentro do container → cai em clone (`DEADPOOL_ALLOW_NETWORK_CLONE=false`) → dry-run. Confirmar em prod antes de depender de `local_path`.

### 2.4 Contrato do Dev e runner (item 4)
- Formato: `ResponseEnvelope` JSON em `<response>` com `artifacts: [{path, content, format?, purpose?}]` **whole-file** (`applications/agents/dev/SYSTEM_PROMPT.md:419-431`; "PATCH cirúrgico… entregue o arquivo completo", `:193-199`). Validação `validate_response_envelope` (`applications/orchestrator/envelope.py:49-105`): `path` obrigatório e sanitizado (`:20-46`), `content` obrigatório quando `require_artifacts` (`:88-89`). Parser tolerante `resilient_json_parse` (`:378-529`) + `MAX_REPAIRS` (`runtime.py:22`). Teto de saída `CLAUDE_MAX_TOKENS` 32k / rework 48k (`runtime.py:953, 967`).
- Gravação: runner `storage.write_apps_artifact` (`runner.py:3861`; `project_storage.py:346-363`, atômico com lock). **O container agents também persiste** por conta própria quando `PROJECT_FILES_ROOT` está setado (`agents/server.py:307-370`) — dois caminhos de escrita.
- O Dev recebe **todo o `apps/`** do disco (arquivos < 50 000 bytes, `runner.py:3727-3737`) como `existing_artifacts`, mas o prompt **trunca cada artefato em 8 000 chars para DEV** (`runtime.py:194-201`; QA 200 000). Ou seja, o Dev reescreve por inteiro arquivos que só viu parcialmente.
- Gate de escopo `_evolution_scope_check(pipeline_ctx, dev_artifacts, apps_root)` (`runner.py:496-535`): descarta `apps/` fora do escopo do RFC e reescritas que removem símbolos exportados (`_exported_symbols`, `:444`); acumula `evolution_touched_files` (`:3814-3828`); 2 rodadas → `blocked_structural_gate` (`:3841-3846`).
- **Runner sem `git`** (`Dockerfile.runner:6-22`); nenhum `git apply`/`patch`/`difflib` em runner, agents ou Deadpool (o `change_generator.py` do Deadpool também é whole-file, `D/runtime/change_generator.py:15, 75, 253-269`).
- Testes: `applications/orchestrator/tests/` (28 arquivos), `import orchestrator.runner as runner` direto; fixtures em `test_runner_evolution_e4.py`, `test_evolution_bloco3.py`.

---

## 3. Desenho

### 3.1 Item 1 — Merge automático do PR `evolution/vN → dev`

**Princípio:** o merge é um **passo adicional e opcional** do aceite; nunca condiciona o push nem a supersessão (que já funcionam). Cada saída é um **estado terminal legível** em `extra.evolution_merge_state`, com ação inversa manual visível no painel.

**Novas primitivas em `services/github.ts`** (mesmo padrão de `openPullRequest`: nunca lançam):
- `getPullRequest(installationId, {owner, repo, number}) → {ok:true, state, merged, mergeable: boolean|null, mergeableState, headSha, baseRef, mergeCommitSha} | {ok:false, status, error}`.
- `mergePullRequest(installationId, {owner, repo, number, method, sha, commitTitle, commitMessage}) → {ok:true, sha, merged:true} | {ok:false, status: 403|405|409|422|number, error, acceptedPermissions?: string}` — lê `X-Accepted-GitHub-Permissions` do erro Octokit (`err.response?.headers`).
- `updatePullRequestBranch(installationId, {owner, repo, number, expectedHeadSha})`.
- `getOctokitForInstallation(installationId, {requireApp?: boolean})` — novo parâmetro: `requireApp=true` **recusa o fallback PAT** (merge com PAT global cruzaria tenants; GAP 4).
- Injeção para testes: `export function __setOctokitFactoryForTests(f)` (padrão já usado em outros serviços com `vi.mock`; alternativa: `vi.mock("@octokit/rest")`).

**`EvolutionPushResult` ganha `prNumber?: number` e `headSha?: string`** (`githubPush.ts:553-563`; `openPullRequest` já devolve `number`; `pushProjectFiles` já devolve `sha` — só falta propagar, `:638-642`, `:670`). `runEvolutionAcceptFlow` grava `evolution_pr_number` e `evolution_head_sha` junto com `evolution_pr_url` (`evolutionAccept.ts:259-268`).

**Novo serviço `services/evolutionMerge.ts`:**
```ts
export type MergeState = "merged" | "skipped_flag" | "skipped_no_pr" | "blocked_permission" | "blocked_conflict"
  | "blocked_protection" | "blocked_checks" | "blocked_major" | "blocked_compat_implicit" | "blocked_regressions"
  | "blocked_no_tests" | "blocked_no_evidence" | "blocked_head_moved" | "blocked_base_mismatch" | "failed";
export async function tryAutoMergeEvolution(db, childId, opts?: { force?: boolean; actorUserId?: string }): Promise<{ state: MergeState; sha?: string; detail?: string }>
```
Pré-condições **determinísticas, nesta ordem** (a primeira que falha define o estado; todas são baratas antes de tocar a rede):
1. `EVOLUTION_AUTO_MERGE === "on"` (senão `skipped_flag`; `force` da rota manual ignora esta e só esta).
2. `extra.evolution_pr_number` presente e `evolution_push_pending !== true` (senão `skipped_no_pr`).
3. Claim idempotente: `UPDATE projects SET extra = extra || '{"evolution_merge_state":"merging"}' WHERE id=$1 AND coalesce(extra->>'evolution_merge_state','') NOT IN ('merging','merged') RETURNING id` (GAP 3).
4. Compat: `evolution_compat === "major"` → `blocked_major`; compat **não explícito** (novo `extra.evolution_compat_explicit !== true`, ver abaixo) → `blocked_compat_implicit`; rank(compat) > rank(`EVOLUTION_AUTO_MERGE_MAX_COMPAT`, default `minor`) → `blocked_major`.
5. PASS_TO_PASS: ler o checkpoint (mesma leitura de `routes/evolutionPlan.ts:82-100`, extraída para `services/evolutionState.ts:readEvolutionCheckpoint(projectId)`); sem checkpoint → `blocked_no_evidence` (fail-closed); `baseline.status === "no_tests"` → `blocked_no_tests` salvo `EVOLUTION_AUTO_MERGE_ALLOW_NO_TESTS=on`; `baseline.final` ausente, `status==="error"` ou `regressions.length>0` → `blocked_regressions`.
6. GitHub: `getPullRequest` → `merged` já → estado `merged` (registrar; hooks); `baseRef !== "dev"` → `blocked_base_mismatch`; `headSha !== extra.evolution_head_sha` → `blocked_head_moved`; `mergeable === null` → repetir até 5× com backoff 2/4/8/16/30 s; `mergeableState`: `clean` (ou `has_hooks` se `EVOLUTION_AUTO_MERGE_ALLOW_HAS_HOOKS=on`) → segue; `behind` → `updatePullRequestBranch` 1× e reconsultar; `dirty` → `blocked_conflict`; `blocked` → `blocked_protection`; `unstable`/`draft`/`unknown` → `blocked_checks`.
7. `mergePullRequest(method = EVOLUTION_AUTO_MERGE_METHOD ?? "squash", sha = headSha, commitTitle = "Evolução v{N} — {título} ({x.y.z})", commitMessage = corpo do PR até 4 000 chars)`. 405 com mensagem de método → tentar `merge` uma vez; 405 restante → `blocked_protection`; 403 → `blocked_permission` (guardar `acceptedPermissions`); 409 → `blocked_head_moved`; outro → `failed`.
8. Sucesso: `extra.evolution_merged_at`, `evolution_merge_sha` (o `sha` da resposta), `evolution_merge_method`, `evolution_merge_state="merged"`, `evolution_merge_actor` (`"genesis"` | userId). Atualizar `project_github_repos.sha_dev` da raiz e do filho. Log em `project_dialogue`. Em seguida **`runPostMergeHooks(db, childId)`** (itens 2 e 3; cada hook com flag própria e estado próprio).

**Onde encaixa:** `runEvolutionAcceptFlow` após `supersedeParent` (`evolutionAccept.ts:289-297`) → `await tryAutoMergeEvolution(db, childId)` dentro de try/catch (nunca derruba o aceite). Também na `republish` (mesmo caminho).

**Compat explícito:** `evaluateEvolutionGate` passa a gravar `evolution_compat_explicit: rfcs.some(r => r.compat !== null)` (`evolutionGate.ts:197-202`) e o planner grava `evolution_compat_explicit: true` só quando o LLM devolveu o campo (`evolutionPlanner.ts:437-448`). O painel mostra "compat: minor (implícito)" e o template de RFC (`GET /api/spec-templates/rfc`) já tem a seção "Compatibilidade" — reforçar o texto: "obrigatório para merge automático".

**Rota manual** `POST /api/projects/:id/evolution/merge` (`routes/evolutionPlan.ts`, ao lado do `republish`): tenant_admin ou dono; `svc==="runner"` e `zentriz_admin` → 403; exige `status='accepted'` + `evolution_pr_number`; body `{confirm: "MERGE"}` obrigatório quando `compat==="major"` ou `blocked_regressions`/`blocked_no_tests`; chama `tryAutoMergeEvolution(db, id, {force:true, actorUserId})`; devolve o estado. Não contorna `blocked_permission`, `blocked_conflict`, `blocked_protection` (não há como).

**Observador de merge** `services/evolutionMergeWorker.ts` (flag `EVOLUTION_MERGE_WATCH=off`, intervalo `EVOLUTION_MERGE_WATCH_MS` default 300 000): a cada tick, `SELECT id FROM projects WHERE status='accepted' AND extra->>'evolution'='true' AND extra->>'evolution_pr_number' IS NOT NULL AND extra->>'evolution_merged_at' IS NULL ORDER BY updated_at LIMIT 20`; para cada, `getPullRequest` com o installation do **próprio tenant** (fail-closed se `revoked_at IS NOT NULL`); `merged===true` → registrar como acima com `evolution_merge_actor="external"` e rodar os hooks. Cobre o caminho "humano mergeou no GitHub" (major, ou App sem permissão). Mesmo padrão dos workers existentes (`setInterval` após `app.listen`, guarda `running`, `index.ts:84-105`).

**Portal (`components/EvolutionPanel.tsx`):** bloco "Merge" abaixo de `publish` (`:182-189`): estado com cor (merged verde; `blocked_*` âmbar com a razão em PT-BR e a ação: "Conceder permissão Pull requests à GitHub App" / "Resolver conflito no GitHub" / "Confirmar merge de major"), SHA encurtado com link `https://github.com/{repo}/commit/{sha}`, botão "Mergear agora" (chama a rota manual; type-to-confirm quando exigido). `GET /evolution-state` passa a devolver `merge: {state, sha, at, method, actor, detail, prNumber}`.

**D-M1 (recomendação): squash.** Justificativa em §1.1. Fallback `merge` só por 405 de método. `rebase` descartado (reescreve SHAs; perde assinatura). **Não apagar `evolution/vN`** após o merge na v1 (`EVOLUTION_AUTO_MERGE_DELETE_BRANCH=off`): o `local_path` do filho ainda está nele até o realinhamento (item 3) e o branch serve de auditoria/rollback do PR.

### 3.2 Item 2 — Redeploy cloud com a mesma identidade

**Modelo:** a identidade cloud de uma linhagem **já é única por construção** (recursos nomeados pelo `repoName`, que é da raiz). O que falta é (a) herdar preferências, (b) deployar o código certo, (c) encadear e rastrear por SHA, (d) não deixar o pai derrubar o filho, (e) rollback.

**Migration `085_cloud_deployments_lineage_sha.sql`** (sem `;` em literal; só `ALTER/CREATE INDEX`):
```sql
ALTER TABLE cloud_deployments ADD COLUMN IF NOT EXISTS git_sha TEXT;
ALTER TABLE cloud_deployments ADD COLUMN IF NOT EXISTS lineage_root_id UUID REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE cloud_deployments ADD COLUMN IF NOT EXISTS supersedes_deployment_id UUID REFERENCES cloud_deployments(id) ON DELETE SET NULL;
ALTER TABLE cloud_deployments ADD COLUMN IF NOT EXISTS superseded_by_deployment_id UUID REFERENCES cloud_deployments(id) ON DELETE SET NULL;
ALTER TABLE cloud_deployments ADD COLUMN IF NOT EXISTS trigger_kind TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE cloud_deployments DROP CONSTRAINT IF EXISTS cloud_deployments_trigger_kind_check;
ALTER TABLE cloud_deployments ADD CONSTRAINT cloud_deployments_trigger_kind_check CHECK (trigger_kind IN ('manual','evolution_merge','rollback'));
CREATE INDEX IF NOT EXISTS idx_cloud_deployments_lineage ON cloud_deployments (lineage_root_id, created_at DESC);
```
Backfill de `lineage_root_id` para linhas existentes: `UPDATE cloud_deployments d SET lineage_root_id = d.project_id WHERE lineage_root_id IS NULL` (raiz = o próprio projeto para deploys pré-evolução; filhos antigos não existem em prod). Guard `migrations.test.ts` já checa `;` em literais.

**(a) Herança de preferências no `/evolve`** (`routes/projects.ts:3264-3272`): copiar do `parentRow.extra` as chaves `delivery_mode, deploy_connection_id, deploy_format, deploy_ttl_days, project_type, runtime_target, api_url` quando presentes. Fallback no hook: se o filho não tem `deploy_connection_id`, usar `connection_id/deploy_format` da última linha `deployed` da linhagem.

**(b) Branch de deploy por estado** (`cloudDeploy.ts:56-76` `loadRepoCtx`): adicionar `p.extra` ao SELECT e decidir `deployBranch = extra.evolution === true && !extra.evolution_merged_at ? (extra.evolution_branch ?? "dev") : "dev"`. Assim um deploy manual do filho **antes** do merge publica a evolução (pré-visualização in-place — a UI avisa "vai substituir a versão corrente na nuvem pela vN ainda não mergeada"); **depois** do merge publica `dev`. `startCloudDeploy` grava `branch`, `lineage_root_id` (`resolveLineageRoot`) e `git_sha` (resolvido em `runDeployAttempt` via `octokit.repos.getBranch`/`git.getRef` do `deployBranch` no momento do dispatch, ou `evolution_merge_sha` quando `trigger_kind='evolution_merge'`).

**(c) Checkout por SHA nos templates** (`deployTargets.ts`): adicionar `inputs.genesis_git_sha` (string, opcional) ao bloco `workflow_dispatch` (`:153-159`) e `with: ref: ${{ github.event.inputs.genesis_git_sha || github.ref }}` nos 6 `actions/checkout@v4` (`:228,255,287,321,347,366`); `dispatchWorkflow(..., inputs: {genesis_deploy_id, genesis_git_sha})` (`cloudDeploy.ts:192-195`). O workflow é recommitado a cada deploy (`:177-186`), então repos antigos se atualizam sozinhos.

**(d) Encadeamento e proteção contra teardown** (hook `redeployAfterMerge`, flag `EVOLUTION_AUTO_REDEPLOY=off`): localizar `prev = última cloud_deployments da linhagem com status='deployed'` (`lineage_root_id` ou, no backfill, `project_id IN (pai, raiz)`); se não existe → `evolution_redeploy_state="skipped_no_prev"` (nunca criar o primeiro deploy sozinho); conexão `status<>'active'` → `blocked_connection`; `delivery_mode==='demo'` no pai com `expires_at` → **herdar `expires_at` e `consented_teardown`** (é o contrato aceito pelo tenant) e marcar `prev.superseded_by_deployment_id = novo`; `teardownExpired` (`cloudDeploy.ts:337-376`) passa a **ignorar linhas com `superseded_by_deployment_id IS NOT NULL`** (os recursos agora pertencem ao novo) e, ao expirar o novo, derruba normalmente. Criar a linha `trigger_kind='evolution_merge'`, `git_sha=evolution_merge_sha`, `supersedes_deployment_id=prev.id` e reusar `startCloudDeploy` (refatorar para aceitar `{branch, gitSha, triggerKind, supersedesId}`). Gravar `extra.evolution_redeploy_id` no filho.

**(e) Rollback manual** `POST /api/projects/:id/deploy/cloud/rollback {deploymentId}` (tenant do projeto; não `zentriz_admin`): cria linha `trigger_kind='rollback'` com `git_sha` da linha alvo (exige `git_sha` não nulo → linhas antigas sem SHA não são elegíveis; UI explica) e mesma conexão/formato. Sem rollback automático na v1 (não há health-check no BYOC; adicionar probe de `extra.api_url`/`app_url` é v2 — `EVOLUTION_REDEPLOY_HEALTH_PROBE`).

**D-B2 (recomendação): in-place + rollback por SHA; blue/green adiado.** Razões: recursos nomeados por repo em 12 templates; Genesis não gerencia DNS/CloudFront do tenant; blue/green dobra custo na conta do tenant; ECS já faz rolling; o rollback por SHA cobre o caso "quebrou → volta em minutos". Blue/green por formato (Lambda alias `live`, S3 bucket `-<sha>` + CloudFront origin swap) fica registrado como v2 com pré-requisito de DNS/distribuição gerenciados.

**Deadpool:** nada muda na chave (§2.3); o hook de redeploy reenvia `appUrl/healthUrl/environment` se conhecidos (mesmo `registerProjectWithDeadpool`).

### 3.3 Item 3 — Auto Care pós-merge (Deadpool segue `dev`, pai sai sem perder histórico)

**Hook `realignAfterMerge`** (flag `EVOLUTION_POST_MERGE_REALIGN=off`), roda na API (tem `git`), sobre `PROJECT_FILES_ROOT/<child>/apps`:
1. Pré-checagens: `apps/.git` existe (`hasGitDir`); `git status --porcelain` **vazio** e HEAD == `evolution/vN` ou `dev` (se HEAD é `deadpool/*` ou há alterações → `evolution_realign_state="deferred_dirty"` + aviso; o worker re-tenta no próximo tick enquanto `deferred_*`, máx. 48 h) — GAPs 8/9.
2. Token escopado `getInstallationTokenForClone(installationId, {repositoryNames:[repo], permissions:{contents:"read"}, requireScoped:true})`; `git fetch origin dev` + `git checkout -B dev origin/dev` (extrair de `gitLinkProjectFolder`, `githubPush.ts:267-326`, um `fetchAndResetBranch(localPath, branch, token)` reutilizável; URL com token só em memória, nunca em `remote set-url` persistido).
3. Verificar `git rev-parse HEAD === evolution_merge_sha` (squash → o SHA do merge é o novo topo de `dev`; se outros merges entraram, HEAD será descendente — aceitar e registrar `evolution_realign_head`).
4. `evolution_realign_state="done"`, `evolution_realign_at`.

**Hook `handoffMonitoring`** (mesma flag), Genesis side, transacional:
- `INSERT INTO project_deadpool_monitoring (project_id, active, system_id, service_id, activated_by, activated_at, last_registered_at) SELECT $child, active, system_id, service_id, activated_by, activated_at, now() FROM project_deadpool_monitoring WHERE project_id=$parent ON CONFLICT (project_id) DO UPDATE SET active=EXCLUDED.active, system_id=EXCLUDED.system_id, service_id=EXCLUDED.service_id, last_registered_at=now()`; depois `UPDATE project_deadpool_monitoring SET active=false, deactivated_at=now(), last_error='superseded_by:'||$child WHERE project_id=$parent`. **Migration 086** adiciona `migrated_to_project_id UUID` / `migrated_from_project_id UUID` (rastreabilidade; `046` não tem).
- Reenvio ao Deadpool: `registerProjectWithDeadpool({systemId, serviceId, repoUrl, installationId, localPath: <child>/apps, branch: "dev", monitoring: <herdado>})` — **novo campo `branch`** no `DeadpoolRegisterArgs` (`githubPush.ts:60-97`) e no payload (`:152-182`). Como a chave é a mesma do pai, o Deadpool faz MERGE na mesma entrada: `local_path` passa a ser o do filho e `branch="dev"`. Histórico intocado (§2.3).
- `DeadpoolMonitorCard` no pai arquivado: "Monitoramento migrado para v{N}" com link; no filho: estado herdado.

**PR separado no `zentriz-deadpool-auto-care`** (flag `DEADPOOL_REGISTRY_BRANCH_ENFORCE=off`):
- `ProjectRegistry.register_project` aceita `branch` (snake/camel em `app/api.py:118-152`) e o persiste (MERGE preserva-None, `project_registry.py:168-227`); `list_monitored_projects` expõe `branch` (`service.py:355-383`).
- `_execute_propose` (`service.py:457-543`): ao adotar `local_path` como `repo_dir`, se a entrada tem `branch` e a flag está `on`: `git rev-parse --abbrev-ref HEAD`; se diferente e a árvore está limpa → `git checkout <branch>`; se suja → não tocar e registrar `misconfigured_branch` no incidente (fail-safe). Passar `base_branch=entry.branch` para `execute_propose_plan` (`service.py:531-542`) para o PR draft nascer contra `dev` e não `main` (hoje `main` por default — fato §2.3).
- Sem flag → comportamento atual (zero regressão).

### 3.4 Item 4 — Dev em modo diff: avaliação honesta e desenho incremental

**Viabilidade com o contrato atual:** baixa para `unified diff` puro. (i) O envelope é JSON e o diff iria dentro de uma string — exatamente o formato que a OpenAI mediu como "particularly poorly" (§1.3); (ii) o runner não tem `git` e `git apply` estrito falha com diffs de LLM (Aider: 9× mais erros sem casamento flexível); (iii) há **dois** escritores de artefatos (runner e `agents/server.py`), ambos assumindo `content` completo; (iv) o gate `_exported_symbols` e o QA leem conteúdo completo — precisariam do arquivo materializado; (v) o Dev **vê só 8 000 chars por arquivo** — editar parcialmente um arquivo que não viu inteiro é pior do que reescrever.

**Custo/benefício honesto:** o benefício real é (a) menos tokens de saída e latência em arquivos grandes, (b) menos "lazy coding"/perda de trechos ao reescrever arquivos vistos parcialmente, (c) menor risco de o gate de símbolos descartar reescritas. O custo é um novo formato + aplicador + validação + prompt + testes, e um novo modo de falha ("edit não casou"). **Sem medir, não dá para afirmar o ganho.**

**Recomendação: adiar `udiff`; fazer `edits` (search/replace) em duas fases, a segunda condicionada à primeira.**

- **Fase 0 — Medir** (`EVOLUTION_DEV_EDIT_METRICS=off`; runner): ao gravar artefatos em evolução, comparar com o arquivo já em disco e registrar no checkpoint `evolution_dev_rewrite_stats = {files, bytes_out, bytes_unchanged, ratio_unchanged, files_over_8k_seen_truncated}` (difflib `SequenceMatcher.ratio()` por arquivo, custo O(n) aceitável para < 50 KB). Painel mostra "X% do que o Dev devolveu era idêntico ao existente". **Critério para a Fase 1: ratio_unchanged ≥ 60% em ≥ 3 evoluções reais** (senão, o formato não compensa e o item é fechado como "refutado com evidência").
- **Fase 1 — `edits` opcional com fallback** (`EVOLUTION_DEV_EDIT_FORMAT=whole|edits`, default `whole`; só em evolução):
  - Contrato (aditivo): `artifacts[i] = {path, format:"edits", edits:[{search:string, replace:string}], content?: null}`. `content` completo continua válido e é **obrigatório** para arquivo novo, arquivo > 50 KB (que o Dev não recebeu) ou após 2 falhas de aplicação na mesma task.
  - `envelope.py:validate_response_envelope` (`:88-89`): `content` **ou** `edits` não vazio; cada edit com `search` não vazio; `sanitize_artifact_path` inalterado. `_required_path_prefixes_for_mode` inalterado.
  - Aplicador puro Python `orchestrator/edits.py:apply_edits(original: str, edits) -> tuple[str|None, list[str]]`: regra `str_replace` — casamento **exato e único**; 0 ou >1 ocorrências → erro com o motivo e um trecho do arquivo real (para o repair); segundo passo tolerante só para **espaço em branco à direita/CRLF** (nunca reordena/reindenta — a lição do Aider vale para `udiff`, não para search/replace com semântica exata); aplicação **atômica** (todos ou nenhum); preserva EOL do arquivo.
  - Runner (`runner.py:3800-3871`): antes do gate de escopo, **materializar** `edits` lendo o arquivo do disco (`PROJECT_FILES_ROOT/<id>/apps/<path>`) → artefato `{path, content}`; falha → mensagem de repair estruturada (`build_repair_feedback_block`, `runtime.py:239`) e `QA_FAIL` da rodada como hoje; assim `_evolution_scope_check`, `_exported_symbols`, QA e `write_apps_artifact` continuam vendo **conteúdo completo** — zero mudança neles.
  - `agents/server.py:_persist_artifacts_for_role` (`:307-370`): **ignorar** artefatos `format=="edits"` (só o runner materializa) — evita escrever `edits` como arquivo.
  - Prompt do Dev (`SYSTEM_PROMPT.md:193-199, 419-431`): seção condicional (injetada só quando a flag está `on`, via `runtime.py:230-235`) com o formato, a regra de unicidade, "inclua 3+ linhas de contexto no `search`", e quando usar `content` completo.
  - Elevar o cap de `existing_artifacts` para DEV **apenas** para arquivos dentro de `evolution_scope` (`runtime.py:194-201`): completo até 50 KB, com orçamento total `EVOLUTION_DEV_SCOPE_FULL_CHARS` (default 120 000) — sem isso o formato não faz sentido.
- **Fase 2 (não planejada agora):** bloco `<edits>` fora do JSON e/ou `udiff` com aplicador tolerante próprio; só se a Fase 1 mostrar taxa de aplicação ≥ 95%.

---

## 4. Adversarial do próprio desenho — GAPs e fechamento

| # | GAP / risco | Sev. | Fechamento no desenho |
|---|---|---|---|
| 1 | **Permissão da App**: `pull_requests: write` não existe hoje; mudança de permissão só vale após aprovação do dono de cada instalação; tenants com App própria precisam aprovar a deles | P1 | `blocked_permission` com `X-Accepted-GitHub-Permissions` logado; painel mostra a ação exata; PR fica aberto (nada se perde); observador detecta merge manual. **AÇÃO DO JEAN** §5.5 |
| 2 | **Race push→merge**: humano/Deadpool empurra em `evolution/vN` entre o push e o merge → mergearíamos código não avaliado | P1 | `sha` obrigatório no merge (409 → `blocked_head_moved`) + comparação prévia `headSha === evolution_head_sha` |
| 3 | **Duplo merge / concorrência** (accept + republish + worker ao mesmo tempo) | P1 | claim atômico `evolution_merge_state='merging'` via `UPDATE … WHERE NOT IN ('merging','merged') RETURNING`; `getPullRequest.merged` antes de mergear; 405 em PR já mergeado tratado como `merged` após reconsulta |
| 4 | **Cross-tenant via PAT**: `getOctokitForInstallation` cai em `GITHUB_TOKEN` global → merge num repo de tenant com credencial da Zentriz; worker itera projetos de todos os tenants | P1 | `requireApp:true` no merge/watch (recusa PAT); installation sempre do tenant do projeto com `revoked_at IS NULL` (fail-closed); nunca `zentriz_admin` na rota manual |
| 5 | **Mergeability**: `mergeable=null`, `behind`, `unstable`, proteção de branch com reviews | P2 | backoff ≤5×; `behind` → `update-branch` 1×; `dirty/blocked/unstable/draft` → estados `blocked_*`; nunca insistir |
| 6 | **PASS_TO_PASS sem evidência**: checkpoint ausente/prunado, volume não mapeado em prod, `final` ausente (TSK-FULL-TEST pulado) | P1 | fail-closed `blocked_no_evidence`; pré-requisito de PÓS: confirmar mapeamento `.runner-state` no compose de prod (bloco 3 GAP C) |
| 7 | **Compat default silencioso**: `evolution_compat=null → "minor"` (fato §2.1) → breaking change mergeada como minor | P1 | `evolution_compat_explicit` gravado por gate/planner; auto-merge exige explícito (`blocked_compat_implicit`); RFC template reforçado |
| 8 | **Squash × working tree**: após squash, `evolution/vN` local não é ancestral de `dev` → `checkout dev` não faz fast-forward | P2 | realinhamento usa `fetch` + `checkout -B dev origin/dev` (reset controlado), só com árvore limpa |
| 9 | **Deadpool sujou o `local_path`** (branch `deadpool/<id>` checkado, alterações não commitadas) → realinhar destruiria trabalho | P1 | pré-checagem `status --porcelain` vazio + HEAD ∈ {`evolution/vN`,`dev`}; senão `deferred_dirty` e re-tentativa; nunca `reset --hard` sobre árvore suja |
| 10 | **`dev` ≠ merge**: entre o merge e o deploy, outros merges (outra evolução, Deadpool `allow_autonomous_dev_promotion`) mudam `dev` | P2 | `git_sha` gravado e passado como `inputs.genesis_git_sha` ao checkout; deploy é do SHA, não do branch; rollback determinístico |
| 11 | **Teardown do pai derruba o filho**: deploy `demo` do pai expira → `teardownExpired` apaga recursos nomeados por repo, agora do filho | P1 | `superseded_by_deployment_id` no pai + `teardownExpired` ignora supersedidos; filho herda `expires_at/consented_teardown` do contrato demo |
| 12 | **Prefs de deploy não herdadas** → hook sem conexão/formato | P2 | cópia no `/evolve` + fallback na última linha `deployed` da linhagem; sem nada → `skipped_no_prev` (nunca inventar) |
| 13 | **Conexão revogada / slot reciclado** (`tenant_cloud_connections.status='revoked'`) | P2 | `blocked_connection`; jamais criar slot/conexão automaticamente; UI pede reconexão |
| 14 | **Hooks não idempotentes** (observador detecta `merged` a cada tick) | P2 | `evolution_merged_at` gravado uma vez via claim; cada hook com chave de estado própria (`evolution_realign_state`, `evolution_redeploy_id`, `evolution_monitoring_handoff_at`) e `WHERE … IS NULL` |
| 15 | **`edits` mal aplicado em silêncio** (match no lugar errado) / arquivo não visto inteiro | P1 | match exato e único (0 ou >1 → erro); `content` obrigatório para arquivos > 50 KB ou novos; cap de contexto elevado só no escopo; Fase 0 mede antes |
| 16 | **Dupla escrita** (`agents/server.py` persiste artefatos por conta própria) gravaria `edits` como arquivo | P1 | guard por `format=="edits"` no agents (ignora); runner é o único que materializa |
| 17 | **Injeção via título**: `commit_title` vem do título do projeto (controlado pelo usuário) | P3 | `slice(0,250)`, remover controles/quebras; corpo ≤ 4 000 chars |
| 18 | **Rate limit / abuso da API GitHub** (poll de `mergeable`, observador) | P3 | ≤5 consultas por merge; observador 5 min, `LIMIT 20`, `updated_at` para rodízio; erros 403 `secondary rate limit` → `failed` transitório (re-tenta no próximo tick) |
| 19 | **Flags OFF = estado "meio pronto"**: merge feito à mão no GitHub sem observador ligado → Deadpool fica em `evolution/vN`, deploy manual do filho publica `dev` (correto) mas `evolution_merged_at` nunca é gravado | P2 | documentado: sem `EVOLUTION_MERGE_WATCH=on` nada pós-merge acontece (estado igual ao de hoje); botão "Verificar merge" na rota manual (`GET`-like: só consulta e registra) para uso sem worker |

Decisões abertas para o Jean: **D-M1** squash (recomendado) × merge commit · **D-M2** ligar o observador em prod (recomendado após 1 evolução real) · **D-B2** in-place+SHA (recomendado) × blue/green · **D-A1** montar `zentriz-genesis_uploads` no container `deadpool` de prod para o `local_path` valer (hoje não vale, §2.3) · **D-E1** Fase 1 do `edits` só após a Fase 0 provar ≥ 60% de bytes idênticos.

---

## 5. Plano de implementação (ordem = menor risco / maior valor)

### 5.1 Ordem e escopo por PR (todos em `dev`, sem deploy)

| # | PR | Repo | Arquivos (linhas de partida) | Depende de |
|---|---|---|---|---|
| M0 | Primitivas GitHub + `prNumber/headSha` + compat explícito | genesis | `services/github.ts` (novas fns após `:700`; `getOctokitForInstallation` `:174-204` + `requireApp`; `__setOctokitFactoryForTests`) · `services/githubPush.ts:553-563, 638-642, 670` · `services/evolutionAccept.ts:259-268` · `services/evolutionGate.ts:197-202` · `services/evolutionPlanner.ts:437-448` · `services/evolutionState.ts` (novo: `readEvolutionCheckpoint`, extraído de `routes/evolutionPlan.ts:82-100`) | — |
| M1 | `evolutionMerge.ts` + integração no aceite + rota manual + `evolution-state.merge` + painel | genesis | `services/evolutionMerge.ts` (novo) · `services/evolutionAccept.ts:289-297` (chamada após supersessão) · `routes/evolutionPlan.ts` (rota `POST …/evolution/merge` ao lado de `:171`; `GET evolution-state` `:119-125` + `merge`) · `components/EvolutionPanel.tsx:32, 182-189` | M0 |
| M2 | Observador de merge | genesis | `services/evolutionMergeWorker.ts` (novo, molde `cloudDeployWorker.ts`) · `index.ts:84-105` (start/stop) | M1 |
| M3 | Migration 086 + handoff de monitoramento + realinhamento + `branch` no payload | genesis | `db/migrations/086_deadpool_monitoring_handoff.sql` (novo) · `services/postMerge/handoffMonitoring.ts`, `services/postMerge/realignWorkingTree.ts` (novos) · `services/githubPush.ts:60-97, 152-182` (campo `branch`), `:267-326` (extrair `fetchAndResetBranch`) · `components/DeadpoolMonitorCard.tsx` · `routes/deadpool.ts:166-199` (escopo já cobre o filho via tabela) | M1 |
| M4 | Registry com `branch` + checkout/base por branch | **deadpool** | `D/app/api.py:118-152` · `D/storage/project_registry.py:168-227` · `D/app/service.py:355-383, 457-543, 531-542` · `D/runtime/propose_executor.py:245-252` (aceitar `base_branch` vindo do registry) · `settings.py` (flag) | independente (contrato aditivo) |
| M5 | Migration 085 + herança de prefs + branch por estado + `git_sha` + checkout por SHA + teardown ciente | genesis | `db/migrations/085_cloud_deployments_lineage_sha.sql` (novo) · `routes/projects.ts:3264-3272` (herdar prefs) · `services/provision/cloudDeploy.ts:56-76` (`loadRepoCtx` + extra), `:88-130` (params novos), `:132-200` (`git_sha` no dispatch), `:337-376` (`teardownExpired` ignora supersedidos) · `services/provision/deployTargets.ts:153-159` (input), `:228,255,287,321,347,366` (`ref`) | M0 |
| M6 | Hook `redeployAfterMerge` + rota de rollback + UI | genesis | `services/postMerge/redeployAfterMerge.ts` (novo) · `routes/projects.ts` (após `:1399`: `POST …/deploy/cloud/rollback`; `GET …/deploy/cloud` `:1409-1414` devolve `git_sha/trigger_kind/supersedes`) · `app/(dashboard)/projects/[id]/page.tsx` (seção Cloud Deploy: badge "vN · sha", botão Rollback com type-to-confirm) | M1, M5 |
| M7 | Dev `edits` — **Fase 0** (métricas) | genesis/orchestrator | `orchestrator/runner.py:3855-3871` (antes de `write_apps_artifact`: comparar com disco; checkpoint `evolution_dev_rewrite_stats`) · `pipeline_context.py:474-481` (persistir) · `routes/evolutionPlan.ts` `evolution-state.rewriteStats` · `EvolutionPanel.tsx` | — |
| M8 | Dev `edits` — **Fase 1** (só se D-E1 aprovada) | genesis/orchestrator + agents | `orchestrator/edits.py` (novo) · `orchestrator/envelope.py:88-89` · `orchestrator/runner.py:3800-3812` (materialização antes do gate) · `agents/server.py:307-370` (ignorar `edits`) · `agents/dev/SYSTEM_PROMPT.md:193-199, 419-431` + `agents/runtime.py:230-235` (seção condicional) · `agents/runtime.py:194-201` (cap por escopo) | M7 + decisão |

### 5.2 Migrations (numeração e regra)
- **085** `cloud_deployments_lineage_sha` (§3.2) — somente `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, `DROP/ADD CONSTRAINT`, `CREATE INDEX`, 1 `UPDATE` de backfill. Zero `;` em literal, zero `DO $$`.
- **086** `deadpool_monitoring_handoff`: `ALTER TABLE project_deadpool_monitoring ADD COLUMN IF NOT EXISTS migrated_to_project_id UUID REFERENCES projects(id) ON DELETE SET NULL` e `migrated_from_project_id` idem; `CREATE INDEX IF NOT EXISTS idx_pdm_migrated_to ON project_deadpool_monitoring (migrated_to_project_id)`.
- ⚠️ `084_cloud_slots_partial_unique.sql` está **untracked** (outra frente). Se ela não entrar antes, este bloco vira 084/085. Nunca dois arquivos com o mesmo prefixo.

### 5.3 Testes

**vitest (api-node)**
- `services/github.merge.test.ts` (novo; `vi.mock("@octokit/rest")` ou factory injetada): `getPullRequest` mapeia `mergeable/mergeable_state/merged/head.sha/base.ref`; `mergePullRequest` 200 → `{ok, sha}`; 403 com header `x-accepted-github-permissions` → `acceptedPermissions`; 405/409/422 → `{ok:false, status}`; `requireApp` recusa PAT (lança/retorna erro sem chamar rede).
- `services/evolutionMerge.test.ts` (novo; DB por regex de SQL como `evolutionAccept.test.ts`; checkpoint em `tmpdir` via `PROJECT_FILES_ROOT`): matriz de estados — flag off → `skipped_flag`; sem `pr_number` → `skipped_no_pr`; claim já `merging` → não chama GitHub; `major` → `blocked_major`; compat implícito → `blocked_compat_implicit`; sem checkpoint → `blocked_no_evidence`; `no_tests` → `blocked_no_tests` (e `on` com allow); `final.regressions` → `blocked_regressions`; `merged` prévio → registra sem mergear; `baseRef!=="dev"` → `blocked_base_mismatch`; `headSha` diferente → `blocked_head_moved`; `mergeable=null`×2 depois `clean` → merge (verifica backoff via fake timers); `behind` → `update-branch` 1× então merge; `dirty` → `blocked_conflict`; 405 método → retry `merge`; 405 outro → `blocked_protection`; 403 → `blocked_permission`; sucesso grava `evolution_merged_at/evolution_merge_sha/method/state` e chama hooks (mock).
- `services/evolutionAccept.test.ts` (existente): novo caso — push ok + supersessão → `tryAutoMergeEvolution` chamado 1×; erro no merge não altera o retorno `true`.
- `routes/evolutionPlan.test.ts` (existente): `POST /evolution/merge` — 403 runner/zentriz_admin, 403 não-dono, 409 sem PR, 400 `confirm` ausente em major, 200 com estado; `GET evolution-state` devolve `merge`.
- `services/evolutionMergeWorker.test.ts` (novo): seleciona só `accepted` + `evolution` + `pr_number` + sem `merged_at`; installation revogada → pula; `merged` → registra `actor="external"` + hooks; tick sobreposto ignorado.
- `services/postMerge/realignWorkingTree.test.ts` (novo; repo bare real em `tmpdir` como `gitLinkProjectFolder.test.ts`): árvore suja → `deferred_dirty` e nada muda; HEAD `deadpool/x` → deferred; limpo em `evolution/v2` → HEAD passa a `origin/dev`; token não persiste em `.git/config`.
- `services/postMerge/handoffMonitoring.test.ts` (novo; SQL por regex): copia linha do pai, desativa pai com `last_error`, idempotente (2ª chamada no-op), `registerProjectWithDeadpool` recebe `branch:"dev"` e `localPath` do filho.
- `services/provision/cloudDeploy.test.ts` (novo ou existente): `loadRepoCtx` → `evolution/vN` antes do merge e `dev` depois; `startCloudDeploy` grava `lineage_root_id/git_sha/trigger_kind/supersedes`; `teardownExpired` ignora `superseded_by_deployment_id`; `deployTargets` gera `inputs.genesis_git_sha` e `ref:` em todos os 12 templates (snapshot).
- `services/postMerge/redeployAfterMerge.test.ts` (novo): sem deploy prévio → `skipped_no_prev`; conexão revogada → `blocked_connection`; demo → herda `expires_at/consented_teardown`; marca `superseded_by`.
- `routes/projects.test.ts` (existente): `/evolve` copia prefs de deploy do pai; `/deploy/cloud/rollback` exige `git_sha` e tenant do projeto.
- `db/migrations.test.ts` (existente): 085/086 sem `;` em literal.

**pytest (orchestrator)**
- `tests/test_dev_rewrite_metrics.py` (M7): stats corretos (idêntico → ratio 1.0; novo → contado em `files`), flag off → nada no checkpoint.
- `tests/test_edits_apply.py` (M8): match único aplica; 0 matches → erro com trecho; 2 matches → erro; atomicidade (2º edit falha → original intacto); CRLF preservado; espaço à direita tolerado; `replace` vazio = remoção.
- `tests/test_runner_evolution_edits.py` (M8): envelope com `edits` passa `validate_response_envelope`; runner materializa antes de `_evolution_scope_check` (gate vê `content`); `edits` em arquivo inexistente → repair; `_exported_symbols` avaliado sobre o resultado.
- `tests/test_agents_persist_ignores_edits.py` (M8): `_persist_artifacts_for_role` não grava `format=="edits"`.

**pytest (deadpool, M4)**
- `tests/test_registry_branch.py`: `register_project` aceita `branch`/`default_branch`, MERGE preserva-None, `list_monitored_projects` expõe; `_execute_propose` com flag on: HEAD diferente + limpo → checkout; sujo → `misconfigured_branch`; `base_branch` do PR = `branch` do registry; flag off → comportamento idêntico ao atual.

### 5.4 Flags de ambiente (todas OFF por default; padrão opt-in `(?? "off") === "on"` / `os.environ.get(X, "off") == "on"`)

| Flag | Default | Onde | Efeito |
|---|---|---|---|
| `EVOLUTION_AUTO_MERGE` | `off` | api | tenta o merge automático no aceite/republish |
| `EVOLUTION_AUTO_MERGE_METHOD` | `squash` | api | `squash\|merge` (fallback `merge` em 405 de método) |
| `EVOLUTION_AUTO_MERGE_MAX_COMPAT` | `minor` | api | `patch\|minor`; `major` nunca automático |
| `EVOLUTION_AUTO_MERGE_ALLOW_NO_TESTS` | `off` | api | mergear com baseline `no_tests` |
| `EVOLUTION_AUTO_MERGE_ALLOW_HAS_HOOKS` | `off` | api | aceitar `mergeable_state=has_hooks` |
| `EVOLUTION_AUTO_MERGE_DELETE_BRANCH` | `off` | api | apagar `evolution/vN` após merge (v1: nunca) |
| `EVOLUTION_MERGE_WATCH` / `EVOLUTION_MERGE_WATCH_MS` | `off` / `300000` | api | observador de merge (manual/externo) |
| `EVOLUTION_POST_MERGE_REALIGN` | `off` | api | realinhar `local_path` para `dev` + handoff de monitoramento + reenvio ao Deadpool com `branch` |
| `EVOLUTION_AUTO_REDEPLOY` | `off` | api | redeploy in-place pós-merge (só se havia deploy anterior) |
| `EVOLUTION_DEV_EDIT_METRICS` | `off` | runner | Fase 0 (métricas de reescrita) |
| `EVOLUTION_DEV_EDIT_FORMAT` | `whole` | runner+agents | `edits` habilita a Fase 1 |
| `EVOLUTION_DEV_SCOPE_FULL_CHARS` | `120000` | agents | orçamento de contexto completo para arquivos no escopo (só com `edits`) |
| `DEADPOOL_REGISTRY_BRANCH_ENFORCE` | `off` | deadpool | checkout/base por `branch` do registry |

### 5.5 AÇÕES DO JEAN (fora do código)
1. **GitHub App `genezis-factory` (App ID 3609618, `docker-compose.override.github.yml:17-18`)**: adicionar permissão de repositório **Pull requests: Read & write** (manter Contents: write, Administration); depois **aprovar as novas permissões na instalação** da organização Zentriz (e orientar tenants com App própria a fazerem o mesmo). Sem isso, `evolution_merge_state` ficará em `blocked_permission` (comportamento atual preservado: PR aberto).
2. Confirmar no compose de **prod** (`/opt/zentriz-genesis/docker-compose.yml`) que a API vê `.runner-state` (`${HOST_PROJECT_FILES_ROOT}/.runner-state` → `/project-files/.runner-state`) — pré-requisito do gate PASS_TO_PASS (bloco 3 GAP C). Sem isso, tudo será `blocked_no_evidence` (fail-closed, seguro).
3. Decidir **D-A1**: montar `zentriz-genesis_uploads:/shared/uploads` no serviço `deadpool` (prod) para o `local_path` ter efeito; hoje o Deadpool cai em clone/dry-run.
4. Decidir D-M1, D-M2, D-B2, D-E1 (§4).
5. Commitar (ou não) a `084_cloud_slots_partial_unique.sql` da outra frente antes deste bloco, para fixar a numeração 085/086.

### 5.6 Critérios de PÓS ao vivo (por item, após deploy com a flag ligada)
- **Item 1:** evolução real aceita com `EVOLUTION_AUTO_MERGE=on`: `GET /api/projects/:id/evolution-state` → `merge.state="merged"`, `merge.sha` = `merge_commit_sha` visível no GitHub (`gh pr view <n> --json mergeCommit,state` = `MERGED`); `project_github_repos.sha_dev` atualizado; `dev` do repo contém o CHANGELOG `## [x.y.z]`. Caso negativo controlado: evolução com RFC `major` → `blocked_major`, PR permanece aberto, painel mostra ação. Sem permissão → `blocked_permission` com `acceptedPermissions` no `project_dialogue`.
- **Item 2:** após merge com `EVOLUTION_AUTO_REDEPLOY=on` e deploy anterior do pai: nova linha `cloud_deployments` `trigger_kind='evolution_merge'`, `git_sha = evolution_merge_sha`, `supersedes_deployment_id` = deploy do pai; run do GitHub mostra checkout no SHA (`git rev-parse HEAD` no log do job = `git_sha`); recurso na nuvem inalterado em nome (mesmo ECS service / bucket); pai com `superseded_by_deployment_id` e `teardownExpired` não o toca ao expirar (forçar `expires_at` no passado em staging e observar). Rollback: `POST …/rollback` cria linha `trigger_kind='rollback'` e o recurso volta ao SHA anterior.
- **Item 3:** `git -C /shared/uploads/<child>/apps rev-parse --abbrev-ref HEAD` = `dev` e HEAD ∈ descendentes de `evolution_merge_sha`; `GET /api/deadpool/projects` (como tenant) mostra o sistema com `local_path` do filho e `branch:"dev"`; `project_deadpool_monitoring` do pai `active=false` com `last_error='superseded_by:<child>'`, do filho `active` herdado; `history.jsonl`/KB do Deadpool com a mesma contagem antes/depois (nada perdido); um incidente simulado gera `deadpool/<id>` a partir de `dev` e PR draft com base `dev`.
- **Item 4:** Fase 0 em ≥ 3 evoluções reais: `evolution-state.rewriteStats.ratio_unchanged` registrado; decisão D-E1 documentada em memória. Fase 1 (se aprovada): taxa de aplicação de `edits` ≥ 95% nas primeiras 20 tasks; nenhum arquivo em `apps/` contendo texto `"edits"` cru; `_exported_symbols` sem falso positivo novo.

---

## 6. Riscos residuais (aceitos e documentados)
- Sem cache de installation token, cada merge/poll pede token novo (custo desprezível hoje; se o observador crescer, adicionar cache in-process com TTL 50 min).
- Squash perde a granularidade dos commits de `evolution/vN` — sem valor prático (lotes mecânicos), mas o branch é preservado na v1.
- O rollback por SHA não desfaz migrações de banco do próprio produto do tenant (o Genesis não conhece o schema do produto) — mesma limitação do whitepaper AWS (dados desacoplados). Documentar na UI do rollback.
- `local_path` do pai fica órfão em disco (branch `dev` antigo) — não é lido por ninguém após o handoff; limpeza fica para o teardown/arquivamento futuro.
