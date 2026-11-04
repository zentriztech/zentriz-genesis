> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO-AW — Correções do parecer AV no orchestrator (A-1, A-3, A-4)

Branch `evo/s1`, escopo `applications/orchestrator/**`. Parecer de origem: `EVOLUIR-PROJETO-AV-parecer-final-programa.md`.

## Resultado

| Medida | Antes | Depois |
|---|---|---|
| pytest `applications/orchestrator/tests` | 23 falhas / 1266 passam / 2 skipped | 23 falhas / **1324** passam / 2 skipped |
| Lista das 23 falhas (ambiente) | — | **idêntica** (diff vazio) |
| Testes novos | — | 57 (14+1 de caos em `test_av_a3_runner_chaos.py`, 43 em `test_av_a1_a4_correcoes.py`) |

Três testes existentes foram ajustados (contrato novo, não afrouxamento): `_ctx` de `test_aq_correcoes_qa_escopo_baseline.py` e `test_n3_n4_n5_n7_orchestrator.py` agora representa filho de card; `test_attachments_inherit_f2.py::test_m03_fetch_efetivo_*` filtra a chamada de `/effective-flags` e declara o projeto como card para o trecho fail-closed.

## A-1 — `_is_qa_pass` (runner.py:3526)

Aprovação só pelo veredito estruturado (`status`, ou `verdict` se o status vier vazio), normalizado em tokens inteiros (`QA_PASS` → qa, pass). `summary` nunca promove a PASS. Token de reprovação/negação (`fail`, `nok`, `not`, `no`, `rejected`, `blocked`...) vence qualquer token de aprovação. "token", "broken", "book", "not ok", "NOK", "bypass" não aprovam. Efeito colateral intencional: o QA_FAIL forçado pelo fingerprint T-08 ("missing strong tokens") deixa de ser neutralizado.

## A-3 — caos do runner (`test_av_a3_runner_chaos.py`)

API falsa em memória reproduzindo `routes/projects.ts:590-640` (transação única, upsert, `COALESCE(card_id)`, preservação de terminais, flag, regra B-3). Kill = exceção `BaseException` no meio de cada etapa.

| Cenário | Testes | Resultado |
|---|---|---|
| C8 (BACKLOG→seed→herança) | kill antes/durante o POST do seed; kill entre seed e herança; restart com terminal no TaskState | Sem duplicar, `card_id` em EVO+FULL-TEST, TSK-INH DONE intactas. **Defeito achado e corrigido**: `completed_tasks` só recebia as TSK-INH na 1ª passada; kill antes do checkpoint as perdia para sempre (`_register_inherited_completed`, runner.py:4403; usado nos dois caminhos) |
| C9 (POST parcial 4xx/5xx) | API não atômica grava 1 task e devolve 500 | **Defeito**: `seed_ok` virava True se "já existem tasks" (backlog parcial seguia em silêncio). Corrigido para filho de card: `_seed_is_complete` (runner.py:4512) + 1 retry; falhando, projeto `failed` |
| C10 (consolidação GAP-NEW-3) | kill entre criar TRIVIAL e cancelar; falha/kill ao criar; card nunca consolida; vínculo | **Defeito**: cancelava as originais ANTES de criar a TRIVIAL; kill no meio = zero tasks ativas e projeto "concluído" sem trabalho. Nova `_consolidate_trivial_tasks` (runner.py:4479) cria primeiro, cancela depois, é retomável (`_trivial_consolidation_pending`) e nunca regride TRIVIAL existente; falha ao criar não cancela nada. Os dois caminhos do runner usam a função |
| C11 (flag no meio da run) | ligada: tasks antigas completam via COALESCE; desligada: vínculo preservado; sem card o seed não envia `card_id: null` | Correto, sem alteração de código |
| C13 (card religado) | runner do filho antigo posta task nova após o religamento | Task fica sem vínculo e não conta para o card novo (arbitragem da API B-3; o runner não polui). Sem alteração de código |

## A-4 — decisão: regra nova só para filho de card

Filho de card = `extra.evolution_origin == "card"` (`_is_card_child`, runner.py:710; também `pipeline_ctx.is_card_child`/`card_id`). Legado e projetos comuns voltam ao comportamento anterior. Override por env em `_a4_rule_applies` (runner.py:741): `card` (padrão) | `all` | `off`.

| Regra | Card | Legado/comum | Env |
|---|---|---|---|
| (a) QA sem veredito ⇒ BLOCKED (runner.py:5035) | BLOCKED | segue o ramo anterior (QA_FAIL/rework; nunca aprova) | `QA_NO_VERDICT_BLOCKS=card\|all\|off` |
| (b) baseline P2P não medida reprova (runner.py:753) | reprova | só aviso, como antes | `EVOLUTION_P2P_REQUIRED=0` (opt-out global, mantido); `EVOLUTION_P2P_REQUIRED_LEGACY=1` liga no legado |
| (c) teto de contexto 1,5 MB/3000 (`context_files.py`, param `enforce_ceiling`; runner.py:5256, 5569) | `ContextTooLargeError` | sem erro de teto; a poda de node_modules/dist continua para todos | `CONTEXT_CEILING_ENFORCE=card\|all\|off`; limites `CONTEXT_MAX_*` inalterados |
| (d) `/effective-flags` indisponível (runner.py:1105) | `SpecReadError` (fail-closed; card desconhecido por falha da API também fecha) | degrada para flag `off`, projeto segue | `EFFECTIVE_FLAGS_FAIL_CLOSED=card\|all\|off` |
| (extra) seed parcial (C9) | retry + `failed` | "continuando" como antes | `SEED_PARTIAL_STRICT=card\|all\|off` |

Fora de A-4 e não alterado: `CYBORG_TREE_GATE` (cyborg_v3.py) e `TSK-FULL-TEST`→CANCELLED ficam para decisão do orquestrador.

## O que muda em produção

- QA: reprovações com "ok"/"token" no resumo deixam de virar DONE (todos os projetos; correção de defeito).
- Legado/comum: sem bloqueio por QA sem veredito, sem reprovação por baseline não medida, sem erro de teto de contexto, sem `failed` por `/effective-flags` fora. Atenção: no legado, "QA sem veredito" volta a ser QA_FAIL (rework), não aprovação.
- Consolidação trivial: ordem criar→cancelar (estado final idêntico quando não há falha).
- Se a API estiver fora e o runner não conseguir dizer se o filho é card, regras de leitura da spec fecham (fail-closed).
- Nenhuma variável nova exige configuração; todos os padrões são os descritos acima.

## Mutação (testes novos falham sem a correção)

Código de produção revertido ao HEAD: 29 falhas + 9 erros de 57; os 19 que passam são controles positivos ou caracterizações. Mutações pontuais confirmam sensibilidade: (M1) `_link_tasks_to_card` desligado derruba 8 testes de C8/C9/C10/C11/C13; (M2) TaskState desligado derruba `test_c8_restart_preserva_status_terminal...`; (M3) seed sempre True derruba os 2 de C9; (M4) `summary` promovendo PASS derruba 17 de A-1. Os 11 casos `test_a1_veredito_estruturado_aprova[*]` e `test_c9_seed_5xx_sem_nenhuma_task...`, `test_c8_kill_entre_*`, `test_c11_seed_sem_card...` são caracterizações do comportamento correto que já existia (passam no HEAD por desenho; protegem contra regressão e super-correção).

## Limites

Caos simulado em processo com API falsa; não foi rodado contra Postgres real nem contra o runner em container. A semântica da API foi copiada de `projects.ts` por leitura, sem execução.
