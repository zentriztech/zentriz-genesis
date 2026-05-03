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
from socketserver import ThreadingMixIn

class ThreadedHTTPServer(ThreadingMixIn, http.server.HTTPServer):
    """Servidor multi-threaded — cada request roda em thread separada."""
    daemon_threads = True

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
        # FT-13: api_key opcional — permite que cada projeto use a chave do tenant/zentriz
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
                f"Login: POST /api/auth/login com application/json, extrair accessToken.\n"
                f"Para cada rota em src/lib/*.ts: curl com TOKEN → verificar HTTP 200.\n"
                f"Corrigir: 404 (rota errada), 415 (Content-Type), 400/500 (param nome/valor errado), CORS.\n"
                f"Testar ao menos 1 POST/PATCH/DELETE por domínio.\n\n"
                f"## FASE 4 — Relatório\n"
                f"Grave {project_path}/docs/qa/QA_REPORT_TSK-FULL-TEST.md com:\n"
                f"- Query params verificados (perPage→limit, sort enum)\n"
                f"- Hrefs verificados vs pages existentes\n"
                f"- Endpoints testados e HTTP status\n"
                f"- Bugs corrigidos\n"
                f"APROVADO só se: build limpo + params corretos + todos hrefs têm page + todos endpoints 200.\n\n"
                f"Execute sem pedir confirmação."
            )

        log.info("TASK-FULL-TEST iniciada: project=%s", project_id)
        wrapper_prompt = f"Você está em: {apps_path}\nDiretório de projeto: {project_path}\n\n{prompt}"

        # FT-13: injetar ANTHROPIC_API_KEY se fornecida no payload (credencial do tenant/zentriz)
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
            # Buscar "APROVADO" em todo o output (não só nos primeiros 12k chars)
            approved = any(w in output.upper() for w in
                           ["APROVADO", "ALL CHECKS", "QA_PASS", "PASSED", "ALL PASS",
                            "STATUS FINAL: APROVADO", "✅ APROVADO", "APPROVED"])
            log.info("Concluída: approved=%s rc=%d len=%d", approved, result.returncode, len(output))
            # Retornar início + fim para não perder o veredito final
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
    log.info("Ctrl+C para encerrar")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Encerrado.")
