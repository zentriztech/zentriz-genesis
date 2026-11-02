/** llmRoleProbe.test.ts — 2A.9: verificação por papel (provedor mockado; nenhuma chamada real). */
import { describe, it, expect, vi } from "vitest";

vi.mock("../db/client.js", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import {
  verifyRoles, classifyRoleProbe, isRoleEligible, sanitizeRoleError, haikuPrefixHint,
} from "./llmRoleProbe.js";
import { probeSlot, type ProbeResult } from "./llmSlotProbe.js";

const CREDS = { aws_access_key_id: "AKIAABCDEFGHIJKLMNOP", aws_secret_access_key: "SuperSecretValue123" };
const OK = (m: string): ProbeResult => ({ ok: true, kind: "", message: "", latencyMs: 5, model: m });
const mk = (fn: (m: string) => ProbeResult & { timedOut?: boolean }) =>
  vi.fn(async (_p: string, m: string) => fn(m)) as unknown as typeof probeSlot & ReturnType<typeof vi.fn>;

describe("verifyRoles", () => {
  it("ok: papéis preenchidos viram status ok", async () => {
    const probe = mk(OK);
    const r = await verifyRoles("bedrock", { orchestrator: "a", advisor: "b", staff: "c" }, CREDS, { probe });
    expect(r.orchestrator?.status).toBe("ok");
    expect(r.advisor?.status).toBe("ok");
    expect(r.staff?.status).toBe("ok");
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("papel vazio não é testado", async () => {
    const probe = mk(OK);
    const r = await verifyRoles("bedrock", { orchestrator: "a", advisor: null, staff: "  " }, CREDS, { probe });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(r.advisor).toBeUndefined();
    expect(r.staff).toBeUndefined();
  });

  it("ids repetidos e veredicto conhecido não repetem a chamada (custo ×3)", async () => {
    const probe = mk(OK);
    const known = new Map([["a", OK("a")]]);
    const r = await verifyRoles("bedrock", { orchestrator: "a", advisor: "b", staff: "b" }, CREDS, { probe, known });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(r.staff?.status).toBe("ok");
  });

  it("denied (AccessDenied/ValidationException de modelo) é distinto de error (rede/cota)", async () => {
    const probe = mk((m) => m === "a"
      ? { ok: false, kind: "auth", message: "AccessDeniedException", latencyMs: 1, model: m }
      : m === "b" ? { ok: false, kind: "model", message: "ValidationException: invalid model", latencyMs: 1, model: m }
      : { ok: false, kind: "network", message: "connection reset", latencyMs: 1, model: m });
    const r = await verifyRoles("bedrock", { orchestrator: "a", advisor: "b", staff: "c" }, CREDS, { probe });
    expect(r.orchestrator?.status).toBe("denied");
    expect(r.advisor?.status).toBe("denied");
    expect(r.staff?.status).toBe("error");
  });

  it("timeout do cliente vira status timeout; unavailable sem timeout não é veredicto", async () => {
    const probe = mk((m) => m === "a"
      ? { ok: false, kind: "unavailable", message: "abort", latencyMs: 30000, model: m, timedOut: true }
      : { ok: false, kind: "unavailable", message: "API_AGENTS_URL ausente", latencyMs: 0, model: m });
    const r = await verifyRoles("bedrock", { orchestrator: "a", advisor: "b" }, CREDS, { probe });
    expect(r.orchestrator?.status).toBe("timeout");
    expect(r.advisor).toBeNull();
  });

  it("respeita o limite de concorrência", async () => {
    let atual = 0, pico = 0;
    const probe = (async (_p: string, m: string) => {
      atual++; pico = Math.max(pico, atual);
      await new Promise((r) => setTimeout(r, 10));
      atual--; return OK(m);
    }) as unknown as typeof probeSlot;
    await verifyRoles("bedrock", { orchestrator: "a", advisor: "b", staff: "c" }, CREDS, { probe, concurrency: 2 });
    expect(pico).toBe(2);
  });

  it("exceção do probe não propaga", async () => {
    const probe = (async () => { throw new Error("boom"); }) as unknown as typeof probeSlot;
    const r = await verifyRoles("bedrock", { orchestrator: "a" }, CREDS, { probe });
    expect(r.orchestrator).toBeNull();
  });
});

describe("sanitização e dica Haiku", () => {
  it("nenhum segredo sobra no erro e há truncamento", () => {
    const msg = `falhou com ${CREDS.aws_secret_access_key} e ${CREDS.aws_access_key_id} sk-abcdefghijkl1234 ` + "x".repeat(900);
    const s = sanitizeRoleError(msg, CREDS);
    expect(s).not.toContain("SuperSecretValue123");
    expect(s).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(s).not.toContain("sk-abcdefghijkl1234");
    expect(s.length).toBeLessThanOrEqual(500);
  });

  it("Haiku us. negado: sugere global. sem trocar o id", () => {
    const id = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
    const v = classifyRoleProbe({ ok: false, kind: "model", message: "invalid model", latencyMs: 1, model: id }, id, CREDS)!;
    expect(v.status).toBe("denied");
    expect(v.error).toContain("sugestão: use o prefixo global.");
    expect(v.error).toContain("global.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(v.model).toBe(id);
  });

  it("Haiku sem versão avisa; outros modelos não recebem dica", () => {
    expect(haikuPrefixHint("global.anthropic.claude-haiku")).toContain("exigem a versão");
    expect(haikuPrefixHint("global.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("");
    expect(haikuPrefixHint("us.anthropic.claude-opus-4-8")).toBe("");
  });
});

describe("isRoleEligible — contrato para a resolução (g-2b)", () => {
  it("só elegível com modelo preenchido e status ok", () => {
    const slot = { model_orchestrator: "a", verify_orchestrator_status: "ok", model_advisor: "b",
                   verify_advisor_status: "denied", model_staff: "c", verify_staff_status: null };
    expect(isRoleEligible(slot, "orchestrator")).toBe(true);
    expect(isRoleEligible(slot, "advisor")).toBe(false);
    expect(isRoleEligible(slot, "staff")).toBe(false);
  });
  it("papel vazio é inelegível mesmo com status ok; orchestrator cai em model_id", () => {
    expect(isRoleEligible({ model_advisor: " ", verify_advisor_status: "ok" }, "advisor")).toBe(false);
    expect(isRoleEligible({ model_id: "m", verify_orchestrator_status: "ok" }, "orchestrator")).toBe(true);
    expect(isRoleEligible({ verify_orchestrator_status: "ok" }, "orchestrator")).toBe(false);
  });
});
