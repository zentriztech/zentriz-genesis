#!/usr/bin/env python3
"""
full-test-server.py — Micro-servidor HTTP no host para executar Claude Code Agent.

Uso: python3 scripts/full-test-server.py
     FULL_TEST_PORT=7878 CLAUDE_BIN=~/.local/bin/claude python3 scripts/full-test-server.py

Endpoint: POST http://host.docker.internal:7878/run-full-test
  Body: { "project_id": "uuid", "project_path": "/path", "prompt_path": "/path/to/prompt.md" }
  Returns: { "status": "ok", "output": "...", "approved": true/false }
"""
import http.server, json, subprocess, os, logging
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("full-test")

CLAUDE_BIN = os.environ.get("CLAUDE_BIN", str(Path.home() / ".local/bin/claude"))
PORT       = int(os.environ.get("FULL_TEST_PORT", "7878"))


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): log.info(fmt % args)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"status": "ok", "claude": CLAUDE_BIN, "port": PORT})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/run-full-test":
            self._json(404, {"error": "not found"}); return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode())
        except Exception as e:
            self._json(400, {"error": f"bad request: {e}"}); return

        project_id   = body.get("project_id", "")
        project_path = body.get("project_path", "")
        prompt_path  = body.get("prompt_path", "")

        if not project_path or not Path(project_path).exists():
            self._json(400, {"error": f"project_path not found: {project_path}"}); return

        apps_path = Path(project_path) / "apps"
        if not apps_path.exists():
            apps_path = Path(project_path)

        if prompt_path and Path(prompt_path).exists():
            prompt = Path(prompt_path).read_text(encoding="utf-8")
        else:
            prompt = (
                f"TASK-FULL-TEST no projeto em {apps_path}.\n\n"
                f"1. cd {apps_path} && npm install --legacy-peer-deps 2>&1 | tail -5\n"
                f"2. npx tsc --noEmit 2>&1 — corrija TODOS os erros TypeScript encontrados\n"
                f"3. Verifique que project/start.sh e docker-compose.yml existem e estão corretos\n"
                f"4. Grave relatório em {project_path}/docs/qa/QA_REPORT_TSK-FULL-TEST.md\n"
                f"   com: issues encontradas, correções aplicadas, status final\n"
                f"5. Termine com APROVADO (se tudo OK) ou ISSUES ENCONTRADAS (lista do que ficou)\n\n"
                f"Execute sem pedir confirmação."
            )

        log.info("TASK-FULL-TEST iniciada: project=%s", project_id)
        try:
            result = subprocess.run(
                [CLAUDE_BIN, "--print", "--dangerously-skip-permissions",
                 f"--cwd={apps_path}", prompt],
                capture_output=True, text=True, timeout=600, cwd=str(apps_path),
            )
            output   = (result.stdout or "") + (result.stderr or "")
            approved = any(w in output.upper() for w in
                           ["APROVADO", "ALL CHECKS", "QA_PASS", "PASSED", "ALL PASS"])
            log.info("Concluída: approved=%s rc=%d", approved, result.returncode)
            self._json(200, {"status": "ok", "output": output[:12000],
                             "approved": approved, "returncode": result.returncode})
        except subprocess.TimeoutExpired:
            self._json(200, {"status": "timeout", "output": "Timeout após 600s", "approved": False})
        except FileNotFoundError:
            self._json(500, {"status": "error",
                             "output": f"claude CLI não encontrado: {CLAUDE_BIN}", "approved": False})
        except Exception as e:
            self._json(500, {"status": "error", "output": str(e), "approved": False})

    def _json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = http.server.HTTPServer(("0.0.0.0", PORT), Handler)
    log.info("full-test-server ouvindo em http://0.0.0.0:%d", PORT)
    log.info("Claude CLI: %s", CLAUDE_BIN)
    log.info("Ctrl+C para encerrar")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Encerrado.")
