/**
 * emailSender.ts — envio de e-mail transacional via Amazon SES v2.
 *
 * Padrão espelhado de services/s3.ts: cliente lazy-singleton + credenciais dedicadas
 * por env (com fallback à cadeia default = instance role) + guarda isSesConfigured().
 *
 * Credenciais (opcionais): AWS_SES_ACCESS_KEY_ID / AWS_SES_SECRET_ACCESS_KEY
 *   (+ AWS_SES_SESSION_TOKEN). Ausentes → SDK usa a cadeia default (instance role).
 * Região:    AWS_SES_REGION (default us-east-1).
 * Remetente: SES_SENDER_EMAIL (default no-reply@zentriz.com.br) — precisa ser uma
 *   identidade verificada no SES.
 * Desligar:  SES_ENABLED=false (dev/local sem SES). Em teste NUNCA envia (hermético).
 *
 * Filosofia (como deadpoolClient.ts): degradar com clareza — em modo OFF, sendEmail
 * apenas loga e devolve delivered=false; NÃO lança. Em modo ON, um erro do SES é
 * propagado ao chamador (que decide se vira 502 ao usuário).
 */
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const REGION = () => (process.env.AWS_SES_REGION ?? "us-east-1").trim();
export const SES_SENDER = () => (process.env.SES_SENDER_EMAIL ?? "no-reply@zentriz.com.br").trim();

/** OFF em teste (hermético) ou quando SES_ENABLED=false; caso contrário ON ("ligar já"). */
function sesEnabled(): boolean {
  if (process.env.NODE_ENV === "test") return false;
  if ((process.env.SES_ENABLED ?? "").trim().toLowerCase() === "false") return false;
  return true;
}

/** Credenciais dedicadas se presentes; senão undefined → cadeia default (instance role). */
function sesCredentials() {
  const accessKeyId = (process.env.AWS_SES_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = (process.env.AWS_SES_SECRET_ACCESS_KEY ?? "").trim();
  if (!accessKeyId || !secretAccessKey) return undefined;
  const sessionToken = (process.env.AWS_SES_SESSION_TOKEN ?? "").trim() || undefined;
  return { accessKeyId, secretAccessKey, sessionToken };
}

let _ses: SESv2Client | null = null;
function sesClient(): SESv2Client {
  if (!_ses) _ses = new SESv2Client({ region: REGION(), credentials: sesCredentials() });
  return _ses;
}

/** Verdadeiro quando o envio real está habilitado E credenciável.
 *
 * Em produção exigimos credenciais DEDICADAS (AWS_SES_*): a cadeia default do SDK
 * resolveria a env genérica AWS_ACCESS_KEY_ID do container, que é de OUTRA conta
 * (896…, sem ses:SendEmail) — enviar assim falha sempre. Fail-closed: sem creds
 * dedicadas em prod tratamos como OFF, e o endpoint público responde 503 claro em
 * vez de tentar e devolver um erro cru do SES. Ver memory genesis-tenants-reform-ses. */
export function isSesConfigured(): boolean {
  if (!sesEnabled()) return false;
  if (process.env.NODE_ENV === "production" && !sesCredentials()) return false;
  return true;
}

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

export type SendEmailResult = {
  delivered: boolean;
  skipped?: boolean;
  messageId?: string;
};

/**
 * Envia um e-mail. Em modo OFF (teste/SES_ENABLED=false) apenas loga e retorna
 * delivered=false (não lança). Em modo ON, envia via SES; erro do SES é propagado.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const to = input.to.trim();
  if (!to) throw new Error("Destinatário de e-mail vazio");

  if (!sesEnabled()) {
    // Não vaza corpo/código em log de produção — só metadados.
    console.info(`[emailSender] OFF — e-mail para ${to} (assunto: ${input.subject}) NÃO enviado`);
    return { delivered: false, skipped: true };
  }

  const out = await sesClient().send(
    new SendEmailCommand({
      FromEmailAddress: SES_SENDER(),
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: input.subject, Charset: "UTF-8" },
          Body: {
            Html: { Data: input.html, Charset: "UTF-8" },
            ...(input.text ? { Text: { Data: input.text, Charset: "UTF-8" } } : {}),
          },
        },
      },
    }),
  );
  return { delivered: true, messageId: out.MessageId };
}

/**
 * E-mail de verificação de código para cadastro de tenant. Layout HTML em tabelas
 * (compatível com clientes de e-mail), fundo claro + texto escuro (contraste seguro),
 * faixa de destaque com o código grande.
 */
export function renderVerificationEmail(code: string): { subject: string; html: string; text: string } {
  const subject = "Seu código de verificação — Zentriz Genesis";
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0D0F14;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0D0F14;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
        <tr><td style="height:4px;background:linear-gradient(135deg,#6366F1 0%,#4F46E5 100%);font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:32px 32px 8px 32px;">
          <div style="font-size:13px;font-weight:700;letter-spacing:1px;color:#6366F1;text-transform:uppercase;">Zentriz Genesis</div>
          <h1 style="margin:12px 0 4px 0;font-size:20px;color:#111827;">Confirme seu e-mail</h1>
          <p style="margin:0;font-size:14px;line-height:1.6;color:#4B5563;">Use o código abaixo para concluir o cadastro da sua empresa. Ele expira em 15 minutos.</p>
        </td></tr>
        <tr><td style="padding:20px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;border-radius:10px;">
            <tr><td align="center" style="padding:20px;font-size:34px;font-weight:800;letter-spacing:10px;color:#111827;">${code}</td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:0 32px 32px 32px;">
          <p style="margin:0;font-size:12px;line-height:1.6;color:#9CA3AF;">Se você não solicitou este cadastro, ignore este e-mail. Nunca compartilhe este código.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  const text = `Zentriz Genesis — Confirme seu e-mail\n\nSeu código de verificação: ${code}\nExpira em 15 minutos.\n\nSe você não solicitou este cadastro, ignore este e-mail.`;
  return { subject, html, text };
}
