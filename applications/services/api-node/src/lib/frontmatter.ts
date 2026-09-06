/**
 * Parser do frontmatter do manifesto de spec — módulo FOLHA de propósito.
 *
 * Ele nasceu dentro do `services/specValidation.ts` (Estágio A), mas vive aqui porque DOIS lados
 * precisam da MESMA regra e não podem se acoplar:
 *  • o Estágio A, que produz o finding `readme_no_frontmatter`;
 *  • o veto de escrita do manifesto (`services/specManifest.ts`), que recusa um manifesto que o
 *    Estágio A reprovaria na validação seguinte.
 *
 * Se cada lado tivesse a sua versão, um parser mais tolerante aprovaria conteúdo que o outro
 * reprovaria e o laço autônomo trocaria um GAP por outro, gastando LLM para andar de lado.
 */

/** `null` quando o conteúdo NÃO começa com um bloco `---` … `---` (é o que o Estágio A exige). */
export function parseFrontmatter(content: string): Record<string, string> | null {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return null;
  const out: Record<string, string> = {};
  for (const line of content.slice(4, end).split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}
