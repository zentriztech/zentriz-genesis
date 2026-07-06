/**
 * awsClients.ts — G1-T13 (Fase C). Fábrica de clients AWS SDK v3 p/ os drivers.
 *
 * Todo driver obtém seus clients daqui, passando o `ResolvedAwsCredentials` do
 * ProvisionContext (resolvido pelo seam de credencial G1-T1). Assim nenhum driver
 * lê env de credencial diretamente, e o GATE 2 (assume-role) já flui sem reescrita.
 */

import { IAMClient } from "@aws-sdk/client-iam";
import { STSClient } from "@aws-sdk/client-sts";
import { EC2Client } from "@aws-sdk/client-ec2";
import type { ResolvedAwsCredentials } from "./awsCredentials.js";

type CredsInput = {
  region: string;
  credentials?: ResolvedAwsCredentials["credentials"];
};

function base(creds: ResolvedAwsCredentials): CredsInput {
  // credentials undefined (GATE 1 ambient) → SDK usa a cadeia default. Correto.
  return { region: creds.region, credentials: creds.credentials };
}

export function iamClient(creds: ResolvedAwsCredentials): IAMClient {
  // IAM é global; região não afeta, mas o SDK exige uma. Usa a do contexto.
  return new IAMClient(base(creds));
}

export function stsClient(creds: ResolvedAwsCredentials): STSClient {
  return new STSClient(base(creds));
}

export function ec2Client(creds: ResolvedAwsCredentials): EC2Client {
  return new EC2Client(base(creds));
}

/** Retry com backoff exponencial (1s,2s,4s...) — cobre eventual-consistency de IAM. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; retryable: (err: unknown) => boolean; label?: string } = { retryable: () => false },
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts - 1 || !opts.retryable(err)) throw err;
      const backoffMs = 1000 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}
