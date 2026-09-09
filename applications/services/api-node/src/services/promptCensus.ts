/**
 * 🔴 GAP-146 — CENSO DO PROMPT no lado da api (o prompt do `spec_cto` é montado AQUI, não no `agents`).
 *
 * Medição de prod (3 dias): `spec_cto` = 764 chamadas × 69.548 tokens de ENTRADA = 52,9 M tokens, a
 * maior conta unitária do cérebro da Bancada. O que ninguém sabia era de QUEM: o prompt por-arquivo é
 * uma pilha de ~15 blocos (mapa do produto, irmãos, oráculos, fatos do manifesto, recorte do arquivo,
 * lista de GAPs, histórico de tentativas…) e nenhum deles jamais foi medido no prompt que SAI.
 *
 * O censo do `agents` (`runtime._prompt_census_record`) mede só `build_user_message`, e o caminho
 * dominante do CTO — edição por arquivo com `SPEC_CTO_EDIT_FORMAT=edits` — NÃO passa por lá: a api
 * monta `prompt_override` + `user_message` e chama `/invoke/raw`. Medido ao vivo em prod: zero linhas
 * `[prompt-census]` com o laço rodando CTO. Este módulo fecha esse furo do mesmo lado onde o prompt
 * nasce, e de propósito ANTES de qualquer recorte: recortar "por relevância" sem medir é adivinhação,
 * e adivinhar antes de medir foi exatamente o GAP-147 (o cache economizou de verdade e o medidor
 * passou a mentir).
 *
 * Regras do instrumento:
 *
 *  1. **etapa 1 é SÓ LOG** — nada é persistido e nenhum prompt muda de um byte. O corte vem depois,
 *     decidido pela distribuição medida.
 *  2. **o censo FECHA**: `soma(campos) + outros == total`. `outros` são delimitadores, rótulos e a
 *     instrução final; se ficar NEGATIVO houve contagem dupla e o log grita, porque um instrumento
 *     que se engana sozinho é pior que nenhum.
 *  3. **conta o ENTREGUE**, nunca o pedido: cada campo é medido pelo tamanho do texto que entrou no
 *     prompt (já cortado pelo orçamento do bloco), senão o campo cortado apareceria como despesa que
 *     não existe.
 *  4. **não carrega conteúdo** — só tamanhos. O censo vai para log; spec de cliente não vai.
 */

/** Censo de um prompt: quem ocupou quantos chars do que efetivamente foi enviado. */
export type PromptCensus = {
  /** Caminho que montou o prompt (ex.: `api-gapfile`). É o que separa uma família de chamadas da outra. */
  origem: string;
  /** Papel do agente, quando o caminho tem um (`CTO`, `JUIZ`…). `null` = não se aplica. */
  role: string | null;
  /** Arquivo da spec em edição, quando o caminho é por-arquivo. `null` = não se aplica. */
  file: string | null;
  /** Chars TOTAIS enviados (system + user), como o provedor vai cobrar. */
  total: number;
  /** Campos com tamanho > 0, do maior para o menor. Campo vazio é omitido (ruído, não fato). */
  fields: Record<string, number>;
  /**
   * `total − soma(campos)`: delimitadores, rótulos e instrução final. **Pode ser negativo** — e nesse
   * caso é BUG de contagem dupla no chamador, não uma economia. Nunca é zerado à força.
   */
  outros: number;
};

/**
 * Monta o censo, escreve UMA linha `[prompt-census]` e devolve o censo (para teste e para quem
 * quiser anexá-lo a uma decisão). Nunca lança: instrumento não derruba a chamada que ele mede.
 *
 * @param total Tamanho REAL do que vai ser enviado (system + user). Quem chama já tem os dois.
 * @param fields Tamanho ENTREGUE de cada bloco nomeado. Zeros são descartados.
 */
export function recordPromptCensus(args: {
  origem: string;
  role?: string | null;
  file?: string | null;
  total: number;
  fields: Record<string, number>;
}): PromptCensus {
  const fields: Record<string, number> = {};
  for (const [k, v] of Object.entries(args.fields).sort((a, b) => b[1] - a[1])) {
    if (Number.isFinite(v) && v > 0) fields[k] = v;
  }
  const contados = Object.values(fields).reduce((a, b) => a + b, 0);
  const censo: PromptCensus = {
    origem: args.origem,
    role: args.role ?? null,
    file: args.file ?? null,
    total: args.total,
    fields,
    outros: args.total - contados,
  };
  try {
    const detalhe = Object.entries(fields).map(([k, v]) => `${k}=${v}c`).join(" ");
    console.log(
      `[prompt-census] origem=${censo.origem} role=${censo.role ?? "?"}`
      + `${censo.file ? ` file=${censo.file}` : ""} total=${censo.total}c ${detalhe}`
      // Negativo = o chamador contou o mesmo texto duas vezes. Aparece no log como defeito, com nome.
      + ` outros=${censo.outros}c${censo.outros < 0 ? " CONTAGEM-DUPLA" : ""}`,
    );
  } catch {
    // Log indisponível é irrelevante para a edição do arquivo; o censo devolvido segue válido.
  }
  return censo;
}
