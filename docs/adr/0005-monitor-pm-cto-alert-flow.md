# ADR-0005: Fluxo de Alertas Monitor → PM → CTO

## Status

Aceito

## Data

2026-01-29

## Contexto

O Zentriz Genesis possui **Monitor Agents** por stack (Backend, Web, Mobile) que monitoram **Dev_<AREA>** e **QA_<AREA>** para entender progresso, status de andamento das atividades, evidências e bloqueios. A documentação original indicava que Monitores "alertam PM/CTO" de forma indistinta, sem definir a cadeia de responsabilidade. O diagrama de arquitetura original mostrava Monitor reportando diretamente ao CTO, omitindo os Monitores por módulo e a hierarquia PM → CTO.

## Decisão

**Fluxo de alertas em cascata**: Monitor_<AREA> → PM_<AREA> → CTO.

1. **Monitor_<AREA>** (Backend, Web, Mobile) monitora **Dev_<AREA>** e **QA_<AREA>** (progresso, status). Informa ao **PM_<AREA>** responsável. Emite `monitor.alert` quando há risco ou bloqueio.
2. **PM_<AREA>** recebe o alerta, avalia, toma ação ou **escala ao CTO** quando o alerta é crítico.
3. **CTO** recebe consolidação dos PMs e alertas escalados, marca `project.completed` quando apropriado.

## Alternativas Consideradas

1. **Monitor → CTO diretamente**: Monitor alerta CTO. Rejeitada por sobrecarregar CTO com alertas de todos os módulos e ignorar a responsabilidade do PM pelo módulo.
2. **Monitor → PM/CTO em paralelo**: Monitor alerta ambos. Rejeitada por criar ruído e duplicação; PM é o dono do módulo e deve triar primeiro.
3. **Monitor → PM → CTO (cascata)**: Monitor alerta PM; PM escala ao CTO quando crítico. Escolhida por seguir a cadeia de comando e manter CTO focado em consolidação e decisões estratégicas.

## Consequências

- **Positivas**: PM é o primeiro responsável pelo módulo; CTO recebe apenas alertas críticos escalados; hierarquia clara; diagrama reflete a arquitetura real.
- **Negativas**: PM deve implementar lógica de triagem e escalação; um PM inativo pode atrasar alertas críticos (mitigado por timeout/escala automática em implementação futura).
- **Neutras**: Schema `monitor.alert` inclui `pm_target` e `escalate_to_cto` para suportar o fluxo.

## Referências

- [ARCHITECTURE_DIAGRAM.md](../../ARCHITECTURE_DIAGRAM.md)
- [docs/ORCHESTRATION_GUIDE.md](../ORCHESTRATION_GUIDE.md)
- [docs/TEAM_COMPOSITION.md](../TEAM_COMPOSITION.md)
- [orchestrator/events/schemas/monitor.alert.json](../../orchestrator/events/schemas/monitor.alert.json)
