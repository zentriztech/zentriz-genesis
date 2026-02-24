"""
Serviço HTTP para agentes (PM, Dev, QA, Monitor, DevOps, Engineer, CTO).
POST /invoke/{role} com body message_envelope; skill_path opcional em input.context.skill_path.
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
from . import pm, dev, qa, monitor, devops
from .cto import CTO_SYSTEM_PROMPT_PATH
from .engineer import ENGINEER_SYSTEM_PROMPT_PATH

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

AGENT_ENDPOINTS = [
    "POST /invoke/engineer",
    "POST /invoke/cto",
    "POST /invoke/pm",
    "POST /invoke/dev",
    "POST /invoke/qa",
    "POST /invoke/monitor",
    "POST /invoke/devops",
]

AGENT_LABELS = {
    "ENGINEER": "Engineer",
    "CTO": "CTO",
    "PM": "PM",
    "DEV": "Dev",
    "QA": "QA",
    "MONITOR": "Monitor",
    "DEVOPS": "DevOps",
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


def _project_id_from_message(body: dict) -> str | None:
    """Extrai project_id do body (message_envelope)."""
    pid = body.get("project_id")
    if pid:
        return str(pid).strip() or None
    inp = body.get("input") or body.get("inputs")
    if isinstance(inp, dict):
        pid = inp.get("project_id")
        if pid:
            return str(pid).strip() or None
    return None


def _request_id_from_message(message: dict) -> str:
    """Extrai request_id para uso em nome de arquivo (sanitizado)."""
    rid = message.get("request_id") or (message.get("input") or {}).get("request_id") or "unknown"
    rid = str(rid).strip()
    safe = "".join(c for c in rid if c.isalnum() or c in "._-")[:64] or "unknown"
    return safe


def _persist_cto_response_json(message: dict, response: dict) -> None:
    """
    Grava a resposta completa da IA (response_envelope) em JSON em docs/cto/ para
    avaliação, mesmo quando o sistema rejeita (BLOCKED/FAIL). Exige project_id e
    PROJECT_FILES_ROOT.
    """
    project_id = _project_id_from_message(message)
    if not project_id:
        return
    try:
        from orchestrator import project_storage as storage
    except ImportError:
        return
    root = os.environ.get("PROJECT_FILES_ROOT", "").strip()
    if not root and getattr(storage, "get_files_root", None):
        root = str(storage.get_files_root())
    if not root:
        return
    if not getattr(storage, "is_enabled", lambda: bool(root))():
        return
    request_id = _request_id_from_message(message)
    filename = f"cto_response_{request_id}.json"
    try:
        payload = json.dumps(response, ensure_ascii=False, indent=2)
        storage.write_doc_by_path(
            project_id, "cto", f"cto/{filename}", payload,
            title="CTO response envelope (IA)",
        )
        logger.info("[CTO] Resposta da IA gravada em docs/cto/%s para avaliação.", filename)
    except Exception as e:
        logger.warning("[CTO] Falha ao gravar resposta JSON: %s", e)


def _persist_cto_artifacts_if_enabled(message: dict, response: dict) -> None:
    """
    Se PROJECT_FILES_ROOT e project_id estiverem definidos, grava os artifacts
    do CTO em disco (docs/ ou project/ conforme path). Permite fluxo completo
    ao chamar POST /invoke/cto sem passar pelo runner.
    """
    _persist_artifacts_for_role(message, response, "cto")


def _persist_engineer_response_json(message: dict, response: dict) -> None:
    """
    Grava a resposta do Engineer (response_envelope) em JSON em docs/engineer/
    para inspeção. Exige project_id e PROJECT_FILES_ROOT.
    """
    project_id = _project_id_from_message(message)
    if not project_id:
        return
    try:
        from orchestrator import project_storage as storage
    except ImportError:
        return
    root = os.environ.get("PROJECT_FILES_ROOT", "").strip()
    if not root and getattr(storage, "get_files_root", None):
        root = str(storage.get_files_root())
    if not root or not getattr(storage, "is_enabled", lambda: bool(root))():
        return
    request_id = _request_id_from_message(message)
    filename = f"engineer_response_{request_id}.json"
    try:
        payload = json.dumps(response, ensure_ascii=False, indent=2)
        storage.write_doc_by_path(
            project_id, "engineer", f"engineer/{filename}", payload,
            title="Engineer response envelope (IA)",
        )
        logger.info("[Engineer] Resposta da IA gravada em docs/engineer/%s", filename)
    except Exception as e:
        logger.warning("[Engineer] Falha ao gravar resposta JSON: %s", e)


def _persist_engineer_artifacts_if_enabled(message: dict, response: dict) -> None:
    """Grava os artifacts do Engineer em disco (docs/engineer/*.md)."""
    _persist_artifacts_for_role(message, response, "engineer")


def _try_persist_engineer_artifacts_from_raw(message: dict, response: dict) -> None:
    """
    Se a resposta tiver menos de 3 artifacts, tenta extrair os 3 .md da resposta bruta
    (raw_response_*.txt) e gravar em docs/engineer/. Assim os 3 arquivos ficam no disco
    mesmo quando o JSON veio incompleto ou com apenas um artifact.
    """
    artifacts = response.get("artifacts") or []
    if len(artifacts) >= 3:
        return
    project_id = _project_id_from_message(message)
    if not project_id:
        return
    request_id = _request_id_from_message(message)
    try:
        from orchestrator import project_storage as storage
        if not getattr(storage, "is_enabled", lambda: False)():
            return
        docs_dir = storage.get_docs_dir(project_id)
        if not docs_dir:
            return
        raw_path = docs_dir / "engineer" / ("raw_response_%s.txt" % request_id)
        if not raw_path.exists():
            return
        raw_text = raw_path.read_text(encoding="utf-8")
        from orchestrator.engineer_raw_extract import persist_engineer_artifacts_from_raw
        n = persist_engineer_artifacts_from_raw(project_id, request_id, raw_text)
        if n:
            logger.info("[Engineer] %d artefato(s) gravado(s) a partir do raw (fallback).", n)
    except Exception as e:
        logger.warning("[Engineer] Fallback raw extract falhou: %s", e)


def _persist_artifacts_for_role(message: dict, response: dict, role_dir: str) -> None:
    """
    Grava artifacts da resposta em disco conforme path (docs/, project/, apps/).
    role_dir: "cto" | "engineer" (usado como creator e subpasta em docs/).
    """
    project_id = _project_id_from_message(message)
    if not project_id:
        return
    try:
        from orchestrator import project_storage as storage
    except ImportError:
        return
    root = os.environ.get("PROJECT_FILES_ROOT", "").strip()
    if not root and getattr(storage, "get_files_root", None):
        root = str(storage.get_files_root())
    if not root or not getattr(storage, "is_enabled", lambda: bool(root))():
        return
    artifacts = response.get("artifacts") or []
    if not artifacts:
        return
    try:
        from orchestrator.envelope import filter_artifacts_by_path_policy
        artifacts = filter_artifacts_by_path_policy(artifacts, project_id)
    except ImportError:
        pass
    for i, art in enumerate(artifacts):
        if not isinstance(art, dict) or not art.get("content"):
            continue
        content = art.get("content", "")
        if isinstance(content, bytes):
            content = content.decode("utf-8", errors="replace")
        else:
            content = str(content)
        # Decodificar escapes JSON se o conteúdo veio com \n literal (ex.: fallback Engineer)
        if "\\n" in content or "\\t" in content:
            try:
                from orchestrator.envelope import _unescape_json_string
                content = _unescape_json_string(content)
            except ImportError:
                pass
        stripped = content.strip()
        if not stripped or stripped in ("...", "[...]", ".") or len(stripped) < 20:
            logger.info("[%s] Artefato %s ignorado (conteúdo trivial: %d chars).", role_dir.title(), art.get("path", i), len(stripped))
            continue
        path_val = (art.get("path") or "").strip()
        title = art.get("purpose") or f"Artifact {i}"
        try:
            if path_val.startswith("project/"):
                storage.write_project_artifact(project_id, path_val[8:].lstrip("/"), content)
            elif path_val.startswith("docs/"):
                storage.write_doc_by_path(
                    project_id, role_dir, path_val[5:].lstrip("/"), content, title=title
                )
            elif path_val.startswith("apps/"):
                if getattr(storage, "write_apps_artifact", None):
                    storage.write_apps_artifact(project_id, path_val[5:].lstrip("/"), content)
                else:
                    storage.write_doc_by_path(
                        project_id, role_dir, path_val[5:].lstrip("/"), content, title=title
                    )
            else:
                storage.write_doc(project_id, role_dir, f"artifact_{i}", content, title=title)
        except Exception as e:
            logger.warning("[%s] Falha ao gravar artifact em disco: %s", role_dir.title(), e)


def _invoke_agent(body: dict, system_prompt, role: str) -> dict:
    """Handler genérico para endpoints com prompt fixo."""
    agent_name = AGENT_LABELS.get(role, role)
    try:
        message = body if "input" in body else {"request_id": body.get("request_id", "http"), "input": body}
        logger.info("[%s] Recebeu solicitação. Processando...", agent_name)
        response = run_agent(system_prompt_path=system_prompt, message=message, role=role)
        logger.info("[%s] Solicitação processada com sucesso.", agent_name)
        if role == "CTO":
            _persist_cto_response_json(message, response)
            _persist_cto_artifacts_if_enabled(message, response)
        elif role == "ENGINEER":
            _persist_engineer_response_json(message, response)
            _persist_engineer_artifacts_if_enabled(message, response)
            _try_persist_engineer_artifacts_from_raw(message, response)
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


def _invoke_parametrized(body: dict, get_path_fn, role: str) -> dict:
    """Handler para agentes com skill_path (dev, pm, qa, monitor, devops)."""
    agent_name = AGENT_LABELS.get(role, role)
    try:
        message = body if "input" in body else {"request_id": body.get("request_id", "http"), "input": body}
        skill_path = ((message.get("input") or {}).get("context") or {}).get("skill_path")
        prompt_path = get_path_fn(skill_path)
        logger.info("[%s] Recebeu solicitação (skill_path=%s). Processando...", agent_name, skill_path or "default")
        response = run_agent(system_prompt_path=prompt_path, message=message, role=role)
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


@app.post("/invoke/engineer")
def invoke_engineer(body: dict):
    return _invoke_agent(body, ENGINEER_SYSTEM_PROMPT_PATH, "ENGINEER")


@app.post("/invoke/cto")
def invoke_cto(body: dict):
    return _invoke_agent(body, CTO_SYSTEM_PROMPT_PATH, "CTO")


@app.post("/invoke/pm")
def invoke_pm(body: dict):
    return _invoke_parametrized(body, pm.get_system_prompt_path, "PM")


@app.post("/invoke/dev")
def invoke_dev(body: dict):
    return _invoke_parametrized(body, dev.get_system_prompt_path, "DEV")


@app.post("/invoke/qa")
def invoke_qa(body: dict):
    return _invoke_parametrized(body, qa.get_system_prompt_path, "QA")


@app.post("/invoke/monitor")
def invoke_monitor(body: dict):
    return _invoke_parametrized(body, monitor.get_system_prompt_path, "MONITOR")


@app.post("/invoke/devops")
def invoke_devops(body: dict):
    return _invoke_parametrized(body, devops.get_system_prompt_path, "DEVOPS")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
