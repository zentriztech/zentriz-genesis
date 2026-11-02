/**
 * anomalyAlerts.ts (lib) — flag `ANOMALY_ALERTS` e parâmetros dos detectores (plano de evolução v2, tarefa 1.6).
 *
 * O alerta estatístico roda AO LADO do LLM Guard, nunca no lugar dele: nada aqui é lido pelo Guard e
 * nenhum alerta pausa, nega ou libera chamada. Só informa, registra e (modo on) notifica.
 *
 *   off    (padrão) nada roda e nada é escrito (byte-idêntico ao comportamento anterior).
 *   shadow calcula e grava alertas marcados `shadow`, sem notificar.
 *   on     igual ao shadow, e notifica pelo canal de operações se ele estiver configurado.
 *
 * Todos os limiares têm padrão CONSERVADOR (poucos alertas, mais tarde) e podem ser sobrescritos por
 * `ANOMALY_<NOME>` no ambiente. Os padrões foram calibrados só em tráfego SINTÉTICO: o limite aceitável
 * de falsos alertas é do pré-registro (tarefa 0.6) e os parâmetros devem ser reavaliados com dados reais.
 */
export type AnomalyMode = "off" | "shadow" | "on";

/** Valor ausente ou desconhecido ⇒ `off` (fail-safe: nunca liga por engano). */
export function anomalyMode(env: NodeJS.ProcessEnv = process.env): AnomalyMode {
  const raw = (env.ANOMALY_ALERTS ?? "off").trim().toLowerCase();
  return raw === "shadow" || raw === "on" ? raw : "off";
}

export interface AnomalyParams {
  /** Horas de histórico usadas como linha de base (mediana/MAD). */
  baselineHours: number;
  /** Defasagem (h) da linha de base em relação à hora avaliada: uma rampa lenta não se esconde na própria base. */
  baselineLagHours: number;
  /** Mínimo de horas na base para o detector começar a avaliar uma série. */
  minBaselineHours: number;
  /** Se true, a base usa só a mesma hora do dia (±1 h) dos últimos dias (sazonalidade diária, MAD sazonal). */
  seasonal: boolean;
  /** Mínimo de pontos sazonais para usar a base sazonal. */
  minSeasonalPoints: number;
  /** Piso relativo do desvio robusto: sigma >= relFloor * |mediana|. */
  relFloor: number;
  /** Piso absoluto do desvio robusto para a série de USD/hora. */
  usdSigmaFloor: number;
  /** Valor mínimo (USD/hora) para um alerta de custo poder disparar. */
  minUsdPerHour: number;
  /** Mínimo de chamadas na hora para a série tokens/chamada ter ponto. */
  minCallsForTokenPoint: number;
  /** Valor mínimo (tokens/chamada) para um alerta de tokens poder disparar. */
  minTokensPerCall: number;
  /** z do MAD robusto (escore (x-mediana)/sigma). */
  madZ: number;
  /** Peso do EWMA (0..1). */
  ewmaLambda: number;
  /** Largura do limite do EWMA em desvios do próprio EWMA. */
  ewmaL: number;
  /** Folga do CUSUM (em sigmas). */
  cusumK: number;
  /** Limite de decisão do CUSUM (em sigmas acumulados). */
  cusumH: number;
  /** Corte do z antes de entrar no CUSUM (um único pico não decide sozinho). */
  zClip: number;
  /** Horas sem repetir o mesmo alerta (mesmo detector e escopo). */
  cooldownHours: number;
  /** Payload repetido: mesma `prompt_hash` pelo menos N vezes na janela. */
  repeatMinCount: number;
  repeatWindowMinutes: number;
  /** Run travada: chamadas na janela sem nenhum evento de progresso. */
  stallMinCalls: number;
  stallWindowMinutes: number;
  /** Run travada só vale se o projeto teve progresso nesta janela anterior (evita planejamento inicial). */
  stallPriorProgressHours: number;
  /** Status de `project_agent_metrics` tratados como progresso. */
  progressStatuses: string[];
  /** Quantas horas recentes a passada do worker mantém (o resto é só histórico/base). */
  reportWindowHours: number;
}

export const DEFAULT_ANOMALY_PARAMS: AnomalyParams = {
  baselineHours: 168,
  baselineLagHours: 24,
  minBaselineHours: 48,
  seasonal: true,
  minSeasonalPoints: 4,
  relFloor: 0.25,
  usdSigmaFloor: 1,
  minUsdPerHour: 3,
  minCallsForTokenPoint: 5,
  minTokensPerCall: 20000,
  madZ: 6,
  ewmaLambda: 0.3,
  ewmaL: 5,
  cusumK: 1,
  cusumH: 10,
  zClip: 6,
  cooldownHours: 12,
  repeatMinCount: 5,
  repeatWindowMinutes: 30,
  stallMinCalls: 60,
  stallWindowMinutes: 180,
  stallPriorProgressHours: 72,
  progressStatuses: ["QA_PASS", "DONE"],
  reportWindowHours: 3,
};

const ENV_KEYS: Array<[keyof AnomalyParams, string]> = (Object.keys(DEFAULT_ANOMALY_PARAMS) as Array<keyof AnomalyParams>)
  .map((k) => [k, "ANOMALY_" + String(k).replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()]);

/** Padrões + sobrescritas por env (`ANOMALY_MAD_Z=8` etc.). Valor inválido é ignorado (fica o padrão). */
export function resolveAnomalyParams(env: NodeJS.ProcessEnv = process.env): AnomalyParams {
  const out = { ...DEFAULT_ANOMALY_PARAMS, progressStatuses: [...DEFAULT_ANOMALY_PARAMS.progressStatuses] } as Record<string, unknown>;
  for (const [key, envName] of ENV_KEYS) {
    const raw = env[envName];
    if (raw === undefined || raw.trim() === "") continue;
    const def = DEFAULT_ANOMALY_PARAMS[key];
    if (typeof def === "number") {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) out[key] = n;
    } else if (typeof def === "boolean") {
      out[key] = /^(1|true|on|yes)$/i.test(raw.trim());
    } else if (Array.isArray(def)) {
      const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
      if (list.length) out[key] = list;
    }
  }
  return out as unknown as AnomalyParams;
}
