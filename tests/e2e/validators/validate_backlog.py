"""Valida o backlog gerado pelo PM."""

import re


def validate_backlog(content: str) -> list:
    errors = []
    content_lower = content.lower()

    # Deve conter pelo menos 3 tasks identificáveis
    task_patterns = [
        r"TASK[-_]?\w*[-_]?\d+",  # TASK-WEB-001
        r"#{2,4}\s+(?:Task|Tarefa)",  # ## Task 1
    ]

    task_count = 0
    for pattern in task_patterns:
        task_count += len(re.findall(pattern, content, re.IGNORECASE))

    if task_count < 3:
        errors.append(f"Apenas {task_count} tasks encontradas (mínimo 3)")

    # Deve conter acceptance criteria ou critérios de aceite
    if not re.search(r"(?:acceptance|aceite|critério|criteria)", content_lower):
        errors.append("Nenhum acceptance criteria encontrado nas tasks")

    # Deve referenciar FRs
    if not re.search(r"FR[-_]?\d+", content, re.IGNORECASE):
        errors.append("Nenhuma referência a FRs nas tasks")

    # Deve mencionar arquivos estimados
    if not re.search(r"(?:estimated_files|arquivos|\.tsx|\.ts|\.css|\.html)", content_lower):
        errors.append("Tasks não mencionam arquivos que serão produzidos")

    return errors
