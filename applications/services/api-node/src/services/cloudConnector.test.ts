/**
 * cloudConnector.test.ts — getAwsMonitoringCredentials (fork B, multi-tenant).
 *
 * A função resolve as credenciais AWS da CONTA do tenant para o Genesis propagar ao Deadpool no
 * activate. Cobre:
 *   - conexão com CHAVES ESTÁTICAS → devolve região + o PAYLOAD CIFRADO as-is (nunca a chave em claro),
 *     roleArn/externalId null;
 *   - conexão SÓ-ROLE (assume-role) → roleArn/externalId setados, credentialsEnc null (nada estático);
 *   - precedência de região: a da credencial vence a coluna;
 *   - sem conexão AWS ativa → null (Deadpool cai na identidade default = fork A);
 *   - decrypt FALHA (chave errada) → degradação limpa: devolve só a região da coluna, resto null (não lança).
 *
 * O pool é dublê; o crypto é REAL (cifra com a mesma chave 64-hex que o Deadpool compartilha), então
 * o vetor cifrado aqui é byte-compatível com o que o poller Python decripta.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const HEX_KEY = "a".repeat(64); // chave 64-hex válida (mesma família do teste de crypto)

// Linha corrente devolvida pelo SELECT — controlável por teste.
let currentRow: Record<string, unknown> | undefined;
const queryMock = vi.fn(async () => ({ rows: currentRow ? [currentRow] : [] }));

vi.mock("../db/client.js", () => ({
  pool: {
    connect: async () => ({ query: queryMock, release: () => undefined }),
  },
}));

import { getAwsMonitoringCredentials, getAwsDeployCredentials } from "./cloudConnector.js";
import { encryptCredentials } from "./crypto.js";

/** Cifra um objeto de credencial e o mapeia para as colunas de tenant_cloud_connections. */
function rowFromCreds(obj: Record<string, unknown>, region: string | null): Record<string, unknown> {
  const p = encryptCredentials(JSON.stringify(obj));
  return {
    id: "conn-1",
    provider: "aws",
    region,
    encrypted_credentials: p.encrypted,
    encryption_iv: p.iv,
    encryption_tag: p.tag,
  };
}

describe("getAwsMonitoringCredentials (fork B)", () => {
  const saved = { key: process.env.CREDENTIALS_ENCRYPTION_KEY, prev: process.env.CREDENTIALS_ENCRYPTION_KEY_PREV };
  beforeEach(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = HEX_KEY;
    delete process.env.CREDENTIALS_ENCRYPTION_KEY_PREV;
    currentRow = undefined;
    queryMock.mockClear();
  });
  afterEach(() => {
    if (saved.key) process.env.CREDENTIALS_ENCRYPTION_KEY = saved.key; else delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    if (saved.prev) process.env.CREDENTIALS_ENCRYPTION_KEY_PREV = saved.prev; else delete process.env.CREDENTIALS_ENCRYPTION_KEY_PREV;
  });

  it("chaves estáticas → região + ciphertext as-is, sem role", async () => {
    currentRow = rowFromCreds(
      { accessKeyId: "AKIA123", secretAccessKey: "s3cr3t", region: "sa-east-1" },
      "sa-east-1",
    );
    const out = await getAwsMonitoringCredentials("t1");
    expect(out).not.toBeNull();
    expect(out!.region).toBe("sa-east-1");
    expect(out!.roleArn).toBeNull();
    expect(out!.externalId).toBeNull();
    // Encaminha o payload CIFRADO (nunca as chaves em claro).
    expect(out!.credentialsEnc).toEqual({
      encrypted: currentRow.encrypted_credentials,
      iv: currentRow.encryption_iv,
      tag: currentRow.encryption_tag,
    });
    // Nada de chave/secret em claro no que sai.
    expect(JSON.stringify(out)).not.toContain("s3cr3t");
    expect(JSON.stringify(out)).not.toContain("AKIA123");
  });

  it("conexão só-role (assume-role) → roleArn/externalId setados, credentialsEnc null", async () => {
    currentRow = rowFromCreds(
      { roleArn: "arn:aws:iam::297088704104:role/deadpool", externalId: "ext-9", region: "sa-east-1" },
      "sa-east-1",
    );
    const out = await getAwsMonitoringCredentials("t1");
    expect(out!.roleArn).toBe("arn:aws:iam::297088704104:role/deadpool");
    expect(out!.externalId).toBe("ext-9");
    expect(out!.credentialsEnc).toBeNull(); // sem chaves estáticas → nada a propagar
    expect(out!.region).toBe("sa-east-1");
  });

  it("região da credencial tem precedência sobre a coluna", async () => {
    currentRow = rowFromCreds(
      { accessKeyId: "AKIA", secretAccessKey: "sk", region: "us-west-2" },
      "sa-east-1", // coluna difere da credencial
    );
    const out = await getAwsMonitoringCredentials("t1");
    expect(out!.region).toBe("us-west-2");
  });

  it("sem conexão AWS ativa → null (Deadpool usa identidade default)", async () => {
    currentRow = undefined;
    expect(await getAwsMonitoringCredentials("t1")).toBeNull();
  });

  it("decrypt falha (chave errada) → degradação limpa: só a região da coluna, resto null", async () => {
    currentRow = rowFromCreds({ accessKeyId: "AKIA", secretAccessKey: "sk" }, "sa-east-1");
    // Rotaciona a chave para uma que NÃO decripta o payload; sem PREV → decrypt falha.
    process.env.CREDENTIALS_ENCRYPTION_KEY = "c".repeat(64);
    delete process.env.CREDENTIALS_ENCRYPTION_KEY_PREV;
    const out = await getAwsMonitoringCredentials("t1");
    expect(out).toEqual({ region: "sa-east-1", roleArn: null, externalId: null, credentialsEnc: null });
  });

  it("connectionId específico é passado no WHERE (scoped ao tenant)", async () => {
    currentRow = rowFromCreds({ accessKeyId: "AKIA", secretAccessKey: "sk", region: "sa-east-1" }, "sa-east-1");
    await getAwsMonitoringCredentials("t1", "conn-xyz");
    const [sql, params] = queryMock.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("id = $1");
    expect(params).toEqual(["conn-xyz", "t1"]);
  });
});

describe("getAwsDeployCredentials (BYOC — credencial DECIFRADA p/ push)", () => {
  const saved = { key: process.env.CREDENTIALS_ENCRYPTION_KEY, prev: process.env.CREDENTIALS_ENCRYPTION_KEY_PREV };
  beforeEach(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = HEX_KEY;
    delete process.env.CREDENTIALS_ENCRYPTION_KEY_PREV;
    currentRow = undefined;
    queryMock.mockClear();
  });
  afterEach(() => {
    if (saved.key) process.env.CREDENTIALS_ENCRYPTION_KEY = saved.key; else delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    if (saved.prev) process.env.CREDENTIALS_ENCRYPTION_KEY_PREV = saved.prev; else delete process.env.CREDENTIALS_ENCRYPTION_KEY_PREV;
  });

  it("chaves estáticas → devolve accessKeyId/secret DECIFRADOS + região", async () => {
    currentRow = rowFromCreds(
      { accessKeyId: "AKIATENANT", secretAccessKey: "s3cr3t", region: "eu-west-1" },
      "eu-west-1",
    );
    const out = await getAwsDeployCredentials("t1");
    expect(out).toEqual({
      accessKeyId: "AKIATENANT",
      secretAccessKey: "s3cr3t",
      region: "eu-west-1",
      roleArn: null,
    });
  });

  it("conexão só-role → chaves vazias + roleArn setado (a política bloqueia)", async () => {
    currentRow = rowFromCreds(
      { roleArn: "arn:aws:iam::999:role/x", region: "eu-central-1" },
      "eu-central-1",
    );
    const out = await getAwsDeployCredentials("t1");
    expect(out).toEqual({
      accessKeyId: "",
      secretAccessKey: "",
      region: "eu-central-1",
      roleArn: "arn:aws:iam::999:role/x",
    });
  });

  it("região da credencial vence a coluna", async () => {
    currentRow = rowFromCreds({ accessKeyId: "AKIA", secretAccessKey: "sk", region: "us-west-2" }, "sa-east-1");
    const out = await getAwsDeployCredentials("t1");
    expect(out!.region).toBe("us-west-2");
  });

  it("sem conexão AWS ativa → null", async () => {
    currentRow = undefined;
    expect(await getAwsDeployCredentials("t1")).toBeNull();
  });

  it("decrypt falha → null (tratado como sem-conta; não lança)", async () => {
    currentRow = rowFromCreds({ accessKeyId: "AKIA", secretAccessKey: "sk" }, "sa-east-1");
    process.env.CREDENTIALS_ENCRYPTION_KEY = "c".repeat(64); // chave que não decifra
    delete process.env.CREDENTIALS_ENCRYPTION_KEY_PREV;
    expect(await getAwsDeployCredentials("t1")).toBeNull();
  });

  it("connectionId específico → WHERE scoped ao tenant", async () => {
    currentRow = rowFromCreds({ accessKeyId: "AKIA", secretAccessKey: "sk", region: "sa-east-1" }, "sa-east-1");
    await getAwsDeployCredentials("t1", "conn-xyz");
    const [sql, params] = queryMock.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("id = $1");
    expect(params).toEqual(["conn-xyz", "t1"]);
  });
});
