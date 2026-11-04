"""C1' — classificador ÚNICO da negativa do LLM Guard no orquestrador (runner).

Por que existe (27c F01): a negativa do Guard chega ao runner em DOIS formatos:

  1. in-process (sem `API_AGENTS_URL`): `LlmGuardDenied` propagando de `run_agent`;
  2. HTTP (produção, `API_AGENTS_URL`): o `agents/server.py` devolve 402 e o cliente
     (`agents/client_http.py`) levanta `RuntimeError(json{"http_code": 402, "error": <corpo cru>, ...})`.
     Um `except LlmGuardDenied` NÃO pega este formato.

Este módulo é puro (sem rede, sem estado de projeto): só reconhece a negativa e diz de que tipo é.
A decisão é sempre do Guard (soberano, fail-closed): nada aqui libera, rebaixa papel/modelo nem
tenta outro caminho; apenas evita que uma NEGATIVA seja tratada como FALHA do pipeline.

Flag `GUARD_DENIAL_GRACEFUL` (`off|on`, padrão `on`): `off` devolve o comportamento antigo
(negativa vira `failed`/`BLOCKED`). Ausente ou inválida ⇒ `on`.
"""
from __future__ import annotations

import json
import os
import random
import re

# Códigos reais do Guard (api-node `services/llmGuard.ts` GuardCode + `agents/llm_guard.py`).
# Obs.: não existe `BUDGET_EXCEEDED` no código — o estouro é BUDGET_PAUSED/BUDGET_INSUFFICIENT.
# `CARD_BUDGET_CAP` (F5, teto % do card): também é orçamento — só um humano resolve (subir orçamento/percentual), esperar não ajuda.
BUDGET_CODES = frozenset({"BUDGET_MISSING", "BUDGET_PAUSED", "BUDGET_INSUFFICIENT", "CARD_BUDGET_CAP"})
PLATFORM_CODES = frozenset({
    "KILL_SWITCH", "GLOBAL_HOURLY_CAP", "GLOBAL_DAILY_CAP", "UNATTRIBUTED_DAILY_CAP",
    "REPEAT_PAYLOAD", "PROJECT_NOT_FOUND",
})
INFRA_CODES = frozenset({"GUARD_ERROR", "GUARD_NO_TOKEN", "GUARD_UNREACHABLE"})
GUARD_CODES = BUDGET_CODES | PLATFORM_CODES | INFRA_CODES

_CODE_RE = re.compile(r'"code"\s*:\s*"([A-Z][A-Z_]{3,})"')
_PREFIX_RE = re.compile(r"\[llm-guard\]\s+([A-Z][A-Z_]{3,}):")


def graceful_enabled() -> bool:
    """Helper ÚNICO da flag. Ausente ou inválido ⇒ `on` (o caminho de erro novo é o seguro)."""
    raw = (os.environ.get("GUARD_DENIAL_GRACEFUL", "on") or "on").strip().lower()
    return raw != "off"


def _chain(exc: BaseException | None, limit: int = 6):
    seen = 0
    while exc is not None and seen < limit:
        yield exc
        exc = exc.__cause__
        seen += 1


def _http_payload(exc: BaseException) -> dict | None:
    """Payload JSON do `RuntimeError` do `client_http` (None se a mensagem não for esse JSON)."""
    try:
        data = json.loads(str(exc))
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def _is_402(exc: BaseException) -> bool:
    for attr in ("http_code", "status_code", "code"):
        if getattr(exc, attr, None) == 402 and not isinstance(getattr(exc, attr), bool):
            return True
    data = _http_payload(exc)
    if data is not None:
        try:
            return int(data.get("http_code")) == 402
        except (TypeError, ValueError):
            return False
    return False


def is_guard_denial(exc: BaseException | None) -> bool:
    """True se `exc` é uma NEGATIVA do Guard, em qualquer dos dois formatos (ver módulo).

    Erro de taxa (429), timeout, 5xx e falha de provider NÃO são negativa: retornam False."""
    for e in _chain(exc):
        if type(e).__name__ == "LlmGuardDenied":  # evita importar agents aqui; cobre subclasses via MRO abaixo
            return True
        if any(c.__name__ == "LlmGuardDenied" for c in type(e).__mro__):
            return True
        if _is_402(e):
            return True
    return False


def guard_denial_code(exc: BaseException | None) -> str | None:
    """Código do Guard (`KILL_SWITCH`, `BUDGET_PAUSED`...) ou None se não for negativa / sem código."""
    for e in _chain(exc):
        code = getattr(e, "code", None)
        if isinstance(code, str) and code in GUARD_CODES:
            return code
        data = _http_payload(e)
        texts = [str(e)]
        if data:
            texts = [str(data.get("error") or ""), str(data.get("human_message") or ""), str(e)]
            c = data.get("code")
            if isinstance(c, str) and c in GUARD_CODES:
                return c
        for t in texts:
            m = _PREFIX_RE.search(t) or _CODE_RE.search(t.replace('\\"', '"'))
            if m and m.group(1) in GUARD_CODES:
                return m.group(1)
    return None


def is_budget_denial(exc: BaseException | None) -> bool:
    """Negativa por ORÇAMENTO do projeto (só um humano resolve: aumentar o orçamento). Não se repete."""
    return guard_denial_code(exc) in BUDGET_CODES


# ── Espera com teto (substitui o laço de 2 s) ────────────────────────────────────────────────────
def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        v = int(float(os.environ.get(name, "") or default))
    except (TypeError, ValueError):
        v = default
    return max(lo, min(hi, v))


def max_checks() -> int:
    """Nº máximo de negativas consecutivas toleradas (com espera) antes de encerrar o run. Padrão 10."""
    return _env_int("GUARD_DENIAL_MAX_CHECKS", 10, 1, 1000)


def backoff_seconds(checks: int, rng=random.random) -> float:
    """Espera antes da verificação `checks` (1-based): exponencial com teto e jitter de até +25 %.

    Base `GUARD_DENIAL_WAIT_BASE_SEC` (padrão 30), teto `GUARD_DENIAL_WAIT_MAX_SEC` (padrão 300)."""
    base = _env_int("GUARD_DENIAL_WAIT_BASE_SEC", 30, 0, 3600)
    cap = _env_int("GUARD_DENIAL_WAIT_MAX_SEC", 300, 0, 3600)
    raw = min(cap, base * (2 ** max(0, checks - 1)))
    return float(raw) * (1.0 + 0.25 * rng())
