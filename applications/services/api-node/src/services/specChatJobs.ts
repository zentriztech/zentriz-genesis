/**
 * specChatJobs.ts — persistência do job do chat de spec da Bancada (migration 089).
 *
 * PROBLEMA QUE ISTO RESOLVE (medido em prod 2026-09-04): o job do chat/"Resolver GAPs" vivia
 * SÓ num Map em memória da api e o `jobId` só no closure do React. Sair da tela matava o poll,
 * o job seguia vivo nos agents e o resultado nascia INALCANÇÁVEL — um job concluiu com 95.199
 * bytes de spec revisada (Opus 5, ~19 min) e o trabalho foi jogado fora. O teto de espera de
 * 18 min ainda descartava jobs que levavam ~19 min: o teto matava o TRABALHO, não a ESPERA.
 *
 * DESENHO (pós-revisão adversarial — ver project/docs/plans/BANCADA-SPEC-CHAT-JOB-DURAVEL-2026-09-04.md):
 *  • O job nasce no Postgres na MESMA transação da mensagem do usuário (sem turno órfão).
 *  • `agents_job_id` é gravado logo após o dispatch → o resultado é RECOLETÁVEL depois de um
 *    restart da api (late collect). Janela real medida: o `_async_jobs` dos agents é um dict em
 *    memória com TTL de 45 min contados de `created_at` (server.py:485-494), e a limpeza é lazy
 *    (só no dispatch de um novo job) → `deadline_at` = created_at + 40 min para o job NUNCA
 *    prometer mais do que o agente guarda.
 *  • Quem coleta é o WORKER (server-side): o usuário que fechou o browser não perde mais o
 *    resultado nem o turno no histórico. O poll em processo (do request que disparou) continua
 *    existindo só para dar latência baixa a quem está olhando — os dois convergem no mesmo
 *    `finishJob`, que é claim-locked por `WHERE status IN ('pending','running')` + rowCount.
 *  • A resposta do assistente é gravada com `job_id` e índice único parcial (job_id, role) →
 *    coleta idempotente (antes a marca `_persisted` vivia em memória e duplicava).
 *  • Heartbeat: o poll em processo toca `updated_at` a cada tick. O worker só adota jobs sem
 *    heartbeat recente — ou seja, órfãos de restart/deploy.
 *
 * Tudo aqui é BEST-EFFORT em relação à rota: uma falha de banco degrada para o comportamento
 * antigo (job só em memória), nunca derruba o chat.
 */
import type { Pool } from "pg";

type Db = Pick<Pool, "query" | "connect">;

export type SpecChatJobKind = "chat" | "resolve_gaps" | "file";
/** Vocabulário ÚNICO memória↔banco. `interrupted` = reinício da api; `lost` = o agente já
 *  descartou o resultado (TTL 45 min). Ambos viram `error` no contrato da rota (com a causa). */
export type SpecChatJobStatus = "pending" | "running" | "done" | "error" | "interrupted" | "lost";

export interface SpecChatJob {
  id: string;
  projectId: string | null;
  tenantId: string | null;
  ownerUserId: string;
  agentsJobId: string | null;
  kind: SpecChatJobKind;
  filePath: string | null;
  baseSha: string | null;
  baseSpecSha: string | null;
  status: SpecChatJobStatus;
  specMarkdown: string | null;
  /** `true` = existe spec gravada no job SEM ter trazido os ~95 KB (usado pelo in-flight, que roda
   *  a cada mount da tela). Cobre a revisão RECUPERADA de um job reprovado pelo enforcer. */
  hasSpecMarkdown: boolean;
  reply: string | null;
  error: string | null;
  /** `true` = a resposta do CTO foi CORTADA no teto de saída do modelo (migração 091). O documento
   *  existe mas está INCOMPLETO — nada pode ser aplicado a partir dele sem revisão humana, e o
   *  modo autônomo recusa a rodada. Ver `_truncated` em `agents/runtime.py`. */
  truncated: boolean;
  createdAt: string;
  finishedAt: string | null;
  collectedAt: string | null;
  deadlineAt: string | null;
}

/** Colunas escalares: NUNCA `SELECT *` — `spec_markdown` chega a 95 KB e o in-flight é chamado
 *  a cada mount da tela só para desenhar um banner. */
const SCALAR_COLS =
  "id, project_id, tenant_id, owner_user_id, agents_job_id, kind, file_path, base_sha, base_spec_sha, " +
  "status, reply, error, truncated, created_at, finished_at, collected_at, deadline_at, " +
  "(spec_markdown IS NOT NULL) AS has_spec";

function rowToJob(r: Record<string, unknown>, specMarkdown: string | null = null): SpecChatJob {
  return {
    id: String(r.id),
    projectId: (r.project_id as string | null) ?? null,
    tenantId: (r.tenant_id as string | null) ?? null,
    ownerUserId: String(r.owner_user_id ?? ""),
    agentsJobId: (r.agents_job_id as string | null) ?? null,
    kind: (r.kind as SpecChatJobKind) ?? "chat",
    filePath: (r.file_path as string | null) ?? null,
    baseSha: (r.base_sha as string | null) ?? null,
    baseSpecSha: (r.base_spec_sha as string | null) ?? null,
    status: (r.status as SpecChatJobStatus) ?? "pending",
    specMarkdown: specMarkdown ?? ((r.spec_markdown as string | null) ?? null),
    hasSpecMarkdown: r.has_spec === true || (r.spec_markdown ?? null) !== null || specMarkdown !== null,
    reply: (r.reply as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    truncated: r.truncated === true,
    createdAt: String(r.created_at ?? new Date().toISOString()),
    finishedAt: (r.finished_at as string | null) ?? null,
    collectedAt: (r.collected_at as string | null) ?? null,
    deadlineAt: (r.deadline_at as string | null) ?? null,
  };
}

/** Teto do job de spec inteira: 40 min (< TTL de 45 min do `_async_jobs` dos agents). */
export const CHAT_JOB_DEADLINE_MS = 40 * 60_000;
/** Modo por-arquivo é síncrono (`/invoke/raw`, 180 s) — teto curto, só para não ficar `running` órfão. */
export const FILE_JOB_DEADLINE_MS = 6 * 60_000;
/** Sem heartbeat por este tempo, o worker adota o job (o processo que o disparou morreu). */
const HEARTBEAT_STALE_MS = 75_000;
/** Falhas consecutivas de poll a partir das quais o job é declarado perdido. */
const MAX_POLL_ERRORS = 5;

export interface CreateJobInput {
  id: string;
  projectId: string | null;
  tenantId: string | null;
  ownerUserId: string;
  kind: SpecChatJobKind;
  filePath: string | null;
  baseSha: string | null;
  baseSpecSha: string | null;
  /** Mensagem do usuário a gravar no histórico NA MESMA TRANSAÇÃO (sem turno órfão). */
  userMessage: string | null;
}

/**
 * Cria a linha do job e, se houver projeto + mensagem, o turno do usuário — atomicamente.
 * Antes a mensagem era gravada fire-and-forget ANTES do job existir: se o job falhasse, sobrava
 * uma pergunta órfã que a rehidratação exibiria como turno sem resposta.
 * Devolve `false` quando o banco recusou (a rota segue com o job só em memória).
 */
export async function createSpecChatJob(db: Db, input: CreateJobInput): Promise<boolean> {
  const deadlineMs = input.kind === "file" ? FILE_JOB_DEADLINE_MS : CHAT_JOB_DEADLINE_MS;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO spec_chat_jobs
         (id, project_id, tenant_id, owner_user_id, kind, file_path, base_sha, base_spec_sha, status, deadline_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', now() + ($9 || ' milliseconds')::interval)`,
      [input.id, input.projectId, input.tenantId, input.ownerUserId, input.kind,
        input.filePath, input.baseSha, input.baseSpecSha, String(deadlineMs)],
    );
    if (input.projectId && input.userMessage) {
      await client.query(
        `INSERT INTO spec_chat_messages (project_id, tenant_id, role, content, file_path, user_id, job_id)
           VALUES ($1, $2, 'user', $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [input.projectId, input.tenantId, input.userMessage, input.filePath,
          UUID_RE.test(input.ownerUserId) ? input.ownerUserId : null, input.id],
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* conexão já inválida */ }
    console.warn(`[SpecChatJobs] createSpecChatJob falhou (job segue só em memória): ${msg(e)}`);
    return false;
  } finally {
    client.release();
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Grava o id do job nos agents — é a CHAVE do late collect. Sem ele o job é irrecuperável. */
export async function setAgentsJobId(db: Db, id: string, agentsJobId: string): Promise<void> {
  try {
    await db.query(
      "UPDATE spec_chat_jobs SET agents_job_id = $2, status = 'running', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1",
      [id, agentsJobId],
    );
  } catch (e) {
    console.warn(`[SpecChatJobs] setAgentsJobId falhou: ${msg(e)}`);
  }
}

/** Heartbeat do poll em processo: sinaliza ao worker que alguém já está olhando este job. */
export async function touchSpecChatJob(db: Db, id: string): Promise<void> {
  try {
    await db.query("UPDATE spec_chat_jobs SET updated_at = now() WHERE id = $1 AND status IN ('pending','running')", [id]);
  } catch { /* heartbeat é best-effort */ }
}

export interface FinishPatch {
  status: Exclude<SpecChatJobStatus, "pending" | "running">;
  specMarkdown?: string | null;
  reply?: string | null;
  error?: string | null;
  modelUsed?: string | null;
  /** Migração 091: resposta cortada no teto de saída do modelo. `undefined` preserva o valor atual. */
  truncated?: boolean | null;
}

/**
 * Encerra o job. `WHERE status IN ('pending','running')` + rowCount = trava lógica de coleta
 * única: o poll em processo e o worker podem correr juntos, só um vence. Quando vence com
 * `done`, grava também o turno do assistente (idempotente pelo índice único (job_id, role)) —
 * é isto que faz o histórico voltar completo mesmo se ninguém estava com a tela aberta.
 * Devolve `true` se ESTA chamada foi a que encerrou.
 */
export async function finishSpecChatJob(db: Db, id: string, patch: FinishPatch): Promise<boolean> {
  try {
    const r = await db.query(
      `UPDATE spec_chat_jobs
          SET status = $2, spec_markdown = COALESCE($3, spec_markdown), reply = COALESCE($4, reply),
              error = COALESCE($5, error), model_used = COALESCE($6, model_used),
              truncated = COALESCE($7::boolean, truncated),
              finished_at = now(), updated_at = now()
        WHERE id = $1 AND status IN ('pending','running')`,
      [id, patch.status, patch.specMarkdown ?? null, patch.reply ?? null,
        patch.error ? patch.error.slice(0, 500) : null, patch.modelUsed ?? null,
        patch.truncated ?? null],
    );
    const won = (r.rowCount ?? 0) > 0;
    if (won && patch.status === "done" && patch.reply) {
      const job = (await db.query(
        "SELECT project_id, tenant_id, file_path FROM spec_chat_jobs WHERE id = $1", [id],
      )).rows[0] as { project_id?: string | null; tenant_id?: string | null; file_path?: string | null } | undefined;
      if (job?.project_id) {
        await db.query(
          `INSERT INTO spec_chat_messages (project_id, tenant_id, role, content, file_path, job_id)
             VALUES ($1, $2, 'assistant', $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [job.project_id, job.tenant_id ?? null, patch.reply, job.file_path ?? null, id],
        ).catch((e) => console.warn(`[SpecChatJobs] gravar resposta no histórico falhou: ${msg(e)}`));
      }
    }
    return won;
  } catch (e) {
    console.warn(`[SpecChatJobs] finishSpecChatJob falhou: ${msg(e)}`);
    return false;
  }
}

/** Job por id, COM o markdown (usado pelo poll/coleta explícita). */
export async function getSpecChatJob(db: Db, id: string): Promise<SpecChatJob | null> {
  try {
    const r = (await db.query(`SELECT ${SCALAR_COLS}, spec_markdown FROM spec_chat_jobs WHERE id = $1`, [id])).rows[0] as
      Record<string, unknown> | undefined;
    return r ? rowToJob(r) : null;
  } catch (e) {
    console.warn(`[SpecChatJobs] getSpecChatJob falhou: ${msg(e)}`);
    return null;
  }
}

/**
 * Job a rehidratar: o mais recente vivo, concluído-e-ainda-não-coletado OU **reprovado mas com
 * revisão recuperável** do escopo (projeto + arquivo + DONO). O binding de dono é o invariante S3
 * da RFC-0004 Onda 0 — o in-flight NÃO pode revogá-lo por omissão. `spec_markdown` fica fora de
 * propósito (só o booleano `has_spec`).
 *
 * O terceiro caso entrou em 2026-09-05: um envelope BLOCKED pelo enforcer ainda carrega a spec
 * inteira, e ela é gravada no job. Sem incluí-lo aqui, a revisão ficava no banco e a tela nunca
 * a oferecia. Só entram erros COM spec e ainda NÃO coletados — o GET /:jobId marca `collected_at`
 * ao entregar, então a oferta não vira banner eterno.
 */
export async function findInFlightSpecChatJob(
  db: Db,
  scope: { projectId: string; filePath: string | null; ownerUserId: string },
): Promise<SpecChatJob | null> {
  try {
    const r = (await db.query(
      `SELECT ${SCALAR_COLS} FROM spec_chat_jobs
        WHERE project_id = $1
          AND owner_user_id = $2
          AND ($3::text IS NULL AND file_path IS NULL OR file_path = $3)
          AND (
                status IN ('pending','running')
             OR (status = 'done' AND collected_at IS NULL)
             OR (status IN ('error','interrupted','lost') AND spec_markdown IS NOT NULL AND collected_at IS NULL)
          )
        ORDER BY created_at DESC
        LIMIT 1`,
      [scope.projectId, scope.ownerUserId, scope.filePath],
    )).rows[0] as Record<string, unknown> | undefined;
    return r ? rowToJob(r) : null;
  } catch (e) {
    console.warn(`[SpecChatJobs] findInFlightSpecChatJob falhou: ${msg(e)}`);
    return null;
  }
}

/** Marca o resultado como entregue ao cliente → o in-flight para de re-oferecê-lo para sempre. */
export async function markSpecChatJobCollected(db: Db, id: string): Promise<void> {
  try {
    await db.query("UPDATE spec_chat_jobs SET collected_at = now(), updated_at = now() WHERE id = $1 AND collected_at IS NULL", [id]);
  } catch (e) {
    console.warn(`[SpecChatJobs] markSpecChatJobCollected falhou: ${msg(e)}`);
  }
}

export interface HistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  jobId: string | null;
}

/**
 * Histórico do chat do escopo (projeto + arquivo). `spec_chat_messages` era WRITE-ONLY (zero
 * SELECT em todo o api-node) — por isso o chat nascia vazio ao voltar à tela.
 * NÃO filtra por usuário: a resposta do CTO era gravada sem `user_id`, então filtrar por dono
 * apagaria justamente todas as respostas. Autoria vai para a UI, não para o filtro.
 */
export async function loadSpecChatHistory(
  db: Db,
  scope: { projectId: string; filePath: string | null; limit?: number },
): Promise<HistoryMessage[]> {
  const limit = Math.min(Math.max(scope.limit ?? 40, 1), 200);
  try {
    const rows = (await db.query(
      `SELECT id, role, content, created_at, job_id FROM spec_chat_messages
        WHERE project_id = $1
          AND ($2::text IS NULL AND file_path IS NULL OR file_path = $2)
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [scope.projectId, scope.filePath, limit],
    )).rows as Array<Record<string, unknown>>;
    return rows
      .map((r) => ({
        id: String(r.id),
        role: (r.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
        content: String(r.content ?? ""),
        createdAt: String(r.created_at ?? ""),
        jobId: (r.job_id as string | null) ?? null,
      }))
      .reverse();
  } catch (e) {
    console.warn(`[SpecChatJobs] loadSpecChatHistory falhou: ${msg(e)}`);
    return [];
  }
}

/**
 * Reaper de BOOT — por `kind`, e é aqui que o v1 do desenho estava errado.
 * `kind='file'` usa `/invoke/raw` SÍNCRONO: a conexão HTTP morre com o processo, o trabalho
 * realmente acabou → `interrupted` é honesto (mesmo caso de `reapOrphanPlanJobs`).
 * `kind='chat'|'resolve_gaps'` usa `/invoke/cto/async`: o job SEGUE VIVO nos agents. Marcá-lo
 * `interrupted` no boot seria MENTIR e destruir exatamente o resultado que este trabalho existe
 * para salvar (é o bug que `reapOrphanValidationRuns` tem hoje). Esses ficam `running` e o
 * WORKER decide por probe. Só os que nem chegaram a ter `agents_job_id` (a api caiu entre o
 * dispatch e o UPDATE) são declarados `lost` — irrecuperáveis por construção, com causa honesta.
 */
export async function reapOrphanSpecChatJobs(db: Db): Promise<{ interrupted: number; lost: number }> {
  let interrupted = 0;
  let lost = 0;
  try {
    const r1 = await db.query(
      `UPDATE spec_chat_jobs SET status = 'interrupted', error = $1, finished_at = now(), updated_at = now()
        WHERE kind = 'file' AND status IN ('pending','running')`,
      ["Revisão interrompida por reinício do servidor — peça a revisão de novo."],
    );
    interrupted = r1.rowCount ?? 0;
    const r2 = await db.query(
      `UPDATE spec_chat_jobs SET status = 'lost', error = $1, finished_at = now(), updated_at = now()
        WHERE kind IN ('chat','resolve_gaps') AND status IN ('pending','running') AND agents_job_id IS NULL`,
      ["A chamada ao CTO foi perdida no reinício do servidor antes de ser rastreável — peça de novo."],
    );
    lost = r2.rowCount ?? 0;
    if (interrupted || lost) {
      console.info(`[SpecChatJobs] reaper de boot: ${interrupted} por-arquivo interrompido(s), ${lost} perdido(s) sem agents_job_id.`);
    }
  } catch (e) {
    console.warn(`[SpecChatJobs] reapOrphanSpecChatJobs falhou: ${msg(e)}`);
  }
  return { interrupted, lost };
}

/** Resultado de um probe ao agents (injetado para permitir teste sem rede). */
export interface AgentProbe {
  (agentsJobId: string): Promise<{ status: string; result?: Record<string, unknown>; error?: string } | "not_found">;
}

/**
 * Um tick do coletor server-side. Adota jobs async vivos SEM heartbeat recente (o processo que
 * os disparou morreu, ou o usuário fechou o browser e o poll do request já terminou), faz o
 * probe e fecha com o MESMO gate de qualidade do poll em processo.
 */
export async function collectSpecChatJobsTick(
  db: Db,
  probe: AgentProbe,
  extract: (result: Record<string, unknown>) => string,
): Promise<{ scanned: number; collected: number; lost: number; expired: number }> {
  const out = { scanned: 0, collected: 0, lost: 0, expired: 0 };
  let rows: Array<Record<string, unknown>>;
  try {
    rows = (await db.query(
      `SELECT id, agents_job_id, poll_errors, deadline_at, project_id, kind FROM spec_chat_jobs
        WHERE status IN ('pending','running')
          AND kind IN ('chat','resolve_gaps')
          AND agents_job_id IS NOT NULL
          AND updated_at < now() - ($1 || ' milliseconds')::interval
        ORDER BY created_at
        LIMIT 20`,
      [String(HEARTBEAT_STALE_MS)],
    )).rows as Array<Record<string, unknown>>;
  } catch (e) {
    console.warn(`[SpecChatJobs] worker: varredura falhou: ${msg(e)}`);
    return out;
  }
  out.scanned = rows.length;

  for (const row of rows) {
    const id = String(row.id);
    const agentsJobId = String(row.agents_job_id);
    const deadlineAt = row.deadline_at ? new Date(String(row.deadline_at)).getTime() : 0;
    // Teto: expira a ESPERA quando o agente já não guarda mais nada (TTL 45 min do _async_jobs).
    if (deadlineAt && Date.now() > deadlineAt) {
      const closed = await finishSpecChatJob(db, id, {
        status: "error",
        error: "O CTO passou do tempo máximo (40 min) e o resultado não estava mais disponível no agente. Peça de novo.",
      });
      if (closed) out.expired += 1;
      continue;
    }
    let probed: Awaited<ReturnType<AgentProbe>>;
    try {
      probed = await probe(agentsJobId);
    } catch (e) {
      const errs = Number(row.poll_errors ?? 0) + 1;
      await db.query("UPDATE spec_chat_jobs SET poll_errors = $2, updated_at = now() WHERE id = $1", [id, errs])
        .catch(() => { /* best-effort */ });
      if (errs >= MAX_POLL_ERRORS) {
        const closed = await finishSpecChatJob(db, id, {
          status: "lost",
          error: `Não foi possível consultar o CTO ${errs} vezes seguidas (${msg(e).slice(0, 120)}). Peça a revisão de novo.`,
        });
        if (closed) out.lost += 1;
      }
      continue;
    }
    if (probed === "not_found") {
      // 404 dos agents = o TTL de 45 min varreu o resultado. Estado terminal com causa REAL —
      // sem isto o job ficava `running` para sempre e o in-flight reofertava rehidratação em loop.
      const closed = await finishSpecChatJob(db, id, {
        status: "lost",
        error: "O agente já descartou o resultado desta revisão (expirou). Peça a revisão de novo — ela agora é coletada automaticamente pelo servidor.",
      });
      if (closed) out.lost += 1;
      continue;
    }
    await db.query("UPDATE spec_chat_jobs SET poll_errors = 0, updated_at = now() WHERE id = $1", [id])
      .catch(() => { /* best-effort */ });
    if (probed.status === "done" && probed.result) {
      const verdict = judgeCtoResult(probed.result, extract);
      // G5: o débito acontece ANTES do claim de coleta e é idempotente por `task_id` — a chamada
      // ao Opus 5 foi paga mesmo que o outro coletor vença a corrida do `finishSpecChatJob`.
      await recordCtoUsage(db, {
        id, projectId: (row.project_id as string | null) ?? null,
        kind: (row.kind as SpecChatJobKind) ?? "chat",
      }, probed.result);
      const closed = await finishSpecChatJob(db, id, verdict);
      if (closed) {
        out.collected += 1;
        console.info(`[SpecChatJobs] worker coletou job=${id} agents=${agentsJobId} status=${verdict.status} chars=${verdict.specMarkdown?.length ?? 0}${verdict.truncated ? " TRUNCADO" : ""}`);
      }
    } else if (probed.status === "error") {
      const closed = await finishSpecChatJob(db, id, { status: "error", error: probed.error ?? "CTO job failed" });
      if (closed) out.lost += 1;
    }
  }
  return out;
}

/** Cauda que o enforcer anexa ao `summary` quando reprova (`agents/runtime.py`: `"; Enforcer: …"`). */
const ENFORCER_TAIL_RE = /;\s*Enforcer:\s*([\s\S]+)$/;
/**
 * Abaixo deste tamanho o artefato não é uma spec: é eco do resumo, esqueleto ou fragmento. Ofertar
 * isso como "revisão recuperada" convidaria o usuário a sobrescrever a spec real com menos conteúdo
 * (a guarda de encolhimento do modo autônomo existe pelo mesmo motivo).
 */
const SALVAGE_MIN_CHARS = 1_500;
/** Teto do trecho de motivo embutido na mensagem (o campo `error` inteiro é cortado em 500). */
const REASON_MAX_CHARS = 240;
/**
 * Aviso ÚNICO de truncamento (um só texto para chat, card de recuperação e log — o usuário não
 * pode receber duas explicações diferentes do mesmo defeito).
 */
export const TRUNCATED_WARNING =
  "⚠️ ATENÇÃO: esta resposta foi CORTADA no limite de saída do modelo — a spec está INCOMPLETA " +
  "(o fim do documento não foi gerado). NÃO aplique: o conteúdo que falta seria apagado da spec atual. " +
  "Peça a revisão por arquivo (spec dividida) ou trate os GAPs em blocos menores.";

/**
 * Motivo REAL da reprovação, na ordem em que o runtime o registra:
 *   1. `validation_errors[]` — lista estruturada do enforcer (`runtime.py`, envelope reprovado);
 *   2. cauda `"; Enforcer: …"` do `summary` — mesma informação, quando a lista não veio;
 *   3. `error`/`reason` de topo — falha de transporte/provedor.
 * Antes tudo isto era descartado e o usuário recebia "Reformule o pedido", que é conselho ERRADO
 * quando a causa é corte de saída, campo de metadados vazio ou disjuntor aberto — nada do pedido dele.
 */
export function ctoFailureReason(result: Record<string, unknown>): string | null {
  const errs = Array.isArray(result.validation_errors)
    ? (result.validation_errors as unknown[]).filter((e): e is string => typeof e === "string" && e.trim().length > 0)
    : [];
  if (errs.length) return clip(errs.slice(0, 3).join("; "));
  const summary = typeof result.summary === "string" ? result.summary : "";
  const tail = ENFORCER_TAIL_RE.exec(summary);
  if (tail) return clip(tail[1]);
  for (const key of ["error", "reason", "blocked_reason"]) {
    const v = result[key];
    if (typeof v === "string" && v.trim()) return clip(v);
  }
  return null;
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > REASON_MAX_CHARS ? `${t.slice(0, REASON_MAX_CHARS)}…` : t;
}

/**
 * Conteúdo do artefato de spec — SEM o fallback para `summary` que `extractSpecMarkdown` faz.
 * No BLOCKED por enforcer o envelope CONTINUA carregando `artifacts[0].content` = a spec inteira
 * (o enforcer reprova metadados, não o documento). Aqui distinguimos "existe documento" de
 * "existe resumo", porque só o primeiro pode ser oferecido ao usuário.
 */
export function salvageableSpec(result: Record<string, unknown>): string | null {
  const artifacts = Array.isArray(result.artifacts) ? (result.artifacts as Array<Record<string, unknown>>) : [];
  for (const a of artifacts) {
    const path = typeof a?.path === "string" ? a.path : "";
    const content = typeof a?.content === "string" ? a.content : "";
    if (!content || content.trim().length < SALVAGE_MIN_CHARS) continue;
    if (path.endsWith(".md") || path.includes("PRODUCT_SPEC") || path.includes("spec")) return content;
  }
  return null;
}

/**
 * Gate de qualidade H4 (usado pelo poll em processo de `specChat.ts` E por este worker — uma única
 * implementação, para os dois caminhos não divergirem): os agents devolvem `status:"done"` mesmo
 * quando o envelope do CTO é BLOCKED/FAIL. Sem este gate, gravaríamos uma spec vazia/parcial que o
 * usuário poderia APLICAR por cima da spec real.
 *
 * Duas correções de 2026-09-05:
 *  • a mensagem passa a dizer o MOTIVO real (`ctoFailureReason`) em vez de "Reformule o pedido";
 *  • quando o envelope reprovado ainda carrega a spec inteira, ela é PRESERVADA no job para ser
 *    OFERECIDA ao usuário (`status` continua `error` → nada é aplicado sozinho, nem pelo modo
 *    autônomo, que só aplica em `done`). Antes era jogada no lixo depois de ~20 min de Opus 5.
 */
/**
 * Modelo REAL da chamada. `model_used` é o campo do `/invoke/raw`; o caminho `cto/async`
 * (`run_agent`) emite `_model` no envelope — por isso `spec_chat_jobs.model_used` ficava NULL em
 * toda revisão da Bancada (GAP G9, medido em prod 2026-09-05).
 */
function modelOf(result: Record<string, unknown>): string | null {
  const a = result.model_used;
  if (typeof a === "string" && a.trim()) return a.trim();
  const b = result._model;
  if (typeof b === "string" && b.trim()) return b.trim();
  return null;
}

/** `_truncated` do envelope (`agents/runtime.py`): a resposta bateu no teto de saída do modelo. */
export function isTruncatedResult(result: Record<string, unknown>): boolean {
  return result._truncated === true;
}

export function judgeCtoResult(
  result: Record<string, unknown>,
  extract: (result: Record<string, unknown>) => string,
): FinishPatch {
  const agentStatus = String((result as { status?: string }).status ?? "").toUpperCase();
  const md = extract(result);
  const rejected = agentStatus === "BLOCKED" || agentStatus === "FAIL";
  const truncated = isTruncatedResult(result);
  if (rejected || !md || md.trim().length < 20) {
    const reason = ctoFailureReason(result);
    const head = rejected
      ? `O CTO não conseguiu revisar (${agentStatus})`
      : "O CTO não retornou uma spec revisada válida";
    const salvaged = rejected ? salvageableSpec(result) : null;
    const parts = [reason ? `${head}: ${reason}` : `${head}. Reformule o pedido e tente de novo.`];
    if (salvaged) {
      parts.push(`A revisão que ele produziu (${salvaged.length} caracteres) foi recuperada — confira antes de aplicar.`);
    }
    if (truncated) parts.push(TRUNCATED_WARNING);
    return {
      status: "error",
      error: parts.join(" "),
      // COALESCE no UPDATE: `null` preserva o que já houver; string grava a spec recuperada.
      specMarkdown: salvaged,
      modelUsed: modelOf(result),
      truncated,
    };
  }
  // 🔴 2026-09-05: `done` COM `truncated` é o caso que gerou o incidente — o envelope vem
  // `status: OK` e o `summary` afirma ter resolvido tudo, mas o documento acaba no meio de uma
  // frase. Mantemos `done` (o parcial tem valor e o humano pode querer olhar), porém MARCADO: a
  // UI avisa e o modo autônomo se recusa a aplicar. O que não se pode é entregar isso em silêncio.
  const baseReply = (result.summary as string | undefined)?.trim() || "Spec atualizada conforme solicitado.";
  return {
    status: "done",
    specMarkdown: md,
    reply: truncated ? `${baseReply}\n\n${TRUNCATED_WARNING}` : baseReply,
    modelUsed: modelOf(result),
    truncated,
  };
}

/** Label do CTO da Bancada em `project_agent_metrics` (convenção snake das chamadas diretas:
 *  `spec_validator`, `splitter`). Distinto do `CTO` da FÁBRICA, que o `runner.py` reporta. */
export const WORKBENCH_CTO_AGENT = "spec_cto";

function intOf(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * 🔴 G5 (medido em prod 2026-09-05) — o medidor de custo NÃO via o agente mais caro do sistema.
 *
 * `_report_direct_usage` (runtime.py) só roda dentro de `call_bedrock_direct`; o `run_agent` — que é
 * o caminho do CTO da Bancada via `/invoke/cto/async` — captura os tokens APENAS PARA O LOG e nunca
 * reporta. Medição de 30 h no projeto do LastMile: `spec_validator`+`triage` deixaram 42 linhas
 * (≈ $13,14) e as 9 chamadas do CTO deixaram ZERO (908.160 in / 523.744 out ≈ $17,63 invisível) →
 * o cost cap mensal por tenant (`tenantCostCap.ts`) e o gate de orçamento do dispatch enxergavam
 * ~43% do gasto real, cegos justamente ao maior consumidor unitário (modo autônomo = 5 rodadas de
 * Opus 5 no teto de saída). Denial-of-wallet pela própria feature.
 *
 * Por que reportar AQUI e não no `run_agent`: a FÁBRICA já reporta o mesmo envelope pelo
 * `runner.py` (`_record_agent_metrics`) — reportar dentro do `run_agent` contaria cada chamada da
 * fábrica DUAS vezes. O furo é exclusivo do caminho api→agents da Bancada, então o débito é feito
 * no ponto de coleta do job.
 *
 * Idempotência (os dois coletores podem correr juntos, e o worker pode reprocessar):
 * `task_id = 'spec_chat:<jobId>'` + `NOT EXISTS` — mesmo padrão do `splitter` em
 * `routes/products.ts`. `jobId` é único por revisão, logo não colide com nenhuma task da fábrica.
 * Usa os TOTAIS do envelope (`_input_tokens_total`) quando presentes: os repairs da LEI 5 são pagos.
 * Nunca lança — cobrança é observabilidade, não pode derrubar a entrega da revisão.
 */
export async function recordCtoUsage(
  db: Db,
  job: { id: string; projectId: string | null; kind: SpecChatJobKind },
  result: Record<string, unknown>,
): Promise<boolean> {
  // Sem projeto real não há onde debitar (preview de spec sem projeto). `file` usa `/invoke/raw` →
  // `call_bedrock_direct`, que JÁ reporta pelo `_report_direct_usage`: reportar aqui duplicaria.
  if (!job.projectId || job.kind === "file") return false;
  const input = intOf(result._input_tokens_total) || intOf(result._input_tokens);
  const output = intOf(result._output_tokens_total) || intOf(result._output_tokens);
  if (!input && !output) return false;
  try {
    const r = await db.query(
      `INSERT INTO project_agent_metrics
         (project_id, agent, task_id, round, input_tokens, output_tokens, model, duration_ms, status)
         SELECT $1, $2, $3, 1, $4, $5, $6, $7, $8
          WHERE NOT EXISTS (
            SELECT 1 FROM project_agent_metrics WHERE project_id = $1 AND agent = $2 AND task_id = $3
          )`,
      [job.projectId, WORKBENCH_CTO_AGENT, `spec_chat:${job.id}`, input, output,
        modelOf(result), intOf(result._duration_ms) || null,
        String((result as { status?: string }).status ?? "OK").toUpperCase().slice(0, 32)],
    );
    const inserted = (r.rowCount ?? 0) > 0;
    if (inserted) {
      console.info(`[SpecChatJobs] usage do CTO debitado: job=${job.id} projeto=${job.projectId.slice(0, 8)} in=${input} out=${output} calls=${intOf(result._llm_calls) || 1}`);
    }
    return inserted;
  } catch (e) {
    console.warn(`[SpecChatJobs] recordCtoUsage falhou (best-effort): ${msg(e)}`);
    return false;
  }
}
