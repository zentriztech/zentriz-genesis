# Arquitetura (Modelo)

> **Fluxo atual (V2):** Spec → **CTO spec review** → **loop CTO↔Engineer** (max 3 rodadas) → Charter → **PM** por módulo → seed de tarefas → **Monitor Loop** (Dev/QA/DevOps) até o usuário aceitar ou parar. Detalhes: [ORCHESTRATION_GUIDE.md](ORCHESTRATION_GUIDE.md), [AGENTS_AND_LLM_FLOW.md](AGENTS_AND_LLM_FLOW.md).

## Atores e responsabilidades

O sistema é composto por **SPEC** (pessoa real, dono do projeto) e agentes **CTO, Engineer, PM, Dev, QA, DevOps, Monitor**. A hierarquia de comunicação é:

- **SPEC ↔ CTO**: Spec fornece requisitos; CTO informa conclusão ou bloqueios.
- **CTO ↔ Engineer**: CTO envia spec e questionamentos; Engineer devolve proposta técnica (squads, dependências); CTO valida ou questiona até Charter (loop max 3 rodadas).
- **CTO ↔ PM**: CTO delega squad(s) com base na proposta do Engineer; PM informa conclusão ou bloqueios. PMs conversam **via CTO** (dependências).
- **PM → Dev, QA, DevOps**: PM atribui atividades (não recebe resultado de testes diretamente do QA).
- **PM ← Monitor**: PM recebe status de andamento e finalização.
- **Monitor ↔ Dev**: Acompanha desenvolvimento; informa refazer/melhorar quando QA indica.
- **Monitor ↔ QA**: Monitor aciona QA para testes; QA retorna OK ou volta para Dev.
- **Monitor ↔ DevOps**: Monitor aciona provisionamento (total ou parcial).

Composição da squad: Dev e QA sempre em **par** (1 QA por 1 Dev); **um** DevOps e **um** Monitor por squad; 1 ou N pares Dev–QA conforme complexidade. Squads formadas apenas por atores com as **mesmas skills**.

Referência completa: [ACTORS_AND_RESPONSIBILITIES.md](ACTORS_AND_RESPONSIBILITIES.md). Diagramas: [ARCHITECTURE_DIAGRAM.md](../ARCHITECTURE_DIAGRAM.md).

## Visão geral de componentes
- Componentes técnicos por squad (Backend, Web, Mobile). Infra (IaC, CI/CD) é responsabilidade do DevOps em cada squad.

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
