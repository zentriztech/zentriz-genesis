# ADR-0001: Spec-Driven como Princípio Zero

## Status

Aceito

## Data

2026-01-29

## Contexto

O Zentriz Genesis é uma fábrica de software autônoma com múltiplos agentes (CTO, PM, Dev, QA, DevOps, Monitor). Sem uma fonte única de verdade, agentes poderiam divergir em requisitos, criar retrabalho e perder rastreabilidade. Era necessário definir de onde nascem todas as decisões técnicas.

## Decisão

**Especificação é lei.** Toda decisão técnica nasce de uma especificação explícita, versionada e auditável (`spec/PRODUCT_SPEC.md`). O documento de spec contém FR (Functional Requirements) e NFR (Non-Functional Requirements) que são a única fonte de verdade para planejamento, desenvolvimento e validação.

## Alternativas Consideradas

1. **Decisões ad-hoc por agente**: Cada agente interpreta livremente. Rejeitada por risco de divergência e falta de rastreabilidade.
2. **Múltiplas specs por módulo**: Backend, Web, Mobile com specs separadas. Rejeitada por complexidade de sincronização e risco de inconsistência.
3. **Spec como sugestão**: Spec é referência, mas agentes podem desviar. Rejeitada por conflito com governança programável.

## Consequências

- **Positivas**: Rastreabilidade total (FR/NFR → tasks → evidências), auditoria facilitada, onboarding claro, evita retrabalho por divergência.
- **Negativas**: Spec deve ser mantido atualizado; mudanças exigem atualização explícita do documento.
- **Neutras**: Exige disciplina de versionamento do spec.

## Referências

- MANIFESTO_TECNICO.md
- spec/PRODUCT_SPEC.md
- docs/PM_AUTOBACKLOG_GUIDE.md
