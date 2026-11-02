/**
 * Simulação offline do ciclo de feedback de skill (plano 1.1, ADR-025 §5): para cada histórico
 * sintético de sinais, mostra a transição de status ANTES (regra legada) e DEPOIS (regra corrigida).
 *
 *   cd applications/services/api-node && npx tsx scripts/simulate-skill-feedback.ts
 *
 * Aceita `--history arquivo.json` com [{"task":"T1","signal":"oracle_pass"}, ...] para rodar sobre
 * um histórico REAL exportado (skill_feedback), com a mesma regra. Não toca em banco nem rede.
 */
import { readFileSync } from "node:fs";
import { simulateLegacy, simulateNew, type SimEvent, type SimStep } from "../src/services/skillFeedbackMemory.js";
import { SCENARIOS } from "../src/services/skillFeedbackScenarios.js";

function firstChange(steps: SimStep[], start: string): string {
  const hit = steps.find((s) => s.status !== start);
  return hit ? `${start}->${hit.status} no sinal #${hit.n}` : "sem transição";
}

async function main() {
  const idx = process.argv.indexOf("--history");
  const scenarios = idx > 0
    ? [{ name: "histórico real", description: process.argv[idx + 1], startStatus: "shadow" as const, startQuality: 1,
         events: JSON.parse(readFileSync(process.argv[idx + 1], "utf-8")) as SimEvent[], expectNew: "shadow" as const }]
    : SCENARIOS;

  console.log("cenário | legado (final / q / transição) | corrigido (final / q / transição)");
  for (const sc of scenarios) {
    // legado só modela shadow->trusted e trusted->deprecated; parte do status inicial do cenário
    const legacy = simulateLegacy(sc.events, sc.startQuality).map((s) => ({ ...s }));
    let legacyStatus = sc.startStatus as string;
    // reaplica a partir do status inicial (simulateLegacy parte de shadow): para trusted, ajusta
    if (sc.startStatus === "trusted") {
      let q = sc.startQuality, use = 10, st = "trusted";
      legacy.length = 0;
      const { legacyNextQualityScore, defaultSignalWeight } = await import("../src/services/skillFeedback.js");
      sc.events.forEach((e, i) => {
        use += 1;
        q = legacyNextQualityScore(q, defaultSignalWeight(e.signal));
        if (st === "trusted" && q < 0.3 && use >= 10) st = "deprecated";
        legacy.push({ n: i + 1, signal: e.signal, quality: q, status: st, use_count: use });
      });
      legacyStatus = "trusted";
    }
    const neu = await simulateNew(sc.events, "on", sc.startQuality, sc.startStatus);
    const l = legacy[legacy.length - 1], n = neu[neu.length - 1];
    console.log(`${sc.name}  [${sc.description}]`);
    console.log(`   legado   : ${l.status} / q=${l.quality.toFixed(3)} / use_count=${l.use_count} / ${firstChange(legacy, legacyStatus)}`);
    console.log(`   corrigido: ${n.status} / q=${n.quality.toFixed(3)} / use_count=${n.use_count} / ${firstChange(neu, sc.startStatus)}  (esperado: ${sc.expectNew})`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
