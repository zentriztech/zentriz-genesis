"""
test_google_vertex_slot.py — provider `google` (Vertex AI / Gemini), 2026-09-10.

Jean: "vamos receber créditos do Google e poderemos usar em modelos que o Google paga via
crédito, então o slot deve ser de provider Google para os modelos da família que ele subsidia".

O crédito do Google cobre o **Vertex AI**, cujo Model Garden revende Claude/Llama/Mistral além
do Gemini nativo. Os testes abaixo guardam as três decisões que fazem esse slot funcionar:

1. a chave da Gemini API NÃO serve para modelo do Model Garden (a Gemini API só serve Gemini) —
   com os dois modos configurados, o Vertex vence para esses ids;
2. as credenciais do Vertex ATRAVESSAM runner_server → env → envelope → agentes; se pararem no
   meio, o slot resolve, a tela diz "ok" e o run cai sem auth;
3. a identidade do deny-cache separa credenciais Google distintas, sem a chave em claro.

Fora de alcance aqui: `_infer_provider_from_model` e `_is_compatible` são funções ANINHADAS
(dentro de `run_agent` e do handler do runner_server) — não dá para importá-las sem refatorar.
A inferência de id do Model Garden (`nome@versão`, `meta/…`, `…-maas` ⇒ google) fica coberta
apenas pelo mapa da tela e pela allow-list da API, testados no lado Node.
"""
import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from orchestrator.agents import runtime  # noqa: E402


# ── 1. Escolha da base: Gemini API × Vertex ──────────────────────────────────────

def test_chave_gemini_com_modelo_gemini_usa_a_gemini_api(monkeypatch):
    monkeypatch.delenv("GOOGLE_BASE_URL", raising=False)
    key, base = runtime._build_google_client({"google_api_key": "AIza-x"}, "gemini-2.5-pro")
    assert key == "AIza-x"
    assert base == runtime._GEMINI_OPENAI_BASE


def test_chave_gemini_com_modelo_do_model_garden_falha_com_mensagem_acionavel(monkeypatch):
    """A Gemini API não serve Llama/Mistral. Sem projeto GCP, falhar AQUI é melhor que 404 no run."""
    monkeypatch.delenv("GOOGLE_VERTEX_PROJECT", raising=False)
    with pytest.raises(ValueError) as e:
        runtime._build_google_client({"google_api_key": "AIza-x"}, "meta/llama-3.3-70b-instruct-maas")
    assert "Vertex" in str(e.value)


def test_base_url_explicita_sobrepoe_a_calculada(monkeypatch):
    monkeypatch.delenv("GOOGLE_BASE_URL", raising=False)
    _, base = runtime._build_google_client(
        {"google_api_key": "AIza-x", "google_base_url": "https://proxy.interno/v1"}, "gemini-2.5-pro")
    assert base == "https://proxy.interno/v1/"


def test_projeto_e_regiao_do_vertex_vem_do_slot_com_default_de_regiao(monkeypatch):
    monkeypatch.delenv("GOOGLE_VERTEX_PROJECT", raising=False)
    monkeypatch.delenv("GOOGLE_VERTEX_LOCATION", raising=False)
    assert runtime._vertex_project_location({"vertex_project_id": "p1"}) == ("p1", "us-east5")
    assert runtime._vertex_project_location({"vertex_project_id": "p1", "vertex_location": "europe-west4"}) \
        == ("p1", "europe-west4")
    with pytest.raises(ValueError):
        runtime._vertex_project_location({})


def test_base_openai_compat_do_vertex_aponta_para_a_regiao():
    base = runtime._vertex_openai_base("meu-projeto", "us-east5")
    assert base.startswith("https://us-east5-aiplatform.googleapis.com/")
    assert "/projects/meu-projeto/locations/us-east5/endpoints/openapi" in base


def test_limites_dos_modelos_gemini_declarados():
    """Sem entrada no mapa o agente cai no default e desperdiça a janela de 1M do Gemini."""
    for m in ("gemini-2.5-pro", "gemini-3-pro"):
        assert m in runtime._OPENAI_MODEL_LIMITS
        assert runtime._OPENAI_MODEL_LIMITS[m]["context"] >= 1_000_000


# ── 2. As credenciais atravessam o envelope ─────────────────────────────────────

def _envelope(monkeypatch, **env):
    from orchestrator.runner import _build_message_envelope
    for k in ("GENESIS_LLM_PROVIDER", "GOOGLE_API_KEY", "GOOGLE_BASE_URL",
              "GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION", "GOOGLE_SERVICE_ACCOUNT_JSON"):
        monkeypatch.delenv(k, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    e = _build_message_envelope("req-g", "Dev", "backend", "implement_task",
                                task_id="t1", task="X", inputs={}, existing_artifacts=[], limits={})
    return e.get("llm_config") or {}


def test_envelope_sob_google_carrega_a_chave_da_gemini_api(monkeypatch):
    cfg = _envelope(monkeypatch, GENESIS_LLM_PROVIDER="google", GOOGLE_API_KEY="AIza-x")
    assert cfg.get("provider") == "google"
    assert cfg.get("google_api_key") == "AIza-x"


def test_envelope_sob_google_carrega_projeto_regiao_e_service_account(monkeypatch):
    sa = '{"type":"service_account","project_id":"p"}'
    cfg = _envelope(monkeypatch, GENESIS_LLM_PROVIDER="google",
                    GOOGLE_VERTEX_PROJECT="meu-projeto", GOOGLE_VERTEX_LOCATION="us-east5",
                    GOOGLE_SERVICE_ACCOUNT_JSON=sa)
    assert cfg.get("vertex_project_id") == "meu-projeto"
    assert cfg.get("vertex_location") == "us-east5"
    assert cfg.get("vertex_service_account_json") == sa


def test_envelope_sob_google_nao_vaza_credencial_de_outro_provider(monkeypatch):
    cfg = _envelope(monkeypatch, GENESIS_LLM_PROVIDER="google", GOOGLE_API_KEY="AIza-x",
                    CLAUDE_API_KEY="sk-ant-nao-deve-vazar")
    assert "api_key" not in cfg
    assert "sk-ant-nao-deve-vazar" not in str(cfg)


# ── 3. Identidade do modelo (deny-cache) separa Google dos demais ───────────────

def test_escopo_de_identidade_distingue_credencial_google():
    a = runtime.model_identity_scope({"provider": "google", "google_api_key": "AIza-a"})
    b = runtime.model_identity_scope({"provider": "google", "google_api_key": "AIza-b"})
    c = runtime.model_identity_scope({"provider": "google", "vertex_project_id": "outro-projeto"})
    assert a.startswith("google:") and b.startswith("google:") and c.startswith("google:")
    assert len({a, b, c}) == 3, "identidades distintas não podem compartilhar o cache de negativa"
    assert "AIza-a" not in a, "a credencial em claro NUNCA entra no escopo"


# ── 4. Diversidade de providers por TENANT (Jean, 2026-09-10) ───────────────────
# "não se trata só da ZFactory — qualquer tenant precisa poder usar uma diversidade de
# providers, inclusive conexão direta via API, e isso tem de refletir nos agentes da
# Fábrica e da Bancada." `resolve_provider` é o único ponto onde essa escolha sobrevive.

def test_tenant_com_credencial_propria_nao_e_sequestrado_pelo_env():
    for prov, cred in (("openai", {"api_key": "sk-x"}),
                       ("anthropic", {"api_key": "sk-ant-x"}),
                       ("bedrock", {"aws_access_key_id": "AKIA_T"}),
                       ("google", {"google_api_key": "AIza-x"}),
                       ("google", {"vertex_project_id": "p"})):
        cfg = {"provider": prov, **cred}
        assert runtime.resolve_provider(cfg, "foundry") == prov, f"{prov} com BYOC deve ser respeitado"


def test_provider_de_outra_familia_e_respeitado_mesmo_sem_credencial_propria():
    """openai/google/azure_openai nunca foram o default legado ⇒ escolher é sempre deliberado."""
    assert runtime.resolve_provider({"provider": "google"}, "foundry") == "google"
    assert runtime.resolve_provider({"provider": "openai"}, "foundry") == "openai"
    assert runtime.resolve_provider({"provider": "azure_openai"}, "foundry") == "azure_openai"


def test_slot_claude_legado_sem_credencial_cai_para_a_infraestrutura():
    """Config antiga (anterior ao Foundry) diz `bedrock`/`anthropic` sem chave: é default, não escolha."""
    assert runtime.resolve_provider({"provider": "bedrock"}, "foundry") == "foundry"
    assert runtime.resolve_provider({"provider": "anthropic"}, "foundry") == "foundry"


def test_sem_provider_no_envelope_vale_o_env():
    assert runtime.resolve_provider({}, "foundry") == "foundry"
    assert runtime.resolve_provider(None, "bedrock") == "bedrock"


def test_fora_do_foundry_a_escolha_do_tenant_sempre_vale():
    assert runtime.resolve_provider({"provider": "bedrock"}, "anthropic") == "bedrock"
    assert runtime.resolve_provider({"provider": "google"}, "bedrock") == "google"


# ── 5. Azure OpenAI — o slot existia na tela e NÃO tinha caminho de cliente ─────
# Mesmo defeito do slot Foundry (corrigido em 2026-09-09): o dispatch caía no ramo Anthropic
# e a chamada ia para a API pública da Anthropic. Agora endpoint/deployment/api-version do
# SLOT do tenant endereçam a chamada.

def test_azure_openai_exige_endpoint_e_chave_com_mensagem_acionavel(monkeypatch):
    monkeypatch.delenv("AZURE_OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("AZURE_OPENAI_ENDPOINT", raising=False)
    monkeypatch.delenv("CLAUDE_API_KEY", raising=False)
    with pytest.raises(ValueError) as e:
        runtime._build_azure_openai_client({"api_key": "k"})       # sem endpoint
    assert "Endpoint" in str(e.value)


def test_azure_openai_endereca_a_chamada_pelo_deployment_do_slot(monkeypatch):
    monkeypatch.delenv("AZURE_OPENAI_DEPLOYMENT", raising=False)
    assert runtime._azure_deployment({"azure_deployment": "meu-gpt4o"}, "gpt-4o") == "meu-gpt4o"
    # sem deployment declarado, o nome do modelo é o melhor palpite (convenção do Azure)
    assert runtime._azure_deployment({}, "gpt-4o") == "gpt-4o"


def test_envelope_sob_azure_openai_carrega_endpoint_deployment_e_versao(monkeypatch):
    for k in ("AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT",
              "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_API_VERSION"):
        monkeypatch.delenv(k, raising=False)
    cfg = _envelope(monkeypatch, GENESIS_LLM_PROVIDER="azure_openai",
                    AZURE_OPENAI_API_KEY="k", AZURE_OPENAI_ENDPOINT="https://x.openai.azure.com",
                    AZURE_OPENAI_DEPLOYMENT="meu-gpt4o", AZURE_OPENAI_API_VERSION="2024-02-01")
    assert cfg["api_key"] == "k"
    assert cfg["azure_endpoint"] == "https://x.openai.azure.com"
    assert cfg["azure_deployment"] == "meu-gpt4o"
    assert cfg["azure_api_version"] == "2024-02-01"
