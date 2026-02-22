"""Valida o Project Charter do CTO."""

import re


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

    return errors
