/**
 * A5.3 (2026-09-06) — o GAP que NENHUMA ação da Bancada resolvia: `no_readme`.
 *
 * ## O que foi medido (NVX LastMile, prod)
 *
 * A validação `cedb11df` fechou com 22 findings; um deles é do Estágio A (determinístico):
 *
 * ```json
 * {"file": "", "severity": "warning", "anchor": "no_readme", "title": "Spec sem manifesto (README.md)"}
 * ```
 *
 * Ele conta como GAP IMPORTANTE (🟡) em `tallyGaps` — logo **sustenta mais uma rodada** do modo
 * autônomo — mas `file` é vazio, então:
 *
 *  • não entra em `importantFileQueue` (a fila é por arquivo existente);
 *  • nenhum arquivo IRMÃO o resolve: o Estágio A só aceita um `README.md` na RAIZ da árvore
 *    (`specValidation.ts:176`), então editar `visao-escopo.md` jamais derruba este finding;
 *  • o roteador de GAPs (Stage A → arquivo) também não ajuda: rotear um "arquivo que falta" para um
 *    arquivo que existe só faria o CTO gastar tokens numa correção impossível.
 *
 * Consequência: o laço autônomo **nunca** consegue terminar em `succeeded` — ele resolve tudo o que
 * é resolvível, continua com ≥1 GAP importante ativo e termina em `exhausted`/`stalled`. E como o
 * comentário do próprio Estágio A diz, "100% das specs pré-RFC não têm manifesto": o defeito vale
 * para toda spec legada dividida, não para um caso isolado.
 *
 * ## O que este módulo faz
 *
 * Só o VETO. O conteúdo do manifesto é decisão do agente (Lei: Genesis é 100% LLM — estrutura e
 * conteúdo de spec são do CTO, não do código). O que o código garante é que o arquivo escrito
 * satisfaz as MESMAS regras que o Estágio A vai reaplicar na validação seguinte — senão a rodada
 * trocaria um warning (`no_readme`) por outro (`readme_no_frontmatter`) ou, pior, por um BLOCKER
 * (`archetype_unknown`), e o laço andaria para trás.
 *
 * Por isso o veto reusa `parseFrontmatter` (`lib/frontmatter.ts`, o MESMO módulo folha que o Estágio A
 * usa — não um equivalente) e
 * o `archetypeCatalog` (mesma fonte de verdade do arquétipo).
 */
import { getArchetype, archetypeForFactoryType, type Archetype } from "./archetypeCatalog.js";
import { parseFrontmatter } from "../lib/frontmatter.js";

/** O manifesto tem UM lugar possível: raiz da árvore, este nome. É a regra do Estágio A. */
export const MANIFEST_PATH = "README.md";

/**
 * Arquétipo ESPERADO do projeto, quando o banco já sabe (fato vence opinião).
 *
 * `projects.extra.project_type` é o `factoryType` escolhido na criação do projeto — é o que a
 * fábrica realmente roteia. Se ele existe, o manifesto NÃO pode declarar outro arquétipo: seria o
 * documento contradizendo a execução. Quando não existe (spec importada crua), não há fato para
 * impor e qualquer arquétipo do catálogo é aceito.
 */
export function expectedArchetype(extra: unknown): Archetype | null {
  const type = (extra as { project_type?: unknown } | null)?.project_type;
  if (typeof type !== "string" || !type.trim()) return null;
  return archetypeForFactoryType(type.trim()) ?? null;
}

export type ManifestVeto =
  | { code: "EMPTY"; message: string }
  | { code: "NO_FRONTMATTER"; message: string }
  | { code: "NO_ARCHETYPE"; message: string }
  | { code: "ARCHETYPE_UNKNOWN"; message: string }
  | { code: "ARCHETYPE_MISMATCH"; message: string }
  | { code: "STATE_FIELDS"; message: string }
  | { code: "TOO_SHORT"; message: string }
  | { code: "LOOKS_LIKE_EDITS"; message: string };

export type ManifestAssessment =
  | { ok: true; content: string; archetypeId: string }
  | ({ ok: false } & ManifestVeto);

/** Um manifesto útil tem frontmatter + título + algum corpo. Abaixo disto é resposta degenerada. */
const MANIFEST_MIN_CHARS = 200;

/**
 * Aprova (ou recusa) o conteúdo proposto para o manifesto.
 *
 * Cada veto corresponde a um finding que o Estágio A produziria se o arquivo fosse escrito assim —
 * a lista NÃO é opinião de estilo:
 *  • sem frontmatter → `readme_no_frontmatter` (warning);
 *  • arquétipo fora do catálogo → `archetype_unknown` (**blocker**, pior que o GAP original);
 *  • `spec_hash`/`status_spec` no frontmatter → `state_in_frontmatter` (warning);
 *  • arquétipo diferente do `project_type` do banco → o manifesto mentiria sobre a própria fábrica.
 */
export function assessManifest(
  raw: string,
  opts: { expected?: Archetype | null } = {},
): ManifestAssessment {
  const content = (raw ?? "").replace(/\r\n/g, "\n").replace(/^﻿/, "").trim();
  if (!content) return { ok: false, code: "EMPTY", message: "o agente não devolveu conteúdo para o manifesto" };
  if (/^<{5,}\s*SEARCH\s*$/m.test(content)) {
    return {
      ok: false, code: "LOOKS_LIKE_EDITS",
      message: "o agente devolveu blocos de edição, mas o manifesto ainda não existe — não há o que editar",
    };
  }
  // O frontmatter tem de ser a PRIMEIRA coisa do arquivo (é o que o Estágio A exige): `parseFrontmatter`
  // devolve `null` para qualquer coisa que não comece com `---\n`, e é isso que vira o veto abaixo.
  const normalized = `${content}\n`;
  const fm = parseFrontmatter(normalized);
  if (!fm) {
    return {
      ok: false, code: "NO_FRONTMATTER",
      message: "o manifesto veio sem o bloco YAML de abertura (`---` na primeira linha e `---` fechando)",
    };
  }
  const arch = (fm.archetype ?? "").trim();
  if (!arch) return { ok: false, code: "NO_ARCHETYPE", message: "o frontmatter não declara `archetype`" };
  if (!getArchetype(arch)) {
    return {
      ok: false, code: "ARCHETYPE_UNKNOWN",
      message: `arquétipo \`${arch}\` não existe no catálogo — escrever isso trocaria um aviso por um BLOQUEADOR`,
    };
  }
  if (opts.expected && arch !== opts.expected.id) {
    return {
      ok: false, code: "ARCHETYPE_MISMATCH",
      message: `o manifesto declara \`${arch}\`, mas este projeto é \`${opts.expected.id}\` (project_type \`${opts.expected.factoryType}\` no banco)`,
    };
  }
  if (fm.spec_hash !== undefined || fm.status_spec !== undefined) {
    return {
      ok: false, code: "STATE_FIELDS",
      message: "o frontmatter traz `spec_hash`/`status_spec` — estado vive só no banco e o validador reclamaria disso",
    };
  }
  if (normalized.length < MANIFEST_MIN_CHARS) {
    return {
      ok: false, code: "TOO_SHORT",
      message: `manifesto com ${normalized.length} caracteres — abaixo do mínimo de ${MANIFEST_MIN_CHARS} para ser um documento útil`,
    };
  }
  return { ok: true, content: normalized, archetypeId: arch };
}
