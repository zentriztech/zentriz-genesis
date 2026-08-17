import { describe, it, expect, afterEach } from "vitest";
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

describe("emailSender — fail-closed em produção sem credenciais dedicadas (F5)", () => {
  const save = {
    NODE_ENV: process.env.NODE_ENV,
    key: process.env.AWS_SES_ACCESS_KEY_ID,
    secret: process.env.AWS_SES_SECRET_ACCESS_KEY,
  };
  afterEach(() => {
    process.env.NODE_ENV = save.NODE_ENV;
    if (save.key === undefined) delete process.env.AWS_SES_ACCESS_KEY_ID;
    else process.env.AWS_SES_ACCESS_KEY_ID = save.key;
    if (save.secret === undefined) delete process.env.AWS_SES_SECRET_ACCESS_KEY;
    else process.env.AWS_SES_SECRET_ACCESS_KEY = save.secret;
  });

  it("prod SEM AWS_SES_* → isSesConfigured false (não cai na conta errada da cadeia default)", () => {
    process.env.NODE_ENV = "production";
    delete process.env.AWS_SES_ACCESS_KEY_ID;
    delete process.env.AWS_SES_SECRET_ACCESS_KEY;
    expect(isSesConfigured()).toBe(false);
  });

  it("prod COM AWS_SES_* → isSesConfigured true", () => {
    process.env.NODE_ENV = "production";
    process.env.AWS_SES_ACCESS_KEY_ID = "AKIATESTKEY";
    process.env.AWS_SES_SECRET_ACCESS_KEY = "secretvalue";
    expect(isSesConfigured()).toBe(true);
  });
});
