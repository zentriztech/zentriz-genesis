# ADR-006 — Resiliência e Operação Autônoma do Genesis

**Status:** Aceito  
**Data:** 2026-04-25  
**Autores:** Equipe Zentriz

---

## Contexto

O Genesis precisa operar de forma autônoma — sem supervisão humana constante — e ser capaz de:
1. Sobreviver a quedas de containers sem perder trabalho em andamento
2. Retomar pipelines interrompidos de onde pararam (não do zero)
3. Evitar loops infinitos e gastos absurdos de tokens/custo
4. Suportar múltiplos projetos em paralelo (futuramente)

---

## Problema identificado

Antes desta ADR, o Genesis tinha os seguintes gaps críticos:

| Gap | Impacto |
|---|---|
| Containers sobem mas projetos `running` ficam órfãos | Pipeline nunca retoma após queda |
| `_running_pids` só em memória | `/stop` ineficaz após restart do container |
| Dois `/run` para o mesmo projeto criavam dois subprocessos | Corrupção de estado, gastos duplos |
| Checkpoint em path global (`state/current_project.json`) | Projetos diferentes sobrescreviam estado um do outro |
| Sem visibilidade do que está rodando | Impossível diagnosticar sem entrar no container |

---

## Decisão

### Camada 1 — Restart de containers
Todos os containers usam `restart: unless-stopped`. Em caso de queda (OOM, crash, reboot do host), o Docker reinicia automaticamente.

### Camada 2 — Recuperação de PIDs no runner
`runner_server.py` persiste o PID de cada pipeline em disco (`STATE_DIR/project_id/runner.pid`). No startup, lê todos os arquivos `.pid`, verifica quais processos ainda estão vivos e restaura o mapa em memória. Processos mortos têm o arquivo removido.

### Camada 3 — Watchdog de auto-recovery
O `api-node` executa um Watchdog a cada `WATCHDOG_INTERVAL_MS` (padrão: 60s):
1. Consulta DB: projetos com `status = 'running'`
2. Consulta runner: `GET /status` → quais projetos têm processo ativo
3. Para projetos `running` sem processo ativo → relança via `POST /run`
4. O pipeline retoma do checkpoint LEI-11 — não começa do zero

**Proteções do Watchdog:**
- `WATCHDOG_MAX_RESTARTS=5` — após N restarts sem sucesso, marca como `failed`
- `WATCHDOG_MAX_RUNTIME_HOURS=8` — projetos rodando além do limite são forçados a `failed` (proteção de custo)
- Runner ocupado → aguarda próximo ciclo (serialização respeitada)
- HTTP 409 do runner → projeto já rodando, skip silencioso

### Camada 4 — Checkpoint por projeto (LEI-11)
`PipelineContext.save_checkpoint()` grava em `STATE_DIR/project_id/checkpoint.json`. O runner carrega apenas o checkpoint do `project_id` correto. `persist_state()` e `events.jsonl` também são isolados por `project_id`.

### Camada 5 — Circuit breakers anti-loop
- `MAX_QA_REWORK=3` — após 3 falhas de QA em uma task, ela é marcada DONE (não aprovada)
- `MAX_CONSECUTIVE_DEV_BLOCKED=5` — Dev que não entrega `apps/` em 5 tentativas: task DONE
- `circuit_breaker_open` no runtime — agent que falha N vezes seguidas retorna BLOCKED diretamente
- `max_rounds=3` em CTO↔Engineer e CTO↔PM — evita loop de validação infinita

### Camada 6 — Mutex no runner
`threading.Lock()` global no `runner_server.py`. Dois `/run` para o mesmo projeto: o segundo recebe HTTP 409. Impossível criar dois subprocessos para o mesmo projeto.

---

## Fluxo de Recovery

```
[Queda do container runner]
        ↓
[Docker reinicia o container]
        ↓
[runner_server startup]
   → _reload_pids_from_disk()
   → PIDs vivos: restaurados em _running_pids
   → PIDs mortos: arquivo .pid removido
        ↓
[Watchdog (api-node) — próximo ciclo, até 60s]
   → SELECT projects WHERE status='running'
   → GET /runner/status → active PIDs
   → Projetos running sem PID ativo = ÓRFÃOS
        ↓
[Para cada órfão (max 1 por ciclo, respeita serialização)]
   → Verifica restart_count < MAX_RESTARTS
   → Verifica runtime < MAX_RUNTIME_HOURS
   → POST /runner/run com token 24h
        ↓
[Runner inicia novo subprocess para o projeto]
   → Carrega checkpoint: PipelineContext.load_checkpoint(STATE_DIR, project_id)
   → Retoma do step salvo (não começa do zero)
        ↓
[Pipeline continua de onde parou]
```

---

## Arquitetura para AWS (roadmap)

Para evolução para cloud, a mesma lógica se aplica com componentes AWS:

| Local | AWS equivalente |
|---|---|
| `runner_server.py` subprocess | ECS Fargate task por projeto |
| Watchdog no api-node | Lambda + EventBridge Rule (cron 1min) |
| Checkpoint em disco | DynamoDB ou S3 |
| Fila de projetos | SQS FIFO |
| `restart: unless-stopped` | ECS `desired_count: 1` + health check |
| `WATCHDOG_MAX_RUNTIME_HOURS` | CloudWatch Alarm + SNS notification |

No ECS, cada projeto tem sua própria task isolada — paralelismo real sem serialização. O Watchdog Lambda consulta o DB e verifica tasks ECS ativas para o mesmo efeito.

---

## Consequências

**Positivas:**
- O Genesis pode rodar 24/7 sem supervisão humana
- Projetos retomam automaticamente após falhas, sem intervenção
- Proteções de custo evitam gastos absurdos em loops
- Diagnóstico simples: `GET /runner/status` mostra o que está ativo

**Limitações atuais (a resolver):**
- Runner serializado (1 projeto por vez) — suficiente para staging, insuficiente para produção multi-tenant
- Watchdog no mesmo processo da API — em produção, deve ser um worker separado
- Migração para AWS requer refatoração do mecanismo de checkpoint (disco → cloud storage)

---

## Referências

- `applications/orchestrator/runner_server.py` — Camadas 2, 4 (mutex + PID disk)
- `applications/orchestrator/runner.py` — Camada 4 (checkpoint por projeto)
- `applications/services/api-node/src/services/watchdog.ts` — Camada 3
- `applications/orchestrator/agents/runtime.py` — Camada 5 (circuit breaker)
- `.env.example` — Variáveis de configuração do Watchdog
