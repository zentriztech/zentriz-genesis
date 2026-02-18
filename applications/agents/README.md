# Agentes — Zentriz Genesis

Estrutura hierárquica por **tipo de ator** e **skill/tecnologia**, permitindo escalar o projeto com novas variantes (ex.: Dev Web Flutter, Dev Backend Python) sem alterar a organização.

**Stacks**: apenas **Backend**, **Web** e **Mobile**. A infraestrutura (IaC, CI/CD, deploy) faz parte de cada stack via **DevOps** (por cloud), não existe stack "Infra" nem atores PM/Dev/QA/Monitor Infra.

Cada agente possui um `SYSTEM_PROMPT.md` que define papel, objetivo, regras e contratos. Referência: [docs/ACTORS_AND_RESPONSIBILITIES.md](../docs/ACTORS_AND_RESPONSIBILITIES.md).

---

## Estrutura

```
agents/
├── cto/                          # Orquestrador (único)
│   └── SYSTEM_PROMPT.md
├── pm/                           # PM por stack
│   ├── backend/
│   ├── web/
│   └── mobile/
├── dev/                          # Dev por stack e tecnologia
│   ├── backend/
│   │   └── nodejs/               # Node.js, AWS Lambda, API Gateway (futuro: python, etc.)
│   ├── web/
│   │   └── react-next-materialui/  # React + Next + Material UI + MobX (futuro: flutter, etc.)
│   └── mobile/
│       └── react-native/         # React Native sem Expo (futuro: kotlin, swift)
├── qa/                           # QA por stack e tecnologia
│   ├── backend/
│   │   ├── nodejs/               # Node.js (TypeScript)
│   │   └── lambdas/              # Lambdas (TypeScript)
│   ├── web/
│   │   └── react/                # React (TypeScript)
│   └── mobile/
│       └── react-native/         # React Native (TypeScript)
├── devops/                       # DevOps: base Docker + cloud (infra faz parte de cada stack)
│   ├── docker/                   # Base: Docker (namespace zentriz-genesis), Terraform, k8s — primeiro a implementar
│   ├── aws/
│   ├── azure/
│   └── gcp/
└── monitor/                      # Monitor por stack
    ├── backend/
    ├── web/
    └── mobile/
```

---

## Resumo por tipo

| Tipo     | Stacks           | Subníveis (skill) | Exemplo inicial |
|----------|------------------|--------------------|-----------------|
| **cto**  | —                | —                  | cto/ |
| **pm**   | backend, web, mobile | —              | pm/backend/, pm/web/ |
| **dev**  | backend, web, mobile | backend: nodejs. web: react-next-materialui. mobile: react-native | dev/backend/nodejs/, dev/web/react-next-materialui/, dev/mobile/react-native/ |
| **qa**   | backend, web, mobile | backend: nodejs, lambdas. web: react. mobile: react-native | qa/backend/nodejs/, qa/web/react/ |
| **devops** | —              | docker (base), aws, azure, gcp | devops/docker/, devops/aws/, devops/azure/, devops/gcp/ |
| **monitor** | backend, web, mobile | —              | monitor/backend/, monitor/web/ |

---

## Como adicionar uma nova skill

1. Criar a pasta sob a stack correta (ex.: `dev/web/flutter/`).
2. Adicionar `SYSTEM_PROMPT.md` com papel, objetivo, regras e links para contracts/docs (ajustar `../` conforme profundidade).
3. Atualizar [docs/AGENTS_CAPABILITIES.md](../docs/AGENTS_CAPABILITIES.md) e [docs/NAVIGATION.md](../docs/NAVIGATION.md) com o novo agente.

---

*Última atualização: 2026-02-17 — Zentriz Genesis*
