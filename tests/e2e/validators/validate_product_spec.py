"""Valida o PRODUCT_SPEC gerado pelo CTO."""

import re


def validate_product_spec(content: str) -> list:
    """
    Retorna lista de erros. Lista vazia = válido.
    """
    errors = []

    required_sections = [
        ("Metadados", r"(?:metadados|metadata|## 0)"),
        ("Visão", r"(?:visão|vision|## 1)"),
        ("Personas|Jornadas", r"(?:persona|jornada|journey|## 2)"),
        ("Requisitos Funcionais", r"(?:requisitos?\s+funciona|functional\s+req|FR[-_]0|## 3)"),
        ("Requisitos Não-Funcionais", r"(?:n[aã]o[\s-]+funciona|non[\s-]+functional|NFR|## 4)"),
        ("Fora de escopo", r"(?:fora\s+de\s+escopo|out\s+of\s+scope|## 8)"),
    ]

    content_lower = content.lower()

    for section_name, pattern in required_sections:
        if not re.search(pattern, content_lower):
            errors.append("Seção obrigatória não encontrada: " + section_name)

    fr_count = len(re.findall(r"FR[-_]?\d+", content, re.IGNORECASE))
    if fr_count < 5:
        errors.append("Apenas %d FRs encontrados (mínimo 5 para esta spec)" % fr_count)

    nfr_count = len(re.findall(r"NFR[-_]?\d+", content, re.IGNORECASE))
    if nfr_count < 3:
        errors.append("Apenas %d NFRs encontrados (mínimo 3 para esta spec)" % nfr_count)

    has_acceptance = bool(
        re.search(
            r"(?:DADO|QUANDO|ENTÃO|GIVEN|WHEN|THEN|aceite|acceptance)",
            content,
            re.IGNORECASE,
        )
    )
    if not has_acceptance:
        errors.append("Nenhum critério de aceite encontrado (DADO/QUANDO/ENTÃO)")

    for keyword in ["hero", "serviço", "contato", "whatsapp", "footer"]:
        if keyword not in content_lower:
            errors.append("Keyword da spec não encontrada no output: '%s'" % keyword)

    return errors
