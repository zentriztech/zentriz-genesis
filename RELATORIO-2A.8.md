> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Relatório 2A.8 — Cross-family por papel e Cyborg (branch `evo/p2a-e`)

Tudo sob `LLM_ROLES_MODE=on`; `off` e `shadow` escolhem exatamente como antes (testes de equivalência).

## Mudanças (api-node em `applications/services/api-node/src/`)
- `services/reviewerModel.ts:224-235,271` — `pickReviewerModel` aceita `candidateRoles`; papel Staff é sempre recusado ("Staff nunca revisa"), inclusive ids sem marcador de porte (`command-r`, `mistral-small`). O pick devolve o `role`.
- `services/tenantLlmConfig.ts:197-` — `getTenantLlmConfigs` lê `verify_orchestrator_status`/`verify_advisor_status` só com `on` (SQL de `off`/`shadow` inalterado).
- `services/tenantLlmConfig.ts:530,551` — `reviewerRoleCandidates` (ordem [Orchestrator, Advisor]; Staff fora; elegibilidade via `isRoleEligible`; sem verificação ⇒ elegível com aviso `unverified`) e `reviewerFamilies`.
- `services/tenantLlmConfig.ts:603-` — `rankReviewerSlots` sob `on`: TODOS os Orchestrators (ordem de prioridade dos slots) antes de qualquer Advisor ⇒ o Advisor nunca é o revisor padrão. Envelope do revisor-Advisor leva o modelo do Advisor, sem `models`/contrato de papéis. `executorRole` propagado (`resolveReviewerLlm*`, `rankReviewerSlots*`).
- `services/crossFamilyAudit.ts:335,411` — `effectiveExecutor` e arg opcional `executor {model, role}`: o auditor recebe o modelo efetivo (sob `on` com `models` no envelope, o do papel; antes, `llm.model_id`).
- `services/specPolicyGate.ts:68,1143` — passa `judgeModel` (efetivo devolvido pelo agent), com fallback para o efetivo do envelope, e `executorRole: "orchestrator"`.
- `routes/llm.ts:337-398` — `families`/`cross_family_available` sobre papéis elegíveis sob `on`; campo aditivo `cross_family_warnings` (papéis não verificados).
- `services/tenantLlmConfig.ts:408,424` — `CYBORG_STARTS_ON_ADVISOR = false` (condição documentada) e `pickStrongestSlot(configs, {compareAdvisors})` exportada: só compara Advisors se a condição for verdadeira; Advisor vazio compara o Orchestrator. Padrão idêntico ao anterior.
- `applications/orchestrator/cyborg_v3.py:257-285,1602-1610` — `_rework_attempt_plan`: modelo por tentativa inalterado (1ª no principal do slot, Advisor na 2ª+); com flag != off envia `llm_role`/`effective_role`/`escalated_from` no corpo do `/invoke/raw` (1ª = orchestrator; 2ª = advisor, `escalated_from=orchestrator`; Advisor vazio/igual ⇒ `effective_role=orchestrator`, sem `escalated_from`).

## Testes novos
- `services/reviewerRoles.2a8.test.ts` (27): matriz de revisores, ordem, Staff, mesma família, modelo efetivo, off==shadow, SQL de `off` sem colunas novas, `pickStrongestSlot` com/sem Advisor, custo.
- `routes/llm.cross-family-roles.test.ts` (5): `families` por papel e avisos.
- `orchestrator/tests/test_cyborg_rework_roles.py` (11): 1ª/2ª tentativa, três modos, custo.

## Saída real dos testes
- `tsc --noEmit`: limpo.
- vitest completo SEM Postgres: antes (stash, mesma máquina) 193 arquivos passaram | 3 pulados; 3438 passaram | 20 pulados. Depois: 195 passaram | 3 pulados; 3470 passaram | 20 pulados (+32). Com Postgres efêmero NÃO executado (não disponível aqui).
- pytest em `applications/orchestrator` (`/tmp/pyv/bin/python`): 1046 passaram, 23 falhas (as 23 de ambiente conhecidas), 2 pulados; base 1035 + 11 novos.

## Cenários de aumento de custo (e prova)
1. Revisor padrão = Advisor: não ocorre (teste "revisor padrão NÃO é o Advisor"; Orchestrators vêm antes).
2. Cyborg no Advisor desde a 1ª tentativa: não ocorre (`test_custo_primeira_tentativa_nunca_e_advisor`; `CYBORG_STARTS_ON_ADVISOR` travado em false).
3. Tenant de uma família: `on` continua sem revisor (alerta, zero chamada).
Observação: tenants com Advisor de outra família passam a ter revisor sob `on` (nova auditoria = nova chamada, por desenho, só se `SPEC_CROSS_AUDIT=on`).

## Estado
Criado e validado por testes unitários/mocks; NÃO funcional em produção (flag `off`, sem deploy, sem push, sem PG real).

## Riscos / pontos para decisão
- O modo `feature` do Cyborg (achado #50) JÁ começa no modelo de reforço (Advisor) desde a 1ª tentativa; mantido por ser pré-existente (mudá-lo reduziria qualidade). O papel registrado diz a verdade (advisor). Nesse modo `pickStrongestSlot` ainda compara Orchestrators (o modo não é conhecido no momento da escolha do slot). Decisão do Jean se quer alinhar.
- `llm_role`/`effective_role`/`escalated_from` no corpo do `/invoke/raw` só terão efeito no ledger quando `server.py` (g-2d) os consumir; hoje o agents ignora e registra `orchestrator`.
- Advisor ≡ `model_id_fallback` (legado autoritativo na transição); o Cyborg não lê `models`.
- Papel não verificado conta como elegível (decisão do pedido); revisar quando 2A.9 popular os status.
- A chamada real do auditor por `crossFamilyAudit` ainda deriva o executor do envelope; chamadores que escalam para o Advisor devem passar `executor` explicitamente (nenhum o faz hoje).

## Fora de escopo
`runner.py`, `runtime.py`, `server.py`, `llm_roles.py`, `llmGuard.ts`, remoção de `cyborg_model_id*` (D3), portal.
