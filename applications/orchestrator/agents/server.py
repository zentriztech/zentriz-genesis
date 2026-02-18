"""
Serviço HTTP para agentes (PM Backend, Monitor, etc.). POST /invoke com body message_envelope.
"""
import os
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

# Carregar .env da raiz do repo
from pathlib import Path
_repo_root = Path(__file__).resolve().parent.parent.parent
_dotenv = _repo_root / ".env"
if _dotenv.exists():
    from dotenv import load_dotenv
    load_dotenv(_dotenv)

from .runtime import run_agent
from .pm_backend import SYSTEM_PROMPT_PATH as PM_SYSTEM_PROMPT
from .monitor_backend import SYSTEM_PROMPT_PATH as MONITOR_SYSTEM_PROMPT
from .cto_agent import CTO_SYSTEM_PROMPT_PATH
from .dev_backend import SYSTEM_PROMPT_PATH as DEV_BACKEND_SYSTEM_PROMPT
from .qa_backend import SYSTEM_PROMPT_PATH as QA_BACKEND_SYSTEM_PROMPT
from .devops_docker import SYSTEM_PROMPT_PATH as DEVOPS_DOCKER_SYSTEM_PROMPT

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)


# Endpoints de agentes: POST /invoke (PM), /invoke/cto, /invoke/monitor, /invoke/dev-backend, /invoke/qa-backend, /invoke/devops-docker
AGENT_ENDPOINTS = [
    "POST /invoke",
    "POST /invoke/cto",
    "POST /invoke/monitor",
    "POST /invoke/dev-backend",
    "POST /invoke/qa-backend",
    "POST /invoke/devops-docker",
]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logger.info("Agents service started. Endpoints: %s", ", ".join(AGENT_ENDPOINTS))
    yield
    logger.info("Agents service shutdown")


app = FastAPI(title="Zentriz Genesis Agents", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/invoke")
def invoke_pm_backend(body: dict):
    """
    Invoca o agente PM Backend. Body = message_envelope (request_id, input com spec_ref, context, task, constraints, artifacts).
    """
    try:
        message = body if "input" in body else {"request_id": body.get("request_id", "http"), "input": body}
        response = run_agent(
            system_prompt_path=PM_SYSTEM_PROMPT,
            message=message,
            role="PM_BACKEND",
        )
        return response
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/invoke/cto")
def invoke_cto(body: dict):
    """
    Invoca o agente CTO. Body = message_envelope (spec_ref, context, task, constraints, artifacts).
    Saída: Charter, next_actions (ex.: call PM_BACKEND).
    """
    try:
        message = body if "input" in body else {"request_id": body.get("request_id", "http"), "input": body}
        response = run_agent(
            system_prompt_path=CTO_SYSTEM_PROMPT_PATH,
            message=message,
            role="CTO",
        )
        return response
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/invoke/monitor")
def invoke_monitor_backend(body: dict):
    """
    Invoca o agente Monitor Backend. Body = message_envelope (contexto do projeto, artefatos, estado das tasks).
    Saída: response_envelope com summary, evidence (health report), next_actions (ex.: escalate to PM/CTO).
    """
    try:
        message = body if "input" in body else {"request_id": body.get("request_id", "http"), "input": body}
        response = run_agent(
            system_prompt_path=MONITOR_SYSTEM_PROMPT,
            message=message,
            role="MONITOR_BACKEND",
        )
        return response
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/invoke/dev-backend")
def invoke_dev_backend(body: dict):
    """
    Invoca o agente Dev Backend. Body = message_envelope (request_id, input com spec_ref, task, constraints, artifacts).
    Saída: response_envelope com status, summary, artifacts, evidence, next_actions.
    """
    try:
        message = body if "input" in body else {"request_id": body.get("request_id", "http"), "input": body}
        response = run_agent(
            system_prompt_path=DEV_BACKEND_SYSTEM_PROMPT,
            message=message,
            role="DEV_BACKEND",
        )
        return response
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/invoke/qa-backend")
def invoke_qa_backend(body: dict):
    """
    Invoca o agente QA Backend. Body = message_envelope (spec_ref, task, constraints, artifacts para validar).
    Saída: response_envelope com summary, evidence (QA report), next_actions (OK ou volta para Dev).
    """
    try:
        message = body if "input" in body else {"request_id": body.get("request_id", "http"), "input": body}
        response = run_agent(
            system_prompt_path=QA_BACKEND_SYSTEM_PROMPT,
            message=message,
            role="QA_BACKEND",
        )
        return response
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/invoke/devops-docker")
def invoke_devops_docker(body: dict):
    """
    Invoca o agente DevOps Docker. Body = message_envelope (spec_ref, task, constraints, artifacts).
    Saída: response_envelope com summary, artifacts (ex.: Compose/Terraform/k8s), evidence, next_actions.
    """
    try:
        message = body if "input" in body else {"request_id": body.get("request_id", "http"), "input": body}
        response = run_agent(
            system_prompt_path=DEVOPS_DOCKER_SYSTEM_PROMPT,
            message=message,
            role="DEVOPS_DOCKER",
        )
        return response
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
