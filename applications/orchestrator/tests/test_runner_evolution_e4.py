"""Evoluir E4 — gate determinístico de escopo (globs do RFC) + preservação de símbolos + inputs ao Dev."""
from __future__ import annotations

from pathlib import Path

import orchestrator.runner as runner
from orchestrator.pipeline_context import PipelineContext


def test_glob_matching_com_duas_estrelas_e_prefixo_apps():
    scope = ["apps/api/src/reports/**", "api/src/routes/reports.ts", "web/src/pages/reports/**"]
    assert runner._evo_path_allowed("api/src/reports/pdf.ts", scope)
    assert runner._evo_path_allowed("api/src/reports/deep/x/y.ts", scope)
    assert runner._evo_path_allowed("api/src/routes/reports.ts", scope)
    assert not runner._evo_path_allowed("api/src/routes/users.ts", scope)
    assert not runner._evo_path_allowed("api/src/reportsX/a.ts", scope)
    # sempre permitidos: testes e docs
    assert runner._evo_path_allowed("api/tests/reports.test.ts", scope)
    assert runner._evo_path_allowed("api/src/reports.spec.ts", scope)
    assert runner._evo_path_allowed("docs/decisoes.md", scope)
    assert runner._evo_path_allowed("web/__tests__/x.tsx", scope)


def test_exported_symbols_ts_py_go():
    ts = "export interface User {}\nexport async function main() {}\nexport const cfg = 1;\nexport default class Svc {}\nconst interno = 2;\n"
    assert runner._exported_symbols(ts) == {"User", "main", "cfg", "Svc"}
    py = "class Repo:\n    pass\n\ndef handler(x):\n    return x\n\nasync def worker():\n    pass\n\n    def metodo(self):\n        pass\n"
    assert runner._exported_symbols(py) == {"Repo", "handler", "worker"}
    assert runner._exported_symbols("func Public() {}\nfunc private() {}\nfunc (s *S) Method() {}\n") == {"Public", "Method"}


def test_scope_check_descarta_fora_do_escopo_e_simbolos_removidos(tmp_path: Path):
    apps = tmp_path / "apps"; (apps / "api" / "src" / "reports").mkdir(parents=True)
    (apps / "api" / "src" / "reports" / "service.ts").write_text("export function listReports() {}\nexport function exportPdf() {}\n")
    ctx = PipelineContext("p"); ctx.evolution_scope = ["apps/api/src/reports/**"]
    arts = [
        {"path": "apps/api/src/reports/pdf.ts", "content": "export function renderPdf() {}"},                   # novo, no escopo
        {"path": "apps/api/src/reports/service.ts", "content": "export function exportPdf() {}\n"},           # reescrito SEM listReports
        {"path": "apps/api/src/users/user.ts", "content": "export const x = 1"},                              # fora do escopo
        {"path": "apps/api/tests/reports.test.ts", "content": "test('x', () => {})"},                          # teste: sempre ok
        {"path": "docs/dev/nota.md", "content": "# nota"},                                                     # docs: passthrough
    ]
    allowed, violations = runner._evolution_scope_check(ctx, arts, apps)
    paths = [a["path"] for a in allowed]
    assert "apps/api/src/reports/pdf.ts" in paths and "apps/api/tests/reports.test.ts" in paths and "docs/dev/nota.md" in paths
    assert "apps/api/src/users/user.ts" not in paths and "apps/api/src/reports/service.ts" not in paths
    assert len(violations) == 2
    assert any("FORA DO ESCOPO" in v and "users/user.ts" in v for v in violations)
    assert any("SÍMBOLOS REMOVIDOS" in v and "listReports" in v for v in violations)
    # arquivo existente reescrito PRESERVANDO exports → permitido
    ok_art = [{"path": "apps/api/src/reports/service.ts", "content": "export function listReports() {}\nexport function exportPdf() {}\nexport function novo() {}\n"}]
    allowed2, v2 = runner._evolution_scope_check(ctx, ok_art, apps)
    assert len(allowed2) == 1 and v2 == []


def test_glob_de_diretorio_sem_curinga_casa_a_arvore():
    # como um humano escreve no RFC: pasta com/sem barra final
    assert runner._evo_path_allowed("api/src/reports/pdf.ts", ["apps/api/src/reports/"])
    assert runner._evo_path_allowed("api/src/reports/deep/x.ts", ["apps/api/src/reports"])
    assert not runner._evo_path_allowed("api/src/reportsX/x.ts", ["apps/api/src/reports"])
    # arquivo exato continua exato
    assert runner._evo_path_allowed("api/src/a.ts", ["apps/api/src/a.ts"])
    assert not runner._evo_path_allowed("api/src/a.ts.bak", ["apps/api/src/a.ts"])


def test_simbolo_movido_para_outro_arquivo_entregue_nao_e_violacao(tmp_path: Path):
    apps = tmp_path / "apps"; (apps / "api" / "src" / "reports").mkdir(parents=True)
    (apps / "api" / "src" / "reports" / "service.ts").write_text("export function listReports() {}\nexport function exportPdf() {}\n")
    ctx = PipelineContext("p"); ctx.evolution_scope = ["apps/api/src/reports/**"]
    arts = [
        {"path": "apps/api/src/reports/service.ts", "content": "export function listReports() {}\n"},   # exportPdf saiu daqui…
        {"path": "apps/api/src/reports/pdf.ts", "content": "export function exportPdf() {}\n"},         # …e foi para cá (refactor)
    ]
    allowed, violations = runner._evolution_scope_check(ctx, arts, apps)
    assert violations == [] and len(allowed) == 2


def test_registro_de_violacao_conta_rodadas_nao_arquivos():
    ctx = PipelineContext("p"); ctx.evolution_scope = ["apps/api/**"]
    three = ["FORA DO ESCOPO do RFC: apps/web/a.ts", "FORA DO ESCOPO do RFC: apps/web/b.ts", "FORA DO ESCOPO do RFC: apps/web/c.ts"]
    assert runner._evo_register_violation(ctx, "T1", three) == 1          # 3 arquivos numa resposta = 1 rodada
    assert runner._evo_register_violation(ctx, "T1", three[:1]) == 2
    assert runner._evo_register_violation(ctx, "T2", three[:1]) == 1      # por task
    assert ctx.evolution_violation_rounds == {"T1": 2, "T2": 1}
    assert len(ctx.evolution_violations["T1"]) == 4
    # cap de mensagens
    for _ in range(10):
        runner._evo_register_violation(ctx, "T1", three)
    assert len(ctx.evolution_violations["T1"]) == runner._EVO_MAX_VIOLATION_MSGS
    assert runner._evo_register_violation(None, "T9", three) == 1


def test_scope_check_sem_escopo_e_passthrough_e_inputs_do_dev(tmp_path: Path):
    ctx = PipelineContext("p")
    arts = [{"path": "apps/qualquer.ts", "content": "x"}]
    assert runner._evolution_scope_check(ctx, arts, tmp_path) == (arts, [])
    assert runner._evolution_scope_check(None, arts, tmp_path) == (arts, [])
    assert ctx.evolution_scope_inputs("T1") == {}
    ctx.evolution_scope = ["apps/api/**"]
    ctx.evolution_violations = {"T1": ["FORA DO ESCOPO do RFC: apps/web/x.ts"]}
    inp = ctx.evolution_scope_inputs("T1")
    assert inp["evolution_scope"] == ["apps/api/**"] and "DESCARTADOS" in inp["evolution_scope_instruction"]
    assert inp["evolution_scope_violations"] == ["FORA DO ESCOPO do RFC: apps/web/x.ts"]
    assert "evolution_scope_violations" not in ctx.evolution_scope_inputs("T2")
    # checkpoint preserva escopo/compat/violações
    ctx.evolution_compat = "minor"
    ctx.save_checkpoint(tmp_path)
    r = PipelineContext.load_checkpoint(tmp_path, "p")
    assert r.evolution_scope == ["apps/api/**"] and r.evolution_compat == "minor" and r.evolution_violations == ctx.evolution_violations
    assert r.evolution_violation_rounds == ctx.evolution_violation_rounds
    assert r.build_inputs_for_pm()["evolution_scope"] == ["apps/api/**"]
