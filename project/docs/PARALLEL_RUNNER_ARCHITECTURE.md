# Parallel Runner Architecture

## Estado Atual

O `runner_server.py` (FastAPI) já suporta execução paralela de múltiplos projetos:

- Cada projeto recebe um `subprocess.Popen` isolado com seu próprio `PROJECT_ID`
- PIDs persistidos em `STATE_ROOT/{project_id}/runner.pid` (isolamento por projeto)
- Estado do pipeline isolado em `STATE_DIR/{project_id}/` (Task #57 — bc2ccff)
- `_running_pids: dict[str, int]` mapeia project_id → pid sem limite configurado
- O 409 CONFLICT em `/run` só é retornado quando o MESMO projeto já está rodando

## Configuração para Multi-Projeto

### 1. Watchdog (configurado)

```bash
# .env ou docker-compose
WATCHDOG_MAX_PARALLEL_RESTARTS=3  # relancar até 3 projetos órfãos por ciclo (default: 1)
```

### 2. Rate Limiting da API (configurado)

```bash
RUN_RATE_LIMIT_MAX_CALLS=10       # 10 /run calls por minuto por tenant (default: 5)
RUN_RATE_LIMIT_WINDOW_MS=60000
```

### 3. Cost Guard

Com projetos paralelos, o custo sobe linearmente. Recomendado:

```bash
WATCHDOG_MAX_PARALLEL_RESTARTS=2  # max 2 pipelines em simultâneo via watchdog
CLEANUP_TTL_DAYS_DRAFT=7          # limpar rascunhos mais rápido
```

---

## Limitações Conhecidas

| Item | Estado | Notas |
|------|--------|-------|
| Isolamento de estado | ✅ Resolvido (G03) | Cada projeto escreve em STATE_DIR/{project_id}/ |
| PID persistence | ✅ Implementado | runner.pid por project_id |
| Watchdog multi-relaunch | ✅ Implementado (G04) | WATCHDOG_MAX_PARALLEL_RESTARTS |
| Limite de recursos | ⚠️ Manual | Claude API rate limits se aplicam por conta |
| LLM rate limit global | ⚠️ Compartilhado | Todos os projetos usam a mesma CLAUDE_API_KEY |
| Logs misturados | ✅ Resolvido (G06) | Cada processo loga com project_id |

---

## Próximos Passos para Escala

1. **Token budget por projeto**: limitar `max_tokens` por pipeline (hoje ilimitado)
2. **Queue de projetos**: substituir o 409 por fila em memória quando há muitos projetos simultâneos
3. **Multi-instância do runner**: rodar N instâncias do runner_server em containers separados com load balancing
4. **Isolamento de API key**: um `CLAUDE_API_KEY` por tenant para billing separado

---

## Teste de Smoke (paralelo)

```bash
# Terminal 1 — inicia projeto A
curl -X POST http://localhost:3000/api/projects/<id-A>/run -H "Authorization: Bearer $TOKEN"

# Terminal 2 — imediatamente inicia projeto B (deve funcionar em paralelo)
curl -X POST http://localhost:3000/api/projects/<id-B>/run -H "Authorization: Bearer $TOKEN"

# Verificar que ambos estão rodando
curl http://localhost:8001/status
# Esperado: { "active_count": 2, "projects": { "<id-A>": PID_A, "<id-B>": PID_B } }
```
