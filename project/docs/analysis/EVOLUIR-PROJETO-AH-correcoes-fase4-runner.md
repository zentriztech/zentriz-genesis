> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO · AH — Correções do runner após a revisão AF (Fase 4)

Branch `evo/f4d` (base `4acaf89`). Escopo: `applications/orchestrator/` e este documento. O api-node não foi tocado.

## Correções

| Achado | Correção | Onde |
|---|---|---|
| **A2** ticket legado muda o prompt com a flag desligada | `derive_change_context` só devolve contexto se `extra.evolution_origin == "card"`. O marcador **já existe**: o claim de promoção o grava (`evolveClaim.ts:515`, junto de `card_draft_project_id`); `/evolve` legado grava só `ticket_*` (`:514`). **Não é preciso mudar o api-node.** Efeito colateral bom: ticket legado também deixa de ligar tasks a `card_id`. | `change_kind.py:54-67` |
| **A3** `card_id` só em `TSK-EVO-*` | `_link_tasks_to_card` liga toda task não `TSK-INH-*` (regex de ID intacto). `_seed_tasks` liga **depois** de anexar `TSK-FULL-TEST`. Também ligam: `TSK-DEVOPS-001`, `TSK-FULL-TEST` (caminho do monitor), `TSK-TRIVIAL-001` (fast-path) e a consolidada. | `runner.py:4198-4225`, `:4270`, `:5221`, `:5366`, `:7028`, `:7453` |
| **A3** `TSK-TRIVIAL-001` cancela as EVO | `_may_consolidate_trivial`: filho de card nunca consolida (nada é cancelado); projeto comum mantém o comportamento. | `runner.py:4205`, `:7419-7422` |
| **M3** QA sem o tipo do card | `call_qa` acrescenta `pipeline_ctx.change_kind_inputs()` (mesmo bloco de CTO/PM/Dev; `{}` fora de card). | `runner.py:2664` |

## Testes (`tests/test_change_kind_ah.py`, 15 casos; `test_change_kind_f4a.py` ajustado)

- A2: `extra` legado ⇒ prompts de CTO/PM/Dev/QA **iguais** aos de um `PipelineContext` virgem (comparação com o contexto que nunca viu os campos, via `_apply_change_context`), sem `FAIL_TO_PASS`/`ORIGEM DA SPEC`/`Non-goals`; card ⇒ regras presentes nos 4 papéis.
- A3: parametrizado por prefixo (EVO, FULL-TEST, DEVOPS, TRIVIAL, BE, WEB-HOME-FIX ligados; INH não); `camelCase`; sem card a lista é a mesma; `_card_link_args`; consolidação não descarta card. Guarda estática dos pontos de POST (fraca por natureza: só impede regressão textual).
- M3: QA de Correção recebe `TIPO DO CARD = CORREÇÃO` + `FAIL_TO_PASS`; Recurso novo recebe `Non-goals` sem `FAIL_TO_PASS`; projeto comum não recebe nada.
- No `test_change_kind_f4a.py`, o helper `_extra` passou a gravar o marcador de card e as asserções "só TSK-EVO recebe vínculo" foram invertidas.
- O teste fraco 1 da seção 2 da AF (byte-identidade) agora tem a comparação com contexto virgem e o caso do ticket legado.

## Mutação (cada teste novo falha sem a correção)

| Mutação | Resultado |
|---|---|
| Reverter `runner.py` e `change_kind.py` ao HEAD | os testes novos nem importam (`is_card_child`, `_may_consolidate_trivial`) |
| Remover o `update` do QA (M3) | 2 falhas: `test_a2_card_recebe_as_regras_novas` (papel QA), `test_m3_qa_recebe_tipo_do_card_e_fail_to_pass_na_correcao` |
| `is_card_child` ⇒ sempre verdadeiro (A2) | 2 falhas: `test_a2_ticket_legado_prompt_identico_ao_pre_fase4`, `test_a2_card_recebe_as_regras_novas` (+ `_card_link_args`) |
| Ligar só `TSK-EVO-*` e liberar a consolidação (A3) | falhas em 4 casos parametrizados + `_card_link_args`/consolidação |

## Contagens (`/tmp/pyv`, `pytest -q tests`)

| | Antes | Depois |
|---|---|---|
| Passam | 1201 | 1216 (+15 novos) |
| Falhas | 23 | 23 (lista **idêntica**, conferida por `diff`) |

(2 skipped nos dois casos.)

## Dependências da frente api-node (evo/f4c)

1. **Nenhuma mudança é necessária para A2**: o marcador `evolution_origin: "card"` já é gravado pelo claim (`evolveClaim.ts:515`).
2. A rota `POST /api/projects/:id/tasks` deve aceitar `card_id` em todos os prefixos não `TSK-INH-*` (hoje aceita em qualquer prefixo, B-3 da AF) e, se a f4c preencher `card_id` no servidor, o COALESCE existente evita conflito com o que o runner envia.
3. M2 (POST sem transação) continua no api-node; o runner agora envia `card_id` em mais tasks, então um `CARD_MISMATCH` afeta mais linhas até a rota validar tudo antes do laço.

## Fora do escopo desta entrega

Dev ainda recebe o bloco com instruções de planejamento (segunda metade de M3); B-5 (texto "cite o card" convida a deformar o ID) e B-4 não foram tratados.
