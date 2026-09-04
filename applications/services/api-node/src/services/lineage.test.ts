import { describe, it, expect, vi } from "vitest";
import { resolveLineageRoot, identityInputsFor } from "./lineage.js";
import { deriveSystemService } from "./githubPush.js";

function dbReturning(rows: unknown[]) {
  return { query: vi.fn(async () => ({ rows })) };
}

describe("lineage (Evoluir E1)", () => {
  it("raiz de v3 → v2 → v1 é v1 (CTE ascendente, não só 2 saltos)", async () => {
    const db = dbReturning([{ id: "root", title: "Controle Financeiro", product_id: "prod", depth: 2 }]);
    const root = await resolveLineageRoot(db as never, "v3");
    expect(root).toEqual({ id: "root", title: "Controle Financeiro", product_id: "prod", depth: 2 });
    const sql = (db.query.mock.calls[0] as unknown[])[0] as string;
    expect(sql).toMatch(/WITH RECURSIVE up/);
    expect(sql).toMatch(/p\.id = up\.parent_project_id/); // sobe, não desce
    expect(sql).toMatch(/depth < 64/);
  });

  it("identidade do filho = identidade da RAIZ (mesmo serviceId em todas as versões)", async () => {
    const db = dbReturning([{ id: "root", title: "Controle Financeiro", product_id: "prod", depth: 1 }]);
    const child = await identityInputsFor(db as never, "child", "Controle Financeiro — Evolução v2");
    expect(child).toEqual({ title: "Controle Financeiro", projectId: "root", rootId: "root", isEvolution: true });
    const idChild = deriveSystemService({ productSystemId: "cf", productName: "CF", title: child.title, projectId: child.projectId, soloApp: false });
    const idRoot = deriveSystemService({ productSystemId: "cf", productName: "CF", title: "Controle Financeiro", projectId: "root", soloApp: false });
    expect(idChild).toEqual(idRoot);
    // sem lineage: título do próprio filho geraria serviceId DIFERENTE (o bug que motivou o E1)
    const idBug = deriveSystemService({ productSystemId: "cf", productName: "CF", title: "Controle Financeiro — Evolução v2", projectId: "child", soloApp: false });
    expect(idBug.serviceId).not.toEqual(idRoot.serviceId);
  });

  it("projeto raiz (sem pai) devolve o próprio — comportamento anterior preservado", async () => {
    const db = dbReturning([{ id: "p1", title: "X", product_id: null, depth: 0 }]);
    expect(await identityInputsFor(db as never, "p1", "X")).toEqual({ title: "X", projectId: "p1", rootId: "p1", isEvolution: false });
    const empty = dbReturning([]);
    expect(await identityInputsFor(empty as never, "p9", "Y")).toEqual({ title: "Y", projectId: "p9", rootId: "p9", isEvolution: false });
  });
});
