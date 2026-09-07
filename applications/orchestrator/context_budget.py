"""
Orçamento de contexto da FÁBRICA — ORDEM, RESERVA e CORTE DECLARADO.

Este módulo transporta para a fábrica os arquétipos aprendidos (e medidos) na Bancada de
Specs nas ondas GAP-69→75 (em produção 2026-09-07). Os três defeitos abaixo são os MESMOS
que estavam vivos aqui — só mudavam de roupa (seção de spec lá, arquivo de código aqui):

* **ORDEM (GAP-72/73)** — o orçamento era gasto em ORDEM DE LISTA. Na Bancada isso entregou
  ao agente **1 de 10 seções ancoradas** (uma seção genérica de 31k comia 34% do recorte) e
  deixou **8 de 25 literais citados** fora do contexto. Na fábrica o efeito é idêntico:
  `existing_artifacts` chega em ordem alfabética de `rglob` e o arquivo que a task CITA
  recebe a mesma fatia de 8.000 chars que um arquivo irrelevante. **Fix: quem é CITADO tem
  RESERVA e vem PRIMEIRO.**

* **CAUDA MUDA (GAP-45/72)** — um `break` no meio do laço derruba o resto da lista em
  silêncio: o último arquivo pedido pela task chega com ZERO e ninguém é avisado.
  **Fix: reserva mínima por item citado + o que não couber é DECLARADO, nunca omitido.**

* **ERRATA NULA / corte mudo (GAP-71)** — declarar sem fazer. Um marcador mudo
  (`... [truncado]`) faz o agente concluir que viu o arquivo inteiro; como o formato de
  entrega do Dev é `whole`, ele reescreve o arquivo a partir do prefixo e **apaga o que não
  viu** (o veto "SÍMBOLOS REMOVIDOS" do `runner.py` é o sintoma, não a causa).
  **Fix: o corte declara NÚMEROS e PROÍBE explicitamente a reescrita integral.**

Nada aqui decide CONTEÚDO — isso é do LLM (Lei: Genesis/Auto Care são 100% LLM). O módulo
só transporta o contexto com ordem/reserva honestas e declara o que não caber.
"""
from __future__ import annotations

import re
from typing import Iterable, Mapping, Sequence

# Corte de ARQUIVO (código/artefato). Diferente do `_PROMPT_CLIP_NOTICE` do runtime, que fala
# de documento narrativo: aqui a consequência do corte mudo é APAGAR código no disco, então a
# proibição de reescrever o arquivo inteiro é explícita.
ARTIFACT_CUT_NOTICE = (
    "\n\n⚠️ [CORTE DE CONTEXTO — ARQUIVO INCOMPLETO] Você recebeu {shown} de {total} "
    "caracteres ({pct}%) de `{path}`. Os {omitted} caracteres restantes EXISTEM no "
    "repositório e NÃO estão nesta mensagem.\n"
    "REGRA: não reescreva este arquivo por inteiro a partir do que você viu — isso APAGARIA "
    "o código que ficou fora. Altere apenas o que a task pede; se precisar do arquivo "
    "completo para cumprir a task, diga isso no `summary` em vez de adivinhar. "
    "Não copie esta marca para nenhum artefato."
)

# Item que NÃO recebeu orçamento nenhum. O contrato é: aparecer DECLARADO em vez de
# desaparecer (a cauda muda do `break` era o defeito).
ARTIFACT_OMITTED_NOTICE = (
    "⚠️ [NÃO ENTREGUE — ORÇAMENTO DE CONTEXTO] `{path}` tem {total} caracteres e não caberia "
    "nesta mensagem. O arquivo EXISTE no repositório e não foi removido. Não invente o "
    "conteúdo dele e não o reescreva; se a task depende deste arquivo, declare isso no "
    "`summary`."
)

# Fatia mínima garantida a cada item citado (ORDEM+RESERVA). Abaixo disso o prefixo é inútil
# e o call site prefere entregar assinaturas (janela útil, GAP-74).
DEFAULT_MIN_SHARE = 2_000


def cut_note(path: str, shown: int, total: int) -> str:
    """Marca de corte com NÚMEROS (GAP-71: corte mudo é o que faz o agente apagar código)."""
    omitted = max(0, total - shown)
    pct = int(round((shown / total) * 100)) if total > 0 else 0
    return ARTIFACT_CUT_NOTICE.format(shown=shown, total=total, pct=pct, omitted=omitted, path=path)


def omitted_note(path: str, total: int) -> str:
    """Declara um item que ficou de fora — nunca desaparecer em silêncio (GAP-45)."""
    return ARTIFACT_OMITTED_NOTICE.format(path=path, total=total)


def apply_cut(path: str, content: str, cap: int) -> str:
    """Corta `content` em `cap` chars declarando o corte. Sem corte, devolve o texto intacto."""
    if not isinstance(content, str) or cap <= 0 or len(content) <= cap:
        return content
    return content[:cap] + cut_note(path, cap, len(content))


def cited_paths(texts: Iterable[str], candidates: Iterable[str]) -> list[str]:
    """Quais `candidates` são CITADOS literalmente em `texts` (caminho completo ou basename).

    GAP-73 ("a outra ponta"): na Bancada, 8 de 25 literais citados só apareciam no
    `rationale` do finding e por isso ficavam fora do recorte — o agente então inventava
    substituição global. Aqui o literal aparece no título/descrição/critérios da task ou nos
    `code_refs`, e o arquivo correspondente precisa de RESERVA, não da sobra.
    """
    blob = "\n".join(t for t in texts if isinstance(t, str) and t)
    if not blob:
        return []
    low = blob.lower()
    out: list[str] = []
    for path in candidates:
        if not isinstance(path, str) or not path:
            continue
        p = path.lower()
        base = p.rsplit("/", 1)[-1]
        # basename sozinho só conta com fronteira de palavra: `app.ts` não pode casar
        # dentro de `myapp.ts`.
        if p in low or (base and re.search(r"(?<![\w./-])" + re.escape(base), low)):
            out.append(path)
    return out


def plan_allocation(
    items: "Mapping[str, int] | Sequence[tuple[str, int]]",
    budget: int,
    *,
    cited: "Iterable[str] | None" = None,
    min_share: int = DEFAULT_MIN_SHARE,
    per_item_cap: "int | None" = None,
) -> dict[str, int]:
    """Distribui `budget` chars entre `items` ({chave: tamanho}) com ORDEM e RESERVA.

    Regras, nesta ordem (a ORDEM é a correção — não o teto):
      1. **Citados primeiro.** A lista é reordenada colocando os `cited` na frente,
         preservando a ordem relativa original de cada grupo.
      2. **Reserva mínima.** Cada item recebe até `min_share` antes de qualquer item receber
         mais do que isso — então nenhum item citado sai com ZERO por estar no fim da lista.
      3. **Sobra em ordem.** O que restou é completado item a item na ordem do passo 1;
         quem cabe inteiro devolve a folga para os seguintes.

    Devolve {chave: chars concedidos} para TODOS os itens (0 é resposta válida e DEVE ser
    declarada pelo chamador — cauda muda é o defeito).
    """
    pairs: list[tuple[str, int]] = list(items.items()) if isinstance(items, Mapping) else list(items)
    if not pairs:
        return {}
    cited_set = {c for c in (cited or ()) if c}
    order = [p for p in pairs if p[0] in cited_set] + [p for p in pairs if p[0] not in cited_set]
    want = {
        key: max(0, min(size, per_item_cap) if per_item_cap is not None else size)
        for key, size in order
    }
    if budget <= 0:
        return {key: 0 for key in want}
    if sum(want.values()) <= budget:
        return want

    alloc = {key: 0 for key in want}
    left = budget
    share = max(0, min_share)
    for key in want:
        if left <= 0:
            break
        give = min(want[key], share, left)
        alloc[key] = give
        left -= give
    for key in want:
        if left <= 0:
            break
        extra = min(want[key] - alloc[key], left)
        alloc[key] += extra
        left -= extra
    return alloc
