"""spec_focus.py — GAP-54b: quem CONSTRÓI o produto também precisa LER a spec.

## O que estava MEDIDO (prod, 2026-09-08, projeto `e2a1988c` NVX LastMile — Backend)

O GAP-54 consertou a ponta da Bancada: o CTO passou a ler **12 de 12 arquivos verbatim** em 8
passes. A jusante, a conta é outra e é pior do que "cortado":

    árvore da spec ................ 1.067.990 chars em 12 arquivos
    Engineer / CTO ................ `product_spec` cortado em 97.066 chars = **9,1% do produto**
    PM ............................ **nada** — recebe `charter` (≤40.000), derivado da spec
    Dev / QA ...................... **nada** — recebem `charter` + `backlog` (≤40.000 cada)

Ou seja: o contrato do produto atravessa um **funil duplo** antes de chegar a quem escreve código —
spec (1.067.990) → `product_spec` (97.066) → charter (40.000) → backlog (40.000) → task. Quem
constrói nunca leu o contrato; leu um resumo de um resumo. E mesmo como leitor puro o teto de uma
string única seria 499.200 = 46,7%: **nenhum número salva a forma "uma string"**, é a mesma lição do
GAP-54 (o teto não era herdado, era a forma da chamada).

## A saída

O mesmo molde já provado duas vezes (dossiê do CTO no GAP-54; digest de irmãos no GAP-72→75): em vez
de um prefixo cego, cada papel recebe **MAPA de 100% dos arquivos** (cabeçalhos verbatim, baratos) +
**texto íntegro dos arquivos do SEU foco** + **a lista nomeada do que ficou fora**. O foco sai de
CITAÇÃO LITERAL do que o papel já tem em mãos (módulo, task, critérios de aceite) — transporte, igual
ao `context_budget.cited_paths`, nunca relevância inferida por heurística.

⚖️ LEI (Jean): estrutura, divisão e conteúdo de spec são decisão de AGENTE. Este módulo **não escolhe
relevância, não resume e não reescreve**: ele recorta em fronteira de arquivo, ordena pelo que o
agente CITOU e DECLARA o que não caberia. Quando ninguém citou nada, a ordem é a original da Bancada
— ausência de julgamento, não julgamento fixo disfarçado.

## Por que o orçamento é POR PAPEL (e não o teto de leitura para todos)

Revisão adversarial cross-família do plano (Nova Pro, 2026-09-08) levantou o custo como ataque, e ele
procede: o Dev é chamado **uma vez por task** — dezenas de vezes por projeto. Dar-lhe o teto de
leitura (499.200 chars ≈ 125k tokens) multiplicaria a conta do projeto inteiro por task. O Engineer é
chamado **uma vez** e precisa do produto todo; o Dev precisa dos arquivos da SUA task. Daí o
orçamento ser por papel e o FOCO fazer o trabalho, em vez de o teto.

## O que este módulo transporta além do texto (correção #1 do adversarial)

A Bancada decide, e persiste, **quem é a fonte única de cada contrato** (`specOracles`, GAP-22). Essa
decisão nunca chegava a jusante: a Bancada sabia que o oráculo de paginação é `contratos-erros.md` e
o Dev não. Dossiê sem a tabela de oráculos reabre a contradição na hora de escrever código. A tabela
é pequena, é FATO já decidido por agente, e viaja junto.
"""
from __future__ import annotations

import os

from orchestrator.spec_dossier import Dossier, SpecFile, build_dossier

#: Pisos de orçamento por papel, em chars de spec. Defaults deliberadamente CONSERVADORES:
#:   • ENGINEER = 0 → usa o teto de LEITURA do modelo (chamado uma vez, precisa do produto inteiro);
#:   • PM = 120.000 → chamado uma vez por módulo, precisa do escopo do módulo e dos contratos;
#:   • DEV/QA = 40.000 → chamados por task; 40.000 é a MESMA ordem de grandeza do `charter`/`backlog`
#:     que eles já recebem hoje, então o custo por chamada não muda de patamar — o que muda é o
#:     conteúdo passar a ser o CONTRATO em vez de um resumo de resumo.
_ROLE_BUDGET_ENV: dict[str, tuple[str, int]] = {
    "ENGINEER": ("SPEC_DOSSIER_ENGINEER_CHARS", 0),
    "PM": ("SPEC_DOSSIER_PM_CHARS", 120_000),
    "DEV": ("SPEC_DOSSIER_DEV_CHARS", 40_000),
    "QA": ("SPEC_DOSSIER_QA_CHARS", 40_000),
    "DEVOPS": ("SPEC_DOSSIER_DEVOPS_CHARS", 40_000),
}

#: Piso absoluto: abaixo disto o dossiê é só mapa e o texto não cabe nem parcial — pior que o
#: `charter` que o papel já tinha. Nesse caso preferimos não emitir nada e dizer por que.
MIN_USEFUL_BUDGET = 8_000


def enabled() -> bool:
    """`SPEC_DOSSIER_DOWNSTREAM=off` volta ao comportamento anterior ao GAP-54b, byte a byte."""
    return os.environ.get("SPEC_DOSSIER_DOWNSTREAM", "on").strip().lower() not in ("0", "off", "false", "no")


def role_budget(role: str, read_cap: int) -> int:
    """Orçamento de spec deste papel. `read_cap` é o teto de LEITURA do modelo (fim da escala).

    Um default 0 significa "use o teto de leitura" — é o caso do Engineer. Qualquer valor
    configurado é respeitado como está, e nunca passa do teto físico do modelo.
    """
    env_name, default = _ROLE_BUDGET_ENV.get(role.upper(), ("SPEC_DOSSIER_CHARS", 40_000))
    raw = os.environ.get(env_name, "").strip()
    want = int(raw) if raw.isdigit() and int(raw) > 0 else default
    if want <= 0:
        want = read_cap
    return max(0, min(want, read_cap)) if read_cap > 0 else want


def focus_labels(texts: list[str], labels: list[str]) -> list[str]:
    """Quais arquivos da spec o papel CITA no que já tem em mãos, na ordem em que aparecem.

    Transporte puro, delegado ao `context_budget.cited_paths` (que já resolve o casamento por
    caminho completo ou por basename com fronteira de palavra — GAP-73). Não há inferência de
    relevância aqui: um arquivo entra no foco porque alguém escreveu o nome dele.
    """
    from orchestrator.context_budget import cited_paths

    return cited_paths(texts, [l for l in labels if l])


def _oracle_block(oracles: list[dict] | None) -> list[str]:
    """Tabela de oráculos: fonte única de cada contrato, já DECIDIDA por agente na Bancada.

    Sem isto o Dev reabre a contradição que a Bancada fechou (GAP-22). É fato transportado, não
    decisão tomada aqui — e por isso só sai o que tem `contractKey` e `oraclePath`.
    """
    rows = []
    for o in oracles or []:
        if not isinstance(o, dict):
            continue
        key = str(o.get("contractKey") or o.get("contract_key") or "").strip()
        path = str(o.get("oraclePath") or o.get("oracle_path") or "").strip()
        if not key or not path:
            continue
        rule = str(o.get("ruleSummary") or o.get("rule_summary") or "").strip()
        rows.append(f"- **{key}** → fonte única: `{path}`" + (f" — {rule}" if rule else ""))
    if not rows:
        return []
    return [
        "=== FONTE ÚNICA DE CADA CONTRATO (decidido na Bancada — NÃO reabra) ===",
        "Se dois arquivos disserem coisas diferentes sobre um destes contratos, vale o arquivo abaixo.",
        *rows,
        "",
    ]


def build_role_dossier(
    role: str,
    files: list[SpecFile],
    *,
    read_cap: int,
    focus_texts: list[str] | None = None,
    oracles: list[dict] | None = None,
) -> tuple[str, Dossier | None]:
    """Dossiê da spec para um papel a JUSANTE. Devolve `(texto, contabilidade)`.

    `("", None)` significa "não há dossiê a emitir" — sem árvore, com a flag desligada, ou com
    orçamento abaixo do mínimo útil. O chamador então mantém exatamente o que fazia antes: esta
    função nunca degrada um caminho existente, ela só acrescenta contexto que não havia.
    """
    if not enabled() or not files:
        return "", None
    budget = role_budget(role, read_cap)
    if budget < MIN_USEFUL_BUDGET:
        return "", None

    labels = [f.label for f in files]
    focus = focus_labels(focus_texts or [], labels)
    dossier = build_dossier(files, budget=budget, focus=focus)
    if not dossier.text:
        return "", None

    head = [
        f"=== SPEC DO PRODUTO — SÓ LEITURA (dossiê de {role.upper()}) ===",
        "Este é o CONTRATO do produto: é o que a Bancada especificou e é contra isto que a entrega "
        "será medida. Você NÃO reescreve a spec — você constrói a partir dela.",
        "Se o que você precisa aparece só no MAPA (sem texto íntegro), DIGA que faltou em vez de "
        "supor o conteúdo: inventar contrato é pior do que declarar a lacuna.",
    ]
    if focus:
        head.append("Foco deste dossiê (arquivos citados no seu escopo): " + ", ".join(focus))
    head.append("")
    return "\n".join(head + _oracle_block(oracles) + [dossier.text]), dossier


def coverage_row(role: str, dossier: Dossier | None, *, budget: int) -> dict:
    """Contabilidade falsificável do que o papel REALMENTE recebeu (L4).

    `map_coverage`/`text_coverage` vêm do próprio dossiê e caem quando o recorte morde — uma
    métrica que devolvesse 100% por construção não mediria nada (lição do GAP-42/43).
    """
    if dossier is None:
        return {"role": role, "emitted": False, "budget": budget}
    return {
        "role": role,
        "emitted": True,
        "budget": budget,
        "files_total": dossier.files,
        "files_verbatim": len([l for l in dossier.included if l not in dossier.partial]),
        "partial": list(dossier.partial),
        "omitted": list(dossier.omitted),
        "map_coverage": round(dossier.map_coverage, 4),
        # Medido em prod (2026-09-08): com 40.000 de orçamento o mapa do Dev indexava 7 de 12 e os
        # outros 5 saíam sem sequer serem NOMEADOS — omissão indistinguível de inexistência. O piso
        # de nomeação fechou isso, e este número é a prova (lido do texto, não da intenção).
        "name_coverage": round(dossier.name_coverage, 4),
        "text_coverage": round(dossier.text_coverage, 4),
        "chars_used": dossier.used,
        "chars_total": dossier.total,
    }
