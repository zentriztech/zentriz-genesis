"""Valida a proposta técnica do Engineer."""

import re


def validate_engineer_proposal(content: str) -> list:
    errors = []
    content_lower = content.lower()

    if not re.search(r"squad", content_lower):
        errors.append("Nenhuma squad mencionada na proposta")

    stack_keywords = ["next.js", "nextjs", "react", "html", "css", "typescript", "tailwind"]
    has_stack = any(kw in content_lower for kw in stack_keywords)
    if not has_stack:
        errors.append("Nenhuma stack web identificada (Next.js, React, HTML/CSS)")

    if not re.search(r"FR[-_]?\d+", content, re.IGNORECASE):
        errors.append("Nenhuma referência a FRs da spec")

    squad_mentions = len(re.findall(r"squad\s+\d|squad\s+\w+\s*:", content_lower))
    if squad_mentions > 2:
        errors.append(
            "Proposta tem %d squads para landing page estática (esperado 1, máximo 2)"
            % squad_mentions
        )

    return errors
