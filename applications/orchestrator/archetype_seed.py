"""
archetype_seed.py — ensina à FÁBRICA os arquétipos aprendidos na Bancada (GAP-69→75, 121, 122).

Popula `context_cache` (CAG) com, para cada papel da fábrica:
  • uma linha `category='package'`   → `systemPromptPrefix`, o texto do arquétipo (parágrafos);
  • uma linha `category='checklist'` → as regras em uma linha cada (bullets sempre visíveis).

Por que `context_cache` e não `lessons_corpus`: a recuperação de lições ordena por
`hit_count * confidence` (ver `context_loader._query_lessons_top_hits`), então lição NOVA
(hit_count 0) fica no fim da fila e pode nunca entrar no prompt. O `context_cache` é
determinístico por (role, stack_key, project_id) — é o veículo que garante entrega.

Idempotente: `INSERT ... ON CONFLICT (cache_key) DO UPDATE`. Pode rodar quantas vezes quiser.

Uso:
    python -m orchestrator.archetype_seed
    # dentro do container de agents/runner, com DATABASE_URL (ou PG* ) apontando para o Genesis

Requer: as mesmas condições do `checklist_seed.py` (tabela `context_cache`, migration 025).
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger(__name__)

# 1.2.0: + GAP-121 (pedido combinado sob orçamento) e GAP-122 (índice do conjunto)
# 1.3.0: + GAP-123 (teto pára de produzir, não de medir)
# 1.4.0: + GAP-124 (a validade é do TRECHO julgado, não do arquivo)
SCHEMA_VERSION = "1.5.0"  # 1.5.0: + GAP-125 (o último artefato não redefine o veredicto do trabalho)
STACK_KEY = "generic"  # vale para qualquer stack — o defeito é de CONTEXTO, não de linguagem

# Papéis que consomem CAG no pipeline (o loader recebe o papel em minúsculas).
ROLES = ("dev", "cto", "engineer", "pm", "qa", "monitor", "devops")


# ─────────────────────────────────────────────────────────────────────────────
# Catálogo — arquétipos MEDIDOS em produção na Bancada (GAP-69→75 em 2026-09-07; 121→125 em
# 2026-09-08). A contagem NÃO é escrita à mão em nenhum lugar: quem exibe usa `len(ARCHETYPES)`,
# senão o próprio arquivo que ensina "contagem não é prova" mentiria sobre a sua (dizia "nove"
# com doze no catálogo).
# ─────────────────────────────────────────────────────────────────────────────

ARCHETYPES: list[dict[str, Any]] = [
    {
        "slug": "arch.gap71.escrita-as-cegas",
        "title": "Nunca reescreva o que você não viu",
        "rule": (
            "Se um arquivo/documento chegou com a marca de CORTE, o que ficou de fora EXISTE. "
            "Entregar a versão 'completa' a partir do trecho visível apaga o resto — altere só o "
            "que a tarefa pede e declare o corte no `summary`."
        ),
        "evidence": (
            "Bancada: o marcador mudo `... [truncado]` fazia o agente concluir que tinha visto o "
            "documento inteiro. O sintoma na fábrica é o veto de não-regressão do runner "
            "(SÍMBOLOS REMOVIDOS) — a causa é o corte não declarado."
        ),
    },
    {
        "slug": "arch.gap72.ordem-do-gasto",
        "title": "A ORDEM do gasto de contexto é uma decisão, não um detalhe",
        "rule": (
            "O que a tarefa CITA vem primeiro e tem reserva própria. Gastar o orçamento em ordem "
            "de lista deixa o alvo para o fim — e ele chega truncado ou não chega."
        ),
        "evidence": (
            "Bancada: uma seção genérica de 31k comia 34% do recorte e o agente recebia 1 de 10 "
            "seções ancoradas; as ausentes CABIAM. Não era teto — era ordem."
        ),
    },
    {
        "slug": "arch.gap73.a-outra-ponta",
        "title": "O literal citado na justificativa também precisa chegar",
        "rule": (
            "Quando a tarefa cita um arquivo/trecho apenas na descrição ou no critério de aceite, "
            "ele conta como alvo: reserve contexto para ele. Sem isso o agente inventa uma "
            "substituição global e contradiz o que existe."
        ),
        "evidence": "Bancada: 8 de 25 literais citados ficavam fora do recorte, todos com ≤3k chars.",
    },
    {
        "slug": "arch.gap74.janela-verbatim",
        "title": "O que não cabe vai como JANELA verbatim, não como promessa",
        "rule": (
            "Se o alvo não cabe inteiro, entregue/peça o TRECHO literal relevante. Declarar que a "
            "seção existe e não mostrá-la trava o defeito para sempre."
        ),
        "evidence": (
            "Bancada: a §7.4 (16.399 chars) era só declarada e sozinha travava 2 dos 4 GAPs eternos."
        ),
    },
    {
        "slug": "arch.gap75.arquivo-irmao",
        "title": "Contexto cross-file é a regra, não a exceção",
        "rule": (
            "A maioria dos defeitos reais envolve mais de um arquivo. Reserve contexto para o "
            "arquivo IRMÃO citado (contrato, tipo, schema) antes de gastar tudo no arquivo próprio."
        ),
        "evidence": "Bancada: 14 de 20 findings eram cross-file; 5 de 11 seções irmãs citadas chegavam.",
    },
    {
        "slug": "arch.gap70.remover-e-progresso",
        "title": "Remover o que a tarefa manda remover é progresso — e vai declarado",
        "rule": (
            "Consolidar/remover código morto pedido pela tarefa não é regressão; o que não se "
            "admite é o corte silencioso. Meça o resultado ANTES de aplicar o teto e diga o que "
            "saiu e por quê."
        ),
        "evidence": (
            "Bancada: uma tolerância de 0 derrubava justamente a rodada que REMOVIA lixo (por "
            "+692 chars), premiando quem só acrescentava."
        ),
    },
    {
        "slug": "arch.gap69.contagem-nao-e-prova",
        "title": "Contagem agregada não é prova de progresso",
        "rule": (
            "'8 de 10 passando' ou 'N itens resolvidos' não substitui dizer QUAL item, em qual "
            "arquivo. Sem identidade estável do item, troca de nome parece progresso."
        ),
        "evidence": (
            "Bancada: 23→20 findings era ROTAÇÃO de cobertura — no subconjunto comparável, 20→20: "
            "zero fechado. E um teto por rodada aplicado repetidamente virou META de gasto "
            "(+15,3% em 7h46)."
        ),
    },
    {
        "slug": "arch.gap121.pedido-impossivel-separa-se",
        "title": "Pedido que exige crescer E encolher, julgado pelo líquido, é impossível com margem zero",
        "rule": (
            "Tarefa que ACRESCENTA e REMOVE ao mesmo tempo, julgada pelo delta líquido tudo-ou-nada: "
            "faça a REMOÇÃO SOZINHA primeiro — ela cabe em qualquer orçamento e o espaço liberado "
            "financia o acréscimo depois. Não podendo separar, declare o pedido inexequível com esse "
            "orçamento em vez de entregar o que nasce condenado. Na remoção o defeito segue ABERTO: "
            "apagar a seção que fala dele não é conserto."
        ),
        "evidence": (
            "Bancada GAP-121 (2026-09-08): margem de crescimento ficou em ZERO da rodada 4 à 12 e 9 "
            "de 24 rodadas não escreveram NADA — sempre nos mesmos arquivos. Pedir a remoção sozinha "
            "devolveu −1.334 chars de margem, 8 de 11 rodadas voltaram a escrever e a contagem caiu "
            "48 → 43 em 11 rodadas (antes: 24 rodadas para ficar em 48)."
        ),
    },
    {
        "slug": "arch.gap122.artefato-novo-entra-no-indice",
        "title": "Arquivo novo que não entra no índice não existe para quem lê depois",
        "rule": (
            "Ao CRIAR membro de um conjunto (arquivo de spec, módulo, serviço do manifesto) — e ao "
            "EDITAR o índice dele — confira que o índice cita todos. A forma do índice é sua decisão; "
            "a completude não é. Sem a lista do conjunto, diga isso em vez de supor índice completo."
        ),
        "evidence": (
            "Bancada GAP-122 (2026-09-08): `arquitetura-modelo.md` foi criado e NÃO entrou no "
            "`README.md`, e o chat reescreveu o README depois sem indexá-lo. O inventário do juiz "
            "listava a árvore, mas cruzar 12 nomes contra o texto do índice à mão nunca aconteceu."
        ),
    },
    {
        "slug": "arch.gap123.teto-para-de-produzir-nao-de-medir",
        "title": "Teto de custo pára de PRODUZIR, não de MEDIR — número sem medição é retrato vencido",
        "rule": (
            "Ao encerrar por teto/orçamento: pare de gerar trabalho novo, mas MEÇA o que já entregou "
            "antes de fechar a conta. Número apurado antes das últimas entregas descreve um estado que "
            "não existe mais — e faz o próprio trabalho parecer regressão. Não podendo medir, DECLARE "
            "quantas entregas ficaram fora da contagem em vez de apresentá-la como retrato do estado."
        ),
        "evidence": (
            "Bancada GAP-123 (2026-09-08): a run `731c58ce` bateu o teto de 30 rodadas e encerrou com "
            "5 rodadas APLICADAS (+1.071 chars, 22:08→22:18) que nenhuma validação mediu — a última "
            "fechara 22:06:31. Reportou 47 (número de 22:06) com 3 de 5 passes ainda no orçamento, e "
            "uma das 5 era justo a rodada que FECHOU o GAP-122: o laço jogou fora a prova do trabalho."
        ),
    },
    {
        "slug": "arch.gap124.validade-e-do-trecho-julgado",
        "title": "A validade de um parecer é do TRECHO julgado, não do arquivo que o contém",
        "rule": (
            "Aprovação, dispensa ou parecer valem sobre o TRECHO que você leu — amarre-os a esse trecho, "
            "não ao arquivo inteiro. Invalidar por mudança em outra parte do mesmo arquivo destrói "
            "trabalho legítimo e, num laço que reescreve tudo a cada passe, nada acumula: o gatilho que "
            "depende do acúmulo fica inalcançável. Se o trecho mudou ou desapareceu, o parecer morre."
        ),
        "evidence": (
            "Bancada GAP-124 (2026-09-08): 13 liberações do juiz acumuladas em 3 runs e ZERO valendo — "
            "nenhum sha de arquivo batia, porque o laço reescreve os 12 arquivos por passe. Resultado: "
            "`released` sempre 0, teto acumulado de 24 decorativo, `promotable` falso por construção e a "
            "feature dos diagramas (gatilho `promotable`) inalcançável — o arquétipo do gatilho impossível."
        ),
    },
    {
        "slug": "arch.gap125.ultimo-artefato-nao-redefine-o-veredicto",
        "title": "O último artefato entregue não redefine o veredicto do trabalho",
        "rule": (
            "Ao FECHAR uma tarefa depois de um passo extra (diagrama, README, resumo): status e motivo "
            "continuam sendo os de quem MEDIU o estado, não os do passo extra. Quem encerra sem receber "
            "esse estado repete um texto fixo — e texto fixo sobre estado variável é mentira em parte dos "
            "caminhos. Carregue o desfecho com a tarefa; sem ele, MEÇA de novo em vez de afirmar."
        ),
        "evidence": (
            "Bancada GAP-125 (2026-09-08): a rodada de desenhos encerrava a run em `succeeded` dizendo "
            "'nenhum GAP ativo restante' — verdade em 1 dos 5 gatilhos. Nos 3 abertos pelo GAP-116 o laço "
            "chega ali com GAPs abertos POR CONSTRUÇÃO, e o parecer do juiz e o motivo do esgotamento eram "
            "descartados: uma figura promovia `exhausted` a sucesso. Os testes cobriam o DESPACHO do "
            "desenho e não o ENCERRAMENTO — foi esse ponto cego que sustentou o defeito."
        ),
    },
]

# Complemento por papel — o mesmo arquétipo, na forma em que ele aparece para cada agente.
ROLE_FOCUS: dict[str, str] = {
    "dev": (
        "Como isto aparece para você: `existing_artifacts` e `dependency_code` podem chegar "
        "CORTADOS, com a marca `⚠️ [CORTE DE CONTEXTO — ARQUIVO INCOMPLETO]` dizendo quantos "
        "caracteres ficaram de fora, ou `⚠️ [NÃO ENTREGUE — ORÇAMENTO DE CONTEXTO]` quando o "
        "arquivo não chegou. Nesses casos: não reescreva o arquivo inteiro, não invente o "
        "conteúdo ausente e declare a falta no `summary`. Os arquivos que a task cita chegam "
        "primeiro e com orçamento próprio — se um CITADO veio cortado, diga isso em vez de adivinhar."
    ),
    "cto": (
        "Como isto aparece para você: a spec pode chegar incompleta (corte em fronteira de "
        "arquivo, DECLARADO no prompt). Não aprove nem reprove completude do que você não viu, e "
        "não normalize um documento que chegou parcial como se fosse o todo."
    ),
    "engineer": (
        "Como isto aparece para você: se a spec/contexto chegou parcial, a proposta técnica cobre "
        "o que você viu e DECLARA o que faltou — não deduza a arquitetura do que ficou fora."
    ),
    "pm": (
        "Como isto aparece para você: um backlog derivado de spec parcial nasce menor que o "
        "produto. Declare no resumo que a spec chegou cortada em vez de fingir cobertura total. "
        "Ao listar `depends_on_files`, cite explicitamente o arquivo irmão que a task precisa ler "
        "— é o que garante reserva de contexto para ele."
    ),
    "qa": (
        "Como isto aparece para você: você recebe artefatos completos. Não reprove uma task por "
        "ausência de arquivo que nunca foi entregue ao Dev (marca de CORTE/NÃO ENTREGUE no "
        "contexto dele) — isso é falta de contexto, e o veredito correto é apontar o arquivo "
        "faltante, não pedir reescrita integral. E o seu veredito vale sobre o TRECHO que você "
        "leu: não reabra o que já aprovou porque outra parte do mesmo arquivo mudou."
    ),
    "monitor": (
        "Como isto aparece para você: 'N tasks concluídas' não é prova. Verifique identidade do "
        "item (task/arquivo), não só a contagem — rotação de itens parece progresso. E confira "
        "QUANDO a contagem foi apurada: número anterior às últimas entregas não é o estado atual. "
        "Do mesmo jeito, um artefato extra entregue no fim (diagrama, resumo, README) não muda o "
        "status do ciclo: relate o desfecho que a MEDIÇÃO deu, não o do último passo."
    ),
    "devops": (
        "Como isto aparece para você: manifesto/compose gerado a partir de contexto parcial "
        "remove serviço que existe. Declare o que não viu em vez de reescrever o arquivo inteiro."
    ),
}


def _prefix_for(role: str) -> str:
    """Texto injetado no topo do SYSTEM_PROMPT (`category='package'`)."""
    lines = [
        "### Arquétipos de contexto (aprendidos em produção — Bancada de Specs, GAP-69→75 · 121→125)",
        "",
        f"Estes {len(ARCHETYPES)} defeitos foram MEDIDOS na Bancada e são de CONTEXTO, não de "
        "linguagem: aparecem igual em spec, em código e em manifesto. Cortar contexto é aceitável; "
        "**mentir sobre o corte não**.",
        "",
    ]
    for a in ARCHETYPES:
        lines.append(f"- **{a['title']}** — {a['rule']}")
    focus = ROLE_FOCUS.get(role)
    if focus:
        lines += ["", focus]
    return "\n".join(lines)


def _package_payload(role: str) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "role": role,
        "stackKey": STACK_KEY,
        "connectVersion": os.environ.get("CONNECT_VERSION_PIN", "1.1.0"),
        "mode": "live",
        "systemPromptPrefix": _prefix_for(role),
    }


def _checklist_payload(role: str) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "role": role,
        "stackKey": STACK_KEY,
        "connectVersion": os.environ.get("CONNECT_VERSION_PIN", "1.1.0"),
        "mode": "live",
        "bugChecklists": [
            {"slug": a["slug"], "title": a["title"], "rule": a["rule"]} for a in ARCHETYPES
        ],
    }


def rows_to_seed() -> list[tuple[str, str, str, dict[str, Any]]]:
    """(cache_key, role, category, payload) para cada papel — testável sem banco."""
    out: list[tuple[str, str, str, dict[str, Any]]] = []
    for role in ROLES:
        out.append((f"cag:{role}:{STACK_KEY}:archetypes-context", role, "package", _package_payload(role)))
        out.append((f"cag:{role}:{STACK_KEY}:archetypes-checklist", role, "checklist", _checklist_payload(role)))
    return out


def _estimate_tokens(payload: dict[str, Any]) -> int:
    return max(1, len(json.dumps(payload, ensure_ascii=False)) // 4)


def _open_pg():
    """Mesma resolução de DSN do `checklist_seed.py` (DATABASE_URL ou PG*)."""
    db_url = os.environ.get("DATABASE_URL", "").strip()
    if not db_url:
        host = os.environ.get("PGHOST", "localhost")
        port = os.environ.get("PGPORT", "5432")
        user = os.environ.get("PGUSER", "genesis")
        password = os.environ.get("PGPASSWORD", "genesis_dev")
        dbname = os.environ.get("PGDATABASE", "zentriz_genesis")
        db_url = f"postgresql://{user}:{password}@{host}:{port}/{dbname}"
    try:
        import psycopg2  # type: ignore
        return psycopg2.connect(db_url)
    except ImportError:
        pass
    try:
        import psycopg  # type: ignore
        return psycopg.connect(db_url)
    except ImportError:
        pass
    raise RuntimeError("psycopg2 ou psycopg não encontrado — instale um deles.")


def seed_all(ttl_days: int = 365) -> dict[str, int]:
    """Insere/atualiza os arquétipos em `context_cache`. Retorna contagens."""
    expires_at = datetime.now(timezone.utc) + timedelta(days=ttl_days)
    connect_version = os.environ.get("CONNECT_VERSION_PIN", "1.1.0")
    inserted = 0
    updated = 0
    rows = rows_to_seed()
    conn = _open_pg()
    try:
        with conn:
            with conn.cursor() as cur:
                for cache_key, role, category, payload in rows:
                    cur.execute(
                        """
                        INSERT INTO context_cache
                            (cache_key, role, connect_version, project_id,
                             stack_key, category, payload, payload_tokens, expires_at)
                        VALUES (%s, %s, %s, NULL, %s, %s, %s::jsonb, %s, %s)
                        ON CONFLICT (cache_key) DO UPDATE
                           SET payload         = EXCLUDED.payload,
                               payload_tokens  = EXCLUDED.payload_tokens,
                               connect_version = EXCLUDED.connect_version,
                               expires_at      = EXCLUDED.expires_at
                         RETURNING (xmax = 0) AS inserted
                        """,
                        (
                            cache_key,
                            role,
                            connect_version,
                            STACK_KEY,
                            category,
                            json.dumps(payload, ensure_ascii=False),
                            _estimate_tokens(payload),
                            expires_at,
                        ),
                    )
                    if cur.fetchone()[0]:
                        inserted += 1
                    else:
                        updated += 1
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return {"inserted": inserted, "updated": updated, "total": len(rows)}


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        result = seed_all()
        logger.info(
            "[archetype_seed] OK — %d inseridos, %d atualizados, %d linhas (%d papéis)",
            result["inserted"], result["updated"], result["total"], len(ROLES),
        )
        return 0
    except Exception as exc:
        logger.error("[archetype_seed] FAIL — %s", exc, exc_info=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
