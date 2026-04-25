"""
Serviço HTTP para disparar o runner em background (Opção B do pipeline).
POST /run  — inicia pipeline. Recusa se já houver processo ativo para o projeto.
POST /stop — encerra o pipeline (SIGTERM + fallback SIGKILL).
GET  /status — lista projetos em execução com PIDs.

Fixes aplicados:
- Mutex por project_id: impede dois pipelines simultâneos do mesmo projeto
- PID persistido em disco (STATE_DIR/project_id/runner.pid): sobrevive a restart do container
- /stop relê PID do disco se não estiver na memória
- /status expõe projetos ativos para diagnóstico
- Limpeza automática de PIDs de processos mortos a cada /run
"""
import base64
import logging
import os
import signal
import tempfile
import threading
from pathlib import Path
from typing import Dict

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

app = FastAPI(title="Genesis Runner Service", version="0.2.0")

# ── Estado em memória ──────────────────────────────────────────────────────
# projectId -> pid  (complementado pelo disco — veja _pid_file())
_running_pids: Dict[str, int] = {}
_lock = threading.Lock()  # mutex global para operações em _running_pids

# ── Diretório de estado ────────────────────────────────────────────────────
# Compartilhado com orchestrator/runner.py via volume — mesma raiz
STATE_ROOT = Path(os.environ.get("RUNNER_STATE_DIR", "/app/orchestrator/state"))

# Specs base64 recebidas via specContent
SPEC_TMP_DIR = Path(tempfile.gettempdir()) / "genesis_runner_specs"


# ── Helpers ────────────────────────────────────────────────────────────────

def _pid_file(project_id: str) -> Path:
    """Arquivo que persiste o PID do processo do runner para um projeto."""
    p = STATE_ROOT / project_id
    p.mkdir(parents=True, exist_ok=True)
    return p / "runner.pid"


def _write_pid(project_id: str, pid: int) -> None:
    _pid_file(project_id).write_text(str(pid), encoding="utf-8")


def _read_pid(project_id: str) -> int | None:
    f = _pid_file(project_id)
    if not f.exists():
        return None
    try:
        return int(f.read_text(encoding="utf-8").strip())
    except (ValueError, OSError):
        return None


def _clear_pid(project_id: str) -> None:
    try:
        _pid_file(project_id).unlink(missing_ok=True)
    except OSError:
        pass


def _is_process_alive(pid: int) -> bool:
    """Verifica se o processo com o PID ainda está rodando."""
    try:
        os.kill(pid, 0)  # signal 0 = apenas verifica existência
        return True
    except (ProcessLookupError, PermissionError):
        return False


def _kill_process(pid: int, project_id: str) -> str:
    """Envia SIGTERM; se ainda vivo após 5s envia SIGKILL."""
    import time
    try:
        os.kill(pid, signal.SIGTERM)
        logger.info("[Runner] SIGTERM enviado pid=%s projectId=%s", pid, project_id)
        for _ in range(10):
            time.sleep(0.5)
            if not _is_process_alive(pid):
                return "stopped"
        # Processo ignorou SIGTERM — forçar SIGKILL
        os.kill(pid, signal.SIGKILL)
        logger.warning("[Runner] SIGKILL enviado pid=%s projectId=%s", pid, project_id)
        return "killed"
    except ProcessLookupError:
        return "already_dead"
    except Exception as e:
        logger.warning("[Runner] Falha ao matar processo %s: %s", pid, e)
        return "error"


def _purge_dead_pids() -> None:
    """Remove da memória e do disco os PIDs de processos mortos."""
    dead = [pid_proj for pid_proj, pid in list(_running_pids.items()) if not _is_process_alive(pid)]
    for project_id in dead:
        _running_pids.pop(project_id, None)
        _clear_pid(project_id)
        logger.info("[Runner] PID de processo morto removido projectId=%s", project_id)


def _ensure_spec_tmp_dir() -> Path:
    SPEC_TMP_DIR.mkdir(parents=True, exist_ok=True)
    return SPEC_TMP_DIR


# ── Startup: recarregar PIDs do disco ─────────────────────────────────────

@app.on_event("startup")
def _reload_pids_from_disk() -> None:
    """
    Ao iniciar o container, verifica se havia processos ativos salvos em disco.
    Processos mortos são descartados; processos vivos são restaurados em _running_pids.
    """
    if not STATE_ROOT.exists():
        return
    restored = 0
    for pid_file in STATE_ROOT.glob("*/runner.pid"):
        project_id = pid_file.parent.name
        try:
            pid = int(pid_file.read_text(encoding="utf-8").strip())
        except (ValueError, OSError):
            pid_file.unlink(missing_ok=True)
            continue
        if _is_process_alive(pid):
            _running_pids[project_id] = pid
            restored += 1
            logger.info("[Runner] PID restaurado do disco pid=%s projectId=%s", pid, project_id)
        else:
            pid_file.unlink(missing_ok=True)
    if restored:
        logger.info("[Runner] %d processo(s) ativos restaurados do disco.", restored)


# ── Endpoints ──────────────────────────────────────────────────────────────

class RunBody(BaseModel):
    projectId: str
    specPath: str | None = None
    specContent: str | None = None
    apiBaseUrl: str
    token: str


class StopBody(BaseModel):
    projectId: str


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/status")
def status():
    """Retorna projetos com pipeline ativo e seus PIDs — útil para diagnóstico."""
    with _lock:
        _purge_dead_pids()
        active = {pid_proj: pid for pid_proj, pid in _running_pids.items() if _is_process_alive(pid)}
    return {"active_count": len(active), "projects": active}


@app.post("/run")
def run(body: RunBody):
    """
    Dispara o runner em background para um projeto.

    Garante isolamento:
    1. Se o projeto já tem processo ativo (memória ou disco), recusa com 409.
    2. Limpa PIDs mortos antes de iniciar.
    3. Persiste o PID em disco para sobreviver a restarts do container.
    """
    with _lock:
        # Limpar processos mortos antes de verificar conflito
        _purge_dead_pids()

        # Verificar se já existe processo ativo para este projeto
        existing_pid = _running_pids.get(body.projectId) or _read_pid(body.projectId)
        if existing_pid and _is_process_alive(existing_pid):
            logger.warning(
                "[Runner] Recusando /run — projeto já tem pipeline ativo pid=%s projectId=%s",
                existing_pid, body.projectId,
            )
            raise HTTPException(
                status_code=409,
                detail=f"Pipeline já em execução para o projeto {body.projectId} (pid={existing_pid}). "
                       f"Envie POST /stop primeiro.",
            )

        # Resolver spec path
        spec_path = body.specPath
        if body.specContent:
            _ensure_spec_tmp_dir()
            path = SPEC_TMP_DIR / f"{body.projectId}.md"
            try:
                content = base64.b64decode(body.specContent).decode("utf-8")
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"specContent inválido (base64): {e}")
            path.write_text(content, encoding="utf-8")
            spec_path = str(path.resolve())

        if not spec_path:
            raise HTTPException(status_code=400, detail="Informe specPath ou specContent")

        spec_file = Path(spec_path)
        if not spec_file.is_file():
            logger.error(
                "[Runner] Spec não encontrada: %s (projectId=%s)", spec_path, body.projectId,
            )
            raise HTTPException(
                status_code=400,
                detail=f"Arquivo de spec não encontrado: {spec_path}",
            )

        logger.info(
            "[Runner] POST /run projectId=%s specPath=%s",
            body.projectId, spec_path[:100],
        )

        env = {
            **os.environ,
            "API_BASE_URL": body.apiBaseUrl,
            "PROJECT_ID": body.projectId,
            "GENESIS_API_TOKEN": body.token,
        }
        if not env.get("CLAUDE_API_KEY"):
            logger.warning("CLAUDE_API_KEY não definida; o runner pode falhar ao chamar os agentes")

        cmd = ["python", "-m", "orchestrator.runner", "--spec-file", spec_path]
        try:
            proc = subprocess.Popen(  # noqa: S603
                cmd,
                env=env,
                cwd="/app",
                stdout=subprocess.DEVNULL,
                stderr=None,
                start_new_session=True,
            )
        except FileNotFoundError:
            raise HTTPException(status_code=500, detail="Runner não disponível (python/orchestrator)")
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

        # Registrar em memória E em disco
        _running_pids[body.projectId] = proc.pid
        _write_pid(body.projectId, proc.pid)

        logger.info("Runner iniciado pid=%s projectId=%s", proc.pid, body.projectId)
        return {"ok": True, "message": "Pipeline iniciado", "pid": proc.pid}


@app.post("/stop")
def stop(body: StopBody):
    """
    Encerra o pipeline do projeto.
    Tenta SIGTERM; se necessário escalona para SIGKILL.
    Funciona mesmo após restart do container (lê PID do disco).
    """
    with _lock:
        # Tentar memória primeiro, depois disco
        pid = _running_pids.pop(body.projectId, None)
        if pid is None:
            pid = _read_pid(body.projectId)
        _clear_pid(body.projectId)

    if pid is None:
        return {"ok": True, "message": "Nenhum pipeline em execução para este projeto"}

    if not _is_process_alive(pid):
        return {"ok": True, "message": "Processo já havia terminado"}

    result = _kill_process(pid, body.projectId)
    logger.info("Pipeline encerrado (%s) pid=%s projectId=%s", result, pid, body.projectId)
    return {"ok": True, "message": f"Pipeline encerrado ({result})", "pid": pid}


import subprocess  # noqa: E402  (import após definição de helpers para evitar circular)
