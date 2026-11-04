"""
change_kind.py — Fase 4 (tarefa 4.1) do plano EVOLUIR-PROJETO-BANCADA: tipo do card e origem da spec na fábrica.

O tipo do card (`evolution` | `fix` | `feature`) chega ao filho por `projects.extra.ticket_kind` (gravado no claim; NÃO vem
do frontmatter da spec). A origem da spec é `initial` (spec inicial do produto) ou `card:TK-NNNN` (spec nova, nascida de
um card). Este módulo só DERIVA esses valores e monta o texto que o runner entrega ao CTO/PM/Dev; quem decide é o LLM,
no slot do tenant (lei: Genesis é 100% LLM — aqui não há decisão automática, só contexto).

Invariantes:
  * o tipo ACRESCENTA exigências; nenhum tipo dispensa o gate de RFC (continua invariante, no api-node);
  * sem tipo e sem origem (projeto comum / evolução legada sem card) a função devolve vazio — prompt byte-idêntico ao anterior;
  * o formato do ID de task NÃO muda (o regex do backlog segue em runner.py); o vínculo com o card vai em coluna própria.
"""
from __future__ import annotations

import re
from typing import Any

KINDS = ("evolution", "fix", "feature")
SPEC_ORIGIN_INITIAL = "initial"
_CARD_ORIGIN_RE = re.compile(r"^card:(TK-\d{4,})$")
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

_KIND_RULES = {
    "fix": (
        "TIPO DO CARD = CORREÇÃO. Além das regras de evolução: (1) o critério de aceite central é o teste de reprodução "
        "(FAIL_TO_PASS) — ele falha antes da correção e passa depois; planeje primeiro a task que o escreve/confirma; "
        "(2) a mudança deve ser MÍNIMA (patch): corrija a causa, sem refatorar, sem renomear, sem recurso novo; "
        "(3) compatibilidade no máximo patch — nada de mudança de contrato; (4) não crie tasks fora do que o defeito exige."
    ),
    "feature": (
        "TIPO DO CARD = RECURSO NOVO. Além das regras de evolução: respeite a seção `Non-goals` da spec do card — tudo o que "
        "ela lista está FORA DE ESCOPO e não pode virar task, arquivo nem comportamento; não antecipe recursos futuros."
    ),
    # evolution: rito atual, sem exigência adicional
}


def normalize_kind(value: Any) -> str | None:
    """`extra.ticket_kind` → um de KINDS, ou None (ausente/desconhecido = rito atual, sem exigência extra)."""
    v = str(value or "").strip().lower()
    return v if v in KINDS else None


def ticket_code(number: Any) -> str | None:
    """Mesmo formato de `ticketCode` do api-node (TK-0001)."""
    try:
        n = int(number)
    except (TypeError, ValueError):
        return None
    return f"TK-{n:04d}" if n > 0 else None


def derive_change_context(extra: dict | None) -> dict:
    """De `projects.extra` do filho → {ticket_kind, spec_origin, card_id, origin_spec_file}.

    Só há origem derivada quando há card (`ticket_id`/`ticket_number`): `card:TK-NNNN`. Projeto sem card ⇒ tudo None
    (a origem `initial` só é afirmada explicitamente por quem chama; ver `change_kind_instruction`)."""
    ex = extra if isinstance(extra, dict) else {}
    kind = normalize_kind(ex.get("ticket_kind"))
    code = ticket_code(ex.get("ticket_number"))
    tid = ex.get("ticket_id")
    card_id = tid if isinstance(tid, str) and _UUID_RE.match(tid) else None
    origin = f"card:{code}" if code and card_id else None
    return {
        "ticket_kind": kind,
        "spec_origin": origin,
        "card_id": card_id,
        "origin_spec_file": f"tickets/{code}/request.md" if origin else None,
    }


def change_kind_instruction(kind: str | None, spec_origin: str | None) -> str:
    """Texto entregue ao CTO/PM/Dev. Vazio se não há tipo nem origem (prompt inalterado)."""
    kind = normalize_kind(kind)
    parts: list[str] = []
    origin = (spec_origin or "").strip()
    m = _CARD_ORIGIN_RE.match(origin)
    if m:
        parts.append(
            f"ORIGEM DA SPEC = NOVA (derivada do card {m.group(1)}). A spec do card descreve SOMENTE o delta sobre a versão "
            "corrente. As tasks `TSK-INH-*` (já DONE) são trabalho entregue: NÃO as refaça, NÃO as replaneje e NÃO as "
            f"renumere. Crie apenas tasks `TSK-EVO-*` para o delta e cite o card {m.group(1)} no backlog."
        )
    elif origin == SPEC_ORIGIN_INITIAL:
        parts.append(
            "ORIGEM DA SPEC = INICIAL. A spec descreve o produto inteiro (não há trabalho entregue anterior a preservar): "
            "planeje o backlog completo, sem tasks herdadas."
        )
    rule = _KIND_RULES.get(kind or "")
    if rule:
        parts.append(rule)
    elif kind == "evolution" and parts:
        parts.append("TIPO DO CARD = EVOLUÇÃO: rito padrão de evolução, sem exigência adicional.")
    if not parts:
        return ""
    parts.append("O gate de RFC não é dispensado por nenhum tipo.")
    return "\n".join(parts)


def change_kind_inputs(kind: str | None, spec_origin: str | None) -> dict:
    """Campos de `inputs` para CTO/PM/Dev. {} quando não há tipo nem origem."""
    text = change_kind_instruction(kind, spec_origin)
    if not text:
        return {}
    out: dict = {"change_kind_instruction": text}
    if normalize_kind(kind):
        out["ticket_kind"] = normalize_kind(kind)
    if spec_origin:
        out["spec_origin"] = spec_origin
    return out
