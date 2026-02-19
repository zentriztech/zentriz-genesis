"""
Armazenamento por projeto em disco: PROJECT_FILES_ROOT / <project_id> / docs | project.
Documentos gerados pelos agentes são salvos em docs/ com atribuição de criador (spec, engineer, cto, etc.).
Artefatos do projeto final podem ser salvos em project/.
"""
import json
import logging
import os
from pathlib import Path
from datetime import datetime

logger = logging.getLogger(__name__)

# Criadores válidos (quem gerou o documento)
CREATORS = frozenset({
    "spec", "engineer", "cto", "pm_backend", "dev_backend", "qa_backend",
    "monitor_backend", "devops_docker", "system",
})

MANIFEST_FILENAME = "manifest.json"


def _root() -> Path | None:
    root = os.environ.get("PROJECT_FILES_ROOT", "").strip()
    if not root:
        return None
    return Path(root)


def get_project_root(project_id: str) -> Path | None:
    """Retorna PROJECT_FILES_ROOT / project_id ou None se PROJECT_FILES_ROOT não estiver definido."""
    base = _root()
    if not base:
        return None
    return base / project_id


def get_docs_dir(project_id: str) -> Path | None:
    """Retorna o diretório docs do projeto (project_id/docs)."""
    root = get_project_root(project_id)
    if not root:
        return None
    return root / "docs"


def get_project_dir(project_id: str) -> Path | None:
    """Retorna o diretório project do projeto (project_id/project) para artefatos finais."""
    root = get_project_root(project_id)
    if not root:
        return None
    return root / "project"


def _ensure_docs_dir(project_id: str) -> Path | None:
    docs = get_docs_dir(project_id)
    if not docs:
        return None
    docs.mkdir(parents=True, exist_ok=True)
    return docs


def _safe_filename(name: str) -> str:
    """Remove caracteres inválidos para nome de arquivo."""
    return "".join(c for c in name if c.isalnum() or c in "._- ").strip() or "doc"


def _read_manifest(docs_dir: Path) -> list:
    manifest_path = docs_dir / MANIFEST_FILENAME
    if not manifest_path.exists():
        return []
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _write_manifest(docs_dir: Path, entries: list) -> None:
    manifest_path = docs_dir / MANIFEST_FILENAME
    manifest_path.write_text(
        json.dumps(entries, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def append_manifest(project_id: str, filename: str, creator: str, title: str = "") -> None:
    """Adiciona uma entrada ao manifest.json em docs/ do projeto."""
    docs_dir = _ensure_docs_dir(project_id)
    if not docs_dir:
        return
    entries = _read_manifest(docs_dir)
    entries.append({
        "filename": filename,
        "creator": creator,
        "title": title or filename,
        "created_at": datetime.utcnow().isoformat() + "Z",
    })
    _write_manifest(docs_dir, entries)


def write_doc(
    project_id: str,
    creator: str,
    name: str,
    content: str,
    extension: str = "md",
    title: str | None = None,
) -> Path | None:
    """
    Grava um documento em project_id/docs com atribuição de criador.
    Nome do arquivo: {creator}_{name}.{extension}
    Atualiza manifest.json com filename, creator, created_at.
    Retorna o Path do arquivo ou None se PROJECT_FILES_ROOT não estiver definido.
    """
    if creator not in CREATORS:
        logger.warning("[ProjectStorage] Criador desconhecido '%s', usando como-is.", creator)
    docs_dir = _ensure_docs_dir(project_id)
    if not docs_dir:
        return None
    safe_name = _safe_filename(name)
    filename = f"{creator}_{safe_name}.{extension}".lstrip(".")
    file_path = docs_dir / filename
    header = f"<!-- Created by: {creator} -->\n\n"
    file_path.write_text(header + content, encoding="utf-8")
    append_manifest(project_id, filename, creator, title=title or name)
    logger.info("[ProjectStorage] Gravado: %s (criador: %s)", file_path, creator)
    return file_path


def write_spec_doc(project_id: str, spec_content: str, spec_ref: str = "product_spec") -> Path | None:
    """Grava a spec do projeto em docs/ com criador 'spec'."""
    return write_doc(
        project_id,
        "spec",
        spec_ref.replace("/", "_").replace(".", "_"),
        spec_content,
        extension="md",
        title="Product Spec",
    )


def write_project_artifact(project_id: str, relative_path: str, content: str | bytes) -> Path | None:
    """
    Grava um artefato em project_id/project/ (código ou config final).
    relative_path pode ser "Dockerfile", "src/index.js", etc.
    """
    root = get_project_dir(project_id)
    if not root:
        return None
    root.mkdir(parents=True, exist_ok=True)
    path = root / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content, encoding="utf-8")
    logger.info("[ProjectStorage] Artefato projeto: %s", path)
    return path


def is_enabled() -> bool:
    """Retorna True se PROJECT_FILES_ROOT está definido e o storage está ativo."""
    return _root() is not None
