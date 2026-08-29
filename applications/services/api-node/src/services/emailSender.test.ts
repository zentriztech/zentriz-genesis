import { describe, it, expect, afterEach } from "vitest";
import { isSesConfigured, sendEmail, renderVerificationEmail, SES_SENDER, buildRawMime } from "./emailSender.js";

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

describe("buildRawMime — MIME cru com anexo", () => {
  const pdf = Buffer.from("%PDF-1.7\n...bytes...", "utf8");
  const mime = buildRawMime({
    from: "no-reply@zentriz.com.br",
    to: "cliente@exemplo.com",
    cc: ["copia@exemplo.com"],
    subject: "Configurações da sua conta — açaí, ção, 🚀",
    html: "<b>olá — configuração</b>",
    text: "olá",
    attachments: [{ filename: "guia.pdf", content: pdf, contentType: "application/pdf" }],
  }).toString("utf8");

  it("tem multipart/mixed e multipart/alternative com boundaries", () => {
    expect(mime).toContain("Content-Type: multipart/mixed; boundary=");
    expect(mime).toContain("Content-Type: multipart/alternative; boundary=");
  });

  it("codifica o Subject não-ASCII como encoded-word RFC 2047 (=?UTF-8?B?)", () => {
    const line = mime.split("\r\n").find((l) => l.startsWith("Subject:")) ?? "";
    expect(line).toContain("=?UTF-8?B?");
    // O assunto cru (com acento/emoji) NÃO aparece em claro.
    expect(mime).not.toContain("Configurações da sua conta — açaí");
  });

  it("preserva From/To/Cc e a disposição do anexo", () => {
    expect(mime).toContain("From: no-reply@zentriz.com.br");
    expect(mime).toContain("To: cliente@exemplo.com");
    expect(mime).toContain("Cc: copia@exemplo.com");
    expect(mime).toContain("Content-Type: application/pdf; name=\"guia.pdf\"");
    expect(mime).toContain("Content-Disposition: attachment; filename=\"guia.pdf\"");
  });

  it("remove CR/LF de To/Cc (anti header-injection)", () => {
    const injected = buildRawMime({
      from: "no-reply@zentriz.com.br",
      to: "vitima@x.com\r\nBcc: atacante@evil.com",
      cc: ["c@x.com\r\nX-Evil: 1"],
      subject: "oi",
      html: "<b>x</b>",
      attachments: [{ filename: "g.pdf", content: Buffer.from("%PDF"), contentType: "application/pdf" }],
    }).toString("utf8");
    // O CR/LF injetado é removido → o payload malicioso NÃO vira uma nova linha de cabeçalho.
    expect(injected).not.toContain("\r\nBcc: atacante@evil.com");
    expect(injected).not.toContain("\r\nX-Evil: 1");
    expect(injected).toContain("To: vitima@x.comBcc: atacante@evil.com");
  });

  it("o HTML e o PDF vão em base64 e decodificam de volta ao original", () => {
    // Extrai o bloco base64 logo após o cabeçalho do anexo PDF.
    const idx = mime.indexOf("Content-Disposition: attachment");
    const after = mime.slice(idx);
    const b64 = after.split("\r\n\r\n")[1].split("\r\n--")[0].replace(/\r\n/g, "");
    expect(Buffer.from(b64, "base64").toString("utf8")).toContain("%PDF-1.7");
    // HTML com acento: base64 evita corromper UTF-8.
    const htmlB64 = Buffer.from("<b>olá — configuração</b>", "utf8").toString("base64");
    expect(mime).toContain(htmlB64);
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
