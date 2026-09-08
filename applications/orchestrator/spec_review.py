"""spec_review.py — GAP-54: a revisão da spec pela Fábrica passa a cobrir 100% do TEXTO.

O `spec_dossier` resolveu o MAPA: o agente passou a saber o que existe em todos os arquivos. Faltava
o TEXTO — e nenhum orçamento de uma única chamada dá conta de 1.098.849 chars (~275k tokens, acima
da janela de 200k). O teto não é um número herdado, é a FORMA da chamada: uma chamada só.

Então a revisão deixa de ser UMA chamada sobre a spec inteira e passa a ser N chamadas, cada uma com
um dossiê próprio, até que **todo arquivo tenha sido lido VERBATIM em ao menos um passe**.

O PLANO DE PASSES é derivado da medição, não de um número escolhido:

    passe 1 ....... dossiê sem foco — mapa completo + os arquivos que couberem, na ordem da Bancada
    passes 2..N ... um por arquivo que ficou FORA do passe 1, com foco nele
    spec que cabe .. exatamente 1 passe, idêntico ao de hoje

A última linha é a que importa para o custo: projeto pequeno não paga nada a mais. No NVX
(12 arquivos, 1,1 M chars) o plano dá 8 passes em vez de 12, porque o passe 1 já entregou 5 arquivos
íntegros. Ninguém escolheu "8": é consequência do que cabe.

⚖️ LEI (Jean): sem LLM a ação FALHA, sem fallback burro. Aqui isso significa que `review_fn` é
obrigatória e que uma falha de passe não é silenciada — ela entra em `failures` e o chamador decide.
Este módulo não julga conteúdo: ele reparte a leitura, agrega perguntas (D3) e presta contas da
cobertura.

E a régua de honestidade do A5.7/GAP-45: a cobertura relatada é a MEDIDA, arquivo por arquivo. Um
arquivo que só apareceu no mapa NÃO conta como coberto — foi exatamente esse tipo de contabilidade
generosa que produziu o "21 → 1 GAP" do GAP-13.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Callable

from orchestrator.spec_dossier import Dossier, SpecFile, build_dossier, parse_spec_blocks

logger = logging.getLogger(__name__)

#: Teto de passes. Existe para que um produto absurdo não vire uma conta absurda — mas o corte é
#: DECLARADO em `uncovered`, nunca silencioso. Env `SPEC_REVIEW_MAX_PASSES`.
DEFAULT_MAX_PASSES = 16


def _max_passes() -> int:
    try:
        return max(1, int(os.environ.get("SPEC_REVIEW_MAX_PASSES", str(DEFAULT_MAX_PASSES))))
    except ValueError:
        return DEFAULT_MAX_PASSES


@dataclass
class ReviewPass:
    """Um passe de revisão: o dossiê enviado e o que o agente devolveu."""

    index: int
    focus: str
    dossier: Dossier
    response: dict | None = None
    error: str = ""

    @property
    def ok(self) -> bool:
        return self.error == "" and isinstance(self.response, dict)


@dataclass
class SpecReviewResult:
    """O resultado agregado, com a contabilidade que permite auditar a decisão."""

    passes: list[ReviewPass] = field(default_factory=list)
    covered: list[str] = field(default_factory=list)
    partial: list[str] = field(default_factory=list)
    uncovered: list[str] = field(default_factory=list)
    questions: list[str] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)
    total_files: int = 0
    total_chars: int = 0

    @property
    def text_coverage(self) -> float:
        """Fração dos ARQUIVOS lidos verbatim em algum passe. Parcial NÃO conta como coberto."""
        return 1.0 if self.total_files == 0 else len(self.covered) / self.total_files

    @property
    def complete(self) -> bool:
        """Todo arquivo foi lido íntegro em algum passe E nenhum passe falhou.

        É esta a condição que o oráculo executável precisa checar antes de transformar uma falha de
        build em GAP da spec: numa spec que chegou truncada, TODA "lacuna de contrato" é consequência
        do truncamento, e realimentá-la envenenaria a spec com GAPs fantasmas.
        """
        return not self.uncovered and not self.partial and not self.failures


def plan_review_passes(
    files: list[SpecFile], *, budget: int, max_passes: int | None = None
) -> list[tuple[str, Dossier]]:
    """Devolve `[(foco, dossiê)]`: o mínimo de passes para ler TODO arquivo verbatim.

    Foco `""` é o passe sem foco (ordem da Bancada). Não há passe redundante: um arquivo que já veio
    íntegro no passe 1 não ganha passe próprio.
    """
    if not files:
        return []
    cap = max_passes if max_passes is not None else _max_passes()

    first = build_dossier(files, budget=budget)
    plan: list[tuple[str, Dossier]] = [("", first)]
    pending = [lbl for lbl in first.omitted]
    # Um arquivo que veio PARCIAL no passe 1 não está lido: ele volta para a fila com foco próprio,
    # onde o dossiê gasta o orçamento inteiro nele.
    pending += [lbl for lbl in first.partial if lbl not in pending]

    for label in pending:
        if len(plan) >= cap:
            break
        plan.append((label, build_dossier(files, budget=budget, focus=[label])))
    return plan


def review_spec_per_file(
    spec_content: str,
    *,
    budget: int,
    review_fn: Callable[[str, str, Dossier], dict],
    extract_questions: Callable[[dict | None], list[str]] | None = None,
    max_passes: int | None = None,
) -> SpecReviewResult:
    """Revisa a spec em N passes, cada um com seu dossiê, e presta contas da cobertura.

    `review_fn(focus, dossier_text, dossier) -> dict` é a chamada ao agente. Obrigatória: sem LLM a
    ação falha (⚖️ LEI do Jean), e é por isso que não existe parâmetro `None` aqui.
    """
    files = parse_spec_blocks(spec_content)
    result = SpecReviewResult(
        total_files=len(files), total_chars=sum(sf.chars for sf in files)
    )
    if not files:
        return result

    plan = plan_review_passes(files, budget=budget, max_passes=max_passes)
    covered: set[str] = set()
    partial: set[str] = set()

    for i, (focus, dossier) in enumerate(plan, start=1):
        rp = ReviewPass(index=i, focus=focus, dossier=dossier)
        try:
            rp.response = review_fn(focus, dossier.text, dossier)
        except Exception as exc:  # noqa: BLE001 — a falha é REGISTRADA, não engolida
            rp.error = f"{type(exc).__name__}: {exc}"
            logger.warning("[spec_review] Passe %d (foco=%s) falhou: %s", i, focus or "-", rp.error)
        result.passes.append(rp)

        if rp.ok:
            # Um arquivo só conta como lido quando o passe que o trouxe DEU CERTO. Contar o dossiê
            # enviado em vez da resposta recebida seria medir o passe, não o resultado (GAP-42/43).
            covered.update(lbl for lbl in dossier.included if lbl not in dossier.partial)
            partial.update(dossier.partial)
            if extract_questions:
                for q in extract_questions(rp.response) or []:
                    if q not in result.questions:
                        result.questions.append(q)
        else:
            result.failures.append(f"passe {i} (foco={focus or 'sem foco'}): {rp.error or 'resposta inválida'}")

    labels = [sf.label for sf in files]
    result.covered = [lbl for lbl in labels if lbl in covered]
    result.partial = [lbl for lbl in labels if lbl in partial and lbl not in covered]
    result.uncovered = [lbl for lbl in labels if lbl not in covered and lbl not in partial]
    return result
