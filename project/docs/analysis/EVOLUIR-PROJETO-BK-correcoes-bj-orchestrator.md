> **Jean Ol'Bar** — AI Engineer · jean@zentriz.com.br

# EVOLUIR-PROJETO-BK — correções dos achados do parecer BJ (orchestrator Python)

Branch `evo/x1`. Escopo: `applications/orchestrator/**`. Sem chamadas reais a LLM/executor/rede nos testes.

## O que mudou

| Achado | Correção | Onde |
|---|---|---|
| **B-N1** (bloqueante) | Com executor REMOTO (`UNTRUSTED_EXECUTOR_URL` ≠ FTS local) e `/cyborg-build` ≠ 200 (ou exceção de transporte), NÃO há `npm install`/`tsc`/build locais. `_collect_context` marca `executor_blocked`; `run_prior_audit` levanta `CyborgEnvBlocked` ANTES de qualquer LLM; `_run_cyborg_v3_impl` converte em `needs_human` com a causa ("Nenhuma rodada de LLM foi paga"). Sem executor remoto: build local legado. | `cyborg_v3.py:411` (`local_build_fallback_allowed`), `:568`, `:966`, `:2824` |
| **A-N1/W2** | Filho de card não chama `spawn_engineer` (`/cyborg-engineer`): o veredito sai só da auditoria escopada ao delta (caminho BG). Legado inalterado (ponte + `CYBORG_DONE`). Menor mudança segura: nenhum briefing novo é necessário. | `cyborg_v3.py:2888` |
| **W3/D-19** | Aceite de filho de card (`evaluate_audit_acceptance(..., card=...)`): `build_rc` ≠ 0 (inclui −1) não aceita; erros de `tsc` NOVOS vs. pai (comparação por `arquivo\|TSnnnn\|mensagem`, sem linha/coluna) não aceitam; erro de `tsc` sem baseline do pai medida não aceita (falha fechada); FULL-TEST reprovada por código (`medida_falhou`/regressões/`approved=false`) não aceita; FULL-TEST NOT_RUN/não medida (infra) só registra (nota no motivo) — o merge segue travado por confirmação humana. Legado: `card=None`, byte a byte como antes. | `cyborg_v3.py:2712` (`card_acceptance_inputs`), `:2752` (`parse_ts_errors`), `:2771`; `runner.py:3488` (`full_test_verdict.json`) |
| **A-N3** | Só filho de card: gate de árvore do Cyborg (remove/restaura lockfile), FULL-TEST NOT_RUN ⇒ `CANCELLED` (legado: `ASSIGNED`, como antes), e `/effective-flags` fora do ar no início ⇒ run falha (legado: flag off, como antes). | `cyborg_v3.py:2594`; `runner.py:3501`; `runner.py:1120` |

Contexto novo persistido: `audit.json → build.type_check_errors` (lista normalizada dos erros de `tsc` do filho; o pai é lido do seu `audit.json` ou medido pelo executor) e `docs/qa/full_test_verdict.json` (escrito pelo runner no veredito e no NOT_RUN).

## Variáveis de ambiente (novas ou com semântica alterada)

| Variável | Padrão | Efeito |
|---|---|---|
| `CYBORG_ALLOW_LOCAL_BUILD_FALLBACK` | `0` | `1` permite build local no container do Cyborg mesmo com executor remoto (NÃO recomendado: o container tem `.env`, token admin e `docker.sock`). |
| `CYBORG_TREE_GATE` | `card` (era `on` para todos) | `card` só filho de card (origem desconhecida/API fora ⇒ ligado); `on`/`all` todo projeto; `off` desliga. |
| `FULL_TEST_NOT_RUN_CANCELS` | `card` | `card`/`all`/`off`: NOT_RUN ⇒ `CANCELLED`; fora disso a task segue `ASSIGNED`. |
| `EFFECTIVE_FLAGS_UNKNOWN_FAIL_CLOSED` | `0` | `1`: origem desconhecida (API fora) falha fechado em `attachmentsStrict`. Padrão: degrada como antes. Card já conhecido (cache/pipeline) continua falhando fechado. |

## O que muda em produção

- Host B caído: o Cyborg de card termina `needs_human` (causa visível no diálogo e em `reason`), sem gasto de LLM e sem executar código gerado no container `cyborg`. Antes: build local no container.
- Cards: o Cyborg nunca abre a sessão de engenheiro; cards com BLOCKER no delta vão a `needs_human` (já era a regra D-13 para escalação). Card com `build_rc=-1`, erro de tipos novo ou FULL-TEST reprovada por código deixa de ser "delivered".
- Projetos legados/comuns: gate de árvore deixa de rodar por padrão (volta ao comportamento pré-N-3); NOT_RUN deixa a task `ASSIGNED`; API fora no início não derruba a run. `CYBORG_TREE_GATE=on` restaura o gate para todos.

## Testes e contagens

Arquivo novo `applications/orchestrator/tests/test_bk_correcoes_bj.py` (19 testes); `test_aq_correcoes_qa_escopo_baseline.py::test_d3_full_test_nao_executada_fica_cancelled_nunca_done` passou a informar `pipeline_ctx` de card (o CANCELLED agora é só de card).

| | orchestrator | scripts/tests |
|---|---|---|
| antes (worktree limpo) | 23 falhas / 1373 passam / 2 skip | 60 passam |
| depois | 23 falhas (lista IDÊNTICA, `diff` vazio) / 1392 passam / 2 skip | 60 passam |

Mutação: com as fontes revertidas (`git checkout HEAD`) 17 dos 19 testes novos falham (os 2 que passam provam o legado inalterado). Mutações pontuais: fallback sempre permitido ⇒ 3 falham; ponte sempre usada ⇒ 3; `build_rc=-1` permissivo no card ⇒ 1; tree gate sempre ligado ⇒ 1.

## Limites

- Baseline de `tsc` do pai: vem do `audit.json` do pai; se ausente, mede pelo `/cyborg-build` do pai (até ~6 min extras e só quando o filho tem erros de tipos). Não medida ⇒ não aceita.
- Erros de `tsc` truncados pelo executor (saída muito longa) podem subestimar o conjunto; o filho é comparado só com o que foi listado.
- `full_test_verdict.json` só existe se o runner novo rodou a FULL-TEST; ausente ⇒ sem restrição (merge segue travado por humano).
- `approved=false` do agente na FULL-TEST sem medição estruturada é tratado como falha de código (conservador).
- Origem de card desconhecida em `_is_card_run` (API ilegível, sem delta gravado) ⇒ trata como legado no aceite/ponte.
- Não validado contra Host B real nem em produção; sem deploy.
