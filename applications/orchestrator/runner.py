"""
Runner do orquestrador: spec -> CTO (Charter) -> PM Backend (backlog).
Persiste estado em orchestrator/state/ e emite eventos conforme schemas.
Uso: python -m orchestrator.runner --spec spec/PRODUCT_SPEC.md

Quando as variáveis API_BASE_URL, PROJECT_ID e GENESIS_API_TOKEN estiverem
definidas, o runner atualiza o projeto na API: started_at ao iniciar e
completed_at + status ao concluir (PATCH /api/projects/:id).
Registra passos e erros no diálogo (project_dialogue) para o portal exibir.
"""
import argparse
import json
import logging
import os
import sys
import traceback
import urllib.request
from pathlib import Path
from datetime import datetime

# Import tardio para evitar dependência circular; usado em main() para diálogo
def _get_summary_human(*a, **k):
    from orchestrator.dialogue import get_summary_human
    return get_summary_human(*a, **k)

# Raiz do repo: runner está em applications/orchestrator/ (host) ou orchestrator/ (container)
_here = Path(__file__).resolve().parent  # applications/orchestrator ou /app/orchestrator
_repo = _here.parent.parent  # applications ou repo root
REPO_ROOT = _repo.parent if _repo.name == "applications" else _repo
# No host: applications/ existe; no container: layout é /app/agents, /app/orchestrator
APPLICATIONS_ROOT = REPO_ROOT / "applications" if (REPO_ROOT / "applications").exists() else REPO_ROOT

_dotenv = REPO_ROOT / ".env"
if _dotenv.exists():
    from dotenv import load_dotenv
    load_dotenv(_dotenv)

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

STATE_DIR = APPLICATIONS_ROOT / "orchestrator" / "state"
EVENTS_DIR = APPLICATIONS_ROOT / "orchestrator" / "events" / "schemas"


def ensure_state_dir() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)


def load_spec(spec_path: Path) -> str:
    path = spec_path if spec_path.is_absolute() else REPO_ROOT / spec_path
    if not path.exists():
        raise FileNotFoundError(f"Spec não encontrada: {path}")
    return path.read_text(encoding="utf-8")


def _agents_root() -> Path:
    return APPLICATIONS_ROOT / "agents"


def call_engineer(spec_ref: str, spec_content: str, request_id: str) -> dict:
    """Engineer analisa spec e devolve proposta técnica (stacks/equipes, dependências)."""
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


def _project_id() -> str | None:
    return os.environ.get("PROJECT_ID")


def _post_dialogue(from_agent: str, to_agent: str, event_type: str, summary_human: str, request_id: str) -> None:
    """Persiste entrada no log de diálogo da API quando PROJECT_ID e API estão configurados."""
    pid = _project_id()
    if not pid:
        return
    from orchestrator.dialogue import post_dialogue
    post_dialogue(pid, from_agent, to_agent, summary_human, event_type=event_type, request_id=request_id)


def _post_step(step_message: str, request_id: str) -> None:
    """Registra um passo no log do portal (event_type=step, from/to=system)."""
    _post_dialogue("system", "system", "step", step_message, request_id)


def _post_error(message: str, request_id: str, exc: BaseException | None = None) -> None:
    """Registra erro no log do portal com stack trace simples (event_type=error)."""
    body = message
    if exc is not None:
        body = body + "\n\n" + "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))[:2000]
    _post_dialogue("system", "error", "error", body, request_id)


def _patch_project(body: dict) -> bool:
    """Envia PATCH /api/projects/:id quando API_BASE_URL, PROJECT_ID e GENESIS_API_TOKEN estão definidos."""
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Runner: spec -> CTO -> PM Backend -> backlog")
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

    logger.info("Lendo spec: %s", spec_ref)
    spec_content = load_spec(spec_path)

    now_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")
    _patch_project({"started_at": now_iso, "status": "running"})
    _post_step("Spec enviada. Pipeline iniciado.", request_id)

    try:
        # 1) Engineer -> proposta técnica (stacks, equipes, dependências)
        _post_step("CTO repassa a spec ao Engineer para análise de stacks e equipes.", request_id)
        _post_step("Engineer recebeu a spec. Analisando e criando proposta técnica.", request_id)
        logger.info("Chamando agente Engineer...")
        engineer_response = call_engineer(spec_ref, spec_content, request_id)
        engineer_summary = engineer_response.get("summary", "")
        logger.info("Engineer status: %s", engineer_response.get("status"))
        _post_step("Engineer respondeu com proposta técnica (stacks, equipes, dependências).", request_id)
        emit_event("cto.engineer.request", {"spec_ref": spec_ref}, request_id)
        emit_event("engineer.cto.response", {"summary": engineer_summary[:500]}, request_id)
        _post_dialogue("cto", "engineer", "cto.engineer.request", _get_summary_human("cto.engineer.request", "cto", "engineer", spec_ref[:500]), request_id)
        _post_dialogue("engineer", "cto", "engineer.cto.response", _get_summary_human("engineer.cto.response", "engineer", "cto", engineer_summary[:500]), request_id)

        # 2) CTO -> Charter (usando proposta do Engineer)
        _post_step("CTO recebeu a proposta do Engineer. Analisando e criando Charter.", request_id)
        logger.info("Chamando agente CTO...")
        cto_response = call_cto(spec_ref, request_id, engineer_proposal=engineer_summary)
        charter_summary = cto_response.get("summary", "")
        charter_artifacts = cto_response.get("artifacts", [])
        logger.info("CTO status: %s", cto_response.get("status"))
        _post_step("CTO criou o Charter. Repassando ao PM Backend.", request_id)

        # Persistir Charter em orchestrator/state/ (não em project/docs/)
        charter_path = STATE_DIR / "PROJECT_CHARTER.md"
        if charter_artifacts and charter_summary:
            ensure_state_dir()
            charter_path.write_text(f"# Project Charter (gerado pelo CTO)\n\n{charter_summary}\n", encoding="utf-8")
            logger.info("Charter persistido: %s", charter_path)

        emit_event("project.created", {"spec_ref": spec_ref, "constraints": {}, "engineer_summary": engineer_summary[:300]}, request_id)
        _post_dialogue("cto", "pm_backend", "project.created", _get_summary_human("project.created", "cto", "pm_backend", charter_summary[:300]), request_id)

        # 3) PM Backend -> backlog
        _post_step("PM Backend recebeu o Charter. Criando backlog.", request_id)
        logger.info("Chamando agente PM Backend...")
        pm_response = call_pm_backend(spec_ref, charter_summary, request_id)
        backlog_summary = pm_response.get("summary", "")
        backlog_artifacts = pm_response.get("artifacts", [])
        logger.info("PM Backend status: %s", pm_response.get("status"))
        _post_step("PM Backend respondeu com backlog do módulo.", request_id)

        emit_event("module.planned", {"spec_ref": spec_ref, "backlog_summary": backlog_summary[:200]}, request_id)
        _post_dialogue("pm_backend", "cto", "module.planned", _get_summary_human("module.planned", "pm_backend", "cto", backlog_summary[:200]), request_id)

        # 4) Persistir estado
        persist_state(
            spec_ref=spec_ref,
            charter={"summary": charter_summary, "artifacts": charter_artifacts},
            backlog={"summary": backlog_summary, "artifacts": backlog_artifacts},
            events=["cto.engineer.request", "engineer.cto.response", "project.created", "module.planned"],
        )
        logger.info("Estado persistido em orchestrator/state/current_project.json")

        completed_at_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")
        _patch_project({
            "status": "completed",
            "completed_at": completed_at_iso,
            "charter_summary": charter_summary,
            "backlog_summary": backlog_summary[:2000] if backlog_summary else None,
        })
        _post_step("Pipeline concluído com sucesso.", request_id)

        print(json.dumps({
            "request_id": request_id,
            "spec_ref": spec_ref,
            "engineer_status": engineer_response.get("status"),
            "cto_status": cto_response.get("status"),
            "pm_status": pm_response.get("status"),
            "charter_path": str(charter_path),
            "state_path": str(STATE_DIR / "current_project.json"),
        }, indent=2))
        return 0

    except Exception as e:
        logger.exception("Falha no pipeline")
        _post_error(f"Erro de processamento: {e}", request_id, e)
        completed_at_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")
        _patch_project({"status": "failed", "completed_at": completed_at_iso})
        raise


if __name__ == "__main__":
    sys.exit(main())
