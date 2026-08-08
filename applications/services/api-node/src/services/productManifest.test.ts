import { describe, it, expect } from "vitest";
import { parseManifest, buildProductSketch, computeProductHash, ManifestError } from "./productManifest.js";

const FILES = [
  "specs/SPEC-00-contracts.md", "specs/SPEC-20-tokens.md",
  "specs/SPEC-01-identity-svc.md", "specs/SPEC-02-content-svc.md",
  "specs/SPEC-03-progress-svc.md", "specs/SPEC-15-bff-mobile.md",
  "specs/SPEC-19-mobile.md",
];

function baseManifest() {
  return {
    schemaVersion: "1.1.0",
    product: { name: "ZVoices", systemId: "zvoices", specApproved: true },
    projects: [
      { id: "c", spec: "specs/SPEC-00-contracts.md", type: "lib_ts", dependsOn: [] },
      { id: "id", spec: "specs/SPEC-01-identity-svc.md", type: "backend_api_nestjs", dependsOn: ["c"] },
      { id: "ct", spec: "specs/SPEC-02-content-svc.md", type: "backend_api_nestjs", dependsOn: ["c"] },
      { id: "pr", spec: "specs/SPEC-03-progress-svc.md", type: "backend_api_nestjs", dependsOn: ["c", "ct"] },
      { id: "bff", spec: "specs/SPEC-15-bff-mobile.md", type: "backend_api_nestjs", dependsOn: ["id", "ct", "pr"] },
      { id: "mob", spec: "specs/SPEC-19-mobile.md", type: "mobile_expo", dependsOn: ["c", "bff"] },
    ],
  };
}

describe("productManifest", () => {
  it("parseia JSON válido", () => {
    const m = parseManifest(JSON.stringify(baseManifest()));
    expect(m.product.name).toBe("ZVoices");
    expect(m.projects).toHaveLength(6);
  });

  it("rejeita JSON inválido", () => {
    expect(() => parseManifest("{ not json")).toThrow(ManifestError);
  });

  it("constrói sketch com ondas topológicas corretas (caso feliz)", () => {
    const sketch = buildProductSketch(baseManifest() as any, FILES);
    const w = Object.fromEntries(sketch.projects.map((p) => [p.id, p.wave]));
    expect(w.c).toBe(0);      // sem deps
    expect(w.id).toBe(1);     // depende de c
    expect(w.ct).toBe(1);
    expect(w.pr).toBe(2);     // depende de ct(1)
    expect(w.bff).toBe(3);    // depende de pr(2)
    expect(w.mob).toBe(4);    // depende de bff(3)
    expect(sketch.waves[0]).toContain("c");
    expect(sketch.waves[4]).toEqual(["mob"]);
  });

  it("detecta CICLO e rejeita", () => {
    const m = baseManifest();
    m.projects[0].dependsOn = ["mob"]; // c → mob → bff → ... → c
    expect(() => buildProductSketch(m as any, FILES)).toThrowError(/MANIFEST_CYCLE|[Cc]iclo/);
  });

  it("rejeita spec ausente no ZIP", () => {
    const m = baseManifest();
    m.projects[0].spec = "specs/NAO-EXISTE.md";
    expect(() => buildProductSketch(m as any, FILES)).toThrowError(/SPEC_MISSING|não encontrada/);
  });

  it("rejeita tipo inválido", () => {
    const m = baseManifest();
    (m.projects[0] as any).type = "banana";
    expect(() => buildProductSketch(m as any, FILES)).toThrowError(/INVALID_TYPE|inválido/);
  });

  it("rejeita dependsOn órfão", () => {
    const m = baseManifest();
    m.projects[1].dependsOn = ["fantasma"];
    expect(() => buildProductSketch(m as any, FILES)).toThrowError(/DEP_ORPHAN|inexistente/);
  });

  it("rejeita id duplicado", () => {
    const m = baseManifest();
    m.projects[1].id = "c";
    expect(() => buildProductSketch(m as any, FILES)).toThrowError(/DUPLICATE_ID|duplicad/);
  });
});

describe("computeProductHash (idempotência)", () => {
  const manifest = '{"product":{"name":"P"},"projects":[]}';
  const files = () => new Map([["a.md", "conteudo A"], ["b.md", "conteudo B"]]);

  it("é estável para a mesma entrada", () => {
    expect(computeProductHash(manifest, files())).toBe(computeProductHash(manifest, files()));
  });

  it("independe da ordem de inserção no Map", () => {
    const m1 = new Map([["a.md", "A"], ["b.md", "B"]]);
    const m2 = new Map([["b.md", "B"], ["a.md", "A"]]);
    expect(computeProductHash(manifest, m1)).toBe(computeProductHash(manifest, m2));
  });

  it("muda se o conteúdo de um arquivo muda", () => {
    const m2 = new Map([["a.md", "conteudo A"], ["b.md", "conteudo B MODIFICADO"]]);
    expect(computeProductHash(manifest, files())).not.toBe(computeProductHash(manifest, m2));
  });

  it("muda se o manifesto muda", () => {
    expect(computeProductHash(manifest, files()))
      .not.toBe(computeProductHash('{"product":{"name":"OUTRO"},"projects":[]}', files()));
  });

  it("evita colisão por concatenação (comprimento explícito)", () => {
    // ("ab","c") vs ("a","bc") não devem colidir graças ao length no framing.
    const m1 = new Map([["x.md", "ab"], ["y.md", "c"]]);
    const m2 = new Map([["x.md", "a"], ["y.md", "bc"]]);
    expect(computeProductHash(manifest, m1)).not.toBe(computeProductHash(manifest, m2));
  });

  it("retorna SHA-256 hex (64 chars)", () => {
    expect(computeProductHash(manifest, files())).toMatch(/^[0-9a-f]{64}$/);
  });
});
