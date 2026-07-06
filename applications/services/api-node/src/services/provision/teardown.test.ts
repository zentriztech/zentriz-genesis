/**
 * G1-T21: teardown reverso — ordem, drain de ENI, DESTROYED vs DESTROY_FAILED, idempotência.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Estado durável ────────────────────────────────────────────────────────────
const statusLog: string[] = [];
let fullRow: Record<string, unknown> | null;
vi.mock("./backendState.js", () => ({
  getFullDeployment: () => Promise.resolve(fullRow),
  setStatus: (_id: string, s: string) => { statusLog.push(s); return Promise.resolve(); },
  listLiveResources: () => Promise.resolve([]),
  markResourceDeleted: () => Promise.resolve(),
}));
vi.mock("./awsCredentials.js", () => ({
  resolveAwsCredentials: () => Promise.resolve({ region: "us-east-1", credentials: undefined }),
}));

// ── driver teardown order: instrumenta getDriver p/ registrar chamadas ─────────
const teardownOrder: string[] = [];
function fakeDriver(key: string) {
  return { key, status: "provisioning", provision: () => Promise.resolve(),
    teardown: () => { teardownOrder.push(key); return Promise.resolve(); } };
}
vi.mock("./provisionChain.js", () => ({
  CHAIN_ORDER: ["iam", "networking", "rds", "secrets", "migrating", "ecs", "acm", "alb", "route53"],
  getDriver: (k: string) => fakeDriver(k), // todos têm teardown
}));
vi.mock("./drivers.js", () => ({}));

// ── EC2 (drain ENIs) ────────────────────────────────────────────────────────
let eniCountSequence: number[] = [0];
let eniIdx = 0;
const ec2Send = vi.fn(async (cmd: { constructor: { name: string } }) => {
  if (cmd.constructor.name === "DescribeNetworkInterfacesCommand") {
    const n = eniCountSequence[Math.min(eniIdx++, eniCountSequence.length - 1)];
    return { NetworkInterfaces: Array.from({ length: n }, () => ({})) };
  }
  return {};
});
vi.mock("./awsClients.js", () => ({ ec2Client: () => ({ send: ec2Send }) }));

// ── RGTA sweep ──────────────────────────────────────────────────────────────
let sweepArns: string[] = [];
const rgtaSend = vi.fn(async (_c?: unknown): Promise<{ ResourceTagMappingList: Array<{ ResourceARN: string }>; PaginationToken: string }> =>
  ({ ResourceTagMappingList: sweepArns.map((a) => ({ ResourceARN: a })), PaginationToken: "" }));
vi.mock("@aws-sdk/client-resource-groups-tagging-api", () => ({
  ResourceGroupsTaggingAPIClient: class { send = (c: unknown) => rgtaSend(c); },
  GetResourcesCommand: class { input: unknown; constructor(input?: unknown) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-ec2", () => ({ DescribeNetworkInterfacesCommand: class { input: unknown; constructor(input?: unknown) { this.input = input; } } }));
vi.stubGlobal("setTimeout", ((fn: () => void) => { fn(); return 0 as unknown; }) as typeof setTimeout);

import { teardownDeployment } from "./teardown.js";

function row(): Record<string, unknown> {
  return {
    id: "dep-1", project_id: "proj-1", tenant_id: "t-1", provider: "aws",
    runtime_target: "ecs_fargate", class: "durable", ecr_repo_uri: "r", image_tag: "t",
    app_url: null, health_url: null, status: "running", error_msg: null,
    cluster_arn: "genesis", service_arn: "arn:svc", target_group_arn: "arn:tg", alb_arn: "arn:alb",
    vpc_id: "vpc-1", subnet_ids: ["s-a", "s-b"], security_group_ids: ["sg-alb", "sg-task"],
    rds_arn: "arn:rds", secret_arn: "arn:sec", acm_cert_arn: "arn:acm",
    route53_record: "app.deploys", iam_role_path: "/genesis/dep-1/",
  };
}

beforeEach(() => {
  statusLog.length = 0; teardownOrder.length = 0; ec2Send.mockClear(); rgtaSend.mockClear();
  fullRow = row(); sweepArns = []; eniCountSequence = [0]; eniIdx = 0;
});

describe("teardownDeployment", () => {
  it("chama teardown na ORDEM REVERSA da cadeia (route53 → … → iam)", async () => {
    await teardownDeployment("dep-1");
    expect(teardownOrder).toEqual(["route53", "alb", "acm", "ecs", "migrating", "secrets", "rds", "networking", "iam"]);
  });

  it("marca DESTROYED quando a varredura final está vazia", async () => {
    sweepArns = [];
    const r = await teardownDeployment("dep-1");
    expect(r.ok).toBe(true);
    expect(statusLog).toContain("destroying");
    expect(statusLog[statusLog.length - 1]).toBe("destroyed");
  });

  it("marca DESTROY_FAILED quando sobra recurso na varredura", async () => {
    sweepArns = ["arn:aws:rds:...:db:leftover"];
    const r = await teardownDeployment("dep-1");
    expect(r.ok).toBe(false);
    expect(r.remaining).toContain("arn:aws:rds:...:db:leftover");
    expect(statusLog[statusLog.length - 1]).toBe("destroy_failed");
  });

  it("drena ENIs entre ecs e networking (poll até zerar)", async () => {
    eniCountSequence = [2, 1, 0]; // 2 ENIs → 1 → 0
    await teardownDeployment("dep-1");
    // DescribeNetworkInterfaces chamado ao menos 3x (poll)
    expect(ec2Send.mock.calls.length).toBeGreaterThanOrEqual(3);
    // networking (SG delete) só depois do ecs no order
    expect(teardownOrder.indexOf("ecs")).toBeLessThan(teardownOrder.indexOf("networking"));
  });

  it("deployment ausente no DB → no-op ok (idempotente)", async () => {
    fullRow = null;
    const r = await teardownDeployment("dep-x");
    expect(r.ok).toBe(true);
    expect(statusLog.length).toBe(0);
  });
});
