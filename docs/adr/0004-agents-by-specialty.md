# ADR-0004: Agentes por Especialidade (PM/Dev/QA/DevOps/Monitor)

## Status

Aceito

## Data

2026-01-29

## Contexto

O Zentriz Genesis precisa simular uma fábrica de software com papéis claros. Um único agente "universal" seria difícil de especializar e manter. A separação de responsabilidades deve refletir o mundo real (PM planeja, Dev implementa, QA valida, DevOps provisiona, Monitor observa).

## Decisão

Agentes são **especializados por papel e módulo**:
- **PM_<AREA>**: Backend, Web, Mobile — define backlog, aprova entregas (infra é responsabilidade do DevOps em cada stack)
- **DEV_<AREA>**: Implementa código, testes, documentação
- **QA_<AREA>**: Valida requisitos, gera QA report, bloqueia regressões
- **DEVOPS_<CLOUD>**: AWS, Azure, GCP — IaC, CI/CD, observabilidade
- **MONITOR_<AREA>**: Monitora Dev_<AREA> e QA_<AREA> (progresso, status de andamento), informa PM_<AREA> (que escala ao CTO quando crítico)

O CTO orquestra e delega para PMs; PMs instanciam Dev, QA e DevOps por módulo.

## Alternativas Consideradas

1. **Agente único polimórfico**: Um agente que muda de papel conforme contexto. Rejeitada por complexidade de prompt e risco de confusão de responsabilidades.
2. **Agentes apenas por módulo (sem QA/DevOps separados)**: Dev faz QA; Dev faz deploy. Rejeitada por conflito com princípio "QA contínuo" e separação de concerns.
3. **Menos especialização (ex: um PM para tudo)**: Um PM para Backend+Web+Mobile. Rejeitada por perda de expertise e backlog muito grande por agente.

## Consequências

- **Positivas**: Separação clara de responsabilidades, especialização por stack, escalabilidade (mais instâncias por papel), alinhamento com práticas de mercado.
- **Negativas**: Mais agentes para manter (20+); coordenação via eventos é essencial.
- **Neutras**: Contratos (message_envelope, response_envelope) devem ser comuns a todos.

## Referências

- [docs/TEAM_COMPOSITION.md](../TEAM_COMPOSITION.md)
- [docs/ORCHESTRATION_GUIDE.md](../ORCHESTRATION_GUIDE.md)
- [agents/](../../agents/)
