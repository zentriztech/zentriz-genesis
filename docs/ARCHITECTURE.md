# Arquitetura (Modelo)

## Atores e responsabilidades

O sistema é composto por **SPEC** (pessoa real, dono do projeto) e agentes **CTO, PM, Dev, QA, DevOps, Monitor**. A hierarquia de comunicação é:

- **SPEC ↔ CTO**: Spec fornece requisitos; CTO informa conclusão ou bloqueios.
- **CTO ↔ PM**: CTO delega stack(s); PM informa conclusão ou bloqueios.
- **PM → Dev, QA, DevOps**: PM atribui atividades (não recebe resultado de testes diretamente do QA).
- **PM ← Monitor**: PM recebe status de andamento e finalização.
- **Monitor ↔ Dev**: Acompanha desenvolvimento; informa refazer/melhorar quando QA indica.
- **Monitor ↔ QA**: Monitor aciona QA para testes; QA retorna OK ou volta para Dev.
- **Monitor ↔ DevOps**: Monitor aciona provisionamento (total ou parcial).

Composição da stack: Dev e QA sempre em **par** (1 QA por 1 Dev); **um** DevOps e **um** Monitor por stack; 1 ou N pares Dev–QA conforme complexidade. Stacks formadas apenas por atores com as **mesmas skills**.

Referência completa: [docs/ACTORS_AND_RESPONSIBILITIES.md](ACTORS_AND_RESPONSIBILITIES.md). Diagramas: [ARCHITECTURE_DIAGRAM.md](../ARCHITECTURE_DIAGRAM.md).

## Visão geral de componentes
- Componentes técnicos por stack (Backend, Web, Mobile). Infra (IaC, CI/CD) é responsabilidade do DevOps em cada stack.

## Backend/API
- Linguagem/framework
- Persistência
- Autenticação/Autorização
- Observabilidade

## Web (React)
- State management
- Rotas
- Design system
- Build/Deploy

## Mobile
- RN/Nativo
- Fluxos
- Storage local
- Build

## Infra
- AWS/Azure/GCP
- IaC
- CI/CD
- Segurança baseline
