/**
 * cardDelivery.ts — tarefa 4.3 da Fase 4 (plano EVOLUIR-PROJETO-BANCADA): marcação automática de EXECUTADO.
 *
 * Regra: filho `accepted` (ou arquivado por supersessão) + PR mergeado (quando a LINHAGEM tem repositório) ⇒ o card vai a `delivered` pela máquina de estados
 * (`transitionCard`, ator `system`, auditado em `ticket_card_events`) e os arquivos de spec do card recebem
 * `executed_in_project` / `executed_at` (migration 149) NA MESMA TRANSAÇÃO da transição. As tasks do filho não têm coluna
 * `executed_*` (migration 150 só criou `card_id` e `origin_spec_file`): "task executada" é derivada — `project_tasks.project_id` =
 * `tickets.child_project_id` de um card `delivered` (decisão D-M2 da revisão D: sem segunda fonte de verdade).
 *
 * Quem chama (todos idempotentes, nenhum lança):
 *   • aceite do projeto (`POST /api/projects/:id/accept`), depois do push/PR e da tentativa de merge automático;
 *   • `recordMergedAndHooks` (merge automático ou manual do PR) — o merge é o último requisito;
 *   • reconciliador (`deliverAcceptedCards`, só em `on`): cobre o merge feito direto no GitHub, sem passar pelo Genesis.
 *
 * Garantias:
 *   • só toca ticket com `card_state` NÃO nulo (ticket legado é invisível aqui ⇒ fluxo legado idêntico, flag desligada ou não);
 *   • a prova de merge é feita ANTES da transação (rede fora do lock): `extra.evolution_merged_at` (gravado pelo merge do Genesis)
 *     ou, na falta dele, consulta ao PR no GitHub (`getPullRequest`, injetável para teste). Sem prova ⇒ `pending_merge`, nada muda;
 *   • repetir N vezes ou em corrida: o `FOR UPDATE` do ticket serializa; o segundo vê `delivered` e vira no-op; o carimbo só escreve
 *     onde `executed_in_project IS NULL`; o evento usa `dedupeKey` por filho;
 *   • card `promoted`/`blocked` com filho já aceito e prova de merge é levado antes a `in_factory` (`child_accepted`), na mesma transação.
 */
import type { Pool } from "pg";
import { transitionCard, isSupersededChild, acceptedLikeChildSql, type CardState, type CardTransitionResult } from "./cardState.js";
import { ticketCode } from "./tickets.js";

type Json = Record<string, unknown>;

/** Resultado mínimo que a verificação de merge precisa do GitHub (compatível com `getPullRequest`). */
export type PrLookup = { ok: true; merged: boolean; state?: string } | { ok: false; error?: string };
export interface DeliveryDeps {
  /** Consulta o PR no GitHub. Default: `getPullRequest` real (usa o seam `__setOctokitFactoryForTests`). */
  getPullRequest?: (installationId: number, o: { owner: string; repo: string; number: number }) => Promise<PrLookup>;
}

export type MergeProof =
  | { required: false; merged: true; source: "no_repo" }
  /** N6a: repositório novo criado pelo push do filho (`fallback_new_repo`) — o código foi direto para `dev`, sem PR por desenho. */
  | { required: false; merged: true; source: "direct_push" }
  /** N8: PR do filho superado foi FECHADO sem merge, mas a versão sucessora (snapshot completo de `apps/`) está mergeada. */
  | { required: true; merged: true; source: "successor_merged" }
  | { required: true; merged: true; source: "genesis_merge" | "github" }
  | { required: true; merged: false; source: "unverified"; detail: string };

/**
 * O PR do filho está mergeado? Decisão de "sem repositório" pela LINHAGEM (B1): a linha do filho em `project_github_repos` só nasce DEPOIS de
 * um push bem-sucedido, então "filho sem linha" quase sempre significa "código ainda não publicado". Ordem (fail-closed):
 *   1. publicação pendente/em voo (`evolution_push_pending` ou `evolution_publish_state='pending'`) ⇒ `push_pending` (precedência máxima);
 *   2. `extra.evolution_merged_at` (merge feito pelo Genesis) ⇒ provado;
 *   3. nem o filho nem a linhagem têm repositório ⇒ `no_repo` (nada a publicar/mergear);
 *   4. há repositório: exige `evolution_pr_number` + instalação viva e consulta o PR no GitHub. Qualquer dúvida ⇒ não mergeado.
 */
export async function verifyChildPrMerged(pool: Pick<Pool, "query">, childId: string, deps: DeliveryDeps = {}): Promise<MergeProof> {
  const row = (await pool.query(
    `SELECT p.extra, p.status, p.tenant_id, p.parent_project_id, r.repo_full_name, gi.installation_id, gi.revoked_at
       FROM projects p
       LEFT JOIN project_github_repos r ON r.project_id = p.id
       LEFT JOIN tenant_github_installations gi ON gi.tenant_id = p.tenant_id
      WHERE p.id = $1`, [childId])).rows[0] as
    { extra: Json | null; status: string; parent_project_id: string | null; repo_full_name: string | null; installation_id: number | string | null; revoked_at: string | null } | undefined;
  if (!row) return { required: true, merged: false, source: "unverified", detail: "child_not_found" };
  const extra = row.extra ?? {};
  // N1: `failed` (push que falhou) também bloqueia — sem prova de publicação não há entrega.
  if (extra.evolution_push_pending === true || extra.evolution_publish_state === "pending" || extra.evolution_publish_state === "failed") return { required: true, merged: false, source: "unverified", detail: "push_pending" };
  if (typeof extra.evolution_merged_at === "string" && extra.evolution_merged_at) return { required: true, merged: true, source: "genesis_merge" };
  let repoFull = row.repo_full_name;
  if (!repoFull) {
    const { findLineageRepo } = await import("./evolutionAccept.js");
    const parent = (typeof extra.evolution_parent_id === "string" ? extra.evolution_parent_id : null) ?? row.parent_project_id ?? null;
    repoFull = (await findLineageRepo(pool as never, childId, parent))?.repo_full_name ?? null;
  }
  if (!repoFull) return { required: false, merged: true, source: "no_repo" };
  const prNumber = typeof extra.evolution_pr_number === "number" ? extra.evolution_pr_number : null;
  // N6a: repositório novo criado pelo próprio filho, publicado e fechado (`done`): o código já está em `dev`; não existe PR a esperar.
  if (!prNumber && row.repo_full_name && extra.evolution_publish_mode === "direct_dev" && extra.evolution_publish_state === "done") {
    return { required: false, merged: true, source: "direct_push" };
  }
  if (!prNumber) return { required: true, merged: false, source: "unverified", detail: "no_pr" };
  if (!row.installation_id || row.revoked_at) return { required: true, merged: false, source: "unverified", detail: "no_installation" };
  const [owner, repo] = repoFull.split("/");
  if (!owner || !repo) return { required: true, merged: false, source: "unverified", detail: "bad_repo" };
  const lookup = deps.getPullRequest ?? (await import("./github.js")).getPullRequest;
  const pr = await lookup(Number(row.installation_id), { owner, repo, number: prNumber }).catch(() => ({ ok: false as const }));
  if (pr.ok && pr.merged) return { required: true, merged: true, source: "github" };
  // N8: filho superado cujo PR foi fechado sem merge — o sucessor empurra o snapshot completo e, mergeado, contém esta versão.
  if (pr.ok && pr.state === "closed" && isSupersededChild(row.status, extra)) {
    if (await successorMerged(pool, extra, lookup, Number(row.installation_id), { owner, repo }, 0)) return { required: true, merged: true, source: "successor_merged" };
    return { required: true, merged: false, source: "unverified", detail: "pr_closed_successor_not_merged" };
  }
  return { required: true, merged: false, source: "unverified", detail: pr.ok ? "pr_not_merged" : "pr_lookup_failed" };
}

/** A versão sucessora (`superseded_by`, até 5 elos) já foi mergeada? Merge do Genesis registrado ou PR do sucessor mergeado no GitHub. */
async function successorMerged(
  pool: Pick<Pool, "query">, extra: Json, lookup: NonNullable<DeliveryDeps["getPullRequest"]>, installationId: number,
  repo: { owner: string; repo: string }, depth: number,
): Promise<boolean> {
  const succId = typeof extra.superseded_by === "string" ? extra.superseded_by : "";
  if (!succId || depth >= 5) return false;
  const s = (await pool.query("SELECT status, extra FROM projects WHERE id = $1", [succId])).rows[0] as { status: string; extra: Json | null } | undefined;
  if (!s) return false;
  const sx = s.extra ?? {};
  if (s.status !== "accepted" && !isSupersededChild(s.status, sx)) return false;
  if (sx.evolution_push_pending === true || sx.evolution_publish_state === "pending" || sx.evolution_publish_state === "failed") return false;
  if (typeof sx.evolution_merged_at === "string" && sx.evolution_merged_at) return true;
  const n = typeof sx.evolution_pr_number === "number" ? sx.evolution_pr_number : null;
  if (n) {
    const pr = await lookup(installationId, { ...repo, number: n }).catch(() => ({ ok: false as const }));
    if (pr.ok && pr.merged) return true;
  }
  // Sucessor ainda não mergeado (aberto, fechado ou direto): o sucessor do sucessor também carrega o snapshot completo.
  return successorMerged(pool, sx, lookup, installationId, repo, depth + 1);
}

export type CardDeliveryOutcome =
  | { ticketId: string; result: "delivered"; stamped: number }
  | { ticketId: string; result: "already_delivered"; stamped: number }
  | { ticketId: string; result: "pending_merge"; detail: string }
  | { ticketId: string; result: "refused"; transition: CardTransitionResult["kind"]; code?: string };

/**
 * Entrega os cards ligados ao filho `childId` se ele está `accepted` e o PR está mergeado. Devolve um resultado por card (vazio quando o
 * filho não está aceito ou não tem card). Nunca lança: erro de banco/rede vira `[]`/`pending_merge`, para o chamador (aceite, merge,
 * reconciliador) jamais falhar por causa disto.
 */
export async function deliverCardsOfChild(pool: Pool, childId: string, deps: DeliveryDeps = {}): Promise<CardDeliveryOutcome[]> {
  try {
    const child = (await pool.query("SELECT status, extra FROM projects WHERE id = $1", [childId])).rows[0] as { status: string; extra: Json | null } | undefined;
    // A1: filho arquivado por SUPERSESSÃO (aceito e substituído pela versão seguinte antes do merge) também entrega quando o PR é mergeado.
    if (!child || (child.status !== "accepted" && !isSupersededChild(child.status, child.extra))) return [];
    const cards = (await pool.query(
      `SELECT id FROM tickets
        WHERE child_project_id = $1 AND card_state IN ('promoted', 'in_factory', 'blocked', 'delivered')
        ORDER BY number`, [childId])).rows as Array<{ id: string }>;
    if (cards.length === 0) return [];
    const proof = await verifyChildPrMerged(pool, childId, deps);
    const out: CardDeliveryOutcome[] = [];
    for (const c of cards) {
      const o = await deliverOne(pool, String(c.id), childId, proof);
      out.push(o);
      if (o.result === "delivered") await reportExecutedTasks(pool, String(c.id), childId);
    }
    return out;
  } catch (e) {
    console.error("[cardDelivery] falha ignorada:", e instanceof Error ? e.message : String(e));
    return [];
  }
}

async function deliverOne(pool: Pool, ticketId: string, childId: string, proof: MergeProof): Promise<CardDeliveryOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = (await client.query(
      "SELECT card_state, number, child_project_id, draft_project_id FROM tickets WHERE id = $1 FOR UPDATE", [ticketId])).rows[0] as
      { card_state: CardState | null; number: number; child_project_id: string | null; draft_project_id: string | null } | undefined;
    // Relido sob lock: o card pode ter sido religado a outro filho, rejeitado ou entregue por uma corrida.
    if (!cur || cur.card_state === null || cur.child_project_id !== childId) { await client.query("ROLLBACK"); return { ticketId, result: "refused", transition: "not_a_card" }; }
    if (cur.card_state === "delivered") {
      const stamped = await stampExecuted(client, cur, childId);
      await client.query("COMMIT");
      return { ticketId, result: "already_delivered", stamped };
    }
    if (!proof.merged) { await client.query("ROLLBACK"); return { ticketId, result: "pending_merge", detail: proof.detail }; }
    if (cur.card_state === "promoted" || cur.card_state === "blocked") {
      const up = await transitionCard(client, { ticketId, to: "in_factory", actorKind: "system", reason: "child_accepted", dedupeKey: `child_accepted:${childId}` });
      if (up.kind !== "applied" && up.kind !== "noop") { await client.query("ROLLBACK"); return refusedOf(ticketId, up); }
    }
    const t = await transitionCard(client, {
      ticketId, to: "delivered", actorKind: "system", reason: `accepted_${proof.source}`, dedupeKey: `delivered:${childId}`,
      // A prova já foi colhida fora do lock; aqui só confirma o resultado (a máquina recusa `merge_unverified` sem este callback).
      mergeCheck: async () => proof.merged,
    });
    if (t.kind !== "applied" && t.kind !== "noop") { await client.query("ROLLBACK"); return refusedOf(ticketId, t); }
    const stamped = await stampExecuted(client, cur, childId);
    await client.query("COMMIT");
    return { ticketId, result: t.kind === "applied" ? "delivered" : "already_delivered", stamped };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * M4 (consumidor de `listExecutedTasksOfCard`): ao ENTREGAR o card, registra no diálogo do filho o relatório das tasks executadas (derivadas, sem coluna
 * `executed_*`). Roda só quando a transição foi aplicada agora (uma vez por card); best-effort — nunca desfaz a entrega. A superfície de API/portal
 * (campo no detalhe do card) fica de fora de propósito: o contrato dos cards está congelado em fixtures do portal (decisão do Jean pendente).
 */
async function reportExecutedTasks(pool: Pool, ticketId: string, childId: string): Promise<void> {
  try {
    const tasks = await listExecutedTasksOfCard(pool, ticketId);
    const list = tasks.length ? tasks.map((t) => t.taskId).join(", ").slice(0, 600) : "nenhuma task própria (somente herdadas)";
    await pool.query(
      "INSERT INTO project_dialogue (project_id, from_agent, to_agent, event_type, summary_human) VALUES ($1, 'system', 'system', 'step', $2)",
      [childId, `✅ Card entregue: ${tasks.length} task(s) executada(s) — ${list}.`],
    );
  } catch { /* relatório é informativo */ }
}

function refusedOf(ticketId: string, t: CardTransitionResult): CardDeliveryOutcome {
  return { ticketId, result: "refused", transition: t.kind, ...(t.kind === "precondition_failed" ? { code: t.code } : {}) };
}

/**
 * Carimba `executed_in_project` / `executed_at` nos arquivos de spec que nasceram do card (`spec_origin = card:TK-NNNN`) — no filho e no
 * rascunho de origem. Só escreve onde ainda é NULL: repetir não move a data nem sobrescreve outro projeto. Devolve quantos arquivos marcou.
 */
async function stampExecuted(q: { query(sql: string, p?: unknown[]): Promise<{ rowCount?: number | null }> }, card: { number: number; draft_project_id: string | null }, childId: string): Promise<number> {
  const r = await q.query(
    `UPDATE project_spec_files SET executed_in_project = $1, executed_at = now()
      WHERE project_id = ANY($2::uuid[]) AND spec_origin = $3 AND executed_in_project IS NULL`,
    [childId, [childId, card.draft_project_id].filter((x): x is string => Boolean(x)), `card:${ticketCode(card.number)}`],
  );
  return r.rowCount ?? 0;
}

/**
 * Passada do reconciliador: cards `in_factory` (ou `promoted`/`blocked`) cujo filho JÁ está `accepted` e ainda não foram entregues — merge
 * feito direto no GitHub, aceite sem o gancho, falha no meio. Corrige pela transição idempotente. Devolve quantos cards foram entregues agora.
 */
export async function deliverAcceptedCards(pool: Pool, opts: { limit?: number; tenantId?: string | null } & DeliveryDeps = {}): Promise<number> {
  let n = 0;
  try {
    const rows = (await pool.query(
      `SELECT t.child_project_id AS id FROM tickets t JOIN projects p ON p.id = t.child_project_id
        WHERE t.card_state IN ('promoted', 'in_factory', 'blocked') AND ${acceptedLikeChildSql("p")}
          AND ($2::uuid IS NULL OR t.tenant_id = $2)
        GROUP BY t.child_project_id ORDER BY t.child_project_id LIMIT $1`, [opts.limit ?? 100, opts.tenantId ?? null])).rows as Array<{ id: string }>;
    for (const r of rows) {
      const res = await deliverCardsOfChild(pool, String(r.id), { getPullRequest: opts.getPullRequest });
      n += res.filter((x) => x.result === "delivered").length;
    }
  } catch { /* detector nunca derruba a passada */ }
  return n;
}

/**
 * M4: tasks "executadas" de um card ENTREGUE — derivadas (sem coluna `executed_*` em `project_tasks`): tasks do filho do card, não herdadas,
 * em estado de sucesso (`DONE`/`QA_PASS`). `CANCELLED`, `QA_FAIL`, `BLOCKED` e as ainda não rodadas NÃO contam. Card não entregue ⇒ vazio.
 */
export async function listExecutedTasksOfCard(pool: Pick<Pool, "query">, ticketId: string): Promise<Array<{ taskId: string; status: string }>> {
  const r = await pool.query(
    `SELECT pt.task_id, pt.status FROM tickets t JOIN project_tasks pt ON pt.project_id = t.child_project_id
      WHERE t.id = $1 AND t.card_state = 'delivered'
        AND pt.task_id NOT LIKE 'TSK-INH-%' AND pt.status IN ('DONE', 'QA_PASS')
      ORDER BY pt.task_id`, [ticketId]);
  return (r.rows as Array<{ task_id: string; status: string }>).map((x) => ({ taskId: x.task_id, status: x.status }));
}
