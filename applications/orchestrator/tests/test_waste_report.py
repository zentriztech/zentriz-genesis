"""Plano de evolução v2, tarefa 1.4 — `scripts/waste_report.py` com resultado calculável à mão."""
import importlib.util
from pathlib import Path

_P = Path(__file__).resolve().parents[3] / "scripts" / "waste_report.py"
_spec = importlib.util.spec_from_file_location("waste_report", _P)
wr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(wr)


def _r(i, ts, reason, usd, secs, key=None, phase="fabrica"):
    return {"id": i, "created_at": ts, "phase": phase, "call_reason": reason, "call_idem_key": key,
            "cost_usd": usd, "duration_ms": None if secs is None else secs * 1000}


ROWS = [
    _r(1, "2026-10-05T10:00:00+00:00", "primary", 1.0, 10, "p|T|DEV|r0.p0"),
    _r(2, "2026-10-05T10:01:00+00:00", "primary", 1.0, 10, "p|T|DEV|r0.p0"),   # retry de rede: mesma chave em 60 s
    _r(3, "2026-10-05T11:00:00+00:00", "repair", 0.5, 5, "p|T|DEV|r0.p1"),
    _r(4, "2026-10-06T11:00:00+00:00", "rework", 1.5, 15, "p|T|DEV|r1.p0"),
    _r(5, "2026-10-06T12:00:00+00:00", "escalation", 2.0, 20),
    _r(6, "2026-10-06T12:30:00+00:00", None, 1.0, None),                         # não medido, sem duração
]


def test_dedup_conta_uma_chamada_de_negocio_mas_o_gasto_e_real():
    (x,) = wr.report(ROWS)
    assert x["semana"] == "2026-10-05" and x["fase"] == "fabrica"
    assert x["linhas_pagas"] == 6 and x["duplicatas_de_rede"] == 1 and x["chamadas_de_negocio"] == 5
    assert x["gasto_total_usd"] == 7.0
    assert (x["retry_usd"], x["repair_usd"], x["rework_usd"]) == (1.0, 0.5, 1.5)   # a duplicata vai para retry
    assert x["desperdicio_usd"] == 3.0 and x["pct_desperdicio"] == 42.9
    assert x["pct_escalation"] == 28.6 and x["pct_nao_medido"] == 14.3


def test_segundos_e_sem_duracao():
    (x,) = wr.report(ROWS)
    assert x["segundos_desperdicados"] == 30.0 and x["segundos_total"] == 60.0
    assert x["pct_segundos_desperdicados"] == 50.0 and x["sem_duracao"] == 1


def test_janela_menor_que_o_intervalo_nao_deduplica():
    (x,) = wr.report(ROWS, janela_s=30)
    assert x["duplicatas_de_rede"] == 0 and x["retry_usd"] == 0.0


def test_sintetico_e_reprodutivel():
    assert wr.synthetic() == wr.synthetic()
    assert wr.render(wr.synthetic())
