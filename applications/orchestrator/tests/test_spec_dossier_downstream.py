"""🔴 GAP-54b — quem CONSTRÓI o produto passa a LER a spec. E GAP-54c, achado ao fiar o 54b.

## O "antes" MEDIDO (prod, 2026-09-08, projeto `e2a1988c` NVX LastMile — Backend)

O GAP-54 consertou a ponta da Bancada: o CTO passou a ler 12 de 12 arquivos verbatim. A jusante a
conta era pior do que "cortada":

    árvore da spec .......... 1.067.990 chars em 12 arquivos
    Engineer / CTO .......... `product_spec` cortado em 97.066 chars = **9,1% do produto**
    PM / Dev / QA ........... **nada** — só `charter`/`backlog` (≤40.000), resumos derivados

## E o que a fiação revelou (por que testar `call_*` e não só `PipelineContext`)

Mexer só em `build_inputs_for_*` seria um **no-op silencioso**, a mesma classe do
`sibling_files_context` (chegava em `inputs` e nunca era emitido no prompt) e do Estágio B pulado do
GAP-13 (nasceu num `if`, não num algoritmo):

  • `call_engineer` SOBRESCREVIA `inputs["product_spec"]` com `spec_content[:_spec_input_cap()]`
    DEPOIS de `build_inputs_for_engineer` — 9,1% do produto passando por cima da leitura íntegra;
  • `call_dev` e `call_qa` **nunca chamam** `build_inputs_for_dev` — montam `inputs` do zero;
  • `call_qa` não recebia nem `pipeline_ctx`.

## GAP-54c — três campos que atravessavam o envelope e morriam no montador do prompt

`task_scope_instruction`, `evolution_scope_instruction` e `evolution_qa_instruction` eram
preenchidos pelo runner/contexto e **nenhum `envelope.get(...)`** os emitia. O efeito é perverso
porque o texto perdido era o que RESTRINGE: o QA recebia `task_files` sem a regra "valide SOMENTE
estes arquivos" e reprovava por ausência de arquivos de outras tasks.
"""
import json

import pytest

from orchestrator import runner, spec_focus
from orchestrator.pipeline_context import PipelineContext
from orchestrator.spec_dossier import SpecFile
from orchestrator.tests.test_spec_dossier import NVX_TREE


def _tree_text() -> str:
    """Árvore do NVX no formato de `load_spec_all` (fronteira `---\\n# [arquivo]\\n\\n`)."""
    parts = []
    for name, size in NVX_TREE:
        head = f"# {name[:-3]}\n\n## 1. Escopo\n\ntexto\n\n## 2. Regras\n\n"
        parts.append(f"---\n# [{name}]\n\n" + head + "x" * max(0, size - len(head)))
    return "\n\n".join(parts)


@pytest.fixture()
def ctx(monkeypatch) -> PipelineContext:
    """Contexto com a árvore REAL do NVX carregada, e um teto de leitura fixo (sem tocar Bedrock)."""
    monkeypatch.setenv("SPEC_DOSSIER_DOWNSTREAM", "on")
    monkeypatch.setattr(PipelineContext, "_spec_read_cap", lambda self: 499_200)
    c = PipelineContext("p-nvx")
    c.set_spec_tree(_tree_text())
    c.set_charter("Charter do módulo backend. Ver contratos-erros.md para o envelope de erro.")
    c.set_backlog("BACKLOG")
    c.current_module = "backend"
    return c


# ── 1. o instrumento: orçamento por papel ────────────────────────────────────


def test_engineer_usa_o_teto_de_leitura_e_o_dev_nao(ctx):
    """O Engineer é chamado UMA vez e precisa do produto todo; o Dev é chamado por TASK.

    Dar ao Dev o teto de leitura multiplicaria a conta do projeto inteiro por task — é o ataque de
    custo levantado no adversarial cross-família (Nova Pro, 2026-09-08), e ele procede.
    """
    assert spec_focus.role_budget("ENGINEER", 499_200) == 499_200
    assert spec_focus.role_budget("DEV", 499_200) == 40_000
    assert spec_focus.role_budget("QA", 499_200) == 40_000
    assert spec_focus.role_budget("PM", 499_200) == 120_000


def test_orcamento_do_papel_nunca_passa_do_teto_fisico(monkeypatch):
    monkeypatch.setenv("SPEC_DOSSIER_PM_CHARS", "900000")
    assert spec_focus.role_budget("PM", 499_200) == 499_200


def test_papel_desconhecido_cai_no_orcamento_generico():
    assert spec_focus.role_budget("DEVOPS", 499_200) == 40_000
    assert spec_focus.role_budget("ARQUEOLOGO", 499_200) == 40_000


def test_flag_off_nao_emite_nada(monkeypatch, ctx):
    monkeypatch.setenv("SPEC_DOSSIER_DOWNSTREAM", "off")
    assert ctx.spec_dossier_for("DEV") == ""


def test_orcamento_abaixo_do_minimo_util_prefere_nao_emitir(monkeypatch):
    """Dossiê que não cabe nem um pedaço de arquivo é pior que o `charter` que o papel já tinha."""
    monkeypatch.setenv("SPEC_DOSSIER_DOWNSTREAM", "on")
    monkeypatch.setenv("SPEC_DOSSIER_DEV_CHARS", "3000")
    files = [SpecFile(label="a.md", content="x" * 50_000)]
    text, dossier = spec_focus.build_role_dossier("DEV", files, read_cap=499_200)
    assert (text, dossier) == ("", None)


# ── 2. o conteúdo: mapa de 100%, foco, selo e o que ficou fora NOMEADO ───────


def test_dossie_do_engineer_cobre_os_12_arquivos_no_mapa(ctx):
    text = ctx.spec_dossier_for("ENGINEER")
    assert text
    for name, _size in NVX_TREE:
        assert name in text, f"{name} não apareceu nem no mapa"
    assert "=== FIM DO DOSSIÊ" in text, "o selo de integridade prova que nada foi cortado no caminho"
    assert "não invente" in text


def test_dossie_declara_que_e_so_leitura_e_que_e_o_contrato(ctx):
    text = ctx.spec_dossier_for("PM")
    assert "SÓ LEITURA" in text
    assert "NÃO reescreve a spec" in text


def test_foco_do_dev_sai_de_citacao_literal_da_task(ctx):
    """Transporte, não relevância inferida: o arquivo entra porque alguém escreveu o nome dele."""
    task = {"title": "Criar índices", "spec_refs": ["contratos-erros.md"]}
    text = ctx.spec_dossier_for("DEV", PipelineContext._task_focus_texts(task, ""))
    assert "Foco deste dossiê" in text and "contratos-erros.md" in text
    row = [r for r in ctx.spec_dossier_coverage if r["role"] == "DEV"][0]
    assert "contratos-erros.md" not in row["omitted"], "o arquivo CITADO não pode ficar de fora"
    assert "--- INÍCIO contratos-erros.md ---" in text, "citado tem de vir com texto, não só no mapa"


def test_sem_citacao_a_ordem_e_a_original_da_bancada(ctx):
    """Ausência de julgamento — não julgamento fixo disfarçado de heurística (LEI do Jean)."""
    text = ctx.spec_dossier_for("DEV", ["nada aqui cita arquivo"])
    row = [r for r in ctx.spec_dossier_coverage if r["role"] == "DEV"][0]
    assert row["emitted"] is True
    primeiro = NVX_TREE[0][0]
    assert f"--- INÍCIO {primeiro} ---" in text


def test_tabela_de_oraculos_viaja_no_dossie(ctx):
    """GAP-22: a Bancada FECHOU a contradição; sem a tabela o Dev a reabre ao escrever código."""
    ctx.set_spec_oracles([
        {"contractKey": "paginacao", "oraclePath": "contratos-erros.md", "ruleSummary": "cursor opaco"},
        {"contractKey": "sem-path"},  # incompleto → não sai (é fato ou não é)
    ])
    text = ctx.spec_dossier_for("PM")
    assert "FONTE ÚNICA DE CADA CONTRATO" in text
    assert "**paginacao** → fonte única: `contratos-erros.md` — cursor opaco" in text
    assert "sem-path" not in text


def test_oraculos_sem_nada_valido_nao_emitem_secao_vazia(ctx):
    ctx.set_spec_oracles([{"foo": "bar"}])
    assert "FONTE ÚNICA DE CADA CONTRATO" not in ctx.spec_dossier_for("PM")


# ── 3. a contabilidade tem de ser FALSIFICÁVEL (L4 / lição do GAP-42-43) ─────


def test_cobertura_do_dev_cai_porque_o_orcamento_morde(ctx):
    ctx.spec_dossier_for("DEV")
    row = [r for r in ctx.spec_dossier_coverage if r["role"] == "DEV"][0]
    assert row["emitted"] is True
    assert row["budget"] == 40_000
    assert row["map_coverage"] == 1.0, "o mapa é barato: cobre 100% mesmo com texto de 3%"
    assert row["text_coverage"] < 0.10, "com 40.000 de 1.067.990 o texto NÃO pode alegar cobertura alta"
    assert row["omitted"], "o que ficou fora tem de vir NOMEADO"
    # Nada se perde na contabilidade: todo arquivo é verbatim, parcial ou NOMEADO como fora.
    assert len(row["omitted"]) + row["files_verbatim"] + len(row["partial"]) == row["files_total"] == 12


def test_nenhum_arquivo_desaparece_calado_nem_no_orcamento_do_dev(ctx):
    """🔴 Medido ao provar o GAP-54b AO VIVO em prod (2026-09-08), antes deste conserto.

    Com o orçamento do Dev/QA (40.000 → mapa de 13.333) a árvore do NVX indexava **7 de 12**
    arquivos e os outros 5 saíam do dossiê **sem sequer serem nomeados**: `map_coverage` 0,5833. Um
    arquivo que não é nomeado é indistinguível de um arquivo que NÃO EXISTE — o agente não tem como
    dizer "isto está na spec e eu não recebi", e a omissão volta a ser silenciosa. `map_coverage`
    pode cair (o índice de seções é caro); `name_coverage` NÃO pode.
    """
    text = ctx.spec_dossier_for("DEV")
    row = [r for r in ctx.spec_dossier_coverage if r["role"] == "DEV"][0]
    assert row["name_coverage"] == 1.0, "todo arquivo da spec tem de vir NOMEADO no dossiê do Dev"
    for name, _size in NVX_TREE:
        assert name in text, f"{name} desapareceu calado do dossiê do Dev"
    if row["map_coverage"] < 1.0:
        assert "ÍNDICE DE SEÇÕES NÃO COUBE" in text, "índice cortado tem de ser DECLARADO"
        assert "não conclua que não existe" in text


def test_piso_de_nomeacao_vale_no_orcamento_minimo(monkeypatch, ctx):
    """No pior orçamento aceitável, o mapa degrada para lista de nomes — nunca perde nomes."""
    monkeypatch.setenv("SPEC_DOSSIER_DEV_CHARS", str(spec_focus.MIN_USEFUL_BUDGET))
    text = ctx.spec_dossier_for("DEV")
    assert text
    for name, _size in NVX_TREE:
        assert name in text, f"{name} desapareceu no orçamento mínimo"


def test_uma_linha_por_papel_mesmo_chamado_muitas_vezes(ctx):
    for i in range(5):
        ctx.spec_dossier_for("DEV", [f"task {i}"])
    assert len([r for r in ctx.spec_dossier_coverage if r["role"] == "DEV"]) == 1


def test_arvore_ausente_no_processo_vira_LINHA_e_nao_silencio(monkeypatch):
    """Checkpoint restaurado noutro processo sem `set_spec_tree`: a cauda MUDA é o defeito."""
    monkeypatch.setenv("SPEC_DOSSIER_DOWNSTREAM", "on")
    c = PipelineContext("p")
    c.spec_tree_files, c.spec_tree_chars = 12, 1_067_990  # a contabilidade diz que havia árvore
    assert c.spec_dossier_for("DEV") == ""
    row = c.spec_dossier_coverage[0]
    assert row == {
        "role": "DEV", "emitted": False,
        "reason": "spec_tree_missing_in_process", "spec_tree_files": 12,
    }


def test_projeto_sem_spec_nao_registra_nada(monkeypatch):
    monkeypatch.setenv("SPEC_DOSSIER_DOWNSTREAM", "on")
    c = PipelineContext("p")
    assert c.spec_dossier_for("DEV") == ""
    assert c.spec_dossier_coverage == []


# ── 4. checkpoint: a CONTABILIDADE persiste, o 1 MB da árvore NÃO ────────────


def test_checkpoint_guarda_a_conta_e_nao_a_arvore(tmp_path, ctx):
    ctx.set_spec_oracles([{"contractKey": "k", "oraclePath": "README.md", "ruleSummary": "r"}])
    ctx.spec_dossier_for("DEV")
    ctx.save_checkpoint(tmp_path)
    raw = (tmp_path / "p-nvx" / "checkpoint.json").read_text(encoding="utf-8")
    data = json.loads(raw)
    assert data["spec_tree_files"] == 12
    assert data["spec_tree_chars"] > 1_000_000
    assert data["spec_dossier_coverage"][0]["role"] == "DEV"
    assert "_spec_tree" not in data
    # A prova de que a árvore não entrou: 1 MB de spec num checkpoint de poucas dezenas de KB.
    assert len(raw) < 200_000, f"checkpoint inflou para {len(raw)} chars — a árvore entrou"

    restored = PipelineContext.load_checkpoint(tmp_path, "p-nvx")
    assert restored.spec_tree_files == 12
    assert restored.spec_oracles[0]["contractKey"] == "k"
    assert restored.spec_dossier_coverage[0]["role"] == "DEV"


def test_checkpoint_antigo_sem_os_campos_novos_carrega(tmp_path):
    p = tmp_path / "old" / "checkpoint.json"
    p.parent.mkdir(parents=True)
    p.write_text(json.dumps({"project_id": "old", "spec_raw": "x"}), encoding="utf-8")
    c = PipelineContext.load_checkpoint(tmp_path, "old")
    assert (c.spec_tree_files, c.spec_oracles, c.spec_dossier_coverage) == (0, [], [])


# ── 5. 🔴 A FIAÇÃO: o que os `call_*` REALMENTE mandam no envelope ───────────


@pytest.fixture()
def envelope(monkeypatch):
    """Intercepta `_build_message_envelope` e devolve os `inputs` que chegaram ao envelope."""
    capturado: dict = {}

    def fake_envelope(request_id, actor, module, action, **kw):
        capturado.clear()
        capturado.update(kw.get("inputs") or {})
        return {"inputs": capturado}

    monkeypatch.setattr(runner, "_build_message_envelope", fake_envelope)
    monkeypatch.setattr(runner, "run_agent", lambda **kw: {"status": "OK"}, raising=False)
    monkeypatch.setenv("API_AGENTS_URL", "http://agents.test")
    monkeypatch.setattr(
        "orchestrator.agents.client_http.run_agent_http",
        lambda name, message: {"status": "OK"},
    )
    return capturado


def test_engineer_recebe_o_dossie_e_nao_os_9_por_cento(envelope, ctx):
    """🔴 A regressão real: `call_engineer` sobrescrevia o dossiê com o corte de 145.000."""
    runner.call_engineer("s", _tree_text(), "r", pipeline_ctx=ctx)
    ps = envelope["product_spec"]
    assert "=== MAPA DA SPEC" in ps, "o dossiê foi sobrescrito pelo corte de escrita"
    assert envelope["spec_readonly"] is True
    assert "spec_raw" not in envelope, "a mesma spec duas vezes = duas versões contraditórias"


def test_pm_passa_a_receber_a_spec(envelope, ctx):
    """Antes: o PM decompunha o produto SEM a spec — só `charter` (≤40.000), um resumo dela."""
    runner.call_pm("s", ctx.charter, "r", module="backend", pipeline_ctx=ctx)
    assert "=== MAPA DA SPEC" in envelope["product_spec"]
    assert envelope["spec_readonly"] is True
    # O charter cita `contratos-erros.md` → o foco tem de sair dessa citação literal.
    assert "contratos-erros.md" in envelope["product_spec"].split("=== TEXTO ÍNTEGRO")[0]


def test_dev_passa_a_receber_a_spec_mesmo_sem_build_inputs_for_dev(envelope, ctx):
    """`call_dev` monta `inputs` do zero — por isso o dossiê é fiado ali, não no contexto."""
    runner.call_dev(
        "s", ctx.charter, ctx.backlog, "r", task_id="T1", task="Implementar paginação",
        task_dict={"taskId": "T1", "spec_refs": ["contratos-erros.md"]}, pipeline_ctx=ctx,
    )
    assert "=== MAPA DA SPEC" in envelope["product_spec"]
    assert "contratos-erros.md" in envelope["product_spec"]


def test_qa_mede_contra_o_contrato_e_e_avisado_disso(envelope, ctx):
    """O papel em que a lacuna doía mais: veredicto de conformidade sem o documento de referência."""
    runner.call_qa(
        "s", ctx.charter, ctx.backlog, "dev fez", "r",
        task_id="T1", task="Validar paginação", pipeline_ctx=ctx,
        task_dict={"taskId": "T1", "spec_refs": ["contratos-erros.md"]},
    )
    assert "=== MAPA DA SPEC" in envelope["product_spec"]
    assert "CONTRATO do produto" in envelope["spec_scope_instruction"]


def test_dev_e_qa_nao_levantam_o_teto_global_do_prompt(envelope, ctx):
    """🔴 Achado da revisão adversarial DESTA implementação (2026-09-08).

    `spec_readonly=True` é verdade para o Dev e o QA — nenhum dos dois reemite a spec. Mas em
    `_prompt_budget` a flag também levanta o teto GLOBAL do prompt de 280.000 para 499.200 chars, e
    o Dev/QA são chamados **uma vez por task**. Ligá-la sem necessidade liberaria ~219.000 chars de
    artefatos que o global vinha cortando, na chamada mais frequente do sistema — o mesmo ataque de
    custo que o adversarial cross-família levantou, entrando por outra porta. Com 40.000 de dossiê
    (< 97.066 do teto default de `product_spec`) o teto não morde: o dossiê chega íntegro E o
    orçamento do Dev/QA fica idêntico ao de antes.
    """
    default_cap = runner._default_product_spec_cap("DEV")
    assert default_cap > 40_000, "se o default caísse abaixo do orçamento do Dev, a flag passa a ser necessária"
    runner.call_dev("s", ctx.charter, ctx.backlog, "r", task_id="T1", task="x", pipeline_ctx=ctx)
    assert "=== MAPA DA SPEC" in envelope["product_spec"], "e o dossiê chega mesmo assim"
    assert len(envelope["product_spec"]) <= default_cap
    assert "spec_readonly" not in envelope


def test_engineer_precisa_do_levantamento_e_por_isso_o_declara(envelope, ctx):
    """A outra metade da mesma regra: quem pede MAIS que o default declara `spec_readonly`.

    Suprimir a flag aqui seria reintroduzir o GAP-61 — o teto de LEITURA derivado do de ESCRITA.
    """
    runner.call_engineer("s", _tree_text(), "r", pipeline_ctx=ctx)
    assert len(envelope["product_spec"]) > runner._default_product_spec_cap("ENGINEER")
    assert envelope["spec_readonly"] is True


def test_qa_sem_contexto_segue_funcionando_como_antes(envelope, ctx):
    runner.call_qa("s", "c", "b", "d", "r")
    assert "product_spec" not in envelope
    assert "spec_scope_instruction" not in envelope


@pytest.mark.parametrize("papel", ["ENGINEER", "PM", "DEV", "QA"])
def test_flag_off_devolve_o_comportamento_anterior_papel_por_papel(monkeypatch, envelope, ctx, papel):
    monkeypatch.setenv("SPEC_DOSSIER_DOWNSTREAM", "off")
    if papel == "ENGINEER":
        runner.call_engineer("s", _tree_text(), "r", pipeline_ctx=ctx)
        assert "=== MAPA DA SPEC" not in envelope["product_spec"]
        assert len(envelope["product_spec"]) <= runner._spec_input_cap()
    elif papel == "PM":
        runner.call_pm("s", ctx.charter, "r", module="backend", pipeline_ctx=ctx)
        assert "product_spec" not in envelope
    elif papel == "DEV":
        runner.call_dev("s", ctx.charter, ctx.backlog, "r", task_id="T1", task="x", pipeline_ctx=ctx)
        assert "product_spec" not in envelope
    else:
        runner.call_qa("s", "c", "b", "d", "r", pipeline_ctx=ctx)
        assert "product_spec" not in envelope
    assert "spec_readonly" not in envelope


def test_dossie_indisponivel_nao_derruba_a_chamada(envelope, ctx, monkeypatch):
    """Dossiê é CONTEXTO, não pré-requisito: exceção mantém o caminho antigo de pé."""
    def boom(*a, **k):
        raise RuntimeError("orçamento indisponível")

    monkeypatch.setattr(ctx, "spec_dossier_for", boom)
    runner.call_dev("s", ctx.charter, ctx.backlog, "r", task_id="T1", task="x", pipeline_ctx=ctx)
    assert envelope["charter"] == ctx.charter
    assert "spec_readonly" not in envelope


# ── 6. 🔴 GAP-54c: as regras de escopo passam a CHEGAR no prompt ─────────────


@pytest.mark.parametrize(
    "campo,titulo",
    [
        ("evolution_scope_instruction", "Escopo desta evolução"),
        ("task_scope_instruction", "Escopo desta validação"),
        ("evolution_qa_instruction", "Escopo da validação nesta evolução"),
        ("spec_scope_instruction", "Contra o que medir a entrega"),
    ],
)
def test_regra_de_escopo_chega_ao_prompt(campo, titulo):
    """Antes: preenchidos pelo runner e NUNCA emitidos — o dado morria no montador do prompt."""
    from orchestrator.agents.runtime import build_user_message

    texto = "REGRA QUE PRECISA CHEGAR AO AGENTE"
    prompt = build_user_message({"task": "t", "inputs": {campo: texto}}, role="QA")
    assert f"## {titulo}" in prompt
    assert texto in prompt


def test_campo_de_escopo_vazio_nao_polui_o_prompt():
    from orchestrator.agents.runtime import build_user_message

    prompt = build_user_message({"task": "t", "inputs": {"task_scope_instruction": "   "}}, role="QA")
    assert "Escopo desta validação" not in prompt


def test_qa_recebe_a_regra_de_escopo_da_task_que_o_runner_sempre_quis_mandar(envelope, ctx):
    """Fecha o laço 54c pela ponta de cima: o runner preenche, e agora o prompt emite."""
    from orchestrator.agents.runtime import build_user_message

    runner.call_qa(
        "s", "c", "b", "d", "r", task_id="T1", task="v",
        task_delivered_files=[{"path": "apps/api/x.ts", "content": "code"}],
    )
    assert "task_scope_instruction" in envelope, "o runner sempre preencheu este campo"
    prompt = build_user_message({"task": "t", "inputs": dict(envelope)}, role="QA")
    assert envelope["task_scope_instruction"][:40] in prompt
