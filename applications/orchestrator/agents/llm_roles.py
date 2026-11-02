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

import os
import threading
import time
import uuid
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
# Roles em que `env=prod` exige o Advisor (doc 06 §A4: F01 Engineer, F05 Dev). QA herda pelo piso do Dev.
_PROD_ROLES = ("DEV", "ENGINEER")


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


def is_prod_env(env: object) -> bool:
    """Fato duro `env=prod` (2A.7). Só o valor declarado conta; ausente ⇒ False (nada é inferido)."""
    return str(env or "").strip().lower() in ("prod", "production")


def required_role(squad_role: str, *, rework_attempt: int = 0, env: object = None) -> str:
    """Papel de modelo EXIGIDO por uma chamada do squad. Só FATO DURO (2A.7, D2):
    `rework_attempt >= 1` (Dev/QA) e `env=prod` quando o fluxo declara o ambiente (Dev/Engineer).
    Nunca por exceção de rede, resposta vazia, truncamento, entitlement negado ou Guard-deny."""
    up = (squad_role or "").upper()
    if up in _REWORK_ROLES and int(rework_attempt or 0) >= 1:
        return ADVISOR
    if up in _PROD_ROLES and is_prod_env(env):
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


def shadow_role(squad_role: str, *, rework_attempt: int = 0, env: object = None) -> str:
    """Papel que SERIA exigido (para `shadow`); não escolhe nem troca modelo."""
    return required_role(squad_role, rework_attempt=rework_attempt, env=env)


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


# ── 2A.6: chamadas diretas fora do `run_agent` (F08, F11, F12 do runner) ─────────────────────────
# Mapa "ponto de chamada → papel" (doc 06 §3/§7): F11/F12 são STAFF (enum fechado, piloto); F08 é
# Orchestrator. Sob `on` o modelo vem do SLOT (envelope do run); sem slot ⇒ falha alta, sem default
# literal e sem provider forçado. Staff vazio ⇒ Orchestrator do mesmo slot, DECLARADO no ledger.
DIRECT_CALL_ROLES = {"F08": ORCHESTRATOR, "F11": STAFF, "F12": STAFF}


@dataclass(frozen=True)
class DirectPlan:
    model: str
    llm_cfg: dict          # envelope do slot (provider + credenciais) para o cliente genérico
    llm_role: str
    effective_role: str
    note: str = ""


def plan_direct_call(point: str, llm_cfg: dict | None) -> DirectPlan:
    """Resolve modelo/provider de uma chamada direta pelo PAPEL do ponto. Só sob `on` (o chamador
    decide). Falha alta (`RoleResolutionError`) se o slot não declara modelo ou provider; falha alta
    (`RoleProviderMismatch`) se o provider do slot não serve o modelo do papel."""
    required = DIRECT_CALL_ROLES.get(point)
    if required is None:
        raise RoleResolutionError(f"ponto de chamada direta desconhecido: {point!r}")
    cfg = llm_cfg if isinstance(llm_cfg, dict) else {}
    provider = _clean(cfg.get("provider"))
    if not provider:
        raise RoleResolutionError(
            f"[{point}] o slot do tenant não declara provider: configure um slot em Configurações → LLM "
            "(LEI dos slots: nenhum provider forçado).")
    res = resolve_model(required, models_from_llm_cfg(cfg))
    validate_provider(provider, res.effective_role, res.model)
    return DirectPlan(res.model, cfg, res.llm_role, res.effective_role, res.note)


# ── 2A.7: política de escalonamento por fato duro ────────────────────────────────────────────────
# O Advisor só é acionado por FATO DURO: `rework_attempt >= 1` (Dev/QA), `env=prod` declarado,
# schema/envelope reprovado DEPOIS do reparo do Orchestrator. Nunca por exceção de rede, resposta
# vazia, truncamento, entitlement negado ou Guard-deny (isso é cascata de slots / propagação).
# Esta seção guarda o estado em memória de processo: idempotência da escalada e teto de custo.
ENV_ADVISOR_CAP = "ADVISOR_MAX_USD_PER_RUN"
DEFAULT_ADVISOR_CAP_USD = 5.0     # conservador; 0 = sem Advisor (nunca escala)
ENV_PRICE_IN, ENV_PRICE_OUT = "ADVISOR_PRICE_USD_PER_MTOK_IN", "ADVISOR_PRICE_USD_PER_MTOK_OUT"
DEFAULT_PRICE_IN, DEFAULT_PRICE_OUT = 5.0, 25.0   # teto Opus da tabela do repo (doc 10); sobrescrevível
ENV_BUDGET_TTL = "ADVISOR_BUDGET_TTL_SEC"
DEFAULT_BUDGET_TTL_SEC = 21600    # janela que delimita um "run" quando a mensagem não traz run_id
ENV_DEDUPE_TTL = "ADVISOR_DEDUPE_TTL_SEC"
DEFAULT_DEDUPE_TTL_SEC = 3600     # janela do retry de rede da MESMA tentativa (chave task+etapa+papel+tentativa)

NOTE_CAP_REACHED = "advisor_cap_reached"
NOTE_DEDUPED = "escalation_deduped"
STAGE_PRIMARY, STAGE_SCHEMA = "primary", "schema"


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        v = float(str(raw).strip())
    except ValueError:
        return default
    return v if v >= 0 else default


def advisor_cap_usd() -> float:
    return _env_float(ENV_ADVISOR_CAP, DEFAULT_ADVISOR_CAP_USD)


def estimate_cost_usd(input_tokens: int, output_tokens: int) -> float:
    """Custo conservador (preço de teto, sobrescrevível por env) — usado para reservar e liquidar."""
    pin = _env_float(ENV_PRICE_IN, DEFAULT_PRICE_IN)
    pout = _env_float(ENV_PRICE_OUT, DEFAULT_PRICE_OUT)
    return (max(0, int(input_tokens or 0)) * pin + max(0, int(output_tokens or 0)) * pout) / 1_000_000.0


def escalation_key(task_id: object, stage: object, role: str, attempt: object = None) -> str:
    """Chave de idempotência da escalada: `task_id + etapa + papel (+ tentativa de negócio)`.
    A tentativa (rework N) entra para que o rework 2 não seja confundido com o retry do rework 1."""
    return _llm_guard.idem_key("-", task_id, stage, f"{role}.{attempt if attempt not in (None, '') else '-'}")


@dataclass(frozen=True)
class Reservation:
    allowed: bool
    code: str = "ok"        # ok | escalation_deduped | advisor_cap_reached


class AdvisorBudget:
    """Idempotência + teto de custo do Advisor (estado de processo, thread-safe, com TTL).

    * `reserve(scope, key, projected_usd)`: concede no máx. UMA escalada por `key` e só se
      `gasto(scope) + projetado <= teto`. O projetado fica reservado até `settle`/`release`.
    * `settle(key, actual_usd)`: troca o projetado pelo custo real (a chave permanece: a tentativa FOI cobrada).
    * `release(key)`: a chamada não saiu (exceção antes da resposta, Guard-deny): devolve a reserva e libera
      a chave, para o retry de rede da MESMA tentativa ainda poder escalar.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._keys: dict[str, tuple[str, float, float]] = {}   # key -> (scope, reservado_usd, ts)
        self._spent: dict[str, tuple[float, float]] = {}       # scope -> (usd, ts)

    def _ttl(self) -> float:
        return _env_float(ENV_BUDGET_TTL, float(DEFAULT_BUDGET_TTL_SEC))

    def _purge(self, now: float) -> None:
        ttl = self._ttl()
        kttl = _env_float(ENV_DEDUPE_TTL, float(DEFAULT_DEDUPE_TTL_SEC))
        for k in [k for k, (_, _, ts) in self._keys.items() if now - ts > kttl]:
            self._keys.pop(k, None)
        for sc in [sc for sc, (_, ts) in self._spent.items() if now - ts > ttl]:
            self._spent.pop(sc, None)

    def reset(self) -> None:
        with self._lock:
            self._keys.clear()
            self._spent.clear()

    def spent(self, scope: str) -> float:
        with self._lock:
            return self._spent.get(scope, (0.0, 0.0))[0]

    def reserve(self, scope: str, key: str, projected_usd: float) -> Reservation:
        now = time.time()
        cap = advisor_cap_usd()
        with self._lock:
            self._purge(now)
            if key in self._keys:
                return Reservation(False, NOTE_DEDUPED)
            spent = self._spent.get(scope, (0.0, now))[0]
            if cap <= 0 or spent + max(0.0, projected_usd) > cap:
                return Reservation(False, NOTE_CAP_REACHED)
            self._keys[key] = (scope, max(0.0, projected_usd), now)
            self._spent[scope] = (spent + max(0.0, projected_usd), now)
            return Reservation(True)

    def settle(self, key: str, actual_usd: float) -> None:
        now = time.time()
        with self._lock:
            ent = self._keys.get(key)
            if not ent:
                return
            scope, reserved, _ = ent
            spent = self._spent.get(scope, (0.0, now))[0]
            self._spent[scope] = (max(0.0, spent - reserved + max(0.0, actual_usd)), now)
            self._keys[key] = (scope, max(0.0, actual_usd), now)

    def release(self, key: str) -> None:
        now = time.time()
        with self._lock:
            ent = self._keys.pop(key, None)
            if not ent:
                return
            scope, reserved, _ = ent
            spent = self._spent.get(scope, (0.0, now))[0]
            self._spent[scope] = (max(0.0, spent - reserved), now)


BUDGET = AdvisorBudget()


def run_scope(*candidates: object) -> str:
    """Escopo do teto: `run_id` quando existir, senão o projeto (a janela é o TTL do orçamento)."""
    for c in candidates:
        s = str(c).strip() if c not in (None, "") else ""
        if s:
            return s[:80]
    return "-"


def schema_escalation_eligible(*, parse_errors: list, gate_errors: list, raw_text: str,
                               stop_reason: object, repair_attempt: int, max_repairs: int) -> bool:
    """Fato duro: schema/envelope REPROVADO depois do reparo do Orchestrator.
    Não escala: truncamento (`max_tokens`), resposta vazia, falha só de qualidade/edits, ou quando
    o reparo seguinte não é o ÚLTIMO (as chamadas totais não crescem: o Advisor ocupa o último reparo)."""
    if not (parse_errors or gate_errors):
        return False
    if stop_reason == "max_tokens" or not (raw_text or "").strip():
        return False
    if max_repairs < 2 or repair_attempt < 1:       # tem de haver >= 1 reparo do Orchestrator que falhou
        return False
    return repair_attempt + 1 == max_repairs


@dataclass(frozen=True)
class AttemptPlan:
    model: str
    llm_role: str          # papel EXIGIDO nesta tentativa
    effective_role: str
    escalated: bool        # o Advisor SUBSTITUIU o Orchestrator nesta tentativa
    key: str | None = None  # chave reservada (a liberar/liquidar); None se não houve reserva
    note: str = ""


def plan_attempt(*, required: str, models: RoleModels, repair_attempt: int, schema_escalate: bool,
                 scope: str, task_id: object, stage: object, rework_attempt: int,
                 projected_usd: float, budget: AdvisorBudget | None = None) -> AttemptPlan:
    """Modelo de UMA tentativa do `run_agent` sob `on`.

    tentativa 0 ⇒ papel exigido pelos fatos duros (rework/env=prod/piso QA); reparos ⇒ Orchestrator,
    salvo o ÚLTIMO reparo quando o schema segue reprovado (`schema_escalate`). Toda escalada real passa
    pela idempotência da chave e pelo teto; negada ⇒ segue no Orchestrator com a nota registrada."""
    budget = budget or BUDGET
    if repair_attempt == 0:
        want, st = required, STAGE_PRIMARY
    elif schema_escalate:
        want, st = ADVISOR, STAGE_SCHEMA
    else:
        want, st = ORCHESTRATOR, STAGE_PRIMARY
    res = resolve_model(want, models)
    if not res.escalated:
        return AttemptPlan(res.model, res.llm_role, res.effective_role, False, None, res.note)
    if task_id in (None, ""):
        # Sem task_id não há identidade da tentativa: dedupe fundiria tarefas distintas. Só o teto vale.
        key = f"anon|{uuid.uuid4().hex}"
    else:
        key = escalation_key(task_id, f"{stage}:{st}", ADVISOR, rework_attempt)
    rsv = budget.reserve(scope, key, projected_usd)
    if not rsv.allowed:
        return AttemptPlan(models.orchestrator, ADVISOR, ORCHESTRATOR, False, None, rsv.code)
    return AttemptPlan(res.model, ADVISOR, ADVISOR, True, key, "")


def peak_role(a: str | None, b: str | None) -> str | None:
    """Maior papel EFETIVO entre dois (para o carimbo/piso QA da invocação inteira)."""
    if not a:
        return b
    if not b:
        return a
    return a if _RANK.get(a, 0) >= _RANK.get(b, 0) else b
