"""Plano de evolução v2, tarefa 1.5 (a) — `scripts/cache_prefix_report.py`, com contas verificáveis à mão."""
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
_spec = importlib.util.spec_from_file_location("cache_prefix_report", ROOT / "scripts" / "cache_prefix_report.py")
cp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cp)

OF, REPO = cp.PRECOS["oficial"], cp.PRECOS["repo"]


def _row(ts, proj, segs, read=0, write=0, model="us.anthropic.claude-opus-5-5", votes=1, purpose="spec_validator"):
    T = sum(t for _h, t in segs)
    return {"created_at": ts, "project_id": proj, "purpose": purpose, "model": model, "output_tokens": 1000,
            "input_tokens": T - read - write, "cache_read_tokens": read, "cache_write_tokens": write,
            "votes": votes, "segments": segs}


def test_precos_oficial_e_divergencia_do_repo():
    assert cp.preco(OF, "us.anthropic.claude-opus-5-5")[:2] == (4.0, 20.0)
    assert cp.preco(OF, "us.anthropic.claude-opus-5-5")[2] == 0.05
    assert cp.preco(REPO, "us.anthropic.claude-opus-5-5")[:2] == (5.0, 25.0)
    assert cp.preco(REPO, "us.anthropic.claude-opus-5-5")[2] == 0.10
    assert cp.preco(OF, "us.anthropic.claude-sonnet-5-5")[2] == 0.05 and cp.preco(REPO, "us.anthropic.claude-sonnet-5-5")[2] == 0.10
    assert cp.preco(OF, "claude-opus-4-8")[:2] == (5.0, 25.0)   # só o Opus 5.5 é 4/20


def test_equilibrio_e_votes_minimo():
    assert round(cp.equilibrio_identidade(0.05, 1.25), 4) == 0.2083
    assert round(cp.equilibrio_identidade(0.10, 1.25), 4) == 0.2174
    assert cp.votes_minimo(0.05, 1.25) == 2 and cp.votes_minimo(0.10, 1.25) == 2


def test_prefixo_comum_para_no_primeiro_bloco_diferente():
    a = [["s", 10], ["x", 100], ["k", 5]]
    b = [["s", 10], ["y", 100], ["k", 5]]
    assert cp.prefixo_comum_tokens(a, b) == 10          # o bloco final igual NÃO conta: cache é por prefixo contíguo
    assert cp.prefixo_comum_tokens(a, a) == 115


def test_votes3_cache_ligado_hit_rate_e_liquido():
    segs = [["s", 1000], ["x", 99000]]                  # 100.000 tokens
    rows = [_row("2026-10-05T10:00:00+00:00", "p", segs, write=100000, votes=3),
            _row("2026-10-05T10:00:30+00:00", "p", segs, read=100000, votes=3),
            _row("2026-10-05T10:01:00+00:00", "p", segs, read=100000, votes=3)]
    (x,) = cp.analisar(rows, OF)
    assert x["hit_rate_pedido"] == 100.0                  # input=0 em todas: 200k / (0 + 200k)
    assert x["hit_rate_total"] == 66.7                    # 200k / 300k
    # Opus 5.5 oficial: multa 100k*0,25*4/1e6 = 0,10 | economia 200k*0,95*4/1e6 = 0,76 | líquido 0,66
    assert (x["multa_escrita_usd"], x["economia_leitura_usd"], x["liquido_cache_atual_usd"]) == (0.1, 0.76, 0.66)
    assert x["runs"] == 1.0


def test_votes1_sem_reuso_e_so_multa_e_votes2_compensa():
    segs = [["s", 100000]]
    (x,) = cp.analisar([_row("2026-10-05T10:00:00+00:00", "p", segs, model="us.anthropic.claude-opus-5-5")], OF)
    g = {r["votes"]: r for r in x["grade_votes"]}
    assert g[1]["ganho_por_run"] < 0 and g[2]["ganho_por_run"] > 0
    assert abs(g[1]["ganho_por_run"] - (-0.25 * 100000 * 4 / 1e6)) < 1e-5     # -US$ 0,10
    assert abs(g[3]["ganho_por_run"] - 100000 * 4 / 1e6 * (3 - (1.25 + 2 * 0.05))) < 1e-5


def test_identidade_no_ttl_e_simulacao_votes1():
    s1 = [["sys", 2000], ["spec1", 58000]]
    s2 = [["sys", 2000], ["spec2", 58000]]              # spec mudou: só o system é reaproveitável (3,3%)
    rows = [_row("2026-10-05T10:00:00+00:00", "p", s1), _row("2026-10-05T10:03:00+00:00", "p", s2),
            _row("2026-10-05T10:30:00+00:00", "p", s2)]  # 3ª fora do TTL
    (x,) = cp.analisar(rows, OF)
    assert x["pares_no_ttl"] == 1 and x["identidade_prefixo_no_ttl_pct"] == 3.3
    assert x["identidade_prefixo_pct"] == round(100 * (2000 + 60000) / 120000, 1)   # 2º par é idêntico, mas fora do TTL
    assert x["sim_votes1_cache_ligado_liquido_usd"] < 0           # abaixo do equilíbrio de 20,8%: só multa
    assert "só adiciona multa" in cp.veredito(x) or "NENHUM par" in cp.veredito(x)


def test_sem_segments_identidade_nao_medida():
    r = _row("2026-10-05T10:00:00+00:00", "p", [["s", 10]]); r.pop("segments")
    (x,) = cp.analisar([r], OF)
    assert x["identidade_prefixo_pct"] is None and "NÃO medida" in cp.veredito(x)


def test_gap142_nao_foi_refeito_usar_cache_so_com_votes_maior_que_1():
    src = (ROOT / "applications" / "orchestrator" / "spec_validator.py").read_text(encoding="utf-8")
    assert "usar_cache = votes > 1" in src                # GAP-142/148 intactos: esta tarefa não os reimplementa


def test_sonda_estrutura_dev_variavel_antes_da_spec():
    env = {**os.environ, "PYTHONPATH": str(ROOT / "applications")}
    out = subprocess.run([sys.executable, "-I", str(ROOT / "scripts" / "cache_prefix_report.py"), "--sonda-estrutura"],
                         capture_output=True, text=True, env=env, timeout=120)
    assert out.returncode == 0, out.stderr[-500:]
    assert "DEV tarefa 1 -> 2" in out.stdout and "= 0.1%" in out.stdout


def test_sintetico_reprodutivel():
    assert cp.sintetico() == cp.sintetico()
    assert cp.render(cp.sintetico()["linhas"], {"oficial": OF, "repo": REPO})
