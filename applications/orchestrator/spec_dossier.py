"""spec_dossier.py — GAP-54: a Fábrica lê a spec POR ARQUIVO, com MAPA do produto inteiro.

O QUE ESTAVA MEDIDO (prod, projeto `e2a1988c` NVX LastMile — Backend, 2026-09-08):

    árvore da spec ..... 1.098.849 chars em 12 arquivos
    orçamento efetivo ..... 143.800 chars (`_spec_input_cap` − reserva do aviso)
    o que CHEGAVA .... 2 de 12 arquivos = 112.614 chars = 10,2% da spec
    `modelo-dados.md` .... 218.840 chars — MAIOR que o orçamento INTEIRO

O GAP-53 já tinha consertado a parte grosseira (cortar em FRONTEIRA DE ARQUIVO e DECLARAR o corte,
em vez de cortar no meio de uma frase em silêncio). Sobrou o teto ESTRUTURAL, e ele tem duas
paredes independentes — é por isso que mexer no número não resolve:

  • PAREDE DA ENTRADA — `runtime.py::_prompt_budget` deriva o teto de LEITURA de `max_output`, e o
    comentário de lá diz o porquê, literalmente: *"no modo `spec_intake_and_normalize` o agente
    REEMITE a spec inteira em `artifacts[].content`, então o teto útil da entrada é o que ele
    consegue DEVOLVER"*. Ou seja: lemos pouco porque escrevemos muito. É o GAP-61 pela outra ponta.
  • PAREDE DA SAÍDA — o Sub-modo C do CTO (`agents/cto/SYSTEM_PROMPT.md`, passo 2) manda
    *"Produzir `PRODUCT_SPEC.md` a partir da spec fornecida"*. Reemitir 1.098.849 chars é
    fisicamente impossível com `max_output` de 64k tokens, e o que sobrevive vira o `product_spec`
    único de que TODO agente a jusante deriva (`runner.py::set_product_spec`).

Nenhuma das duas se resolve subindo `SPEC_INPUT_CHARS`: 1,1 M chars são ~275k tokens, acima da
janela de 200k. O teto não é um número herdado — é a forma da chamada.

A SAÍDA, e por que ela é esta: em vez de UM documento gigante, o agente recebe um DOSSIÊ — o MAPA
do produto inteiro (cabeçalhos de todos os arquivos, que sempre cabem) mais o TEXTO ÍNTEGRO dos
arquivos em foco, mais a lista declarada do que ficou fora. É o mesmo molde que a Bancada já provou
duas vezes: `specFileDigest.ts` + `specSiblingContext.ts` (GAP-72→75) e o dossiê do auditor
cross-family, onde o `indecidivel` caiu de 80% para 25% só por trocar "seção ancorada" por "dossiê".

⚖️ LEI (Jean): estrutura, divisão e conteúdo de spec são decisão de AGENTE, nunca de automação
fixa. Este módulo NÃO escolhe relevância, NÃO resume e NÃO reescreve nada: ele recorta em fronteira
de arquivo, extrai cabeçalhos verbatim e DECLARA o que não caberia. Quem escolhe o foco é o LLM
(ou, na ausência de escolha, a ordem original da Bancada — que é ausência de julgamento, não
julgamento disfarçado).

E a regra que vem do A5.7 e do GAP-45: **cortar é aceitável, mentir sobre o corte não é.** Todo
recorte aqui sai acompanhado do nome do que ficou fora.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

#: Fronteira de arquivo produzida por `runner.load_spec_all` ("---\n# [caminho/arquivo.md]\n\n").
#: Mantida idêntica ao `runner._SPEC_BLOCK_RE` de propósito: este módulo é o LEITOR daquele
#: formato, e divergir das duas expressões faria o dossiê perder arquivos em silêncio.
_BLOCK_RE = re.compile(r"(?:^|\n)---\n# \[([^\]\n]+)\]\n\n")

#: Cabeçalhos markdown de nível 1–3. Nível 4+ fica fora porque o mapa precisa CABER: no NVX a
#: árvore tem ~1,1 M chars, e descer a granularidade transforma o índice em outra spec.
_HEADING_RE = re.compile(r"^(#{1,3})[ \t]+(\S.*?)[ \t]*#*$", re.MULTILINE)

#: Teto de chars do MAPA. Medido: 12 arquivos do NVX rendem ~11 KB de cabeçalhos; 40.000 é folga de
#: 3,5× e ainda assim uma fração do orçamento. Se o mapa estourar, ele é cortado — e declarado.
OUTLINE_CAP = 40_000

#: Reserva para os cabeçalhos das seções do dossiê (marcadores `=== … ===` e o aviso de corte).
_FRAME_RESERVE = 1_500

#: Piso do recorte PARCIAL. Um fragmento de algumas centenas de chars entre `--- INÍCIO x.md ---` e
#: `--- FIM x.md ---` PARECE um arquivo e não é: o agente lê o começo de um documento e conclui sobre
#: o resto. Abaixo deste piso o dossiê prefere entregar só o MAPA e dizer que é só o mapa — não ter o
#: texto é uma limitação, achar que se tem é um defeito. É transporte, não julgamento de conteúdo.
_PARTIAL_MIN_CHARS = 2_000


@dataclass(frozen=True)
class SpecFile:
    """Um arquivo da árvore de spec, com o rótulo que a Bancada lhe deu."""

    label: str
    content: str

    @property
    def chars(self) -> int:
        return len(self.content)


@dataclass
class Dossier:
    """O que o agente recebe, e a contabilidade honesta do que ele NÃO recebeu.

    `map_coverage` e `text_coverage` são separados de propósito: com 2 de 12 arquivos o agente tinha
    10,2% de cobertura e NENHUMA noção do que havia nos outros 10. Com o mapa ele passa a ter 100%
    de cobertura de MAPA e os mesmos 10,2% de TEXTO — e a diferença entre "não recebi" e "não
    recebi, e sei o que era" é exatamente o que separa `no-invent` de invenção.
    """

    text: str
    included: list[str] = field(default_factory=list)
    omitted: list[str] = field(default_factory=list)
    partial: list[str] = field(default_factory=list)
    mapped: list[str] = field(default_factory=list)
    used: int = 0
    total: int = 0
    outline_chars: int = 0
    outline_truncated: bool = False

    @property
    def files(self) -> int:
        return len(self.included) + len(self.omitted)

    @property
    def map_coverage(self) -> float:
        """Fração dos arquivos cujos CABEÇALHOS chegaram ao agente.

        Conta os rótulos que REALMENTE saíram no mapa — não os que deveriam ter saído. Se o mapa for
        cortado no orçamento, este número CAI, e é assim que ele se torna falsificável: uma métrica
        que devolve 100% por construção não mede nada (foi a lição do GAP-42/43, validação que media
        o passe em vez do resultado).
        """
        return 1.0 if self.files == 0 else len(self.mapped) / self.files

    @property
    def text_coverage(self) -> float:
        """Fração dos CHARS da spec que chegaram verbatim."""
        return 1.0 if self.total <= 0 else self.used / self.total


def parse_spec_blocks(spec_content: str) -> list[SpecFile]:
    """Desfaz a concatenação de `load_spec_all`, devolvendo os arquivos como CONJUNTO.

    Spec de arquivo único (sem fronteira) devolve um bloco de rótulo vazio — o chamador continua
    tendo um conjunto, e nenhum caminho precisa de um `if` para "spec pequena".
    """
    if not spec_content:
        return []
    matches = list(_BLOCK_RE.finditer(spec_content))
    if not matches:
        return [SpecFile(label="", content=spec_content)]
    out: list[SpecFile] = []
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(spec_content)
        body = spec_content[m.end():end]
        out.append(SpecFile(label=m.group(1), content=body))
    return out


def build_outline(files: list[SpecFile], *, cap: int = OUTLINE_CAP) -> tuple[str, list[str], bool]:
    """MAPA do produto: todos os arquivos, com tamanho e cabeçalhos VERBATIM.

    Devolve `(texto, rótulos_que_entraram, truncado)`. Cabeçalho não é resumo: é o texto que o autor
    escreveu, copiado. Por isso o mapa não viola `no-invent` nem introduz interpretação de máquina.

    O corte, quando acontece, é por ARQUIVO INTEIRO — um arquivo listado no mapa tem TODOS os seus
    cabeçalhos, ou não está no mapa. Meio índice é pior que índice nenhum: o agente concluiria que a
    seção que falta não existe.
    """
    if not files:
        return "", [], False
    chunks: list[tuple[str, str]] = []
    for sf in files:
        label = sf.label or "(arquivo único)"
        heads = _HEADING_RE.findall(sf.content)
        lines = [f"- **{label}** — {sf.chars} chars, {len(heads)} cabeçalho(s)"]
        for level, title in heads:
            lines.append(f"  {'  ' * (len(level) - 1)}{'#' * len(level)} {title}")
        chunks.append((sf.label, "\n".join(lines)))

    out: list[str] = []
    mapped: list[str] = []
    used = 0
    truncated = False
    for label, chunk in chunks:
        add = len(chunk) + (1 if out else 0)
        if used + add > cap:
            truncated = True
            continue
        out.append(chunk)
        mapped.append(label)
        used += add
    text = "\n".join(out)
    if truncated:
        missing = len(chunks) - len(mapped)
        text += f"\n… (MAPA CORTADO no orçamento: {missing} arquivo(s) não foram nem indexados)"
    return text, mapped, truncated


def build_dossier(
    files: list[SpecFile],
    *,
    budget: int,
    focus: list[str] | None = None,
    outline_cap: int = OUTLINE_CAP,
) -> Dossier:
    """Monta o dossiê: MAPA de tudo + TEXTO íntegro do que couber + o corte DECLARADO.

    `focus` são os rótulos que o agente (LLM) pediu, na ordem em que pediu. Sem `focus`, a ordem é a
    original da Bancada — ausência de julgamento, não julgamento fixo disfarçado de heurística.

    Um arquivo só entra ÍNTEGRO. Nenhum arquivo é cortado no meio, exceto o caso degenerado em que
    NENHUM cabe (aí o primeiro entra parcial e é declarado em `partial`) — mesma disciplina do
    `fit_spec_to_budget`.
    """
    if not files:
        return Dossier(text="", total=0)

    total = sum(sf.chars for sf in files)
    # O mapa é barato, mas não é grátis: num orçamento apertado ele sozinho passaria do teto e o
    # dossiê inteiro seria recortado depois pelo `_clip` do runtime — corte cego e silencioso, o
    # defeito que este módulo existe para matar. Daí o mapa nunca passar de 1/3 do orçamento: acima
    # disso ele deixa de ser índice e começa a competir com o texto que deveria indexar.
    eff_outline_cap = min(outline_cap, max(1_000, budget // 3))
    outline, mapped, outline_cut = build_outline(files, cap=eff_outline_cap)
    room = budget - len(outline) - _FRAME_RESERVE

    by_label = {sf.label: sf for sf in files}
    wanted: list[SpecFile] = []
    seen: set[str] = set()
    for label in focus or []:
        sf = by_label.get(label)
        if sf is not None and label not in seen:
            wanted.append(sf)
            seen.add(label)
    rest = [sf for sf in files if sf.label not in seen]

    included: list[SpecFile] = []
    partial: list[str] = []
    used = 0

    # O FOCO tem prioridade absoluta. Sem isto o passe dedicado a `modelo-dados.md` (218.840 chars)
    # descartava o próprio arquivo do foco e enchia o espaço com irmãos menores — o passe existia,
    # custava uma chamada e não entregava o que prometeu. Passe dedicado que não entrega o arquivo
    # dedicado é pior que passe nenhum: ele CREDITA cobertura que não houve.
    for sf in wanted:
        if used + sf.chars <= room:
            included.append(sf)
            used += sf.chars
    if wanted and not included:
        head = wanted[0]
        if room >= _PARTIAL_MIN_CHARS:
            included.append(SpecFile(label=head.label, content=head.content[:room]))
            partial.append(head.label)
            used = room

    # Só o que sobra do orçamento vai para os irmãos, e nunca à frente do foco.
    for sf in rest:
        if used + sf.chars <= room:
            included.append(sf)
            used += sf.chars

    if not included and room >= _PARTIAL_MIN_CHARS:
        head = files[0]
        included = [SpecFile(label=head.label, content=head.content[:room])]
        used = room
        partial = [head.label]

    inc_labels = {sf.label for sf in included}
    # A ordem de APRESENTAÇÃO é sempre a original da Bancada, mesmo quando o foco mudou a ordem de
    # ESCOLHA: o agente lê o produto na sequência em que ele foi escrito. Quando há recorte parcial,
    # a lista `included` já carrega o conteúdo cortado — usá-la direto evita reintroduzir o inteiro.
    if partial:
        by_inc = {sf.label: sf for sf in included}
        present = [by_inc[sf.label] for sf in files if sf.label in by_inc]
    else:
        present = [sf for sf in files if sf.label in inc_labels]
    omitted = [sf.label for sf in files if sf.label not in inc_labels]

    parts = [
        "=== MAPA DA SPEC (todos os arquivos do produto, cabeçalhos verbatim) ===",
        outline,
        "",
        f"=== TEXTO ÍNTEGRO NESTE DOSSIÊ: {len(present)} de {len(files)} arquivo(s) ===",
    ]
    for sf in present:
        parts.append("")
        parts.append(f"--- INÍCIO {sf.label or '(arquivo único)'} ---")
        parts.append(sf.content)
        parts.append(f"--- FIM {sf.label or '(arquivo único)'} ---")
    parts += ["", "=== FORA DESTE DOSSIÊ (declarado, não omitido) ==="]
    if omitted:
        parts.append(
            f"Os {len(omitted)} arquivo(s) abaixo NÃO vieram em texto integral — você viu apenas os "
            "cabeçalhos deles no MAPA acima:"
        )
        parts += [f"- {label}" for label in omitted]
    if partial:
        parts.append(
            f"O arquivo {partial[0]} sozinho excede o orçamento e veio CORTADO — trate o que falta "
            "como lacuna declarada."
        )
    if outline_cut:
        parts.append("O próprio MAPA foi cortado no orçamento: existem mais cabeçalhos do que os listados.")
    if not present:
        parts.append(
            "NENHUM arquivo veio em texto integral: o orçamento desta chamada não cabe nem um deles. "
            "Você está lendo APENAS o mapa — qualquer conclusão sobre o texto é indevida."
        )
    if not omitted and not partial and not outline_cut:
        parts.append("Nada: a spec inteira está neste dossiê.")
    parts += [
        "",
        "> **não invente** o conteúdo do que não chegou. Se a sua conclusão depender de um arquivo",
        "> que ficou fora, DIGA isso no seu resultado em vez de preencher a lacuna.",
        "",
        # SELO DE INTEGRIDADE. O dossiê é dimensionado pelo orçamento do modelo que o runner resolveu,
        # mas um override de modelo por tenant pode dar ao agente uma janela MENOR — e aí o `_clip` do
        # runtime corta a cauda do dossiê. O corte apararia justamente esta linha, então a ausência
        # dela é prova de truncamento. Sem o selo, um arquivo cortado na cauda continuaria entre
        # `--- INÍCIO ---` e nada, parecendo íntegro: o agente concluiria sobre texto que não leu.
        f"=== FIM DO DOSSIÊ — {len(present)} arquivo(s) em texto integral, {used} chars ===",
    ]

    return Dossier(
        text="\n".join(parts),
        included=[sf.label for sf in present],
        omitted=omitted,
        partial=partial,
        mapped=mapped,
        used=used,
        total=total,
        outline_chars=len(outline),
        outline_truncated=outline_cut,
    )
