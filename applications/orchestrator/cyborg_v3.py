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
V3_MODEL          = os.environ.get("CYBORG_V3_MODEL", "us.anthropic.claude-opus-4-7")
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

    ctx = {
        "project_id": project_id,
        "spec":                  _read(proj_dir / "docs" / "spec" / "PRODUCT_SPEC.md"),
        "cto_charter":           _read(proj_dir / "docs" / "cto_charter.md"),
        "engineer_architecture": _read(proj_dir / "docs" / "engineer_engineer_architecture.md"),
        "pm_backlog":            _read(proj_dir / "docs" / "pm" / "web" / "BACKLOG.md")
                                  or _read(proj_dir / "docs" / "pm_backlog.md"),
        "apps_tree":             "\n".join(sorted(
            str(p.relative_to(proj_dir)) for p in src_root.rglob("*.tsx")
        ))[:6000] if src_root.exists() else "",
        "root_page":  _read(proj_dir / "apps" / "src" / "app" / "page.tsx"),
        "layout":     _read(proj_dir / "apps" / "src" / "app" / "layout.tsx"),
        "app_shell":  _read(proj_dir / "apps" / "src" / "components" / "layout" / "AppShell.tsx"),
        "sidebar":    _read(proj_dir / "apps" / "src" / "components" / "layout" / "Sidebar.tsx"),
        "all_pages":  _read_glob("app/**/page.tsx"),
        "types":      _read_glob("**/types.ts"),
    }

    # Build output
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
    except Exception as e:
        logger.warning(f"[Cyborg V3] Build check falhou: {e}")

    ctx["_proj_dir"] = str(proj_dir)
    return ctx


def _call_bedrock(prompt: str, ctx: dict, model_id: str) -> str:
    body = {
        "prompt_override": prompt,
        "user_message": json.dumps({"context": ctx}, ensure_ascii=False)[:60000],
        "model_id": model_id,
        "model_id_fallback": "us.anthropic.claude-sonnet-4-6",
        "max_tokens": 6000,
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

    # Briefing curto — Claude vai investigar o resto sozinho
    user_briefing = f"""# Missão

Você foi convocado como Cyborg V3 (engenheiro sênior final) para o projeto **{project_id}**.

O pipeline Genesis já entregou o produto. Sua função: **auditar, corrigir cirurgicamente o que impede entrega, publicar no S3 e reportar entrega**.

## Briefing (auditoria prévia Bedrock)

{audit_summary}

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
