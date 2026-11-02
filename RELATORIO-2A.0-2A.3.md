> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# Relatório 2A.0 a 2A.3 — papéis por slot (estrutura aditiva)

Branch `evo/p2a-a` (a partir de `dev` com a Fase 1, migrations até 137). Commits locais, **sem push**, sem deploy, sem acesso a produção.

| Hash | Conteúdo |
|---|---|
| `4c3aba4` | 2A.0: `docs-evo/2A0-semanticas-fallback.md` |
| `d7ef60c` | 2A.1 e backfill: migrations `138_llm_roles_columns.sql` e `139_llm_roles_backfill.sql` |
| `12d2dcc` | 2A.2 e 2A.3: reorder por UPDATE, dupla escrita, `models`, validação, testes e simulação |

## Estado
- **Criado e validado em Postgres efêmero e em testes unitários**: migrations 1→139 aplicam do zero; reorder preserva colunas; backfill SQL igual à função TypeScript.
- **Não funcional em produção**: nada foi implantado; com `LLM_ROLES_MODE=off` (padrão) as colunas novas não são lidas nem escritas por nenhum caminho. Não há roteamento por papel (isso é 2A.4+).

## Mudanças (arquivo:linha aproximada, base `applications/services/api-node`)
- **2A.0** `docs-evo/2A0-semanticas-fallback.md`: tabela das 5 semânticas com evidência, papel-alvo, efeito de `model_advisor`, risco de custo e teste. Achado novo: a Fase 1 grava o failover do `/invoke/raw` (`agents/server.py:1195`) como `advisor`, mas isso é semântica 4 (disponibilidade) e não deve ser Advisor; corrigir em 2A.4/2A.7.
- **2A.1** `src/db/migrations/138_llm_roles_columns.sql`: `model_orchestrator/advisor/staff` e `verify_{orchestrator,advisor,staff}_{status,at,error}` (TEXT/TIMESTAMPTZ, NULL) em `tenant_llm_configs` e `zentriz_llm_config`. O padrão atual era um conjunto único de `verify_*` (mig. 125/126); replicado por papel com 3 colunas (status/at/error). Sem `DO $$`, sem `;` em literal, sem down. Nenhuma coluna existente muda.
  - **Mudança de constraint (decisão a confirmar):** o CHECK de `priority` passa de 0..3 para -4..3 nas duas tabelas. Motivo: a UNIQUE `(tenant_id, priority)` não pode ser DEFERRABLE (o upsert usa `ON CONFLICT (tenant_id, priority)`, que não aceita arbitro deferível) e uma permutação cíclica de 4 slots precisa de valores de estacionamento. As rotas continuam validando 0..3; valores negativos só existem dentro da transação do reorder (teste confirma 0 negativos após).
- **2A.2** `src/routes/llm.ts` (reorder, ~linhas 410-447) e `src/routes/managementLlm.ts` (reorder): `UPDATE priority` em transação (estaciona em `-(priority+1)`, depois define a posição final; slots fora de `order` seguem sendo removidos, como antes). A linha nunca é recriada, então `id` e todas as colunas (atuais e futuras) ficam intactas. A conta de gestão também era DELETE+INSERT com lista fixa e foi corrigida.
- **2A.3** backfill `139_llm_roles_backfill.sql` (idempotente; só preenche destino NULL; não toca `*_bak_*`):
  `model_orchestrator := model_id`; `model_advisor := model_id_fallback` se não vazio e diferente de `model_id` (igual ⇒ NULL, D1b); `model_advisor := cyborg_model_id` se o fallback é NULL/vazio, advisor ainda NULL e valor diferente do principal (D3); Staff NULL.
  - **Desvios deliberados em relação à letra do pedido (para confirmar):** (a) D3 **não** se aplica quando fallback == principal (senão o caso "sem escalada" viraria escalada para o valor que a migration 030 carimbou em todos os tenants); (b) D3 não é aplicado em `zentriz_llm_config`, cujos `cyborg_model_id*` são DEFAULTs de coluna (029/030), não escolha de ninguém.
- `src/lib/llmRoleSlots.ts` (novo): `backfillRolesFromLegacy` (espelho do SQL), `validateRoleModels` (Staff não pode ser classe topo/opus; Advisor não pode ser `isSmallModel`; provider↔modelo por `servableBy`; id desconhecido ⇒ aviso), `deriveRolesForSave` (conflito novo×legado ⇒ erro), `rolesFromRow`.
- `src/services/tenantLlmConfig.ts`: `ResolvedLlmConfig.models` e `TenantLlmConfig.roleModels` só com flag != off; SELECT com colunas novas só com flag != off; `models` **não** entra nos envelopes para agents/runner (`toAgentsOverride`/`agentsLlmFields` intactos). Legado autoritativo: Orchestrator/Advisor derivados de `model_id`/`model_id_fallback`, Staff da coluna nova; divergência das colunas novas gera aviso sem ids nem credenciais.
- `src/routes/llm.ts`: `upsertConfig` com dupla escrita sob flag (`model_orchestrator` aceito como alias de `model_id`; 400 com mensagem clara em conflito ou papel inválido; `warnings` na resposta); GET inclui `models` por slot. `managementLlm.ts` PUT idem.
- `scripts/simulate-roles-backfill.ts` + `scripts/fixtures/roles-backfill-slots.json`.

## Testes (saída real)
Baseline antes: `186 arquivos + 1 pulado (188); 3375 passaram, 13 pulados`; `tsc --noEmit` exit 0 (arquivo de baseline: 187 passados + 1 pulado).

Depois, suíte padrão (sem Postgres): `Test Files 190 passed | 2 skipped (192)`, `Tests 3413 passed | 19 skipped (3432)`. Com `PG_TEST_URL`: `Test Files 192 passed (192)`, `Tests 3431 passed | 1 skipped (3432)`. `tsc --noEmit` exit 0.

Migrations 1→139 em `pgvector/pgvector:pg16` efêmero (porta 55432, derrubado ao final): `139 Migration applied`, última linha `[DB] Migration applied: 139_llm_roles_backfill`.

Integração Postgres (`src/routes/llm.reorder.pg.integration.test.ts`, 6 testes verdes):
- 24 colunas novas existem (12 × 2 tabelas) e as migrations 138/139 constam em `schema_migrations`;
- ciclo de 4 slots `[1,2,3,0]`: todas as colunas (papéis, `verify_<papel>_*`, `verify_*`, `cyborg_*`, credenciais, quotas) e o `id` iguais; só `priority`/`updated_at` mudam;
- troca com remoção por omissão e 400 sem alterar nada em order inválida; 0 prioridades negativas e UNIQUE vigente;
- conta de gestão: ciclo `[2,0,1]` preserva colunas;
- backfill SQL == `backfillRolesFromLegacy` em 7 casos, e idempotente na 2a execução.

Novos testes padrão: `llm.roles.test.ts` (13; off ⇒ SQL de upsert/GET **igual literal ao HEAD da Fase 1**, 11 parâmetros, campos novos ignorados), `tenantLlmConfig.roles.test.ts` (5; off ⇒ objeto resolvido `toStrictEqual` literal sem chave `models`, payload agents idêntico), `llmRoleSlots.test.ts` (16), `llm.probe-reorder.test.ts` atualizado para UPDATE. Não houve teste negativo executado contra o reorder antigo; a perda de colunas dele é evidente por inspeção (INSERT com lista fixa).

## Simulação do backfill (`npx tsx scripts/simulate-roles-backfill.ts`)
Resumo real: 14 slots; 10 com Advisor, 4 vazios; 3 com Advisor da mesma classe do Orchestrator (T1, T2 e plataforma do baseline); 2 com Advisor mais fraco; 1 via `cyborg_model_id`; 1 erro de validação (Advisor haiku). Baseline: T1 `opus-4-8`/`opus-4-7` (mesma classe), T2 `opus-5`/`opus-4-8` (mesma classe), T3 `sonnet-4-6`/`opus-4-8` (escalada real), plataforma `opus-4-8`/`opus-4-7` (mesma classe). Os ids do fixture são **ilustrativos da classe**, não leitura literal de produção. Tabela completa: executar o script.

```
## Resumo
{
  "total": 14,
  "comAdvisor": 10,
  "advisorVazio": 4,
  "mesmaClasse": 3,
  "advisorMaisFraco": 2,
  "viaCyborg": 1,
  "avisos": 1,
  "erros": 1
}
```

## Riscos e pontos a decidir
1. **CHECK de priority -4..3** (acima): confirmar. Alternativa descartada: constraint DEFERRABLE (quebra o `ON CONFLICT`).
2. **Desvios D3** (acima): confirmar; a leitura literal alteraria "sem escalada" para escalada com valor carimbado pela 030.
3. Slots salvos com a flag `off` deixam as colunas novas defasadas; por isso a leitura usa o legado como autoritativo e avisa a divergência. Antes de ligar `shadow`/`on` convém reexecutar os UPDATEs da 139 (idempotentes).
4. Com flag != off e migration 138 ausente, o SELECT de `getTenantLlmConfigs` falha e cai no `catch` (lista vazia, fail-closed). Migrations rodam no boot da api antes de servir, então só importa em rollback parcial.
5. Com a flag ligada, `GET /api/internal/project-llm-config` passa a incluir `models` (espalha `...cfg`); aditivo, agents/runner ignoram.
6. Custo: o backfill por si não muda custo. No baseline, 3 de 4 slots têm Advisor da mesma classe (escalada sem ganho); T3 é o único com escalada real.

## Fora do escopo (não feito)
Roteamento por papel em runtime (2A.4+), envelope/transporte (2A.5), probe por papel (2A.9: colunas `verify_<papel>_*` existem, ninguém as escreve), portal (2A.10), conta de gestão em runtime (2A.12), remoção de `CLAUDE_MODEL_FALLBACK`, correção do rótulo `advisor` do failover do `/invoke/raw`. Python e docker-compose não tocados; `llmGuard.ts` não tocado.
