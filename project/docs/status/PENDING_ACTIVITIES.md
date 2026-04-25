# Atividades pendentes

> Atualizado em 2026-04-25 — integra atividades históricas + novas descobertas de resiliência e operação autônoma.

---

## ✅ Concluído recentemente (2026-04-25)

- **Isolamento de runner por projeto**: mutex `threading.Lock()` em `runner_server.py`, rejeita segundo `/run` com HTTP 409
- **PID persistido em disco**: `STATE_DIR/project_id/runner.pid` — sobrevive restart do container
- **Watchdog de auto-recovery**: `api-node/src/services/watchdog.ts` — relança projetos órfãos automaticamente
- **Checkpoint isolado por projeto**: `persist_state()` e `events.jsonl` em subpasta do `project_id`
- **Portal com tabs em tempo real**: Diálogo | Tasks (polling 8s) | Artefatos — com barra de progresso e live status
- **ADR-006**: documentação completa da arquitetura de resiliência → `project/docs/adr/0006-resiliencia-e-operacao-autonoma.md`

---

## 1. Opcionais (já previstos no plano)

- **Serviço LLM para resumo:** hoje o resumo do diálogo é por template. Se quiser resumos gerados por LLM, implementar um serviço que exponha `SUMMARY_LLM_URL` (POST com `from_agent`, `to_agent`, `event_type`, `payload_snippet`; resposta com `summary_human`).
- **Diálogo em tempo real no Genesis-Web:** hoje há polling (10 s). Para tempo real: SSE ou WebSocket (ex.: `GET /api/projects/:id/dialogue/stream` ou equivalente).
- **Stepper com estado “Engineer”:** o Stepper já tem o passo “Engineer (proposta)”; não existe status `engineer_done` no backend. Se quiser um estado explícito, é preciso novo status e ajuste no runner/API.

---

## 2. Outros agentes (PM Web, PM Mobile)

- **skills.md** existe apenas para **PM Backend**. Para alinhar com o plano:
  - Criar `applications/agents/pm/web/skills.md` e `applications/agents/pm/mobile/skills.md` (com seção “Exemplos práticos” no mesmo padrão), **ou**
  - Deixar para quando esses PMs forem acionados pelo runner.

---

## 3. Bloqueios cross-team (fluxo vivo)

- **Documentado** em ORCHESTRATOR_BLUEPRINT, TASK_STATE_MACHINE e ACTORS (PM → CTO → Engineer/PM responsável → Dev).
- **Não implementado** no runner: o runner atual não trata eventos `block.reported` / `block.resolved` nem aciona CTO/Engineer/PM em resposta a bloqueio. Falta:
  - Definir quando o runner (ou outro serviço) recebe “bloqueio reportado”.
  - Implementar o fluxo: registrar bloqueio, escalar ao CTO (e, se for o caso, ao Engineer), repassar solução ao PM/Dev.

---

## 4. Testes

- **Feito:** testes do módulo de diálogo (`orchestrator/tests/test_runner_dialogue.py`).
- **Falta (opcional):** teste de integração do **fluxo completo** com mocks (spec → Engineer → CTO → PM Backend) para validar ordem de chamadas e eventos, sem chamar agentes reais.

---

## 5. Resumo

| Item | Prioridade | Observação |
|------|------------|------------|
| LLM para summary_human | Opcional | SUMMARY_LLM_URL |
| Diálogo tempo real (SSE/WS) | Opcional | Genesis-Web |
| Status engineer_done no backend | Opcional | Se quiser passo explícito |
| skills.md PM Web / PM Mobile | Média | Quando PMs forem usados |
| Fluxo de bloqueio no runner | Média | block.reported / block.resolved |
| Teste integração fluxo completo | Baixa | Mocks Engineer/CTO/PM |

---

*Documento criado para retomada após correção do serviço agents e disponibilidade do Engineer.*
