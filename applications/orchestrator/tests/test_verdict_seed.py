"""
verdict_seed — a honestidade de veredicto medida na Bancada chegando à FÁBRICA via CAG.

Estes testes NÃO tocam banco: congelam o catálogo, as chaves de cache e o formato do payload
que o `context_loader` sabe renderizar (`payload.systemPromptPrefix` para `category='package'`,
`payload.bugChecklists` para `category='checklist'`).

Duas garantias que valem mais que as outras:

* **Não colidir com `archetype_seed`.** O loader ACUMULA linhas de `context_cache`
  (`prefix_chunks` concatenado, `bug_checklists` estendido), então este pacote SOMA ao dos
  arquétipos de contexto. Se as chaves colidissem, ensinar veredicto APAGARIA o ensino de
  contexto — trocar uma lição por outra pareceria progresso.
* **O vocabulário é o mesmo do Connect.** `noOpinion.reason` do contrato
  `learning/review-verdict-record` v1.4.0 e as causas ensinadas aqui têm de coincidir; três
  taxonomias diferentes atravessando Bancada, Fábrica e Auto Care tornam o relatório
  incomparável, e comparabilidade é o que faz o laço fechar.
"""
import json
from pathlib import Path


def test_catalogo_cobre_os_nove_arquetipos_de_veredicto():
    from orchestrator.verdict_seed import VERDICT_ARCHETYPES
    slugs = [a["slug"] for a in VERDICT_ARCHETYPES]
    assert len(slugs) == len(set(slugs)), "slug é identidade — não pode repetir"
    assert len(slugs) == 13
    for a in VERDICT_ARCHETYPES:
        assert a["title"].strip() and a["rule"].strip() and a["evidence"].strip()
        assert len(a["rule"]) <= 400, "regra é uma linha de checklist, não um ensaio"


def test_todo_defeito_medido_citado_como_evidencia_tambem_tem_regra():
    """A lacuna que 3 de 3 revisores cross-family apontaram: justificar com um defeito que o
    material não ensina a evitar é o mesmo vício de 'evidência que não sustenta a regra'."""
    from orchestrator.verdict_seed import VERDICT_ARCHETYPES
    regras = " ".join(a["rule"] for a in VERDICT_ARCHETYPES).lower()
    # GAP-39/49 (âncora reescrita) era citado só como evidência — agora tem regra própria.
    assert "âncora" in regras, "o defeito da âncora reescrita tem de virar REGRA, não só evidência"
    assert any("ancora-literal-e-identidade" in a["slug"] for a in VERDICT_ARCHETYPES)


def test_nenhuma_regra_instala_hierarquia_entre_revisores():
    """Contradição apontada por 2 de 3 revisores: 'o veredicto dele prevalece' é automação fixa
    disfarçada de julgamento e briga com a Lei (a decisão é do agente, justificada)."""
    from orchestrator.verdict_seed import VERDICT_ARCHETYPES
    auto = next(a for a in VERDICT_ARCHETYPES if a["slug"] == "verd.autorrevisao-ganho-zero")
    assert "prevalece por hierarquia" in auto["rule"] and "ninguém prevalece" in auto["rule"]
    assert "decisão final continua sua" in auto["rule"]


def test_nenhuma_regra_pede_introspeccao_sobre_a_propria_capacidade():
    """Inexequível apontado por 3 de 3: 'diga se você tinha como procurar' pede ao agente um
    dado que ele não tem. A âncora tem de ser o que ele RECEBEU e o vocabulário em uso."""
    from orchestrator.verdict_seed import VERDICT_ARCHETYPES
    central = next(a for a in VERDICT_ARCHETYPES if a["slug"] == "verd.gap104.nao-medido-nao-e-ausente")
    assert "tinha como procurá-lo" not in central["rule"]
    assert "RECEBEU" in central["rule"] and "tipos de defeito" in central["rule"]


def test_o_dev_entrega_antes_de_ressalvar():
    """Equilíbrio: a lição não pode virar licença para encher o summary de ressalvas."""
    from orchestrator.verdict_seed import ROLE_FOCUS
    assert "Ressalva não substitui entrega" in ROLE_FOCUS["dev"]


def test_toda_evidencia_tem_origem_verificavel():
    """A lição é MEDIDA ou CITADA — nunca 'é sabido que'. Sem origem, é opinião com selo."""
    from orchestrator.verdict_seed import VERDICT_ARCHETYPES
    marcadores = ("Bancada", "arXiv", "migration", "gold set", "produção")
    for a in VERDICT_ARCHETYPES:
        assert any(m in a["evidence"] for m in marcadores), (
            f"{a['slug']}: evidência sem origem rastreável — {a['evidence'][:60]!r}"
        )


def test_a_licao_central_aparece_com_o_numero_medido():
    """0% em 5 de 5: é o achado mais estável da medição e o motivo do módulo existir."""
    from orchestrator.verdict_seed import VERDICT_ARCHETYPES, rows_to_seed
    central = next(a for a in VERDICT_ARCHETYPES if "nao-medido-nao-e-ausente" in a["slug"])
    assert "0%" in central["evidence"] and "5 de 5" in central["evidence"]
    for _key, _role, category, payload in rows_to_seed():
        if category == "package":
            prefix = payload["systemPromptPrefix"]
            assert "não sei procurar" in prefix
            assert "0% em 5 de 5" in prefix
            assert "chamar não-saber de ausência não é" in prefix


def test_uma_linha_package_e_uma_checklist_por_papel():
    from orchestrator.verdict_seed import ROLES, rows_to_seed
    rows = rows_to_seed()
    assert len(rows) == 2 * len(ROLES)
    keys = [r[0] for r in rows]
    assert len(keys) == len(set(keys)), "cache_key colidindo sobrescreveria outro papel"
    for role in ROLES:
        assert role == role.lower(), "o loader recebe o papel em minúsculas"
        assert f"cag:{role}:generic:verdicts-context" in keys
        assert f"cag:{role}:generic:verdicts-checklist" in keys
    for _key, _role, category, _payload in rows:
        assert category in ("package", "checklist")


def test_nao_colide_com_as_chaves_do_archetype_seed():
    """Se colidisse, ensinar veredicto APAGARIA o ensino de contexto (ON CONFLICT DO UPDATE)."""
    from orchestrator.archetype_seed import rows_to_seed as archetype_rows
    from orchestrator.verdict_seed import rows_to_seed as verdict_rows
    a = {r[0] for r in archetype_rows()}
    v = {r[0] for r in verdict_rows()}
    assert not (a & v), f"chaves colidindo: {sorted(a & v)}"
    # E os dois pacotes cobrem os MESMOS papéis — nenhum agente aprende metade.
    assert {r[1] for r in archetype_rows()} == {r[1] for r in verdict_rows()}


def test_vocabulario_de_nao_opiniao_bate_com_o_contrato_do_connect():
    """Mesmo enum dos dois lados; se o Connect não estiver ao lado, o teste diz isso."""
    from orchestrator.verdict_seed import NO_OPINION_REASONS
    schema_path = (
        Path(__file__).resolve().parents[3].parent
        / "zentriz-connect"
        / "contract-kit"
        / "schemas"
        / "learning"
        / "review-verdict-record.schema.json"
    )
    if not schema_path.exists():  # pragma: no cover - checkout sem o repo do Connect ao lado
        import pytest
        pytest.skip(f"zentriz-connect não está ao lado ({schema_path}); comparação pulada")
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    enum = schema["properties"]["noOpinion"]["properties"]["reason"]["enum"]
    # O contrato tem "outro" como escape; a fábrica não recebe esse escape de propósito —
    # "outro" sem texto é o silêncio sem causa que o arquétipo proíbe.
    assert set(NO_OPINION_REASONS) == set(enum) - {"outro"}


def test_payload_package_tem_o_prefixo_que_o_loader_renderiza():
    from orchestrator.verdict_seed import NO_OPINION_REASONS, rows_to_seed
    pkg = {r[1]: r[3] for r in rows_to_seed() if r[2] == "package"}
    prefix = pkg["qa"]["systemPromptPrefix"]
    assert "Arquétipos de veredicto" in prefix
    for reason in NO_OPINION_REASONS:
        assert reason in prefix, f"a causa {reason} não chegou ao prompt"
    assert pkg["qa"]["stackKey"] == "generic", "o defeito é de afirmação, não de linguagem"
    assert pkg["qa"]["mode"] == "live"


def test_payload_checklist_tem_bugchecklists_em_uma_linha():
    from orchestrator.verdict_seed import VERDICT_ARCHETYPES, rows_to_seed
    chk = {r[1]: r[3] for r in rows_to_seed() if r[2] == "checklist"}
    items = chk["cto"]["bugChecklists"]
    assert len(items) == len(VERDICT_ARCHETYPES)
    for item in items:
        assert set(item) == {"slug", "title", "rule"}
        assert "\n" not in item["rule"], "bullet de checklist é uma linha"


def test_cada_papel_recebe_o_recorte_do_seu_proprio_veredicto():
    """Mesmo arquétipo, forma diferente: o QA vê recall, o DevOps vê digest."""
    from orchestrator.verdict_seed import ROLES, rows_to_seed
    pkg = {r[1]: r[3]["systemPromptPrefix"] for r in rows_to_seed() if r[2] == "package"}
    assert set(pkg) == set(ROLES), "nenhum papel pode ficar sem o pacote"
    assert "recall" in pkg["qa"], "o QA é o juiz — ele precisa saber o recall medido"
    assert "digest" in pkg["devops"], "healthy não prova deploy"
    assert "promoção" in pkg["cto"]
    assert "summary" in pkg["dev"]
    assert "lockfile" in pkg["engineer"]
    assert "sem tarefa" in pkg["pm"]
    assert "identidade de item" in pkg["monitor"]
    assert len({pkg[r] for r in ROLES}) == len(ROLES), "papéis com texto idêntico não foram recortados"


def test_payload_serializa_em_json_utf8_com_acentos_reais():
    from orchestrator.verdict_seed import rows_to_seed
    for _key, _role, _cat, payload in rows_to_seed():
        blob = json.dumps(payload, ensure_ascii=False)
        assert "\\u" not in blob, "acento vai literal no jsonb, não escapado"
        assert json.loads(blob) == payload


def test_estimativa_de_tokens_e_positiva_e_enxuta():
    from orchestrator.verdict_seed import _estimate_tokens, rows_to_seed
    rows = rows_to_seed()
    pkg = next(r[3] for r in rows if r[2] == "package")
    chk = next(r[3] for r in rows if r[2] == "checklist")
    assert _estimate_tokens(pkg) > 0 and _estimate_tokens(chk) > 0
    assert _estimate_tokens(pkg) < 4_000, "prefixo de system prompt tem de ser enxuto"


def test_soma_dos_dois_pacotes_cabe_no_prompt():
    """Contexto + veredicto convivem no MESMO prefixo (o loader concatena)."""
    from orchestrator.archetype_seed import _estimate_tokens as est_a
    from orchestrator.archetype_seed import rows_to_seed as archetype_rows
    from orchestrator.verdict_seed import _estimate_tokens as est_v
    from orchestrator.verdict_seed import rows_to_seed as verdict_rows
    for role in ("dev", "qa", "cto"):
        a = next(r[3] for r in archetype_rows() if r[1] == role and r[2] == "package")
        v = next(r[3] for r in verdict_rows() if r[1] == role and r[2] == "package")
        assert est_a(a) + est_v(v) < 6_000, f"{role}: os dois pacotes juntos ficaram grandes"


def test_rows_to_seed_e_deterministico():
    """Idempotência começa aqui: mesma entrada, mesmas chaves e mesmo payload."""
    from orchestrator.verdict_seed import rows_to_seed
    a = rows_to_seed()
    b = rows_to_seed()
    assert [r[0] for r in a] == [r[0] for r in b]
    assert json.dumps(a[0][3], sort_keys=True) == json.dumps(b[0][3], sort_keys=True)
