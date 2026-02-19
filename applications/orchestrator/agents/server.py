"""
Serviço HTTP para agentes (PM Backend, Monitor, etc.). POST /invoke com body message_envelope.
"""
import json
import os
import logging
import traceback as _tb
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from pathlib import Path
_repo_root = Path(__file__).resolve().parent.parent.parent
_dotenv = _repo_root / ".env"
if _dotenv.exists():
    from dotenv import load_dotenv
    load_dotenv(_dotenv)

from .runtime import run_agent, SHOW_TRACEBACK
from .pm_backend import SYSTEM_PROMPT_PATH as PM_SYSTEM_PROMPT
from .monitor_backend import SYSTEM_PROMPT_PATH as MONITOR_SYSTEM_PROMPT
from .cto_agent import CTO_SYSTEM_PROMPT_PATH
from .engineer_agent import ENGINEER_SYSTEM_PROMPT_PATH
from .dev_backend import SYSTEM_PROMPT_PATH as DEV_BACKEND_SYSTEM_PROMPT
from .qa_backend import SYSTEM_PROMPT_PATH as QA_BACKEND_SYSTEM_PROMPT
from .devops_docker import SYSTEM_PROMPT_PATH as DEVOPS_DOCKER_SYSTEM_PROMPT

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

AGENT_ENDPOINTS = [
    "POST /invoke",
    "POST /invoke/cto",
    "POST /invoke/engineer",
    "POST /invoke/monitor",
    "POST /invoke/dev-backend",
    "POST /invoke/qa-backend",
    "POST /invoke/devops-docker",
]

AGENT_LABELS = {
    "PM_BACKEND": "PM Backend",
    "ENGINEER": "Engineer",
    "CTO": "CTO",
    "MONITOR_BACKEND": "Monitor Backend",
    "DEV_BACKEND": "Dev Backend",
    "QA_BACKEND": "QA Backend",
    "DEVOPS_DOCKER": "DevOps Docker",
}


def _env_diagnostic() -> None:
    model = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")
    key_set = bool(os.environ.get("CLAUDE_API_KEY", "").strip())
    key_preview = "(definida)" if key_set else "(NÃO DEFINIDA — chamadas à Claude falharão)"
    show_tb = "ativado" if SHOW_TRACEBACK else "desativado"
    logger.info("CLAUDE_MODEL=%s | CLAUDE_API_KEY %s | SHOW_TRACEBACK %s", model, key_preview, show_tb)
    if not key_set:
        logger.error(
            "CLAUDE_API_KEY não está definida neste container. "
            "Defina no .env e reinicie: docker compose up -d --force-recreate agents"
        )


def _error_response(role: str, exc: Exception) -> dict:
    """Constrói resposta de erro estruturada, respeitando SHOW_TRACEBACK."""
    agent_name = AGENT_LABELS.get(role, role)
    err_str = str(exc)

    # Tentar parsear JSON estruturado do runtime
    try:
        detail = json.loads(err_str)
    except (json.JSONDecodeError, TypeError):
        detail = {"error": err_str, "agent": role}
        if SHOW_TRACEBACK:
            detail["traceback"] = "".join(_tb.format_exception(type(exc), exc, exc.__traceback__))

    error_msg = detail.get("error", err_str)
    human_msg = f"O agente {agent_name} encontrou um erro: {error_msg}"
    detail["human_message"] = human_msg
    return detail


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _env_diagnostic()
    logger.info("Agents service started. Endpoints: %s", ", ".join(AGENT_ENDPOINTS))
    yield
    logger.info("Agents service shutdown")


app = FastAPI(title="Zentriz Genesis Agents", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
def health():
    model = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")
    key_ok = bool(os.environ.get("CLAUDE_API_KEY", "").strip())
    return {"status": "ok", "claude_model": model, "claude_configured": key_ok, "show_traceback": SHOW_TRACEBACK}


def _invoke_agent(body: dict, system_prompt, role: str) -> dict:
    """Handler genérico para todos os endpoints de invoke."""
    agent_name = AGENT_LABELS.get(role, role)
    try:
        message = body if "input" in body else {"request_id": body.get("request_id", "http"), "input": body}
        logger.info("[%s] Recebeu solicitação. Processando...", agent_name)
        response = run_agent(system_prompt_path=system_prompt, message=message, role=role)
        logger.info("[%s] Solicitação processada com sucesso.", agent_name)
        return response
    except ValueError as e:
        logger.warning("[%s] Erro de validação: %s", agent_name, e)
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        logger.error("[%s] Arquivo não encontrado: %s", agent_name, e)
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        detail = _error_response(role, e)
        logger.error("[%s] Erro ao processar: %s", agent_name, detail.get("error", str(e)))
        raise HTTPException(status_code=500, detail=detail)


@app.post("/invoke")
def invoke_pm_backend(body: dict):
    return _invoke_agent(body, PM_SYSTEM_PROMPT, "PM_BACKEND")


@app.post("/invoke/engineer")
def invoke_engineer(body: dict):
    return _invoke_agent(body, ENGINEER_SYSTEM_PROMPT_PATH, "ENGINEER")


@app.post("/invoke/cto")
def invoke_cto(body: dict):
    return _invoke_agent(body, CTO_SYSTEM_PROMPT_PATH, "CTO")


@app.post("/invoke/monitor")
def invoke_monitor_backend(body: dict):
    return _invoke_agent(body, MONITOR_SYSTEM_PROMPT, "MONITOR_BACKEND")


@app.post("/invoke/dev-backend")
def invoke_dev_backend(body: dict):
    return _invoke_agent(body, DEV_BACKEND_SYSTEM_PROMPT, "DEV_BACKEND")


@app.post("/invoke/qa-backend")
def invoke_qa_backend(body: dict):
    return _invoke_agent(body, QA_BACKEND_SYSTEM_PROMPT, "QA_BACKEND")


@app.post("/invoke/devops-docker")
def invoke_devops_docker(body: dict):
    return _invoke_agent(body, DEVOPS_DOCKER_SYSTEM_PROMPT, "DEVOPS_DOCKER")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
