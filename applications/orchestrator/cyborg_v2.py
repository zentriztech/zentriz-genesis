"""
cyborg_v2.py — Cyborg V2 como resolvedor final agentic.

FILOSOFIA
─────────
Cyborg = engenheiro sênior humano com Claude Code CLI + modelo mais capaz disponível.
Missão: **lapidar e entregar** o produto no S3, funcional e polido. Não é gate binário.

FLUXO
─────
1. AUDITORIA PARALELA (Bedrock)   — 5 análises independentes (A1..A5) em ângulos distintos.
2. DIAGNÓSTICO CONSOLIDADO         — LLM síntese dos findings em plano de ação priorizado.
3. CORREÇÃO ITERATIVA              — para cada action, spawna Claude Code CLI via full-test-server.
4. VERIFICAÇÃO                     — re-roda A1..A5; se ok, avança; se não, itera (max 3 ciclos).
5. DEPLOY S3 AUTOMÁTICO            — push GitHub + POST /deploy/ephemeral + valida URL.
6. ACEITE ou RELATÓRIO DE FALHA    — /accept com evidence rico, ou relatório humano-readable.

DEPENDÊNCIAS
────────────
- Bedrock via boto3 (client em orchestrator.agents.runtime)
- full-test-server no host: POST /cyborg-claude-code, POST /cyborg-playwright
- API Genesis: POST /api/projects/:id/accept, POST /api/projects/:id/deploy/ephemeral

CONFIGURAÇÃO
────────────
- Modelo lido de tenant_llm_configs.cyborg_model_id (com fallback do zentriz_llm_config).
- CYBORG_VERSION=v2 (env do container) ativa este módulo; v1 usa zentriz_cyborg_legacy.
- CYBORG_MAX_ITERATIONS (default 3)
- CYBORG_ANALYSIS_TIMEOUT_SEC (default 300)
- CYBORG_FIX_TIMEOUT_SEC (default 900)
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
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
MAX_ITERATIONS    = int(os.environ.get("CYBORG_MAX_ITERATIONS", "3"))   # cirúrgico: 3 rodadas suficientes para lapidação
CONVERGE_WINDOW   = int(os.environ.get("CYBORG_CONVERGE_WINDOW", "1"))   # 1 iteração sem redução → escalar humano
MAX_ACTIONS_PER_ITER = int(os.environ.get("CYBORG_MAX_ACTIONS", "3"))    # cap de ações por iteração — anti loop de refatoração
ANALYSIS_TIMEOUT  = int(os.environ.get("CYBORG_ANALYSIS_TIMEOUT_SEC", "300"))
FIX_TIMEOUT       = int(os.environ.get("CYBORG_FIX_TIMEOUT_SEC", "900"))

DEFAULT_CYBORG_MODEL          = "us.anthropic.claude-opus-4-7"
DEFAULT_CYBORG_MODEL_FALLBACK = "us.anthropic.claude-sonnet-4-6"


# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class Finding:
    severity: str        # BLOCKER | MAJOR | MINOR
    area: str
    description: str
    evidence: str = ""
    suggested_fix: str = ""


@dataclass
class AnalysisResult:
    name: str
    ok: bool
    score: int
    findings: list[Finding] = field(default_factory=list)
    raw: str = ""           # resposta bruta da LLM
    duration_ms: int = 0
    error: str | None = None


@dataclass
class Action:
    id: str
    priority: int
    severity: str
    phase: str
    goal: str
    instructions: str
    verify_command: str
    success_criteria: str


@dataclass
class ConsolidatedPlan:
    verdict: str        # APROVADO_SEM_MUDANCAS | REQUER_CORRECAO | IMPOSSIVEL_ENTREGAR
    summary: str
    actions: list[Action] = field(default_factory=list)
    estimated_iterations: int = 1


@dataclass
class CyborgRun:
    project_id: str
    tenant_id: str | None
    prod_id: str | None
    started_at: float
    model_id: str
    model_id_fallback: str
    iterations: list[dict] = field(default_factory=list)
    final_status: str = "running"   # running | accepted | failed | needs_human
    final_report: str = ""
    s3_url: str | None = None


# ── Helpers HTTP ──────────────────────────────────────────────────────────────

def _http(method: str, url: str, body: dict | None = None, timeout: int = 60) -> tuple[int, str]:
    """HTTP simples com urllib (evita deps externas)."""
    import urllib.request
    import urllib.error
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_TOKEN}"} if API_TOKEN
        else {"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except Exception as e:
        return 0, f"error: {e}"


def _api(method: str, path: str, body: dict | None = None, timeout: int = 60) -> tuple[Any, int]:
    status, text = _http(method, f"{API_BASE_URL}{path}", body, timeout)
    try:
        return json.loads(text), status
    except Exception:
        return text, status


def _post_dialogue(project_id: str, message: str) -> None:
    # FT-18 fix (2026-07-03): API do Node.js espera snake_case (from_agent/to_agent/summary_human),
    # camelCase retornava 400 silencioso. Confirmado via curl direto.
    _api("POST", f"/api/projects/{project_id}/dialogue",
         {"from_agent": "cyborg", "to_agent": "system", "event_type": "step", "summary_human": message},
         timeout=10)


# ── Config: obter modelo do Cyborg do tenant/Zentriz ──────────────────────────

def _resolve_cyborg_model(tenant_id: str | None) -> tuple[str, str]:
    """Retorna (model_id, fallback). Cascata: tenant → Zentriz singleton → default."""
    # Chamada direta ao DB via API interna (evita duplicar credenciais)
    if tenant_id:
        # Query tenant_llm_configs.cyborg_model_id
        # (na prática, seria melhor uma API dedicada; para MVP, delegamos ao Node)
        try:
            data, status = _api("GET", f"/api/tenant/{tenant_id}/llm-config", timeout=10)
            if status == 200 and isinstance(data, dict):
                slots = data.get("slots", [])
                for slot in slots:
                    m = slot.get("cyborg_model_id")
                    f = slot.get("cyborg_model_id_fallback")
                    if m:
                        return m, f or DEFAULT_CYBORG_MODEL_FALLBACK
                sd = data.get("system_default", {})
                m = sd.get("cyborg_model_id")
                f = sd.get("cyborg_model_id_fallback")
                if m:
                    return m, f or DEFAULT_CYBORG_MODEL_FALLBACK
        except Exception as e:
            logger.warning(f"[Cyborg V2] Falha ao ler cyborg_model_id do tenant: {e}")

    return DEFAULT_CYBORG_MODEL, DEFAULT_CYBORG_MODEL_FALLBACK


# ── Fase 1: Análises paralelas via Bedrock ───────────────────────────────────

def _load_prompt(name: str) -> str:
    """Carrega prompt de applications/agents/cyborg/prompts/<name>.md.

    Automaticamente prefixa com _filosofia.md (regras comuns anti-refactor,
    escopo estreito de lapidação-de-entrega) exceto para o próprio _filosofia
    e para o fixer_bridge (que já tem sua própria filosofia interna).
    """
    candidates = [
        Path("/app/agents/cyborg/prompts") / f"{name}.md",
        Path(__file__).resolve().parent.parent / "agents" / "cyborg" / "prompts" / f"{name}.md",
    ]
    prompt: str | None = None
    prompts_dir: Path | None = None
    for p in candidates:
        if p.exists():
            prompt = p.read_text(encoding="utf-8")
            prompts_dir = p.parent
            break
    if prompt is None:
        raise FileNotFoundError(f"Cyborg prompt {name} não encontrado em {candidates}")

    # Prefixa filosofia comum (exceto pra ela mesma e para o fixer)
    if name not in ("_filosofia", "fixer_bridge") and prompts_dir:
        philosophy = prompts_dir / "_filosofia.md"
        if philosophy.exists():
            prompt = philosophy.read_text(encoding="utf-8") + "\n\n---\n\n" + prompt
    return prompt


def _collect_context(project_id: str, prod_id: str | None) -> dict:
    """Coleta artefatos do projeto para os prompts das análises.

    FT-18 fix (2026-07-02, OrienteMe V4): quando havia prod_id, o path
    /project-files/<prod>/<pid>/ existia mas só com pastas vazias (apps/, docs/, project/).
    A checagem `any(rglob("*"))` retornava True (pastas existem!) mas os arquivos reais
    estavam em /project-files/<pid>/ (sem prod_id). Fix: usar um "canário" — verificar se
    docs/cto_charter.md OU docs/spec/PRODUCT_SPEC.md existem no path candidato. Se não,
    fallback.
    """
    root = Path(PROJECT_FILES)

    def _has_real_content(base: Path) -> bool:
        # Um dos artefatos-chave produzidos pelo CTO/Dev tem que estar presente
        # FT-18 fix: incluir apps/package.json (canário do Dev) — se falta, A3 não consegue rodar build.
        canaries = [
            base / "apps" / "package.json",   # sinal forte de que Dev entregou código
            base / "docs" / "cto_charter.md",
            base / "docs" / "spec" / "PRODUCT_SPEC.md",
            base / "docs" / "pm_backlog.md",
        ]
        return any(c.exists() and c.stat().st_size > 100 for c in canaries)

    candidates: list[Path] = []
    if prod_id:
        candidates.append(root / prod_id / project_id)
    candidates.append(root / project_id)

    proj_dir = next((c for c in candidates if _has_real_content(c)), None)
    if proj_dir is None:
        # último recurso: primeiro que existir, mesmo vazio (evita crash)
        proj_dir = next((c for c in candidates if c.exists()), candidates[-1])
        logger.warning(f"[Cyborg V2] Nenhum canário encontrado; usando fallback {proj_dir}")
    else:
        logger.info(f"[Cyborg V2] proj_dir resolvido: {proj_dir}")

    def _read(p: Path, max_chars: int = 20000) -> str:
        try:
            return p.read_text(encoding="utf-8", errors="replace")[:max_chars]
        except Exception:
            return ""

    # FT-18 F3: contexto ampliado — antes só 4 arquivos, agora todas as pages, types, mocks, layout components
    src_root = proj_dir / "apps" / "src"

    def _read_glob(pattern: str, max_files: int = 15, max_chars: int = 30000) -> str:
        if not src_root.exists():
            return ""
        files = sorted(src_root.rglob(pattern))[:max_files]
        parts = []
        total = 0
        for f in files:
            content = _read(f, 2500)
            entry = f"### {f.relative_to(proj_dir)}\n```\n{content}\n```"
            if total + len(entry) > max_chars:
                break
            parts.append(entry)
            total += len(entry)
        return "\n\n".join(parts)

    ctx = {
        "project_id": project_id,
        "spec":                    _read(proj_dir / "docs" / "spec" / "PRODUCT_SPEC.md"),
        "cto_charter":             _read(proj_dir / "docs" / "cto_charter.md"),
        "engineer_architecture":   _read(proj_dir / "docs" / "engineer_engineer_architecture.md"),
        "pm_backlog":              _read(proj_dir / "docs" / "pm" / "web" / "BACKLOG.md")
                                    or _read(proj_dir / "docs" / "pm_backlog.md"),
        "apps_tree":               "\n".join(sorted(
            str(p.relative_to(proj_dir))
            for p in src_root.rglob("*.tsx")
        ))[:8000] if src_root.exists() else "",
        # Fase estruturais (o essencial)
        "root_page":               _read(proj_dir / "apps" / "src" / "app" / "page.tsx"),
        "layout":                  _read(proj_dir / "apps" / "src" / "app" / "layout.tsx"),
        "app_shell":               _read(proj_dir / "apps" / "src" / "components" / "layout" / "AppShell.tsx"),
        "sidebar":                 _read(proj_dir / "apps" / "src" / "components" / "layout" / "Sidebar.tsx"),
        "header":                  _read(proj_dir / "apps" / "src" / "components" / "layout" / "Header.tsx"),
        "footer":                  _read(proj_dir / "apps" / "src" / "components" / "layout" / "Footer.tsx"),
        # F3: ampliado — types, mocks, todas as page.tsx, componentes de layout adicionais
        "types_files":             _read_glob("**/types.ts") + "\n" + _read_glob("types/*.ts"),
        "mock_files":               _read_glob("**/mock-*.ts"),
        "all_pages":               _read_glob("app/**/page.tsx", max_files=20, max_chars=40000),
        "auth_lib":                _read(proj_dir / "apps" / "src" / "lib" / "auth.ts"),
        "middleware":              _read(proj_dir / "apps" / "src" / "middleware.ts")
                                    or _read(proj_dir / "apps" / "middleware.ts"),
    }
    ctx["_proj_dir"] = str(proj_dir)

    # F2: rodar build real ANTES das análises — A3 opinava sobre saída de build que nunca coletou.
    # Se o build passa/falha, A3 tem contexto real. Se demora demais (timeout), degrada mas não bloqueia.
    try:
        build_payload = {"project_id": project_id, "prod_id": prod_id, "timeout": 300}
        status, text = _http("POST", f"{FTS_URL}/cyborg-build", build_payload, timeout=360)
        if status == 200:
            bd = json.loads(text)
            ctx["build_output"] = bd.get("build_output", "")[-5000:]
            ctx["build_rc"] = bd.get("build_rc", -1)
            ctx["type_check_output"] = bd.get("type_check_output", "")[-3000:]
            ctx["type_check_rc"] = bd.get("type_check_rc", -1)
            logger.info(f"[Cyborg V2] build coletado: rc={ctx['build_rc']}, tc_rc={ctx.get('type_check_rc')}")
        else:
            ctx["build_output"] = f"[FTS retornou {status}] Cyborg V2 não conseguiu executar build"
            ctx["build_rc"] = -1
    except Exception as e:
        logger.warning(f"[Cyborg V2] build check falhou: {e}")
        ctx["build_output"] = f"[erro] {e}"
        ctx["build_rc"] = -1

    return ctx


def _call_bedrock(prompt: str, ctx: dict, model_id: str, fallback_id: str) -> str:
    """Chama Bedrock via agents container (HTTP). Fallback é gerenciado lá.
    Usa /invoke/raw que aceita prompt/user customizados."""
    return _call_bedrock_via_agents(prompt, ctx, model_id, fallback_id)


def _call_bedrock_via_agents(prompt: str, ctx: dict, model_id: str, fallback_id: str) -> str:
    """Fallback: chama o agents container (que já tem Bedrock configurado)."""
    body = {
        "prompt_override": prompt,
        "user_message": json.dumps({"context": ctx}, ensure_ascii=False)[:60000],
        "model_id": model_id,
        "model_id_fallback": fallback_id,
        "max_tokens": 8000,
    }
    status, text = _http(
        "POST", f"http://agents:8000/invoke/raw",
        body, timeout=ANALYSIS_TIMEOUT,
    )
    if status != 200:
        raise RuntimeError(f"agents /invoke/raw retornou {status}: {text[:500]}")
    try:
        data = json.loads(text)
        return data.get("response", "") or data.get("content", "") or text
    except Exception:
        return text


def _parse_analysis(name: str, raw: str) -> AnalysisResult:
    """Extrai JSON estruturado da resposta da análise."""
    # Encontra o primeiro { e o último } — tolera preâmbulo/thinking
    try:
        start = raw.index("{")
        end   = raw.rindex("}") + 1
        obj   = json.loads(raw[start:end])
    except (ValueError, json.JSONDecodeError) as e:
        return AnalysisResult(
            name=name, ok=False, score=0, raw=raw,
            error=f"parse fail: {e}",
        )

    findings = [
        Finding(
            severity=f.get("severity", "MAJOR"),
            area=f.get("area", "unknown"),
            description=f.get("description", ""),
            evidence=f.get("evidence", ""),
            suggested_fix=f.get("suggested_fix", ""),
        )
        for f in obj.get("findings", [])
        if isinstance(f, dict)
    ]
    return AnalysisResult(
        name=name,
        ok=bool(obj.get("ok", False)) and not any(fnd.severity == "BLOCKER" for fnd in findings),
        score=int(obj.get("score", 0)),
        findings=findings,
        raw=raw,
    )


def run_analyses(project_id: str, tenant_id: str | None, prod_id: str | None) -> dict[str, AnalysisResult]:
    """Executa as 5 análises em paralelo (thread pool)."""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    model_id, fallback_id = _resolve_cyborg_model(tenant_id)
    ctx = _collect_context(project_id, prod_id)

    logger.info(f"[Cyborg V2] Iniciando 5 análises paralelas (model={model_id})")
    _post_dialogue(project_id,
        f"🔬 Auditando o produto em 5 dimensões paralelas (Opus): "
        f"coerência estrutural, fidelidade à spec, build+runtime, UX+completude, domínio.")

    analyses = ["a1_coerencia_estrutural", "a2_fidelidade_spec", "a3_build_runtime", "a4_ux_completude", "a5_dominio"]
    results: dict[str, AnalysisResult] = {}

    def _one(name: str) -> tuple[str, AnalysisResult]:
        t0 = time.time()
        try:
            prompt = _load_prompt(name)
            raw = _call_bedrock(prompt, ctx, model_id, fallback_id)
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
                total_blk = sum(1 for f in ar.findings if f.severity == "BLOCKER")
                logger.info(f"[Cyborg V2] {name}: score={ar.score} findings={len(ar.findings)} blockers={total_blk} ({ar.duration_ms}ms)")
            except Exception as e:
                logger.error(f"[Cyborg V2] Análise futura falhou: {e}")

    # Resumo da auditoria — quantos blockers por dimensão, para o usuário ter visibilidade
    LABELS = {
        "a1_coerencia_estrutural": "Coerência estrutural",
        "a2_fidelidade_spec":       "Fidelidade à spec",
        "a3_build_runtime":         "Build + runtime",
        "a4_ux_completude":         "UX + completude",
        "a5_dominio":               "Domínio",
    }
    lines = []
    total_blk = 0
    for name in analyses:
        ar = results.get(name)
        if not ar:
            lines.append(f"  • {LABELS[name]}: ERRO"); continue
        blk = sum(1 for f in ar.findings if f.severity == "BLOCKER")
        maj = sum(1 for f in ar.findings if f.severity == "MAJOR")
        total_blk += blk
        icon = "✓" if blk == 0 else "⚠" if blk <= 2 else "✗"
        lines.append(f"  {icon} {LABELS[name]} · score {ar.score}/10 · {blk} bloqueios · {maj} maiores")
    _post_dialogue(project_id,
        f"📋 Auditoria concluída — {total_blk} bloqueio{'s' if total_blk != 1 else ''} detectado{'s' if total_blk != 1 else ''}:\n"
        + "\n".join(lines))

    return results


# ── Fase 2: Consolidador ─────────────────────────────────────────────────────

def consolidate(project_id: str, tenant_id: str | None, analyses: dict[str, AnalysisResult]) -> ConsolidatedPlan:
    model_id, fallback_id = _resolve_cyborg_model(tenant_id)
    prompt = _load_prompt("consolidator")
    payload = {name: asdict(ar) for name, ar in analyses.items()}
    raw = _call_bedrock(prompt, {"analyses": payload}, model_id, fallback_id)

    try:
        start = raw.index("{")
        end   = raw.rindex("}") + 1
        obj   = json.loads(raw[start:end])
    except Exception as e:
        logger.error(f"[Cyborg V2] Consolidação parse fail: {e}")
        return ConsolidatedPlan(
            verdict="IMPOSSIVEL_ENTREGAR",
            summary=f"Falha ao parsear consolidação: {e}. Raw: {raw[:400]}",
        )

    actions = [
        Action(
            id=a.get("id", f"ACT-{i:02d}"),
            priority=int(a.get("priority", i)),
            severity=a.get("severity", "MAJOR"),
            phase=a.get("phase", "unknown"),
            goal=a.get("goal", ""),
            instructions=a.get("instructions", ""),
            verify_command=a.get("verify_command", ""),
            success_criteria=a.get("success_criteria", ""),
        )
        for i, a in enumerate(obj.get("actions", []), start=1)
        if isinstance(a, dict)
    ]
    actions.sort(key=lambda x: x.priority)

    # Filtro cirúrgico: só BLOCKERs viram ação. MAJOR/MINOR ficam de fora
    # (evita loop de refatoração — precedente OrienteMe V4).
    actions = [a for a in actions if a.severity == "BLOCKER"]

    # Cap absoluto de MAX_ACTIONS_PER_ITER — evita over-planning.
    if len(actions) > MAX_ACTIONS_PER_ITER:
        logger.warning(
            f"[Cyborg V2] Consolidador retornou {len(actions)} ações, capando em {MAX_ACTIONS_PER_ITER} "
            f"(BLOCKERs remanescentes ficam para próxima iteração)."
        )
        actions = actions[:MAX_ACTIONS_PER_ITER]

    # Se após filtro não sobra ação, força veredito de aprovação
    verdict = obj.get("verdict", "REQUER_CORRECAO")
    if not actions and verdict != "IMPOSSIVEL_ENTREGAR":
        verdict = "APROVADO_SEM_MUDANCAS"

    return ConsolidatedPlan(
        verdict=verdict,
        summary=obj.get("summary", ""),
        actions=actions,
        estimated_iterations=int(obj.get("estimated_iterations", 1)),
    )


# ── Fase 3: Correção via Claude Code CLI ─────────────────────────────────────

def _spawn_claude_code(project_id: str, prod_id: str | None, action: Action, model_id: str) -> dict:
    """Invoca Claude Code CLI no host via full-test-server.

    FT-18 fix (2026-07-03, auditoria adversarial): carrega fixer_bridge.md como
    system prompt do Claude Code — antes o arquivo era escrito mas nunca chegava
    ao Opus. As regras anti-refactor (proibido reescrever, regra dos 100%,
    anti-padrão OrienteMe V4) precisam estar no --append-system-prompt.
    """
    try:
        fixer_system = _load_prompt("fixer_bridge")
    except Exception as e:
        logger.warning(f"[Cyborg V2] fixer_bridge.md não carregou: {e}")
        fixer_system = ""

    payload = {
        "project_id": project_id,
        "prod_id": prod_id,
        "action_id": action.id,
        "system_prompt": fixer_system,   # F1: filosofia anti-refactor via --append-system-prompt
        "prompt": (
            f"# Ação: {action.id}\n"
            f"## Objetivo\n{action.goal}\n\n"
            f"## Instruções\n{action.instructions}\n\n"
            f"## Verificação\nApós aplicar, execute: `{action.verify_command}`\n"
            f"Success = {action.success_criteria}\n\n"
            f"REGRAS CRÍTICAS (sistema já as recebeu — reforço):\n"
            f"1. Rode `{action.verify_command}` PRIMEIRO, sem tocar em nada. Se PASSAR → última linha: STATUS: SUCCESS. Fim.\n"
            f"2. Se falhar, faça a MENOR mudança possível. NÃO mova arquivos/pastas. NÃO renomeie. NÃO refatore estilo.\n"
            f"3. NÃO edite arquivos que a Ação não mencionou.\n"
            f"4. Última linha OBRIGATÓRIA: STATUS: SUCCESS|FAILED|PARTIAL"
        ),
        "model_id": model_id,
        "timeout": FIX_TIMEOUT,
        "verify_command": action.verify_command,
    }
    status, text = _http("POST", f"{FTS_URL}/cyborg-claude-code", payload, timeout=FIX_TIMEOUT + 60)
    if status != 200:
        return {"status": "FAILED", "error": f"FTS returned {status}: {text[:500]}"}
    try:
        return json.loads(text)
    except Exception:
        return {"status": "FAILED", "raw": text[:2000]}


def apply_actions(project_id: str, tenant_id: str | None, prod_id: str | None, plan: ConsolidatedPlan) -> list[dict]:
    """Aplica cada action; retorna lista de resultados. Comunica progresso ao usuário via dialogue."""
    model_id, _ = _resolve_cyborg_model(tenant_id)
    results: list[dict] = []
    total = len(plan.actions)

    _post_dialogue(project_id,
        f"🔧 Iniciando aplicação de {total} correção{'ões' if total != 1 else ''} via Claude Code CLI (Opus).")

    for idx, action in enumerate(plan.actions, start=1):
        _post_dialogue(project_id,
            f"[{idx}/{total}] {action.id} · {action.severity} · em andamento: {action.goal[:120]}")
        logger.info(f"[Cyborg V2] Aplicando {action.id}: {action.goal}")
        t0 = time.time()
        r = _spawn_claude_code(project_id, prod_id, action, model_id)
        r["action_id"] = action.id
        dur = int(time.time() - t0)
        results.append(r)
        status = r.get('status', '?')
        icon = {"SUCCESS": "✓", "FAILED": "✗", "PARTIAL": "◐"}.get(status, "?")
        _post_dialogue(project_id, f"[{idx}/{total}] {action.id} → {icon} {status} ({dur}s)")

    ok = sum(1 for r in results if r.get('status') == 'SUCCESS')
    fail = sum(1 for r in results if r.get('status') == 'FAILED')
    partial = sum(1 for r in results if r.get('status') == 'PARTIAL')
    _post_dialogue(project_id,
        f"🔧 Correções aplicadas — {ok} ✓ · {partial} ◐ · {fail} ✗ de {total}. "
        f"Vou re-auditar para confirmar se os blockers foram resolvidos.")
    return results


# ── Fase 5: Deploy S3 automático ─────────────────────────────────────────────

def deploy_to_s3(project_id: str) -> dict:
    """Chama /deploy/ephemeral com consented=true. Aguarda até running ou timeout."""
    _post_dialogue(project_id, "☁️ Cyborg — publicando no S3 (deploy automático)…")
    data, status = _api("POST", f"/api/projects/{project_id}/deploy/ephemeral",
                       {"ttlDays": 7, "consented": True}, timeout=30)
    if status not in (200, 202):
        return {"ok": False, "error": f"deploy launch: HTTP {status} — {str(data)[:400]}"}

    deployment_id = data.get("deploymentId") if isinstance(data, dict) else None
    if not deployment_id:
        return {"ok": False, "error": f"resposta sem deploymentId: {data}"}

    # Polling até 6 min
    for i in range(72):
        time.sleep(5)
        r, _ = _api("GET", f"/api/projects/{project_id}/deploy/ephemeral/active", timeout=10)
        if not isinstance(r, dict) or not r.get("deployment"):
            continue
        st = r["deployment"].get("status")
        if st in ("running", "running_degraded"):
            return {
                "ok": True,
                "app_url": r["deployment"].get("appUrl"),
                "status": st,
                "deployment_id": deployment_id,
            }
        if st == "failed":
            return {"ok": False, "error": "deploy status=failed", "deployment_id": deployment_id}

    return {"ok": False, "error": "deploy timeout (~6min)", "deployment_id": deployment_id}


# ── Fase 6: Aceite / Relatório ────────────────────────────────────────────────

def _accept(project_id: str, evidence: str) -> bool:
    data, status = _api("POST", f"/api/projects/{project_id}/accept",
                       {"acceptedBy": "cyborg-v2", "evidence": evidence}, timeout=30)
    if status in (200, 202, 204):
        return True
    logger.error(f"[Cyborg V2] /accept falhou {status}: {data}")
    return False


def _reject_with_report(project_id: str, report: str) -> None:
    """Não usa /reject: registra relatório rico em docs/ e dialogue, sem marcar rejeitado.
    Filosofia: Cyborg V2 não rejeita — informa motivo real para humano decidir."""
    _post_dialogue(project_id, f"⚠️ Cyborg V2 — não conseguiu entregar automaticamente. Relatório:\n{report[:3000]}")
    # Grava relatório em docs/cyborg/
    try:
        root = Path(PROJECT_FILES) / project_id / "docs" / "cyborg"
        root.mkdir(parents=True, exist_ok=True)
        (root / "final_report.md").write_text(report, encoding="utf-8")
    except Exception as e:
        logger.warning(f"[Cyborg V2] Falha ao gravar final_report.md: {e}")


# ── Orquestrador ─────────────────────────────────────────────────────────────

def run_cyborg_v2(project_id: str, tenant_id: str | None, prod_id: str | None) -> CyborgRun:
    """Ponto de entrada — executa o fluxo completo."""
    model_id, fallback_id = _resolve_cyborg_model(tenant_id)
    run = CyborgRun(
        project_id=project_id, tenant_id=tenant_id, prod_id=prod_id,
        started_at=time.time(), model_id=model_id, model_id_fallback=fallback_id,
    )

    _post_dialogue(project_id,
        f"═══════════════════════════════════════\n"
        f"🤖 Cyborg V2 assumiu o produto para lapidação e entrega\n"
        f"═══════════════════════════════════════\n"
        f"Modelo: {model_id} (fallback: {fallback_id})\n"
        f"Como trabalho: audito o produto em 5 dimensões, corrijo bloqueios via Claude Code, republico no S3 e aceito.\n"
        f"Se estagnar (2 rodadas sem progresso), paro e informo o motivo real para você decidir.\n"
        f"Máx iterações: {MAX_ITERATIONS}.")

    prev_blocker_count = None
    stagnation_streak = 0

    for iteration in range(1, MAX_ITERATIONS + 1):
        if iteration == 1:
            _post_dialogue(project_id, f"▶ Iteração 1/{MAX_ITERATIONS} — auditoria inicial")
        else:
            _post_dialogue(project_id,
                f"🔄 Iteração {iteration}/{MAX_ITERATIONS} — {prev_blocker_count or '?'} bloqueio{'s' if (prev_blocker_count or 0) != 1 else ''} restante{'s' if (prev_blocker_count or 0) != 1 else ''}. "
                f"Vou reauditar e aplicar novas correções.")
        it_record = {"iteration": iteration, "started_at": time.time()}

        # 1. Auditoria paralela
        analyses = run_analyses(project_id, tenant_id, prod_id)
        it_record["analyses"] = {name: {"ok": ar.ok, "score": ar.score, "findings_count": len(ar.findings)}
                                 for name, ar in analyses.items()}
        total_blockers = sum(
            sum(1 for f in ar.findings if f.severity == "BLOCKER")
            for ar in analyses.values()
        )
        it_record["blockers"] = total_blockers

        # Detecção de estagnação: se o número de BLOCKERs não cai por N iterações consecutivas,
        # o Cyborg está travado e precisa do humano.
        if prev_blocker_count is not None and total_blockers >= prev_blocker_count and total_blockers > 0:
            stagnation_streak += 1
        else:
            stagnation_streak = 0
        prev_blocker_count = total_blockers

        # 2. Consolidação
        plan = consolidate(project_id, tenant_id, analyses)
        it_record["plan"] = {"verdict": plan.verdict, "actions_count": len(plan.actions), "summary": plan.summary}

        # Delta de bloqueios da iteração anterior (para o usuário ver progresso)
        delta_msg = ""
        if prev_blocker_count is not None and iteration > 1:
            diff = prev_blocker_count - total_blockers
            if diff > 0:
                delta_msg = f" · ⬇ {diff} resolvido{'s' if diff != 1 else ''} desde a iteração anterior"
            elif diff < 0:
                delta_msg = f" · ⬆ {abs(diff)} novo{'s' if abs(diff) != 1 else ''} (regressão)"
            else:
                delta_msg = f" · = sem redução"

        verdict_labels = {
            "APROVADO_SEM_MUDANCAS": "✅ Aprovado sem mais correções",
            "REQUER_CORRECAO":        f"🔧 Requer {len(plan.actions)} correção{'ões' if len(plan.actions) != 1 else ''}",
            "IMPOSSIVEL_ENTREGAR":    "🛑 Impossível entregar automaticamente",
        }
        _post_dialogue(project_id,
            f"🎯 Iteração {iteration}: {verdict_labels.get(plan.verdict, plan.verdict)}{delta_msg}\n"
            f"{plan.summary[:400]}")

        # Se estagnou, escalar ao humano
        if stagnation_streak >= CONVERGE_WINDOW:
            run.final_status = "needs_human"
            run.final_report = (
                f"Cyborg V2 — estagnação detectada.\n\n"
                f"Após {iteration} iterações, o número de BLOCKERs não reduziu por {stagnation_streak} rodadas seguidas ({total_blockers} atuais).\n"
                f"Isso indica problema estrutural que não pode ser resolvido no nível de código.\n\n"
                f"Última síntese: {plan.summary[:800]}\n\n"
                f"Ações que foram tentadas mas não convergiram: {[a.id for a in plan.actions[:5]]}\n\n"
                f"Recomendação: revisar spec ou backlog upstream — pode haver contradição ou requisito impossível."
            )
            run.iterations.append(it_record)
            _post_dialogue(project_id,
                f"═══════════════════════════════════════\n"
                f"🛑 Cyborg V2 parou — precisa de intervenção humana\n"
                f"═══════════════════════════════════════\n"
                f"Motivo: estagnação após {iteration} iterações — {total_blockers} bloqueio{'s' if total_blockers != 1 else ''} não convergiu.\n"
                f"Relatório completo em: docs/cyborg/final_report.md\n"
                f"Sugestão: revisar spec ou backlog upstream — pode haver contradição.")
            _reject_with_report(project_id, run.final_report)
            return run

        # 3. Se aprovado sem mudanças → ACEITAR primeiro (muda status para accepted), depois deploy S3
        # FT-18 fix (2026-07-03): antes deploy vinha primeiro e falhava com HTTP 409 "só accepted/completed
        # podem publicar". Ordem correta: /accept → /deploy/ephemeral.
        if plan.verdict == "APROVADO_SEM_MUDANCAS":
            _post_dialogue(project_id,
                f"✅ Auditoria limpa — aceitando o produto e publicando no S3.")

            # 3a. Aceitar o projeto
            evidence_pre = _build_evidence(run, iteration, analyses, plan, {"app_url": "pending", "status": "pending"})
            accept_ok = _accept(project_id, evidence_pre)
            if not accept_ok:
                run.final_status = "needs_human"
                run.final_report = f"Auditoria aprovada mas /accept falhou. Aceitar manualmente no portal."
                run.iterations.append(it_record)
                _post_dialogue(project_id,
                    f"═══════════════════════════════════════\n"
                    f"⚠️ Cyborg V2 — auditoria aprovada, aceite manual necessário\n"
                    f"═══════════════════════════════════════\n"
                    f"Endpoint /accept falhou. Clique em 'Aceitar' no portal.")
                _reject_with_report(project_id, run.final_report)
                return run

            # 3b. Aguardar transição de status (pending_cyborg → accepted)
            time.sleep(3)

            # 3c. Deploy S3
            deploy = deploy_to_s3(project_id)
            it_record["deploy"] = deploy
            if deploy.get("ok"):
                run.s3_url = deploy["app_url"]
                run.final_status = "accepted"
                # Atualizar evidence com URL S3 real
                evidence_full = _build_evidence(run, iteration, analyses, plan, deploy)
                run.final_report = evidence_full
                run.iterations.append(it_record)
                _elapsed = int(time.time() - run.started_at)
                _post_dialogue(project_id,
                    f"═══════════════════════════════════════\n"
                    f"🎉 Cyborg V2 concluiu com sucesso!\n"
                    f"═══════════════════════════════════════\n"
                    f"✅ Produto aceito e publicado em S3\n"
                    f"🌐 URL: {run.s3_url}\n"
                    f"⏱️ Duração total: {_elapsed // 60} min {_elapsed % 60}s\n"
                    f"🔄 Iterações: {iteration}\n"
                    f"🤖 Modelo: {run.model_id}\n"
                    f"📄 Relatório: docs/cyborg/final_report.md")
                return run
            # Deploy falhou (produto já aceito)
            run.final_status = "accepted"
            run.final_report = f"Produto ACEITO mas deploy S3 falhou: {deploy.get('error', 'desconhecido')}. Tentar deploy manual pelo portal."
            run.iterations.append(it_record)
            _post_dialogue(project_id,
                f"═══════════════════════════════════════\n"
                f"⚠️ Cyborg V2 — auditoria aprovada, deploy S3 falhou\n"
                f"═══════════════════════════════════════\n"
                f"Motivo: {deploy.get('error', 'desconhecido')}\n"
                f"O código está pronto no repo GitHub. Tentar deploy manual pelo portal.")
            _reject_with_report(project_id, run.final_report)
            return run

        if plan.verdict == "IMPOSSIVEL_ENTREGAR":
            run.final_status = "needs_human"
            run.final_report = f"Cyborg V2 — impossível entregar automaticamente.\n\n{plan.summary}\n\nAções bloqueantes: {len(plan.actions)}"
            run.iterations.append(it_record)
            _post_dialogue(project_id,
                f"═══════════════════════════════════════\n"
                f"🛑 Cyborg V2 identificou impossibilidade\n"
                f"═══════════════════════════════════════\n"
                f"{plan.summary[:400]}\n"
                f"Relatório completo em: docs/cyborg/final_report.md")
            _reject_with_report(project_id, run.final_report)
            return run

        # 4. REQUER_CORRECAO → aplicar ações
        results = apply_actions(project_id, tenant_id, prod_id, plan)
        it_record["fixes"] = results
        run.iterations.append(it_record)

        # Continua para próxima iteração

    # Esgotou iterações
    run.final_status = "needs_human"
    run.final_report = (
        f"Cyborg V2 — {MAX_ITERATIONS} iterações esgotadas sem aprovação limpa.\n\n"
        f"Última síntese: {(run.iterations[-1].get('plan') or {}).get('summary', '(sem summary)')[:600]}\n\n"
        f"Sugestão: revisar spec/backlog. Há problemas estruturais que o Cyborg não pode resolver sozinho."
    )
    _elapsed = int(time.time() - run.started_at)
    _post_dialogue(project_id,
        f"═══════════════════════════════════════\n"
        f"⚠️ Cyborg V2 esgotou {MAX_ITERATIONS} iterações\n"
        f"═══════════════════════════════════════\n"
        f"Duração total: {_elapsed // 60} min\n"
        f"O produto ainda tem bloqueios que não convergiram automaticamente.\n"
        f"Sugestão: revisar spec ou backlog upstream — pode haver contradição estrutural.\n"
        f"Relatório completo em: docs/cyborg/final_report.md")
    _reject_with_report(project_id, run.final_report)
    return run


def _build_evidence(run: CyborgRun, iteration: int, analyses: dict[str, AnalysisResult],
                    plan: ConsolidatedPlan, deploy: dict) -> str:
    lines = [
        f"# Cyborg V2 — Aceite",
        f"",
        f"Modelo: {run.model_id} (fallback: {run.model_id_fallback})",
        f"Iterações consumidas: {iteration}",
        f"Deploy S3: {deploy.get('app_url', '?')}",
        f"",
        f"## Auditoria final (5 análises paralelas)",
    ]
    for name, ar in analyses.items():
        lines.append(f"- {name}: score={ar.score}/10, findings={len(ar.findings)}, ok={ar.ok}")
    lines += [
        f"",
        f"## Plano consolidado",
        f"Veredito: {plan.verdict}",
        f"Ações aplicadas: {len(plan.actions)}",
        f"",
        f"## Deploy S3",
        f"URL: {deploy.get('app_url')}",
        f"Status: {deploy.get('status')}",
        f"Deployment ID: {deploy.get('deployment_id')}",
    ]
    return "\n".join(lines)
