"""product_architect.py — Product Architect em MODO INFERÊNCIA (ADR-018 / Cenário A).

Recebe um master markdown (produto descrito em PROSA) + a lista de specs presentes no
ZIP e **PROPÕE** um manifesto PRODUCT.json (grafo de projetos). O manifesto proposto passa
por gates DETERMINÍSTICOS (JSON válido, campos obrigatórios, tipos conhecidos, specs
existentes, DAG sem ciclo) ANTES de ser devolvido. O guardrail central do Cenário A:

    NUNCA decompõe-e-executa. Apenas PROPÕE (needs_human=True). A execução (criação de
    produto + projetos) só acontece depois que um humano aprova a proposta e ela é ingerida
    pelo caminho determinístico (productDecomposer no api-node).

A chamada de LLM é INJETÁVEL (`llm_fn`) — por padrão usa `call_bedrock_direct`, mas nos
testes recebe um stub, tornando este módulo verificável SEM Bedrock ao vivo.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Callable, Optional

# Tipos canônicos aceitos no manifesto (espelha VALID_TYPES do productManifest.ts).
VALID_TYPES = {
    "lib_ts", "backend_api_nestjs", "backend_api", "backend_api_node",
    "backend_api_python", "backend_graphql", "backend_worker",
    "frontend_dashboard", "frontend_landing", "fullstack_saas",
    "mobile_expo", "mobile_crossplatform", "other",
}

SYSTEM_PROMPT_PATH = Path(__file__).resolve().parents[1] / "agents" / "product_architect" / "SYSTEM_PROMPT.md"
SPLIT_SYSTEM_PROMPT_PATH = Path(__file__).resolve().parents[1] / "agents" / "product_architect" / "SPLIT_SYSTEM_PROMPT.md"

# Conteúdo mínimo aceitável para a spec de um projeto (evita specs vazias/triviais do LLM).
MIN_SPEC_CONTENT_CHARS = 80


class ManifestProposalError(Exception):
    """Erro estruturado quando a proposta do LLM não passa nos gates determinísticos."""

    def __init__(self, code: str, message: str, details: Optional[dict] = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def _load_split_system_prompt() -> str:
    try:
        return SPLIT_SYSTEM_PROMPT_PATH.read_text(encoding="utf-8")
    except OSError:
        # Fallback embutido — o módulo não deve quebrar se o arquivo não existir ainda.
        return (
            "Você é o Product Architect em modo SPLITTER. Dado UM documento em prosa, decomponha o "
            "produto em N projetos interdependentes. Para cada projeto emita id, spec (specs/<id>.md), "
            "type, dependsOn e specContent (a spec markdown COMPLETA daquele projeto). Use APENAS tipos "
            "válidos. O grafo dependsOn deve ser um DAG (sem ciclo). specApproved=false. Responda só o JSON."
        )


def _load_system_prompt() -> str:
    try:
        return SYSTEM_PROMPT_PATH.read_text(encoding="utf-8")
    except OSError:
        # Fallback embutido — o módulo não deve quebrar se o arquivo não existir ainda.
        return (
            "Você é o Product Architect. Dado um produto descrito em prosa e a lista de specs "
            "presentes, proponha um PRODUCT.json com product{name,systemId,specApproved,"
            "deliveryDefault} e projects[{id,spec,type,dependsOn}]. Use APENAS specs presentes. "
            "O grafo dependsOn deve ser um DAG (sem ciclo). Responda só o JSON."
        )


def build_prompt(master_md: str, present_specs: list[str]) -> str:
    """Monta a mensagem de usuário: prosa do produto + specs disponíveis + contrato de saída."""
    specs_block = "\n".join(f"- {s}" for s in sorted(present_specs)) or "(nenhuma spec no ZIP)"
    types_block = ", ".join(sorted(VALID_TYPES))
    return (
        "# Produto (descrição em prosa)\n\n"
        f"{master_md.strip()}\n\n"
        "# Specs presentes no ZIP (use SOMENTE estes caminhos no campo `spec`)\n\n"
        f"{specs_block}\n\n"
        "# Tipos de projeto válidos\n\n"
        f"{types_block}\n\n"
        "# Sua tarefa\n\n"
        "Proponha um PRODUCT.json decompondo o produto em projetos interdependentes. "
        "Formato EXATO (responda somente o JSON, sem cercas de código):\n"
        '{"schemaVersion":"1.1.0","product":{"name":"...","systemId":"...",'
        '"specApproved":false,"deliveryDefault":"source_only"},'
        '"projects":[{"id":"...","spec":"specs/....md","type":"<um tipo válido>","dependsOn":[],'
        '"stack":["nodejs"],"deployTarget":"none"}]}\n'
        "Regras: cada `spec` DEVE estar na lista de specs presentes; `dependsOn` referencia "
        "apenas `id`s deste manifesto; o grafo deve ser um DAG (sem ciclo); libs/contracts "
        "(type lib_ts) são predecessores dos consumidores. Campos `stack` (tecnologias "
        "principais, ex.: nodejs, nextjs, mysql) e `deployTarget` (aws-ecs | aws-lambda | "
        "s3-cloudfront | none) são OPCIONAIS — quando souber, preencha; `id` em kebab-case "
        "minúsculo ([a-z0-9-])."
    )


def _extract_json(raw: str) -> dict:
    """Extrai o objeto JSON da resposta do LLM (tolera cercas ```json e texto ao redor)."""
    text = raw.strip()
    # Remove cercas de código se houver.
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    else:
        # Pega do primeiro { ao último } balanceando de forma simples.
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            text = text[start:end + 1]
    try:
        obj = json.loads(text)
    except json.JSONDecodeError as e:
        raise ManifestProposalError("PROPOSAL_INVALID_JSON", f"LLM não retornou JSON válido: {e}")
    if not isinstance(obj, dict):
        raise ManifestProposalError("PROPOSAL_INVALID_JSON", "Proposta não é um objeto JSON.")
    return obj


def validate_proposal(manifest: dict, present_specs: list[str]) -> None:
    """Gates DETERMINÍSTICOS sobre a proposta. Lança ManifestProposalError no primeiro erro.

    Espelha buildProductSketch (productManifest.ts): campos obrigatórios, tipos válidos,
    specs presentes, dependsOn sem órfão/self, e DAG (Kahn) sem ciclo.
    """
    present = {s.replace("./", "") for s in present_specs}

    product = manifest.get("product")
    if not isinstance(product, dict) or not str(product.get("name") or "").strip():
        raise ManifestProposalError("PROPOSAL_NO_PRODUCT", "Proposta sem product.name.")

    projects = manifest.get("projects")
    if not isinstance(projects, list) or not projects:
        raise ManifestProposalError("PROPOSAL_NO_PROJECTS", "Proposta sem projects (mínimo 1).")

    ids = [str(p.get("id") or "") for p in projects]
    if any(not i for i in ids):
        raise ManifestProposalError("PROPOSAL_MISSING_ID", "Há projeto sem `id`.")
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise ManifestProposalError("PROPOSAL_DUPLICATE_ID", f"IDs duplicados: {', '.join(sorted(dupes))}")
    # RFC-0004 T1.6 (auditoria finding 9): ids viram nome de pasta/arquivo (spec_root,
    # <id>.md) — charset restrito fecha traversal/nome inválido ANTES de tocar disco.
    # Espelho TS: parseManifest (productManifest.ts). Retry do splitter cobre a rejeição.
    _ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")
    bad_ids = [i for i in ids if not _ID_RE.fullmatch(i)]
    if bad_ids:
        raise ManifestProposalError(
            "PROPOSAL_INVALID_ID",
            f"IDs fora do padrão [a-z0-9][a-z0-9_-]{{0,40}}: {', '.join(sorted(bad_ids))}",
        )
    id_set = set(ids)

    for p in projects:
        pid = p["id"]
        ptype = p.get("type")
        if ptype not in VALID_TYPES:
            raise ManifestProposalError("PROPOSAL_INVALID_TYPE", f'Projeto "{pid}": tipo inválido "{ptype}".',
                                        {"validTypes": sorted(VALID_TYPES)})
        spec = str(p.get("spec") or "").replace("./", "")
        if spec not in present:
            raise ManifestProposalError("PROPOSAL_SPEC_MISSING", f'Projeto "{pid}": spec "{p.get("spec")}" não está no ZIP.')
        for dep in p.get("dependsOn") or []:
            if dep == pid:
                raise ManifestProposalError("PROPOSAL_SELF_DEP", f'Projeto "{pid}" depende de si mesmo.')
            if dep not in id_set:
                raise ManifestProposalError("PROPOSAL_DEP_ORPHAN", f'Projeto "{pid}": dependsOn "{dep}" não existe.')

    # DAG via Kahn — detecta ciclo.
    deps = {p["id"]: set(p.get("dependsOn") or []) for p in projects}
    remaining = set(ids)
    while True:
        ready = [i for i in remaining if not (deps[i] & remaining)]
        if not ready:
            break
        remaining -= set(ready)
    if remaining:
        raise ManifestProposalError("PROPOSAL_CYCLE",
                                    f"Ciclo de dependências envolvendo: {', '.join(sorted(remaining))}. Deve ser um DAG.")


def infer_manifest(
    master_md: str,
    present_specs: list[str],
    llm_fn: Optional[Callable[[str, str, str], str]] = None,
    model_id: str = "us.anthropic.claude-sonnet-4-6",
) -> dict:
    """Propõe (NÃO executa) um manifesto a partir da prosa do produto.

    Retorna {"manifest": <dict validado>, "needs_human": True, "warnings": [...]}.
    `needs_human` é SEMPRE True — a proposta exige aprovação humana antes de ingerir.

    `llm_fn(system, user, model_id) -> str` é injetável (default: call_bedrock_direct).
    Lança ManifestProposalError se a proposta falhar nos gates determinísticos.
    """
    if llm_fn is None:
        from orchestrator.agents.runtime import call_bedrock_direct  # import tardio (evita dep de SDK nos testes)
        llm_fn = call_bedrock_direct

    system = _load_system_prompt()
    user = build_prompt(master_md, present_specs)
    raw = llm_fn(system, user, model_id)

    manifest = _extract_json(raw)
    validate_proposal(manifest, present_specs)

    warnings: list[str] = []
    # Aviso: proposta inferida nasce specApproved=False (humano precisa revisar e aprovar).
    product = manifest.get("product", {})
    if product.get("specApproved") is True:
        product["specApproved"] = False
        warnings.append("specApproved forçado a false: proposta inferida exige revisão humana antes de aprovar specs.")

    return {"manifest": manifest, "needs_human": True, "warnings": warnings}


# ── MODO SPLITTER: 1 documento grande → N specs geradas + grafo ────────────────

def build_split_prompt(master_md: str) -> str:
    """Monta a mensagem de usuário do SPLITTER: o documento inteiro + contrato de saída.

    Diferença vs. build_prompt (modo inferência): NÃO recebe specs presentes — o LLM GERA
    o conteúdo de cada spec (campo specContent) além do grafo.
    """
    types_block = ", ".join(sorted(VALID_TYPES))
    return (
        "# Documento do produto (prosa — pode ser longo)\n\n"
        f"{master_md.strip()}\n\n"
        "# Tipos de projeto válidos\n\n"
        f"{types_block}\n\n"
        "# Sua tarefa\n\n"
        "Decomponha ESTE produto em projetos interdependentes. Para CADA projeto gere também a "
        "spec markdown COMPLETA no campo `specContent`. Formato EXATO (responda somente o JSON, "
        "sem cercas de código):\n"
        '{"schemaVersion":"1.1.0","product":{"name":"...","systemId":"...",'
        '"specApproved":false,"deliveryDefault":"source_only"},'
        '"projects":[{"id":"...","spec":"specs/<id>.md","type":"<um tipo válido>",'
        '"dependsOn":[],"specContent":"# ...spec markdown completa..."}]}\n'
        "Regras: `id`s únicos; `spec` = `specs/<id>.md`; `dependsOn` referencia apenas `id`s "
        "deste manifesto; o grafo deve ser um DAG (sem ciclo); libs/contracts (type lib_ts) são "
        "predecessores dos consumidores; `specContent` é a spec inteira, não um resumo.\n"
        "CIENTE DE INFRA: se o produto usa infra compartilhada (banco/cache/fila/worker) ou tem "
        "≥2 componentes, modele a infra como projeto dedicado `<slug>-infra` (type `other`, onda 0, "
        "com esquema/env/portas e a ESTRATÉGIA DE DISTRIBUIÇÃO — docker-compose single-host OU "
        "Terraform/gerenciado) OU embuta uma seção `## Infraestrutura, Dependências e Distribuição` "
        "no backend; se a distribuição for ambígua, assuma docker-compose single-host, marque "
        "`Premissa:` e registre a pergunta em `## Decisões em Aberto`. NUNCA deixe infra implícita."
    )


def _split_manifest_and_specs(proposal: dict) -> tuple[dict, dict]:
    """Separa a proposta do SPLITTER em (manifest limpo, specs).

    `manifest` tem os projetos SEM o campo specContent (formato canônico PRODUCT.json).
    `specs` é {caminho_da_spec: conteúdo_markdown}. Valida presença/tamanho do specContent e
    unicidade do caminho `spec` por projeto (uma spec por projeto, sem colisão).
    """
    projects = proposal.get("projects")
    if not isinstance(projects, list) or not projects:
        raise ManifestProposalError("PROPOSAL_NO_PROJECTS", "Proposta sem projects (mínimo 1).")

    specs: dict[str, str] = {}
    clean_projects: list[dict] = []
    seen_paths: set[str] = set()
    for p in projects:
        if not isinstance(p, dict):
            raise ManifestProposalError("PROPOSAL_INVALID_JSON", "Projeto não é um objeto.")
        pid = str(p.get("id") or "").strip()
        spec_path = str(p.get("spec") or "").replace("./", "").strip()
        if not spec_path:
            raise ManifestProposalError("PROPOSAL_SPEC_MISSING", f'Projeto "{pid or "?"}": sem caminho `spec`.')
        if spec_path in seen_paths:
            raise ManifestProposalError("PROPOSAL_SPEC_DUPLICATE_PATH",
                                        f'Caminho de spec duplicado entre projetos: "{spec_path}".')
        content = p.get("specContent")
        if not isinstance(content, str) or len(content.strip()) < MIN_SPEC_CONTENT_CHARS:
            raise ManifestProposalError("PROPOSAL_EMPTY_SPEC",
                                        f'Projeto "{pid or "?"}": specContent ausente ou trivial '
                                        f"(mínimo {MIN_SPEC_CONTENT_CHARS} caracteres).")
        seen_paths.add(spec_path)
        specs[spec_path] = content
        clean = {k: v for k, v in p.items() if k != "specContent"}
        clean["spec"] = spec_path
        clean_projects.append(clean)

    manifest = {k: v for k, v in proposal.items() if k != "projects"}
    manifest["projects"] = clean_projects
    return manifest, specs


def split_document(
    master_md: str,
    llm_fn: Optional[Callable[[str, str, str], str]] = None,
    model_id: str = "us.anthropic.claude-sonnet-4-6",
) -> dict:
    """SPLITTER: a partir de UM documento grande, PROPÕE (NÃO executa) N specs + o grafo.

    Retorna {"manifest": <dict>, "specs": {path: content}, "needs_human": True, "warnings": [...]}.
    `needs_human` é SEMPRE True — a proposta (specs geradas + grafo) exige aprovação humana antes
    de ingerir pelo caminho determinístico (productDecomposer no api-node).

    `llm_fn(system, user, model_id) -> str` é injetável (default: call_bedrock_direct).
    Lança ManifestProposalError se a proposta falhar nos gates determinísticos (os MESMOS do
    modo inferência: tipos válidos, dependsOn sem órfão/self/ciclo — reusa validate_proposal).
    """
    if llm_fn is None:
        from orchestrator.agents.runtime import call_bedrock_direct  # import tardio (evita dep de SDK nos testes)
        llm_fn = call_bedrock_direct

    system = _load_split_system_prompt()
    user = build_split_prompt(master_md)
    raw = llm_fn(system, user, model_id)

    proposal = _extract_json(raw)
    manifest, specs = _split_manifest_and_specs(proposal)

    # Gates determinísticos reusados: as specs geradas são as "specs presentes".
    validate_proposal(manifest, list(specs.keys()))

    warnings: list[str] = []
    product = manifest.get("product", {})
    if product.get("specApproved") is True:
        product["specApproved"] = False
        warnings.append("specApproved forçado a false: proposta do splitter exige revisão humana antes de aprovar specs.")

    return {"manifest": manifest, "specs": specs, "needs_human": True, "warnings": warnings}
