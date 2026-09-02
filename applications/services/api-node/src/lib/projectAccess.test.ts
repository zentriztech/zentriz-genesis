import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canAccessProjectRow } from "./projectAccess.js";
import type { AuthUser } from "../middleware/auth.js";

function user(partial: Partial<AuthUser>): AuthUser {
  return { id: "u1", email: "u@x", role: "user", tenantId: "t1", ...partial };
}

describe("canAccessProjectRow (fix 1.4 — auditoria 2026-09-02)", () => {
  it("zentriz_admin acessa qualquer projeto", () => {
    expect(canAccessProjectRow(user({ role: "zentriz_admin", tenantId: null }), { tenant_id: "t9", created_by: "outro" })).toBe(true);
  });

  it("mesmo tenant acessa", () => {
    expect(canAccessProjectRow(user({}), { tenant_id: "t1", created_by: "outro" })).toBe(true);
  });

  it("criador NÃO acessa projeto de OUTRO tenant (o furo original)", () => {
    expect(canAccessProjectRow(user({ tenantId: "t2" }), { tenant_id: "t1", created_by: "u1" })).toBe(false);
  });

  it("criador demovido/movido não mantém acesso cross-tenant", () => {
    // ex-zentriz_admin demovido a user de t2, criou projeto em t1
    expect(canAccessProjectRow(user({ role: "user", tenantId: "t2" }), { tenant_id: "t1", created_by: "u1" })).toBe(false);
  });

  it("tenant nulo dos dois lados NÃO concede por si só", () => {
    expect(canAccessProjectRow(user({ tenantId: null }), { tenant_id: null, created_by: "outro" })).toBe(false);
  });

  it("projeto SEM tenant (legado): só o criador acessa", () => {
    expect(canAccessProjectRow(user({ tenantId: null }), { tenant_id: null, created_by: "u1" })).toBe(true);
    expect(canAccessProjectRow(user({ tenantId: "t1" }), { tenant_id: null, created_by: "u1" })).toBe(true);
  });

  it("tenant diferente nega", () => {
    expect(canAccessProjectRow(user({ tenantId: "t2" }), { tenant_id: "t1", created_by: "outro" })).toBe(false);
  });
});

describe("grep-guard: nenhuma checagem inline do padrão antigo pode voltar", () => {
  it("rotas não contêm mais 'created_by === user.id' fora do helper", () => {
    const routesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "routes");
    const offenders: string[] = [];
    for (const f of readdirSync(routesDir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const src = readFileSync(join(routesDir, f), "utf-8");
      if (/created_by\s*[!=]==?\s*user\.id/.test(src)) offenders.push(f);
    }
    // Toda checagem de acesso a projeto DEVE usar canAccessProjectRow (lib/projectAccess.ts).
    expect(offenders).toEqual([]);
  });
});
