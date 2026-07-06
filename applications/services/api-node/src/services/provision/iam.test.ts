/**
 * G1-T13: driver IAM — path determinístico, idempotência, secret grant, boundary seam.
 * Mocka o IAMClient e o ledger (sem AWS, sem DB).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Captura os comandos enviados ao IAMClient.
const sent: unknown[] = [];
const sendMock = vi.fn(async (cmd: { constructor: { name: string } }) => {
  const name = cmd.constructor.name;
  if (name === "CreateRoleCommand") {
    return { Role: { Arn: `arn:aws:iam::123456789012:role/x` } };
  }
  if (name === "GetRoleCommand") return { Role: { Arn: `arn:aws:iam::123456789012:role/x` } };
  if (name === "ListRolePoliciesCommand") return { PolicyNames: ["genesis-exec"] };
  return {};
});
vi.mock("@aws-sdk/client-iam", async (orig) => {
  const actual = await orig<typeof import("@aws-sdk/client-iam")>();
  return { ...actual, IAMClient: class { send = (c: unknown) => { sent.push(c); return sendMock(c as never); }; } };
});

const recordResourceIntent = vi.fn((..._a: unknown[]) => Promise.resolve("led-1"));
const markResourceCreated = vi.fn((..._a: unknown[]) => Promise.resolve());
let priorResource: { arn: string } | null = null;
vi.mock("./backendState.js", () => ({
  recordResourceIntent: (...a: unknown[]) => recordResourceIntent(...a),
  markResourceCreated: (...a: unknown[]) => markResourceCreated(...a),
  findCreatedResource: () => Promise.resolve(priorResource),
}));
// provisionChain precisa expor registerDriver (o driver se registra no import).
vi.mock("./provisionChain.js", () => ({ registerDriver: () => {} }));

import { iamDriver, rolePath } from "./iam.js";
import type { ProvisionContext } from "./provisionChain.js";

function ctx(): ProvisionContext {
  return {
    deploymentId: "dep-abcdef123456", projectId: "proj-1", tenantId: "t-1",
    runtimeTarget: "ecs_fargate", klass: "durable", ecrRepoUri: "acct/repo",
    imageTag: "abc", creds: { region: "us-east-1", credentials: undefined }, scratch: {},
  };
}

beforeEach(() => {
  sent.length = 0; sendMock.mockClear(); recordResourceIntent.mockClear();
  markResourceCreated.mockClear(); priorResource = null;
  delete process.env.GENESIS_PERMISSIONS_BOUNDARY_ARN;
});

describe("rolePath", () => {
  it("path determinístico /genesis/<id>/", () => {
    expect(rolePath("dep-1")).toBe("/genesis/dep-1/");
  });
});

describe("iamDriver.provision", () => {
  it("cria execution + task role sob o path e expõe ARNs no scratch", async () => {
    const c = ctx();
    await iamDriver.provision(c);
    const creates = sent.filter((s) => (s as { constructor: { name: string } }).constructor.name === "CreateRoleCommand");
    expect(creates.length).toBe(2);
    // ambas sob o path do deployment
    for (const cr of creates) {
      expect((cr as { input: { Path: string } }).input.Path).toBe("/genesis/dep-abcdef123456/");
    }
    expect(c.scratch.executionRoleArn).toBeTruthy();
    expect(c.scratch.taskRoleArn).toBeTruthy();
    expect(c.scratch.iamRolePath).toBe("/genesis/dep-abcdef123456/");
  });

  it("execution role recebe policy inline com ECR pull + logs", async () => {
    await iamDriver.provision(ctx());
    const putPol = sent.find((s) => (s as { constructor: { name: string } }).constructor.name === "PutRolePolicyCommand");
    expect(putPol).toBeDefined();
    const doc = (putPol as { input: { PolicyDocument: string } }).input.PolicyDocument;
    expect(doc).toContain("ecr:BatchGetImage");
    expect(doc).toContain("logs:PutLogEvents");
  });

  it("idempotência: role já criada (ledger) → não recria", async () => {
    priorResource = { arn: "arn:aws:iam::123456789012:role/existing" };
    const c = ctx();
    await iamDriver.provision(c);
    const creates = sent.filter((s) => (s as { constructor: { name: string } }).constructor.name === "CreateRoleCommand");
    expect(creates.length).toBe(0); // reusou ambas do ledger
    expect(c.scratch.executionRoleArn).toBe("arn:aws:iam::123456789012:role/existing");
  });

  it("SEAM GATE 2: boundary aplicado quando env presente", async () => {
    process.env.GENESIS_PERMISSIONS_BOUNDARY_ARN = "arn:aws:iam::123456789012:policy/boundary";
    await iamDriver.provision(ctx());
    const create = sent.find((s) => (s as { constructor: { name: string } }).constructor.name === "CreateRoleCommand");
    expect((create as { input: { PermissionsBoundary?: string } }).input.PermissionsBoundary)
      .toBe("arn:aws:iam::123456789012:policy/boundary");
  });

  it("sem boundary (GATE 1): PermissionsBoundary undefined", async () => {
    await iamDriver.provision(ctx());
    const create = sent.find((s) => (s as { constructor: { name: string } }).constructor.name === "CreateRoleCommand");
    expect((create as { input: { PermissionsBoundary?: string } }).input.PermissionsBoundary).toBeUndefined();
  });
});
