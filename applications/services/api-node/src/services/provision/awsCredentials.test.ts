/**
 * G1-T1: awsCredentials — testa o seam de credencial plugável.
 * Estrutural (determinístico) + smoke STS opcional (só com credenciais reais).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  AmbientCredentialProvider,
  getCredentialProvider,
  setCredentialProvider,
  resolveAwsCredentials,
  defaultRegion,
  type AwsCredentialProvider,
} from "./awsCredentials.js";

describe("awsCredentials seam", () => {
  beforeEach(() => {
    // reset para o default (Ambient) entre testes
    setCredentialProvider(new AmbientCredentialProvider());
  });

  it("GATE 1: provider default é ambient", () => {
    expect(getCredentialProvider().kind).toBe("ambient");
  });

  it("AmbientCredentialProvider resolve região e credentials undefined (cadeia default do SDK)", async () => {
    const r = await new AmbientCredentialProvider().resolve();
    expect(typeof r.region).toBe("string");
    expect(r.region.length).toBeGreaterThan(0);
    expect(r.credentials).toBeUndefined(); // deixa o SDK usar a cadeia default
  });

  it("respeita região explícita do contexto", async () => {
    const r = await resolveAwsCredentials({ region: "sa-east-1" });
    expect(r.region).toBe("sa-east-1");
  });

  it("defaultRegion cai em us-east-1 quando nenhuma env está setada", () => {
    const saved = {
      p: process.env.GENESIS_PROVISION_REGION, g: process.env.GENESIS_AWS_REGION,
      a: process.env.AWS_REGION, s: process.env.AWS_S3_DEPLOY_REGION,
    };
    delete process.env.GENESIS_PROVISION_REGION; delete process.env.GENESIS_AWS_REGION;
    delete process.env.AWS_REGION; delete process.env.AWS_S3_DEPLOY_REGION;
    try {
      expect(defaultRegion()).toBe("us-east-1");
    } finally {
      if (saved.p) process.env.GENESIS_PROVISION_REGION = saved.p;
      if (saved.g) process.env.GENESIS_AWS_REGION = saved.g;
      if (saved.a) process.env.AWS_REGION = saved.a;
      if (saved.s) process.env.AWS_S3_DEPLOY_REGION = saved.s;
    }
  });

  it("SEAM GATE 2: setCredentialProvider troca o provider sem tocar os drivers", async () => {
    const fake: AwsCredentialProvider = {
      kind: "assume-role-fake",
      async resolve() {
        return {
          region: "us-east-1",
          credentials: { accessKeyId: "AKIAFAKE", secretAccessKey: "secret", sessionToken: "tok" },
          accountId: "999999999999",
        };
      },
    };
    setCredentialProvider(fake);
    expect(getCredentialProvider().kind).toBe("assume-role-fake");
    const r = await resolveAwsCredentials({ tenantId: "t1", deploymentId: "d1" });
    expect(r.accountId).toBe("999999999999");
    expect((r.credentials as { accessKeyId: string }).accessKeyId).toBe("AKIAFAKE");
  });
});

// Smoke opcional: só roda se houver credenciais AWS reais no ambiente.
// Prova o critério de aceitação (sts:GetCallerIdentity → accountId).
describe.skipIf(!process.env.RUN_AWS_SMOKE)("awsCredentials STS smoke (real AWS)", () => {
  it("resolve e chama GetCallerIdentity", async () => {
    const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
    const r = await resolveAwsCredentials();
    const sts = new STSClient({ region: r.region, credentials: r.credentials });
    const id = await sts.send(new GetCallerIdentityCommand({}));
    expect(id.Account).toMatch(/^\d{12}$/);
    // eslint-disable-next-line no-console
    console.log("[smoke] conta AWS resolvida:", id.Account, "region:", r.region);
  });
});
