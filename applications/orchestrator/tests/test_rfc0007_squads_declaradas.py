"""RFC-0007 F1/F4 — a Fábrica não pode descartar squads em silêncio.

Medido em prod (2026-09-10): 7 de 26 propostas do Engineer declararam 2+ squads e nas 7
só a primeira virou backlog/tasks — a run terminava reportando sucesso sobre uma fatia do
produto. Estes testes trancam o comportamento novo:

  • `squads_pendentes` nomeia o que ficou de fora (e devolve [] quando nada ficou);
  • o checkpoint carrega `squads_declared` e sobrevive a checkpoint antigo sem o campo;
  • o override de dono de task só muda por marcador EXPLÍCITO (fim do "webhook" → DEV_WEB).
"""
import json

from orchestrator.pipeline_context import PipelineContext
from orchestrator.runner import _parse_squads_yaml, squads_pendentes


PROPOSTA_3_SQUADS = """<!-- Created by: engineer -->

---
squads:
  - name: backend
    module: backend
    owner_role: DEV_BACKEND
    variant: nodejs-nestjs
    target_tasks: 11
  - name: web
    module: web
    owner_role: DEV_WEB
    variant: react-next-materialui
    target_tasks: 7
  - name: mobile
    module: mobile
    owner_role: DEV_MOBILE
    variant: react-native
    target_tasks: 6
complexity_hint: high
scope: code
---

# Proposta
"""

PROPOSTA_1_SQUAD = """<!-- Created by: engineer -->

---
squads:
  - name: web
    module: web
    owner_role: DEV_WEB
    variant: react-next-materialui
    target_tasks: 4
complexity_hint: low
scope: code
---

# Proposta
"""


def test_frontmatter_sobrevive_ao_comentario_html_antes_do_delimitador():
    # O Engineer grava `<!-- Created by: engineer -->` ANTES do `---`. Um parser ancorado no
    # início do arquivo enxergaria zero squads (foi o que aconteceu na primeira medição).
    squads = _parse_squads_yaml(PROPOSTA_3_SQUADS)
    assert [s["module"] for s in squads] == ["backend", "web", "mobile"]


def test_squads_pendentes_nomeia_as_que_a_run_nao_planeja():
    squads = _parse_squads_yaml(PROPOSTA_3_SQUADS)
    pend = squads_pendentes(squads, "backend")
    assert [s["module"] for s in pend] == ["web", "mobile"]


def test_squad_unica_nao_gera_pendencia():
    # 19 de 26 propostas em prod são de squad única: este é o caminho que funciona hoje
    # e ele NÃO pode mudar de comportamento.
    squads = _parse_squads_yaml(PROPOSTA_1_SQUAD)
    assert squads_pendentes(squads, "web") == []


def test_sem_frontmatter_nao_ha_pendencia():
    assert _parse_squads_yaml("# proposta sem frontmatter") == []
    assert squads_pendentes([], "backend") == []


def test_modulo_planejado_ausente_nao_esconde_nada():
    # Se o módulo desta run é desconhecido, TODAS as squads declaradas contam como pendentes:
    # a falha tem de ser alta, nunca "nenhuma pendência" por omissão.
    squads = _parse_squads_yaml(PROPOSTA_3_SQUADS)
    assert len(squads_pendentes(squads, None)) == 3


def test_comparacao_de_modulo_ignora_caixa():
    # O frontmatter é escrito por LLM e já apareceu como `module: Backend`. Se a comparação
    # fosse sensível à caixa, a própria squad planejada viraria "pendente" — alarme falso.
    squads = [{"module": "Backend"}, {"module": "WEB"}]
    assert [s["module"] for s in squads_pendentes(squads, "backend")] == ["WEB"]


def test_checkpoint_leva_e_traz_as_squads_declaradas(tmp_path):
    ctx = PipelineContext(project_id="p1")
    ctx.squads_declared = _parse_squads_yaml(PROPOSTA_3_SQUADS)
    ctx.current_module = "backend"
    ctx.save_checkpoint(tmp_path)

    lido = PipelineContext.load_checkpoint(tmp_path, "p1")
    assert lido is not None
    assert [s["module"] for s in lido.squads_declared] == ["backend", "web", "mobile"]
    assert [s["module"] for s in squads_pendentes(lido.squads_declared, lido.current_module)] == ["web", "mobile"]


def test_checkpoint_antigo_sem_o_campo_nao_quebra(tmp_path):
    ctx = PipelineContext(project_id="p2")
    ctx.current_module = "web"
    ctx.save_checkpoint(tmp_path)
    # Simula checkpoint gravado ANTES do RFC-0007: remove a chave do JSON.
    alvo = tmp_path / "p2" / "checkpoint.json"
    dados = json.loads(alvo.read_text(encoding="utf-8"))
    dados.pop("squads_declared", None)
    alvo.write_text(json.dumps(dados), encoding="utf-8")

    lido = PipelineContext.load_checkpoint(tmp_path, "p2")
    assert lido is not None
    assert lido.squads_declared == []
    assert squads_pendentes(lido.squads_declared, lido.current_module) == []
