/**
 * Fase 3 / 3.3 — guarda da spec do rascunho do card (unidade, sem banco): escopo de escrita, corpo da trava, porta única
 * (`cardSpecWriteBlock`) com o banco simulado, e o veredito do `card_draft` (promotability).
 */
import { describe, it, expect } from "vitest";
import {
  cardPathOutOfScopeBody, cardSpecLockedBody, cardSpecWriteBlock, cardWritableRoots, isCardWritablePath, loadCardDraftInfo, type CardDraftInfo,
} from "./cardSpecGuard.js";
import { decideCardDraftPromotability, decideSpecPromotability } from "./promotability.js";
import { runStageA } from "./specValidation.js";

const PID = "11111111-1111-4111-8111-111111111111";
const TID = "22222222-2222-4222-8222-222222222222";
const dbWith = (row: Record<string, unknown> | null, calls: string[] = []) => ({
  query: async (sql: string) => { calls.push(sql); return { rows: row ? [row] : [] }; },
});

describe("escopo de escrita do rascunho", () => {
  it("só a pasta do card, o RFC e o ADR", () => {
    expect(cardWritableRoots("TK-0001")).toEqual(["tickets/TK-0001", "docs/rfc", "docs/adr"]);
    for (const [dir, file] of [["tickets/TK-0001", "request.md"], ["tickets/TK-0001/anexos", "regra.md"], ["docs/rfc", "RFC-0001-x.md"], ["docs/adr", "ADR-001-x.md"], ["/docs/rfc/", "RFC-0002-y.md"]] as const) {
      expect(isCardWritablePath("TK-0001", dir, file), `${dir}/${file}`).toBe(true);
    }
    for (const [dir, file] of [["", "README.md"], ["", "CHANGELOG.md"], ["", "connect.yaml"], ["tickets/TK-0002", "request.md"], ["tickets", "x.md"], ["docs", "arquitetura.md"], ["docs/rfcs", "x.md"], ["apps/api", "x.ts"], ["tickets/TK-0001/../TK-0002", "x.md"], ["docs/rfc/../../apps", "x.md"]] as const) {
      expect(isCardWritablePath("TK-0001", dir, file), `${dir}/${file}`).toBe(false);
    }
  });
  it("caminho inteiro numa string só", () => {
    expect(isCardWritablePath("TK-0007", "docs/rfc/RFC-0001-x.md")).toBe(true);
    expect(isCardWritablePath("TK-0007", "README.md")).toBe(false);
    expect(isCardWritablePath("TK-0007", "tickets/TK-0007/request.md")).toBe(true);
    expect(isCardWritablePath("TK-0007", "tickets/TK-0008/request.md")).toBe(false);
  });
});

describe("trava CARD_SPEC_LOCKED", () => {
  const info = (state: CardDraftInfo["state"]): CardDraftInfo => ({ projectId: PID, tenantId: null, ticketId: TID, number: 1, code: "TK-0001", state });
  it("ready: pode reabrir; estados seguintes: histórico", () => {
    expect(cardSpecLockedBody(info("ready"))).toMatchObject({ code: "CARD_SPEC_LOCKED", state: "ready", canReopen: true, cardId: TID, reopen: `POST /api/cards/${TID}/reopen` });
    const hist = cardSpecLockedBody(info("promoted"));
    expect(hist).toMatchObject({ code: "CARD_SPEC_LOCKED", state: "promoted", canReopen: false });
    expect(hist.reopen).toBeUndefined();
    expect(String(hist.message)).toContain("histórico");
  });
  it("escopo: devolve os globs graváveis", () => {
    expect(cardPathOutOfScopeBody(info("refining"), "README.md")).toMatchObject({ code: "CARD_PATH_OUT_OF_SCOPE", path: "README.md", writable: ["tickets/TK-0001/**", "docs/rfc/**", "docs/adr/**"] });
  });
});

describe("cardSpecWriteBlock (porta única dos escritores)", () => {
  const row = (state: string | null) => ({ status: "card_draft", tenant_id: null, ticket_id: state ? TID : null, number: 1, card_state: state });
  it("projeto comum ⇒ null SEM consulta (status conhecido)", async () => {
    const calls: string[] = [];
    expect(await cardSpecWriteBlock(dbWith(row("ready"), calls), PID, { knownStatus: "draft", relPath: "README.md" })).toBeNull();
    expect(await loadCardDraftInfo(dbWith(row("ready"), calls), PID, "accepted")).toBeNull();
    expect(calls).toEqual([]);
  });
  it("projeto comum sem status conhecido ⇒ uma consulta e null", async () => {
    const calls: string[] = [];
    expect(await cardSpecWriteBlock(dbWith({ status: "draft", card_state: null }, calls), PID)).toBeNull();
    expect(calls.length).toBe(1);
  });
  it("draft/refining liberam; ready, promoted, blocked, rejected e órfão travam (409)", async () => {
    for (const st of ["draft", "refining"]) expect(await cardSpecWriteBlock(dbWith(row(st)), PID, { knownStatus: "card_draft" })).toBeNull();
    for (const st of ["ready", "promoted", "in_factory", "blocked", "delivered", "rejected", null]) {
      const b = await cardSpecWriteBlock(dbWith(row(st)), PID, { knownStatus: "card_draft", relPath: "docs/rfc/RFC-0001-x.md" });
      expect(b?.status, String(st)).toBe(409);
      expect(b?.body.code).toBe("CARD_SPEC_LOCKED");
    }
  });
  it("escopo: fora da pasta do card ⇒ 400, e a trava vence o escopo", async () => {
    const out = await cardSpecWriteBlock(dbWith(row("refining")), PID, { knownStatus: "card_draft", relPath: "README.md" });
    expect(out?.status).toBe(400);
    expect(out?.body.code).toBe("CARD_PATH_OUT_OF_SCOPE");
    const both = await cardSpecWriteBlock(dbWith(row("ready")), PID, { knownStatus: "card_draft", relPath: "README.md" });
    expect(both?.body.code).toBe("CARD_SPEC_LOCKED");
    expect(await cardSpecWriteBlock(dbWith(row("draft")), PID, { knownStatus: "card_draft", relDir: "tickets/TK-0001", filename: "notas.md" })).toBeNull();
    expect((await cardSpecWriteBlock(dbWith(row("draft")), PID, { knownStatus: "card_draft", relDir: "", filename: "connect.yaml" }))?.body.code).toBe("CARD_PATH_OUT_OF_SCOPE");
  });
});

describe("veredito do card_draft (não é spec de produto)", () => {
  it("nunca 'já saiu da Bancada' nem 'normalizar'; aponta o card", () => {
    const v = decideSpecPromotability("card_draft", null);
    expect(v).toMatchObject({ canPromote: false, reason: "CARD_DRAFT", status: "card_draft", normalized: null });
    expect(v.message).not.toMatch(/saiu da Bancada|normalizar/i);
    expect(decideSpecPromotability("draft", true, { ok: true })).toMatchObject({ canPromote: true });   // spec comum: inalterado
  });
  it("por estado do card", () => {
    expect(decideCardDraftPromotability({ cardId: TID, state: "ready" }).card).toEqual({ cardId: TID, state: "ready", promoteVia: `POST /api/cards/${TID}/promote` });
    expect(decideCardDraftPromotability({ cardId: TID, state: "refining" }).card?.promoteVia).toBeNull();
    expect(decideCardDraftPromotability({ cardId: TID, state: "refining" }).message).toContain("valide o card");
    expect(decideCardDraftPromotability({ cardId: TID, state: "promoted" }).message).toContain("histórico");
  });
});

describe("Estágio A da validação sobre o rascunho do card", () => {
  const files = [
    { filename: "request.md", file_path: "/x/request.md", rel_dir: "tickets/TK-0001", content: "# Pedido\n\n" + "Exportar entregas em CSV com ponto e vírgula e UTF-8. ".repeat(8) },
  ];
  it("não acusa README/connect.yaml ausentes (são da versão corrente); spec comum continua acusando", () => {
    const titles = (f: ReturnType<typeof runStageA>) => f.map((x) => x.title);
    expect(titles(runStageA(files, { evolution: true, cardDraft: true }))).toEqual([]);
    const comum = titles(runStageA(files, { evolution: true }));
    expect(comum).toContain("Spec sem manifesto (README.md)");
    expect(comum).toContain("Spec sem declaração Connect (connect.yaml)");
  });
  it("mas o RFC do card continua sendo exigido como em toda evolução (blocker)", () => {
    const f = runStageA([...files, { filename: "RFC-0001-x.md", file_path: "/x/r.md", rel_dir: "docs/rfc", content: "# RFC-0001 — x\n\nsó prosa solta sem Gherkin nem impacto" }], { evolution: true, cardDraft: true });
    expect(f.some((x) => x.severity === "blocker" && x.file === "docs/rfc/RFC-0001-x.md")).toBe(true);
  });
});
