"""LLM GUARD — licença ANTES e registro DEPOIS de toda chamada paga de LLM (post-mortem 30/09/2026).

O incidente (BRL 90.305,78): um laço da api chamou Opus ~1×/min por 22 dias e o gasto era
INVISÍVEL — ninguém debitava o usage das chamadas por `/invoke/raw`. A lição: o controle não pode
depender de quem LEMBRA de debitar. Ele vive aqui, no ponto da chamada (`run_agent` e
`call_bedrock_direct`), e a decisão é da api (`/api/internal/llm-guard/*`), que conhece orçamento,
kill switch e disjuntores.

Contrato:
  * FAIL-CLOSED: api fora, token ausente, resposta ilegível ⇒ a chamada é NEGADA (`LlmGuardDenied`).
    Gasto sem controle custou mais que qualquer indisponibilidade.
  * Projeto vem do escopo (`guard_scope`, ContextVar) ou do argumento. Só UUID conta como projeto:
    pseudo-projetos (`"spec_chat"`, `"default"`) viram "sem projeto" (teto diário próprio na api).
  * `record` nunca lança: a chamada já foi paga, perder o registro é pior que atrasar a resposta.
  * ContextVar NÃO atravessa ThreadPoolExecutor/threading.Thread sozinho: quem dispara threads usa
    `contextvars.copy_context().run(...)` (ou `run_in_scope`).
"""
from __future__ import annotations

import contextlib
import contextvars
import hashlib
import json
import logging
import os
import re
import urllib.request

logger = logging.getLogger(__name__)

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

_scope: "contextvars.ContextVar[dict | None]" = contextvars.ContextVar("llm_guard_scope", default=None)


class LlmGuardDenied(RuntimeError):
    """Chamada de LLM recusada pelo guard. NÃO é falha de provider: não conta no circuit breaker
    nem na cascata de slots, e o HTTP do agents a devolve como 402."""

    def __init__(self, code: str, message: str, project_id: str | None = None):
        super().__init__(f"[llm-guard] {code}: {message}")
        self.code = code
        self.message = message
        self.project_id = project_id


def as_project_id(value: object) -> str | None:
    """Só UUID é projeto. `"spec_chat"`, `"default"`, `""` ⇒ None."""
    s = str(value or "").strip()
    return s if _UUID_RE.match(s) else None


def current_scope() -> dict:
    return dict(_scope.get() or {})


@contextlib.contextmanager
def guard_scope(project_id: object = None, purpose: str | None = None, source: str | None = None,
                **extra):
    """Define o projeto/finalidade das chamadas de LLM deste contexto (restaura ao sair).
    Valores vazios herdam do escopo externo."""
    base = current_scope()
    pid = as_project_id(project_id)
    if pid:
        base["project_id"] = pid
    if purpose:
        base["purpose"] = purpose
    if source:
        base["source"] = source
    for k, v in extra.items():
        if v:
            base[k] = v
    token = _scope.set(base)
    try:
        yield base
    finally:
        _scope.reset(token)


def run_in_scope(fn, *args, **kwargs):
    """Executa `fn` numa CÓPIA do contexto atual — usar ao submeter para threads/executors."""
    return contextvars.copy_context().run(fn, *args, **kwargs)


def prompt_hash(model: str, system: str, user: str) -> str:
    h = hashlib.sha256()
    for part in (model or "", "\x00", system or "", "\x00", user or ""):
        h.update(part.encode("utf-8", "replace"))
    return h.hexdigest()


# ── Papel de LLM (plano de evolução v2, tarefa 1.3) ──────────────────────────────────────────────
# `LLM_ROLES_MODE` = off | shadow | on (padrão off). Espelho de `api-node/src/lib/llmRoles.ts`.
# off ⇒ NADA muda: nenhum campo de papel entra no payload do preflight/record (byte-idêntico).
# shadow/on ⇒ o papel DERIVADO do comportamento atual viaja ao ledger. Ainda não há roteamento por
# papel (Fase 2A), e uma negativa do guard nunca rebaixa papel nem modelo.
LLM_ROLES = ("orchestrator", "advisor", "staff")


def roles_mode() -> str:
    """Helper ÚNICO da flag. Ausente ou inválido ⇒ `off` (fail-safe)."""
    raw = (os.environ.get("LLM_ROLES_MODE", "off") or "off").strip().lower()
    return raw if raw in ("shadow", "on") else "off"


def normalize_role(value: object) -> str | None:
    s = str(value or "").strip().lower()
    return s if s in LLM_ROLES else None


def role_kwargs(*, escalated: bool = False, staff: bool = False) -> dict:
    """Papel derivado do comportamento atual, como kwargs para `check`/`call_bedrock_direct`.

    Orchestrator = modelo principal do slot · Advisor = modelo de rework/fallback usado por escalada
    (`escalated_from="orchestrator"`) · Staff = só quando o chamador afirma de forma inequívoca.
    Com a flag `off` devolve `{}` — o chamador não passa argumento novo nenhum.
    """
    if roles_mode() == "off":
        return {}
    if staff:
        return {"llm_role": "staff"}
    if escalated:
        return {"llm_role": "advisor", "escalated_from": "orchestrator"}
    return {"llm_role": "orchestrator"}


# ── Telemetria de desperdício (plano de evolução v2, tarefa 1.4) ──────────────────────────────────
# `WASTE_TELEMETRY` = off | shadow | on (padrão off). off ⇒ NADA muda: nenhum campo novo entra no
# payload do preflight/record (byte-idêntico). shadow e on gravam o MOTIVO da chamada
# (`call_reason`) e a chave de idempotência por chamada no ledger; nenhum comportamento muda.
CALL_REASONS = ("primary", "retry", "repair", "rework", "escalation", "support")


def waste_mode() -> str:
    """Helper ÚNICO da flag. Ausente ou inválido ⇒ `off` (fail-safe)."""
    raw = (os.environ.get("WASTE_TELEMETRY", "off") or "off").strip().lower()
    return raw if raw in ("shadow", "on") else "off"


def normalize_reason(value: object) -> str | None:
    s = str(value or "").strip().lower()
    return s if s in CALL_REASONS else None


def derive_reason(*, repair_attempt: int = 0, rework_attempt: int = 0, rework_role: bool = False) -> str:
    """Motivo derivado do contexto de `run_agent`: repair da LEI 5 > rework Dev/QA > primary."""
    if int(repair_attempt or 0) >= 1:
        return "repair"
    if rework_role and int(rework_attempt or 0) >= 1:
        return "rework"
    return "primary"


def idem_key(project_id: object, task_id: object, stage: object, attempt: object) -> str:
    """Chave de idempotência por chamada de NEGÓCIO: `projeto|task|etapa|tentativa`.
    Retry de rede (mesma tentativa) repete a chave e não conta como outra chamada na análise."""
    return "|".join(str(x if x not in (None, "") else "-")[:80] for x in (project_id, task_id, stage, attempt))


def waste_kwargs(reason: str, *, task: object = None, stage: str | None = None,
                 attempt: object = None) -> dict:
    """Kwargs de telemetria para `check`/`call_bedrock_direct`. Com a flag `off` devolve `{}`.
    Sem `stage` não há chave de idempotência (melhor não deduplicar do que fundir chamadas distintas)."""
    if waste_mode() == "off":
        return {}
    kw: dict = {"call_reason": reason}
    if stage:
        kw.update(call_task=task, call_stage=stage, call_attempt=attempt)
    return kw


def waste_call_kwargs(reason: str, **kw) -> dict:
    """Para `call_bedrock_direct(**...)`: `{}` com a flag off (a chamada fica com os MESMOS argumentos de antes,
    inclusive para dublês de teste), `{"waste": waste_kwargs(...)}` com a flag ligada."""
    w = waste_kwargs(reason, **kw)
    return {"waste": w} if w else {}


def _disabled() -> bool:
    # Só para teste unitário isolado. Em prod NÃO existe: o compose não define a variável.
    return os.environ.get("LLM_GUARD_DISABLED_FOR_TESTS", "").strip() == "1"


def _post(path: str, body: dict, timeout: float) -> dict:
    base = (os.environ.get("API_BASE_URL") or "http://api:3000").strip().rstrip("/")
    token = (os.environ.get("GENESIS_API_TOKEN") or "").strip()
    if not token:
        raise LlmGuardDenied("GUARD_NO_TOKEN", "GENESIS_API_TOKEN ausente — sem como pedir licença ao guard.")
    req = urllib.request.Request(
        f"{base}{path}", data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode() or "{}")


def _merge(project_id: object, purpose: str | None, source: str | None) -> dict:
    sc = current_scope()
    # PROJECT_ID do env: o processo do runner é UM run de UM projeto (runner_server injeta).
    pid = as_project_id(project_id) or sc.get("project_id") or as_project_id(os.environ.get("PROJECT_ID"))
    return {
        "projectId": pid,
        "purpose": (purpose or sc.get("purpose") or "")[:120],
        "source": source or sc.get("source") or "agents",
        "systemId": sc.get("system_id"),
        "serviceId": sc.get("service_id"),
    }


def check(*, model: str, system: str = "", user: str = "", max_tokens: int = 8000,
          provider: str | None = None, project_id: object = None, purpose: str | None = None,
          source: str | None = None, llm_role: str | None = None,
          escalated_from: str | None = None, call_reason: str | None = None,
          call_task: object = None, call_stage: str | None = None,
          call_attempt: object = None) -> dict:
    """Pede licença. Devolve o contexto para o `record` ou LANÇA `LlmGuardDenied`."""
    ctx = _merge(project_id, purpose, source)
    ctx["promptHash"] = prompt_hash(model, system, user)
    ctx["model"] = model
    ctx["provider"] = provider
    # Plano 1.3: só com a flag ligada e papel válido. Sem papel ⇒ nenhuma chave (ledger grava NULL).
    if roles_mode() != "off":
        _r = normalize_role(llm_role)
        if _r:
            ctx["llmRole"] = _r
            ctx["effectiveRole"] = _r  # papel exigido = papel efetivo (ainda não há roteamento)
            _from = normalize_role(escalated_from)
            if _from:
                ctx["escalatedFrom"] = _from
    # Plano 1.4: só com WASTE_TELEMETRY ligada. Sem motivo válido ⇒ nenhuma chave (ledger grava NULL).
    if waste_mode() != "off":
        _why = normalize_reason(call_reason)
        if _why:
            ctx["callReason"] = _why
            if call_stage and ctx.get("projectId"):
                ctx["callIdemKey"] = idem_key(ctx["projectId"], call_task, call_stage, call_attempt)
    if _disabled():
        return ctx
    # ~4 caracteres por token: estimativa conservadora o bastante para a checagem de saldo.
    body = {**ctx, "maxOutputTokens": int(max_tokens or 0),
            "estInputTokens": (len(system or "") + len(user or "")) // 4}
    try:
        res = _post("/api/internal/llm-guard/preflight", body, timeout=15)
    except LlmGuardDenied:
        raise
    except Exception as exc:  # api fora / timeout / 401 ⇒ NEGA
        raise LlmGuardDenied("GUARD_UNREACHABLE", f"guard indisponível ({exc}) — chamada negada (fail-closed).",
                             ctx.get("projectId")) from exc
    if not res.get("allow"):
        code = str(res.get("code") or "DENIED")
        msg = str(res.get("message") or "chamada negada pelo guard de custo.")
        logger.warning("[llm-guard] NEGADO %s projeto=%s finalidade=%s: %s",
                       code, ctx.get("projectId"), ctx.get("purpose"), msg)
        raise LlmGuardDenied(code, msg, ctx.get("projectId"))
    if res.get("projectId") and not ctx.get("projectId"):
        ctx["projectId"] = res.get("projectId")
    return ctx


def record(ctx: dict, *, model: str | None = None, provider: str | None = None,
           input_tokens: int = 0, output_tokens: int = 0, cache_read_tokens: int = 0,
           cache_write_tokens: int = 0, duration_ms: int = 0) -> None:
    """Registra o gasto (tokens + USD calculado na api). Síncrono e curto; NUNCA lança."""
    if _disabled() or not ctx:
        return
    body = {
        **ctx, "model": model or ctx.get("model"), "provider": provider or ctx.get("provider"),
        "inputTokens": int(input_tokens or 0), "outputTokens": int(output_tokens or 0),
        "cacheReadTokens": int(cache_read_tokens or 0), "cacheWriteTokens": int(cache_write_tokens or 0),
        "durationMs": int(duration_ms or 0),
    }
    try:
        _post("/api/internal/llm-guard/record", body, timeout=10)
    except Exception as exc:
        logger.error("[llm-guard] FALHA ao registrar gasto (projeto=%s modelo=%s in=%s out=%s): %s",
                     ctx.get("projectId"), body["model"], input_tokens, output_tokens, exc)
