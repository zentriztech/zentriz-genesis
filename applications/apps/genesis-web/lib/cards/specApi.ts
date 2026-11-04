import { apiGet, apiPost, apiPut, withQuery } from "@/lib/api";
import type { ChatJob, ChatStart, PlanJob, PlanStart, RfcFromTemplate, SpecFileGet, SpecFileWrite, SpecTree } from "./schemas";

// Rotas de spec do RASCUNHO do card usadas pela aba “Especificação do card”. Contrato REAL: fixtures em `__contract__/spec/*.json`
// (teste `cards.contract.spec.pg.integration.test.ts` do api-node), validadas por `schemas.ts`.

/** Pastas onde o card pode escrever (espelho de `cardWritableRoots` do backend): o pedido do card, os RFCs e os ADRs. A spec da versão corrente é somente leitura. */
export function cardWritableRoots(code: string): string[] { return [`tickets/${code}`, "docs/rfc", "docs/adr"]; }
/** Máscaras para mostrar ao usuário (iguais às que o servidor devolve em `writable`). */
export function cardWritableMasks(code: string): string[] { return cardWritableRoots(code).map((r) => `${r}/**`); }

/** O arquivo `p` (caminho relativo ao rascunho) está num escopo onde o card escreve? Mesma regra do servidor, aplicada antes de pedir. */
export function isCardWritablePath(code: string, p: string): boolean {
  const norm = p.trim().replace(/\\/g, "/");
  if (!norm || norm.startsWith("/")) return false;
  const segs = norm.split("/");
  if (segs.length < 2 || segs.length > 4 || segs.some((s) => s === "" || s === "." || s === "..")) return false;
  const dir = segs.slice(0, -1).join("/");
  return cardWritableRoots(code).some((root) => dir === root || dir.startsWith(`${root}/`));
}

/** Motivo (PT-BR) de um caminho novo ser recusado ANTES de chamar o servidor; `null` = ok. */
export function newFilePathProblem(code: string, p: string): string | null {
  const norm = p.trim();
  if (!norm) return "Informe o caminho do arquivo.";
  if (!/\.md$/i.test(norm)) return "Use a extensão .md (texto Markdown).";
  if (!isCardWritablePath(code, norm)) return `O card só escreve em ${cardWritableMasks(code).join(", ")}.`;
  return null;
}

const slugify = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "novo";

/**
 * Caminho sugerido para um RFC novo: `docs/rfc/RFC-NNNN-<slug>.md`, com NNNN logo após o maior número já presente no rascunho E na
 * versão corrente (`basePaths`, AB-05): o servidor recusa o número que a base já usa, então sugerir só pelo rascunho levava a um 409.
 */
export function suggestRfcPath(existing: string[], title = "novo-rfc", basePaths: string[] = []): string {
  let max = 0;
  for (const p of [...existing, ...basePaths]) { const m = /(?:^|\/)RFC-(\d{4})/i.exec(p); if (m) max = Math.max(max, Number(m[1])); }
  return `docs/rfc/RFC-${String(max + 1).padStart(4, "0")}-${slugify(title)}.md`;
}

/** Arquivos que a aba mostra: o pedido do card (somente leitura), os RFCs e os ADRs do card. Nada do resto da árvore. */
export function visibleDraftFiles(code: string, paths: string[]): string[] {
  return paths.filter((p) => isCardWritablePath(code, p)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
const rank = (p: string) => (p.startsWith("docs/rfc/") ? 0 : p.startsWith("docs/adr/") ? 1 : 2);
/** O pedido original (`tickets/TK-NNNN/…`) é imutável: a tela o exibe, mas não o edita. */
export const isRequestFile = (p: string) => p.startsWith("tickets/");

export const specApi = {
  tree: (draftId: string) => apiGet<SpecTree>(`/api/projects/${draftId}/spec-tree`),
  read: (draftId: string, path: string) => apiGet<SpecFileGet>(withQuery(`/api/projects/${draftId}/spec-file`, { path })),
  write: (draftId: string, path: string, content: string, baseSha: string) =>
    apiPut<SpecFileWrite>(withQuery(`/api/projects/${draftId}/spec-file`, { path }), { content, baseSha }),
  create: (draftId: string, path: string, content: string) => apiPost<SpecFileWrite>(`/api/projects/${draftId}/spec-file`, { path, content }),
  rfcFromTemplate: (draftId: string, title: string) => apiPost<RfcFromTemplate>(`/api/projects/${draftId}/rfc-from-template`, { title }),
  planStart: (draftId: string, request?: string) => apiPost<PlanStart>(`/api/projects/${draftId}/evolution-plan`, request ? { request } : {}),
  planPoll: (draftId: string, jobId: string) => apiGet<PlanJob>(`/api/projects/${draftId}/evolution-plan/${jobId}`),
  chatStart: (b: { specMarkdown: string; messages: Array<{ role: "user" | "assistant"; content: string }>; projectId: string; filePath: string; baseSha: string }) =>
    apiPost<ChatStart>("/api/spec-chat", b),
  chatPoll: (jobId: string) => apiGet<ChatJob>(`/api/spec-chat/${jobId}`),
};
