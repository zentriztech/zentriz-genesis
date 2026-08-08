/**
 * productManifest.ts — parse + validação determinística do manifesto de produto
 * (ADR-018). Núcleo SEM I/O nem LLM: recebe o texto do manifesto e a lista de
 * arquivos presentes no ZIP, e devolve o Product Sketch (grafo validado + ondas
 * por ordenação topológica) OU um erro estruturado. Rejeita ciclo / spec ausente
 * / tipo inválido / dependsOn órfão ANTES de qualquer criação de projeto.
 *
 * Formato do manifesto: PRODUCT.json (JSON nativo — sem dependência de YAML).
 * Ver contract-kit/schemas/products/product-manifest.schema.json no Connect.
 */

export interface ManifestProject {
  id: string;
  spec: string;
  type: string;
  dependsOn?: string[];
  wave?: number;
  delivery?: string;
}

export interface ProductManifest {
  schemaVersion: string;
  product: {
    name: string;
    systemId?: string;
    description?: string;
    specApproved?: boolean;
    deliveryDefault?: string;
  };
  projects: ManifestProject[];
}

export interface SketchProject extends ManifestProject {
  dependsOn: string[];
  wave: number; // onda computada (topo-sort), independente do wave declarado
}

export interface ProductSketch {
  product: ProductManifest["product"];
  projects: SketchProject[]; // ordenados por onda asc, depois por id
  waves: string[][];         // ids por onda
  schemaVersion: string;
}

export class ManifestError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const VALID_TYPES = new Set([
  "lib_ts", "backend_api_nestjs", "backend_api", "backend_api_node",
  "backend_api_python", "backend_graphql", "backend_worker",
  "frontend_dashboard", "frontend_landing", "fullstack_saas",
  "mobile_expo", "mobile_crossplatform", "other",
]);

/** Faz parse do texto do manifesto (JSON). Lança ManifestError em JSON inválido. */
export function parseManifest(text: string): ProductManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ManifestError("MANIFEST_INVALID_JSON", `PRODUCT.json inválido: ${e instanceof Error ? e.message : String(e)}`);
  }
  const m = raw as Partial<ProductManifest>;
  if (!m || typeof m !== "object") throw new ManifestError("MANIFEST_INVALID", "Manifesto vazio ou não-objeto.");
  if (!m.product || typeof m.product.name !== "string" || !m.product.name.trim()) {
    throw new ManifestError("MANIFEST_NO_PRODUCT", "Manifesto sem product.name.");
  }
  if (!Array.isArray(m.projects) || m.projects.length === 0) {
    throw new ManifestError("MANIFEST_NO_PROJECTS", "Manifesto sem projects (mínimo 1).");
  }
  return m as ProductManifest;
}

/**
 * Valida o manifesto contra os arquivos presentes e o grafo, e computa as ondas.
 * @param manifest manifesto já parseado
 * @param presentFiles caminhos de arquivos presentes no ZIP (para checar `spec`)
 */
export function buildProductSketch(manifest: ProductManifest, presentFiles: string[]): ProductSketch {
  const present = new Set(presentFiles.map((f) => f.replace(/^\.\//, "")));
  const ids = manifest.projects.map((p) => p.id);
  const idSet = new Set(ids);

  // 1. IDs únicos
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) throw new ManifestError("MANIFEST_DUPLICATE_ID", `IDs de projeto duplicados: ${[...new Set(dupes)].join(", ")}`);

  // 2. tipo válido + spec presente + dependsOn referencia ids existentes
  for (const p of manifest.projects) {
    if (!VALID_TYPES.has(p.type)) {
      throw new ManifestError("MANIFEST_INVALID_TYPE", `Projeto "${p.id}": tipo inválido "${p.type}".`, { validTypes: [...VALID_TYPES] });
    }
    const specPath = p.spec.replace(/^\.\//, "");
    if (!present.has(specPath)) {
      throw new ManifestError("MANIFEST_SPEC_MISSING", `Projeto "${p.id}": spec "${p.spec}" não encontrada no ZIP.`);
    }
    for (const dep of p.dependsOn ?? []) {
      if (!idSet.has(dep)) {
        throw new ManifestError("MANIFEST_DEP_ORPHAN", `Projeto "${p.id}": dependsOn referencia id inexistente "${dep}".`);
      }
      if (dep === p.id) {
        throw new ManifestError("MANIFEST_SELF_DEP", `Projeto "${p.id}" depende de si mesmo.`);
      }
    }
  }

  // 3. ordenação topológica de Kahn — detecta ciclo (gate determinístico, sem LLM)
  const deps = new Map<string, Set<string>>();
  const dependents = new Map<string, string[]>();
  for (const p of manifest.projects) {
    deps.set(p.id, new Set(p.dependsOn ?? []));
    for (const d of p.dependsOn ?? []) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d)!.push(p.id);
    }
  }
  const waveOf = new Map<string, number>();
  let frontier = ids.filter((id) => (deps.get(id)!.size === 0));
  let wave = 0;
  const remaining = new Set(ids);
  while (frontier.length) {
    for (const id of frontier) { waveOf.set(id, wave); remaining.delete(id); }
    const next: string[] = [];
    for (const id of frontier) {
      for (const dep of dependents.get(id) ?? []) {
        const s = deps.get(dep)!;
        s.delete(id);
        if (s.size === 0 && remaining.has(dep)) next.push(dep);
      }
    }
    frontier = [...new Set(next)];
    wave++;
  }
  if (remaining.size) {
    throw new ManifestError("MANIFEST_CYCLE", `Ciclo de dependências detectado envolvendo: ${[...remaining].join(", ")}. O grafo deve ser um DAG.`);
  }

  // 4. montar sketch ordenado por onda
  const sketchProjects: SketchProject[] = manifest.projects
    .map((p) => ({ ...p, dependsOn: p.dependsOn ?? [], wave: waveOf.get(p.id)! }))
    .sort((a, b) => a.wave - b.wave || a.id.localeCompare(b.id));

  const maxWave = Math.max(...sketchProjects.map((p) => p.wave));
  const waves: string[][] = Array.from({ length: maxWave + 1 }, () => []);
  for (const p of sketchProjects) waves[p.wave].push(p.id);

  return { product: manifest.product, projects: sketchProjects, waves, schemaVersion: manifest.schemaVersion };
}
