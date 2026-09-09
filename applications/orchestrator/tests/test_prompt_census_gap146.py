"""🔴 GAP-146 — o `spec_cto` custa 69.548 tokens de ENTRADA por chamada e ninguém sabia de QUEM.

Medição de prod (3 dias): 764 chamadas de `spec_cto` = 52,9 M tokens de entrada, a maior conta
unitária do cérebro da Bancada. O contexto é montado por orçamento por campo (`_prompt_budget`), mas
o prompt que SAI nunca foi medido campo a campo — então "recortar por relevância" seria adivinhação,
e adivinhar antes de medir é literalmente o GAP-147 (o cache economizou de verdade e o medidor
passou a mentir; a lição foi INSTRUMENTO ANTES DA MUDANÇA).

Este arquivo pina o instrumento, não uma crença:

  1. o censo FECHA (`sum(campos) + outros == total`) — sem isso, campo esquecido viraria "economia";
  2. o corte aparece (`clipped`) e o campo cortado é contado pelo tamanho ENTREGUE, não pelo pedido;
  3. a deduplicação de `product_spec` (defeito D3) aparece como `product_spec_dedup`, senão a
     próxima leitura concluiria que aquele campo nunca custou nada;
  4. o censo é por THREAD (`ContextVar`), porque o `agents` roda uma thread por job e desde o
     GAP-145 os lotes do estágio B são despachados em paralelo — uma global misturaria dois prompts;
  5. o instrumento NUNCA derruba a chamada.
"""
import threading

from orchestrator.agents import runtime


def _msg(**inputs):
    return {"task": "T", "mode": "m", "inputs": inputs}


# ── 1. o censo fecha ──────────────────────────────────────────────────────────────────────────────

def test_censo_fecha_soma_dos_campos_mais_outros():
    prompt = runtime.build_user_message(
        _msg(spec_raw="S" * 5_000, validation_report="V" * 1_000),
        role="CTO", model="us.anthropic.claude-opus-5",
    )
    c = runtime.LAST_PROMPT_CENSUS.get()
    assert c is not None
    assert c["total"] == len(prompt)
    contados = sum(v for k, v in c["fields"].items() if not k.endswith("_dedup"))
    assert contados + c["outros"] == c["total"]
    assert c["fields"]["spec_raw"] == 5_000
    assert c["role"] == "CTO"


def test_censo_lista_campos_do_maior_para_o_menor():
    # `validation_report` só é EMITIDO com `context_emit=v2` (a marca que a api põe quando
    # SPEC_CONTEXT_PRODUCT_SCOPE=on) — sem ela o campo não entra no prompt e, corretamente, não
    # entra no censo: censo mede o que SAIU, não o que chegou no envelope.
    runtime.build_user_message(
        _msg(spec_raw="S" * 4_000, validation_report="V" * 9_000, context_emit="v2"),
        role="CTO", model="us.anthropic.claude-opus-5",
    )
    ordem = list(runtime.LAST_PROMPT_CENSUS.get()["fields"].items())
    assert [k for k, _ in ordem][0] == "validation_report"
    assert [v for _, v in ordem] == sorted([v for _, v in ordem], reverse=True)


# ── 2. corte: conta o ENTREGUE, e declara quem foi cortado ─────────────────────────────────────────

def test_campo_cortado_conta_o_entregue_e_aparece_em_clipped(monkeypatch):
    monkeypatch.setenv("AGENT_PROMPT_SPEC_CHARS", "2000")
    runtime.build_user_message(
        _msg(spec_raw="S" * 50_000), role="CTO", model="us.anthropic.claude-opus-5",
    )
    c = runtime.LAST_PROMPT_CENSUS.get()
    assert "spec_raw" in c["clipped"]
    # entregue = cap + o aviso de corte (que também ocupa contexto e por isso é contado)
    assert 2_000 <= c["fields"]["spec_raw"] < 50_000
    assert c["budget_total"] is not None


def test_orcamento_desligado_cai_no_piso_e_o_censo_registra(monkeypatch):
    monkeypatch.setenv("AGENT_PROMPT_BUDGET", "off")
    runtime.build_user_message(_msg(spec_raw="S" * 90_000), role="CTO", model="modelo-x")
    c = runtime.LAST_PROMPT_CENSUS.get()
    assert c["budget_total"] is None            # "piso" — não havia orçamento
    assert c["fields"]["spec_raw"] == runtime._PROMPT_FIELD_FLOORS["spec_raw"]
    assert "spec_raw" in c["clipped"]


# ── 3. a economia do D3 não pode desaparecer do censo ─────────────────────────────────────────────

def test_product_spec_deduplicado_aparece_como_economia():
    texto = "S" * 3_000
    runtime.build_user_message(
        _msg(spec_raw=texto, product_spec=texto),
        role="CTO", model="us.anthropic.claude-opus-5",
    )
    c = runtime.LAST_PROMPT_CENSUS.get()
    assert c["fields"].get("product_spec_dedup") == 3_000
    assert "product_spec" not in c["fields"]     # não foi emitido, logo não custou
    contados = sum(v for k, v in c["fields"].items() if not k.endswith("_dedup"))
    assert contados + c["outros"] == c["total"]  # o pseudo-campo NÃO entra na soma


def test_product_spec_diferente_continua_custando_e_e_contado():
    runtime.build_user_message(
        _msg(spec_raw="S" * 3_000, product_spec="OUTRO DOCUMENTO " * 100),
        role="CTO", model="us.anthropic.claude-opus-5",
    )
    c = runtime.LAST_PROMPT_CENSUS.get()
    assert c["fields"]["product_spec"] == len("OUTRO DOCUMENTO " * 100)
    assert "product_spec_dedup" not in c["fields"]


# ── 4. isolamento por thread (GAP-145 despacha lotes em paralelo) ─────────────────────────────────

def test_censo_e_por_thread_nao_global():
    vistos: dict[str, int] = {}

    def build(nome: str, n: int):
        runtime.build_user_message(_msg(spec_raw="S" * n), role="CTO", model="us.anthropic.claude-opus-5")
        vistos[nome] = runtime.LAST_PROMPT_CENSUS.get()["fields"]["spec_raw"]

    ts = [threading.Thread(target=build, args=(f"t{i}", 1_000 * (i + 1))) for i in range(4)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert vistos == {"t0": 1_000, "t1": 2_000, "t2": 3_000, "t3": 4_000}


# ── 5. instrumento nunca derruba a chamada ────────────────────────────────────────────────────────

def test_falha_no_censo_nao_derruba_o_prompt(monkeypatch):
    def explode(*_a, **_k):
        raise RuntimeError("censo quebrado")

    monkeypatch.setattr(runtime, "_prompt_census_record", explode)
    prompt = runtime.build_user_message(_msg(spec_raw="S" * 100), role="CTO", model="modelo-x")
    assert "S" * 100 in prompt


def test_censo_nao_carrega_conteudo_do_prompt():
    """O censo é auditável em log: não pode carregar spec (LEI de PII e volume de log)."""
    runtime.build_user_message(
        _msg(spec_raw="SEGREDO-DO-CLIENTE " * 50), role="CTO", model="modelo-x",
    )
    assert "SEGREDO" not in repr(runtime.LAST_PROMPT_CENSUS.get())
