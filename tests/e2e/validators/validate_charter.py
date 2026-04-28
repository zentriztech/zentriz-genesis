"""Valida o Project Charter do CTO."""

import re

VALID_COMPLEXITY_HINTS = {"trivial", "low", "medium", "high"}


def validate_charter(content: str) -> list:
    errors = []
    content_lower = content.lower()

    if not re.search(r"(?:visão|vision|objetivo|goal)", content_lower):
        errors.append("Charter sem seção de visão/objetivo")

    if not re.search(r"squad", content_lower):
        errors.append("Charter sem referência a squads")

    if not re.search(r"\bpm\b", content_lower):
        errors.append("Charter sem menção a PM")

    if not re.search(r"(?:FR[-_]?\d+|spec|requisito|funcional)", content, re.IGNORECASE):
        errors.append("Charter sem referência a FRs ou spec")

    if not re.search(r"(?:escopo|scope|priorid|priority|mvp)", content_lower):
        errors.append("Charter sem escopo ou prioridades definidas")

    # BLOCKER: complexity_hint obrigatório — PM usa como âncora primária para FAST-TRACK vs FULL
    hint_match = re.search(
        r"complexity_hint[*\s]*[:\|][*\s]*(trivial|low|medium|high)",
        content,
        re.IGNORECASE,
    )
    if not hint_match:
        errors.append(
            "Charter sem complexity_hint [BLOCKER] — inclua a seção:\n"
            "## Complexity Hint\n"
            "**complexity_hint:** trivial | low | medium | high\n"
            "**routes_estimated:** N\n"
            "**reasoning:** <1 linha>"
        )
    else:
        hint_value = hint_match.group(1).lower()
        if hint_value not in VALID_COMPLEXITY_HINTS:
            errors.append(
                f"complexity_hint inválido: '{hint_value}'. "
                f"Valores aceitos: {', '.join(sorted(VALID_COMPLEXITY_HINTS))}"
            )

    return errors
