/**
 * skillFeedbackScenarios.ts — históricos sintéticos de sinais para a simulação offline (plano 1.1).
 * Cada cenário descreve um tipo de skill e o que o ciclo deve (e não deve) fazer com ela.
 * Determinístico (sem aleatoriedade): o padrão de acerto é cíclico.
 */
import type { SimEvent } from "./skillFeedbackMemory.js";

export interface Scenario {
  name: string;
  description: string;
  startStatus: "shadow" | "trusted";
  startQuality: number;
  events: SimEvent[];
  /** O que se espera da regra CORRIGIDA no fim (ADR-025). */
  expectNew: "shadow" | "trusted" | "deprecated";
}

/** `pattern`: sequência de 'p'/'f' repetida ciclicamente por `tasks` tarefas. */
function history(tasks: number, pattern: string, opts: { qa: boolean; oracle: boolean }): SimEvent[] {
  const ev: SimEvent[] = [];
  for (let i = 0; i < tasks; i++) {
    const pass = pattern[i % pattern.length] === "p";
    const task = `T${String(i + 1).padStart(3, "0")}`;
    if (opts.qa) ev.push({ task, signal: pass ? "qa_pass" : "qa_fail" });
    if (opts.oracle) ev.push({ task, signal: pass ? "oracle_pass" : "oracle_fail" });
  }
  return ev;
}

export const SCENARIOS: Scenario[] = [
  { name: "A. boa, com oráculo", description: "40 tasks, QA e oráculo sempre positivos",
    startStatus: "shadow", startQuality: 1, events: history(40, "p", { qa: true, oracle: true }), expectNew: "trusted" },
  { name: "B. ruim, com oráculo", description: "40 tasks, QA e oráculo sempre negativos (skill shadow)",
    startStatus: "shadow", startQuality: 1, events: history(40, "f", { qa: true, oracle: true }), expectNew: "shadow" },
  { name: "C. boa só pelo QA", description: "40 tasks só com qa_pass, sem oráculo — QA (LLM) não pode promover",
    startStatus: "shadow", startQuality: 1, events: history(40, "p", { qa: true, oracle: false }), expectNew: "shadow" },
  { name: "D. ruim só pelo QA", description: "40 tasks só com qa_fail — legado promovia mesmo assim",
    startStatus: "shadow", startQuality: 1, events: history(40, "f", { qa: true, oracle: false }), expectNew: "shadow" },
  { name: "E. trusted que passou a falhar", description: "trusted, 40 tasks com QA e oráculo negativos — deve ser deprecada",
    startStatus: "trusted", startQuality: 1, events: history(40, "f", { qa: true, oracle: true }), expectNew: "deprecated" },
  { name: "F. trusted só falha no QA", description: "trusted, 40 qa_fail sem oráculo — QA não pode deprecar",
    startStatus: "trusted", startQuality: 1, events: history(40, "f", { qa: true, oracle: false }), expectNew: "trusted" },
  { name: "G. mediana (50% de acerto)", description: "40 tasks, oráculo alternado — score ~0,5, nem trusted nem deprecated",
    startStatus: "shadow", startQuality: 1, events: history(40, "pf", { qa: true, oracle: true }), expectNew: "shadow" },
];
