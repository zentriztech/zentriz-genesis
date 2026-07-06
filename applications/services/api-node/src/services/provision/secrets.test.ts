/**
 * G1-T15: driver secrets — app secret com DATABASE_URL+JWT_SECRET, grant escopado no exec role.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const smSent: Array<{ name: string; input: Record<string, unknown> }> = [];
const smSend = vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
  const name = cmd.constructor.name;
  smSent.push({ name, input: cmd.input });
  if (name === "CreateSecretCommand") return { ARN: "arn:aws:secretsmanager:us-east-1:1:secret:genesis/app" };
  if (name === "GetSecretValueCommand") return { ARN: "arn:aws:secretsmanager:us-east-1:1:secret:genesis/app", SecretString: "{}" };
  return {};
});
vi.mock("@aws-sdk/client-secrets-manager", async (orig) => {
  const actual = await orig<typeof import("@aws-sdk/client-secrets-manager")>();
  return { ...actual, SecretsManagerClient: class { send = (c: unknown) => smSend(c as never); } };
});

const iamSent: Array<{ name: string; input: Record<string, unknown> }> = [];
const iamSend = vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
  iamSent.push({ name: cmd.constructor.name, input: cmd.input }); return {};
});
vi.mock("@aws-sdk/client-iam", async (orig) => {
  const actual = await orig<typeof import("@aws-sdk/client-iam")>();
  return { ...actual, IAMClient: class { send = (c: unknown) => iamSend(c as never); } };
});

const patchDeployment = vi.fn((..._a: unknown[]) => Promise.resolve());
let prior: { arn: string } | null = null;
vi.mock("./backendState.js", () => ({
  recordResourceIntent: () => Promise.resolve("led"),
  markResourceCreated: () => Promise.resolve(),
  findCreatedResource: () => Promise.resolve(prior),
  patchDeployment: (...a: unknown[]) => patchDeployment(...a),
}));
vi.mock("./provisionChain.js", () => ({ registerDriver: () => {} }));

import { secretsDriver } from "./secrets.js";
import type { ProvisionContext } from "./provisionChain.js";

function ctx(): ProvisionContext {
  return {
    deploymentId: "dep-abcdef123456", projectId: "proj-1", tenantId: "t-1",
    runtimeTarget: "ecs_fargate", klass: "durable", ecrRepoUri: "acct/repo", imageTag: "abc",
    creds: { region: "us-east-1", credentials: undefined },
    scratch: {
      databaseUrl: "postgresql://genesis:pw@db.abc:5432/appdb",
      executionRoleName: "genesis-exec-dep-abcdef1", containerPort: 3004,
    },
  };
}

beforeEach(() => { smSent.length = 0; iamSent.length = 0; smSend.mockClear(); iamSend.mockClear(); prior = null; patchDeployment.mockClear(); });

describe("secretsDriver.provision", () => {
  it("cria app secret com DATABASE_URL + JWT_SECRET + NODE_ENV=production", async () => {
    const c = ctx();
    await secretsDriver.provision(c);
    const create = smSent.find((s) => s.name === "CreateSecretCommand")!;
    const val = JSON.parse(create.input.SecretString as string);
    expect(val.DATABASE_URL).toContain("postgresql://");
    expect(val.JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(val.NODE_ENV).toBe("production");
    expect(c.scratch.appSecretArn).toContain("secret:genesis/app");
  });

  it("escopa o grant de GetSecretValue ao ARN do secret no exec role", async () => {
    await secretsDriver.provision(ctx());
    const put = iamSent.find((s) => s.name === "PutRolePolicyCommand")!;
    expect(put.input.RoleName).toBe("genesis-exec-dep-abcdef1");
    const doc = put.input.PolicyDocument as string;
    expect(doc).toContain("secretsmanager:GetSecretValue");
    expect(doc).toContain("secret:genesis/app"); // Resource = ARN exato (não *)
    expect(doc).toContain("kms:Decrypt");
  });

  it("persiste secret_arn no deployment", async () => {
    await secretsDriver.provision(ctx());
    expect(patchDeployment).toHaveBeenCalledWith("dep-abcdef123456", expect.objectContaining({ secret_arn: expect.stringContaining("secret:genesis/app") }));
  });

  it("idempotência: secret já no ledger → PutSecretValue, não CreateSecret", async () => {
    prior = { arn: "arn:aws:secretsmanager:us-east-1:1:secret:genesis/app" };
    await secretsDriver.provision(ctx());
    expect(smSent.some((s) => s.name === "CreateSecretCommand")).toBe(false);
    expect(smSent.some((s) => s.name === "PutSecretValueCommand")).toBe(true);
  });
});
