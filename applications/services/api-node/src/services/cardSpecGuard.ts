/**
 * cardSpecGuard.ts — Fase 3 (tarefa 3.3, plano EVOLUIR-PROJETO-BANCADA v2; desenho H §5.2/§5.4): a spec do CARD (rascunho `card_draft`).
 *
 * Um card é um `tickets` com `card_state`; a spec dele vive no projeto-rascunho (`projects.status = 'card_draft'`, sem versão, sem
 * pai, sem árvore herdada). Todo escritor de spec que aceita um `projectId` (editor de árvore, PATCH spec-content, Chat IA, Resolver
 * GAPs / modo autônomo, planner de RFC, RFC a partir do modelo) passa por aqui quando o projeto é um `card_draft`:
 *
 *   • TRAVA `CARD_SPEC_LOCKED` (409): só se escreve com o card em `draft`/`refining`. Depois que o card vai a `ready` (carimbo do hash da
 *     spec, `extra.card_ready`) — e nos estados seguintes, em que o rascunho é histórico — qualquer escritor responde 409 até o card
 *     voltar a `refining` pela transição explícita `reopen` (`POST /api/cards/:id/reopen`, máquina de estados + auditoria). A promoção
 *     continua protegida pelo hash do carimbo (`cardPromote`), com ou sem a trava.
 *   • ESCOPO de escrita `CARD_PATH_OUT_OF_SCOPE` (400): o rascunho só aceita a pasta do card (`tickets/TK-NNNN/**`) e o RFC/ADR do card
 *     (`docs/rfc/**`, `docs/adr/**`). Nada de README, CHANGELOG, connect.yaml, diagramas: a promoção copia tudo que o rascunho tem fora da
 *     pasta do ticket para o filho (passo `card_spec` do claim) e isso não pode sobrescrever a árvore herdada da versão corrente.
 *   • PRIMEIRA ESCRITA: `draft → refining` (ator `system`, motivo `spec_write`), como já faz o PATCH de texto.
 *   • CONTEXTO somente leitura: `buildCardBaseContextBlock` entrega ao Chat IA / Resolver GAPs / validador / planner a spec da versão
 *     CORRENTE (HEAD da linhagem; o mesmo helper de `GET /api/cards/:id/base-spec`) em bloco rotulado "SOMENTE LEITURA". Nunca é escrita.
 *
 * Projeto que NÃO é `card_draft` ⇒ nada aqui age (`null`/`""`): o caminho legado fica byte a byte como era (com `knownStatus` informado,
 * nem uma consulta a mais é feita).
 */
import { transitionCard, type CardState } from "./cardState.js";
import { readRuntimeNumber, type RuntimeConfigDb } from "./runtimeTunables.js";
import { cardUserMessage } from "./cardErrors.js";

type Row = Record<string, unknown>;
export type GuardDb = { query(sql: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }> };

export const CARD_DRAFT_STATUS = "card_draft";
/** Pastas (relativas à raiz da spec do rascunho) em que o card escreve, além de `tickets/TK-NNNN/**`. */
export const CARD_EXTRA_WRITABLE_DIRS = ["docs/rfc", "docs/adr"] as const;

/** Chave de configuração do teto (em caracteres) do bloco de spec-base entregue à IA. calibrado=falso (o número do código só vale sem a chave). */
export const CARD_BASE_CONTEXT_CHARS_KEY = "CARD_BASE_CONTEXT_CHARS";
export const CARD_BASE_CONTEXT_FALLBACK_CHARS = 14_000;

export interface CardDraftInfo {
  projectId: string;
  tenantId: string | null;
  ticketId: string | null;
  number: number | null;
  /** `TK-0001`; `null` se o rascunho ficou órfão (sem ticket). */
  code: string | null;
  state: CardState | null;
}

const code4 = (n: number) => `TK-${String(n).padStart(4, "0")}`;

/**
 * O projeto é um rascunho de card? `knownStatus` (quando o chamador já leu o status) evita a consulta para qualquer projeto comum.
 * Rascunho órfão (sem ticket ligado) volta com `state: null` — trata-se como travado.
 */
export async function loadCardDraftInfo(db: GuardDb, projectId: string, knownStatus?: string | null): Promise<CardDraftInfo | null> {
  if (knownStatus !== undefined && knownStatus !== null && knownStatus !== CARD_DRAFT_STATUS) return null;
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) return null;
  const r = (await db.query(
    `SELECT p.status, p.tenant_id, t.id AS ticket_id, t.number, t.card_state
       FROM projects p LEFT JOIN tickets t ON t.draft_project_id = p.id
      WHERE p.id = $1`,
    [projectId],
  )).rows[0];
  if (!r || String(r.status) !== CARD_DRAFT_STATUS) return null;
  const n = r.number === null || r.number === undefined ? null : Number(r.number);
  return {
    projectId, tenantId: r.tenant_id ? String(r.tenant_id) : null,
    ticketId: r.ticket_id ? String(r.ticket_id) : null, number: n, code: n === null ? null : code4(n),
    state: r.card_state ? (String(r.card_state) as CardState) : null,
  };
}

/** Pastas (prefixos) graváveis no rascunho do card `code`. */
export function cardWritableRoots(code: string): string[] {
  return [`tickets/${code}`, ...CARD_EXTRA_WRITABLE_DIRS];
}

const normDir = (d: string | null | undefined) => (d ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

/** `relDir` + `filename` dentro do escopo de escrita do card? (`tickets/TK-NNNN` e subpastas; `docs/rfc`; `docs/adr`.) */
export function isCardWritablePath(code: string, relDir: string | null | undefined, filename?: string | null): boolean {
  let dir = normDir(relDir);
  if (filename === undefined || filename === null) {
    // `relDir` recebeu o caminho inteiro (`docs/rfc/RFC-0001-x.md`): separa o último segmento.
    const i = dir.lastIndexOf("/");
    dir = i >= 0 ? dir.slice(0, i) : "";
  }
  if (dir.split("/").some((s) => s === ".." || s === "." )) return false;
  return cardWritableRoots(code).some((root) => dir === root || dir.startsWith(`${root}/`));
}

export interface CardGuardBlock { status: number; body: Record<string, unknown> }

/** Corpo da recusa por trava (409 `CARD_SPEC_LOCKED`). */
export function cardSpecLockedBody(info: CardDraftInfo): Record<string, unknown> {
  const canReopen = info.state === "ready";
  const code = info.code ?? "o card";
  return {
    code: "CARD_SPEC_LOCKED",
    message: canReopen
      ? `A spec de ${code} está travada: o card está pronto (ready). Reabra o card (POST /api/cards/${info.ticketId}/reopen) para voltar a editar.`
      : info.state
        ? `A spec de ${code} está travada: o card está em '${info.state}' e o rascunho virou histórico.`
        : "A spec deste rascunho está travada: ele não está ligado a nenhum card.",
    userMessage: cardUserMessage("CARD_SPEC_LOCKED"),
    state: info.state, canReopen,
    ...(info.ticketId ? { cardId: info.ticketId, ...(canReopen ? { reopen: `POST /api/cards/${info.ticketId}/reopen` } : {}) } : {}),
  };
}

export function cardPathOutOfScopeBody(info: CardDraftInfo, path: string): Record<string, unknown> {
  const code = info.code ?? "TK-NNNN";
  return {
    code: "CARD_PATH_OUT_OF_SCOPE",
    message: `O card só escreve em ${cardWritableRoots(code).map((r) => `${r}/`).join(", ")}. O caminho '${path}' pertence à spec da versão corrente (somente leitura).`,
    userMessage: cardUserMessage("CARD_PATH_OUT_OF_SCOPE"),
    path, writable: cardWritableRoots(code).map((r) => `${r}/**`),
  };
}

/**
 * A porta única dos escritores. `null` = pode escrever (ou o projeto não é rascunho de card). `relPath`/`relDir`+`filename` (quando o
 * escritor sabe o destino) também são checados contra o escopo. Chamar ANTES de escrever.
 */
export async function cardSpecWriteBlock(
  db: GuardDb, projectId: string,
  opts: { knownStatus?: string | null; relPath?: string | null; relDir?: string | null; filename?: string | null } = {},
): Promise<CardGuardBlock | null> {
  const info = await loadCardDraftInfo(db, projectId, opts.knownStatus);
  if (!info) return null;
  if (info.state !== "draft" && info.state !== "refining") return { status: 409, body: cardSpecLockedBody(info) };
  const code = info.code ?? "";
  if (opts.relPath != null && opts.relPath !== "") {
    if (!isCardWritablePath(code, opts.relPath)) return { status: 400, body: cardPathOutOfScopeBody(info, opts.relPath) };
  } else if (opts.filename != null) {
    if (!isCardWritablePath(code, opts.relDir ?? "", opts.filename)) {
      const p = normDir(opts.relDir) ? `${normDir(opts.relDir)}/${opts.filename}` : opts.filename;
      return { status: 400, body: cardPathOutOfScopeBody(info, p) };
    }
  }
  return null;
}

/**
 * Orçamento COMPARTILHADO com o dono da versão corrente (o rascunho aponta `budget_owner_project_id` para ele): antes de gastar LLM no
 * rascunho, o Guard de custo é consultado e a negativa vira 402 com o código do Guard (`BUDGET_*`, `KILL_SWITCH`…) — resposta clara,
 * SEM alterar o card (nunca `blocked`/`failed` por falta de saldo na maturação: nada em execução foi perdido). `null` = liberado
 * (ou projeto que não é rascunho de card).
 */
export async function cardBudgetBlock(db: GuardDb, projectId: string, knownStatus?: string | null): Promise<CardGuardBlock | null> {
  const info = await loadCardDraftInfo(db, projectId, knownStatus);
  if (!info) return null;
  const { checkProjectBudgetGate } = await import("./llmGuard.js");
  const gate = await checkProjectBudgetGate(db as never, projectId);
  if (gate.ok) return null;
  return {
    status: 402,
    body: {
      code: gate.code, message: gate.message, userMessage: cardUserMessage(gate.code),
      ...(info.ticketId ? { cardId: info.ticketId, cardState: info.state } : {}),
    },
  };
}

/** Escritor que só PODE rodar fora de um rascunho de card (split, declaração Connect, diagramas…): 409 explicando. */
export async function cardDraftUnsupportedBlock(db: GuardDb, projectId: string, what: string, knownStatus?: string | null): Promise<CardGuardBlock | null> {
  const info = await loadCardDraftInfo(db, projectId, knownStatus);
  if (!info) return null;
  return {
    status: 409,
    body: {
      code: "CARD_OPERATION_UNSUPPORTED",
      userMessage: cardUserMessage("CARD_OPERATION_UNSUPPORTED"),
      message: `${what} não se aplica ao rascunho de um card: o card escreve só a pasta dele (tickets/${info.code ?? "TK-NNNN"}/**, RFC e ADR). Use o Chat IA do card ou o planner de RFC.`,
    },
  };
}

/**
 * Pós-escrita: a 1ª escrita na spec do rascunho leva o card `draft → refining` (ator `system`, motivo `spec_write`). Idempotente,
 * best-effort (a escrita já aconteceu; o estado se acerta na próxima chamada). Só mexe em `draft`.
 */
export async function noteCardSpecWrite(
  db: Parameters<typeof transitionCard>[0] & GuardDb, projectId: string, opts: { actorId?: string | null; knownStatus?: string | null } = {},
): Promise<void> {
  try {
    const info = await loadCardDraftInfo(db, projectId, opts.knownStatus);
    if (!info || !info.ticketId || info.state !== "draft") return;
    await transitionCard(db, { ticketId: info.ticketId, to: "refining", actorKind: "system", actorId: opts.actorId ?? null, reason: "spec_write" });
  } catch (e) {
    console.warn(`[cardSpecGuard] draft→refining após escrita não aplicado (best-effort): ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Contexto somente leitura (spec da versão corrente) ───────────────────────────────────────────

/** Cabeçalho que ancora a IA: onde ela escreve e o que é só leitura. */
export function cardScopeInstruction(code: string): string {
  return [
    `ESCOPO DESTE CARD (${code}): você está editando a spec de UM CARD (rascunho), não a do produto.`,
    `Escreva SOMENTE em ${cardWritableRoots(code).map((r) => `${r}/`).join(", ")} (o pedido, o RFC com Gherkin e files_allowed, ADR).`,
    "A spec da VERSÃO CORRENTE abaixo é SOMENTE LEITURA: use-a para entender o produto, citar caminhos e não contradizê-la — NÃO a copie, NÃO a reescreva, NÃO crie README/CHANGELOG/connect.yaml/diagramas.",
  ].join("\n");
}

/**
 * Bloco "SPEC DA VERSÃO CORRENTE (somente leitura)" para o prompt da IA. `""` quando o projeto não é rascunho de card, o card não tem
 * base (sem HEAD aceito) ou qualquer falha de leitura (best-effort: contexto a menos nunca derruba a rota). Reaproveita `loadBaseSpec`
 * (a mesma leitura de `GET /api/cards/:id/base-spec`), recortada pelo orçamento `CARD_BASE_CONTEXT_CHARS`.
 */
export async function buildCardBaseContextBlock(
  db: GuardDb & RuntimeConfigDb, projectId: string, opts: { knownStatus?: string | null; budgetChars?: number } = {},
): Promise<string> {
  try {
    const info = await loadCardDraftInfo(db, projectId, opts.knownStatus);
    if (!info || !info.code) return "";
    const { loadBaseSpecForDraft } = await import("./cardService.js");
    const spec = await loadBaseSpecForDraft(db as never, projectId);
    if (!spec) return "";
    const budget = opts.budgetChars
      ?? (await readRuntimeNumber(db, CARD_BASE_CONTEXT_CHARS_KEY, info.tenantId, { min: 1000, max: 400_000 }))
      ?? CARD_BASE_CONTEXT_FALLBACK_CHARS;
    const lines: string[] = [
      `--- SPEC DA VERSÃO CORRENTE (v${spec.headVersion}) — SOMENTE LEITURA ---`,
      cardScopeInstruction(info.code),
      "",
      `Arquivos da versão corrente (${spec.files.length}): ${spec.files.map((f) => `${f.path} (${f.sizeBytes}B)`).join(", ")}`,
    ];
    let used = lines.join("\n").length;
    for (const f of spec.files) {
      if (f.content === null || f.content === undefined) continue;
      const remaining = budget - used;
      if (remaining < 200) { lines.push("\n(demais arquivos da versão corrente omitidos por limite de contexto)"); break; }
      const body = f.content.length > remaining ? `${f.content.slice(0, remaining)}\n…(truncado)…` : f.content;
      const chunk = `\n### ARQUIVO DA VERSÃO CORRENTE (somente leitura): ${f.path}\n${body}`;
      lines.push(chunk);
      used += chunk.length;
    }
    lines.push("--- FIM DA SPEC DA VERSÃO CORRENTE ---");
    return lines.join("\n");
  } catch (e) {
    console.warn(`[cardSpecGuard] contexto da spec-base indisponível (best-effort): ${e instanceof Error ? e.message : String(e)}`);
    return "";
  }
}
