import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mocka o helper httpPost do módulo de rotas (evita carregar o specs.ts real e sua
// árvore de dependências). O gate semântico chama httpPost(url, body, timeout) e
// espera de volta o CORPO HTTP cru (string), do qual extrai `.response`.
const { httpPostMock } = vi.hoisted(() => ({ httpPostMock: vi.fn() }));
vi.mock("../routes/specs.js", () => ({ httpPost: httpPostMock }));

import { checkSpecIsMinimallyValid } from "./specSemanticGate.js";

/** Faz o próximo httpPost devolver um corpo HTTP contendo {response: <texto do LLM>}. */
function mockVerdictOnce(responseText: string) {
  httpPostMock.mockResolvedValueOnce(JSON.stringify({ response: responseText }));
}

const OLD_ENV = { ...process.env };
beforeEach(() => {
  process.env.API_AGENTS_URL = "http://agents:8000";
  process.env.SPEC_GATE_MIN_CONFIDENCE = "0.75";
  httpPostMock.mockReset();
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.restoreAllMocks();
});

describe("checkSpecIsMinimallyValid — fail-open", () => {
  it("faz skip quando API_AGENTS_URL não está setado", async () => {
    delete process.env.API_AGENTS_URL;
    const r = await checkSpecIsMinimallyValid({ title: "X", projectType: "backend_api", content: "algo" });
    expect(r.ok).toBe(true);
    expect(httpPostMock).not.toHaveBeenCalled();
  });

  it("faz skip quando o conteúdo é vazio", async () => {
    const r = await checkSpecIsMinimallyValid({ title: "X", projectType: "backend_api", content: "   " });
    expect(r.ok).toBe(true);
    expect(httpPostMock).not.toHaveBeenCalled();
  });

  it("passa (fail-open) em erro de rede", async () => {
    httpPostMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r = await checkSpecIsMinimallyValid({ title: "X", projectType: "backend_api", content: "conteúdo" });
    expect(r.ok).toBe(true);
  });

  it("passa (fail-open) em HTTP não-2xx do agents (httpPost lança)", async () => {
    httpPostMock.mockRejectedValueOnce(new Error("HTTP 500: erro interno"));
    const r = await checkSpecIsMinimallyValid({ title: "X", projectType: "backend_api", content: "conteúdo" });
    expect(r.ok).toBe(true);
  });

  it("passa (fail-open) quando a resposta não é JSON válido", async () => {
    mockVerdictOnce("desculpe, não sei responder em json");
    const r = await checkSpecIsMinimallyValid({ title: "X", projectType: "backend_api", content: "conteúdo" });
    expect(r.ok).toBe(true);
  });
});

describe("checkSpecIsMinimallyValid — veredito", () => {
  it("PASSA quando o LLM diz is_spec=true", async () => {
    mockVerdictOnce('{"is_spec": true, "confidence": 0.9, "reason": "descreve um produto", "missing": []}');
    const r = await checkSpecIsMinimallyValid({ title: "Frota", projectType: "backend_api", content: "spec real..." });
    expect(r.ok).toBe(true);
  });

  it("BLOQUEIA quando is_spec=false com confiança alta", async () => {
    mockVerdictOnce('{"is_spec": false, "confidence": 0.95, "reason": "texto aleatório sem sentido", "missing": ["requisitos","o que o produto faz"]}');
    const r = await checkSpecIsMinimallyValid({ title: "X", projectType: "backend_api", content: "aaaa aaaa aaaa" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.block.code).toBe("SPEC_NOT_A_SPEC");
      expect(r.block.reason).toContain("aleatório");
      expect(r.block.missing).toContain("requisitos");
    }
  });

  it("PASSA quando is_spec=false porém confiança BAIXA (fail-open)", async () => {
    mockVerdictOnce('{"is_spec": false, "confidence": 0.4, "reason": "na dúvida"}');
    const r = await checkSpecIsMinimallyValid({ title: "X", projectType: "backend_api", content: "algo curto mas talvez válido" });
    expect(r.ok).toBe(true);
  });

  it("HIGH-3.3: BLOQUEIA is_spec=false mesmo SEM o campo confidence", async () => {
    mockVerdictOnce('{"is_spec": false, "reason": "placeholder em branco", "missing": ["conteúdo"]}');
    const r = await checkSpecIsMinimallyValid({ title: "X", projectType: "backend_api", content: "[preencher]" });
    expect(r.ok).toBe(false);
  });

  it("tolera cercas ```json ao redor do veredito", async () => {
    mockVerdictOnce('```json\n{"is_spec": false, "confidence": 0.9, "reason": "placeholder"}\n```');
    const r = await checkSpecIsMinimallyValid({ title: "X", projectType: "backend_api", content: "[preencher aqui]" });
    expect(r.ok).toBe(false);
  });
});
