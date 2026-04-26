# Agentes (Engineer, CTO, PM, Monitor, Dev, QA, DevOps) — Python + Claude
# Build a partir da raiz: docker compose build agents
# Contexto = raiz; copia apenas applications/ necessários (sem project/docs).
FROM python:3.12-slim

# Healthcheck do compose usa curl; ca-certificates atualizados para evitar
# SSL: UNEXPECTED_EOF_WHILE_READING em saída HTTPS (ex.: api.anthropic.com)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY applications/agents/ agents/
COPY applications/contracts/ contracts/
COPY applications/orchestrator/ orchestrator/

RUN pip install --no-cache-dir -r orchestrator/agents/requirements.txt

ENV PYTHONPATH=/app

EXPOSE 8000
# 2 workers: allows spec-preview background jobs to run without blocking health/other endpoints
# Single worker: async jobs use threading within one process — multiple workers
# would split _async_jobs dict across processes, causing "job not found" errors.
# Background threads handle parallelism; one uvicorn process is sufficient.
CMD ["uvicorn", "orchestrator.agents.server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--timeout-keep-alive", "600"]
