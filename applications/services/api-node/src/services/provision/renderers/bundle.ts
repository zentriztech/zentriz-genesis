/**
 * bundle.ts — DM-T8 (Fase A). Monta o BUNDLE completo do modo source_only.
 *
 * Junta os 4 renderers (compose/terraform/k8s/CI) num único conjunto de arquivos que:
 *   1. é COMMITADO no repo do projeto (pasta deploy/ + raiz) pelo pipeline, e
 *   2. pode ser baixado como .zip pelo portal.
 *
 * Puro: IR (DM-T3) → RenderedFile[]. A escrita em disco / commit / zip fica na borda
 * (rota do portal / runner), não aqui — mantém testável por snapshot sem I/O.
 */

import type { ProvisionPlanIR } from "../provisionPlanIR.js";
import type { RenderedFile } from "./composeRenderer.js";
import { renderComposeBundle } from "./composeRenderer.js";
import { renderTerraformBundle } from "./terraformRenderer.js";
import { renderK8sBundle } from "./k8sRenderer.js";
import { renderCiBundle } from "./ciRenderer.js";

/** Índice raiz que aparece no topo do repo, apontando para DEPLOY.md. */
function renderReadmeSnippet(plan: ProvisionPlanIR): RenderedFile {
  return {
    path: "deploy/README.md",
    content: [
      "# Kit de provisionamento (Genesis · source_only)",
      "",
      "Este produto foi entregue como **código-fonte + kit de deploy**. Você provisiona onde quiser:",
      "",
      "- `docker-compose.yml` + `RUN.md` — rodar local na hora.",
      "- `terraform/` — subir na AWS (" + (plan.runtimeTarget === "ecs_fargate" ? "ECS Fargate + ALB" + (plan.db.kind === "rds" ? " + RDS" : "") : plan.runtimeTarget) + ").",
      "- `k8s/` — aplicar num cluster Kubernetes (`kubectl apply -k k8s/`).",
      "- `.github/workflows/deploy.yml` — CI/CD build+push.",
      "",
      "Comece por `DEPLOY.md` na raiz.",
      "",
    ].join("\n"),
  };
}

/**
 * Bundle completo do source_only. Ordem determinística; sem colisão de paths
 * (compose/CI vão na raiz; terraform/ e k8s/ em subpastas; deploy/ para initdb+README).
 */
export function renderSourceOnlyBundle(plan: ProvisionPlanIR): RenderedFile[] {
  const files: RenderedFile[] = [
    ...renderComposeBundle(plan),   // docker-compose.yml, .env.example, RUN.md, deploy/initdb/*
    ...renderTerraformBundle(plan), // terraform/*
    ...renderK8sBundle(plan),       // k8s/*
    ...renderCiBundle(plan),        // .github/workflows/deploy.yml, DEPLOY.md
    renderReadmeSnippet(plan),      // deploy/README.md
  ];
  // Guarda de integridade: nenhum path duplicado (renderers não podem colidir).
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) throw new Error(`BUNDLE_PATH_COLLISION: ${f.path}`);
    seen.add(f.path);
  }
  return files;
}

/** Manifesto do bundle (lista de arquivos + tamanho) — útil p/ o portal exibir. */
export function bundleManifest(files: RenderedFile[]): Array<{ path: string; bytes: number }> {
  return files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content, "utf-8") }));
}
