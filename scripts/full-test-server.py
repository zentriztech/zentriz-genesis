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
        else:
            self._json(404, {"error": "not found"})

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
        try:
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
