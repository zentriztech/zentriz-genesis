"""Valida output do Dev."""


def validate_dev_output(artifacts: list) -> list:
    errors = []

    if not artifacts:
        errors.append("Dev não produziu nenhum artifact")
        return errors

    for art in artifacts:
        path = art.get("path", "")
        content = art.get("content", "")

        if not path:
            errors.append("Artifact sem path")

        if not content or len(content) < 50:
            errors.append(f"{path}: conteúdo muito curto ({len(content)} chars)")

        # Placeholders proibidos
        forbidden = [
            "...",
            "// TODO",
            "// implementar",
            "/* TODO */",
            "// rest of",
            "// adicionar",
            "# TODO",
            "[...]",
        ]
        for placeholder in forbidden:
            if placeholder in content:
                errors.append(f"{path}: contém placeholder proibido '{placeholder}'")

    return errors
