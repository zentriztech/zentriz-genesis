/**
 * specChatWorker.ts — coletor SERVER-SIDE dos jobs do chat de spec (Bancada).
 *
 * POR QUE ISTO EXISTE: o caso de falha real medido em prod NÃO é "o poll do usuário derrapou" —
 * é "o usuário fechou a tela e não voltou". Enquanto a coleta dependia de alguém estar pollando,
 * o CTO terminava, o resultado ficava no dict em memória dos agents e era descartado pelo TTL de
 * 45 min. Um job concluiu com 95.199 bytes de spec revisada (Opus 5, ~19 min) e o trabalho foi
 * jogado fora. Só um coletor do lado do servidor fecha esse buraco.
 *
 * Contrato com o poll em processo (`runChatJob`): aquele poll dá latência baixa a quem está com a
 * tela aberta e faz HEARTBEAT (`updated_at`) a cada tick. Este worker só adota jobs SEM heartbeat
 * recente — órfãos de restart/deploy ou de request encerrado. O encerramento é claim-locked
 * (`finishSpecChatJob`), então nunca há resposta duplicada no histórico.
 *
 * Molde: `evolutionMergeWorker.ts` (timer de módulo + guarda de reentrância + stop no SIGTERM).
 */
import { pool } from "../db/client.js";
import { collectSpecChatJobsTick } from "./specChatJobs.js";
import { advanceAutonomyRunsTick } from "./specAutonomy.js";
import { collectSpecSplitsTick } from "./specSplit.js";
import { collectBancadaLessonsTick } from "./specLearning.js";
import { extractSpecMarkdown, httpGet } from "../routes/specs.js";

/** 20 s: barato (só toca jobs órfãos) e rápido o bastante para o usuário que volta à tela. */
const TICK_MS = Number.parseInt(process.env.SPEC_CHAT_WORKER_TICK_MS ?? "20000", 10);

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Probe do resultado no agente. Distingue 404 (resultado JÁ descartado pelo TTL → estado terminal
 * `lost`, com causa honesta) de falha de rede (transitória → contabilizada em `poll_errors`).
 * `httpGet` rejeita em qualquer não-2xx com a mensagem contendo o status.
 */
async function probeAgents(agentsJobId: string): Promise<{ status: string; result?: Record<string, unknown>; error?: string } | "not_found"> {
  const base = (process.env.API_AGENTS_URL ?? "").trim().replace(/\/$/, "");
  if (!base) throw new Error("API_AGENTS_URL não configurado");
  try {
    const text = await httpGet(`${base}/invoke/cto/status/${agentsJobId}`, 60_000);
    return JSON.parse(text) as { status: string; result?: Record<string, unknown>; error?: string };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/\b404\b/.test(m) || /not\s*found/i.test(m)) return "not_found";
    throw e;
  }
}

/** Mesmo probe, outro endpoint: a divisão da spec tem job próprio no serviço agents. */
async function probeSpecSplit(agentsJobId: string) {
  const base = (process.env.API_AGENTS_URL ?? "").trim().replace(/\/$/, "");
  if (!base) throw new Error("API_AGENTS_URL não configurado");
  try {
    const text = await httpGet(`${base}/invoke/spec_split/status/${agentsJobId}`, 60_000);
    return JSON.parse(text) as { status: string; result?: Record<string, unknown>; error?: string };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/\b404\b/.test(m) || /not\s*found/i.test(m)) return "not_found" as const;
    throw e;
  }
}

async function tick(): Promise<void> {
  const out = await collectSpecChatJobsTick(pool, probeAgents, extractSpecMarkdown);
  if (out.collected || out.lost || out.expired) {
    console.info(`[SpecChatWorker] tick: ${out.scanned} órfão(s) varrido(s) — ${out.collected} coletado(s), ${out.lost} perdido(s), ${out.expired} expirado(s).`);
  }
  // MODO AUTÔNOMO (migração 090): o mesmo tick avança o laço "Resolver GAPs → Salvar → Validar".
  // A ORDEM importa: coletar PRIMEIRO encerra o job do CTO desta rodada, e só então o laço vê
  // `done` e aplica a spec — sem isto o autônomo esperaria um tick extra por rodada.
  // Nunca lança (a função é defensiva por dentro) para não derrubar a coleta de jobs.
  const auto = await advanceAutonomyRunsTick(pool);
  if (auto.advanced) {
    console.info(`[SpecChatWorker] modo autônomo: ${auto.advanced}/${auto.scanned} laço(s) avançado(s).`);
  }
  // F2/PR-3 (migração 093): mesma classe de furo para a DIVISÃO da spec — são ~10 chamadas de LLM
  // por proposta, e um deploy no meio as jogaria fora. Endpoint próprio nos agents (spec_split).
  const split = await collectSpecSplitsTick(pool, probeSpecSplit).catch((e) => {
    console.warn(`[SpecChatWorker] coleta de divisões falhou: ${e instanceof Error ? e.message : String(e)}`);
    return { scanned: 0, collected: 0, lost: 0 };
  });
  if (split.collected || split.lost) {
    console.info(`[SpecChatWorker] divisão de spec: ${split.collected} coletada(s), ${split.lost} perdida(s) de ${split.scanned} órfã(s).`);
  }
  // G7 (migração 096): a Bancada APRENDE. Depois de avançar os laços, os que TERMINARAM neste tick
  // (ou em ticks anteriores, se a api reiniciou) viram material de extração de lição. Vem por
  // último de propósito: aprender é acessório e nunca deve atrasar a coleta ou o laço.
  const learn = await collectBancadaLessonsTick(pool).catch((e) => {
    console.warn(`[SpecChatWorker] extração de lições falhou: ${e instanceof Error ? e.message : String(e)}`);
    return { scanned: 0, kicked: 0, skipped: 0, polled: 0, finished: 0 };
  });
  if (learn.kicked || learn.finished || learn.skipped) {
    console.info(`[SpecChatWorker] aprendizado: ${learn.kicked} episódio(s) enviado(s), ${learn.finished} concluído(s), ${learn.skipped} sem rodadas.`);
  }
}

export function startSpecChatWorker(): void {
  if (timer) return;
  if (!Number.isFinite(TICK_MS) || TICK_MS < 5_000) {
    console.warn(`[SpecChatWorker] SPEC_CHAT_WORKER_TICK_MS inválido (${process.env.SPEC_CHAT_WORKER_TICK_MS}) — worker NÃO iniciado.`);
    return;
  }
  timer = setInterval(() => {
    if (running) return; // um tick lento (probe de 60 s) não deve empilhar outro
    running = true;
    tick()
      .catch((e) => console.warn(`[SpecChatWorker] tick falhou: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => { running = false; });
  }, TICK_MS);
  timer.unref?.();
  console.info(`[SpecChatWorker] iniciado (tick ${TICK_MS}ms) — coleta jobs de spec-chat órfãos (usuário fora da tela / restart da api).`);
}

export function stopSpecChatWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
