# Zentriz Genesis — Architecture Diagram (Mermaid)

## Diagrama Original (Simplificado)

> Diagrama inicial — mantido para referência histórica. Não reflete a granularidade dos Monitores por módulo nem o fluxo Monitor→PM→CTO.

```mermaid
flowchart LR
    SPEC[Product Spec]
    CTO[CTO Agent]
    PM[PM Agents]
    DEV[Dev Agents]
    QA[QA Agents]
    DEVOPS[DevOps Agents]
    MON[Monitor Agents]
    CLOUD[(AWS / Azure / GCP)]

    SPEC --> CTO
    CTO --> PM
    PM --> DEV
    PM --> QA
    PM --> DEVOPS

    DEV --> QA
    QA --> PM

    DEVOPS --> CLOUD
    CLOUD --> MON
    MON --> CTO
```

---

## Diagrama Atualizado (Arquitetura Completa)

> Reflete a arquitetura real: Monitores por módulo (Backend, Web, Mobile, Infra) monitoram **Dev/QA** para progresso e status, informando ao PM. Fluxo de alertas **Monitor → PM → CTO**. Layout: DevOps (por Cloud) e CLOUD posicionados abaixo do Módulo Infra.

```mermaid
flowchart TB
    subgraph ENTRADA
        SPEC[Product Spec]
    end

    subgraph ORQUESTRAÇÃO
        CTO[CTO Agent]
    end

    subgraph MÓDULO_BACKEND["Módulo Backend"]
        PM_BE[PM Backend]
        DEV_BE[Dev Backend]
        QA_BE[QA Backend]
        MON_BE[Monitor Backend]
    end

    subgraph MÓDULO_WEB["Módulo Web"]
        PM_WEB[PM Web]
        DEV_WEB[Dev Web]
        QA_WEB[QA Web]
        MON_WEB[Monitor Web]
    end

    subgraph MÓDULO_MOBILE["Módulo Mobile"]
        PM_MOB[PM Mobile]
        DEV_MOB[Dev Mobile]
        QA_MOB[QA Mobile]
        MON_MOB[Monitor Mobile]
    end

    subgraph MÓDULO_INFRA["Módulo Infra"]
        PM_INFRA[PM Infra]
        DEV_INFRA[Dev Infra]
        QA_INFRA[QA Infra]
        MON_INFRA[Monitor Infra]
    end

    subgraph DEVOPS_CLOUD["DevOps (por Cloud)"]
        DEVOPS[DevOps AWS/Azure/GCP]
    end

    subgraph CLOUD
        AWS[(AWS)]
        AZURE[(Azure)]
        GCP[(GCP)]
    end

    %% Fluxo principal
    SPEC --> CTO
    CTO --> PM_BE
    CTO --> PM_WEB
    CTO --> PM_MOB
    CTO --> PM_INFRA

    PM_BE --> DEV_BE
    PM_BE --> QA_BE
    PM_BE --> DEVOPS
    PM_WEB --> DEV_WEB
    PM_WEB --> QA_WEB
    PM_WEB --> DEVOPS
    PM_MOB --> DEV_MOB
    PM_MOB --> QA_MOB
    PM_MOB --> DEVOPS
    PM_INFRA --> DEV_INFRA
    PM_INFRA --> QA_INFRA
    PM_INFRA --> DEVOPS

    DEV_BE --> QA_BE
    QA_BE --> PM_BE
    DEV_WEB --> QA_WEB
    QA_WEB --> PM_WEB
    DEV_MOB --> QA_MOB
    QA_MOB --> PM_MOB
    DEV_INFRA --> QA_INFRA
    QA_INFRA --> PM_INFRA

    DEVOPS --> AWS
    DEVOPS --> AZURE
    DEVOPS --> GCP

    %% Monitor observa Dev/QA do seu módulo (progresso, status)
    MON_BE -.->|observa| DEV_BE
    MON_BE -.->|observa| QA_BE
    MON_WEB -.->|observa| DEV_WEB
    MON_WEB -.->|observa| QA_WEB
    MON_MOB -.->|observa| DEV_MOB
    MON_MOB -.->|observa| QA_MOB
    MON_INFRA -.->|observa| DEV_INFRA
    MON_INFRA -.->|observa| QA_INFRA

    %% Fluxo de alertas: Monitor → PM → CTO
    MON_BE -->|informa| PM_BE
    MON_WEB -->|informa| PM_WEB
    MON_MOB -->|informa| PM_MOB
    MON_INFRA -->|informa| PM_INFRA

    PM_BE -->|consolida/escala| CTO
    PM_WEB -->|consolida/escala| CTO
    PM_MOB -->|consolida/escala| CTO
    PM_INFRA -->|consolida/escala| CTO
```

---

## Papel do Monitor (por módulo)

**Monitor_<AREA>** (Backend, Web, Mobile, Infra) monitora **Dev_<AREA>** e **QA_<AREA>** do seu módulo para:

- Entender o **progresso** das atividades
- Acompanhar o **status de andamento** (tasks, evidências, bloqueios)
- Detectar travas, loops, falhas recorrentes
- **Informar ao PM_<AREA>** responsável pelo módulo

O PM avalia, toma ação ou escala ao CTO quando crítico.

---

## Fluxo de Alertas (Monitor → PM → CTO)

| Etapa | Agente | Ação |
|-------|--------|------|
| 1 | **Monitor_<AREA>** | Observa **Dev_<AREA>** e **QA_<AREA>** do módulo. Acompanha progresso, status, evidências. Detecta travas, loops, falhas. Gera MONITOR_HEALTH_<area>.md |
| 2 | **Monitor → PM_<AREA>** | Informa progresso e status ao PM responsável. Emite `monitor.alert` quando há risco ou bloqueio |
| 3 | **PM_<AREA>** | Recebe informações, avalia, toma ação ou escala ao CTO |
| 4 | **PM → CTO** | Consolida status, escala alertas críticos, reporta no STATUS.md |