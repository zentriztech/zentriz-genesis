/**
 * awsCredentials.ts — SEAM de credencial AWS para provisionamento de backend.
 *
 * Este é o ÚNICO ponto por onde os drivers de provisão (ecr/ecs/rds/iam/alb/acm/
 * route53/secrets/networking/teardown) obtêm credenciais. Os drivers NUNCA sabem
 * de onde a credencial vem — só consomem o set resolvido. Isso torna o GATE 2
 * (cross-account role de terceiro) um PLUG-IN, não uma reescrita:
 *
 *   GATE 1 (conta da própria Zentriz)  → AmbientCredentialProvider (cadeia default do SDK)
 *   GATE 2 (conta AWS do tenant)       → AssumeRoleCredentialProvider (sts:AssumeRole +
 *                                        externalId, fresh a partir do principal BASE,
 *                                        com refresh-before-expiry) — a implementar no GATE 2.
 *
 * Ver docs/05-analyses/2026-07-04-backend-provisioning-plan/ (§14/§16, tarefa G1-T1).
 */

import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@aws-sdk/types";

export interface CredentialContext {
  /** Tenant dono do deployment (usado pelo provider do GATE 2 para achar a role). */
  tenantId?: string | null;
  /** Deployment sendo provisionado — para RoleSessionName determinístico no GATE 2. */
  deploymentId?: string | null;
  /** Região alvo; default resolvido por defaultRegion(). */
  region?: string;
}

export interface ResolvedAwsCredentials {
  /** Região efetiva a ser usada pelos clients. */
  region: string;
  /**
   * Credenciais no formato aceito pelos clients do AWS SDK v3.
   * - GATE 1 (ambient): `undefined` → o SDK usa a cadeia default (env/instance role/SSO).
   * - GATE 2 (assume-role): um provider assíncrono que renova antes de expirar.
   */
  credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  /** Descoberto via sts:GetCallerIdentity quando validado (útil para logs/guardrails). */
  accountId?: string;
}

/** Região default para provisão de backend (separada do AWS_S3_DEPLOY_REGION do path S3). */
export function defaultRegion(): string {
  return (
    process.env.GENESIS_PROVISION_REGION ??
    process.env.GENESIS_AWS_REGION ??
    process.env.AWS_REGION ??
    process.env.AWS_S3_DEPLOY_REGION ??
    "us-east-1"
  ).trim();
}

export interface AwsCredentialProvider {
  readonly kind: string;
  resolve(ctx?: CredentialContext): Promise<ResolvedAwsCredentials>;
}

/**
 * GATE 1 — usa a conta da PRÓPRIA Zentriz. Não passa credenciais explícitas:
 * deixa o AWS SDK v3 resolver pela cadeia default (variáveis de ambiente,
 * ECS task role, EC2 instance profile, SSO, ~/.aws). Isso é o que o ambiente
 * onde o Genesis já roda oferece.
 *
 * Diferença deliberada do path S3 (s3.ts usa AWS_S3_DEPLOY_* dedicado): o
 * provisionamento de backend usa a identidade ambiente da conta Zentriz, não a
 * chave estática dedicada de deploy S3.
 */
export class AmbientCredentialProvider implements AwsCredentialProvider {
  readonly kind = "ambient";

  async resolve(ctx?: CredentialContext): Promise<ResolvedAwsCredentials> {
    return {
      region: (ctx?.region ?? defaultRegion()).trim(),
      // credentials: undefined → cadeia default do SDK (conta Zentriz).
      credentials: undefined,
    };
  }
}

let _provider: AwsCredentialProvider | null = null;

/**
 * Retorna o provider de credencial ativo. No GATE 1 é sempre o Ambient.
 * No GATE 2, um bootstrap trocará por AssumeRoleCredentialProvider quando o
 * deployment tiver uma conexão cross-account (tenant_cloud_connections.role_arn).
 */
export function getCredentialProvider(): AwsCredentialProvider {
  if (!_provider) _provider = new AmbientCredentialProvider();
  return _provider;
}

/** Permite ao GATE 2 injetar seu provider sem tocar os drivers. */
export function setCredentialProvider(p: AwsCredentialProvider): void {
  _provider = p;
}

/** Atalho: resolve credenciais para um contexto. */
export function resolveAwsCredentials(ctx?: CredentialContext): Promise<ResolvedAwsCredentials> {
  return getCredentialProvider().resolve(ctx);
}
