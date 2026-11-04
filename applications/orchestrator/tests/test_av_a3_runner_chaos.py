"""A-3 (parecer AV) — caos do RUNNER: C8, C9, C10, C11, C13 (cenários do relatório AF, §matriz de caos).

O runner é morto (exceção `Killed`) no meio de cada etapa e "reiniciado" chamando as mesmas funções de novo contra a
MESMA API em memória. A API falsa reproduz a semântica de `routes/projects.ts` (POST /tasks, ~590-640): transação única,
upsert por (project, task_id), `COALESCE(card_id)`, status terminais preservados, flag CARDS_BANCADA e regra B-3
(task de filho que não é o ativo do card fica sem vínculo). Os invariantes verificados: sem tasks duplicadas, sem
perder `card_id`, retomada correta.
"""
from __future__ import annotations

import pytest

from orchestrator import runner

PID = "11111111-1111-1111-1111-111111111111"
PARENT = "22222222-2222-2222-2222-222222222222"
CARD = "33333333-3333-3333-3333-333333333333"
TERMINAL = ("DONE", "QA_PASS", "QA_FAIL", "BLOCKED")


class Killed(BaseException):
    """Simula kill -9 do runner: não é capturada por `except Exception` do código sob teste."""


class FakeApi:
    def __init__(self):
        self.tasks: dict[str, dict[str, dict]] = {}     # project -> task_id -> row
        self.extra: dict[str, dict] = {PID: {"evolution": True, "evolution_origin": "card"}, PARENT: {}}
        self.active_child = {CARD: PID}                  # card -> filho ativo (B-3)
        self.cards_on = True
        self.kill_on_post = None                         # callable(n_post, tasks) -> None | "kill" | 500
        self.kill_on_patch = None                        # callable(n_patch, task_id, body)
        self.partial_on_500 = False                      # API antiga NÃO atômica
        self.completes_card = False                      # A3 da API desligado: isola o que o RUNNER envia
        self.posted: list[dict] = []
        self.n_post = 0
        self.n_patch = 0

    # ---- roteador -------------------------------------------------------------------------------
    def get(self, path):
        parts = path.strip("/").split("/")
        if len(parts) == 4 and parts[3] == "tasks":
            return [self._out(r) for r in self.tasks.get(parts[2], {}).values()], 200
        if len(parts) == 3:
            return {"id": parts[2], "extra": self.extra.get(parts[2], {}), "status": "running", "versionNumber": 2}, 200
        return None, 404

    def post(self, path, body):
        pid = path.split("/")[3]
        self.n_post += 1
        self.posted.extend(dict(t) for t in body["tasks"])
        action = self.kill_on_post(self.n_post, body["tasks"]) if self.kill_on_post else None
        if action == "kill":
            raise Killed()                 # antes do COMMIT: transação única ⇒ nada gravado
        rows = self.tasks.setdefault(pid, {})
        staged = {k: dict(v) for k, v in rows.items()}
        for i, t in enumerate(body["tasks"]):
            tid = t.get("task_id") or t.get("taskId")
            inherited = tid.startswith("TSK-INH-")
            card_id = t.get("card_id")
            if card_id and (not self.cards_on or inherited):
                card_id = None
            if card_id and self.active_child.get(card_id) != pid:   # B-3
                card_id = None
            if self.completes_card and not card_id and not inherited and self.cards_on and self.extra.get(pid, {}).get("evolution_origin") == "card" \
                    and self.active_child.get(CARD) == pid:
                card_id = CARD                                        # A3: API completa o vínculo
            old = staged.get(tid)
            if old is None:
                staged[tid] = {"task_id": tid, "status": t.get("status", "ASSIGNED"), "card_id": card_id,
                               "requirements": t.get("requirements"), "module": t.get("module")}
            else:
                st = old["status"]
                new_status = st if st in TERMINAL else ("ASSIGNED" if st in ("IN_PROGRESS", "WAITING_REVIEW") else t.get("status", "ASSIGNED"))
                staged[tid] = {**old, "status": new_status, "card_id": card_id or old["card_id"]}
            if action == 500 and self.partial_on_500 and i == 0:
                self.tasks[pid] = dict(staged)    # gravou só a 1ª e devolveu 5xx
        if action == 500:
            return {"error": "boom"}, 500
        self.tasks[pid] = staged
        return {"ok": True}, 201

    def patch(self, path, body):
        _, _, pid, _, tid = path.strip("/").split("/")
        self.n_patch += 1
        if self.kill_on_patch:
            self.kill_on_patch(self.n_patch, tid, body)
        self.tasks[pid][tid].update(body)
        return {"ok": True}, 200

    @staticmethod
    def _out(r):
        return {**r, "taskId": r["task_id"], "card_id": r["card_id"]}


@pytest.fixture
def env(monkeypatch, tmp_path):
    api = FakeApi()
    monkeypatch.setenv("PROJECT_FILES_ROOT", str(tmp_path))
    monkeypatch.setenv("API_BASE_URL", "http://api.invalid")
    monkeypatch.setenv("GENESIS_API_TOKEN", "t")
    monkeypatch.setattr(runner, "_api_get", api.get)
    monkeypatch.setattr(runner, "_api_post", api.post)
    monkeypatch.setattr(runner, "_api_patch", api.patch)
    d = tmp_path / PID / "docs" / "pm" / "web"
    d.mkdir(parents=True)
    (d / "BACKLOG.md").write_text(
        "\n".join(f"## TSK-EVO-00{i} — Implementar item numero {i}" for i in range(1, 6)) + "\n", encoding="utf-8")
    (tmp_path / PARENT).mkdir()
    api.tmp = tmp_path
    return api


def _ids(api, pid=PID):
    return sorted(api.tasks.get(pid, {}))


def _own(api):
    return [r for k, r in api.tasks[PID].items() if not k.startswith("TSK-INH-")]


def _seed(card=CARD):
    return runner._seed_tasks(PID, "web", card_id=card, origin_spec_file="docs/spec.md" if card else None)


# ───────────────────────── C8 ─────────────────────────

def test_c8_kill_entre_backlog_e_seed_retomada_sem_duplicar_e_com_card_id(env):
    """BACKLOG.md gravado, runner morre antes do POST do seed (e durante o POST): retomar semeia UMA vez."""
    env.kill_on_post = lambda n, tasks: "kill" if n == 1 else None
    with pytest.raises(Killed):
        _seed()
    assert env.tasks.get(PID, {}) == {}                       # transação única: nada parcial
    assert _seed() is True                                     # retomada
    assert _seed() is True                                     # e uma terceira vez (restart repetido)
    ids = _ids(env)
    assert ids == sorted({"TSK-EVO-001", "TSK-EVO-002", "TSK-EVO-003", "TSK-EVO-004", "TSK-EVO-005", "TSK-FULL-TEST"})
    assert all(r["card_id"] == CARD for r in _own(env)), "TSK-EVO e FULL-TEST precisam do vínculo com o card"


def test_c8_kill_entre_seed_e_heranca_tsk_inh_done_intactas(env):
    env.tasks[PARENT] = {
        "TSK-EVO-001": {"task_id": "TSK-EVO-001", "status": "DONE", "card_id": None, "requirements": "r", "module": "web"},
        "TSK-DEVOPS-001": {"task_id": "TSK-DEVOPS-001", "status": "DONE", "card_id": None, "requirements": "r", "module": "web"},
    }
    assert _seed() is True
    env.kill_on_post = lambda n, tasks: "kill" if tasks and tasks[0]["task_id"].startswith("TSK-INH-") else None
    with pytest.raises(Killed):
        runner._inherit_parent_tasks(PID, PARENT)
    assert not [k for k in env.tasks[PID] if k.startswith("TSK-INH-")]
    env.kill_on_post = None
    assert runner._inherit_parent_tasks(PID, PARENT) == 1       # só a EVO (DEVOPS é pulada)
    assert runner._inherit_parent_tasks(PID, PARENT) == 1       # replay idempotente
    inh = {k: r for k, r in env.tasks[PID].items() if k.startswith("TSK-INH-")}
    assert list(inh) == ["TSK-INH-EVO-001"] and inh["TSK-INH-EVO-001"]["status"] == "DONE"
    assert inh["TSK-INH-EVO-001"]["card_id"] is None            # herdada não recebe vínculo
    assert _seed() is True                                       # novo restart do seed não toca as herdadas
    assert env.tasks[PID]["TSK-INH-EVO-001"]["status"] == "DONE"
    assert len(env.tasks[PID]) == 7


def test_c8_heranca_registrada_em_completed_tasks_mesmo_se_o_kill_foi_antes_do_checkpoint(env):
    """A herança já está na API (restart); o checkpoint restaurado não a tem: TODA TSK-INH volta a `completed_tasks`."""
    env.tasks[PID] = {"TSK-INH-EVO-001": {"task_id": "TSK-INH-EVO-001", "status": "DONE", "card_id": None,
                                          "requirements": "", "module": "web"}}
    class Ctx:  # checkpoint restaurado sem as herdadas
        completed_tasks: list = []
    ctx = Ctx(); ctx.completed_tasks = []
    assert runner._register_inherited_completed(PID, ctx) == 1
    assert runner._register_inherited_completed(PID, ctx) == 0   # sem duplicar
    assert ctx.completed_tasks == ["TSK-INH-EVO-001"]


def test_c8_restart_preserva_status_terminal_e_nao_perde_card_id(env):
    assert _seed() is True
    env.tasks[PID]["TSK-EVO-001"]["status"] = "DONE"
    env.tasks[PID]["TSK-EVO-002"]["status"] = "IN_PROGRESS"
    from orchestrator.task_state import TaskState
    ts = TaskState(PID).load(); ts.mark_done("TSK-EVO-001"); ts.save()
    assert _seed() is True
    assert env.tasks[PID]["TSK-EVO-001"]["status"] == "DONE"
    assert env.tasks[PID]["TSK-EVO-002"]["status"] == "ASSIGNED"
    reposted = [t for t in env.posted[6:] if t["task_id"] == "TSK-EVO-001"]
    assert reposted and reposted[0]["status"] == "DONE", "o runner reenvia o terminal do TaskState (não depende só do upsert da API)"
    assert all(r["card_id"] == CARD for r in _own(env)) and len(_own(env)) == 6


# ───────────────────────── C9 ─────────────────────────

def test_c9_post_parcial_5xx_nao_segue_em_silencio(env):
    """API não atômica: grava 1 task e devolve 500. `_seed_tasks` é False, o backlog é detectado PARCIAL e o retry completa."""
    env.partial_on_500 = True
    env.kill_on_post = lambda n, tasks: 500 if n == 1 else None
    assert _seed() is False
    existing = runner._get_tasks(PID)
    assert existing and len(existing) < 6
    assert runner._seed_is_complete(PID, "web", existing) is False
    assert _seed() is True
    assert runner._seed_is_complete(PID, "web", runner._get_tasks(PID)) is True
    assert len(env.tasks[PID]) == 6 and all(r["card_id"] == CARD for r in _own(env))


def test_c9_seed_5xx_sem_nenhuma_task_nao_vira_sucesso(env):
    env.kill_on_post = lambda n, tasks: 500
    assert _seed() is False
    assert runner._get_tasks(PID) == []


# ───────────────────────── C10 ─────────────────────────

def _legacy_tasks(env, n=5):
    env.extra[PID] = {}
    env.active_child.clear()
    assert _seed(card=None) is True
    return runner._get_tasks(PID)


def test_c10_kill_depois_de_criar_a_trivial_e_antes_de_cancelar_retoma_consistente(env):
    all_t = _legacy_tasks(env)
    active = runner._active_pm_tasks_for_consolidation(all_t)
    assert len(active) == 6 and runner._may_consolidate_trivial(active, None)
    def kill_on_second_cancel(n, tid, body):
        if n == 2:
            raise Killed()
    env.kill_on_patch = kill_on_second_cancel
    with pytest.raises(Killed):
        runner._consolidate_trivial_tasks(PID, all_t, active, "web", "charter", (None, None))
    assert env.tasks[PID]["TSK-TRIVIAL-001"]["status"] == "ASSIGNED"        # criada ANTES de cancelar
    assert sum(1 for r in env.tasks[PID].values() if r["status"] == "CANCELLED") == 1
    # retomada: o novo run vê a TRIVIAL viva e termina de cancelar, sem criar outra
    env.kill_on_patch = None
    env.tasks[PID]["TSK-TRIVIAL-001"]["status"] = "DONE"                     # já entregue por outro ciclo
    all_t = runner._get_tasks(PID)
    assert runner._trivial_consolidation_pending(all_t) is True
    active = runner._active_pm_tasks_for_consolidation(all_t)
    n_post = env.n_post
    runner._consolidate_trivial_tasks(PID, all_t, active, "web", "charter", (None, None))
    assert env.n_post == n_post, "TRIVIAL existente: não é recriada nem regride"
    assert env.tasks[PID]["TSK-TRIVIAL-001"]["status"] == "DONE"
    assert [k for k, r in env.tasks[PID].items() if r["status"] not in ("CANCELLED", "DONE")] == []
    assert len([k for k in env.tasks[PID] if k == "TSK-TRIVIAL-001"]) == 1


def test_c10_falha_ao_criar_a_trivial_nao_cancela_nada(env):
    """Antes: cancelava as originais e DEPOIS criava; criação falha/kill ⇒ projeto com ZERO tasks ativas."""
    all_t = _legacy_tasks(env)
    active = runner._active_pm_tasks_for_consolidation(all_t)
    env.kill_on_post = lambda n, tasks: 500
    assert runner._consolidate_trivial_tasks(PID, all_t, active, "web", "charter", (None, None)) is None
    assert not [r for r in env.tasks[PID].values() if r["status"] == "CANCELLED"]
    env.kill_on_post = lambda n, tasks: "kill"
    with pytest.raises(Killed):
        runner._consolidate_trivial_tasks(PID, all_t, active, "web", "charter", (None, None))
    assert len([r for r in env.tasks[PID].values() if r["status"] in ("ASSIGNED", "NEW")]) == 6
    assert "TSK-TRIVIAL-001" not in env.tasks[PID]


def test_c10_filho_de_card_nunca_consolida_e_preserva_o_vinculo(env):
    assert _seed() is True
    all_t = runner._get_tasks(PID)
    active = runner._active_pm_tasks_for_consolidation(all_t)
    assert runner._may_consolidate_trivial(active, CARD) is False
    assert "TSK-TRIVIAL-001" not in env.tasks[PID]
    assert all(r["card_id"] == CARD for r in _own(env))


def test_c10_trivial_de_legado_com_card_id_leva_o_vinculo(env):
    all_t = runner._get_tasks(PID)
    assert _seed() is True
    runner._consolidate_trivial_tasks(PID, [], runner._get_tasks(PID)[:4], "web", "c", (CARD, "docs/spec.md"))
    assert env.tasks[PID]["TSK-TRIVIAL-001"]["card_id"] == CARD


# ───────────────────────── C11 ─────────────────────────

def test_c11_flag_ligada_no_meio_da_run_completa_tasks_antigas_sem_perder_nada(env):
    env.cards_on = False
    assert _seed() is True
    assert all(r["card_id"] is None for r in _own(env))
    env.tasks[PID]["TSK-EVO-001"]["status"] = "DONE"
    env.cards_on = True                                           # flag ligada no meio
    assert _seed() is True
    assert len(_own(env)) == 6 and all(r["card_id"] == CARD for r in _own(env))
    assert env.tasks[PID]["TSK-EVO-001"]["status"] == "DONE"


def test_c11_flag_desligada_no_meio_da_run_nao_apaga_vinculos(env):
    assert _seed() is True
    env.cards_on = False                                           # flag desligada no meio
    assert _seed() is True
    assert len(_own(env)) == 6 and all(r["card_id"] == CARD for r in _own(env))   # COALESCE preserva


def test_c11_seed_sem_card_nao_envia_card_id_nulo(env):
    sent = []
    orig = env.post
    def spy(path, body):
        sent.extend(body["tasks"]); return orig(path, body)
    runner._api_post = spy
    try:
        assert _seed(card=None) is True
    finally:
        runner._api_post = env.post
    assert all("card_id" not in t for t in sent)


# ───────────────────────── C13 ─────────────────────────

def test_c13_runner_do_filho_antigo_nao_polui_o_card_novo(env):
    OLD = "44444444-4444-4444-4444-444444444444"
    env.extra[OLD] = {"evolution": True, "evolution_origin": "card"}
    bl = env.tmp / OLD / "docs" / "pm" / "web"
    bl.mkdir(parents=True)
    (bl / "BACKLOG.md").write_text("## TSK-EVO-001 — Item antigo do filho\n", encoding="utf-8")
    env.active_child[CARD] = OLD
    assert runner._seed_tasks(OLD, "web", card_id=CARD, origin_spec_file="docs/spec.md") is True
    assert all(r["card_id"] == CARD for r in env.tasks[OLD].values())
    antes = set(env.tasks[OLD])                                     # criadas enquanto OLD era o filho ativo
    env.active_child[CARD] = PID                                    # card religado ao filho novo
    # o runner do filho antigo ainda posta tasks novas (retomada/rework) com o card_id do seu extra
    (bl / "BACKLOG.md").write_text("## TSK-EVO-001 — Item antigo do filho\n## TSK-EVO-002 — Task tardia do filho morto\n", encoding="utf-8")
    assert runner._seed_tasks(OLD, "web", card_id=CARD, origin_spec_file="docs/spec.md") is True
    assert env.tasks[OLD]["TSK-EVO-002"]["card_id"] is None, "task nova do filho antigo não pode ficar ligada ao card novo"
    assert _seed() is True
    novas = [(p, k) for p in (OLD, PID) for k, r in env.tasks[p].items() if r["card_id"] == CARD and not (p == OLD and k in antes)]
    assert all(p == PID for p, _ in novas) and len(novas) == len(env.tasks[PID])


def test_c10_os_dois_caminhos_do_runner_usam_a_consolidacao_retomavel():
    import inspect
    src = inspect.getsource(runner)
    assert src.count("_consolidate_trivial_tasks(project_id,") == 2
    # sobra 1: a criação da TRIVIAL no caminho pré-PM (trivial detectado ANTES do PM; não cancela nada)
    assert src.count('"task_id":   "TSK-TRIVIAL-001"') == 1, "sobrou cancelar-antes-de-criar inline"
    assert src.count('_a4_rule_applies("SEED_PARTIAL_STRICT"') == 2
