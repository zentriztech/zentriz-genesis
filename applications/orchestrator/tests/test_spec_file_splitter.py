"""F2/PR-3 (2026-09-05) — divisão AGÊNTICA da spec em arquivos.

A divisão é uma cadeia de agentes (arquiteto + N redatores), nunca um algoritmo de corte: a lei do
Jean é que estrutura, nomes e conteúdo são decisão de LLM. O que se testa aqui é o TRANSPORTE (recorte
por seção, cobertura, tetos) e as recusas — nada que julgue o agrupamento escolhido pelo agente.
"""
import json

import pytest

from orchestrator.spec_file_splitter import (
    SPEC_SPLIT_MAX_FILES,
    SpecSplitError,
    _BEGIN,
    _END,
    _norm_title,
    build_plan_prompt,
    build_writer_prompt,
    extract_writer_content,
    split_markdown_sections,
    split_spec_into_files,
)

SPEC = """# NVX LastMile

Versão 3 — documento de produto.

## 1. Visão do produto
Roteirização de última milha.

## 2. Requisitos Funcionais
- FR-01: importar pedidos.
- FR-02: otimizar rota.

## 3. Modelo de dados
Tabela `orders`, tabela `routes`.

## 4. Contratos
`POST /orders`.

## 5. Decisões em Aberto
- Qual provedor de mapa?
"""

PLAN = {
    "rationale": "Separei leitura de negócio de material técnico.",
    "indexPurpose": "Porta de entrada com a tabela de arquivos.",
    "files": [
        {"name": "objetivo-escopo.md", "title": "Objetivo", "purpose": "Visão.",
         "sections": ["1. Visão do produto"]},
        {"name": "requisitos.md", "title": "Requisitos", "purpose": "FRs.",
         "sections": ["2. Requisitos Funcionais", "5. Decisões em Aberto"]},
        {"name": "tecnico/dados-e-contratos.md", "title": "Dados e contratos", "purpose": "Modelo + API.",
         "sections": ["3. Modelo de dados", "4. Contratos"]},
    ],
}


def _llm(plan: dict = None, content: str = None, *, calls: list = None):
    """LLM falso. Distingue arquiteto de redator pelo SYSTEM prompt (não pela ordem da chamada:
    o arquiteto pode ser chamado 2× quando o plano deixa seção órfã)."""
    plan = plan if plan is not None else PLAN

    def fn(system: str, user: str, model_id: str) -> str:
        if calls is not None:
            calls.append({"system": system, "user": user, "model": model_id})
        if "PASSO 1 do divisor" in system:
            return json.dumps(plan, ensure_ascii=False)
        body = content or ("# Arquivo\n\n" + "conteúdo suficientemente longo para passar do piso de tamanho. " * 4)
        return json.dumps({"content": body}, ensure_ascii=False)

    return fn


# ── Transporte: recorte por seção ─────────────────────────────────────────────────────────────────

def test_split_sections_separates_preamble_and_level_two_headings():
    preamble, sections = split_markdown_sections(SPEC)
    assert preamble.startswith("# NVX LastMile")
    assert "Versão 3" in preamble
    assert [s["title"] for s in sections] == [
        "1. Visão do produto", "2. Requisitos Funcionais", "3. Modelo de dados",
        "4. Contratos", "5. Decisões em Aberto",
    ]
    assert sections[2]["body"].startswith("## 3. Modelo de dados")
    assert "tabela `routes`" in sections[2]["body"]


def test_headings_inside_code_fences_are_not_sections():
    """Um exemplo de Markdown embutido não pode inventar seção fantasma."""
    md = "# T\n\n## 1. Uma\ntexto\n\n```md\n## Isto é exemplo\n```\n\n## 2. Duas\nfim\n"
    _, sections = split_markdown_sections(md)
    assert [s["title"] for s in sections] == ["1. Uma", "2. Duas"]
    assert "## Isto é exemplo" in sections[0]["body"]


def test_norm_title_tolerates_numbering_accent_and_hashes():
    assert _norm_title("## 3. Modelo de Dados") == _norm_title("Modelo de dados")
    assert _norm_title("5) Decisões em Aberto") == _norm_title("decisoes em aberto")
    assert _norm_title("Contratos") != _norm_title("Contratos externos")


# ── Caminho felizes ───────────────────────────────────────────────────────────────────────────────

def test_split_produces_index_plus_files_and_full_coverage():
    out = split_spec_into_files(SPEC, llm_fn=_llm(), project_name="NVX LastMile")
    assert set(out["files"]) == {"objetivo-escopo.md", "requisitos.md", "tecnico/dados-e-contratos.md"}
    assert out["index"].startswith("#")
    assert out["needs_human"] is True
    assert [c["section"] for c in out["coverage"]] == [
        "1. Visão do produto", "2. Requisitos Funcionais", "3. Modelo de dados",
        "4. Contratos", "5. Decisões em Aberto",
    ]
    assert all(c["targets"] for c in out["coverage"]), "toda seção tem destino"
    assert out["coverage"][4]["targets"] == ["requisitos.md"]
    assert out["sourceChars"] == len(SPEC)
    assert "_matched" not in out["plan"]["files"][0], "detalhe interno não vaza para a api/UI"


def test_writer_receives_only_its_own_sections_not_the_whole_spec():
    """Adversarial A1.1 — mandar a spec inteira para cada redator multiplicaria o custo por N."""
    calls: list = []
    split_spec_into_files(SPEC, llm_fn=_llm(calls=calls), project_name="NVX")
    plan_call = next(c for c in calls if "PASSO 1 do divisor" in c["system"])
    writer_calls = [c for c in calls if "PASSO 2 do divisor" in c["system"]]
    assert "Roteirização de última milha" in plan_call["user"], "o arquiteto lê a spec inteira"
    dados = next(c for c in writer_calls if "# SEU ARQUIVO: `tecnico/dados-e-contratos.md`" in c["user"])
    assert "Tabela `orders`" in dados["user"] and "POST /orders" in dados["user"]
    assert "FR-01: importar pedidos" not in dados["user"], "material de outro arquivo não viaja"


def test_index_writer_gets_the_plan_and_the_preamble():
    preamble, sections = split_markdown_sections(SPEC)
    from orchestrator.spec_file_splitter import _validate_plan
    plan = _validate_plan(json.loads(json.dumps(PLAN)), sections, [])
    msg = build_writer_prompt(plan, None, preamble, "NVX LastMile")
    assert "ÍNDICE" in msg and "Versão 3" in msg
    assert "requisitos.md" in msg
    assert "FR-01" not in msg, "o índice não recebe o corpo das seções (ele aponta, não repete)"


# ── Recusas (integridade, não julgamento) ─────────────────────────────────────────────────────────

def test_uncovered_section_is_fed_back_to_the_architect_then_vetoed():
    """Seção órfã = conteúdo perdido. 1ª tentativa vira feedback ao agente; a 2ª veta."""
    bad = {"files": [dict(PLAN["files"][0])]}  # só cobre a seção 1
    prompts: list = []
    with pytest.raises(SpecSplitError) as e:
        split_spec_into_files(SPEC, llm_fn=_llm(plan=bad, calls=prompts))
    assert e.value.code == "SPEC_SPLIT_UNCOVERED_SECTIONS"
    assert "2. Requisitos Funcionais" in str(e.value)
    assert len(e.value.details["uncovered"]) == 4
    plan_calls = [c for c in prompts if "PASSO 1 do divisor" in c["system"]]
    assert len(plan_calls) == 2, "o arquiteto é chamado de novo com o feedback"
    assert "CORREÇÃO OBRIGATÓRIA" in plan_calls[1]["user"], "a 2ª tentativa recebe as órfãs"
    assert not any("PASSO 2 do divisor" in c["system"] for c in prompts), "não gasta redator com plano ruim"


def test_spec_with_too_few_sections_is_refused_before_spending_llm():
    calls: list = []
    with pytest.raises(SpecSplitError) as e:
        split_spec_into_files("# T\n\n## Só uma\n" + "x" * 200, llm_fn=_llm(calls=calls))
    assert e.value.code == "SPEC_SPLIT_TOO_FEW_SECTIONS"
    assert calls == [], "não gasta chamada de LLM num documento que não dá para dividir"


def test_empty_source_is_refused():
    with pytest.raises(SpecSplitError) as e:
        split_spec_into_files("   ", llm_fn=_llm())
    assert e.value.code == "SPEC_SPLIT_SOURCE_EMPTY"


@pytest.mark.parametrize("name,code", [
    ("README.md", "SPEC_SPLIT_RESERVED_FILENAME"),
    ("index.md", "SPEC_SPLIT_RESERVED_FILENAME"),
    ("sub/readme.md", "SPEC_SPLIT_RESERVED_FILENAME"),
    ("../escapa.md", "SPEC_SPLIT_BAD_FILENAME"),
    ("/absoluto.md", "SPEC_SPLIT_BAD_FILENAME"),
    ("com espaço.md", "SPEC_SPLIT_BAD_FILENAME"),
    ("sem-extensao", "SPEC_SPLIT_BAD_FILENAME"),
    ("a/b/c/fundo.md", "SPEC_SPLIT_BAD_FILENAME"),
])
def test_bad_filenames_in_the_plan_are_refused(name, code):
    plan = {"files": [{**PLAN["files"][0], "name": name}, *PLAN["files"][1:]]}
    with pytest.raises(SpecSplitError) as e:
        split_spec_into_files(SPEC, llm_fn=_llm(plan=plan))
    assert e.value.code == code


def test_uppercase_filename_is_normalized_not_refused():
    """Caixa é forma, não decisão: normalizar é transporte. O agente não é reprovado por isso."""
    plan = {"files": [{**PLAN["files"][0], "name": "Objetivo-Escopo.MD"}, *PLAN["files"][1:]]}
    out = split_spec_into_files(SPEC, llm_fn=_llm(plan=plan))
    assert "objetivo-escopo.md" in out["files"]


def test_duplicate_filename_is_refused():
    plan = {"files": [PLAN["files"][0], {**PLAN["files"][1], "name": "objetivo-escopo.md"}]}
    with pytest.raises(SpecSplitError) as e:
        split_spec_into_files(SPEC, llm_fn=_llm(plan=plan))
    assert e.value.code == "SPEC_SPLIT_DUPLICATE_FILENAME"


def test_file_without_any_real_section_is_refused():
    plan = {"files": [*PLAN["files"], {"name": "fantasma.md", "title": "x", "purpose": "y",
                                       "sections": ["Seção que não existe"]}]}
    with pytest.raises(SpecSplitError) as e:
        split_spec_into_files(SPEC, llm_fn=_llm(plan=plan))
    assert e.value.code == "SPEC_SPLIT_FILE_WITHOUT_SECTIONS"


def test_too_many_files_is_refused():
    files = [{"name": f"a{i}.md", "title": "t", "purpose": "p", "sections": ["1. Visão do produto"]}
             for i in range(SPEC_SPLIT_MAX_FILES + 1)]
    with pytest.raises(SpecSplitError) as e:
        split_spec_into_files(SPEC, llm_fn=_llm(plan={"files": files}))
    assert e.value.code == "SPEC_SPLIT_TOO_MANY_FILES"


def test_trivial_file_content_is_refused_after_retry():
    with pytest.raises(SpecSplitError) as e:
        split_spec_into_files(SPEC, llm_fn=_llm(content="curto"))
    assert e.value.code == "SPEC_SPLIT_EMPTY_FILE"


def test_shrink_below_half_produces_a_visible_warning_not_a_veto():
    """Encolher é sinal de redator que resumiu — mas cortar a proposta seria o código julgando
    conteúdo. Vira aviso ao humano (que aprova arquivo por arquivo)."""
    gorda = SPEC.replace("Roteirização de última milha.", "Roteirização de última milha. " * 400)
    out = split_spec_into_files(gorda, llm_fn=_llm(content="# A\n\n" + "curto mas acima do piso. " * 4))
    assert any("<50%" in w for w in out["warnings"])
    assert out["producedChars"] < out["sourceChars"] * 0.5


def test_section_cited_but_absent_only_warns():
    plan = {"files": [PLAN["files"][0],
                      {**PLAN["files"][1], "sections": [*PLAN["files"][1]["sections"], "Seção inexistente"]},
                      PLAN["files"][2]]}
    out = split_spec_into_files(SPEC, llm_fn=_llm(plan=plan))
    assert any("Seção inexistente" in w for w in out["warnings"])
    assert set(out["files"]) == {"objetivo-escopo.md", "requisitos.md", "tecnico/dados-e-contratos.md"}


def test_plan_prompt_announces_the_limits_and_the_index_numbering():
    _, sections = split_markdown_sections(SPEC)
    msg = build_plan_prompt(SPEC, sections, "NVX", "backend_node")
    assert f"Máximo de {SPEC_SPLIT_MAX_FILES} arquivos" in msg
    assert "1. 1. Visão do produto" in msg  # índice numerado pela fábrica
    assert "readme.md" in msg  # nomes reservados anunciados ao agente


# ── Envelope do redator: Markdown CRU entre marcadores (Onda 5, prod 2026-09-06) ───────────────────
#
# Duas propostas ao vivo morreram porque o redator tinha de embrulhar 30 kB de Markdown numa string
# JSON: `connect.md` emitiu uma aspa sem escape e `Expecting ',' delimiter: line 1 column 29574`
# levou consigo as 17 chamadas de Opus 5 já pagas. Marcador não tem escape para errar.

def test_marcadores_devolvem_o_markdown_literal_com_aspas_cercas_e_barras():
    """O caso EXATO que quebrava: conteúdo que, em JSON, exigiria escape em todo caractere hostil."""
    hostil = (
        '# Connect\n\nO campo `"eventType"` é obrigatório e o separador é `\\`.\n\n'
        '```json\n{"a": "b\\"c"}\n```\n\n## Fim\n' + "texto suficientemente longo. " * 4
    )
    assert extract_writer_content(f"{_BEGIN}\n{hostil}\n{_END}") == hostil.strip()


def test_marcadores_ignoram_prosa_antes_e_depois():
    corpo = "# A\n\ncorpo do arquivo com tamanho de sobra. " * 3
    raw = f"Claro, segue o arquivo:\n{_BEGIN}\n{corpo}\n{_END}\nPosso ajustar se quiser."
    assert extract_writer_content(raw) == corpo.strip()


def test_marcador_de_fim_ecoado_no_texto_nao_perde_conteudo():
    """Se o modelo citar o próprio marcador, o ÚLTIMO é o que fecha — nada é cortado."""
    corpo = f"# A\n\nresponda entre {_END} quando terminar.\n\n## Fim\n"
    assert extract_writer_content(f"{_BEGIN}\n{corpo}\n{_END}").endswith("## Fim")
    assert _END in extract_writer_content(f"{_BEGIN}\n{corpo}\n{_END}")


def test_json_antigo_continua_aceito_como_fallback():
    """Compatibilidade: prompt/versão em voo que ainda responda `{content}` não quebra."""
    corpo = "# A\n\nconteúdo do contrato antigo, longo o bastante. " * 3
    assert extract_writer_content(json.dumps({"content": corpo}, ensure_ascii=False)) == corpo.strip()


def test_resposta_sem_marcador_e_sem_content_falha_com_codigo_estavel():
    with pytest.raises(Exception) as e:
        extract_writer_content("desculpe, não consegui escrever este arquivo")
    assert getattr(e.value, "code", "") in ("PROPOSAL_INVALID_JSON", "SPEC_SPLIT_WRITER_FAILED")


def test_writer_prompt_pede_marcador_e_nao_pede_mais_json():
    from orchestrator.spec_file_splitter import _validate_plan
    _, sections = split_markdown_sections(SPEC)
    plan = _validate_plan(json.loads(json.dumps(PLAN)), sections, [])
    msg = build_writer_prompt(plan, plan["files"][0], "preâmbulo", "NVX")
    assert _BEGIN in msg and _END in msg
    assert "SOMENTE o JSON" not in msg
    idx = build_writer_prompt(plan, None, "preâmbulo", "NVX")
    assert _BEGIN in idx and "SOMENTE o JSON" not in idx


def test_pipeline_completo_com_redator_usando_marcadores():
    """Ponta a ponta com o envelope novo — inclusive uma cerca de código dentro do conteúdo."""
    corpo = "# Arquivo\n\n```sql\nSELECT 1;\n```\n\n" + "conteúdo acima do piso de tamanho. " * 4

    def fn(system: str, user: str, model_id: str) -> str:
        if "PASSO 1 do divisor" in system:
            return json.dumps(PLAN, ensure_ascii=False)
        return f"{_BEGIN}\n{corpo}\n{_END}"

    out = split_spec_into_files(SPEC, llm_fn=fn, project_name="NVX")
    assert set(out["files"]) == {"objetivo-escopo.md", "requisitos.md", "tecnico/dados-e-contratos.md"}
    assert all("```sql" in c for c in out["files"].values())
    assert out["index"].startswith("# Arquivo")
