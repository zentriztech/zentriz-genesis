"""N-1 (execução real 4.5b): node_modules/dist fora do contexto do LLM + teto defensivo que falha ALTO."""
import pytest

from orchestrator import context_files as cf


def _mk(root, rel, content="x"):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


@pytest.fixture
def proj(tmp_path):
    apps = tmp_path / "proj1" / "apps"
    _mk(apps, "src/index.ts", "export const a = 1")
    _mk(apps, "package.json", "{}")
    for i in range(300):
        _mk(apps, f"node_modules/pkg{i}/index.js", "module.exports = 1")
    _mk(apps, ".next/cache/a.js")
    _mk(apps, "dist/main.js")
    _mk(apps, "pnpm-lock.yaml", "lockfileVersion: 9")
    _mk(apps, "package-lock.json", "{}")
    return apps


def test_collect_exclui_node_modules_dist_next_e_lockfiles(proj):
    arts = cf.collect_context_artifacts(proj, proj.parent.parent)
    paths = sorted(a["path"] for a in arts)
    assert paths == ["proj1/apps/package.json", "proj1/apps/src/index.ts"]


def test_teto_total_falha_alto_com_mensagem_acionavel(proj):
    _mk(proj, "src/big1.ts", "a" * 40_000)
    _mk(proj, "src/big2.ts", "a" * 40_000)
    with pytest.raises(cf.ContextTooLargeError) as ei:
        cf.collect_context_artifacts(proj, proj.parent.parent, max_total_bytes=50_000)
    assert "CONTEXT_MAX_TOTAL_BYTES" in str(ei.value) and "teto defensivo" in str(ei.value)


def test_rglob_filtered_ignora_node_modules(proj):
    found = [p.name for p in cf.rglob_filtered(proj, "*.js")]
    assert found == []  # só havia .js dentro de node_modules/dist/.next
    assert [p.name for p in cf.rglob_filtered(proj, "*.ts")] == ["index.ts"]


def test_runner_monta_contexto_do_dev_sem_node_modules(proj, monkeypatch):
    """O helper usado pelo runner (5061) não pode devolver nada de node_modules (reproduz os US$ 26,16)."""
    import inspect
    from orchestrator import runner
    src = inspect.getsource(runner)
    assert "_apps_root.rglob(" not in src, "varredura sem poda de apps/ voltou ao runner"
    arts = cf.collect_context_artifacts(proj, proj.parent.parent)
    assert not any("node_modules" in a["path"] for a in arts)
