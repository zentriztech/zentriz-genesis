/**
 * alb.ts — G1-T18 (Fase C). Application Load Balancer + listeners.
 *
 * Cria o ALB (subnets públicas ≥2 AZ, SG do ALB do networking), aponta para o target
 * group do ecs (T17) e monta os listeners:
 *   • com cert ACM (T18/acm) → HTTPS:443 forward ao TG + HTTP:80 redirect → HTTPS.
 *   • sem cert (dev/homolog) → HTTP:80 forward direto ao TG.
 *
 * Idempotente: describe-before-create do LB por nome; reusa listeners existentes.
 * Persiste alb_arn/listener_arn. O app_url final é gravado pelo route53 (ou, sem zona,
 * pelo próprio ALB DNS name aqui).
 */

import {
  CreateLoadBalancerCommand, DescribeLoadBalancersCommand,
  CreateListenerCommand, DescribeListenersCommand,
  DeleteLoadBalancerCommand,
  type ElasticLoadBalancingV2Client,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { elbv2Client } from "./awsClients.js";
import {
  recordResourceIntent, markResourceCreated, findCreatedResource, patchDeployment,
} from "./backendState.js";
import { setAppUrl } from "./provisionChain.js";
import { registerDriver, type ProvisionContext, type ProvisionDriver } from "./provisionChain.js";

function albName(ctx: ProvisionContext): string {
  return `gen-${ctx.deploymentId.slice(0, 12)}`; // ≤32 chars
}

async function ensureLoadBalancer(
  elb: ElasticLoadBalancingV2Client, ctx: ProvisionContext,
): Promise<{ arn: string; dns: string }> {
  const name = albName(ctx);
  // describe-before-create por nome.
  try {
    const got = await elb.send(new DescribeLoadBalancersCommand({ Names: [name] }));
    const lb = got.LoadBalancers?.[0];
    if (lb?.LoadBalancerArn && lb.DNSName) return { arn: lb.LoadBalancerArn, dns: lb.DNSName };
  } catch (err) {
    if ((err as { name?: string })?.name !== "LoadBalancerNotFoundException") throw err;
  }
  const ledgerId = await recordResourceIntent(ctx.deploymentId, "alb", name, ctx.creds.region);
  const out = await elb.send(new CreateLoadBalancerCommand({
    Name: name, Type: "application", Scheme: "internet-facing",
    Subnets: (ctx.scratch.subnetIds as string[]) ?? [],
    SecurityGroups: [ctx.scratch.albSecurityGroupId as string].filter(Boolean),
    Tags: [{ Key: "zentriz:product", Value: "genesis" }, { Key: "zentriz:deployment_id", Value: ctx.deploymentId }],
  }));
  const lb = out.LoadBalancers![0];
  await markResourceCreated(ledgerId, lb.LoadBalancerArn!, { dns: lb.DNSName });
  return { arn: lb.LoadBalancerArn!, dns: lb.DNSName! };
}

/** Lista as portas de listeners já existentes no ALB (idempotência). */
async function existingListenerPorts(elb: ElasticLoadBalancingV2Client, albArn: string): Promise<Set<number>> {
  const out = await elb.send(new DescribeListenersCommand({ LoadBalancerArn: albArn }));
  return new Set((out.Listeners ?? []).map((l) => l.Port!).filter(Boolean));
}

export const albDriver: ProvisionDriver = {
  key: "alb",
  status: "creating_service",

  async provision(ctx: ProvisionContext): Promise<void> {
    const elb = elbv2Client(ctx.creds);
    const targetGroupArn = ctx.scratch.targetGroupArn as string | undefined;
    if (!targetGroupArn) throw new Error("ALB_NO_TARGET_GROUP: driver ecs não populou targetGroupArn");
    const certArn = ctx.scratch.acmCertArn as string | undefined;

    const lb = await ensureLoadBalancer(elb, ctx);
    ctx.scratch.albArn = lb.arn;
    ctx.scratch.albDns = lb.dns;

    const ports = await existingListenerPorts(elb, lb.arn);
    let listenerArn: string | undefined;

    if (certArn) {
      // HTTPS:443 forward → TG (cria se ausente).
      if (!ports.has(443)) {
        const led = await recordResourceIntent(ctx.deploymentId, "listener_https", `${albName(ctx)}:443`, ctx.creds.region);
        const out = await elb.send(new CreateListenerCommand({
          LoadBalancerArn: lb.arn, Protocol: "HTTPS", Port: 443,
          Certificates: [{ CertificateArn: certArn }],
          DefaultActions: [{ Type: "forward", TargetGroupArn: targetGroupArn }],
        }));
        listenerArn = out.Listeners![0].ListenerArn!;
        await markResourceCreated(led, listenerArn);
      }
      // HTTP:80 redirect → HTTPS.
      if (!ports.has(80)) {
        const led = await recordResourceIntent(ctx.deploymentId, "listener_redirect", `${albName(ctx)}:80`, ctx.creds.region);
        const out = await elb.send(new CreateListenerCommand({
          LoadBalancerArn: lb.arn, Protocol: "HTTP", Port: 80,
          DefaultActions: [{
            Type: "redirect",
            RedirectConfig: { Protocol: "HTTPS", Port: "443", StatusCode: "HTTP_301" },
          }],
        }));
        await markResourceCreated(led, out.Listeners![0].ListenerArn!);
      }
    } else {
      // Sem cert: HTTP:80 forward direto (dev/homolog).
      if (!ports.has(80)) {
        const led = await recordResourceIntent(ctx.deploymentId, "listener_http", `${albName(ctx)}:80`, ctx.creds.region);
        const out = await elb.send(new CreateListenerCommand({
          LoadBalancerArn: lb.arn, Protocol: "HTTP", Port: 80,
          DefaultActions: [{ Type: "forward", TargetGroupArn: targetGroupArn }],
        }));
        listenerArn = out.Listeners![0].ListenerArn!;
        await markResourceCreated(led, listenerArn);
      }
    }

    await patchDeployment(ctx.deploymentId, { alb_arn: lb.arn, listener_arn: listenerArn ?? null });

    // Sem hosted zone (sem cert), a URL é o próprio DNS name do ALB (HTTP). Com zona,
    // o driver route53 sobrescreve com o hostname HTTPS.
    if (!certArn) {
      await setAppUrl(ctx.deploymentId, `http://${lb.dns}`, `http://${lb.dns}/health`);
    }
  },

  async teardown(ctx: ProvisionContext): Promise<void> {
    const res = await findCreatedResource(ctx.deploymentId, "alb");
    if (res?.arn) {
      const elb = elbv2Client(ctx.creds);
      // Deletar o LB remove seus listeners junto.
      await elb.send(new DeleteLoadBalancerCommand({ LoadBalancerArn: res.arn })).catch(() => { /* T21 reconcilia */ });
    }
  },
};

registerDriver(albDriver);
