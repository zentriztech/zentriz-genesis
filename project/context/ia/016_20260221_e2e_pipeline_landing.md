# 016 — Teste E2E do Pipeline (Landing Page Zentriz)

**Data**: 2026-02-21  
**Fonte**: [project/docs/E2E_PIPELINE_TEST_GUIDE.md](../docs/E2E_PIPELINE_TEST_GUIDE.md)

## Objetivo

Implementar e executar testes end-to-end do pipeline de agentes usando a spec de **landing page estática** (Zentriz), conforme guia E2E. Spec de teste: **project/spec/spec_landing_zentriz.txt**.

## O que foi feito

### 1. Estrutura de testes E2E

- **tests/e2e/** (na raiz do repositório):
  - **test_pipeline_landing.py**: teste principal em 7 etapas (CTO spec → Engineer → CTO validate → CTO charter → PM backlog → Dev/QA loop → resumo).
  - **conftest.py**: paths (repo root, spec em project/spec), config.
  - **validators/**:
    - validate_product_spec.py
    - validate_engineer_proposal.py
    - validate_charter.py
    - validate_backlog.py
    - validate_dev_output.py
    - validate_qa_report.py

### 2. Spec utilizada

- **project/spec/spec_landing_zentriz.txt** — landing page institucional Zentriz (single page, hero, sobre, serviços, diferenciais, contato, footer; sem backend, sem formulário; Next.js estático ou HTML/CSS/JS).

### 3. Fluxo coberto pelo E2E

1. **test_01_cto_spec_intake**: CTO converte spec TXT → PRODUCT_SPEC.md (valida seções, FRs ≥5, NFRs ≥3, keywords).
2. **test_02_engineer_propose**: Engineer propõe arquitetura (1 squad Web, stack, referência a FRs).
3. **test_03_cto_validate_engineer**: CTO valida proposta (OK ou REVISION).
4. **test_04_cto_charter**: CTO gera PROJECT_CHARTER.md (visão, squads, escopo).
5. **test_05_pm_backlog**: PM gera BACKLOG com ≥3 tasks (acceptance criteria, depends_on_files, estimated_files).
6. **test_06_dev_qa_loop**: Loop Dev → QA para as 3 primeiras tasks (retry 1x se QA_FAIL); exige ≥50% tasks aprovadas.
7. **test_07_final_summary**: Resumo e gravação dos artifacts em tests/e2e/output/e2e-landing-test/.

### 4. Pré-requisitos para rodar

- **Agents service** rodando na porta 8000 (`./start-agents-host.sh` ou `docker compose up agents`).
- **CLAUDE_API_KEY** configurada (health retorna `claude_configured: true`).
- Dependências: `pytest`, `pytest-asyncio`, `httpx`.

### 5. Execução (2026-02-21)

- Comando: `pytest tests/e2e/test_pipeline_landing.py -v -s`
- **Resultado**: 7 testes **SKIPPED** — agents service não estava rodando (fixture `check_agents_health` faz skip com mensagem orientando a subir o serviço).
- A suíte está **implementada e pronta**; para rodar com LLM real é necessário subir o agents e rodar novamente.

### 6. Como executar quando agents estiver rodando

```bash
# Health
curl -s http://127.0.0.1:8000/health | python -m json.tool

# E2E completo (vários minutos; chamadas reais ao Claude)
pytest tests/e2e/test_pipeline_landing.py -v -s

# Apenas até PM (mais rápido e barato)
pytest tests/e2e/test_pipeline_landing.py -v -s -k "not test_06 and not test_07"

# Uma etapa
pytest tests/e2e/test_pipeline_landing.py -v -s -k "test_01"
```

## Referências

- **Guia**: [docs/E2E_PIPELINE_TEST_GUIDE.md](../docs/E2E_PIPELINE_TEST_GUIDE.md) — estrutura, validadores, diagnóstico, critérios de sucesso.
- **Análise de comunicação**: [docs/AGENT_LLM_COMMUNICATION_ANALYSIS.md](../docs/AGENT_LLM_COMMUNICATION_ANALYSIS.md).
- **Contextos anteriores**: 001–015 (plano, 12 Leis, checklists, runner, checkpoint).
