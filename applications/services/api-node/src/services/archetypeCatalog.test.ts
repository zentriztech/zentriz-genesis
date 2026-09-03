/**
 * archetypeCatalog.test.ts — RFC-0004 F2/T1.5: o catálogo é a FONTE ÚNICA da taxonomia.
 *
 * Garante que (a) todo factoryType do catálogo existe nos VALID_TYPES da fábrica (TS),
 * (b) a cópia Python (product_architect.VALID_TYPES) permanece IDÊNTICA à TS — o teste lê
 * o .py cru e extrai o set, então qualquer divergência entre as camadas quebra aqui, e
 * (c) o template de README gera frontmatter AUTORAL sem campos de estado (spec_hash/
 * status_spec são proibidos no arquivo — auto-referentes/forjáveis, RFC §6.1).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadArchetypeCatalog, getArchetype, archetypeForFactoryType, renderProjectReadme } from "./archetypeCatalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Extrai VALID_TYPES do productManifest.ts (TS) e do product_architect.py (Python) CRUS —
// se alguém editar uma cópia sem a outra, este teste é o alarme.
function extractSet(source: string, marker: string): Set<string> {
  const idx = source.indexOf(marker);
  expect(idx, `marcador '${marker}' não encontrado`).toBeGreaterThan(-1);
  const block = source.slice(idx, source.indexOf("}", idx) + 1);
  const values = [...block.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
  return new Set(values);
}

const tsSource = fs.readFileSync(path.join(__dirname, "productManifest.ts"), "utf-8");
const pySource = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "..", "orchestrator", "product_architect.py"),
  "utf-8",
);
const tsTypes = extractSet(tsSource, "const VALID_TYPES");
const pyTypes = extractSet(pySource, "VALID_TYPES = {");

describe("archetype catalog — fonte única da taxonomia (T1.5)", () => {
  it("carrega e tem versão + arquétipos", () => {
    const cat = loadArchetypeCatalog();
    expect(cat.catalogVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(cat.archetypes.length).toBeGreaterThanOrEqual(6);
  });

  it("todo factoryType do catálogo existe nos VALID_TYPES da fábrica (TS)", () => {
    for (const a of loadArchetypeCatalog().archetypes) {
      expect(tsTypes.has(a.factoryType), `factoryType '${a.factoryType}' (${a.id}) fora da taxonomia da fábrica`).toBe(true);
    }
  });

  it("VALID_TYPES Python === VALID_TYPES TS (cópias sincronizadas)", () => {
    expect([...pyTypes].sort()).toEqual([...tsTypes].sort());
  });

  it("ids de arquétipo são únicos e kebab-case", () => {
    const ids = loadArchetypeCatalog().archetypes.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{1,40}$/);
  });

  it("getArchetype/archetypeForFactoryType resolvem", () => {
    expect(getArchetype("backend-service")?.factoryType).toBe("backend_api");
    expect(archetypeForFactoryType("frontend_dashboard")?.id).toBe("web-frontend");
    expect(getArchetype("inexistente")).toBeUndefined();
  });

  it("renderProjectReadme: frontmatter autoral, SEM campos de estado", () => {
    const md = renderProjectReadme({
      title: "API de Pedidos",
      archetype: getArchetype("backend-service")!,
      stack: ["nodejs", "fastify"],
      dependsOn: ["shared-contracts"],
      deployTarget: "aws-ecs",
    });
    expect(md).toContain("kind: project");
    expect(md).toContain("archetype: backend-service");
    expect(md).toContain("stack: [nodejs, fastify]");
    expect(md).toContain("depends_on: [shared-contracts]");
    expect(md).toContain("deploy_target: aws-ecs");
    // estado NUNCA no arquivo (RFC §6.1 — auto-referente/forjável):
    expect(md).not.toContain("spec_hash");
    expect(md).not.toContain("status_spec");
  });
});
