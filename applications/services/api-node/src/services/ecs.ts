/**
 * ecs.ts — AWS ECS Fargate fallback stub.
 *
 * The actual ECS integration requires @aws-sdk/client-ecs and @aws-sdk/client-ec2
 * which are not installed by default (they're only needed as a fallback provider).
 *
 * To activate: install the SDKs and set the env vars below.
 * Required env vars:
 *   AWS_ECS_CLUSTER, AWS_ECS_SUBNET, AWS_ECS_SECURITY_GROUP,
 *   AWS_ECR_REGISTRY, AWS_ECS_EXECUTION_ROLE, AWS_REGION
 */

export function isECSConfigured(): boolean {
  return Boolean(
    (process.env.AWS_ECS_CLUSTER ?? "").trim() &&
    (process.env.AWS_ECS_SUBNET ?? "").trim() &&
    (process.env.AWS_ECR_REGISTRY ?? "").trim(),
  );
}

export interface ECSRunResult {
  taskArn: string;
  imageTag: string;
}

export async function runECSTask(_projectId: string, _ttlMinutes: number): Promise<ECSRunResult> {
  // Activate by installing @aws-sdk/client-ecs and implementing this function.
  // The stub throws so ephemeralDeploy.ts falls back gracefully.
  throw new Error(
    "AWS ECS Fargate fallback is not yet activated. " +
    "Install @aws-sdk/client-ecs + @aws-sdk/client-ec2 and implement runECSTask().",
  );
}

export async function getECSTaskUrl(_taskArn: string): Promise<string> {
  throw new Error("ECS not activated");
}

export async function stopECSTask(_taskArn: string): Promise<void> {
  // No-op stub — tasks will expire naturally via ECS task stop timeout
  console.warn("[ECS] stopECSTask called but ECS SDK not installed — task will expire naturally");
}
