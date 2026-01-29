# Scripts de Manutenção — Zentriz Genesis

> **Propósito**: Scripts para validação, geração de índices, relatórios e provisionamento.  
> **Inspirado em**: Projeto de agentes educacionais (scripts para índice, validação, testes de protocolos).

---

## 1. Estrutura Planejada

```
scripts/
├─ README.md           # Este arquivo
├─ validate/           # Validação de spec, schemas, contratos
├─ generate/           # Geração de índices, relatórios
├─ test/               # Testes de protocolos (eventos, envelopes)
└─ provision/          # Provisionamento Docker, ambientes
```

---

## 2. Scripts Recomendados

### 2.1 Validação

| Script | Propósito |
|--------|-----------|
| `validate/spec.sh` | Validar spec/PRODUCT_SPEC.md (FR/NFR, estrutura) |
| `validate/schemas.sh` | Validar orchestrator/events/schemas/*.json |
| `validate/contracts.sh` | Validar contracts/*.json (message_envelope, response_envelope) |
| `validate/backlog.sh` | Validar docs/BACKLOG_*.md (tasks, referências FR/NFR) |

### 2.2 Geração

| Script | Propósito |
|--------|-----------|
| `generate/context_index.sh` | Atualizar context/PROJECT_OVERVIEW.md ou índice JSON |
| `generate/agents_index.sh` | Atualizar docs/AGENTS_CAPABILITIES.md a partir de agents/*/SYSTEM_PROMPT.md |
| `generate/report.sh` | Gerar relatório consolidado de status |

### 2.3 Testes de Protocolo

| Script | Propósito |
|--------|-----------|
| `test/events.sh` | Validar exemplos em examples/messages/ contra schemas |
| `test/envelopes.sh` | Validar message_envelope e response_envelope em exemplos |

### 2.4 Provisionamento

| Script | Propósito |
|--------|-----------|
| `provision/docker.sh` | Build e run de containers (quando aplicável) |
| `provision/local.sh` | Setup de ambiente local para desenvolvimento |

---

## 3. Implementação

Os scripts acima são **recomendações**. A implementação pode ser incremental conforme necessidade.

**Prioridade sugerida**:
1. `validate/schemas.sh` — Garantir que exemplos e schemas estão alinhados
2. `validate/contracts.sh` — Validar envelopes JSON
3. `test/events.sh` — Testes de protocolo de eventos

---

## 4. Integração com CI/CD

Scripts de validação podem ser integrados aos workflows em `.github/workflows/` como etapa pré-deploy.

---

*Documento criado em 2026-01-29 — Zentriz Genesis*
