> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO BE — Levantamento SOMENTE LEITURA da produção e roteiro de promoção (Cards da Bancada)

Data do levantamento: **2026-11-05, 01:00–01:45 UTC** · Host: `3.220.66.113` (`i-06e866de4b9ad8cfa`, `ip-10-10-1-167`) · Natureza: **levantamento + proposta para aprovação do Jean**. Nada foi alterado em produção: só `SELECT`, `docker inspect/images/ps`, `systemctl status/cat`, `ss`, `curl` de leitura e `aws … describe/list/get` com o perfil `zentriz` (usuário `jean.zentriz`) e com a instance role. Nenhum segredo foi impresso: variáveis e arquivos de configuração aparecem só por **nome** e por **booleano** (definido/vazio); chaves, tokens, PEM e `private_key_encrypted` não foram lidos.

Fontes lidas: `CLAUDE.md` do repo (fluxo ECR), `CARDS-BANCADA-ROLLOUT.md` (§2, §3, §10), `CARDS-BANCADA-RUNBOOK.md` (§6, §7, §8, §11.4), `EVOLUIR-PROJETO-AV` (§6, §7), `EVOLUIR-PROJETO-AX` (B-2), `scripts/dev/start-fts.sh`, `scripts/genesis-full-test.service.template`, `executor_bridge.py`, `full-test-server.py`. O que é fato medido traz o comando; o que é inferência está marcado **(inferência)**; o que não deu para verificar está marcado **a verificar**.

---

## 0. Resumo e BLOQUEIOS

**Estado:** produção roda o código de `dev@bce3f50` (build de 2026-11-03 01:29Z, deploy "evo" das migrations 134–140). O que falta promover são **156 commits** (`bce3f50..dev`, HEAD `0553379`) e as **12 migrations pendentes 141–162 (confirmado, §2)**. Cards da Bancada ainda **não existem** em produção (nenhuma flag de card definida, tabela `cost_policies` ausente, `tickets` com 0 linhas). Zero runs em voo agora.

**Achados que mudam o plano (novos em relação aos documentos AV/AX/ROLLOUT):**

1. **O Host B já existe e já está ligado.** `UNTRUSTED_EXECUTOR_URL=http://10.10.9.225:7878` está definida em `.env` e nos containers api/runner/agents/cyborg; a instância `zentriz-hostb-untrusted` (`i-0da9d0e2508dab5f1`, t3.large) responde `/health` 200. Logo, `/run-tests`, `/run-full-test` e `/cyborg-*` **já saem do host de produção** (global, para todos os tenants). O FTS co-locado de produção só serviria aos endpoints de deploy.
2. **O FTS co-locado de produção está parado** (`genesis-full-test.service`: `enabled`, `inactive (dead)`; nada escuta na 7878). Os unit/env já **não têm chaves AKIA** (conferido: 0 ocorrências). O script em produção é a versão antiga (HEAD `09653d5`): faz `bind("0.0.0.0")`, sem `FTS_BIND`, sem `scripts/dev/` (sem `start-fts.sh`/`fts-firewall.sh`).
3. **O código de produção não está no GitHub.** `origin/main` = `origin/dev` = `09653d5` (2026-10-16); `dev` local está **202 commits à frente**, e a árvore `/opt/zentriz-genesis` também está em `09653d5`, enquanto as imagens em execução vieram de `dev@bce3f50`. Push e CI (M-8) ainda não aconteceram.
4. **Todos os 14 projetos `accepted` da ZFactory têm `budget_usd = 0` e `budget_paused_at` preenchido** ("orçamento US$ 0 — defina o orçamento na plataforma"). Sem orçamento, o card dá `402 BUDGET_MISSING` (C10).

**BLOQUEIOS (impedem ligar `CARDS_BANCADA` na ZFactory ou promover o código):**

| # | Bloqueio | Tipo | Quem destrava |
|---|---|---|---|
| BL-1 | Push de `dev` (202 commits) + CI `ci-evolution` verde no GitHub (M-8) | Autorização | Jean (OK de push) |
| BL-2 | Orçamento `budget_usd` > 0 e despausa em pelo menos o projeto-raiz do produto de fumaça (C10/C11); `card_budget_pct` | Decisão de US$ | Jean |
| BL-3 | Host B com **versão de `full-test-server.py` desconhecida** e **sem acesso** (SG só aceita 7878 de `10.10.1.167/32`, sem SSH, role sem SSM). Precisa estar na versão de `dev` (correções 4.5c, `fa823d8`) antes de ligar cards | Acesso/infra | Jean (abrir regra SSH temporária) |
| BL-4 | Permissão **Pull requests: Read & write** da GitHub App da instalação da ZFactory: o app da instalação é `app_id=3609618` (não é o `GITHUB_APP_ID=3492947` da plataforma); a API pública só devolveu permissões do app 3492947 (`pull_requests: write`). **A verificar** na tela de instalação (C3) | Verificação manual | Jean |
| BL-5 | Condições da ROLLOUT §10.1 ainda abertas na última leitura (Z1, Z3, Z4, Z6, Z7, Z9) e K-itens de cliente. Não reverificadas aqui; reconferir no dia | Decisões do Jean | Jean |
| BL-6 | Teste de rollback "imagem atual × esquema 162" (M-10/A5) nunca executado | Teste | Executor |
| BL-7 | Sem rotina de backup do banco (só dumps manuais; o último é de 2026-11-03 02:39Z). Fazer dump novo no dia é pré-condição | Execução | Executor |

Severidades e demais riscos: §5. Roteiros: §2 (promoção), §3 (rollback), §4 (FTS/slot), §6 (checklist de ligar).

---

## 1. Levantamento (evidência)

### 1.1 Imagens em uso por serviço e tags de rollback

Comando: `sudo docker inspect --format '{{.Image}}' zentriz-genesis-<svc>-1`; digests ECR via `aws ecr describe-images --profile zentriz … --image-ids imageTag=latest`. Em `docker image` deste host o **ID da imagem é igual ao digest do manifesto ECR** (conferido nos 5 serviços rebuildados), o que torna a verificação de deploy uma comparação de strings.

| Serviço | Imagem em uso (ID = digest ECR `:latest`) | Iniciado (UTC) | Build da imagem | Tag de rollback "anterior" | Qtde de tags `rollback-<svc>` |
|---|---|---|---|---|---|
| api | `sha256:f42b8bbefb853969b6fb8754d3d6225d9eaf275dccf41938eab1be0b6a0fbeed` | 2026-11-03 02:41:53 | 2026-11-03 01:29:59 | `rollback-api:pre-evo-20261103` = `4ca8685741f1` | 157 |
| genesis-web | `sha256:b04e432992a001fc78d8ae6f2ef2494e1a9dc03b425da21a7ffe713a465eebea` | 2026-11-03 02:40:34 | 2026-11-03 00:24:57 | `rollback-genesis-web:pre-evo-20261103` = `cb07afb4ec22` | 63 |
| runner | `sha256:0d2bbddd6e4ecf7fe7ed3afd86fb31de0b4e3d4fcb959fd5df37053059dbdf59` | 2026-11-03 02:42:12 | 2026-11-03 01:30:11 | `rollback-runner:pre-evo-20261103` = `0694e65efb8f` | 46 |
| agents | `sha256:9467788790c8c081f1c766e86a76313ac10afa13e64c03dad3b2b8cd869a3ce7` | 2026-11-03 02:42:12 | 2026-11-03 01:30:10 | `rollback-agents:pre-evo-20261103` = `837039cdb069` | 58 |
| cyborg | `sha256:a9ac5218dfe0f5bc78425dc83488804945bf1828dcf3cf250853e9f276149528` | 2026-11-03 02:42:13 | 2026-11-03 01:30:11 | `rollback-cyborg:pre-evo-20261103` = `2d157cb941fa` | 27 |
| deadpool | `sha256:2b421503b5210f0c833ba235ae1905a10fec14b723ae415af741601e6374af32` | 2026-10-01 11:41:00 | 2026-10-01 11:30:34 | `rollback-deadpool:pre-llmguard-20261001` = `4e8c8bc6d47d` (não há `pre-evo`) | 10 |

- Nome do serviço no compose = `Config.Image` do container (`zentriz-genesis-<svc>`), sem `image:` no YAML (compose BUILD-based, **sem overrides**; `docker-compose.yml` de produção tem o mesmo sha256 de `dev` e de `09653d5`: `5660210f6ad4…`). Não há diferença de compose a levar nesta promoção; flags novas entram via `.env` (`env_file`).
- Digests ECR anteriores ao `latest` (untagged, ainda no registro): api `08d45f4d…`/`a8ff9d1e…`, runner `60036bb0…`/`25479dbc…`, agents `7bd74809…`/`ce070267…`, genesis-web `208e1282…`/`a63413e2…`, cyborg `52e963c1…`/`bc350482…`. Servem de contingência (`docker pull …@sha256:`) se uma tag local for perdida.
- `deadpool`: nenhuma mudança de código esperada nesta promoção (contexto `../zentriz-deadpool-auto-care`); manter `deadpool` e `redis`/`postgres` como estão.
- Containers de produção: api, agents, runner (healthy), cyborg e genesis-web (sem healthcheck), deadpool (healthy), redis, postgres (`pgvector/pgvector:pg16`, healthy) + 7 containers de outros produtos no mesmo host (money-flow, fleet etc.; vários `unhealthy`, **não são do Genesis**).
- Build de `dev@HEAD` já existe nesta workstation (`zentriz-genesis-*:latest` "about an hour ago"), mas é do stack local; **rebuildar antes** (§2.2).

### 1.2 Migrations

| Item | Evidência |
|---|---|
| Tabela | `schema_migrations(version text, applied_at timestamptz)` — a coluna chama `version`; **`name` não existe** |
| Formato do `version` | nome do arquivo sem `.sql`, p.ex. `140_cost_source_ledger_tenant_index` |
| Quantidade / última | **141 linhas**; máxima lexicográfica `140_cost_source_ledger_tenant_index` (aplicada no deploy de 03/11) |
| Repo local | 152 arquivos `.sql` em `applications/services/api-node/src/db/migrations/` |
| **Diferença** (`comm` entre `schema_migrations` de produção e o diretório local) | **Só no repo (pendentes), exatamente 12:** `141_projects_status_materializing`, `142_runtime_config_evolve_min_free_budget`, `143_ticket_attachments_kind_and_limits`, `144_ticket_events`, `145_evolve_reconciler_findings`, `147_redact_git_secrets_in_extra`, `148_cards_expand`, `149_project_spec_files_origin`, `150_project_tasks_card`, `160_attachment_conversions`, `161_cost_policies`, `162_llm_ledger_project_index` |
| Só em produção | `068_backfill_onboarding_suspended` (aplicada 2026-08-30; arquivo não existe mais no repo; coexiste com `068_tenant_llm_budget`). Inofensiva: o executor só aplica o que falta. |

**Confirmado:** as pendentes são 141–162 (sem a 146 e sem 151–159, como o runbook §7 prevê).

Medições do ROLLOUT §10.5 (em produção, somente leitura):

| Tabela | Tamanho total | Linhas estimadas | Efeito |
|---|---|---|---|
| `llm_call_ledger` | 400 kB | 349 | índice da 162 (`idx_llm_ledger_project`, **ausente hoje**) cria em milissegundos; bloqueio de INSERT desprezível |
| `project_dialogue` | 2616 kB | 6408 | varredura com regex da 147 muito abaixo do `statement_timeout` de 300 s |
| `projects` | 432 kB | — | idem |
| banco inteiro | 99 MB | — | `pg_dump` em segundos |

Conclusão: **não é preciso aplicar 147/162 à parte**. Constraints novas (148, 141, 149) não violam dados: `projects.status` em produção ∈ {accepted 32, archived 12, completed 13, draft 4, spec_submitted 1} (todos dentro do CHECK ampliado); `tickets` tem 0 linhas.

### 1.3 Tenants, ZFactory e slots

`SELECT … FROM tenants`:

| id | nome | status | plano | byoc_exempt | billing_exempt |
|---|---|---|---|---|---|
| `beca944e-d7ee-4a5e-a8b6-cfd097239151` | **ZFactory** | active | plan_ouro | **true** | true |
| `0931c5dc-46eb-474a-a54a-dad12733b4b2` | VENUXX TECHNOLOGIES LTDA | active | plan_diamante | **false** | false |
| `1fd37f85-941f-480a-ad7a-f2cb3235fd51` | Cabral Org | suspended | plan_ouro | true | false |
| `4d83cbc6-f390-4129-aa34-91b7211c41e5` | Salif Org | suspended | plan_ouro | true | false |

A **ZFactory** é o tenant `beca944e…` (não há outro "Zentriz"). A Venuxx é cliente ativo (não isenta): **tenant de cliente** na linguagem do ROLLOUT.

Slots da ZFactory (`tenant_llm_configs`, 1 linha ativa, prioridade 0; só booleanos de credencial):

| Campo | Valor |
|---|---|
| provider | `bedrock` |
| model_id / fallback | `us.anthropic.claude-sonnet-5-5` / `us.anthropic.claude-opus-5-5` |
| orchestrator / advisor / staff | `…sonnet-5-5` / `…opus-5-5` / `…haiku-5-5` |
| cyborg | `us.anthropic.claude-sonnet-5-5` |
| **credencial própria** (`credentials` não vazio) | **sim (true)**; valores não lidos |
| verificação | `verify_status`, `verify_orchestrator_status`, `verify_advisor_status`, `verify_staff_status` = **ok**; `verified_at` 2026-11-03 17:44Z |
| `daily_token_quota` / `max_concurrent_projects` / `deadpool_token_reserve` | 10000 / 3 / 0 (a cota **não** vale: `DAILY_TOKEN_QUOTA=off` no `.env`, por decisão de 03/11) |

`zentriz_llm_config` (slot de gestão da plataforma): 1 linha ativa, `bedrock`, label "Gestão Zentriz — Bedrock (conta 820, credencial própria)", `model_id=…sonnet-4-6`, fallback `…opus-4-5-20251101-v1:0`, cyborg `…opus-4-8`, `verify_status=ok` (2026-09-10), credencial própria = **true**. Cabral e Salif têm 1 slot cada (suspensos).

Efeito para o executor (RUNBOOK §11.4): slot Bedrock **com chaves** ⇒ o executor roda **com as chaves do slot** (conta do tenant); a isenção `byoc_exempt` (já `true`) só passaria a valer se o slot ficasse sem chaves (aí o executor usaria o IMDS do host, o que no Host B significa a role mínima). Nada a alterar no slot para a onda 1 (§4.5).

### 1.4 Produtos/projetos `accepted` da ZFactory, repositórios e GitHub App

Projetos da ZFactory por status: accepted 14, archived 8, draft 3, spec_submitted 1. Os 14 `accepted` são todos **raiz** (`parent_project_id IS NULL`, `version_number=1`), todos com repo em `project_github_repos` (`default_branch=main`), todos com **`budget_usd=0` e `budget_paused_at` preenchido**:

| Produto (`product_id` curto) | Projeto accepted | `repo_full_name` |
|---|---|---|
| `cae20ef3` | OrienteME - V13 | `genezis-factory/orienteme-v13-5np0` |
| `05cb1b40` | SPEC-00-contracts | `genezis-factory/spec-00-contracts-lzwj` |
| `05cb1b40` | SPEC-01-identity-svc | `genezis-factory/spec-01-identity-svc-xovp` |
| `05cb1b40` | SPEC-02-content-svc | `genezis-factory/spec-02-content-svc-i6c3` |
| `05cb1b40` | SPEC-03-progress-svc | `genezis-factory/spec-03-progress-svc-7jma` |
| `05cb1b40` | SPEC-15-bff-mobile | `genezis-factory/spec-15-bff-mobile-v4y4` |
| `05cb1b40` | SPEC-19-mobile | `genezis-factory/spec-19-mobile-gfst` |
| `05cb1b40` | SPEC-20-tokens | `genezis-factory/spec-20-tokens-eujb` |
| `a7eb80f8` | Fulfillment - V1 / V2 / API backend - V1 (3 projetos) | `genezis-factory/fulfillment-v1-kyd3`, `…fulfillment-v2-bcnn`, `…fulfillment-api-backend-v1-5mzj` |
| `a105fe22` | Teste Bedrock Fix | `genezis-factory/teste-bedrock-fix-xcj4` |
| `9866aa2c` | Backend de Oficinas | `genezis-factory/backend-de-oficinas-edmh` |
| `b5eec7ba` | Zentriz Summit 2026 | `genezis-factory/zentriz-summit-2026-9d78` |

`SPEC-00…20` pertencem ao mesmo produto (`05cb1b40`), com **mais de um serviço**: sem decisão D-E9 entram em `400 SERVICE_REQUIRED` (ROLLOUT §1, "fora de ordem"). Candidatos a produto de fumaça (um serviço, repo próprio): `Teste Bedrock Fix`, `Backend de Oficinas`, `Zentriz Summit 2026`, `OrienteME - V13`. **A suíte executável (baseline `ok`, C12) de nenhum deles foi medida aqui.**

`tenant_github_installations` (sem colunas secretas; `private_key_encrypted` só como booleano `true`):

| tenant | installation_id | github_login | tipo | scope genesis/deadpool | `app_id` | revogada |
|---|---|---|---|---|---|---|
| ZFactory | **129756252** | `genezis-factory` | Organization | true/true | **3609618** | não |
| Venuxx | 157061284 | `venuxxtech` | Organization | true/true | 4741246 | não |
| Cabral Org | 157575168 | `test10102007` | Organization | true/true | 4764019 | não |

Permissão de Pull requests: `GITHUB_APP_ID` do `.env` = `3492947` = app público **`zentriz-autonomy`**; `GET https://api.github.com/apps/zentriz-autonomy` (público, sem segredo) devolve `pull_requests: write`, `contents: write`, `issues: write`, `workflows: write`, `organization_administration: write`, `metadata: read`. **Mas a instalação da ZFactory é do app 3609618** (um app por tenant); seu slug é desconhecido e a permissão **não é consultável sem assinar JWT com a chave privada** (não lida). Registro: **a verificar** na tela de instalação da org `genezis-factory` (C3), com captura no ticket do rollout.

### 1.5 Servidor de testes (FTS)

| Item | Achado | Comando |
|---|---|---|
| Unit | `genesis-full-test.service` **existe, `enabled`, `Active: inactive (dead)`**; arquivo de 2026-09-02 21:11 | `systemctl status`, `systemctl cat` |
| Usuário / grupos | `User=ubuntu`; `ubuntu` ∈ `docker`, `sudo`, `adm`, `lxd`; **sudo NOPASSWD = sim** | `id ubuntu`, `sudo -n true` |
| `ExecStart` / `WorkingDirectory` | `python3 scripts/full-test-server.py` em `/opt/zentriz-genesis` | `systemctl cat` |
| Chaves AWS estáticas | **Não** no unit (0 ocorrências de `AKIA`) e **não** no env file (0). Nem `AWS_ACCESS_KEY_ID` nos containers api/runner | `grep -c AKIA`, `printenv` |
| `Environment=` do unit | `FULL_TEST_PORT=7878`, `CLAUDE_BIN=/usr/bin/claude`, `AWS_REGION`/`AWS_DEFAULT_REGION=us-east-1`, `CLAUDE_CODE_USE_BEDROCK=1`, `ANTHROPIC_DEFAULT_SONNET_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0` (modelo antigo) |  |
| `/etc/systemd/genesis-fts.env` | existe, `-rw------- root:root`, 644 bytes, de 2026-09-02. **Nomes (todos definidos):** `PATH, HOME, FULL_TEST_PORT, HEAVY_JOBS_MAX, CLAUDE_BIN, CLAUDE_CODE_USE_BEDROCK, AWS_REGION, GENESIS_API_TOKEN, CYBORG_HOST_API_URL, FTS_AUTH_TOKEN`. **Ausentes:** `FTS_BIND`, `FTS_HOST_ROLE`, `FTS_ISOLATED_EXECUTOR`, `FTS_UNTRUSTED_ONLY` | `awk -F=` só nomes |
| Porta 7878 | **sem listener**; sem regra iptables da porta (`DOCKER-USER` vazia), `ufw inactive`. SG de produção não abre 7878 (só 22, 80, 443 e 3000–8001 **entre membros do próprio SG**) | `ss -ltnp`, `iptables -S`, `describe-security-groups` |
| Código no host | `scripts/full-test-server.py` = HEAD `09653d5` (sha256 `59422cf8…`), **0 ocorrências de `FTS_BIND`**, `ThreadedHTTPServer(("0.0.0.0", PORT), …)`; **não existe** `/opt/zentriz-genesis/scripts/dev/` | `grep`, `ls` |
| Instance role | `zentriz-genesis-ec2-role` (perfil `zentriz-genesis-ec2-policy`); IMDSv2 **obrigatório** (`HttpTokens=required`), **`HttpPutResponseHopLimit=2`** (containers alcançam o IMDS). A role **não** lista S3/EC2/ECR/IAM (AccessDenied), só pull de ECR/Bedrock/afins | `aws ec2 describe-instances` |
| Superfície de segredos alcançável por quem roda como `ubuntu` | `/opt/zentriz-genesis/.env` é `-rw------- ubuntu:ubuntu` (**legível por `ubuntu`**); `/opt/zentriz-secrets/zentriz-autonomy.private-key.pem` é **`-rw-r--r--` (644)** (PEM da GitHub App legível por qualquer usuário); `docker` + `sudo` NOPASSWD = root | `ls -l` (conteúdo não lido) |

**Host B (executor não confiável) — já em produção desde 2026-09-03:**

| Item | Achado |
|---|---|
| Instância | `i-0da9d0e2508dab5f1` `zentriz-hostb-untrusted`, t3.large, running, `10.10.9.225` (pública `35.175.124.69`), IMDSv2 required, hop 2 |
| Health | `GET http://10.10.9.225:7878/health` (de dentro de produção) → 200 `{"status":"ok","claude":"/usr/bin/claude","port":7878}` |
| SG `sg-0a438afa8c4e348ff` | ingress **só** tcp/7878 de `10.10.1.167/32` (produção); **sem SSH**; egress aberto (tcp/udp 0.0.0.0/0) |
| Role `zentriz-hostb-untrusted-role` | inline `BedrockInvokeOnly` (`InvokeModel*` em `foundation-model/*` e `inference-profile/*` da conta) + `EcrPullReadOnly`. Sem S3/Secrets/EC2/IAM |
| Roteamento em produção | `UNTRUSTED_EXECUTOR_URL=http://10.10.9.225:7878` + `UNTRUSTED_EXECUTOR_FTS_TOKEN` (definido) no `.env`, e `UNTRUSTED_EXECUTOR_URL` em api/runner/agents/cyborg; `FULL_TEST_SERVER_URL=http://host.docker.internal:7878` (trusted/deploy). `executor_bridge.executor_is_remote()` = verdadeiro |
| Código no Host B | `/opt/hostb/scripts/full-test-server.py` (instalado em 2026-09-03). **Versão atual não verificável** (sem SSH): **a verificar** (BL-3) |

### 1.6 Guard, custo e orçamento

| Item | Achado |
|---|---|
| `llm_guard_settings` | **uma linha:** `kill_switch = off` (por `claude-code:bring-up-2026-10-01`). **Sem tetos gravados** (valem os padrões do código; `GET /api/admin/llm-guard/settings` mostra os efetivos — requer token de `zentriz_admin`, **a verificar** no dia) |
| `cost_policies` | **tabela não existe** (migration 161 pendente) |
| Orçamento dos projetos da ZFactory | 14/14 `accepted` com `budget_usd=0`, pausa `budget_paused_reason = "orçamento US$ 0 — defina o orçamento na plataforma"` |
| Gasto | `llm_call_ledger`: 349 linhas no total; **US$ 0,00** na última hora e nas últimas 24 h |
| Outros | `ADVISOR_MAX_USD_PER_RUN=5` (provisório), `DAILY_TOKEN_QUOTA=off`, `POLICY_ENFORCEMENT_ENABLED=true`, `GENESIS_BYOC_ENFORCED=true`, `GENESIS_BYOC_EXEMPT_TENANTS` vazio |
| Concorrência | 0 projetos `running/queued/materializing/paused/stopping` (janela quieta confirmada às 01:2x UTC) |

### 1.7 Flags

`genesis_runtime_config` (30 linhas; **sem duplicatas** de `(key, tenant_id)`): chaves existentes = `AGENT_TIMEOUT_*`, `CLAUDE_MAX_TOKENS*`, `MAX_QA_REWORK`, `REQUEST_TIMEOUT`, `SPEC_CHAT_MAX_TOKENS` (globais, e overrides da ZFactory para timeouts/tokens). **Não existem** `CARDS_BANCADA`, `EVOLUTION_PROMOTE_BANCADA`, `TASK_INHERIT_TRANSITIVE`, `EVOLVE_RECONCILER` (nem a `EVOLVE_MIN_FREE_BUDGET` da 142). Nenhuma duplicata global.

Env (nomes + valores **não secretos**; `.env` e containers coincidem):

| Variável | api | runner | agents | cyborg | Esperado pelo ROLLOUT |
|---|---|---|---|---|---|
| `NODE_ENV` | production | production | production | production | production (M-13) ✔ |
| `GENESIS_API_TOKEN` | definido | definido | — | — | definido ✔ |
| `LLM_ROLES_MODE` | on | on | on | on | igual nos três (P8) ✔ |
| `EVOLUTION_MERGE_WATCH` | on | on | on | on | — |
| `EVOLUTION_AUTO_MERGE` / `EVOLUTION_AUTO_REDEPLOY` | não definidas | não definidas | não definidas | não definidas | desligadas (P5) ✔ |
| `EVOLVE_RECONCILER`, `CARDS_BANCADA`, `EVOLUTION_PROMOTE_BANCADA`, `TASK_INHERIT_TRANSITIVE` | não definidas | — | — | — | off até o rollout |
| `GENESIS_GITHUB_PUSH` | não definida (padrão `on`) | — | — | — | `on` (C4) ✔ |
| `ATTACHMENTS_STRICT` / `ATTACHMENT_CONVERSION` | não definidas | — | — | — | decidir (C16) |
| `PROJECT_FILES_ROOT` / `UPLOAD_DIR` | `/project-files` / `/shared/uploads` | `/project-files` | `/project-files` | `/project-files` | montados (P6) ✔ |
| `FULL_TEST_SERVER_URL` | `http://host.docker.internal:7878` | idem | idem | idem | — |
| `UNTRUSTED_EXECUTOR_URL` | `http://10.10.9.225:7878` | idem | idem | idem | Host B ✔ |
| `RAG_ENABLED` | live | live | live | live | — |
| `EVOLUTION_P2P_REQUIRED`, `CYBORG_TREE_GATE`, `CONTEXT_MAX_*` | não definidas | — | — | — | A-4: decidir (ROLLOUT Z4) |

Flags `on` no `.env` desde 03/11: `SKILL_FEEDBACK`, `ANOMALY_ALERTS`, `WASTE_TELEMETRY`, `COST_SOURCE_LEDGER`, `SPEC_AUTONOMY`.

### 1.8 Host, backups, nginx, saúde

| Item | Achado |
|---|---|
| Disco | `/dev/root` 96 GB, 68 GB usados, **29 GB livres (71%)**. Docker: 403 imagens (43,75 GB, "64,7 GB reclamável"), volumes 694 MB. O pull dos 5 serviços acrescenta ~3 GB |
| Memória | 7816 MB total, ~1,8 GB usado, ~6 GB disponível, **sem swap**. Load 0,27 |
| Uptime | 34 dias |
| Backup do banco | **Sem rotina:** `crontab` vazio (ubuntu e root), sem timer de dump (timers ativos: `disk-guardian`, `segregation-watch`, `certbot`, sysstat, apt…). Dumps manuais: `~/backups/zentriz_genesis_prod_pre-evo_20261103_0239.sql.gz` (**39,5 MB, o último**), `~/backups/…pre-batch-items123_20260821…`, `~/genesis-backups/…20260817…`, `/opt/zentriz-genesis-backup-pre-finance-f1-20260817-….sql`, `/opt/backups/pre-main-20260719…dump`. Volume do Postgres: `zentriz-genesis_zentriz-genesis_pgdata` (local, sem snapshot conhecido) |
| nginx | `active`, `nginx -t` ok; site `genesis` (443/certbot): `/`→genesis_web, `/api` e `/health`→genesis_api. Certificado de `genesis.zentriz.com.br` válido até **2027-01-30** (86 dias) |
| Saúde pública | `https://genesis.zentriz.com.br/health` → `{"status":"ok","version":"1.5.0","timestamp":"2026-11-05T01:12:19.901Z"}`; `/` → 307 (redireciona) |
| SG de produção `sg-058d888facb43688d` | 80 e 443 abertos ao mundo (ok) e **22 aberto a `0.0.0.0/0`**; 3000–8001 só entre membros do SG |
| Árvore `/opt/zentriz-genesis` | `main` @ `09653d5`; untracked: ~25 arquivos `.env.bak*`/`.env.pre*` (cópias do `.env`, **contêm segredos**, modo conforme o original) |

### 1.9 Produção × `origin/main` × `dev`

| Ref | Commit | Data |
|---|---|---|
| Árvore de produção `git -C /opt/zentriz-genesis log -1` (branch `main`) | `09653d55d04f7a2fb75eb7be92ae29fc299278be` "fix(bancada): faixa da jornada…" | 2026-10-16T20:01:39Z |
| `origin/main` (e `git ls-remote origin main`) | `09653d55…` — **igual à árvore de produção** | idem |
| `origin/dev` (`ls-remote`) | `09653d55…` | idem |
| `dev` local (HEAD) | `055337914fc08ed4e814f15d08e9fcbbe84d2ddd` "Merge branch 'evo/u2' into dev" | 2026-11-04T23:57:47Z, **202 commits à frente** de `origin/dev`; árvore de trabalho limpa (`git status --short` vazio) |
| Imagens em execução | construídas de `dev@bce3f50` (2026-11-03T01:27Z; a data do build das imagens 01:29–01:30Z bate) **(inferência pela data; não há label de commit nas imagens)** | — |

Consequências: (i) a produção **não tem do GitHub** o código que roda; (ii) um `docker compose build` ou `git pull` em produção **regrediria** o sistema para o código de 16/10 (o compose é BUILD-based) — razão a mais para só injetar bytes via ECR; (iii) diff `bce3f50..dev`: `api-node` 166 arquivos (+26 743/−1 237), `genesis-web` 184 (+12 296/−542), `orchestrator` 32 (+4 717/−144), `scripts/full-test-server.py` +412/−66 (**não há diff de `docker-compose.yml`**).

---

## 2. ROTEIRO DE PROMOÇÃO (código; flags de card todas desligadas)

Modo **DO-CONFIRM**: faça, confirme com o comando, pare na primeira falha. Cada bloco marca onde roda: **[LOCAL]** = esta workstation (`~/workspace/current/zentriz/zentriz-autonomy-suite/zentriz-genesis`, branch `dev`); **[PROD]** = `ssh -i ~/.ssh/zentriz_id ubuntu@3.220.66.113`. Toda ação **[PROD]** que escreve exige o OK do Jean no dia. O workstation não é produção.

### 2.1 Portão G0 (antes de buildar)

```bash
# G0.1 [LOCAL] estado do repo e do que será promovido
cd ~/workspace/current/zentriz/zentriz-autonomy-suite/zentriz-genesis
git branch --show-current                       # esperado: dev
git status --short | wc -l                      # esperado: 0
git rev-parse HEAD                              # registrar (hoje 055337914fc0…)
git rev-list --count bce3f50..HEAD              # hoje 156
git ls-remote origin dev                        # hoje 09653d55… => push pendente (BL-1)

# G0.2 [LOCAL] push e CI (SOMENTE com o OK do Jean) — M-8
git push origin dev                             # e aguardar o workflow ci-evolution verde no GitHub
gh run list --branch dev --limit 3              # esperado: success

# G0.3 [PROD] janela quieta: nada em voo (esperado: 0 linhas)
ssh -i ~/.ssh/zentriz_id ubuntu@3.220.66.113 \
 "sudo docker exec zentriz-genesis-postgres-1 psql -U genesis -d zentriz_genesis -tAc \
  \"SELECT id,status FROM projects WHERE status IN ('running','queued','materializing','paused','stopping')\""

# G0.4 [PROD] disco e memória (esperado >= 15 GB livres)
ssh -i ~/.ssh/zentriz_id ubuntu@3.220.66.113 'df -h / | tail -1; free -m | sed -n 2p'
```

Decisões do Jean pendentes que precisam estar escritas antes do passo 2.4 (ROLLOUT §10.1/§10.3): Z3 (N-7 ou `NOT_RUN` aceito), Z4 (defaults globais de A-4), Z9 (aceite do B-2), e o OK de push/deploy. Conferir também o estado de Z1, Z6, Z7 (abertos em 04/11).

### 2.2 Build local (comando padrão, SEM `override.dev`)

```bash
# [LOCAL]
cd ~/workspace/current/zentriz/zentriz-autonomy-suite/zentriz-genesis
docker compose -f docker-compose.yml -f docker-compose.override.linux.yml -f docker-compose.override.foundry.yml \
  build api agents runner cyborg genesis-web
# (deadpool NAO muda; se duvidar: git diff --stat bce3f50 dev -- ../zentriz-deadpool-auto-care  -> repo irmão, conferir lá)

# guard: o bundle web não pode ser de dev (o ecr-push.sh também recusa)
docker image inspect zentriz-genesis-genesis-web:latest --format '{{ index .Config.Labels "com.zentriz.build_target" }}'   # esperado: != dev

# registrar os IDs construídos (serão comparados com ECR e com produção)
for s in api agents runner cyborg genesis-web; do
  echo "$s $(docker image inspect zentriz-genesis-$s:latest --format '{{.Id}}')"; done | tee /tmp/genesis-build-ids.txt
```

### 2.3 Push ao ECR

```bash
# [LOCAL] login com --profile zentriz é feito pelo próprio script; guard recusa bundle web com localhost
bash project/infra/aws/ecr-push.sh 820198199720 us-east-1 api agents runner cyborg genesis-web

# [LOCAL] o digest do :latest no ECR tem de ser igual ao ID local (neste host ID local == digest do manifesto)
export AWS_PAGER=""
for s in api agents runner cyborg genesis-web; do
  echo "$s ecr=$(aws ecr describe-images --profile zentriz --region us-east-1 --repository-name zentriz-genesis/$s \
     --image-ids imageTag=latest --query 'imageDetails[0].imageDigest' --output text)"; done
cat /tmp/genesis-build-ids.txt        # comparar linha a linha; divergiu => PARE
```

Atenção: `ecr-push.sh` só publica a tag `latest`. Os digests em produção hoje (§1.1) ficam *untagged* no ECR depois do push: guarde-os (já listados no §1.1) como contingência.

### 2.4 Preparar o host de produção (backup, tags de rollback, login ECR)

```bash
ssh -i ~/.ssh/zentriz_id ubuntu@3.220.66.113

# a) variável de tag e backup NOVO do banco (último é de 03/11; sem rotina)  [escreve em ~/backups]
export TAG=pre-bancada-$(date +%Y%m%d)
mkdir -p ~/backups
sudo docker exec zentriz-genesis-postgres-1 pg_dump -U genesis zentriz_genesis | gzip > ~/backups/zentriz_genesis_prod_${TAG}_$(date +%H%M).sql.gz
ls -la ~/backups | tail -2 ; gunzip -t ~/backups/zentriz_genesis_prod_${TAG}_*.sql.gz && echo "dump integro"     # tamanho ~ 35-45 MB
cp -p /opt/zentriz-genesis/.env ~/backups/.env.bak-${TAG}   # contém segredos: modo 600, nunca imprimir
chmod 600 ~/backups/.env.bak-${TAG}

# b) tags de rollback do que roda AGORA (as 5 imagens a trocar)
for s in api agents runner cyborg genesis-web; do
  ID=$(sudo docker inspect --format '{{.Image}}' zentriz-genesis-$s-1)
  sudo docker tag "$ID" rollback-$s:$TAG
  echo "rollback-$s:$TAG -> $ID"
done
sudo docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep ":$TAG"     # esperado: 5 linhas
# esperado também: os IDs batem com a coluna "Imagem em uso" do §1.1 (api f42b8bbe…, agents 94677887…, runner 0d2bbddd…, cyborg a9ac5218…, web b04e4329…)

# c) login ECR pela INSTANCE ROLE, tudo no lado remoto (nunca heredoc + pipe de fora)
aws ecr get-login-password --region us-east-1 | sudo docker login --username AWS --password-stdin 820198199720.dkr.ecr.us-east-1.amazonaws.com

# d) pull + retag dos 5 serviços (ainda NÃO recria nada)
R=820198199720.dkr.ecr.us-east-1.amazonaws.com/zentriz-genesis
for s in api agents runner cyborg genesis-web; do
  sudo docker pull $R/$s:latest && sudo docker tag $R/$s:latest zentriz-genesis-$s:latest
done
# e) conferir que o ID local em produção == digest ECR registrado no §2.3 (ainda sem trocar nada)
for s in api agents runner cyborg genesis-web; do echo "$s $(sudo docker image inspect zentriz-genesis-$s:latest --format '{{.Id}}')"; done
```

### 2.5 Recriar na ordem api → agents → [Host B] → runner → cyborg → genesis-web

Compose de produção é único e BUILD-based; usar sempre `--no-build`. Acrescento `--no-deps` ao comando canônico para **garantir que só o serviço nomeado seja recriado** (`api` depende de `runner`; sem `--no-deps` o compose pode arrastar dependências). Entre os passos: `sudo docker ps --format '{{.Names}} {{.Status}}'`.

```bash
cd /opt/zentriz-genesis

# --- 1) API (migrations 141-162 rodam no boot) ---
sudo docker compose up -d --no-build --no-deps --force-recreate api
sudo docker logs -f --since 1m zentriz-genesis-api-1 2>&1 | grep -iE "migra|listening|error|fatal" | head -40   # Ctrl+C quando ver o servidor ouvindo
until [ "$(sudo docker inspect --format '{{.State.Health.Status}}' zentriz-genesis-api-1)" = healthy ]; do sleep 5; done; echo healthy
# digest (healthy NÃO prova código novo):
sudo docker inspect --format '{{.Image}}' zentriz-genesis-api-1          # == sha256 do §2.3 (api)
curl -s https://genesis.zentriz.com.br/health                             # {"status":"ok",...}
# migrations: esperado 153 linhas e as 12 versões novas
sudo docker exec zentriz-genesis-postgres-1 psql -U genesis -d zentriz_genesis -tAc "SELECT count(*) FROM schema_migrations"
sudo docker exec zentriz-genesis-postgres-1 psql -U genesis -d zentriz_genesis -tAc \
  "SELECT version FROM schema_migrations WHERE version >= '141' ORDER BY version"     # esperado: as 12 versões do §1.2
sudo docker exec zentriz-genesis-postgres-1 psql -U genesis -d zentriz_genesis -tAc "SELECT to_regclass('cost_policies'), to_regclass('ticket_card_events'), (SELECT indisvalid FROM pg_index WHERE indexrelid='idx_llm_ledger_project'::regclass)"
#   esperado: cost_policies | ticket_card_events | t
# rotas novas (token de zentriz_admin em $ADM, obtido por login no portal; NUNCA logar o valor):
curl -s -H "Authorization: Bearer $ADM" https://genesis.zentriz.com.br/api/admin/runtime-config/resolved | jq 'has("rolloutFlags")'      # esperado: true
curl -s -H "Authorization: Bearer $ADM" https://genesis.zentriz.com.br/api/admin/llm-guard/settings | jq '{advisor: .advisor, tenant_max: (.settings|has("tenant_max_usd_per_hour"))}'   # advisor.divergent=false
# com a flag desligada, as rotas de card devem dar 404:
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ADM" "https://genesis.zentriz.com.br/api/products/cae20ef3-decf-429f-ae80-cc6af913b91b/cards/capabilities"   # esperado: 404

# --- 2) AGENTS (depois da API: advisor-gate só existe na API nova) ---
sudo docker compose up -d --no-build --no-deps --force-recreate agents
sudo docker inspect --format '{{.Image}}' zentriz-genesis-agents-1       # == §2.3 (agents)

# --- 3) HOST B: atualizar o FTS do Host B ANTES do runner/cyborg novos (ver §4.2) ---
#     (precisa de acesso temporário; sem isso, PARE aqui — BL-3)

# --- 4) RUNNER ---
sudo docker compose up -d --no-build --no-deps --force-recreate runner
sudo docker inspect --format '{{.Image}}' zentriz-genesis-runner-1       # == §2.3 (runner)

# --- 5) CYBORG ---
sudo docker compose up -d --no-build --no-deps --force-recreate cyborg
sudo docker inspect --format '{{.Image}}' zentriz-genesis-cyborg-1       # == §2.3 (cyborg)

# --- 6) GENESIS-WEB ---
sudo docker compose up -d --no-build --no-deps --force-recreate genesis-web
sudo docker inspect --format '{{.Image}}' zentriz-genesis-genesis-web-1  # == §2.3 (genesis-web)
```

### 2.6 Conferências pós-deploy (flags de card ainda desligadas)

```bash
# 1) todos no ar; nenhum container reiniciando; deadpool/redis/postgres intactos
sudo docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep zentriz-genesis
for s in api runner agents cyborg genesis-web deadpool; do echo "$s restarts=$(sudo docker inspect --format '{{.RestartCount}}' zentriz-genesis-$s-1)"; done

# 2) públicos
curl -s https://genesis.zentriz.com.br/health ; curl -s -o /dev/null -w 'web=%{http_code}\n' https://genesis.zentriz.com.br/

# 3) variáveis de flag nos 4 containers (nenhuma flag de card ligada; LLM_ROLES_MODE igual nos 3; AUTO_MERGE/REDEPLOY vazias)
for s in api runner agents cyborg; do echo "== $s"; sudo docker exec zentriz-genesis-$s-1 printenv | grep -E '^(CARDS_BANCADA|EVOLUTION_AUTO_MERGE|EVOLUTION_AUTO_REDEPLOY|EVOLVE_RECONCILER|LLM_ROLES_MODE|NODE_ENV)='; done

# 4) Host B continua roteado e saudável (do host de produção)
curl -s -m 5 http://10.10.9.225:7878/health

# 5) reconciliador em SHADOW (ROLLOUT P4) por >= 3 passadas (15 min) — via runtime-config, valores inteiros (0=off 1=shadow 2=on)
curl -s -X PUT -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' \
  -d '{"value":1}' https://genesis.zentriz.com.br/api/admin/runtime-config/EVOLVE_RECONCILER
# após 15 min: achados abertos (esperado: nenhum crítico novo)
curl -s -H "Authorization: Bearer $ADM" "https://genesis.zentriz.com.br/api/admin/evolve-reconciler/findings?open=true" | jq 'length'

# 6) Guard/kill switch e gasto da última hora
curl -s -H "Authorization: Bearer $ADM" https://genesis.zentriz.com.br/api/admin/llm-guard/settings | jq '.settings.kill_switch, .spend.lastHourUsd'

# 7) nenhum erro nos logs 10 min depois
for s in api runner agents cyborg; do echo "== $s"; sudo docker logs --since 10m zentriz-genesis-$s-1 2>&1 | grep -ciE 'error|traceback|fatal'; done
```

Observações de operação: (a) pull de `:latest` para o repositório ECR **não** altera o compose; (b) não rodar `docker compose build/up` sem `--no-build` em produção (a árvore está em `09653d5` e regrediria o código); (c) não atualizar a árvore `/opt/zentriz-genesis` por `git pull` (canônico: sem git pull no prod); se a árvore precisar refletir `dev`, só com cópia dirigida dos arquivos necessários (ex.: scripts do FTS, §4.2) e com aprovação.

---

## 3. ROTEIRO DE ROLLBACK

**Princípios:** rollback é **por imagem**; **não há migration de volta** (todas as 12 são aditivas/expand, com `IF NOT EXISTS`); `CARDS_BANCADA=0` por tenant via `PUT` (nunca `DELETE`); nunca editar `schema_migrations` à mão. Premissa **não testada** (A5/M-10): a imagem anterior da API rodando contra o esquema 162 — ver BL-6 (o teste em ambiente efêmero deve ser feito **antes** do deploy: subir a imagem `rollback-api:pre-evo-20261103` contra um Postgres restaurado do dump novo + as 12 migrations e bater em `/health` e nas rotas legadas).

### 3.1 Rollback de uma imagem (qualquer serviço)

```bash
# [PROD]
cd /opt/zentriz-genesis
S=<api|agents|runner|cyborg|genesis-web>
sudo docker tag rollback-$S:$TAG zentriz-genesis-$S:latest     # $TAG = pre-bancada-AAAAMMDD (§2.4); fallback: pre-evo-20261103
sudo docker compose up -d --no-build --no-deps --force-recreate $S
sudo docker inspect --format '{{.Image}}' zentriz-genesis-$S-1  # == ID registrado em §2.4(b) / §1.1
```

### 3.2 Ordem

- **Rollback total** (problema descoberto depois de tudo trocado): **ordem inversa do deploy:** `genesis-web` → `cyborg` → `runner` → `agents` → `api` por último. Motivo: runner/agents novos dependem de rotas da API nova (`advisor-gate`, `card_id` em tasks); manter a API nova até os consumidores novos saírem evita o par "consumidor novo × API velha". (O CLAUDE.md e o ROLLOUT §10.4 dizem "api primeiro"; o RUNBOOK §7 fala em "ordem inversa da dependência". Há ambiguidade entre os documentos; esta é a ordem segura, a confirmar com o Jean.)
- **API não subiu no deploy:** como a API é o **primeiro** passo, os demais serviços ainda estão nas imagens antigas — reverter **só a API** (3.1 com `S=api`). Nada mais a fazer.

### 3.3 Se a API não subir

1. `sudo docker logs --tail 80 zentriz-genesis-api-1 2>&1 | grep -iE "migra|lock|timeout|error"`.
2. Causa provável 1, `lock_timeout` de 5 s (`MIGRATION_LOCK_TIMEOUT_MS`): `ALTER TABLE` atrás de transação longa. Ver `SELECT pid, state, wait_event_type, now()-xact_start AS idade, left(query,80) FROM pg_stat_activity WHERE datname='zentriz_genesis' AND state<>'idle' ORDER BY xact_start;`; remover o bloqueador (decisão do Jean para `pg_terminate_backend`) e **repetir o recreate**. A migration que falhou não foi registrada e é idempotente.
3. Causa provável 2, `statement_timeout` de 300 s (147/162): descartada pelas medidas do §1.2 (tabelas de kB/MB).
4. Causa provável 3, CHECK que viola dados (148/141/149): descartada pelos pré-checks do §1.2 (`tickets` vazio; status de `projects` dentro do conjunto novo). `to_regclass`/`pg_constraint` mostram o que ficou parcial.
5. Persistindo: rollback da imagem da API (3.1). Como o esquema pode estar **parcialmente** à frente, a API velha continua compatível (colunas/tabelas novas são ignoradas). **Último recurso (perda de dados desde o dump):** parar api/runner/agents/cyborg e restaurar `~/backups/zentriz_genesis_prod_${TAG}_*.sql.gz`; só com OK do Jean.

### 3.4 Rollback da flag (depois de ligar a ZFactory)

`PUT /api/admin/runtime-config/CARDS_BANCADA {"value":0,"tenantId":"beca944e-d7ee-4a5e-a8b6-cfd097239151"}` (RUNBOOK §6). Cards `draft/refining/ready` ainda não promovidos ficam em limbo (404 + `409 USE_CARD_PROMOTE`): promover/rejeitar antes ou religar. Dados não são apagados. `EVOLVE_RECONCILER`: `PUT … {"value":0}` (off).

### 3.5 Rollback de `.env`

`cp -p ~/backups/.env.bak-${TAG} /opt/zentriz-genesis/.env` + recreate dos serviços afetados (`--no-build --no-deps --force-recreate`). Não mexer em `.env` na promoção de código, a menos que o Jean decida algo da §6.

---

## 4. PLANO — FTS (servidor de testes) em produção na primeira onda, e slot/byoc da ZFactory

### 4.1 O que a decisão do Jean significa à luz do levantamento

Decisão registrada: *aceitar B-2 só na ZFactory na primeira onda; Host B para clientes; container como destino futuro; sem chaves AWS estáticas; token; firewall/bind.*

Fatos: (1) o Host B **já existe e já recebe** todo o trabalho não confiável (roteamento global por `UNTRUSTED_EXECUTOR_URL`; não existe roteamento por tenant); (2) o FTS co-locado de produção está **parado** e é a versão antiga (`0.0.0.0`); (3) quem roda o FTS co-locado é `ubuntu`, que lê `.env` (600 `ubuntu`), tem docker e sudo NOPASSWD, e há PEM 644 — executar conteúdo de card ali equivale a **comprometer o control plane inteiro**.

**Duas variantes.** A primeira é a recomendada; a segunda é a leitura literal e exige trabalho de código.

| | **Variante R (recomendada): manter o Host B para todos, inclusive a ZFactory** | **Variante L (literal): FTS co-locado na produção, B-2 aceito só para a ZFactory** |
|---|---|---|
| Como | Não mexer em `UNTRUSTED_EXECUTOR_URL`. Atualizar o FTS do Host B (§4.2). O FTS co-locado fica **parado** (ou sobe só para deploys, §4.3) | `UNTRUSTED_EXECUTOR_URL` removida ⇒ **todos os tenants** (inclusive a Venuxx, cliente ativo) executariam no host do control plane; não há roteamento por tenant no código |
| Risco B-2 | **Fechado para todos** (executor em máquina separada) | **Aberto para todos**, não só para a ZFactory — viola a própria decisão ("Host B para clientes") |
| Esforço | Acesso temporário ao Host B + deploy do script + canário (≈ 0,5 dia) | Código novo (roteamento por tenant ou trava por tenant) + override auditável + testes (dias) |
| Aceite do Jean | Não precisa aceitar B-2 (o risco que sobra é o do Host B, §5 R-12) | Aceite escrito com prazo-limite |

**Recomendação: Variante R.** Ela cumpre a intenção da decisão (cliente isolado) e dispensa o risco B-2 para a ZFactory também. O restante deste item descreve R, e depois o mínimo para L, se o Jean a escolher.

### 4.2 Variante R — passos

**R1. Atualizar o `full-test-server.py` do Host B (BL-3).** O Host B não tem SSH nem SSM. Procedimento (como em 2026-09-03; exige OK do Jean):

```bash
# [LOCAL] abrir SSH SÓ para o IP desta workstation, por tempo curto (altera infra!)
export AWS_PAGER=""
MYIP=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress --profile zentriz --region us-east-1 --group-id sg-0a438afa8c4e348ff \
  --protocol tcp --port 22 --cidr ${MYIP}/32          # anotar o SecurityGroupRuleId devolvido
# [LOCAL] 1) registrar a versão atual do Host B (leitura) e fazer backup do script
ssh -i <chave-do-host-b> ubuntu@35.175.124.69 'sha256sum /opt/hostb/scripts/full-test-server.py; sudo cp -p /opt/hostb/scripts/full-test-server.py /opt/hostb/scripts/full-test-server.py.pre-bancada-$(date +%Y%m%d)'
# 2) copiar a versão de dev (o mesmo arquivo que está no commit promovido)
scp -i <chave-do-host-b> scripts/full-test-server.py ubuntu@35.175.124.69:/tmp/fts-new.py
ssh -i <chave-do-host-b> ubuntu@35.175.124.69 'sudo install -m 0644 /tmp/fts-new.py /opt/hostb/scripts/full-test-server.py && sudo systemctl restart genesis-full-test.service && sleep 3 && curl -s http://127.0.0.1:7878/health'
# 3) FECHAR a regra SSH imediatamente
aws ec2 revoke-security-group-ingress --profile zentriz --region us-east-1 --group-id sg-0a438afa8c4e348ff --security-group-rule-ids <SecurityGroupRuleId>
aws ec2 describe-security-groups --profile zentriz --region us-east-1 --group-ids sg-0a438afa8c4e348ff --query 'SecurityGroups[0].IpPermissions[].FromPort'    # esperado: [7878]
```

(Caminho da chave do Host B, nome do unit e `/opt/hostb` vêm da memória do projeto de 2026-09-03; **a verificar** no host.) Conferir no Host B: `FTS_UNTRUSTED_ONLY=1` (o script recusa subir com `GENESIS_API_TOKEN`/AWS/JWT/DB no ambiente, `_assert_untrusted_host_has_no_secrets`) e `ANTHROPIC_DEFAULT_SONNET_MODEL` coerente com os slots (§1.5 mostrou valor antigo no unit de produção; no Host B é **a verificar**).

**R2. Canário (sem LLM, sem custo):** do container runner, `curl -s -m 5 http://10.10.9.225:7878/health`; e um `/run-tests` determinístico de projeto `accepted` pequeno via `executor_bridge.dispatch_run_tests` (ou o primeiro card de fumaça §6); no Host B, `journalctl -u genesis-full-test -n 50` deve mostrar `/ingest-project` + `/run-tests`; no host de produção, `ss -ltn | grep 7878` continua **vazio** (prova de que nada rodou co-locado).

**R3. Defesas adicionais no Host B (recomendadas, não bloqueantes para a onda 1):** `HttpPutResponseHopLimit=1`; trocar `BedrockInvokeOnly` para modelos/perfis específicos e com limite de custo; egress restrito ao registro de pacotes e ao Bedrock; AMI/rebuild periódico; limpar `/opt/genesis-files` entre tenants (vazamento cross-tenant de arquivos, AX §2.B).

### 4.3 FTS co-locado na produção (trusted): só se for necessário

Serve apenas aos **deploys confiáveis** (`/launch-s3-deploy`, `/launch-backend-deploy`, chamados pela API em `s3StaticDeploy.ts`/`deployBackendCloud.ts` via `FULL_TEST_SERVER_URL`). Hoje esses deploys **falham** (porta sem listener) — **a confirmar com o Jean se a parada é intencional** (R-9). Para reativar, **sem** expor execução de produto:

1. Copiar para produção os scripts de `dev` (`scripts/full-test-server.py`, `scripts/dev/start-fts.sh`, `scripts/dev/fts-firewall.sh`) com backup do arquivo atual (`cp -p full-test-server.py full-test-server.py.pre-bancada-$TAG`).
2. Token: `FTS_AUTH_TOKEN` já existe nos dois lados (`/etc/systemd/genesis-fts.env` e `.env`); **não** rotacionar na onda; se rotacionar: `openssl rand -hex 32`, atualizar os dois, recriar api/runner/cyborg/agents, reiniciar o unit.
3. `/etc/systemd/genesis-fts.env` (root, 600): acrescentar `FTS_BIND=127.0.0.1,172.17.0.1` (a bridge `docker0` é `172.17.0.1/16`, conferido; `host.docker.internal` → host-gateway), **nunca** `0.0.0.0`; `FTS_REQUIRE_FIREWALL=1`; **sem** `AWS_ACCESS_KEY_ID/SECRET` (já não há).
4. Firewall: `sudo scripts/dev/fts-firewall.sh` (DROP da 7878 fora de loopback e `172.16.0.0/12`) e persistir (`netfilter-persistent save` ou `ExecStartPre`); `scripts/dev/fts-firewall.sh --check` deve dar exit 0. O SG já não abre a 7878 ao mundo.
5. **Trava do B-2 (o que exige override explícito e auditável):** `start-fts.sh` **recusa** `FTS_HOST_ROLE=production` sem `FTS_ISOLATED_EXECUTOR=1`. Esta variável só pode ser definida **depois** de provar que nenhum job não confiável cai no host (R2: canário + `UNTRUSTED_EXECUTOR_URL` remoto ativo). Não usar `FTS_HOST_ROLE=development` para contornar (mentiria o papel do host). Registrar o override: arquivo de aceite/ticket com data e dono, e a linha `FTS_ISOLATED_EXECUTOR=1` com comentário `# provado em <data> por canário R2`.
6. Se o unit voltar a existir, **não** como `User=ubuntu`: usar usuário dedicado sem `docker`/`sudo` e sem leitura de `/opt/zentriz-genesis/.env`, e corrigir o PEM (`chmod 600`, dono `root`/serviço) — ver R-3/R-4.
7. Subir: `sudo systemctl start genesis-full-test.service` ⇒ `ss -ltnp | grep 7878` deve mostrar **apenas** `127.0.0.1` e `172.17.0.1`; `curl -s http://127.0.0.1:7878/health`.

### 4.4 Variante L — o mínimo adicional (se o Jean a escolher)

Além de 4.3: (i) código que roteie por tenant (ou trave `/run-tests`/`/cyborg-*` do FTS co-locado a `tenant_id` da ZFactory), com teste; (ii) variável de aceite explícita — **não existe hoje**; proposta: `FTS_B2_RISK_ACCEPTED=<ref do aceite>:<AAAA-MM-DD>` que `start-fts.sh` exige para `FTS_HOST_ROLE=production` sem executor isolado e grava em log/auditoria, com prazo-limite; (iii) aceite do B-2 **por escrito**, enquanto durar a onda 1 (AX §4.1, ROLLOUT Z9); (iv) usuário dedicado e remoção do PEM/`.env` do alcance do FTS **antes** de subir (sem isso, qualquer card que rode ali lê todos os segredos). Sem (i), a Venuxx também cairia no host de produção.

### 4.5 Slot e `byoc_exempt` da ZFactory

Estado atual (§1.3): `byoc_exempt=true`; slot Bedrock ativo, prioridade 0, **com credencial própria**, modelos `sonnet-5-5`/`opus-5-5`/`haiku-5-5`, verificação `ok` em todos os papéis (2026-11-03 17:44Z). **Nenhuma alteração obrigatória.** Passos de conferência (leitura) no dia:

```bash
# [LOCAL ou PROD] token zentriz_admin em $ADM
curl -s -H "Authorization: Bearer $ADM" "https://genesis.zentriz.com.br/api/tenant/llm-config?tenantId=beca944e-d7ee-4a5e-a8b6-cfd097239151" | jq '.[]? | {priority,provider,verify_status}'   # nenhuma credencial é impressa pela rota; conferir antes
# re-teste do slot (gera 1 chamada barata ao Bedrock; é escrita de status de verificação — OK do Jean):
# POST /api/tenant/llm-config/0/test?tenantId=beca944e-d7ee-4a5e-a8b6-cfd097239151
```

Decisões a registrar (C8/C8b): como o slot tem chaves, o executor (Host B) roda **na conta do slot**; `byoc_exempt=true` fica como rede de segurança (se alguém remover as chaves, o executor usaria a role mínima do Host B, aceitável). Confirmar com o Jean: (a) cota diária `DAILY_TOKEN_QUOTA=off` mantida na onda 1; (b) se o slot `haiku-5-5` está intencional (verificado `ok`); (c) `ADVISOR_MAX_USD_PER_RUN=5` continua provisório.

---

## 5. Pré-condições faltantes e riscos (severidade)

Escala: **Bloqueante** (impede a etapa) · **Alta** · **Média** · **Baixa**.

| # | Item | Sev. | Evidência / ação |
|---|---|---|---|
| R-1 | Código de produção só existe nesta workstation: push (202 commits) e CI `ci-evolution` não feitos; árvore de produção em `09653d5` | **Bloqueante** | §1.9; BL-1 |
| R-2 | Orçamento 0/pausado nos 14 projetos `accepted` da ZFactory ⇒ `402 BUDGET_MISSING` e Guard negando | **Bloqueante** (para cards) | §1.6; BL-2; C10/C11 |
| R-3 | Host B sem acesso e com versão do FTS desconhecida; sem ele atualizado, correções 4.5c/`fa823d8` não valem e `baseline` pode falhar | **Bloqueante** (para cards) | §1.5; §4.2; BL-3 |
| R-4 | Permissão PR do app da instalação da ZFactory (app 3609618) não verificável sem JWT | **Bloqueante** (para cards) | §1.4; BL-4; prova real = 1º PR |
| R-5 | Condições ROLLOUT §10.1 abertas (Z1 `_is_qa_pass`, Z3 N-7/`NOT_RUN`, Z4 A-4, Z6 gate F4 ×3, Z7 caos C8–C11/C13, Z9 aceite B-2) e K1–K9 para clientes | **Bloqueante** (decisões/execução) | ROLLOUT §10; reconferir no dia |
| R-6 | Teste de rollback "imagem atual × esquema 162" não feito (M-10/A5) | **Alta** | BL-6; §3 |
| R-7 | Sem rotina de backup do banco; sem snapshot de volume conhecido; um único disco de 96 GB (71%) | **Alta** | §1.8; BL-7. Propor `pg_dump` diário + retenção + cópia fora do host |
| R-8 | FTS co-locado **ficaria** com acesso a `.env` (600 `ubuntu`), docker, sudo NOPASSWD, PEM 644 e IMDS hop 2 se executasse conteúdo de card; script antigo binda `0.0.0.0` sem firewall | **Alta** (se reativado como executor) | §1.5; §4.3. Hoje mitigado: parado e fora do roteamento |
| R-9 | Unit do FTS co-locado parado ⇒ deploys S3/backend da API (`FULL_TEST_SERVER_URL`) sem listener | **Alta** (a confirmar) | §1.5; confirmar se foi intencional; funcionalidade de deploy de produtos |
| R-10 | SG de produção com **SSH 22 aberto a `0.0.0.0/0`** | **Alta** | §1.8. Restringir a IPs conhecidos / SSM |
| R-11 | PEM da GitHub App (`/opt/zentriz-secrets/zentriz-autonomy.private-key.pem`) com modo 644; cópias de `.env` (`.env.bak*`, ~25) e `env.bak-pre-foundry-removal` no host | **Alta** | §1.5/§1.8: `chmod 600`, dono do serviço; apagar cópias antigas com segredos (com OK) |
| R-12 | Host B: egress aberto, role com `bedrock:InvokeModel` em qualquer modelo da conta, hop limit 2, IP público; vazamento cross-tenant de `/opt/genesis-files` entre jobs | **Média** (cliente: Alta) | §1.5; §4.2 R3 |
| R-13 | Decisões globais A-4 (`EVOLUTION_P2P_REQUIRED=1`, `CYBORG_TREE_GATE=on`, `CONTEXT_MAX_*`, QA sem veredito ⇒ `BLOCKED`) mudam o legado de **todos** os tenants ao subir o código | **Média** | ROLLOUT Z4; hoje não definidas no `.env` |
| R-14 | Compose BUILD-based e árvore de produção stale: `docker compose build`/`up` sem `--no-build` regride o código | **Média** | §1.9; usar sempre `--no-build` |
| R-15 | A-5/K2: teto horário por tenant mitigado, mas a solução estrutural (C6') fica para ≥ 2 tenants de cliente | **Média** (onda 2) | ROLLOUT K2 |
| R-16 | Sem swap, 7,8 GB para 8 containers + 7 de outros produtos no mesmo host; 403 imagens (64 GB reclamáveis) | **Média** | §1.8; `docker image prune` só dos `rollback-*` antigos, com OK |
| R-17 | Imagens sem label de commit; a origem das imagens em execução (`dev@bce3f50`) é inferida pela data | **Baixa** | adicionar `LABEL com.zentriz.git_sha` no build |
| R-18 | Linha órfã `068_backfill_onboarding_suspended` em `schema_migrations` | **Baixa** | inofensiva; registrar |
| R-19 | `ANTHROPIC_DEFAULT_SONNET_MODEL=…sonnet-4-5…` no unit do FTS de produção (modelo antigo) | **Baixa** | revisar se o FTS co-locado for reativado |
| R-20 | `ATTACHMENTS_STRICT`/`ATTACHMENT_CONVERSION` não definidas (anexo em card ⇒ `409 ATTACHMENTS_UNAVAILABLE`) | **Baixa** (decisão) | C16; ligar por tenant se desejado |
| R-21 | Nenhum run em voo agora, mas o gasto histórico é pequeno (349 linhas no ledger): **não há linha de base de custo/vazão** para calibrar `card_budget_pct` e o teto horário | **Média** | usar o US$ 5–8 por card da 4.5 como referência, com o teto por card conferido (C11) |

---

## 6. CHECKLIST — ligar `CARDS_BANCADA` na ZFactory (valores INTEIROS)

Tenant: `beca944e-d7ee-4a5e-a8b6-cfd097239151`. `$API=https://genesis.zentriz.com.br`; `$ADM` = token de `zentriz_admin` (login no portal; `read -s ADM`; nunca em log nem em histórico). **Todas as flags com valor inteiro** (`1`), nunca `"on"`; **só pelo `PUT`** (dispara backfill e checagem de divergência). Modo DO-CONFIRM; parar na primeira falha. Pré-requisito: §2 concluído (código novo no ar, flags de card desligadas), BL-1 a BL-7 resolvidos.

**A. Entrada da plataforma (ROLLOUT §2.1) — verificar no dia**

- [ ] P1 digests api/agents/runner == ECR (§2.5/2.6) e `rolloutFlags` presente em `GET $API/api/admin/runtime-config/resolved`.
- [ ] P2 `SELECT count(*) FROM schema_migrations` = **153** e as 12 versões novas presentes.
- [ ] P3 executor: Host B atualizado (§4.2 R1/R2); `curl -m 5 http://10.10.9.225:7878/health` do container do runner; `ss -ltn | grep 7878` no host de produção **vazio** (nada co-locado) ou, se o trusted FTS foi reativado, só `127.0.0.1`/`172.17.0.1` + `fts-firewall.sh --check` exit 0.
- [ ] P4 `EVOLVE_RECONCILER`=**1** (shadow, global) por ≥ 3 passadas (15 min); achados abertos contados (runbook §10.7).
- [ ] P5 `EVOLUTION_AUTO_MERGE`/`EVOLUTION_AUTO_REDEPLOY` vazias nos 4 containers.
- [ ] P6 `PROJECT_FILES_ROOT=/project-files` e `UPLOAD_DIR=/shared/uploads` na api; nenhum achado `reconciler_disk_unverifiable`.
- [ ] P7 Guard: `kill_switch=off`; tetos efetivos e `tenant_max_usd_per_hour` anotados; `spend.lastHourUsd` baixo.
- [ ] P8 `LLM_ROLES_MODE=on` nos três; `advisor.divergent=false`.

**B. Entrada do tenant (ROLLOUT §2.2)**

- [ ] C1 repo na raiz do produto escolhido: `SELECT project_id, repo_full_name, default_branch FROM project_github_repos WHERE project_id = '<ROOT>'` devolve 1 linha (já existe para os 14 raiz, §1.4).
- [ ] C2 instalação ativa: `SELECT installation_id, github_login, app_id FROM tenant_github_installations WHERE tenant_id='beca944e-…' AND revoked_at IS NULL` ⇒ `129756252 / genezis-factory / 3609618` (já confere).
- [ ] C3 **Pull requests: Read & write** do app **3609618** na tela de instalação (org `genezis-factory`); anexar captura ao ticket. (BL-4)
- [ ] C4 `GENESIS_GITHUB_PUSH` = `on` ou não definida.
- [ ] C7 slot verificado: papéis `ok` (já em 2026-11-03); re-teste se passou de 24 h.
- [ ] C8/C8b `byoc_exempt=true` (já) e slot **com chaves** (já) ⇒ executor na conta do slot.
- [ ] C10 **orçamento do projeto-raiz do produto de fumaça**: `PUT $API/api/projects/<ROOT>/budget {"budgetUsd":<valor>,"alertStepPct":<n>}` — **valor definido pelo Jean** (hoje 0 e pausado). Referência: a 4.5 gastou US$ 4,92–8,37 por card com `card_budget_pct` 34% de US$ 30 (US$ 10,20). Confirmar despausa (`budget_paused_at IS NULL`).
- [ ] C11 `card_budget_pct` definido (`GET $API/api/cost-policies`) e o teto por card **cabe** em um card real.
- [ ] C12 baseline medindo para o produto: após o primeiro card, `evolution-state.baseline.status = "ok"` (`error`/`no_tests` reprovam).
- [ ] C13 QA com `output_tokens > 0` e `TSK-FULL-TEST` executado, ou `NOT_RUN` **aceito por escrito** (Z3).
- [ ] C14 papéis: `tenant_admin` da ZFactory que promove/mergeia; `zentriz_admin` não cria, não promove, não mergeia.
- [ ] C15 produto com versão `accepted` (todos os 14 raiz estão).
- [ ] C16 decidir `ATTACHMENTS_STRICT`/`ATTACHMENT_CONVERSION` (inteiros por tenant).
- [ ] C17 sem `running`/`materializing` no tenant (hoje 0).
- [ ] C18 decidir `TASK_INHERIT_TRANSITIVE` (recomendada ligada na ZFactory).
- [ ] Produto de fumaça com **serviço único** (evitar `SPEC-*` por D-E9): candidatos `Teste Bedrock Fix`, `Backend de Oficinas`, `Zentriz Summit 2026`, `OrienteME - V13` (suíte executável **a verificar**).
- [ ] OK do Jean para este tenant registrado (data e nome).

**C. Ligar (ROLLOUT §3)**

```bash
Z=beca944e-d7ee-4a5e-a8b6-cfd097239151
H=(-H "Authorization: Bearer $ADM" -H 'Content-Type: application/json')

# 1) inteiros, por tenant, ORDEM: promote -> inherit -> cards (o PUT de CARDS_BANCADA roda o backfill e confere divergências)
curl -s -X PUT "${H[@]}" -d "{\"value\":1,\"tenantId\":\"$Z\"}" $API/api/admin/runtime-config/EVOLUTION_PROMOTE_BANCADA
curl -s -X PUT "${H[@]}" -d "{\"value\":1,\"tenantId\":\"$Z\"}" $API/api/admin/runtime-config/TASK_INHERIT_TRANSITIVE     # se C18 = sim
curl -s -X PUT "${H[@]}" -d "{\"value\":1,\"tenantId\":\"$Z\"}" $API/api/admin/runtime-config/CARDS_BANCADA
#   respostas de erro: 409 CARD_DIVERGENCE (nada mudou) ou 500 CARDS_BACKFILL_FAILED => PARE; não corrigir por SQL

# 2) conferir (ignored vazio; capabilities true)
curl -s "${H[@]}" $API/api/admin/runtime-config/resolved | jq '.rolloutFlags | {CARDS_BANCADA, EVOLUTION_PROMOTE_BANCADA, TASK_INHERIT_TRANSITIVE}'
curl -s "${H[@]}" $API/api/products/<PRODUCT>/cards/capabilities | jq .cardsBancada          # true
```

- [ ] Backfill: `SELECT card_state, count(*) FROM tickets WHERE tenant_id='beca944e-…' GROUP BY 1` (hoje `tickets` = 0, backfill sem efeito esperado).
- [ ] **Card de fumaça** pelo `tenant_admin` (não `zentriz_admin`), tipo **Correção** de uma linha, produto de menor risco: criar → gerar RFC → validar → promover; **um card por hora** (`spend.lastHourUsd` conferido antes).
- [ ] Filho: `connect.yaml` presente (senão `409 CONNECT_MISSING`), `baseline.status=ok`, QA com saída.
- [ ] PR: título/commits com `TK-NNNN`; seção "Gates da fábrica" sem "FALHOU"; diff só dos `files_allowed`; nenhuma `*.spec.*` encolhida.
- [ ] Merge humano; se pedir `confirm:"MERGE"`/`confirmScope`, **PARE e investigue**.
- [ ] `delivered` ⇔ PR mergeado (runbook §10.6).
- [ ] Só depois, decidir `EVOLVE_RECONCILER`=**2** (on, global; decisão de plataforma).
- [ ] Observar (ROLLOUT §4): custo por card, `blocked.rate`, achados do reconciliador, kill switch.

**D. Desligar:** `PUT … CARDS_BANCADA {"value":0,"tenantId":"beca944e-…"}`; nunca `DELETE`; promover/rejeitar antes os cards pré-fábrica (runbook §6).

**Critérios de saída da onda 1 (ROLLOUT §1.1, propostos):** 3 tipos de card percorridos até `delivered` com QA real e `TSK-FULL-TEST` executado ou `NOT_RUN` aceito; ≥ 5 cards entregues com `delivered` ⇔ PR mergeado; zero `GLOBAL_HOURLY_CAP`/kill switch em 7 dias; zero achado crítico novo; custo médio dentro do teto por card.

---

## 7. Apêndice — comandos de leitura usados (reprodutíveis)

- Imagens: `sudo docker inspect --format '{{.Image}} {{.State.StartedAt}}' zentriz-genesis-<svc>-1`; `sudo docker images --format '{{.Repository}}:{{.Tag}}|{{.ID}}|{{.CreatedAt}}' | grep rollback-`.
- ECR: `aws ecr describe-images --profile zentriz --region us-east-1 --repository-name zentriz-genesis/<svc> --image-ids imageTag=latest`.
- Migrations: `SELECT version FROM schema_migrations` (produção) × `ls …/db/migrations | sed 's/\.sql$//'` (repo) com `comm`.
- DB: `sudo docker exec zentriz-genesis-postgres-1 psql -U genesis -d zentriz_genesis -c "SET default_transaction_read_only=on; <SELECT>"` (as colunas `credentials` e `private_key_encrypted` só como `IS NOT NULL`).
- Env: `sudo awk -F= '/^[A-Za-z_]…/{…}' .env` imprimindo `nome|set/empty`; valores só para as flags não secretas listadas.
- FTS/host: `systemctl status|cat genesis-full-test.service`, `sudo ss -ltnp`, `sudo iptables -S`, `ls -l` de arquivos de segredo (sem `cat`), `id ubuntu`, `sudo -n true`.
- AWS: `aws ec2 describe-instances|describe-security-groups`, `aws iam get-role-policy|list-attached-role-policies` (perfil `zentriz`, leitura).
- Público: `curl https://genesis.zentriz.com.br/health`; `curl https://api.github.com/apps/zentriz-autonomy`.
