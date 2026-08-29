import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock do emailSender: controlamos o gate e capturamos os envios (inclui anexos/bcc).
type SendArg = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  cc?: string[];
  bcc?: string[];
  attachments?: { filename: string; content: Buffer; contentType: string }[];
};
const sendEmailMock = vi.fn(async (_input: SendArg) => ({ delivered: true, messageId: "msg-1" }));
let sesConfigured = true;
vi.mock("./emailSender.js", () => ({
  isSesConfigured: () => sesConfigured,
  sendEmail: (input: SendArg) => sendEmailMock(input),
}));

import { notifyTenantActivated, maybeNotifyTenantActivated, renderOnboardingEmail, loadGuidePdf } from "./tenantNotify.js";

/**
 * Pool fake: simula `tenant_notifications` (UNIQUE tenant_id,kind) para o INSERT ... ON
 * CONFLICT DO NOTHING RETURNING e devolve a linha do tenant no SELECT.
 */
function makeFakePool(tenantRow: Record<string, unknown> | null) {
  const claimed = new Set<string>();
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("INSERT INTO tenant_notifications")) {
      const key = String(params?.[0]);
      if (claimed.has(key)) return { rowCount: 0, rows: [] };
      claimed.add(key);
      return { rowCount: 1, rows: [{ id: "row-1" }] };
    }
    if (sql.includes("FROM tenants")) {
      return { rowCount: tenantRow ? 1 : 0, rows: tenantRow ? [tenantRow] : [] };
    }
    return { rowCount: 0, rows: [] };
  });
  return { pool: { query } as never, query };
}

const CABRAL = {
  name: "CABRAL",
  responsible_name: "Bernardo",
  responsible_email: "bernardo.cabral@outlook.com",
  email: "contato@cabral.com",
};

beforeEach(() => {
  sendEmailMock.mockClear();
  sesConfigured = true;
  process.env.ONBOARDING_NOTIFY_COPY = "jean@zentriz.com.br";
});

describe("asset do guia", () => {
  it("o PDF versionado é carregável e começa com %PDF", () => {
    const pdf = loadGuidePdf();
    expect(pdf).not.toBeNull();
    expect(pdf!.length).toBeGreaterThan(1000);
    expect(pdf!.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("renderOnboardingEmail", () => {
  it("usa o nome na saudação e cita as três essenciais + anexo", () => {
    const { subject, html, text } = renderOnboardingEmail("Bernardo");
    expect(subject).toContain("Configurações");
    expect(html).toContain("Olá, Bernardo,");
    expect(html).toContain("GitHub");
    expect(html).toContain("Cloud Deploy");
    expect(html).toContain("LLM / IA");
    expect(html).toContain("em anexo");
    expect(text).toContain("Administration: Read & write");
  });
  it("sem nome usa saudação neutra", () => {
    expect(renderOnboardingEmail("").html).toContain("Olá,");
  });
  it("escapa HTML no nome (anti-injeção no corpo)", () => {
    expect(renderOnboardingEmail("<script>x</script>").html).toContain("&lt;script&gt;");
  });
});

describe("notifyTenantActivated — envio e idempotência", () => {
  it("envia UM e-mail com PDF e BCC ao responsável na 1ª ativação e nada na 2ª", async () => {
    const { pool } = makeFakePool(CABRAL);
    const first = await notifyTenantActivated(pool, "t-1");
    const second = await notifyTenantActivated(pool, "t-1");
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0][0];
    expect(arg.to).toBe("bernardo.cabral@outlook.com");
    expect(arg.bcc).toEqual(["jean@zentriz.com.br"]);
    expect(arg.attachments?.[0].contentType).toBe("application/pdf");
    expect(arg.attachments?.[0].content.length).toBeGreaterThan(1000);
    expect(arg.html).toContain("Olá, Bernardo,");
  });

  it("cai no email de contato quando não há responsible_email", async () => {
    const { pool } = makeFakePool({ ...CABRAL, responsible_email: null });
    await notifyTenantActivated(pool, "t-2");
    expect(sendEmailMock.mock.calls[0][0].to).toBe("contato@cabral.com");
  });

  it("sem NENHUM e-mail → não reivindica idempotência nem envia", async () => {
    const { pool, query } = makeFakePool({ ...CABRAL, responsible_email: null, email: null });
    const r = await notifyTenantActivated(pool, "t-3");
    expect(r).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Nunca chegou ao INSERT (só o SELECT do tenant).
    expect(query.mock.calls.some((c) => String(c[0]).includes("INSERT INTO tenant_notifications"))).toBe(false);
  });

  it("ONBOARDING_NOTIFY_COPY=none desliga a cópia oculta", async () => {
    process.env.ONBOARDING_NOTIFY_COPY = "none";
    const { pool } = makeFakePool(CABRAL);
    await notifyTenantActivated(pool, "t-4");
    expect(sendEmailMock.mock.calls[0][0].bcc).toBeUndefined();
  });
});

describe("gate desligado (SES não configurado)", () => {
  it("não toca o DB nem envia", async () => {
    sesConfigured = false;
    const { pool, query } = makeFakePool(CABRAL);
    const r = await notifyTenantActivated(pool, "t-5");
    expect(r).toBe(false);
    expect(query).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("robustez — nunca lança", () => {
  it("resolve false quando sendEmail rejeita", async () => {
    sendEmailMock.mockRejectedValueOnce(new Error("SES down"));
    const { pool } = makeFakePool(CABRAL);
    await expect(notifyTenantActivated(pool, "t-6")).resolves.toBe(false);
  });
  it("tenant inexistente → false, sem envio", async () => {
    const { pool } = makeFakePool(null);
    expect(await notifyTenantActivated(pool, "ghost")).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("maybeNotifyTenantActivated — só dispara em status=active", () => {
  it("status != active NÃO agenda envio", async () => {
    const { pool, query } = makeFakePool(CABRAL);
    maybeNotifyTenantActivated(pool, "t-7", "suspended");
    maybeNotifyTenantActivated(pool, "t-7", undefined);
    await new Promise((r) => setImmediate(r));
    expect(query).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
  it("status=active agenda e envia (fire-and-forget)", async () => {
    const { pool } = makeFakePool(CABRAL);
    maybeNotifyTenantActivated(pool, "t-8", "active");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});
