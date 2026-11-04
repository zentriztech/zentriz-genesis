/**
 * factoryHealth.ts — saúde da Fábrica de um filho aceito (rodada 4.5c, D-1..D-4): deriva `ok | attention | failed` dos 5 gates REAIS
 * registrados no aceite (`extra.evolution_factory_gates`). Módulo puro (sem banco) para o card, a API e os testes compartilharem a regra.
 */
/** `failed` se algum gate FALHOU; `attention` se algum não executou/sem evidência; senão `ok`. */
export type FactoryHealth = "ok" | "attention" | "failed";
export const FACTORY_GATE_KEYS = ["scope", "symbols", "qa", "fullTest", "baseline"] as const;
export function factoryHealthOf(g: Partial<Record<(typeof FACTORY_GATE_KEYS)[number], { status?: string } | null | undefined>> | null | undefined): FactoryHealth | null {
  if (!g) return null;
  const sts = FACTORY_GATE_KEYS.map((k) => g[k]?.status);
  if (sts.every((x) => x === undefined)) return null;
  if (sts.includes("failed")) return "failed";
  if (sts.some((x) => x !== "passed")) return "attention";
  return "ok";
}
