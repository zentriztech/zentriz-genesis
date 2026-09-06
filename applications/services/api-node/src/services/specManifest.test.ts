/**
 * A5.3 — o veto do manifesto. Cada teste amarra um veto ao finding que o Estágio A produziria se o
 * arquivo fosse escrito assim: o valor deste módulo é NÃO trocar um aviso por outro (ou por um
 * bloqueador) no meio de um laço autônomo que roda sem humano na frente.
 */
import { describe, it, expect } from "vitest";
import { assessManifest, expectedArchetype, MANIFEST_PATH } from "./specManifest.js";
import { archetypeForFactoryType } from "./archetypeCatalog.js";

const BACKEND = archetypeForFactoryType("backend_api")!;

function manifest(fm: string[], body = "x".repeat(400)): string {
  return ["---", ...fm, "---", "", "# NVX LastMile", "", body].join("\n");
}

const VALID = manifest([
  `archetype: ${BACKEND.id}`,
  "kind: project",
  "stack: [nodejs]",
  "depends_on: []",
  `deploy_target: ${BACKEND.deployTargets[0]}`,
]);

describe("expectedArchetype", () => {
  it("deriva o arquétipo do project_type do banco (fato vence opinião)", () => {
    expect(expectedArchetype({ project_type: "backend_api" })?.id).toBe(BACKEND.id);
  });
  it("sem project_type não há fato a impor — qualquer arquétipo do catálogo é aceitável", () => {
    expect(expectedArchetype({})).toBeNull();
    expect(expectedArchetype(null)).toBeNull();
    expect(expectedArchetype({ project_type: "   " })).toBeNull();
  });
  it("project_type desconhecido não vira arquétipo inventado", () => {
    expect(expectedArchetype({ project_type: "nao_existe" })).toBeNull();
  });
});

describe("assessManifest — aprova", () => {
  it("aceita o manifesto no formato exigido e devolve o conteúdo normalizado", () => {
    const v = assessManifest(VALID, { expected: BACKEND });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.archetypeId).toBe(BACKEND.id);
    expect(v.content.startsWith("---\n")).toBe(true);
    expect(v.content.endsWith("\n")).toBe(true);
  });
  it("tolera CRLF e BOM (o que muda é o transporte, não a decisão do agente)", () => {
    const v = assessManifest(`﻿${VALID.replace(/\n/g, "\r\n")}`, { expected: BACKEND });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.content).not.toContain("\r");
  });
  it("sem arquétipo esperado, aceita qualquer id do catálogo", () => {
    expect(assessManifest(VALID).ok).toBe(true);
  });
});

describe("assessManifest — veta o que faria o laço andar para trás", () => {
  it("EMPTY: resposta vazia", () => {
    expect(assessManifest("   \n ")).toMatchObject({ ok: false, code: "EMPTY" });
  });
  it("LOOKS_LIKE_EDITS: blocos de edição para um arquivo que não existe", () => {
    const edits = "<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE\n";
    expect(assessManifest(edits)).toMatchObject({ ok: false, code: "LOOKS_LIKE_EDITS" });
  });
  it("NO_FRONTMATTER: sem o bloco YAML de abertura → viraria `readme_no_frontmatter`", () => {
    expect(assessManifest(`# NVX LastMile\n\n${"x".repeat(400)}`))
      .toMatchObject({ ok: false, code: "NO_FRONTMATTER" });
  });
  it("NO_FRONTMATTER: frontmatter que não começa na primeira linha não conta", () => {
    expect(assessManifest(`Preâmbulo\n\n${VALID}`)).toMatchObject({ ok: false, code: "NO_FRONTMATTER" });
  });
  it("NO_ARCHETYPE: frontmatter sem `archetype`", () => {
    expect(assessManifest(manifest(["kind: project", "stack: [nodejs]"])))
      .toMatchObject({ ok: false, code: "NO_ARCHETYPE" });
  });
  it("ARCHETYPE_UNKNOWN: id fora do catálogo trocaria um aviso por um BLOQUEADOR", () => {
    expect(assessManifest(manifest(["kind: project", "archetype: microsservico-mágico"])))
      .toMatchObject({ ok: false, code: "ARCHETYPE_UNKNOWN" });
  });
  it("ARCHETYPE_MISMATCH: o manifesto não pode contradizer o project_type do banco", () => {
    const other = archetypeForFactoryType("frontend_dashboard")!;
    expect(other.id).not.toBe(BACKEND.id);
    const v = assessManifest(manifest(["kind: project", `archetype: ${other.id}`]), { expected: BACKEND });
    expect(v).toMatchObject({ ok: false, code: "ARCHETYPE_MISMATCH" });
  });
  it("STATE_FIELDS: `spec_hash`/`status_spec` no frontmatter (estado vive no banco)", () => {
    expect(assessManifest(manifest(["kind: project", `archetype: ${BACKEND.id}`, "spec_hash: abc"])))
      .toMatchObject({ ok: false, code: "STATE_FIELDS" });
    expect(assessManifest(manifest(["kind: project", `archetype: ${BACKEND.id}`, "status_spec: validated"])))
      .toMatchObject({ ok: false, code: "STATE_FIELDS" });
  });
  it("TOO_SHORT: frontmatter válido com corpo degenerado não é manifesto", () => {
    expect(assessManifest(manifest(["kind: project", `archetype: ${BACKEND.id}`], "ok")))
      .toMatchObject({ ok: false, code: "TOO_SHORT" });
  });
});

describe("MANIFEST_PATH", () => {
  it("é o único lugar que o Estágio A aceita (raiz, este nome)", () => {
    expect(MANIFEST_PATH).toBe("README.md");
  });
});
