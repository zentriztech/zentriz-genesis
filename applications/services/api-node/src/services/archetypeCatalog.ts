/**
 * archetypeCatalog.ts — RFC-0004 F2: loader do catálogo FECHADO de arquétipos.
 *
 * Fonte única: config/archetype-catalog.v1.json (arquivo versionado no repo — D2; NUNCA
 * seed SQL). O catálogo mapeia o arquétipo VISÍVEL (manifesto/Bancada) para o
 * `factoryType` que a fábrica roteia (VALID_TYPES do productManifest.ts) — o teste
 * archetypeCatalog.test.ts garante que todo factoryType existe na taxonomia da fábrica
 * E que a cópia Python (product_architect.VALID_TYPES) segue idêntica à TS.
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

export interface Archetype {
  id: string;
  factoryType: string;
  description: string;
  validStacks: string[];
  deployTargets: string[];
  checklist: string[];
}

export interface ArchetypeCatalog {
  catalogVersion: string;
  archetypes: Archetype[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _catalog: ArchetypeCatalog | null = null;

export function loadArchetypeCatalog(): ArchetypeCatalog {
  if (_catalog) return _catalog;
  const file = path.join(__dirname, "..", "config", "archetype-catalog.v1.json");
  const raw = JSON.parse(readFileSync(file, "utf-8")) as ArchetypeCatalog;
  if (!raw?.catalogVersion || !Array.isArray(raw.archetypes) || raw.archetypes.length === 0) {
    throw new Error("archetype-catalog.v1.json inválido (catalogVersion/archetypes)");
  }
  _catalog = raw;
  return raw;
}

export function getArchetype(id: string): Archetype | undefined {
  return loadArchetypeCatalog().archetypes.find((a) => a.id === id);
}

/** Deriva o arquétipo a partir do factoryType (p/ propostas do splitter que só trazem `type`). */
export function archetypeForFactoryType(factoryType: string): Archetype | undefined {
  return loadArchetypeCatalog().archetypes.find((a) => a.factoryType === factoryType);
}

/**
 * Gera o README-manifesto DETERMINÍSTICO de um projeto (D7): frontmatter AUTORAL
 * (kind/archetype/stack/depends_on/deploy_target — nunca estado/hash, que vivem só no
 * banco) + descrição do arquétipo + checklist como guia de evolução da spec.
 */
export function renderProjectReadme(opts: {
  title: string;
  archetype: Archetype;
  stack?: string[];
  dependsOn?: string[];
  deployTarget?: string;
}): string {
  const stack = (opts.stack ?? []).filter(Boolean);
  const deps = (opts.dependsOn ?? []).filter(Boolean);
  const lines = [
    "---",
    "kind: project",
    `archetype: ${opts.archetype.id}`,
    `stack: [${stack.join(", ")}]`,
    `depends_on: [${deps.join(", ")}]`,
    `deploy_target: ${opts.deployTarget ?? "none"}`,
    "---",
    "",
    `# ${opts.title}`,
    "",
    `> ${opts.archetype.description}`,
    "",
    "## Guia de especificação (checklist do arquétipo)",
    ...opts.archetype.checklist.map((c) => `- [ ] ${c}`),
    "",
    "A especificação detalhada vive em `01-spec.md` (e arquivos `nn-*.md` adicionais).",
    "",
  ];
  return lines.join("\n");
}
