# Zentriz Genesis — Architecture Diagram (Mermaid)

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