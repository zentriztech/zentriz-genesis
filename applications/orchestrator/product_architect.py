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
import os
from concurrent.futures import ThreadPoolExecutor

# Tipos canônicos aceitos no manifesto (espelha VALID_TYPES do productManifest.ts).
VALID_TYPES = {
    "lib_ts", "backend_api_nestjs", "backend_api", "backend_api_node",
    "backend_api_python", "backend_graphql", "backend_worker",
    "frontend_dashboard", "frontend_landing", "fullstack_saas",
    "mobile_expo", "mobile_crossplatform", "other",
}

SYSTEM_PROMPT_PATH = Path(__file__).resolve().parents[1] / "agents" / "product_architect" / "SYSTEM_PROMPT.md"
SPLIT_SYSTEM_PROMPT_PATH = Path(__file__).resolve().parents[1] / "agents" / "product_architect" / "SPLIT_SYSTEM_PROMPT.md"
SPLIT_PROJECT_FILES_PROMPT_PATH = Path(__file__).resolve().parents[1] / "agents" / "product_architect" / "SPLIT_PROJECT_FILES_PROMPT.md"

# Versão do contrato Connect `ProductManifest`/`SpecConnectDeclaration` emitido pelo splitter
# (R4 PR3). 1.3.0 = campos opcionais archetype/stack/deployTarget/rationale/files/connectDeclaration
# + schema novo spec-connect-declaration (ADR-013 Connect-local).
PRODUCT_MANIFEST_SCHEMA_VERSION = "1.3.0"

# Conteúdo mínimo aceitável para a spec de um projeto (evita specs vazias/triviais do LLM).
MIN_SPEC_CONTENT_CHARS = 80

# ── R4 PR3: enums do racional de corte (validados pós-parse; fora do enum → fallback + warning) ──
# Desintegradores/integradores (Ford & Richards, "Software Architecture: The Hard Parts", cap. 7);
# relações entre contexts (Context Mapper / Evans-Vernon). Ver SPLIT_SYSTEM_PROMPT.md §0.1/§4.2.
CUT_REASONS = {"service-scope", "code-volatility", "scalability-throughput", "fault-tolerance",
               "security", "extensibility", "shared-infra"}
MERGE_BLOCKERS = {"none", "database-transaction", "workflow-chattiness", "shared-code", "data-relationships"}
RELATIONSHIP_TYPES = {"shared-kernel", "partnership", "customer-supplier", "conformist",
                      "anticorruption-layer", "open-host-service", "published-language", "none"}
# Campos de racional que o LLM emite no passo 1 e que NÃO existem no schema Connect (são
# dobrados em `rationale` e removidos do manifesto antes de devolver).
_RATIONALE_RAW_FIELDS = ("summary", "cutReason", "mergeBlocker", "ishScore", "relationships")

# Arquivos temáticos do passo 2 → `kind` do ProductManifest.files[] (1.3.0).
FILE_KIND_BY_NAME = {
    "dominio-modelo.md": "domain-model",
    "requisitos.md": "requirements",
    "contratos.md": "contracts",
    "infra-deploy.md": "infra-deploy",
    "decisoes.md": "decisions",
}
_FILE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,60}\.md$")
# Nomes reservados: a fábrica gera README.md (manifesto autoral) e 01-spec.md (spec principal).
_RESERVED_FILE_NAMES = {"readme.md", "01-spec.md", "connect.yaml"}
# Fan-out do passo 2 (1 chamada LLM por projeto, em paralelo). RPM do Bedrock (Sonnet 4.6 = 10/min)
# → teto conservador; env SPLITTER_FANOUT permite ajustar por ambiente (inválido → default 4).
def _env_int(name: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.environ.get(name, str(default))))
    except (TypeError, ValueError):
        return default


SPLITTER_FANOUT = _env_int("SPLITTER_FANOUT", 4)
# Backoff do retry do passo 2 (segundos). Sob throttling (RPM), repetir no mesmo segundo falha de novo
# (adversarial PR3 #2). Env SPLITTER_RETRY_BACKOFF_S; 0 nos testes.
SPLITTER_RETRY_BACKOFF_S = _env_int("SPLITTER_RETRY_BACKOFF_S", 8, minimum=0)


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


def _load_project_files_prompt() -> str:
    try:
        return SPLIT_PROJECT_FILES_PROMPT_PATH.read_text(encoding="utf-8")
    except OSError:
        return (
            "Você é o Product Architect (passo 2 do splitter). Para o projeto indicado, escreva a spec "
            "markdown COMPLETA (`spec`), arquivos temáticos opcionais (`files`: dominio-modelo.md, "
            "requisitos.md, contratos.md, infra-deploy.md, decisoes.md — só os que fizerem sentido; nunca "
            "README.md) e a declaração Connect (`connect`: serviceName, responsibility, interfaces[], "
            "dependencies[], events, runtimeType, queues[], healthModel, environments[], "
            "integrationTierTarget). Responda só o JSON {spec, files, connect}."
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
        f'{{"schemaVersion":"{PRODUCT_MANIFEST_SCHEMA_VERSION}","product":{{"name":"...","systemId":"...",'
        '"specApproved":false,"deliveryDefault":"source_only"}},'
        '"projects":[{{"id":"...","spec":"specs/....md","type":"<um tipo válido>","dependsOn":[],'
        '"stack":["nodejs"],"deployTarget":"none"}}]}}\n'
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
    # R4 PR1 adversarial #5: 41→61 chars (nomes semânticos tipo `controle-financeiro-command-service`).
    _ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,60}$")
    bad_ids = [i for i in ids if not _ID_RE.fullmatch(i)]
    if bad_ids:
        raise ManifestProposalError(
            "PROPOSAL_INVALID_ID",
            f"IDs fora do padrão [a-z0-9][a-z0-9_-]{{0,60}}: {', '.join(sorted(bad_ids))}",
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
        "# Sua tarefa (PASSO 1 — manifesto; a spec completa de cada projeto é o PASSO 2)\n\n"
        "Decomponha ESTE produto em projetos interdependentes seguindo o MÉTODO do system prompt "
        "(enumerar candidatos → desintegradores × integradores → ISH → coarse-first). Para CADA "
        "projeto devolva `summary` (3-6 frases) + racional de corte (`cutReason`, `mergeBlocker`, "
        "`ishScore`, `relationships`). NÃO devolva `specContent`. Formato EXATO (responda somente o "
        "JSON, sem cercas de código):\n"
        f'{{"schemaVersion":"{PRODUCT_MANIFEST_SCHEMA_VERSION}","product":{{"name":"...","systemId":"...",'
        '"specApproved":false,"deliveryDefault":"source_only","rationale":"...",'
        '"connect":{"environments":[{"name":"prod","type":"prod","criticality":"high"}],'
        '"integrationTierTarget":"tier1-integration-ready"}},'
        '"projects":[{"id":"...","spec":"specs/<id>.md","type":"<um tipo válido>","dependsOn":[],'
        '"archetype":"...","stack":["..."],"deployTarget":"...","summary":"...",'
        '"cutReason":"<' + "|".join(sorted(CUT_REASONS)) + '>",'
        '"mergeBlocker":"<' + "|".join(sorted(MERGE_BLOCKERS)) + '>","ishScore":0,'
        '"relationships":[{"dependsOn":"<id>","type":"<' + "|".join(sorted(RELATIONSHIP_TYPES)) + '>"}]}]}\n'
        "Regras: `id`s únicos em kebab-case; `spec` = `specs/<id>.md`; `dependsOn` referencia apenas "
        "`id`s deste manifesto; o grafo deve ser um DAG (sem ciclo); libs/contracts (type lib_ts) são "
        "predecessores dos consumidores; `systemId` em kebab-case derivado do NOME do produto.\n"
        "CIENTE DE INFRA: se o produto usa infra compartilhada (banco/cache/fila/worker) ou tem "
        "≥2 componentes, modele a infra como projeto dedicado `<slug>-infra` (type `other`, onda 0, "
        "com esquema/env/portas e a ESTRATÉGIA DE DISTRIBUIÇÃO — docker-compose single-host OU "
        "Terraform/gerenciado) OU embuta uma seção `## Infraestrutura, Dependências e Distribuição` "
        "no backend; se a distribuição for ambígua, assuma docker-compose single-host, marque "
        "`Premissa:` e registre a pergunta em `## Decisões em Aberto`. NUNCA deixe infra implícita."
    )


def build_project_files_prompt(master_md: str, manifest: dict, project: dict) -> str:
    """Mensagem de usuário do PASSO 2: documento original + manifesto (contexto) + o projeto alvo."""
    product = manifest.get("product") or {}
    siblings = [
        {k: p.get(k) for k in ("id", "type", "dependsOn", "summary") if p.get(k) is not None}
        for p in (manifest.get("projects") or [])
    ]
    target = {k: v for k, v in project.items() if k not in ("relationships",)}
    return (
        "# Documento original do produto (prosa)\n\n"
        f"{master_md.strip()}\n\n"
        "# Manifesto já decidido no PASSO 1 (contexto — NÃO redecomponha)\n\n"
        f"Produto: {json.dumps({k: product.get(k) for k in ('name', 'systemId', 'rationale') if product.get(k)}, ensure_ascii=False)}\n"
        f"Projetos (irmãos): {json.dumps(siblings, ensure_ascii=False)}\n\n"
        "# PROJETO ALVO — escreva a spec completa, os arquivos temáticos e a declaração Connect DESTE projeto\n\n"
        f"{json.dumps(target, ensure_ascii=False, indent=2)}\n\n"
        "Responda SOMENTE o JSON {spec, files, connect} no formato do system prompt (sem cercas)."
    )


def _normalize_rationale(project: dict, warnings: list[str]) -> None:
    """Valida os enums do racional (pós-parse, determinístico) e dobra tudo em `rationale`.

    Campos crus (`summary`, `cutReason`, `mergeBlocker`, `ishScore`, `relationships`) NÃO existem
    no schema Connect (additionalProperties:false) → são removidos do projeto após a dobra.
    Fora do enum → fallback + warning visível ao humano (nunca erro fatal — a chamada é cara).
    """
    pid = str(project.get("id") or "?")
    cut = str(project.get("cutReason") or "").strip()
    if cut and cut not in CUT_REASONS:
        warnings.append(f'Projeto "{pid}": cutReason "{cut}" fora do enum → "service-scope".')
        cut = "service-scope"
    blocker = str(project.get("mergeBlocker") or "none").strip()
    if blocker not in MERGE_BLOCKERS:
        warnings.append(f'Projeto "{pid}": mergeBlocker "{blocker}" fora do enum → "none".')
        blocker = "none"
    ish_raw = project.get("ishScore")
    try:
        ish = int(ish_raw) if ish_raw is not None else None
        if ish is not None and not (0 <= ish <= 10):
            raise ValueError
    except (TypeError, ValueError):
        warnings.append(f'Projeto "{pid}": ishScore "{ish_raw}" inválido (0-10) → ignorado.')
        ish = None
    if ish is not None and ish < 5:
        warnings.append(f'Projeto "{pid}": ISH {ish}/10 < 5 — candidato a fusão com um vizinho; revise antes de aprovar.')
    if blocker != "none":
        warnings.append(f'Projeto "{pid}": integrador "{blocker}" presente — corte exige justificativa explícita.')
    rels: list[str] = []
    for r in project.get("relationships") or []:
        if not isinstance(r, dict):
            continue
        dep = str(r.get("dependsOn") or "").strip()
        rtype = str(r.get("type") or "none").strip()
        if rtype not in RELATIONSHIP_TYPES:
            warnings.append(f'Projeto "{pid}": relationship "{rtype}" fora do enum → "none".')
            rtype = "none"
        if dep:
            rels.append(f"{dep}={rtype}")
    parts = []
    if cut:
        parts.append(f"Corte: {cut}")
    parts.append(f"Integrador: {blocker}")
    if ish is not None:
        parts.append(f"ISH {ish}/10")
    if rels:
        parts.append("Relações: " + ", ".join(rels))
    summary = str(project.get("summary") or "").strip()
    existing = str(project.get("rationale") or "").strip()
    rationale = " · ".join(parts)
    tail = existing or summary
    project["rationale"] = f"{rationale} — {tail}" if tail else rationale
    for k in _RATIONALE_RAW_FIELDS:
        project.pop(k, None)


def _file_kind(name: str) -> str:
    return FILE_KIND_BY_NAME.get(name.lower(), "other")


def _validate_connect_declaration(decl: dict) -> list[str]:
    """Valida contra products/spec-connect-declaration.schema.json quando o schema está acessível
    (host/dev). Em container sem o repo irmão (até o snapshot ser vendorizado — PR 5) NÃO há
    validação: devolve 1 aviso EXPLÍCITO em vez de silêncio (adversarial PR3 #6)."""
    try:
        from orchestrator.connect_contracts import _schema_for, validate_connect_artifact
        if not _schema_for("SpecConnectDeclaration"):
            return ["declaração NÃO validada: schema Connect indisponível neste ambiente (ZENTRIZ_CONNECT_ROOT)."]
        return validate_connect_artifact("SpecConnectDeclaration", decl)
    except Exception as e:  # noqa: BLE001
        return [f"declaração NÃO validada: erro no validador ({type(e).__name__})."]


def _build_connect_declaration(product: dict, project: dict, connect: dict | None, warnings: list[str],
                               sibling_ids: set[str] | None = None) -> dict:
    """Monta a SpecConnectDeclaration do projeto: identidade vem do MANIFESTO (não do LLM)."""
    sibling_ids = sibling_ids or set()
    pid = str(project.get("id") or "").strip()
    system_id = str((product or {}).get("systemId") or "").strip()
    if not system_id:
        # Mesmo fallback do deriveSystemService (api-node): slug do nome do produto.
        system_id = re.sub(r"-{2,}", "-", re.sub(r"[^a-z0-9]+", "-", str(product.get("name") or "produto").lower())).strip("-")
        warnings.append(f"product.systemId ausente — derivado do nome: {system_id}.")
    src = dict(connect or {})
    for k in ("schemaVersion", "systemId", "serviceId", "owners"):
        src.pop(k, None)  # identidade/owners vêm do manifesto/tenant, nunca do LLM (falsa precisão)
    decl: dict = {
        "schemaVersion": PRODUCT_MANIFEST_SCHEMA_VERSION,
        "systemId": system_id,
        "serviceId": pid,
        "serviceName": str(src.pop("serviceName", "") or pid.replace("-", " ").title()),
        "responsibility": str(src.pop("responsibility", "") or project.get("rationale") or f"Responsabilidades do projeto {pid}."),
        "interfaces": [i for i in (src.pop("interfaces", None) or []) if isinstance(i, dict) and i.get("name") and i.get("type")],
    }
    for k in ("dependencies", "events", "runtimeType", "queues", "healthModel", "environments", "integrationTierTarget", "notes"):
        if k in src and src[k] not in (None, "", [], {}):
            decl[k] = src[k]
    if src:
        warnings.append(f'Projeto "{pid}": chaves Connect desconhecidas ignoradas: {", ".join(sorted(src))}.')
    # Coerência grafo × declaração: dependência declarada que é um irmão do manifesto mas NÃO está
    # em dependsOn indica aresta faltante no grafo (aviso; o humano decide na Bancada).
    deps = set(project.get("dependsOn") or [])
    for d in decl.get("dependencies") or []:
        if d in sibling_ids and d not in deps:
            warnings.append(f'Projeto "{pid}": connect.dependencies inclui "{d}" mas dependsOn não — aresta faltante no grafo?')
    errors = _validate_connect_declaration(decl)
    for e in errors:
        warnings.append(f'Projeto "{pid}": connect.yaml — {e}')
    return decl


def _sleep_backoff() -> None:
    if SPLITTER_RETRY_BACKOFF_S > 0:
        import time
        time.sleep(SPLITTER_RETRY_BACKOFF_S)


def _to_yaml(obj: dict) -> str:
    import yaml  # PyYAML (agents/requirements.txt)
    return yaml.safe_dump(obj, sort_keys=False, allow_unicode=True, default_flow_style=False)


def _generate_project_files(
    master_md: str,
    manifest: dict,
    project: dict,
    llm_fn: Callable[[str, str, str], str],
    model_id: str,
    warnings: list[str],
) -> tuple[dict[str, str], list[dict], str]:
    """PASSO 2 para UM projeto → (specs {path: content}, files[] do manifesto, connectDeclaration path).

    1 retry em falha de parse/conteúdo (chamada cara; a 2ª tentativa costuma corrigir JSON quebrado).
    """
    pid = str(project.get("id") or "").strip()
    system = _load_project_files_prompt()
    user = build_project_files_prompt(master_md, manifest, project)
    last_err: Exception | None = None
    for attempt in range(2):
        try:
            raw = llm_fn(system, user, model_id)
            out = _extract_json(raw)
            spec = out.get("spec")
            if not isinstance(spec, str) or len(spec.strip()) < MIN_SPEC_CONTENT_CHARS:
                raise ManifestProposalError("PROPOSAL_EMPTY_SPEC",
                                            f'Projeto "{pid}": spec ausente ou trivial (mínimo {MIN_SPEC_CONTENT_CHARS} caracteres).')
            specs: dict[str, str] = {str(project.get("spec") or f"specs/{pid}.md").replace("./", ""): spec}
            files_meta: list[dict] = []
            files = out.get("files") or {}
            if isinstance(files, dict):
                for name, content in files.items():
                    fname = str(name).strip()
                    if fname.lower() in _RESERVED_FILE_NAMES or not _FILE_NAME_RE.fullmatch(fname):
                        warnings.append(f'Projeto "{pid}": arquivo "{fname}" ignorado (nome reservado/inválido).')
                        continue
                    if not isinstance(content, str) or len(content.strip()) < MIN_SPEC_CONTENT_CHARS:
                        warnings.append(f'Projeto "{pid}": arquivo "{fname}" ignorado (conteúdo trivial).')
                        continue
                    path = f"specs/{pid}/{fname}"
                    specs[path] = content
                    files_meta.append({"path": path, "kind": _file_kind(fname)})
            decl = _build_connect_declaration(
                manifest.get("product") or {}, project,
                out.get("connect") if isinstance(out.get("connect"), dict) else None, warnings,
                sibling_ids={str(p.get("id")) for p in (manifest.get("projects") or []) if isinstance(p, dict)},
            )
            decl_path = f"specs/{pid}/connect.yaml"
            specs[decl_path] = _to_yaml(decl)
            files_meta.append({"path": decl_path, "kind": "connect-declaration"})
            return specs, files_meta, decl_path
        except ManifestProposalError as e:
            last_err = e
            if attempt == 0:
                warnings.append(f'Projeto "{pid}": passo 2 falhou ({e.code}) — repetindo 1x.')
                _sleep_backoff()
                continue
            raise
        except Exception as e:  # noqa: BLE001 — falha de rede/SDK/throttling
            last_err = e
            if attempt == 0:
                warnings.append(f'Projeto "{pid}": passo 2 falhou ({type(e).__name__}) — repetindo 1x após backoff.')
                _sleep_backoff()
                continue
            raise ManifestProposalError("PROPOSAL_PROJECT_FILES_FAILED", f'Projeto "{pid}": passo 2 falhou: {e}') from e
    raise ManifestProposalError("PROPOSAL_PROJECT_FILES_FAILED", f'Projeto "{pid}": {last_err}')


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
    warnings: list[str] = []
    projects_raw = proposal.get("projects") if isinstance(proposal.get("projects"), list) else []
    legacy = any(isinstance(p, dict) and "specContent" in p for p in projects_raw)

    if legacy:
        # Caminho LEGADO (1 chamada com specContent): preservado para modelos/prompts antigos e testes.
        manifest, specs = _split_manifest_and_specs(proposal)
        validate_proposal(manifest, list(specs.keys()))
        for p in manifest.get("projects") or []:
            if any(k in p for k in _RATIONALE_RAW_FIELDS):
                _normalize_rationale(p, warnings)
    else:
        # R4 PR3 — PASSO 1 (manifesto) validado ANTES de gastar N chamadas no PASSO 2.
        manifest = {k: v for k, v in proposal.items()}
        projects = [p for p in projects_raw if isinstance(p, dict)]
        for p in projects:
            pid = str(p.get("id") or "").strip()
            p["spec"] = str(p.get("spec") or (f"specs/{pid}.md" if pid else "")).replace("./", "")
        manifest["projects"] = projects
        validate_proposal(manifest, [p["spec"] for p in projects])
        for p in projects:
            _normalize_rationale(p, warnings)

        # PASSO 2 — 1 chamada por projeto, em paralelo (cabe no cap de saída; sem truncar JSON).
        specs = {}
        results: dict[str, tuple[dict[str, str], list[dict], str]] = {}
        proj_warnings: dict[str, list[str]] = {str(p["id"]): [] for p in projects}

        def _one(p: dict) -> tuple[str, tuple[dict[str, str], list[dict], str]]:
            pid = str(p["id"])
            return pid, _generate_project_files(master_md, manifest, p, llm_fn, model_id, proj_warnings[pid])

        with ThreadPoolExecutor(max_workers=min(SPLITTER_FANOUT, max(1, len(projects)))) as pool:
            for pid, res in pool.map(_one, projects):
                results[pid] = res
        for p in projects:
            pid = str(p["id"])
            p_specs, files_meta, decl_path = results[pid]
            specs.update(p_specs)
            if files_meta:
                p["files"] = files_meta
            p["connectDeclaration"] = decl_path
            warnings.extend(proj_warnings[pid])

    manifest["schemaVersion"] = PRODUCT_MANIFEST_SCHEMA_VERSION
    product = manifest.get("product", {})
    if product.get("specApproved") is True:
        product["specApproved"] = False
        warnings.append("specApproved forçado a false: proposta do splitter exige revisão humana antes de aprovar specs.")

    return {"manifest": manifest, "specs": specs, "needs_human": True, "warnings": warnings}
