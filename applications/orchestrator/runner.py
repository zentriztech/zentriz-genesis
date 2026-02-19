"""
Runner do orquestrador: spec -> Engineer -> CTO (Charter) -> PM Backend (backlog).
Quando API e PROJECT_ID estão definidos: após PM Backend faz seed de tarefas e
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
from datetime import datetime

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

def call_engineer(spec_ref: str, spec_content: str, request_id: str) -> dict:
    message = {
        "request_id": request_id,
        "input": {
            "spec_ref": spec_ref,
            "spec_content": spec_content[:15000] if spec_content else "",
            "context": {},
            "task": {},
            "constraints": {},
            "artifacts": [],
        },
    }
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("engineer", message)
    from orchestrator.agents.runtime import run_agent
    engineer_prompt = _agents_root() / "engineer" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=engineer_prompt, message=message, role="ENGINEER")


def call_cto(spec_ref: str, request_id: str, engineer_proposal: str = "") -> dict:
    message = {
        "request_id": request_id,
        "input": {
            "spec_ref": spec_ref,
            "context": {"engineer_stack_proposal": engineer_proposal} if engineer_proposal else {},
            "task": {},
            "constraints": {},
            "artifacts": [],
        },
    }
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("cto", message)
    from orchestrator.agents.runtime import run_agent
    cto_prompt = _agents_root() / "cto" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=cto_prompt, message=message, role="CTO")


def call_pm_backend(spec_ref: str, charter_summary: str, request_id: str) -> dict:
    message = {
        "request_id": request_id,
        "input": {
            "spec_ref": spec_ref,
            "context": {"charter_summary": charter_summary},
            "task": {},
            "constraints": {},
            "artifacts": [],
        },
    }
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("pm_backend", message)
    from orchestrator.agents.runtime import run_agent
    pm_prompt = _agents_root() / "pm" / "backend" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=pm_prompt, message=message, role="PM_BACKEND")


def call_dev_backend(spec_ref: str, charter_summary: str, backlog_summary: str, request_id: str) -> dict:
    message = {
        "request_id": request_id,
        "input": {
            "spec_ref": spec_ref,
            "context": {"charter_summary": charter_summary, "backlog_summary": backlog_summary},
            "task": {},
            "constraints": {},
            "artifacts": [],
        },
    }
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("dev_backend", message)
    from orchestrator.agents.runtime import run_agent
    dev_prompt = _agents_root() / "dev" / "backend" / "nodejs" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=dev_prompt, message=message, role="DEV_BACKEND")


def call_qa_backend(spec_ref: str, charter_summary: str, backlog_summary: str, dev_summary: str, request_id: str) -> dict:
    message = {
        "request_id": request_id,
        "input": {
            "spec_ref": spec_ref,
            "context": {
                "charter_summary": charter_summary,
                "backlog_summary": backlog_summary,
                "dev_backend_summary": dev_summary,
            },
            "task": {},
            "constraints": {},
            "artifacts": [],
        },
    }
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("qa_backend", message)
    from orchestrator.agents.runtime import run_agent
    qa_prompt = _agents_root() / "qa" / "backend" / "nodejs" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=qa_prompt, message=message, role="QA_BACKEND")


def call_monitor_backend(spec_ref: str, charter_summary: str, backlog_summary: str, dev_summary: str, qa_summary: str, request_id: str) -> dict:
    message = {
        "request_id": request_id,
        "input": {
            "spec_ref": spec_ref,
            "context": {
                "charter_summary": charter_summary,
                "backlog_summary": backlog_summary,
                "dev_backend_summary": dev_summary,
                "qa_backend_summary": qa_summary,
            },
            "task": {},
            "constraints": {},
            "artifacts": [],
        },
    }
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("monitor_backend", message)
    from orchestrator.agents.runtime import run_agent
    monitor_prompt = _agents_root() / "monitor" / "backend" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=monitor_prompt, message=message, role="MONITOR_BACKEND")


def call_devops_docker(spec_ref: str, charter_summary: str, backlog_summary: str, request_id: str) -> dict:
    message = {
        "request_id": request_id,
        "input": {
            "spec_ref": spec_ref,
            "context": {"charter_summary": charter_summary, "backlog_summary": backlog_summary},
            "task": {},
            "constraints": {},
            "artifacts": [],
        },
    }
    if os.environ.get("API_AGENTS_URL"):
        from orchestrator.agents.client_http import run_agent_http
        return run_agent_http("devops_docker", message)
    from orchestrator.agents.runtime import run_agent
    devops_prompt = _agents_root() / "devops" / "docker" / "SYSTEM_PROMPT.md"
    return run_agent(system_prompt_path=devops_prompt, message=message, role="DEVOPS_DOCKER")


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
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }
    (STATE_DIR / "current_project.json").write_text(
        json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def emit_event(event_type: str, payload: dict, request_id: str) -> None:
    ensure_state_dir()
    event = {
        "event_type": event_type,
        "request_id": request_id,
        "timestamp": datetime.utcnow().isoformat() + "Z",
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


def _post_error(message: str, request_id: str, exc: BaseException | None = None) -> None:
    """Registra erro no log do portal. Inclui traceback apenas se SHOW_TRACEBACK=true."""
    body = message
    if exc is not None:
        error_detail = _extract_error_info(exc)
        if error_detail.get("human_message"):
            body = error_detail["human_message"]
        if SHOW_TRACEBACK:
            tb_text = error_detail.get("traceback", "")
            if not tb_text:
                tb_text = "".join(_tb.format_exception(type(exc), exc, exc.__traceback__))
            body += "\n\n--- Traceback (SHOW_TRACEBACK=true) ---\n" + tb_text[:3000]
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
) -> None:
    global _shutdown_requested
    signal.signal(signal.SIGTERM, _sigterm_handler)
    storage = _project_storage()
    dev_summary = ""
    qa_summary = ""
    devops_done = False
    loop_interval = int(os.environ.get("MONITOR_LOOP_INTERVAL", "20"))
    while True:
        if _shutdown_requested:
            _post_step("Monitor Loop encerrado (sinal recebido).", request_id)
            break
        status = _get_project_status(project_id)
        if status in ("accepted", "stopped"):
            _post_step(f"Monitor Loop encerrado: status do projeto é '{status}'.", request_id)
            break
        tasks = _get_tasks(project_id)
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
            _post_step("O Monitor acionou o QA Backend para revisar a tarefa.", request_id)
            try:
                qa_response = call_qa_backend(spec_ref, charter_summary, backlog_summary, dev_summary, request_id)
                qa_summary = qa_response.get("summary", "")
                qa_status = qa_response.get("status", "?")
                _post_dialogue(
                    "dev_backend", "qa_backend", "qa.review",
                    _get_summary_human("qa.review", "qa_backend", "monitor_backend", qa_summary[:200]),
                    request_id,
                )
                if project_id and storage and storage.is_enabled():
                    storage.write_doc(project_id, "qa_backend", "report", qa_summary, title="QA Backend report")
                new_status = "QA_PASS" if (qa_status and "pass" in str(qa_status).lower()) else "QA_FAIL"
                _update_task(project_id, task_id, status=new_status)
                if new_status == "QA_PASS":
                    _update_task(project_id, task_id, status="DONE")
                _post_step(f"QA Backend concluiu. Status: {qa_status}. Task atualizada para {new_status}.", request_id)
            except Exception as e:
                logger.exception("[Monitor Loop] QA Backend falhou")
                _post_error(str(e), request_id, e)
            time.sleep(2)
            continue

        if need_dev:
            dev_task = next(
                (t for t in tasks if t.get("status") in ("ASSIGNED", "IN_PROGRESS", "QA_FAIL", "BLOCKED")),
                None,
            )
            if dev_task:
                task_id = dev_task.get("taskId") or dev_task.get("task_id")
                _update_task(project_id, task_id, status="IN_PROGRESS")
                _post_step("O Monitor acionou o Dev Backend para implementar ou rework.", request_id)
                try:
                    dev_response = call_dev_backend(spec_ref, charter_summary, backlog_summary, request_id)
                    dev_summary = dev_response.get("summary", "")
                    dev_status = dev_response.get("status", "?")
                    _post_dialogue(
                        "pm_backend", "dev_backend", "task.assigned",
                        _get_summary_human("task.assigned", "pm_backend", "dev_backend", backlog_summary[:200]),
                        request_id,
                    )
                    _post_dialogue(
                        "dev_backend", "qa_backend", "task.completed",
                        _get_summary_human("task.completed", "dev_backend", "qa_backend", dev_summary[:200]),
                        request_id,
                    )
                    if project_id and storage and storage.is_enabled():
                        storage.write_doc(project_id, "dev_backend", "implementation", dev_summary, title="Dev Backend implementation")
                    _update_task(project_id, task_id, status="WAITING_REVIEW")
                    _post_step(f"Dev Backend concluiu. Status: {dev_status}. Task em WAITING_REVIEW.", request_id)
                except Exception as e:
                    logger.exception("[Monitor Loop] Dev Backend falhou")
                    _post_error(str(e), request_id, e)
                    _update_task(project_id, task_id, status="ASSIGNED")
                time.sleep(2)
                continue

        if all_done and not devops_done:
            _post_step("O Monitor acionou o DevOps Docker para provisionamento.", request_id)
            try:
                devops_response = call_devops_docker(spec_ref, charter_summary, backlog_summary, request_id)
                devops_summary = devops_response.get("summary", "")
                _post_dialogue(
                    "monitor_backend", "devops_docker", "devops.deploy",
                    _get_summary_human("devops.deploy", "devops_docker", "cto", devops_summary[:200]),
                    request_id,
                )
                if project_id and storage and storage.is_enabled():
                    storage.write_doc(project_id, "devops_docker", "summary", devops_summary, title="DevOps Docker summary")
                devops_done = True
                _post_step("DevOps Docker concluiu. Aguardando aceite do usuário ou parada.", request_id)
            except Exception as e:
                logger.exception("[Monitor Loop] DevOps Docker falhou")
                _post_error(str(e), request_id, e)
            time.sleep(2)
            continue

        time.sleep(loop_interval)


# ---------------------------------------------------------------------------
# Pipeline principal
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Runner: spec -> Engineer -> CTO -> PM Backend -> backlog")
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

    request_id = f"runner-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}"
    project_id = _project_id()
    storage = _project_storage()

    logger.info("[Pipeline] Lendo spec: %s", spec_ref)
    spec_content = load_spec(spec_path)

    # Persistir spec em project_id/docs quando PROJECT_FILES_ROOT estiver definido
    if project_id and storage and storage.is_enabled():
        storage.write_spec_doc(project_id, spec_content, spec_ref.replace("/", "_").replace(".", "_")[:80])

    now_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")
    _patch_project({"started_at": now_iso, "status": "running"})
    _post_step(
        "Pipeline iniciado. A especificação do produto foi recebida e será analisada pelos agentes.",
        request_id,
    )

    try:
        # ── Passo 1: Engineer ─────────────────────────────────────────
        _post_step(
            "O CTO está repassando a especificação ao Engineer para que ele analise "
            "as squads técnicas, equipes necessárias e dependências do projeto.",
            request_id,
        )
        logger.info("[Pipeline] Chamando agente Engineer...")
        engineer_response = call_engineer(spec_ref, spec_content, request_id)
        engineer_summary = engineer_response.get("summary", "")
        engineer_status = engineer_response.get("status", "?")
        logger.info("[Pipeline] Engineer respondeu (status: %s)", engineer_status)

        _post_step(
            f"O Engineer concluiu a análise técnica e entregou a proposta com as squads "
            f"e equipes recomendadas. Status: {engineer_status}.",
            request_id,
        )
        emit_event("cto.engineer.request", {"spec_ref": spec_ref}, request_id)
        emit_event("engineer.cto.response", {"summary": engineer_summary[:500]}, request_id)
        _post_dialogue(
            "cto", "engineer", "cto.engineer.request",
            _get_summary_human("cto.engineer.request", "cto", "engineer", spec_ref[:500]),
            request_id,
        )
        _post_dialogue(
            "engineer", "cto", "engineer.cto.response",
            _get_summary_human("engineer.cto.response", "engineer", "cto", engineer_summary[:500]),
            request_id,
        )
        if project_id and storage and storage.is_enabled():
            storage.write_doc(project_id, "engineer", "proposal", engineer_summary, title="Engineer technical proposal")

        # ── Passo 2: CTO ─────────────────────────────────────────────
        _post_step(
            "O CTO recebeu a proposta técnica do Engineer e está elaborando o Charter do projeto, "
            "definindo escopo, prioridades e a estrutura organizacional.",
            request_id,
        )
        logger.info("[Pipeline] Chamando agente CTO...")
        cto_response = call_cto(spec_ref, request_id, engineer_proposal=engineer_summary)
        charter_summary = cto_response.get("summary", "")
        charter_artifacts = cto_response.get("artifacts", [])
        cto_status = cto_response.get("status", "?")
        logger.info("[Pipeline] CTO respondeu (status: %s)", cto_status)

        _post_step(
            f"O CTO finalizou o Charter do projeto. Agora será repassado ao PM Backend "
            f"para a geração do backlog. Status: {cto_status}.",
            request_id,
        )

        charter_path = STATE_DIR / "PROJECT_CHARTER.md"
        charter_content = f"# Project Charter (gerado pelo CTO)\n\n{charter_summary}\n"
        if project_id and storage and storage.is_enabled():
            p = storage.write_doc(project_id, "cto", "charter", charter_summary, title="Project Charter")
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

        emit_event("project.created", {"spec_ref": spec_ref, "constraints": {}, "engineer_summary": engineer_summary[:300]}, request_id)
        _post_dialogue(
            "cto", "pm_backend", "project.created",
            _get_summary_human("project.created", "cto", "pm_backend", charter_summary[:300]),
            request_id,
        )

        # ── Passo 3: PM Backend ──────────────────────────────────────
        _post_step(
            "O PM Backend recebeu o Charter e está gerando o backlog completo do módulo, "
            "com tarefas, prioridades e critérios de aceitação.",
            request_id,
        )
        logger.info("[Pipeline] Chamando agente PM Backend...")
        pm_response = call_pm_backend(spec_ref, charter_summary, request_id)
        backlog_summary = pm_response.get("summary", "")
        backlog_artifacts = pm_response.get("artifacts", [])
        pm_status = pm_response.get("status", "?")
        logger.info("[Pipeline] PM Backend respondeu (status: %s)", pm_status)

        _post_step(
            f"O PM Backend concluiu a geração do backlog. O módulo está planejado "
            f"com tarefas e prioridades definidas. Status: {pm_status}.",
            request_id,
        )

        emit_event("module.planned", {"spec_ref": spec_ref, "backlog_summary": backlog_summary[:200]}, request_id)
        _post_dialogue(
            "pm_backend", "cto", "module.planned",
            _get_summary_human("module.planned", "pm_backend", "cto", backlog_summary[:200]),
            request_id,
        )
        if project_id and storage and storage.is_enabled():
            storage.write_doc(project_id, "pm_backend", "backlog", backlog_summary, title="Backlog Backend")
            for i, art in enumerate(backlog_artifacts):
                if isinstance(art, dict) and art.get("content"):
                    storage.write_doc(
                        project_id, "pm_backend", f"artifact_{i}", art.get("content", ""),
                        title=art.get("purpose", f"Artifact {i}"),
                    )

        # ── Fase 2: Monitor Loop (quando API e PROJECT_ID definidos) ───
        if project_id and _api_available():
            _post_step(
                "Squad criada. Iniciando Monitor Loop: Dev/QA/DevOps serão acionados até você aceitar o projeto ou parar.",
                request_id,
            )
            if not _seed_tasks(project_id):
                _post_error("Falha ao criar tarefas iniciais na API.", request_id, None)
            else:
                _run_monitor_loop(project_id, spec_ref, charter_summary, backlog_summary, request_id)
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

        # ── Passo 4: Dev Backend (fluxo sequencial quando sem API/PROJECT_ID) ──
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
            _post_step(
                "O Dev Backend está recebendo o backlog e o charter para gerar a implementação e evidências.",
                request_id,
            )
            logger.info("[Pipeline] Chamando agente Dev Backend...")
            try:
                dev_response = call_dev_backend(spec_ref, charter_summary, backlog_summary, request_id)
                dev_summary = dev_response.get("summary", "")
                dev_status = dev_response.get("status", "?")
                dev_artifacts = dev_response.get("artifacts", [])
                logger.info("[Pipeline] Dev Backend respondeu (status: %s)", dev_status)
                _post_step(
                    f"O Dev Backend concluiu. Status: {dev_status}. Resumo: {dev_summary[:150]}...",
                    request_id,
                )
                _post_dialogue(
                    "pm_backend", "dev_backend", "task.assigned",
                    _get_summary_human("task.assigned", "pm_backend", "dev_backend", backlog_summary[:200]),
                    request_id,
                )
                _post_dialogue(
                    "dev_backend", "qa_backend", "task.completed",
                    _get_summary_human("task.completed", "dev_backend", "qa_backend", dev_summary[:200]),
                    request_id,
                )
                if project_id and storage and storage.is_enabled():
                    storage.write_doc(project_id, "dev_backend", "implementation", dev_summary, title="Dev Backend implementation")
                    for i, art in enumerate(dev_artifacts):
                        if isinstance(art, dict) and art.get("content"):
                            storage.write_doc(project_id, "dev_backend", f"artifact_{i}", art.get("content", ""), title=art.get("purpose", f"Artifact {i}"))
            except Exception as e:
                logger.exception("[Pipeline] Dev Backend falhou")
                dev_status = "FAIL"
                _post_error(str(e), request_id, e)

            # ── Passo 5: QA Backend ─────────────────────────────────────
            _post_step(
                "O QA Backend está validando o trabalho do Dev e gerando relatório de qualidade.",
                request_id,
            )
            logger.info("[Pipeline] Chamando agente QA Backend...")
            try:
                qa_response = call_qa_backend(spec_ref, charter_summary, backlog_summary, dev_summary, request_id)
                qa_summary = qa_response.get("summary", "")
                qa_status = qa_response.get("status", "?")
                qa_artifacts = qa_response.get("artifacts", [])
                logger.info("[Pipeline] QA Backend respondeu (status: %s)", qa_status)
                _post_step(
                    f"O QA Backend concluiu. Status: {qa_status}. Resumo: {qa_summary[:150]}...",
                    request_id,
                )
                _post_dialogue(
                    "dev_backend", "qa_backend", "qa.review",
                    _get_summary_human("qa.review", "qa_backend", "monitor_backend", qa_summary[:200]),
                    request_id,
                )
                if project_id and storage and storage.is_enabled():
                    storage.write_doc(project_id, "qa_backend", "report", qa_summary, title="QA Backend report")
                    for i, art in enumerate(qa_artifacts):
                        if isinstance(art, dict) and art.get("content"):
                            storage.write_doc(project_id, "qa_backend", f"artifact_{i}", art.get("content", ""), title=art.get("purpose", f"Artifact {i}"))
            except Exception as e:
                logger.exception("[Pipeline] QA Backend falhou")
                qa_status = "FAIL"
                _post_error(str(e), request_id, e)

            # ── Passo 6: Monitor Backend ───────────────────────────────
            _post_step(
                "O Monitor Backend está consolidando o status e gerando o health do projeto.",
                request_id,
            )
            logger.info("[Pipeline] Chamando agente Monitor Backend...")
            try:
                monitor_response = call_monitor_backend(spec_ref, charter_summary, backlog_summary, dev_summary, qa_summary, request_id)
                monitor_summary = monitor_response.get("summary", "")
                monitor_status = monitor_response.get("status", "?")
                logger.info("[Pipeline] Monitor Backend respondeu (status: %s)", monitor_status)
                _post_step(
                    f"O Monitor Backend concluiu. Status: {monitor_status}.",
                    request_id,
                )
                _post_dialogue(
                    "monitor_backend", "pm_backend", "monitor.health",
                    _get_summary_human("monitor.health", "monitor_backend", "pm_backend", monitor_summary[:200]),
                    request_id,
                )
                if project_id and storage and storage.is_enabled():
                    storage.write_doc(project_id, "monitor_backend", "health", monitor_summary, title="Monitor Backend health")
            except Exception as e:
                logger.exception("[Pipeline] Monitor Backend falhou")
                monitor_status = "FAIL"
                _post_error(str(e), request_id, e)

            # ── Passo 7: DevOps Docker ─────────────────────────────────
            _post_step(
                "O DevOps Docker está gerando Dockerfile, docker-compose e artefatos de infraestrutura.",
                request_id,
            )
            logger.info("[Pipeline] Chamando agente DevOps Docker...")
            try:
                devops_response = call_devops_docker(spec_ref, charter_summary, backlog_summary, request_id)
                devops_summary = devops_response.get("summary", "")
                devops_status = devops_response.get("status", "?")
                devops_artifacts = devops_response.get("artifacts", [])
                logger.info("[Pipeline] DevOps Docker respondeu (status: %s)", devops_status)
                _post_step(
                    f"O DevOps Docker concluiu. Status: {devops_status}.",
                    request_id,
                )
                _post_dialogue(
                    "monitor_backend", "devops_docker", "devops.deploy",
                    _get_summary_human("devops.deploy", "devops_docker", "cto", devops_summary[:200]),
                    request_id,
                )
                if project_id and storage and storage.is_enabled():
                    storage.write_doc(project_id, "devops_docker", "summary", devops_summary, title="DevOps Docker summary")
                    for i, art in enumerate(devops_artifacts):
                        if isinstance(art, dict):
                            content = art.get("content")
                            path_key = art.get("path") or f"artifact_{i}"
                            if content and path_key:
                                storage.write_project_artifact(project_id, path_key, content if isinstance(content, str) else str(content))
                            elif content:
                                storage.write_doc(project_id, "devops_docker", f"artifact_{i}", content, title=art.get("purpose", f"Artifact {i}"))
            except Exception as e:
                logger.exception("[Pipeline] DevOps Docker falhou")
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

        completed_at_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")
        _patch_project({
            "status": "completed",
            "completed_at": completed_at_iso,
            "charter_summary": charter_summary,
            "backlog_summary": backlog_summary[:2000] if backlog_summary else None,
        })
        pipeline_desc = "Engineer → CTO → PM Backend"
        if run_full_stack:
            pipeline_desc += " → Dev Backend → QA Backend → Monitor Backend → DevOps Docker"
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
        completed_at_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")
        _patch_project({"status": "failed", "completed_at": completed_at_iso})
        raise


if __name__ == "__main__":
    sys.exit(main())
