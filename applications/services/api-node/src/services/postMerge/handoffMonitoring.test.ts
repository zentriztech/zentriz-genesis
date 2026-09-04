/**
 * handoffMonitoring.test.ts — Bloco 4 (M3): migração do monitoramento Auto Care do pai para o filho.
 * Cobre: cópia da linha do pai + desativação do pai (last_error 'superseded_by:'), reenvio ao Deadpool
 * com branch:"dev" e local_path do filho, sem-monitoramento-no-pai → skip, e idempotência.
 * DB mockado por regex de SQL (padrão do harness); registerProjectWithDeadpool mockado.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const register = vi.fn(async () => ({ ok: true }));
vi.mock("../githubPush.js", () => ({ registerProjectWithDeadpool: register }));

const { handoffMonitoring } = await import("./handoffMonitoring.js");

const CHILD = "child-1";
const PARENT = "parent-1";

function makeDb(childRow: Record<string, unknown> | null) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/SELECT c\.parent_project_id/.test(sql)) return { rows: childRow === null ? [] : [childRow] };
      return { rows: [] };
    }),
  };
  return { db, calls };
}

const parentMonitoring = {
  parent_project_id: PARENT,
  extra: {},
  tenant_id: "t1",
  repo_full_name: "acme/produto",
  installation_id: 100,
  parent_active: true,
  system_id: "acme-produto",
  service_id: "extrato",
};

beforeEach(() => {
  vi.clearAllMocks();
  register.mockResolvedValue({ ok: true });
});

describe("handoffMonitoring", () => {
  it("copia a linha do pai, desativa o pai e reenvia ao Deadpool com branch 'dev'", async () => {
    const { db, calls } = makeDb(parentMonitoring);
    await handoffMonitoring(db as never, CHILD);

    const insert = calls.find((c) => /INSERT INTO project_deadpool_monitoring/.test(c.sql) && /SELECT .* FROM project_deadpool_monitoring WHERE project_id = \$2/s.test(c.sql));
    expect(insert).toBeTruthy();
    expect(insert!.params).toEqual([CHILD, PARENT]);
    expect(insert!.sql).toMatch(/migrated_from_project_id/);

    const deact = calls.find((c) => /UPDATE project_deadpool_monitoring[\s\S]*SET active = false/.test(c.sql));
    expect(deact).toBeTruthy();
    expect(deact!.params[0]).toBe(CHILD);
    expect(deact!.params[1]).toBe(`superseded_by:${CHILD}`);
    expect(deact!.params[2]).toBe(PARENT);
    expect(deact!.sql).toMatch(/migrated_to_project_id = \$1/);

    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      systemId: "acme-produto", serviceId: "extrato", branch: "dev", monitoring: true,
      repoUrl: "https://github.com/acme/produto", installationId: 100,
    }));

    const done = calls.find((c) => /UPDATE projects SET extra/.test(c.sql) && /evolution_monitoring_handoff_at/.test(String(c.params[1] ?? "")));
    expect(done).toBeTruthy();
    expect(JSON.parse(done!.params[1] as string).evolution_monitoring_handoff_state).toBe("done");
  });

  it("passa o local_path do filho quando apps/.git existe", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-"));
    process.env.PROJECT_FILES_ROOT = root;
    await mkdir(join(root, CHILD, "apps", ".git"), { recursive: true });
    // Re-importa com o novo PROJECT_FILES_ROOT (capturado no load do módulo).
    vi.resetModules();
    const { handoffMonitoring: fn } = await import("./handoffMonitoring.js");
    const { db } = makeDb(parentMonitoring);
    await fn(db as never, CHILD);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ localPath: join(root, CHILD, "apps"), branch: "dev" }));
  });

  it("pai sem linha de monitoramento → skip (nada a migrar), não chama o Deadpool", async () => {
    const { db, calls } = makeDb({ ...parentMonitoring, parent_active: null });
    await handoffMonitoring(db as never, CHILD);
    expect(calls.find((c) => /INSERT INTO project_deadpool_monitoring/.test(c.sql))).toBeUndefined();
    expect(register).not.toHaveBeenCalled();
    const done = calls.find((c) => /evolution_monitoring_handoff_at/.test(String(c.params[1] ?? "")));
    expect(JSON.parse(done!.params[1] as string).evolution_monitoring_handoff_state).toBe("skipped_no_parent_monitoring");
  });

  it("idempotente: handoff já feito → no-op (só o SELECT inicial)", async () => {
    const { db, calls } = makeDb({ ...parentMonitoring, extra: { evolution_monitoring_handoff_at: "2026-09-04T00:00:00Z" } });
    await handoffMonitoring(db as never, CHILD);
    expect(calls.length).toBe(1);
    expect(register).not.toHaveBeenCalled();
  });
});
