# Contrato: Proposta técnica do Engineer (engineer_stack_proposal)

O agente **Engineer** devolve ao CTO uma proposta técnica estruturada. O CTO usa essa proposta para gerar o Project Charter e contratar os PM(s) corretos.

## Estrutura esperada (em artifacts ou summary)

- **squads_teams**: Lista de squads/equipes que o projeto precisa, ex.:
  - "Web Básica" (sites estáticos, landing pages)
  - "Web Avançada" (app web com API, auth, gestão)
  - "Backend API" (REST/GraphQL para consumo pelas outras equipes)
  - "Mobile" (quando aplicável)
- **dependencies**: Dependências entre equipes, ex.:
  - "Web Avançada depende de Backend API: obter base URL e lista de endpoints via CTO"
- **recommendations** (opcional): Recomendações técnicas (REST vs GraphQL, auth OAuth2/OIDC, cloud sugerida).

## Uso pelo CTO

- Contratar um PM por squad/equipe listada.
- Ao delegar ao PM, informar dependências (ex.: "PM Web: obter lista de endpoints do PM Backend via mim").
- Incluir na visão do Charter a proposta técnica (resumida) para alinhamento.

## Referência

- [agents/engineer/SYSTEM_PROMPT.md](../agents/engineer/SYSTEM_PROMPT.md)
- [docs/ENGINEER_AND_TEAM_DYNAMICS_PLAN.md](../../project/docs/ENGINEER_AND_TEAM_DYNAMICS_PLAN.md)
