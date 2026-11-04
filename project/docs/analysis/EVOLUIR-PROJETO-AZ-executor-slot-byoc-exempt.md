> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO AZ — executor × LEI dos slots: `byoc_exempt`

Data: 2026-11-04 · Branch `evo/t1` (base logo após `f4f8ad3`) · Origem: N-7 (502 do `TSK-FULL-TEST` no dev). Natureza: implementação + testes; **nenhuma chamada real ao Bedrock** (validação ao vivo fica com o orquestrador).

## Causa

`scripts/full-test-server.py` `_cli_env_from_slot` devolvia `None` para slot Bedrock sem chaves ("instance role da Zentriz é a fatura que a LEI proíbe"). Mas o Genesis já define a exceção legítima para os agents: `tenants.byoc_exempt` (migration 069; só `zentriz_admin` escreve) lida por `slotUsability` (`tenantLlmConfig.ts`). Executor e agents divergiam: no dev o tenant isento tinha slot "utilizável" na API e inutilizável no executor.

## Decisão (Jean)

Provedor, região e modelos vêm do slot. Slot Bedrock sem chave só usa a conta da Zentriz (IMDS/instance role) se o **tenant** é `byoc_exempt`. Não isento ⇒ continua recusado.

## Mudanças

| Camada | Arquivo | O que mudou |
|---|---|---|
| API | `applications/services/api-node/src/services/tenantLlmConfig.ts` | `ResolvedLlmConfig.byocExempt?` (de `tenants.byoc_exempt`); `toResolved` o emite **só quando `true`** (objeto do tenant comum segue byte-idêntico: contrato `LLM_ROLES_MODE=off`) |
| API | `.../routes/internalLlm.ts` | `GET /api/internal/project-llm-config/:id` devolve `byoc_exempt: boolean` (estrito `=== true`) no corpo e em cada item de `candidates`; sem campo camelCase duplicado; nenhum segredo novo |
| Runner | `applications/orchestrator/runner_server.py` | grava `GENESIS_LLM_BYOC_EXEMPT=1` no env do run só com `true` estrito; senão remove (não herda do container) |
| Runner | `applications/orchestrator/runner.py` | `_byoc_exempt_do_run()`; `_ft_payload` do `/run-full-test` leva `byoc_exempt` junto de `llm_config` |
| Cyborg | `applications/orchestrator/cyborg_v3.py` | `_resolve_slot_llm` devolve `byoc_exempt`; `_slot_body_fields(for_executor=True)` o põe no corpo do `/cyborg-engineer` (o corpo do `/invoke/raw` não muda) |
| FTS | `scripts/full-test-server.py` | `_bedrock_uses_host_identity`; `_cli_env_from_slot(..., byoc_exempt=False)`; `_slot_cli_attempts` lê `payload["byoc_exempt"]` (ou do slot) e rotula o slot `... [executando na conta da Zentriz (tenant byoc_exempt)]` + `log.warning`; `_slot_unusable_reason` diferencia não isento (mensagem "habilite byoc_exempt ou cadastre chaves"), chave parcial e isento |

`/run-tests` e `/cyborg-build` não carregam slot de LLM (execução determinística), logo não ganharam o campo.

## Garantias

- Isento + Bedrock sem NENHUMA chave ⇒ env com `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION/AWS_DEFAULT_REGION` do slot (padrão `us-east-1`), modelos do slot, **sem** `AWS_ACCESS_KEY_ID/SECRET/SESSION/PROFILE`.
- Não isento, flag não booleana (`"true"`, `1`) ou chave parcial ⇒ `None` (fail-closed).
- Com chaves ⇒ idêntico ao anterior, isento ou não. Outros providers: a isenção não se aplica.
- `_sanitized_base_env(slot_bound=True)` não precisa de nada além de `PATH/HOME` para o IMDS; continua removendo `ANTHROPIC_*`, `FTS_AUTH_TOKEN`, `GITHUB_*`, `GENESIS_API_TOKEN`, chaves AWS do host (teste).
- A probe real do slot (`_probe_cli_slot`) segue obrigatória (o rótulo não vazio a aciona).

## Testes (cada um falha sem a correção; verificado por mutação)

- `scripts/tests/test_fts_byoc_exempt.py` (14): isento/não isento/parcial/estrito/com chaves/outros providers/mensagem/sandbox sem vazamento. Sem a correção: 14 falham.
- `applications/orchestrator/tests/test_byoc_exempt_executor.py` (15): runner_server (propaga, estrito, não herda do container), runner, cyborg_v3 (`_resolve_slot_llm`, corpo, `spawn_engineer`), FTS ponta a ponta (flag da API chega ao roteamento; sem vazamento do host). Sem a correção: 10 falham (os demais são casos fail-closed que valem por ausência).
- `applications/services/api-node/src/routes/internalLlm.test.ts` (+3: contrato, estrito/fail-closed, cross-tenant sem vazar flag) e `services/tenantLlmConfig.byoc-exempt-flag.test.ts` (3: isento, não isento lança, com chave). Sem a correção: 4 falham.

## Resultados

| Suíte | Baseline | Agora |
|---|---|---|
| orchestrator pytest | 23 falhas de ambiente / 1329 passam | mesmas 23 (lista idêntica) / 1344 passam |
| `scripts/tests` | 17 | 31 |
| api-node vitest | — | 4191 passam; 3 falhas em `src/integration.test.ts` idênticas sem as mudanças (verificado com stash em DB limpo) |
| `tsc --noEmit` | limpo | limpo |

## Riscos

1. Com `byoc_exempt`, o executor roda código **não confiável do produto** com acesso de rede ao IMDS do host: o processo pode obter credenciais da instance role (escopo de IAM dessa role). Já era o caso do legado sem slot; mitigação real é o isolamento B-2 ([AX](EVOLUIR-PROJETO-AX-b2-isolamento-executor.md)) e IMDSv2 com hop limit 1 onde possível.
2. Executor remoto (Host B): a flag viaja no corpo (`dispatch_full_test` não a remove); o IMDS ali é o do Host B, não o da API. Confirmar qual conta é essa antes de isentar tenant.
3. O rótulo do slot (`llm_slot`) ganhou sufixo textual; consumidores que comparem `llm_slot` por igualdade exata devem ser revistos (nenhum encontrado no repo).
4. Falta a validação ao vivo (probe real no Bedrock com o instance role) — por instrução, a cargo do orquestrador.
