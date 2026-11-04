import { describe, expect, it } from "vitest";
import { cardWritableMasks, isCardWritablePath, isRequestFile, newFilePathProblem, suggestRfcPath, visibleDraftFiles } from "./specApi";
import { safeHttpsUrl } from "./safeUrl";
import { specFixture } from "./contractFixtures";

describe("escopo de escrita do card (espelho do backend, provado contra as fixtures reais)", () => {
  it("aceita só tickets/<código>/**, docs/rfc/** e docs/adr/**", () => {
    for (const ok of ["docs/rfc/RFC-0001-x.md", "docs/adr/ADR-001-x.md", "tickets/TK-0001/request.md", "tickets/TK-0001/anexos/a.md", "docs/rfc/sub/RFC-0002-x.md"])
      expect(isCardWritablePath("TK-0001", ok), ok).toBe(true);
    for (const no of ["spec.md", "rfc/RFC-001.md", "docs/regras.md", "tickets/TK-0002/x.md", "docs/rfc/../x.md", "/docs/rfc/x.md", "docs/rfc/", "docs/rfc", "docs/./rfc/x.md", "a/b/c/d/e.md", "Docs/rfc/x.md"])
      expect(isCardWritablePath("TK-0001", no), no).toBe(false);
  });
  it("as máscaras mostradas são as mesmas que o servidor devolve em 'writable'", () => {
    const e = specFixture<{ writable: string[] }>("spec-file.post-400-fora-do-escopo").body;
    expect(cardWritableMasks("TK-0001")).toEqual(e.writable);
  });
  it("os caminhos que o backend REAL recusou nas fixtures também são recusados pelo cliente", () => {
    for (const [name, p] of [["spec-file.post-400-fora-do-escopo", "rfc/RFC-001.md"], ["spec-file.post-400-raiz", "spec.md"]] as const) {
      expect(specFixture(name).status).toBe(400);
      expect(newFilePathProblem("TK-0001", p), p).toMatch(/O card só escreve em/);
    }
  });
  it("os caminhos que o backend REAL aceitou nas fixtures passam na checagem do cliente", () => {
    for (const p of ["docs/rfc/RFC-0001-exportar-csv.md", "docs/adr/ADR-001-formato-csv.md"]) expect(newFilePathProblem("TK-0001", p), p).toBeNull();
    expect(newFilePathProblem("TK-0001", "")).toMatch(/Informe/);
    expect(newFilePathProblem("TK-0001", "docs/rfc/x.txt")).toMatch(/\.md/);
  });
  it("lista só o que o card vê: RFCs, ADRs e o pedido (nunca o resto da árvore); RFC primeiro", () => {
    const tree = specFixture<{ files: Array<{ path: string }> }>("spec-tree.with-rfc").body.files.map((f) => f.path);
    expect(visibleDraftFiles("TK-0001", [...tree, "spec.md", "docs/regras.md"])).toEqual(["docs/rfc/RFC-0001-exportar-csv.md", "tickets/TK-0001/request.md"]);
    expect(isRequestFile("tickets/TK-0001/request.md")).toBe(true);
    expect(isRequestFile("docs/rfc/x.md")).toBe(false);
  });
  it("sugere docs/rfc/RFC-NNNN-<slug>.md logo após o maior número presente", () => {
    expect(suggestRfcPath([], "Exportar entregas em CSV")).toBe("docs/rfc/RFC-0001-exportar-entregas-em-csv.md");
    expect(suggestRfcPath(["docs/rfc/RFC-0007-a.md", "docs/rfc/RFC-0003-b.md"], "Ação rápida!")).toBe("docs/rfc/RFC-0008-acao-rapida.md");
    // AB-05: a versão corrente também reserva números — HEAD com RFC-0001 e rascunho vazio ⇒ RFC-0002 (antes sugeria RFC-0001 e duplicava)
    expect(suggestRfcPath([], "Exportar CSV", ["docs/rfc/RFC-0001-exportar.md"])).toBe("docs/rfc/RFC-0002-exportar-csv.md");
    expect(suggestRfcPath(["docs/rfc/RFC-0002-a.md"], "x", ["docs/rfc/RFC-0004-legado.md", "docs/adr/ADR-009-y.md"])).toBe("docs/rfc/RFC-0005-x.md");
    expect(newFilePathProblem("TK-0001", suggestRfcPath([], "qualquer título"))).toBeNull();
  });
});

describe("safeHttpsUrl (Y-18)", () => {
  it("só https://", () => {
    expect(safeHttpsUrl("https://github.com/zentriz-demo/entregas/pull/42")).toBe("https://github.com/zentriz-demo/entregas/pull/42");
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "http://github.com/x", "//evil.example/x", "/relativo", "https:// com espaço", "", null, undefined])
      expect(safeHttpsUrl(bad as string), String(bad)).toBeNull();
  });
});
