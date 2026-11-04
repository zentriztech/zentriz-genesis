> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO AQ — Correções de QA, escopo do Cyborg, TSK-FULL-TEST e baseline P2P

Data: 2026-11-04 · Branch `evo/q1` (base `8faa378`) · Origem: defeitos D-1, D-2, D-3, D-4 e D-10 do relatório AP (`EVOLUIR-PROJETO-AP-execucoes-reais-4-5.md`, seção 5).
Escopo respeitado: só `applications/orchestrator` (Python) e este documento. Nada em `applications/services/api-node`, nada de push, produção, containers do stack ou `genezis-factory`.

## 1. Resultado

| Defeito | Situação | Teste que falha sem a correção |
|---|---|---|
| D-2 QA nunca devolve JSON | **Causa-raiz provada e corrigida**: não era o parser, era `stop_reason="refusal"` do modelo, provocado pela instrução de saída | 5 testes (instrução, parser, refusal, vazio, veredito) |
| D-3 `TSK-FULL-TEST` `DONE` sem executar | Corrigido na origem do runner (`CANCELLED` + relatório `NOT_RUN`). **Resta 1 ponto no api-node** (fechamento do aceite) | 2 testes |
| D-4 baseline `Connection refused` | Causa provada (ambiente: nada escuta em `:7878`); código agora **reprova alto** em vez de degradar em silêncio | 4 testes |
| D-1 Cyborg fora do gate de escopo | Corrigido: mesmo gate do Dev + regra nova "testes existentes não encolhem" (vale para Dev e Cyborg) | 5 testes (um de integração do loop real) |
| D-10 herança transitiva | **Só decisão de flag**; sem mudança de código (recomendação na seção 6) | n/a |

## 2. D-2 — causa-raiz do QA sem JSON (com evidência)

**Hipótese refutada:** o parser. "Resposta sem JSON (ResponseEnvelope)" só é emitida quando o texto bruto é vazio (`envelope.py:444`, ramo `if not json_str`). Cerca ```json, thinking antes do JSON, texto ao redor e truncamento por `max_tokens` produzem outras mensagens.

**Evidência do dev (somente leitura):**
- `llm_call_ledger` do filho v4 (`85428bd3…`): as 9 chamadas `QA:validate_task` têm `output_tokens = 0`, `input_tokens` ≈ 35 mil, 1,8–3,2 s cada (3 reparos × 3 rodadas). Dev: 9 de 21 chamadas com `output_tokens = 0` desde 13:00; CTO 1 de 18; PM/Engineer 0.
- Log do `agents`: `[QA] Resposta recebida … tokens_out=0` em todas; nenhum `max_tokens`.

**Reprodução ao vivo (Bedrock, Sonnet 5.5, container `agents`, prompt real do QA + usuário real montado por `build_user_message`):**

| Variante | Resultado |
|---|---|
| Fluxo real (`run_agent`), instrução antiga | `stop_reason="refusal"`, `content=[]`, `output_tokens=0` |
| Mesmo prompt, instrução antiga, 3 repetições | `refusal` 3/3 |
| Mesmo prompt, só trocando a instrução por "Responda apenas com o JSON … dentro de `<response>`" | resposta normal 3/3 |
| Mesmo prompt, instrução sem tags, 3 repetições | resposta normal 3/3 |
| Cada parte isolada (charter, backlog, arquivos) | sem recusa — a causa é a instrução, não o conteúdo |
| Bloco de reparo antigo ("Use `<thinking>` para planejar…") | sem recusa 3/3 (por isso foi mantido) |
| Fluxo real com o código corrigido | `end_turn`, 1.956 tokens de saída, envelope validado (`QA_FAIL` legítimo: a reprodução não tinha arquivos da task) |

Conclusão: a instrução universal `runtime.py` ("Responda primeiro com seu raciocínio dentro de tags `<thinking>`…") faz o Sonnet 5.5 recusar a resposta. Efeito: QA 100 % e Dev ~43 % de respostas vazias; o reparo repetia o mesmo pedido 3 vezes (≈ US$ 0,21 por QA sem nenhuma saída).

**Custo da investigação:** ledger de US$ 20,462802 → US$ 20,679956 = **US$ 0,217** (teto autorizado US$ 1,50). Credencial usada: a do próprio container `agents` (sem token admin, sem imprimir segredo). Arquivos temporários removidos do container.

**Correções**
- `agents/runtime.py:421` `response_format_instruction()`: por padrão não pede raciocínio em tags; mantém o contrato `<response>` JSON. `GENESIS_ASK_THINKING_TAGS=1` restaura o texto antigo.
- `agents/runtime.py:2968` resposta sem texto vira erro próprio (`LLM_REFUSAL` ou `LLM_EMPTY_RESPONSE`), com marca `_refusal` / `_empty_response` no envelope e `validator_pass=false`; recusa repetida não gasta os demais reparos (`:3018`, 1 chamada + 1 reparo).
- `envelope.py:352` parser tolerante e seguro: prosa antes do JSON sem `<response>`/cerca é aceita só se houver um objeto JSON **bem formado com chave `status`**; o resultado segue pela validação de schema e de `artifacts[].path` (teste com `../../etc/passwd` continua reprovado).
- `runner.py:3404` `_qa_produced_verdict`: recusa, resposta vazia, `validator_pass=false` ou status `BLOCKED/FAIL` **não é revisão feita**. Em `runner.py:4844` isso não incrementa `qa_fail_count` (não aciona rework do Dev), reaciona o QA e, após `MAX_QA_NO_VERDICT` (padrão 2), marca a task `BLOCKED` com escalonamento "entrega NÃO validada" — nunca `DONE (não aprovada)`. `_is_qa_pass` (`:3421`) nunca aprova sem veredito (a busca de "ok" no summary casava "token").

## 3. D-3 — `TSK-FULL-TEST`

Estado real: o runner **já** gravava `ASSIGNED` no ramo manual (`runner.py` ~5750), mas o aceite do projeto fechava a task: `api-node/src/routes/projects.ts:847-855` (`UPDATE … SET status='DONE' … AND status NOT IN ('DONE','QA_PASS','CANCELLED')`). Por isso o banco mostra `DONE` exatamente na hora do aceite (14:06:10, 15:14:58, 16:14:35). O `schema` de `project_tasks` só admite `NEW, ASSIGNED, IN_PROGRESS, WAITING_REVIEW, QA_FAIL, QA_PASS, BLOCKED, DONE, CANCELLED` (`project_tasks_status_check`); não existe `SKIPPED`/`NOT_RUN`.

**Decisão:** usar o status existente **`CANCELLED`** para "não executada" (`runner.py:3363` `_declare_full_test_not_run`): é terminal, sobrevive ao fechamento do aceite (a cláusula exclui `CANCELLED`) e `cardDelivery.ts:241` não o conta entre as tasks "executadas" do card. O helper também grava `docs/qa/QA_REPORT_TSK-FULL-TEST.md` com "Veredito: NOT_RUN … NÃO é aprovação" e um passo de aviso explícito.

**Executar quando houver como:** o único executor existente é o `full-test-server` do host (`:7878`) — o mesmo que atende `/run-tests` (D-4). Sem ele não há sandbox alternativo; quando ele responde, o caminho executado já existia e segue inalterado (veredito estruturado, fail-closed).

**Não resolvido (api-node, fora do meu escopo):** se alguém promover `CANCELLED` a `DONE` fora do runner, nada no Python impede. O texto do PR (`api-node/src/services/evolutionAccept.ts:185`, D-13) ainda afirma "QA rodaram na fábrica" mesmo com QA sem veredito ou `TSK-FULL-TEST` `NOT_RUN`; sugestão para a frente do api-node: montar essa frase a partir dos fatos (`CANCELLED`/`BLOCKED` ⇒ "NÃO validada").

## 4. D-4 — baseline `/run-tests` com `Connection refused`

**Causa (ambiente, com evidência):** o runner chama o executor em `FULL_TEST_SERVER_URL=http://host.docker.internal:7878` (`docker-compose.yml:251-252`; `executor_bridge.py:48-53`). No container `runner`, `host.docker.internal` resolve (`172.17.0.1`, `extra_hosts: host-gateway`), mas **nada escuta em 7878**: `ss -ltn` no host não lista a porta e `socket.connect` do container devolve `[Errno 111] Connection refused`. O `scripts/full-test-server.py` é um **processo de host** (unit systemd só em prod, `scripts/genesis-full-test.service.template`), não um serviço do compose; no dev ninguém o inicia. O mesmo servidor atende `/run-full-test` (D-3).

**Mudança necessária fora do repositório versionado (override local/gitignored ou processo):** subir o FTS no host de dev, p.ex. `FTS_AUTH_TOKEN=<o mesmo valor do runner/api> FULL_TEST_PORT=7878 python3 scripts/full-test-server.py` (o servidor recusa tudo sem `FTS_AUTH_TOKEN`, `full-test-server.py:707`), ou apontar `FULL_TEST_SERVER_URL`/`UNTRUSTED_EXECUTOR_URL` do runner para um executor existente. Não editei compose nem subi o servidor.

**Código (versionado):**
- `runner.py:699` `_evo_p2p_unmeasured_reason`: baseline `status=error` numa evolução com código ⇒ motivo; `no_tests` (nada a comparar), baseline não tentada e `EVOLUTION_P2P_MODE=off` não reprovam. Opt-out explícito: `EVOLUTION_P2P_REQUIRED=0`.
- Na baseline: executor sem resposta (`None`) agora grava um erro de baseline declarado (antes não gravava nada); o passo vira "🔴 baseline NÃO MEDIDA … o TSK-FULL-TEST será REPROVADO" e dispara escalonamento.
- Veredito final (`runner.py:5860`): `TSK-FULL-TEST` só é `DONE` se o P2P foi medido (ou dispensado explicitamente); senão `QA_FAIL` com o motivo "gate P2P sem medição".
- Efeito colateral intencional: no dev sem FTS toda evolução passa a reprovar o full-test em vez de seguir com "não-regressão desativada".

## 5. D-1 — Cyborg fora do gate de escopo

- Causa confirmada: `autonomous_rework` gravava direto (`write_apps_artifact`) sem passar por `_evolution_scope_check`. Além disso, o próprio gate do Dev **não via spec reduzida**: `**/*.spec.*` é sempre permitido (`_EVO_ALWAYS_ALLOWED`) e testes não exportam símbolos.
- `runner.py:516,558`: regra nova, compartilhada pelo Dev e pelo Cyborg, "spec/teste existente não perde casos" (`it`/`test`/`def test_`/`func Test`), violação `TESTES REDUZIDOS em apps/…`.
- `cyborg_v3.py:1202,1221`: `_cyborg_evolution_scope` lê `extra.evolution_scope` do projeto (API) e `cyborg_scope_gate` reaproveita `runner._evolution_scope_check` (mesmo critério do Dev). Em `cyborg_v3.py:1738` o gate roda **antes de gravar**; artefato rejeitado não é gravado, a violação vai para o diálogo, para `scope_violations` no retorno de `autonomous_rework` e para `docs/cyborg/scope_violations.json`; a rodada seguinte recebe o escopo e as violações no prompt (`:1633`). Sem escopo (não-evolução) = passthrough, como no Dev. API indisponível ⇒ gate não avaliado com `logger.error` (falha aberta, alto no log).
- Teste de integração (`test_d1_autonomous_rework_nao_grava_fora_do_escopo`) roda o loop real com a fixture do PR #1: só `health.controller.ts` é gravado; validator de produção e spec reduzido ficam intactos; 2 violações registradas.
- **Limite:** `evolution-state.violations` lê o checkpoint do runner (`evolutionPlan.ts:94`), volume que o container do Cyborg não monta; por isso a evidência do Cyborg fica no arquivo e no diálogo. Para aparecer no painel, o api-node precisaria ler `docs/cyborg/scope_violations.json` (sugestão para a frente do api-node).

## 6. D-10 — herança transitiva (só leitura)

`TASK_INHERIT_TRANSITIVE` é uma flag booleana resolvida por tenant (`featureFlags.ts:36,144`; o runner a recebe via `/effective-flags`, `runner.py:4124-4127`, e só herda tasks `TSK-INH-*` do pai quando ligada, `runner.py:4182`). `genesis_runtime_config` não tem linha dela para o tenant e2e (0 linhas) ⇒ desligada ⇒ o v3 herdou 1 de 21. É decisão de flag, sem defeito de código. **Recomendação:** ligar para o tenant e2e antes da próxima rodada, pela mesma rota usada para `CARDS_BANCADA` (`PUT /api/admin/runtime-config/TASK_INHERIT_TRANSITIVE {"value":1,"tenantId":"<e2e>"}`, valor inteiro, não `"on"` — D-8), e só depois reavaliar a contagem herdada.

## 7. Verificação

Baseline Python em worktree limpo (`/tmp/pyv`, `pytest applications/orchestrator/tests`): **23 falhas, 1226 aprovados, 2 ignorados**. Depois: **23 falhas, 1245 aprovados, 2 ignorados**; `diff` das listas de falhas (`FAILED …`, ordenadas) **idêntico**. Os +19 são os testes novos de `tests/test_aq_correcoes_qa_escopo_baseline.py`.

**Mutação** (stash dos 4 arquivos de código, testes mantidos): **16 dos 19** testes novos falham sem a correção; os 3 que passam são controles (flag restaura a instrução antiga; spec que cresce é aceita; objeto JSON sem `status` continua rejeitado).

## 8. O que não foi possível resolver ou ficou de fora

1. `projects.ts:847` (aceite fecha `TSK-FULL-TEST`) e `evolutionAccept.ts:185` (texto do PR) — api-node, frente `evo/q2`.
2. Subir o `full-test-server` no host de dev (processo/override local) — sem isso toda evolução reprova o full-test por design, agora de forma explícita.
3. `evolution-state.violations` não enxerga o Cyborg (volume do checkpoint não montado no container dele).
4. Achado paralelo, não corrigido: `thinking={"type":"disabled"}` é recusado pelo Sonnet 5.5 no Bedrock (HTTP 400: "send `between_tools`"); o runtime já refaz sem o parâmetro (`_thinking_extra`/`_is_thinking_param_error`), portanto cada chamada paga uma ida extra. Merece ajuste do mapeamento por modelo.
5. Os caminhos `call_bedrock_direct` / `_call_converse` (Cyborg, advisor) não tratam `stop_reason="refusal"`; o Cyborg já reintenta em resposta vazia, mas não distingue a causa.
6. A reprodução do QA usou o Bedrock do container `agents` com a credencial do ambiente, não o slot cifrado do tenant e2e (o token admin em `/tmp/adm.tok` não foi necessário).
7. O texto de bloco de reparo ("Use `<thinking>`…") foi mantido: testado ao vivo, não provoca recusa.
