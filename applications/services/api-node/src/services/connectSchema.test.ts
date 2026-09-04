import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadVendoredSchema, validateAgainst, productManifestWarnings, VENDORED_CONNECT_VERSION } from "./connectSchema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function baseManifest() {
  return {
    schemaVersion: "1.3.0",
    product: { name: "ZVoices", systemId: "zvoices", specApproved: false, deliveryDefault: "source_only",
               rationale: "corte por bounded context", connect: { environments: [{ name: "prod", type: "prod" }], integrationTierTarget: "tier1-integration-ready" } },
    projects: [
      { id: "c", spec: "specs/c.md", type: "lib_ts", dependsOn: [], archetype: "shared-contracts", stack: ["TypeScript 5"], deployTarget: "none",
        rationale: "Corte: shared-code", files: [{ path: "specs/c/contratos.md", kind: "contracts" }], connectDeclaration: "specs/c/connect.yaml" },
    ],
  };
}

describe("connectSchema (vendorizado v" + VENDORED_CONNECT_VERSION + ", modo warning)", () => {
  it("carrega os 2 schemas vendorizados", () => {
    expect(loadVendoredSchema("product-manifest")?.title).toBe("ProductManifest");
    expect(loadVendoredSchema("spec-connect-declaration")?.title).toBe("SpecConnectDeclaration");
  });

  it("manifesto 1.3.0 com campos do splitter (archetype/stack/files/connectDeclaration) é VÁLIDO", () => {
    expect(productManifestWarnings(baseManifest())).toEqual([]);
  });

  it("propriedade desconhecida e enum inválido viram avisos (nunca exceção)", () => {
    const m = baseManifest() as any;
    m.projects[0].cutReason = "service-scope"; // campo cru do splitter — NÃO existe no schema
    m.projects[0].type = "tipo-inexistente";
    const w = productManifestWarnings(m);
    expect(w.some((x) => x.includes("cutReason") && x.includes("não permitida"))).toBe(true);
    expect(w.some((x) => x.includes("fora do enum"))).toBe(true);
  });

  it("files[].kind fora do enum e connect.integrationTierTarget inválido são avisos", () => {
    const m = baseManifest() as any;
    m.projects[0].files[0].kind = "planilha";
    m.product.connect.integrationTierTarget = "tier9";
    const w = productManifestWarnings(m);
    expect(w.length).toBe(2);
  });

  it("validateAgainst: type-lista com null e $ref local (SpecConnectDeclaration)", () => {
    const s = loadVendoredSchema("spec-connect-declaration")!;
    const decl = {
      schemaVersion: "1.3.0", systemId: "x-sys", serviceId: null, serviceName: "X", responsibility: "Faz X de ponta a ponta.",
      interfaces: [{ name: "http", type: "http" }],
      owners: { technicalOwner: { id: "t", name: "T", email: "t@x.com" }, escalationPath: [{ id: "e", name: "E" }] },
    };
    expect(validateAgainst(decl, s)).toEqual([]);
    const bad = { ...decl, systemId: "Maiúsculo Inválido", owners: { technicalOwner: { name: "sem id" } } };
    const errs = validateAgainst(bad, s);
    expect(errs.some((e) => e.includes("padrão"))).toBe(true);
    expect(errs.some((e) => e.includes("owners.technicalOwner.id"))).toBe(true);
  });

  it("schemas vendorizados são byte-idênticos ao snapshot v1.3.0 do zentriz-connect (quando o repo irmão existe)", () => {
    const snap = path.resolve(__dirname, "../../../../../../zentriz-connect/contract-kit/.snapshots/v1.3.0/products");
    if (!fs.existsSync(snap)) return; // CI sem o repo irmão: pular
    for (const f of ["product-manifest.schema.json", "spec-connect-declaration.schema.json"]) {
      const vendored = fs.readFileSync(path.resolve(__dirname, "../config/connect/v1.3.0", f), "utf-8");
      const upstream = fs.readFileSync(path.join(snap, f), "utf-8");
      expect(vendored).toBe(upstream);
    }
  });
});
