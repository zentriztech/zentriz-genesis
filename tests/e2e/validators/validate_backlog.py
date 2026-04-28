"""Valida o backlog gerado pelo PM."""

import re

# Limites de tasks por complexity_hint (inclusive)
TASK_LIMITS = {
    "trivial": (1, 1),    # exatamente 1 task
    "low":     (1, 7),    # FAST-TRACK: máx 7
    "medium":  (1, 12),   # FULL limitado: máx 12
    "high":    (1, 999),  # FULL: sem limite
}
TASK_MIN_DEFAULT = 3  # mínimo quando complexity_hint ausente


def _count_tasks(content: str) -> int:
    """Conta tasks pelo padrão TSK-* ou ## Task / Tarefa."""
    patterns = [
        r"\bTSK[-_][A-Z]+[-_]\d+\b",   # TSK-WEB-001, TSK-TRIVIAL-001
        r"\bTASK[-_]?\w*[-_]?\d+\b",    # TASK-001
        r"#{2,4}\s+(?:Task|Tarefa)\s+\d+",
    ]
    ids: set = set()
    for p in patterns:
        for m in re.finditer(p, content, re.IGNORECASE):
            ids.add(m.group(0).upper())
    return len(ids) if ids else 0


def validate_backlog(content: str, complexity_hint: str = "") -> list:
    errors = []
    content_lower = content.lower()
    hint = complexity_hint.lower().strip() if complexity_hint else ""

    # ── Contagem de tasks ─────────────────────────────────────────────────────
    task_count = _count_tasks(content)

    if hint and hint in TASK_LIMITS:
        min_tasks, max_tasks = TASK_LIMITS[hint]
        if task_count < min_tasks:
            errors.append(
                f"Backlog com {task_count} tasks — complexity_hint='{hint}' exige pelo menos {min_tasks}."
            )
        if task_count > max_tasks:
            errors.append(
                f"Backlog superdimensionado: {task_count} tasks geradas, "
                f"mas complexity_hint='{hint}' limita a {max_tasks} "
                f"({'TRIVIAL' if hint == 'trivial' else 'FAST-TRACK' if hint == 'low' else 'FULL limitado' if hint == 'medium' else 'FULL'}). "
                f"O PM pode ter ignorado o complexity_hint e usado fallback por palavras-chave."
            )
    else:
        if task_count < TASK_MIN_DEFAULT:
            errors.append(f"Apenas {task_count} tasks encontradas (mínimo {TASK_MIN_DEFAULT})")

    # ── Acceptance criteria ───────────────────────────────────────────────────
    if not re.search(r"(?:acceptance|aceite|critério|criteria)", content_lower):
        errors.append("Nenhum acceptance criteria encontrado nas tasks")

    # ── Referência a FRs ──────────────────────────────────────────────────────
    if not re.search(r"FR[-_]?\d+", content, re.IGNORECASE):
        errors.append("Nenhuma referência a FRs nas tasks")

    # ── Arquivos estimados ────────────────────────────────────────────────────
    if not re.search(r"(?:estimated_files|arquivos|\.tsx|\.ts|\.css|\.html|\.py)", content_lower):
        errors.append("Tasks não mencionam arquivos que serão produzidos")

    # ── depends_on_files obrigatório ──────────────────────────────────────────
    if not re.search(r"depends_on_files", content_lower):
        errors.append("Backlog sem depends_on_files — Dev não receberá contexto seletivo")

    return errors
