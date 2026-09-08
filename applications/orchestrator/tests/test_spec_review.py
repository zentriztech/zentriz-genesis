"""GAP-54 — a revisão da spec cobre 100% do TEXTO, em N passes, e presta contas.

O `spec_dossier` deu 100% de MAPA. Este módulo é o que fecha o TEXTO: nenhuma chamada única cabe
1.098.849 chars (~275k tokens contra janela de 200k), então a revisão passa a ser N passes até que
todo arquivo tenha sido lido VERBATIM em algum deles.

As propriedades que os testes fixam, e por que cada uma existe:

  • **spec que cabe → 1 passe.** Sem isto, cada projeto pequeno passaria a pagar N chamadas por um
    problema que ele não tem. O plano de passes é consequência do que cabe, não de um número.
  • **cobertura 100% na árvore real do NVX.** É a medição que abriu o GAP-54 (2 de 12 arquivos).
  • **parcial NÃO conta como coberto.** Contabilidade generosa foi o que produziu o "21 → 1 GAP" do
    GAP-13; aqui um arquivo meio lido é `partial`, e `complete` é False.
  • **passe que falhou não credita cobertura.** Creditar o dossiê ENVIADO em vez da resposta
    RECEBIDA é medir o passe, não o resultado (GAP-42/43).
  • **perguntas do CTO (D3) sobrevivem à agregação.** Engolir uma pergunta bloqueante é o GAP-62.
"""
import pytest

from orchestrator.spec_dossier import SpecFile, parse_spec_blocks
from orchestrator.spec_review import (
    ReviewPass,
    plan_review_passes,
    review_spec_per_file,
)
from orchestrator.tests.test_spec_dossier import NVX_TREE


def _nvx_files() -> list[SpecFile]:
    out = []
    for name, size in NVX_TREE:
        head = f"# {name[:-3]}\n\n## 1. Escopo\n\ntexto\n\n## 2. Regras\n\n"
        out.append(SpecFile(label=name, content=head + "x" * max(0, size - len(head))))
    return out


def _concat(files: list[SpecFile]) -> str:
    return "\n\n".join(f"---\n# [{sf.label}]\n\n{sf.content}" for sf in files)


NVX_SPEC = _concat(_nvx_files())

#: Orçamento de LEITURA do Opus 5 depois do GAP-61: (200.000 − 8.000) × 4 × 0,65.
READ_BUDGET = 499_200


def _ok(_focus, _text, _dossier):
    return {"status": "OK", "summary": "revisado"}


# ── 1. o plano de passes é consequência do que cabe ──────────────────────────


def test_spec_que_cabe_inteira_gasta_exatamente_um_passe():
    # 🔴 A trava de custo. Projeto pequeno não paga nada a mais do que pagava.
    files = [SpecFile(label="a.md", content="# A\n\ntexto"), SpecFile(label="b.md", content="# B\n\ntexto")]
    plan = plan_review_passes(files, budget=READ_BUDGET)
    assert len(plan) == 1
    assert plan[0][0] == ""
    assert plan[0][1].omitted == []


def test_arvore_do_nvx_planeja_menos_passes_que_arquivos():
    # O passe 1 já entrega vários arquivos íntegros; só os que ficaram fora ganham passe próprio.
    plan = plan_review_passes(_nvx_files(), budget=READ_BUDGET)
    assert 1 < len(plan) < len(NVX_TREE)


def test_arquivo_que_ja_veio_integro_no_passe_1_nao_ganha_passe_redundante():
    files = _nvx_files()
    plan = plan_review_passes(files, budget=READ_BUDGET)
    primeiro = plan[0][1]
    focos = {focus for focus, _d in plan[1:]}
    for label in primeiro.included:
        assert label not in focos, f"{label} veio íntegro e ainda ganhou passe próprio"


def test_todo_passe_carrega_o_MAPA_completo():
    # Sem o mapa em TODOS os passes, o agente do passe 5 não sabe que existe um passe 1.
    for _focus, d in plan_review_passes(_nvx_files(), budget=READ_BUDGET):
        assert d.map_coverage == 1.0
        assert "MAPA DA SPEC" in d.text


def test_teto_de_passes_e_declarado_nunca_silencioso():
    r = review_spec_per_file(NVX_SPEC, budget=READ_BUDGET, review_fn=_ok, max_passes=2)
    assert len(r.passes) == 2
    assert r.uncovered, "o que não foi lido tem de aparecer em uncovered"
    assert r.complete is False


# ── 2. 🔴 a cobertura que fecha o GAP-54 ─────────────────────────────────────


def test_regressao_nvx_os_12_arquivos_sao_lidos_verbatim():
    """ANTES (medido em prod 2026-09-08): 2 de 12 arquivos, 10,2% da spec."""
    r = review_spec_per_file(NVX_SPEC, budget=READ_BUDGET, review_fn=_ok)
    assert r.total_files == 12
    assert r.text_coverage == 1.0, f"faltaram: {r.uncovered + r.partial}"
    assert r.uncovered == []
    assert r.partial == []
    assert r.complete is True


def test_arquivo_maior_que_o_orcamento_de_escrita_chega_pelo_orcamento_de_leitura():
    # `modelo-dados.md` tem 218.840 chars: maior que o orçamento de ESCRITA (145.600), menor que o de
    # LEITURA (499.200). É exatamente o arquivo que o GAP-61 destravou — e com o orçamento de leitura
    # ele cabe já no PRIMEIRO passe, sem precisar de passe dedicado.
    r = review_spec_per_file(NVX_SPEC, budget=READ_BUDGET, review_fn=_ok)
    assert "modelo-dados.md" in r.covered
    assert "modelo-dados.md" in r.passes[0].dossier.included


def test_com_o_orcamento_antigo_o_arquivo_gigante_NAO_fecha_e_isso_e_declarado():
    """🔴 GAP-54 e GAP-61 NÃO são independentes — este teste é a prova.

    Repartir a leitura em N passes resolve árvore grande, mas não resolve ARQUIVO grande: com o
    orçamento derivado de `max_output` (145.600), `modelo-dados.md` (218.840) não cabe íntegro em
    passe nenhum, por mais passes que se gaste. A cobertura para em 11 de 12 — e o que importa é que
    ela para DECLARANDO, em vez de creditar o arquivo como lido.

    É por isso que os dois têm de ir juntos ao ar: sem o orçamento de LEITURA, o agente que decide o
    modelo de dados do produto continua nunca tendo visto o modelo de dados.
    """
    r = review_spec_per_file(NVX_SPEC, budget=145_600, review_fn=_ok, max_passes=32)
    assert r.covered == [lbl for lbl, _s in NVX_TREE if lbl != "modelo-dados.md"]
    assert r.partial == ["modelo-dados.md"]
    assert r.uncovered == []
    assert r.complete is False, "spec incompleta não pode se declarar completa"
    assert len(r.passes) > 8


def test_passe_dedicado_ENTREGA_o_arquivo_do_foco_mesmo_apertado():
    """🔴 Defeito encontrado por este teste: o passe focado descartava o arquivo do foco.

    Com orçamento de 145.600 e `modelo-dados.md` de 218.840, o first-fit pulava o arquivo do foco e
    enchia o espaço com irmãos menores. O passe existia, custava uma chamada e creditava cobertura
    que não houve — a família do GAP-42/43 (medir o passe, não o resultado), agora do lado do
    transporte. Foco passou a ter prioridade absoluta, com recorte parcial DECLARADO quando não cabe.
    """
    r = review_spec_per_file(NVX_SPEC, budget=145_600, review_fn=_ok, max_passes=32)
    dedicado = [p for p in r.passes if p.focus == "modelo-dados.md"]
    assert len(dedicado) == 1
    d = dedicado[0].dossier
    assert "modelo-dados.md" in d.included, "o passe dedicado tem de trazer o arquivo dedicado"
    assert d.partial == ["modelo-dados.md"], "não cabendo íntegro, o corte é declarado"
    # E o irmão menor NÃO pode ter tomado o lugar do arquivo do foco.
    assert d.included == ["modelo-dados.md"]


# ── 3. contabilidade honesta: parcial e falha não creditam ───────────────────


def test_parcial_nao_conta_como_coberto():
    # Orçamento em que nem o menor arquivo (51.009) cabe íntegro.
    r = review_spec_per_file(NVX_SPEC, budget=20_000, review_fn=_ok, max_passes=32)
    assert r.partial, "um arquivo meio lido tem de aparecer como parcial"
    for label in r.partial:
        assert label not in r.covered
    assert r.complete is False


def test_passe_que_falhou_nao_credita_cobertura():
    """🔴 Creditar o dossiê ENVIADO em vez da resposta RECEBIDA é medir o passe (GAP-42/43)."""

    def boom(_focus, _text, _d):
        raise RuntimeError("Bedrock 429")

    r = review_spec_per_file(NVX_SPEC, budget=READ_BUDGET, review_fn=boom)
    assert r.covered == []
    assert r.text_coverage == 0.0
    assert r.failures and "Bedrock 429" in r.failures[0]
    assert r.complete is False


def test_resposta_nao_dict_conta_como_falha_nao_como_sucesso():
    r = review_spec_per_file(NVX_SPEC, budget=READ_BUDGET, review_fn=lambda *_a: None)
    assert r.covered == []
    assert r.failures
    assert r.complete is False


def test_falha_de_um_passe_nao_aborta_os_outros():
    # Uma spec de 12 arquivos não pode perder a revisão inteira por um 429 no passe 3.
    chamadas = {"n": 0}

    def flaky(_focus, _text, _d):
        chamadas["n"] += 1
        if chamadas["n"] == 3:
            raise RuntimeError("429")
        return {"status": "OK"}

    r = review_spec_per_file(NVX_SPEC, budget=READ_BUDGET, review_fn=flaky)
    assert len(r.failures) == 1
    assert r.covered, "os passes que deram certo continuam valendo"
    assert r.complete is False


# ── 4. o que o passe DEVOLVE tem de sobreviver à agregação ───────────────────


def test_perguntas_de_qualquer_passe_sobrevivem():
    """Engolir pergunta bloqueante do CTO é o GAP-62 (fail-OPEN)."""

    def pergunta(focus, _text, _d):
        if focus == "privacidade-lgpd.md":
            return {"status": "NEEDS_INFO", "next_actions": {"questions": ["Qual o TTL do token?"]}}
        return {"status": "OK"}

    r = review_spec_per_file(
        NVX_SPEC,
        budget=READ_BUDGET,
        review_fn=pergunta,
        extract_questions=lambda resp: ((resp or {}).get("next_actions") or {}).get("questions") or [],
    )
    assert r.questions == ["Qual o TTL do token?"]


def test_pergunta_repetida_em_varios_passes_nao_duplica():
    def sempre(_focus, _text, _d):
        return {"status": "NEEDS_INFO", "next_actions": {"questions": ["Qual a stack?"]}}

    r = review_spec_per_file(
        NVX_SPEC,
        budget=READ_BUDGET,
        review_fn=sempre,
        extract_questions=lambda resp: ((resp or {}).get("next_actions") or {}).get("questions") or [],
    )
    assert r.questions == ["Qual a stack?"]


def test_o_foco_chega_ao_agente_junto_com_o_dossie():
    vistos = []

    def espia(focus, text, dossier):
        vistos.append((focus, len(text), tuple(dossier.included)))
        return {"status": "OK"}

    review_spec_per_file(NVX_SPEC, budget=READ_BUDGET, review_fn=espia)
    assert vistos[0][0] == ""
    focos = [v[0] for v in vistos[1:]]
    assert all(f for f in focos), "todo passe depois do primeiro tem foco explícito"
    for focus, _n, included in vistos[1:]:
        assert focus in included, "o passe focado tem de TRAZER o arquivo do foco"


# ── 5. casos degenerados ─────────────────────────────────────────────────────


def test_spec_vazia_nao_gasta_passe_nenhum():
    r = review_spec_per_file("", budget=READ_BUDGET, review_fn=_ok)
    assert r.passes == []
    assert r.total_files == 0
    # Vazio não é "completo com sucesso" nem "incompleto": não há o que revisar, e o chamador é quem
    # decide. O que NÃO pode é reportar cobertura falsa.
    assert r.text_coverage == 1.0
    assert r.covered == []


def test_spec_de_arquivo_unico_e_revisada_em_um_passe():
    r = review_spec_per_file("# Spec\n\n## 1\n\ntexto", budget=READ_BUDGET, review_fn=_ok)
    assert len(r.passes) == 1
    assert r.complete is True


def test_plano_de_spec_vazia_e_vazio():
    assert plan_review_passes([], budget=READ_BUDGET) == []


def test_review_pass_ok_exige_resposta_dict_sem_erro():
    assert ReviewPass(index=1, focus="", dossier=None, response={"a": 1}).ok is True  # type: ignore[arg-type]
    assert ReviewPass(index=1, focus="", dossier=None, response={}, error="x").ok is False  # type: ignore[arg-type]
    assert ReviewPass(index=1, focus="", dossier=None, response="texto").ok is False  # type: ignore[arg-type]


def test_max_passes_por_env(monkeypatch):
    monkeypatch.setenv("SPEC_REVIEW_MAX_PASSES", "3")
    plan = plan_review_passes(_nvx_files(), budget=READ_BUDGET)
    assert len(plan) == 3


@pytest.mark.parametrize("valor", ["", "zero", "-5"])
def test_env_invalido_cai_no_default_sem_quebrar(monkeypatch, valor):
    monkeypatch.setenv("SPEC_REVIEW_MAX_PASSES", valor)
    plan = plan_review_passes(_nvx_files(), budget=READ_BUDGET)
    assert 1 <= len(plan) <= 16


def test_parse_e_o_mesmo_formato_que_o_runner_concatena():
    # Se as duas expressões divergirem, o dossiê perde arquivos EM SILÊNCIO.
    from orchestrator.runner import _SPEC_BLOCK_RE

    from orchestrator.spec_dossier import _BLOCK_RE

    assert _BLOCK_RE.pattern == _SPEC_BLOCK_RE.pattern
    assert len(parse_spec_blocks(NVX_SPEC)) == 12
