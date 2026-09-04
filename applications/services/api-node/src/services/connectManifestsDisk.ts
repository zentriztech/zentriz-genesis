/**
 * connectManifestsDisk.ts — lê os manifests Connect emitidos pela fábrica no BUILD
 * (`<PROJECT_FILES_ROOT>/[<productId>/]<projectId>/project/connect/v<versão>/*.json`) para enviá-los
 * ao Deadpool no registro/ativação do monitoramento (R4 PR6 — plumbing build→Deadpool).
 *
 * Antes deste PR o Genesis gravava os 6 manifests em disco e NUNCA os transportava: o poller do
 * Deadpool montava o envelope do incidente sem contexto Connect e TODO incidente auto-detectado caía
 * em `tier0-observed`/`degraded`, mesmo com os contratos emitidos.
 *
 * Regras (R3/R4 adversarial):
 *  - envia só os REQUIRED do Deadpool (`serviceManifest`, `ownershipManifest`, `integrationReadyContract`)
 *    + `runtimePassport`/`observabilityBaselineManifest` (recommended). **NUNCA** `knownSafeActionsPack`:
 *    ações heurísticas virariam candidatas de remediação.
 *  - `serviceManifest` = o do serviço canônico do projeto (serviceId; para App solo, serviceId ≡ systemId);
 *    se não casar, o primeiro `service-manifest.*.json`.
 *  - versão: o diretório `v<maior>` presente (semver simples).
 * Best-effort: qualquer falha → `null` (o registro segue sem manifests, como antes).
 */
import fs from "fs/promises";
import path from "path";

export type ConnectManifestsPayload = {
  connectVersion: string;
  manifests: Record<string, Record<string, unknown>>;
};

const FILE_TO_KEY: Record<string, string> = {
  "ownership-manifest.json": "ownershipManifest",
  "integration-ready-contract.json": "integrationReadyContract",
  "runtime-passport.json": "runtimePassport",
  "observability-baseline-manifest.json": "observabilityBaselineManifest",
};

function semverKey(v: string): number[] {
  return v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
}

function cmpSemver(a: string, b: string): number {
  const x = semverKey(a), y = semverKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(p, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Candidatos de raiz do projeto: aninhado no produto (I-1) e standalone (legado). */
export function projectRootCandidates(root: string, projectId: string, productId?: string | null): string[] {
  const out: string[] = [];
  if (productId) out.push(path.join(root, productId, projectId));
  out.push(path.join(root, projectId));
  return out;
}

export async function loadConnectManifestsFromDisk(opts: {
  projectId: string;
  productId?: string | null;
  serviceId: string | null;
  systemId: string;
  root?: string | null;
}): Promise<ConnectManifestsPayload | null> {
  const root = (opts.root ?? process.env.PROJECT_FILES_ROOT ?? "").trim();
  if (!root) return null;
  for (const projectRoot of projectRootCandidates(root, opts.projectId, opts.productId)) {
    const connectDir = path.join(projectRoot, "project", "connect");
    let versions: string[];
    try {
      versions = (await fs.readdir(connectDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && /^v\d+(\.\d+){0,2}$/.test(d.name))
        .map((d) => d.name);
    } catch {
      continue;
    }
    if (versions.length === 0) continue;
    versions.sort(cmpSemver);
    const version = versions[versions.length - 1];
    const dir = path.join(connectDir, version);
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    const manifests: Record<string, Record<string, unknown>> = {};
    for (const [file, key] of Object.entries(FILE_TO_KEY)) {
      if (!files.includes(file)) continue;
      const json = await readJson(path.join(dir, file));
      if (json) manifests[key] = json;
    }
    // ServiceManifest: o do serviço canônico (serviceId; solo → systemId); senão o primeiro.
    const svcFiles = files.filter((f) => /^service-manifest\..+\.json$/.test(f)).sort();
    const wanted = (opts.serviceId ?? opts.systemId).toLowerCase();
    let chosen: Record<string, unknown> | null = null;
    for (const f of svcFiles) {
      const json = await readJson(path.join(dir, f));
      if (!json) continue;
      if (String(json.serviceId ?? "").toLowerCase() === wanted) { chosen = json; break; }
      if (!chosen) chosen = json;
    }
    if (chosen) manifests.serviceManifest = chosen;
    if (Object.keys(manifests).length === 0) continue;
    return { connectVersion: version.replace(/^v/, ""), manifests };
  }
  return null;
}
