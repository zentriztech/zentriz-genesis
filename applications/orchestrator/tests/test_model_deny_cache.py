"""
Cache de negação de modelo (A4.1 — 2026-09-06).

MEDIDO EM PROD (conta 820198199720): o `.env` pede `CLAUDE_MODEL=us.anthropic.claude-opus-4-8`
(e `CLAUDE_MODEL_REWORK` idem), mas a conta só tem entitlement de `us.anthropic.claude-sonnet-4-6`.
Em 24 h o log dos agents somou 9 chamadas nascendo com um 403 "not available for this account"
antes de cair no fallback. O 403 não custa tokens — custa uma das `CLAUDE_RETRY_ATTEMPTS`: sob
throttling (429) a resiliência da rodada caía de 3 tentativas para 2.

A correção NÃO é apontar o `.env` para baixo (no dia em que o entitlement do Opus for concedido,
ninguém lembraria de voltar). É lembrar do 403 por um TTL: para de bater no que já sabemos negado
e reavalia sozinho depois, sem redeploy e sem restart.

Estes testes travam as quatro propriedades que fazem isso ser seguro:
  • o 403 de ENTITLEMENT é distinguido de erro de rede/quota (senão um timeout derrubaria o Opus);
  • a entrada VENCE (o Opus volta a ser tentado quando o acesso chegar);
  • `CLAUDE_MODEL_DENY_TTL_SEC=0` desliga tudo (escape hatch do comportamento antigo);
  • sem fallback configurado (Foundry local) o comportamento é literalmente inalterado.
"""
import pytest


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    from orchestrator.agents import runtime
    runtime._MODEL_DENIED.clear()
    monkeypatch.delenv("CLAUDE_MODEL_DENY_TTL_SEC", raising=False)
    yield
    runtime._MODEL_DENIED.clear()


OPUS = "us.anthropic.claude-opus-4-8"
SONNET = "us.anthropic.claude-sonnet-4-6"


# ── classificação do erro ─────────────────────────────────────────────────────

class _PermissionDeniedError(Exception):
    """Imita o `anthropic.PermissionDeniedError` (o teste não pode depender do SDK)."""


def test_reconhece_o_403_de_entitlement_pelas_4_assinaturas():
    from orchestrator.agents.runtime import is_model_unavailable_error
    # nome da classe do SDK (a mensagem do Bedrock varia)
    assert is_model_unavailable_error(_PermissionDeniedError("boom")) is True
    # texto real medido em prod
    assert is_model_unavailable_error(Exception(
        "The provided model identifier is invalid or not available for this account")) is True
    assert is_model_unavailable_error(Exception(
        "AccessDeniedException: User is not authorized to perform bedrock:InvokeModel")) is True
    assert is_model_unavailable_error(Exception(
        "You don't have access to the model with the specified model ID")) is True


def test_nao_confunde_rede_quota_nem_validacao_com_falta_de_entitlement():
    """Marcar o Opus como negado por um timeout tiraria o modelo bom por 30 min."""
    from orchestrator.agents.runtime import is_model_unavailable_error
    for msg in ("Read timeout on endpoint URL", "429 Too Many Requests: ThrottlingException",
                "Connection reset by peer", "ValidationException: max_tokens too large",
                "402 Payment Required", "ServiceUnavailableException"):
        assert is_model_unavailable_error(Exception(msg)) is False, msg


# ── memória do 403 ────────────────────────────────────────────────────────────

def test_primeiro_403_marca_e_as_proximas_chamadas_nascem_no_fallback():
    from orchestrator.agents.runtime import note_model_denied, is_model_denied, preferred_model
    # antes: o principal é o escolhido (o 403 ainda não aconteceu)
    assert preferred_model(OPUS, SONNET) == OPUS
    note_model_denied(OPUS)
    assert is_model_denied(OPUS) is True
    # depois: zero tentativa extra — a chamada já começa no modelo que a conta tem
    assert preferred_model(OPUS, SONNET) == SONNET


def test_a_marca_vence_e_o_opus_volta_a_ser_tentado_quando_o_acesso_chegar(monkeypatch):
    """O ponto do TTL: entitlement concedido é percebido sem redeploy nem restart."""
    from orchestrator.agents import runtime
    monkeypatch.setenv("CLAUDE_MODEL_DENY_TTL_SEC", "1800")
    fake_now = [1000.0]
    monkeypatch.setattr(runtime.time, "time", lambda: fake_now[0])
    runtime.note_model_denied(OPUS)
    fake_now[0] += 1799
    assert runtime.preferred_model(OPUS, SONNET) == SONNET
    fake_now[0] += 2  # TTL vencido
    assert runtime.preferred_model(OPUS, SONNET) == OPUS
    assert OPUS not in runtime._MODEL_DENIED, "a entrada vencida tem de ser esquecida, não relida"


def test_marca_por_modelo_nao_contamina_os_outros():
    from orchestrator.agents.runtime import note_model_denied, is_model_denied
    note_model_denied(OPUS)
    assert is_model_denied(SONNET) is False
    assert is_model_denied("us.anthropic.claude-opus-5") is False


# ── escape hatches ────────────────────────────────────────────────────────────

def test_ttl_zero_desliga_o_cache_inteiro(monkeypatch):
    from orchestrator.agents.runtime import note_model_denied, is_model_denied, preferred_model
    monkeypatch.setenv("CLAUDE_MODEL_DENY_TTL_SEC", "0")
    note_model_denied(OPUS)
    assert is_model_denied(OPUS) is False
    assert preferred_model(OPUS, SONNET) == OPUS  # comportamento anterior à A4.1


def test_ttl_invalido_cai_no_default_em_vez_de_explodir(monkeypatch):
    from orchestrator.agents.runtime import _model_denied_ttl
    for bad in ("", "  ", "abc", "-5"):
        monkeypatch.setenv("CLAUDE_MODEL_DENY_TTL_SEC", bad)
        ttl = _model_denied_ttl()
        assert ttl in (0, 1800), bad
        assert ttl >= 0


def test_sem_fallback_configurado_nada_muda(monkeypatch):
    """Foundry local: `CLAUDE_MODEL_FALLBACK` vazio → o principal continua sendo o chamado."""
    from orchestrator.agents.runtime import note_model_denied, preferred_model
    note_model_denied(OPUS)
    assert preferred_model(OPUS, "") == OPUS
    assert preferred_model(OPUS, OPUS) == OPUS  # fallback igual ao principal não é fallback


def test_fallback_tambem_negado_nao_gera_troca_inutil():
    """Se a conta não tem NENHUM dos dois, trocar só embaralha o log — quem falha é o principal."""
    from orchestrator.agents.runtime import note_model_denied, preferred_model
    note_model_denied(OPUS)
    note_model_denied(SONNET)
    assert preferred_model(OPUS, SONNET) == OPUS


# ── o 403 é da CONTA: a marca é por IDENTIDADE, não só por modelo ─────────────

def test_403_da_plataforma_nao_rebaixa_o_tenant_que_tem_o_modelo():
    """Caso REAL medido em prod (2026-09-06): o tenant `beca944e` (NVX LastMile) roda `opus-5` com
    credencial PRÓPRIA (BYOC, 19 chamadas de validador em 2026-09-05), enquanto a instance role da
    conta 820 leva 403 no MESMO modelo. Cache por `model_id` puro rebaixaria o tenant por 30 min.
    """
    from orchestrator.agents.runtime import model_identity_scope, note_model_denied, preferred_model
    opus5 = "us.anthropic.claude-opus-5"
    plataforma = model_identity_scope(None)                                    # instance role
    tenant = model_identity_scope({"aws_access_key_id": "AKIA-DO-TENANT",
                                   "aws_secret_access_key": "x"})              # BYOC
    assert plataforma != tenant
    note_model_denied(opus5, plataforma)
    assert preferred_model(opus5, SONNET, plataforma) == SONNET   # a plataforma cai
    assert preferred_model(opus5, SONNET, tenant) == opus5        # o tenant NÃO é afetado


def test_escopo_identifica_a_conta_sem_expor_a_credencial():
    from orchestrator.agents.runtime import model_identity_scope
    ak = "AKIAIOSFODNN7EXAMPLE"
    escopo = model_identity_scope({"aws_access_key_id": ak, "aws_secret_access_key": "segredo"})
    assert escopo.startswith("bedrock:")
    assert ak not in escopo and "segredo" not in escopo
    # mesma conta → mesmo escopo (a marca de uma chamada vale para a próxima do mesmo tenant)
    assert escopo == model_identity_scope({"aws_access_key_id": ak, "aws_secret_access_key": "outro"})
    # contas diferentes → escopos diferentes
    assert escopo != model_identity_scope({"aws_access_key_id": "AKIA-OUTRA-CONTA"})
    # provider diferente não colide com o Bedrock (Foundry é outro entitlement)
    assert model_identity_scope({"provider": "foundry", "foundry_api_key": "k"}).startswith("foundry:")


def test_sem_escopo_explicito_a_marca_continua_valendo_para_a_identidade_do_container():
    """Compatibilidade: quem não passa escopo (testes, chamadas antigas) fica no escopo do env."""
    from orchestrator.agents.runtime import note_model_denied, is_model_denied, model_identity_scope
    note_model_denied(OPUS)
    assert is_model_denied(OPUS) is True
    assert is_model_denied(OPUS, model_identity_scope(None)) is True


# ── o orçamento de tokens passa a ser do modelo REALMENTE usado ───────────────

def test_orcamento_de_saida_segue_o_modelo_efetivo():
    """Efeito colateral bom: o `run_agent` troca `model` ANTES do `calculate_token_budget`.

    Antes da A4.1 o downgrade só acontecia dentro do `except`, então o budget da 1ª tentativa era
    calculado para o modelo negado. Com um par de tetos diferentes (Opus 64k vs Haiku 8.192) fica
    demonstrável que pedir `max_tokens` de Opus num Haiku é `ValidationException`.
    """
    from orchestrator.agents.runtime import calculate_token_budget, preferred_model, note_model_denied
    haiku = "us.anthropic.claude-haiku-4-5"
    assert calculate_token_budget("sys", "user", OPUS)["safe_max_tokens"] == 64_000
    assert calculate_token_budget("sys", "user", haiku)["safe_max_tokens"] == 8_192
    note_model_denied(OPUS)
    efetivo = preferred_model(OPUS, haiku)
    assert efetivo == haiku
    assert calculate_token_budget("sys", "user", efetivo)["safe_max_tokens"] == 8_192
