# Métricas de Performance — Zentriz Genesis

> **Propósito**: Targets numéricos explícitos para latência, throughput, cobertura e qualidade.  
> **Inspirado em**: Projeto de agentes educacionais (latência <2s, 50+ QPS, 85%+ cobertura).

---

## 1. Métricas por Camada

### 1.1 API / Backend (produtos gerados)

| Métrica | Target | Referência |
|---------|--------|------------|
| **Latência p95** | < 500ms | NFR-01 (spec/PRODUCT_SPEC.md) |
| **Latência p99** | < 1s | Recomendado |
| **Throughput** | 50+ req/s por endpoint | Baseline |
| **Disponibilidade** | 99.5% | SLA mínimo |

### 1.2 Agentes (sistema de orquestração)

| Métrica | Target | Notas |
|---------|--------|-------|
| **Tempo de resposta por agente** | < 30s (média) | Por task |
| **Lead time por task** | < 5 min (objetivo) | Spec → evidência |
| **Taxa de QA_FAIL** | < 20% | Retrabalho |
| **Throughput** | 10+ tasks/hora (por squad) | Paralelização |

### 1.3 Testes

| Métrica | Target | Referência |
|---------|--------|------------|
| **Cobertura unitária** | > 80% | Por módulo |
| **Cobertura por FR** | 100% | Cada FR tem teste |
| **Smoke tests** | 100% pós-deploy | tests/smoke/ |
| **Testes automatizados** | PASS em CI | DoD global |

### 1.4 Qualidade de Código

| Métrica | Target | Ferramentas |
|---------|--------|-------------|
| **Lint** | 0 erros | ESLint, Ruff, etc. |
| **Typecheck** | 0 erros | TypeScript, mypy |
| **Build** | PASS | CI pipeline |
| **Secrets** | 0 hardcoded | DoD global |

---

## 2. Métricas de Projeto (Observabilidade)

Conforme `business/OBSERVABILITY_FINOPS.md`:

| Métrica | Descrição |
|---------|-----------|
| **Tempo total** | Spec → produção (lead time end-to-end) |
| **% FR/NFR cobertos** | Requisitos atendidos com evidência |
| **Falhas por módulo** | QA_FAIL, deploy failures |
| **Custo por módulo** | FinOps por cloud/agente |

---

## 3. Eventos Monitorados

- `task.assigned`
- `task.completed`
- `qa.failed`
- `devops.deployed`
- `monitor.alert`

---

## 4. Saídas Esperadas

- Dashboards (quando implementado)
- Relatórios automáticos (QA Report, Monitor Health)
- Alertas de ineficiência (Monitor Agent)

---

## 5. Evolução Futura

- **CQA Engine**: Avaliação automatizada de qualidade (inspirado no projeto educacional)
- **Métricas em tempo real**: Integração com CloudWatch, App Insights, Cloud Logging
- **SLOs/SLIs**: Service Level Objectives por agente

---

*Documento criado em 2026-01-29 — Zentriz Genesis*
