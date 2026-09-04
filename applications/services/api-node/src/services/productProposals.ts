/**
 * productProposals.ts — RFC-0004 T1.6b: o job do Splitter (doc→N projetos) NASCE persistido.
 *
 * Antes, /api/products/propose e /api/projects/:id/decompose guardavam o job num Map em
 * memória (products.ts _proposeJobs) que morria em TODO deploy/restart — a proposta sumia no
 * meio do poll do portal. Aqui o job vive na tabela `product_proposals` (migration 076):
 *   • runProposeJob roda o Product Architect (agents async + poll) e escreve o resultado na
 *     linha, com transições SEMPRE guardadas por status (WHERE ... AND status='running') —
 *     um reaper/deadline concorrente nunca é sobrescrito por um poll atrasado (TOCTOU).
 *   • reapOrphanProposals (boot) marca 'pending'/'running' órfão como 'interrupted'.
 *   • expireOverdueProposals (watchdog) aplica deadline_at + purga payload antigo (>7d).
 *   • revertTerminatedOrigins devolve à Bancada a spec presa em pending_conversion cuja
 *     proposta acabou de terminar sem consumo (escopada à origem afetada — nunca varre
 *     pending_conversion de outro fluxo).
 *
 * Assunção (documentada): 1 instância da API. O reaper de boot mata TODA proposta em voo
 * sem guarda de idade — se houvesse N instâncias, mataria jobs vivos de outra instância.
 */

import type { Pool } from "pg";
import { httpPost, httpGet } from "../routes/specs.js";
import {
  parseManifest,
  buildProductSketch,
  ManifestError,
  type ProductManifest,
} from "./productManifest.js";
import { productManifestWarnings } from "./connectSchema.js";

// Deadline de restart-survival: o timer em processo cobre o caso normal (11 min); este é o
// backstop no DB para quando o processo morre (o watchdog expira a linha).
// R4 PR3: o splitter passou a 2 passos (manifesto + 1 chamada por projeto em paralelo) — produtos de
// 8+ projetos chegavam ao teto de 11 min. Alinhado ao Resolver GAPs (18 min) + folga no backstop.
export const PROPOSAL_DEADLINE_MIN = 22;

// Onda 4 (PR-2): o Product Architect passa a reportar o consumo de tokens agregado da
// decomposição (soma de todas as chamadas ao LLM, inclusive as paralelas do PASSO 2).
type ProposalUsage = { input_tokens?: number; output_tokens?: number; model?: string; calls?: number };
type AgentsResult = { manifest?: ProductManifest; specs?: Record<string, string>; warnings?: string[]; usage?: ProposalUsage };

/** Coleta origin_project_id não-nulos de um resultado de UPDATE ... RETURNING. */
function originsOf(rows: unknown[]): string[] {
  return (rows ?? [])
    .map((r) => (r as { origin_project_id?: string | null }).origin_project_id)
    .filter((id): id is string => !!id);
}

async function failProposal(pool: Pool, jobId: string, error: string): Promise<void> {
  const r = await pool
    .query(
      "UPDATE product_proposals SET status='error', error=$2, deadline_at=NULL, updated_at=now() WHERE id=$1 AND status IN ('pending','running') RETURNING origin_project_id",
      [jobId, String(error).slice(0, 500)],
    )
    .catch((e) => { console.error(`[Propose] failProposal ${jobId}:`, e); return null; });
  // MEDIUM-2: a origem presa em pending_conversion precisa voltar à Bancada AGORA — sem isto
  // uma proposta que erra em voo (agents fora) deixava a spec presa até o próximo boot.
  if (r) await revertTerminatedOrigins(pool, originsOf(r.rows));
}

async function interruptProposal(pool: Pool, jobId: string, error: string): Promise<void> {
  const r = await pool
    .query(
      "UPDATE product_proposals SET status='interrupted', error=$2, deadline_at=NULL, updated_at=now() WHERE id=$1 AND status IN ('pending','running') RETURNING origin_project_id",
      [jobId, String(error).slice(0, 500)],
    )
    .catch((e) => { console.error(`[Propose] interruptProposal ${jobId}:`, e); return null; });
  if (r) await revertTerminatedOrigins(pool, originsOf(r.rows));
}

/**
 * Onda 4 (PR-3): cancelamento EXPLÍCITO de uma proposta em voo pelo usuário. Marca a linha
 * como 'interrupted' (o contrato do poll já mapeia isso para error+interrupted:true no portal),
 * registra QUEM cancelou em `cancelled_by` e devolve a origem à Bancada. A transição é guardada
 * por status (só 'pending'/'running') → cancelar uma proposta já terminal é no-op idempotente
 * (rowCount 0). NÃO aborta o job no serviço agents (fora do nosso controle); o poll em voo vê a
 * linha já terminal e para de escrever (todas as transições dele são guardadas por status).
 */
export async function cancelProposal(pool: Pool, jobId: string, cancelledBy: string | null): Promise<number> {
  const by = cancelledBy && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cancelledBy)
    ? cancelledBy : null;
  const r = await pool.query(
    "UPDATE product_proposals SET status='interrupted', error='Cancelado pelo usuário', cancelled_by=$2, deadline_at=NULL, updated_at=now() WHERE id=$1 AND status IN ('pending','running') RETURNING origin_project_id",
    [jobId, by],
  );
  if (r.rowCount) await revertTerminatedOrigins(pool, originsOf(r.rows));
  return r.rowCount ?? 0;
}

async function finishProposal(pool: Pool, jobId: string, result: AgentsResult): Promise<void> {
  try {
    const manifest = result.manifest!;
    const specs = result.specs!;
    // Valida o grafo no lado TS e computa as ondas (double-check dos MESMOS gates do splitter).
    const parsed = parseManifest(JSON.stringify(manifest));
    const sketch = buildProductSketch(parsed, Object.keys(specs));
    // R4 PR5: validação contra o schema Connect VENDORIZADO (modo warning — vira aviso visível no
    // DecomposeDialog, nunca falha a proposta nesta release).
    const schemaWarnings = productManifestWarnings(manifest);
    const projects = sketch.projects.map((p) => ({
      id: p.id, type: p.type, wave: p.wave, dependsOn: p.dependsOn,
      // R4 PR3: racional/arquivos visíveis ao humano no DecomposeDialog antes de aprovar.
      rationale: p.rationale ?? null,
      files: (p.files ?? []).map((f) => f.path),
      connectDeclaration: p.connectDeclaration ?? null,
    }));
    const payload = { manifest, specs, waves: sketch.waves, projects };
    const payloadJson = JSON.stringify(payload);
    // Teto de 2MB: uma proposta gigante não deve estourar a linha (nem a memória no poll).
    if (Buffer.byteLength(payloadJson, "utf8") > 2 * 1024 * 1024) {
      await failProposal(pool, jobId, "Proposta grande demais (>2MB) para persistir. Reduza a spec.");
      return;
    }
    const warningsJson = JSON.stringify([...(result.warnings ?? []), ...schemaWarnings]);
    // Onda 4 (PR-2): telemetria de custo — grava tokens/modelo agregados da decomposição.
    // Sanitiza para inteiros >= 0 (o serviço agents é confiável, mas defende contra NaN/negativo).
    const u = result.usage ?? {};
    const inTok = Math.max(0, Math.trunc(Number(u.input_tokens ?? 0)) || 0);
    const outTok = Math.max(0, Math.trunc(Number(u.output_tokens ?? 0)) || 0);
    const modelUsed = typeof u.model === "string" && u.model.trim() ? u.model.trim().slice(0, 200) : null;
    // Onda 4 (PR-1): PRESERVA os avisos gravados na criação (ex.: decompose marcou .doc/PDF
    // sem texto como ignorados) — concatena com os do resultado em vez de sobrescrever.
    const r = await pool.query(
      "UPDATE product_proposals SET status='done', payload=$2::jsonb, warnings=COALESCE(warnings, '[]'::jsonb) || $3::jsonb, error=NULL, deadline_at=NULL, input_tokens=$4, output_tokens=$5, model_used=COALESCE($6, model_used), updated_at=now() WHERE id=$1 AND status='running'",
      [jobId, payloadJson, warningsJson, inTok, outTok, modelUsed],
    );
    if (r.rowCount) console.log(`[Propose] ✓ job=${jobId} DONE — ${projects.length} projetos, ${sketch.waves.length} ondas`);
  } catch (e) {
    const msg = e instanceof ManifestError ? `[${e.code}] ${e.message}` : e instanceof Error ? e.message : String(e);
    await failProposal(pool, jobId, msg);
  }
}

/**
 * Roda a proposta em background: chama o Product Architect (agents, job async + poll) e grava
 * o resultado na linha `product_proposals`. Não segura a conexão HTTP do cliente (poll-based).
 */
export function runProposeJob(
  pool: Pool,
  jobId: string,
  document: string,
  modelId: string | undefined,
  agentsUrl: string,
  originProjectId?: string | null,
): void {
  const base = agentsUrl.replace(/\/$/, "");
  const startedAt = Date.now();
  const MAX_MS = 1_080_000; // 18 min (R4 PR3: split em 2 passos; deadline_at cobre o restart)

  // pending -> running (guardado: só transiciona se ainda estiver pending)
  void pool
    .query("UPDATE product_proposals SET status='running', updated_at=now() WHERE id=$1 AND status='pending'", [jobId])
    .catch((e) => console.error(`[Propose] set running ${jobId}:`, e));

  const reqBody = JSON.stringify({
    document,
    ...(modelId ? { model_id: modelId } : {}),
    ...(originProjectId ? { originProjectId } : {}),
  });

  httpPost(`${base}/invoke/product_architect/async`, reqBody, 30_000)
    .then(async (startText) => {
      const agentsJobId = (JSON.parse(startText) as { jobId?: string }).jobId;
      if (!agentsJobId) throw new Error("agents /invoke/product_architect/async não retornou jobId");
      await pool
        .query("UPDATE product_proposals SET agents_job_id=$2, updated_at=now() WHERE id=$1 AND status='running'", [jobId, agentsJobId])
        .catch(() => {});
      console.log(`[Propose] job=${jobId} agents_job=${agentsJobId} started`);

      const timer = setInterval(() => {
        void (async () => {
          if (Date.now() - startedAt > MAX_MS) {
            clearInterval(timer);
            await failProposal(pool, jobId, "Timeout: Product Architect demorou mais de 11 minutos.");
            return;
          }
          let pollText: string;
          try {
            pollText = await httpGet(`${base}/invoke/product_architect/status/${agentsJobId}`, 60_000);
          } catch (pollErr) {
            const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
            // agents 404 = job sumiu no lado agents (restart do agents) -> interrompe já
            // (não adianta seguir fazendo poll de um job que não existe mais).
            if (/\b404\b/.test(msg)) {
              clearInterval(timer);
              await interruptProposal(pool, jobId, "Serviço de agentes perdeu o job (reinício). Tente novamente.");
            } else {
              console.warn(`[Propose] poll error job=${jobId}: ${msg}`);
            }
            return;
          }
          const poll = JSON.parse(pollText) as { status: string; result?: AgentsResult; error?: string };
          if (poll.status === "done" && poll.result?.manifest && poll.result?.specs) {
            clearInterval(timer);
            await finishProposal(pool, jobId, poll.result);
          } else if (poll.status === "error") {
            clearInterval(timer);
            await failProposal(pool, jobId, poll.error ?? "Product Architect falhou");
          }
        })();
      }, 8_000);
    })
    .catch(async (err) => {
      await failProposal(pool, jobId, err instanceof Error ? err.message.slice(0, 300) : String(err));
    });
}

/**
 * Boot reaper (chamado no index.ts junto de reapOrphanValidationRuns): toda proposta em voo
 * ('pending'/'running') no boot é órfã — o processo que a rodava morreu.
 */
export async function reapOrphanProposals(pool: Pool): Promise<number> {
  const r = await pool.query(
    "UPDATE product_proposals SET status='interrupted', error=COALESCE(error,'Interrompido por reinício da API'), deadline_at=NULL, updated_at=now() WHERE status IN ('pending','running') RETURNING origin_project_id",
  );
  if (r.rowCount) console.log(`[Propose][reaper] ${r.rowCount} proposta(s) órfã(s) marcada(s) interrupted`);
  await revertTerminatedOrigins(pool, originsOf(r.rows));
  return r.rowCount ?? 0;
}

/**
 * Tick do watchdog: expira propostas cujo deadline_at passou (backstop de restart) e purga
 * payload de propostas antigas (>7d) — libera JSONB grande de propostas nunca consumidas.
 */
export async function expireOverdueProposals(pool: Pool): Promise<number> {
  const overdue = await pool.query(
    "UPDATE product_proposals SET status='interrupted', error=COALESCE(error,'Deadline excedido'), deadline_at=NULL, updated_at=now() WHERE status IN ('pending','running') AND deadline_at IS NOT NULL AND deadline_at < now() RETURNING origin_project_id",
  );
  await pool
    .query("UPDATE product_proposals SET payload=NULL, updated_at=now() WHERE payload IS NOT NULL AND created_at < now() - interval '7 days'")
    .catch((e) => console.error("[Propose] purge payload:", e));
  await revertTerminatedOrigins(pool, originsOf(overdue.rows));
  return overdue.rowCount ?? 0;
}

/**
 * Devolve à Bancada (spec_submitted) as origens ESPECÍFICAS cuja proposta acabou de terminar
 * sem consumo nesta operação (fail/interrupt/reap/deadline). Escopada por `originIds` de
 * propósito: uma varredura cega por `EXISTS (qualquer proposta)` (versão anterior) rebaixava
 * indevidamente specs em pending_conversion do fluxo CLÁSSICO (projectCreation.ts:247 — anexos
 * não-.md aguardando conversão) sempre que a spec tivesse tido, em algum momento passado, uma
 * proposta terminal não-consumida. Aqui só tocamos origens cuja proposta transicionou AGORA.
 *
 * Guardas mantidas: só reverte se a origem AINDA está pending_conversion e NÃO há proposta viva
 * nem consumida para ela (uma origem cujo produto nasceu tem consumed_at e fica protegida).
 */
export async function revertTerminatedOrigins(pool: Pool, originIds: string[]): Promise<void> {
  const ids = [...new Set(originIds)].filter(Boolean);
  if (ids.length === 0) return;
  await pool
    .query(
      `UPDATE projects p SET status='spec_submitted', updated_at=now()
         WHERE p.id = ANY($1::uuid[])
           AND p.status='pending_conversion'
           AND NOT EXISTS (
             SELECT 1 FROM product_proposals pp2
               WHERE pp2.origin_project_id = p.id
                 AND (pp2.status IN ('pending','running') OR pp2.consumed_at IS NOT NULL)
           )`,
      [ids],
    )
    .catch((e) => console.error("[Propose] revertTerminatedOrigins:", e));
}
