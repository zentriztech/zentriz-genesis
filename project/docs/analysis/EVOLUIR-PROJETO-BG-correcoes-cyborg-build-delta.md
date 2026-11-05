> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO BG — correções da rodada real 4.5d (D-12 a D-16)

Origem: relatório BF (`EVOLUIR-PROJETO-BF-execucoes-reais-4-5d.md`). Branch `evo/w1`. Escopo: orchestrator Python e `scripts/full-test-server.py` (FTS). Sem chamadas reais a LLM.

## O que mudou

| Id | Defeito | Correção | Onde |
|----|---------|----------|------|
| D-12 | `/cyborg-build` rodava `npm install` simples e morria em ERESOLVE | Em ERESOLVE (só npm) retenta UMA vez com `--legacy-peer-deps`; registra `install_fallback`, `install_first_attempt_output` e prefixo `[install: …]` no `build_output`. Outra falha de install continua fail-closed, sem retry. | `scripts/full-test-server.py` `_cyborg_build_core` |
| D-13 | Auditoria final avaliava o produto inteiro; bugfix de 1 linha recebeu 5 BLOCKER por dívida antiga e o Cyborg escalou para "conclusão de feature" | Filho de CARD: auditoria escopada ao delta (ver abaixo); BLOCKER fora do delta vira `PRE_EXISTING`; sem escalação de feature | `applications/orchestrator/cyborg_v3.py` |
| D-14 | Laço de rodadas pagava o Dev antes de checar se o build roda | Gate de ambiente antes de cada rodada; falha de ambiente ⇒ zero LLM, `needs_human` com a causa | `cyborg_v3.py` `autonomous_rework`, `_run_cyborg_v3_impl` |
| D-15 | CLI do TSK-FULL-TEST subiu MongoDB em Docker no host | Env sem `DOCKER_*`/`COMPOSE_*`; shims `docker`/`docker-compose`/`podman` na frente do PATH negam (rc 126) e registram; prompts proíbem Docker | `full-test-server.py`, `runner.py` |
| D-16 | Diálogo dizia "Foundry" fixo | `_slot_provider_label()` usa o provedor do slot (Bedrock, Anthropic, Foundry, Vertex AI…) | `cyborg_v3.py` |

### D-13 em detalhe

- Ativa quando `CYBORG_AUDIT_SCOPE=auto` (padrão) e `extra.evolution_origin == "card"`, ou `=delta`. `=full` força o comportamento anterior em tudo.
- Delta = arquivos de `apps/` novos/alterados/removidos do filho versus `apps/` do pai (`extra.evolution_parent_id`), mais seus testes (mesmo nome-base `x.spec.ts`/`x.test.ts`) e os globs `evolution_scope` do RFC (`files_allowed`).
- Prompt das 5 análises recebe `DELTA_SCOPE_INSTRUCTION` (escopo do delta; proíbe exigir "conclusão de feature" ou trabalho fora do card) e o contexto ganha `audit_scope`.
- Pós-processamento (`apply_delta_scope`): BLOCKER cujo arquivo citado (em `evidence`/`description`) está só fora do delta ⇒ severidade `PRE_EXISTING`, registrado em `audit.json` (`pre_existing`, `scope`) e no diálogo; não conta em `evaluate_audit_acceptance`.
- Fail-closed (continuam BLOCKER): arquivo no delta; BLOCKER sem arquivo citado; a3 (build) com `build_rc` diferente de 0/-1; `stack_violation` (fingerprint determinístico).
- Card nunca escala para modo `feature`; BLOCKER residual no delta ⇒ `needs_human`.
- Sem pai/árvore localizável, API fora do ar ou erro ao resolver ⇒ auditoria COMPLETA (mais rígida, nunca mais frouxa).
- Projetos comuns/legado: prompts, contexto e `audit.json` idênticos aos anteriores (teste dedicado).

### D-14 em detalhe

`build_env_failure(rc, *textos)` reconhece ERESOLVE, "could not resolve dependency", ENOTFOUND/EAI_AGAIN/ETIMEDOUT/ECONNRESET/EACCES, "BUILD NÃO EXECUTOU", "install falhou", `not found`/`command not found`; build ok (0) ou não aplicável (-1) e erro de tipos (TSxxxx) NÃO são ambiente. Fontes por rodada: bloco `build` do `audit.json` (estado atual) e baseline do gate. Rodada revertida pelo gate por causa de ambiente liga re-checagem fresca (`run_build_check`) antes da próxima. Retorno de `autonomous_rework` ganha `env_blocked`.

## Variáveis novas

| Variável | Padrão | Efeito |
|----------|--------|--------|
| `CYBORG_AUDIT_SCOPE` | `auto` | `auto` = delta só para filho de card; `delta` = força; `full` = auditoria completa (anterior) |

Sem variáveis novas para D-12/D-14/D-15/D-16. Comportamentos existentes preservados: `CYBORG_ESCALATION_ENABLED`, `CYBORG_ROUND_GATE`.

## Verificação

- Baseline (worktree limpo, `applications`): 23 falhas de ambiente, 1357 passam. Depois: as MESMAS 23 falhas (lista idêntica por `diff`), 1378 passam (+21). `scripts/tests`: 51 → 59 (+8).
- Testes novos: `applications/orchestrator/tests/test_cyborg_delta_env_4_5d.py` (21) e `scripts/tests/test_fts_4_5d_install_docker.py` (8).
- Mutação: sem as correções, 22 dos 29 testes novos falham (os 7 restantes afirmam comportamento preservado/legado). Neutralizando só `apply_delta_scope`, 5 falham; desligando só o gate de ambiente, 3 falham.

## Limites

- D-15 não é isolamento total: caminho absoluto (`/usr/bin/docker`) ou outro cliente falando direto com o socket não passam pelos shims. O fechamento definitivo é o usuário do CLI fora do grupo `docker` (mudança de host, fora deste escopo). O prompt do runner ainda manda executar `project/start.sh`; a restrição prevalece e o agente deve declarar a limitação.
- D-13: `files_allowed` amplos do RFC ampliam o delta; extração de arquivo é por regex em `evidence`/`description` (BLOCKER sem caminho permanece bloqueante). Notas do LLM podem continuar baixas por dívida antiga: o aceite ideal ainda exige média mínima (`CYBORG_AUDIT_MIN_AVG`); o prompt de delta existe para evitar isso, não há ajuste artificial de nota.
- D-14: detecção é textual; padrões novos de erro de ambiente exigem ampliar `_ENV_FAILURE_RE`.
- D-12: fallback só para npm (pnpm/yarn não têm essa flag). Servidor de testes em execução (7878) NÃO foi reiniciado: as correções de FTS só valem após reinício decidido pelo Jean.
