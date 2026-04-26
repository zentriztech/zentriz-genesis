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
# timeout-keep-alive=600: keeps socket alive during long LLM calls (3-5 min)
# h11-max-incomplete-event-size: allow large response bodies (spec can be 40KB+)
CMD ["uvicorn", "orchestrator.agents.server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--timeout-keep-alive", "600", "--h11-max-incomplete-event-size", "10485760"]
