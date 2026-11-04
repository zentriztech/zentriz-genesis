> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO AX — B-2: isolamento do executor de testes (alternativas e recomendação)

Data: 2026-11-04 · Origem: parecer final [AV](EVOLUIR-PROJETO-AV-parecer-final-programa.md), achado **B-2** (bloqueante) · Natureza: **proposta para decisão do Jean**. Nada aqui foi implementado: esta frente entregou só o endurecimento parcial de A-6 (bind e firewall do servidor de testes, relatório [AY](EVOLUIR-PROJETO-AY-correcoes-av-api-scripts.md)). Estimativas de esforço e custo são **assunções** (nenhuma foi medida); o que é fato do código traz `arquivo:linha`.

## 1. O problema (fatos do código)

- `scripts/full-test-server.py` (FTS) roda, **como subprocesso direto no host e sem container**, o `npm ci`/`npm install` do produto (com scripts de pós-instalação) e `npx jest`/`vitest`/`npm test` (`/run-tests`, `_handle_run_tests`), além de `pnpm install` + build + `tsc` (`/cyborg-build`) e do `claude --dangerously-skip-permissions` (`/cyborg-*`). O conteúdo executado vem do **produto do cliente** e do **LLM** (um autor de card pode pedir "inclua um teste que…", e o LLM gera teste ou `postinstall` hostis).
- O unit do FTS roda como `User=ubuntu` (`scripts/genesis-full-test.service.template`), que está no grupo `docker` (equivale a root no host), e o próprio template registra que o unit real de produção carrega chaves `AKIA…` estáticas no `Environment=`. O host tem IMDS (role da instância) e `HOME` com credenciais.
- Resultado (AV B-2): **execução arbitrária de código no host do control plane** por conteúdo de card. Para código só da Zentriz é um risco aceitável e temporário; para conteúdo de **cliente** é bloqueante.
- O que já existe no código para separar: `applications/orchestrator/executor_bridge.py` (`UNTRUSTED_EXECUTOR_URL`: despacha `/run-tests`, `/cyborg-build`, `/cyborg-engineer`, `/cyborg-claude-code`, `/run-full-test` a um **Host B** e embarca os arquivos por job via `/ingest-project`; o token admin nunca viaja para lá; o token de projeto `svc:runner`+`projectId` é cunhado no control plane) e `FTS_UNTRUSTED_ONLY=1` no FTS (recusa os endpoints de deploy e **recusa subir** com qualquer segredo do control plane no ambiente, `_assert_untrusted_host_has_no_secrets`). Se há uma instância de Host B provisionada **não foi verificado** aqui.

Requisitos mínimos do isolamento (AV §6.1 item 8): sem `docker.sock`, sem IMDS, sem `HOME` do host, uid sem privilégio, sem rede ou com egress restrito ao registro de pacotes.

## 2. Alternativas

### A. Container descartável por job (executor no mesmo host, isolado por container)

O FTS deixa de executar o código do produto: cada `/run-tests` e `/cyborg-build` roda em `docker run --rm` de uma imagem de toolchain (node/python) fixada por digest, com: sem `docker.sock`; `--user` sem privilégio; rootfs somente leitura + `tmpfs`; `--cap-drop ALL`, `--security-opt no-new-privileges`, limites de CPU/memória/pids/tempo; **sem `HOME` do host** nem variáveis do FTS; árvore do projeto montada **somente leitura** com cópia gravável em `tmpfs`/volume do job; bloqueio do IMDS (`169.254.169.254`) por regra de firewall na rede do container (ou IMDSv2 com hop limit 1) e egress só para o registro de pacotes (proxy com allow-list).

| Prós | Contras |
|---|---|
| Isola por job; nada persiste entre jobs; barato (sem máquina nova) | O FTS continua no host e com acesso ao Docker (o daemon é a superfície; o grupo `docker` do FTS segue equivalendo a root **para o FTS**, não para o código do produto). Mitigar com socket-proxy restrito ou Docker rootless |
| Reaproveita o fluxo atual (`/run-tests` determinístico, resultado por reporter) | Esforço real: imagens de toolchain por stack, cache de dependências sem vazar entre tenants, rede com allow-list, tratamento de `pnpm`/`npm`/`pytest`/`go` |
| Escala com a máquina atual | `/cyborg-engineer` e `/cyborg-claude-code` (executam o `claude` com credencial de LLM) não se resolvem só com container: dependem de N-7 (como o executor obtém credencial sem violar a LEI dos slots) |
| | Mesmo kernel do host: escape de container é risco residual (menor que o atual) |

Esforço (assunção): **5 a 8 dias** de uma pessoa + testes de escape (`docker.sock` ausente, IMDS inalcançável, `HOME` vazio, rede). Custo de infra: ~0.

### B. Host B (executor em máquina separada, já previsto no código)

Subir o FTS num **segundo host** dedicado ao executor não-confiável, com `FTS_UNTRUSTED_ONLY=1`, e apontar o control plane com `UNTRUSTED_EXECUTOR_URL`. O Host B: sem segredos do control plane (o boot recusa se houver), instance role **mínima** (só Bedrock, nada de ECR/S3/Secrets), Security Group aceitando a porta do FTS **só** do control plane, sem `docker.sock` compartilhado, disco e instância **descartáveis** (reconstruir por AMI/script periodicamente), `FTS_BIND` no IP privado (ver AY) e o firewall versionado (`scripts/dev/fts-firewall.sh`).

| Prós | Contras |
|---|---|
| **Menor esforço**: o roteamento, o tarball por job, o token escopado e o boot fail-closed já existem (`executor_bridge.py`, `full-test-server.py`) | Continua executando código hostil, só que numa máquina descartável: o raio de explosão é o Host B (cota de LLM da role, rede interna da VPC). Exige role mínima e SG rigoroso |
| Isolamento forte entre control plane e conteúdo de cliente (máquina ≠ máquina) | Custo fixo de uma instância (assunção: ordem de dezenas de dólares/mês) e operação extra (patches, rebuild) |
| Compatível com `claude --dangerously-skip-permissions` (que precisa de um host com a CLI) | Jobs de clientes diferentes compartilham o mesmo Host B: sem limpeza entre jobs há vazamento cross-tenant de cache/arquivos |
| | A disponibilidade passa a depender de um segundo host (P3 vale para ele) |

Esforço (assunção): **2 a 4 dias** (provisionamento, role/SG, configuração, teste fim a fim com o Host B) + a decisão de rebuild periódico. Verificar antes: o que já está provisionado, e se `/run-tests` e `/cyborg-build` de fato seguem para o Host B nos três tipos de card.

### C. Executor sem rede (duas fases: instalar com confiança, executar sem rede)

Separar **instalar dependências** (precisa de rede) de **executar código** (não precisa): (1) fase confiável: `npm ci --ignore-scripts` (e equivalentes) por processo do FTS ou de um job controlado, com lockfile do produto, para um diretório de cache; (2) fase não-confiável: executar `jest`/`vitest`/`tsc` com **rede desabilitada** (`docker run --network none` ou `unshare -n`/`bubblewrap`), montando o resultado da fase 1 somente leitura. Scripts de pós-instalação nunca rodam com rede; os que forem necessários (binários nativos como esbuild) entram numa lista de `rebuild` explícita e auditada.

| Prós | Contras |
|---|---|
| Elimina exfiltração e movimento lateral por rede (inclui IMDS) na fase que executa código hostil | `--ignore-scripts` quebra pacotes com binário nativo/`prepare`; é preciso lista de exceções, e o `package.json` do produto pode depender de scripts |
| Barato de operar depois de pronto; combina com A ou B (é uma camada, não um substituto de máquina) | A fase 1 (instalar) ainda lê o `package.json` do cliente: dependência maliciosa baixa-se, só não executa; mantém risco de cadeia de suprimentos |
| Resultado mais determinístico (sem rede, sem flakiness externa) | Testes que precisam de rede (integração com serviços externos) deixam de passar: `baseline` mudaria e viraria `error`/falha para esses produtos |
| | Não resolve sozinho o `claude --dangerously-skip-permissions`, que precisa de rede para o LLM |

Esforço (assunção): **4 a 6 dias**, mais a revisão da classificação `error`/`no_tests` para produtos que dependem de rede.

## 3. Comparação resumida

| Critério | A. Container | B. Host B | C. Sem rede |
|---|---|---|---|
| Esforço (assunção) | 5–8 dias | 2–4 dias + infra | 4–6 dias |
| Custo fixo | ~0 | 1 instância | ~0 |
| Isola código do cliente do control plane | Sim (kernel compartilhado) | **Sim (máquina)** | Parcial (só rede) |
| Resolve `claude --dangerously-skip-permissions` | Não sozinho (N-7) | **Sim** | Não |
| Já existe no código | Não | **Sim (roteamento e boot fail-closed)** | Não |
| Risco de regressão da baseline | Médio (imagens) | Baixo | Médio (testes com rede) |

## 4. Recomendação

1. **Onda 1 (ZFactory, conteúdo só da Zentriz):** B-2 pode ser **aceito explicitamente pelo Jean como risco temporário** (AV §6.1 item 6), com as mitigações já entregues: servidor de testes com bind restrito (`FTS_BIND`) e firewall versionado (AY) e, antes de subir, retirar as chaves `AKIA` do unit e tirar o usuário do FTS do grupo `docker` quando possível. O aceite precisa ficar por escrito.
2. **Clientes (onda 2):** adotar **B (Host B)** como primeira entrega — é o menor esforço porque o código já existe — **antes de ligar qualquer tenant de cliente**, e depois **A como destino** (escala sem segunda máquina), com **C como camada** dentro de A (fase de execução sem rede). Confirmar antes que `UNTRUSTED_EXECUTOR_URL` encaminha `/run-tests` e `/cyborg-build` e que o Host B tem role mínima e SG fechado.
3. **Condição (registrada no ROLLOUT §10):** o servidor de testes **não deve rodar código de produto no host de PRODUÇÃO** sem isolamento. `scripts/dev/start-fts.sh` já recusa `FTS_HOST_ROLE=production` sem `FTS_ISOLATED_EXECUTOR=1`; essa variável só deve ser definida **depois** que A, B ou C estiver implantada e verificada.

## 5. Decisões pedidas ao Jean

1. Aceitar (por escrito) B-2 como risco temporário da onda 1? Prazo-limite?
2. Escolher a alternativa para clientes (recomendação: B agora, A depois, C como camada).
3. N-7 (credencial do executor para o `claude` sem violar a LEI dos slots), que decide se A resolve os endpoints `/cyborg-*` ou se eles ficam só no Host B.
