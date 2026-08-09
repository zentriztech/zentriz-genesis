/**
 * typePolicyParity.test.ts — invariante de REGULAGEM (achado da fatia vertical, 2026-08-09).
 *
 * Todo tipo aceito no manifesto de produto (VALID_TYPES do productManifest) DEVE ser
 * reconhecido pela policy do orchestrator (policies.json: canônico OU alias). Senão o
 * runner resolve para `_default` com `blocks_generation: true` e a geração TRAVA num loop
 * CTO↔Engineer silencioso — foi exatamente o que aconteceu com `lib_ts` (existia no api-node
 * mas faltava na policy). Este teste impede a regressão.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Espelha VALID_TYPES de productManifest.ts (tipos aceitos no PRODUCT.json).
const MANIFEST_VALID_TYPES = [
  "lib_ts", "backend_api_nestjs", "backend_api", "backend_api_node",
  "backend_api_python", "backend_graphql", "backend_worker",
  "frontend_dashboard", "frontend_landing", "fullstack_saas",
  "mobile_expo", "mobile_crossplatform", "other",
];

describe("paridade tipo-do-manifesto ↔ policy do orchestrator", () => {
  const pol = JSON.parse(readFileSync(join(__dirname, "../generated/policies.json"), "utf8")) as {
    types: Record<string, unknown>;
    type_aliases: Record<string, string>;
  };
  const known = new Set([...Object.keys(pol.types), ...Object.keys(pol.type_aliases)]);

  it("todo tipo do manifesto é conhecido pela policy (canônico ou alias)", () => {
    const missing = MANIFEST_VALID_TYPES.filter((t) => !known.has(t));
    expect(missing, `tipos sem policy (resolveriam p/ _default e travariam a geração): ${missing.join(", ")}`).toEqual([]);
  });

  it("aliases resolvem para um tipo canônico existente", () => {
    for (const [alias, canonical] of Object.entries(pol.type_aliases)) {
      expect(pol.types[canonical], `alias '${alias}' aponta p/ canônico inexistente '${canonical}'`).toBeDefined();
    }
  });

  it("lib_ts é canônico (não cai em _default) — o achado da fatia vertical", () => {
    expect(pol.types["lib_ts"]).toBeDefined();
  });
});
