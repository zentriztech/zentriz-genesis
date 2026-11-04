/**
 * redactSecrets.ts — sanitizador CENTRAL de segredos em texto livre (mensagens de erro, logs, respostas HTTP).
 *
 * Origem: achado M-01 da revisão adversarial da Fase 1' (EVOLUIR-PROJETO-M): o `err.message` do `execFile`
 * inclui o argv completo ("Command failed: git … -c http.extraheader=Authorization: Basic <base64(x-access-token:TOKEN)> …"),
 * e a mensagem era gravada em `projects.extra`, devolvida ao tenant e logada.
 *
 * Regra: TODA mensagem de erro que veio de um comando git/rede passa por `redactSecrets` ANTES de ser gravada, logada
 * ou devolvida. A defesa em profundidade é dupla: (1) o segredo nem entra no argv (ver `gitAuthEnv` em githubPush.ts);
 * (2) este filtro mascara o que ainda assim aparecer.
 *
 * Cobre: `Authorization: Basic|Bearer|token …`, `Basic <base64>` / `Bearer <jwt>` soltos, `http.extraheader=…`,
 * `x-access-token:<token>`, tokens do GitHub (`ghp_/gho_/ghu_/ghs_/ghr_`, `github_pat_`), credenciais em URL
 * (`https://user:senha@host`) e segredos literais informados pelo chamador (inclusive o base64 do par x-access-token).
 */

export const REDACTED = "[REDACTED]";

const PATTERNS: Array<[RegExp, string]> = [
  // Cabeçalho inteiro (inclui o valor passado a `-c http.extraheader=`).
  [/(authorization\s*[:=]\s*)(basic|bearer|token)\s+[^\s'"]+/gi, `$1$2 ${REDACTED}`],
  [/(http\.[\w./-]*extraheader\s*=\s*)[^\n'"]*/gi, `$1${REDACTED}`],
  // Esquemas soltos (o prefixo pode ter sido cortado).
  [/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{16,}/g, `$1 ${REDACTED}`],
  [/x-access-token:[^@\s'"/]+/gi, `x-access-token:${REDACTED}`],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, REDACTED],
  // Credenciais embutidas em URL.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@'"]+:[^/\s@'"]+@/gi, `$1${REDACTED}@`],
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Mascara segredos em `text`. `extraSecrets`: valores literais conhecidos (ex.: o token da instalação). */
export function redactSecrets(text: unknown, extraSecrets: ReadonlyArray<string | null | undefined> = []): string {
  let out = typeof text === "string" ? text : text instanceof Error ? text.message : String(text ?? "");
  for (const s of extraSecrets) {
    const v = (s ?? "").trim();
    if (v.length < 6) continue; // evita mascarar fragmentos triviais
    const b64 = Buffer.from(`x-access-token:${v}`).toString("base64");
    for (const lit of [v, b64, Buffer.from(v).toString("base64")]) {
      out = out.replace(new RegExp(escapeRe(lit), "g"), REDACTED);
    }
  }
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Mensagem segura de um erro desconhecido (para gravar/logar/responder). */
export function safeErrorMessage(err: unknown, extraSecrets: ReadonlyArray<string | null | undefined> = []): string {
  return redactSecrets(err instanceof Error ? err.message : String(err), extraSecrets);
}
