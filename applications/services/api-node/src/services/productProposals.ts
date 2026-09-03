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
 *   • revertOrphanOrigins devolve à Bancada a spec presa em pending_conversion cuja única
 *     proposta terminou sem consumo (senão a spec ficava fora da lista para sempre).
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

// Deadline de restart-survival: o timer em processo cobre o caso normal (11 min); este é o
// backstop no DB para quando o processo morre (o watchdog expira a linha).
export const PROPOSAL_DEADLINE_MIN = 15;

type AgentsResult = { manifest?: ProductManifest; specs?: Record<string, string>; warnings?: string[] };

async function failProposal(pool: Pool, jobId: string, error: string): Promise<void> {
  await pool
    .query(
      "UPDATE product_proposals SET status='error', error=$2, deadline_at=NULL, updated_at=now() WHERE id=$1 AND status IN ('pending','running')",
      [jobId, String(error).slice(0, 500)],
    )
    .catch((e) => console.error(`[Propose] failProposal ${jobId}:`, e));
}

async function interruptProposal(pool: Pool, jobId: string, error: string): Promise<void> {
  await pool
    .query(
      "UPDATE product_proposals SET status='interrupted', error=$2, deadline_at=NULL, updated_at=now() WHERE id=$1 AND status IN ('pending','running')",
      [jobId, String(error).slice(0, 500)],
    )
    .catch((e) => console.error(`[Propose] interruptProposal ${jobId}:`, e));
}

async function finishProposal(pool: Pool, jobId: string, result: AgentsResult): Promise<void> {
  try {
    const manifest = result.manifest!;
    const specs = result.specs!;
    // Valida o grafo no lado TS e computa as ondas (double-check dos MESMOS gates do splitter).
    const parsed = parseManifest(JSON.stringify(manifest));
    const sketch = buildProductSketch(parsed, Object.keys(specs));
    const projects = sketch.projects.map((p) => ({ id: p.id, type: p.type, wave: p.wave, dependsOn: p.dependsOn }));
    const payload = { manifest, specs, waves: sketch.waves, projects };
    const payloadJson = JSON.stringify(payload);
    // Teto de 2MB: uma proposta gigante não deve estourar a linha (nem a memória no poll).
    if (Buffer.byteLength(payloadJson, "utf8") > 2 * 1024 * 1024) {
      await failProposal(pool, jobId, "Proposta grande demais (>2MB) para persistir. Reduza a spec.");
      return;
    }
    const warningsJson = JSON.stringify(result.warnings ?? []);
    const r = await pool.query(
      "UPDATE product_proposals SET status='done', payload=$2::jsonb, warnings=$3::jsonb, error=NULL, deadline_at=NULL, updated_at=now() WHERE id=$1 AND status='running'",
      [jobId, payloadJson, warningsJson],
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
  const MAX_MS = 660_000; // 11 min (teto duro em processo; deadline_at cobre o restart)

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
    "UPDATE product_proposals SET status='interrupted', error=COALESCE(error,'Interrompido por reinício da API'), deadline_at=NULL, updated_at=now() WHERE status IN ('pending','running')",
  );
  if (r.rowCount) console.log(`[Propose][reaper] ${r.rowCount} proposta(s) órfã(s) marcada(s) interrupted`);
  await revertOrphanOrigins(pool);
  return r.rowCount ?? 0;
}

/**
 * Tick do watchdog: expira propostas cujo deadline_at passou (backstop de restart) e purga
 * payload de propostas antigas (>7d) — libera JSONB grande de propostas nunca consumidas.
 */
export async function expireOverdueProposals(pool: Pool): Promise<number> {
  const overdue = await pool.query(
    "UPDATE product_proposals SET status='interrupted', error=COALESCE(error,'Deadline excedido'), deadline_at=NULL, updated_at=now() WHERE status IN ('pending','running') AND deadline_at IS NOT NULL AND deadline_at < now()",
  );
  await pool
    .query("UPDATE product_proposals SET payload=NULL, updated_at=now() WHERE payload IS NOT NULL AND created_at < now() - interval '7 days'")
    .catch((e) => console.error("[Propose] purge payload:", e));
  if (overdue.rowCount) await revertOrphanOrigins(pool);
  return overdue.rowCount ?? 0;
}

/**
 * Devolve à Bancada (spec_submitted) a spec presa em pending_conversion cuja ÚNICA proposta
 * terminou sem consumo. Só reverte se NÃO houver proposta viva NEM consumida para a origem
 * (uma origem cujo produto nasceu de fato tem consumed_at e fica protegida) e apenas se ela
 * teve alguma proposta (não mexe em pending_conversion vindo de outro fluxo).
 */
export async function revertOrphanOrigins(pool: Pool): Promise<void> {
  await pool
    .query(
      `UPDATE projects p SET status='spec_submitted', updated_at=now()
         WHERE p.status='pending_conversion'
           AND EXISTS (SELECT 1 FROM product_proposals pp WHERE pp.origin_project_id = p.id)
           AND NOT EXISTS (
             SELECT 1 FROM product_proposals pp2
               WHERE pp2.origin_project_id = p.id
                 AND (pp2.status IN ('pending','running') OR pp2.consumed_at IS NOT NULL)
           )`,
    )
    .catch((e) => console.error("[Propose] revertOrphanOrigins:", e));
}
