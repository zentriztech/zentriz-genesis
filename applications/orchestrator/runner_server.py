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
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Dict

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# T01: sanitiza AWS_PROFILE="" antes de qualquer import boto3.
for _k in ("AWS_PROFILE", "AWS_DEFAULT_PROFILE"):
    if _k in os.environ and not os.environ[_k].strip():
        os.environ.pop(_k, None)

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

app = FastAPI(title="Genesis Runner Service", version="0.2.0")

# ── Estado em memória ──────────────────────────────────────────────────────
# projectId -> pid  (complementado pelo disco — veja _pid_file())
_running_pids: Dict[str, int] = {}
_lock = threading.Lock()  # mutex global para operações em _running_pids

# ── T14: Circuit breaker LLM ──────────────────────────────────────────────
# Estado do circuit breaker para o classificador LLM. Quando um projeto
# recente sofreu ClassifierUnavailable (config/auth), novos projetos entram
# em BLOCKED_LLM_UNAVAILABLE por CB_COOLDOWN_S em vez de crashar.
_llm_cb_state = {
    "healthy": True,
    "last_check": 0.0,
    "last_fail": 0.0,
    "last_fail_kind": "",
    "consecutive_fails": 0,
}
_llm_cb_lock = threading.Lock()
LLM_CB_COOLDOWN_S = int(os.environ.get("LLM_CB_COOLDOWN_S", "60"))
LLM_CB_FAIL_THRESHOLD = int(os.environ.get("LLM_CB_FAIL_THRESHOLD", "3"))
LLM_CB_FILE = Path(os.environ.get("LLM_CB_FILE", "/tmp/genesis_llm_cb.json"))


def _cb_persist():
    """T14: persiste CB em arquivo para o runner subprocess ler."""
    try:
        import json as _j
        LLM_CB_FILE.write_text(_j.dumps(_llm_cb_state))
    except Exception:
        pass


def _cb_load():
    """T14: carrega CB do arquivo (usado no boot para sobreviver a restart do serviço)."""
    try:
        import json as _j
        if LLM_CB_FILE.exists():
            data = _j.loads(LLM_CB_FILE.read_text())
            _llm_cb_state.update({k: data[k] for k in _llm_cb_state.keys() if k in data})
    except Exception:
        pass


def llm_cb_snapshot() -> dict:
    """T14: retorna cópia do estado do circuit breaker LLM (sem lock)."""
    with _llm_cb_lock:
        return dict(_llm_cb_state)


def llm_cb_report(ok: bool, kind: str = "") -> None:
    """T14: agentes reportam sucesso/falha do LLM aqui.
    Após LLM_CB_FAIL_THRESHOLD falhas consecutivas de tipos fatais (config/auth),
    o breaker fica OPEN por LLM_CB_COOLDOWN_S segundos.
    """
    import time as _t
    with _llm_cb_lock:
        now = _t.time()
        _llm_cb_state["last_check"] = now
        if ok:
            _llm_cb_state["healthy"] = True
            _llm_cb_state["consecutive_fails"] = 0
            _cb_persist()
            return
        _llm_cb_state["last_fail"] = now
        _llm_cb_state["last_fail_kind"] = kind or "unknown"
        # Só conta como "hard fail" categorias fatais
        if kind in ("config", "auth"):
            _llm_cb_state["consecutive_fails"] += 1
            if _llm_cb_state["consecutive_fails"] >= LLM_CB_FAIL_THRESHOLD:
                _llm_cb_state["healthy"] = False
                logger.error(
                    "[T14-CB] Circuit breaker OPEN após %d falhas fatais (kind=%s). "
                    "Novos runs entrarão em BLOCKED por %ds.",
                    _llm_cb_state["consecutive_fails"], kind, LLM_CB_COOLDOWN_S,
                )
        _cb_persist()


# T14: carrega estado do CB no boot (sobrevive a restart do serviço)
_cb_load()


def llm_cb_is_open() -> bool:
    """T14: True se o CB está OPEN (LLM indisponível) e ainda dentro do cooldown."""
    import time as _t
    with _llm_cb_lock:
        if _llm_cb_state["healthy"]:
            return False
        elapsed = _t.time() - _llm_cb_state["last_fail"]
        if elapsed > LLM_CB_COOLDOWN_S:
            # Half-open — permite próxima tentativa
            _llm_cb_state["healthy"] = True
            _llm_cb_state["consecutive_fails"] = 0
            logger.info("[T14-CB] Circuit breaker half-open — cooldown expirou (%.1fs)", elapsed)
            return False
        return True


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


@app.get("/health/llm")
def health_llm():
    """T14: expõe estado do circuit breaker LLM. Portal/monitoring podem consultar."""
    snap = llm_cb_snapshot()
    return {
        "healthy": snap["healthy"],
        "cb_open": llm_cb_is_open(),
        "last_fail_kind": snap["last_fail_kind"],
        "consecutive_fails": snap["consecutive_fails"],
        "cooldown_s": LLM_CB_COOLDOWN_S,
    }


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

        # FT-13: Resolver credenciais LLM pela autoridade do projeto (zentriz_admin vs tenant)
        # Usa GENESIS_API_TOKEN do env (token interno do runner, aceito pelo endpoint)
        try:
            import urllib.request as _urlreq
            _internal_token = os.environ.get("GENESIS_API_TOKEN", "").strip() or body.token
            _llm_url = f"{body.apiBaseUrl.rstrip('/')}/api/internal/project-llm-config/{body.projectId}"
            _req = _urlreq.Request(_llm_url, headers={"X-Internal-Token": _internal_token})
            with _urlreq.urlopen(_req, timeout=5) as _resp:
                import json as _json
                _llm_cfg = _json.loads(_resp.read().decode())
            if _llm_cfg.get("ok"):
                _raw_provider = (_llm_cfg.get("provider") or "").strip().lower()
                _model_id     = (_llm_cfg.get("modelId")  or "").strip()
                _api_key      = (_llm_cfg.get("apiKey")   or "").strip()

                # Validar compatibilidade provider ↔ modelo.
                # Regra: respeitar o provider do banco. Só corrigir se for impossível
                # (ex: provider=bedrock com modelo gpt-4o, ou provider=openai com modelo us.anthropic.*).
                def _is_compatible(prov: str, m: str) -> bool:
                    ml = m.lower()
                    if prov == "bedrock"     and ml.startswith("us.anthropic"): return True
                    if prov == "anthropic"   and any(x in ml for x in ("claude", "sonnet", "opus", "haiku")) and not ml.startswith("us.anthropic"): return True
                    if prov == "openai"      and any(x in ml for x in ("gpt", "o1", "o3", "o4", "composer", "davinci")): return True
                    if prov == "azure_openai" and any(x in ml for x in ("gpt", "o1", "o3", "davinci")): return True
                    # Modelo desconhecido → assumir compatível (não quebrar)
                    known = any(x in ml for x in ("claude","sonnet","opus","haiku","gpt","o1","o3","o4","composer","davinci","us.anthropic"))
                    return not known

                if _model_id and not _is_compatible(_raw_provider, _model_id):
                    # Inferir provider correto para o modelo
                    ml = _model_id.lower()
                    if ml.startswith("us.anthropic"):
                        _corrected = "bedrock"
                    elif any(x in ml for x in ("claude", "sonnet", "opus", "haiku")):
                        _corrected = "anthropic"
                    elif any(x in ml for x in ("gpt", "o1", "o3", "o4", "composer", "davinci")):
                        _corrected = "openai"
                    else:
                        _corrected = _raw_provider
                    logger.warning(
                        "[FT-13] provider='%s' incompatível com modelo '%s' — corrigindo para '%s'",
                        _raw_provider, _model_id, _corrected,
                    )
                    _effective_provider = _corrected
                else:
                    _effective_provider = _raw_provider

                env["GENESIS_LLM_PROVIDER"] = _effective_provider
                env["CLAUDE_MODEL"]          = _model_id

                # Credentials por provider
                if _effective_provider == "openai" and _api_key:
                    env["CLAUDE_API_KEY"] = _api_key
                elif _effective_provider == "anthropic" and _api_key:
                    env["CLAUDE_API_KEY"] = _api_key
                elif _effective_provider == "bedrock":
                    # Bedrock usa credenciais AWS do env — não sobrescrever com OpenAI key
                    if _llm_cfg.get("awsAccessKeyId"):
                        env["AWS_ACCESS_KEY_ID"]     = _llm_cfg["awsAccessKeyId"]
                    if _llm_cfg.get("awsSecretAccessKey"):
                        env["AWS_SECRET_ACCESS_KEY"] = _llm_cfg["awsSecretAccessKey"]
                    if _llm_cfg.get("awsRegion"):
                        env["GENESIS_AWS_REGION"]    = _llm_cfg["awsRegion"]
                    # Limpar qualquer CLAUDE_API_KEY OpenAI que possa ter vazado
                    env.pop("CLAUDE_API_KEY", None)

                # Fallback model: usado em rework (QA_FAIL >= 1) e piso inter-agente Dev→QA
                _fallback_model = (_llm_cfg.get("fallbackModelId") or "").strip()
                if _fallback_model:
                    env["CLAUDE_MODEL_REWORK"] = _fallback_model
                    logger.info("[FT-13] Fallback model configurado: %s → %s", _model_id, _fallback_model)
                else:
                    # Se não há fallback explícito, remover override para usar o default do runner
                    env.pop("CLAUDE_MODEL_REWORK", None)

                _is_default = _llm_cfg.get("isDefault", True)
                logger.info("[FT-13] LLM config resolvida: provider=%s model=%s fallback=%s isDefault=%s",
                            _effective_provider, _model_id, _fallback_model or "none", _is_default)
        except Exception as _llm_err:
            logger.warning("[FT-13] Não foi possível resolver LLM config via API (%s) — usando env atual", _llm_err)

        if not env.get("CLAUDE_API_KEY") and env.get("GENESIS_LLM_PROVIDER", "bedrock") != "bedrock":
            logger.warning("CLAUDE_API_KEY não definida; o runner pode falhar ao chamar os agentes")

        # Runtime Config: sobrescreve env com valores da tabela genesis_runtime_config
        # Gera token fresco assinado com JWT_SECRET atual (body.token pode estar desatualizado)
        try:
            import urllib.request as _urlreq2
            import json as _json2
            import time as _time
            import hmac as _hmac
            import hashlib as _hashlib
            import struct as _struct

            # Gerar JWT HS256 mínimo sem dependência externa
            def _make_jwt(secret: str) -> str:
                import base64 as _b64
                header  = _b64.urlsafe_b64encode(b'{"alg":"HS256","typ":"JWT"}').rstrip(b"=").decode()
                now     = int(_time.time())
                payload = _b64.urlsafe_b64encode(
                    _json2.dumps({"sub":"runner","role":"zentriz_admin","tenantId":None,"iat":now,"exp":now+300}).encode()
                ).rstrip(b"=").decode()
                sig_input = f"{header}.{payload}".encode()
                sig = _b64.urlsafe_b64encode(
                    _hmac.HMAC(secret.encode(), sig_input, _hashlib.sha256).digest()
                ).rstrip(b"=").decode()
                return f"{header}.{payload}.{sig}"

            _jwt_secret = os.environ.get("JWT_SECRET", "genesis_secret")
            _fresh_token = _make_jwt(_jwt_secret)
            _cfg_url = f"{body.apiBaseUrl.rstrip('/')}/api/admin/runtime-config/resolved"
            _cfg_req = _urlreq2.Request(_cfg_url, headers={"Authorization": f"Bearer {_fresh_token}"})
            with _urlreq2.urlopen(_cfg_req, timeout=5) as _cfg_resp:
                _runtime_cfg = _json2.loads(_cfg_resp.read().decode())
            _RUNTIME_KEYS = {
                "AGENT_TIMEOUT_ENGINEER", "AGENT_TIMEOUT_CTO", "AGENT_TIMEOUT_PM",
                "AGENT_TIMEOUT_DEV", "AGENT_TIMEOUT_QA", "AGENT_TIMEOUT_MONITOR",
                "AGENT_TIMEOUT_DEVOPS", "REQUEST_TIMEOUT", "MAX_QA_REWORK",
                "CLAUDE_MAX_TOKENS", "CLAUDE_MAX_TOKENS_DEV", "CLAUDE_MAX_TOKENS_PM",
                "CLAUDE_MAX_TOKENS_ENGINEER", "CLAUDE_MAX_TOKENS_QA",
                "CLAUDE_MAX_TOKENS_SPEC_INTAKE",
            }
            applied = []
            for k, v in _runtime_cfg.items():
                if k in _RUNTIME_KEYS and v:
                    env[k] = str(v)
                    applied.append(f"{k}={v}")
            if applied:
                logger.info("[RuntimeConfig] Aplicado: %s", ", ".join(applied))
        except Exception as _cfg_err:
            logger.warning("[RuntimeConfig] Não foi possível carregar via API (%s) — usando env atual", _cfg_err)

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
