/**
 * G1-T15: driver rds — idempotência por identifier, poll até available, senha via secret.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const rdsSent: Array<{ name: string; input: Record<string, unknown> }> = [];
let instanceState: string | null = null; // null = not found
let describeCalls = 0;

const rdsSend = vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
  const name = cmd.constructor.name;
  rdsSent.push({ name, input: cmd.input });
  if (name === "DescribeDBSubnetGroupsCommand") {
    const e = new Error("nf"); (e as { name: string }).name = "DBSubnetGroupNotFoundFault"; throw e;
  }
  if (name === "CreateDBSubnetGroupCommand") return {};
  if (name === "CreateDBInstanceCommand") { instanceState = "creating"; return {}; }
  if (name === "DescribeDBInstancesCommand") {
    describeCalls++;
    if (instanceState === null) { const e = new Error("nf"); (e as { name: string }).name = "DBInstanceNotFoundFault"; throw e; }
    // primeira descrição pós-create = creating; depois available
    const status = describeCalls >= 2 ? "available" : instanceState;
    return { DBInstances: [{ DBInstanceStatus: status, DBInstanceArn: "arn:rds:1",
      Endpoint: { Address: "db.abc.rds.amazonaws.com", Port: 5432 } }] };
  }
  return {};
});
vi.mock("@aws-sdk/client-rds", async (orig) => {
  const actual = await orig<typeof import("@aws-sdk/client-rds")>();
  return { ...actual, RDSClient: class { send = (c: unknown) => rdsSend(c as never); } };
});

let secretExists = false;
const smSend = vi.fn(async (cmd: { constructor: { name: string } }) => {
  const name = cmd.constructor.name;
  if (name === "GetSecretValueCommand") {
    if (!secretExists) { const e = new Error("nf"); (e as { name: string }).name = "ResourceNotFoundException"; throw e; }
    return { SecretString: JSON.stringify({ username: "genesis", password: "storedpw" }), ARN: "arn:sec:db" };
  }
  if (name === "CreateSecretCommand") { secretExists = true; return { ARN: "arn:sec:db" }; }
  return {};
});
vi.mock("@aws-sdk/client-secrets-manager", async (orig) => {
  const actual = await orig<typeof import("@aws-sdk/client-secrets-manager")>();
  return { ...actual, SecretsManagerClient: class { send = (c: unknown) => smSend(c as never); } };
});

const patchDeployment = vi.fn((..._a: unknown[]) => Promise.resolve());
let prior: Record<string, { arn: string }> = {};
vi.mock("./backendState.js", () => ({
  recordResourceIntent: () => Promise.resolve("led"),
  markResourceCreated: () => Promise.resolve(),
  findCreatedResource: (_d: string, rt: string) => Promise.resolve(prior[rt] ?? null),
  patchDeployment: (...a: unknown[]) => patchDeployment(...a),
}));
vi.mock("./provisionChain.js", () => ({ registerDriver: () => {} }));

// Acelera o poll (evita 15s reais).
vi.stubGlobal("setTimeout", ((fn: () => void) => { fn(); return 0 as unknown; }) as typeof setTimeout);

import { rdsDriver } from "./rds.js";
import type { ProvisionContext } from "./provisionChain.js";

function ctx(): ProvisionContext {
  return {
    deploymentId: "dep-abcdef123456", projectId: "proj-1", tenantId: "t-1",
    runtimeTarget: "ecs_fargate", klass: "durable", ecrRepoUri: "acct/repo", imageTag: "abc",
    creds: { region: "us-east-1", credentials: undefined },
    scratch: { subnetIds: ["subnet-a", "subnet-b"], taskSecurityGroupId: "sg-task", containerPort: 3004 },
  };
}

beforeEach(() => {
  rdsSent.length = 0; rdsSend.mockClear(); smSend.mockClear();
  instanceState = null; describeCalls = 0; secretExists = false; prior = {}; patchDeployment.mockClear();
});

describe("rdsDriver.provision", () => {
  it("cria RDS PG16 db.t3.micro e monta DATABASE_URL", async () => {
    const c = ctx();
    await rdsDriver.provision(c);
    const create = rdsSent.find((s) => s.name === "CreateDBInstanceCommand");
    expect(create).toBeDefined();
    expect(create!.input.Engine).toBe("postgres");
    expect(create!.input.DBInstanceClass).toBe("db.t3.micro");
    expect(c.scratch.databaseUrl).toMatch(/^postgresql:\/\/genesis:.*@db\.abc\.rds\.amazonaws\.com:5432\/appdb$/);
  });

  it("durable: DeletionProtection ON + backup 7d", async () => {
    await rdsDriver.provision(ctx());
    const create = rdsSent.find((s) => s.name === "CreateDBInstanceCommand")!;
    expect(create.input.DeletionProtection).toBe(true);
    expect(create.input.BackupRetentionPeriod).toBe(7);
  });

  it("demo (DM-T9): NÃO cria RDS — DB é sidecar na task; seta DATABASE_URL localhost", async () => {
    const c = ctx(); c.klass = "demo";
    await rdsDriver.provision(c);
    // demo não provisiona RDS gerenciado (barato + descartável via sidecar no ecsFargate).
    expect(rdsSent.some((s) => s.name === "CreateDBInstanceCommand")).toBe(false);
    expect(c.scratch.databaseUrl).toBe("postgresql://genesis:demo@localhost:5432/appdb");
    expect(c.scratch.demoDbName).toBe("appdb");
  });

  it("idempotência: instância já existente NÃO é recriada", async () => {
    instanceState = "available"; // já existe e available
    await rdsDriver.provision(ctx());
    expect(rdsSent.some((s) => s.name === "CreateDBInstanceCommand")).toBe(false);
    expect(patchDeployment).toHaveBeenCalled();
  });

  it("senha reusa a do secret quando já existe (resume-safe)", async () => {
    secretExists = true; // db-master já gravado
    const c = ctx();
    await rdsDriver.provision(c);
    expect(c.scratch.rdsPassword).toBe("storedpw");
  });
});
