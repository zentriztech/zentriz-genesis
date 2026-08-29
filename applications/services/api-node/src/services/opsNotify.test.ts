import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock do emailSender: controlamos o gate e capturamos os envios.
const sendEmailMock = vi.fn(async (_input: { to: string; subject: string; html: string; text?: string }) => ({
  delivered: true,
  messageId: "msg-1",
}));
let sesConfigured = true;
vi.mock("./emailSender.js", () => ({
  isSesConfigured: () => sesConfigured,
  sendEmail: (input: { to: string; subject: string; html: string; text?: string }) => sendEmailMock(input),
}));

import {
  notifyFactoryStart,
  notifyFactoryBlocked,
  notifyFactoryDone,
  isBlockStatus,
  isDoneStatus,
} from "./opsNotify.js";

/**
 * Pool fake: simula `ops_notifications` (UNIQUE project_id,kind) para o INSERT ... ON CONFLICT
 * DO NOTHING RETURNING e devolve uma linha de enriquecimento fixa para o SELECT.
 */
function makeFakePool() {
  const claimed = new Set<string>();
  const enrichRow = {
    title: "Gestão de frota",
    status: "running",
    product_name: "FleetOps",
    tenant_name: "CABRAL",
    user_email: "admin@cabralorg.com",
    user_name: "Admin Cabral",
    user_role: "tenant_admin",
  };
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("INSERT INTO ops_notifications")) {
      const key = `${params?.[0]}::${params?.[1]}`;
      if (claimed.has(key)) return { rowCount: 0, rows: [] };
      claimed.add(key);
      return { rowCount: 1, rows: [{ id: "row-1" }] };
    }
    if (sql.includes("FROM projects p")) {
      return { rowCount: 1, rows: [enrichRow] };
    }
    if (sql.includes("tasks_total")) {
      return { rowCount: 1, rows: [{ tasks_total: 15, tasks_done: 15, duration_sec: 4200 }] };
    }
    if (sql.includes("from_agent IN")) {
      return { rowCount: 1, rows: [{ summary_human: "deploy S3 bloqueado: tenant sem GitHub App" }] };
    }
    return { rowCount: 0, rows: [] };
  });
  return { pool: { query } as never, query, enrichRow };
}

beforeEach(() => {
  sendEmailMock.mockClear();
  sesConfigured = true;
});

describe("isBlockStatus", () => {
  it("reconhece blocked_*/failed/spec_validation_failed", () => {
    expect(isBlockStatus("blocked_backlog_empty_with_frs")).toBe(true);
    expect(isBlockStatus("blocked_structural_gate")).toBe(true);
    expect(isBlockStatus("blocked_cyborg")).toBe(true);
    expect(isBlockStatus("failed")).toBe(true);
    expect(isBlockStatus("spec_validation_failed")).toBe(true);
  });
  it("EXCLUI blocked_awaiting_expo_confirm (espera humana, não erro)", () => {
    expect(isBlockStatus("blocked_awaiting_expo_confirm")).toBe(false);
  });
  it("ignora estados normais", () => {
    expect(isBlockStatus("running")).toBe(false);
    expect(isBlockStatus("completed")).toBe(false);
    expect(isBlockStatus("accepted")).toBe(false);
  });
});

describe("notifyFactoryStart — idempotência", () => {
  it("envia UM e-mail no primeiro start e nada no segundo (mesmo projeto)", async () => {
    const { pool } = makeFakePool();
    await notifyFactoryStart(pool, "proj-1", { origin: "interactive" });
    await notifyFactoryStart(pool, "proj-1", { origin: "cascade" });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("o assunto e o corpo trazem título, tenant e quem iniciou", async () => {
    const { pool } = makeFakePool();
    await notifyFactoryStart(pool, "proj-1", { origin: "interactive" });
    const arg = sendEmailMock.mock.calls[0][0];
    expect(arg.to).toBe("jean@zentriz.com.br");
    expect(arg.subject).toContain("Gestão de frota");
    expect(arg.html).toContain("CABRAL");
    expect(arg.html).toContain("admin@cabralorg.com");
    expect(arg.html).toContain("disparo interativo");
  });
});

describe("notifyFactoryBlocked — idempotência por status", () => {
  it("mesmo status 2x ⇒ 1 e-mail; status diferente ⇒ +1", async () => {
    const { pool } = makeFakePool();
    await notifyFactoryBlocked(pool, "proj-1", "failed", { reason: "x" });
    await notifyFactoryBlocked(pool, "proj-1", "failed", { reason: "x" });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    await notifyFactoryBlocked(pool, "proj-1", "blocked_structural_gate");
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
  });
});

describe("isDoneStatus", () => {
  it("reconhece accepted/completed/delivered", () => {
    expect(isDoneStatus("accepted")).toBe(true);
    expect(isDoneStatus("completed")).toBe(true);
    expect(isDoneStatus("delivered")).toBe(true);
  });
  it("ignora estados não-finais", () => {
    expect(isDoneStatus("running")).toBe(false);
    expect(isDoneStatus("blocked_cyborg")).toBe(false);
    expect(isDoneStatus("failed")).toBe(false);
  });
});

describe("notifyFactoryDone — produzido 100%", () => {
  it("envia UM e-mail no fechamento e nada no segundo (idempotente)", async () => {
    const { pool } = makeFakePool();
    await notifyFactoryDone(pool, "proj-1");
    await notifyFactoryDone(pool, "proj-1");
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("o corpo traz tarefas concluídas, duração e o tenant", async () => {
    const { pool } = makeFakePool();
    await notifyFactoryDone(pool, "proj-1");
    const arg = sendEmailMock.mock.calls[0][0];
    expect(arg.subject).toContain("produzido");
    expect(arg.html).toContain("15/15");
    expect(arg.html).toContain("1h10m"); // 4200s
    expect(arg.html).toContain("CABRAL");
  });
});

describe("notifyFactoryBlocked — motivo automático", () => {
  it("sem reason explícito, puxa o último passo humano-legível como MOTIVO", async () => {
    const { pool } = makeFakePool();
    await notifyFactoryBlocked(pool, "proj-1", "blocked_cyborg");
    const arg = sendEmailMock.mock.calls[0][0];
    expect(arg.html).toContain("tenant sem GitHub App");
  });
});

describe("gate desligado (SES não configurado)", () => {
  it("não toca o DB nem envia e-mail", async () => {
    sesConfigured = false;
    const { pool, query } = makeFakePool();
    await notifyFactoryStart(pool, "proj-1");
    expect(query).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("robustez — nunca lança", () => {
  it("resolve sem throw quando sendEmail rejeita", async () => {
    sendEmailMock.mockRejectedValueOnce(new Error("SES down"));
    const { pool } = makeFakePool();
    await expect(notifyFactoryStart(pool, "proj-1")).resolves.toBeUndefined();
  });

  it("não envia quando o projeto sumiu no enrich (0 linhas)", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO ops_notifications")) return { rowCount: 1, rows: [{ id: "r" }] };
      return { rowCount: 0, rows: [] }; // enrich vazio
    });
    await notifyFactoryStart({ query } as never, "proj-ghost");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
