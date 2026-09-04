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


# ── Bloco 2 H5: exports completos + re-export opaco; H6: herança de tasks ─────────────────────

def test_exported_symbols_h5_formas_adicionais():
    ts = (
        "export { a, b as c, d }\n"
        "export default function () {}\n"
        "export type { T } from './t'\n"
        "export abstract class Base {}\n"
    )
    assert runner._exported_symbols(ts) == {"a", "c", "d", "default", "Base"}
    cjs = "module.exports = { alpha, beta: fn, 'gamma': g }\nexports.delta = 1\nmodule.exports.eps = 2\n"
    assert runner._exported_symbols(cjs) == {"alpha", "beta", "gamma", "delta", "eps"}
    py_all = "__all__ = [\n  'publico',\n  \"outro\",\n]\ndef publico(): ...\ndef _privado(): ...\ndef nao_listado(): ...\n"
    assert runner._exported_symbols(py_all) == {"publico", "outro"}          # __all__ literal sobrepõe
    py = "def publico(): ...\ndef _privado(): ...\nclass Repo: ...\n"
    assert runner._exported_symbols(py) == {"publico", "Repo"}               # sem __all__: sem `_` inicial
    go = "type Order struct{}\nvar Version = \"1\"\nconst maxN = 3\nfunc (o Order) Total() int { return 0 }\nfunc helper() {}\n"
    assert runner._exported_symbols(go) == {"Order", "Version", "Total"}


def test_exports_opaque_pula_checagem_de_simbolos(tmp_path: Path):
    assert runner._exports_opaque("export * from './x'\n")
    assert runner._exports_opaque("export * as ns from './x'\n")
    assert runner._exports_opaque("module.exports = require('./impl')\n")
    assert runner._exports_opaque("__all__ = []\n__all__ += other.__all__\n")
    assert not runner._exports_opaque("export { a } from './x'\nexport const b = 1\n")
    apps = tmp_path / "apps"; (apps / "api" / "src").mkdir(parents=True)
    (apps / "api" / "src" / "index.ts").write_text("export * from './a'\nexport function keep() {}\n")
    ctx = PipelineContext("p"); ctx.evolution_scope = ["apps/api/**"]
    # reescreve o barrel SEM `keep` — opaco → não acusa (falso-negativo aceitável)
    allowed, violations = runner._evolution_scope_check(ctx, [{"path": "apps/api/src/index.ts", "content": "export * from './a'\nexport * from './b'\n"}], apps)
    assert violations == [] and len(allowed) == 1


def test_inherit_parent_tasks_mapeia_done_como_tsk_inh(monkeypatch):
    parent_tasks = [
        {"taskId": "TSK-BE-001", "status": "DONE", "module": "backend", "ownerRole": "DEV_BACKEND", "requirements": "Criar CRUD"},
        {"taskId": "TSK-WEB-002", "status": "QA_PASS", "module": "web", "ownerRole": "DEV_WEB", "requirements": "Tela X"},
        {"taskId": "TSK-BE-003", "status": "QA_FAIL", "module": "backend", "ownerRole": "DEV_BACKEND"},   # não terminal → fora
        {"taskId": "TSK-DEVOPS-001", "status": "DONE", "module": "backend", "ownerRole": "DEVOPS"},         # devops → fora
        {"taskId": "TSK-FULL-TEST", "status": "DONE", "module": "backend", "ownerRole": "QA"},              # full-test → fora
        {"taskId": "TSK-INH-BE-000", "status": "DONE", "module": "backend", "ownerRole": "DEV"},            # já herdada → fora
    ]
    posted: list = []
    monkeypatch.setattr(runner, "_api_get", lambda path: (parent_tasks, 200))
    monkeypatch.setattr(runner, "_api_post", lambda path, body: (posted.append((path, body)) or ({}, 200)))
    n = runner._inherit_parent_tasks("child", "parent")
    assert n == 2
    path, body = posted[0]
    assert path == "/api/projects/child/tasks"
    ids = [t["task_id"] for t in body["tasks"]]
    assert ids == ["TSK-INH-BE-001", "TSK-INH-WEB-002"]
    assert all(t["status"] == "DONE" for t in body["tasks"])
    assert body["tasks"][0]["requirements"].startswith("[HERDADA da versão anterior — TSK-BE-001]")
    assert body["tasks"][1]["owner_role"] == "DEV_WEB" and body["tasks"][1]["module"] == "web"
    # pai sem tasks / API falhou → 0, sem POST
    posted.clear()
    monkeypatch.setattr(runner, "_api_get", lambda path: (None, 500))
    assert runner._inherit_parent_tasks("child", "parent") == 0 and posted == []
