"""Fase 4 — correções AK (re-verificação AI): TSK-DEVOPS-001 do Passo 7 também recebe `card_id`."""
from pathlib import Path

import orchestrator.runner as runner


def test_n_runner_todo_post_de_tasks_passa_pelo_vinculo_ao_card():
    """Todo `{"tasks": ...}` enviado à API passa por `_link_tasks_to_card`, exceto o das herdadas (TSK-INH-*, nunca ligadas) e o de
    `_seed_tasks`, que liga a lista antes de montar o corpo. Falhava no Passo 7 (`_d7_task`)."""
    lines = Path(runner.__file__).read_text(encoding="utf-8").splitlines()
    offenders = []
    for i, line in enumerate(lines, 1):
        if '{"tasks"' not in line or "_link_tasks_to_card(" in line:
            continue
        ctx = "\n".join(lines[max(0, i - 30):i])
        if '{"tasks": inherited}' in line:
            continue
        if 'body = {"tasks": tasks}' in line and "tasks = _link_tasks_to_card(tasks, card_id, origin_spec_file)" in ctx:
            continue
        offenders.append(f"{i}: {line.strip()}")
    assert offenders == [], offenders


def test_n_runner_devops_passo7_recebe_card_id():
    body = runner._link_tasks_to_card([{"task_id": "TSK-DEVOPS-001", "taskId": "TSK-DEVOPS-001"}], "11111111-1111-1111-1111-111111111111", None)
    assert body[0]["card_id"] == "11111111-1111-1111-1111-111111111111"
