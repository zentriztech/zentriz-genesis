/**
 * JORNADA da Bancada até a Fábrica — em que etapa a spec/produto está e QUAL é o próximo comando.
 *
 * Pedido do Jean (2026-10-16, VNX Judge): os comandos apareciam todos com o mesmo peso e fora de
 * ordem (Modo autônomo e Descartar ao lado de Normalizar; Promover sumia sem dizer onde estava o
 * usuário), e o motivo do bloqueio era um parágrafo cru do servidor. Aqui a ordem que o SERVIDOR
 * exige (`PROMOTION_STEPS`) vira 4 etapas com estado, e o motivo vira uma frase curta + a ação.
 *
 * A decisão continua sendo do servidor (`PromotionVerdict`): este módulo só a traduz. Código novo
 * do gate que não estiver mapeado cai no texto do servidor — nunca inventa uma etapa.
 */
import type { PromotionVerdict } from "./factoryActions";

export type JourneyStepKey = "normalize" | "validate" | "review" | "promote";
export type JourneyStepState = "done" | "current" | "todo";

/** O comando que destrava a etapa atual — cada tela o liga ao seu handler. */
export type JourneyAction = "normalize" | "validate" | "ack" | "gaps" | "promote" | null;

export interface JourneyStep { key: JourneyStepKey; label: string; state: JourneyStepState }

export interface Journey {
  /** `unknown`: o servidor não conferiu (`canPromote: null`) — não há etapa a afirmar. */
  phase: "unknown" | "in_factory" | "blocked" | "ready";
  steps: JourneyStep[];
  current: JourneyStepKey | null;
  action: JourneyAction;
  /** Rótulo do botão da ação (o mesmo no card e na barra). */
  actionLabel: string | null;
  /** Frase curta do estado (≤ ~60 caracteres) — o detalhe completo do servidor vai em `detail`. */
  headline: string;
  detail: string | null;
  severity: "success" | "info" | "warning" | "error";
  /** Spec que travou (no produto, a primeira que falhou) — para levar o usuário direto a ela. */
  blockingProjectId: string | null;
  blockingProjectTitle: string | null;
}

export const JOURNEY_LABEL: Record<JourneyStepKey, string> = {
  normalize: "Normalizar",
  validate: "Validar",
  review: "Revisar GAPs",
  promote: "Promover",
};

const ORDER: JourneyStepKey[] = ["normalize", "validate", "review", "promote"];

function stepsAt(current: JourneyStepKey | "all_done"): JourneyStep[] {
  const idx = current === "all_done" ? ORDER.length : ORDER.indexOf(current);
  return ORDER.map((key, i) => ({
    key, label: JOURNEY_LABEL[key],
    state: i < idx ? "done" : i === idx ? "current" : "todo",
  }));
}

/** O texto do servidor sem o prefixo "Título: " (já mostrado à parte) e sem a "Ordem: …" (é o stepper). */
function stripDetail(message: string | null | undefined, title: string | null | undefined): string | null {
  if (!message) return null;
  let m = message.trim();
  if (title && m.startsWith(`${title}:`)) m = m.slice(title.length + 1).trim();
  m = m.replace(/\s*Ordem:\s*[^.]*\.?\s*$/, "").trim();
  return m || null;
}

/**
 * Traduz o veredito do servidor em jornada. `normalizedFallback` cobre a listagem antiga sem
 * `promotion` (contrato anterior a 2026-09-11).
 */
export function journeyFromVerdict(
  promotion: PromotionVerdict | null | undefined,
  normalizedFallback?: boolean | null,
): Journey {
  const blockingProjectId = promotion?.blockingProjectId ?? null;
  const blockingProjectTitle = promotion?.blockingProjectTitle ?? null;
  const detail = stripDetail(promotion?.message, blockingProjectTitle);
  const base = { blockingProjectId, blockingProjectTitle, detail };

  if (!promotion) {
    if (normalizedFallback === false) {
      return { ...base, phase: "blocked", steps: stepsAt("normalize"), current: "normalize", action: "normalize",
        actionLabel: JOURNEY_LABEL.normalize, headline: "Falta normalizar (RFC, ADR e connect.yaml)", severity: "info" };
    }
    return { ...base, phase: "unknown", steps: stepsAt("normalize").map((s) => ({ ...s, state: "todo" })), current: null,
      action: null, actionLabel: null, headline: "Etapa não conferida pelo servidor", severity: "info" };
  }

  if (promotion.canPromote === true) {
    return { ...base, phase: "ready", steps: stepsAt("promote"), current: "promote", action: "promote",
      actionLabel: JOURNEY_LABEL.promote, headline: "Pronto para promover à fábrica", severity: "success" };
  }
  if (promotion.canPromote === null) {
    // Não conferido: se ao menos sabemos que está normalizado, a etapa seguinte é Validar — mas sem
    // afirmar; a ação fica com quem chama (o /promote decide de verdade).
    const steps = promotion.normalized === true ? stepsAt("validate") : stepsAt("normalize");
    return { ...base, phase: "unknown", steps, current: null, action: null, actionLabel: null,
      headline: "Etapa não conferida pelo servidor", severity: "info" };
  }

  // canPromote === false
  switch (promotion.reason) {
    case "NOT_ON_WORKBENCH":
      return { ...base, phase: "in_factory", steps: stepsAt("all_done"), current: null, action: null, actionLabel: null,
        headline: "Já está na fábrica", severity: "success" };
    case "NOT_NORMALIZED":
      return { ...base, phase: "blocked", steps: stepsAt("normalize"), current: "normalize", action: "normalize",
        actionLabel: JOURNEY_LABEL.normalize, headline: "Falta normalizar (RFC, ADR e connect.yaml)", severity: "info" };
    case "CONNECT_MISSING":
      // O [Normalizar] gera o connect.yaml ausente — é a mesma ação, e a etapa continua a 1ª.
      return { ...base, phase: "blocked", steps: stepsAt("normalize"), current: "normalize", action: "normalize",
        actionLabel: JOURNEY_LABEL.normalize,
        headline: promotion.code === "CONNECT_DECLARATION_INCOMPLETE" ? "connect.yaml incompleto" : "Falta o connect.yaml",
        severity: "warning" };
    case "NOT_VALIDATED":
      switch (promotion.code) {
        case "SPEC_WARNINGS_UNACKED":
          return { ...base, phase: "blocked", steps: stepsAt("review"), current: "review", action: "ack",
            actionLabel: "Reconhecer avisos", headline: "Validada com avisos — reconheça para seguir", severity: "warning" };
        case "SPEC_VALIDATION_BLOCKED":
          return { ...base, phase: "blocked", steps: stepsAt("review"), current: "review", action: "gaps",
            actionLabel: "Resolver GAPs críticos", headline: "GAPs críticos impedem a promoção", severity: "error" };
        case "SPEC_COVERAGE_INCOMPLETE":
          return { ...base, phase: "blocked", steps: stepsAt("validate"), current: "validate", action: "validate",
            actionLabel: "Validar de novo", headline: "Validação não cobriu todos os arquivos", severity: "warning" };
        case "SPEC_FILES_MISSING":
          return { ...base, phase: "blocked", steps: stepsAt("validate"), current: "validate", action: null,
            actionLabel: null, headline: "Spec sem arquivos legíveis", severity: "error" };
        default:
          return { ...base, phase: "blocked", steps: stepsAt("validate"), current: "validate", action: "validate",
            actionLabel: JOURNEY_LABEL.validate, headline: "Falta validar a versão atual", severity: "info" };
      }
    default:
      return { ...base, phase: "blocked", steps: stepsAt("normalize"), current: null, action: null, actionLabel: null,
        headline: detail ?? "Promoção bloqueada", severity: "info" };
  }
}
