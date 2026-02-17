# Agentes (PM, Monitor, CTO) — Python + Claude
# Build a partir da raiz: docker compose build agents-backend
FROM python:3.12-slim

WORKDIR /app

COPY agents/ agents/
COPY contracts/ contracts/
COPY docs/ docs/
COPY orchestrator/ orchestrator/

RUN pip install --no-cache-dir -r orchestrator/agents/requirements.txt

ENV PYTHONPATH=/app

EXPOSE 8000
CMD ["uvicorn", "orchestrator.agents.server:app", "--host", "0.0.0.0", "--port", "8000"]
