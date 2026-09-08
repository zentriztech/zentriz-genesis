/**
 * 🔴 GAP-122 (pedido do Jean, medido na Bancada em 2026-09-08) — **arquivo novo da spec não entrava no
 * índice do `README.md`**, e nem quando o chat DEPOIS reescreveu o próprio README ele foi indexado.
 *
 * O `README.md` da raiz é o manifesto: "o documento de entrada que declara o que este projeto é e
 * **indexa os demais**" (`buildManifestRequest`). Quando `arquitetura-modelo.md` foi criado, o índice
 * ficou desatualizado — e nada no laço media isso:
 *
 *  • o prompt de edição do README (`manifestFactBlock`) entregava as regras do frontmatter e o catálogo
 *    de arquétipos, mas **não a árvore** — o editor não tinha como saber que existe um arquivo novo, e
 *    "adicione ao índice" nunca foi pedido por ninguém;
 *  • o inventário do estágio B lista todos os arquivos, mas o juiz teria de cruzar 12 nomes contra o
 *    texto do README à mão para notar a ausência — cobrança que ele nunca fez em nenhuma das runs.
 *
 * Arquivo fora do índice é o mesmo defeito do J1 por outra ponta: quem lê a spec pela porta da frente
 * não chega ao arquivo, então o conteúdo existe e não conta.
 *
 * ## O que este módulo faz (e o que NÃO faz)
 *
 * Faz uma MEDIÇÃO, em UM lugar só, consumida pelas duas pontas (o pedido de edição do README e a
 * entrada da validação): quais arquivos da spec **não são citados em nenhum lugar** do texto do
 * manifesto. Não decide se isso é GAP, não decide severidade, não escreve índice nenhum e não escolhe
 * onde a linha entra — isso é do agente (Lei: Genesis é 100% LLM).
 *
 * A medição é DELIBERADAMENTE conservadora — conta como citado quem aparece por caminho **ou** só pelo
 * nome do arquivo, em qualquer contexto (link, tabela, prosa). Assim ela SUBnotifica: pode deixar de
 * apontar um arquivo mal indexado, mas não inventa órfão que o README menciona de alguma forma. Num
 * fato que vai virar cobrança ao agente, o erro tem de cair para o lado de não acusar à toa.
 */
import { MANIFEST_PATH } from "./specManifest.js";

export interface IndexCoverageFile {
  path: string;
  content?: string;
}

const norm = (s: string) => s.trim().toLowerCase();
const isManifest = (p: string) => norm(p) === norm(MANIFEST_PATH);

/**
 * Arquivos da spec que o texto do manifesto não cita — nem pelo caminho, nem pelo nome do arquivo.
 *
 * `readme` vazio (o manifesto ainda não existe) devolve lista vazia: o laço já tem uma rodada dedicada
 * à CRIAÇÃO do manifesto (A5.3), e acusar "12 arquivos fora do índice" de um índice que não nasceu
 * transformaria essa rodada num relatório de defeitos inevitáveis.
 */
export function unindexedFiles(readme: string, paths: readonly string[]): string[] {
  const hay = norm(readme ?? "");
  if (!hay) return [];
  return paths.filter((p) => {
    if (!p || isManifest(p)) return false;
    const full = norm(p);
    const base = full.split("/").pop() ?? full;
    return !hay.includes(full) && !hay.includes(base);
  });
}

/**
 * FATO para o pedido de edição do `README.md`: a árvore atual e, dela, o que o índice não cita.
 *
 * Só é montado para o manifesto (o chamador garante) e só diz o que foi MEDIDO. A instrução é de
 * completude do índice, não de forma: o formato do índice (tabela, lista, seção) é decisão do agente,
 * e forçar um formato aqui seria a automação fixa que a Lei proíbe.
 */
export function indexCoverageFactBlock(paths: readonly string[], orphans: readonly string[]): string {
  if (paths.length === 0) return "";
  const tree = paths.filter((p) => !isManifest(p)).map((p) => `  • \`${p}\``).join("\n");
  const lines = [
    `--- FATOS DO ÍNDICE (este README indexa ${paths.filter((p) => !isManifest(p)).length} arquivo(s) da spec) ---`,
    "Árvore ATUAL da especificação (medida agora, no banco — não é o que estava aqui quando você a escreveu):",
    tree,
  ];
  if (orphans.length > 0) {
    lines.push(
      `MEDIDO: ${orphans.length} destes arquivos NÃO são citados em nenhum lugar deste README:`,
      orphans.map((p) => `  • \`${p}\``).join("\n"),
      "Como o manifesto é a porta de entrada da spec, arquivo fora do índice é conteúdo que o leitor"
      + " não alcança. Indexe-os nesta edição, no mesmo formato de índice que este arquivo já usa"
      + " (a forma é sua decisão; a completude não é).",
    );
  } else {
    lines.push("MEDIDO: todos os arquivos acima são citados neste README — não mexa no índice sem motivo.");
  }
  lines.push("--- FIM DOS FATOS DO ÍNDICE ---", "");
  return lines.join("\n");
}

/**
 * FATO para o inventário do estágio B: o que o manifesto não indexa.
 *
 * Vai como MEDIÇÃO, sem veredicto — o juiz decide se é achado e com que severidade. Vazio quando não
 * há órfão ou quando o manifesto não está entre os arquivos (aí não há índice contra o que medir).
 */
export function indexCoverageValidationFact(files: readonly IndexCoverageFile[]): string {
  const manifest = files.find((f) => isManifest(f.path));
  if (!manifest) return "";
  const orphans = unindexedFiles(manifest.content ?? "", files.map((f) => f.path));
  if (orphans.length === 0) return "";
  return [
    `[MEDIDO PELO SISTEMA — ${orphans.length} arquivo(s) da spec NÃO são citados em nenhum lugar do`,
    ` \`${MANIFEST_PATH}\` (o manifesto, que é a porta de entrada e o índice da spec):`,
    ...orphans.map((p) => `  • \`${p}\``),
    " Este é um fato de contagem, não um veredicto: julgue você se a ausência no índice é um defeito e",
    " de que severidade, e atribua o achado ao arquivo que deve ser corrigido.]",
  ].join("\n");
}
