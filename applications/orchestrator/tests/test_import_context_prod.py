"""test_import_context_prod.py — F1 (adversarial RFC-0004 Onda 1).

Em produção o runner sobe como `python -m orchestrator.runner` com cwd=/app — imports
BARE (`from spec_tree_hash import ...`) não resolvem lá, e o except do gate engolia o
ModuleNotFoundError → fail-open silencioso. Os testes rodam de DENTRO de orchestrator/
(cwd no sys.path), então nunca reproduziam o contexto de prod. Este teste importa os
módulos exatamente como prod importa: pelo pacote `orchestrator.` a partir do diretório
PAI, num subprocesso limpo.
"""
import subprocess
import sys
from pathlib import Path

PARENT = Path(__file__).resolve().parents[2]  # applications/ (pai do pacote orchestrator)


def _import_from_parent(stmt: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-c", stmt],
        cwd=str(PARENT), capture_output=True, text=True, timeout=60,
    )


def test_spec_tree_hash_importable_as_package():
    r = _import_from_parent("from orchestrator.spec_tree_hash import hash_spec_tree_from_files; print('ok')")
    assert r.returncode == 0, f"import de pacote falhou (contexto de prod): {r.stderr[-400:]}"
    assert "ok" in r.stdout


def test_runner_spec_hash_gate_resolves_module_in_prod_context():
    # O gate do runner usa dual-import; o caminho de PROD é o de pacote — se este quebrar,
    # o gate spec-approved vira fail-open silencioso de novo.
    r = _import_from_parent(
        "import ast, pathlib\n"
        "src = pathlib.Path('orchestrator/runner.py').read_text()\n"
        "assert 'from orchestrator.spec_tree_hash import' in src, 'runner sem import de pacote'\n"
        "from orchestrator.spec_tree_hash import compute_spec_tree_hash\n"
        "print('ok')"
    )
    assert r.returncode == 0, f"{r.stderr[-400:]}"
    assert "ok" in r.stdout
