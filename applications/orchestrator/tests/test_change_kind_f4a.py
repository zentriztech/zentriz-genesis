"""Tarefas 4.1 e 4.2 do plano EVOLUIR-PROJETO-BANCADA — Fase 4 (fábrica): tipo do card e origem da spec nos prompts
do CTO/PM/Dev, e vínculo `card_id` das TASKs novas `TSK-EVO-*` sem refazer as herdadas `DONE`.

Sem rede, sem LLM, sem API real (fake em memória do upsert de tasks).
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

import orchestrator.runner as runner
from orchestrator.agents.runtime import build_user_message
from orchestrator.change_kind import change_kind_instruction, derive_change_context, normalize_kind
from orchestrator.pipeline_context import PipelineContext

CARD_UUID = "3f2b8c1e-0a4d-4e57-9b6a-1c2d3e4f5a6b"
KINDS = ("evolution", "fix", "feature")


def _extra(kind: str | None, number: int | None = 7, card: str | None = CARD_UUID) -> dict:
    ex: dict = {"evolution": True, "evolution_origin": "card", "card_draft_project_id": "draft"}
    if kind is not None:
        ex["ticket_kind"] = kind
    if number is not None:
        ex["ticket_number"] = number
    if card is not None:
        ex["ticket_id"] = card
    return ex


def _ctx(kind: str | None, origin: str | None) -> PipelineContext:
    c = PipelineContext("filho")
    c.ticket_kind, c.spec_origin = kind, origin
    c.set_charter("Charter"); c.current_module = "backend"
    return c


def _prompts(ctx: PipelineContext) -> dict[str, str]:
    """Prompt REAL (build_user_message) que cada papel recebe a partir dos inputs do contexto."""
    return {
        "CTO": build_user_message({"task": "t", "inputs": ctx.build_inputs_for_cto("charter_and_proposal")}, role="CTO"),
        "PM": build_user_message({"task": "t", "inputs": ctx.build_inputs_for_pm()}, role="PM"),
        "DEV": build_user_message({"task": "t", "inputs": ctx.evolution_scope_inputs("T1")}, role="DEV"),
    }


# ───────────────────────── 4.1 — derivação a partir de extra ─────────────────────────

@pytest.mark.parametrize("kind", KINDS)
def test_tipo_e_origem_vem_de_extra_nao_do_frontmatter(kind):
    cc = derive_change_context(_extra(kind))
    assert cc == {"ticket_kind": kind, "spec_origin": "card:TK-0007", "card_id": CARD_UUID,
                  "origin_spec_file": "tickets/TK-0007/request.md"}


def test_sem_card_ou_tipo_desconhecido_nao_inventa_nada():
    assert derive_change_context(_extra("fix", number=None, card=None))["spec_origin"] is None
    assert derive_change_context(_extra("fix", card="nao-e-uuid"))["card_id"] is None
    assert normalize_kind("HOTFIX") is None and normalize_kind(None) is None
    assert derive_change_context(None) == {"ticket_kind": None, "spec_origin": None, "card_id": None, "origin_spec_file": None}


def test_runner_aplica_o_contexto_no_pipeline_ctx_e_checkpoint_preserva(tmp_path):
    ctx = PipelineContext("filho")
    runner._apply_change_context(ctx, _extra("fix"))
    assert (ctx.ticket_kind, ctx.spec_origin, ctx.card_id, ctx.origin_spec_file) == ("fix", "card:TK-0007", CARD_UUID, "tickets/TK-0007/request.md")
    ctx.save_checkpoint(tmp_path)
    r = PipelineContext.load_checkpoint(tmp_path, "filho")
    assert (r.ticket_kind, r.spec_origin, r.card_id, r.origin_spec_file) == (ctx.ticket_kind, ctx.spec_origin, ctx.card_id, ctx.origin_spec_file)
    assert runner._apply_change_context(None, _extra("fix"))["card_id"] == CARD_UUID  # sem contexto: não explode


# ───────────────────────── 4.1 — prompts: 3 tipos × spec inicial/derivada ─────────────────────────

@pytest.mark.parametrize("origin", ["initial", "card:TK-0007"])
@pytest.mark.parametrize("kind", KINDS)
def test_prompt_por_tipo_e_origem(kind, origin):
    for role, prompt in _prompts(_ctx(kind, origin)).items():
        assert "## Tipo do card e origem da spec" in prompt, role
        # origem: spec inicial × nova
        if origin == "initial":
            assert "ORIGEM DA SPEC = INICIAL" in prompt and "TSK-INH-" not in prompt, role
        else:
            assert "ORIGEM DA SPEC = NOVA (derivada do card TK-0007)" in prompt, role
            assert "TSK-INH-" in prompt and "NÃO as refaça" in prompt and "TSK-EVO-" in prompt, role
        # tipo ACRESCENTA exigências, cada um só as suas
        assert ("FAIL_TO_PASS" in prompt) == (kind == "fix"), role
        assert ("MÍNIMA (patch)" in prompt) == (kind == "fix"), role
        assert ("Non-goals" in prompt) == (kind == "feature"), role
        assert ("rito padrão de evolução" in prompt) == (kind == "evolution"), role
        # o gate de RFC é invariante: nenhum tipo o dispensa
        assert "O gate de RFC não é dispensado por nenhum tipo." in prompt, role


def test_sem_tipo_nem_origem_prompt_byte_identico():
    base = _prompts(_ctx(None, None))
    for p in base.values():
        assert "Tipo do card" not in p and "ORIGEM DA SPEC" not in p
    # e igual ao de um contexto que nunca ouviu falar dos campos novos
    virgem = PipelineContext("filho"); virgem.set_charter("Charter"); virgem.current_module = "backend"
    assert _prompts(virgem) == base
    assert change_kind_instruction(None, None) == ""


def test_dev_com_escopo_recebe_regras_do_tipo_junto_do_escopo():
    ctx = _ctx("fix", "card:TK-0007"); ctx.evolution_scope = ["apps/api/**"]
    inp = ctx.evolution_scope_inputs("T1")
    assert "DESCARTADOS" in inp["evolution_scope_instruction"] and "FAIL_TO_PASS" in inp["change_kind_instruction"]
    assert inp["ticket_kind"] == "fix" and inp["spec_origin"] == "card:TK-0007"


# ───────────────────────── 4.2 — regex de ID, herdadas DONE, card_id ─────────────────────────

def test_regex_de_id_de_task_nao_mudou():
    src = Path(runner.__file__).read_text(encoding="utf-8")
    assert src.count(r"(TSK-[A-Z]+-\d+|TSK-\d+)") >= 3          # task_id_pattern, header e heading
    assert r"task_id_pattern = _re.compile(r'\b(TSK-[A-Z]+-\d+|TSK-\d+)\b')" in src
    rx = re.compile(r'\b(TSK-[A-Z]+-\d+|TSK-\d+)\b')
    assert rx.search("TSK-EVO-001").group(1) == "TSK-EVO-001"
    assert rx.search("TSK-INH-V2-EVO-001") is None               # herdada nunca é parseada do texto do PM


class _Store:
    """Fake do upsert de `POST /api/projects/:id/tasks` (routes/projects.ts): DONE preservado; card_id/origin com COALESCE."""

    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}
        self.posts: list[dict] = []

    def install(self, monkeypatch) -> None:
        def api_post(path, body):
            self.posts.append(body)
            for t in body["tasks"]:
                cur = self.rows.get(t["task_id"])
                st = cur["status"] if cur and cur["status"] in ("DONE", "QA_PASS", "QA_FAIL", "BLOCKED") else t.get("status", "ASSIGNED")
                self.rows[t["task_id"]] = {
                    "status": st, "requirements": t.get("requirements") or (cur or {}).get("requirements"),
                    "card_id": t.get("card_id") or (cur or {}).get("card_id"),
                    "origin_spec_file": t.get("origin_spec_file") or (cur or {}).get("origin_spec_file"),
                }
            return {}, 201
        monkeypatch.setattr(runner, "_api_post", api_post)
        monkeypatch.setattr(runner, "_api_get", lambda path: ([], 200))


BACKLOG = "# Backlog\n\n## TSK-EVO-001 — Exportar CSV [backend]\n\n## TSK-EVO-002 — Botão de exportar [web]\n"


def _backlog(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("PROJECT_FILES_ROOT", str(tmp_path))
    d = tmp_path / "filho" / "docs" / "pm" / "backend"
    d.mkdir(parents=True)
    (d / "BACKLOG.md").write_text(BACKLOG, encoding="utf-8")


def test_tasks_novas_carregam_card_id_e_herdadas_done_nao_sao_refeitas(tmp_path, monkeypatch):
    _backlog(tmp_path, monkeypatch)
    store = _Store(); store.install(monkeypatch)
    store.rows["TSK-INH-V1-BE-001"] = {"status": "DONE", "requirements": "[HERDADA da v1 — TSK-BE-001] CRUD", "card_id": None, "origin_spec_file": None}
    assert runner._seed_tasks("filho", "backend", card_id=CARD_UUID, origin_spec_file="tickets/TK-0007/request.md")
    # novas: ligadas ao card, ID inalterado
    for tid in ("TSK-EVO-001", "TSK-EVO-002"):
        assert store.rows[tid]["card_id"] == CARD_UUID and store.rows[tid]["origin_spec_file"] == "tickets/TK-0007/request.md"
    # herdada DONE: nem reenviada, nem alterada, nem ligada ao card
    assert store.rows["TSK-INH-V1-BE-001"] == {"status": "DONE", "requirements": "[HERDADA da v1 — TSK-BE-001] CRUD", "card_id": None, "origin_spec_file": None}
    sent = {t["task_id"]: t for p in store.posts for t in p["tasks"]}
    assert "TSK-INH-V1-BE-001" not in sent
    assert sent["TSK-FULL-TEST"]["card_id"] == CARD_UUID          # AH-A3: toda task não herdada recebe o vínculo
    # retomada (runner morto e reiniciado): idempotente, sem duplicar, card_id mantido
    assert runner._seed_tasks("filho", "backend", card_id=CARD_UUID, origin_spec_file="tickets/TK-0007/request.md")
    assert sorted(store.rows) == ["TSK-EVO-001", "TSK-EVO-002", "TSK-FULL-TEST", "TSK-INH-V1-BE-001"]


def test_sem_card_o_corpo_do_post_e_identico_ao_de_antes(tmp_path, monkeypatch):
    _backlog(tmp_path, monkeypatch)
    store = _Store(); store.install(monkeypatch)
    assert runner._seed_tasks("filho", "backend")
    assert all("card_id" not in t and "origin_spec_file" not in t for t in store.posts[0]["tasks"])


def test_link_toca_toda_task_nao_herdada():
    out = runner._link_tasks_to_card(
        [{"task_id": "TSK-EVO-001"}, {"task_id": "TSK-INH-V2-EVO-001", "status": "DONE"}, {"task_id": "TSK-BE-003"}], CARD_UUID, "tickets/TK-0007/request.md")
    assert [bool(t.get("card_id")) for t in out] == [True, False, True]
