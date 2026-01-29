# Práticas de Outros Projetos — Análise e Recomendações

> **Origem**: Análise do projeto de agentes de IA para consulta educacional (Knowledge Agent + DidacticResponseAgent).  
> **Objetivo**: Identificar práticas aplicáveis ao Zentriz Genesis.

---

## 1. Práticas do Projeto Educacional (Resumo)

| Prática | Projeto Educacional | Zentriz Genesis (atual) |
|---------|---------------------|--------------------------|
| **Protocolos de comunicação** | REST, MCP, A2A | Event-driven (schemas JSON) |
| **Base de conhecimento** | Índice JSON (keywords, conceitos, glossário) | context/, docs/, spec/ |
| **Qualidade de código** | CQA engine, 184 testes, >85% cobertura | Smoke tests, DoD com lint/test |
| **Documentação** | ADRs, RFCs, guias consolidados | docs/ diversos, sem ADR/RFC |
| **Métricas de performance** | Latência <2s, 50+ QPS | NFR-01 p95 <500ms (spec) |
| **Scripts de manutenção** | Geração de índices, validação, relatórios | CI/CD workflows |
| **Pipeline explícito** | Query → Knowledge → Didactic → Response | CTO → PM → Dev/QA/DevOps → Monitor |

---

## 2. Práticas Recomendadas para Adoção

### ✅ 2.1 ADRs (Architecture Decision Records)

**O que é**: Documentos que registram decisões arquiteturais com contexto e consequências.

**Por que adotar**: Zentriz Genesis tem decisões importantes (spec-driven, event-driven, cloud-agnostic) que não estão formalmente documentadas. ADRs preservam o "porquê" para futuros desenvolvedores e chats.

**Implementado**: [docs/adr/](../docs/adr/) com template e ADRs iniciais.

---

### ✅ 2.2 RFCs (Request for Comments)

**O que é**: Propostas formais para mudanças significativas antes da implementação.

**Por que adotar**: O projeto tem "próximos passos" (Dashboard, Orchestrator real, SaaS). RFCs permitem discutir e aprovar propostas antes de codificar.

**Implementado**: [docs/rfc/](../docs/rfc/) com template.

---

### ✅ 2.3 Documentação Consolidada de Agentes

**O que é**: Um único documento listando todos os agentes e suas capacidades.

**Por que adotar**: O projeto educacional tinha documentação consolidada. Zentriz tem 20+ agentes em pastas separadas — um índice facilita onboarding e referência.

**Implementado**: `docs/AGENTS_CAPABILITIES.md`.

---

### ✅ 2.4 Métricas de Performance Explícitas

**O que é**: Targets numéricos para latência, throughput, cobertura de testes.

**Por que adotar**: O projeto educacional tinha latência <2s, 50+ QPS, 85%+ cobertura. Zentriz tem NFR-01 (p95 <500ms) no spec, mas não tem métricas consolidadas para o sistema de agentes.

**Implementado**: [docs/PERFORMANCE_METRICS.md](../docs/PERFORMANCE_METRICS.md) com targets por camada.

---

### ✅ 2.5 Scripts de Manutenção

**O que é**: Scripts para validação, geração de índices, relatórios, provisionamento.

**Por que adotar**: O projeto educacional tinha scripts para índice, validação, testes de protocolos. Zentriz pode ter scripts para validar spec, schemas, contratos.

**Implementado**: `scripts/` com README e estrutura inicial.

---

### 🔄 2.6 Índice Estruturado (JSON)

**O que é**: Índice JSON com keywords, conceitos, mapeamento de documentos.

**Por que adotar**: O projeto educacional tinha `indice-ia.json` para busca inteligente. Zentriz tem [context/PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) — um índice JSON poderia permitir busca programática e integração com LLMs.

**Status**: Recomendado para fase posterior (quando houver execução real do Orchestrator).

---

### 🔄 2.7 MCP (Model Context Protocol)

**O que é**: Protocolo para integração de LLMs com ferramentas e contexto.

**Por que adotar**: O projeto educacional usava MCP para integração com LLMs. Zentriz poderia expor agentes via MCP para que LLMs consumam o sistema.

**Status**: Recomendado para fase posterior (Dashboard, execução real).

---

### 🔄 2.8 CQA (Code Quality Assessment) Engine

**O que é**: Engine integrada para avaliar qualidade de código automaticamente.

**Por que adotar**: O projeto educacional tinha CQA com 184 testes, >85% cobertura. Zentriz tem DoD e checklists, mas não tem engine automatizada.

**Status**: O QA Agent e os checklists já cobrem parte. CQA como serviço pode ser evolução futura.

---

## 3. Resumo de Implementação

| Prática | Status | Localização |
|---------|--------|-------------|
| ADRs | ✅ Implementado | [docs/adr/](../docs/adr/) |
| RFCs | ✅ Implementado | [docs/rfc/](../docs/rfc/) |
| Documentação consolidada de agentes | ✅ Implementado | [docs/AGENTS_CAPABILITIES.md](../docs/AGENTS_CAPABILITIES.md) |
| Métricas de performance | ✅ Implementado | [docs/PERFORMANCE_METRICS.md](../docs/PERFORMANCE_METRICS.md) |
| Scripts de manutenção | ✅ Implementado | `scripts/` |
| Índice JSON | 🔄 Futuro | — |
| MCP | 🔄 Futuro | — |
| CQA engine | 🔄 Futuro | — |

---

## 4. Referência ao Projeto Educacional

O projeto de agentes educacionais tinha:
- **Knowledge Agent**: busca e recuperação de informação
- **DidacticResponseAgent**: transformação pedagógica das respostas
- Pipeline: Query → Knowledge → Didactic → Response
- Múltiplos protocolos: REST, MCP, A2A
- 184 testes, >85% cobertura, latência <2s, 50+ QPS
- ADRs, RFCs, guias de teste/deploy/manutenção

---

*Documento criado em 2026-01-29 — Zentriz Genesis*
