> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO · AD — Fase 4 (tarefas 4.1 e 4.2): tipo do card, origem da spec e `card_id` nas TASKs

Branch `evo/f4a` (base 80103b1), worktree `g-f4a`. Sem push, sem produção. Fora de escopo e intocado: `evolveClaim`, `ticketTransitions`, `github*`, `evolutionAccept`, `evolutionMerge` (frente evo/f4b).

## O que foi feito

**4.1 — runner/CTO/PM/Dev leem tipo e origem**
- `applications/orchestrator/change_kind.py` (novo): deriva de `projects.extra` do filho `ticket_kind` (`evolution|fix|feature`), `spec_origin` (`card:TK-NNNN`, formato de `ticketCode`), `card_id` (`extra.ticket_id`, só se UUID) e `origin_spec_file` (`tickets/TK-NNNN/request.md`). Monta o texto de contexto por tipo e origem. Não decide nada: é contexto para o LLM do slot do tenant (lei: Genesis 100% LLM, Guard soberano intacto).
  - Correção: FAIL_TO_PASS de reprodução como aceite central, mudança MÍNIMA (patch), compat ≤ patch, sem refatorar.
  - Recurso novo: respeitar `Non-goals`.
  - Evolução: rito atual (só a linha de origem).
  - Origem nova: spec descreve só o delta; `TSK-INH-*` (DONE) não são refeitas/replanejadas/renumeradas; só `TSK-EVO-*` para o delta. Origem `initial`: backlog completo, sem herdadas.
  - Toda saída termina com "O gate de RFC não é dispensado por nenhum tipo." (o gate segue no api-node, invariante).
- `pipeline_context.py`: campos `ticket_kind/spec_origin/card_id/origin_spec_file` (+ checkpoint save/load), `change_kind_inputs()` injetado em `build_inputs_for_cto` (l.404), `build_inputs_for_pm` (l.467) e `evolution_scope_inputs` (Dev, l.472).
- `agents/runtime.py:699`: novo campo `change_kind_instruction` renderizado como `## Tipo do card e origem da spec` (mesmo mecanismo do GAP-54c).
- `runner.py`: `_apply_change_context` (l.4180) chamado no bloco FT-10 onde `extra` já é lido (l.6170). Sem tipo/origem (projeto comum, evolução legada sem card) o prompt é byte-idêntico ao anterior (testado).

**4.2 — `TSK-EVO-*` com `card_id`, herdadas `DONE` intactas**
- `runner.py`: `_link_tasks_to_card` (l.4195) marca só `TSK-EVO-*` com `card_id`/`origin_spec_file`; `_seed_tasks` ganhou `card_id`/`origin_spec_file` opcionais (chamada em l.~7368 com o valor do `pipeline_ctx`). Regex de ID (`runner.py:3882`, header e heading) NÃO foi alterado. `TSK-INH-V<n>-…`, `TSK-FULL-TEST` e demais não recebem o vínculo; herdadas DONE não são reenviadas e o upsert da API preserva status terminal. O resumo compacto das herdadas (`_summarize_inherited_tasks`) permanece.
- api-node, MENOR mudança: `routes/projects.ts` (`POST /api/projects/:id/tasks`) aceitava só task_id/module/owner_role/requirements/status; passou a aceitar `card_id|cardId` e `origin_spec_file|originSpecFile`, gravados na migration 150 com `COALESCE` no upsert (reenvio sem card não apaga). Salvaguardas: (a) só com `CARDS_BANCADA` ligada para o tenant (flag off ⇒ ignora, banco idêntico); (b) `card_id` tem de ser o `extra.ticket_id` do próprio projeto, senão 400 `CARD_MISMATCH`. Sem os campos no corpo, comportamento anterior.
- Teste de guarda atualizado: `db/cardsExpand.migration.pg.integration.test.ts` afirmava que o runner não continha `card_id` ("ainda não conhece o card, Fase 4"); agora só proíbe padrão `TSK-EVO-\d` no regex de ID.

## Arquivos
Alterados: `applications/orchestrator/{runner.py,pipeline_context.py,agents/runtime.py}`, `applications/services/api-node/src/routes/projects.ts`, `applications/services/api-node/src/db/cardsExpand.migration.pg.integration.test.ts`.
Novos: `applications/orchestrator/change_kind.py`, `applications/orchestrator/tests/test_change_kind_f4a.py` (17 testes), `applications/services/api-node/src/routes/projects.tasks.card.pg.integration.test.ts` (2 testes), este relatório.

## Testes
Python (`/home/ubuntu/.venvs/genesis-py`, de `applications/`: `python -m pytest orchestrator/tests -q -p no:cacheprovider`):
- Antes (baseline, ANTES de editar): 23 failed, 1179 passed, 3 skipped.
- Depois: 23 failed, 1196 passed, 3 skipped. As 23 falhas são exatamente as mesmas (diff da lista vazio): test_connect_contracts (2), prompt_census_invoke_raw_gap146 (4), spec_dossier_downstream (1), spec_validator (11), thinking_arm_gap144 (2), workbench_llm_config (1) + 2 restantes da mesma família de ambiente.
- Mutação: com as fontes revertidas (só os testes novos), 10 dos 17 falham (prompt 3 tipos × 2 origens = 6, Dev com escopo, seed com `card_id`, `_link_tasks_to_card`, checkpoint/aplicação do contexto). Os 7 que passam são invariantes/guardas que por natureza valem antes e depois: derivação pura (módulo novo), regex de ID inalterado, prompt byte-idêntico sem tipo, POST sem card idêntico.

api-node (Postgres efêmero `f4a-pg` na porta **55441**, pois 55432/55440 estavam ocupadas por f4b; container removido ao final; migrations até 160 aplicadas):
- Novos 2/2 verdes (flag off ignora; flag on liga, COALESCE, herdada DONE intacta, 400 CARD_MISMATCH, GET expõe o vínculo) e `cardsOff.regression` 4/4 verde.
- Suíte completa `vitest run`: 4004 passed, 26 skipped, 0 testes falhando; 4 arquivos "failed" só porque `llm.reorder`, `llm.role-verify`, `costSource` e `skillFeedback` exigem literalmente a porta 55432 (ambiente, pré-existente).

## Não resolvido / decisões a conferir
- `spec_origin = initial` só é afirmado explicitamente (testes); o runner hoje deriva apenas `card:TK-NNNN`. Projeto comum e evolução legada sem card não ganham texto novo (preserva byte-identidade). Se quiser que projetos comuns recebam "ORIGEM = INICIAL" no prompt, é uma linha em `_apply_change_context`, mas muda todo prompt existente.
- `origin_spec_file` é o `tickets/TK-NNNN/request.md` (caminho determinístico do card), não o arquivo de RFC/spec específico que gerou a task; refinar exigiria o PM citar a origem por task.
- Só `TSK-EVO-*` é ligada ao card (conforme tarefa). Tasks de outro prefixo criadas pelo PM numa evolução ficam sem `card_id`.
- Qualidade do prompt com LLM real não foi medida (é a 4.5, ZFactory). Os testes provam que o texto chega a CTO/PM/Dev, não que o modelo o obedece.
- Integração com f4b: sem arquivos em comum; `projects.ts` já constava como permitido na guarda estática da Fase 2, mas f4b pode tocar o mesmo arquivo (conflito textual possível em merge).
- Não há teste de caos (4.6) nem E2E do runner completo; a retomada foi coberta só no nível do seed idempotente.
