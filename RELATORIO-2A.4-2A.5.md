> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Relatório 2A.4 e 2A.5 — resolução por papel e contrato de transporte

Branch `evo/p2a-b` (derivada de `evo/p2a-a`). Commits locais, **sem push**, sem deploy, sem produção, sem `docker-compose*`, `llmGuard.ts` e o probe intocados.

| Hash | Conteúdo |
|---|---|
| `f859db0` | api-node: envelope versionado, `resolveRoleModel`/`requiredRoleFor`, fixtures legacy/v1 e testes |
| `36d676c` | agents (Python): `llm_roles.py`, `run_agent`/`server.py`/`client_http.py` sob `on`, testes de resolução |
| `548bdec` | runner: `runner_server.py` (transporte e validação), `runner.py` (envelope e piso QA), testes de contrato |

## Estado
**Preparado e validado em testes unitários/contrato.** Nada implantado; com `LLM_ROLES_MODE=off` (padrão) e `shadow` a escolha de modelo é a de antes. Não é "funcional" em produção: nenhum acesso a prod, nenhuma chamada real a provider.

## Mudanças (base `applications/`)
**Python (`orchestrator/`)**
- `agents/llm_roles.py` (novo): `required_role` (só `rework_attempt >= 1` em Dev/QA), `apply_floor` (piso QA ≥ Dev pelo papel efetivo), `resolve_model` (Staff vazio ⇒ Orchestrator declarado; Advisor vazio ⇒ sem escalada; Advisor == Orchestrator ⇒ sem troca), `provider_serves`/`validate_provider`/`validate_models` (falha alto, nomeia o papel), `models_from_llm_cfg` (`models.*` ou legado `model_rework`; versão futura ⇒ legado), `models_from_runner_response`, `transport_env`, `envelope_from_env`.
- `agents/runtime.py`: `_get_model_for_role` sob `on` lê só `CLAUDE_MODEL` (:~1500); `run_agent` (:2301-2390) sob `on` toma o Orchestrator do envelope, sem env/literal, e troca a "correção" silenciosa openai→Claude por `validate_provider` (erro); bloco de papel (:2603-2640) resolve o modelo do papel exigido, ignora `CLAUDE_MODEL_REWORK`; `CLAUDE_MODEL_FALLBACK` desligado sob `on` (:2652); shadow só carimba `_llm_role` exigido e `_effective_role`; `_scrub_secrets` não toca `models`.
- `agents/llm_guard.py`: `role_kwargs(required, effective)` e `check(effective_role)` (ledger: Advisor vazio ⇒ `llm_role=advisor, effective_role=orchestrator`; Staff vazio idem).
- `agents/server.py`: `_wrap_with_llm_config` aceita `model_rework` (legado) e `models.*` (só se vier `roles_contract_version`); `/invoke/raw` sob `on`: `_fb`=Advisor desligado (:1184) e resposta vazia avança para o próximo slot (:1229). Corrige o desvio do doc 18 (failover marcado como advisor) **sob `on`**.
- `agents/client_http.py` (:138): retry por timeout não escala para `CLAUDE_MODEL_REWORK` sob `on`.
- `runner_server.py` (:420-465): sob `on` valida cada papel contra o provider (422, sem corrigir), injeta `CLAUDE_MODEL_ADVISOR`/`CLAUDE_MODEL_STAFF`/`GENESIS_LLM_ROLES_CONTRACT_VERSION` (transporte) e remove `CLAUDE_MODEL_SPEC/CODE`/`PIPELINE_LLM_MODEL` e papéis vazados do container; API antiga ⇒ Advisor derivado do `fallbackModelId` do mesmo slot. Credencial segue UMA por slot.
- `runner.py`: `_llm_envelope_do_run` (:2969) acrescenta `models`+versão sob `on`; `dev_effective_role` → `call_qa(role_floor=...)` (:4228, :4501) só sob `on`.

**api-node**
- `lib/llmRoleSlots.ts`: `ROLES_CONTRACT_VERSION`, `rolesRoutingOn`, `requiredRoleFor`, `resolveRoleModel` (espelho do Python).
- `services/tenantLlmConfig.ts`: `toAgentsOverride` (:281-298) e `agentsLlmFields` acrescentam `roles_contract_version` + `models` (topo e por candidato) **só sob `on`**; `toResolved` (:444) põe a versão na resposta do runner sob `on`. `model_id`/`model_id_rework` legados seguem presentes.

## Testes (saída real)
- **vitest completo:** base `190 passed | 2 skipped (192)`, `3413 passed | 19 skipped`; depois `Test Files 191 passed | 2 skipped (193)`, `Tests 3422 passed | 19 skipped (3441)` (+10 novos em `tenantLlmConfig.roles-routing.test.ts`; −1 iteração `on` removida de `tenantLlmConfig.roles.test.ts`, pois `on` agora acrescenta campos de propósito). `tsc --noEmit` exit 0.
- **pytest orquestrador (`/tmp/pyv`):** base `23 failed, 928 passed, 2 skipped`; depois `23 failed, 1035 passed, 2 skipped`. As 23 falhas são **as mesmas** (diff dos nomes vazio; ambiente).
- Novos: `tests/test_llm_roles_resolution.py` (75) e `tests/test_llm_roles_contract.py` (32).
  - matriz papel × slot (completo, Staff vazio, Advisor vazio, Advisor igual) × slot caído × Guard negado;
  - off/shadow equivalentes ao legado (96 combinações papel × rework × `model_rework` × env), mesmo com `models` divergente no envelope;
  - `on` escolhe o modelo do papel; ignora `CLAUDE_MODEL_REWORK/SPEC/CODE/PIPELINE`; sem modelo no slot ⇒ falha mesmo com `CLAUDE_MODEL`;
  - provider incompatível: `on` falha alto (`/run` devolve 422 nomeando `advisor`), `off` mantém a correção atual;
  - falha do slot não chama o Advisor e o papel exigido não muda ao trocar de slot (rework na contingência usa o Advisor do próprio slot); Guard negado não rebaixa nem cascateia;
  - contrato (i) API nova + agents/runner antigo: leitores antigos congelados (cópia literal) produzem o mesmo resultado para a fixture v1 e a legacy; (ii) agents/runner novos + API antiga: payload legado dá o comportamento legado em off/shadow/on; `/run` real do `runner_server` exercitado com urlopen/Popen falsos.

## Riscos e pontos a decidir
1. **Decisões minhas sob `on` além do pedido literal** (confirmar): desliguei `CLAUDE_MODEL_FALLBACK` em `run_agent` (semântica 5; modelo negado vira falha de slot), o escalonamento por timeout do `client_http` e o failover para Advisor do `/invoke/raw`. Podem expor falhas hoje mascaradas; a medição pedida no doc 19 (existe a env em prod?) continua pendente. `call_bedrock_direct` ainda lê `CLAUDE_MODEL_FALLBACK` (chamadas diretas = 2A.6).
2. `provider_serves` (Python) difere do `_is_compatible` legado em um ponto: Bedrock aceita qualquer id com prefixo de vendor/região (`global.` do Haiku) em vez de só `us.anthropic`. Id desconhecido segue compatível (regra do legado).
3. `shadow` mudou o carimbo: `llm_role` passa a ser o papel **exigido** (advisor mesmo sem Advisor) e `effective_role` o que serviu; antes `llm_role` seguia o efeito. Escolha de modelo inalterada.
4. Hoje o cadastro tem legado autoritativo; Advisor == Orchestrator vira `null` em `models` mas `model_id_rework` legado continua igual ao principal (sem efeito de custo).
5. Fixtures TS↔Python acoplam as duas suítes (regenerar com `UPDATE_FIXTURES=1`).
6. 19 s de uma das suítes novas vêm de retries com `sleep` do próprio runtime em testes de falha de slot.

## Fora de escopo (não feito)
- **2A.6** chamadas diretas F08/F11/F12 (`runner.py` com default literal `claude-sonnet-4-6`) e `CLAUDE_MODEL_FALLBACK` em `call_bedrock_direct`.
- **2A.7** política de escalonamento (`env=prod`, schema reprovado, idempotência, teto de custo): só o gatilho `rework_attempt >= 1` existe, como hoje.
- **2A.8** cross-family/Cyborg (`cyborg_v3.py`, `pickStrongestSlot`, revisor [Orchestrator, Advisor]). Probe por papel (2A.9) e portal (2A.10) intocados.
