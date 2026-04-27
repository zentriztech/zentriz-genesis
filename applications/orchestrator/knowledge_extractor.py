"""
knowledge_extractor.py — G46: Self-learning loop.

Após cada projeto completar, extrai padrões de QA_FAIL recorrentes dos
QA reports e cria uma knowledge_entry no banco para revisão humana.

Ciclo:
  Pipeline completa
    → extract_knowledge(project_id, stack)
        → lê docs/qa/QA_REPORT_*.md do projeto
        → identifica padrões BLOCKER/MAJOR repetidos
        → salva em knowledge_entries (tabela)
        → (futuro) abre PR automático no GitHub dos SYSTEM_PROMPTs

A validação humana é OBRIGATÓRIA antes de qualquer mudança nos SYSTEM_PROMPTs.
O módulo apenas propõe — não aplica.
"""
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Padrões conhecidos mapeados a fixes — enriquecido com cada rodada
KNOWN_PATTERNS: list[dict[str, str]] = [
    # Python / FastAPI
    {
        "pattern": r"setuptools\.backends\.legacy|BackendUnavailable",
        "category": "python_fastapi",
        "symptom": "setuptools.backends.legacy não existe — BackendUnavailable no docker build",
        "fix": "build-backend = 'setuptools.build_meta' em pyproject.toml",
    },
    {
        "pattern": r"settings\.[A-Z_]{3,}|AttributeError.*Settings.*attribute",
        "category": "python_fastapi",
        "symptom": "Atributo Pydantic Settings em uppercase (settings.DATABASE_URL)",
        "fix": "Sempre acessar em lowercase: settings.database_url. Varrer com grep -rn 'settings\\.[A-Z]'",
    },
    {
        "pattern": r"DuplicateObjectError.*type.*already exists|duplicate.*ENUM",
        "category": "python_fastapi",
        "symptom": "ENUM duplicado no Alembic upgrade",
        "fix": "Usar create_type=True (default) em op.create_table; remover compare_type do env.py",
    },
    {
        "pattern": r"python-multipart|Form data requires",
        "category": "python_fastapi",
        "symptom": "RuntimeError: Form data requires python-multipart",
        "fix": "Adicionar python-multipart>=0.0.9 ao pyproject.toml",
    },
    {
        "pattern": r"bcrypt.*__about__|AttributeError.*bcrypt",
        "category": "python_fastapi",
        "symptom": "passlib incompatível com bcrypt>=4",
        "fix": "Fixar bcrypt>=3.2.0,<4.0.0 em pyproject.toml",
    },
    # Node.js / Drizzle
    {
        "pattern": r"mysql|mysqlTable|mysql2",
        "category": "nodejs_drizzle",
        "symptom": "Driver MySQL gerado para projeto PostgreSQL",
        "fix": "Usar postgres + drizzle-orm/pg-core; varrer com grep -r 'mysql' apps/src/",
    },
    {
        "pattern": r"npm ci.*package-lock|package-lock\.json.*required",
        "category": "nodejs_drizzle",
        "symptom": "npm ci falha — sem package-lock.json",
        "fix": "Substituir RUN npm ci por RUN npm install --legacy-peer-deps no Dockerfile",
    },
    {
        "pattern": r"cors\(\)|allow_origins.*\*|CORS.*sem restrição",
        "category": "any_backend",
        "symptom": "CORS sem restrição de origem",
        "fix": "cors({ origin: ['http://localhost:3000'] }) — nunca cors() vazio",
    },
    # DevOps
    {
        "pattern": r"port.*already allocated|Bind for.*failed",
        "category": "devops_docker",
        "symptom": "Porta já alocada ao subir container",
        "fix": "docker-compose.yml: name: <slug> + container_name: <slug>_api; porta ≥ 3004",
    },
    {
        "pattern": r"container.*name.*apps|project.*name.*apps",
        "category": "devops_docker",
        "symptom": "Containers com nome genérico 'apps-*' conflitam entre projetos",
        "fix": "docker-compose.yml deve ter name: <project-slug> e container_name: em cada serviço",
    },
]


def _read_qa_reports(project_id: str) -> list[str]:
    """Lê todos os QA reports do projeto do disco."""
    root = os.environ.get("PROJECT_FILES_ROOT", "/project-files")
    docs_dir = Path(root) / project_id / "docs"
    reports = []
    for f in docs_dir.glob("qa_report*.md"):
        try:
            reports.append(f.read_text(encoding="utf-8"))
        except Exception:
            pass
    return reports


def _extract_patterns(reports: list[str]) -> list[dict[str, str]]:
    """Identifica padrões conhecidos nos reports de QA."""
    found: list[dict[str, str]] = []
    seen: set[str] = set()
    combined = "\n".join(reports)

    for kp in KNOWN_PATTERNS:
        if re.search(kp["pattern"], combined, re.IGNORECASE):
            key = kp["category"] + ":" + kp["symptom"][:40]
            if key not in seen:
                seen.add(key)
                found.append({
                    "category": kp["category"],
                    "symptom": kp["symptom"],
                    "fix": kp["fix"],
                    "occurrences": len(re.findall(kp["pattern"], combined, re.IGNORECASE)),
                })

    return found


def _count_qa_fails(reports: list[str]) -> int:
    return sum(1 for r in reports if "QA_FAIL" in r)


def _detect_stack(project_id: str) -> str:
    """Detecta stack do projeto pelo backlog."""
    root = os.environ.get("PROJECT_FILES_ROOT", "/project-files")
    backlog_candidates = [
        Path(root) / project_id / "docs" / "pm" / "backend" / "BACKLOG.md",
        Path(root) / project_id / "docs" / "pm_backlog.md",
    ]
    for p in backlog_candidates:
        if p.exists():
            content = p.read_text(encoding="utf-8")[:2000].lower()
            if "fastapi" in content or "python" in content:
                return "python_fastapi"
            if "express" in content or "node" in content or "typescript" in content:
                return "nodejs_express"
            if "nestjs" in content:
                return "nodejs_nestjs"
    return "unknown"


def extract_knowledge(project_id: str, api_base_url: str = "", token: str = "") -> dict[str, Any]:
    """
    Extrai knowledge do projeto e persiste via API para revisão humana.
    Retorna summary do que foi extraído.
    """
    try:
        reports = _read_qa_reports(project_id)
        if not reports:
            logger.info("[G46] Sem QA reports para extrair knowledge. project_id=%s", project_id)
            return {"extracted": 0, "qa_fails": 0}

        qa_fails = _count_qa_fails(reports)
        patterns = _extract_patterns(reports)
        stack = _detect_stack(project_id)

        if not patterns:
            logger.info("[G46] Nenhum padrão conhecido nos QA reports. project_id=%s qa_fails=%s", project_id, qa_fails)
            return {"extracted": 0, "qa_fails": qa_fails}

        entry = {
            "project_id": project_id,
            "stack": stack,
            "qa_fails_total": qa_fails,
            "patterns": patterns,
            "extracted_at": datetime.now(timezone.utc).isoformat(),
            "status": "pending_review",  # validação humana obrigatória
            "pr_url": None,
        }

        # Persiste como dialogue entry no projeto para visibilidade no portal
        _persist_knowledge_entry(project_id, entry, api_base_url, token)

        logger.info(
            "[G46] Knowledge extraído: project=%s stack=%s patterns=%d qa_fails=%d",
            project_id, stack, len(patterns), qa_fails,
        )
        return {"extracted": len(patterns), "qa_fails": qa_fails, "stack": stack, "patterns": patterns}

    except Exception as exc:
        logger.warning("[G46] Erro ao extrair knowledge: %s", exc)
        return {"extracted": 0, "error": str(exc)}


def _persist_knowledge_entry(project_id: str, entry: dict, api_base_url: str, token: str) -> None:
    """
    Persiste como dialogue entry do tipo 'knowledge.extracted' para
    aparecer no portal e poder ser revisado/aprovado pelo usuário.
    """
    if not api_base_url or not token:
        # Fallback: salvar em arquivo local
        root = os.environ.get("PROJECT_FILES_ROOT", "/project-files")
        out_path = Path(root) / project_id / "docs" / "knowledge_entry.json"
        out_path.write_text(json.dumps(entry, ensure_ascii=False, indent=2))
        logger.info("[G46] Knowledge salvo em disco: %s", out_path)
        return

    try:
        import urllib.request
        summary = (
            f"[G46 Self-Learning] {len(entry['patterns'])} padrão(ões) extraído(s) dos QA reports "
            f"({entry['qa_fails_total']} QA_FAILs). Stack: {entry['stack']}. "
            f"Aguardando revisão humana antes de propor mudanças nos SYSTEM_PROMPTs.\n\n"
            + "\n".join(
                f"• [{p['category']}] {p['symptom']} → {p['fix']}"
                for p in entry["patterns"]
            )
        )
        payload = json.dumps({
            "fromAgent": "genesis",
            "toAgent": "human",
            "eventType": "knowledge.extracted",
            "summaryHuman": summary,
        }).encode()

        req = urllib.request.Request(
            f"{api_base_url.rstrip('/')}/api/projects/{project_id}/dialogue",
            data=payload,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=10)
        logger.info("[G46] Knowledge entry postado no diálogo do projeto.")
    except Exception as exc:
        logger.warning("[G46] Falha ao persistir knowledge entry via API: %s", exc)
        # Fallback to disk
        root = os.environ.get("PROJECT_FILES_ROOT", "/project-files")
        out_path = Path(root) / project_id / "docs" / "knowledge_entry.json"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(entry, ensure_ascii=False, indent=2))
