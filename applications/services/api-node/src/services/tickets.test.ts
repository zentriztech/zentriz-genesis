/**
 * tickets.test.ts — RFC-0009: prova das regras que o desenho depende, não da fiação.
 *
 * O que precisa ficar provado aqui:
 *  1. O carimbo do ticket NÃO usa o formato que o runner truncaria (o veto medido do estudo, B.2).
 *  2. O corpo do humano entra no `request.md` byte a byte — nenhuma reescrita silenciosa.
 *  3. O cabeçalho da evolução sem ticket é IDÊNTICO ao de antes (retrocompatibilidade).
 *  4. A alocação de número usa UPDATE .. RETURNING (atômico), nunca `max(number)+1`.
 *  5. Descartar a execução devolve o pedido à fila (invariante 3 da revisão adversarial).
 */
import { describe, it, expect, vi } from "vitest";
import {
  ticketCode, evolutionRequestHeader, ticketStamp, renderTicketRequestMd,
  allocTicketNumber, reopenTicketsOfChild, isTicketChangeKind, TICKET_KIND_LABEL,
} from "./tickets.js";

/** O MESMO regex de `runner.py:3600`, que segura o estado de todas as tasks. */
const RUNNER_TASK_ID = /\b(TSK-[A-Z]+-\d+|TSK-\d+)\b/g;

describe("RFC-0009 — identidade do ticket", () => {
  it("formata com zero-padding estável", () => {
    expect(ticketCode(1)).toBe("TK-0001");
    expect(ticketCode(12)).toBe("TK-0012");
    expect(ticketCode(1234)).toBe("TK-1234");
    // Ordenação como texto acompanha a numérica — é o que a listagem usa.
    expect([ticketCode(2), ticketCode(10)].sort()).toEqual(["TK-0002", "TK-0010"]);
  });

  it("VETO MEDIDO: o sufixo no ID da task seria truncado em silêncio — por isso não o usamos", () => {
    // Reproduz o achado B.2 do estudo: o runner leria TSK-BE-001 e PERDERIA o -TK12 sem erro.
    expect("## TSK-BE-001-TK12 — Titulo".match(RUNNER_TASK_ID)).toEqual(["TSK-BE-001"]);
    expect("## TSK-001-TK7 — Titulo".match(RUNNER_TASK_ID)).toEqual(["TSK-001"]);
    // O nosso carimbo é independente do ID da task: não casa com o padrão do runner.
    expect(ticketCode(12).match(RUNNER_TASK_ID)).toBeNull();
  });

  it("ticketStamp só carimba quando há ticket — o caminho antigo fica intocado", () => {
    expect(ticketStamp(null)).toBeNull();
    expect(ticketStamp({})).toBeNull();
    expect(ticketStamp({ ticket_number: "12" })).toBeNull(); // string não conta: só número
    expect(ticketStamp({ ticket_number: 12 })).toBe("TK-0012");
  });

  it("aceita só os três tipos declarados", () => {
    expect(isTicketChangeKind("evolution")).toBe(true);
    expect(isTicketChangeKind("fix")).toBe(true);
    expect(isTicketChangeKind("feature")).toBe(true);
    expect(isTicketChangeKind("qualquer")).toBe(false);
    expect(TICKET_KIND_LABEL.feature).toBe("recurso novo");
  });
});

describe("RFC-0009 — cabeçalho da evolução", () => {
  it("sem ticket, byte a byte igual ao texto de antes", () => {
    expect(evolutionRequestHeader(3, null)).toBe("# EVOLUTION REQUEST — v3");
  });

  it("com ticket, expõe código e tipo DECLARADO para a Bancada e a Fábrica lerem", () => {
    expect(evolutionRequestHeader(3, { number: 12, change_kind: "feature" }))
      .toBe("# EVOLUTION REQUEST — v3 (TK-0012 · recurso novo)");
    // Tipo corrompido no banco não quebra a evolução: cai no padrão.
    expect(evolutionRequestHeader(2, { number: 1, change_kind: "lixo" }))
      .toBe("# EVOLUTION REQUEST — v2 (TK-0001 · evolução)");
  });
});

describe("RFC-0009 — request.md é o pedido CRU (invariante 1)", () => {
  const base = {
    number: 12,
    title: "Exportar relatório em CSV",
    body: "Quero baixar a lista de entregas em CSV.\n\nHoje só dá PDF — e o **financeiro** precisa abrir no Excel.",
    change_kind: "feature",
    created_at: new Date("2026-09-11T12:00:00Z"),
  };

  it("copia o corpo do humano sem alterar um único caractere", () => {
    const md = renderTicketRequestMd({ ticket: base, attachments: [], authorEmail: "jean@zentriz.com.br" });
    expect(md).toContain(base.body);
  });

  it("declara o tipo no frontmatter para a máquina e no texto para o humano", () => {
    const md = renderTicketRequestMd({ ticket: base, attachments: [], authorEmail: "jean@zentriz.com.br" });
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("ticket: TK-0012");
    expect(md).toContain("tipo: feature");
    expect(md).toContain("imutavel: true");
    expect(md).toContain("**Tipo declarado:** recurso novo");
  });

  it("lista anexos com link relativo utilizável dentro da própria pasta", () => {
    const md = renderTicketRequestMd({ ticket: base, attachments: [{ filename: "tela atual.png" }], authorEmail: null });
    expect(md).toContain("[`tela atual.png`](anexos/tela%20atual.png)");
  });

  it("sem anexo, não inventa a seção", () => {
    const md = renderTicketRequestMd({ ticket: base, attachments: [], authorEmail: null });
    expect(md).not.toContain("## Anexos");
  });
});

describe("RFC-0009 — numeração por produto", () => {
  it("aloca por UPDATE .. RETURNING (atômico), nunca por max(number)+1", async () => {
    const seen: string[] = [];
    const db = { query: vi.fn(async (sql: string) => { seen.push(sql); return { rows: [{ allocated: 7 }] }; }) };
    const n = await allocTicketNumber(db as never, "prod-1");
    expect(n).toBe(7);
    expect(seen[0]).toContain("UPDATE products SET next_ticket_seq = next_ticket_seq + 1");
    expect(seen[0]).toContain("RETURNING next_ticket_seq - 1");
    // max()+1 é condição de corrida: duas transações leriam o mesmo máximo.
    expect(seen[0].toLowerCase()).not.toContain("max(");
  });

  it("falha alto se o produto não tiver contador, em vez de gravar número inválido", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    await expect(allocTicketNumber(db as never, "prod-x")).rejects.toThrow(/sem contador/);
  });
});

describe("RFC-0009 — invariante 3: o pedido sobrevive à execução", () => {
  it("descartar o filho devolve o ticket para a fila e apaga o vínculo", async () => {
    let sql = "";
    let params: unknown[] = [];
    const db = { query: vi.fn(async (s: string, p: unknown[]) => { sql = s; params = p; return { rowCount: 1 }; }) };
    const n = await reopenTicketsOfChild(db as never, "child-1");
    expect(n).toBe(1);
    expect(sql).toContain("status = 'open'");
    expect(sql).toContain("child_project_id = NULL");
    // Um pedido recusado pelo humano NÃO volta a ficar aberto.
    expect(sql).toContain("status <> 'rejected'");
    expect(params).toEqual(["child-1"]);
  });
});
