/**
 * promotability.test.ts — o veredito ÚNICO de "posso promover isto à Fábrica?".
 *
 * O que se prova aqui é exatamente o que o achado do Jean (2026-09-11) expôs e o que o adversarial
 * (`~/relatorios/2026-09-11-devil-promover-e-normalizar-fora-da-bancada.md`) exigiu:
 *   • ESTADO vem antes de NORMALIZAÇÃO — num produto que já saiu da Bancada, prometer que
 *     normalizar destrava o promover é mentira (era o botão habilitado que o Jean viu);
 *   • `null` (não consegui decidir) NUNCA vira `false` — erro nosso não esconde função do usuário;
 *   • sem carimbo de normalização a resposta é `false` SEM tocar o disco;
 *   • falha de leitura do disco degrada para `null`, não para `false`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { isProductNormalizedMock, isProjectNormalizedMock, loadProductProjectsMock, assessMock, gateOnMock } = vi.hoisted(() => ({
  isProductNormalizedMock: vi.fn(),
  isProjectNormalizedMock: vi.fn(),
  loadProductProjectsMock: vi.fn(),
  assessMock: vi.fn(),
  gateOnMock: vi.fn(() => true),
}));
vi.mock("./productNormalizer.js", () => ({
  isProductNormalized: isProductNormalizedMock,
  isProjectNormalized: isProjectNormalizedMock,
  loadProductProjects: loadProductProjectsMock,
}));
vi.mock("./specValidation.js", () => ({
  assessSpecValidation: assessMock,
  specValidationGateEnabled: gateOnMock,
}));

import {
  decidePromotability,
  decideSpecPromotability,
  evaluateProductPromotability,
  evaluateProjectPromotability,
  assessProjectReadiness,
  assessProductReadiness,
  type Queryable,
} from "./promotability.js";

const CONNECT_OK = "schemaVersion: 1.1.0\nsystemId: vnx-judge\nserviceName: judge\nresponsibility: x\ninterfaces: []\n";
const connectFile = (content: string, rel_dir = "") => ({ filename: "connect.yaml", rel_dir, file_path: "/x/connect.yaml", content });
/** Avaliação de validação com o `connect.yaml` dado e o veredito do gate. */
const assessment = (files: unknown[], block: { code: string; message: string } | null = null) => ({ files, block });

const DB = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Queryable;
const PRODUCT = {
  id: "99999999-9999-4999-8999-999999999999",
  name: "VNX LastMile",
  systemId: "nvx-lastmile",
};

beforeEach(() => {
  isProductNormalizedMock.mockReset();
  isProjectNormalizedMock.mockReset();
  loadProductProjectsMock.mockReset().mockResolvedValue([]);
  assessMock.mockReset().mockResolvedValue(assessment([connectFile(CONNECT_OK)]));
  gateOnMock.mockReset().mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("decidePromotability — estado ANTES de normalização", () => {
  it("produto fora da Bancada recusa por NOT_ON_WORKBENCH mesmo normalizado", () => {
    // Caso exato do achado: VNX LastMile em `running` com o botão habilitado. Normalizar não
    // destravaria nada aqui — e o veredito precisa dizer isso, não "falta documentação".
    const v = decidePromotability("product", { status: "running", promotableStatus: "draft", normalized: true });
    expect(v.canPromote).toBe(false);
    expect(v.reason).toBe("NOT_ON_WORKBENCH");
    expect(v.message).toContain("running");
  });

  it("fora da Bancada e sem doc: a razão continua sendo o ESTADO (não promete destravar)", () => {
    const v = decidePromotability("product", { status: "accepted", promotableStatus: "draft", normalized: false });
    expect(v.reason).toBe("NOT_ON_WORKBENCH");
  });

  it("na Bancada e sem doc: recusa por NOT_NORMALIZED, que normalizar resolve", () => {
    const v = decidePromotability("product", { status: "draft", promotableStatus: "draft", normalized: false });
    expect(v.canPromote).toBe(false);
    expect(v.reason).toBe("NOT_NORMALIZED");
    expect(v.message).toMatch(/normalizar/i);
  });

  it("na Bancada e documentado: libera, sem mensagem", () => {
    const v = decidePromotability("product", { status: "draft", promotableStatus: "draft", normalized: true });
    expect(v).toMatchObject({ canPromote: true, reason: null, message: null });
  });

  it("normalized=null na Bancada ⇒ canPromote=null (botão FICA visível)", () => {
    // A regra que o adversarial R2/R3 fixou: "não consegui conferir" não é "não pode".
    const v = decidePromotability("product", { status: "draft", promotableStatus: "draft", normalized: null });
    expect(v.canPromote).toBeNull();
    expect(v.reason).toBeNull();
    expect(v.message).toBeNull();
  });

  it("status null (linha sem lifecycle) não vira 'pode' por omissão", () => {
    const v = decidePromotability("product", { status: null, promotableStatus: "draft", normalized: true });
    expect(v.canPromote).toBe(false);
    expect(v.reason).toBe("NOT_ON_WORKBENCH");
  });
});

describe("decideSpecPromotability — spec solta do INBOX", () => {
  it("spec_submitted já saiu da Bancada", () => {
    const v = decideSpecPromotability("spec_submitted", true);
    expect(v.reason).toBe("NOT_ON_WORKBENCH");
    expect(v.message).toContain("spec");
  });

  it("draft sem documentação pede normalizar", () => {
    expect(decideSpecPromotability("draft", false).reason).toBe("NOT_NORMALIZED");
  });
});

describe("evaluateProductPromotability — I/O", () => {
  it("sem carimbo ⇒ false SEM tocar o disco", async () => {
    const v = await evaluateProductPromotability(DB, {
      ...PRODUCT, lifecycleStatus: "draft", normalizedHash: null,
    });
    expect(v.normalized).toBe(false);
    expect(v.reason).toBe("NOT_NORMALIZED");
    expect(isProductNormalizedMock).not.toHaveBeenCalled();
  });

  it("com carimbo, o disco decide", async () => {
    isProductNormalizedMock.mockResolvedValue({ normalized: true });
    const v = await evaluateProductPromotability(DB, {
      ...PRODUCT, lifecycleStatus: "draft", normalizedHash: "abc",
    });
    expect(v.canPromote).toBe(true);
    expect(isProductNormalizedMock).toHaveBeenCalledTimes(1);
  });

  it("falha ao conferir o disco degrada para null — nunca para false", async () => {
    isProductNormalizedMock.mockRejectedValue(new Error("ENOENT"));
    const v = await evaluateProductPromotability(DB, {
      ...PRODUCT, lifecycleStatus: "draft", normalizedHash: "abc",
    });
    expect(v.normalized).toBeNull();
    expect(v.canPromote).toBeNull();
  });

  it("skipNormalizedCheck (teto da listagem) devolve null, mas o ESTADO continua valendo", async () => {
    // Sem isto, uma listagem que estourou o teto de I/O diria "não documentado" e esconderia o
    // botão por economia nossa — foi o bug do `?? false` que escondia Promover por erro do servidor.
    const v = await evaluateProductPromotability(DB, {
      ...PRODUCT, lifecycleStatus: "accepted", normalizedHash: "abc", skipNormalizedCheck: true,
    });
    expect(isProductNormalizedMock).not.toHaveBeenCalled();
    expect(v.normalized).toBeNull();
    expect(v.reason).toBe("NOT_ON_WORKBENCH");   // estado é de graça: continua sendo respondido
  });
});

describe("evaluateProjectPromotability — I/O", () => {
  it("sem carimbo ⇒ false sem tocar o disco", async () => {
    const v = await evaluateProjectPromotability(DB, { id: "p1", status: "draft", hasStamp: false });
    expect(v.reason).toBe("NOT_NORMALIZED");
    expect(isProjectNormalizedMock).not.toHaveBeenCalled();
  });

  it("carimbo em dia libera; carimbo velho trava", async () => {
    isProjectNormalizedMock.mockResolvedValueOnce({ normalized: true });
    expect((await evaluateProjectPromotability(DB, { id: "p1", status: "draft", hasStamp: true })).canPromote).toBe(true);
    isProjectNormalizedMock.mockResolvedValueOnce({ normalized: false });
    expect((await evaluateProjectPromotability(DB, { id: "p1", status: "draft", hasStamp: true })).reason)
      .toBe("NOT_NORMALIZED");
  });

  it("exceção na conferência ⇒ null", async () => {
    isProjectNormalizedMock.mockRejectedValue(new Error("disco fora"));
    const v = await evaluateProjectPromotability(DB, { id: "p1", status: "draft", hasStamp: true });
    expect(v.canPromote).toBeNull();
  });
});

describe("prontidão (achado do Jean 2026-10-16, VNX Judge) — normalizado NÃO basta", () => {
  it("normalizado + 1 GAP blocker ativo ⇒ NOT_VALIDATED (era o Promover liberado com GAP crítico)", async () => {
    isProjectNormalizedMock.mockResolvedValue({ normalized: true });
    assessMock.mockResolvedValue(assessment([connectFile(CONNECT_OK)],
      { code: "SPEC_VALIDATION_BLOCKED", message: "1 GAP blocker ativo." }));
    const v = await evaluateProjectPromotability(DB, { id: "p1", status: "draft", hasStamp: true });
    expect(v.canPromote).toBe(false);
    expect(v.reason).toBe("NOT_VALIDATED");
    expect(v.code).toBe("SPEC_VALIDATION_BLOCKED");
    expect(v.message).toContain("Revalide");
  });

  it("normalizado sem connect.yaml ⇒ CONNECT_MISSING, ANTES da validação (escrever o connect venceria a validação)", async () => {
    isProjectNormalizedMock.mockResolvedValue({ normalized: true });
    assessMock.mockResolvedValue(assessment([], { code: "SPEC_VALIDATION_BLOCKED", message: "x" }));
    const v = await evaluateProjectPromotability(DB, { id: "p1", status: "draft", hasStamp: true });
    expect(v.reason).toBe("CONNECT_MISSING");
    expect(v.code).toBe("CONNECT_DECLARATION_MISSING");
    expect(v.message).toContain("Normalizar");
  });

  it("connect.yaml numa subpasta não conta; connect sem chave obrigatória ⇒ INCOMPLETE", async () => {
    assessMock.mockResolvedValueOnce(assessment([connectFile(CONNECT_OK, "docs")]));
    expect(await assessProjectReadiness(DB, "p1")).toMatchObject({ ok: false, code: "CONNECT_DECLARATION_MISSING" });
    assessMock.mockResolvedValueOnce(assessment([connectFile("systemId: a\n")]));
    const r = await assessProjectReadiness(DB, "p1");
    expect(r).toMatchObject({ ok: false, code: "CONNECT_DECLARATION_INCOMPLETE" });
    expect(!r.ok && r.message).toContain("interfaces");
  });

  it("avisos sem reconhecimento ⇒ pede Reconhecer avisos", async () => {
    assessMock.mockResolvedValue(assessment([connectFile(CONNECT_OK)], { code: "SPEC_WARNINGS_UNACKED", message: "3 avisos." }));
    const r = await assessProjectReadiness(DB, "p1");
    expect(!r.ok && r.message).toContain("Reconhecer avisos");
  });

  it("SPEC_VALIDATION_GATE=off ⇒ validação não trava; connect continua travando", async () => {
    gateOnMock.mockReturnValue(false);
    assessMock.mockResolvedValueOnce(assessment([connectFile(CONNECT_OK)], { code: "SPEC_NOT_VALIDATED", message: "x" }));
    expect(await assessProjectReadiness(DB, "p1")).toEqual({ ok: true });
    assessMock.mockResolvedValueOnce(assessment([]));
    expect((await assessProjectReadiness(DB, "p1")).ok).toBe(false);
  });

  it("tudo em dia ⇒ libera", async () => {
    isProjectNormalizedMock.mockResolvedValue({ normalized: true });
    expect((await evaluateProjectPromotability(DB, { id: "p1", status: "draft", hasStamp: true })).canPromote).toBe(true);
  });

  it("erro de I/O na prontidão ⇒ null na tela (o /promote decide), nunca true", async () => {
    isProjectNormalizedMock.mockResolvedValue({ normalized: true });
    assessMock.mockRejectedValue(new Error("disco fora"));
    const v = await evaluateProjectPromotability(DB, { id: "p1", status: "draft", hasStamp: true });
    expect(v.canPromote).toBeNull();
    expect(v.normalized).toBe(true);
  });

  it("não normalizado: prontidão nem é avaliada (sem I/O desnecessário)", async () => {
    await evaluateProjectPromotability(DB, { id: "p1", status: "draft", hasStamp: false });
    expect(assessMock).not.toHaveBeenCalled();
  });

  it("produto: AND dos projetos em rascunho; a mensagem diz QUAL spec; projeto promovido não conta", async () => {
    loadProductProjectsMock.mockResolvedValue([
      { projectId: "a", title: "Judge API", status: "draft" },
      { projectId: "b", title: "Judge Worker", status: "draft" },
      { projectId: "c", title: "Já na fábrica", status: "running" },
    ]);
    assessMock.mockImplementation(async (_db: unknown, id: string) =>
      id === "b" ? assessment([connectFile(CONNECT_OK)], { code: "SPEC_VALIDATION_BLOCKED", message: "blocker." })
        : id === "c" ? assessment([])
        : assessment([connectFile(CONNECT_OK)]));
    const r = await assessProductReadiness(DB, "prod");
    expect(r).toMatchObject({ ok: false, reason: "NOT_VALIDATED", projectId: "b" });
    expect(!r.ok && r.message.startsWith("Judge Worker:")).toBe(true);
    expect(assessMock).not.toHaveBeenCalledWith(DB, "c");

    isProductNormalizedMock.mockResolvedValue({ normalized: true });
    const v = await evaluateProductPromotability(DB, { ...PRODUCT, lifecycleStatus: "draft", normalizedHash: "abc" });
    expect(v.canPromote).toBe(false);
    expect(v.reason).toBe("NOT_VALIDATED");
    // A tela leva direto à spec que travou (16/10): id + título no veredito, não só no texto.
    expect(v).toMatchObject({ code: "SPEC_VALIDATION_BLOCKED", blockingProjectId: "b", blockingProjectTitle: "Judge Worker" });
  });
});
