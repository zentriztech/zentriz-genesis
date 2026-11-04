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
import { toCanonicalUuid } from "../lib/uuid.js";

type Row = Record<string, unknown>;
export type GuardDb = { query(sql: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }> };

export const CARD_DRAFT_STATUS = "card_draft";
/** Pastas (relativas à raiz da spec do rascunho) em que o card escreve, além de `tickets/TK-NNNN/**`. */
export const CARD_EXTRA_WRITABLE_DIRS = ["docs/rfc", "docs/adr"] as const;

/** Chave de configuração do teto (em caracteres) do bloco de spec-base entregue à IA. calibrado=falso (o número do código só vale sem a chave). */
export const CARD_BASE_CONTEXT_CHARS_KEY = "CARD_BASE_CONTEXT_CHARS";
export const CARD_BASE_CONTEXT_FALLBACK_CHARS = 14_000;
/** Teto de segurança do bloco de contexto (Y-09): o `zentriz_admin` pode configurar até 200 000; sem a chave vale o piso de 14 000. */
export const CARD_BASE_CONTEXT_MAX_CHARS = 200_000;
/** Teto de caracteres da LISTA de arquivos dentro do bloco (Y-22): a lista conta no orçamento e é truncada. */
export const CARD_BASE_FILE_LIST_MAX_CHARS = 4_000;

export interface CardDraftInfo {
  projectId: string;
  tenantId: string | null;
  ticketId: string | null;
  number: number | null;
  /** `TK-0001`; `null` se o rascunho ficou órfão (sem ticket). */
  code: string | null;
  state: CardState | null;
  /** Raiz da linhagem do serviço-alvo (`extra.card_target_root_id`): de lá sai o HEAD que o rascunho não pode reescrever. */
  targetRootId?: string | null;
}

const code4 = (n: number) => `TK-${String(n).padStart(4, "0")}`;

/**
 * O projeto é um rascunho de card? `knownStatus` (quando o chamador já leu o status) evita a consulta para qualquer projeto comum.
 * Rascunho órfão (sem ticket ligado) volta com `state: null` — trata-se como travado.
 */
export async function loadCardDraftInfo(db: GuardDb, projectId: string, knownStatus?: string | null): Promise<CardDraftInfo | null> {
  if (knownStatus !== undefined && knownStatus !== null && knownStatus !== CARD_DRAFT_STATUS) return null;
  // Y-04: o Postgres aceita UUID sem hífens ou entre chaves. O id é normalizado UMA vez aqui e a linha é resolvida por `::uuid`;
  // `info.projectId` é sempre o id canônico lido do banco, nunca o texto cru da requisição.
  const canonical = toCanonicalUuid(projectId);
  if (!canonical) return null;
  const r = (await db.query(
    `SELECT p.id, p.status, p.tenant_id, p.extra->>'card_target_root_id' AS target_root_id, t.id AS ticket_id, t.number, t.card_state
       FROM projects p LEFT JOIN tickets t ON t.draft_project_id = p.id
      WHERE p.id = $1::uuid`,
    [canonical],
  )).rows[0];
  if (!r || String(r.status) !== CARD_DRAFT_STATUS) return null;
  const n = r.number === null || r.number === undefined ? null : Number(r.number);
  return {
    projectId: r.id ? String(r.id) : canonical, tenantId: r.tenant_id ? String(r.tenant_id) : null,
    ticketId: r.ticket_id ? String(r.ticket_id) : null, number: n, code: n === null ? null : code4(n),
    state: r.card_state ? (String(r.card_state) as CardState) : null,
    targetRootId: r.target_root_id ? String(r.target_root_id) : null,
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

/** Corpo da recusa por colisão com a árvore da versão corrente (409 `CARD_PATH_COLLIDES_WITH_BASE`, Y-02/Y-08). */
export function cardPathCollidesBody(info: CardDraftInfo, path: string): Record<string, unknown> {
  return {
    code: "CARD_PATH_COLLIDES_WITH_BASE",
    message: `'${path}' já existe na spec da versão corrente (somente leitura): o card não pode reescrever RFC/ADR herdado nem reutilizar o número dele. Crie um arquivo novo com outro número${info.code ? ` (${info.code})` : ""}.`,
    userMessage: cardUserMessage("CARD_PATH_COLLIDES_WITH_BASE"),
    path,
  };
}

const lowerNorm = (d: string | null | undefined) => normDir(d).toLowerCase();

/**
 * Colisão `(rel_dir, filename)` com a árvore do HEAD da linhagem (comparação sem diferenciar maiúsculas: conservador). A pasta do
 * próprio card (`tickets/TK-NNNN/**`) é regenerada pelo passo `ticket` da promoção e fica fora da regra. `null` = sem colisão
 * (ou sem HEAD legível: contexto a menos nunca derruba a escrita; o claim da promoção confere de novo).
 */
export async function findBaseCollision(db: GuardDb, info: CardDraftInfo, relDir: string | null | undefined, filename: string): Promise<string | null> {
  const dir = lowerNorm(relDir);
  const own = info.code ? `tickets/${info.code}`.toLowerCase() : null;
  if (own && (dir === own || dir.startsWith(`${own}/`))) return null;
  if (!info.targetRootId) return null;
  const { resolveLineageHead } = await import("./lineage.js");
  const head = await resolveLineageHead(db as never, info.targetRootId).catch(() => null);
  if (!head) return null;
  // AB-05: além do nome idêntico, o NÚMERO de RFC/ADR do HEAD é reservado (nome diferente com o mesmo número duplicaria o MADR no filho).
  const num = specNumberKey(filename);
  const rows = (await db.query(
    num
      ? "SELECT rel_dir, filename FROM project_spec_files WHERE project_id = $1 AND lower(btrim(COALESCE(rel_dir, ''), '/')) = $2"
      : "SELECT rel_dir, filename FROM project_spec_files WHERE project_id = $1 AND lower(btrim(COALESCE(rel_dir, ''), '/')) = $2 AND lower(filename) = $3 LIMIT 1",
    num ? [head.id, dir] : [head.id, dir, filename.toLowerCase()],
  )).rows as Array<{ rel_dir: string | null; filename: string }>;
  const hit = rows.find((r) => String(r.filename).toLowerCase() === filename.toLowerCase() || (num !== null && specNumberKey(String(r.filename)) === num));
  return hit ? `${normDir(String(hit.rel_dir ?? "")) ? `${normDir(String(hit.rel_dir))}/` : ""}${String(hit.filename)}` : null;
}

/** `RFC-0001-x.md` ⇒ `rfc:1`; `ADR-007-y.md` ⇒ `adr:7`; outro nome ⇒ `null`. Chave do número reservado pelo HEAD (AB-05). */
export function specNumberKey(filename: string): string | null {
  const m = /^(RFC|ADR)-(\d{1,6})(?:[-_.]|$)/i.exec(filename);
  return m ? `${m[1].toLowerCase()}:${Number(m[2])}` : null;
}

/** Todos os caminhos do conjunto `files` que já existem no HEAD (fora da pasta do próprio card), por nome OU por número de RFC/ADR. Uma consulta só. */
export async function findBaseCollisions(db: GuardDb, info: CardDraftInfo, files: Array<{ rel_dir: string | null; filename: string }>): Promise<string[]> {
  if (!info.targetRootId || files.length === 0) return [];
  const own = info.code ? `tickets/${info.code}`.toLowerCase() : null;
  const { resolveLineageHead } = await import("./lineage.js");
  const head = await resolveLineageHead(db as never, info.targetRootId).catch(() => null);
  if (!head) return [];
  const rows = (await db.query("SELECT rel_dir, filename FROM project_spec_files WHERE project_id = $1", [head.id])).rows as Array<{ rel_dir: string | null; filename: string }>;
  const key = (d: string | null | undefined, f: string) => `${lowerNorm(d)}\u0000${f.toLowerCase()}`;
  const numKey = (d: string | null | undefined, f: string) => { const n = specNumberKey(f); return n ? `${lowerNorm(d)}\u0000${n}` : null; };
  const display = (r: { rel_dir: string | null; filename: string }) => `${normDir(r.rel_dir as string | null) ? `${normDir(r.rel_dir as string | null)}/` : ""}${String(r.filename)}`;
  const inHead = new Map(rows.map((r) => [key(r.rel_dir as string | null, String(r.filename)), display(r)]));
  const numInHead = new Map<string, string>();
  for (const r of rows) { const k = numKey(r.rel_dir as string | null, String(r.filename)); if (k && !numInHead.has(k)) numInHead.set(k, display(r)); }
  const out: string[] = [];
  for (const f of files) {
    const dir = lowerNorm(f.rel_dir);
    if (own && (dir === own || dir.startsWith(`${own}/`))) continue;
    const nk = numKey(f.rel_dir, f.filename);
    const hit = inHead.get(key(f.rel_dir, f.filename)) ?? (nk ? numInHead.get(nk) : undefined);
    if (hit) out.push(hit);
  }
  return out;
}

/** Nomes de arquivo que a versão corrente (HEAD) tem em `relDir` — base da numeração de RFC/ADR do planner para o rascunho (Y-08). */
export async function listBaseFilenames(db: GuardDb, projectId: string, relDir: string): Promise<string[]> {
  const info = await loadCardDraftInfo(db, projectId);
  if (!info?.targetRootId) return [];
  const { resolveLineageHead } = await import("./lineage.js");
  const head = await resolveLineageHead(db as never, info.targetRootId).catch(() => null);
  if (!head) return [];
  const rows = (await db.query(
    "SELECT filename FROM project_spec_files WHERE project_id = $1 AND lower(btrim(COALESCE(rel_dir, ''), '/')) = $2",
    [head.id, lowerNorm(relDir)],
  )).rows;
  return rows.map((r) => String(r.filename));
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
  let target: { dir: string; filename: string; path: string } | null = null;
  if (opts.relPath != null && opts.relPath !== "") {
    if (!isCardWritablePath(code, opts.relPath)) return { status: 400, body: cardPathOutOfScopeBody(info, opts.relPath) };
    const clean = normDir(opts.relPath);
    const i = clean.lastIndexOf("/");
    target = { dir: i >= 0 ? clean.slice(0, i) : "", filename: clean.slice(i + 1), path: clean };
  } else if (opts.filename != null) {
    const p = normDir(opts.relDir) ? `${normDir(opts.relDir)}/${opts.filename}` : opts.filename;
    if (!isCardWritablePath(code, opts.relDir ?? "", opts.filename)) return { status: 400, body: cardPathOutOfScopeBody(info, p) };
    target = { dir: normDir(opts.relDir), filename: opts.filename, path: p };
  }
  // Y-02/Y-08: o card nunca reescreve um arquivo (RFC/ADR) que a versão corrente já tem — a promoção faria o upsert em cima dele no filho.
  if (target) {
    const hit = await findBaseCollision(db, info, target.dir, target.filename);
    if (hit) return { status: 409, body: cardPathCollidesBody(info, hit) };
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
    if (!info || !info.ticketId) return;
    if (info.state === "draft" || info.state === "ready") {
      // `draft → refining` na 1ª escrita. Y-01: o estado lido pode estar atrasado — o `ready` pode ter sido carimbado entre a leitura e a
      // transição (a máquina trava o ticket e vê `ready`); a escrita passou pela guarda ANTES do `ready` e terminou DEPOIS dele, então o
      // carimbo não vale: o card cai para `refining` e o carimbo é descartado, nunca fica `ready` sobre uma árvore que mudou.
      const t = await transitionCard(db, {
        ticketId: info.ticketId, to: "refining", actorKind: "system", actorId: opts.actorId ?? null,
        reason: info.state === "ready" ? "spec_write_after_ready" : "spec_write",
      });
      if (t.kind === "applied" && t.from === "ready") {
        await db.query(
          "UPDATE projects SET extra = COALESCE(extra, '{}'::jsonb) - 'card_ready', updated_at = now() WHERE id = $1::uuid AND status = 'card_draft'",
          [info.projectId],
        );
      }
    }
  } catch (e) {
    console.warn(`[cardSpecGuard] transição após escrita não aplicada (best-effort): ${e instanceof Error ? e.message : String(e)}`);
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
      ?? (await readRuntimeNumber(db, CARD_BASE_CONTEXT_CHARS_KEY, info.tenantId, { min: 1000, max: CARD_BASE_CONTEXT_MAX_CHARS }))
      ?? CARD_BASE_CONTEXT_FALLBACK_CHARS;
    // Y-22: a LISTA de arquivos conta no orçamento do bloco e tem teto próprio (spec com centenas de arquivos não estoura o contexto).
    const listBudget = Math.min(CARD_BASE_FILE_LIST_MAX_CHARS, Math.max(200, Math.floor(budget / 4)));
    let listText = "";
    let listed = 0;
    for (const f of spec.files) {
      const item = `${listed > 0 ? ", " : ""}${f.path} (${f.sizeBytes}B)`;
      if (listText.length + item.length > listBudget) break;
      listText += item;
      listed++;
    }
    if (listed < spec.files.length) listText += `, … (+${spec.files.length - listed} arquivo(s) omitido(s) da lista)`;
    const lines: string[] = [
      `--- SPEC DA VERSÃO CORRENTE (v${spec.headVersion}) — SOMENTE LEITURA ---`,
      cardScopeInstruction(info.code),
      "",
      `Arquivos da versão corrente (${spec.files.length}): ${listText}`,
    ];
    let used = lines.join("\n").length;
    for (const f of spec.files) {
      if (f.content === null || f.content === undefined) continue;
      // o cabeçalho de cada arquivo também entra na conta (antes o estouro era sempre o tamanho do cabeçalho)
      const header = `\n### ARQUIVO DA VERSÃO CORRENTE (somente leitura): ${f.path}\n`;
      const remaining = budget - used - header.length;
      if (remaining < 200) { lines.push("\n(demais arquivos da versão corrente omitidos por limite de contexto)"); break; }
      const body = f.content.length > remaining ? `${f.content.slice(0, remaining)}\n…(truncado)…` : f.content;
      const chunk = `${header}${body}`;
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
