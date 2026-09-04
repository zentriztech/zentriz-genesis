/**
 * specQuestionsWorker.ts — D3: escalada de perguntas da fábrica sem resposta (TTL 72h → Zentriz).
 * Padrão setInterval igual aos demais workers (financeBillingWorker/s3CleanupWorker).
 */
import type { Pool } from "pg";
import { pool as defaultPool } from "../db/client.js";
import { escalateStaleQuestions, SPEC_QUESTION_TTL_HOURS } from "./specQuestions.js";

const INTERVAL_MS = Math.max(60_000, parseInt(process.env.SPEC_QUESTIONS_WORKER_INTERVAL_MS ?? String(30 * 60_000), 10) || 30 * 60_000);
const FIRST_TICK_MS = 2 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let first: ReturnType<typeof setTimeout> | null = null;

export async function tick(pool: Pool = defaultPool): Promise<void> {
  try {
    const n = await escalateStaleQuestions(pool, SPEC_QUESTION_TTL_HOURS);
    if (n > 0) console.log(`[spec-questions-worker] ${n} pergunta(s) escalada(s) à Zentriz (TTL ${SPEC_QUESTION_TTL_HOURS}h)`);
  } catch (e) {
    console.warn("[spec-questions-worker] tick falhou:", e instanceof Error ? e.message : e);
  }
}

export function startSpecQuestionsWorker(): void {
  if (timer) return;
  if ((process.env.SPEC_QUESTIONS_WORKER ?? "on").toLowerCase() === "off") return;
  first = setTimeout(() => { void tick(); }, FIRST_TICK_MS);
  timer = setInterval(() => { void tick(); }, INTERVAL_MS);
}

export function stopSpecQuestionsWorker(): void {
  if (first) { clearTimeout(first); first = null; }
  if (timer) { clearInterval(timer); timer = null; }
}
