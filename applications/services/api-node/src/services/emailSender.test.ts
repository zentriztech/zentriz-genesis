import { describe, it, expect } from "vitest";
import { isSesConfigured, sendEmail, renderVerificationEmail, SES_SENDER } from "./emailSender.js";

describe("emailSender — modo teste (SES OFF) e template", () => {
  it("isSesConfigured é false em NODE_ENV=test (nunca envia em teste)", () => {
    expect(isSesConfigured()).toBe(false);
  });

  it("sendEmail em modo OFF não lança e retorna skipped", async () => {
    const res = await sendEmail({ to: "alguem@exemplo.com", subject: "oi", html: "<b>x</b>" });
    expect(res.delivered).toBe(false);
    expect(res.skipped).toBe(true);
  });

  it("sendEmail rejeita destinatário vazio", async () => {
    await expect(sendEmail({ to: "  ", subject: "x", html: "y" })).rejects.toThrow();
  });

  it("remetente padrão é no-reply@zentriz.com.br", () => {
    expect(SES_SENDER()).toBe("no-reply@zentriz.com.br");
  });

  it("renderVerificationEmail embute o código e tem assunto", () => {
    const { subject, html, text } = renderVerificationEmail("123456");
    expect(subject).toContain("Zentriz Genesis");
    expect(html).toContain("123456");
    expect(text).toContain("123456");
  });
});
