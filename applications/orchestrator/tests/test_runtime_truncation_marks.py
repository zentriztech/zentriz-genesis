"""
Marcas de TRUNCAMENTO e de USAGE no envelope do agente — correção T1/G5 (2026-09-05).

O QUE ISTO PROTEGE (incidente real, projeto NVX LastMile):
  A spec tem 98.045 caracteres. O CTO regenera o documento INTEIRO, bate no teto de 64.000 tokens
  de SAÍDA do Opus 5 e a resposta volta `stop_reason="max_tokens"` — mas o envelope chegava à api
  com `status: "OK"` e um `summary` afirmando ter resolvido os GAPs. O texto parava no meio de uma
  linha (`… ON deliveries(courier_id) WHERE`) e o modo autônomo APLICAVA isso por cima da spec, que
  perdia tudo o que o modelo não chegou a reescrever.

  `_truncated` é o sinal que faltava: a api o propaga para `spec_chat_jobs.truncated`, a UI avisa
  "não aplique" e o laço autônomo se recusa a escrever no disco.

Segundo sinal (`_json_recovered_truncated`): não todo provedor preenche `stop_reason`. Quando o
JSON chega cortado e o `resilient_json_parse` precisa FECHAR as chaves à força para recuperar o
artefato parcial, isso é, por definição, um documento truncado.

`_input_tokens_total` / `_output_tokens_total` (G5): o custo do CTO da Bancada não era debitado em
`project_agent_metrics` porque `run_agent` só logava os tokens. Os TOTAIS somam os repairs (LEI 5),
que também são pagos.
"""


def test_mark_truncation_por_stop_reason():
    from orchestrator.agents.runtime import _mark_truncation
    out = {"status": "OK", "summary": "Resolvi tudo."}
    _mark_truncation(out, "max_tokens", "CTO")
    assert out["_truncated"] is True
    assert out["_truncated_signal"] == "stop_reason=max_tokens"


def test_mark_truncation_stop_reason_normal_nao_marca():
    from orchestrator.agents.runtime import _mark_truncation
    out = {"status": "OK"}
    _mark_truncation(out, "end_turn", "CTO")
    assert out["_truncated"] is False
    # sem sinal: nada de campo fantasma para a api interpretar
    assert "_truncated_signal" not in out


def test_mark_truncation_por_json_recuperado_e_consome_a_marca_interna():
    """O `_json_recovered_truncated` é detalhe do parser: sai do envelope, virando `_truncated`."""
    from orchestrator.agents.runtime import _mark_truncation
    out = {"status": "OK", "_json_recovered_truncated": True}
    _mark_truncation(out, "end_turn", "CTO")
    assert out["_truncated"] is True
    assert out["_truncated_signal"] == "json_recovered"
    assert "_json_recovered_truncated" not in out


def test_mark_usage_totals_expoe_totais_sem_apagar_o_contrato_antigo():
    from orchestrator.agents.runtime import _mark_usage_totals
    out = {"status": "OK", "_input_tokens": 40_000, "_output_tokens": 20_000}
    _mark_usage_totals(out, 100_900, 58_200, 2)
    assert out["_input_tokens_total"] == 100_900
    assert out["_output_tokens_total"] == 58_200
    assert out["_llm_calls"] == 2
    # o runner.py lê `_input_tokens`/`_output_tokens` — não podem mudar de significado
    assert out["_input_tokens"] == 40_000
    assert out["_output_tokens"] == 20_000


def test_envelope_json_cortado_e_recuperado_marca_truncamento():
    """JSON que termina no meio: o parser fecha à força e DECLARA que recuperou um parcial."""
    from orchestrator.envelope import resilient_json_parse
    truncado = (
        '{"status": "OK", "summary": "parcial", "artifacts": [{"path": "docs/spec/PRODUCT_SPEC.md",'
        ' "content": "# Spec\\n\\n## 1. Contexto\\ntexto que para no meio'
    )
    data, errs = resilient_json_parse(truncado)
    assert errs == []
    assert data.get("_json_recovered_truncated") is True
    assert data["artifacts"][0]["path"] == "docs/spec/PRODUCT_SPEC.md"
    # o conteúdo parcial é PRESERVADO (recuperar o trabalho pago é o comportamento certo)
    assert "para no meio" in data["artifacts"][0]["content"]


def test_envelope_json_intacto_nao_marca_truncamento():
    from orchestrator.envelope import resilient_json_parse
    data, errs = resilient_json_parse('{"status": "OK", "summary": "completo", "artifacts": []}')
    assert errs == []
    assert data["summary"] == "completo"
    assert "_json_recovered_truncated" not in data
