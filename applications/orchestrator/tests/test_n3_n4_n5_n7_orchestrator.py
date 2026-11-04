"""4.5b N-3 (gate de árvore do Cyborg vê lockfile), N-4/N-5 (baseline), N-7/TSK-FULL-TEST (motivo do NOT_RUN)."""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from orchestrator import cyborg_v3, runner


# ───────────── N-3: fixture que reproduz o PR #5 (pnpm-lock.yaml +5.486 fora do files_allowed) ─────────────
@pytest.fixture
def apps(tmp_path):
    a = tmp_path / "apps"
    (a / "src").mkdir(parents=True)
    (a / "src" / "retry.util.ts").write_text("export const retry = 1;\n")
    (a / "package.json").write_text("{}")
    (a / "package-lock.json").write_text('{"lockfileVersion": 3}')
    return a


SCOPE = ["src/retry.util.ts", "src/retry.util.spec.ts"]


def test_gate_de_arvore_ve_e_remove_lockfile_gerado_pelo_build(apps):
    before = cyborg_v3.snapshot_apps_tree(apps)
    (apps / "pnpm-lock.yaml").write_text("lockfileVersion: 9\n" * 5486)        # efeito colateral do `pnpm install`
    (apps / "node_modules" / "x").mkdir(parents=True); (apps / "node_modules" / "x" / "i.js").write_text("1")
    (apps / "src" / "retry.util.ts").write_text("export const retry = 2;\n")    # dentro do escopo: ok
    pending, fixed = cyborg_v3.audit_apps_tree_changes(apps, before, SCOPE)
    assert pending == []
    assert any("LOCKFILE GERADO" in f and "pnpm-lock.yaml" in f for f in fixed)
    assert not (apps / "pnpm-lock.yaml").exists()
    assert (apps / "package-lock.json").exists()


def test_gate_de_arvore_restaura_lockfile_preexistente_reescrito(apps):
    before = cyborg_v3.snapshot_apps_tree(apps)
    (apps / "package-lock.json").write_text('{"lockfileVersion": 3, "x": 1}')
    pending, fixed = cyborg_v3.audit_apps_tree_changes(apps, before, SCOPE)
    assert pending == [] and any("RESTAURADO" in f for f in fixed)
    assert (apps / "package-lock.json").read_text() == '{"lockfileVersion": 3}'


def test_gate_de_arvore_aponta_arquivo_fora_do_files_allowed(apps):
    before = cyborg_v3.snapshot_apps_tree(apps)
    (apps / "src" / "other.ts").write_text("export const o = 1;\n")
    (apps / "tsconfig.tsbuildinfo").write_text("{}")                             # subproduto de build: ignorado
    pending, fixed = cyborg_v3.audit_apps_tree_changes(apps, before, SCOPE)
    assert fixed == [] and len(pending) == 1 and "FORA DO ESCOPO" in pending[0] and "src/other.ts" in pending[0]


def test_gate_de_arvore_sem_escopo_so_cuida_de_lockfile(apps):
    before = cyborg_v3.snapshot_apps_tree(apps)
    (apps / "src" / "other.ts").write_text("x")
    pending, _ = cyborg_v3.audit_apps_tree_changes(apps, before, [])
    assert pending == []


def test_run_cyborg_v3_rebaixa_delivered_quando_ha_arquivo_fora_do_escopo(apps, monkeypatch):
    monkeypatch.setattr(cyborg_v3, "_resolve_proj_dir", lambda pid, prod: apps.parent)
    monkeypatch.setattr(cyborg_v3, "_cyborg_evolution_scope", lambda pid: SCOPE)
    monkeypatch.setattr(cyborg_v3, "_post_dialogue", lambda *a, **k: None)
    monkeypatch.setattr(cyborg_v3, "_persist_cyborg_violations", lambda *a, **k: None)

    def _impl(pid, tid, prod):
        (apps / "pnpm-lock.yaml").write_text("lock")
        (apps / "src" / "other.ts").write_text("x")
        return cyborg_v3.CyborgV3Run(project_id=pid, tenant_id=tid, prod_id=prod, started_at=0, model_id="m",
                                     final_status="delivered", reason="ok")
    monkeypatch.setattr(cyborg_v3, "_run_cyborg_v3_impl", _impl)
    run = cyborg_v3.run_cyborg_v3("p1", "t1", None)
    assert run.final_status == "needs_human" and "gate de árvore" in run.reason
    assert not (apps / "pnpm-lock.yaml").exists()


# ───────────── N-4 / N-5 ─────────────
def _ctx(bl):
    return SimpleNamespace(evolution_baseline=bl)


def test_n4_baseline_no_tests_nao_e_baseline_confiavel(monkeypatch):
    monkeypatch.delenv("EVOLUTION_P2P_MODE", raising=False)
    monkeypatch.delenv("EVOLUTION_P2P_REQUIRED", raising=False)
    r = runner._evo_p2p_unmeasured_reason(_ctx({"status": "no_tests", "no_tests": True, "total": 0}))
    assert r and "NÃO medida" in r and "EVOLUTION_P2P_REQUIRED=0" in r
    monkeypatch.setenv("EVOLUTION_P2P_REQUIRED", "0")      # saída explícita continua valendo
    assert runner._evo_p2p_unmeasured_reason(_ctx({"status": "no_tests", "no_tests": True})) is None


def test_n5_baseline_com_erro_e_remedida_ao_retomar():
    assert runner._evo_baseline_needs_measure(None)
    assert runner._evo_baseline_needs_measure({})
    assert runner._evo_baseline_needs_measure({"status": "error", "error": "npm install falhou (rc=243)", "kind": "baseline"})
    assert not runner._evo_baseline_needs_measure({"status": "passed", "passed": 3})
    assert not runner._evo_baseline_needs_measure({"status": "no_tests", "no_tests": True})   # medição concluída


def test_n5_o_gatilho_da_baseline_usa_o_helper():
    src = Path(runner.__file__).read_text(encoding="utf-8")
    assert "and not pipeline_ctx.evolution_baseline:" not in src
    assert "_evo_baseline_needs_measure(pipeline_ctx.evolution_baseline)" in src


# ───────────── N-7 / TSK-FULL-TEST: o motivo real chega ao NOT_RUN ─────────────
def test_motivo_do_502_do_full_test_server_e_legivel():
    body = json.dumps({"status": "error", "output": "nenhum slot de LLM do tenant conseguiu rodar o TSK-FULL-TEST",
                       "llm_slots_descartados": ["bedrock/us.anthropic.claude-sonnet-5-5: slot Bedrock sem credencial própria"]})
    msg = runner._full_test_failure_reason(RuntimeError(f"/run-full-test retornou 502: {body}"))
    assert "HTTP 502" in msg and "slots descartados" in msg and "credencial própria" in msg


def test_motivo_de_servidor_inacessivel():
    assert "inacessível" in runner._full_test_failure_reason(ConnectionRefusedError("[Errno 111] Connection refused"))
