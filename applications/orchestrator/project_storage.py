"""
Armazenamento por projeto em disco: PROJECT_FILES_ROOT / <project_id> / docs | project | apps.
Blueprint V2 REV2: project_id obrigatório; escrita atômica (temp + rename); lock por projeto.
"""
import json
import logging
import os
import threading
from pathlib import Path
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

# Lock por project_id (evita escrita concorrente no mesmo projeto)
_project_locks: dict[str, threading.Lock] = {}
_locks_mutex = threading.Lock()


def _project_lock(project_id: str) -> threading.Lock:
    with _locks_mutex:
        if project_id not in _project_locks:
            _project_locks[project_id] = threading.Lock()
        return _project_locks[project_id]

# Criadores válidos (quem gerou o documento)
CREATORS = frozenset({
    "spec", "engineer", "cto", "pm", "dev", "qa", "monitor", "devops", "system",
    # Legacy (for reading existing docs)
    "pm_backend", "dev_backend", "qa_backend", "monitor_backend", "devops_docker",
})

MANIFEST_FILENAME = "manifest.json"


def _root() -> Path | None:
    """Raiz dos projetos. Usa PROJECT_FILES_ROOT ou fallback ~/zentriz-files para resiliência."""
    root = os.environ.get("PROJECT_FILES_ROOT", "").strip()
    if not root:
        root = os.environ.get("HOST_PROJECT_FILES_ROOT", "").strip()
    if not root:
        root = str(Path.home() / "zentriz-files")
    return Path(root)


def get_files_root() -> Path:
    """Raiz dos arquivos de projeto (sempre definida: env ou fallback ~/zentriz-files)."""
    return _root()


def get_project_root(project_id: str, product_id: str | None = None) -> Path | None:
    """I-1: Retorna path do projeto.

    Com product_id: <FILES_ROOT>/<product_id>/<project_id>/
    Sem product_id: <FILES_ROOT>/<project_id>/  (standalone ou backward-compat)

    Prioridade: se diretório com product_id existir, usa; senão cria no path correto.
    """
    base = _root()
    if not base or not (project_id and str(project_id).strip()):
        return None
    pid = str(project_id).strip()
    if product_id and str(product_id).strip():
        product_path = base / str(product_id).strip() / pid
        # Se já existe standalone (projeto antigo), mantém standalone
        standalone = base / pid
        if standalone.exists() and not product_path.exists():
            return standalone
        return product_path
    return base / pid


def get_product_root(product_id: str) -> Path | None:
    """I-1: Retorna <FILES_ROOT>/<product_id>/ — pasta raiz do produto."""
    base = _root()
    if not base or not (product_id and str(product_id).strip()):
        return None
    return base / str(product_id).strip()


def _require_project_id(project_id: str, product_id: str | None = None) -> Path | None:
    """
    Exige project_id não vazio quando storage está ativo (Blueprint 1.1).
    Retorna get_project_root(project_id, product_id) ou None.
    """
    pid = (project_id or "").strip() if project_id else ""
    if not pid:
        if _root() is not None:
            logger.warning("[ProjectStorage] BLOCKED: project_id vazio com storage ativo.")
        return None
    return get_project_root(pid, product_id)


def ensure_project_dirs(project_id: str, product_id: str | None = None) -> bool:
    """I-1: Garante docs/, project/, apps/ sob o path correto do projeto.

    Se product_id fornecido: cria em <FILES_ROOT>/<product_id>/<project_id>/
    Também garante que <FILES_ROOT>/<product_id>/contracts/ existe.
    """
    root = _require_project_id(project_id, product_id)
    if not root:
        return False
    for sub in ("docs", "project", "apps"):
        (root / sub).mkdir(parents=True, exist_ok=True)
    # I-2: garantir pasta contracts/ na raiz do produto
    if product_id:
        prod_root = get_product_root(product_id)
        if prod_root:
            (prod_root / "contracts").mkdir(parents=True, exist_ok=True)
    return True


def copy_contract_to_product(project_id: str, product_id: str, project_title: str = "") -> bool:
    """I-2: Copia api_contract.md do projeto para <product_id>/contracts/<slug>.api_contract.md.

    Chamado quando o projeto é aceito — centraliza contratos para predecessores encontrarem facilmente.
    """
    try:
        proj_root = get_project_root(project_id, product_id)
        if not proj_root:
            return False
        contract_src = proj_root / "project" / "api_contract.md"
        if not contract_src.exists():
            logger.debug("[I-2] api_contract.md ausente em %s — nada a copiar", project_id[:8])
            return False
        prod_root = get_product_root(product_id)
        if not prod_root:
            return False
        contracts_dir = prod_root / "contracts"
        contracts_dir.mkdir(parents=True, exist_ok=True)
        slug = project_title.lower().replace(" ", "-").replace("_", "-") if project_title else project_id[:8]
        dest = contracts_dir / f"{slug}.api_contract.md"
        import shutil
        shutil.copy2(str(contract_src), str(dest))
        logger.info("[I-2] Contrato copiado: %s → %s", contract_src.name, dest)
        return True
    except Exception as _e:
        logger.debug("[I-2] Falha ao copiar contrato: %s", _e)
        return False


def _atomic_write(path: Path, content: str | bytes) -> None:
    """Escrita atômica: grava em path.tmp e renomeia para path (Blueprint 6.2)."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        if isinstance(content, bytes):
            tmp.write_bytes(content)
        else:
            tmp.write_text(content, encoding="utf-8")
        tmp.replace(path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def get_docs_dir(project_id: str) -> Path | None:
    """Retorna o diretório docs do projeto (project_id/docs)."""
    root = get_project_root(project_id)
    if not root:
        return None
    return root / "docs"


def get_project_dir(project_id: str) -> Path | None:
    """Retorna o diretório project do projeto (project_id/project) para artefatos finais (infra, DevOps)."""
    root = get_project_root(project_id)
    if not root:
        return None
    return root / "project"


def get_connect_dir(project_id: str, connect_version: str) -> Path | None:
    """Retorna o diretório project/connect/v<version> do projeto."""
    project_dir = get_project_dir(project_id)
    if not project_dir:
        return None
    version_dir = f"v{str(connect_version).lstrip('v')}"
    return project_dir / "connect" / version_dir


def get_apps_dir(project_id: str) -> Path | None:
    """Retorna o diretório apps do projeto (project_id/apps) para código da aplicação gerado pelo Dev."""
    root = get_project_root(project_id)
    if not root:
        return None
    return root / "apps"


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
    _atomic_write(manifest_path, json.dumps(entries, ensure_ascii=False, indent=2))


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
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
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
    Grava um documento em project_id/docs com atribuição de criador (Blueprint: project_id obrigatório, escrita atômica).
    Retorna o Path do arquivo ou None se project_id inválido ou storage inativo.
    """
    if not _require_project_id(project_id):
        return None
    if creator not in CREATORS:
        logger.warning("[ProjectStorage] Criador desconhecido '%s', usando como-is.", creator)
    with _project_lock(project_id):
        docs_dir = _ensure_docs_dir(project_id)
        if not docs_dir:
            return None
        safe_name = _safe_filename(name)
        filename = f"{creator}_{safe_name}.{extension}".lstrip(".")
        file_path = docs_dir / filename
        header = f"<!-- Created by: {creator} -->\n\n"
        _atomic_write(file_path, header + content)
        append_manifest(project_id, filename, creator, title=title or name)
    logger.info("[ProjectStorage] Gravado: %s (criador: %s)", file_path, creator)
    return file_path


def write_doc_by_path(
    project_id: str,
    creator: str,
    relative_path_under_docs: str,
    content: str,
    title: str | None = None,
) -> Path | None:
    """
    Grava um documento em project_id/docs/<relative_path_under_docs>, preservando estrutura de pastas.
    relative_path_under_docs é relativo a docs/ (ex.: dev/dev_implementation_TSK-001.md). Bloqueia path traversal.
    Retorna o Path do arquivo ou None se inválido.
    """
    if not _require_project_id(project_id):
        return None
    raw = (relative_path_under_docs or "").strip().replace("\\", "/").lstrip("/")
    if not raw or ".." in raw or raw.startswith("/"):
        logger.warning("[ProjectStorage] write_doc_by_path bloqueado (path): %s", relative_path_under_docs)
        return None
    parts = [p for p in raw.split("/") if p and p != "."]
    if not parts:
        return None
    if creator not in CREATORS:
        logger.warning("[ProjectStorage] Criador desconhecido '%s', usando como-is.", creator)
    with _project_lock(project_id):
        docs_dir = _ensure_docs_dir(project_id)
        if not docs_dir:
            return None
        file_path = docs_dir.joinpath(*parts)
        file_path.parent.mkdir(parents=True, exist_ok=True)
        header = f"<!-- Created by: {creator} -->\n\n"
        _atomic_write(file_path, header + content)
        # GAP-Portal: salvar path relativo completo (docs/subdir/file.md) para que
        # a rota doc-content consiga encontrar o arquivo — não apenas o filename final.
        filename_for_manifest = "/".join(["docs"] + parts) if len(parts) > 1 else parts[-1]
        append_manifest(project_id, filename_for_manifest, creator, title=title or parts[-1])
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
    Grava um artefato em project_id/project/ (infra, DevOps). project_id obrigatório; escrita atômica.
    relative_path pode ser "Dockerfile", "docker-compose.yml", etc. Bloqueia path traversal (.., absolutos).
    """
    root = get_project_dir(project_id)
    if not _require_project_id(project_id) or not root:
        return None
    # Sanitize relative_path: no .. or absolute
    if ".." in relative_path or relative_path.startswith("/"):
        logger.warning("[ProjectStorage] Path bloqueado (traversal): %s", relative_path)
        return None
    with _project_lock(project_id):
        root.mkdir(parents=True, exist_ok=True)
        path = root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write(path, content)
    logger.info("[ProjectStorage] Artefato projeto: %s", path)
    return path


def write_connect_artifact(project_id: str, connect_version: str, filename: str, content: str | bytes) -> Path | None:
    """
    Grava um artefato contratual do Connect em project/connect/v<version>/filename.
    """
    version_dir = f"v{str(connect_version).lstrip('v')}"
    relative_path = f"connect/{version_dir}/{filename}".lstrip("/")
    return write_project_artifact(project_id, relative_path, content)


def write_apps_artifact(project_id: str, relative_path: str, content: str | bytes) -> Path | None:
    """
    Grava um artefato em project_id/apps/ (código gerado pelo Dev). project_id obrigatório; escrita atômica.
    relative_path pode ser "src/index.js", "package.json", etc. Bloqueia path traversal.
    """
    root = get_apps_dir(project_id)
    if not _require_project_id(project_id) or not root:
        return None
    if ".." in relative_path or relative_path.startswith("/"):
        logger.warning("[ProjectStorage] Path bloqueado (traversal): %s", relative_path)
        return None
    with _project_lock(project_id):
        root.mkdir(parents=True, exist_ok=True)
        path = root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write(path, content)
    logger.info("[ProjectStorage] Artefato apps: %s", path)
    return path


def is_enabled() -> bool:
    """Retorna True se PROJECT_FILES_ROOT está definido e o storage está ativo."""
    return _root() is not None
