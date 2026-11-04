/**
 * M-03 — resolução única das flags por tenant (sem banco: db falso). Precedência: tenant > global > env (default) > off.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveFlag, flagEnabled, parseEnvFlag, effectiveProjectFlags, resolveReconcilerMode, isRolloutFlagKey, FLAG_NAMES } from "./featureFlags.js";

type Row = Record<string, unknown>;
function fakeDb(rows: Array<{ key: string; tenant_id: string | null; value: string }>, fail = false) {
  return {
    async query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }> {
      if (fail) throw new Error("db down");
      const [key, tenant] = params as [string, string | null];
      const hit = rows.filter((r) => r.key === key && (r.tenant_id === null || r.tenant_id === tenant));
      hit.sort((a, b) => (a.tenant_id === null ? 1 : 0) - (b.tenant_id === null ? 1 : 0));
      return { rows: hit.map((r) => ({ tenant_id: r.tenant_id, value: r.value })) };
    },
  };
}

describe("resolveFlag — precedência", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sem nada ⇒ off (default)", async () => {
    expect(await resolveFlag(fakeDb([]), "EVOLVE_CLAIM", "A", "")).toEqual({ value: 0, source: "default" });
  });
  it("env é o DEFAULT de plataforma quando não há linha", async () => {
    expect(await resolveFlag(fakeDb([]), "ATTACHMENTS_STRICT", "A", "on")).toEqual({ value: 1, source: "env" });
    expect(await resolveFlag(fakeDb([]), "ATTACHMENTS_STRICT", "A", "off")).toEqual({ value: 0, source: "env" });
  });
  it("global em config vence o env, em qualquer direção", async () => {
    expect(await resolveFlag(fakeDb([{ key: "ATTACHMENTS_STRICT", tenant_id: null, value: "0" }]), "ATTACHMENTS_STRICT", "A", "on"))
      .toEqual({ value: 0, source: "global" });
    expect(await resolveFlag(fakeDb([{ key: "ATTACHMENTS_STRICT", tenant_id: null, value: "1" }]), "ATTACHMENTS_STRICT", "A", "off"))
      .toEqual({ value: 1, source: "global" });
  });
  it("tenant explícito vence global E env (nunca o ambiente sobrepõe o tenant)", async () => {
    const rows = [{ key: "TICKET_TRANSITIONS", tenant_id: null, value: "1" }, { key: "TICKET_TRANSITIONS", tenant_id: "A", value: "0" }];
    expect(await resolveFlag(fakeDb(rows), "TICKET_TRANSITIONS", "A", "on")).toEqual({ value: 0, source: "tenant" });
    expect(await resolveFlag(fakeDb(rows), "TICKET_TRANSITIONS", "B", "off")).toEqual({ value: 1, source: "global" }); // outro tenant: global
    expect(await resolveFlag(fakeDb([{ key: "TICKET_TRANSITIONS", tenant_id: "A", value: "1" }]), "TICKET_TRANSITIONS", "A", "off"))
      .toEqual({ value: 1, source: "tenant" });
  });
  it("sem tenant (zentriz_admin) só o nível global entra", async () => {
    const rows = [{ key: "EVOLVE_CLAIM", tenant_id: "A", value: "1" }];
    expect(await resolveFlag(fakeDb(rows), "EVOLVE_CLAIM", null, "")).toEqual({ value: 0, source: "default" });
  });
  it("linha inválida é IGNORADA e a resolução cai para o nível seguinte", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = [{ key: "EVOLVE_CLAIM", tenant_id: null, value: "1" }, { key: "EVOLVE_CLAIM", tenant_id: "A", value: "banana" }];
    expect(await resolveFlag(fakeDb(rows), "EVOLVE_CLAIM", "A", "")).toEqual({ value: 1, source: "global" });
    expect(await resolveFlag(fakeDb([{ key: "EVOLVE_CLAIM", tenant_id: null, value: "2" }]), "EVOLVE_CLAIM", "A", "on")).toEqual({ value: 1, source: "env" });
  });
  it("erro de banco ⇒ off (fail-safe), nunca lança", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await resolveFlag(fakeDb([], true), "EVOLVE_CLAIM", "A", "on")).toEqual({ value: 0, source: "default" });
    expect(await flagEnabled(fakeDb([], true), "EVOLVE_CLAIM", "A", "on")).toBe(false);
  });
  it("parseEnvFlag: on/1/true, off/0/false, shadow só no tri; lixo ⇒ null", () => {
    expect(parseEnvFlag(" ON ", "bool")).toBe(1);
    expect(parseEnvFlag("true", "tri")).toBe(2);
    expect(parseEnvFlag("shadow", "tri")).toBe(1);
    expect(parseEnvFlag("shadow", "bool")).toBeNull();
    expect(parseEnvFlag("0", "bool")).toBe(0);
    expect(parseEnvFlag("banana", "bool")).toBeNull();
    expect(parseEnvFlag(undefined, "bool")).toBeNull();
  });
  it("reconciliador tri-estado: 0/1/2 do banco global > env", async () => {
    expect(await resolveReconcilerMode(fakeDb([]), { EVOLVE_RECONCILER: "shadow" } as NodeJS.ProcessEnv)).toBe("shadow");
    expect(await resolveReconcilerMode(fakeDb([{ key: "EVOLVE_RECONCILER", tenant_id: null, value: "2" }]), { EVOLVE_RECONCILER: "off" } as NodeJS.ProcessEnv)).toBe("on");
    expect(await resolveReconcilerMode(fakeDb([{ key: "EVOLVE_RECONCILER", tenant_id: null, value: "0" }]), { EVOLVE_RECONCILER: "on" } as NodeJS.ProcessEnv)).toBe("off");
    expect(await resolveReconcilerMode(fakeDb([]), {} as NodeJS.ProcessEnv)).toBe("off");
  });
  it("effectiveProjectFlags entrega o contrato do runner (booleanos + origem)", async () => {
    const rows = [{ key: "ATTACHMENTS_STRICT", tenant_id: "A", value: "1" }];
    expect(await effectiveProjectFlags(fakeDb(rows), "A")).toMatchObject({ attachmentsStrict: true, taskInheritTransitive: false, sources: { attachmentsStrict: "tenant" } });
    expect(await effectiveProjectFlags(fakeDb(rows), "B")).toMatchObject({ attachmentsStrict: false });
  });
  it("as sete flags de rollout são reconhecidas (guarda adminOnly)", () => {
    expect([...FLAG_NAMES].sort()).toEqual(["ATTACHMENTS_STRICT", "ATTACHMENT_CONVERSION", "CARDS_BANCADA", "EVOLUTION_PROMOTE_BANCADA", "EVOLVE_CLAIM", "EVOLVE_RECONCILER", "TASK_INHERIT_TRANSITIVE", "TICKET_TRANSITIONS"]);
    expect(isRolloutFlagKey("EVOLVE_CLAIM")).toBe(true);
    expect(isRolloutFlagKey("AGENT_TIMEOUT_PM")).toBe(false);
    expect(isRolloutFlagKey("toString")).toBe(false);
  });

  it("S-06: CARDS_BANCADA é configOnly — o ambiente (envRaw='1') é IGNORADO; só a configuração liga", async () => {
    expect(await resolveFlag(fakeDb([]), "CARDS_BANCADA", "A", "1")).toEqual({ value: 0, source: "default" });
    expect(await resolveFlag(fakeDb([]), "CARDS_BANCADA", "A", "on")).toEqual({ value: 0, source: "default" });
    expect(await flagEnabled(fakeDb([]), "CARDS_BANCADA", "A", "1")).toBe(false);
    // a configuração continua valendo (tenant e global)
    expect(await resolveFlag(fakeDb([{ key: "CARDS_BANCADA", tenant_id: "A", value: "1" }]), "CARDS_BANCADA", "A", "0")).toEqual({ value: 1, source: "tenant" });
    expect(await resolveFlag(fakeDb([{ key: "CARDS_BANCADA", tenant_id: null, value: "1" }]), "CARDS_BANCADA", "A")).toEqual({ value: 1, source: "global" });
    // as demais flags seguem aceitando o env como default de plataforma
    expect(await resolveFlag(fakeDb([]), "EVOLVE_CLAIM", "A", "1")).toEqual({ value: 1, source: "env" });
  });
});

describe("D-8 (AR) — valores gravados na tabela: sinônimos de ligado valem, em leitura e escrita", () => {
  it("parseFlagConfigValue: 0/1/2 canônicos E on/true/off/false (+shadow no tri); lixo e fora de faixa ⇒ null", async () => {
    const { parseFlagConfigValue, normalizeFlagValueForWrite } = await import("./featureFlags.js");
    expect(["on", "true", "1", " ON "].map((v) => parseFlagConfigValue(v, "bool"))).toEqual([1, 1, 1, 1]);
    expect(["off", "false", "0"].map((v) => parseFlagConfigValue(v, "bool"))).toEqual([0, 0, 0]);
    expect(parseFlagConfigValue("on", "tri")).toBe(2);
    expect(parseFlagConfigValue("shadow", "tri")).toBe(1);
    expect(parseFlagConfigValue("shadow", "bool")).toBeNull();
    expect(parseFlagConfigValue("2", "bool")).toBeNull();
    expect(parseFlagConfigValue("banana", "bool")).toBeNull();
    expect(parseFlagConfigValue("", "bool")).toBeNull();
    expect(normalizeFlagValueForWrite("on", "bool")).toBe("1");
    expect(normalizeFlagValueForWrite("shadow", "tri")).toBe("1");
    expect(normalizeFlagValueForWrite("x", "tri")).toBeNull();
  });
  it("resolveFlag: linha global 'on' liga a flag (antes: IGNORADA, caía no default off); CARDS_BANCADA idem", async () => {
    expect(await resolveFlag(fakeDb([{ key: "EVOLVE_CLAIM", tenant_id: null, value: "on" }]), "EVOLVE_CLAIM", "A", "")).toEqual({ value: 1, source: "global" });
    expect(await resolveFlag(fakeDb([{ key: "CARDS_BANCADA", tenant_id: "A", value: "true" }]), "CARDS_BANCADA", "A", "")).toEqual({ value: 1, source: "tenant" });
    expect(await resolveFlag(fakeDb([{ key: "EVOLVE_RECONCILER", tenant_id: null, value: "on" }]), "EVOLVE_RECONCILER", null, "")).toEqual({ value: 2, source: "global" });
  });
});
