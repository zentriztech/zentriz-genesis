/**
 * albRouting.ts — G1-T25 (Fase E). Regras de path-routing do ALB para multi-serviço.
 *
 * O ALB roteia por PREFIXO DE SERVIÇO (não por rota OpenAPI individual: o ALB não
 * suporta path params e tem teto de 100 regras). As regras são ordenadas por
 * ESPECIFICIDADE — `/api/auth/*`→auth ANTES de `/api/*`→api — e o serviço web fica no
 * default action do listener (catch-all `/`).
 *
 * Prioridade ALB: número menor = avaliado primeiro. Emitimos prioridades explícitas
 * a partir da ordem por especificidade (10, 20, 30, ...).
 */

import {
  CreateRuleCommand, DescribeRulesCommand,
  type ElasticLoadBalancingV2Client,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { orderByRouteSpecificity, type ServicePlan } from "./tenantProvisioner.js";

export interface PathRule {
  priority: number;
  pathPattern: string;        // ex.: "/api/auth/*"
  serviceName: string;
  targetGroupArn: string;     // TG do serviço (do ecs driver por serviço)
  isCatchAll: boolean;        // web → default action, sem regra explícita
}

/**
 * Plano de regras a partir da topologia + mapa serviço→targetGroupArn.
 * O serviço catch-all ("/") vira default action (isCatchAll=true, sem regra).
 * Demais viram regras `<prefix>/*` ordenadas por especificidade.
 */
export function planPathRules(
  services: ServicePlan[],
  targetGroups: Record<string, string>,
): PathRule[] {
  const ordered = orderByRouteSpecificity(services);
  const rules: PathRule[] = [];
  let priority = 10;
  for (const svc of ordered) {
    const tg = targetGroups[svc.name];
    if (!tg) continue; // worker sem ingress
    const isCatchAll = svc.routePrefix === "/";
    rules.push({
      priority: isCatchAll ? 50000 : priority,   // catch-all: prioridade alta (última)
      pathPattern: isCatchAll ? "/*" : `${svc.routePrefix.replace(/\/$/, "")}/*`,
      serviceName: svc.name,
      targetGroupArn: tg,
      isCatchAll,
    });
    if (!isCatchAll) priority += 10;
  }
  return rules;
}

/**
 * Aplica as regras de path no listener (idempotente: não recria prioridade existente).
 * O catch-all NÃO vira regra — é o default action do listener (setado no alb driver).
 */
export async function applyPathRules(
  elb: ElasticLoadBalancingV2Client,
  listenerArn: string,
  rules: PathRule[],
): Promise<void> {
  const existing = await elb.send(new DescribeRulesCommand({ ListenerArn: listenerArn }));
  const usedPriorities = new Set(
    (existing.Rules ?? []).map((r) => r.Priority).filter((p): p is string => !!p && p !== "default"),
  );
  for (const rule of rules) {
    if (rule.isCatchAll) continue; // default action, não é regra
    if (usedPriorities.has(String(rule.priority))) continue; // idempotente
    await elb.send(new CreateRuleCommand({
      ListenerArn: listenerArn,
      Priority: rule.priority,
      Conditions: [{ Field: "path-pattern", PathPatternConfig: { Values: [rule.pathPattern] } }],
      Actions: [{ Type: "forward", TargetGroupArn: rule.targetGroupArn }],
    }));
  }
}
