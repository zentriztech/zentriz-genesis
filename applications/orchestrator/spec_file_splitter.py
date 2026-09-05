"""spec_file_splitter.py — F2/PR-3: divide UMA spec monolítica em vários arquivos, por AGENTES.

Problema (medido em prod 2026-09-05): a spec do NVX LastMile tem 98.045 chars. Toda revisão do CTO
reemitia o documento inteiro e batia no teto de 64.000 tokens de SAÍDA do Opus 5 — `stop_reason=
max_tokens` voltava como `status: OK` e o modo autônomo aplicava a spec mutilada (14 → 7 seções).
O F1 (formato `edits`) reduz a saída; o F2 ataca o outro lado: com a spec repartida por tema, cada
rodada de melhoria toca UM arquivo e cabe com folga.

LEI (Jean, 2026-09-05): "estrutura de pastas, conteúdo e divisão de arquivos devem ser feitos por
LLM inteligente, nunca por automações fixas que não pensam". Por isso a divisão é uma CADEIA DE
AGENTES, não um algoritmo:

    PASSO 1 — Spec Architect  → decide a estrutura (saída pequena: o PLANO).
    PASSO 2 — N Spec Writers  → 1 chamada por arquivo, cada um ELABORA o conteúdo do seu arquivo
                                 (+1 chamada para o ÍNDICE, que substitui a spec monolítica).

O que este módulo faz de determinístico é só TRANSPORTE e INTEGRIDADE: recortar o texto das seções
que o próprio LLM nomeou, checar que nenhuma seção ficou órfã (relatório de cobertura), validar
nomes de arquivo e vetar entrega trivial. Nada aqui escolhe conteúdo, nome ou agrupamento — e não
existe fallback sem LLM: sem modelo, a ação falha e reporta.

Molde reusado: `product_architect.py::split_document` (mesmo par arquiteto+redatores, mesmo
`_extract_json`, mesmo fan-out com retry). Guardrail idêntico: PROPÕE, nunca executa — quem grava é
a api-node, depois do humano aprovar na Bancada.
"""
from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Optional

from orchestrator.product_architect import (
    MIN_SPEC_CONTENT_CHARS,
    SPLITTER_FANOUT,
    _extract_json,
    _sleep_backoff,
)

PLAN_SYSTEM_PROMPT_PATH = Path(__file__).resolve().parents[1] / "agents" / "spec_architect" / "PLAN_SYSTEM_PROMPT.md"
WRITER_SYSTEM_PROMPT_PATH = Path(__file__).resolve().parents[1] / "agents" / "spec_architect" / "WRITER_SYSTEM_PROMPT.md"

#: Teto de arquivos que o plano pode propor. Bem abaixo do teto da árvore de spec
#: (`SPEC_TREE_MAX_FILES` = 200 na api) porque acima de ~16 a leitura humana se perde.
SPEC_SPLIT_MAX_FILES = max(2, int(os.environ.get("SPEC_SPLIT_MAX_FILES", "16") or 16))

#: Piso de seções para valer a pena dividir: com 1 seção não há o que repartir.
SPEC_SPLIT_MIN_SECTIONS = max(2, int(os.environ.get("SPEC_SPLIT_MIN_SECTIONS", "4") or 4))

#: Nome de arquivo do plano: kebab-case `.md`, com no máximo UM nível de pasta.
_NAME_RE = re.compile(r"^(?:[a-z0-9][a-z0-9-]{0,40}/)?[a-z0-9][a-z0-9-]{0,60}\.md$")

#: A fábrica é quem escreve o índice (no arquivo primário existente) — o plano não pode reivindicá-lo.
_RESERVED_NAMES = {"readme.md", "index.md", "product_spec.md", "connect.yaml"}


class SpecSplitError(Exception):
    """Falha de gate na proposta de divisão. `code` é estável e viaja até a UI."""

    def __init__(self, code: str, message: str, details: Optional[dict] = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}


# ── Transporte: recorte do Markdown por seção de nível 2 ──────────────────────────────────────────

_FENCE_RE = re.compile(r"^\s*(```|~~~)")
_H2_RE = re.compile(r"^##\s+(?!#)(.+?)\s*$")


def split_markdown_sections(md: str) -> tuple[str, list[dict]]:
    """Divide o Markdown em (preâmbulo, seções de nível 2).

    Preâmbulo = tudo antes do primeiro `## ` (título `#`, versão, autoria). Cada seção é
    `{"heading", "title", "body"}`, onde `body` inclui a própria linha do heading — recortar é
    transporte: quem decidiu o que é uma unidade de assunto foi quem escreveu a spec.

    Linhas dentro de blocos de código (``` ou ~~~) NUNCA são tratadas como heading: um exemplo de
    Markdown embutido não pode inventar uma seção fantasma.
    """
    lines = (md or "").splitlines()
    preamble: list[str] = []
    sections: list[dict] = []
    current: Optional[dict] = None
    in_fence = False
    fence_marker = ""
    for line in lines:
        fence = _FENCE_RE.match(line)
        if fence:
            marker = fence.group(1)
            if not in_fence:
                in_fence, fence_marker = True, marker
            elif marker == fence_marker:
                in_fence, fence_marker = False, ""
        m = None if in_fence else _H2_RE.match(line)
        if m:
            current = {"heading": line.rstrip(), "title": m.group(1).strip(), "lines": [line.rstrip()]}
            sections.append(current)
        elif current is not None:
            current["lines"].append(line)
        else:
            preamble.append(line)
    for s in sections:
        s["body"] = "\n".join(s.pop("lines")).strip()
    return "\n".join(preamble).strip(), sections


def _norm_title(raw: str) -> str:
    """Normaliza um título para casar o que o LLM citou com o heading real.

    Tolera o que um modelo naturalmente varia: `##` na frente, numeração, acento, caixa, espaços
    repetidos e pontuação final. NÃO tolera texto diferente — casar por aproximação semântica seria
    o código adivinhando a intenção do agente.
    """
    import unicodedata

    s = (raw or "").strip()
    s = re.sub(r"^#+\s*", "", s)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower().strip()
    s = re.sub(r"^\d+(\.\d+)*[.)\-–]?\s*", "", s)  # "3. Modelo de dados" → "modelo de dados"
    s = re.sub(r"[\s_]+", " ", s)
    return s.strip(" .:—-")


# ── PASSO 1 — o Arquiteto de Spec ─────────────────────────────────────────────────────────────────

def _load(path: Path, what: str) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError as e:
        raise SpecSplitError("SPEC_SPLIT_PROMPT_MISSING", f"System prompt do {what} indisponível: {e}") from e


def build_plan_prompt(
    spec_md: str,
    sections: list[dict],
    project_name: str = "",
    project_type: str = "",
    uncovered_feedback: Optional[list[str]] = None,
) -> str:
    """Mensagem do PASSO 1: a spec inteira + o índice numerado + o contrato de saída.

    O arquiteto recebe a spec COMPLETA (a decisão de estrutura exige ler tudo); são os REDATORES
    que recebem apenas as seções designadas — é o passo 2 que se multiplica por N, não este.
    """
    index = "\n".join(f"{i + 1}. {s['title']}" for i, s in enumerate(sections))
    head = ""
    if project_name or project_type:
        head = f"Projeto: {project_name or '(sem nome)'}" + (f" · tipo: {project_type}\n\n" if project_type else "\n\n")
    retry = ""
    if uncovered_feedback:
        retry = (
            "\n# CORREÇÃO OBRIGATÓRIA da sua tentativa anterior\n\n"
            "Estas seções ficaram SEM destino no plano que você devolveu. Toda seção precisa aparecer "
            "em `sections` de pelo menos um arquivo. Refaça o plano cobrindo TODAS:\n"
            + "\n".join(f"- {t}" for t in uncovered_feedback)
            + "\n"
        )
    return (
        f"{head}# Spec atual (monolítica — {len(spec_md)} caracteres)\n\n"
        f"{spec_md.strip()}\n\n"
        f"# Índice das seções desta spec ({len(sections)} seções de nível 2)\n\n"
        f"{index}\n\n"
        f"# Limites desta fábrica\n\n"
        f"- Máximo de {SPEC_SPLIT_MAX_FILES} arquivos no plano (o índice NÃO conta: é gerado à parte).\n"
        f"- Nomes: kebab-case `.md`, no máximo um nível de pasta. Proibidos: "
        f"{', '.join(sorted(_RESERVED_NAMES))}.\n"
        f"{retry}\n"
        "# Sua tarefa (PASSO 1 — só o PLANO; o conteúdo é escrito no PASSO 2)\n\n"
        "Responda SOMENTE o JSON {rationale, indexPurpose, files:[{name,title,purpose,sections}]} "
        "no formato do system prompt (sem cercas de código)."
    )


def _validate_plan(plan: dict, sections: list[dict], warnings: list[str]) -> dict:
    """Gates determinísticos do plano: shape, nomes, tetos e COBERTURA.

    Só recusa o que é corrupção ou perda (nome inválido, arquivo sem seção, seção órfã). Não opina
    sobre agrupamento — a decisão é do arquiteto.
    """
    files = plan.get("files")
    if not isinstance(files, list) or not files:
        raise SpecSplitError("SPEC_SPLIT_PLAN_EMPTY", "O plano não trouxe arquivos (`files` vazio).")
    if len(files) > SPEC_SPLIT_MAX_FILES:
        raise SpecSplitError(
            "SPEC_SPLIT_TOO_MANY_FILES",
            f"O plano propôs {len(files)} arquivos — o teto desta fábrica é {SPEC_SPLIT_MAX_FILES}.",
        )

    by_norm: dict[str, list[dict]] = {}
    for s in sections:
        by_norm.setdefault(_norm_title(s["title"]), []).append(s)

    clean: list[dict] = []
    seen_names: set[str] = set()
    covered: set[str] = set()
    for raw in files:
        if not isinstance(raw, dict):
            raise SpecSplitError("SPEC_SPLIT_PLAN_INVALID", "Item de `files` não é um objeto.")
        name = str(raw.get("name") or "").strip().lower()
        if not _NAME_RE.fullmatch(name):
            raise SpecSplitError("SPEC_SPLIT_BAD_FILENAME",
                                 f'Nome de arquivo inválido no plano: "{raw.get("name")}".')
        if name in _RESERVED_NAMES or Path(name).name in _RESERVED_NAMES:
            raise SpecSplitError("SPEC_SPLIT_RESERVED_FILENAME",
                                 f'Nome reservado no plano: "{name}" (o índice é gerado pela fábrica).')
        if name in seen_names:
            raise SpecSplitError("SPEC_SPLIT_DUPLICATE_FILENAME", f'Arquivo duplicado no plano: "{name}".')
        seen_names.add(name)

        wanted = raw.get("sections")
        wanted = [str(x) for x in wanted if str(x).strip()] if isinstance(wanted, list) else []
        matched: list[dict] = []
        for title in wanted:
            hits = by_norm.get(_norm_title(title))
            if not hits:
                warnings.append(f'Arquivo "{name}": seção "{title}" não existe na spec atual — ignorada.')
                continue
            for s in hits:
                covered.add(s["heading"])
                if not any(s is m for m in matched):  # identidade: dois headings iguais são seções distintas
                    matched.append(s)
        if not matched:
            raise SpecSplitError(
                "SPEC_SPLIT_FILE_WITHOUT_SECTIONS",
                f'Arquivo "{name}" ficou sem nenhuma seção de origem válida — plano inutilizável.',
            )
        clean.append({
            "name": name,
            "title": str(raw.get("title") or name),
            "purpose": str(raw.get("purpose") or "").strip(),
            "sections": [s["title"] for s in matched],
            "_matched": matched,
        })

    uncovered = [s["title"] for s in sections if s["heading"] not in covered]
    return {
        "rationale": str(plan.get("rationale") or "").strip(),
        "indexPurpose": str(plan.get("indexPurpose") or "").strip(),
        "files": clean,
        "uncovered": uncovered,
    }


# ── PASSO 2 — os Redatores ────────────────────────────────────────────────────────────────────────

def build_writer_prompt(
    plan: dict,
    target: Optional[dict],
    preamble: str,
    project_name: str = "",
) -> str:
    """Mensagem do PASSO 2. `target=None` ⇒ está escrevendo o ÍNDICE (o arquivo primário)."""
    outline = [
        {"name": f["name"], "title": f.get("title"), "purpose": f.get("purpose"), "sections": f.get("sections")}
        for f in plan.get("files") or []
    ]
    head = (
        f"# Plano aprovado no PASSO 1 (contexto — NÃO redecida a estrutura)\n\n"
        f"Projeto: {project_name or '(sem nome)'}\n"
        f"Racional: {plan.get('rationale') or '(sem racional)'}\n"
        f"Arquivos do plano:\n{json.dumps(outline, ensure_ascii=False, indent=2)}\n\n"
    )
    if target is None:
        return (
            head
            + "# VOCÊ ESTÁ ESCREVENDO O ÍNDICE\n\n"
            + f"Propósito declarado pelo arquiteto: {plan.get('indexPurpose') or 'porta de entrada da spec'}\n\n"
            + "# Preâmbulo da spec original (texto antes da primeira seção — preserve o que informa)\n\n"
            + (preamble.strip() or "(a spec original não tinha preâmbulo)")
            + "\n\nEste arquivo SUBSTITUI a spec monolítica: ele aponta para os arquivos do plano, "
              "não repete o conteúdo deles. Responda SOMENTE o JSON {content}."
        )
    material = "\n\n".join(s["body"] for s in target.get("_matched") or [])
    return (
        head
        + f"# SEU ARQUIVO: `{target['name']}` — {target.get('title')}\n\n"
        + f"Propósito: {target.get('purpose') or '(sem propósito declarado)'}\n"
        + f"Seções da spec atual designadas a você: {', '.join(target.get('sections') or [])}\n\n"
        + "# Material de origem (texto INTEGRAL das suas seções — nada aqui pode ser perdido)\n\n"
        + material
        + "\n\nResponda SOMENTE o JSON {content} no formato do system prompt."
    )


def _write_one(
    plan: dict,
    target: Optional[dict],
    preamble: str,
    project_name: str,
    llm_fn: Callable[[str, str, str], str],
    model_id: str,
    warnings: list[str],
) -> str:
    """1 chamada (com 1 retry) para UM arquivo. Devolve o conteúdo Markdown."""
    label = target["name"] if target else "(índice)"
    system = _load(WRITER_SYSTEM_PROMPT_PATH, "redator de spec")
    user = build_writer_prompt(plan, target, preamble, project_name)
    last: Optional[Exception] = None
    for attempt in range(2):
        try:
            out = _extract_json(llm_fn(system, user, model_id))
            content = out.get("content")
            if not isinstance(content, str) or len(content.strip()) < MIN_SPEC_CONTENT_CHARS:
                raise SpecSplitError(
                    "SPEC_SPLIT_EMPTY_FILE",
                    f'Arquivo "{label}": conteúdo ausente ou trivial (mínimo {MIN_SPEC_CONTENT_CHARS} caracteres).',
                )
            return content.strip() + "\n"
        except Exception as e:  # noqa: BLE001 — parse, rede, throttling: a 2ª tentativa costuma passar
            last = e
            if attempt == 0:
                warnings.append(f'Arquivo "{label}": passo 2 falhou ({type(e).__name__}) — repetindo 1x.')
                _sleep_backoff()
                continue
            code = getattr(e, "code", None) or "SPEC_SPLIT_WRITER_FAILED"
            raise SpecSplitError(code, f'Arquivo "{label}": redação falhou: {e}') from e
    raise SpecSplitError("SPEC_SPLIT_WRITER_FAILED", f'Arquivo "{label}": {last}')


# ── Orquestração ──────────────────────────────────────────────────────────────────────────────────

def split_spec_into_files(
    spec_md: str,
    llm_fn: Optional[Callable[[str, str, str], str]] = None,
    model_id: str = "us.anthropic.claude-sonnet-4-6",
    project_name: str = "",
    project_type: str = "",
) -> dict:
    """Divide a spec em arquivos com 1 chamada de arquiteto + (N+1) de redatores. PROPÕE, não grava.

    Retorno:
        {
          "plan":     {rationale, indexPurpose, files:[{name,title,purpose,sections}]},
          "index":    "<conteúdo do arquivo primário — o índice>",
          "files":    {"<name>": "<conteúdo>"},
          "coverage": [{"section","targets":[...]}],   # relatório, uma linha por seção da origem
          "warnings": [...],
          "needs_human": True,
          "sourceChars": <int>, "producedChars": <int>
        }

    Lança `SpecSplitError` quando a proposta é inutilizável (spec sem seções, plano vazio/inválido,
    seção órfã, arquivo trivial). Não há caminho sem LLM: `llm_fn=None` usa `call_bedrock_direct`.
    """
    spec_md = spec_md or ""
    if len(spec_md.strip()) < MIN_SPEC_CONTENT_CHARS:
        raise SpecSplitError("SPEC_SPLIT_SOURCE_EMPTY", "A spec atual está vazia ou trivial — nada a dividir.")
    preamble, sections = split_markdown_sections(spec_md)
    if len(sections) < SPEC_SPLIT_MIN_SECTIONS:
        raise SpecSplitError(
            "SPEC_SPLIT_TOO_FEW_SECTIONS",
            f"A spec tem {len(sections)} seção(ões) de nível 2 (mínimo {SPEC_SPLIT_MIN_SECTIONS} para dividir). "
            "Enriqueça a spec antes de reparti-la.",
        )
    if llm_fn is None:
        from orchestrator.agents.runtime import call_bedrock_direct  # import tardio (SDK só em runtime)
        llm_fn = call_bedrock_direct

    warnings: list[str] = []

    # PASSO 1 — o plano. Uma seção órfã é feedback ao agente (1 retry), não um erro do humano.
    plan_system = _load(PLAN_SYSTEM_PROMPT_PATH, "arquiteto de spec")
    plan: dict = {}
    uncovered_feedback: Optional[list[str]] = None
    for attempt in range(2):
        raw_plan = _extract_json(llm_fn(plan_system, build_plan_prompt(
            spec_md, sections, project_name, project_type, uncovered_feedback), model_id))
        plan = _validate_plan(raw_plan, sections, warnings)
        if not plan["uncovered"]:
            break
        if attempt == 0:
            uncovered_feedback = plan["uncovered"]
            warnings.append(
                f"Plano da 1ª tentativa deixou {len(plan['uncovered'])} seção(ões) sem destino — "
                "pedindo correção ao arquiteto."
            )
            _sleep_backoff()
            continue
        raise SpecSplitError(
            "SPEC_SPLIT_UNCOVERED_SECTIONS",
            "O plano deixou seções da spec sem destino (o conteúdo seria perdido): "
            + "; ".join(plan["uncovered"][:10]),
            {"uncovered": plan["uncovered"]},
        )

    # PASSO 2 — N redatores + o índice, em paralelo (cada saída é pequena: cabe sem truncar).
    targets: list[Optional[dict]] = [*plan["files"], None]
    per_file_warnings: dict[str, list[str]] = {(t["name"] if t else "__index__"): [] for t in targets}

    def _one(t: Optional[dict]) -> tuple[str, str]:
        key = t["name"] if t else "__index__"
        return key, _write_one(plan, t, preamble, project_name, llm_fn, model_id, per_file_warnings[key])

    produced: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=min(SPLITTER_FANOUT, max(1, len(targets)))) as pool:
        for key, content in pool.map(_one, targets):
            produced[key] = content
    for t in targets:
        warnings.extend(per_file_warnings[t["name"] if t else "__index__"])

    index = produced.pop("__index__")
    coverage = [
        {
            "section": s["title"],
            "chars": len(s["body"]),
            "targets": [f["name"] for f in plan["files"]
                        if any(s is m for m in (f.get("_matched") or []))],
        }
        for s in sections
    ]
    total = len(index) + sum(len(v) for v in produced.values())
    # Perda grosseira de material é integridade, não julgamento de estilo: o índice não repete o
    # conteúdo, então o total fica naturalmente perto (ou acima) da origem; metade indica arquivo
    # esvaziado por um redator que "resumiu".
    if total < len(spec_md) * 0.5:
        warnings.append(
            f"ATENÇÃO: o conjunto produzido tem {total} chars contra {len(spec_md)} da origem "
            "(<50%) — revise arquivo por arquivo antes de aplicar: pode haver conteúdo resumido."
        )
    for f in plan["files"]:
        f.pop("_matched", None)
    return {
        "plan": plan,
        "index": index,
        "files": produced,
        "coverage": coverage,
        "warnings": warnings,
        "needs_human": True,
        "sourceChars": len(spec_md),
        "producedChars": total,
    }
