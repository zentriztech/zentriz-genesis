/**
 * G1-T18: drivers acm + alb + route53 — cert DNS auto, listeners HTTPS+redirect, ALIAS, no-op sem zona.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── ACM ──────────────────────────────────────────────────────────────────────
const acmSent: Array<{ name: string; input: Record<string, unknown> }> = [];
let certStatus = "ISSUED";
let certStatusSequence: string[] | null = null; // se setado, consome em ordem por describe
let describeIdx = 0;
const acmSend = vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
  const name = cmd.constructor.name;
  acmSent.push({ name, input: cmd.input });
  if (name === "RequestCertificateCommand") return { CertificateArn: "arn:acm:cert1" };
  if (name === "DescribeCertificateCommand") {
    const status = certStatusSequence ? (certStatusSequence[describeIdx++] ?? certStatusSequence[certStatusSequence.length - 1]) : certStatus;
    return { Certificate: { Status: status,
      DomainValidationOptions: [{ ResourceRecord: { Name: "_val.host.", Type: "CNAME", Value: "_x.acm." } }] } };
  }
  return {};
});
vi.mock("@aws-sdk/client-acm", async (orig) => {
  const actual = await orig<typeof import("@aws-sdk/client-acm")>();
  return { ...actual, ACMClient: class { send = (c: unknown) => acmSend(c as never); } };
});

// ── Route53 ────────────────────────────────────────────────────────────────────
const r53Sent: Array<{ name: string; input: Record<string, unknown> }> = [];
const r53Send = vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
  r53Sent.push({ name: cmd.constructor.name, input: cmd.input }); return {};
});
vi.mock("@aws-sdk/client-route-53", async (orig) => {
  const actual = await orig<typeof import("@aws-sdk/client-route-53")>();
  return { ...actual, Route53Client: class { send = (c: unknown) => r53Send(c as never); } };
});

// ── ELBv2 ────────────────────────────────────────────────────────────────────
const elbSent: Array<{ name: string; input: Record<string, unknown> }> = [];
let lbExists = false;
let existingPorts: number[] = [];
const elbSend = vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
  const name = cmd.constructor.name;
  elbSent.push({ name, input: cmd.input });
  if (name === "DescribeLoadBalancersCommand") {
    if (cmd.input.LoadBalancerArns) return { LoadBalancers: [{ DNSName: "gen.elb.amazonaws.com", CanonicalHostedZoneId: "Z35" }] };
    if (lbExists) return { LoadBalancers: [{ LoadBalancerArn: "arn:alb:1", DNSName: "gen.elb.amazonaws.com" }] };
    const e = new Error("nf"); (e as { name: string }).name = "LoadBalancerNotFoundException"; throw e;
  }
  if (name === "CreateLoadBalancerCommand") return { LoadBalancers: [{ LoadBalancerArn: "arn:alb:new", DNSName: "gen.elb.amazonaws.com" }] };
  if (name === "DescribeListenersCommand") return { Listeners: existingPorts.map((p) => ({ Port: p })) };
  if (name === "CreateListenerCommand") return { Listeners: [{ ListenerArn: `arn:listener:${cmd.input.Port}` }] };
  return {};
});
vi.mock("@aws-sdk/client-elastic-load-balancing-v2", async (orig) => {
  const actual = await orig<typeof import("@aws-sdk/client-elastic-load-balancing-v2")>();
  return { ...actual, ElasticLoadBalancingV2Client: class { send = (c: unknown) => elbSend(c as never); } };
});

const patchDeployment = vi.fn((..._a: unknown[]) => Promise.resolve());
const setAppUrlMock = vi.fn((..._a: unknown[]) => Promise.resolve());
let prior: Record<string, { arn: string; intended_name?: string }> = {};
vi.mock("./backendState.js", () => ({
  recordResourceIntent: () => Promise.resolve("led"),
  markResourceCreated: () => Promise.resolve(),
  findCreatedResource: (_d: string, rt: string) => Promise.resolve(prior[rt] ?? null),
  patchDeployment: (...a: unknown[]) => patchDeployment(...a),
}));
vi.mock("./provisionChain.js", () => ({ registerDriver: () => {}, setAppUrl: (...a: unknown[]) => setAppUrlMock(...a) }));
vi.stubGlobal("setTimeout", ((fn: () => void) => { fn(); return 0 as unknown; }) as typeof setTimeout);

import { acmDriver } from "./acm.js";
import { albDriver } from "./alb.js";
import { route53Driver } from "./route53.js";
import type { ProvisionContext } from "./provisionChain.js";

function ctx(): ProvisionContext {
  return {
    deploymentId: "dep-abcdef123456", projectId: "proj-1", tenantId: "t-1",
    runtimeTarget: "ecs_fargate", klass: "durable", ecrRepoUri: "acct/repo", imageTag: "abc",
    creds: { region: "us-east-1", credentials: undefined },
    scratch: {
      subnetIds: ["subnet-a", "subnet-b"], albSecurityGroupId: "sg-alb",
      targetGroupArn: "arn:tg:1", containerPort: 3004,
    },
  };
}

beforeEach(() => {
  acmSent.length = 0; r53Sent.length = 0; elbSent.length = 0;
  acmSend.mockClear(); r53Send.mockClear(); elbSend.mockClear();
  patchDeployment.mockClear(); setAppUrlMock.mockClear();
  certStatus = "ISSUED"; certStatusSequence = null; describeIdx = 0; lbExists = false; existingPorts = []; prior = {};
  process.env.GENESIS_DEPLOY_HOSTED_ZONE_ID = "Z-ZONE";
  process.env.GENESIS_DEPLOY_DOMAIN = "deploys.zentriz.com.br";
});
afterEach(() => { delete process.env.GENESIS_DEPLOY_HOSTED_ZONE_ID; delete process.env.GENESIS_DEPLOY_DOMAIN; });

describe("acmDriver", () => {
  it("com zona: pede cert, escreve CNAME de validação e espera ISSUED", async () => {
    certStatusSequence = ["PENDING_VALIDATION", "ISSUED"]; // 1º describe pendente → escreve CNAME; 2º ISSUED
    const c = ctx();
    await acmDriver.provision(c);
    expect(acmSent.some((s) => s.name === "RequestCertificateCommand")).toBe(true);
    expect(r53Sent.some((s) => s.name === "ChangeResourceRecordSetsCommand")).toBe(true);
    expect(c.scratch.acmCertArn).toBe("arn:acm:cert1");
  });

  it("sem hosted zone: no-op (dev/homolog), sem cert", async () => {
    delete process.env.GENESIS_DEPLOY_HOSTED_ZONE_ID;
    const c = ctx();
    await acmDriver.provision(c);
    expect(acmSent.length).toBe(0);
    expect(c.scratch.acmCertArn).toBeUndefined();
  });

  it("cert FAILED → erro", async () => {
    certStatus = "FAILED";
    await expect(acmDriver.provision(ctx())).rejects.toThrow(/ACM_FAILED/);
  });
});

describe("albDriver", () => {
  it("com cert: cria ALB + listener HTTPS:443 + redirect HTTP:80", async () => {
    const c = ctx(); c.scratch.acmCertArn = "arn:acm:cert1";
    await albDriver.provision(c);
    const listeners = elbSent.filter((s) => s.name === "CreateListenerCommand");
    const ports = listeners.map((l) => l.input.Port);
    expect(ports).toContain(443);
    expect(ports).toContain(80);
    const redirect = listeners.find((l) => l.input.Port === 80)!;
    expect((redirect.input.DefaultActions as Array<{ Type: string }>)[0].Type).toBe("redirect");
  });

  it("sem cert: HTTP:80 forward direto + app_url HTTP do ALB", async () => {
    const c = ctx(); // sem acmCertArn
    await albDriver.provision(c);
    const l80 = elbSent.find((s) => s.name === "CreateListenerCommand" && s.input.Port === 80)!;
    expect((l80.input.DefaultActions as Array<{ Type: string }>)[0].Type).toBe("forward");
    expect(setAppUrlMock).toHaveBeenCalledWith("dep-abcdef123456", "http://gen.elb.amazonaws.com", expect.any(String));
  });

  it("idempotência: listener já existe (porta) → não recria", async () => {
    lbExists = true; existingPorts = [80];
    const c = ctx();
    await albDriver.provision(c);
    expect(elbSent.some((s) => s.name === "CreateListenerCommand")).toBe(false);
  });

  it("sem target group → erro claro", async () => {
    const c = ctx(); delete c.scratch.targetGroupArn;
    await expect(albDriver.provision(c)).rejects.toThrow(/NO_TARGET_GROUP/);
  });
});

describe("route53Driver", () => {
  it("com zona + ALB: cria ALIAS A e grava app_url HTTPS", async () => {
    const c = ctx(); c.scratch.albArn = "arn:alb:new";
    await route53Driver.provision(c);
    const change = r53Sent.find((s) => s.name === "ChangeResourceRecordSetsCommand")!;
    const rrs = (change.input.ChangeBatch as { Changes: Array<{ ResourceRecordSet: { Type: string; AliasTarget?: unknown } }> }).Changes[0].ResourceRecordSet;
    expect(rrs.Type).toBe("A");
    expect(rrs.AliasTarget).toBeDefined();
    expect(setAppUrlMock).toHaveBeenCalledWith("dep-abcdef123456",
      "https://dep-abcdef12.deploys.zentriz.com.br", expect.any(String));
  });

  it("sem zona: no-op (mantém app_url HTTP do ALB)", async () => {
    delete process.env.GENESIS_DEPLOY_HOSTED_ZONE_ID;
    const c = ctx(); c.scratch.albArn = "arn:alb:new";
    await route53Driver.provision(c);
    expect(r53Sent.length).toBe(0);
    expect(setAppUrlMock).not.toHaveBeenCalled();
  });
});
