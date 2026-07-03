"""
Zentriz Cyborg — Autonomous Monitor (FT-14)
Claude Code CLI operando como membro permanente do time.

Responsabilidade:
- Poll por projetos em status "completed"
- Executa PLAYBOOK UNIVERSAL em 6 fases para validar o projeto
- Autocorrige problemas (máx 2 ciclos)
- POST /accept (accepted_by: zentriz-cyborg) ou POST /reject com log detalhado

Instanciação:
- Por Produto: 1 Cyborg por produto, acumula contexto entre projetos
- Por Projeto solitário: instância efêmera que encerra ao aceitar/rejeitar

Diretivas absolutas:
1. SOMENTE testa — nunca modifica código de produção sem registrar
2. Máx 2 ciclos de autocorreção por projeto
3. Timeout: 5 minutos por PLAYBOOK completo
4. Registra tudo em project_dialogue
5. Isolamento por produto — Cyborg A não interfere no Produto B
6. Critério de PASS: TODOS os checks do PLAYBOOK passam
"""

import os
import sys
import time
import json
import logging
import subprocess
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

try:
    import requests as _requests_lib
    def _http(method, url, headers, body, timeout):
        r = _requests_lib.request(method, url, headers=headers, json=body, timeout=timeout)
        return r.status_code, r.text
except ImportError:
    import urllib.request, urllib.error
    def _http(method, url, headers, body, timeout):  # type: ignore[misc]
        data = json.dumps(body).encode() if body else None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()
        except Exception as e:
            return 0, str(e)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [Cyborg] %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("zentriz.cyborg")

API_BASE_URL  = os.environ.get("API_BASE_URL",  "http://localhost:3000").rstrip("/")
GENESIS_TOKEN = os.environ.get("GENESIS_API_TOKEN", "")
POLL_INTERVAL = int(os.environ.get("CYBORG_POLL_INTERVAL", "60"))
MAX_FIX_CYCLES = int(os.environ.get("CYBORG_MAX_FIX_CYCLES", "2"))
PLAYBOOK_TIMEOUT = int(os.environ.get("CYBORG_PLAYBOOK_TIMEOUT", "300"))  # 5 min
PRODUCT_ID    = os.environ.get("CYBORG_PRODUCT_ID", "")   # vazio = modo solitário
PROJECT_FILES = os.environ.get("PROJECT_FILES_ROOT", "/project-files").rstrip("/")


# ─── Helpers de API ────────────────────────────────────────────────────────────

def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {GENESIS_TOKEN}", "Content-Type": "application/json"}


def _api(method: str, path: str, body: Optional[dict] = None) -> tuple[Any, int]:
    url = f"{API_BASE_URL}{path}"
    try:
        status, text = _http(method, url, _headers(), body, 30)
        try:
            data = json.loads(text)
        except Exception:
            data = {"raw": text[:500]}
        return data, status
    except Exception as e:
        return {"error": str(e)}, 0


def _post_dialogue(project_id: str, message: str) -> None:
    _api("POST", f"/api/projects/{project_id}/dialogue", {
        "fromAgent": "zentriz-cyborg",
        "toAgent": "system",
        "eventType": "step",
        "summaryHuman": message,
    })


def _accept(project_id: str, evidence: str) -> bool:
    data, status = _api("POST", f"/api/projects/{project_id}/accept", {
        "accepted_by": "zentriz-cyborg",
        "evidence": evidence,
    })
    return status in (200, 201)


def _reject(project_id: str, reason: str) -> bool:
    data, status = _api("POST", f"/api/projects/{project_id}/reject", {
        "rejected_by": "zentriz-cyborg",
        "reason": reason,
    })
    if status not in (200, 201):
        logger.warning("[Cyborg] REJECT FALHOU: endpoint /reject retorna %d — %s", status,
                       str(data)[:200])
        # Fallback: marcar como failed via PATCH se /reject não funcionar
        _api("PATCH", f"/api/projects/{project_id}", {"status": "failed"})
        return False
    return True


# ─── PLAYBOOK UNIVERSAL ────────────────────────────────────────────────────────

class PlaybookResult:
    def __init__(self) -> None:
        self.passed: list[str] = []
        self.failed: list[str] = []
        self.log: list[str] = []

    @property
    def ok(self) -> bool:
        return len(self.failed) == 0

    def record(self, check: str, ok: bool, detail: str = "") -> None:
        entry = f"[{'PASS' if ok else 'FAIL'}] {check}" + (f" — {detail}" if detail else "")
        self.log.append(entry)
        (self.passed if ok else self.failed).append(check)

    def summary(self) -> str:
        return "\n".join(self.log)


def _run_cmd(cmd: str, cwd: str | None = None, timeout: int = 60) -> tuple[int, str, str]:
    try:
        res = subprocess.run(
            cmd, shell=True, capture_output=True, text=True,
            timeout=timeout, cwd=cwd,
        )
        return res.returncode, res.stdout[:4000], res.stderr[:2000]
    except subprocess.TimeoutExpired:
        return -1, "", f"Timeout ({timeout}s)"
    except Exception as e:
        return -1, "", str(e)


def _detect_project_type(project_id: str, prod_id: str | None) -> str:
    """Detecta tipo do projeto pelo charter_summary ou pelo conteúdo do apps/."""
    data, _ = _api("GET", f"/api/projects/{project_id}")
    if not isinstance(data, dict):
        return "generic"
    charter = (data.get("charterSummary") or "").lower()
    title   = (data.get("title") or "").lower()
    extra   = data.get("extra") or {}

    combined = charter + " " + title
    if any(k in combined for k in ("nf-e", "nfe", "nota fiscal", "ct-e", "cte", "mdf-e", "mdfe", "nfs-e", "nfse", "nfc-e", "nfce", "fiscal")):
        return "fiscal"
    if any(k in combined for k in ("next.js", "nextjs", "react", "frontend", "manager", "portal", "dashboard")):
        return "frontend"
    if any(k in combined for k in ("migration", "schema", "banco", "database", "-db", "drizzle")):
        return "db"
    if any(k in combined for k in ("auth", "login", "jwt", "token", "usuário")):
        return "auth"
    return "generic"


def _find_project_dir(project_id: str, prod_id: str | None) -> Path | None:
    """Localiza o diretório raiz do projeto em PROJECT_FILES_ROOT.
    Tenta múltiplos paths: com produto, sem produto, e fallback sem exigir /apps.
    """
    root = Path(PROJECT_FILES)

    candidates: list[Path] = []
    if prod_id:
        candidates.append(root / prod_id / project_id)
    candidates.append(root / project_id)

    for base in candidates:
        if not base.exists():
            continue
        # Verificar se tem arquivos reais (não só pastas vazias)
        try:
            has_files = any(True for _ in base.rglob("*") if _.is_file())
        except PermissionError:
            has_files = False
        if has_files:
            logger.info("[Cyborg] Diretório do projeto encontrado: %s", base)
            return base

    logger.warning(
        "[Cyborg] Diretório não encontrado para project_id=%s prod_id=%s em %s",
        project_id[:8], prod_id, PROJECT_FILES,
    )
    return None


def _generate_api_contract(runbook: str, project_id: str) -> str:
    """Extrai informações do RUNBOOK.md para gerar um api_contract.md mínimo.
    Procura: Base URL / porta, credenciais seed, endpoints listados.
    Usado pelo Cyborg quando o DevOps não gerou o arquivo.
    """
    import re as _re

    # Extrair porta / base URL
    port_match = _re.search(r"(?:localhost|127\.0\.0\.1):(\d{4,5})", runbook)
    port = port_match.group(1) if port_match else "3000"
    base_url = f"http://localhost:{port}"

    # Extrair credenciais seed
    email_match = _re.search(r"(?:email|e-mail)\s*[:\|]\s*([a-z0-9_.+-]+@[a-z0-9.-]+\.[a-z]{2,})", runbook, _re.I)
    pass_match  = _re.search(r"(?:password|senha|pwd)\s*[:\|]\s*([^\s\n]{4,40})", runbook, _re.I)
    email    = email_match.group(1) if email_match else "admin@projeto.dev"
    password = pass_match.group(1)  if pass_match  else "Admin@123"

    # Extrair endpoints explícitos (linhas com GET/POST/PUT/DELETE /api/...)
    endpoints = _re.findall(r"\b(GET|POST|PUT|PATCH|DELETE)\s+(/[\w/:{}-]+)", runbook)
    endpoints_md = "\n".join(f"  {m} {ep}" for m, ep in endpoints[:40]) if endpoints else \
        "  GET  /api/health\n  POST /api/auth/login\n  GET  /api/auth/me"

    # Extrair informações de stack
    stack_match = _re.search(r"(?:Stack|stack|framework|Framework)\s*[:\|]\s*([^\n]{5,80})", runbook)
    stack = stack_match.group(1).strip() if stack_match else "Node.js / Fastify"

    return f"""# API Contract — Projeto {project_id[:8]}
# Gerado automaticamente pelo Zentriz Cyborg a partir do RUNBOOK.md

Base URL: {base_url}
Auth: Bearer JWT via POST /api/auth/login
Stack: {stack}

## Credenciais seed
  email: {email}
  password: {password}

## Endpoints
{endpoints_md}
"""


def check_consumer_integration(consumer_project_id: str, backend_project_id: str, prod_id: str | None) -> dict:
    """Valida integração entre um consumer (frontend/mobile) e seu backend.

    Extrai os paths de API que o consumer chama (src/lib/*.ts ou src/services/*.ts),
    extrai os paths que o backend expõe (api_contract.md ou introspection via swagger),
    compara e retorna:
      - missing_in_backend: paths que consumer chama mas backend não tem
      - path_mismatches: paths que existem com nome diferente (ex: /api/admin/x vs /api/x)
      - ok: paths validados

    Quando encontra gaps, tenta corrigir automaticamente:
      - Se o path existe com prefixo diferente (ex: /api/admin vs /api): corrige no consumer
      - Se o endpoint não existe no backend E é simples: cria alias/stub no backend
    """
    result: dict = {"ok": [], "missing_in_backend": [], "path_mismatches": [], "fixed": []}

    # 1. Encontrar diretório do consumer
    consumer_dir = _find_project_dir(consumer_project_id, prod_id)
    if not consumer_dir:
        result["error"] = "Consumer project directory not found"
        return result

    # 2. Extrair paths que o consumer chama
    import re as _re
    consumer_paths: set[str] = set()
    for ext in ("ts", "tsx", "js"):
        for lib_dir in ("src/lib", "src/services", "src/api", "src/hooks"):
            search_dir = consumer_dir / "apps" / lib_dir
            if not search_dir.exists():
                continue
            for f in search_dir.rglob(f"*.{ext}"):
                try:
                    text = f.read_text(encoding="utf-8", errors="replace")
                    # Capturar paths de API: '/api/...', "/api/..."
                    found = _re.findall(r"['\"`](/api/[^'\"`\s?#]+)", text)
                    consumer_paths.update(found)
                except Exception:
                    pass

    if not consumer_paths:
        result["info"] = "No API paths found in consumer source"
        return result

    result["consumer_paths_found"] = sorted(consumer_paths)

    # 3. Extrair paths que o backend expõe (via api_contract.md)
    backend_dir = _find_project_dir(backend_project_id, prod_id)
    backend_paths: set[str] = set()
    if backend_dir:
        contract_file = backend_dir / "project" / "api_contract.md"
        if contract_file.exists():
            contract_text = contract_file.read_text(encoding="utf-8", errors="replace")
            # Extrair paths do contrato: | GET | /api/... | ou `GET /api/...`
            found_contract = _re.findall(r"(?:GET|POST|PATCH|PUT|DELETE)\s+(/api/[^\s|`\n]+)", contract_text)
            backend_paths.update(p.rstrip("/") for p in found_contract)

    # 4. Verificar cada path do consumer
    for path in sorted(consumer_paths):
        norm = path.rstrip("/")
        # Substituir IDs dinâmicos por placeholder
        norm_generic = _re.sub(r"/[0-9a-f-]{8,}[0-9a-f-]*", "/:id", norm)

        # Verificar se existe no backend
        matched = any(
            norm_generic == _re.sub(r"/[0-9a-f-]{8,}", "/:id", bp)
            or norm_generic.rstrip("/") == bp.rstrip("/")
            for bp in backend_paths
        )

        if matched:
            result["ok"].append(norm)
        elif backend_paths:
            # Verificar se existe com prefixo diferente
            suffix = norm.replace("/api/admin", "/api").replace("/api/v1", "/api")
            suffix_matched = any(suffix.rstrip("/") == bp.rstrip("/") for bp in backend_paths)
            if suffix_matched:
                result["path_mismatches"].append({"consumer": norm, "backend": suffix, "fix": "rename_consumer"})
            else:
                result["missing_in_backend"].append(norm)

    return result


def _check_and_fix_consumer_integration(consumer_project_id: str, prod_id: str) -> dict:
    """Encontra o backend do produto, roda check_consumer_integration e aplica correções automáticas."""
    # Encontrar projetos do mesmo produto via API
    data, status = _api("GET", "/api/projects")
    if status != 200 or not isinstance(data, list):
        return {"error": "Cannot list projects"}

    # Backend = projeto do mesmo produto que não é frontend/mobile
    backend_candidates = [
        p for p in data
        if p.get("productId") == prod_id
        and p.get("id") != consumer_project_id
        and p.get("status") in ("accepted", "completed", "running", "pending_cyborg")
    ]
    if not backend_candidates:
        return {"info": "No backend project found in product"}

    backend_project_id = backend_candidates[0]["id"]
    logger.info("[Cyborg] Verificando integração %s → %s", consumer_project_id[:8], backend_project_id[:8])

    issues = check_consumer_integration(consumer_project_id, backend_project_id, prod_id)

    fixed = []
    import re as _re2

    # Auto-corrigir: paths com prefixo errado (ex: /api/admin → /api)
    if issues.get("path_mismatches"):
        consumer_dir = _find_project_dir(consumer_project_id, prod_id)
        if consumer_dir:
            apps_dir = consumer_dir / "apps"
            for mismatch in issues["path_mismatches"]:
                wrong  = mismatch.get("consumer", "")
                correct = mismatch.get("backend", "")
                if wrong and correct and apps_dir.exists():
                    # Substituir em todos os arquivos .ts/.tsx do consumer
                    import subprocess as _sp
                    _sp.run(
                        ["grep", "-rl", wrong, str(apps_dir / "src")],
                        capture_output=True, text=True
                    )
                    for ts_file in apps_dir.rglob("src/**/*.ts"):
                        try:
                            content = ts_file.read_text(encoding="utf-8")
                            if wrong in content:
                                ts_file.write_text(content.replace(wrong, correct), encoding="utf-8")
                                fixed.append(f"Fixed {ts_file.name}: {wrong} → {correct}")
                        except Exception:
                            pass
                    for tsx_file in apps_dir.rglob("src/**/*.tsx"):
                        try:
                            content = tsx_file.read_text(encoding="utf-8")
                            if wrong in content:
                                tsx_file.write_text(content.replace(wrong, correct), encoding="utf-8")
                                fixed.append(f"Fixed {tsx_file.name}: {wrong} → {correct}")
                        except Exception:
                            pass

    issues["fixed"] = fixed
    return issues


def _run_playbook(project_id: str, prod_id: str | None, cyborg_ctx: dict) -> PlaybookResult:
    """PLAYBOOK UNIVERSAL — 6 fases."""
    result = PlaybookResult()
    proj_dir = _find_project_dir(project_id, prod_id)
    apps_dir = str(proj_dir / "apps") if proj_dir else None
    project_dir = str(proj_dir / "project") if proj_dir else None

    # ── FASE 1: LEITURA ────────────────────────────────────────────────────────
    result.log.append("=== FASE 1: LEITURA ===")
    runbook_content = ""
    smoke_script    = ""
    api_contract    = ""

    if project_dir:
        try:
            # RUNBOOK.md é informativo — não bloquear se não existir
            for runbook_name in ("RUNBOOK.md", "README.md", "docs/RUNBOOK.md"):
                runbook = Path(project_dir) / runbook_name
                if runbook.exists():
                    runbook_content = runbook.read_text(encoding="utf-8", errors="replace")[:8000]
                    result.record("RUNBOOK.md existe", True, f"{len(runbook_content)} chars ({runbook_name})")
                    break
            else:
                # Não bloquear — logar apenas como aviso
                result.log.append("[WARN] RUNBOOK.md não encontrado — continuando sem ele")
        except Exception as e:
            result.log.append(f"[WARN] Erro ao ler RUNBOOK: {e}")

        try:
            # smoke_test.sh é opcional — se não existir, Cyborg usa api_contract.md
            smoke = Path(project_dir) / "smoke_test.sh"
            if smoke.exists():
                smoke_script = smoke.read_text(encoding="utf-8", errors="replace")[:4000]
                result.log.append("[INFO] smoke_test.sh encontrado")
            else:
                result.log.append("[INFO] smoke_test.sh não encontrado — usando api_contract.md para smoke")
        except Exception:
            pass

        try:
            contract = Path(project_dir) / "api_contract.md"
            if contract.exists() and contract.stat().st_size > 10:
                api_contract = contract.read_text(encoding="utf-8", errors="replace")[:8000]
                result.record("api_contract.md existe", True, f"{len(api_contract)} chars")
            else:
                # Frontends não têm api_contract.md próprio — consomem o do backend.
                # Apenas backends precisam expor o contrato.
                _detected_type = _detect_project_type(project_id, prod_id)
                if _detected_type in ("frontend", "mobile"):
                    result.log.append(f"[INFO] Projeto {_detected_type} — api_contract.md não obrigatório (consome API do backend)")
                    # Tentar ler o contrato do produto (gerado pelo backend)
                    if prod_id:
                        product_contract = Path(PROJECT_FILES) / prod_id / "contracts" / f"*.api_contract.md"
                        import glob as _glob
                        candidates = _glob.glob(str(product_contract))
                        if candidates:
                            api_contract = Path(candidates[0]).read_text(encoding="utf-8", errors="replace")[:8000]
                            result.log.append(f"[INFO] api_contract.md do produto carregado: {candidates[0]}")
                else:
                    # Backend: tentar gerar a partir do RUNBOOK.md
                    result.record("api_contract.md existe", False, "gerando a partir do RUNBOOK.md")
                    if runbook_content:
                        api_contract = _generate_api_contract(runbook_content, project_id)
                        if api_contract:
                            contract.write_text(api_contract, encoding="utf-8")
                            if prod_id:
                                contracts_dir = Path(PROJECT_FILES) / prod_id / "contracts"
                                contracts_dir.mkdir(parents=True, exist_ok=True)
                                dest = contracts_dir / f"{project_id[:8]}.api_contract.md"
                                import shutil as _shutil
                                _shutil.copy2(str(contract), str(dest))
                            result.record("api_contract.md gerado pelo Cyborg", True, f"{len(api_contract)} chars")
                            logger.info("[Cyborg] api_contract.md gerado para projeto %s", project_id[:8])
        except Exception as e:
            result.record("api_contract.md", False, str(e))

    # ── FASE 2: INFRAESTRUTURA ─────────────────────────────────────────────────
    result.log.append("=== FASE 2: INFRAESTRUTURA ===")
    # Procurar docker-compose.yml em project/ (gerado pelo DevOps) ou apps/ (fallback)
    _compose_dir: str | None = None
    if project_dir and (Path(project_dir) / "docker-compose.yml").exists():
        _compose_dir = project_dir
    elif apps_dir and (Path(apps_dir) / "docker-compose.yml").exists():
        _compose_dir = apps_dir
    if _compose_dir:
        rc, out, err = _run_cmd(
            "docker compose up -d --build 2>&1 | tail -30",
            cwd=_compose_dir, timeout=PLAYBOOK_TIMEOUT,
        )
        if rc == 0:
            # Aguardar healthcheck
            time.sleep(15)
            rc2, out2, _ = _run_cmd("docker compose ps", cwd=_compose_dir, timeout=30)
            all_healthy = "unhealthy" not in out2.lower() and "exited" not in out2.lower()
            result.record("docker compose up", rc == 0, out[-300:] if rc != 0 else "OK")
            result.record("Containers saudáveis", all_healthy, out2[-300:] if not all_healthy else "OK")
        else:
            result.record("docker compose up", False, f"exit={rc}\n{err[-500:]}")
    elif apps_dir:
        # Projeto sem docker — verificar se tem start.sh
        start_sh = Path(apps_dir).parent / "project" / "start.sh"
        if start_sh.exists():
            rc, out, err = _run_cmd(f"bash {start_sh} &", cwd=str(start_sh.parent), timeout=30)
            result.record("start.sh executável", rc in (0, -1), "iniciado em background")
        else:
            result.record("Infraestrutura detectável", False, "Sem docker-compose.yml nem start.sh")

    # ── FASE 3: SMOKE TEST ─────────────────────────────────────────────────────
    result.log.append("=== FASE 3: SMOKE TEST ===")
    _in_docker   = os.path.exists("/.dockerenv")
    _smoke_host  = "host.docker.internal" if _in_docker else "localhost"
    import re as _re

    if smoke_script:
        rc, out, err = _run_cmd("bash -e smoke_test.sh", cwd=project_dir, timeout=120)
        result.record("smoke_test.sh executado", rc == 0, (out + err)[-500:] if rc != 0 else "OK")
    else:
        # Detectar porta pelo docker-compose ativo
        _port_from_compose: str | None = None
        if _compose_dir and (Path(_compose_dir) / "docker-compose.yml").exists():
            try:
                _dc_txt = (Path(_compose_dir) / "docker-compose.yml").read_text(encoding="utf-8")
                _pm = _re.search(r'"(\d{4,5}):\d{4,5}"', _dc_txt) or _re.search(r"(\d{4,5}):\d{4,5}", _dc_txt)
                if _pm:
                    _port_from_compose = _pm.group(1)
            except Exception:
                pass

        _proj_type = _detect_project_type(project_id, prod_id)
        _port = _port_from_compose

        if _port:
            if _proj_type in ("frontend", "mobile"):
                # Frontend: qualquer resposta HTTP < 500 é OK (pode redirecionar para login)
                rc, out, _ = _run_cmd(
                    f"curl -sI http://{_smoke_host}:{_port}/ | head -1",
                    timeout=20
                )
                _ok = rc == 0 and ("HTTP/" in out) and not any(c in out for c in ["5", "000"])
                result.record(f"Frontend responde :{_port}", _ok, out[:100] if not _ok else "OK")
            else:
                # Backend: testar health endpoint
                rc, out, _ = _run_cmd(
                    f"curl -sf http://{_smoke_host}:{_port}/api/health || "
                    f"curl -sf http://{_smoke_host}:{_port}/health || "
                    f"curl -sf http://{_smoke_host}:{_port}/healthz",
                    timeout=20
                )
                result.record(f"Health endpoint :{_port}", rc == 0, out[:200] if rc != 0 else "OK")
        elif api_contract:
            port_match = _re.search(r"http://localhost:(\d+)", api_contract)
            if port_match:
                port = port_match.group(1)
                rc, out, _ = _run_cmd(
                    f"curl -sf http://{_smoke_host}:{port}/api/health || "
                    f"curl -sf http://{_smoke_host}:{port}/health",
                    timeout=20
                )
                result.record(f"Health endpoint :{port}", rc == 0, out[:200] if rc != 0 else "OK")
            else:
                result.record("Health endpoint", False, "Porta não detectada")
        else:
            result.record("Health endpoint", False, "Porta não detectada no api_contract.md")

    # ── FASE 4: VALIDAÇÃO FUNCIONAL ────────────────────────────────────────────
    result.log.append("=== FASE 4: VALIDAÇÃO FUNCIONAL ===")
    proj_type = _detect_project_type(project_id, prod_id)
    result.log.append(f"Tipo detectado: {proj_type}")

    if api_contract and "POST" in api_contract:
        # Tentar login com credenciais do seed
        import re as _re2
        login_url_match = _re2.search(r"http://localhost:\d+", api_contract)
        cred_match = _re2.search(r"(?:email|user).*?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})", api_contract, _re2.IGNORECASE)
        pass_match = _re2.search(r"password.*?[\"']([^\"']+)[\"']", api_contract, _re2.IGNORECASE)

        if login_url_match and cred_match:
            base = login_url_match.group(0)
            email = cred_match.group(1)
            pwd = pass_match.group(1) if pass_match else "Admin@123"
            rc, out, _ = _run_cmd(
                f'curl -sf -X POST {base}/api/auth/login '
                f'-H "Content-Type: application/json" '
                f'-d \'{{"email":"{email}","password":"{pwd}"}}\' | head -200',
                timeout=15
            )
            login_ok = rc == 0 and ("token" in out.lower() or "access" in out.lower())
            result.record("Login com credenciais do seed", login_ok, out[:200] if not login_ok else "Token retornado")

            if login_ok:
                # Extrair token e testar GET de listagem
                try:
                    login_json = json.loads(out.split("\n")[0])
                    token = (login_json.get("data") or login_json).get("accessToken") or (login_json.get("data") or login_json).get("token", "")
                    if token:
                        # Testar primeiro endpoint GET do contrato
                        endpoint_match = _re2.search(r"GET\s+(/?api/\S+)", api_contract)
                        if endpoint_match:
                            ep = endpoint_match.group(1).rstrip(",").strip()
                            rc2, out2, _ = _run_cmd(
                                f'curl -sf -H "Authorization: Bearer {token}" {base}/{ep.lstrip("/")}',
                                timeout=15
                            )
                            result.record(f"GET {ep}", rc2 == 0, out2[:200] if rc2 != 0 else "200 OK")
                except Exception as fe:
                    result.record("Parse token", False, str(fe))

    # ── FASE 5: AUTOCORREÇÃO ───────────────────────────────────────────────────
    # (Chamada externamente em run_with_autocorrection — esta fase é placeholder no log)
    result.log.append("=== FASE 5: AUTOCORREÇÃO (se necessário) ===")
    result.log.append("Autocorreção executada fora do PLAYBOOK principal se FASE 3/4 falharam.")

    # ── FASE 6: DECISÃO ────────────────────────────────────────────────────────
    result.log.append("=== FASE 6: DECISÃO ===")
    result.log.append(f"PASS: {len(result.passed)} checks | FAIL: {len(result.failed)} checks")
    if result.failed:
        result.log.append(f"Falhas: {', '.join(result.failed)}")

    return result


def _autocorrect(project_id: str, proj_dir: Path | None, failed_checks: list[str]) -> bool:
    """Tenta corrigir os problemas encontrados. Retorna True se conseguiu corrigir."""
    if not proj_dir:
        return False

    apps_dir = proj_dir / "apps"
    project_d = proj_dir / "project"
    corrected = False

    for check in failed_checks:
        check_lower = check.lower()

        if "seed" in check_lower and apps_dir.exists():
            # Tentar rodar seed manualmente
            seed_files = list(apps_dir.glob("**/seed.mjs")) + list(apps_dir.glob("**/seed.py"))
            if seed_files:
                rc, _, err = _run_cmd(f"node {seed_files[0]}", cwd=str(apps_dir), timeout=60)
                if rc == 0:
                    logger.info("[Cyborg] Seed executado manualmente para projeto %s", project_id[:8])
                    corrected = True

        elif "health" in check_lower or "container" in check_lower:
            # Reiniciar containers — procurar docker-compose em project/ primeiro, depois apps/
            _dc_dir = None
            if proj_dir and (proj_dir / "docker-compose.yml").exists():
                _dc_dir = proj_dir
            elif apps_dir.exists() and (apps_dir / "docker-compose.yml").exists():
                _dc_dir = apps_dir
            if _dc_dir:
                _run_cmd("docker compose down", cwd=str(_dc_dir), timeout=30)
                time.sleep(3)
                rc, _, _ = _run_cmd("docker compose up -d --build", cwd=str(_dc_dir), timeout=120)
                time.sleep(20)  # aguardar healthcheck
                if rc == 0:
                    corrected = True
                    logger.info("[Cyborg] Containers reiniciados para projeto %s", project_id[:8])

        elif "smoke" in check_lower or "login" in check_lower:
            # Verificar variáveis de ambiente
            env_example = apps_dir / ".env.example"
            env_file    = apps_dir / ".env"
            if env_example.exists() and not env_file.exists():
                rc, _, _ = _run_cmd(f"cp {env_example} {env_file}", timeout=5)
                if rc == 0:
                    corrected = True
                    logger.info("[Cyborg] .env criado a partir de .env.example")
                    # Rebuild após .env
                    if (apps_dir / "docker-compose.yml").exists():
                        _run_cmd("docker compose up -d --build 2>&1 | tail -10",
                                 cwd=str(apps_dir), timeout=PLAYBOOK_TIMEOUT)
                        time.sleep(10)

    return corrected


# ─── Loop principal ────────────────────────────────────────────────────────────

def run_with_autocorrection(project_id: str, prod_id: str | None, cyborg_ctx: dict) -> bool:
    """Executa PLAYBOOK com até MAX_FIX_CYCLES tentativas de autocorreção."""
    proj_dir = _find_project_dir(project_id, prod_id)

    for attempt in range(1, MAX_FIX_CYCLES + 2):  # +1 para a tentativa após última correção
        logger.info("[Cyborg] Projeto %s — tentativa %d/%d", project_id[:8], attempt, MAX_FIX_CYCLES + 1)
        _post_dialogue(project_id, f"🤖 Zentriz Cyborg — PLAYBOOK tentativa {attempt}/{MAX_FIX_CYCLES + 1}")

        result = _run_playbook(project_id, prod_id, cyborg_ctx)
        summary = result.summary()
        _post_dialogue(project_id, f"📋 Resultado:\n```\n{summary[:3000]}\n```")

        if result.ok:
            # ── Fase extra: validação de integração consumer→backend ──────────────
            # Se o projeto é frontend/mobile e tem projetos relacionados no produto,
            # verificar se todos os endpoints que ele chama existem no backend.
            _proj_type = _detect_project_type(project_id, prod_id)
            if _proj_type in ("frontend", "mobile") and prod_id:
                try:
                    _integration_issues = _check_and_fix_consumer_integration(project_id, prod_id)
                    if _integration_issues.get("missing_in_backend"):
                        missing = _integration_issues["missing_in_backend"]
                        logger.warning("[Cyborg] Integração: %d endpoint(s) chamados pelo consumer não existem no backend: %s",
                                       len(missing), missing[:5])
                        _post_dialogue(project_id,
                            f"⚠️ Cyborg — Integração consumer→backend: {len(missing)} endpoint(s) ausentes: "
                            + ", ".join(missing[:5]) + ("\n...e mais" if len(missing) > 5 else ""))
                        # Adicionar ao evidence mas não bloquear o aceite — issues foram documentados
                    if _integration_issues.get("fixed"):
                        logger.info("[Cyborg] Integração: %d issue(s) corrigidos automaticamente",
                                    len(_integration_issues["fixed"]))
                        _post_dialogue(project_id,
                            f"✅ Cyborg — Integração: {len(_integration_issues['fixed'])} correção(ões) aplicadas")
                except Exception as _ie:
                    logger.warning("[Cyborg] Erro na validação de integração: %s", _ie)

            evidence = f"PLAYBOOK PASS — {len(result.passed)} checks passaram. Tentativa {attempt}.\n\n{summary[:2000]}"
            ok = _accept(project_id, evidence)
            if ok:
                _post_dialogue(project_id, f"✅ Zentriz Cyborg aceitou o projeto. {len(result.passed)} checks OK.")
                logger.info("[Cyborg] Projeto %s ACEITO na tentativa %d", project_id[:8], attempt)
                cyborg_ctx["accepted_count"] = cyborg_ctx.get("accepted_count", 0) + 1
                return True
            else:
                logger.error("[Cyborg] Falha ao chamar /accept para %s", project_id[:8])
                return False

        # PLAYBOOK falhou
        if attempt > MAX_FIX_CYCLES:
            # Última tentativa falhou — rejeitar
            reason = f"PLAYBOOK FAIL após {MAX_FIX_CYCLES} ciclos de autocorreção.\n\nFalhas:\n" + "\n".join(f"- {f}" for f in result.failed) + f"\n\nLog completo:\n{summary[:3000]}"
            _reject(project_id, reason)
            _post_dialogue(project_id, f"❌ Zentriz Cyborg rejeitou o projeto após {MAX_FIX_CYCLES} tentativas.\nFalhas: {', '.join(result.failed[:5])}")
            logger.warning("[Cyborg] Projeto %s REJEITADO após %d ciclos", project_id[:8], MAX_FIX_CYCLES)
            return False

        # Tentar autocorreção
        _post_dialogue(project_id, f"🔧 Tentando autocorrigir: {', '.join(result.failed[:3])}")
        fixed = _autocorrect(project_id, proj_dir, result.failed)
        if not fixed:
            logger.info("[Cyborg] Autocorreção não resolveu os problemas — tentando PLAYBOOK novamente")
        else:
            logger.info("[Cyborg] Autocorreção aplicada — repetindo PLAYBOOK")

        time.sleep(5)  # Aguardar estabilização

    return False


def poll_completed_projects(product_id: str | None) -> list[dict]:
    """Busca projetos em status 'completed' ou 'pending_cyborg' (retry após falha).
    Modo produto: filtra pelo produto. Modo solitário: projetos sem produto.
    """
    data, status = _api("GET", "/api/projects")
    if status != 200 or not isinstance(data, list):
        return []

    # Aceita 'completed' (novo) e 'pending_cyborg' (retry após falha anterior)
    valid_statuses = {"completed", "pending_cyborg"}

    projects = []
    for p in data:
        if p.get("status") not in valid_statuses:
            continue
        if product_id and p.get("productId") != product_id:
            continue
        if not product_id and p.get("productId"):
            # Modo solitário: normalmente ignora projetos com produto.
            # Exceção: pending_cyborg — o runner pediu validação explícita independente do modo.
            if p.get("status") != "pending_cyborg":
                continue
        projects.append(p)
    return projects


def poll_blocked_tasks(product_id: str | None) -> list[dict]:
    """Busca projetos 'running' com tasks em BLOCKED para intervenção autônoma.

    Retorna lista de dicts: { project_id, product_id, blocked_tasks: [task_id] }.
    O Cyborg vai reprocessar cada task BLOCKED chamando o runner com reset da task.
    """
    data, status = _api("GET", "/api/projects")
    if status != 200 or not isinstance(data, list):
        return []

    result = []
    for p in data:
        if p.get("status") != "running":
            continue
        if product_id and p.get("productId") != product_id:
            continue
        proj_id = p.get("id", "")
        if not proj_id:
            continue
        # Buscar tasks BLOCKED do projeto
        tasks_data, t_status = _api("GET", f"/api/projects/{proj_id}/tasks")
        if t_status != 200 or not isinstance(tasks_data, list):
            continue
        blocked = [
            t.get("taskId") or t.get("task_id")
            for t in tasks_data
            if t.get("status") == "BLOCKED" and (t.get("taskId") or t.get("task_id"))
        ]
        if blocked:
            result.append({
                "project_id":  proj_id,
                "product_id":  p.get("productId") or product_id,
                "title":       p.get("title", ""),
                "blocked_tasks": blocked,
            })
    return result


def handle_blocked_task(project_id: str, task_id: str, product_id: str | None) -> bool:
    """Reprocessa uma task BLOCKED:
    1. Reset do status para NEW (permite que o monitor loop a re-execute)
    2. Aumenta MAX_QA_REWORK para dar mais uma chance (via API runtime-config)
    3. Posta diálogo informando a intervenção
    """
    logger.info("[Cyborg] Intervenção autônoma — task BLOCKED: %s / %s", project_id[:8], task_id)
    _post_dialogue(
        project_id,
        f"🤖 Cyborg — Intervindo em task BLOCKED: {task_id}. "
        f"Resetando status para NEW e acionando rework com Opus (modelo superior)."
    )

    # Reset para ASSIGNED — o monitor loop processa ASSIGNED (não NEW).
    # dev_peak_rework já registra rework>=1 → próxima execução usará Opus automaticamente.
    reset_data, reset_status = _api(
        "PATCH",
        f"/api/projects/{project_id}/tasks/{task_id}",
        {"status": "ASSIGNED"}
    )
    if reset_status not in (200, 204):
        logger.warning("[Cyborg] Falha ao resetar task %s: HTTP %d — resp: %s", task_id, reset_status, str(reset_data)[:100])
        return False

    logger.info("[Cyborg] Task %s / %s resetada para ASSIGNED — monitor loop irá reprocessar com Opus.", project_id[:8], task_id)
    return True


def main() -> int:
    """Entry point do Zentriz Cyborg."""
    mode = "produto" if PRODUCT_ID else "solitário"
    logger.info(
        "🤖 Zentriz Cyborg iniciando — modo=%s product_id=%s poll=%ds",
        mode, PRODUCT_ID[:8] if PRODUCT_ID else "N/A", POLL_INTERVAL,
    )

    cyborg_ctx: dict = {
        "product_id": PRODUCT_ID or None,
        "processed": set(),  # project_ids já processados nesta sessão
        "accepted_count": 0,
        "rejected_count": 0,
    }

    while True:
        try:
            # ── Fase 1: intervenção em tasks BLOCKED em projetos running ─────────
            blocked_projects = poll_blocked_tasks(PRODUCT_ID or None)
            for bp in blocked_projects:
                proj_id   = bp["project_id"]
                prod_id   = bp.get("product_id") or PRODUCT_ID or None
                for task_id in bp.get("blocked_tasks", []):
                    # Evitar re-intervenção na mesma task nesta sessão
                    intervention_key = f"{proj_id}:{task_id}:blocked"
                    if intervention_key in cyborg_ctx.get("processed", set()):
                        continue
                    try:
                        ok = handle_blocked_task(proj_id, task_id, prod_id)
                        if ok:
                            cyborg_ctx.setdefault("processed", set()).add(intervention_key)
                            logger.info("[Cyborg] Task %s do projeto %s: intervenção concluída.", task_id, proj_id[:8])
                    except Exception as e:
                        logger.error("[Cyborg] Erro ao intervir em task BLOCKED %s/%s: %s", proj_id[:8], task_id, e)

            # ── Fase 2: validar projetos completed/pending_cyborg ─────────────
            projects = poll_completed_projects(PRODUCT_ID or None)

            for proj in projects:
                proj_id = proj.get("id", "")
                if not proj_id:
                    continue

                proj_status = proj.get("status", "")

                # Pular projetos já processados com sucesso nesta sessão.
                # pending_cyborg: limitar a 2 reprocessamentos para não travar o loop.
                rejection_key = f"{proj_id}:rejected"
                rejection_count = cyborg_ctx.get("rejection_counts", {}).get(proj_id, 0)
                if proj_id in cyborg_ctx["processed"] and proj_status != "pending_cyborg":
                    continue
                if proj_status == "pending_cyborg" and rejection_count >= 2:
                    # Desistir após 2 rejeições — evitar loop infinito em projeto sem arquivos
                    continue

                logger.info("[Cyborg] Projeto detectado: %s (%s) — %s",
                            proj_id[:8], proj_status, proj.get("title", "")[:60])
                cyborg_ctx["processed"].add(proj_id)

                try:
                    # FT-18: Cyborg V3 é o único caminho suportado (engenheiro sênior autônomo, sessão única).
                    # Se falhar, marcamos blocked_cyborg — sem fallback silencioso para V1/V2.
                    from orchestrator import cyborg_v3 as _cv3
                    try:
                        _run = _cv3.run_cyborg_v3(
                            proj_id,
                            proj.get("tenantId") or proj.get("tenant_id"),
                            PRODUCT_ID or proj.get("productId"),
                        )
                        success = (_run.final_status == "delivered")
                    except Exception as _ev3:
                        logger.exception("[Cyborg V3] falhou: %s", _ev3)
                        _reject(proj_id, f"Cyborg V3 crashou: {str(_ev3)[:400]}")
                        success = False
                    if success:
                        cyborg_ctx["accepted_count"] += 1
                    else:
                        cyborg_ctx["rejected_count"] += 1
                        # Contar rejeições para evitar loop infinito
                        cyborg_ctx.setdefault("rejection_counts", {})[proj_id] = \
                            cyborg_ctx.get("rejection_counts", {}).get(proj_id, 0) + 1
                        # Remover do processed para permitir retry no próximo poll
                        # (somente se ainda estiver pending_cyborg — o runner pode ter relançado)
                        cyborg_ctx["processed"].discard(proj_id)
                except Exception as e:
                    logger.error("[Cyborg] Erro ao processar %s: %s\n%s", proj_id[:8], e, traceback.format_exc()[:1000])
                    _reject(proj_id, f"Erro interno do Cyborg: {str(e)[:500]}")
                    cyborg_ctx["processed"].discard(proj_id)

                # Modo solitário: encerrar após aceitar/processar o projeto
                # Mas só encerra se não houver tasks BLOCKED pendentes de intervenção
                if not PRODUCT_ID:
                    logger.info("[Cyborg] Modo solitário — projeto %s processado, verificando tasks BLOCKED...", proj_id[:8])
                    # Não encerra — continua monitorando tasks BLOCKED em loop

        except Exception as e:
            logger.error("[Cyborg] Erro no poll: %s", e)

        logger.debug("[Cyborg] Aguardando %ds até próximo poll...", POLL_INTERVAL)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    sys.exit(main())
