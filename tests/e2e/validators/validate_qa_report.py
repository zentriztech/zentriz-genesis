"""Valida report do QA."""


def validate_qa_report(response: dict) -> list:
    errors = []

    status = response.get("status", "")

    if status not in ("QA_PASS", "QA_FAIL"):
        errors.append(
            f"QA retornou status inesperado: {status} (esperado QA_PASS ou QA_FAIL)"
        )

    if status == "QA_FAIL":
        summary = response.get("summary", "")
        if len(summary) < 50:
            errors.append("QA_FAIL sem summary detalhado")

        # Deve ter issues acionáveis
        artifacts = response.get("artifacts", [])
        has_issues = False
        for art in artifacts:
            content = art.get("content", "")
            if "issue" in content.lower() or "fail" in content.lower():
                has_issues = True

        if not has_issues and "issue" not in summary.lower():
            errors.append("QA_FAIL sem issues específicos (Dev não consegue corrigir)")

    return errors
