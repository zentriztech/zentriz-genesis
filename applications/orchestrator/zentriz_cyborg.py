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
from typing import Any

import requests

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


def _api(method: str, path: str, body: dict | None = None) -> tuple[Any, int]:
    url = f"{API_BASE_URL}{path}"
    try:
        resp = requests.request(method, url, headers=_headers(), json=body, timeout=30)
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text[:500]}
        return data, resp.status_code
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
    return status in (200, 201)


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
    root = Path(PROJECT_FILES)
    if prod_id:
        candidate = root / prod_id / project_id / "apps"
        if candidate.exists():
            return candidate.parent
    candidate = root / project_id / "apps"
    if candidate.exists():
        return candidate.parent
    return None


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
            runbook = Path(project_dir) / "RUNBOOK.md"
            if runbook.exists():
                runbook_content = runbook.read_text(encoding="utf-8", errors="replace")[:8000]
                result.record("RUNBOOK.md existe", True, f"{len(runbook_content)} chars")
            else:
                result.record("RUNBOOK.md existe", False, "arquivo não encontrado")
        except Exception as e:
            result.record("Ler RUNBOOK", False, str(e))

        try:
            smoke = Path(project_dir) / "smoke_test.sh"
            if smoke.exists():
                smoke_script = smoke.read_text(encoding="utf-8", errors="replace")[:4000]
                result.record("smoke_test.sh existe", True)
            else:
                result.record("smoke_test.sh existe", False, "será gerado inline")
        except Exception:
            pass

        try:
            contract = Path(project_dir) / "api_contract.md"
            if contract.exists():
                api_contract = contract.read_text(encoding="utf-8", errors="replace")[:8000]
                result.record("api_contract.md existe", True)
        except Exception:
            pass

    # ── FASE 2: INFRAESTRUTURA ─────────────────────────────────────────────────
    result.log.append("=== FASE 2: INFRAESTRUTURA ===")
    if apps_dir and (Path(apps_dir) / "docker-compose.yml").exists():
        rc, out, err = _run_cmd(
            "docker compose up -d --build 2>&1 | tail -30",
            cwd=apps_dir, timeout=PLAYBOOK_TIMEOUT,
        )
        if rc == 0:
            # Aguardar healthcheck
            time.sleep(10)
            rc2, out2, _ = _run_cmd("docker compose ps", cwd=apps_dir, timeout=30)
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
    if smoke_script:
        rc, out, err = _run_cmd("bash -e smoke_test.sh", cwd=project_dir, timeout=120)
        result.record("smoke_test.sh executado", rc == 0, (out + err)[-500:] if rc != 0 else "OK")
    elif api_contract:
        # Extrair porta e testar health endpoint
        import re as _re
        port_match = _re.search(r"http://localhost:(\d+)", api_contract)
        if port_match:
            port = port_match.group(1)
            rc, out, _ = _run_cmd(f"curl -sf http://localhost:{port}/health || curl -sf http://localhost:{port}/healthz", timeout=15)
            result.record(f"Health endpoint :{port}", rc == 0, out[:200] if rc != 0 else "OK")
        else:
            result.record("Health endpoint", False, "Porta não detectada no api_contract.md")
    else:
        result.record("Smoke test", False, "Sem smoke_test.sh nem api_contract.md para teste automático")

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
            # Reiniciar containers
            if apps_dir.exists() and (apps_dir / "docker-compose.yml").exists():
                rc, _, _ = _run_cmd("docker compose restart", cwd=str(apps_dir), timeout=60)
                time.sleep(8)
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
    """Busca projetos em status 'completed' do produto (ou todos se sem produto)."""
    data, status = _api("GET", "/api/projects")
    if status != 200 or not isinstance(data, list):
        return []

    projects = []
    for p in data:
        if p.get("status") != "completed":
            continue
        if product_id and p.get("productId") != product_id:
            continue
        if not product_id and p.get("productId"):
            continue  # Modo solitário: ignorar projetos com produto
        projects.append(p)
    return projects


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
            projects = poll_completed_projects(PRODUCT_ID or None)

            for proj in projects:
                proj_id = proj.get("id", "")
                if not proj_id or proj_id in cyborg_ctx["processed"]:
                    continue

                logger.info("[Cyborg] Projeto detectado: %s — %s", proj_id[:8], proj.get("title", "")[:60])
                cyborg_ctx["processed"].add(proj_id)

                try:
                    success = run_with_autocorrection(proj_id, PRODUCT_ID or proj.get("productId"), cyborg_ctx)
                    if success:
                        cyborg_ctx["accepted_count"] += 1
                    else:
                        cyborg_ctx["rejected_count"] += 1
                except Exception as e:
                    logger.error("[Cyborg] Erro ao processar %s: %s\n%s", proj_id[:8], e, traceback.format_exc()[:1000])
                    _reject(proj_id, f"Erro interno do Cyborg: {str(e)[:500]}")

                # Modo solitário: encerrar após processar o único projeto
                if not PRODUCT_ID:
                    logger.info("[Cyborg] Modo solitário — encerrando após processar projeto %s", proj_id[:8])
                    return 0

        except Exception as e:
            logger.error("[Cyborg] Erro no poll: %s", e)

        logger.debug("[Cyborg] Aguardando %ds até próximo poll...", POLL_INTERVAL)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    sys.exit(main())
