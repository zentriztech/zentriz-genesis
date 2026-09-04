import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { loadConnectManifestsFromDisk, projectRootCandidates } from "./connectManifestsDisk.js";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "cm-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function write(dir: string, name: string, obj: unknown) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), JSON.stringify(obj), "utf-8");
}

describe("connectManifestsDisk (R4 PR6 — plumbing build→Deadpool)", () => {
  it("lê a maior versão, escolhe o ServiceManifest do serviço canônico e NUNCA envia knownSafeActionsPack", async () => {
    const d11 = path.join(root, "prod-1", "proj-1", "project", "connect", "v1.1.0");
    const d13 = path.join(root, "prod-1", "proj-1", "project", "connect", "v1.3.0");
    await write(d11, "ownership-manifest.json", { schemaVersion: "1.1.0", systemId: "old" });
    await write(d13, "ownership-manifest.json", { schemaVersion: "1.3.0", systemId: "cf" });
    await write(d13, "integration-ready-contract.json", { schemaVersion: "1.3.0", systemId: "cf", declaredTier: "tier1-integration-ready" });
    await write(d13, "runtime-passport.json", { schemaVersion: "1.3.0", systemId: "cf", runtimeType: "container" });
    await write(d13, "observability-baseline-manifest.json", { schemaVersion: "1.3.0", systemId: "cf" });
    await write(d13, "known-safe-actions-pack.json", { schemaVersion: "1.3.0", systemId: "cf", actions: [] });
    await write(d13, "service-manifest.cf-infra.json", { schemaVersion: "1.3.0", serviceId: "cf-infra", systemId: "cf" });
    await write(d13, "service-manifest.cf-backend.json", { schemaVersion: "1.3.0", serviceId: "cf-backend", systemId: "cf" });
    await write(d13, "reconciliation.json", { status: "clean" });

    const out = await loadConnectManifestsFromDisk({ projectId: "proj-1", productId: "prod-1", serviceId: "cf-backend", systemId: "cf", root });
    expect(out?.connectVersion).toBe("1.3.0");
    expect(Object.keys(out!.manifests).sort()).toEqual([
      "integrationReadyContract", "observabilityBaselineManifest", "ownershipManifest", "runtimePassport", "serviceManifest",
    ]);
    expect(out!.manifests.serviceManifest.serviceId).toBe("cf-backend");
    expect(out!.manifests.ownershipManifest.systemId).toBe("cf"); // v1.3.0, não v1.1.0
    expect("knownSafeActionsPack" in out!.manifests).toBe(false);
  });

  it("App solo (serviceId=null) casa o ServiceManifest pelo systemId; layout standalone como fallback", async () => {
    const d = path.join(root, "proj-2", "project", "connect", "v1.3.0");
    await write(d, "service-manifest.meu-app.json", { serviceId: "meu-app", systemId: "meu-app" });
    await write(d, "ownership-manifest.json", { systemId: "meu-app" });
    const out = await loadConnectManifestsFromDisk({ projectId: "proj-2", productId: "prod-x", serviceId: null, systemId: "meu-app", root });
    expect(out?.manifests.serviceManifest.serviceId).toBe("meu-app");
    expect(projectRootCandidates(root, "proj-2", "prod-x")).toEqual([path.join(root, "prod-x", "proj-2"), path.join(root, "proj-2")]);
  });

  it("sem diretório/arquivos → null (comportamento anterior preservado); JSON inválido é ignorado", async () => {
    expect(await loadConnectManifestsFromDisk({ projectId: "nope", serviceId: null, systemId: "x", root })).toBeNull();
    const d = path.join(root, "proj-3", "project", "connect", "v1.3.0");
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, "ownership-manifest.json"), "{ nao json", "utf-8");
    expect(await loadConnectManifestsFromDisk({ projectId: "proj-3", serviceId: null, systemId: "x", root })).toBeNull();
    expect(await loadConnectManifestsFromDisk({ projectId: "proj-3", serviceId: null, systemId: "x", root: "" })).toBeNull();
  });
});
