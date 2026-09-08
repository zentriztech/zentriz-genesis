"""
verdict_seed.py — ensina à FÁBRICA a HONESTIDADE DE VEREDICTO medida na Bancada.

Irmão de `archetype_seed.py`, deliberadamente separado. Aquele ensina arquétipos de
**CONTEXTO** (o que chegou ao agente e o que foi cortado); este ensina arquétipos de
**AFIRMAÇÃO** (o que o agente diz que verificou). Misturar os dois num único pacote faria
o próprio texto mentir sobre o seu escopo — que é exatamente o defeito aqui catalogado.
A mesma decisão foi tomada no Connect: `ReviewVerdictRecord` nasceu como contrato NOVO em
vez de esticar `ReflectionRecord`, porque auto-avaliação (ganho ZERO) e revisão de outra
família (+12 p.p.) não podem compartilhar o mesmo registro (ADR-014).

A frase única que resume as nove regras:

    "não encontrei" e "não sei procurar" NÃO são a mesma resposta.

Isso não é opinião de desenho: defeito FORA DO VOCABULÁRIO do revisor teve recall **0% em
5 de 5 provas** em produção (2026-09-08) — todos saíam classificados como "ausente". É o
achado mais estável de toda a medição do juiz, e é ele que a fábrica precisa aprender.

Por que `context_cache` (CAG) e não `lessons_corpus`: a recuperação de lições ordena por
`hit_count * confidence` (ver `context_loader._query_lessons_top_hits`), então lição NOVA
(hit_count 0) fica no fim da fila e pode nunca entrar no prompt. O `context_cache` é
determinístico por (role, stack_key, project_id) e o loader ACUMULA todas as linhas
(`prefix_chunks` concatenado, `bug_checklists` estendido) — ou seja, este pacote SOMA ao
dos arquétipos de contexto, não o substitui.

Idempotente: `INSERT ... ON CONFLICT (cache_key) DO UPDATE`. Pode rodar quantas vezes quiser.

Uso:
    python -m orchestrator.verdict_seed
    # dentro do container de agents/runner, com DATABASE_URL (ou PG*) apontando para o Genesis

Requer: as mesmas condições do `archetype_seed.py` (tabela `context_cache`, migration 025).
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger(__name__)

SCHEMA_VERSION = "1.2.0"
STACK_KEY = "generic"  # o defeito é de AFIRMAÇÃO, não de linguagem

# Papéis que consomem CAG no pipeline (o loader recebe o papel em minúsculas).
ROLES = ("dev", "cto", "engineer", "pm", "qa", "monitor", "devops")

# As seis causas nomeadas de não opinar. Espelham `noOpinion.reason` do contrato Connect
# `learning/review-verdict-record` v1.4.0 — o vocabulário é o mesmo dos dois lados de
# propósito: um relatório que atravessa Bancada, Fábrica e Auto Care usando três taxonomias
# diferentes não é comparável, e comparabilidade é o que faz o laço fechar.
NO_OPINION_REASONS = (
    "nao_se_aplica",
    "desligado_por_configuracao",
    "api_incompativel_com_a_familia",
    "provedor_indisponivel",
    "resposta_ilegivel",
    "fora_do_vocabulario",
)


# ─────────────────────────────────────────────────────────────────────────────
# Catálogo — nove arquétipos de veredicto, todos MEDIDOS (ou citados com fonte)
# O da ÂNCORA (`verd.gap39.ancora-literal-e-identidade`) entrou na revisão adversarial
# cross-family de 2026-09-08: 3 de 3 revisores de outra família apontaram a MESMA lacuna — o
# GAP-39/49 aparecia só como EVIDÊNCIA de outra regra, e nenhuma regra proibia reescrever a
# âncora. Ou seja: o material justificava com um defeito que não ensinava a evitar.
# O ÚLTIMO (`verd.a2.declarar-corrigido-nao-e-ter-corrigido`) é o achado A2 da Bancada: declarar
# "corrigido" com edição aplicada e o defeito continuar na MESMA âncora — 5 de 10 casos medidos.
# ─────────────────────────────────────────────────────────────────────────────

VERDICT_ARCHETYPES: list[dict[str, Any]] = [
    {
        "slug": "verd.gap104.nao-medido-nao-e-ausente",
        "title": "'Não encontrei' e 'não sei procurar' não são a mesma resposta",
        "rule": (
            "Ao dizer que algo NÃO está presente, diga em que você procurou: os artefatos que "
            "você RECEBEU e a lista de tipos de defeito que você está usando. Item fora desses "
            "dois conjuntos é NÃO MEDIDO com o motivo nomeado — nunca AUSENTE."
        ),
        "evidence": (
            "Bancada 2026-09-08: defeito fora do vocabulário do revisor teve recall 0% em 5 de "
            "5 provas, e 100% deles saíam como 'ausente'. É o achado mais estável da medição."
        ),
    },
    {
        "slug": "verd.gap104.silencio-tem-causa",
        "title": "Silêncio tem causa, e a causa vai nomeada",
        "rule": (
            "Quando você não opina, declare POR QUÊ, escolhendo entre: não se aplica · "
            "desligado por configuração · ferramenta/API incompatível · indisponível · "
            "resposta ilegível · fora do vocabulário. 'Não opinou' sem causa aparece no "
            "relatório como limitação do modelo e esconde o defeito real."
        ),
        "evidence": (
            "Bancada GAP-104: incompatibilidade de API (o dialeto Anthropic serve SÓ Claude) "
            "saía no relatório como 'o revisor não opinou' — causa errada, conclusão errada."
        ),
    },
    {
        "slug": "verd.gap98.garantia-derivada-do-pedido",
        "title": "De onde a garantia foi derivada importa tanto quanto a garantia",
        "rule": (
            "Declare a FONTE do que você afirma: o modelo, arquivo ou comando efetivamente "
            "USADO — não o que foi pedido. Se uma das duas pontas é desconhecida, não afirme a "
            "garantia; diga 'desconhecido'. Errar para o lado de não afirmar é a escolha certa."
        ),
        "evidence": (
            "Bancada GAP-98: 'revisão cross-family' foi publicada como garantia derivada do "
            "modelo PEDIDO; o modelo efetivamente invocado era o do próprio autor — ou seja, "
            "auto-revisão vendida como revisão independente."
        ),
    },
    {
        "slug": "verd.autorrevisao-ganho-zero",
        "title": "Reler o próprio trabalho não substitui revisor independente",
        "rule": (
            "Sua própria releitura é AUTO-AVALIAÇÃO e deve ser declarada como tal — não a "
            "apresente como revisão. Havendo revisor de outra origem, a divergência entre vocês "
            "é DADO: registre-a e responda a ela por escrito. A decisão final continua sua, e vai "
            "justificada; ninguém prevalece por hierarquia."
        ),
        "evidence": (
            "Literatura cs.SE (arXiv:2609.04270) + nossa medição: auto-revisão da mesma família "
            "dá ganho ZERO; revisor de outra família mid-tier dá +12 p.p. de recall com ~2% de "
            "falso positivo — ou seja, famílias diferentes acham defeitos COMPLEMENTARES, e é por "
            "isso que a divergência é sinal, não ruído. Na Bancada o falso positivo do revisor de "
            "outra família foi ZERO em 12 achados auditados, o que mede precisão dele — não "
            "autoridade sobre você."
        ),
    },
    {
        "slug": "verd.recall-do-juiz",
        "title": "'O revisor não achou nada' cobre menos da metade",
        "rule": (
            "Ausência de achado não é prova de correção. Um 'está ok' precisa vir com a lista do "
            "que você TEVE COMO verificar com o que recebeu — não uma lista do escopo ideal. Sem "
            "essa lista, o silêncio é indistinguível de não ter olhado."
        ),
        "evidence": (
            "Bancada 2026-09-08 (gold set em produção): recall do juiz entre 33% e 43% "
            "(IC95 Wilson 16%–75%, n=7). O MESMO juiz variou de 14% a 43% no mesmo alvo apenas "
            "trocando o gold set. O número mede uma coisa só — que 'não achei' cobre menos da "
            "metade — e não prova que listar resolve; listar é a RESPOSTA que escolhemos, porque "
            "torna o silêncio auditável em vez de indistinguível."
        ),
    },
    {
        "slug": "verd.presente-exige-citacao",
        "title": "Afirmação sem citação verificável é indecidível, não 'presente'",
        "rule": (
            "Ao afirmar que algo ESTÁ presente (defeito, requisito, trecho, símbolo), cite o "
            "literal e a origem (arquivo e seção/linha). Quando a origem não é um arquivo que você "
            "recebeu — versão em lockfile, contrato, resposta de comando — cite essa fonte e o "
            "método. Sem nenhuma citação, o veredicto é INDECIDÍVEL. Paráfrase não é citação."
        ),
        "evidence": (
            "Bancada: achado afirmado sem literal conferível não sobrevive à rodada seguinte — o "
            "trecho é reescrito e o mesmo defeito volta como novo (ver o arquétipo da âncora)."
        ),
    },
    {
        "slug": "verd.gap39.ancora-literal-e-identidade",
        "title": "A âncora é a identidade do achado — reescrevê-la cria um achado novo",
        "rule": (
            "Ao reportar (ou reabrir) um achado, copie a âncora literal SEM alterar: é ela que diz "
            "se este achado é o mesmo da rodada anterior. Se precisar explicar com suas palavras, "
            "mantenha a citação original ao lado e diga que a outra é reformulação."
        ),
        "evidence": (
            "Bancada GAP-39/49: o juiz REESCREVIA o trecho de âncora, então a identidade do achado "
            "mudava sozinha — 17 de 18 'novas aberturas' eram o mesmo achado rebatizado, e a "
            "contagem parecia progresso enquanto nada fechava."
        ),
    },
    {
        "slug": "verd.teste-verde-nao-e-conformidade",
        "title": "Suíte verde responde 'não quebrou', não 'respeita o que foi pedido'",
        "rule": (
            "Constraints declaradas (proibições, limites, contratos, campos obrigatórios) "
            "precisam de verificação PRÓPRIA e explícita, citada no resultado. Não use 'todos os "
            "testes passaram' como prova de conformidade com o que a tarefa exigiu."
        ),
        "evidence": (
            "Literatura cs.SE (arXiv:2609.04167): 34% dos patches que PASSAM nos testes violam "
            "constraints declaradas. Na Bancada isso virou gate próprio (migration 107)."
        ),
    },
    {
        "slug": "verd.a2.declarar-corrigido-nao-e-ter-corrigido",
        "title": "Editar o trecho não é fechar o defeito — e o sintoma não é a causa",
        "rule": (
            "Ao declarar CORRIGIDO, diga qual CONTRADIÇÃO deixou de existir, não qual trecho você "
            "reescreveu: apagar a frase que nomeia o conflito só troca a redação com que ele volta. "
            "Se a causa mora em artefato que você não pode editar, o desfecho é 'não é deste "
            "arquivo', com o artefato apontado. Se o defeito voltou na MESMA âncora, a via anterior "
            "falhou: escolha outra ou conteste com argumento."
        ),
        "evidence": (
            "Bancada 2026-09-08 (run 10b1a4e1, passe 1): dos 10 GAPs declarados 'corrigido' — "
            "todos com edição ancorada de fato aplicada — 5 continuavam na MESMA âncora na "
            "validação seguinte, com o título reescrito pelo juiz (semelhança 0,03..0,30). Como o "
            "título mudava, cada rodada parecia progresso e a contagem não caía."
        ),
    },
]

# Complemento por papel — o mesmo arquétipo, na forma em que ele aparece para cada agente.
ROLE_FOCUS: dict[str, str] = {
    "dev": (
        "Como isto aparece para você: no `summary` da sua entrega. Declare como 'corrigido' o que "
        "você pode apontar no artefato que escreveu — isso é a maior parte do seu trabalho e deve "
        "ser dito com clareza. O que você não executou nem leu vai como 'não verificado', na mesma "
        "frase. Ao afirmar que um símbolo/rota/campo já existe no repositório, cite o arquivo onde "
        "você o viu; se você não recebeu o arquivo, isso é NÃO MEDIDO. Ressalva não substitui "
        "entrega: o `summary` diz o que foi feito primeiro, e depois o que ficou fora."
    ),
    "cto": (
        "Como isto aparece para você: seu veredicto de spec decide promoção. 'Nenhum problema "
        "encontrado' só vale acompanhado da lista do que foi verificado; item que você não tinha "
        "como checar (seção não entregue, arquivo irmão ausente) é NÃO MEDIDO, nunca APROVADO. "
        "Ao apontar um defeito, cite a âncora literal da spec — reescrever a âncora troca a "
        "identidade do achado e faz o mesmo defeito reabrir para sempre."
    ),
    "engineer": (
        "Como isto aparece para você: a proposta técnica afirma viabilidade. Diga de onde saiu "
        "cada garantia (versão de biblioteca que você leu no lockfile, contrato que você abriu) "
        "e marque como suposição o que você não conferiu — não apresente pedido como fato."
    ),
    "pm": (
        "Como isto aparece para você: cobertura de backlog. 'N tarefas cobrem a spec' não é "
        "prova; diga QUAIS requisitos ficaram sem tarefa. Requisito que você não conseguiu ler "
        "é NÃO COBERTO por falta de contexto — declare isso em vez de omitir da contagem."
    ),
    "qa": (
        "Como isto aparece para você: você é o juiz, e o recall medido de um juiz LLM ficou "
        "entre 33% e 43%. Portanto: (a) liste o que você VERIFICOU, não só o que falhou; "
        "(b) suíte verde não prova constraint respeitada — verifique as proibições declaradas "
        "uma a uma; (c) defeito de um tipo que você não sabe testar é NÃO MEDIDO com o motivo "
        "nomeado, nunca 'aprovado'."
    ),
    "monitor": (
        "Como isto aparece para você: relatório de progresso. Contagem agregada não é prova — "
        "o mesmo juiz variou 14%–43% no mesmo alvo só trocando o conjunto de referência. Compare "
        "identidade de item (qual achado, em qual arquivo) entre rodadas, e declare quando a "
        "superfície verificada mudou, porque aí a comparação não é válida."
    ),
    "devops": (
        "Como isto aparece para você: 'container healthy' e 'pipeline verde' não provam que o "
        "código novo subiu nem que a política foi respeitada. Cite o digest/versão que você "
        "conferiu; o que você não conferiu vai declarado como NÃO MEDIDO."
    ),
}


def _prefix_for(role: str) -> str:
    """Texto injetado no topo do SYSTEM_PROMPT (`category='package'`)."""
    lines = [
        "### Arquétipos de veredicto (medidos em produção — Bancada de Specs, 2026-09-08)",
        "",
        '**"não encontrei" e "não sei procurar" NÃO são a mesma resposta.** Defeito fora do '
        "vocabulário do revisor teve recall 0% em 5 de 5 provas, e 100% deles foram reportados "
        "como 'ausente'. Não saber é aceitável; **chamar não-saber de ausência não é**.",
        "",
    ]
    for a in VERDICT_ARCHETYPES:
        lines.append(f"- **{a['title']}** — {a['rule']}")
    lines += [
        "",
        "Quando você não opina, o motivo é UM destes: " + " · ".join(NO_OPINION_REASONS) + ".",
    ]
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
            {"slug": a["slug"], "title": a["title"], "rule": a["rule"]}
            for a in VERDICT_ARCHETYPES
        ],
    }


def rows_to_seed() -> list[tuple[str, str, str, dict[str, Any]]]:
    """(cache_key, role, category, payload) para cada papel — testável sem banco."""
    out: list[tuple[str, str, str, dict[str, Any]]] = []
    for role in ROLES:
        out.append((f"cag:{role}:{STACK_KEY}:verdicts-context", role, "package", _package_payload(role)))
        out.append((f"cag:{role}:{STACK_KEY}:verdicts-checklist", role, "checklist", _checklist_payload(role)))
    return out


def _estimate_tokens(payload: dict[str, Any]) -> int:
    return max(1, len(json.dumps(payload, ensure_ascii=False)) // 4)


def _open_pg():
    """Mesma resolução de DSN do `archetype_seed.py` (DATABASE_URL ou PG*)."""
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
    """Insere/atualiza os arquétipos de veredicto em `context_cache`. Retorna contagens."""
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
            "[verdict_seed] OK — %d inseridos, %d atualizados, %d linhas (%d papéis)",
            result["inserted"], result["updated"], result["total"], len(ROLES),
        )
        return 0
    except Exception as exc:
        logger.error("[verdict_seed] FAIL — %s", exc, exc_info=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
