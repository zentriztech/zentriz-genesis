/**
 * GAP-98 — o pedido de OUTRA FAMÍLIA que o modelo do tenant engolia em silêncio.
 *
 * Medido em prod (2026-09-08, primeira medição de recall do juiz): o casador foi pedido em
 * `amazon.nova-pro-v1:0` e respondeu `us.anthropic.claude-opus-5` — o modelo do PRÓPRIO juiz. Causa:
 * `callPolicyAgent` montava `model_id` ANTES de espalhar `llm`, e o `model_id` do tenant sobrescrevia o
 * explícito. A medição virou auto-revisão (ZERO ganho, `arXiv:2609.04270`) e ainda assim publicou
 * `same_family = false`, porque a família era calculada sobre o PEDIDO.
 *
 * Estes testes guardam as duas metades: o pedido explícito vence, e o que rodou é devolvido cru para
 * quem precisa afirmar família sobre FATO, não sobre intenção.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let ultimoBody: Record<string, unknown> = {};
let resposta = "{}";
vi.mock("../routes/specs.js", () => ({
  httpPost: async (_url: string, body: string) => {
    ultimoBody = JSON.parse(body) as Record<string, unknown>;
    return resposta;
  },
}));

const { callPolicyAgent } = await import("./specPolicyGate.js");

describe("callPolicyAgent — GAP-98: o model_id EXPLÍCITO vence o do tenant", () => {
  beforeEach(() => {
    process.env.API_AGENTS_URL = "http://agents:8000";
    ultimoBody = {};
    resposta = JSON.stringify({ response: "ok", model_used: "amazon.nova-pro-v1:0" });
  });

  it("manda o modelo pedido, não o do `llm_config` do tenant", async () => {
    const res = await callPolicyAgent({
      system: "s", user: "u", modelId: "amazon.nova-pro-v1:0",
      llm: { model_id: "us.anthropic.claude-opus-5", model_id_rework: "x", llm_config: { provider: "bedrock" } },
    });
    expect(res.ok).toBe(true);
    expect(ultimoBody.model_id).toBe("amazon.nova-pro-v1:0");
    // As credenciais/provedor do tenant continuam indo: só o MODELO é trocado.
    expect(ultimoBody.llm_config).toEqual({ provider: "bedrock" });
  });

  it("sem modelo pedido, o do tenant continua valendo", async () => {
    await callPolicyAgent({ system: "s", user: "u", llm: { model_id: "us.anthropic.claude-opus-5" } });
    expect(ultimoBody.model_id).toBe("us.anthropic.claude-opus-5");
  });

  it("devolve o modelo que RESPONDEU cru — é ele que decide a família, não o pedido", async () => {
    resposta = JSON.stringify({ response: "ok", model_used: "us.anthropic.claude-opus-5", model_requested: "amazon.nova-pro-v1:0" });
    const res = await callPolicyAgent({ system: "s", user: "u", modelId: "amazon.nova-pro-v1:0" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.modelUsedRaw).toBe("us.anthropic.claude-opus-5");
      // A frase para humano continua denunciando a substituição (GAP-88).
      expect(res.model).toBe("us.anthropic.claude-opus-5 (pedido amazon.nova-pro-v1:0)");
    }
  });
});
