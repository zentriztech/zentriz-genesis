"""🔴 GAP-148 — o instrumento de cache existia em UM dos três caminhos de medição.

O GAP-142 deu ao `spec_validator` colunas e leitura de tokens de cache; o GAP-147 mostrou o preço de
não ter: no instante em que o cache passou a funcionar, `input_tokens` caiu para 2 e o medidor
(fonte única) subestimou a validação em ~99% — gasto invisível ao cost cap do tenant, a mesma
família do G5. Sobravam DOIS caminhos com o mesmo risco latente, e são justamente os mais caros:

  1. **CTO da Bancada** (api → agents `/invoke/cto/async` e `/invoke/raw`): grava na MESMA tabela,
     mas o envelope de `run_agent` não carregava cache e o `usage` do `/invoke/raw` também não.
     Medição de 30 h (2026-09-05): 9 chamadas do CTO = 908.160 tokens de entrada.
  2. **Splitter / decomposição de produto**: grava em `product_proposals`, que não tinha colunas
     (migration 117).

Por isso a ordem é sempre INSTRUMENTO → MARCAÇÃO. Aqui não se liga cache em nenhum dos dois: só se
garante que, quando ligar, o token aparece no medidor. E a lei do `truncated[]` vale igual: chave
AUSENTE = "o provedor não reportou" (NULL), chave presente valendo 0 = "medi, não houve cache".
"""
import types


class _UsageSDK:
    """Usage no dialeto do SDK `anthropic` (AnthropicBedrock)."""

    def __init__(self, r=None, w=None):
        self.input_tokens, self.output_tokens = 100, 10
        self.cache_read_input_tokens = r
        self.cache_creation_input_tokens = w


# ── 1. envelope do run_agent (caminho do CTO da Bancada) ──────────────────────

def test_mark_usage_totals_carrega_cache_quando_medido():
    from orchestrator.agents.runtime import _mark_usage_totals
    out = {"status": "OK"}
    _mark_usage_totals(out, 100_900, 58_200, 2, 163_941, 0)
    assert out["_cache_read_tokens_total"] == 163_941
    assert out["_cache_write_tokens_total"] == 0
    # contrato antigo intacto
    assert out["_input_tokens_total"] == 100_900 and out["_llm_calls"] == 2


def test_mark_usage_totals_omite_cache_nao_medido():
    """Sem isto, o débito gravaria 0 e um relatório afirmaria 'nenhum cache' sem ter medido."""
    from orchestrator.agents.runtime import _mark_usage_totals
    out = {"status": "OK"}
    _mark_usage_totals(out, 10, 5, 1)
    assert "_cache_read_tokens_total" not in out
    assert "_cache_write_tokens_total" not in out


# ── 2. `usage` do /invoke/raw (edição por arquivo da Bancada) ──────────────────

def test_last_usage_carrega_cache_em_snake_case():
    """O contrato HTTP do /invoke/raw é snake_case (`input_tokens`) — o cache segue a mesma forma."""
    from orchestrator.agents import runtime
    runtime._record_call_outcome(2, 900, "end_turn",
                                 {"cacheReadTokens": 51_200, "cacheWriteTokens": 0})
    u = runtime.LAST_USAGE.get()
    assert u["input_tokens"] == 2
    assert u["cache_read_tokens"] == 51_200
    assert u["cache_write_tokens"] == 0


def test_last_usage_sem_cache_nao_inventa_chave():
    from orchestrator.agents import runtime
    runtime._record_call_outcome(10, 20, None)
    u = runtime.LAST_USAGE.get()
    assert "cache_read_tokens" not in u and "cache_write_tokens" not in u


def test_record_call_outcome_nunca_lanca():
    """Cobrança é observabilidade: não pode derrubar a entrega (mesmo racional do débito na api)."""
    from orchestrator.agents import runtime
    runtime._record_call_outcome(1, 1, "end_turn", {"cacheReadTokens": "lixo"})  # não lança


# ── 3. coletor de operação multi-chamada (splitter/decomposição) ───────────────

def test_collector_soma_cache_de_varias_chamadas():
    from orchestrator.agents.runtime import _UsageCollector
    c = _UsageCollector()
    c.add(100, 10, "sonnet-5", {"cacheWriteTokens": 8_000, "cacheReadTokens": 0})
    c.add(2, 20, "sonnet-5", {"cacheWriteTokens": 0, "cacheReadTokens": 8_000})
    t = c.totals()
    assert t["cache_write_tokens"] == 8_000
    assert t["cache_read_tokens"] == 8_000
    assert t["input_tokens"] == 102 and t["calls"] == 2


def test_collector_sem_cache_reportado_nao_expoe_zero():
    from orchestrator.agents.runtime import _UsageCollector
    c = _UsageCollector()
    c.add(100, 10, "sonnet-5")
    t = c.totals()
    assert "cache_read_tokens" not in t and "cache_write_tokens" not in t


def test_collector_negativo_nao_passa():
    """Mesma guarda da migration 070/116: negativo distorceria o relatório de economia."""
    from orchestrator.agents.runtime import _UsageCollector
    c = _UsageCollector()
    c.add(1, 1, "m", {"cacheReadTokens": -5})
    assert c.totals()["cache_read_tokens"] == 0


# ── 4. o sink e o outcome recebem o cache do provedor de fato ──────────────────

def test_sink_recebe_cache_da_chamada_real(monkeypatch):
    """Prova de ponta: o que `_cache_tokens` extrai do provedor chega ao coletor da operação."""
    from orchestrator.agents import runtime
    c = runtime._UsageCollector()
    with runtime.collect_usage(c):
        runtime._sink_usage(100, 10, "sonnet-5", runtime._cache_tokens(_UsageSDK(r=7, w=0)))
    assert c.totals()["cache_read_tokens"] == 7


def test_invoke_raw_outcome_reflete_o_dialeto_converse():
    """Cross-family (Nova/Mistral) reporta em camelCase da Converse — o instrumento cobre os dois."""
    from orchestrator.agents import runtime
    cache = runtime._cache_tokens({"cacheReadInputTokens": 9, "cacheWriteInputTokens": 0})
    runtime._record_call_outcome(2, 5, "end_turn", cache)
    assert runtime.LAST_USAGE.get()["cache_read_tokens"] == 9


def test_usage_de_objeto_sem_atributos_de_cache_nao_gera_chave():
    from orchestrator.agents import runtime
    vazio = types.SimpleNamespace(input_tokens=5, output_tokens=1)
    assert runtime._cache_tokens(vazio) == {}
