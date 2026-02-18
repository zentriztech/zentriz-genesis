"""
Serviço HTTP para disparar o runner em background (Opção B do pipeline).
POST /run com body: { projectId, specPath, apiBaseUrl, token }.
POST /stop com body: { projectId } para encerrar o pipeline em execução.
O runner roda em subprocess com --spec-file e env (API_BASE_URL, PROJECT_ID, GENESIS_API_TOKEN, etc.).
Uso em Docker quando a API não tem Python no container.
"""
import base64
import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Dict

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

app = FastAPI(title="Genesis Runner Service", version="0.1.0")

# projectId -> pid do subprocess do runner (para POST /stop)
_running_pids: Dict[str, int] = {}

# Diretório para specs quando recebidas em base64 (specContent)
SPEC_TMP_DIR = Path(tempfile.gettempdir()) / "genesis_runner_specs"


class RunBody(BaseModel):
    projectId: str
    specPath: str | None = None
    specContent: str | None = None  # base64 opcional (quando não há volume compartilhado)
    apiBaseUrl: str
    token: str


class StopBody(BaseModel):
    projectId: str


def _ensure_spec_tmp_dir() -> Path:
    SPEC_TMP_DIR.mkdir(parents=True, exist_ok=True)
    return SPEC_TMP_DIR


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/run")
def run(body: RunBody):
    """
    Dispara o runner em background com --spec-file e env.
    Aceita specPath (path no container, ex.: volume compartilhado) ou specContent (base64).
    """
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

    env = {
        **os.environ,
        "API_BASE_URL": body.apiBaseUrl,
        "PROJECT_ID": body.projectId,
        "GENESIS_API_TOKEN": body.token,
    }
    if not env.get("CLAUDE_API_KEY"):
        logger.warning("CLAUDE_API_KEY não definida; o runner pode falhar ao chamar os agentes")

    cmd = [
        "python", "-m", "orchestrator.runner",
        "--spec-file", spec_path,
    ]
    try:
        # stderr herdado para que erros do runner apareçam em docker logs runner
        proc = subprocess.Popen(
            cmd,
            env=env,
            cwd="/app",
            stdout=subprocess.DEVNULL,
            stderr=None,
            start_new_session=True,
        )
    except FileNotFoundError:
        logger.exception("python ou módulo orchestrator não encontrado")
        raise HTTPException(status_code=500, detail="Runner não disponível (python/orchestrator)")
    except Exception as e:
        logger.exception("Falha ao iniciar runner")
        raise HTTPException(status_code=500, detail=str(e))

    _running_pids[body.projectId] = proc.pid
    logger.info("Runner iniciado em background pid=%s projectId=%s", proc.pid, body.projectId)
    return {"ok": True, "message": "Pipeline iniciado", "pid": proc.pid}


@app.post("/stop")
def stop(body: StopBody):
    """Encerra o pipeline em execução para o projectId (envia SIGTERM ao processo)."""
    pid = _running_pids.pop(body.projectId, None)
    if pid is None:
        return {"ok": True, "message": "Nenhum pipeline em execução para este projeto"}
    try:
        os.kill(pid, 15)
        logger.info("Pipeline encerrado (SIGTERM) pid=%s projectId=%s", pid, body.projectId)
        return {"ok": True, "message": "Pipeline encerrado"}
    except ProcessLookupError:
        return {"ok": True, "message": "Processo já havia terminado"}
    except Exception as e:
        logger.warning("Falha ao encerrar processo %s: %s", pid, e)
        raise HTTPException(status_code=500, detail=str(e))
