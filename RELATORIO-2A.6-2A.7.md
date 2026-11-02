> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Relatório 2A.6 e 2A.7 — chamadas diretas por papel e escalonamento por fato duro

Branch `evo/p2a-d` (derivada de `evo/phase2a-int`, repo zentriz-genesis, worktree `g-2d`). Commits locais, **sem push**, sem deploy, sem produção, sem `docker-compose*`; api-node intocado; `cyborg_v3.py`, `reviewerModel.ts`, `crossFamilyAudit.ts` e `tenantLlmConfig.ts` intocados.

| Hash | Conteúdo |
|---|---|
| `a320cfe` | código e testes de 2A.6 e 2A.7 |
| (este relatório) | docs |

## Estado (preparado · criado · validado · funcional)
**Criado e validado em testes unitários e de contrato** (fakes de provider, Guard falso). **Não funcional em produção**: nenhum acesso a prod, nenhuma chamada real a provider, flag `LLM_ROLES_MODE` segue `off` por padrão. Com `off`/`shadow` a escolha de modelo é a de antes (testes de equivalência).

## Mudanças (`applications/orchestrator/`)
**2A.6**
- `runner.py:1885` `_direct_role_kwargs` (shadow registra o papel que seria usado: F11/F12 `staff`, F08 `orchestrator`, `effective_role=orchestrator`; off ⇒ nada). `runner.py:1895` `_direct_role_text`: chamada direta sob `on` via `call_bedrock_direct` (cliente genérico por provider: Bedrock/Foundry/Anthropic/Google/Azure), com `llm_cfg` = envelope do slot do run.
- F11 `_ask_llm_for_backend_language` (`runner.py:1913`), F12 `_ask_llm_for_module` (`:2128`), F08 `_call_autonomous_monitor` (`:2639`): ramo `on` novo; ramo legado preservado (byte a byte na lógica) em `else`. Sob `on`: sem env/literal (`claude-sonnet-4-6`, `us.anthropic.claude-sonnet-4-6`), sem provider default `anthropic`, sem `Anthropic(api_key=CLAUDE_API_KEY)`. F08 resolve o slot **antes** do laço (sem slot ⇒ exceção, o chamador escala a task ao humano).
- Falha alta propagada: `_detect_backend_stack` e `_detect_backend_language` (F11) e `infer_pm_module_from_engineer_proposal` (F12) relançam `RoleResolutionError` em vez de tentar a próxima fonte, cair em `nodejs` ou na heurística.
- `agents/llm_roles.py:281` `plan_direct_call` + `DIRECT_CALL_ROLES` (F08 orchestrator, F11/F12 staff; Staff vazio ⇒ Orchestrator declarado `llm_role=staff, effective_role=orchestrator`; provider vazio ou incompatível ⇒ `RoleResolutionError`/`RoleProviderMismatch`).
- `agents/runtime.py:3520` `call_bedrock_direct` ganha `effective_role` (aditivo) para o ledger; `runtime.py:3857` `CLAUDE_MODEL_FALLBACK` não é lido sob `on`.

**2A.7**
- `llm_roles.py:92` `required_role(..., env=)`: gatilhos duros = `rework_attempt>=1` (Dev/QA) e `env=prod` (Dev/Engineer; QA só pelo piso). `:435` `schema_escalation_eligible`: schema/envelope reprovado **após** reparo do Orchestrator, só no **último** reparo (o Advisor ocupa um reparo existente: total de chamadas = 1+`MAX_REPAIRS`, sem multiplicar), nunca com truncamento (`max_tokens`), resposta vazia, falha só de qualidade/edits, nem com `MAX_REPAIRS<2`.
- `llm_roles.py:352` `AdvisorBudget` (estado de processo, thread-safe, TTL): `reserve` (uma escalada por chave `task_id+etapa+papel+tentativa`; teto cumulativo por run), `settle` (custo real), `release` (a chamada não saiu: exceção sem resposta ou Guard-deny devolve reserva e chave). `ADVISOR_MAX_USD_PER_RUN` (padrão 5,00; 0 = sem Advisor; inválido ⇒ padrão). Preço conservador sobrescrevível (`ADVISOR_PRICE_USD_PER_MTOK_IN/OUT`, padrão 5/25). Negada ⇒ segue no Orchestrator do slot e registra `advisor_cap_reached` / `escalation_deduped` (log + `_escalation_note` na resposta + ledger `llm_role=advisor, effective_role=orchestrator`, sem `escalated_from`).
- `llm_roles.py:459` `plan_attempt`; `runtime.py:2603-2720` (`run_agent` decide o modelo **por tentativa**), `:2978` gatilho de schema, liberação da reserva em exceção e Guard-deny. Reparos voltam ao Orchestrator (antes, sob `on`, todos os reparos de um rework ficavam no Advisor).
- `server.py:1211` `/invoke/raw`: failover de disponibilidade deixa de ser `advisor`+`escalated_from` no ledger (shadow/waste): `llm_role=orchestrator, effective_role=orchestrator`, `call_reason=retry`. Modelo escolhido inalterado em off/shadow; sob `on` o fallback segue desligado (2A.4).
- `tests/conftest.py`: reset autouse do orçamento do Advisor entre testes.

## Testes (saída real)
- **pytest orquestrador (`/tmp/pyv`):** base `23 failed, 1035 passed, 2 skipped`; depois `23 failed, 1109 passed, 2 skipped` (+74). As 23 falhas são **as mesmas** (diff dos nomes vazio; ambiente).
- Novos: `tests/test_llm_roles_2a6_2a7.py` (74): F08/F11/F12 sob `on` (Staff, Staff vazio ⇒ orchestrator declarado, sem slot/provider ⇒ erro mesmo com env, 5 providers respeitados, provider incompatível, Guard-deny sem rebaixar), equivalência off/shadow (modelo, ledger, default literal só no off), `CLAUDE_MODEL_FALLBACK` morto sob `on`, gatilhos duros e não-gatilhos (truncamento, vazio, rede, entitlement, Guard-deny), idempotência da chave (retry não escala de novo; rework 2 é outra tentativa; chave liberada quando nada foi cobrado), teto (0, minúsculo, cumulativo, `advisor_cap_reached`), failover do `/invoke/raw`, e **pior caso** parametrizado `CLAUDE_RETRY_ATTEMPTS` 1–4 × `MAX_REPAIRS` 0–3 com transitórios de rede.
- **Limite provado (pior caso, rework + schema reprovado sempre):** respostas cobradas do Advisor ≤ 2; requisições ao Advisor ≤ 2×`CLAUDE_RETRY_ATTEMPTS` (com 3×2: ≤ 6 requisições, 2 cobradas); respostas cobradas totais ≤ 1+`MAX_REPAIRS`. Antes (sob `on`, 2A.4): rework mantinha o Advisor em todos os reparos (até 3 cobradas, 9 requisições).
- vitest: **não rodado** (api-node não foi tocado).

## Riscos e decisões que precisam do Jean
1. **Teto padrão de US$ 5,00 por run** é palpite conservador, não dado medido; sob `on` um projeto com muito rework passa a ser servido pelo Orchestrator depois do teto (registrado). Confirmar o valor.
2. **"Run" = `run_id` se vier, senão o projeto**, numa janela TTL de 6 h (o Genesis não expõe `run_id` hoje). Idempotência: chave em memória de processo (TTL 1 h), vale por processo do agents, não entre réplicas/restarts.
3. **Reparos de rework agora no Orchestrator** (só a 1ª tentativa e o último reparo por schema vão ao Advisor): reduz custo, mas é mudança de qualidade sob `on` a medir.
4. **`env=prod` está implementado e dormente**: nenhum fluxo expõe o ambiente (grep sem ocorrências). Leio `input.env`/`message.env` (nome assumido); o produtor desse campo não existe.
5. Dedupe nega a escalada de um reprocessamento legítimo da **mesma** tentativa (mesmo `rework_attempt`) dentro de 1 h; ele roda no Orchestrator com `escalation_deduped` no registro.
6. F11/F12/F08 sob `on` usam `system` fixo curto (`_DIRECT_SYSTEM`), temperatura padrão de `call_bedrock_direct` (0,2) e, no F08, sem o `timeout=120` do SDK: diferenças de forma, não de modelo. F08 como **orchestrator** (instrução); o doc 06 sugere O→A na 2ª tentativa, não implementado.
7. O custo do cap usa preço de teto único (inclusive para Advisor não-Claude, cf. E16); `usage` ausente ⇒ vale a reserva projetada.
8. O Haiku/Staff nos pontos F11/F12 continua piloto: sem medição de concordância (2B).

## Fora de escopo / não feito
- Consulta explícita Orchestrator→Advisor (D2 adiada). Cross-family/Cyborg (g-2e). Literais Haiku no api-node (**apenas listados, não editados**): `gapContinuity.ts:57` (`RECON_MODEL`, usos `:222`, `:468`) e `specGapScope.ts:372` (`ROUTER_MODEL`, uso `:476`). Fora também: `product_architect.py`, `lesson_extractor.py` (E05), `client_http.py` (já tratado na 2A.4; sem mudança).
- Coluna/campo próprio no ledger para `advisor_cap_reached` (exigiria api-node/migration): hoje vai em log + `_escalation_note` + papel efetivo.
