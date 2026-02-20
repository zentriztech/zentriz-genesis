"""
Testes do project_storage (Blueprint Fase 2): project_id obrigatório, path traversal bloqueado.
"""
import os
import tempfile
import pytest


@pytest.fixture
def storage_root(tmp_path):
    """Define PROJECT_FILES_ROOT para um diretório temporário."""
    before = os.environ.get("PROJECT_FILES_ROOT")
    os.environ["PROJECT_FILES_ROOT"] = str(tmp_path)
    yield tmp_path
    if before is not None:
        os.environ["PROJECT_FILES_ROOT"] = before
    elif "PROJECT_FILES_ROOT" in os.environ:
        del os.environ["PROJECT_FILES_ROOT"]


def test_get_project_root_requires_project_id(storage_root):
    from orchestrator.project_storage import get_project_root, _require_project_id
    assert get_project_root("") is None
    assert get_project_root(None) is None
    assert _require_project_id("") is None
    assert _require_project_id("  ") is None
    assert get_project_root("p1") is not None
    assert _require_project_id("p1") is not None


def test_ensure_project_dirs_creates_docs_project_apps(storage_root):
    from orchestrator.project_storage import ensure_project_dirs, get_docs_dir, get_project_dir, get_apps_dir
    ok = ensure_project_dirs("proj1")
    assert ok is True
    assert get_docs_dir("proj1").exists()
    assert get_project_dir("proj1").exists()
    assert get_apps_dir("proj1").exists()


def test_ensure_project_dirs_fails_empty_project_id(storage_root):
    from orchestrator.project_storage import ensure_project_dirs
    assert ensure_project_dirs("") is False
    assert ensure_project_dirs(None) is False


def test_write_apps_artifact_blocks_traversal(storage_root):
    from orchestrator.project_storage import write_apps_artifact
    # Path com .. deve ser bloqueado (storage já verifica)
    out = write_apps_artifact("p1", "../../../etc/foo", "content")
    assert out is None


def test_write_apps_artifact_success(storage_root):
    from orchestrator.project_storage import write_apps_artifact, get_apps_dir
    out = write_apps_artifact("p2", "src/index.js", "console.log('hi');")
    assert out is not None
    assert (get_apps_dir("p2") / "src" / "index.js").read_text() == "console.log('hi');"
