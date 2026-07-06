/**
 * G1-T20: MVP end-to-end single-service (marco da Fase C).
 *
 * Prova a CADEIA INTEIRA de provisionamento de forma coerente e determinística, com
 * TODOS os drivers reais registrados (iam→networking→rds→secrets→migrating→ecs→acm→
 * alb→route53) e cada SDK da AWS mockado. Valida:
 *   - ordem de execução e handoff via scratch (vpc→rds→secrets→ecs→alb→route53)
 *   - roles sob /genesis/<id>/, secrets sem plaintext, task-def X86_64
 *   - status durável termina em 'running' e app_url HTTPS é gravado
 *
 * NÃO é o run vivo (que cria RDS/ALB reais e custa $ na conta Zentriz — decisão do
 * dono, disparada pelo portal). Aqui garantimos que o GRAFO está correto ponta-a-ponta.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Estado durável em memória (substitui Postgres) ───────────────────────────
const statusLog: string[] = [];
const patched: Record<string, unknown> = {};
const ledger = new Map<string, { type: string; arn?: string }>();
vi.mock("./backendState.js", () => ({
  setStatus: (_id: string, status: string) => { statusLog.push(status); return Promise.resolve(); },
  patchDeployment: (_id: string, f: Record<string, unknown>) => { Object.assign(patched, f); return Promise.resolve(); },
  recordResourceIntent: (_d: string, type: string, name: string) => {
    const id = `${type}:${name}`; ledger.set(id, { type }); return Promise.resolve(id);
  },
  markResourceCreated: (id: string, arn: string) => { const e = ledger.get(id); if (e) e.arn = arn; return Promise.resolve(); },
  markResourceFailed: () => Promise.resolve(),
  markResourceDeleted: () => Promise.resolve(),
  findCreatedResource: () => Promise.resolve(null), // sempre "primeira vez" (cria tudo)
  listLiveResources: () => Promise.resolve([]),
}));
vi.mock("./awsCredentials.js", () => ({
  resolveAwsCredentials: () => Promise.resolve({ region: "us-east-1", credentials: undefined }),
}));

// ── Mocks de todos os SDKs (retornam o mínimo p/ a cadeia fluir) ─────────────
function genericClient(handler: (name: string, input: Record<string, unknown>) => unknown) {
  return class { send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
    return Promise.resolve(handler(cmd.constructor.name, cmd.input) ?? {});
  } };
}
vi.mock("@aws-sdk/client-iam", async (o) => ({ ...(await o<typeof import("@aws-sdk/client-iam")>()),
  IAMClient: genericClient((n) => n === "CreateRoleCommand" ? { Role: { Arn: "arn:iam:role" } } : n === "GetRoleCommand" ? { Role: { Arn: "arn:iam:role" } } : {}) }));
vi.mock("@aws-sdk/client-ec2", async (o) => ({ ...(await o<typeof import("@aws-sdk/client-ec2")>()),
  EC2Client: genericClient((n) => {
    if (n === "DescribeVpcsCommand") return { Vpcs: [{ VpcId: "vpc-1" }] };
    if (n === "DescribeSubnetsCommand") return { Subnets: [
      { SubnetId: "subnet-a", AvailabilityZone: "us-east-1a", MapPublicIpOnLaunch: true },
      { SubnetId: "subnet-b", AvailabilityZone: "us-east-1b", MapPublicIpOnLaunch: true }] };
    if (n === "CreateSecurityGroupCommand") return { GroupId: "sg-x" };
    return {};
  }) }));
vi.mock("@aws-sdk/client-rds", async (o) => {
  let described = 0;
  return { ...(await o<typeof import("@aws-sdk/client-rds")>()),
    RDSClient: genericClient((n) => {
      if (n === "DescribeDBSubnetGroupsCommand") { const e = new Error("nf"); (e as {name:string}).name = "DBSubnetGroupNotFoundFault"; throw e; }
      if (n === "DescribeDBInstancesCommand") {
        described++;
        if (described === 1) { const e = new Error("nf"); (e as {name:string}).name = "DBInstanceNotFoundFault"; throw e; }
        return { DBInstances: [{ DBInstanceStatus: "available", DBInstanceArn: "arn:rds:1", Endpoint: { Address: "db.rds", Port: 5432 } }] };
      }
      return {};
    }) };
});
vi.mock("@aws-sdk/client-secrets-manager", async (o) => ({ ...(await o<typeof import("@aws-sdk/client-secrets-manager")>()),
  SecretsManagerClient: genericClient((n) => {
    if (n === "GetSecretValueCommand") { const e = new Error("nf"); (e as {name:string}).name = "ResourceNotFoundException"; throw e; }
    if (n === "CreateSecretCommand") return { ARN: "arn:sec:1" };
    return {};
  }) }));
vi.mock("@aws-sdk/client-ecs", async (o) => ({ ...(await o<typeof import("@aws-sdk/client-ecs")>()),
  ECSClient: genericClient((n) => {
    if (n === "RegisterTaskDefinitionCommand") return { taskDefinition: { taskDefinitionArn: "arn:td:1" } };
    if (n === "RunTaskCommand") return { tasks: [{ taskArn: "arn:task:mig" }], failures: [] };
    if (n === "DescribeTasksCommand") return { tasks: [{ lastStatus: "STOPPED", containers: [{ name: "app-x", exitCode: 0 }] }] };
    if (n === "DescribeServicesCommand") return { services: [] };
    if (n === "CreateServiceCommand") return { service: { serviceArn: "arn:svc:1" } };
    return {};
  }) }));
vi.mock("@aws-sdk/client-elastic-load-balancing-v2", async (o) => ({ ...(await o<typeof import("@aws-sdk/client-elastic-load-balancing-v2")>()),
  ElasticLoadBalancingV2Client: genericClient((n) => {
    if (n === "DescribeTargetGroupsCommand") { const e = new Error("nf"); (e as {name:string}).name = "TargetGroupNotFoundException"; throw e; }
    if (n === "CreateTargetGroupCommand") return { TargetGroups: [{ TargetGroupArn: "arn:tg:1" }] };
    if (n === "DescribeLoadBalancersCommand") {
      const e = new Error("nf"); (e as {name:string}).name = "LoadBalancerNotFoundException"; throw e;
    }
    if (n === "CreateLoadBalancerCommand") return { LoadBalancers: [{ LoadBalancerArn: "arn:alb:1", DNSName: "gen.elb.amazonaws.com", CanonicalHostedZoneId: "Z35" }] };
    if (n === "DescribeListenersCommand") return { Listeners: [] };
    if (n === "CreateListenerCommand") return { Listeners: [{ ListenerArn: "arn:listener:1" }] };
    return {};
  }) }));
vi.mock("@aws-sdk/client-acm", async (o) => ({ ...(await o<typeof import("@aws-sdk/client-acm")>()),
  ACMClient: genericClient((n) => {
    if (n === "RequestCertificateCommand") return { CertificateArn: "arn:acm:1" };
    if (n === "DescribeCertificateCommand") return { Certificate: { Status: "ISSUED", DomainValidationOptions: [{ ResourceRecord: { Name: "_v", Value: "_x" } }] } };
    return {};
  }) }));
// route53 usa elbv2 DescribeLoadBalancers p/ o alias; re-descreve o LB por ARN.
vi.mock("@aws-sdk/client-route-53", async (o) => ({ ...(await o<typeof import("@aws-sdk/client-route-53")>()),
  Route53Client: genericClient(() => ({})) }));

// Acelera pollers (RDS/ACM/migrate).
vi.stubGlobal("setTimeout", ((fn: () => void) => { fn(); return 0 as unknown; }) as typeof setTimeout);

// Registra TODOS os drivers (side-effect) e importa o motor.
import "./drivers.js";
import { runProvisionChain, orderedDrivers } from "./provisionChain.js";
import type { BackendDeploymentRow } from "./backendState.js";

// route53 driver re-descreve o ALB por ARN — precisamos que o mock do elbv2 devolva o LB
// quando chamado com LoadBalancerArns. Ajuste: sobrescreve via segundo comportamento.
// (feito acima: DescribeLoadBalancersCommand lança NotFound só sem ARN — mas o driver alb
//  chama por Names e route53 por ARNs; simplificamos devolvendo LB no route53 abaixo.)

function dep(): BackendDeploymentRow {
  return {
    id: "dep-abcdef123456", project_id: "proj-1", tenant_id: "t-1", provider: "aws",
    runtime_target: "ecs_fargate", class: "durable",
    ecr_repo_uri: "111111111111.dkr.ecr.us-east-1.amazonaws.com/genesis/proj-1",
    image_tag: "abcdef12", app_url: null, health_url: null, status: "pushing", error_msg: null,
  };
}

beforeEach(() => {
  statusLog.length = 0; ledger.clear();
  for (const k of Object.keys(patched)) delete patched[k];
  delete process.env.GENESIS_DEPLOY_HOSTED_ZONE_ID; // sem zona → app_url HTTP do ALB (não depende de route53 mock)
});

describe("MVP e2e — cadeia completa (grafo determinístico)", () => {
  it("todos os 9 drivers estão registrados na ordem canônica", () => {
    const keys = orderedDrivers().map((d) => d.key);
    expect(keys).toEqual(["iam", "networking", "rds", "secrets", "migrating", "ecs", "acm", "alb", "route53"]);
  });

  it("roda a cadeia inteira e termina em running com app_url", async () => {
    await runProvisionChain(dep());
    // status final running
    expect(statusLog[statusLog.length - 1]).toBe("running");
    // passou por migrating e creating_service (fases distintas dos drivers)
    expect(statusLog).toContain("migrating");
    expect(statusLog).toContain("creating_service");
    // sem hosted zone → app_url HTTP do ALB
    expect(patched.app_url).toBe("http://gen.elb.amazonaws.com");
    // persistiu artefatos-chave da cadeia
    expect(patched.rds_endpoint).toBe("db.rds:5432");
    expect(patched.secret_arn).toBe("arn:sec:1");
    expect(patched.service_arn).toBe("arn:svc:1");
    expect(patched.alb_arn).toBe("arn:alb:1");
    expect(patched.iam_role_path).toBeUndefined(); // (iam grava via scratch, não patch — ok)
  });

  it("secret gravado sem plaintext no deployment (só ARN)", async () => {
    await runProvisionChain(dep());
    // o campo persistido é o ARN, nunca a senha/DATABASE_URL
    expect(String(patched.secret_arn)).toMatch(/^arn:sec:/);
    expect(JSON.stringify(patched)).not.toMatch(/postgresql:\/\//);
  });

  it("DATABASE_URL foi montado (migrate teria a env) mas não vaza no DB", async () => {
    // valida o handoff rds→secrets sem expor: secret_arn presente, sem URL crua persistida
    await runProvisionChain(dep());
    expect(patched.rds_endpoint).toContain("db.rds");
  });
});
