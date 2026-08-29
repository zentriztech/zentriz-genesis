/**
 * tenantNotify.ts — e-mail de ONBOARDING ao TENANT na ativação.
 *
 * Evento único (por ora):
 *   ONBOARDING_CONFIG — quando um tenant é ATIVADO (status -> active, via criação
 *   com status=active ou PATCH status=active). Envia ao responsável do tenant um
 *   e-mail branded de boas-vindas + o "Guia de Configurações" (PDF em anexo),
 *   destacando as três configurações essenciais (GitHub, Cloud Deploy, LLM/IA).
 *
 * Princípios (espelham opsNotify.ts — inegociáveis):
 *  - NUNCA bloqueia nem lança no fluxo da rota: o hook chama o wrapper fire-and-forget
 *    (`maybeNotifyTenantActivated`), que agenda em setImmediate e engole erros.
 *  - IDEMPOTENTE: `tenant_notifications` (UNIQUE tenant_id,kind) + INSERT ON CONFLICT
 *    DO NOTHING RETURNING — no máximo um e-mail por tenant.
 *  - CONFIG-GATED / fail-safe: só envia se `isSesConfigured()` E houver destinatário.
 *  - FAIL-CLOSED no anexo: se o PDF do guia não puder ser carregado, NÃO reivindica o
 *    slot de idempotência e NÃO envia (o corpo promete o anexo — não mandamos vazio);
 *    uma reativação posterior, com o asset presente, reenvia.
 *  - SEM PII EM LOG: loga só tenantId/delivered — nunca e-mail/nome.
 */
import { readFileSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { Pool } from "pg";
import { isSesConfigured, sendEmail, type EmailAttachment } from "./emailSender.js";

const PDF_ATTACH_NAME = "Guia_Configuracoes_Zentriz_Genesis.pdf";

/** Cópia oculta ao time Zentriz (default: Jean). Vazio/`none` desliga. */
function copyRecipient(): string | null {
  const v = (process.env.ONBOARDING_NOTIFY_COPY ?? "jean@zentriz.com.br").trim();
  if (!v || v.toLowerCase() === "none") return null;
  return v;
}

/**
 * Carrega o PDF do guia dos assets versionados. Cacheia APENAS o sucesso (o Buffer é
 * imutável na imagem). A FALHA não é cacheada de propósito: se o asset faltasse (ex.:
 * regressão no COPY do Dockerfile), uma próxima ativação reavalia o disco em vez de
 * envenenar o processo com null permanente e silenciar o envio para sempre.
 * Multi-path: runtime (dist/assets), dev (src/assets) e cwd (fallback).
 */
let _pdfCache: Buffer | null = null;
export function loadGuidePdf(): Buffer | null {
  if (_pdfCache) return _pdfCache;
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(dirname, "..", "assets", "onboarding", "guia-configuracoes.pdf"),
    path.join(dirname, "..", "..", "src", "assets", "onboarding", "guia-configuracoes.pdf"),
    path.join(process.cwd(), "src", "assets", "onboarding", "guia-configuracoes.pdf"),
  ];
  for (const c of candidates) {
    try {
      const buf = readFileSync(c);
      if (buf && buf.length > 0) {
        _pdfCache = buf;
        return buf;
      }
    } catch {
      /* tenta o próximo */
    }
  }
  return null; // não cacheia a falha — reavalia na próxima chamada
}

function esc(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * E-mail de onboarding — layout branded escuro (regra de ouro: fundo escuro + texto claro),
 * tabelas (compatível com clientes de e-mail), destaque das três essenciais e referência
 * ao PDF em anexo. `name` é o nome do responsável (ou do tenant); vazio → saudação neutra.
 */
export function renderOnboardingEmail(name: string): { subject: string; html: string; text: string } {
  const subject = "Zentriz Genesis — Guia de Configurações da plataforma";
  const greeting = name ? `Olá, ${esc(name)},` : "Olá,";
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background:#0a1420;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a1420; padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#0f1b2d; border-radius:14px; overflow:hidden; font-family:Arial,Helvetica,sans-serif;">

  <tr><td style="padding:28px 32px 20px 32px; background:#0f1b2d; border-bottom:1px solid #1e3350;">
    <div style="font-size:11px; letter-spacing:3px; color:#17b3a3; text-transform:uppercase; font-weight:bold;">Zentriz Genesis</div>
    <div style="font-size:22px; color:#ffffff; font-weight:bold; margin-top:8px;">Bem-vindo à plataforma</div>
  </td></tr>

  <tr><td style="padding:26px 32px 8px 32px;">
    <p style="color:#eaf2f8; font-size:15px; line-height:1.6; margin:0 0 16px 0;">${greeting}</p>
    <p style="color:#c6d4e2; font-size:14px; line-height:1.65; margin:0 0 16px 0;">
      Sua organização está <b style="color:#ffffff;">ativa</b> no Zentriz Genesis — a fábrica que constrói o seu produto de ponta a ponta: da especificação ao código, testes, publicação e monitoramento contínuo.
    </p>
    <p style="color:#c6d4e2; font-size:14px; line-height:1.65; margin:0 0 20px 0;">
      Para aproveitar a plataforma com autonomia total — usando o <b style="color:#ffffff;">seu</b> provedor de IA, a <b style="color:#ffffff;">sua</b> nuvem e os <b style="color:#ffffff;">seus</b> repositórios — preparamos um guia com <b style="color:#ffffff;">todas as Configurações</b>: o que cada uma é, para que serve e como configurar. Ele está <b style="color:#17b3a3;">em anexo (PDF)</b>.
    </p>
  </td></tr>

  <tr><td style="padding:0 32px 8px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#13253c; border-left:4px solid #17b3a3; border-radius:0 10px 10px 0;">
      <tr><td style="padding:18px 20px;">
        <div style="color:#17b3a3; font-size:12px; letter-spacing:1px; text-transform:uppercase; font-weight:bold; margin-bottom:12px;">Comece por estas três — as essenciais</div>

        <div style="margin-bottom:12px;">
          <div style="color:#ffffff; font-size:14px; font-weight:bold;">1 &middot; GitHub</div>
          <div style="color:#aebfce; font-size:13px; line-height:1.55;">Conecta o GitHub App na sua organização para o código ser entregue no seu repositório. <b style="color:#f0b866;">Importante:</b> o App precisa da permissão <b style="color:#ffffff;">&ldquo;Administration: Read &amp; write&rdquo;</b> &mdash; sem ela, a publicação falha com erro 403 mesmo com o produto pronto.</div>
        </div>

        <div style="margin-bottom:12px;">
          <div style="color:#ffffff; font-size:14px; font-weight:bold;">2 &middot; Cloud Deploy</div>
          <div style="color:#aebfce; font-size:13px; line-height:1.55;">Suas credenciais de nuvem (AWS, Azure ou GCP) para o produto <b style="color:#ffffff;">subir sozinho</b> após a geração. Sem isso, o código é entregue mas não há deploy automático.</div>
        </div>

        <div>
          <div style="color:#ffffff; font-size:14px; font-weight:bold;">3 &middot; LLM / IA</div>
          <div style="color:#aebfce; font-size:13px; line-height:1.55;">Seu provedor de IA (Bedrock, OpenAI, Anthropic ou Azure) para você controlar <b style="color:#ffffff;">modelo e custo</b>. Sem isso, usamos o pool de cortesia da Zentriz e seus créditos de cortesia.</div>
        </div>
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:18px 32px 6px 32px;">
    <p style="color:#c6d4e2; font-size:14px; line-height:1.65; margin:0;">
      O passo a passo completo de cada uma (e das demais: Deployments, Skill Store, UI/UX, Telegram, Usuários e Plano e uso) está no PDF em anexo. Configurar essas três primeiro garante o melhor uso desde o primeiro produto.
    </p>
  </td></tr>

  <tr><td style="padding:18px 32px 26px 32px;">
    <p style="color:#c6d4e2; font-size:14px; line-height:1.6; margin:0;">
      Qualquer dúvida ou ajuda para configurar, é só responder este e-mail ou falar com a gente em <a href="mailto:jean@zentriz.com.br" style="color:#17b3a3; text-decoration:none;">jean@zentriz.com.br</a>. Estamos à disposição.
    </p>
  </td></tr>

  <tr><td style="padding:18px 32px; background:#0a1420; border-top:1px solid #1e3350;">
    <div style="color:#7a889b; font-size:12px; line-height:1.5;">Equipe Zentriz &middot; <a href="https://genesis.zentriz.com.br" style="color:#8fa6bd; text-decoration:none;">genesis.zentriz.com.br</a></div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  const text =
    `Zentriz Genesis — Bem-vindo à plataforma\n\n` +
    `${name ? `Olá, ${name},` : "Olá,"}\n\n` +
    `Sua organização está ativa no Zentriz Genesis. Em anexo (PDF) segue o Guia de Configurações: ` +
    `o que cada configuração é, para que serve e como configurar.\n\n` +
    `Comece pelas três essenciais:\n` +
    `1. GitHub — conecte o GitHub App (precisa da permissão "Administration: Read & write", senão a publicação falha com 403).\n` +
    `2. Cloud Deploy — suas credenciais de nuvem para o produto subir sozinho.\n` +
    `3. LLM / IA — seu provedor de IA para controlar modelo e custo.\n\n` +
    `Dúvidas: jean@zentriz.com.br — genesis.zentriz.com.br`;

  return { subject, html, text };
}

interface TenantRow {
  name: string | null;
  responsible_name: string | null;
  responsible_email: string | null;
  email: string | null;
}

/**
 * Núcleo idempotente. Ordem deliberada:
 *   1. gate SES  2. destinatário  3. PDF (fail-closed)  4. reivindica o slot  5. envia.
 * Só reivindica a idempotência quando tudo o que é necessário para um envio íntegro
 * está disponível — assim uma reativação futura pode reenviar se algo faltava.
 * Nunca lança. Retorna true se ESTE chamador enviou (útil em teste).
 */
export async function notifyTenantActivated(pool: Pool, tenantId: string): Promise<boolean> {
  if (!isSesConfigured()) return false;
  try {
    const res = await pool.query(
      `SELECT name, responsible_name, responsible_email, email FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const row = res.rows[0] as TenantRow | undefined;
    if (!row) return false;

    const to = (row.responsible_email || row.email || "").trim();
    if (!to) {
      console.info(`[tenantNotify] tenant=${tenantId} sem e-mail de destino — pulado (sem reivindicar)`);
      return false;
    }

    // Anexo obrigatório: sem o guia não enviamos e não queimamos a idempotência.
    const pdf = loadGuidePdf();
    if (!pdf) {
      console.warn(`[tenantNotify] tenant=${tenantId} guia PDF ausente no runtime — envio adiado (sem reivindicar)`);
      return false;
    }

    // Idempotência atômica: só quem inserir a linha (RETURNING não-vazio) envia.
    const claim = await pool.query(
      `INSERT INTO tenant_notifications (tenant_id, kind) VALUES ($1, 'onboarding_config')
       ON CONFLICT (tenant_id, kind) DO NOTHING RETURNING id`,
      [tenantId],
    );
    if (claim.rowCount === 0) return false; // já notificado

    const attachments: EmailAttachment[] = [
      { filename: PDF_ATTACH_NAME, content: pdf, contentType: "application/pdf" },
    ];
    const name = (row.responsible_name || row.name || "").trim();
    const email = renderOnboardingEmail(name);
    const copy = copyRecipient();
    const out = await sendEmail({
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments,
      ...(copy ? { bcc: [copy] } : {}),
    });
    console.info(`[tenantNotify] tenant=${tenantId} delivered=${out.delivered}`);
    return out.delivered;
  } catch {
    // Nunca propaga. Aceitamos perder no máximo este 1 e-mail (evita loop de spam).
    console.warn(`[tenantNotify] falha tenant=${tenantId} delivered=false`);
    return false;
  }
}

/**
 * Wrapper FIRE-AND-FORGET para os hooks das rotas. Dispara SOMENTE quando o status
 * pretendido é `active` (ativação deliberada) — nunca em edições de tenants já ativos.
 * Agenda em setImmediate e engole erros: NUNCA afeta a resposta da rota.
 */
export function maybeNotifyTenantActivated(pool: Pool, tenantId: string, status: string | undefined): void {
  if (status !== "active") return;
  setImmediate(() => {
    notifyTenantActivated(pool, tenantId).catch(() => {});
  });
}
