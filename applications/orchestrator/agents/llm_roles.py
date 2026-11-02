"""Resolução de modelo por PAPEL (plano de evolução v2, tarefas 2A.4 e 2A.5; ADR-024).

Três papéis de modelo por slot: Orchestrator · Advisor · Staff (mesma linha do slot, UMA credencial).
Este módulo é puro (sem rede, sem env de escolha) e só vale com `LLM_ROLES_MODE=on`; com `off` e
`shadow` ninguém o consulta para ESCOLHER modelo (shadow só pergunta "qual papel seria usado").

Regras (todas testadas em `tests/test_llm_roles_resolution.py`):
  * papel do squad → papel de modelo: tabela do doc 05 §16 (tudo Orchestrator; Dev/QA com
    `rework_attempt >= 1` → Advisor). O papel EXIGIDO não muda ao trocar de slot.
  * Staff vazio ⇒ Orchestrator do mesmo slot, DECLARADO (`llm_role=staff`, `effective_role=orchestrator`).
  * Advisor vazio ⇒ SEM escalada, registrado (nunca modelo de plataforma).
  * Advisor igual ao Orchestrator ⇒ sem troca (`effective_role=orchestrator`).
  * falha de modelo/exceção/entitlement NÃO sobe para Advisor (isso é a cascata de slots, em outro lugar);
    negativa do Guard nunca rebaixa papel nem modelo (o Guard roda ANTES e propaga).
  * piso QA ≥ Dev compara o papel EFETIVO (`apply_floor`), nunca ids.
  * provider↔modelo é validado por papel e FALHA ALTO (`RoleProviderMismatch`), sem "corrigir" provider.
  * LEI dos slots: nada de modelo vindo de env/literal; sem Orchestrator no envelope ⇒ `RoleResolutionError`.

Contrato de transporte (2A.5, aditivo): `roles_contract_version` (int) e `models`
{orchestrator, advisor, staff} no envelope `llm_config` (agents) e no corpo de
`/api/internal/project-llm-config` (runner). Sem credencial por papel.
"""
from __future__ import annotations

from dataclasses import dataclass

from orchestrator.agents import llm_guard as _llm_guard

CONTRACT_VERSION = 1

ORCHESTRATOR, ADVISOR, STAFF = "orchestrator", "advisor", "staff"
# Capacidade relativa dos papéis EFETIVOS que servem autoria/QA. Staff nunca serve Dev/QA.
_RANK = {STAFF: 0, ORCHESTRATOR: 1, ADVISOR: 2}

# Doc 05 §16 — papel do squad → papel de modelo. Tudo que é autoria/QA/orquestração roda no
# Orchestrator; Staff NUNCA é papel de squad (nasce nos pontos mecânicos da 2B/2A.6).
_SQUAD_TO_MODEL_ROLE = {
    "CTO": ORCHESTRATOR, "ENGINEER": ORCHESTRATOR, "PM": ORCHESTRATOR, "DEV": ORCHESTRATOR,
    "QA": ORCHESTRATOR, "DEVOPS": ORCHESTRATOR, "MONITOR": ORCHESTRATOR,
}
# Roles em que o fato duro `rework_attempt >= 1` exige o Advisor (comportamento atual, doc 19 uso 1).
_REWORK_ROLES = ("DEV", "QA")


class RoleResolutionError(ValueError):
    """Não há como resolver o modelo do papel a partir do slot (LEI dos slots: falha alta)."""


class RoleProviderMismatch(RoleResolutionError):
    """O provider do slot não serve o modelo declarado para o papel (nunca corrigido em silêncio)."""


@dataclass(frozen=True)
class RoleModels:
    orchestrator: str = ""
    advisor: str = ""   # "" = sem escalada (D1b)
    staff: str = ""     # "" = usa o Orchestrator do mesmo slot (D1)

    def as_dict(self) -> dict:
        return {ORCHESTRATOR: self.orchestrator or None, ADVISOR: self.advisor or None,
                STAFF: self.staff or None}


@dataclass(frozen=True)
class RoleResolution:
    llm_role: str          # papel EXIGIDO pela chamada
    effective_role: str    # papel que de fato serve (diferente só em Staff vazio / Advisor vazio)
    model: str
    escalated: bool        # True só se o modelo do papel substituiu o Orchestrator
    note: str = ""         # registro auditável (sem ids de credencial)


def _clean(v: object) -> str:
    return str(v).strip() if isinstance(v, str) else ""


def is_on() -> bool:
    return _llm_guard.roles_mode() == "on"


def required_role(squad_role: str, *, rework_attempt: int = 0) -> str:
    """Papel de modelo EXIGIDO por uma chamada do squad. Só fato duro (`rework_attempt >= 1`)."""
    up = (squad_role or "").upper()
    if up in _REWORK_ROLES and int(rework_attempt or 0) >= 1:
        return ADVISOR
    return _SQUAD_TO_MODEL_ROLE.get(up, ORCHESTRATOR)


def apply_floor(required: str, floor: str | None) -> str:
    """Piso QA ≥ Dev: o papel exigido nunca é MENOR que o papel efetivo do Dev."""
    f = _llm_guard.normalize_role(floor)
    if f and _RANK.get(f, 0) > _RANK.get(required, 0):
        return f
    return required


def models_from_llm_cfg(cfg: dict | None) -> RoleModels:
    """Papéis do envelope `llm_config`. Prefere `models.*` (contrato novo); sem eles cai no legado
    (`model` = Orchestrator, `model_rework` = Advisor, semântica 1) — NUNCA em env."""
    cfg = cfg if isinstance(cfg, dict) else {}
    m = cfg.get("models")
    if isinstance(m, dict) and _version_ok(cfg):
        return RoleModels(
            orchestrator=_clean(m.get(ORCHESTRATOR)) or _clean(cfg.get("model")),
            advisor=_clean(m.get(ADVISOR)), staff=_clean(m.get(STAFF)),
        )
    return RoleModels(orchestrator=_clean(cfg.get("model")), advisor=_clean(cfg.get("model_rework")))


def _version_ok(cfg: dict) -> bool:
    """Versão ausente (candidato dentro de um envelope versionado) ou ≤ à conhecida. Versão FUTURA
    (semântica desconhecida) ⇒ NÃO interpreta `models`: cai no legado (fail-safe)."""
    try:
        return int(cfg.get("roles_contract_version") or 0) <= CONTRACT_VERSION
    except (TypeError, ValueError):
        return False


def has_contract(cfg: dict | None) -> bool:
    """O envelope trouxe o contrato novo? (versão inteira ≥ 1 e `models` dict)."""
    cfg = cfg if isinstance(cfg, dict) else {}
    try:
        ver = int(cfg.get("roles_contract_version") or 0)
    except (TypeError, ValueError):
        ver = 0
    return 1 <= ver <= CONTRACT_VERSION and isinstance(cfg.get("models"), dict)


def resolve_model(required: str, models: RoleModels) -> RoleResolution:
    """Modelo do papel exigido dentro do SLOT (D1/D1b). Sem Orchestrator ⇒ falha alta."""
    req = required if required in _RANK else ORCHESTRATOR
    orch = models.orchestrator
    if not orch:
        raise RoleResolutionError(
            "nenhum modelo Orchestrator no slot do tenant: configure um slot em Configurações → LLM "
            "(LEI dos slots: nenhum modelo de env/literal)."
        )
    if req == ORCHESTRATOR:
        return RoleResolution(ORCHESTRATOR, ORCHESTRATOR, orch, False)
    if req == STAFF:
        if models.staff:
            return RoleResolution(STAFF, STAFF, models.staff, False)
        return RoleResolution(STAFF, ORCHESTRATOR, orch, False, "staff_empty_uses_orchestrator")
    # ADVISOR
    if not models.advisor:
        return RoleResolution(ADVISOR, ORCHESTRATOR, orch, False, "advisor_empty_no_escalation")
    if models.advisor == orch:
        return RoleResolution(ADVISOR, ORCHESTRATOR, orch, False, "advisor_same_as_orchestrator")
    return RoleResolution(ADVISOR, ADVISOR, models.advisor, True)


def provider_serves(provider: str, model: str) -> bool:
    """O provider consegue servir o id? Mesma matriz do `_is_compatible` do runner_server (id
    desconhecido ⇒ compatível, não quebrar), com um ajuste: Bedrock aceita qualquer id com prefixo de
    vendor/região (`us.`, `global.`, `amazon.`…) — o Haiku 4.5 exige `global.`, que o teste antigo
    (`startswith("us.anthropic")`) tratava como incompatível."""
    p, ml = (provider or "").strip().lower(), (model or "").strip().lower()
    if not ml:
        return False
    claude = any(x in ml for x in ("claude", "sonnet", "opus", "haiku"))
    openai_like = any(x in ml for x in ("gpt", "o1", "o3", "o4", "composer", "davinci"))
    gemini = "gemini" in ml
    bedrock_id = "." in ml.split(":")[0] and not ml.startswith(("claude", "gemini", "gpt", "meta/"))
    known = claude or openai_like or gemini or ml.startswith("us.anthropic")
    if p == "bedrock":
        fits = bedrock_id and not openai_like and not gemini
    elif p == "foundry":
        fits = claude and not ml.startswith(("us.anthropic", "global.anthropic"))
    elif p == "anthropic":
        fits = claude and not bedrock_id
    elif p == "google":
        fits = (not ml.startswith(("us.anthropic", "global.anthropic"))
                and any(x in ml for x in ("gemini", "claude", "llama", "mistral", "qwen", "gemma")))
    elif p == "openai":
        fits = openai_like
    elif p == "azure_openai":
        fits = any(x in ml for x in ("gpt", "o1", "o3", "davinci"))
    else:
        fits = False
    # Id DESCONHECIDO (nem Claude, nem GPT, nem Gemini) ⇒ compatível: não quebrar (regra do legado).
    return fits or not known


def validate_provider(provider: str, role: str, model: str) -> None:
    """Falha ALTO (nunca corrige) se o provider do slot não serve o modelo do papel."""
    if model and not provider_serves(provider, model):
        raise RoleProviderMismatch(
            f"o provider '{provider}' do slot não serve o modelo do papel {role} ('{model}'): "
            "corrija o modelo em Configurações → LLM. O provider NÃO é trocado em silêncio."
        )


def validate_models(provider: str, models: RoleModels) -> None:
    """Valida cada papel declarado contra o provider (usado ao receber o slot, antes do run)."""
    for role, m in ((ORCHESTRATOR, models.orchestrator), (ADVISOR, models.advisor), (STAFF, models.staff)):
        validate_provider(provider, role, m)


def shadow_role(squad_role: str, *, rework_attempt: int = 0) -> str:
    """Papel que SERIA exigido (para `shadow`); não escolhe nem troca modelo."""
    return required_role(squad_role, rework_attempt=rework_attempt)


def envelope_fields(models: RoleModels) -> dict:
    """Campos ADITIVOS do envelope (agents/runner): versão do contrato + os 3 modelos. Sem credencial."""
    return {"roles_contract_version": CONTRACT_VERSION, "models": models.as_dict()}


# ── Transporte Fábrica (2A.5): envs de TRANSPORTE, nunca de escolha ───────────────────────────────
# `runner_server` resolve o slot e injeta no env DO RUN; o runner lê de volta para montar o envelope.
# Estas envs só existem sob LLM_ROLES_MODE=on e são escritas SÓ pelo `runner_server`.
ENV_ORCHESTRATOR, ENV_ADVISOR, ENV_STAFF = "CLAUDE_MODEL", "CLAUDE_MODEL_ADVISOR", "CLAUDE_MODEL_STAFF"
ENV_CONTRACT_VERSION = "GENESIS_LLM_ROLES_CONTRACT_VERSION"
# Envs de escolha por papel que NINGUÉM injeta (doc 05 §6) e que, vindas do container, seriam atalho
# de modelo fora do slot. Sob `on` o runner_server as REMOVE do env do run.
_SHORTCUT_ENVS = ("CLAUDE_MODEL_SPEC", "CLAUDE_MODEL_CODE", "PIPELINE_LLM_MODEL")


def models_from_runner_response(resp: dict | None) -> RoleModels:
    """Papéis do corpo de `/api/internal/project-llm-config` (camelCase). Com o contrato novo
    (`models` + `roles_contract_version`) lê `models`; API ANTIGA (sem os campos) ⇒ deriva do legado
    do MESMO slot (`modelId` = Orchestrator, `fallbackModelId` = Advisor, semântica 1)."""
    resp = resp if isinstance(resp, dict) else {}
    if has_contract({"models": resp.get("models"), "roles_contract_version": resp.get("roles_contract_version")}):
        m = resp["models"]
        return RoleModels(orchestrator=_clean(m.get(ORCHESTRATOR)) or _clean(resp.get("modelId")),
                          advisor=_clean(m.get(ADVISOR)), staff=_clean(m.get(STAFF)))
    return RoleModels(orchestrator=_clean(resp.get("modelId")), advisor=_clean(resp.get("fallbackModelId")))


def transport_env(models: RoleModels) -> dict:
    """Mudanças no env do run (valor `None` = remover). Sem credencial: só ids de modelo e versão."""
    out: dict = {ENV_ORCHESTRATOR: models.orchestrator or None,
                 ENV_ADVISOR: models.advisor or None, ENV_STAFF: models.staff or None,
                 ENV_CONTRACT_VERSION: str(CONTRACT_VERSION)}
    out.update({k: None for k in _SHORTCUT_ENVS})
    return out


def envelope_from_env(env) -> dict:
    """Campos aditivos do envelope `llm_config` a partir do env DO RUN (lado do runner)."""
    ver = _clean(env.get(ENV_CONTRACT_VERSION))
    if not ver:
        return {}  # runner_server antigo (não transportou o contrato): envelope legado, sem `models`
    return envelope_fields(RoleModels(orchestrator=_clean(env.get(ENV_ORCHESTRATOR)),
                                      advisor=_clean(env.get(ENV_ADVISOR)),
                                      staff=_clean(env.get(ENV_STAFF))))
