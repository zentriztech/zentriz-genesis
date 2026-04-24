# Connect / Deadpool Ready Checklist

## Objetivo

Mapear o que o Genesis deve produzir para falar a linguagem do `zentriz-connect` e tornar sistemas gerados realmente Deadpool Ready sem criar dependência de runtime do Deadpool.

## Contratos mínimos obrigatórios

- `SystemPassport`
- `ServiceManifest`
- `OwnershipManifest`
- `ObservabilityBaselineManifest`

## Contratos recomendados

- `RuntimePassport`
- `KnownSafeActionsPack`
- `CapabilityManifest` quando houver necessidade real de descrever capacidades transversais

## Pontos prováveis de geração no fluxo do Genesis

- **Charter / arquitetura inicial**: `SystemPassport`
- **Planejamento por módulo / serviço**: `ServiceManifest`
- **Definição de ownership e governança**: `OwnershipManifest`
- **Preparação operacional / DevOps / Monitor**: `ObservabilityBaselineManifest`
- **Maturidade operacional posterior**: `RuntimePassport` e `KnownSafeActionsPack`

## Revisão obrigatória

- o Genesis continua standalone
- nenhum artefato exige instalação do Deadpool
- os contratos usados são consumidos por versão oficial do Connect
- os examples do Connect continuam cobrindo os outputs gerados pelo Genesis
