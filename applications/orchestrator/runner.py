"""
Runner do orquestrador: spec -> Engineer -> CTO (Charter) -> PM (backlog).
Quando API e PROJECT_ID estão definidos: após PM faz seed de tarefas e
entra no Monitor Loop (Fase 2), que aciona Dev/QA/DevOps conforme estado das tasks
até o usuário aceitar o projeto (POST /accept) ou parar (SIGTERM/stopped).
Persiste estado em orchestrator/state/ e emite eventos conforme schemas.
Uso: python -m orchestrator.runner --spec spec/PRODUCT_SPEC.md
"""
import argparse
import json
import logging
import os
import signal
import sys
import time
import traceback as _tb
import urllib.error
import urllib.request
from pathlib import Path
from datetime import datetime, timezone

_shutdown_requested = False

def _sigterm_handler(_signum, _frame):
    global _shutdown_requested
    _shutdown_requested = True
    logger = logging.getLogger(__name__)
    logger.info("[Pipeline] SIGTERM recebido; encerrando Monitor Loop.")

def _get_summary_human(*a, **k):
    from orchestrator.dialogue import get_summary_human
    return get_summary_human(*a, **k)


def _project_storage():
    try:
        from orchestrator import project_storage
        return project_storage
    except ImportError:
        return None

_here = Path(__file__).resolve().parent
_repo = _here.parent.parent
REPO_ROOT = _repo.parent if _repo.name == "applications" else _repo
APPLICATIONS_ROOT = REPO_ROOT / "applications" if (REPO_ROOT / "applications").exists() else REPO_ROOT

_dotenv = REPO_ROOT / ".env"
if _dotenv.exists():
    from dotenv import load_dotenv
    load_dotenv(_dotenv)

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

STATE_DIR = APPLICATIONS_ROOT / "orchestrator" / "state"
EVENTS_DIR = APPLICATIONS_ROOT / "orchestrator" / "events" / "schemas"

SHOW_TRACEBACK = os.environ.get("SHOW_TRACEBACK", "true").strip().lower() in ("1", "true", "yes")


def ensure_state_dir() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)


def load_spec(spec_path: Path) -> str:
    path = spec_path if spec_path.is_absolute() else REPO_ROOT / spec_path
    if not path.exists():
        raise FileNotFoundError(f"Spec não encontrada: {path}")
    return path.read_text(encoding="utf-8")


def _agents_root() -> Path:
    return APPLICATIONS_ROOT / "agents"


# ---------------------------------------------------------------------------
# Chamadas aos agentes
# ---------------------------------------------------------------------------

def call_engineer(
    spec_ref: str,
    spec_content: str,
    request_id: str,
    cto_questionamentos: str | None = None,
    pipeline_ctx: "PipelineContext | None" = None,
) -> dict:
    if pipeline_ctx:
        inputs = pipeline_ctx.build_inputs_for_engineer(cto_questionamentos)
        if spec_content:
            inputs["product_spec"] = spec_content[:15000]
    else:
        inputs = {
            "spec_ref": spec_ref,
            "product_spec": spec_content[:15000] if spec_content else "",
            "constraints": ["spec-driven", "paths-resilient", "no-invent"],
        }
        if cto_questionamentos:
            inputs["cto_questionamentos"] = cto_questionamentos
    message = _build_message_envelope(
        request_id, "Engineer", "generic", "generate_engineering_docs",
        task_id=None, task="Gerar proposta técnica (stacks, squads, dependências).",
        inputs=inputs, existing_artifacts=[], limits={"max_rounds": 3, "timeout_sec": 120},
    )
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("engineer", message)
    from orchestrator.agents.runtime import run_agent
    engineer_prompt = _agents_root() / "engineer" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=engineer_prompt, message=message, role="ENGINEER")


def _load_spec_template() -> str:
    """Carrega o modelo aceitável de spec (PRODUCT_SPEC_TEMPLATE) para o CTO converter/validar."""
    for rel in ("project/spec/PRODUCT_SPEC_TEMPLATE.md", "spec/PRODUCT_SPEC_TEMPLATE.md"):
        path = REPO_ROOT / rel
        if path.exists():
            return path.read_text(encoding="utf-8")
    return ""


def call_cto(
    spec_ref: str,
    request_id: str,
    engineer_proposal: str = "",
    spec_content: str = "",
    spec_template: str = "",
    backlog_summary: str = "",
    validate_backlog_only: bool = False,
    pipeline_ctx: "PipelineContext | None" = None,
) -> dict:
    if validate_backlog_only:
        mode = "validate_backlog"
    elif engineer_proposal:
        mode = "validate_engineer_docs" if not backlog_summary else "charter_and_proposal"
    else:
        mode = "spec_intake_and_normalize"

    if pipeline_ctx:
        inputs = pipeline_ctx.build_inputs_for_cto(mode, backlog_summary, validate_backlog_only)
        if engineer_proposal:
            inputs["engineer_stack_proposal"] = engineer_proposal[:15000]
        if spec_content:
            inputs["spec_raw"] = spec_content[:20000]
            inputs["product_spec"] = spec_content[:20000]
        if spec_template:
            inputs["spec_template"] = spec_template[:15000]
        if backlog_summary:
            inputs["backlog_summary"] = backlog_summary[:15000]
    else:
        inputs = {"spec_ref": spec_ref, "constraints": ["spec-driven", "paths-resilient", "no-invent"]}
        if engineer_proposal:
            inputs["engineer_stack_proposal"] = engineer_proposal
        if spec_content:
            inputs["spec_raw"] = spec_content[:20000]
            inputs["product_spec"] = spec_content[:20000]
        if spec_template:
            inputs["spec_template"] = spec_template[:15000]
        if backlog_summary:
            inputs["backlog_summary"] = backlog_summary[:15000]
        if validate_backlog_only:
            inputs["validate_backlog_only"] = True
    message = _build_message_envelope(
        request_id, "CTO", "generic", mode, task_id=None, task="",
        inputs=inputs, existing_artifacts=[], limits={"max_rounds": 3, "timeout_sec": 120},
    )
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("cto", message)
    from orchestrator.agents.runtime import run_agent
    cto_prompt = _agents_root() / "cto" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=cto_prompt, message=message, role="CTO")


def infer_pm_module_from_engineer_proposal(engineer_proposal: str) -> str:
    """
    Infere o módulo/squad do PM (web, backend, mobile) a partir da proposta do Engineer.
    O Engineer define squads no engineer_proposal (ex.: 'Squad: Web (Frontend)', 'Backend Squad: Desnecessário').
    Retorna 'web' | 'backend' | 'mobile'. Default 'web' para landing/estático quando não há backend.
    """
    if not (engineer_proposal or "").strip():
        return "web"
    text = (engineer_proposal or "").lower()
    # Backend como squad explícita (equipe/squad de API, servidor)
    if "squad backend" in text or "equipe backend" in text or "backend squad" in text:
        if "desnecessário" in text or "desnecessario" in text or "não" in text or "nao" in text:
            pass  # "Backend Squad: Desnecessário" → não é backend
        else:
            return "backend"
    if "backend api" in text and "squad" in text:
        return "backend"
    # Mobile como squad
    if "squad mobile" in text or "equipe mobile" in text or "mobile squad" in text:
        return "mobile"
    # Web/Frontend: único squad, ou squad web, ou next.js/react sem backend
    if "squad web" in text or "squad: web" in text or "único squad web" in text or "um único squad" in text:
        return "web"
    if "frontend" in text and "backend" not in text:
        return "web"
    if "next.js" in text or "nextjs" in text:
        if "backend" not in text or "desnecessário" in text or "zero backend" in text:
            return "web"
    return "web"


def call_pm(
    spec_ref: str,
    charter_summary: str,
    request_id: str,
    module: str = "backend",
    engineer_proposal: str = "",
    cto_questionamentos: str | None = None,
    pipeline_ctx: "PipelineContext | None" = None,
) -> dict:
    # Garantir que o server carregue o SYSTEM_PROMPT correto (pm/web, pm/backend, pm/mobile)
    if not (module in ("web", "backend", "mobile")):
        module = "web"
    skill_path = f"pm/{module}"
    if pipeline_ctx:
        pipeline_ctx.current_module = module
        inputs = pipeline_ctx.build_inputs_for_pm(cto_questionamentos)
        if engineer_proposal:
            inputs["engineer_proposal"] = engineer_proposal[:15000]
        if charter_summary:
            inputs["charter"] = charter_summary[:15000]
            inputs["charter_summary"] = charter_summary[:15000]
    else:
        inputs = {
            "spec_ref": spec_ref,
            "charter": charter_summary,
            "charter_summary": charter_summary,
            "module": module,
            "constraints": ["spec-driven", "paths-resilient", "no-invent"],
        }
        if engineer_proposal:
            inputs["engineer_proposal"] = engineer_proposal
        if cto_questionamentos:
            inputs["cto_questionamentos"] = cto_questionamentos
    inputs["context"] = inputs.get("context") or {}
    inputs["context"]["skill_path"] = skill_path
    message = _build_message_envelope(
        request_id, "PM", module, "generate_backlog",
        task_id=None, task=f"Gerar backlog da squad {module}.",
        inputs=inputs, existing_artifacts=[], limits={"max_rounds": 3, "timeout_sec": 120},
    )
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("pm", message)
    from orchestrator.agents.runtime import run_agent
    pm_prompt = _agents_root() / "pm" / module / "SYSTEM_PROMPT.md"
    if not pm_prompt.exists():
        pm_prompt = _agents_root() / "pm" / "backend" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=pm_prompt, message=message, role="PM")


def call_dev(
    spec_ref: str,
    charter_summary: str,
    backlog_summary: str,
    request_id: str,
    task_id: str | None = None,
    task: str = "",
    code_refs: list | None = None,
    existing_artifacts: list | None = None,
    task_dict: dict | None = None,
    dependency_code: dict | None = None,
    pipeline_ctx: "PipelineContext | None" = None,
) -> dict:
    inputs = {
        "spec_ref": spec_ref,
        "charter": charter_summary,
        "charter_summary": charter_summary,
        "backlog": backlog_summary,
        "backlog_summary": backlog_summary,
        "constraints": ["spec-driven", "paths-resilient", "no-invent"],
    }
    if code_refs:
        inputs["code_refs"] = code_refs
    if task_dict:
        inputs["current_task"] = {
            "id": task_dict.get("taskId") or task_dict.get("task_id") or task_id,
            "title": task_dict.get("title") or task_dict.get("name") or "",
            "description": task_dict.get("description") or task or "",
            "acceptance_criteria": task_dict.get("acceptance_criteria") or task_dict.get("acceptanceCriteria") or [],
            "fr_ref": task_dict.get("fr_ref") or task_dict.get("frRef") or "",
        }
    if dependency_code:
        inputs["dependency_code"] = dependency_code
    if pipeline_ctx:
        inputs["completed_summary"] = [{"task_id": t, "status": "done"} for t in pipeline_ctx.completed_tasks]
    message = _build_message_envelope(
        request_id, "Dev", "backend", "implement_task",
        task_id=task_id,
        task=task or (task_dict.get("description") if task_dict else "") or "Implementar tarefa conforme backlog e spec.",
        inputs=inputs,
        existing_artifacts=existing_artifacts or [],
        limits={"max_rework": int(os.environ.get("MAX_QA_REWORK", "3")), "timeout_sec": 120},
    )
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("dev", message)
    from orchestrator.agents.runtime import run_agent
    dev_prompt = _agents_root() / "dev" / "backend" / "nodejs" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=dev_prompt, message=message, role="DEV")


def call_qa(
    spec_ref: str,
    charter_summary: str,
    backlog_summary: str,
    dev_summary: str,
    request_id: str,
    task_id: str | None = None,
    task: str = "",
    code_refs: list | None = None,
    existing_artifacts: list | None = None,
) -> dict:
    inputs = {
        "spec_ref": spec_ref,
        "charter_summary": charter_summary,
        "backlog_summary": backlog_summary,
        "dev_summary": dev_summary,
        "constraints": ["spec-driven", "paths-resilient"],
    }
    if code_refs:
        inputs["code_refs"] = code_refs
    message = _build_message_envelope(
        request_id, "QA", "backend", "validate_task",
        task_id=task_id,
        task=task or "Validar artefatos do Dev (veredito QA_PASS ou QA_FAIL).",
        inputs=inputs,
        existing_artifacts=existing_artifacts or [],
        limits={"timeout_sec": 120},
    )
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("qa", message)
    from orchestrator.agents.runtime import run_agent
    qa_prompt = _agents_root() / "qa" / "backend" / "nodejs" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=qa_prompt, message=message, role="QA")


def call_monitor(spec_ref: str, charter_summary: str, backlog_summary: str, dev_summary: str, qa_summary: str, request_id: str) -> dict:
    inputs = {
        "spec_ref": spec_ref,
        "charter_summary": charter_summary,
        "backlog_summary": backlog_summary,
        "dev_summary": dev_summary,
        "qa_summary": qa_summary,
        "constraints": ["spec-driven"],
    }
    message = _build_message_envelope(
        request_id, "Monitor", "backend", "orchestrate",
        task_id=None, task="Decidir próximo passo (Dev/QA/DevOps) e atualizar estado.",
        inputs=inputs, existing_artifacts=[], limits={"max_rework": int(os.environ.get("MAX_QA_REWORK", "3")), "timeout_sec": 120},
    )
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("monitor", message)
    from orchestrator.agents.runtime import run_agent
    monitor_prompt = _agents_root() / "monitor" / "backend" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=monitor_prompt, message=message, role="MONITOR")


def call_devops(spec_ref: str, charter_summary: str, backlog_summary: str, request_id: str) -> dict:
    inputs = {
        "spec_ref": spec_ref,
        "charter": charter_summary,
        "charter_summary": charter_summary,
        "backlog_summary": backlog_summary,
        "constraints": ["spec-driven", "paths-resilient"],
    }
    message = _build_message_envelope(
        request_id, "DevOps", "docker", "provision_artifacts",
        task_id=None, task="Gerar artefatos de infra (Dockerfile, runbook) em project/ e docs/devops/.",
        inputs=inputs, existing_artifacts=[], limits={"timeout_sec": 120},
    )
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("devops", message)
    from orchestrator.agents.runtime import run_agent
    devops_prompt = _agents_root() / "devops" / "docker" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=devops_prompt, message=message, role="DEVOPS")


# ---------------------------------------------------------------------------
# Persistência de estado e eventos
# ---------------------------------------------------------------------------

def persist_state(spec_ref: str, charter: dict, backlog: dict, events: list) -> None:
    ensure_state_dir()
    state = {
        "spec_ref": spec_ref,
        "charter": charter,
        "backlog": backlog,
        "events": events,
        "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    (STATE_DIR / "current_project.json").write_text(
        json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def emit_event(event_type: str, payload: dict, request_id: str) -> None:
    ensure_state_dir()
    event = {
        "event_type": event_type,
        "request_id": request_id,
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "payload": payload,
    }
    events_file = STATE_DIR / "events.jsonl"
    with open(events_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")
    logger.info("Evento emitido: %s", event_type)


# ---------------------------------------------------------------------------
# Diálogo (log de passos e erros no portal)
# ---------------------------------------------------------------------------

def _project_id() -> str | None:
    return os.environ.get("PROJECT_ID")


def _build_message_envelope(
    request_id: str,
    agent: str,
    variant: str,
    mode: str,
    task_id: str | None,
    task: str,
    inputs: dict,
    existing_artifacts: list | None = None,
    limits: dict | None = None,
) -> dict:
    """Monta MessageEnvelope completo para o Enforcer (project_id, mode, task_id, inputs, existing_artifacts, limits)."""
    project_id = _project_id() or "default"
    return {
        "request_id": request_id,
        "project_id": project_id,
        "agent": agent,
        "variant": variant or "generic",
        "mode": mode,
        "task_id": task_id,
        "task": task or "",
        "inputs": inputs,
        "existing_artifacts": existing_artifacts or [],
        "limits": limits or {"max_rounds": 3, "max_rework": 3, "timeout_sec": int(os.environ.get("REQUEST_TIMEOUT", "300"))},
        "input": inputs,  # compatibilidade: runtime pode ler input ou inputs
    }


def _post_dialogue(from_agent: str, to_agent: str, event_type: str, summary_human: str, request_id: str) -> None:
    pid = _project_id()
    if not pid:
        return
    from orchestrator.dialogue import post_dialogue
    post_dialogue(pid, from_agent, to_agent, summary_human, event_type=event_type, request_id=request_id)


def _post_step(step_message: str, request_id: str) -> None:
    """Registra um passo no log do portal. Mensagem deve ser em linguagem humana."""
    logger.info("[Pipeline] %s", step_message)
    _post_dialogue("system", "system", "step", step_message, request_id)


def _audit_log(agent: str, request_id: str, response: dict) -> None:
    """Audit trail por chamada (Blueprint 6 / Fase 4). Log estruturado para rastreabilidade."""
    status = response.get("status", "?")
    artifacts_count = len(response.get("artifacts") or [])
    validator_pass = response.get("validator_pass")
    validation_errors = response.get("validation_errors") or []
    artifacts_paths = response.get("artifacts_paths") or []
    logger.info(
        "[Audit] agent=%s request_id=%s status=%s artifacts_count=%d validator_pass=%s validation_errors=%s artifacts_paths=%s",
        agent, request_id, status, artifacts_count, validator_pass, len(validation_errors), artifacts_paths[:10],
    )


def _post_agent_working(agent_key: str, activity_message: str, request_id: str) -> None:
    """Registra que um agente está em execução (LLM processando). Portal pode exibir loading no passo correspondente."""
    logger.info("[Pipeline] %s", activity_message)
    _post_dialogue(agent_key, "system", "agent_working", activity_message, request_id)


def _content_for_doc(response: dict) -> str:
    """
    Extrai texto adequado para gravar em .md a partir do response_envelope do agente.
    A LLM às vezes devolve no campo summary um JSON (envelope inteiro); evita gravar isso como .md.
    """
    raw = (response.get("summary") or "").strip()
    if not raw:
        return ""
    # Se o summary for um JSON (ex.: envelope inteiro), tenta extrair o summary interno
    if raw.startswith("{"):
        try:
            data = json.loads(raw)
            if isinstance(data.get("summary"), str):
                inner = data["summary"].strip()
                if inner.startswith("{"):
                    try:
                        data2 = json.loads(inner)
                        if isinstance(data2.get("summary"), str):
                            return data2["summary"]
                    except (json.JSONDecodeError, TypeError):
                        pass
                return inner
            # Fallback: se for dict, monta texto legível
            if isinstance(data, dict) and "summary" not in data:
                return raw
        except (json.JSONDecodeError, TypeError):
            pass
    return raw


def _validate_response_quality(agent: str, response: dict) -> tuple[bool, list[str]]:
    """Delegate para envelope.validate_response_quality (AGENT_LLM_COMMUNICATION_ANALYSIS)."""
    try:
        from orchestrator.envelope import validate_response_quality as _v
        return _v(agent, response)
    except ImportError:
        return True, []


def _is_qa_pass(qa_response: dict) -> bool:
    """Considera QA como aprovado se status ou summary indicarem sucesso (evita QA_FAIL infinito por variação do LLM)."""
    status = (qa_response.get("status") or "").strip().lower()
    summary = (qa_response.get("summary") or "").lower()
    if any(k in status for k in ("pass", "qa_pass", "ok", "aprovado", "success", "done")):
        return True
    if any(k in summary for k in ("aprovado", "passou", "ok", "sem problemas", "approved")):
        return True
    return False


def _is_timeout_error(exc: BaseException | None, message: str) -> bool:
    """Detecta timeout para exibir mensagem amigável (recorrência: runner→agents HTTP)."""
    if exc is not None:
        if isinstance(exc, TimeoutError):
            return True
        if isinstance(exc, OSError) and "timed out" in str(exc).lower():
            return True
    return "timed out" in (message or "").lower() or "timeout" in (message or "").lower()


def _post_error(message: str, request_id: str, exc: BaseException | None = None) -> None:
    """Registra erro no log do portal. Inclui traceback apenas se SHOW_TRACEBACK=true."""
    body = message
    if exc is not None:
        error_detail = _extract_error_info(exc)
        if error_detail.get("human_message"):
            body = error_detail["human_message"]
        if _is_timeout_error(exc, body):
            body = "O agente demorou mais que o limite (timeout). Tente iniciar o pipeline novamente ou defina REQUEST_TIMEOUT=300 no ambiente do runner."
        if SHOW_TRACEBACK:
            tb_text = error_detail.get("traceback", "")
            if not tb_text:
                tb_text = "".join(_tb.format_exception(type(exc), exc, exc.__traceback__))
            body += "\n\n--- Traceback (SHOW_TRACEBACK=true) ---\n" + tb_text[:3000]
    elif _is_timeout_error(None, body):
        body = "O agente demorou mais que o limite (timeout). Tente iniciar o pipeline novamente ou defina REQUEST_TIMEOUT=300 no ambiente do runner."
    logger.error("[Pipeline] %s", body[:500])
    _post_dialogue("system", "error", "error", body, request_id)


def _extract_error_info(exc: BaseException) -> dict:
    """Extrai informações estruturadas de erros dos agentes (que usam JSON no message)."""
    msg = str(exc)
    try:
        return json.loads(msg)
    except (json.JSONDecodeError, TypeError):
        return {"error": msg, "human_message": msg}


def _patch_project(body: dict) -> bool:
    base = os.environ.get("API_BASE_URL")
    project_id = os.environ.get("PROJECT_ID")
    token = os.environ.get("GENESIS_API_TOKEN")
    if not base or not project_id or not token:
        return False
    url = f"{base.rstrip('/')}/api/projects/{project_id}"
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="PATCH",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if 200 <= resp.status < 300:
                logger.info("Projeto atualizado na API: %s", body)
                return True
    except Exception as e:
        logger.warning("Falha ao atualizar projeto na API: %s", e)
    return False


def _api_available() -> bool:
    return bool(
        os.environ.get("API_BASE_URL")
        and os.environ.get("GENESIS_API_TOKEN")
        and os.environ.get("PROJECT_ID")
    )


def _api_request(method: str, path: str, body: dict | None = None) -> tuple[dict | list | None, int]:
    base = os.environ.get("API_BASE_URL", "").rstrip("/")
    token = os.environ.get("GENESIS_API_TOKEN")
    if not base or not token:
        return None, 0
    url = f"{base}{path}"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    data = json.dumps(body).encode("utf-8") if body else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            out = json.loads(raw) if raw else None
            return out, resp.status
    except urllib.error.HTTPError as e:
        try:
            out = json.loads(e.read().decode("utf-8"))
        except Exception:
            out = None
        return out, e.code
    except Exception as e:
        logger.warning("Falha na requisição API %s %s: %s", method, path, e)
        return None, 0


def _api_get(path: str) -> tuple[dict | list | None, int]:
    return _api_request("GET", path)


def _api_post(path: str, body: dict) -> tuple[dict | list | None, int]:
    return _api_request("POST", path, body)


def _api_patch(path: str, body: dict) -> tuple[dict | list | None, int]:
    return _api_request("PATCH", path, body)


def _seed_tasks(project_id: str) -> bool:
    path = f"/api/projects/{project_id}/tasks"
    body = {
        "tasks": [
            {"task_id": "TSK-BE-001", "module": "backend", "owner_role": "DEV_BACKEND", "status": "ASSIGNED"}
        ]
    }
    data, status = _api_post(path, body)
    if 200 <= status < 300:
        logger.info("[Monitor Loop] Tarefas iniciais criadas para projeto %s", project_id)
        return True
    logger.warning("[Monitor Loop] Falha ao criar tarefas: %s %s", status, data)
    return False


def _get_project_status(project_id: str) -> str | None:
    data, status = _api_get(f"/api/projects/{project_id}")
    if status != 200 or not isinstance(data, dict):
        return None
    return data.get("status")


def _get_tasks(project_id: str) -> list:
    data, status = _api_get(f"/api/projects/{project_id}/tasks")
    if status != 200 or not isinstance(data, list):
        return []
    return data


def _update_task(project_id: str, task_id: str, **kwargs) -> bool:
    path = f"/api/projects/{project_id}/tasks/{task_id}"
    data, status = _api_patch(path, kwargs)
    return 200 <= status < 300


def _run_monitor_loop(
    project_id: str,
    spec_ref: str,
    charter_summary: str,
    backlog_summary: str,
    request_id: str,
    pipeline_ctx: "PipelineContext | None" = None,
) -> None:
    global _shutdown_requested
    signal.signal(signal.SIGTERM, _sigterm_handler)
    storage = _project_storage()
    dev_summary = ""
    qa_summary = ""
    last_dev_artifacts: list = []
    devops_done = False
    # Tarefas marcadas DONE por terem atingido o máximo de reworks do QA (não aprovação)
    tasks_done_after_qa_fail: set[str] = set()
    # Tarefas que não devem mais acionar Dev (circuit breaker ou máximo de BLOCKED sem apps/)
    dev_gave_up_tasks: set[str] = set()
    consecutive_dev_blocked: dict[str, int] = {}
    max_consecutive_dev_blocked = int(os.environ.get("MAX_CONSECUTIVE_DEV_BLOCKED", "5"))
    loop_interval = int(os.environ.get("MONITOR_LOOP_INTERVAL", "20"))
    max_qa_rework = int(os.environ.get("MAX_QA_REWORK", "3"))
    qa_fail_count: dict[str, int] = {}
    while True:
        if _shutdown_requested:
            _post_step("Monitor Loop encerrado (sinal recebido).", request_id)
            break
        status = _get_project_status(project_id)
        if status in ("accepted", "stopped"):
            _post_step(f"Monitor Loop encerrado: status do projeto é '{status}'.", request_id)
            break
        tasks = _get_tasks(project_id)
        try:
            from orchestrator.pipeline_context import validate_backlog_tasks_max_files
            lei8_issues = validate_backlog_tasks_max_files(tasks)
            if lei8_issues:
                logger.warning("[LEI 8] Tasks com mais de 3 arquivos estimados: %s", lei8_issues[:5])
        except Exception:
            pass
        waiting_review = [t for t in tasks if t.get("status") == "WAITING_REVIEW"]
        need_qa = len(waiting_review) > 0
        need_dev = any(
            t.get("status") in ("ASSIGNED", "IN_PROGRESS", "QA_FAIL", "BLOCKED")
            for t in tasks
        )
        all_done = bool(tasks) and all(t.get("status") == "DONE" for t in tasks)

        if need_qa and waiting_review:
            task = waiting_review[0]
            task_id = task.get("taskId") or task.get("task_id")
            task_desc = task.get("title") or task.get("description") or task.get("name") or ""
            code_refs = [a.get("path") for a in last_dev_artifacts if isinstance(a, dict) and a.get("path")]
            _post_step("O Monitor acionou o QA para revisar a tarefa.", request_id)
            _post_agent_working("qa", "O QA está revisando os artefatos e executando testes.", request_id)
            try:
                qa_response = call_qa(
                    spec_ref, charter_summary, backlog_summary, dev_summary, request_id,
                    task_id=task_id, task=task_desc, code_refs=code_refs, existing_artifacts=last_dev_artifacts,
                )
                _audit_log("qa", request_id, qa_response)
                qa_summary = qa_response.get("summary", "")
                qa_status = qa_response.get("status", "?")
                _post_dialogue(
                    "dev", "qa", "qa.review",
                    _get_summary_human("qa.review", "qa", "monitor", qa_summary[:200]),
                    request_id,
                )
                if project_id and storage and storage.is_enabled():
                    storage.write_doc(project_id, "qa", "report", _content_for_doc(qa_response), title="QA report")
                passed = _is_qa_pass(qa_response)
                if passed:
                    new_status = "QA_PASS"
                    _update_task(project_id, task_id, status=new_status)
                    _update_task(project_id, task_id, status="DONE")
                    qa_fail_count[task_id] = 0
                    if pipeline_ctx and last_dev_artifacts:
                        for art in last_dev_artifacts:
                            if isinstance(art, dict) and art.get("path") and art.get("content"):
                                path_val = (art.get("path") or "").strip()
                                if path_val.startswith("apps/") or path_val.startswith("docs/"):
                                    pipeline_ctx.register_artifact(path_val, art.get("content", ""), task_id)
                    _post_step(f"QA concluiu. Status: {qa_status}. Task aprovada (DONE).", request_id)
                else:
                    current_fails = qa_fail_count.get(task_id, 0) + 1
                    qa_fail_count[task_id] = current_fails
                    if current_fails >= max_qa_rework:
                        _update_task(project_id, task_id, status="DONE")
                        tasks_done_after_qa_fail.add(task_id)
                        _post_step(
                            f"QA reportou QA_FAIL (reatempto {current_fails}/{max_qa_rework}). "
                            "Máximo de reworks atingido; tarefa marcada como DONE (não aprovada). DevOps não será acionado.",
                            request_id,
                        )
                    else:
                        _update_task(project_id, task_id, status="QA_FAIL")
                        _post_step(
                            f"QA concluiu. Status: {qa_status}. Task em QA_FAIL (reatempto {current_fails}/{max_qa_rework}); Dev será acionado para rework.",
                            request_id,
                        )
            except Exception as e:
                logger.exception("[Monitor Loop] QA falhou")
                _post_error(str(e), request_id, e)
            time.sleep(2)
            continue

        if need_dev:
            dev_task = next(
                (
                    t
                    for t in tasks
                    if t.get("status") in ("ASSIGNED", "IN_PROGRESS", "QA_FAIL", "BLOCKED")
                    and (t.get("taskId") or t.get("task_id")) not in dev_gave_up_tasks
                ),
                None,
            )
            if dev_task:
                task_id = dev_task.get("taskId") or dev_task.get("task_id")
                task_desc = dev_task.get("title") or dev_task.get("description") or dev_task.get("name") or "Implementar tarefa do backlog."
                _update_task(project_id, task_id, status="IN_PROGRESS")
                _post_step("O Monitor acionou o Dev para implementar ou rework.", request_id)
                _post_agent_working("dev", "O Dev está implementando ou corrigindo a tarefa.", request_id)
                try:
                    dep_code = None
                    if pipeline_ctx:
                        depends_on = dev_task.get("depends_on_files") or dev_task.get("dependsOnFiles") or []
                        dep_code = pipeline_ctx.get_dependency_code(depends_on)
                    dev_response = call_dev(
                        spec_ref, charter_summary, backlog_summary, request_id,
                        task_id=task_id, task=task_desc, code_refs=[],
                        existing_artifacts=last_dev_artifacts if dev_task.get("status") == "QA_FAIL" else [],
                        task_dict=dev_task, dependency_code=dep_code, pipeline_ctx=pipeline_ctx,
                    )
                    _audit_log("dev", request_id, dev_response)
                    dev_summary = dev_response.get("summary", "")
                    dev_status = dev_response.get("status", "?")
                    last_dev_artifacts = dev_response.get("artifacts", [])
                    _post_dialogue(
                        "pm", "dev", "task.assigned",
                        _get_summary_human("task.assigned", "pm", "dev", backlog_summary[:200]),
                        request_id,
                    )
                    _post_dialogue(
                        "dev", "qa", "task.completed",
                        _get_summary_human("task.completed", "dev", "qa", dev_summary[:200]),
                        request_id,
                    )
                    circuit_breaker = dev_response.get("circuit_breaker_open") or ("Circuit breaker" in (dev_summary or ""))
                    if circuit_breaker:
                        _update_task(project_id, task_id, status="DONE")
                        dev_gave_up_tasks.add(task_id)
                        _post_step(
                            "Circuit breaker do Dev aberto. Tarefa marcada como DONE (não aprovada). Intervenção humana necessária.",
                            request_id,
                        )
                        time.sleep(2)
                        continue
                    _has_apps_artifact = any(
                        (a.get("path") or "").strip().startswith("apps/")
                        for a in (last_dev_artifacts or []) if isinstance(a, dict)
                    )
                    if project_id and storage and storage.is_enabled():
                        storage.write_doc(project_id, "dev", "implementation", _content_for_doc(dev_response), title="Dev implementation")
                        dev_artifacts = last_dev_artifacts
                        try:
                            from orchestrator.envelope import filter_artifacts_by_path_policy
                            dev_artifacts = filter_artifacts_by_path_policy(dev_artifacts, project_id)
                        except ImportError:
                            pass
                        _has_apps_artifact = any(
                            (a.get("path") or "").strip().startswith("apps/")
                            for a in dev_artifacts if isinstance(a, dict)
                        )
                        for i, art in enumerate(dev_artifacts):
                            if not isinstance(art, dict) or not art.get("content"):
                                continue
                            content = art.get("content", "")
                            path_val = (art.get("path") or "").strip()
                            if path_val.startswith("apps/"):
                                try:
                                    storage.write_apps_artifact(project_id, path_val[5:].lstrip("/"), content if isinstance(content, str) else str(content))
                                except Exception as _e:
                                    logger.warning("[Monitor Loop] Falha ao gravar apps artifact: %s", _e)
                            elif path_val.startswith("docs/"):
                                try:
                                    storage.write_doc_by_path(project_id, "dev", path_val[5:].lstrip("/"), content if isinstance(content, str) else str(content), title=art.get("purpose", f"Artifact {i}"))
                                except Exception as _e:
                                    logger.warning("[Monitor Loop] write_doc_by_path falhou, fallback write_doc: %s", _e)
                                    storage.write_doc(project_id, "dev", path_val.replace("/", "_").replace(".", "_")[:60] or f"artifact_{i}", content if isinstance(content, str) else str(content), title=art.get("purpose", f"Artifact {i}"))
                            elif path_val:
                                storage.write_doc(project_id, "dev", f"artifact_{i}", content if isinstance(content, str) else str(content), title=art.get("purpose", f"Artifact {i}"))
                    if _has_apps_artifact:
                        consecutive_dev_blocked[task_id] = 0
                        _update_task(project_id, task_id, status="WAITING_REVIEW")
                        _post_step(f"Dev concluiu. Status: {dev_status}. Task em WAITING_REVIEW.", request_id)
                    else:
                        n = consecutive_dev_blocked.get(task_id, 0) + 1
                        consecutive_dev_blocked[task_id] = n
                        if n >= max_consecutive_dev_blocked:
                            _update_task(project_id, task_id, status="DONE")
                            dev_gave_up_tasks.add(task_id)
                            _post_step(
                                f"Máximo de tentativas do Dev atingido ({n}x sem artefato em apps/). Tarefa marcada como DONE (não aprovada).",
                                request_id,
                            )
                        else:
                            _update_task(project_id, task_id, status="BLOCKED")
                            _post_step(
                                f"Dev não entregou artefato em apps/. Task mantida para rework (tentativa {n}/{max_consecutive_dev_blocked}).",
                                request_id,
                            )
                except Exception as e:
                    logger.exception("[Monitor Loop] Dev falhou")
                    _post_error(str(e), request_id, e)
                    _update_task(project_id, task_id, status="ASSIGNED")
                time.sleep(2)
                continue

        if all_done and not devops_done:
            if tasks_done_after_qa_fail:
                _post_step(
                    "Monitor: uma ou mais tarefas não foram aprovadas pelo QA após o máximo de reworks. "
                    "DevOps não será acionado. Revise o projeto ou aceite o estado atual no portal.",
                    request_id,
                )
                devops_done = True  # Marca para não tentar de novo
            else:
                _post_step("O Monitor acionou o DevOps para provisionamento.", request_id)
                _post_agent_working("devops", "O DevOps está gerando Dockerfile e artefatos de infraestrutura.", request_id)
                try:
                    devops_response = call_devops(spec_ref, charter_summary, backlog_summary, request_id)
                    _audit_log("devops", request_id, devops_response)
                    devops_summary = devops_response.get("summary", "")
                    _post_dialogue(
                        "monitor", "devops", "devops.deploy",
                        _get_summary_human("devops.deploy", "devops", "cto", devops_summary[:200]),
                        request_id,
                    )
                    if project_id and storage and storage.is_enabled():
                        storage.write_doc(project_id, "devops", "summary", _content_for_doc(devops_response), title="DevOps summary")
                        devops_artifacts = devops_response.get("artifacts", [])
                        try:
                            from orchestrator.envelope import filter_artifacts_by_path_policy
                            devops_artifacts = filter_artifacts_by_path_policy(devops_artifacts, project_id)
                        except ImportError:
                            pass
                        for i, art in enumerate(devops_artifacts):
                            if not isinstance(art, dict) or not art.get("content"):
                                continue
                            content = art.get("content", "")
                            path_val = (art.get("path") or "").strip()
                            if path_val.startswith("project/"):
                                try:
                                    storage.write_project_artifact(project_id, path_val[8:].lstrip("/"), content if isinstance(content, str) else str(content))
                                except Exception as _e:
                                    logger.warning("[Monitor Loop] Falha ao gravar project artifact: %s", _e)
                            elif path_val.startswith("docs/"):
                                try:
                                    storage.write_doc_by_path(project_id, "devops", path_val[5:].lstrip("/"), content if isinstance(content, str) else str(content), title=art.get("purpose", f"Artifact {i}"))
                                except Exception as _e:
                                    logger.warning("[Monitor Loop] write_doc_by_path devops falhou, fallback write_doc: %s", _e)
                                    storage.write_doc(project_id, "devops", path_val.replace("/", "_").replace(".", "_")[:60] or f"artifact_{i}", content if isinstance(content, str) else str(content), title=art.get("purpose", f"Artifact {i}"))
                            elif path_val:
                                storage.write_doc(project_id, "devops", f"artifact_{i}", content if isinstance(content, str) else str(content), title=art.get("purpose", f"Artifact {i}"))
                    devops_done = True
                    _post_step("DevOps concluiu. Aguardando aceite do usuário ou parada.", request_id)
                except Exception as e:
                    logger.exception("[Monitor Loop] DevOps falhou")
                    _post_error(str(e), request_id, e)
            time.sleep(2)
            continue

        time.sleep(loop_interval)


# ---------------------------------------------------------------------------
# Pipeline principal
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Runner: spec -> Engineer -> CTO -> PM -> backlog")
    default_spec = "project/spec/PRODUCT_SPEC.md" if (REPO_ROOT / "project" / "spec" / "PRODUCT_SPEC.md").exists() else "spec/PRODUCT_SPEC.md"
    parser.add_argument("--spec", "-s", default=None, help="Caminho relativo ao repo para o spec (FR/NFR)")
    parser.add_argument("--spec-file", "--spec-path", dest="spec_file", metavar="PATH", default=None, help="Caminho absoluto do arquivo de spec (ex.: uploads/<projectId>/arquivo.md)")
    args = parser.parse_args()

    if args.spec_file:
        spec_path = Path(args.spec_file)
        if not spec_path.is_absolute():
            spec_path = spec_path.resolve()
        if not spec_path.exists():
            logger.error("Spec não encontrada: %s", spec_path)
            return 1
        spec_ref = str(spec_path)
    else:
        spec_ref = args.spec or default_spec
        if not (REPO_ROOT / spec_ref).exists():
            logger.error("Spec não encontrada: %s", spec_ref)
            return 1
        spec_path = REPO_ROOT / spec_ref

    request_id = f"runner-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    project_id = _project_id()
    storage = _project_storage()
    if storage and storage.is_enabled():
        if project_id:
            try:
                from orchestrator.project_storage import ensure_project_dirs
                if ensure_project_dirs(project_id):
                    logger.info("[Pipeline] Diretórios garantidos: docs/, project/, apps/ para project_id=%s", project_id)
            except Exception as e:
                logger.warning("[Pipeline] ensure_project_dirs: %s", e)
        logger.info(
            "[Pipeline] Armazenamento por projeto ativo: PROJECT_FILES_ROOT=%s (docs, project, apps em <root>/<project_id>/)",
            os.environ.get("PROJECT_FILES_ROOT", ""),
        )
    else:
        logger.info(
            "[Pipeline] Armazenamento por projeto desativado (PROJECT_FILES_ROOT não definido). "
            "Para gravar artefatos em disco, defina PROJECT_FILES_ROOT e use volume/bind mount no runner."
        )

    logger.info("[Pipeline] Lendo spec: %s", spec_ref)
    spec_content = load_spec(spec_path)

    spec_template_content = _load_spec_template()
    # LEI 11: tentar restaurar checkpoint; senão criar contexto novo
    pipeline_ctx = None
    try:
        from orchestrator.pipeline_context import PipelineContext
        ensure_state_dir()
        loaded = PipelineContext.load_checkpoint(STATE_DIR, project_id or "default")
        if loaded is not None:
            pipeline_ctx = loaded
            logger.info("[Pipeline] Checkpoint restaurado (LEI 11): step=%s, retomando a partir da próxima fase.", pipeline_ctx.current_step)
        else:
            pipeline_ctx = PipelineContext(project_id or "default")
            pipeline_ctx.set_spec_raw(spec_content)
            if spec_template_content:
                pipeline_ctx.set_product_spec_template(spec_template_content)
    except ImportError:
        pipeline_ctx = None

    spec_understood = spec_content
    charter_summary = ""
    engineer_summary = ""
    backlog_summary = ""
    if pipeline_ctx:
        spec_understood = pipeline_ctx.product_spec or spec_content
        charter_summary = pipeline_ctx.charter or ""
        engineer_summary = pipeline_ctx.engineer_proposal or ""
        backlog_summary = pipeline_ctx.backlog or ""

    # Persistir spec em project_id/docs quando PROJECT_FILES_ROOT estiver definido
    if project_id and storage and storage.is_enabled():
        storage.write_spec_doc(project_id, spec_content, spec_ref.replace("/", "_").replace(".", "_")[:80])

    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    _patch_project({"started_at": now_iso, "status": "running"})
    _post_step(
        "Pipeline iniciado. A especificação do produto foi recebida e será analisada pelos agentes.",
        request_id,
    )

    cto_spec_response = {}
    cto_response = None
    engineer_response = None
    charter_artifacts = []
    backlog_artifacts = []
    charter_path = STATE_DIR / "PROJECT_CHARTER.md"
    try:
        # ── V2: CTO spec review (LEI 11: pular se current_step >= 1) ──
        if not pipeline_ctx or pipeline_ctx.current_step < 1:
            _post_step(
                "O CTO está analisando a especificação recebida (conversão para .md e entendimento do projeto).",
                request_id,
            )
            _post_agent_working("cto", "O CTO está revisando e convertendo a spec para o modelo aceitável.", request_id)
            logger.info("[Pipeline] Chamando CTO para revisão da spec (com template)...")
            cto_spec_response = call_cto(
                spec_ref, request_id, engineer_proposal="",
                spec_content=spec_content, spec_template=spec_template_content,
                pipeline_ctx=pipeline_ctx,
            )
            _audit_log("cto", request_id, cto_spec_response)
            spec_understood = _content_for_doc(cto_spec_response) or cto_spec_response.get("summary", "") or spec_content
            for art in cto_spec_response.get("artifacts", []):
                if isinstance(art, dict) and art.get("content"):
                    spec_understood = art.get("content", "").strip() or spec_understood
                    break
            if project_id and storage and storage.is_enabled():
                storage.write_doc(project_id, "cto", "spec_review", spec_understood, title="Spec revisada pelo CTO")
                try:
                    storage.write_doc_by_path(
                        project_id, "cto", "cto/cto_spec_response.json",
                        json.dumps(cto_spec_response, ensure_ascii=False, indent=2),
                        title="CTO spec response (IA)",
                    )
                except Exception as _e:
                    logger.warning("[Pipeline] Falha ao gravar CTO spec response JSON: %s", _e)
            if pipeline_ctx:
                pipeline_ctx.set_product_spec(spec_understood)
                pipeline_ctx.current_step = 1
                pipeline_ctx.save_checkpoint(STATE_DIR)
            _post_step("O CTO concluiu a revisão da spec. Iniciando alinhamento com o Engineer.", request_id)

        # ── V2: Loop CTO ↔ Engineer (LEI 11: pular se current_step >= 2) ───────────────────
        max_cto_engineer_rounds = int(os.environ.get("MAX_CTO_ENGINEER_ROUNDS", "3"))
        engineer_summary = engineer_summary or ""
        cto_response = None
        charter_summary = charter_summary or ""

        if not pipeline_ctx or pipeline_ctx.current_step < 2:
            for round_num in range(1, max_cto_engineer_rounds + 1):
                _post_step(
                    f"Rodada {round_num}/{max_cto_engineer_rounds}: CTO envia spec ao Engineer para proposta técnica (squads e skills).",
                    request_id,
                )
                _post_agent_working("engineer", "O Engineer está gerando a proposta técnica (squads e dependências).", request_id)
                logger.info("[Pipeline] Chamando agente Engineer (rodada %s)...", round_num)
                engineer_response = call_engineer(
                    spec_ref, spec_understood, request_id,
                    cto_questionamentos=None if round_num == 1 else (cto_response.get("summary", "") if cto_response else None),
                    pipeline_ctx=pipeline_ctx,
                )
                _audit_log("engineer", request_id, engineer_response)
                engineer_summary = engineer_response.get("summary", "")
                engineer_status = engineer_response.get("status", "?")
                logger.info("[Pipeline] Engineer respondeu (status: %s)", engineer_status)
                _post_dialogue("cto", "engineer", "cto.engineer.request", _get_summary_human("cto.engineer.request", "cto", "engineer", spec_ref[:500]), request_id)
                _post_dialogue("engineer", "cto", "engineer.cto.response", _get_summary_human("engineer.cto.response", "engineer", "cto", engineer_summary[:500]), request_id)
                if pipeline_ctx:
                    pipeline_ctx.set_engineer_proposal(engineer_summary)
                if project_id and storage and storage.is_enabled():
                    storage.write_doc(project_id, "engineer", "proposal", _content_for_doc(engineer_response), title="Engineer technical proposal")
                    for i, art in enumerate(engineer_response.get("artifacts", [])):
                        if isinstance(art, dict) and art.get("content"):
                            name = (Path(art.get("path", "")).stem if art.get("path") else f"artifact_{i}").replace(".", "_") or f"artifact_{i}"
                            storage.write_doc(project_id, "engineer", name, art.get("content", ""), title=art.get("purpose", name))

                _post_step("O CTO está validando a proposta e elaborando o Charter (ou preparando questionamentos).", request_id)
                _post_agent_working("cto", "O CTO está elaborando o Charter do projeto.", request_id)
                logger.info("[Pipeline] Chamando agente CTO (charter/validação)...")
                cto_response = call_cto(
                    spec_ref, request_id, engineer_proposal=engineer_summary, spec_content=spec_understood,
                    pipeline_ctx=pipeline_ctx,
                )
                _audit_log("cto", request_id, cto_response)
                if project_id and storage and storage.is_enabled():
                    try:
                        storage.write_doc_by_path(
                            project_id, "cto", f"cto/cto_charter_response_round{round_num}.json",
                            json.dumps(cto_response, ensure_ascii=False, indent=2),
                            title="CTO charter response (IA)",
                        )
                    except Exception as _e:
                        logger.warning("[Pipeline] Falha ao gravar CTO charter response JSON: %s", _e)
                charter_summary = cto_response.get("summary", "")
                charter_artifacts = cto_response.get("artifacts", [])
                cto_status = cto_response.get("status", "?")
                logger.info("[Pipeline] CTO respondeu (status: %s)", cto_status)
                if cto_status and str(cto_status).upper() == "OK":
                    _post_step("O CTO aprovou a proposta e finalizou o Charter. Seguindo para o PM.", request_id)
                    break
                if round_num == max_cto_engineer_rounds:
                    _post_step("Máximo de rodadas CTO↔Engineer atingido. Usando última versão do Charter.", request_id)
                    break
                _post_step("O CTO enviou questionamentos ao Engineer. Nova rodada.", request_id)

            charter_path = STATE_DIR / "PROJECT_CHARTER.md"
            charter_content = f"# Project Charter (gerado pelo CTO)\n\n{_content_for_doc(cto_response) or charter_summary}\n"
            if project_id and storage and storage.is_enabled():
                p = storage.write_doc(project_id, "cto", "charter", _content_for_doc(cto_response), title="Project Charter")
                if p:
                    charter_path = p
                for i, art in enumerate(charter_artifacts):
                    if isinstance(art, dict) and art.get("content"):
                        storage.write_doc(
                            project_id, "cto", f"artifact_{i}", art.get("content", ""),
                            title=art.get("purpose", f"Artifact {i}"),
                        )
            if charter_summary:
                ensure_state_dir()
                charter_path.write_text(charter_content, encoding="utf-8")
                logger.info("[Pipeline] Charter persistido: %s", charter_path)
            if pipeline_ctx:
                pipeline_ctx.set_charter(charter_summary)
                pipeline_ctx.current_step = 2
                pipeline_ctx.save_checkpoint(STATE_DIR)

        cto_status = cto_response.get("status", "?") if cto_response else "?"
        engineer_status = engineer_response.get("status", "?") if engineer_response else "?"

        emit_event("project.created", {"spec_ref": spec_ref, "constraints": {}, "engineer_summary": engineer_summary[:300]}, request_id)
        _post_dialogue(
            "cto", "pm", "project.created",
            _get_summary_human("project.created", "cto", "pm", charter_summary[:300]),
            request_id,
        )

        # ── Passo 3: PM + loop CTO↔PM (LEI 11: pular se current_step >= 3) ──
        pm_response = None
        pm_status = "?"
        if not pipeline_ctx or pipeline_ctx.current_step < 3:
            max_cto_pm_rounds = int(os.environ.get("MAX_CTO_PM_ROUNDS", "3"))
            cto_pm_questionamentos = None
            for pm_round in range(1, max_cto_pm_rounds + 1):
                _post_step(
                    f"O PM está gerando o backlog do módulo (rodada {pm_round}/{max_cto_pm_rounds}).",
                    request_id,
                )
                _post_agent_working("pm", "O PM está gerando o backlog (tarefas e critérios de aceitação).", request_id)
                pm_module = infer_pm_module_from_engineer_proposal(engineer_summary)
                logger.info("[Pipeline] Chamando agente PM (módulo %s inferido da proposta do Engineer, rodada %s)...", pm_module, pm_round)
                pm_response = call_pm(
                    spec_ref, charter_summary, request_id,
                    module=pm_module, engineer_proposal=engineer_summary,
                    cto_questionamentos=cto_pm_questionamentos,
                    pipeline_ctx=pipeline_ctx,
                )
                _audit_log("pm", request_id, pm_response)
                backlog_summary = pm_response.get("summary", "")
                backlog_artifacts = pm_response.get("artifacts", [])
                pm_status = pm_response.get("status", "?")
                logger.info("[Pipeline] PM respondeu (status: %s)", pm_status)
                if project_id and storage and storage.is_enabled():
                    storage.write_doc(project_id, "pm", "backlog", _content_for_doc(pm_response), title="Backlog")
                    for i, art in enumerate(backlog_artifacts):
                        if not isinstance(art, dict) or not art.get("content"):
                            continue
                        path_val = (art.get("path") or "").strip()
                        content = art.get("content", "")
                        title = art.get("purpose", f"Artifact {i}")
                        if path_val.startswith("docs/"):
                            try:
                                storage.write_doc_by_path(project_id, "pm", path_val[5:].lstrip("/"), content, title=title)
                            except Exception as _e:
                                logger.warning("[Pipeline] write_doc_by_path PM falhou, fallback: %s", _e)
                                storage.write_doc(project_id, "pm", f"artifact_{i}", content, title=title)
                        else:
                            storage.write_doc(project_id, "pm", f"artifact_{i}", content, title=title)
                _post_step("O CTO está validando o backlog do PM.", request_id)
                _post_agent_working("cto", "O CTO está validando o backlog.", request_id)
                cto_backlog_response = call_cto(
                    spec_ref, request_id,
                    backlog_summary=backlog_summary,
                    validate_backlog_only=True,
                    pipeline_ctx=pipeline_ctx,
                )
                cto_backlog_ok = (str(cto_backlog_response.get("status", "")).upper() == "OK")
                if cto_backlog_ok:
                    _post_step("O CTO aprovou o backlog. Acionando a squad.", request_id)
                    break
                if pm_round == max_cto_pm_rounds:
                    _has_pm_artifacts = any(
                        (a.get("path") or "").strip().startswith("docs/pm/")
                        for a in (backlog_artifacts or []) if isinstance(a, dict)
                    )
                    if _has_pm_artifacts:
                        _post_step("Máximo de rodadas CTO↔PM atingido. Usando último backlog.", request_id)
                    else:
                        _post_step("Máximo de rodadas CTO↔PM atingido. PM não entregou artefatos formais (docs/pm/); usando resumo disponível.", request_id)
                    break
                cto_pm_questionamentos = cto_backlog_response.get("summary", "") or _content_for_doc(cto_backlog_response)
                _post_step("O CTO enviou ajustes ao PM. Nova rodada.", request_id)

            if pipeline_ctx:
                pipeline_ctx.set_backlog(backlog_summary)
                pipeline_ctx.current_step = 3
                pipeline_ctx.save_checkpoint(STATE_DIR)
        _post_step(
            f"O PM concluiu a geração do backlog. O módulo está planejado com tarefas e prioridades. Status: {pm_status}.",
            request_id,
        )
        emit_event("module.planned", {"spec_ref": spec_ref, "backlog_summary": backlog_summary[:200]}, request_id)
        _post_dialogue(
            "pm", "cto", "module.planned",
            _get_summary_human("module.planned", "pm", "cto", backlog_summary[:200]),
            request_id,
        )

        # ── Fase 2: Monitor Loop (quando API e PROJECT_ID definidos) ───
        if project_id and _api_available():
            _post_step(
                "Squad criada. Iniciando Monitor Loop: Dev/QA/DevOps serão acionados até você aceitar o projeto ou parar.",
                request_id,
            )
            if not _seed_tasks(project_id):
                _post_error("Falha ao criar tarefas iniciais na API.", request_id, None)
                _patch_project({"status": "failed"})
            else:
                _run_monitor_loop(project_id, spec_ref, charter_summary, backlog_summary, request_id, pipeline_ctx=pipeline_ctx)
            persist_state(
                spec_ref=spec_ref,
                charter={"summary": charter_summary, "artifacts": charter_artifacts},
                backlog={"summary": backlog_summary, "artifacts": backlog_artifacts},
                events=["cto.engineer.request", "engineer.cto.response", "project.created", "module.planned", "task.assigned", "task.completed", "qa.review", "monitor.health", "devops.deploy"],
            )
            _post_step("Monitor Loop encerrado. Aceite o projeto no portal ou revise o status.", request_id)
            out = {
                "request_id": request_id,
                "spec_ref": spec_ref,
                "engineer_status": engineer_status,
                "cto_status": cto_status,
                "pm_status": pm_status,
                "charter_path": str(charter_path),
                "state_path": str(STATE_DIR / "current_project.json"),
                "monitor_loop": True,
            }
            if project_id and storage and storage.is_enabled():
                out["project_docs_root"] = str(storage.get_docs_dir(project_id))
                out["project_artifacts_root"] = str(storage.get_project_dir(project_id))
            print(json.dumps(out, indent=2))
            return 0

        # ── Passo 4: Dev (fluxo sequencial quando sem API/PROJECT_ID) ──
        run_full_stack = os.environ.get("PIPELINE_FULL_STACK", "true").strip().lower() in ("1", "true", "yes")
        dev_status = pm_status
        qa_status = "-"
        monitor_status = "-"
        devops_status = "-"
        dev_summary = ""
        qa_summary = ""
        monitor_summary = ""
        devops_summary = ""

        if run_full_stack:
            dev_artifacts: list = []
            dev_code_refs: list = []
            _post_step(
                "O Dev está recebendo o backlog e o charter para gerar a implementação e evidências.",
                request_id,
            )
            _post_agent_working("dev", "O Dev está gerando a implementação e evidências.", request_id)
            logger.info("[Pipeline] Chamando agente Dev...")
            try:
                dev_response = call_dev(spec_ref, charter_summary, backlog_summary, request_id)
                dev_summary = dev_response.get("summary", "")
                dev_status = dev_response.get("status", "?")
                dev_artifacts = dev_response.get("artifacts", [])
                dev_code_refs = [a.get("path") for a in dev_artifacts if isinstance(a, dict) and a.get("path")]
                logger.info("[Pipeline] Dev respondeu (status: %s)", dev_status)
                _post_step(
                    f"O Dev concluiu. Status: {dev_status}. Resumo: {dev_summary[:150]}...",
                    request_id,
                )
                _post_dialogue(
                    "pm", "dev", "task.assigned",
                    _get_summary_human("task.assigned", "pm", "dev", backlog_summary[:200]),
                    request_id,
                )
                _post_dialogue(
                    "dev", "qa", "task.completed",
                    _get_summary_human("task.completed", "dev", "qa", dev_summary[:200]),
                    request_id,
                )
                if project_id and storage and storage.is_enabled():
                    storage.write_doc(project_id, "dev", "implementation", _content_for_doc(dev_response), title="Dev implementation")
                    for i, art in enumerate(dev_artifacts):
                        if isinstance(art, dict) and art.get("content"):
                            content = art.get("content", "")
                            path_key = art.get("path") or f"artifact_{i}"
                            if art.get("path"):
                                storage.write_apps_artifact(project_id, path_key, content if isinstance(content, str) else str(content))
                            else:
                                storage.write_doc(project_id, "dev", f"artifact_{i}", content, title=art.get("purpose", f"Artifact {i}"))
            except Exception as e:
                logger.exception("[Pipeline] Dev falhou")
                dev_status = "FAIL"
                _post_error(str(e), request_id, e)

            # ── Passo 5: QA ──────────────────────────────────────────────
            _post_step(
                "O QA está validando o trabalho do Dev e gerando relatório de qualidade.",
                request_id,
            )
            _post_agent_working("qa", "O QA está validando artefatos e gerando relatório de qualidade.", request_id)
            logger.info("[Pipeline] Chamando agente QA...")
            try:
                qa_response = call_qa(
                    spec_ref, charter_summary, backlog_summary, dev_summary, request_id,
                    task_id=None, task="", code_refs=dev_code_refs, existing_artifacts=dev_artifacts,
                )
                qa_summary = qa_response.get("summary", "")
                qa_status = qa_response.get("status", "?")
                qa_artifacts = qa_response.get("artifacts", [])
                logger.info("[Pipeline] QA respondeu (status: %s)", qa_status)
                _post_step(
                    f"O QA concluiu. Status: {qa_status}. Resumo: {qa_summary[:150]}...",
                    request_id,
                )
                _post_dialogue(
                    "dev", "qa", "qa.review",
                    _get_summary_human("qa.review", "qa", "monitor", qa_summary[:200]),
                    request_id,
                )
                if project_id and storage and storage.is_enabled():
                    storage.write_doc(project_id, "qa", "report", _content_for_doc(qa_response), title="QA report")
                    for i, art in enumerate(qa_artifacts):
                        if isinstance(art, dict) and art.get("content"):
                            storage.write_doc(project_id, "qa", f"artifact_{i}", art.get("content", ""), title=art.get("purpose", f"Artifact {i}"))
            except Exception as e:
                logger.exception("[Pipeline] QA falhou")
                qa_status = "FAIL"
                _post_error(str(e), request_id, e)

            # ── Passo 6: Monitor ──────────────────────────────────────────
            _post_step(
                "O Monitor está consolidando o status e gerando o health do projeto.",
                request_id,
            )
            _post_agent_working("monitor", "O Monitor está consolidando o status e o health do projeto.", request_id)
            logger.info("[Pipeline] Chamando agente Monitor...")
            try:
                monitor_response = call_monitor(spec_ref, charter_summary, backlog_summary, dev_summary, qa_summary, request_id)
                monitor_summary = monitor_response.get("summary", "")
                monitor_status = monitor_response.get("status", "?")
                logger.info("[Pipeline] Monitor respondeu (status: %s)", monitor_status)
                _post_step(
                    f"O Monitor concluiu. Status: {monitor_status}.",
                    request_id,
                )
                _post_dialogue(
                    "monitor", "pm", "monitor.health",
                    _get_summary_human("monitor.health", "monitor", "pm", monitor_summary[:200]),
                    request_id,
                )
                if project_id and storage and storage.is_enabled():
                    storage.write_doc(project_id, "monitor", "health", _content_for_doc(monitor_response), title="Monitor health")
            except Exception as e:
                logger.exception("[Pipeline] Monitor falhou")
                monitor_status = "FAIL"
                _post_error(str(e), request_id, e)

            # ── Passo 7: DevOps ───────────────────────────────────────────
            _post_step(
                "O DevOps está gerando Dockerfile, docker-compose e artefatos de infraestrutura.",
                request_id,
            )
            _post_agent_working("devops", "O DevOps está gerando artefatos de infraestrutura.", request_id)
            logger.info("[Pipeline] Chamando agente DevOps...")
            try:
                devops_response = call_devops(spec_ref, charter_summary, backlog_summary, request_id)
                devops_summary = devops_response.get("summary", "")
                devops_status = devops_response.get("status", "?")
                devops_artifacts = devops_response.get("artifacts", [])
                logger.info("[Pipeline] DevOps respondeu (status: %s)", devops_status)
                _post_step(
                    f"O DevOps concluiu. Status: {devops_status}.",
                    request_id,
                )
                _post_dialogue(
                    "monitor", "devops", "devops.deploy",
                    _get_summary_human("devops.deploy", "devops", "cto", devops_summary[:200]),
                    request_id,
                )
                if project_id and storage and storage.is_enabled():
                    storage.write_doc(project_id, "devops", "summary", _content_for_doc(devops_response), title="DevOps summary")
                    for i, art in enumerate(devops_artifacts):
                        if isinstance(art, dict):
                            content = art.get("content")
                            path_key = art.get("path") or f"artifact_{i}"
                            if content and path_key:
                                storage.write_project_artifact(project_id, path_key, content if isinstance(content, str) else str(content))
                            elif content:
                                storage.write_doc(project_id, "devops", f"artifact_{i}", content, title=art.get("purpose", f"Artifact {i}"))
            except Exception as e:
                logger.exception("[Pipeline] DevOps falhou")
                devops_status = "FAIL"
                _post_error(str(e), request_id, e)

        # ── Persistir estado ──────────────────────────────────────────
        events_list = ["cto.engineer.request", "engineer.cto.response", "project.created", "module.planned"]
        if run_full_stack:
            events_list.extend(["task.assigned", "task.completed", "qa.review", "monitor.health", "devops.deploy"])
        persist_state(
            spec_ref=spec_ref,
            charter={"summary": charter_summary, "artifacts": charter_artifacts},
            backlog={"summary": backlog_summary, "artifacts": backlog_artifacts},
            events=events_list,
        )
        logger.info("[Pipeline] Estado persistido em orchestrator/state/current_project.json")

        completed_at_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        _patch_project({
            "status": "completed",
            "completed_at": completed_at_iso,
            "charter_summary": charter_summary,
            "backlog_summary": backlog_summary[:2000] if backlog_summary else None,
        })
        pipeline_desc = "Engineer → CTO → PM"
        if run_full_stack:
            pipeline_desc += " → Dev → QA → Monitor → DevOps"
        _post_step(
            f"Pipeline concluído com sucesso! A especificação passou por {pipeline_desc}. "
            "Os documentos foram gerados e, quando configurado, salvos em PROJECT_FILES_ROOT.",
            request_id,
        )

        out = {
            "request_id": request_id,
            "spec_ref": spec_ref,
            "engineer_status": engineer_status,
            "cto_status": cto_status,
            "pm_status": pm_status,
            "charter_path": str(charter_path),
            "state_path": str(STATE_DIR / "current_project.json"),
        }
        if run_full_stack:
            out["dev_status"] = dev_status
            out["qa_status"] = qa_status
            out["monitor_status"] = monitor_status
            out["devops_status"] = devops_status
        if project_id and storage and storage.is_enabled():
            out["project_docs_root"] = str(storage.get_docs_dir(project_id))
            out["project_artifacts_root"] = str(storage.get_project_dir(project_id))
        print(json.dumps(out, indent=2))
        return 0

    except Exception as e:
        logger.exception("[Pipeline] Falha no pipeline")
        error_info = _extract_error_info(e)
        human_msg = error_info.get("human_message", f"Erro no pipeline: {e}")
        _post_error(human_msg, request_id, e)
        completed_at_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        _patch_project({"status": "failed", "completed_at": completed_at_iso})
        raise


if __name__ == "__main__":
    sys.exit(main())
