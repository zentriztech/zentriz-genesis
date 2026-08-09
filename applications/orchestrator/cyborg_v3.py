"""
cyborg_v3.py — Cyborg V3 como Engenheiro Sênior Autônomo.

FILOSOFIA V3
────────────
V2 fragmentava trabalho em N sessões Claude isoladas (uma por ACT), cada uma
sem memória do resto. V3 usa **UMA sessão Claude Code longa** com contexto
contínuo, toolset completo e scripts wrappers que encapsulam bugs de infra.

FLUXO
─────
1. AUDITORIA PRÉVIA (Bedrock, ~30s) — 5 análises paralelas para dar briefing.
   Grava audit.json em docs/cyborg/ para o `zentriz-audit` retornar.
2. BRIEFING — monta prompt com contexto do produto + missão end-to-end.
3. SPAWN CLAUDE CODE (uma sessão ~30-60min):
   - system prompt = engineer_bridge.md
   - CWD = /opt/genesis-files/<pid>/apps/
   - PATH inclui scripts/cyborg-wrappers/
   - env: PROJECT_ID, API_BASE_URL, GENESIS_API_TOKEN, GITHUB_TOKEN (via helper)
4. STREAMING — stdout do claude → dialogue no portal em tempo real.
5. FIM — parse última linha `CYBORG_DONE status=DELIVERED url=...` ou `NEEDS_HUMAN`.
6. Se DELIVERED, valida URL S3 e chama /accept (idempotente).

CONFIGURAÇÃO
────────────
- CYBORG_V3_TIMEOUT_SEC (default 3600 = 1h)
- CYBORG_V3_MODEL (default us.anthropic.claude-opus-4-7)
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# ── Config ─────────────────────────────────────────────────────────────────────

PROJECT_FILES     = os.environ.get("PROJECT_FILES_ROOT", "/project-files")
FTS_URL           = os.environ.get("FULL_TEST_SERVER_URL", "http://host.docker.internal:7878")
API_BASE_URL      = os.environ.get("API_BASE_URL", "http://api:3000").rstrip("/")
API_TOKEN         = os.environ.get("GENESIS_API_TOKEN", "")
V3_TIMEOUT        = int(os.environ.get("CYBORG_V3_TIMEOUT_SEC", "3600"))
V3_MODEL          = os.environ.get("CYBORG_V3_MODEL", "us.anthropic.claude-opus-4-8")
ANALYSIS_TIMEOUT  = int(os.environ.get("CYBORG_ANALYSIS_TIMEOUT_SEC", "180"))


# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class Finding:
    severity: str
    area: str
    description: str
    evidence: str = ""


@dataclass
class AnalysisResult:
    name: str
    ok: bool
    score: int
    findings: list[Finding] = field(default_factory=list)
    raw: str = ""
    duration_ms: int = 0
    error: str | None = None


@dataclass
class CyborgV3Run:
    project_id: str
    tenant_id: str | None
    prod_id: str | None
    started_at: float
    model_id: str
    audit: dict[str, AnalysisResult] = field(default_factory=dict)
    final_status: str = "running"    # running | delivered | needs_human | error
    s3_url: str | None = None
    reason: str = ""
    claude_stdout: str = ""


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _http(method: str, url: str, body: dict | None = None, timeout: int = 60) -> tuple[int, str]:
    import urllib.request
    import urllib.error
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"}
    if API_TOKEN:
        headers["Authorization"] = f"Bearer {API_TOKEN}"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except Exception as e:
        return 0, f"error: {e}"


def _post_dialogue(project_id: str, message: str) -> None:
    _http("POST", f"{API_BASE_URL}/api/projects/{project_id}/dialogue",
          {"from_agent": "cyborg", "to_agent": "system",
           "event_type": "step", "summary_human": message},
          timeout=10)


# ── Fase 1: Auditoria prévia (5 análises Bedrock) ─────────────────────────────

def _load_prompt(name: str) -> str:
    candidates = [
        Path("/app/agents/cyborg/prompts") / f"{name}.md",
        Path(__file__).resolve().parent.parent / "agents" / "cyborg" / "prompts" / f"{name}.md",
    ]
    for p in candidates:
        if p.exists():
            content = p.read_text(encoding="utf-8")
            # Prefixar filosofia comum
            if name not in ("_filosofia", "fixer_bridge", "engineer_bridge"):
                phil_path = p.parent / "_filosofia.md"
                if phil_path.exists():
                    content = phil_path.read_text(encoding="utf-8") + "\n\n---\n\n" + content
            return content
    raise FileNotFoundError(f"Cyborg prompt {name} não encontrado em {candidates}")


def _resolve_proj_dir(project_id: str, prod_id: str | None) -> Path:
    """Resolve o diretório real do projeto (com canário apps/package.json)."""
    root = Path(PROJECT_FILES)
    candidates: list[Path] = []
    if prod_id:
        candidates.append(root / prod_id / project_id)
    candidates.append(root / project_id)

    for c in candidates:
        if (c / "apps" / "package.json").exists():
            return c
    for c in candidates:
        if c.exists():
            return c
    return candidates[-1]


def _fetch_type_policy_for_project(project_id: str) -> dict | None:
    """
    T-14: consulta project_type do projeto via API e monta type_policy.
    Retorna None se não conseguir resolver — análises continuam sem type_policy
    (compatibilidade retroativa com projetos antigos).
    """
    try:
        # Tentar via API HTTP (mesma que o runner usa)
        api_url = os.environ.get("API_BASE_URL", "http://api:3000").rstrip("/")
        token = os.environ.get("GENESIS_API_TOKEN", "")
        if not token:
            return None
        import urllib.request as _ur
        req = _ur.Request(f"{api_url}/api/projects/{project_id}", method="GET")
        req.add_header("Authorization", f"Bearer {token}")
        with _ur.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        raw_type = (data or {}).get("projectType") or (data or {}).get("project_type") or ""
        if not raw_type:
            return None
        # Usa loader do pipeline_context
        from orchestrator.pipeline_context import _build_type_policy_input
        return _build_type_policy_input(raw_type)
    except Exception as e:
        logger.debug(f"[Cyborg V3/T-14] type_policy indisponível: {e}")
        return None


def _collect_context(project_id: str, prod_id: str | None) -> dict:
    """Coleta artefatos + build output para as análises."""
    proj_dir = _resolve_proj_dir(project_id, prod_id)
    src_root = proj_dir / "apps" / "src"

    def _read(p: Path, max_chars: int = 15000) -> str:
        try:
            return p.read_text(encoding="utf-8", errors="replace")[:max_chars]
        except Exception:
            return ""

    def _read_glob(pattern: str, max_files: int = 10, max_chars: int = 20000) -> str:
        if not src_root.exists():
            return ""
        files = sorted(src_root.rglob(pattern))[:max_files]
        parts = []
        total = 0
        for f in files:
            entry = f"### {f.relative_to(proj_dir)}\n```\n{_read(f, 1500)}\n```"
            if total + len(entry) > max_chars:
                break
            parts.append(entry)
            total += len(entry)
        return "\n\n".join(parts)

    # apps_tree GENÉRICO: captura TODO tipo de fonte (.ts/.tsx/.js/.jsx/.mjs), não só .tsx.
    # Antes só varria *.tsx → para lib TS/backend (que têm .ts, sem page.tsx/Sidebar) a árvore
    # ficava VAZIA e a análise a2_fidelidade concluía "nenhum código" (BLOCKER falso).
    # (achado #9 da fatia vertical — viés frontend/web)
    _src_exists = src_root.exists()
    _apps_root = proj_dir / "apps"
    _all_src: list = []
    if _src_exists:
        for _pat in ("*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs"):
            _all_src.extend(src_root.rglob(_pat))
    # INCLUIR os arquivos de config na RAIZ de apps/ (package.json, tsconfig, tsup.config,
    # Dockerfile, vitest.config) — antes o apps_tree só listava apps/src/** e o Cyborg
    # concluía "sem package.json/tsconfig" (BLOCKER falso). (achado #11)
    _root_files: list = []
    if _apps_root.exists():
        for _cfg in ("package.json", "tsconfig.json", "tsconfig.test.json", "tsup.config.ts",
                     "vitest.config.ts", "Dockerfile", ".eslintrc.js", "eslint.config.js",
                     "app.config.ts", "eas.json", "README.md"):
            if (_apps_root / _cfg).exists():
                _root_files.append(_apps_root / _cfg)
    _tree_paths = sorted(str(p.relative_to(proj_dir)) for p in (_root_files + _all_src))
    _apps_tree = "\n".join(_tree_paths)[:6000] if _tree_paths else ""

    # Amostra de código real (para tipos não-web): index/barrel + primeiros fontes.
    def _read_first(patterns: list[str], n: int = 6) -> str:
        if not _src_exists:
            return ""
        found: list = []
        for pat in patterns:
            found.extend(sorted(src_root.rglob(pat)))
        seen, parts, total = set(), [], 0
        for f in found:
            if f in seen:
                continue
            seen.add(f)
            entry = f"### {f.relative_to(proj_dir)}\n```\n{_read(f, 1500)}\n```"
            if total + len(entry) > 20000 or len(parts) >= n:
                break
            parts.append(entry); total += len(entry)
        return "\n\n".join(parts)

    ctx = {
        "project_id": project_id,
        "spec":                  _read(proj_dir / "docs" / "spec" / "PRODUCT_SPEC.md"),
        "cto_charter":           _read(proj_dir / "docs" / "cto_charter.md"),
        "engineer_architecture": _read(proj_dir / "docs" / "engineer_engineer_architecture.md"),
        "pm_backlog":            _read(proj_dir / "docs" / "pm" / "backend" / "BACKLOG.md")
                                  or _read(proj_dir / "docs" / "pm" / "web" / "BACKLOG.md")
                                  or _read(proj_dir / "docs" / "pm_backlog.md"),
        "apps_tree":             _apps_tree,
        # Entry points genéricos (web e não-web): index/barrel da lib + app web quando existir.
        "root_page":  _read(proj_dir / "apps" / "src" / "index.ts")
                       or _read(proj_dir / "apps" / "src" / "app" / "page.tsx"),
        "layout":     _read(proj_dir / "apps" / "src" / "app" / "layout.tsx"),
        "app_shell":  _read(proj_dir / "apps" / "src" / "components" / "layout" / "AppShell.tsx"),
        "sidebar":    _read(proj_dir / "apps" / "src" / "components" / "layout" / "Sidebar.tsx"),
        "all_pages":  _read_glob("app/**/page.tsx"),
        # Amostra de fontes reais — cobre lib/backend (index, *.ts) além de web.
        "source_sample": _read_first(["index.ts", "index.tsx", "*.ts", "*.tsx"]),
        "types":      _read_glob("**/types.ts") or _read_glob("**/*.ts"),
        # Arquivos de config na raiz de apps/ — o analisador precisa vê-los p/ não acusar
        # "sem package.json/tsconfig" (achado #11).
        "package_json": _read(_apps_root / "package.json"),
        "tsconfig":     _read(_apps_root / "tsconfig.json"),
        "tsup_config":  _read(_apps_root / "tsup.config.ts"),
    }

    # Build output — tenta o full-test-server (host); se indisponível, roda build LOCAL
    # (npm ci + build/type-check no diretório apps/) para o a3_build_runtime ter dados reais.
    _build_done = False
    try:
        status, text = _http("POST", f"{FTS_URL}/cyborg-build",
                             {"project_id": project_id, "prod_id": prod_id or "", "timeout": 300},
                             timeout=360)
        if status == 200:
            bd = json.loads(text)
            ctx["build_output"] = bd.get("build_output", "")[-4000:]
            ctx["build_rc"] = bd.get("build_rc", -1)
            ctx["type_check_output"] = bd.get("type_check_output", "")[-2000:]
            ctx["type_check_rc"] = bd.get("type_check_rc", -1)
            _build_done = True
    except Exception as e:
        logger.warning(f"[Cyborg V3] Build check (FTS) falhou: {e}")

    if not _build_done and _apps_root.exists() and (_apps_root / "package.json").exists():
        # Fallback local: instala deps e roda type-check (tsc --noEmit) + build.
        import subprocess as _sp
        try:
            logger.info("[Cyborg V3] FTS indisponível — build local em %s", _apps_root)
            _env = {**os.environ, "CI": "1"}
            # --legacy-peer-deps: o código gerado pelo LLM frequentemente tem conflitos de
            # peer deps (ex.: eslint@9 vs @typescript-eslint/parser@7 que pede eslint@^8).
            # Sem isso, npm install falha (ERESOLVE) e o build inteiro trava (achado #15).
            _inst = _sp.run(["npm", "install", "--no-audit", "--no-fund", "--legacy-peer-deps", "--loglevel=error"],
                            cwd=str(_apps_root), capture_output=True, text=True, timeout=600, env=_env)
            _tc = _sp.run(["npx", "--no-install", "tsc", "--noEmit"],
                          cwd=str(_apps_root), capture_output=True, text=True, timeout=300, env=_env)
            ctx["type_check_rc"] = _tc.returncode
            ctx["type_check_output"] = (_tc.stdout + _tc.stderr)[-2000:]
            _bd = _sp.run(["npm", "run", "build", "--if-present"],
                          cwd=str(_apps_root), capture_output=True, text=True, timeout=600, env=_env)
            ctx["build_rc"] = _bd.returncode
            ctx["build_output"] = (_bd.stdout + _bd.stderr)[-4000:]
            logger.info("[Cyborg V3] build local: install_rc=%s tsc_rc=%s build_rc=%s",
                        _inst.returncode, _tc.returncode, _bd.returncode)
        except Exception as e:
            logger.warning(f"[Cyborg V3] Build local falhou: {e}")
            ctx.setdefault("build_rc", -1)

    ctx["_proj_dir"] = str(proj_dir)

    # T-14: injetar type_policy resolvida no contexto compartilhado.
    # As 5 análises (A1-A5) e os bridges (engineer/fixer/consolidator) leem daí.
    _tp = _fetch_type_policy_for_project(project_id)
    if _tp:
        ctx["type_policy"] = _tp
        logger.info(f"[Cyborg V3/T-14] type_policy={_tp.get('canonical_type')} injetada no contexto")

    return ctx


def _call_bedrock(prompt: str, ctx: dict, model_id: str) -> str:
    # Fallback compatível com o provider ativo: em Foundry, ids us.anthropic.* dão 404
    # (DeploymentNotFound) — usar claude-sonnet-5. (achado #7 da fatia vertical)
    _fallback = (
        "claude-sonnet-5"
        if os.environ.get("GENESIS_LLM_PROVIDER", "").strip().lower() == "foundry"
        else "us.anthropic.claude-sonnet-4-6"
    )
    # Claude 5 (Foundry) faz thinking extenso: com contexto grande (60KB) e max_tokens baixo
    # (6000), o output real estoura o budget e volta VAZIO → parse "substring not found" →
    # score 0/blockers aleatórios. Elevar max_tokens e conter o contexto. (achado #12)
    _max_toks = int(os.environ.get("CYBORG_ANALYSIS_MAX_TOKENS", "16000"))
    _ctx_cap = int(os.environ.get("CYBORG_ANALYSIS_CTX_CHARS", "45000"))
    body = {
        "prompt_override": prompt,
        "user_message": json.dumps({"context": ctx}, ensure_ascii=False)[:_ctx_cap],
        "model_id": model_id,
        "model_id_fallback": _fallback,
        "max_tokens": _max_toks,
    }
    status, text = _http("POST", f"http://agents:8000/invoke/raw", body, timeout=ANALYSIS_TIMEOUT)
    if status != 200:
        raise RuntimeError(f"agents /invoke/raw {status}: {text[:400]}")
    data = json.loads(text)
    return data.get("response", "")


def _parse_analysis(name: str, raw: str) -> AnalysisResult:
    try:
        start = raw.index("{")
        end = raw.rindex("}") + 1
        obj = json.loads(raw[start:end])
    except Exception as e:
        return AnalysisResult(name=name, ok=False, score=0, raw=raw, error=f"parse: {e}")
    findings = [
        Finding(severity=f.get("severity", "MAJOR"), area=f.get("area", "?"),
                description=f.get("description", ""), evidence=f.get("evidence", ""))
        for f in obj.get("findings", []) if isinstance(f, dict)
    ]
    return AnalysisResult(
        name=name, ok=bool(obj.get("ok", False)),
        score=int(obj.get("score", 0)), findings=findings, raw=raw,
    )


def run_prior_audit(project_id: str, prod_id: str | None, model_id: str) -> dict[str, AnalysisResult]:
    """Executa 5 análises Bedrock em paralelo (~30s). Gera briefing para o Cyborg V3."""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    ctx = _collect_context(project_id, prod_id)

    _post_dialogue(project_id,
        f"🔬 Cyborg V3 — auditoria prévia (5 análises Bedrock paralelas, modelo: {model_id})")

    analyses = ["a1_coerencia_estrutural", "a2_fidelidade_spec", "a3_build_runtime",
                "a4_ux_completude", "a5_dominio"]
    results: dict[str, AnalysisResult] = {}

    def _one(name: str):
        t0 = time.time()
        try:
            prompt = _load_prompt(name)
            raw = _call_bedrock(prompt, ctx, model_id)
            ar = _parse_analysis(name, raw)
        except Exception as e:
            ar = AnalysisResult(name=name, ok=False, score=0, error=str(e))
        ar.duration_ms = int((time.time() - t0) * 1000)
        return name, ar

    with ThreadPoolExecutor(max_workers=5) as ex:
        futs = {ex.submit(_one, a): a for a in analyses}
        for fut in as_completed(futs, timeout=ANALYSIS_TIMEOUT + 60):
            try:
                name, ar = fut.result()
                results[name] = ar
                blk = sum(1 for f in ar.findings if f.severity == "BLOCKER")
                logger.info(f"[Cyborg V3] {name}: score={ar.score} blockers={blk} ({ar.duration_ms}ms)")
            except Exception as e:
                logger.error(f"[Cyborg V3] Análise falhou: {e}")

    # Grava audit.json para o wrapper `zentriz-audit`
    try:
        proj_dir = _resolve_proj_dir(project_id, prod_id)
        cyborg_dir = proj_dir / "docs" / "cyborg"
        cyborg_dir.mkdir(parents=True, exist_ok=True)
        audit_data = {
            name: {
                "score": ar.score,
                "ok": ar.ok,
                "findings": [asdict(f) for f in ar.findings],
                "duration_ms": ar.duration_ms,
                "error": ar.error,
            }
            for name, ar in results.items()
        }
        # Adicionar contexto build
        audit_data["build"] = {
            "rc": ctx.get("build_rc", -1),
            "output_tail": ctx.get("build_output", "")[-1500:],
            "type_check_rc": ctx.get("type_check_rc", -1),
        }
        (cyborg_dir / "audit.json").write_text(json.dumps(audit_data, indent=2, ensure_ascii=False),
                                                encoding="utf-8")
    except Exception as e:
        logger.warning(f"[Cyborg V3] Falha ao gravar audit.json: {e}")

    return results


def _summarize_audit(results: dict[str, AnalysisResult]) -> str:
    """Resumo em markdown para o Cyborg V3 ler no briefing inicial."""
    LABELS = {
        "a1_coerencia_estrutural": "Coerência estrutural",
        "a2_fidelidade_spec":       "Fidelidade à spec",
        "a3_build_runtime":         "Build + runtime",
        "a4_ux_completude":         "UX + completude",
        "a5_dominio":               "Domínio",
    }
    lines = ["## Resultado da auditoria prévia (5 dimensões Bedrock)\n"]
    for name in ["a1_coerencia_estrutural", "a2_fidelidade_spec", "a3_build_runtime",
                 "a4_ux_completude", "a5_dominio"]:
        ar = results.get(name)
        if not ar:
            lines.append(f"- **{LABELS[name]}**: ERRO"); continue
        blk = sum(1 for f in ar.findings if f.severity == "BLOCKER")
        maj = sum(1 for f in ar.findings if f.severity == "MAJOR")
        icon = "✓" if blk == 0 else "⚠" if blk <= 2 else "✗"
        lines.append(f"### {icon} {LABELS[name]} — score {ar.score}/10 · {blk} BLOCKER · {maj} MAJOR")
        for f in ar.findings:
            if f.severity == "BLOCKER":
                lines.append(f"  - **BLOCKER** {f.area}: {f.description[:180]}")
        lines.append("")
    return "\n".join(lines)


# ── Fase 2: Spawn Claude Code CLI longo ───────────────────────────────────────

def spawn_engineer(project_id: str, tenant_id: str | None, prod_id: str | None,
                    audit_summary: str, model_id: str) -> dict:
    """Chama full-test-server /cyborg-engineer para spawnar sessão longa."""
    engineer_prompt = _load_prompt("engineer_bridge")

    # T-14: type_policy no briefing do engineer bridge (também disponível ao Cyborg via zentriz-audit).
    _tp = _fetch_type_policy_for_project(project_id)
    _tp_section = ""
    if _tp:
        pol = _tp.get("policy", {}) or {}
        _tp_section = f"""

## Type Policy (aplicável a este projeto)

- **Tipo canônico:** `{_tp.get('canonical_type')}` (resolvido de `{_tp.get('resolved_from')}`)
- **Enforcement mode:** `{_tp.get('enforcement_mode')}` (warn = aviso, blocker = REVISION)
- **Versão da policy:** {_tp.get('policy_version')}
- **Rotas strict obrigatórias:** {pol.get('required_routes', {}).get('strict', [])}
- **Components obrigatórios:** {pol.get('required_components', [])[:5]}
- **Patterns proibidos (não introduza estes):** {pol.get('forbidden_patterns', [])[:8]}

**Regra:** ao corrigir bugs, respeite `forbidden_patterns` (nunca introduza `Prisma` em `backend_api`, `hero-section` em `frontend_dashboard`, etc.). Se o audit sugere um fix que viola a policy, **prefira alternativa que respeite o tipo** ou emita `NEEDS_HUMAN` com motivo.
"""

    # Briefing curto — Claude vai investigar o resto sozinho
    user_briefing = f"""# Missão

Você foi convocado como Cyborg V3 (engenheiro sênior final) para o projeto **{project_id}**.

O pipeline Genesis já entregou o produto. Sua função: **auditar, corrigir cirurgicamente o que impede entrega, publicar no S3 e reportar entrega**.

## Briefing (auditoria prévia Bedrock)

{audit_summary}{_tp_section}

## Escopo

- Diretório de trabalho: `/opt/genesis-files/{prod_id + "/" if prod_id else ""}{project_id}/apps/`
- Você é usuário `ubuntu` no host EC2.
- Ferramentas prontas no PATH:
  - `zentriz-audit {project_id}` — ler audit.json completo (mais detalhes)
  - `zentriz-github-push {project_id}` — commit + push do apps/ para branch dev do repo GitHub
  - `zentriz-accept {project_id}` — chama POST /accept
  - `zentriz-deploy-s3 {project_id}` — dispara deploy + polling até running
  - `zentriz-verify <url>` — testa rotas retornando 200
  - `zentriz-say {project_id} "<msg>"` — posta no chat do projeto

## Sua tarefa

Cumpra o **contrato**: sua última linha DEVE ser `CYBORG_DONE status=DELIVERED url=<url>` ou `CYBORG_DONE status=NEEDS_HUMAN reason=<motivo>`.

Comece analisando o audit (via `zentriz-audit {project_id}`) e o estado atual do apps/. Depois decida seu plano e execute.

**Regras críticas** (já estão no system prompt — não repita):
1. NÃO refatore código que já funciona.
2. NÃO invente rotas fora da spec.
3. Build TEM que passar antes de push.
4. Só reporte DELIVERED após validar URL S3 respondendo 200.
"""

    payload = {
        "project_id": project_id,
        "prod_id": prod_id or "",
        "system_prompt": engineer_prompt,
        "user_prompt": user_briefing,
        "model_id": model_id,
        "timeout": V3_TIMEOUT,
        "cwd_hint": "apps",  # trabalhar dentro de apps/
    }

    status, text = _http("POST", f"{FTS_URL}/cyborg-engineer", payload, timeout=V3_TIMEOUT + 60)
    if status != 200:
        return {"ok": False, "error": f"FTS retornou {status}: {text[:500]}"}
    try:
        return json.loads(text)
    except Exception as e:
        return {"ok": False, "error": f"parse fail: {e}", "raw": text[:2000]}


def autonomous_rework(project_id: str, prod_id: str | None, audit: dict, model_id: str,
                      max_rounds: int = 2) -> dict:
    """Correção AUTÔNOMA via /invoke/dev quando o engineer-bridge (Claude CLI) está ausente.

    Fecha o loop de qualidade sem depender do host de produção: pega os BLOCKERs/MAJORs da
    auditoria, pede ao agente Dev (Foundry) para corrigi-los, grava os artefatos retornados em
    apps/, e re-audita. Repete até 0 BLOCKER ou esgotar rounds. (achado #16)

    Retorna {"ok": bool, "rounds": n, "final_audit": dict, "delivered": bool}.
    """
    from orchestrator.project_storage import write_apps_artifact
    proj_dir = _resolve_proj_dir(project_id, prod_id)
    cur_audit = audit
    for rnd in range(1, max_rounds + 1):
        # Coletar findings acionáveis (BLOCKER + MAJOR) de todas as dimensões.
        findings = []
        for name, ar in cur_audit.items():
            for f in getattr(ar, "findings", []) or []:
                if f.severity in ("BLOCKER", "MAJOR"):
                    findings.append(f"[{f.severity}] {f.area}: {f.description}")
        if not findings:
            return {"ok": True, "rounds": rnd - 1, "final_audit": cur_audit, "delivered": True}

        _post_dialogue(project_id,
            f"🔧 Cyborg — correção autônoma (rodada {rnd}/{max_rounds}): {len(findings)} issue(s) "
            f"da auditoria enviadas ao Dev via Foundry.")

        # Ler os fontes atuais para dar contexto ao Dev.
        ctx = _collect_context(project_id, prod_id)
        _fix_prompt = (
            "Você é o Dev sênior. O código gerado NÃO cumpre a spec integralmente. "
            "Corrija TODOS os problemas abaixo, respeitando a spec e a arquitetura. "
            "Responda APENAS um JSON: {\"artifacts\":[{\"path\":\"<relativo a apps/>\",\"content\":\"<conteúdo completo do arquivo>\"}]}. "
            "Inclua TODOS os arquivos novos/alterados necessários (código, config, .changeset, api_contract.md em project/). "
            "Não trunque conteúdo. Não explique fora do JSON."
        )
        _fix_user = (
            f"## Spec (PRODUCT_SPEC)\n{ctx.get('spec','')[:20000]}\n\n"
            f"## Arquitetura do Engineer\n{ctx.get('engineer_architecture','')[:8000]}\n\n"
            f"## Código atual (amostra)\n{ctx.get('source_sample','')[:12000]}\n\n"
            f"## Árvore atual\n{ctx.get('apps_tree','')}\n\n"
            f"## Problemas a corrigir ({len(findings)})\n" + "\n".join(f"- {x}" for x in findings[:20])
        )
        body = {
            "prompt_override": _fix_prompt, "user_message": _fix_user[:45000],
            "model_id": model_id,
            "model_id_fallback": ("claude-opus-5" if os.environ.get("GENESIS_LLM_PROVIDER","").lower()=="foundry" else "us.anthropic.claude-opus-4-6-v1"),
            "max_tokens": int(os.environ.get("CYBORG_REWORK_MAX_TOKENS", "24000")),
        }
        status, text = _http("POST", f"http://agents:8000/invoke/raw", body, timeout=ANALYSIS_TIMEOUT + 120)
        if status != 200:
            logger.warning("[Cyborg rework] /invoke/raw %s", status)
            break
        try:
            resp = json.loads(text).get("response", "")
            s = resp.index("{"); e = resp.rindex("}") + 1
            obj = json.loads(resp[s:e])
            arts = obj.get("artifacts", []) or []
        except Exception as ex:
            logger.warning("[Cyborg rework] parse artifacts falhou: %s", ex)
            break
        written = 0
        for a in arts:
            p = (a.get("path") or "").strip().lstrip("/")
            c = a.get("content")
            if p and isinstance(c, str) and ".." not in p:
                # api_contract.md e outros vão em project/; código em apps/.
                if p.startswith("project/") or p.endswith("api_contract.md"):
                    from orchestrator.project_storage import write_project_artifact
                    write_project_artifact(project_id, p if p.startswith("project/") else f"project/{p}", c)
                else:
                    write_apps_artifact(project_id, p, c)
                written += 1
        _post_dialogue(project_id, f"🔧 Cyborg — Dev gravou {written} arquivo(s). Re-auditando…")
        logger.info("[Cyborg rework] rodada %d: %d findings → %d artefatos gravados", rnd, len(findings), written)
        if written == 0:
            break
        # Re-auditar com o código corrigido.
        cur_audit = run_prior_audit(project_id, prod_id, model_id)
    total_blk = sum(sum(1 for f in ar.findings if f.severity == "BLOCKER") for ar in cur_audit.values())
    return {"ok": total_blk == 0, "rounds": max_rounds, "final_audit": cur_audit, "delivered": total_blk == 0}


# ── Fase 3: Parse resultado do Claude Code ────────────────────────────────────

def parse_cyborg_done(stdout: str) -> dict:
    """Procura pela última linha CYBORG_DONE no stdout do Claude."""
    for line in stdout.splitlines()[::-1]:
        line = line.strip()
        if line.startswith("CYBORG_DONE"):
            # CYBORG_DONE status=DELIVERED url=http://xxx
            parts = {}
            for kv in line.replace("CYBORG_DONE", "").strip().split():
                if "=" in kv:
                    k, v = kv.split("=", 1)
                    parts[k.strip()] = v.strip()
            return parts
    return {}


# ── Orquestrador V3 ───────────────────────────────────────────────────────────

def run_cyborg_v3(project_id: str, tenant_id: str | None, prod_id: str | None) -> CyborgV3Run:
    model_id = V3_MODEL
    run = CyborgV3Run(
        project_id=project_id, tenant_id=tenant_id, prod_id=prod_id,
        started_at=time.time(), model_id=model_id,
    )

    _post_dialogue(project_id,
        f"═══════════════════════════════════════\n"
        f"🤖 Cyborg V3 assumiu o produto\n"
        f"═══════════════════════════════════════\n"
        f"Modo: engenheiro sênior autônomo (sessão única, memória contínua).\n"
        f"Modelo: {model_id} · Timeout: {V3_TIMEOUT // 60}min\n"
        f"Como trabalho: audito → corrijo cirurgicamente → build → push → accept → deploy S3 → valido URL.\n"
        f"Se algo estruturalmente impossível, paro e informo o motivo real.")

    # Fase 1: Auditoria prévia
    audit = run_prior_audit(project_id, prod_id, model_id)
    run.audit = audit
    total_blk = sum(sum(1 for f in ar.findings if f.severity == "BLOCKER") for ar in audit.values())
    _post_dialogue(project_id, f"📋 Briefing pronto — {total_blk} BLOCKER(s) detectado(s). Passando para o engenheiro (Claude Code CLI).")

    audit_summary = _summarize_audit(audit)

    # Fase 2: Spawn Claude Code (sessão única longa)
    _post_dialogue(project_id, f"🛠️ Cyborg V3 trabalhando no produto (pode levar 20-40 min).")
    result = spawn_engineer(project_id, tenant_id, prod_id, audit_summary, model_id)

    if not result.get("ok"):
        # VEREDITO POR AUDITORIA (fallback autônomo): quando o engineer-bridge (Claude Code CLI
        # via full-test-server) não está disponível, decidir accept/needs_human a partir das 5
        # análises Bedrock/Foundry — que já rodaram e são o sinal de verificação externa. Evita
        # travar em pending_cyborg eternamente em ambientes sem o bridge pesado. Ligado por
        # default; desligar com CYBORG_AUDIT_ONLY_FALLBACK=0. (achado #8 da fatia vertical)
        _audit_fallback = os.environ.get("CYBORG_AUDIT_ONLY_FALLBACK", "1").strip() != "0"
        if _audit_fallback and audit:
            # CORREÇÃO AUTÔNOMA (achado #16): se há BLOCKERs, tenta corrigir via /invoke/dev
            # (Foundry) antes de desistir — fecha o loop de qualidade sem o Claude CLI de produção.
            if total_blk > 0 and os.environ.get("CYBORG_AUTONOMOUS_REWORK", "1").strip() != "0":
                _rw = autonomous_rework(project_id, prod_id, audit, model_id,
                                        max_rounds=int(os.environ.get("CYBORG_REWORK_ROUNDS", "2")))
                if _rw.get("final_audit"):
                    audit = _rw["final_audit"]; run.audit = audit
                    total_blk = sum(sum(1 for f in ar.findings if f.severity == "BLOCKER") for ar in audit.values())
            _scores = [ar.score for ar in audit.values() if ar.ok or ar.score > 0]
            _avg = (sum(_scores) / len(_scores)) if _scores else 0
            _min_avg = float(os.environ.get("CYBORG_AUDIT_MIN_AVG", "7"))
            if total_blk == 0 and _avg >= _min_avg:
                run.final_status = "delivered"
                run.reason = f"aceito por auditoria (bridge indisponível): 0 BLOCKER, média {_avg:.1f}/10 ≥ {_min_avg}"
                _post_dialogue(project_id,
                    f"═══════════════════════════════════════\n"
                    f"✅ Cyborg V3 — aceito por auditoria autônoma\n"
                    f"═══════════════════════════════════════\n"
                    f"Engineer-bridge (Claude Code CLI) indisponível; decisão pelas 5 análises "
                    f"Foundry: 0 BLOCKER, média {_avg:.1f}/10. Projeto aprovado.")
                return run
            run.final_status = "needs_human"
            run.reason = (f"auditoria reprovou (bridge indisponível): {total_blk} BLOCKER, "
                          f"média {_avg:.1f}/10 (< {_min_avg}). Ver docs/cyborg/audit.json.")
            _post_dialogue(project_id,
                f"═══════════════════════════════════════\n"
                f"⚠️ Cyborg V3 — needs_human (auditoria)\n"
                f"═══════════════════════════════════════\n"
                f"{run.reason}")
            return run
        run.final_status = "error"
        run.reason = result.get("error", "erro desconhecido no spawn_engineer")
        _post_dialogue(project_id,
            f"═══════════════════════════════════════\n"
            f"⚠️ Cyborg V3 — erro no spawn\n"
            f"═══════════════════════════════════════\n"
            f"{run.reason}")
        return run

    run.claude_stdout = result.get("stdout", "")

    # Fase 3: Parse CYBORG_DONE
    done = parse_cyborg_done(run.claude_stdout)
    status = done.get("status", "").upper()

    if status == "DELIVERED":
        url = done.get("url", "")
        run.s3_url = url
        run.final_status = "delivered"
        _elapsed = int(time.time() - run.started_at)
        _post_dialogue(project_id,
            f"═══════════════════════════════════════\n"
            f"🎉 Cyborg V3 entregou o produto!\n"
            f"═══════════════════════════════════════\n"
            f"✅ Deploy S3 ativo: {url}\n"
            f"⏱️ Duração total: {_elapsed // 60}min {_elapsed % 60}s\n"
            f"🤖 Modelo: {model_id}")
    elif status == "NEEDS_HUMAN":
        run.final_status = "needs_human"
        run.reason = done.get("reason", "motivo não especificado")
        _post_dialogue(project_id,
            f"═══════════════════════════════════════\n"
            f"⚠️ Cyborg V3 — precisa de intervenção humana\n"
            f"═══════════════════════════════════════\n"
            f"Motivo: {run.reason}\n"
            f"Detalhes completos: docs/cyborg/final_report.md")
    else:
        run.final_status = "error"
        run.reason = "Claude Code não retornou linha CYBORG_DONE — pode ter sido cortado por timeout ou crashou"
        _post_dialogue(project_id,
            f"═══════════════════════════════════════\n"
            f"⚠️ Cyborg V3 — resposta não parseável\n"
            f"═══════════════════════════════════════\n"
            f"O engenheiro Claude Code não terminou com CYBORG_DONE. "
            f"Última saída: {run.claude_stdout[-300:]}")

    # Grava relatório final
    try:
        proj_dir = _resolve_proj_dir(project_id, prod_id)
        cyborg_dir = proj_dir / "docs" / "cyborg"
        cyborg_dir.mkdir(parents=True, exist_ok=True)
        (cyborg_dir / "final_report.md").write_text(
            f"# Cyborg V3 — {run.final_status.upper()}\n\n"
            f"Modelo: {run.model_id}\n"
            f"Duração: {int(time.time() - run.started_at)}s\n"
            f"S3 URL: {run.s3_url or '—'}\n"
            f"Motivo (se needs_human): {run.reason}\n\n"
            f"## Auditoria prévia\n\n{audit_summary}\n\n"
            f"## Stdout Claude Code (últimas 5000 chars)\n\n```\n{run.claude_stdout[-5000:]}\n```\n",
            encoding="utf-8",
        )
    except Exception as e:
        logger.warning(f"[Cyborg V3] Falha ao gravar final_report.md: {e}")

    return run
