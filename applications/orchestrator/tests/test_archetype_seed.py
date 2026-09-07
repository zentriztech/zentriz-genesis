"""
archetype_seed — os arquétipos da Bancada (GAP-69→75) chegando à FÁBRICA via CAG.

Estes testes NÃO tocam banco: congelam o catálogo, as chaves de cache e o formato do payload
que o `context_loader` sabe renderizar (`payload.systemPromptPrefix` para `category='package'`,
`payload.bugChecklists` para `category='checklist'`).

Por que importa: o veículo tem de ser determinístico. `lessons_corpus` ordena por
`hit_count * confidence`, então lição nova entra no fim da fila e pode nunca aparecer no prompt.
"""
import json


def test_catalogo_cobre_os_sete_arquetipos_medidos():
    from orchestrator.archetype_seed import ARCHETYPES
    slugs = [a["slug"] for a in ARCHETYPES]
    assert len(slugs) == len(set(slugs)), "slug é identidade — não pode repetir"
    for gap in ("gap69", "gap70", "gap71", "gap72", "gap73", "gap74", "gap75"):
        assert any(gap in s for s in slugs), f"{gap} não foi ensinado à fábrica"
    for a in ARCHETYPES:
        assert a["title"].strip() and a["rule"].strip() and a["evidence"].strip()
        assert len(a["rule"]) <= 400, "regra é uma linha de checklist, não um ensaio"


def test_uma_linha_package_e_uma_checklist_por_papel():
    from orchestrator.archetype_seed import ROLES, rows_to_seed
    rows = rows_to_seed()
    assert len(rows) == 2 * len(ROLES)
    keys = [r[0] for r in rows]
    assert len(keys) == len(set(keys)), "cache_key colidindo sobrescreveria outro papel"
    for role in ROLES:
        assert role == role.lower(), "o loader recebe o papel em minúsculas"
        assert f"cag:{role}:generic:archetypes-context" in keys
        assert f"cag:{role}:generic:archetypes-checklist" in keys
    for _key, _role, category, _payload in rows:
        assert category in ("package", "checklist")


def test_payload_package_tem_o_prefixo_que_o_loader_renderiza():
    from orchestrator.archetype_seed import rows_to_seed
    pkg = {r[1]: r[3] for r in rows_to_seed() if r[2] == "package"}
    prefix = pkg["dev"]["systemPromptPrefix"]
    assert "Arquétipos de contexto" in prefix
    assert "CORTE DE CONTEXTO" in prefix, "o Dev tem de reconhecer a marca que vai receber"
    assert "NÃO ENTREGUE" in prefix
    assert "mentir sobre o corte não" in prefix
    assert pkg["dev"]["stackKey"] == "generic", "o defeito é de contexto, não de linguagem"
    assert pkg["dev"]["mode"] == "live"


def test_payload_checklist_tem_bugchecklists_em_uma_linha():
    from orchestrator.archetype_seed import ARCHETYPES, rows_to_seed
    chk = {r[1]: r[3] for r in rows_to_seed() if r[2] == "checklist"}
    items = chk["qa"]["bugChecklists"]
    assert len(items) == len(ARCHETYPES)
    for item in items:
        assert set(item) == {"slug", "title", "rule"}
        assert "\n" not in item["rule"], "bullet de checklist é uma linha"


def test_cada_papel_recebe_o_recorte_do_seu_proprio_defeito():
    """Mesmo arquétipo, forma diferente: o Dev vê a marca de corte, o QA vê o veredito."""
    from orchestrator.archetype_seed import ROLES, rows_to_seed
    pkg = {r[1]: r[3]["systemPromptPrefix"] for r in rows_to_seed() if r[2] == "package"}
    assert set(pkg) == set(ROLES), "nenhum papel pode ficar sem o pacote"
    assert "dependency_code" in pkg["dev"]
    assert "spec" in pkg["cto"].lower()
    assert "depends_on_files" in pkg["pm"], "o PM é quem CITA o arquivo irmão (GAP-75)"
    assert "reescrita integral" in pkg["qa"]
    assert pkg["dev"] != pkg["qa"]


def test_payload_serializa_em_json_utf8_com_acentos_reais():
    from orchestrator.archetype_seed import rows_to_seed
    for _key, _role, _cat, payload in rows_to_seed():
        blob = json.dumps(payload, ensure_ascii=False)
        assert "\\u" not in blob, "acento vai literal no jsonb, não escapado"
        assert json.loads(blob) == payload


def test_estimativa_de_tokens_e_positiva_e_proporcional():
    from orchestrator.archetype_seed import _estimate_tokens, rows_to_seed
    rows = rows_to_seed()
    pkg = next(r[3] for r in rows if r[2] == "package")
    chk = next(r[3] for r in rows if r[2] == "checklist")
    assert _estimate_tokens(pkg) > 0 and _estimate_tokens(chk) > 0
    assert _estimate_tokens(pkg) < 4_000, "prefixo de system prompt tem de ser enxuto"


def test_rows_to_seed_e_deterministico():
    """Idempotência começa aqui: mesma entrada, mesmas chaves e mesmo payload."""
    from orchestrator.archetype_seed import rows_to_seed
    a = rows_to_seed()
    b = rows_to_seed()
    assert [r[0] for r in a] == [r[0] for r in b]
    assert json.dumps(a[0][3], sort_keys=True) == json.dumps(b[0][3], sort_keys=True)
