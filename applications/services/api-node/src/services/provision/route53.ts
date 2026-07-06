/**
 * route53.ts — G1-T18 (Fase C). Record final <app>.<domain> → ALB (ALIAS A) + app_url HTTPS.
 *
 * Último driver da cadeia. Cria o ALIAS A apontando para o ALB e grava o app_url HTTPS
 * definitivo. Sem hosted zone (dev), é no-op: o app_url HTTP do ALB (setado no alb.ts)
 * permanece.
 *
 * ALIAS exige o CanonicalHostedZoneId do ALB (fixo por região p/ ALBs) — obtido via
 * DescribeLoadBalancers. Idempotente (UPSERT).
 */

import {
  ChangeResourceRecordSetsCommand, type Route53Client,
} from "@aws-sdk/client-route-53";
import {
  DescribeLoadBalancersCommand, type ElasticLoadBalancingV2Client,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { route53Client, elbv2Client } from "./awsClients.js";
import { appHostname, hostedZoneId } from "./dnsConfig.js";
import {
  recordResourceIntent, markResourceCreated, findCreatedResource, patchDeployment,
} from "./backendState.js";
import { setAppUrl } from "./provisionChain.js";
import { registerDriver, type ProvisionContext, type ProvisionDriver } from "./provisionChain.js";

async function albAliasTarget(
  elb: ElasticLoadBalancingV2Client, albArn: string,
): Promise<{ dns: string; zoneId: string }> {
  const out = await elb.send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [albArn] }));
  const lb = out.LoadBalancers?.[0];
  if (!lb?.DNSName || !lb.CanonicalHostedZoneId) throw new Error("ROUTE53_ALB_NOT_FOUND");
  return { dns: lb.DNSName, zoneId: lb.CanonicalHostedZoneId };
}

export const route53Driver: ProvisionDriver = {
  key: "route53",
  status: "creating_service",

  async provision(ctx: ProvisionContext): Promise<void> {
    const zoneId = hostedZoneId();
    const albArn = ctx.scratch.albArn as string | undefined;
    if (!zoneId || !albArn) return; // dev/homolog: mantém o app_url HTTP do ALB.

    const hostname = appHostname(ctx);
    const r53 = route53Client(ctx.creds);
    const elb = elbv2Client(ctx.creds);
    const target = await albAliasTarget(elb, albArn);

    const ledgerId = await recordResourceIntent(ctx.deploymentId, "route53_record", hostname, ctx.creds.region);
    await r53.send(new ChangeResourceRecordSetsCommand({
      HostedZoneId: zoneId,
      ChangeBatch: {
        Changes: [{
          Action: "UPSERT",
          ResourceRecordSet: {
            Name: hostname, Type: "A",
            AliasTarget: { DNSName: target.dns, HostedZoneId: target.zoneId, EvaluateTargetHealth: true },
          },
        }],
      },
    }));
    await markResourceCreated(ledgerId, hostname, { alb: target.dns });

    const appUrl = `https://${hostname}`;
    await patchDeployment(ctx.deploymentId, { route53_record: hostname });
    await setAppUrl(ctx.deploymentId, appUrl, `${appUrl}/health`);
    ctx.scratch.appUrl = appUrl;
  },

  async teardown(ctx: ProvisionContext): Promise<void> {
    const zoneId = hostedZoneId();
    const res = await findCreatedResource(ctx.deploymentId, "route53_record");
    const albArn = ctx.scratch.albArn as string | undefined;
    if (!zoneId || !res?.intended_name || !albArn) return;
    try {
      const elb = elbv2Client(ctx.creds);
      const target = await albAliasTarget(elb, albArn);
      const r53 = route53Client(ctx.creds);
      await r53.send(new ChangeResourceRecordSetsCommand({
        HostedZoneId: zoneId,
        ChangeBatch: {
          Changes: [{
            Action: "DELETE",
            ResourceRecordSet: {
              Name: res.intended_name, Type: "A",
              AliasTarget: { DNSName: target.dns, HostedZoneId: target.zoneId, EvaluateTargetHealth: true },
            },
          }],
        },
      }));
    } catch { /* T21 reconcilia (ALB pode já ter sido removido) */ }
  },
};

registerDriver(route53Driver);
