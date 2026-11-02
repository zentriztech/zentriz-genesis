> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Relatório 2A.9 — verificação por papel e elegibilidade

Branch `evo/p2a-c` (derivada de `evo/p2a-a`). Sem push, sem deploy, sem chamada real a provedor.

## Mudanças (arquivo:linha)
Base: `applications/services/api-node/src/`
- `services/llmRoleProbe.ts` (novo): `verifyRoles` (papéis preenchidos, dedupe de ids, concorrência 2, timeout 30 s), `classifyRoleProbe` (ok / denied = auth|model / error / timeout; `unavailable` não é veredicto), `sanitizeRoleError` (mascara valores de credencial, AKIA/sk-/AIza/Bearer/`?key=`, trunca em 500), `haikuPrefixHint` (sugere `global.` e versão, sem trocar o id), `recordRoleVerdicts` (UPDATE de `verify_<papel>_status/_at/_error`; papel vazio → NULL; colunas de whitelist), `isRoleEligible(slot, role)` (contrato: elegível só com modelo preenchido E `verify_<papel>_status = 'ok'`; orchestrator cai em `model_id`), `roleVerdictsPayload`, `roleVerifyFromRow`.
- `services/llmSlotProbe.ts`: `ProbeResult.timedOut?` (só presente quando o AbortController estoura; demais caminhos inalterados).
- `routes/llm.ts`: `verifyAndRecordRoles` (l.161); salvar (l.276, resposta `verify_roles` l.285); re-teste (l.513-519); GET: SELECT das colunas `verify_<papel>_*` e `verify_roles` por slot (l.147), tudo só com `rolesEnabled()`.
- Testes: `services/llmRoleProbe.test.ts` (12), `routes/llm.role-verify.test.ts` (4), `routes/llm.role-verify.pg.integration.test.ts` (1, PG efêmero).

## Achados
- Guard: o probe passa pelo LLM Guard (`/llm/probe` → `probe_slot` → `call_bedrock_direct`, com `_llm_guard.check/record`). Mantido, `llmGuard.ts` intocado. Negação do Guard é classificada hoje como `other` no lado Python (vira `error`, não `denied`); não alterei (arquivos do g-2b).
- Custo ×3 mitigado: o veredicto do probe legado de `model_id` é reaproveitado para o orchestrator e ids repetidos são testados uma vez.
- Salvar: `unavailable` zera o status do papel (o `ok` antigo pode ser de outro modelo); re-teste: preserva.
- `verify_<papel>` não guarda o modelo verificado; se g-2b quiser elegibilidade ligada ao id exato, falta coluna (não prevista na 138).

## Testes (saída real)
- Suíte completa antes: base informada 3413 passaram / 19 pulados. Depois: `Test Files 192 passed | 3 skipped`, `Tests 3429 passed | 20 skipped (3449)` (+16 novos; +1 pulado = integração PG sem PG_TEST_URL).
- `tsc --noEmit`: sem erros.
- Integração PG (container `g2a-pg-test`, porta 55432, migrado 1→139): `1 passed`; container removido.
- `off` idêntico: teste confirma 1 só probe (`model_id`), nenhum UPDATE/SELECT de papel, sem `verify_roles`; testes existentes de SQL byte-idêntico seguem verdes.

## Estado
Criado e validado em teste (mocks + PG efêmero). Não funcional em produção (sem deploy; flag `off` por padrão). Resolução (g-2b) ainda não consome `isRoleEligible`.

## Riscos
- `kind=model` (ValidationException) vira `denied` mesmo para id inexistente (a mensagem distingue).
- Latência do salvar com flag ligada: até 2 probes extras em paralelo (limite 2).
- Python classifica por substring; mudanças ali afetam o mapeamento.

## Commits
Ver `git log evo/p2a-c` (feat + test + este relatório).
