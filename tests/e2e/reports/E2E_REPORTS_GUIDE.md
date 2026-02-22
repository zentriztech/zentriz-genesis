# Guia dos relatórios E2E — Para análise por outra IA

Este documento descreve o que são os testes E2E do pipeline, como são executados, o que cada arquivo de relatório contém e onde encontrá-los. Use-o junto com os arquivos em `tests/e2e/reports/` para pedir ajuda externa (outra IA ou pessoa).

---

## 1. O que são os testes E2E

Testes **end-to-end** do pipeline de agentes: uma spec de produto (landing page estática) é enviada ao **CTO**, que gera um **PRODUCT_SPEC**; em seguida **Engineer** propõe arquitetura, **CTO** valida e gera **Charter**, **PM** gera **backlog**, e por fim **Dev** e **QA** executam as primeiras tarefas do backlog. Cada etapa chama um serviço HTTP (agents na porta 8000), que por sua vez chama o **Claude** (API Anthropic).

- **Spec de teste:** `project/spec/spec_landing_zentriz.txt` (landing page institucional Zentriz, sem backend).
- **Referência completa:** `project/docs/E2E_PIPELINE_TEST_GUIDE.md`.

---

## 2. Como os testes são feitos

### 2.1 Estrutura

- **Arquivo principal:** `tests/e2e/test_pipeline_landing.py` (pytest, assíncrono).
- **Validadores:** `tests/e2e/validators/` — um módulo por tipo de artefato (product_spec, engineer_proposal, charter, backlog, dev_output, qa_report).
- **Contexto compartilhado:** fixture `ctx` (módulo) acumula saídas de cada fase (product_spec, engineer_proposal, charter, backlog, tasks, artifacts) para as fases seguintes.

### 2.2 As 7 fases (em ordem)

| # | Teste | O que faz | Validação |
|---|--------|-----------|-----------|
| 1 | `test_01_cto_spec_intake` | CTO recebe spec TXT, gera PRODUCT_SPEC.md | status=OK, artifact com seções/FRs/NFRs, sem placeholders |
| 2 | `test_02_engineer_propose` | Engineer recebe product_spec, gera proposta técnica | status=OK, 1 squad, stack definida, referência a FRs |
| 3 | `test_03_cto_validate_engineer` | CTO valida proposta do Engineer | status=OK ou REVISION (aqui aceitamos OK em 1 rodada) |
| 4 | `test_04_cto_charter` | CTO gera Project Charter | status=OK, charter com visão, squads, escopo |
| 5 | `test_05_pm_backlog` | PM gera backlog de tarefas | status=OK, ≥3 tasks com acceptance_criteria, depends_on_files |
| 6 | `test_06_dev_qa_loop` | Para as 3 primeiras tasks: Dev gera código → QA valida; retry 1x se QA_FAIL | Dev status=OK, artifacts sem placeholders; ≥50% tasks com QA_PASS |
| 7 | `test_07_final_summary` | Resumo e gravação dos artefatos em `tests/e2e/output/e2e-landing-test/` | Garante que ctx tem product_spec, charter, backlog e ≥1 task concluída |

Cada fase envia um **POST** para `http://127.0.0.1:8000/invoke/{cto|engineer|pm|dev|qa}` com body JSON (project_id, mode, task, **inputs**, **input**). O runtime dos agentes espera o payload em `message.input` ou `message.inputs`; por isso o teste envia ambos com o mesmo conteúdo.

### 2.3 Pré-requisitos

- **Agents** rodando na porta 8000 (ex.: `./start-agents-host.sh`).
- **CLAUDE_API_KEY** configurada (o agents usa para chamar a API Anthropic).
- Antes de rodar, a fixture `check_agents_health` faz GET em `{AGENTS_URL}/health`; se não houver 200 com `claude_configured: true`, **todos os testes são SKIPPED** (não falham).

### 2.4 Timeouts e retry

- Timeouts por agente no teste: **600 s** (cto, engineer, pm, dev, qa), 300 s (monitor).
- O teste faz **1 retry** em caso de `ReadTimeout`/`ConnectTimeout` na chamada HTTP.

---

## 3. Formas de execução

### 3.1 Execução em fases (recomendada): `run_phased.py`

```bash
# Na raiz do repositório
python tests/e2e/run_phased.py
```

- Roda pytest com **-x** (para na primeira falha).
- Se **todos** os testes forem **SKIPPED** (agents não rodando): exibe aviso e termina; **não** gera `e2e_failure_log_*.txt`.
- Se um teste **falhar**: aplica correções automáticas (ex.: aumentar timeout) e **repete** até **3 tentativas** para a **mesma fase**.
- Após **3 falhas** na mesma fase: gera `tests/e2e/reports/e2e_failure_log_YYYYMMDD_HHMMSS.txt` e encerra (para uso com ajuda externa).

### 3.2 Execução direta (pytest)

```bash
pytest tests/e2e/test_pipeline_landing.py -v -s --junitxml=tests/e2e/reports/junit.xml
```

- Roda os 7 testes em ordem; não para na primeira falha (a menos que use `-x`).
- Grava relatório JUnit em `tests/e2e/reports/junit.xml`.

---

## 4. Arquivos de relatório (todos em `tests/e2e/reports/`)

| Arquivo | Quando é gerado | Conteúdo |
|---------|------------------|----------|
| **junit.xml** | Sempre ao final de uma execução do pytest (por `run_phased.py` ou pelo comando pytest acima). | Relatório JUnit: suite, testcases, status (passed/failed/skipped), tempo, mensagem de falha dentro de `<failure>`. |
| **summary_YYYYMMDD_HHMMSS.txt** | Ao final da sessão pytest, por hook em `tests/e2e/conftest.py` (pytest_sessionfinish). | Resumo em texto: data, exit status, totais (passed/failed/skipped), caminho do junit.xml. |
| **summary_last_run.txt** | Criado manualmente/por script como resumo da última execução (não é sobrescrito automaticamente a cada run). | Texto livre descrevendo última corrida e correções aplicadas. |
| **e2e_failure_log_YYYYMMDD_HHMMSS.txt** | **Somente** quando `run_phased.py` falha **3 vezes** na **mesma fase** (ex.: test_01 três vezes). | Data, nome do teste que falhou, número de tentativas, trecho do erro, saída completa (últimos 15k chars), AGENTS_URL, spec e guia. **É o principal artefato para enviar a outra IA.** |
| **README.md** | Documentação estática da pasta. | Lista dos arquivos e comandos para gerar relatórios. |

---

## 5. Onde estão os arquivos

- **Pasta de relatórios:** `tests/e2e/reports/`
  - Caminho absoluto típico: `{repositório}/tests/e2e/reports/`
- **Saída de artefatos do pipeline (quando test_07 passa):** `tests/e2e/output/e2e-landing-test/`  
  - PRODUCT_SPEC.md, TECHNICAL_PROPOSAL.md, PROJECT_CHARTER.md, BACKLOG.md e arquivos de código gerados pelo Dev.

---

## 6. Referências para outra IA

- **Este guia:** `tests/e2e/reports/E2E_REPORTS_GUIDE.md`
- **Guia completo do E2E (fluxo, validadores, diagnóstico):** `project/docs/E2E_PIPELINE_TEST_GUIDE.md`
- **Spec de teste:** `project/spec/spec_landing_zentriz.txt`
- **Teste principal:** `tests/e2e/test_pipeline_landing.py`
- **Runner em fases:** `tests/e2e/run_phased.py`
- **Análise de comunicação agentes/LLM:** `project/docs/AGENT_LLM_COMMUNICATION_ANALYSIS.md`

Ao pedir ajuda, anexe ou cite:
1. **E2E_REPORTS_GUIDE.md** (este arquivo)
2. **junit.xml** (sempre que houver uma execução)
3. **e2e_failure_log_*.txt** (se existir — indica falha após 3 tentativas na mesma fase)

Isso permite à outra IA entender o fluxo, os relatórios e o contexto da falha.
