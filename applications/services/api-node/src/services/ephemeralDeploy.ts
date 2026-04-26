/**
 * ephemeralDeploy.ts — Orchestrates ephemeral cloud deployments.
 *
 * Primary provider: Fly.io Machines API
 * Fallback provider: AWS ECS Fargate (B-T6)
 *
 * TTL: 30 minutes by default (configurable, max 60)
 * Data persistence: none — container is destroyed at TTL, no volumes
 */

import { pool } from "../db/client.js";
import { isFlyConfigured, createMachine, waitForMachineStarted, flyAppUrl, destroyMachine as flyDestroyMachine } from "./fly.js";
import { buildAndPushImage } from "./dockerBuilder.js";
import { isECSConfigured, runECSTask, getECSTaskUrl, stopECSTask } from "./ecs.js";

const MAX_TTL_MINUTES = 60;

export interface EphemeralDeployResult {
  deploymentId: string;
  provider: "fly" | "ecs";
  appUrl: string;
  expiresAt: string;
  ttlMinutes: number;
}

// ── Generate unique Fly app name ───────────────────────────────────────────────
function generateFlyAppName(projectId: string): string {
  // Fly app names: lowercase alphanumeric + hyphens, max 30 chars
  const short = projectId.replace(/-/g, "").slice(0, 12);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `genesis-${short}-${suffix}`;
}

// ── Main orchestrator ─────────────────────────────────────────────────────────
export async function deployEphemeral(
  projectId: string,
  ttlMinutes = 30,
): Promise<EphemeralDeployResult> {
  const ttl = Math.min(ttlMinutes, MAX_TTL_MINUTES);
  const expiresAt = new Date(Date.now() + ttl * 60_000);
  const client = await pool.connect();

  try {
    // Idempotency: return existing running deployment
    const existing = await client.query(
      `SELECT id, provider, app_url, expires_at, ttl_minutes
       FROM ephemeral_deployments
       WHERE project_id = $1 AND status = 'running' AND expires_at > now()
       LIMIT 1`,
      [projectId],
    );
    if (existing.rows.length > 0) {
      const r = existing.rows[0];
      return {
        deploymentId: r.id as string,
        provider: r.provider as "fly" | "ecs",
        appUrl: r.app_url as string,
        expiresAt: (r.expires_at as Date).toISOString(),
        ttlMinutes: r.ttl_minutes as number,
      };
    }

    // Create DB record in provisioning state
    const insertRes = await client.query(
      `INSERT INTO ephemeral_deployments
         (project_id, provider, status, ttl_minutes, expires_at)
       VALUES ($1, $2, 'provisioning', $3, $4)
       RETURNING id`,
      [projectId, isFlyConfigured() ? "fly" : "ecs", ttl, expiresAt],
    );
    const deploymentId = insertRes.rows[0].id as string;

    // Release client before long operations
    client.release();

    let appUrl: string;
    let provider: "fly" | "ecs";
    let machineId: string | null = null;
    let appName: string | null = null;
    let imageTag: string | null = null;

    // ── Try Fly.io first ───────────────────────────────────────────────────────
    if (isFlyConfigured()) {
      try {
        const flyApp = generateFlyAppName(projectId);
        appName = flyApp;

        // Build + push Docker image
        const build = await buildAndPushImage(projectId, flyApp);
        imageTag = build.imageTag;

        // Create machine with TTL
        const machine = await createMachine({
          appName: flyApp,
          image: build.imageTag,
          port: build.port,
          ttlSeconds: ttl * 60,
          memoryMb: 256,
          cpus: 1,
          env: { PORT: String(build.port), NODE_ENV: "production" },
        });

        // Wait for machine to start (2 min timeout)
        await waitForMachineStarted(flyApp, machine.id, 120_000);
        machineId = machine.id;
        appUrl = flyAppUrl(flyApp);
        provider = "fly";
      } catch (flyErr) {
        console.error("[EphemeralDeploy] Fly.io failed, trying ECS:", flyErr);
        // Fall through to ECS
        if (isECSConfigured()) {
          const ecsResult = await runECSTask(projectId, ttl);
          machineId = ecsResult.taskArn;
          appName = ecsResult.taskArn;
          imageTag = ecsResult.imageTag;
          appUrl = await getECSTaskUrl(ecsResult.taskArn);
          provider = "ecs";
        } else {
          throw new Error("Both Fly.io and ECS failed or are not configured");
        }
      }
    } else if (isECSConfigured()) {
      const ecsResult = await runECSTask(projectId, ttl);
      machineId = ecsResult.taskArn;
      appName = ecsResult.taskArn;
      imageTag = ecsResult.imageTag;
      appUrl = await getECSTaskUrl(ecsResult.taskArn);
      provider = "ecs";
    } else {
      throw new Error("No cloud provider configured. Set FLY_API_TOKEN or AWS_ECS_CLUSTER.");
    }

    // Update DB with success
    const updateClient = await pool.connect();
    try {
      await updateClient.query(
        `UPDATE ephemeral_deployments
         SET status='running', provider=$1, machine_id=$2, app_name=$3,
             image_tag=$4, app_url=$5, updated_at=now()
         WHERE id=$6`,
        [provider, machineId, appName, imageTag, appUrl, deploymentId],
      );
    } finally {
      updateClient.release();
    }

    return { deploymentId, provider, appUrl, expiresAt: expiresAt.toISOString(), ttlMinutes: ttl };

  } catch (err) {
    // Update DB with failure
    try {
      await client.query(
        `UPDATE ephemeral_deployments SET status='failed', error_msg=$1, updated_at=now() WHERE project_id=$2 AND status='provisioning'`,
        [String(err), projectId],
      ).catch(() => null);
    } catch { /* */ }
    throw err;
  } finally {
    try { client.release(); } catch { /* */ }
  }
}

// ── Destroy ───────────────────────────────────────────────────────────────────
export async function destroyDeployment(deploymentId: string): Promise<void> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "SELECT provider, machine_id, app_name FROM ephemeral_deployments WHERE id=$1",
      [deploymentId],
    );
    const row = res.rows[0];
    if (!row) return;

    if (row.provider === "fly" && row.machine_id && row.app_name) {
      await flyDestroyMachine(row.app_name as string, row.machine_id as string).catch(console.error);
    } else if (row.provider === "ecs" && row.machine_id) {
      await stopECSTask(row.machine_id as string).catch(console.error);
    }

    await client.query(
      "UPDATE ephemeral_deployments SET status='destroyed', destroyed_at=now(), updated_at=now() WHERE id=$1",
      [deploymentId],
    );
  } finally {
    client.release();
  }
}
