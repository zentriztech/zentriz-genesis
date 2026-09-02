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


def _salvage_artifacts_from_truncated(resp: str) -> list[dict]:
    """Recupera artifacts COMPLETOS de um JSON de rework truncado (achado #30-bis).

    O rework pede TODOS os arquivos num único JSON {"artifacts":[{path,content},...]}.
    Com muitos/grandes arquivos + thinking, a resposta trunca no meio de um `content`
    (`Unterminated string`) e `json.loads` falha → ANTES perdíamos TUDO, inclusive os N
    arquivos que vieram completos antes do corte. Aqui varremos objeto-a-objeto e coletamos
    só os `{path, content}` que fecham corretamente, descartando o último (truncado).

    Estratégia: localizar o array "artifacts", então usar json.JSONDecoder.raw_decode
    iterativamente a partir de cada `{`, acumulando os objetos que decodificam sem erro.
    """
    import re as _re
    # Achado #34 (2026-08-10): strict=False tolera caracteres de controle CRUS (newline/tab
    # literais) dentro de valores string — os modelos às vezes emitem o conteúdo do arquivo com
    # quebras de linha reais em vez de \n escapado. Com o decoder strict (default), isso dá
    # "Invalid control character at char N" e o artifact era PERDIDO (rodada 3 do SPEC-20 perdeu
    # style-dictionary.config.mjs). strict=False aceita e mantém o conteúdo íntegro.
    _dec = json.JSONDecoder(strict=False)
    # Recorta a partir do início do array de artifacts (tolera fence e prosa).
    _key = resp.find('"artifacts"')
    _scan_from = resp.find("[", _key) if _key != -1 else resp.find("[")
    if _scan_from == -1:
        return []
    out: list[dict] = []
    i = _scan_from + 1
    n = len(resp)
    while i < n:
        # avança até o próximo '{' de objeto
        while i < n and resp[i] not in "{]":
            i += 1
        if i >= n or resp[i] == "]":
            break
        try:
            obj, end = _dec.raw_decode(resp, i)
        except Exception:
            # objeto truncado (o último) — paramos; o que já coletamos é válido
            break
        if isinstance(obj, dict) and obj.get("path") and isinstance(obj.get("content"), str):
            out.append({"path": obj["path"], "content": obj["content"]})
        i = end
    return out


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _http(method: str, url: str, body: dict | None = None, timeout: int = 60) -> tuple[int, str]:
    import urllib.request
    import urllib.error
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"}
    if API_TOKEN:
        headers["Authorization"] = f"Bearer {API_TOKEN}"
    if os.environ.get("FTS_AUTH_TOKEN"):
        headers["X-FTS-Token"] = os.environ["FTS_AUTH_TOKEN"]
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
    #
    # Achado #36: a lista-allowlist fixa era ESTREITA — não continha `style-dictionary.config.mjs`
    # (nem qualquer `*.config.*`/`*.mjs`/`*.cjs` de raiz). Um teste importava
    # `../../style-dictionary.config.mjs` (existe, build_rc=0), mas como o arquivo NÃO aparecia
    # no apps_tree, o auditor A3 alucinava "arquivo não existe → build quebra" (BLOCKER falso,
    # família #27/#29 — reprova artefato que o revisor não vê). Fix: além da allowlist, varrer
    # TODOS os arquivos NÃO-diretório na raiz de apps/ (config/manifesto/qualquer .mjs/.cjs/.json
    # de raiz) — sem descer em subpastas (src/** já vem por _all_src). Dedup via set.
    _root_files: list = []
    if _apps_root.exists():
        _seen_root: set = set()
        for _cfg in ("package.json", "tsconfig.json", "tsconfig.test.json", "tsup.config.ts",
                     "vitest.config.ts", "Dockerfile", ".eslintrc.js", "eslint.config.js",
                     "app.config.ts", "eas.json", "README.md"):
            _p = _apps_root / _cfg
            if _p.exists():
                _root_files.append(_p); _seen_root.add(_p.name)
        # Varredura genérica da RAIZ de apps/ (não-recursiva): qualquer arquivo de config/build
        # que o allowlist não previu (ex.: style-dictionary.config.mjs, *.config.cjs, metro.config.js).
        try:
            for _p in sorted(_apps_root.iterdir()):
                if _p.is_file() and _p.name not in _seen_root and not _p.name.startswith("."):
                    if _p.suffix in (".mjs", ".cjs", ".js", ".ts", ".json", ".yml", ".yaml", ".toml") \
                       or ".config." in _p.name or _p.name.endswith("rc"):
                        _root_files.append(_p); _seen_root.add(_p.name)
        except Exception:
            pass
    _tree_paths = sorted(str(p.relative_to(proj_dir)) for p in (_root_files + _all_src))
    _apps_tree = "\n".join(_tree_paths)[:6000] if _tree_paths else ""

    # Amostra de código real. achado #47 (camada 2): com apenas 6 arquivos @1500 chars,
    # o a2_fidelidade_spec NUNCA via os fontes que implementam os FRs (sync/, publishing/
    # rollback, etc. — alfabeticamente tardios) e BLOQUEAVA "não há trecho que comprove
    # FR-X" mesmo com o arquivo existindo. Ampliado: mais arquivos, mais chars/arquivo,
    # e ORDEM por relevância (controllers/services carregam o comportamento a auditar).
    def _read_first(patterns: list[str], n: int = 20, per_file: int = 4000,
                    budget: int = 50000) -> str:
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
            entry = f"### {f.relative_to(proj_dir)}\n```\n{_read(f, per_file)}\n```"
            if total + len(entry) > budget or len(parts) >= n:
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
        # Amostra de fontes reais — PRIORIZA controllers/services (comportamento que o
        # a2 precisa ler p/ certificar FRs), depois main/module, depois o resto (#47 c2).
        "source_sample": _read_first(
            ["*.controller.ts", "*.service.ts", "main.ts", "*.module.ts",
             "index.ts", "index.tsx", "*.ts", "*.tsx"]),
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
            # Achado #35: muitas ferramentas de build (ex.: Style Dictionary) ESCONDEM o
            # detalhe acionável atrás de um flag de verbosidade e só imprimem um resumo
            # inútil ("Some token references (15) could not be found. Use log.verbosity
            # 'verbose' for more details."). Esse resumo, repassado ao rework (achado #32),
            # não diz QUAIS refs/colisões consertar → o Dev corrige às cegas. Se o build
            # falhou E o output pede verbose, re-roda UMA vez com verbosidade escalada
            # (env + `-- --verbose`) e ANEXA o detalhe. Puramente aditivo: só dispara em
            # falha + hint; se nada mudar, não faz mal.
            _bo_low = (ctx.get("build_output") or "").lower()
            _needs_verbose = _bd.returncode not in (0, -1) and (
                "verbosity" in _bo_low or "verbose" in _bo_low
                or "for more details" in _bo_low or "--verbose" in _bo_low)
            if _needs_verbose:
                _vout = ""
                # (a) Caso Style Dictionary: o build costuma ser um `node -e` que instancia
                # `new StyleDictionary(config)` SEM `log.verbosity`, então env/CLI NÃO chegam
                # à lib (verificado ao vivo no SPEC-20). O único jeito de extrair QUAIS refs
                # colidem/faltam é importar o próprio config do projeto e injetar
                # `log.verbosity='verbose'`. Descobrimos o config e o export usado no script.
                try:
                    import glob as _glob
                    _sd_cfgs = _glob.glob(str(_apps_root / "**" / "style-dictionary.config.*"), recursive=True)
                    if _sd_cfgs and ("style" in _bo_low or "token" in _bo_low or "reference" in _bo_low):
                        _cfg_abs = _sd_cfgs[0]
                        _cfg_rel = os.path.relpath(_cfg_abs, str(_apps_root)).replace(os.sep, "/")
                        if not _cfg_rel.startswith("."):
                            _cfg_rel = "./" + _cfg_rel
                        # Import * e roda buildAllPlatforms em CADA export que pareça um config,
                        # com verbosity forçada — captura colisões + refs faltantes por nome.
                        _probe = (
                            f"import * as _m from '{_cfg_rel}';"
                            "import SD from 'style-dictionary';"
                            "for (const [k,v] of Object.entries(_m)) {"
                            "  if (!v || typeof v!=='object' || (!v.platforms && !v.source && !v.tokens)) continue;"
                            "  try { const sd=new SD({...v, log:{verbosity:'verbose',warnings:'warn'}});"
                            "    await sd.buildAllPlatforms(); }"
                            "  catch(e){ console.error('### '+k+':\\n'+(e&&e.message||e)); } }")
                        _vp = _sp.run(["node", "--input-type=module", "-e", _probe],
                                      cwd=str(_apps_root), capture_output=True, text=True, timeout=180, env=_env)
                        _vout = (_vp.stdout + _vp.stderr)
                except Exception as _ve:
                    logger.warning(f"[Cyborg V3] probe verbose Style Dictionary falhou (ignorado): {_ve}")
                # (b) Fallback genérico p/ ferramentas que honram env/CLI de verbosidade.
                if not (_vout and "collision" in _vout.lower() or "could not" in _vout.lower()):
                    try:
                        _venv = {**_env, "VERBOSE": "1", "SD_VERBOSITY": "verbose",
                                 "STYLE_DICTIONARY_LOG_VERBOSITY": "verbose"}
                        _vbd = _sp.run(["npm", "run", "build", "--if-present", "--", "--verbose"],
                                       cwd=str(_apps_root), capture_output=True, text=True, timeout=600, env=_venv)
                        _gen = (_vbd.stdout + _vbd.stderr)
                        if len(_gen.strip()) > len(_vout.strip()):
                            _vout = _gen
                    except Exception as _ve:
                        logger.warning(f"[Cyborg V3] re-run verbose genérico falhou (ignorado): {_ve}")
                # Só anexa se o verbose trouxe MAIS sinal que o resumo original.
                if _vout and len(_vout.strip()) > len((ctx.get("build_output") or "").strip()):
                    ctx["build_output"] = (
                        (ctx.get("build_output") or "")
                        + "\n\n## DETALHE VERBOSE (re-run — refs/colisões ESPECÍFICAS a corrigir):\n"
                        + _vout)[-6000:]
                    logger.info("[Cyborg V3] detalhe verbose capturado (+%d chars) — rework agora vê os nomes", len(_vout))
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
    # achado #47 (camada 2): 45000 não cabia evidência de build + árvore + spec +
    # source_sample dos arquivos que implementam os FRs. Com a serialização por
    # prioridade (abaixo), a evidência pequena/decisiva sempre entra; ampliamos o teto
    # p/ ~100KB (≈25K tokens de INPUT — trivial p/ Claude; o risco de saída vazia do #12
    # era o budget de OUTPUT, hoje em 16000) para caber também o source_sample maior.
    _ctx_cap = int(os.environ.get("CYBORG_ANALYSIS_CTX_CHARS", "100000"))
    # achado #47 (sistêmico): o corte cru `json.dumps(ctx)[:_ctx_cap]` descartava
    # exatamente as chaves inseridas POR ÚLTIMO no ctx — `build_output`, `type_check_output`,
    # `build_rc`, `type_check_rc` (adicionadas depois do build, linhas ~342-368) e, quando o
    # ctx é grande, também o `apps_tree`. Só `spec`(~19KB) + `engineer_architecture`(~7.5KB) +
    # `source_sample`(~20KB) já estouram 45KB, então tudo depois deles sumia. Consequência:
    #   • a3_build_runtime BLOQUEAVA com "build_output/type_check_output não fornecidos"
    #     (embora o ctx os tivesse) → BLOCKER fantasma que nenhum rework conserta;
    #   • a2_fidelidade_spec BLOQUEAVA com "módulo `sync/` não existe" (ele EXISTE no
    #     apps_tree — que foi cortado) → BLOCKER fantasma → nunca converge (raiz do #45).
    # Os 4 backends menores couberam sob 45KB; o content-svc (maior spec) transbordava.
    # Fix: serializar com PRIORIDADE — evidência pequena e decisiva primeiro (build, árvore
    # de arquivos, configs, type_policy, charters), e só então os campos narrativos grandes
    # (spec, source_sample, types), que passam a absorver o corte sem matar a evidência.
    _PRIORITY = [
        "project_id",
        "build_rc", "type_check_rc", "build_output", "type_check_output",
        "apps_tree",
        "package_json", "tsconfig", "tsup_config",
        "type_policy",
        "cto_charter", "engineer_architecture", "pm_backlog",
        "spec",
        "root_page", "layout", "app_shell", "sidebar", "all_pages",
        "source_sample", "types",
    ]
    _ordered: dict = {}
    for _k in _PRIORITY:
        if _k in ctx:
            _ordered[_k] = ctx[_k]
    for _k, _v in ctx.items():  # chaves não previstas na lista vão ao fim (menos as internas _*)
        if _k not in _ordered and not _k.startswith("_"):
            _ordered[_k] = _v
    body = {
        "prompt_override": prompt,
        "user_message": json.dumps({"context": _ordered}, ensure_ascii=False)[:_ctx_cap],
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

    # Achado #36-b: guarda DETERMINÍSTICA p/ projetos HEADLESS (sem superfície de usuário).
    # A4 (UX completude) audita "home renderiza / screenshots / DOM" — categoricamente N/A p/
    # lib_ts, lib_cli, lib_plugin, backend_*, infra_cicd, bot_scraper. O auditor A4, mesmo
    # reconhecendo no texto que "é uma lib sem UI", ainda emitia BLOCKER por screenshots
    # ausentes → reprovava lib íntegra por não ter tela (família do viés-frontend, achado #9).
    # Mitigação de prompt é frouxa (achado #33) → neutralizamos A4 no código: para tipo
    # headless, rebaixa BLOCKERs de A4 a MINOR e força score>=8. NÃO mexe em A1/A2/A3/A5.
    try:
        _ct = ((ctx.get("type_policy") or {}).get("canonical_type") or "").strip()
        _HEADLESS = {"lib_ts", "lib_cli", "lib_plugin", "backend_api", "backend_api_nestjs",
                     "backend_api_python", "backend_graphql", "backend_worker", "infra_cicd",
                     "bot_scraper"}
        _a4 = results.get("a4_ux_completude")
        if _ct in _HEADLESS and _a4 is not None:
            _downgraded = 0
            for _f in _a4.findings:
                if _f.severity == "BLOCKER":
                    _f.severity = "MINOR"
                    _f.description = ("[HEADLESS/{}: UX não se aplica — rebaixado de BLOCKER] ".format(_ct)
                                      + (_f.description or ""))
                    _downgraded += 1
            if _downgraded or _a4.score < 8:
                _a4.score = max(_a4.score, 8)
                _a4.ok = True
                logger.info("[Cyborg V3] tipo headless '%s' — A4/UX neutralizada: %d BLOCKER(s)→MINOR, score→%d",
                            _ct, _downgraded, _a4.score)
    except Exception as _he:
        logger.warning(f"[Cyborg V3] guarda headless A4 falhou (ignorado): {_he}")

    # ACHADO #37: guarda DETERMINÍSTICA de stack travada (fingerprint) no oráculo de aceite.
    # O T-08 fingerprint do runner é só 'warn' (POLICY_ENFORCEMENT_ENABLED global, unset→warn),
    # então o Dev pode construir a stack ERRADA task após task sem nada barrar. Real (SPEC-03):
    # spec trava NestJS 11 (tipo backend_api_nestjs, forbidden 'Express cru sem @nestjs'), mas o
    # serviço saiu 100% Express+Mongoose (zero @nestjs/*). O a2 do LLM rotulou como MAJOR, não
    # BLOCKER → não gateava. Pela lição do #33 (prompt é frouxo), enforçamos no CÓDIGO: se o tipo
    # canônico DEFINE tokens strong (stack travada) e a app montada não tem NENHUM deles (framework
    # inteiramente ausente) OU casa um forbidden_token, injeta BLOCKER real em a2. Não penaliza
    # ausência PARCIAL (1 token faltando ≠ framework errado) — só a ausência TOTAL, que é a
    # assinatura de "stack errada", não de "cobertura incompleta".
    try:
        _tp_fp = ctx.get("type_policy") or {}
        _ct_fp = (_tp_fp.get("canonical_type") or "").strip()
        _pol_fp = _tp_fp.get("policy") or {}
        _strong = (((_pol_fp.get("fingerprint") or {}).get("required_tokens") or {}).get("strong")) or []
        if _ct_fp and _strong:  # só tipos com stack travada (definem tokens strong)
            from orchestrator import type_fingerprint as _tfp
            _proj_dir_fp = ctx.get("_proj_dir")
            if _proj_dir_fp:
                _fpres = _tfp.check_fingerprint(_proj_dir_fp, _pol_fp)
                _miss = _fpres.get("missing_strong") or []
                _forb = _fpres.get("forbidden_found") or []
                # framework INTEIRAMENTE ausente = todos os strong faltando
                _all_missing = len(_miss) >= len(_strong) and len(_strong) > 0
                if _all_missing or _forb:
                    _a2 = results.get("a2_fidelidade_spec")
                    if _a2 is not None:
                        _why = []
                        if _all_missing:
                            _why.append(f"stack travada '{_ct_fp}' AUSENTE: 0 de {len(_strong)} "
                                        f"tokens strong presentes (faltam {_miss})")
                        if _forb:
                            _why.append(f"padrões PROIBIDOS presentes {_forb}")
                        _a2.findings.append(Finding(
                            severity="BLOCKER",
                            area="stack_violation",
                            description=("[STACK TRAVADA #37 — gate determinístico] O spec/charter fixa a "
                                         f"stack do tipo '{_ct_fp}', mas a app montada a viola: "
                                         + "; ".join(_why) + ". Reescreva na stack correta antes de aceitar."),
                            evidence=f"fingerprint: missing_strong={_miss} forbidden={_forb} "
                                     f"files={_fpres.get('details',{}).get('files_scanned')}",
                        ))
                        _a2.ok = False
                        _a2.score = min(_a2.score, 4)
                        logger.info("[Cyborg V3] stack travada '%s' VIOLADA — BLOCKER injetado em a2 "
                                    "(missing_strong=%s forbidden=%s)", _ct_fp, _miss, _forb)
    except Exception as _se:
        logger.warning(f"[Cyborg V3] guarda de stack travada falhou (ignorado): {_se}")

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


def _stitch_export_context(project_id: str, prod_id: str | None, ctx: dict) -> str:
    """Achado #45 (2026-08-11): erros TS2305 ('módulo não exporta membro') e TS2339
    ('propriedade não existe no tipo') são de CONTRATO cross-file — um lado importa/usa um
    nome que o outro lado não exporta/define. Confirmado ao vivo travando SPEC-02 (sync.controller
    ↔ dto/service) e SPEC-03 (common/index.ts barrel ↔ ../contracts; progress.module ↔ StoreService).

    O rework é stateless e regenera arquivos INTEIROS → re-dessincroniza os nomes a cada rodada
    (some um erro, aparece outro) e nunca alinha os DOIS lados ao mesmo tempo → build_rc=2
    persiste → gate inviolável #38 bloqueia. A escalação feature (#50/#50-bis) não cura porque o
    problema não é gap-de-feature (subsistema ausente) e sim COSTURA de export entre pares.

    Este helper faz o parse determinístico desses erros, RESOLVE o arquivo-alvo do export/símbolo
    faltante e devolve um bloco com o PAR de arquivos (importador + alvo) em conteúdo COMPLETO +
    a instrução cirúrgica de alinhar os dois lados na MESMA rodada. Vazio quando não há tais erros.
    """
    import re as _re
    blob = ((ctx.get("type_check_output") or "") + "\n" + (ctx.get("build_output") or ""))
    if not blob.strip():
        return ""
    # tsc pretty-print injeta códigos ANSI de cor (SPEC-02 tinha) — remover p/ o regex casar.
    blob = _re.sub(r"\x1b\[[0-9;]*m", "", blob)
    apps_root = _resolve_proj_dir(project_id, prod_id) / "apps"

    def _read_full(p: Path, cap: int = 6000) -> str | None:
        try:
            return p.read_text(encoding="utf-8", errors="replace")[:cap]
        except Exception:
            return None

    # TS2305 — dois formatos: "<file>(l,c): error TS2305:" e "<file>:l:c - error TS2305:"
    ts2305: dict = {}   # (src_rel, spec) -> set(members)
    for m in _re.finditer(
        r"([\w./\-]+\.tsx?)[\(:]\d+[,:]\d+\)?\s*:?\s*-?\s*error TS2305:\s*Module\s*'\"?([^'\"]+)\"?'\s*"
        r"has no exported member '([^']+)'", blob):
        ts2305.setdefault((m.group(1), m.group(2)), set()).add(m.group(3))

    # TS2339 — "Property '<name>' does not exist on type '<Type>'"
    ts2339: dict = {}   # src_rel -> set((name, type))
    for m in _re.finditer(
        r"([\w./\-]+\.tsx?)[\(:]\d+[,:]\d+\)?\s*:?\s*-?\s*error TS2339:\s*Property '([^']+)' "
        r"does not exist on type '([^']+)'", blob):
        ts2339.setdefault(m.group(1), set()).add((m.group(2), m.group(3)))

    if not ts2305 and not ts2339:
        return ""

    def _resolve_spec(src_rel: str, spec: str) -> Path | None:
        """Resolve um import specifier relativo p/ arquivo dentro de apps/. None se externo."""
        if not spec.startswith("."):
            return None
        base = (apps_root / src_rel).parent
        cand = (base / spec)
        try:
            cand = cand.resolve()
        except Exception:
            return None
        for suff in ("", ".ts", ".tsx", "/index.ts", "/index.tsx"):
            p = Path(str(cand) + suff)
            if p.is_file():
                return p
        return None

    included: set = set()
    parts: list = []
    for (src_rel, spec), members in ts2305.items():
        tgt = _resolve_spec(src_rel, spec)
        line = [f"- EM `{src_rel}` o import de `{spec}` referencia membro(s) que o alvo NÃO "
                f"exporta: {', '.join(sorted(members))}."]
        included.add(apps_root / src_rel)
        if tgt is not None:
            line.append(f"  → alvo resolvido: `{tgt.relative_to(apps_root)}` — ADICIONE/RENOMEIE lá "
                        "o(s) export(s) faltante(s) OU corrija o nome no import; alinhe os DOIS lados nesta rodada.")
            included.add(tgt)
        else:
            line.append(f"  → `{spec}` não resolve p/ arquivo em apps/ (pacote externo, ex.: "
                        "@zentriz/contracts). NÃO invente membros: corrija o import p/ os nomes REAIS do pacote.")
        parts.append("\n".join(line))

    for src_rel, pairs in ts2339.items():
        included.add(apps_root / src_rel)
        for name, typ in sorted(pairs):
            parts.append(f"- EM `{src_rel}` usa-se `.{name}` no tipo `{typ}`, que não possui esse membro. "
                         f"→ ADICIONE o método/propriedade `{name}` na definição de `{typ}` (ou corrija a "
                         "chamada); devolva ambos os arquivos.")
        # localizar o arquivo que DEFINE cada Type p/ incluir no contexto
        _src = apps_root / "src"
        for _n, typ in sorted(pairs):
            try:
                for f in _src.rglob("*.ts"):
                    if _re.search(r"\b(?:class|interface|type|abstract class)\s+" + _re.escape(typ) + r"\b",
                                  f.read_text(encoding="utf-8", errors="replace")):
                        included.add(f); break
            except Exception:
                pass

    files_block: list = []
    for p in sorted(included):
        c = _read_full(p)
        if c is None:
            continue
        try:
            rel = p.relative_to(apps_root)
        except Exception:
            rel = p.name
        files_block.append(f"### {rel}\n```\n{c}\n```")

    return (
        "\n## ⚠️ DESCOMPASSO DE EXPORT/TIPO CROSS-FILE (TS2305/TS2339) — COSTURA CIRÚRGICA OBRIGATÓRIA (achado #45)\n"
        "Estes erros de build são de CONTRATO entre arquivos: um lado importa/usa um nome que o outro "
        "lado não exporta/define. A correção CORRETA é ALINHAR OS DOIS LADOS na MESMA rodada "
        "(adicionar/renomear o export no alvo E/OU corrigir o nome no importador). NÃO regenere arquivos "
        "inteiros nem reescreva quem já compila — faça a MENOR edição que alinha os nomes. Devolva AMBOS "
        "os arquivos de cada par (importador + alvo) já alinhados.\n\n"
        "### Descompassos detectados:\n" + "\n".join(parts) +
        "\n\n### Conteúdo COMPLETO dos arquivos envolvidos (edite exatamente estes):\n" +
        "\n\n".join(files_block) + "\n"
    )


def _feature_integration_context(project_id: str, prod_id: str | None) -> str:
    """Achado #54 (2026-08-11): no modo feature (conclusão de subsistemas ausentes), o gargalo
    real NÃO é falta de criatividade do modelo — é que os subsistemas ADICIONADOS não COMPILAM,
    porque o Dev não enxerga os arquivos de INTEGRAÇÃO (onde registrar módulos, quais tipos de
    domínio consumir, como declarar dependências npm). Confirmado ao vivo no SPEC-03: as 5 rodadas
    feature ADICIONARAM código mas TODAS quebraram o build (build_ok=False) → best-tree restaurava
    o baseline verde de 4 BLOCKERs → nunca convergia. Falhas típicas: (a) usar uma lib externa
    (ts-fsrs, @nestjs/mongoose, cockatiel) sem adicioná-la ao package.json → o build roda
    `npm install` e o import falha; (b) criar um módulo novo e não registrá-lo em app.module.ts →
    rota/serviço inexistente em runtime; (c) reinventar shapes em vez de importar os canônicos.

    Este bloco entrega, em conteúdo COMPLETO, os arquivos-âncora de integração (package.json,
    app.module.ts, contracts/index.ts, tsconfig*) para o Dev fiar corretamente os subsistemas
    novos. É o análogo do #45 (costura de export) para o modo feature (costura de integração).
    """
    apps_root = _resolve_proj_dir(project_id, prod_id) / "apps"
    wanted = [
        "package.json",
        "tsconfig.json",
        "tsconfig.build.json",
        "src/app.module.ts",
        "src/contracts/index.ts",
    ]
    blocks: list = []
    for rel in wanted:
        p = apps_root / rel
        if not p.is_file():
            blocks.append(f"### {rel}\n```\n(NÃO EXISTE — crie se a spec exigir)\n```")
            continue
        cap = 3000 if rel.endswith(".json") and rel != "package.json" else 9000
        try:
            c = p.read_text(encoding="utf-8", errors="replace")[:cap]
        except Exception:
            continue
        blocks.append(f"### {rel}\n```\n{c}\n```")
    if not blocks:
        return ""
    return (
        "\n## 🧩 CONTEXTO DE INTEGRAÇÃO (âncoras — para os subsistemas novos COMPILAREM) — achado #54\n"
        "Os subsistemas que você adicionar SÓ contam se COMPILAREM e estiverem CONECTADOS. Regras "
        "duras de integração:\n"
        "1. **Dependências npm**: para usar QUALQUER lib externa que a spec exige (ex.: `ts-fsrs` p/ "
        "FSRS-6, `@nestjs/mongoose`+`mongoose` p/ persistência, `cockatiel` p/ circuit breaker), "
        "ADICIONE-a a `dependencies` no package.json NESTA rodada — o build roda `npm install`; "
        "importar sem declarar QUEBRA o build. Mantenha as deps já presentes.\n"
        "2. **Wiring**: todo módulo NestJS novo (ex.: PlacementModule) DEVE ser registrado em "
        "`src/app.module.ts` `imports:[...]` na MESMA rodada, senão a rota/serviço não existe.\n"
        "3. **Tipos de domínio**: importe os shapes canônicos de `src/contracts/index.ts` (e "
        "`@zentriz/contracts`) — NÃO reinvente enums/interfaces que já existem ali.\n"
        "4. **Não regenere** estes arquivos-âncora por inteiro nem apague o que já funciona — "
        "faça a MENOR alteração aditiva (novo import, nova entry em dependencies, novo provider).\n\n"
        "### Conteúdo COMPLETO dos arquivos-âncora atuais:\n" + "\n\n".join(blocks) + "\n"
    )


# Achado #55 (2026-08-12): DETECÇÃO DE DOMÍNIO INCOERENTE. Quando a fábrica constrói o domínio
# ERRADO (ex.: SPEC-02 content-svc virou um LMS/calendário genérico — Course.slug, Hour com
# dayOfWeek/startTime/endTime, ActivityItem tipo video/config — em vez do domínio ZVoices da spec:
# hierarquia canônica Course→Level→Book/Theme→Block→Lesson→Hour→ActivityItem, 18 ACTIVITY_ITEM_TYPES
# com discriminators, LocaleConfig, provenance/rights, marca ZVoices), o BUILD fica VERDE (o produto
# é coerente… com o domínio errado) mas a2_fidelidade_spec/a5_dominio BLOQUEIAM. O modo feature
# (achado #50) ADICIONA módulos periféricos corretos (sync/publishing) mas NUNCA substitui o núcleo
# errado, porque sua diretriz é "preserve tudo, nunca remova" → platô eterno (SPEC-02: 9 BLOCKER,
# build verde, esgota rework). A cura NÃO é patch (cirúrgico) nem add (feature): é REGENERAR o modelo
# de domínio central ancorado na spec canônica. Este helper detecta o sinal de domínio-errado.
_DOMAIN_INCOHERENCE_AREAS = {
    "wrong_domain_lexicon", "template_leftover", "mock_incoherent", "wrong_domain",
}
_DOMAIN_MISMATCH_MARKERS = (
    "não corresponde ao domínio", "domínio completamente diferente", "domínio errado",
    "em vez do domínio", "lms genérico", "não bate com o da spec", "hierarquia canônica",
    "domínio de um produto", "produto entregue é de um domínio",
)


def _domain_incoherence_findings(audit: dict) -> list:
    """Retorna os BLOCKERs que sinalizam DOMÍNIO ERRADO (não gap-de-feature, não build).

    Sinal FORTE: área ∈ _DOMAIN_INCOHERENCE_AREAS (wrong_domain_lexicon/template_leftover/
    mock_incoherent). Sinal por FIDELIDADE: BLOCKER de a2_fidelidade_spec/a5_dominio cuja descrição
    contém um marcador de descompasso de domínio. O chamador só usa isto no modo feature (após o
    cirúrgico esgotar) — o gate de build inviolável (#38) continua soberano em qualquer caso.
    """
    out: list = []
    for name, ar in (audit or {}).items():
        for f in getattr(ar, "findings", []) or []:
            if getattr(f, "severity", "") != "BLOCKER":
                continue
            _area = (getattr(f, "area", "") or "").lower()
            _desc = (getattr(f, "description", "") or "").lower()
            if _area in _DOMAIN_INCOHERENCE_AREAS:
                out.append(f)
            elif name in ("a2_fidelidade_spec", "a5_dominio") and any(
                    m in _desc for m in _DOMAIN_MISMATCH_MARKERS):
                out.append(f)
    return out


def autonomous_rework(project_id: str, prod_id: str | None, audit: dict, model_id: str,
                      max_rounds: int = 2, mode: str = "surgical") -> dict:
    """Correção AUTÔNOMA via /invoke/dev quando o engineer-bridge (Claude CLI) está ausente.

    Fecha o loop de qualidade sem depender do host de produção: pega os BLOCKERs/MAJORs da
    auditoria, pede ao agente Dev (Foundry) para corrigi-los, grava os artefatos retornados em
    apps/, e re-audita. Repete até 0 BLOCKER ou esgotar rounds. (achado #16)

    Dois modos (achado #50 — diretriz do Jean 2026-08-11: o Cyborg deve ENTREGAR, nunca
    estacionar em blocked_cyborg):
      - mode="surgical" (default): correção CIRÚRGICA — mexe só nos arquivos implicados, teto
        baixo de arquivos/rodada, modelo padrão. Converge sem regredir (achado #33), mas é
        estruturalmente INCAPAZ de adicionar subsistemas inteiros que a spec exige e que o Dev
        nunca gerou (ex.: offline WatermelonDB, 18 renderizadores de exercício, WebRTC LiveKit).
      - mode="feature": CONCLUSÃO DE FEATURE — quando o cirúrgico esgota com BLOCKERs de
        gap-de-feature REAIS, escala para o modelo maior (opus-5 no Foundry) AUTORIZADO a
        ADICIONAR arquivos/módulos inteiros p/ cumprir os FR/NFR faltantes, com grounding
        forte no contrato canônico (@zentriz/contracts) p/ não reinventar domínio (achado #48).
        O gate de não-regressão continua ativo (só entrega quem não piora o produto).

    Retorna {"ok": bool, "rounds": n, "final_audit": dict, "delivered": bool}.
    """
    from orchestrator.project_storage import write_apps_artifact
    proj_dir = _resolve_proj_dir(project_id, prod_id)
    cur_audit = audit

    def _count_blk(a: dict) -> int:
        return sum(sum(1 for f in getattr(ar, "findings", []) or [] if f.severity == "BLOCKER")
                   for ar in a.values())

    # Achado #52 (2026-08-11): o gate de não-regressão precisa ser BUILD-AWARE. build_rc==0/-1 é
    # "build ok"; qualquer outro rc é falha (mesma convenção do gate inviolável #38). Um estado que
    # COMPILA é estritamente melhor que um que NÃO compila, INDEPENDENTE da contagem bruta de
    # BLOCKERs — pois nenhum projeto é aceito com build_rc!=0 (#38). Ver comparação composta abaixo.
    def _bok(rc: int) -> bool:
        return rc in (0, -1)

    # Achado #33 (2026-08-10): GATE DE NÃO-REGRESSÃO. O Dev stateless às vezes conserta uma
    # dimensão e quebra outra (SPEC-20: rodada 2 chegou a build_rc=0 e a rodada 3 REGREDIU o
    # build de volta a rc=1, jogando fora o melhor estado). O prompt cirúrgico mitiga mas não
    # garante. Aqui tornamos o loop MONOTÔNICO segundo uma chave COMPOSTA (build_ok primário,
    # menos BLOCKERs secundário): se uma rodada piora essa chave vs. o melhor estado já visto,
    # revertemos os arquivos que a rodada escreveu (snapshot) e mantemos o melhor audit — o rework
    # nunca piora o produto, só melhora ou mantém.
    # Achado #52: a comparação só por contagem de BLOCKERs REVERTIA rodadas que consertavam o build
    # (SPEC-02: rodada que levou build_rc 1→0 subiu o total 11→14 pq dimensões de domínio/fidelidade
    # oscilaram, e o gate jogou fora o estado que COMPILA voltando ao que NÃO compila). Como build é
    # gate inviolável, priorizamos build_ok sobre a contagem.
    _best_blk = _count_blk(cur_audit)
    _best_build_ok = _bok(_cur_build_rc(project_id, prod_id))

    # Achado #56 (2026-08-12): a REGENERAÇÃO DE DOMÍNIO (#55) precisa de gate PRÓPRIO. O submodo
    # regen detecta "build VERDE mas DOMÍNIO ERRADO" e reescreve o núcleo — porém o gate composto
    # (build_ok, -blk) tratava a árvore VERDE-DE-DOMÍNIO-ERRADO do baseline como o "melhor" alvo de
    # restauração; como reescrever o núcleo quebra o build / sobe BLOCKERs transitoriamente, a
    # restauração final (mais abaixo) revertia TUDO de volta ao domínio-errado-verde — a cura era
    # desfeita a cada passe e NUNCA convergia (evidência #56: oscilação 13→19→16→22→17→18). Correção:
    # quando a regen ENGATA, a fidelidade de domínio passa a ser o eixo PRIMÁRIO do ranking (uma
    # árvore de domínio errado deixa de ser alvo válido de restauração); e se a regen nunca atingir
    # coerência de domínio, NÃO revertemos ao verde-errado — mantemos a tentativa de regen (domínio-
    # correto-em-progresso) p/ ESCALAR ao humano, nunca estacionar no produto errado
    # (feedback-cyborg-deve-entregar). Antes de a regen engatar, _rank reduz à chave LEGADA e todo o
    # comportamento cirúrgico/feature validado (#33/#52/#53/#50-bis) permanece byte-a-byte idêntico.
    _best_dom_ok = not bool(_domain_incoherence_findings(cur_audit))
    _regen_engaged = False

    def _rank(dom_ok: bool, build_ok, blk: int) -> tuple:
        _dom_axis = (1 if dom_ok else 0) if _regen_engaged else 0
        return (_dom_axis, 1 if build_ok else 0, -blk)

    # Achado #53 (2026-08-11): JANELA DE RECUPERAÇÃO DE BUILD (modo cirúrgico). Corrigir um BLOCKER
    # de domínio quase sempre altera um export/shape e QUEBRA o build dos importadores (TS2305/
    # TS2339), que só seriam costurados (#45) na rodada SEGUINTE. Como o gate #52 revertia todo
    # estado build-vermelho na hora, a costura #45 NUNCA chegava a disparar no modo cirúrgico (o
    # estado quebrado era descartado antes da próxima rodada enxergá-lo) → oscilação eterna
    # (SPEC-02/03: BLOCKERs caíam a cada rodada, o build quebrava e revertia, nada convergia). Aqui
    # abrimos uma JANELA: uma rodada que QUEBRA o build mas REDUZ BLOCKERs é MANTIDA por até N
    # rodadas p/ a costura #45 reparar o build; se a janela esgotar sem reparo, restauramos a melhor
    # árvore VERDE (nunca entregamos pior que o baseline — mesma garantia do #52).
    _recovery_max = int(os.environ.get("CYBORG_BUILD_RECOVERY_ROUNDS", "2"))
    _recovery_used = 0
    _best_tree_enabled = (mode == "feature") or _recovery_max > 0

    # Achado #50-bis (2026-08-11): o gate de não-regressão per-rodada (acima) é CORRETO para o
    # modo CIRÚRGICO, mas DEFEITUOSO para o modo FEATURE: adicionar um subsistema inteiro quase
    # sempre ELEVA os BLOCKERs transitoriamente (o módulo novo tem wiring/tipos pendentes) até a
    # rodada seguinte fiá-lo. Se revertermos per-rodada, jogamos fora TODA adição e a rodada 2
    # nunca enxerga os módulos da rodada 1 → a escalação nunca progride (SPEC-03: rodada 1 8→13,
    # revertida, entrega zero). Em FEATURE mode acumulamos as rodadas no disco (cumulativo) e
    # preservamos a MELHOR ÁRVORE cumulativa vista; ao final restauramos a melhor se o estado
    # final piorou — assim NUNCA entregamos pior que o baseline, mas permitimos a convergência
    # round-1-adiciona → round-2-fia.
    _feature_mode = (mode == "feature")
    _apps_dir = None
    _best_tree = None  # dir temporário com a melhor árvore apps/ (feature mode + recuperação #53)
    if _best_tree_enabled:
        import shutil as _shutil, tempfile as _tempfile
        _ft_ignore = _shutil.ignore_patterns("node_modules", "dist", ".git", "coverage", ".turbo", ".next")
        try:
            from orchestrator.project_storage import get_apps_dir as _get_apps_dir
            _apps_dir = _get_apps_dir(project_id)
        except Exception as _adx:
            logger.warning("[Cyborg rework/feature] get_apps_dir falhou: %s", _adx)

        def _snap_best_tree():
            nonlocal _best_tree
            if not (_apps_dir and _apps_dir.exists()):
                return
            try:
                _new = _tempfile.mkdtemp(prefix="cyborg_ft_best_")
                _shutil.copytree(str(_apps_dir), os.path.join(_new, "apps"), ignore=_ft_ignore)
                if _best_tree:
                    _shutil.rmtree(_best_tree, ignore_errors=True)
                _best_tree = _new
            except Exception as _snx:
                logger.warning("[Cyborg rework/feature] snapshot da melhor árvore falhou: %s", _snx)

        def _restore_best_tree():
            _src = os.path.join(_best_tree or "", "apps")
            if not (_apps_dir and _best_tree and os.path.isdir(_src)):
                return False
            try:
                for _e in list(_apps_dir.iterdir()):
                    if _e.name in ("node_modules", "dist"):
                        continue  # preserva install/build p/ não re-instalar
                    _shutil.rmtree(_e, ignore_errors=True) if _e.is_dir() else _e.unlink()
                for _n in os.listdir(_src):
                    _s = os.path.join(_src, _n)
                    _d = _apps_dir / _n
                    if os.path.isdir(_s):
                        _shutil.copytree(_s, str(_d), ignore=_ft_ignore)
                    else:
                        _shutil.copy2(_s, str(_d))
                return True
            except Exception as _rex:
                logger.warning("[Cyborg rework/feature] restauração da melhor árvore falhou: %s", _rex)
                return False

        _snap_best_tree()  # baseline (melhor estado cirúrgico) preservado

    # Achado #56: BUDGET DEDICADO DE REGEN. A regeneração de domínio precisa de rodadas p/ (1)
    # acertar o núcleo do domínio e (2) costurar o build (#45) de volta ao verde SOBRE o domínio
    # correto. Se a regen engata perto do fim do budget de feature, não sobra rodada p/ costurar e
    # ela termina domínio-correto-mas-vermelho (escalada, mas sem convergir). Estendemos o TETO de
    # rodadas assim que a regen engata, garantindo ao menos _regen_rounds rodadas a partir do
    # engate, até um limite de segurança. Fora da regen (cirúrgico / feature-sem-domínio-errado) o
    # teto permanece = max_rounds, comportamento validado inalterado.
    _regen_rounds = int(os.environ.get("CYBORG_DOMAIN_REGEN_ROUNDS", "5"))
    _round_cap = max_rounds
    rnd = 0
    while rnd < _round_cap:
        rnd += 1
        # Coletar findings acionáveis (BLOCKER + MAJOR) de todas as dimensões.
        findings = []
        for name, ar in cur_audit.items():
            for f in getattr(ar, "findings", []) or []:
                if f.severity in ("BLOCKER", "MAJOR"):
                    findings.append(f"[{f.severity}] {f.area}: {f.description}")
        if not findings:
            return {"ok": True, "rounds": rnd - 1, "final_audit": cur_audit, "delivered": True}

        # Achado #55: no modo feature, se a auditoria sinaliza DOMÍNIO ERRADO, esta rodada roda em
        # submodo REGENERAÇÃO DE MODELO (reescreve o núcleo do domínio p/ bater com a spec canônica)
        # em vez de só ADICIONAR módulos. Recalculado por rodada: quando o domínio já bate, o sinal
        # some e voltamos ao feature normal (concluir os gaps de feature restantes).
        _domain_regen = (mode == "feature") and bool(_domain_incoherence_findings(cur_audit))
        if _domain_regen:
            # Achado #56: a partir do momento em que a regen engata, o ranking passa a priorizar
            # fidelidade de domínio (ver _rank). Fica engatado até o fim deste rework — uma árvore
            # de domínio errado nunca mais volta a ser alvo válido de restauração.
            _regen_engaged = True
            # Budget dedicado: garante ≥ _regen_rounds rodadas a partir DESTE engate p/ acertar o
            # domínio + costurar o build, sem estourar o teto de segurança (max_rounds + _regen_rounds).
            _round_cap = min(max(_round_cap, rnd + _regen_rounds - 1), max_rounds + _regen_rounds)

        if mode == "feature":
            _post_dialogue(project_id,
                f"🚀 Cyborg — ESCALAÇÃO / conclusão de feature (rodada {rnd}/{_round_cap}): "
                f"{len(findings)} gap(s) de feature enviados ao modelo maior, autorizado a "
                f"ADICIONAR módulos inteiros para cumprir os FR/NFR faltantes.")
        else:
            _post_dialogue(project_id,
                f"🔧 Cyborg — correção autônoma (rodada {rnd}/{_round_cap}): {len(findings)} issue(s) "
                f"da auditoria enviadas ao Dev via Foundry.")

        # Ler os fontes atuais para dar contexto ao Dev.
        ctx = _collect_context(project_id, prod_id)
        # Achado #30-bis (2026-08-10): pedir "TODOS os arquivos completos" num único JSON
        # estoura o teto de tokens (thinking + N arquivos grandes) → JSON truncado. Agora
        # LIMITAMOS a quantidade de arquivos por rodada e priorizamos os BLOCKERs; as rodadas
        # 2/3 continuam de onde parou. Isso mantém o JSON dentro do orçamento e converge.
        _feature_mode = (mode == "feature")
        if _feature_mode:
            # Achado #50: modo CONCLUSÃO DE FEATURE. O cirúrgico já esgotou; os BLOCKERs
            # restantes são gaps de feature REAIS (subsistema/FR que o Dev nunca gerou). Aqui
            # o objetivo é o OPOSTO do cirúrgico: ADICIONAR os módulos inteiros que faltam.
            # Achado #51 (2026-08-11): mesmo com thinking desligado, ~2.8K tokens/arquivo × N
            # arquivos precisa caber em max_tokens (32000). 14 arquivos grandes estouram e o JSON
            # trunca. Baixado p/ 7 (≈20K tokens de saída, folga) — as 3 rodadas CUMULATIVAS do
            # modo feature (#50-bis) cobrem 7×3=21 arquivos, ≥ contagem típica de gaps. Completo
            # por rodada > truncado com muitos.
            _max_files = int(os.environ.get("CYBORG_ESCALATION_MAX_FILES_PER_ROUND", "9"))
            _fix_prompt = (
                "Você é um ENGENHEIRO SÊNIOR de produto. O rework cirúrgico já esgotou: os problemas "
                "abaixo são GAPS DE FEATURE REAIS — funcionalidades/requisitos (FR/NFR) que a spec exige "
                "e que o código atual NÃO implementa (subsistemas inteiros ausentes ou pela metade). "
                f"Sua missão é ENTREGAR essas features de forma COMPLETA e funcional, criando quantos "
                f"arquivos forem necessários (até {_max_files} nesta rodada; priorize um FR/subsistema "
                "por vez, do mais crítico ao menos). "
                # Diferente do cirúrgico: AQUI é permitido (e esperado) ADICIONAR módulos novos.
                "REGRA (conclusão de feature): você PODE e DEVE CRIAR arquivos/módulos/subsistemas novos "
                "para cumprir os FR/NFR faltantes (ex.: camada offline, renderizadores, integrações, "
                "serviços, DTOs). Entregue cada feature INTEIRA e coerente — módulo + serviço + tipos + "
                "wiring (registro no módulo/rota/injeção) — de modo que COMPILE e funcione de ponta a ponta; "
                "meia-implementação que não compila é PIOR que nada (o build é gate inviolável). "
                # Grounding de domínio (achado #48): não reinventar shapes.
                "GROUNDING DE DOMÍNIO (obrigatório): consuma os tipos/contratos canônicos do domínio "
                "(pacote @zentriz/contracts e os shapes definidos na spec/arquitetura) como fonte ÚNICA de "
                "verdade — NÃO invente shapes genéricos (ex.: não trate um serviço de conteúdo como blog/"
                "curso genérico; use exatamente as entidades e enums que a spec define). "
                # Preservação (não-regressão continua valendo via snapshot).
                "PRESERVE todo o comportamento já correto: não remova exports, funções, campos ou lógica "
                "que a spec exige e que já existem; ao tocar um arquivo existente, integre a nova feature "
                "sem apagar o que funciona. O objetivo é REDUZIR BLOCKERs, nunca reintroduzir um já resolvido. "
                # Achado #45: mesmo no modo feature, erros TS2305/TS2339 são costura de export cross-file.
                "SE houver a seção 'DESCOMPASSO DE EXPORT/TIPO CROSS-FILE (TS2305/TS2339)', trate-a ANTES "
                "de adicionar features novas: alinhe os DOIS lados (export no alvo + import no consumidor) "
                "na MESMA rodada e devolva AMBOS os arquivos do par. "
                # Achado #54: subsistema novo que não compila/conecta = best-tree o descarta → nunca converge.
                "INTEGRAÇÃO OBRIGATÓRIA (achado #54): siga à risca a seção '🧩 CONTEXTO DE INTEGRAÇÃO' — "
                "para usar uma lib externa, ADICIONE-a ao package.json (dependencies) NESTA rodada (o build "
                "roda npm install); registre TODO módulo novo em src/app.module.ts imports[]; devolva o "
                "package.json e o app.module.ts JUNTO com os arquivos do subsistema, para o build passar. "
                "Prefira ENTREGAR 1 subsistema COMPLETO e que COMPILA a espalhar meias-implementações. "
                "Responda APENAS um JSON: {\"artifacts\":[{\"path\":\"<relativo a apps/>\",\"content\":\"<conteúdo completo do arquivo>\"}]}. "
                "Cada arquivo COMPLETO (nunca trunque no meio). Escape quebras de linha como \\n dentro das "
                "strings do JSON (nunca quebras CRUAS). Ordene por prioridade (o mais crítico primeiro). "
                "Não explique fora do JSON."
            )
        else:
            _max_files = int(os.environ.get("CYBORG_REWORK_MAX_FILES_PER_ROUND", "6"))
            _fix_prompt = (
                "Você é o Dev sênior. O código gerado NÃO cumpre a spec integralmente. "
                f"Corrija os problemas abaixo, PRIORIZANDO os BLOCKERs. Entregue no MÁXIMO {_max_files} arquivos "
                "nesta rodada — escolha os de maior impacto; os demais serão corrigidos na próxima rodada. "
                # Achado #33 (2026-08-10): rodadas de rework REGRIDIAM dimensões já aprovadas. Ao
                # vivo (SPEC-20): rodada 1 zerou os BLOCKERs de fidelidade (A2 4→8), rodada 2 —
                # mirando o build — reescreveu arquivos não implicados e derrubou A2 de volta
                # (8→3). O Dev stateless regenera arquivos inteiros e clobbera correções anteriores.
                # Regra de correção CIRÚRGICA para convergir em vez de oscilar:
                "REGRA CRÍTICA (correção cirúrgica): mexa APENAS nos arquivos diretamente implicados "
                "pelos findings listados. NÃO reescreva nem 'melhore' arquivos não citados. Ao editar um "
                "arquivo, PRESERVE todo o comportamento que já está correto — altere só o trecho necessário "
                "para resolver o finding; nunca remova exports, funções, campos ou lógica que a spec exige e "
                "que já existem. O objetivo é REDUZIR o número de BLOCKERs a cada rodada, JAMAIS reintroduzir "
                "um problema já resolvido em rodada anterior. Se um finding não indica claramente o arquivo, "
                "escolha o de menor escopo que o resolve. "
                # Achado #45: erros de export/tipo cross-file exigem editar o PAR (importador+alvo).
                "SE houver a seção 'DESCOMPASSO DE EXPORT/TIPO CROSS-FILE (TS2305/TS2339)', siga-a à "
                "risca: alinhe os DOIS lados (adicione/renomeie o export no alvo E/OU corrija o nome no "
                "importador) na MESMA rodada e devolva AMBOS os arquivos do par — nunca só um lado. "
                # Achado #53: correção de domínio que muda export/shape quebra importadores → build.
                "PRESERVE O BUILD (crítico): se a sua correção alterar a ASSINATURA de um export (nome, "
                "tipo, campos, shape) que outros arquivos importam, INCLUA também nesta MESMA rodada os "
                "arquivos importadores afetados, já ajustados aos novos nomes/tipos — nunca deixe um lado "
                "dessincronizado, pois é isso que quebra o build. "
                "Responda APENAS um JSON: {\"artifacts\":[{\"path\":\"<relativo a apps/>\",\"content\":\"<conteúdo completo do arquivo>\"}]}. "
                "Cada arquivo deve vir COMPLETO (nunca trunque um arquivo no meio). Escape corretamente quebras "
                "de linha como \\n dentro das strings do JSON (nunca quebras de linha CRUAS). Prefira arquivos menores e focados. "
                "Ordene os arquivos por prioridade (o mais crítico primeiro) para que, se faltar espaço, os últimos é que caiam. "
                "Não explique fora do JSON."
            )
        # Achado #55 (2026-08-12): SUBMODO REGENERAÇÃO DE MODELO. Quando o domínio central está
        # ERRADO (não é gap-de-feature nem build), a diretriz do feature ("adicione, preserve tudo,
        # nunca remova") PERPETUA o núcleo errado. Aqui invertemos: mandamos REESCREVER/SUBSTITUIR o
        # modelo de domínio p/ bater com a spec canônica (que entra COMPLETA no _fix_user abaixo),
        # removendo os campos/tipos genéricos que a spec NÃO define e criando os que ela exige.
        if _domain_regen:
            _dom_findings = _domain_incoherence_findings(cur_audit)
            _max_files = int(os.environ.get("CYBORG_DOMAIN_REGEN_MAX_FILES_PER_ROUND", "12"))
            _fix_prompt = (
                "⚠️ DOMÍNIO ERRADO — REGENERAÇÃO DE MODELO (achado #55). A auditoria detectou que o "
                "NÚCLEO do domínio implementado NÃO é o da spec: a fábrica construiu um domínio genérico "
                "(ex.: LMS/calendário — Course.slug, Hour com dayOfWeek/startTime, ActivityItem tipo "
                "video) em vez das entidades canônicas que a spec define. Isto NÃO se resolve adicionando "
                "módulos nem com patch cirúrgico — o modelo de dados central está errado. "
                "Sua missão AGORA é REGENERAR o modelo de domínio central (schemas/entidades/DTOs/enums/"
                "validators) para corresponder EXATAMENTE à spec canônica (seção 'Spec (PRODUCT_SPEC)' "
                "abaixo, que é o CONTRATO de domínio): use as MESMAS entidades, a MESMA hierarquia, os "
                "MESMOS enums/valores (inclusive listas fechadas de tipos) e a MESMA marca/nomenclatura "
                "que a spec define. "
                # A INVERSÃO da regra feature: aqui É permitido e necessário REMOVER/reescrever o núcleo.
                "SUBSTITUA as entidades genéricas erradas: REMOVA campos/tipos que a spec NÃO define e "
                "CRIE os que ela exige (discriminators por tipo, enums fechados, sub-shapes canônicos). "
                "A regra de 'preservar tudo / nunca remover' do modo feature NÃO se aplica ao domínio "
                "incoerente — o objetivo é fazer o modelo BATER com a spec, não somar sobre o errado. "
                # Preservar só o periférico correto e re-apontar para o modelo novo.
                "PRESERVE apenas os módulos PERIFÉRICOS que já estão CORRETOS (ex.: sync, publishing, "
                "outbox, health) e RE-APONTE-os para o modelo corrigido, ajustando os importadores ao "
                "novo shape na MESMA rodada (o build é gate inviolável — não deixe importador órfão). "
                # Reusar as regras duras de integração/JSON.
                "INTEGRAÇÃO OBRIGATÓRIA: adicione ao package.json (dependencies) toda lib externa que a "
                "spec exige (o build roda npm install) e registre todo módulo novo em src/app.module.ts "
                "imports[] na MESMA rodada; devolva package.json e app.module.ts junto quando mudarem. "
                "Responda APENAS um JSON: {\"artifacts\":[{\"path\":\"<relativo a apps/>\",\"content\":\"<conteúdo completo do arquivo>\"}]}. "
                "Cada arquivo COMPLETO (nunca trunque no meio). Escape quebras de linha como \\n dentro "
                "das strings (nunca quebras CRUAS). Ordene por prioridade: o MODELO DE DOMÍNIO CENTRAL "
                "(schemas/enums/entidades) PRIMEIRO. Não explique fora do JSON."
            )
            _post_dialogue(project_id,
                f"🧬 Cyborg — DOMÍNIO INCOERENTE detectado ({len(_dom_findings)} sinal(is), build verde). "
                f"Escalando para REGENERAÇÃO DE MODELO (achado #55): reescrevendo o núcleo do domínio "
                f"para bater com a spec canônica, não apenas adicionando módulos.")

        # Achado #32 (2026-08-10): o rework recebia SÓ as descrições dos findings — nunca o
        # traceback REAL do build (que _collect_context já coleta em ctx["build_output"]/
        # ["type_check_output"]). Sem o erro concreto ("dictionary.allTokens is not iterable at
        # build-tokens.mjs:35"), o Dev não converge em BLOCKERs de build e chega a REGREDIR o A3
        # (8→2) reescrevendo às cegas um arquivo que já compilava. Agora, quando o build falhou,
        # anexamos o stderr/stdout real + o type-check ao contexto do Dev.
        _build_block = ""
        _b_rc = ctx.get("build_rc", -1)
        _tc_rc = ctx.get("type_check_rc", -1)
        if (isinstance(_b_rc, int) and _b_rc not in (0, -1)) or (isinstance(_tc_rc, int) and _tc_rc not in (0, -1)):
            _bo = (ctx.get("build_output") or "")[-3500:]
            _tco = (ctx.get("type_check_output") or "")[-2000:]
            _build_block = (
                f"\n## ⚠️ BUILD FALHOU (build_rc={_b_rc}, type_check_rc={_tc_rc}) — CORRIJA A CAUSA-RAIZ\n"
                f"Este é o erro REAL do build/type-check. NÃO reescreva às cegas arquivos que já "
                f"compilavam — mire exatamente o arquivo/linha do traceback abaixo.\n"
                f"### build_output (fim)\n```\n{_bo}\n```\n"
                + (f"### type_check_output (fim)\n```\n{_tco}\n```\n" if _tco else "")
            )
        # Achado #45 (2026-08-11): quando o build falha por TS2305/TS2339 (descompasso de export/
        # tipo cross-file), injeta o PAR de arquivos (importador + alvo) completo + a instrução de
        # costura cirúrgica. É o contexto DECISIVO — quando presente, reduzimos a amostra genérica
        # (source_sample) e o spec p/ caber em 45000 sem cortar os findings (que vão no FIM).
        _stitch_block = _stitch_export_context(project_id, prod_id, ctx)
        # Achado #54: no modo feature, os arquivos-âncora de integração (package.json/app.module/
        # contracts) são o contexto DECISIVO p/ os subsistemas novos COMPILAREM — entram em conteúdo
        # completo e a amostra genérica (source_sample) é reduzida p/ caber no cap de 45000.
        _feat_block = _feature_integration_context(project_id, prod_id) if _feature_mode else ""
        # Budgets apertados no modo feature: o _feat_block (âncoras) é grande e decisivo; os findings
        # (o que corrigir) vão no FIM e o cap [:45000] cortaria-os primeiro — então reduzimos spec/
        # arch/src/tree p/ o total caber COM os findings preservados (achado #54).
        if _domain_regen:
            # Regen precisa da spec de domínio COMPLETA (é o contrato canônico) + os findings de
            # domínio COM evidência (o delta exato "spec exige X, código tem Y"). Cortamos arch/src/
            # tree (menos úteis p/ reescrever o núcleo) p/ caber no cap de 45000 do _fix_user.
            _spec_budget, _arch_budget, _src_budget, _tree_budget = 20000, 4000, 1500, 2500
        elif _feature_mode:
            _spec_budget, _arch_budget, _src_budget, _tree_budget = 10000, 6000, 2000, 3000
        else:
            _spec_budget = 16000 if _stitch_block else 20000
            _arch_budget, _tree_budget = 8000, 4000
            _src_budget = 4000 if _stitch_block else 12000
        # Achado #55: bloco do DELTA de domínio (spec exige vs. construído), com evidência do auditor.
        # Vai perto do TOPO do _fix_user (antes das âncoras) p/ não cair no corte [:45000] do fim.
        _regen_block = ""
        if _domain_regen:
            _parts = []
            for _f in (_dom_findings or [])[:6]:
                _ev = (getattr(_f, "evidence", "") or "").strip()[:900]
                _parts.append(f"- **{getattr(_f,'area','?')}**: {getattr(_f,'description','')}"
                              + (f"\n  Evidência: {_ev}" if _ev else ""))
            _regen_block = (
                "\n## 🧬 DELTA DE DOMÍNIO — regenere o núcleo p/ eliminar CADA descompasso (achado #55)\n"
                "A spec acima é o contrato canônico. O código atual diverge dela nestes pontos "
                "(substitua o shape errado pelo da spec, removendo o que a spec não define):\n"
                + "\n".join(_parts) + "\n"
            )
        _fix_user = (
            f"## Spec (PRODUCT_SPEC)\n{ctx.get('spec','')[:_spec_budget]}\n\n"
            f"## Arquitetura do Engineer\n{ctx.get('engineer_architecture','')[:_arch_budget]}\n\n"
            f"{_regen_block}\n"
            f"{_feat_block}\n"
            f"{_stitch_block}\n"
            f"## Código atual (amostra)\n{ctx.get('source_sample','')[:_src_budget]}\n\n"
            f"## Árvore atual\n{ctx.get('apps_tree','')[:_tree_budget]}\n"
            f"{_build_block}\n"
            f"## Problemas a corrigir ({len(findings)}) — priorize BLOCKERs, no máx {_max_files} arquivos nesta rodada\n"
            + "\n".join(f"- {x}" for x in findings[:20])
        )
        # Achado #30 (2026-08-10): uma resposta LLM vazia (200 com response="") NÃO pode
        # abortar o loop inteiro de correção. Antes, um único `break` aqui pulava as rodadas
        # 2/3 E o modelo de reforço, jogando o projeto direto para needs_human sem NENHUMA
        # tentativa real de correção — foi o que travou a onda 0 (SPEC-00 e SPEC-20).
        # Agora: reintenta a chamada dentro da mesma rodada, escalando para o modelo mais
        # capaz (CLAUDE_MODEL_REWORK/opus) a partir da 2ª tentativa, antes de desistir.
        _fallback_model = ("claude-opus-5" if os.environ.get("GENESIS_LLM_PROVIDER","").lower()=="foundry"
                           else os.environ.get("CLAUDE_MODEL_REWORK", "us.anthropic.claude-opus-4-6-v1"))
        _max_llm_attempts = max(1, int(os.environ.get("CYBORG_REWORK_LLM_ATTEMPTS", "3")))
        _obj = None
        resp = ""
        # Achado #50: no modo feature, começamos JÁ com o modelo maior (opus-5 no Foundry) —
        # gaps de feature exigem raciocínio que o modelo padrão não entregou no cirúrgico — e
        # damos um teto de tokens maior (subsistemas inteiros são saídas maiores).
        _start_model = _fallback_model if _feature_mode else model_id
        _rework_max_tokens = int(os.environ.get(
            "CYBORG_ESCALATION_MAX_TOKENS" if _feature_mode else "CYBORG_REWORK_MAX_TOKENS",
            "48000" if _feature_mode else "24000"))
        for _att in range(_max_llm_attempts):
            _use_model = _start_model if _att == 0 else _fallback_model
            body = {
                "prompt_override": _fix_prompt, "user_message": _fix_user[:45000],
                "model_id": _use_model,
                "model_id_fallback": _fallback_model,
                "max_tokens": _rework_max_tokens,
            }
            # Timeout largo: /invoke/raw pode encadear principal→fallback (sonnet→opus)
            # DENTRO de uma única request quando o principal volta vazio (achado #30). 300s
            # era apertado p/ a cadeia dupla → timeout (status 0). CYBORG_REWORK_HTTP_TIMEOUT_SEC.
            _rework_http_timeout = int(os.environ.get("CYBORG_REWORK_HTTP_TIMEOUT_SEC", "720"))
            status, text = _http("POST", f"http://agents:8000/invoke/raw", body, timeout=_rework_http_timeout)
            if status != 200:
                logger.warning("[Cyborg rework] /invoke/raw %s (tentativa %d/%d)", status, _att + 1, _max_llm_attempts)
                continue
            try:
                resp = json.loads(text).get("response", "") or ""
            except Exception:
                resp = text or ""
            # Extração ROBUSTA do JSON de artifacts (tolera ```json fences```, prosa ao redor,
            # e resposta vazia). Antes: resp.index("{") lançava "substring not found" e abortava
            # o rework silenciosamente (achado #20). Agora tenta fence → primeiro-{...}-último.
            _obj = None
            if resp.strip():
                import re as _re
                _m = _re.search(r"```(?:json)?\s*(\{.*\})\s*```", resp, _re.DOTALL)
                _candidate = _m.group(1) if _m else None
                if not _candidate:
                    _a, _b = resp.find("{"), resp.rfind("}")
                    if _a != -1 and _b != -1 and _b > _a:
                        _candidate = resp[_a:_b + 1]
                if _candidate:
                    try:
                        # strict=False: tolera control chars crus em strings (achado #34).
                        _obj = json.loads(_candidate, strict=False)
                    except Exception as ex:
                        # JSON truncado (Unterminated string) — SALVAR os artifacts completos
                        # que vieram antes do corte em vez de perder a rodada inteira (#30-bis).
                        _salv = _salvage_artifacts_from_truncated(resp)
                        if _salv:
                            logger.warning("[Cyborg rework] JSON truncado (%s) — salvos %d artifact(s) completo(s) do parcial",
                                           ex, len(_salv))
                            _obj = {"artifacts": _salv}
                        else:
                            logger.warning("[Cyborg rework] JSON inválido (%s); resp[:200]=%r", ex, resp[:200])
            if _obj is not None:
                break
            logger.warning("[Cyborg rework] resposta sem JSON de artifacts (resp_len=%d, tentativa %d/%d) — %s",
                           len(resp), _att + 1, _max_llm_attempts,
                           ("reintentando com modelo escalado (%s)" % _fallback_model) if _att + 1 < _max_llm_attempts else "esgotado")
        if _obj is None:
            logger.warning("[Cyborg rework] sem JSON de artifacts após %d tentativa(s) — encerrando rework", _max_llm_attempts)
            break
        arts = _obj.get("artifacts", []) or []
        written = 0
        # Achado #33: snapshot dos arquivos que ESTA rodada vai sobrescrever, p/ permitir
        # rollback se ela regredir. Guarda (abs_path, conteúdo_anterior | None se novo).
        _snapshot: list[tuple] = []
        for a in arts:
            p = (a.get("path") or "").strip().lstrip("/")
            c = a.get("content")
            if p and isinstance(c, str) and ".." not in p:
                # api_contract.md e outros vão em project/; código em apps/.
                # write_project_artifact JÁ prefixa "project/" — se p já vier com esse prefixo,
                # removê-lo evita o caminho duplicado "project/project/..." (achado #30-bis).
                if p.startswith("project/") or p.endswith("api_contract.md"):
                    from orchestrator.project_storage import write_project_artifact, get_project_dir
                    _rel = p[len("project/"):] if p.startswith("project/") else p
                    _base = get_project_dir(project_id)
                    _abs = (_base / _rel) if _base else None
                    _prev = _abs.read_text(encoding="utf-8", errors="replace") if (_abs and _abs.exists()) else None
                    _snapshot.append((_abs, _prev))
                    write_project_artifact(project_id, _rel, c)
                else:
                    from orchestrator.project_storage import get_apps_dir
                    _base = get_apps_dir(project_id)
                    _abs = (_base / p) if _base else None
                    _prev = _abs.read_text(encoding="utf-8", errors="replace") if (_abs and _abs.exists()) else None
                    _snapshot.append((_abs, _prev))
                    write_apps_artifact(project_id, p, c)
                written += 1
        _post_dialogue(project_id, f"🔧 Cyborg — Dev gravou {written} arquivo(s). Re-auditando…")
        logger.info("[Cyborg rework] rodada %d: %d findings → %d artefatos gravados", rnd, len(findings), written)
        if written == 0:
            break
        # Re-auditar com o código corrigido.
        _new_audit = run_prior_audit(project_id, prod_id, model_id)
        _new_blk = _count_blk(_new_audit)
        _new_bok = _bok(_cur_build_rc(project_id, prod_id))
        # GATE DE NÃO-REGRESSÃO (#33 + #52): compara por chave COMPOSTA (build_ok primário, MENOS
        # BLOCKERs secundário). Maior = melhor. Assim consertar o build (build_rc→0) NUNCA é tratado
        # como regressão, mesmo que a contagem de BLOCKERs de outras dimensões suba transitoriamente
        # — pois com build!=0 o projeto jamais é aceito (#38), então build verde é estritamente mais
        # próximo do aceite. Com o build verde, os BLOCKERs restantes caem por rework cirúrgico.
        # Achado #56: chave DOMÍNIO-CONSCIENTE. Enquanto a regen não engata, _rank reduz à chave
        # legada (build_ok, -blk); após engatar, domínio-correto é o eixo primário → uma rodada que
        # ACERTA o domínio é uma MELHORA mesmo que quebre o build transitoriamente (a costura #45
        # repara o build nas rodadas seguintes, agora SOBRE o domínio correto, em vez de reincidir).
        _new_dom_ok = not bool(_domain_incoherence_findings(_new_audit))
        _best_key = _rank(_best_dom_ok, _best_build_ok, _best_blk)
        _new_key = _rank(_new_dom_ok, _new_bok, _new_blk)
        _regressed = _new_key < _best_key
        _improved = _new_key > _best_key
        # Achado #53: uma rodada que QUEBRA o build (verde→vermelho) mas REDUZ BLOCKERs é a
        # assinatura de uma correção de domínio que desincronizou exports cross-file — exatamente
        # o que a costura #45 repara na rodada SEGUINTE. Não a jogamos fora: abrimos uma janela.
        _broke_build_progressed = (_best_build_ok and (not _new_bok) and _new_blk < _best_blk)
        if not _regressed:
            # Melhorou (build consertado e/ou menos BLOCKERs) OU empatou → adota o novo estado.
            cur_audit = _new_audit
            if _improved:
                if _new_bok and not _best_build_ok:
                    logger.info("[Cyborg rework] rodada %d CONSERTOU O BUILD (build_rc→0); adotada mesmo "
                                "com BLOCKERs %d→%d (build é gate inviolável #38).", rnd, _best_blk, _new_blk)
                if _new_dom_ok and not _best_dom_ok:
                    logger.info("[Cyborg rework] rodada %d ACERTOU O DOMÍNIO (regen #56); adotada como novo "
                                "melhor mesmo com build_ok=%s/BLOCKERs %d→%d — domínio correto é o eixo "
                                "primário após a regen engatar.", rnd, _new_bok, _best_blk, _new_blk)
                _best_blk = _new_blk
                _best_build_ok = _new_bok
                _best_dom_ok = _new_dom_ok
                _recovery_used = 0  # aterrissou num estado melhor → zera a janela de recuperação
                if _best_tree_enabled:
                    _snap_best_tree()  # novo melhor estado → preserva a árvore p/ restauração
            if _new_blk == 0 and _new_bok:
                break  # 0 BLOCKER E build ok — convergiu, não gasta rodadas à toa
        elif _feature_mode:
            # FEATURE mode (achado #50-bis): NÃO reverter. Adicionar um subsistema eleva BLOCKERs
            # transitoriamente; a rodada seguinte constrói SOBRE o que esta escreveu (cumulativo).
            # A melhor árvore já está preservada em _best_tree p/ restauração ao final.
            cur_audit = _new_audit
            logger.info("[Cyborg rework/feature] rodada %d: BLOCKERs %d→%d build_ok=%s (transitório — "
                        "acumulando p/ a próxima rodada fiar o wiring; melhor cumulativo=%d/build_ok=%s preservado)",
                        rnd, _best_blk, _new_blk, _new_bok, _best_blk, _best_build_ok)
            _post_dialogue(project_id,
                f"🧩 Cyborg (escalação) — rodada {rnd}: adicionou módulos ({_best_blk}→{_new_blk} BLOCKERs, "
                f"transitório). Mantendo as adições p/ a próxima rodada fiar o wiring; melhor estado "
                f"({_best_blk}) preservado p/ restauração.")
        elif _broke_build_progressed and _recovery_used < _recovery_max:
            # Achado #53: JANELA DE RECUPERAÇÃO. Quebrou o build mas reduziu BLOCKERs → MANTÉM o
            # estado (não reverte) p/ que a próxima rodada veja os erros TS2305/TS2339 no build e a
            # costura de export (#45) os alinhe, reparando o build. O melhor estado VERDE segue
            # preservado em _best_tree p/ restauração se a janela esgotar sem reparo.
            _recovery_used += 1
            cur_audit = _new_audit  # alimenta build_output/stitch da próxima rodada
            logger.warning("[Cyborg rework] rodada %d QUEBROU o build mas reduziu BLOCKERs (%d→%d); MANTIDA "
                           "em janela de recuperação %d/%d p/ a costura de export #45 reparar o build na "
                           "próxima rodada (melhor verde=%d BLOCKER preservado).",
                           rnd, _best_blk, _new_blk, _recovery_used, _recovery_max, _best_blk)
            _post_dialogue(project_id,
                f"🩹 Cyborg — rodada {rnd} reduziu BLOCKERs ({_best_blk}→{_new_blk}) mas quebrou o build; "
                f"mantida p/ costura de export na próxima rodada (recuperação {_recovery_used}/{_recovery_max}).")
        elif _recovery_used > 0 and _best_tree_enabled and _restore_best_tree():
            # Janela de recuperação esgotada sem reparar o build → volta à melhor árvore VERDE
            # (garantia #52: nunca entrega pior que o baseline). Re-audita o disco restaurado.
            logger.warning("[Cyborg rework] janela de recuperação esgotada (%d/%d) sem reparar o build na "
                           "rodada %d — restaurada a melhor árvore verde (%d BLOCKER).",
                           _recovery_used, _recovery_max, rnd, _best_blk)
            _post_dialogue(project_id,
                f"↩️ Cyborg — janela de recuperação esgotada; restaurado o melhor estado verde "
                f"({_best_blk} BLOCKER, build_ok={_best_build_ok}).")
            _recovery_used = 0
            cur_audit = run_prior_audit(project_id, prod_id, model_id)
        else:
            # Regressão comum (build seguiu verde mas BLOCKERs subiram, ou sem árvore preservada) →
            # reverte apenas os arquivos que ESTA rodada escreveu (gate #33), mantendo o melhor.
            _reverted = 0
            for _abs, _prev in _snapshot:
                if _abs is None:
                    continue
                try:
                    if _prev is None:
                        if _abs.exists():
                            _abs.unlink()  # arquivo novo introduzido pela rodada ruim → remove
                    else:
                        _abs.write_text(_prev, encoding="utf-8")  # restaura conteúdo anterior
                    _reverted += 1
                except Exception as _re_ex:
                    logger.warning("[Cyborg rework] rollback falhou p/ %s: %s", _abs, _re_ex)
            logger.warning("[Cyborg rework] rodada %d REGREDIU (blk %d→%d, build_ok %s→%s) — revertidos %d "
                           "arquivo(s), mantendo melhor estado (%d BLOCKERs, build_ok=%s)",
                           rnd, _best_blk, _new_blk, _best_build_ok, _new_bok, _reverted, _best_blk, _best_build_ok)
            _post_dialogue(project_id,
                f"↩️ Cyborg — rodada {rnd} regrediu (blk {_best_blk}→{_new_blk}, build_ok {_best_build_ok}→{_new_bok}); "
                f"revertida. Mantido o melhor estado ({_best_blk} BLOCKER, build_ok={_best_build_ok}).")
            # cur_audit permanece o melhor (não adota o pior). Re-audita o disco revertido p/
            # sincronizar o audit.json com o estado real restaurado.
            cur_audit = run_prior_audit(project_id, prod_id, model_id)

    # FEATURE mode + JANELA DE RECUPERAÇÃO (#53): ao final, se o estado no disco piorou vs. a melhor
    # árvore preservada, restaura a melhor (garante: NUNCA entrega pior que o baseline — vale tanto p/
    # a escalação de feature quanto p/ uma janela de recuperação de build que não reparou o build).
    # Comparação COMPOSTA (#52): build_ok primário, MENOS BLOCKERs secundário — nunca restaura
    # sobre um estado que consertou o build só porque a contagem de BLOCKERs subiu.
    if _best_tree_enabled:
        _final_blk = _count_blk(cur_audit)
        _final_bok = _bok(_cur_build_rc(project_id, prod_id))
        _final_dom_ok = not bool(_domain_incoherence_findings(cur_audit))
        _final_worse = _rank(_final_dom_ok, _final_bok, _final_blk) < _rank(_best_dom_ok, _best_build_ok, _best_blk)
        # Achado #56 (a correção DECISIVA): se a regen engatou mas a MELHOR árvore preservada é de
        # DOMÍNIO ERRADO (a regen nunca atingiu coerência de domínio nas rodadas disponíveis),
        # restaurá-la desfaz a cura e reincide no produto errado — exatamente o loop que impedia a
        # convergência (#56). Nesse caso NÃO restauramos: mantemos a tentativa de regen em disco
        # (domínio-correto-em-progresso) p/ ESCALAR ao humano — nunca estacionar no verde-de-domínio-
        # errado (feedback-cyborg-deve-entregar). Quando a melhor árvore JÁ é de domínio correto, a
        # restauração protege esse marco normalmente.
        _regen_no_restore = _regen_engaged and (not _best_dom_ok)
        if _regen_no_restore and _final_worse:
            logger.warning("[Cyborg rework/regen #56] estado final pior pela chave composta, MAS a melhor "
                           "árvore preservada é de domínio ERRADO — NÃO restaurando (evita reincidir no "
                           "produto errado). Mantendo a regeneração de domínio em disco p/ escalação humana.")
            _post_dialogue(project_id,
                "⚠️ Cyborg (regen) — a regeneração de domínio não convergiu para build verde nas rodadas "
                "disponíveis. Mantendo o código de DOMÍNIO CORRETO em progresso (não revertido ao verde-de-"
                "domínio-errado) e escalando para revisão humana.")
        if _final_worse and (not _regen_no_restore) and _restore_best_tree():
            logger.warning("[Cyborg rework/feature] estado final (blk %d, build_ok %s) pior que o melhor cumulativo "
                           "(blk %d, build_ok %s) — restaurada a melhor árvore; re-auditando p/ sincronizar.",
                           _final_blk, _final_bok, _best_blk, _best_build_ok)
            _post_dialogue(project_id,
                f"↩️ Cyborg (escalação) — restaurado o melhor estado cumulativo ({_best_blk} BLOCKER, "
                f"build_ok={_best_build_ok}) ao final.")
            cur_audit = run_prior_audit(project_id, prod_id, model_id)
        if _best_tree:
            try:
                _shutil.rmtree(_best_tree, ignore_errors=True)
            except Exception:
                pass

    total_blk = _count_blk(cur_audit)
    return {"ok": total_blk == 0, "rounds": rnd, "final_audit": cur_audit, "delivered": total_blk == 0}


# ── Fase 3: Parse resultado do Claude Code ────────────────────────────────────

def _cur_build_rc(project_id: str, prod_id: str | None) -> int:
    """Lê o build_rc da última auditoria do audit.json em disco. -1 = desconhecido.

    run_prior_audit grava o bloco 'build' (rc, output_tail, type_check_rc) no audit.json.
    Este helper relê de lá — é a fonte confiável do resultado do build local (achado #21).
    """
    try:
        proj_dir = _resolve_proj_dir(project_id, prod_id)
        aj = proj_dir / "docs" / "cyborg" / "audit.json"
        if aj.exists():
            data = json.loads(aj.read_text(encoding="utf-8"))
            return int(data.get("build", {}).get("rc", -1))
    except Exception:
        pass
    return -1


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
                                        max_rounds=int(os.environ.get("CYBORG_REWORK_ROUNDS", "5")))
                if _rw.get("final_audit"):
                    audit = _rw["final_audit"]; run.audit = audit
                    total_blk = sum(sum(1 for f in ar.findings if f.severity == "BLOCKER") for ar in audit.values())

            # Decisão de aceite REAVALIÁVEL (helper local): lê o `audit` corrente e devolve as
            # métricas + flags de aceite. Extraída p/ poder ser reexecutada após uma escalação
            # de conclusão de feature (achado #50). Mantém INTACTOS os gates duros (#21/#38).
            def _evaluate(_audit: dict) -> dict:
                _scores = [ar.score for ar in _audit.values() if ar.ok or ar.score > 0]
                _avg = (sum(_scores) / len(_scores)) if _scores else 0
                _min_avg = float(os.environ.get("CYBORG_AUDIT_MIN_AVG", "7"))
                # GATE DE BUILD (inviolável): o build TEM que passar (rc=0). Separa "código que
                # compila mas não cobre 100% da spec" de "código quebrado".
                _build_rc = _cur_build_rc(project_id, prod_id)
                # Critério ponderado de aceite (achado #21): specs exigentes deixam resíduo de
                # fidelidade (FRs opcionais/edge) que não impede USO. Aceita quando:
                #  (a) 0 BLOCKER + média ≥ limiar (ideal), OU
                #  (b) build passa (rc=0) E média alta (≥ CYBORG_AUDIT_STRONG_AVG) E poucos
                #      blockers residuais (≤ CYBORG_AUDIT_MAX_RESIDUAL_BLK), NENHUM em a3 (build).
                _strong_avg = float(os.environ.get("CYBORG_AUDIT_STRONG_AVG", "8"))
                _max_resid = int(os.environ.get("CYBORG_AUDIT_MAX_RESIDUAL_BLK", "3"))
                _blk = sum(sum(1 for f in getattr(ar, "findings", []) or [] if f.severity == "BLOCKER")
                           for ar in _audit.values())
                _build_blk = sum(1 for f in getattr(_audit.get("a3_build_runtime"), "findings", []) or []
                                 if f.severity == "BLOCKER")
                # ACHADO #38: build_rc>0 (falhou) NUNCA aceita, em NENHUM caminho. rc==-1
                # (build não rodou p/ este tipo) permanece permissivo (comportamento prévio).
                _build_failed = _build_rc not in (0, -1)
                _accept_ideal = (_blk == 0 and _avg >= _min_avg and not _build_failed)
                _accept_weighted = (_build_rc == 0 and _avg >= _strong_avg
                                    and _blk <= _max_resid and _build_blk == 0)
                return {"blk": _blk, "avg": _avg, "build_rc": _build_rc, "build_blk": _build_blk,
                        "build_failed": _build_failed, "ideal": _accept_ideal, "weighted": _accept_weighted}

            _ev = _evaluate(audit)

            # ESCALAÇÃO — CONCLUSÃO DE FEATURE (achado #50 · diretriz Jean 2026-08-11: o Cyborg
            # deve ENTREGAR, jamais estacionar em blocked_cyborg). Se o rework CIRÚRGICO esgotou
            # SEM aceitar e ainda há BLOCKER(s), antes de ir p/ needs_human tentamos concluir as
            # features faltantes com o modelo MAIOR autorizado a ADICIONAR módulos inteiros
            # (subsistemas que o Dev nunca gerou — o cirúrgico é estruturalmente incapaz disso).
            # O gate de build/não-regressão continua inviolável: escalar CURA o defeito real, não
            # afrouxa o gate (#38). Ver [[feedback-cyborg-deve-entregar-nao-parar]].
            _escalation_on = os.environ.get("CYBORG_ESCALATION_ENABLED", "1").strip() != "0"
            if _escalation_on and not (_ev["ideal"] or _ev["weighted"]) and _ev["blk"] > 0:
                _post_dialogue(project_id,
                    f"🚀 Cyborg — rework cirúrgico esgotou com {_ev['blk']} BLOCKER(s) de feature. "
                    f"Escalando para CONCLUSÃO DE FEATURE (modelo maior, pode adicionar módulos "
                    f"inteiros) antes de qualquer bloqueio — o Cyborg existe para entregar.")
                _esc = autonomous_rework(project_id, prod_id, audit, model_id,
                                         max_rounds=int(os.environ.get("CYBORG_ESCALATION_ROUNDS", "5")),
                                         mode="feature")
                if _esc.get("final_audit"):
                    audit = _esc["final_audit"]; run.audit = audit
                _ev = _evaluate(audit)

            total_blk = _ev["blk"]; _avg = _ev["avg"]; _build_rc = _ev["build_rc"]
            _build_blk = _ev["build_blk"]; _build_failed = _ev["build_failed"]
            _accept_ideal = _ev["ideal"]; _accept_weighted = _ev["weighted"]
            if _accept_ideal or _accept_weighted:
                run.final_status = "delivered"
                run.reason = (f"aceito por auditoria: {total_blk} BLOCKER, média {_avg:.1f}/10, "
                              f"build_rc={_build_rc} ({'ideal' if _accept_ideal else 'ponderado'})")
                _post_dialogue(project_id,
                    f"═══════════════════════════════════════\n"
                    f"✅ Cyborg V3 — aceito por auditoria autônoma\n"
                    f"═══════════════════════════════════════\n"
                    f"Decisão pelas 5 análises Foundry: {total_blk} BLOCKER residual, "
                    f"média {_avg:.1f}/10, build {'OK' if _build_rc==0 else 'FALHOU'}. Projeto aprovado.")
                return run
            run.final_status = "needs_human"
            _build_note = " — BUILD FALHOU (gate inviolável #38)" if _build_failed else ""
            run.reason = (f"auditoria reprovou: {total_blk} BLOCKER (build={_build_blk}), "
                          f"média {_avg:.1f}/10, build_rc={_build_rc}{_build_note}. "
                          f"Ver docs/cyborg/audit.json.")
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
