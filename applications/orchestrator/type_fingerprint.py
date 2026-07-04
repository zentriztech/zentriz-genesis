"""
type_fingerprint.py — Wave 1 (T-08/T-09) — grep semântico sobre código gerado.

Consumido por:
- QA (via chamada do runner após artefatos serem gerados)
- Cyborg V3 sub-fase 2f (via full-test-server.py)

Retorna {pass, missing_strong, missing_soft, forbidden_found, details} onde:
- missing_strong: tokens strong ausentes (FAIL BLOCKER)
- missing_soft:   tokens soft ausentes (WARN)
- forbidden_found: tokens proibidos encontrados (FAIL BLOCKER)

Grep é OR de tokens EN + synonyms_pt_br para evitar falso positivo em
produtos PT-BR (ex: 'dashboard' também bate com 'painel', 'gerenciador').
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable

_SKIP_DIRS = {"node_modules", ".next", "dist", ".git", "__pycache__", ".venv", "venv", "coverage", "build"}
_TEXT_EXTS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".json", ".md", ".yaml", ".yml", ".toml", ".env", ".env.example", ".sh", ".sql", ".html", ".css"}
_MAX_FILE_BYTES = 500_000  # skip arquivos > 500KB (bundles, minified)


def _iter_code_files(root: Path) -> Iterable[Path]:
    """Itera sobre arquivos de código dentro de root, respeitando skip_dirs e extensões."""
    if not root.exists():
        return
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if any(part in _SKIP_DIRS for part in p.parts):
            continue
        if p.suffix.lower() not in _TEXT_EXTS:
            continue
        try:
            if p.stat().st_size > _MAX_FILE_BYTES:
                continue
        except OSError:
            continue
        yield p


def _read_all_code(root: Path) -> str:
    """
    Concatena todo o código relevante em uma string lower-case para grep case-insensitive.
    Inclui também os PATHS dos arquivos — muitos tokens são nomes de arquivo/dir
    (ex.: 'drizzle.config.ts', 'AppShell.tsx', 'middleware.ts') que não aparecem
    literalmente no conteúdo mas são evidência estrutural forte.
    """
    chunks: list[str] = []
    for p in _iter_code_files(root):
        try:
            # Path relativo entra no haystack (garante detectar arquivos-marcadores)
            chunks.append(str(p.relative_to(root)))
            chunks.append(p.read_text(encoding="utf-8", errors="replace"))
        except (OSError, ValueError):
            continue
    return "\n".join(chunks).lower()


def _tokens_for_search(token: str, synonyms_pt_br: dict) -> list[str]:
    """
    Expande um token adicionando sinônimos PT-BR se aplicável.
    Ex.: token='dashboard' + synonyms_pt_br={dashboard: [painel, gerenciador]}
         retorna ['dashboard', 'painel', 'gerenciador']
    """
    variants = [token.lower()]
    key = token.lower()
    if key in synonyms_pt_br:
        for syn in synonyms_pt_br[key]:
            variants.append(syn.lower())
    return variants


def _has_any_token(haystack: str, variants: list[str]) -> bool:
    """
    True se qualquer variante aparece no haystack.

    Regras de match para reduzir falso positivo:
    - Tokens curtos (<5 chars) que são pura palavra alfabética → word boundary
      (ex.: 'bot' NÃO bate com 'bottom', 'about', 'robot')
    - Tokens com caractere não-alfanumérico (/, ., -, @, #) OU longos (≥5) → substring
      (ex.: '/health' e 'AppShell' e 'fastify' batem por substring)
    """
    for v in variants:
        v = v.strip()
        if not v:
            continue
        v_lower = v.lower()
        is_short_word = len(v_lower) < 5 and re.fullmatch(r"[a-z0-9]+", v_lower) is not None
        if is_short_word:
            if re.search(rf"\b{re.escape(v_lower)}\b", haystack):
                return True
        else:
            if v_lower in haystack:
                return True
    return False


def check_stub_pages(project_root: Path | str) -> dict:
    """
    L-DEV-2/4 (V12 OrienteMe): detecta páginas entregues como stub
    "em desenvolvimento" em vez de implementação real de um FR.

    Retorna {stubs_found: [paths], pass: bool}. Uma página é stub se:
    - contém Alert com "em desenvolvimento" / "Deve listar" / "Deve exibir" / "será implementad"
    - tem menos de ~40 linhas E só renderiza Alert/Typography sem lógica

    Rotas admin (dashboard/atendimentos/profissionais/etc.) NÃO podem ser stub.
    """
    root = Path(project_root)
    apps_dir = root / "apps"
    scan_root = apps_dir if apps_dir.exists() else root

    STUB_MARKERS = [
        "em desenvolvimento", "página em desenvolvimento", "pagina em desenvolvimento",
        "deve listar", "deve exibir", "deve conter", "será implementad", "sera implementad",
        "placeholder", "todo: implementar", "conteúdo a definir", "conteudo a definir",
        "em breve", "coming soon",
    ]
    stubs: list[str] = []
    if scan_root.exists():
        for p in scan_root.rglob("page.tsx"):
            if any(part in _SKIP_DIRS for part in p.parts):
                continue
            try:
                txt = p.read_text(encoding="utf-8", errors="replace").lower()
            except OSError:
                continue
            # Não flaga páginas institucionais curtas (sobre/privacidade/termos são simples por design)
            rel = str(p.relative_to(scan_root)).lower()
            is_institutional = any(x in rel for x in ("sobre", "privacidade", "termos", "login"))
            hit = any(m in txt for m in STUB_MARKERS)
            if hit and not is_institutional:
                stubs.append(str(p.relative_to(root)))
    return {"stubs_found": stubs, "pass": len(stubs) == 0}


def check_fingerprint(project_root: Path | str, policy: dict) -> dict:
    """
    Executa fingerprint check no diretório `project_root/apps/` (default do Genesis).

    Args:
        project_root: Path para o diretório raiz do projeto (contém apps/)
        policy: dict de type_policy.policy conforme project_types.yaml

    Returns:
        {
          "pass": bool,                    # True se sem FAIL
          "missing_strong": [str],         # tokens strong ausentes (FAIL)
          "missing_soft":   [str],         # tokens soft ausentes (WARN)
          "forbidden_found": [str],        # tokens proibidos encontrados (FAIL)
          "details": {                     # info diagnóstica
            "files_scanned": int,
            "haystack_chars": int,
            "policy_present": bool,
          }
        }
    """
    root = Path(project_root)
    apps_dir = root / "apps"
    scan_root = apps_dir if apps_dir.exists() else root

    fp = policy.get("fingerprint", {}) if policy else {}
    required = fp.get("required_tokens", {}) or {}
    strong = required.get("strong", []) or []
    soft = required.get("soft", []) or []
    forbidden = fp.get("forbidden_tokens", []) or []
    synonyms = fp.get("synonyms_pt_br", {}) or {}

    haystack = _read_all_code(scan_root)
    files_scanned = sum(1 for _ in _iter_code_files(scan_root))

    missing_strong: list[str] = []
    missing_soft: list[str] = []
    forbidden_found: list[str] = []

    for token in strong:
        variants = _tokens_for_search(token, synonyms)
        if not _has_any_token(haystack, variants):
            missing_strong.append(token)

    for token in soft:
        variants = _tokens_for_search(token, synonyms)
        if not _has_any_token(haystack, variants):
            missing_soft.append(token)

    for token in forbidden:
        # Forbidden não usa synonyms — match exato lowercase (substring)
        if _has_any_token(haystack, [token]):
            forbidden_found.append(token)

    # L-DEV-2/4: páginas stub ("em desenvolvimento") são FAIL — rota existir != FR implementado
    stub_result = check_stub_pages(root)
    stubs_found = stub_result["stubs_found"]

    pass_ = (not missing_strong) and (not forbidden_found) and (not stubs_found)

    return {
        "pass": pass_,
        "missing_strong": missing_strong,
        "missing_soft": missing_soft,
        "forbidden_found": forbidden_found,
        "stubs_found": stubs_found,
        "details": {
            "files_scanned": files_scanned,
            "haystack_chars": len(haystack),
            "policy_present": bool(policy),
        },
    }


def summarize_result(result: dict, canonical_type: str = "") -> str:
    """Formata resultado como string legível para logs / dialogue."""
    parts = []
    if result.get("pass"):
        parts.append(f"✓ Fingerprint PASS ({canonical_type})")
    else:
        parts.append(f"✗ Fingerprint FAIL ({canonical_type})")
    if result.get("missing_strong"):
        parts.append(f"missing strong: {result['missing_strong']}")
    if result.get("forbidden_found"):
        parts.append(f"forbidden found: {result['forbidden_found']}")
    if result.get("stubs_found"):
        parts.append(f"STUB pages (FR não implementado): {result['stubs_found']}")
    if result.get("missing_soft"):
        parts.append(f"missing soft (WARN): {result['missing_soft']}")
    d = result.get("details", {})
    parts.append(f"files={d.get('files_scanned', 0)} chars={d.get('haystack_chars', 0)}")
    return " | ".join(parts)
