"""2A.8 — papéis e modelo por tentativa do rework do Cyborg (`_rework_attempt_plan`).

Trava: o MODELO é o de sempre em qualquer `LLM_ROLES_MODE` (1ª tentativa no principal do slot,
Advisor só na 2ª; nunca Advisor desde a 1ª fora do modo `feature` pré-existente) e os papéis só
são registrados com a flag != off.
"""
import pytest

from orchestrator import cyborg_v3 as cy

ORCH, ADV = "orch-model", "adv-model"


def plan(att, mode, *, feature=False, adv=ADV):
    import os
    os.environ["LLM_ROLES_MODE"] = mode
    return cy._rework_attempt_plan(att, feature_mode=feature, model_id=ORCH, fallback_model=adv)


@pytest.fixture(autouse=True)
def _restore(monkeypatch):
    monkeypatch.delenv("LLM_ROLES_MODE", raising=False)
    yield
    import os
    os.environ.pop("LLM_ROLES_MODE", None)


@pytest.mark.parametrize("mode", ["off", "shadow", "on"])
def test_modelo_identico_em_qualquer_modo(mode):
    # 1ª tentativa: principal do slot; 2ª e 3ª: Advisor (fallback do slot).
    assert [plan(a, mode)[0] for a in range(3)] == [ORCH, ADV, ADV]


@pytest.mark.parametrize("mode", ["off", "shadow", "on"])
def test_modo_feature_preexistente_segue_comecando_no_reforco(mode):
    assert [plan(a, mode, feature=True)[0] for a in range(2)] == [ADV, ADV]


def test_off_nao_adiciona_campo_nenhum():
    for a in range(3):
        assert plan(a, "off")[1] == {}
        assert plan(a, "off", feature=True)[1] == {}


@pytest.mark.parametrize("mode", ["shadow", "on"])
def test_papeis_1a_orchestrator_2a_advisor_escalado(mode):
    assert plan(0, mode)[1] == {"llm_role": "orchestrator", "effective_role": "orchestrator"}
    assert plan(1, mode)[1] == {"llm_role": "advisor", "effective_role": "advisor", "escalated_from": "orchestrator"}


def test_advisor_vazio_ou_igual_nao_escala_de_verdade():
    for adv in ("", ORCH):
        # fallback vazio é substituído por model_id pelo chamador (`... or model_id`); aqui simulamos os dois.
        fb = adv or ORCH
        m, f = plan(1, "on", adv=fb)
        assert m == ORCH
        assert f == {"llm_role": "advisor", "effective_role": "orchestrator"}


def test_custo_primeira_tentativa_nunca_e_advisor():
    # cenário de aumento de custo proibido: Advisor desde a 1ª tentativa (fora do modo feature).
    for mode in ("off", "shadow", "on"):
        assert plan(0, mode)[0] == ORCH
