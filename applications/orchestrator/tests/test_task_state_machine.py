"""
Testes para TaskStateMachine (LEI 9).
"""
import pytest


def test_task_state_machine_valid_transitions():
    from orchestrator.task_state_machine import TaskStateMachine, VALID_TRANSITIONS
    sm = TaskStateMachine("T1", "PENDING")
    assert sm.state == "PENDING"
    assert sm.transition("IN_PROGRESS", "Monitor acionou Dev") is True
    assert sm.state == "IN_PROGRESS"
    assert sm.transition("IN_REVIEW", "Dev entregou") is True
    assert sm.state == "IN_REVIEW"
    assert sm.transition("DONE", "QA aprovou") is True
    assert sm.state == "DONE"
    assert len(sm.history) == 3


def test_task_state_machine_qa_fail_rework_then_blocked():
    from orchestrator.task_state_machine import TaskStateMachine, MAX_REWORK_BEFORE_BLOCKED
    sm = TaskStateMachine("T2", "IN_REVIEW")
    for _ in range(MAX_REWORK_BEFORE_BLOCKED):
        assert sm.transition("QA_FAIL", "QA rejeitou") is True
        assert sm.state == "IN_PROGRESS"
        assert sm.transition("IN_REVIEW", "Dev reentregou") is True
    assert sm.transition("QA_FAIL", "Terceira falha") is True
    assert sm.state == "BLOCKED"
    assert sm.rework_count == 3


def test_task_state_machine_invalid_transition():
    from orchestrator.task_state_machine import TaskStateMachine
    sm = TaskStateMachine("T3", "PENDING")
    assert sm.transition("DONE", "?") is False
    assert sm.state == "PENDING"