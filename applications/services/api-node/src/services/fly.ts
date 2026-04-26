/**
 * fly.ts — Fly.io Machines API client
 *
 * API reference: https://fly.io/docs/machines/api/
 * Auth: FLY_API_TOKEN (set in .env)
 * Registry: registry.fly.io/{appName}:{tag}
 *
 * Required env vars:
 *   FLY_API_TOKEN   — Fly.io personal access token
 *   FLY_ORG         — Fly.io org slug (e.g. "zentriz")
 *   FLY_REGION      — preferred region (e.g. "gru" for São Paulo)
 */

const FLY_API_BASE = "https://api.machines.dev/v1";
const FLY_TOKEN    = () => (process.env.FLY_API_TOKEN ?? "").trim();
const FLY_ORG      = () => (process.env.FLY_ORG ?? "").trim();
const FLY_REGION   = () => (process.env.FLY_REGION ?? "gru").trim();

export function isFlyConfigured(): boolean {
  return Boolean(FLY_TOKEN()) && Boolean(FLY_ORG());
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FlyMachine {
  id: string;
  state: "created" | "starting" | "started" | "stopping" | "stopped" | "replacing" | "destroying" | "destroyed";
  region: string;
  private_ip?: string;
}

export interface FlyCreateMachineOpts {
  appName: string;
  image: string;           // registry.fly.io/appName:tag
  port: number;            // container port
  env?: Record<string, string>;
  ttlSeconds?: number;     // auto-destroy after N seconds (max 86400)
  memoryMb?: number;       // default 256
  cpus?: number;           // default 1
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function flyFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const token = FLY_TOKEN();
  if (!token) throw new Error("FLY_API_TOKEN not configured");
  const res = await fetch(`${FLY_API_BASE}${path}`, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
    signal: opts.signal ?? AbortSignal.timeout(30000),
  });
  return res;
}

// ── App management ────────────────────────────────────────────────────────────

/**
 * Creates a Fly app if it doesn't already exist.
 * App names must be globally unique on Fly.io.
 */
export async function ensureFlyApp(appName: string): Promise<void> {
  const org = FLY_ORG();
  if (!org) throw new Error("FLY_ORG not configured");

  // Check if app exists
  const check = await flyFetch(`/apps/${appName}`);
  if (check.ok) return; // already exists

  // Create app
  const res = await flyFetch("/apps", {
    method: "POST",
    body: JSON.stringify({ app_name: appName, org_slug: org }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to create Fly app ${appName}: ${res.status} ${text.slice(0, 200)}`);
  }
}

// ── Machine lifecycle ─────────────────────────────────────────────────────────

/**
 * Creates and starts a Fly Machine with optional TTL (auto-destroy).
 * The machine URL will be https://{appName}.fly.dev
 */
export async function createMachine(opts: FlyCreateMachineOpts): Promise<FlyMachine> {
  await ensureFlyApp(opts.appName);

  const body = {
    region: FLY_REGION(),
    config: {
      image: opts.image,
      auto_destroy: opts.ttlSeconds != null,
      restart: { policy: "no" },
      ...(opts.ttlSeconds != null && {
        metadata: { auto_destroy_after_s: String(opts.ttlSeconds) },
      }),
      env: opts.env ?? {},
      services: [
        {
          ports: [
            { port: 443, handlers: ["tls", "http"] },
            { port: 80,  handlers: ["http"] },
          ],
          protocol: "tcp",
          internal_port: opts.port,
          auto_stop_machines: false,
          auto_start_machines: false,
          min_machines_running: 1,
        },
      ],
      guest: {
        cpu_kind: "shared",
        cpus: opts.cpus ?? 1,
        memory_mb: opts.memoryMb ?? 256,
      },
    },
  };

  const res = await flyFetch(`/apps/${opts.appName}/machines`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to create Fly Machine: ${res.status} ${text.slice(0, 300)}`);
  }

  return (await res.json()) as FlyMachine;
}

/**
 * Polls machine state until "started" or timeout.
 */
export async function waitForMachineStarted(
  appName: string,
  machineId: string,
  timeoutMs = 120_000,
): Promise<FlyMachine> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const machine = await getMachineStatus(appName, machineId);
    if (machine.state === "started") return machine;
    if (machine.state === "destroying" || machine.state === "destroyed") {
      throw new Error(`Machine ${machineId} entered state ${machine.state} unexpectedly`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Machine ${machineId} did not start within ${timeoutMs / 1000}s`);
}

export async function getMachineStatus(appName: string, machineId: string): Promise<FlyMachine> {
  const res = await flyFetch(`/apps/${appName}/machines/${machineId}`);
  if (!res.ok) throw new Error(`Failed to get machine ${machineId}: ${res.status}`);
  return (await res.json()) as FlyMachine;
}

export async function destroyMachine(appName: string, machineId: string): Promise<void> {
  // Stop first, then destroy
  await flyFetch(`/apps/${appName}/machines/${machineId}/stop`, { method: "POST" }).catch(() => null);
  await new Promise((r) => setTimeout(r, 2000));
  const res = await flyFetch(`/apps/${appName}/machines/${machineId}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to destroy machine ${machineId}: ${res.status} ${text.slice(0, 200)}`);
  }
}

/** Returns the public HTTPS URL for a Fly app */
export function flyAppUrl(appName: string): string {
  return `https://${appName}.fly.dev`;
}
