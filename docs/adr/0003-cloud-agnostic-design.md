# ADR-0003: Cloud-Agnostic por Design

## Status

Aceito

## Data

2026-01-29

## Contexto

O Zentriz Genesis provisiona infraestrutura para projetos (API, Web, Mobile). Depender de um único provedor (AWS, Azure ou GCP) limitaria adoção e criaria vendor lock-in. Clientes enterprise podem ter preferências ou restrições por cloud.

## Decisão

A arquitetura é **cloud-agnostic por design**. DevOps Agents são especializados por cloud (DEVOPS_AWS, DEVOPS_AZURE, DEVOPS_GCP). O PM seleciona o provedor com base em `constraints.cloud` do spec. Nenhuma dependência estratégica deve aprisionar a arquitetura.

## Alternativas Consideradas

1. **AWS-only**: Simplifica implementação inicial. Rejeitada por lock-in e exclusão de clientes Azure/GCP.
2. **Abstração única (Terraform multi-cloud)**: Um único IaC para todas as clouds. Rejeitada por complexidade e diferenças fundamentais entre provedores.
3. **Cloud-agnostic com abstração de serviços**: Camada que abstrai Lambda vs Functions vs Cloud Run. Rejeitada por perda de otimizações específicas e complexidade de manutenção.

## Consequências

- **Positivas**: Flexibilidade para cliente, evita lock-in, permite competição entre provedores, suporta multi-cloud futuro.
- **Negativas**: Três implementações de DevOps (AWS, Azure, GCP); mais esforço de manutenção.
- **Neutras**: Contratos e DoD devem ser comuns; implementação é específica por cloud.

## Referências

- MANIFESTO_TECNICO.md
- docs/DEVOPS_SELECTION.md
- agents/devops-aws/, devops-azure/, devops-gcp/
