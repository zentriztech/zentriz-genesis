#!/usr/bin/env python3
"""
full-test-server.py — Micro-servidor HTTP no host para executar Claude Code Agent.

Uso: python3 scripts/full-test-server.py
     FULL_TEST_PORT=7878 CLAUDE_BIN=~/.local/bin/claude python3 scripts/full-test-server.py

Endpoints:
  POST /run-full-test   — TSK-FULL-TEST interno (pipeline Genesis)
  POST /launch-cyborg   — Cyborg externo: valida, corrige e aceita/rejeita projeto
  GET  /health          — healthcheck
"""
import http.server, json, subprocess, os, logging, threading, time, uuid
from pathlib import Path
from socketserver import ThreadingMixIn

class ThreadedHTTPServer(ThreadingMixIn, http.server.HTTPServer):
    """Servidor multi-threaded — cada request roda em thread separada."""
    daemon_threads = True

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("full-test")

CLAUDE_BIN   = os.environ.get("CLAUDE_BIN", str(Path.home() / ".local/bin/claude"))
PORT         = int(os.environ.get("FULL_TEST_PORT", "7878"))
CYBORG_DIR   = Path(__file__).parent.parent / "project" / "cyborg"

# T09/FT-17: Semaphore global compartilhado entre Cyborg e S3 static deploy.
# Limita concorrência total no host (2 vCPU no EC2 t3.large). Sem isso, um Cyborg
# de 60min + build de Vite paralelos causam OOM kill. Ajustar via env HEAVY_JOBS_MAX.
HEAVY_JOBS_MAX = int(os.environ.get("HEAVY_JOBS_MAX", "2"))
HEAVY_SEM = threading.BoundedSemaphore(HEAVY_JOBS_MAX)


def acquire_heavy_slot(kind: str, job_id: str) -> None:
    """Bloqueia até slot livre. Loga espera para debug."""
    if HEAVY_SEM.acquire(blocking=False):
        log.info(f"[SEM] acquired kind={kind} job={job_id} (immediate)")
        return
    log.warning(f"[SEM] waiting kind={kind} job={job_id} — outros jobs em execução")
    HEAVY_SEM.acquire(blocking=True)
    log.info(f"[SEM] acquired kind={kind} job={job_id} (after wait)")


def release_heavy_slot(kind: str, job_id: str) -> None:
    try:
        HEAVY_SEM.release()
        log.info(f"[SEM] released kind={kind} job={job_id}")
    except ValueError:
        log.error(f"[SEM] release without acquire kind={kind} job={job_id}")

# Mapeamento group → RUNBOOK file (derivado do prefixo do project_type)
RUNBOOK_MAP = {
    "backend":  "RUNBOOK_backend.md",
    "frontend": "RUNBOOK_frontend.md",
    "fullstack":"RUNBOOK_fullstack.md",
    "mobile":   "RUNBOOK_mobile.md",
    "infra":    "RUNBOOK_infra.md",
    "bot":      "RUNBOOK_bot.md",
    "lib":      "RUNBOOK_lib.md",
    "other":    "RUNBOOK_other.md",
    "integration": "RUNBOOK_bot.md",  # integration é do grupo bot
}


def _resolve_runbook_type(project_type: str) -> str:
    """Extrai o grupo do project_type (ex: backend_api → backend)."""
    prefix = project_type.split("_")[0] if project_type else "other"
    return RUNBOOK_MAP.get(prefix, "RUNBOOK_other.md")


def _build_cyborg_playbook(project_id: str, project_dir: str, project_type: str,
                            genesis_api_url: str, genesis_token: str, attempt: int) -> str:
    """Monta o PLAYBOOK completo: BASE + tipo + RUNBOOK.md do projeto."""
    base_path    = CYBORG_DIR / "RUNBOOK_BASE.md"
    type_file    = _resolve_runbook_type(project_type)
    type_path    = CYBORG_DIR / type_file
    # DevOps gera em docs/devops/RUNBOOK.md — também aceita project/RUNBOOK.md como alias
    _runbook_candidates = [
        Path(project_dir) / "project" / "RUNBOOK.md",
        Path(project_dir) / "docs" / "devops" / "RUNBOOK.md",
        Path(project_dir) / "docs" / "RUNBOOK.md",
    ]
    project_runbook = next((p for p in _runbook_candidates if p.exists()), _runbook_candidates[0])

    parts = []

    # Injetar variáveis de contexto no topo
    parts.append(f"""# CONTEXTO DO CYBORG

```
PROJECT_ID={project_id}
PROJECT_DIR={project_dir}
PROJECT_TYPE={project_type}
GENESIS_API_URL={genesis_api_url}
GENESIS_TOKEN={genesis_token}
ATTEMPT={attempt}
```

Use essas variáveis nos comandos curl e docker exatamente como estão acima.

---
""")

    if base_path.exists():
        parts.append(base_path.read_text(encoding="utf-8"))
        parts.append("\n\n---\n\n")

    if type_path.exists():
        parts.append(type_path.read_text(encoding="utf-8"))
        parts.append("\n\n---\n\n")
    else:
        log.warning("[CYBORG] RUNBOOK tipo não encontrado: %s", type_path)

    if project_runbook.exists():
        parts.append("# RUNBOOK DO PROJETO (gerado pelo DevOps)\n\n")
        parts.append(project_runbook.read_text(encoding="utf-8"))
    else:
        parts.append(f"# RUNBOOK DO PROJETO\n\nArquivo não encontrado em {project_runbook}. "
                     "Use o RUNBOOK_BASE e o RUNBOOK de tipo como guia.")

    return "\n".join(parts)


def _heartbeat_thread(project_id: str, genesis_api_url: str, genesis_token: str,
                      attempt: int, stop_event: threading.Event):
    """Posta 'Cyborg ainda trabalhando...' a cada 90s enquanto o processo roda."""
    interval = 90
    while not stop_event.wait(interval):
        try:
            import urllib.request
            payload = json.dumps({
                "message": f"Cyborg ainda trabalhando na tentativa {attempt}... aguarde.",
                "attempt": attempt,
            }).encode()
            req = urllib.request.Request(
                f"{genesis_api_url}/api/projects/{project_id}/cyborg-log",
                data=payload,
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {genesis_token}"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=10)
        except Exception as e:
            log.debug("[CYBORG] heartbeat falhou: %s", e)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): log.info(fmt % args)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"status": "ok", "claude": CLAUDE_BIN, "port": PORT})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/run-full-test":
            self._handle_run_full_test()
        elif self.path == "/launch-cyborg":
            self._handle_launch_cyborg()
        elif self.path == "/launch-s3-deploy":
            self._handle_launch_s3_deploy()
        elif self.path == "/cyborg-claude-code":
            self._handle_cyborg_claude_code()
        elif self.path == "/cyborg-playwright":
            self._handle_cyborg_playwright()
        elif self.path == "/cyborg-build":
            self._handle_cyborg_build()
        elif self.path == "/cyborg-engineer":
            self._handle_cyborg_engineer()
        else:
            self._json(404, {"error": "not found"})

    # ── /cyborg-build — roda pnpm install + build + tsc no cwd do projeto ─────
    def _handle_cyborg_build(self):
        """FT-18 F2: executa build real para A3 ter contexto verdadeiro (não alucinado)."""
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length).decode())
        except Exception as e:
            self._json(400, {"error": f"bad request: {e}"}); return

        project_id = payload.get("project_id", "")
        prod_id    = payload.get("prod_id", "")
        timeout    = int(payload.get("timeout", 300))

        # FT-18 fix (2026-07-03, V5 iter 1): usar canário `apps/package.json` para escolher o path certo,
        # não só existência da pasta. Ambos os paths podem existir (produto multi-projeto), mas só um tem
        # os arquivos reais.
        candidates = []
        if prod_id:
            candidates.append(f"/opt/genesis-files/{prod_id}/{project_id}")
        candidates.append(f"/opt/genesis-files/{project_id}")
        proj_dir = next(
            (c for c in candidates if Path(c).exists() and (Path(c) / "apps" / "package.json").exists()),
            None,
        )
        if not proj_dir:
            # Segundo fallback: qualquer path que exista (mesmo sem apps/package.json)
            proj_dir = next((c for c in candidates if Path(c).exists()), None)
        if not proj_dir:
            self._json(404, {"error": f"projeto não encontrado"}); return
        apps_dir = Path(proj_dir) / "apps"
        if not apps_dir.exists() or not (apps_dir / "package.json").exists():
            self._json(200, {
                "build_rc": -1, "build_output": f"sem apps/package.json em {proj_dir} — projeto não é web/next",
                "type_check_rc": -1, "type_check_output": "",
            })
            return

        # 1. pnpm install (leve — usa lockfile se existir)
        log.info(f"[cyborg-build] {project_id[:8]}: pnpm install em {apps_dir}")
        install_rc = -1; install_out = ""
        try:
            r = subprocess.run(
                "pnpm install --prefer-offline --no-frozen-lockfile 2>&1 | tail -50",
                cwd=str(apps_dir), shell=True, capture_output=True, text=True, timeout=180,
            )
            install_rc = r.returncode
            install_out = (r.stdout or "")[-1500:]
        except subprocess.TimeoutExpired:
            install_out = "TIMEOUT after 180s"

        # 2. pnpm build
        log.info(f"[cyborg-build] {project_id[:8]}: pnpm build")
        build_rc = -1; build_out = ""
        try:
            r = subprocess.run(
                "pnpm build 2>&1 | tail -80",
                cwd=str(apps_dir), shell=True, capture_output=True, text=True, timeout=timeout,
            )
            build_rc = r.returncode
            build_out = (r.stdout or "")[-3500:]
        except subprocess.TimeoutExpired:
            build_out = f"TIMEOUT after {timeout}s"

        # 3. tsc --noEmit (rápido, se disponível)
        tc_rc = -1; tc_out = ""
        try:
            r = subprocess.run(
                "npx --no-install tsc --noEmit 2>&1 | tail -30",
                cwd=str(apps_dir), shell=True, capture_output=True, text=True, timeout=60,
            )
            tc_rc = r.returncode
            tc_out = (r.stdout or "")[-2000:]
        except Exception:
            pass

        self._json(200, {
            "build_rc": build_rc,
            "build_output": build_out,
            "install_rc": install_rc,
            "install_output": install_out,
            "type_check_rc": tc_rc,
            "type_check_output": tc_out,
        })

    # ── /cyborg-engineer — spawn ONE longa sessão Claude Code (Cyborg V3) ────────
    def _handle_cyborg_engineer(self):
        """FT-18 V3: sessão única longa (30-60min) com toolset completo + wrappers no PATH.
        Streaming de stdout NÃO ao portal em tempo real (BaseHTTP não suporta bem stream),
        mas o próprio Claude pode postar via `zentriz-say`. Retorna stdout completo ao final."""
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length).decode())
        except Exception as e:
            self._json(400, {"error": f"bad request: {e}"}); return

        project_id    = payload.get("project_id", "")
        prod_id       = payload.get("prod_id", "")
        system_prompt = payload.get("system_prompt", "")
        user_prompt   = payload.get("user_prompt", "")
        model_id      = payload.get("model_id", os.environ.get("CLAUDE_MODEL", ""))
        timeout       = int(payload.get("timeout", 3600))
        cwd_hint      = payload.get("cwd_hint", "apps")

        if not project_id or not user_prompt:
            self._json(400, {"error": "project_id + user_prompt obrigatórios"}); return

        # Achar projeto com canário apps/package.json
        candidates = []
        if prod_id:
            candidates.append(f"/opt/genesis-files/{prod_id}/{project_id}")
        candidates.append(f"/opt/genesis-files/{project_id}")
        proj_dir = next(
            (c for c in candidates if Path(c).exists() and (Path(c) / "apps" / "package.json").exists()),
            None,
        )
        if not proj_dir:
            proj_dir = next((c for c in candidates if Path(c).exists()), None)
        if not proj_dir:
            self._json(404, {"error": "projeto não encontrado"}); return

        cwd = f"{proj_dir}/{cwd_hint}" if cwd_hint else proj_dir
        if not Path(cwd).exists():
            cwd = proj_dir

        # Localizar Claude CLI
        _claude_bin = CLAUDE_BIN
        if not Path(_claude_bin).exists():
            for candidate in ("/usr/bin/claude", "/usr/local/bin/claude", "/opt/claude/bin/claude"):
                if Path(candidate).exists():
                    _claude_bin = candidate
                    break

        # Preparar env: injetar PATH dos wrappers do Cyborg + tokens/URLs
        wrapper_dir = "/opt/zentriz-genesis/scripts/cyborg-wrappers"
        env = os.environ.copy()
        env["PATH"] = f"{wrapper_dir}:{env.get('PATH', '/usr/local/bin:/usr/bin:/bin')}"
        env["PROJECT_ID"] = project_id
        env["PROD_ID"] = prod_id or ""
        # API_BASE_URL do FTS aponta pra container api — Cyborg V3 (que roda no HOST) precisa da URL pública
        env["API_BASE_URL"] = env.get("CYBORG_HOST_API_URL", "http://localhost:3000")
        # GENESIS_API_TOKEN já deve estar no env do FTS (setado via systemd)
        if not env.get("GENESIS_API_TOKEN"):
            # tentar ler do .env
            try:
                with open("/opt/zentriz-genesis/.env") as f:
                    for line in f:
                        if line.startswith("GENESIS_API_TOKEN="):
                            env["GENESIS_API_TOKEN"] = line.split("=", 1)[1].strip()
                            break
            except Exception:
                pass
        if model_id:
            env["CLAUDE_MODEL"] = model_id
            env["ANTHROPIC_MODEL"] = model_id
        # CLAUDE_CODE_USE_BEDROCK já deve estar setado — Cyborg V3 usa Bedrock

        log.info(f"[cyborg-engineer] {project_id[:8]}: sessão longa iniciada. cwd={cwd} model={model_id} timeout={timeout}s")

        # Executar Claude Code com system prompt + user prompt via stdin
        cmd = [_claude_bin, "--dangerously-skip-permissions", "-p"]
        if system_prompt:
            cmd.extend(["--append-system-prompt", system_prompt])

        t0 = time.time()
        try:
            r = subprocess.run(cmd, cwd=cwd, env=env, input=user_prompt,
                              capture_output=True, text=True, timeout=timeout)
            claude_stdout = r.stdout or ""
            claude_stderr = r.stderr or ""
            claude_rc = r.returncode
        except subprocess.TimeoutExpired:
            self._json(408, {"ok": False, "error": f"timeout {timeout}s", "stdout": "", "stderr": ""})
            return
        except Exception as e:
            import traceback
            log.error(f"[cyborg-engineer] {project_id[:8]}: subprocess exception: {e}\n{traceback.format_exc()}")
            self._json(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})
            return

        duration_s = int(time.time() - t0)
        log.info(f"[cyborg-engineer] {project_id[:8]}: concluído em {duration_s}s (rc={claude_rc}, stdout={len(claude_stdout)} chars)")

        self._json(200, {
            "ok": True,
            "stdout": claude_stdout,
            "stderr": claude_stderr[-4000:],
            "rc": claude_rc,
            "duration_s": duration_s,
        })

    # ── /cyborg-claude-code — spawn Claude Code CLI para aplicar 1 ação do Cyborg ─
    def _handle_cyborg_claude_code(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length).decode())
        except Exception as e:
            self._json(400, {"error": f"bad request: {e}"}); return

        project_id      = payload.get("project_id", "")
        prod_id         = payload.get("prod_id", "")
        action_id       = payload.get("action_id", "unknown")
        prompt          = payload.get("prompt", "")
        system_prompt   = payload.get("system_prompt", "")  # FT-18 F1: filosofia anti-refactor
        model_id        = payload.get("model_id", os.environ.get("CLAUDE_MODEL", ""))
        timeout         = int(payload.get("timeout", 900))
        verify_cmd      = payload.get("verify_command", "")

        if not project_id or not prompt:
            self._json(400, {"error": "project_id + prompt obrigatórios"}); return

        # Localizar cwd (com/sem prod_id)
        candidates = []
        if prod_id:
            candidates.append(f"/opt/genesis-files/{prod_id}/{project_id}")
        candidates.append(f"/opt/genesis-files/{project_id}")
        cwd = next((c for c in candidates if Path(c).exists()), None)
        if not cwd:
            self._json(404, {"error": f"projeto não encontrado: {candidates}"}); return

        # Escreve prompt em arquivo temporário (evita command line gigante)
        prompt_file = Path(f"/tmp/cyborg-{project_id[:8]}-{action_id}.md")
        prompt_file.write_text(prompt, encoding="utf-8")

        # Executa Claude Code CLI com model_id override
        env = os.environ.copy()
        if model_id:
            env["CLAUDE_MODEL"] = model_id
            env["ANTHROPIC_MODEL"] = model_id
        # FT-18 fix (2026-07-02): CLAUDE_BIN precisa apontar para binário real.
        # Default do módulo era ~/.local/bin/claude (root não tem); host usa /usr/bin/claude.
        _claude_bin = CLAUDE_BIN
        if not Path(_claude_bin).exists():
            for candidate in ("/usr/bin/claude", "/usr/local/bin/claude", "/opt/claude/bin/claude"):
                if Path(candidate).exists():
                    _claude_bin = candidate
                    break
            else:
                # Não achou nenhum — reporta erro claro pro Cyborg
                self._json(500, {
                    "action_id": action_id, "status": "FAILED",
                    "error": f"Claude CLI não encontrado. Tentado: {CLAUDE_BIN} + /usr/bin/claude + /usr/local/bin/claude. "
                             "Defina CLAUDE_BIN=<path> no genesis-fts.service.",
                })
                return

        # FT-18 F8: snapshot antes das mudanças — usado depois para detectar refator suspeito.
        # Estratégia sem git: hash + tamanho de cada arquivo dentro de apps/src/. Se após execução
        # mais de N arquivos mudaram, marca refactor suspect (mesmo que verify_command passe).
        def _snapshot_apps(d: str) -> dict:
            snap = {}
            root = Path(d) / "apps" / "src"
            if not root.exists():
                return snap
            for p in root.rglob("*"):
                if p.is_file() and p.stat().st_size < 500_000:  # ignora binários grandes
                    try:
                        st = p.stat()
                        snap[str(p.relative_to(root))] = (st.st_size, st.st_mtime_ns)
                    except Exception:
                        pass
            return snap
        snap_before = _snapshot_apps(cwd)

        # Claude Code CLI: passar o prompt inline via stdin (evita bugs de @-file em algumas versões).
        # -p ativa modo print (headless, one-shot). Lê stdin quando não há argumento.
        # FT-18 F1: se system_prompt fornecido, passa via --append-system-prompt (filosofia anti-refactor)
        cmd = [_claude_bin, "--dangerously-skip-permissions", "-p"]
        if system_prompt:
            cmd.extend(["--append-system-prompt", system_prompt])
            log.info(f"[cyborg-cc] {action_id}: system_prompt injetado ({len(system_prompt)} chars)")
        prompt_text = prompt_file.read_text(encoding="utf-8")
        log.info(f"[cyborg-cc] {action_id}: cwd={cwd} model={model_id or 'default'} bin={_claude_bin} timeout={timeout}s")
        t0 = time.time()
        try:
            r = subprocess.run(cmd, cwd=cwd, env=env, input=prompt_text,
                              capture_output=True, text=True, timeout=timeout)
            claude_stdout = (r.stdout or "")[-8000:]
            claude_stderr = (r.stderr or "")[-2000:]
            claude_rc     = r.returncode
        except subprocess.TimeoutExpired:
            self._json(408, {"action_id": action_id, "status": "FAILED", "error": f"timeout {timeout}s"})
            return
        except Exception as e:
            import traceback
            log.error(f"[cyborg-cc] {action_id}: subprocess exception: {e}\n{traceback.format_exc()}")
            self._json(500, {"action_id": action_id, "status": "FAILED", "error": f"{type(e).__name__}: {e}"})
            return

        # Roda verify_command
        verify_output = ""
        verify_rc = -1
        if verify_cmd:
            try:
                vr = subprocess.run(verify_cmd, cwd=cwd, shell=True, capture_output=True,
                                    text=True, timeout=60)
                verify_output = ((vr.stdout or "") + "\n" + (vr.stderr or ""))[-2000:]
                verify_rc = vr.returncode
            except Exception as e:
                verify_output = f"verify error: {e}"

        # Parse Claude output para achar CYBORG_ACTION_RESULT
        status = "PARTIAL"
        for line in claude_stdout.splitlines()[::-1]:
            if line.startswith("STATUS:"):
                v = line.split(":", 1)[1].strip()
                if v in ("SUCCESS", "FAILED", "PARTIAL"):
                    status = v
                    break

        # Se verify_command foi executado e falhou → override para FAILED
        if verify_cmd and verify_rc != 0:
            status = "FAILED"

        # FT-18 F8: guardrail mecânico anti-refactor.
        # Se o snapshot mostra que Claude tocou muitos arquivos ou criou novas pastas
        # (típico de refatoração arquitetural), degradar status para REFACTOR_SUSPECT.
        # O Cyborg V2 vai interpretar como FAILED e não aplicar mudanças na próxima iter.
        snap_after = _snapshot_apps(cwd)
        added = [k for k in snap_after if k not in snap_before]
        removed = [k for k in snap_before if k not in snap_after]
        modified = [k for k in snap_after if k in snap_before and snap_after[k] != snap_before[k]]
        total_changed = len(added) + len(removed) + len(modified)
        # FT-18 fix (2026-07-03): threshold aumentado. Correções legítimas de conteúdo institucional
        # (§11 spec em /sobre + /privacidade + /termos) tocam 3-4 arquivos. Só suspeitar >10.
        # Também: só suspeitar de PASTAS NOVAS (indicativo de reorganização estrutural).
        REFACTOR_THRESHOLD_FILES = 10   # antes 5 — muito restritivo, falso-positivo em correção de 3 páginas
        refactor_suspect = False
        if total_changed > REFACTOR_THRESHOLD_FILES and status == "SUCCESS":
            refactor_suspect = True
            status = "FAILED"
            log.warning(
                f"[cyborg-cc] {action_id}: REFACTOR_SUSPECT — {total_changed} arquivos mudaram "
                f"(+{len(added)} novos, -{len(removed)} removidos, ~{len(modified)} modificados). "
                f"Threshold: {REFACTOR_THRESHOLD_FILES}. Ação: FAILED forçado."
            )
        # Pastas criadas novas indicam refactor arquitetural (route groups, novos dirs)
        new_dirs = set()
        for a in added:
            parts = a.split("/")
            if len(parts) > 1:
                new_dir = parts[0]
                # Só é 'novo' se a pasta não existia antes
                if not any(k.startswith(new_dir + "/") for k in snap_before):
                    new_dirs.add(new_dir)
        if new_dirs and status == "SUCCESS":
            refactor_suspect = True
            status = "FAILED"
            log.warning(
                f"[cyborg-cc] {action_id}: REFACTOR_SUSPECT — pastas novas criadas: {sorted(new_dirs)}. "
                f"Ações cirúrgicas não criam route groups nem reorganizam estrutura. FAILED forçado."
            )

        self._json(200, {
            "action_id": action_id,
            "status": status,
            "refactor_suspect": refactor_suspect,
            "files_changed": total_changed,
            "files_added": added[:20],
            "files_removed": removed[:20],
            "duration_s": int(time.time() - t0),
            "claude_rc": claude_rc,
            "claude_stdout_tail": claude_stdout[-2000:],
            "claude_stderr_tail": claude_stderr,
            "verify_command": verify_cmd,
            "verify_rc": verify_rc,
            "verify_output": verify_output,
        })

    # ── /cyborg-playwright — screenshot + smoke navegacional ──────────────────
    def _handle_cyborg_playwright(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length).decode())
        except Exception as e:
            self._json(400, {"error": f"bad request: {e}"}); return

        base_url  = payload.get("base_url", "")
        routes    = payload.get("routes", ["/"])
        out_dir   = payload.get("out_dir", f"/tmp/cyborg-shots-{int(time.time())}")
        if not base_url:
            self._json(400, {"error": "base_url obrigatório"}); return

        try:
            Path(out_dir).mkdir(parents=True, exist_ok=True)
            # Delega para script Python que chama playwright headless (se instalado)
            script = f"""
import sys, json
from playwright.sync_api import sync_playwright
results = []
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={{"width":1280,"height":800}})
    page = ctx.new_page()
    console_errors = []
    page.on("console", lambda msg: console_errors.append(msg.text) if msg.type=="error" else None)
    for route in {routes!r}:
        url = {base_url!r} + route
        try:
            resp = page.goto(url, wait_until="networkidle", timeout=15000)
            title = page.title()
            shot = "{out_dir}" + "/" + route.replace("/","_or_") + ".png"
            page.screenshot(path=shot, full_page=True)
            results.append({{"route": route, "url": url, "status": resp.status if resp else 0, "title": title, "shot": shot}})
        except Exception as e:
            results.append({{"route": route, "url": url, "error": str(e)}})
    b.close()
print(json.dumps({{"results": results, "console_errors": console_errors[-30:]}}))
"""
            r = subprocess.run(["python3", "-c", script], capture_output=True, text=True, timeout=120)
            if r.returncode != 0:
                self._json(500, {"error": f"playwright fail: {r.stderr[-1000:]}"}); return
            self._json(200, json.loads(r.stdout))
        except Exception as e:
            self._json(500, {"error": f"cyborg-playwright: {e}"})

    # ── /launch-s3-deploy (FT-17) ─────────────────────────────────────────────
    def _handle_launch_s3_deploy(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length).decode())
        except Exception as e:
            self._json(400, {"error": f"bad request: {e}"}); return

        required = ["project_id", "project_dir", "deployment_id", "bucket_name",
                    "deployment_type", "genesis_api_url", "genesis_token",
                    "aws_s3_access_key_id", "aws_s3_secret_access_key"]
        missing = [k for k in required if not payload.get(k)]
        if missing:
            self._json(400, {"error": f"missing fields: {missing}"}); return

        deployment_id = payload["deployment_id"]
        job_id = deployment_id[:8]

        # Roda em thread (com semáforo)
        def _worker():
            acquire_heavy_slot("s3-deploy", job_id)
            try:
                # Import lazy — evita carregar módulo se rota nunca é chamada
                from pathlib import Path as _P
                import sys as _sys
                _sys.path.insert(0, str(_P(__file__).parent))
                from s3_deploy_runner import run_s3_deploy
                run_s3_deploy(payload)
            except Exception as e:
                log.exception(f"[s3-deploy] {job_id} crashed: {e}")
            finally:
                release_heavy_slot("s3-deploy", job_id)

        t = threading.Thread(target=_worker, name=f"s3-deploy-{job_id}", daemon=True)
        t.start()

        self._json(202, {"ok": True, "job_id": job_id, "deployment_id": deployment_id})

    # ── /run-full-test (pipeline interno) ─────────────────────────────────────

    def _handle_run_full_test(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode())
        except Exception as e:
            self._json(400, {"error": f"bad request: {e}"}); return

        project_id   = body.get("project_id", "")
        project_path = body.get("project_path", "")
        prompt_path  = body.get("prompt_path", "")
        api_key      = body.get("api_key", "")

        if not project_path or not Path(project_path).exists():
            self._json(400, {"error": f"project_path not found: {project_path}"}); return

        apps_path = Path(project_path) / "apps"
        if not apps_path.exists():
            apps_path = Path(project_path)

        if prompt_path and Path(prompt_path).exists():
            prompt = Path(prompt_path).read_text(encoding="utf-8")
        else:
            prompt = (
                f"# TASK-FULL-TEST — Validação E2E e Correção Final\n\n"
                f"Projeto em: {project_path}\n"
                f"Apps em: {apps_path}\n\n"
                f"## REGRA FUNDAMENTAL\n"
                f"Esta task tem 4 fases obrigatórias em sequência. Corrija cada bug IMEDIATAMENTE antes de avançar.\n\n"
                f"## FASE 1 — Build e TypeScript (BLOCKER)\n"
                f"```bash\n"
                f"cd {apps_path}\n"
                f"npm install --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -3\n"
                f"npm run build 2>&1 | tail -30\n"
                f"```\n"
                f"Corrija TODOS os erros TypeScript antes de continuar.\n\n"
                f"## FASE 2 — Varredura preventiva de query params e hrefs (BLOCKER)\n\n"
                f"### 2a. Query params incorretos\n"
                f"```bash\n"
                f"grep -rn 'perPage' {apps_path}/src/lib/ {apps_path}/src/hooks/ {apps_path}/src/components/\n"
                f"grep -rn \"sort.*'\" {apps_path}/src/lib/ {apps_path}/src/hooks/ {apps_path}/src/components/ | grep -v 'createdAt\\|stockLevel\\|price\\|name'\n"
                f"```\n"
                f"Se encontrar 'perPage': substituir por 'limit' em todos os arquivos.\n"
                f"Se encontrar sort com valor inventado (ex: 'newest', 'popular', 'recent'):\n"
                f"  verificar o enum real no backend: grep -n 'z.enum\\|sort.*enum' <backend>/apps/src/http/schemas/*.schema.ts\n"
                f"  substituir pelo valor correto do enum.\n\n"
                f"### 2b. Hrefs sem page.tsx\n"
                f"```bash\n"
                f"grep -rh 'href=\"/' {apps_path}/src/components/layout/ | grep -oE '\"(/[^\"?#]+)\"' | sort -u\n"
                f"find {apps_path}/src/app -name 'page.tsx' | sed 's|{apps_path}/src/app||' | sed 's|/page.tsx||' | sort\n"
                f"```\n"
                f"Para cada href sem page.tsx correspondente: criar página stub com Header + Footer + título.\n\n"
                f"## FASE 3 — Integração real com backend\n"
                f"Execute project/start.sh e confirme que o servidor sobe.\n"
                f"Login: POST /api/auth/login com application/json, extrair accessToken.\n\n"
                f"### 3a. LEI DOS LOGS — OBRIGATÓRIA ANTES DE DECLARAR QUALQUER ERRO\n"
                f"Antes de declarar qualquer endpoint como 'offline' ou 'com erro', SEMPRE ler os logs:\n"
                f"```bash\n"
                f"# Ver logs de TODOS os containers do produto\n"
                f"docker logs <container_name> 2>&1 | tail -30\n"
                f"# Verificar status real dos containers\n"
                f"docker ps --format '{{{{.Names}}}}\\t{{{{.Status}}}}\\t{{{{.Ports}}}}' | grep <product_slug>\n"
                f"```\n"
                f"Logs revelam: JWT inválido, porta errada, DB indisponível, rota 404, CORS error.\n"
                f"Nunca assumir que um serviço está offline sem confirmar nos logs.\n\n"
                f"### 3b. Verificar TODOS os endpoints das libs\n"
                f"```bash\n"
                f"# Extrair e testar cada rota de src/lib/api/*.ts\n"
                f"grep -rh '\\.(get|post|patch|delete)(' src/lib/api/ | grep -oE \"'[^']+'\"\n"
                f"```\n"
                f"Para cada rota, fazer curl com o token real e verificar HTTP 200.\n"
                f"ATENÇÃO: se o projeto usa createApiClient que adiciona /api/ ao baseURL,\n"
                f"as rotas nas libs NÃO devem ter /api/ prefix (duplicaria: /api/api/cte = 404).\n"
                f"Corrigir: 404 (rota errada/prefix duplicado), 415 (Content-Type), 400 (param errado), CORS.\n"
                f"Testar ao menos 1 POST/PATCH/DELETE por domínio.\n\n"
                f"## FASE 4 — Relatório\n"
                f"Grave {project_path}/docs/qa/QA_REPORT_TSK-FULL-TEST.md com:\n"
                f"- Logs lidos de todos os containers (LEI DOS LOGS)\n"
                f"- Query params verificados (perPage→limit, sort enum)\n"
                f"- Hrefs verificados vs pages existentes\n"
                f"- Endpoints testados com HTTP status real (não assumido)\n"
                f"- Bugs corrigidos (incluindo prefix /api/ duplicado)\n"
                f"APROVADO só se: build limpo + params corretos + todos hrefs têm page + todos endpoints 200 (verificado com curl real).\n\n"
                f"Execute sem pedir confirmação."
            )

        log.info("TASK-FULL-TEST iniciada: project=%s", project_id)
        wrapper_prompt = f"Você está em: {apps_path}\nDiretório de projeto: {project_path}\n\n{prompt}"

        subprocess_env = os.environ.copy()
        if api_key:
            subprocess_env["ANTHROPIC_API_KEY"] = api_key
            subprocess_env["CLAUDE_API_KEY"]     = api_key
            log.info("[FT-13] api_key injetada no subprocess claude (len=%d)", len(api_key))

        try:
            result = subprocess.run(
                [CLAUDE_BIN, "--print", "--dangerously-skip-permissions", wrapper_prompt],
                capture_output=True, text=True, timeout=3600, cwd=str(apps_path),
                env=subprocess_env,
            )
            output   = (result.stdout or "") + (result.stderr or "")
            approved = any(w in output.upper() for w in
                           ["APROVADO", "ALL CHECKS", "QA_PASS", "PASSED", "ALL PASS",
                            "STATUS FINAL: APROVADO", "✅ APROVADO", "APPROVED"])
            log.info("Concluída: approved=%s rc=%d len=%d", approved, result.returncode, len(output))
            out_excerpt = output[:8000] + "\n...\n" + output[-4000:] if len(output) > 12000 else output
            self._json(200, {"status": "ok", "output": out_excerpt,
                             "approved": approved, "returncode": result.returncode})
        except subprocess.TimeoutExpired:
            self._json(200, {"status": "timeout", "output": "Timeout após 3600s", "approved": False})
        except FileNotFoundError:
            self._json(500, {"status": "error",
                             "output": f"claude CLI não encontrado: {CLAUDE_BIN}", "approved": False})
        except Exception as e:
            self._json(500, {"status": "error", "output": str(e), "approved": False})

    # ── /launch-cyborg (validação externa autônoma) ────────────────────────────

    def _handle_launch_cyborg(self):
        # FT-18: endpoint legacy (V1). Substituído por Cyborg V3 (watcher zentriz_cyborg.py + /cyborg-engineer).
        # Devolvemos 410 GONE para qualquer chamador residual — não relançamos o playbook antigo.
        log.info("[launch-cyborg] chamada legacy ignorada (Cyborg V3 é o único caminho ativo)")
        self._json(410, {
            "error": "endpoint deprecated",
            "message": "Cyborg V1 (/launch-cyborg) foi substituído pelo Cyborg V3 (watcher orchestrator/zentriz_cyborg.py + /cyborg-engineer).",
            "gone": True,
        })
        return
        # Código legacy abaixo mantido só para referência do playbook — nunca é executado.
        try:  # noqa: E722
            length = int(self.headers.get("Content-Length", 0))
            body   = json.loads(self.rfile.read(length).decode())
        except Exception as e:
            self._json(400, {"error": f"bad request: {e}"}); return

        project_id      = body.get("project_id", "")
        project_dir     = body.get("project_dir", "")
        project_type    = body.get("project_type", "other")
        genesis_api_url = body.get("genesis_api_url", "http://localhost:3000")
        genesis_token   = body.get("genesis_token", "")
        attempt         = int(body.get("attempt", 1))
        api_key         = body.get("api_key", "")

        if not project_id:
            self._json(400, {"error": "project_id é obrigatório"}); return
        if not project_dir or not Path(project_dir).exists():
            self._json(400, {"error": f"project_dir não encontrado: {project_dir}"}); return
        if not genesis_token:
            self._json(400, {"error": "genesis_token é obrigatório"}); return

        job_id  = str(uuid.uuid4())[:8]
        playbook = _build_cyborg_playbook(
            project_id, project_dir, project_type, genesis_api_url, genesis_token, attempt
        )

        log.info("[CYBORG] job=%s project=%s type=%s attempt=%d", job_id, project_id, project_type, attempt)

        # Responde imediatamente com job_id — processo roda em background
        self._json(202, {"ok": True, "job_id": job_id, "attempt": attempt})

        # Spawna o Cyborg em thread separada para não bloquear o servidor
        t = threading.Thread(
            target=self._run_cyborg,
            args=(job_id, project_id, project_dir, project_type,
                  genesis_api_url, genesis_token, attempt, playbook, api_key),
            daemon=True,
        )
        t.start()

    def _run_cyborg(self, job_id: str, project_id: str, project_dir: str, project_type: str,
                    genesis_api_url: str, genesis_token: str, attempt: int,
                    playbook: str, api_key: str):
        """Executa o processo claude do Cyborg e posta resultado na API."""

        def post_log(msg: str):
            try:
                import urllib.request
                payload = json.dumps({"message": msg, "attempt": attempt}).encode()
                req = urllib.request.Request(
                    f"{genesis_api_url}/api/projects/{project_id}/cyborg-log",
                    data=payload,
                    headers={"Content-Type": "application/json",
                             "Authorization": f"Bearer {genesis_token}"},
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=10)
            except Exception as e:
                log.debug("[CYBORG] post_log falhou: %s", e)

        post_log(f"Cyborg iniciado — tentativa {attempt}/5. Tipo: {project_type}. Lendo RUNBOOK...")

        subprocess_env = os.environ.copy()
        if api_key:
            subprocess_env["ANTHROPIC_API_KEY"] = api_key
            subprocess_env["CLAUDE_API_KEY"]     = api_key
        # Injetar variáveis para que o claude process as acesse via env
        subprocess_env["PROJECT_ID"]       = project_id
        subprocess_env["PROJECT_DIR"]      = project_dir
        subprocess_env["PROJECT_TYPE"]     = project_type
        subprocess_env["GENESIS_API_URL"]  = genesis_api_url
        subprocess_env["GENESIS_TOKEN"]    = genesis_token
        subprocess_env["ATTEMPT"]          = str(attempt)

        # Heartbeat: posta a cada 90s enquanto claude roda
        stop_heartbeat = threading.Event()
        hb = threading.Thread(
            target=_heartbeat_thread,
            args=(project_id, genesis_api_url, genesis_token, attempt, stop_heartbeat),
            daemon=True,
        )
        hb.start()

        accepted = False
        rejected = False
        output   = ""
        try:
            result = subprocess.run(
                [CLAUDE_BIN, "--print", "--dangerously-skip-permissions", playbook],
                capture_output=True, text=True, timeout=3600,
                cwd=project_dir, env=subprocess_env,
            )
            output = (result.stdout or "") + (result.stderr or "")
            log.info("[CYBORG] job=%s rc=%d len=%d", job_id, result.returncode, len(output))

            accepted = any(w in output.upper() for w in
                           ["APROVADO", "ACCEPTED", "ACCEPT", "✅", "PASS", "CYBORG_PASS"])
            rejected = any(w in output.upper() for w in
                           ["REJEITADO", "REJECTED", "REJECT", "FAIL", "CYBORG_FAIL", "❌"])

        except subprocess.TimeoutExpired:
            log.error("[CYBORG] job=%s timeout", job_id)
            rejected = True
            output   = "TIMEOUT"
        except FileNotFoundError:
            log.error("[CYBORG] claude CLI não encontrado: %s", CLAUDE_BIN)
            rejected = True
            output   = f"CLAUDE_NOT_FOUND: {CLAUDE_BIN}"
        except Exception as e:
            log.error("[CYBORG] job=%s erro: %s", job_id, e)
            rejected = True
            output   = str(e)
        finally:
            # Para o heartbeat ANTES de postar o log final — evita mensagem
            # "ainda trabalhando" aparecer depois do veredicto
            stop_heartbeat.set()

        # Log final limpo — sem JSON raw, sem output bruto
        if accepted:
            post_log(f"✅ Cyborg tentativa {attempt} concluída: PASS — projeto aceito.")
        elif rejected:
            # Extrair apenas a última linha significativa do output para o motivo
            lines = [l.strip() for l in output.splitlines() if l.strip() and not l.strip().startswith("{")]
            motivo = lines[-1][:200] if lines else output[:200]
            post_log(f"❌ Cyborg tentativa {attempt} concluída: FAIL — {motivo}")
        else:
            post_log(f"⚠️ Cyborg tentativa {attempt} inconclusiva — nenhum veredicto detectado no output.")

    # ── helpers ────────────────────────────────────────────────────────────────

    def _json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = ThreadedHTTPServer(("0.0.0.0", PORT), Handler)
    log.info("full-test-server ouvindo em http://0.0.0.0:%d", PORT)
    log.info("Claude CLI: %s", CLAUDE_BIN)
    log.info("CYBORG RUNBOOKs em: %s", CYBORG_DIR)
    log.info("Ctrl+C para encerrar")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Encerrado.")
