// Mensagens de erro dos cards (PT-BR). Fonte da verdade: o BACKEND.
//  1. `userMessage` do corpo da resposta (o api-node acrescenta em toda rota de card; `services/cardErrors.ts`);
//  2. tabela local = espelho do backend (`__contract__/error-codes.json`, gravado pelo teste de contrato) + os poucos códigos
//     que o portal conhece por fora dessa tabela (`PORTAL_ONLY`) — cobre respostas SEM `userMessage` (flag desligada, `/evolve` legado);
//  3. `message` técnico do servidor; 4. texto genérico.
// Alguns códigos ganham uma frase de DETALHE montada do corpo (saldo livre, o que falta ao tipo, problemas do RFC, anexos recusados…).
import { ApiError } from "@/lib/api";
import backendTable from "./__contract__/error-codes.json";

type BackendEntry = { http: number; area: string; message: string };
export const BACKEND_ERRORS = backendTable as Record<string, BackendEntry>;

/** Códigos que o portal trata mas que NÃO estão na tabela dos cards do backend (vêm do middleware de auth etc.). */
export const PORTAL_ONLY: Record<string, string> = {
  TENANT_INACTIVE: "O tenant está suspenso. Fale com o administrador.",
};

/** Mensagem de tabela para um código (backend primeiro, depois os do portal). */
export function tableMessage(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return BACKEND_ERRORS[code]?.message ?? PORTAL_ONLY[code];
}

const FALLBACK = "Não foi possível concluir a ação. Tente novamente.";
const usd = (v: unknown) => (typeof v === "number" ? `US$ ${v.toFixed(2)}` : "valor não informado");
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const MISSING_LABEL: Record<string, string> = { repro_scenario: "cenário de reprodução (FAIL_TO_PASS)", non_goals: "seção “Non-goals” (não-objetivos)" };

/** Frase extra, montada do corpo do erro, para os códigos em que o servidor manda mais do que a mensagem curta. */
export function errorDetail(err: ApiError): string {
  const b = err.body ?? {};
  switch (err.code) {
    case "BUDGET_FREE_BELOW_MIN":
      return `Saldo livre: ${usd(b.freeUsd)}; mínimo exigido: ${usd(b.minFreeUsd)}.`;
    case "CARD_KIND_REQUIREMENT": {
      const missing = asRecord(b.details).missing;
      const list = (Array.isArray(missing) ? missing : typeof missing === "string" ? [missing] : []).map((m) => MISSING_LABEL[String(m)] ?? String(m));
      return list.length ? `Falta: ${list.join("; ")}.` : "";
    }
    case "EVOLUTION_RFC_INVALID": {
      const items = Array.isArray(b.details) ? (b.details as unknown[]).map(asRecord) : [];
      const parts = items.slice(0, 3).map((i) => `${String(i.path ?? "RFC")}: ${(Array.isArray(i.problems) ? (i.problems as unknown[]).slice(0, 3).map(String) : []).join("; ")}`);
      return parts.length ? `Problemas: ${parts.join(" | ")}.` : "";
    }
    case "ATTACHMENT_INVALID": {
      const errs = Array.isArray(b.errors) ? (b.errors as unknown[]).map((e) => (typeof e === "string" ? e : String(asRecord(e).message ?? ""))).filter(Boolean) : [];
      return errs.length ? errs.join(" ") : "";
    }
    case "SERVICE_REQUIRED": {
      const svc = Array.isArray(b.services) ? (b.services as unknown[]).map(asRecord).map((x) => `${String(x.title ?? x.projectId)}${x.versionNumber ? ` (v${x.versionNumber})` : ""}`) : [];
      return svc.length ? `Serviços: ${svc.join(", ")}.` : "";
    }
    case "CARD_PATH_OUT_OF_SCOPE": {
      const w = Array.isArray(b.writable) ? (b.writable as unknown[]).map(String) : [];
      return w.length ? `Pastas permitidas: ${w.join(", ")}.` : "";
    }
    case "CARD_INVALID_TRANSITION":
      return b.from && b.to ? `De “${String(b.from)}” para “${String(b.to)}”. Atualize a tela e confira o estado do card.` : "";
    case "CARD_NOT_READY":
      return b.state === "refining" ? "O card voltou a “Refinando”: valide de novo antes de promover." : "";
    case "MATERIALIZATION_IN_PROGRESS":
    case "EVOLUTION_BUSY":
      return err.retryAfterSeconds ? `Tente de novo em ${err.retryAfterSeconds} s.` : "";
    default:
      return "";
  }
}

/** Mensagem PT-BR para qualquer erro vindo da API de cards. */
export function cardErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const userMessage = typeof err.body?.userMessage === "string" ? err.body.userMessage : undefined;
    // BAD_REQUEST: o `message` do servidor diz QUAL campo; a mensagem de tabela é genérica.
    const specific = err.code === "BAD_REQUEST" ? err.message || undefined : undefined;
    let base = specific ?? userMessage ?? tableMessage(err.code);
    if (!base) {
      if (err.status === 402) base = err.message || "Orçamento insuficiente para esta ação.";
      else if (err.status === 401) base = "Sessão expirada. Entre novamente.";
      else base = err.message || FALLBACK;
    }
    const detail = errorDetail(err);
    return detail ? `${base} ${detail}` : base;
  }
  if (err instanceof Error && err.message) return err.message;
  return FALLBACK;
}

export function cardErrorCode(err: unknown): string | undefined {
  return err instanceof ApiError ? err.code : undefined;
}

/** `blocked_reason` do card em texto para pessoas (`budget:CÓDIGO`, `child_failed`, `materialization_failed…`). */
export function blockedReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "não registrado";
  if (reason.startsWith("budget:")) { const code = reason.slice("budget:".length); return `orçamento — ${tableMessage(code) ?? code}`; }
  if (reason.startsWith("child_")) return `a execução não está mais ativa (${reason.slice("child_".length)})`;
  if (reason.startsWith("materialization_failed")) return tableMessage("MATERIALIZATION_FAILED") ?? reason;
  return reason;
}
